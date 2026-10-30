"""Step 02: terrain heightmap, hillshade and a placeholder stylized texture.

Fetches AWS Terrain Tiles (terrarium PNG, no key) covering the AOI, mosaics them, and
resamples onto a regular lon/lat grid, because the TerrainLayer maps one image linearly
onto `bounds`. Writes:
  dem.png             terrarium-encoded 1025×1025 heightmap (row 0 = north) for deck.gl TerrainLayer
  dem.json            size, bounds, pixel size, elevation range, decoder, analysis grid
  hillshade.png       greyscale hillshade
  base_stylized.jpg   painted-relief placeholder texture from elevation + slope + hillshade,
                      written only until step 03 exists (it re-colours by ESA WorldCover land cover)
  work/<fire>/elevation.npy, slope_deg.npy, aspect_deg.npy  for later steps

Run: uv run python -m steps.s02_dem
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from ember.config import load_fire
from ember.geo import (
    TILE,
    fetch_cached,
    lonlat_to_global_px,
    meters_per_degree,
    terrarium_decode,
    terrarium_encode,
)
from ember.manifest import add_source

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# Palette for the placeholder texture (DESIGN.md §4.2): grass beige → chaparral olive → conifer green.
GRASS = np.array([214, 190, 140], np.float32)
CHAPARRAL = np.array([146, 138, 86], np.float32)
CONIFER = np.array([78, 92, 58], np.float32)
WATER = np.array([158, 172, 176], np.float32)  # flat blue-grey, like the reference's reservoir


def bilinear(img: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    r0 = np.clip(np.floor(rows).astype(int), 0, img.shape[0] - 2)
    c0 = np.clip(np.floor(cols).astype(int), 0, img.shape[1] - 2)
    fr = (rows - r0)[:, None]
    fc = (cols - c0)[None, :]
    a = img[np.ix_(r0, c0)]
    b = img[np.ix_(r0, c0 + 1)]
    c = img[np.ix_(r0 + 1, c0)]
    d = img[np.ix_(r0 + 1, c0 + 1)]
    return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr


def shade(elev: np.ndarray, px_x: float, px_y: float, azimuth=315.0, altitude=40.0):
    """Hillshade in [0, 1] plus slope and aspect in degrees (aspect clockwise from north)."""
    d_row, d_col = np.gradient(elev)
    dz_east = d_col / px_x
    dz_north = -d_row / px_y  # rows run south
    normal = np.stack([-dz_east, -dz_north, np.ones_like(elev)], axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    az, alt = np.radians(azimuth), np.radians(altitude)
    light = np.array([np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt)])
    hill = np.clip(normal @ light, 0, 1)
    slope = np.degrees(np.arctan(np.hypot(dz_east, dz_north)))
    aspect = (np.degrees(np.arctan2(-dz_east, -dz_north)) + 360) % 360  # downslope direction
    return hill, slope, aspect


def stylize(elev: np.ndarray, slope: np.ndarray, hill: np.ndarray, water: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(elev[~water] if (~water).any() else elev, [2, 98])
    e = np.clip((elev - lo) / max(hi - lo, 1), 0, 1)
    s = np.clip(slope / 35.0, 0, 1)
    veg = np.clip(0.05 + 0.5 * s + 0.2 * e, 0, 1)[..., None]  # steeper/higher → denser
    base = np.where(veg < 0.5, GRASS + (CHAPARRAL - GRASS) * (veg / 0.5),
                    CHAPARRAL + (CONIFER - CHAPARRAL) * ((veg - 0.5) / 0.5))
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 6, elev.shape)[..., None]
    lit = (0.55 + 0.6 * hill)[..., None]
    land = base * lit + grain
    return np.clip(np.where(water[..., None], WATER, land), 0, 255).astype(np.uint8)


def main() -> None:
    fire = load_fire()
    aoi = fire.read_json("aoi.json")
    west, south, east, north = aoi["bbox"]
    z = fire.dem_zoom

    gx0, gy0 = lonlat_to_global_px(west, north, z)
    gx1, gy1 = lonlat_to_global_px(east, south, z)
    tx0, ty0, tx1, ty1 = int(gx0 // TILE), int(gy0 // TILE), int(gx1 // TILE), int(gy1 // TILE)

    mosaic = np.zeros(((ty1 - ty0 + 1) * TILE, (tx1 - tx0 + 1) * TILE), np.float32)
    n_tiles = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            path = fetch_cached(TERRARIUM.format(z=z, x=tx, y=ty),
                                fire.raw_dir / "terrarium" / str(z) / f"{tx}_{ty}.png")
            rgb = np.asarray(Image.open(path).convert("RGB"))
            r, c = (ty - ty0) * TILE, (tx - tx0) * TILE
            mosaic[r:r + TILE, c:c + TILE] = terrarium_decode(rgb)
            n_tiles += 1

    # Regular lon/lat output grid at roughly the source resolution, square-ish pixels in meters.
    m_lon, m_lat = meters_per_degree((south + north) / 2)
    width = int(round(gx1 - gx0))
    px_x = (east - west) * m_lon / width
    height = int(round((north - south) * m_lat / px_x))
    px_y = (north - south) * m_lat / height

    lons = np.linspace(west, east, width)
    lats = np.linspace(north, south, height)
    cols = np.array([lonlat_to_global_px(lon, north, z)[0] for lon in lons]) - tx0 * TILE
    rows = np.array([lonlat_to_global_px(west, lat, z)[1] for lat in lats]) - ty0 * TILE
    elev = bilinear(mosaic, rows, cols).astype(np.float32)
    # Terrarium tiles carry bathymetry; the replay only needs land, so clamp the sea to 0 m.
    water = elev <= 0.0
    elev = np.maximum(elev, 0.0)

    hill, slope, aspect = shade(elev, px_x, px_y)

    # The web heightmap is resampled to 1025×1025 (2^10 + 1) so deck.gl's TerrainLoader can
    # use the fast Martini tessellator; any other size falls back to Delatin, which takes seconds.
    mesh_n = 1025
    mesh_elev = bilinear(elev, np.linspace(0, height - 1, mesh_n), np.linspace(0, width - 1, mesh_n))
    Image.fromarray(terrarium_encode(mesh_elev)).save(fire.out_dir / "dem.png")
    Image.fromarray((hill * 255).astype(np.uint8)).save(fire.out_dir / "hillshade.png")
    # Step 03 owns the texture once land cover exists; only write the placeholder before that.
    placeholder = not (fire.work_dir / "landcover.npy").exists()
    if placeholder:
        Image.fromarray(stylize(elev, slope, hill, water)).save(fire.out_dir / "base_stylized.jpg", quality=88)
    np.save(fire.work_dir / "elevation.npy", elev)
    np.save(fire.work_dir / "slope_deg.npy", slope.astype(np.float32))
    np.save(fire.work_dir / "aspect_deg.npy", aspect.astype(np.float32))

    fire.write_json(
        "dem.json",
        {
            # dem.png (the web mesh)
            "width": mesh_n,
            "height": mesh_n,
            "bounds": [west, south, east, north],
            "pixel_m": [round(px_x * (width - 1) / (mesh_n - 1), 2), round(px_y * (height - 1) / (mesh_n - 1), 2)],
            "elevation_m": [round(float(elev.min()), 1), round(float(elev.max()), 1)],
            "zoom": z,
            "decoder": {"rScaler": 256, "gScaler": 1, "bScaler": 1 / 256, "offset": -32768},
            # work/<fire>/*.npy (analysis grid at the source resolution)
            "analysis_grid": {"width": width, "height": height, "pixel_m": [round(px_x, 2), round(px_y, 2)]},
        },
    )
    add_source(
        fire,
        layer="Terrain",
        source="AWS Terrain Tiles (terrarium)",
        url="https://registry.opendata.aws/terrain-tiles/",
        status="REAL",
        attribution="Terrain Tiles on AWS Open Data; elevation from USGS 3DEP, SRTM and other public sources",
        notes=f"z{z}, resampled to {px_x:.0f} m lon/lat grid",
    )
    if placeholder:
        add_source(fire, layer="Base texture", source="Stylized from elevation, slope and hillshade", url="",
                   status="MODELED", notes="Placeholder palette until step 03 colors it by land cover.")
    print(f"{n_tiles} tiles → {width}×{height} px at {px_x:.1f}×{px_y:.1f} m; "
          f"elevation {elev.min():.0f}–{elev.max():.0f} m")


if __name__ == "__main__":
    main()
