"""Step 03: land cover and fuels → stylized texture, fuel classes, tree instances.

LANDFIRE FBFM40/EVT needs an emailed async job, so this step stands in ESA WorldCover
2021 v200 (10 m, CC BY 4.0, open on AWS). It reads only the AOI window of the 3°×3° COG
over HTTP range requests (/vsicurl/), caches that window, and mode-resamples it onto the
analysis grid from step 02 (dem.json → analysis_grid; row 0 = north).

Inputs:  dem.json, hillshade.png, final_perimeter.geojson (steps 01–02)
         ESA WorldCover tile ESA_WorldCover_10m_2021_v200_<N..W..>_Map.tif (window only)
Outputs: work/<fire>/landcover.npy   uint8 WorldCover code per analysis-grid cell
         fuel.png                    red channel = fuel class index (G = B = R), 0 = no data
         fuel_classes.json           {"<index>": {label, worldcover: [codes], burnable}}
         base_stylized.jpg           land-cover palette × hillshade + grain (replaces step 02's)
         trees.json                  [[lon, lat, height_m], ...], ≤ 40,000, tree and shrub cells
         manifest.json               "Land cover / fuels" (REAL), "Base texture" (MODELED)

Run: FIRE=eaton uv run python -m steps.s03_landcover
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.coords import BoundingBox
from rasterio.errors import RasterioIOError
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds
from scipy.ndimage import gaussian_filter

from ember.config import Fire, load_fire
from ember.grid import Grid
from ember.manifest import add_source

WORLDCOVER_TILE = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
)
USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"
ATTRIBUTION = (
    "(c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) "
    "processed by ESA WorldCover consortium"
)
PAD_PX = 3  # source pixels around the grid so edge cells get full support for mode

MAX_TREES = 40_000
TREE_TO_SHRUB_DENSITY = 4.0  # instances per tree cell : instances per shrub cell
TREE_HEIGHT_M = (8.0, 18.0)
SHRUB_HEIGHT_M = (1.5, 3.0)
SEED = 3

# Fuel classes: index → (label, WorldCover codes, burnable, palette RGB).
# Index 0 is "no data" so fuel.png 0 means the same thing as in severity.png.
# Snow/ice (70) and moss/lichen (100) do not occur in either AOI; they fold into bare.
CLASSES: dict[int, tuple[str, list[int], bool, tuple[int, int, int]]] = {
    0: ("No data", [0], False, (200, 196, 186)),
    1: ("Grass", [30], True, (0xD6, 0xBE, 0x8C)),
    2: ("Chaparral / shrubland", [20], True, (0x92, 0x8A, 0x56)),
    3: ("Forest", [10], True, (0x4E, 0x5C, 0x3A)),
    4: ("Urban / WUI (structures)", [50], True, (0xB9, 0xB2, 0xA4)),
    5: ("Cropland", [40], True, (0xC9, 0xC2, 0x8A)),
    6: ("Bare / rock", [60, 70, 100], False, (0xDC, 0xCF, 0xB0)),
    7: ("Water", [80], False, (0x9E, 0xAC, 0xB0)),
    8: ("Wetland", [90, 95], True, (0x8E, 0x9A, 0x78)),
}
GRASS, SHRUB, FOREST, URBAN, WATER = 1, 2, 3, 4, 7


def class_lut() -> np.ndarray:
    """256-entry WorldCover code → fuel class index (unknown codes → 0, no data)."""
    lut = np.zeros(256, np.uint8)
    for idx, (_, codes, _, _) in CLASSES.items():
        lut[codes] = idx
    return lut


def tile_name(west: float, south: float) -> str:
    """WorldCover 3°×3° tile id from its lower-left corner, e.g. N33W120."""
    lat0 = int(math.floor(south / 3.0) * 3)
    lon0 = int(math.floor(west / 3.0) * 3)
    return f"{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}"


def covers(outer: BoundingBox, grid: Grid) -> bool:
    return (outer.left <= grid.west and outer.right >= grid.east
            and outer.bottom <= grid.south and outer.top >= grid.north)


def _read_remote_window(url: str, grid: Grid) -> tuple[np.ndarray, rasterio.Affine, dict]:
    env = dict(
        GDAL_HTTP_USERAGENT=USER_AGENT,
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",  # don't list the S3 prefix
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        GDAL_HTTP_MAX_RETRY="3",                   # GDAL backs off on 429/5xx itself
        GDAL_HTTP_RETRY_DELAY="2",
    )
    with rasterio.Env(**env), rasterio.open(f"/vsicurl/{url}") as src:
        if not covers(src.bounds, grid):
            raise SystemExit(f"WorldCover tile {url} does not cover the AOI {grid.bounds}; "
                             "the AOI crosses a 3° tile edge and needs a mosaic.")
        f = from_bounds(*grid.bounds, transform=src.transform)
        c0, r0 = math.floor(f.col_off) - PAD_PX, math.floor(f.row_off) - PAD_PX
        c1, r1 = math.ceil(f.col_off + f.width) + PAD_PX, math.ceil(f.row_off + f.height) + PAD_PX
        win = Window(c0, r0, c1 - c0, r1 - r0).intersection(Window(0, 0, src.width, src.height))
        arr = src.read(1, window=win)
        return arr, src.window_transform(win), {"crs": src.crs, "nodata": src.nodata}


def fetch_window(fire: Fire, grid: Grid) -> tuple[np.ndarray, rasterio.Affine, str]:
    """AOI window of the WorldCover tile, cached as a small GeoTIFF in raw/<fire>/worldcover/."""
    url = WORLDCOVER_TILE.format(tile=tile_name(grid.west, grid.south))
    cache = fire.raw_dir / "worldcover" / Path(url).name.replace("_Map.tif", "_Map_window.tif")
    if cache.exists():
        with rasterio.open(cache) as src:
            if covers(src.bounds, grid):
                return src.read(1), src.transform, url

    for attempt in range(4):
        try:
            arr, transform, meta = _read_remote_window(url, grid)
            break
        except RasterioIOError:
            if attempt == 3:
                raise
            time.sleep(2.0 * 2**attempt)

    cache.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        cache, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1,
        dtype="uint8", crs=meta["crs"], transform=transform, nodata=meta["nodata"], compress="deflate",
    ) as dst:
        dst.write(arr, 1)
    return arr, transform, url


def to_grid(arr: np.ndarray, transform: rasterio.Affine, grid: Grid) -> np.ndarray:
    """Categorical (mode) resample of WorldCover codes onto the analysis grid."""
    out = np.zeros(grid.shape, np.uint8)
    reproject(
        arr, out,
        src_transform=transform, src_crs="EPSG:4326", src_nodata=0,
        dst_transform=grid.transform, dst_crs="EPSG:4326", dst_nodata=0,
        resampling=Resampling.mode,
    )
    return out


def stylize(fuel: np.ndarray, hill: np.ndarray) -> np.ndarray:
    """Land-cover palette × hillshade with subtle grain; water stays flat blue-grey."""
    palette = np.zeros((256, 3), np.float32)
    for idx, (*_, rgb) in CLASSES.items():
        palette[idx] = rgb
    base = palette[fuel]
    # A light blur turns the 16 m class mosaic into soft painted edges.
    base = np.stack([gaussian_filter(base[..., c], 0.8) for c in range(3)], axis=-1)
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 6, fuel.shape)[..., None]
    lit = (0.55 + 0.6 * hill)[..., None]
    land = base * lit + grain
    water = (fuel == WATER)[..., None]
    return np.clip(np.where(water, palette[WATER], land), 0, 255).astype(np.uint8)


def sample_trees(fuel: np.ndarray, grid: Grid) -> list[list[float]]:
    """Deterministic tree/shrub instances: denser on forest cells, sparser on shrub cells."""
    rng = np.random.default_rng(SEED)
    flat = fuel.ravel()
    tree_cells = np.flatnonzero(flat == FOREST)
    shrub_cells = np.flatnonzero(flat == SHRUB)
    weight = TREE_TO_SHRUB_DENSITY * tree_cells.size + shrub_cells.size
    if weight == 0:
        return []
    n_tree = min(tree_cells.size, round(MAX_TREES * TREE_TO_SHRUB_DENSITY * tree_cells.size / weight))
    n_shrub = min(shrub_cells.size, MAX_TREES - n_tree)

    picks = []
    for cells, n, (h0, h1) in ((tree_cells, n_tree, TREE_HEIGHT_M), (shrub_cells, n_shrub, SHRUB_HEIGHT_M)):
        idx = np.sort(rng.choice(cells, size=n, replace=False))
        row, col = np.divmod(idx, grid.width)
        # Jitter inside the cell (±0.45 keeps each instance on its own cell).
        lon, lat = grid.to_lonlat(col + rng.uniform(-0.45, 0.45, n), row + rng.uniform(-0.45, 0.45, n))
        h = rng.uniform(h0, h1, n)
        picks.append(np.column_stack([idx, lon, lat, h]))
    rows = np.concatenate(picks)
    rows = rows[np.argsort(rows[:, 0], kind="stable")]  # row-major for a stable file
    return [[round(float(lo), 6), round(float(la), 6), round(float(h), 1)] for _, lo, la, h in rows]


def fractions(fuel: np.ndarray, mask: np.ndarray | None = None) -> dict[str, float]:
    vals = fuel[mask.astype(bool)] if mask is not None else fuel.ravel()
    counts = np.bincount(vals, minlength=len(CLASSES))
    total = max(int(counts.sum()), 1)
    return {CLASSES[i][0]: round(float(counts[i]) / total, 4) for i in CLASSES if counts[i]}


def main() -> None:
    fire = load_fire()
    grid = Grid.for_fire(fire)

    src, transform, url = fetch_window(fire, grid)
    landcover = to_grid(src, transform, grid)
    np.save(fire.work_dir / "landcover.npy", landcover)

    fuel = class_lut()[landcover]
    Image.fromarray(np.repeat(fuel[..., None], 3, axis=-1)).save(fire.out_dir / "fuel.png")
    fire.write_json(
        "fuel_classes.json",
        {str(i): {"label": label, "worldcover": codes, "burnable": burnable}
         for i, (label, codes, burnable, _) in CLASSES.items()},
    )

    hill_img = np.asarray(Image.open(fire.out_dir / "hillshade.png").convert("L"))
    if hill_img.shape != grid.shape:
        raise SystemExit(f"hillshade.png is {hill_img.shape}, analysis grid is {grid.shape}; rerun step 02")
    Image.fromarray(stylize(fuel, hill_img.astype(np.float32) / 255.0)).save(
        fire.out_dir / "base_stylized.jpg", quality=88)

    trees = sample_trees(fuel, grid)
    (fire.out_dir / "trees.json").write_text(json.dumps(trees, separators=(",", ":")) + "\n")

    perim = fire.read_json("final_perimeter.geojson")
    inside = grid.rasterize([f["geometry"] for f in perim["features"]])
    stats = {"aoi": fractions(fuel), "final_perimeter": fractions(fuel, inside),
             "n_trees": len(trees), "source_window_px": list(src.shape)}
    (fire.work_dir / "landcover_stats.json").write_text(json.dumps(stats, indent=2) + "\n")

    add_source(
        fire,
        layer="Land cover / fuels",
        source="ESA WorldCover 2021 v200 (10 m)",
        url="https://esa-worldcover.org/",
        status="REAL",
        attribution=ATTRIBUTION,
        notes=(
            "Stands in for LANDFIRE LF2024 FBFM40/EVT, whose LFPS job needs an emailed request. "
            "WorldCover is land cover, not a fuel model: its 11 classes are grouped into 8 coarse "
            "fuel classes with no fuel load or bed depth. Imagery is from 2021, about 3.5 years "
            f"before the fire. Read as a window of {Path(url).name} over HTTP range requests and "
            "mode-resampled from 10 m to the ~16 m analysis grid. Limitation: its tree-cover class "
            "(>10% tree canopy) likely includes dense, tall chaparral and oak woodland here."
        ),
    )
    add_source(
        fire,
        layer="Base texture",
        source="Stylized from ESA WorldCover land cover + hillshade",
        url="https://esa-worldcover.org/",
        status="MODELED",
        attribution=ATTRIBUTION,
        notes="Fixed palette per land-cover class, lit by the terrain hillshade, with grain. Not imagery.",
    )

    print(f"{fire.name}: WorldCover window {src.shape[1]}×{src.shape[0]} px → grid {grid.width}×{grid.height}")
    for name, frac in (("AOI", stats["aoi"]), ("final perimeter", stats["final_perimeter"])):
        print(f"  {name}: " + ", ".join(f"{k} {v:.1%}" for k, v in sorted(frac.items(), key=lambda kv: -kv[1])))
    print(f"  {len(trees):,} tree/shrub instances → {fire.out_dir / 'trees.json'}")


if __name__ == "__main__":
    main()
