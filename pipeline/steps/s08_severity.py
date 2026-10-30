"""Step 08: burn severity (dNBR) from JPL AVIRIS-3 on the analysis grid.

Inputs:
  JPL AVIRIS-3 provisional dNBR COG for the fire (NIR 866 nm / SWIR 2198 nm, pre 2024-09-05,
  post 2025-01-16), from https://popo.jpl.nasa.gov/pub/LA_Fires/dist/dnbr/ (not the *_color.tif).
  Native grid: UTM 11N (EPSG:32611), 3.1-3.2 m, float32, unitless dNBR (not x1000), nodata = inf.
  Cached in raw/<fire>/dnbr/.
  final_perimeter.geojson and dem.json (via ember.grid.Grid) from steps 01-02.

Processing: inf -> NaN; physically impossible values (|dNBR| > 2, since NBR is in [-1, 1]) are
masked as sensor artifacts and counted; then a bilinear reprojection onto the analysis grid
(EPSG:4326, row 0 = north, same bounds as dem.png), with NaN as nodata on both sides.

Outputs:
  work/<fire>/dnbr.npy   float32 dNBR on the analysis grid, NaN = no data
  severity.png           RGB, analysis grid, row 0 = north, same bounds as dem.png
                           R: dNBR clipped to [-0.1, 1.0], mapped linearly to 1..255; 0 = no data.
                              Decode: dnbr = -0.1 + (R - 1) / 254 * 1.1
                           G: USGS-style class (Key & Benson thresholds): 0 no data, 1 unburned (<0.1),
                              2 low (0.1-0.27), 3 moderate-low (0.27-0.44), 4 moderate-high (0.44-0.66),
                              5 high (>=0.66)
                           B: 0
  severity_stats.json    coverage of the final perimeter, class fractions and acres inside it, mean
                         dNBR inside vs outside, and a georeferencing check: a chamfer match of the
                         data outline against the perimeter outline over ±12-cell shifts (edge_alignment)

JPL clipped the product to a burn perimeter, so ~99% of valid cells fall inside the final perimeter
and the "outside" sample is a thin edge ring (mean_dnbr.n_valid_outside in the stats). The
inside/outside means are reported, but the edge-alignment minimum at zero shift is the stronger
georeferencing test. AVIRIS-3 flight lines cover only part of each fire (perimeter.coverage; about
56% for Eaton and 2% for Palisades with the product dated 2025-01-24); the gap is recorded in the
stats and manifest, not filled.

Run: FIRE=eaton uv run python -m steps.s08_severity
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.warp import Resampling, reproject
from scipy import ndimage

from ember.config import load_fire
from ember.grid import Grid
from ember.manifest import add_source

BASE_URL = "https://popo.jpl.nasa.gov/pub/LA_Fires/dist/dnbr/"
PRODUCTS = {
    "eaton": "COG_Eaton_AV3_provisional_dNBR_866nm_2198nm_20240905-20250116.tif",
    "palisades": "COG_Palisades_AV3_provisional_dNBR_866nm_2198nm_20240905-20250116.tif",
}
USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"

VALID_ABS_MAX = 2.0                     # |dNBR| above this cannot come from two NBRs in [-1, 1]
RED_RANGE = (-0.1, 1.0)                 # dNBR mapped to red 1..255
CLASS_EDGES = [0.1, 0.27, 0.44, 0.66]   # USGS (Key & Benson) breaks, unitless dNBR
CLASS_LABELS = ["unburned", "low", "moderate_low", "moderate_high", "high"]  # green codes 1..5
ALIGN_RADIUS = 12                       # shift search half-width in cells (~190 m)
ALIGN_CAP = 3.0                         # cells; edge distances beyond this count as "not on the perimeter"
M2_PER_ACRE = 4046.8564224


def download(url: str, dest: Path, *, retries: int = 4) -> Path:
    """Stream url to dest once (cached), checking the byte count so a cut-off file is never kept."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(retries):
        try:
            with requests.get(url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=60) as r:
                if 400 <= r.status_code < 500:
                    raise SystemExit(f"s08_severity: {url} returned HTTP {r.status_code}")
                r.raise_for_status()
                expected = int(r.headers.get("Content-Length", 0))
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            got = tmp.stat().st_size
            if expected and got != expected:
                raise requests.RequestException(f"short read: {got} of {expected} bytes")
            tmp.replace(dest)
            return dest
        except requests.RequestException as err:
            tmp.unlink(missing_ok=True)
            if attempt == retries - 1:
                raise
            wait = 2.0 * 2**attempt
            print(f"download failed ({err}); retrying in {wait:.0f} s")
            time.sleep(wait)
    return dest


def load_dnbr(path: Path) -> tuple[np.ndarray, rasterio.Affine, rasterio.crs.CRS, dict]:
    """Native dNBR with nodata and out-of-range values as NaN, plus provenance for the stats."""
    with rasterio.open(path) as ds:
        arr = ds.read(1).astype(np.float32)
        info = {
            "crs": str(ds.crs),
            "native_res_m": [round(ds.res[0], 2), round(ds.res[1], 2)],
            "native_shape": list(ds.shape),
            "nodata": str(ds.nodata),
            "scale": ds.scales[0],
            "offset": ds.offsets[0],
        }
        transform, crs = ds.transform, ds.crs
    if info["scale"] != 1.0 or info["offset"] != 0.0:
        raise SystemExit(f"s08_severity: unexpected band scale/offset {info['scale']}/{info['offset']}")
    arr[~np.isfinite(arr)] = np.nan
    finite = np.isfinite(arr)
    bad = finite & (np.abs(arr) > VALID_ABS_MAX)
    # A x1000-scaled product would put most values far outside [-2, 2]; fail rather than guess.
    if bad.sum() > 0.01 * finite.sum():
        raise SystemExit("s08_severity: dNBR values look scaled (many |dNBR| > 2); check the source")
    arr[bad] = np.nan
    info["native_valid_px"] = int(finite.sum() - bad.sum())
    info["masked_out_of_range_px"] = int(bad.sum())
    return arr, transform, crs, info


def to_grid(arr: np.ndarray, transform, crs, grid: Grid) -> np.ndarray:
    out = np.full(grid.shape, np.nan, np.float32)
    reproject(
        arr, out,
        src_transform=transform, src_crs=crs, src_nodata=np.nan,
        dst_transform=grid.transform, dst_crs="EPSG:4326", dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    return out


def classify(dnbr: np.ndarray) -> np.ndarray:
    """USGS-style class 1..5, 0 where there is no data."""
    # Compare in the data's own precision, so a float32 0.44 counts as >= 0.44.
    cls = (np.digitize(dnbr, np.asarray(CLASS_EDGES, dnbr.dtype)) + 1).astype(np.uint8)
    cls[~np.isfinite(dnbr)] = 0  # digitize puts NaN in the top bin
    return cls


def encode_png(dnbr: np.ndarray) -> np.ndarray:
    lo, hi = RED_RANGE
    valid = np.isfinite(dnbr)
    scaled = np.clip((np.nan_to_num(dnbr, nan=lo) - lo) / (hi - lo), 0.0, 1.0)
    red = np.where(valid, np.rint(scaled * 254) + 1, 0).astype(np.uint8)
    return np.dstack([red, classify(dnbr), np.zeros_like(red)])


def edge_alignment(valid: np.ndarray, inside: np.ndarray, radius: int = ALIGN_RADIUS,
                   cap: float = ALIGN_CAP) -> dict:
    """Chamfer-match the data outline against the final-perimeter outline under small shifts.

    Where JPL's clip mask forms the data edge, it should trace the official perimeter. For every
    shift of the data (dcol east, drow south) up to `radius` cells, take the mean distance from
    data-edge cells to the nearest perimeter-boundary cell, capped at `cap` cells so flight-line
    edges deep inside the perimeter add only a flat background. Correct georeferencing puts the
    minimum at (0, 0).
    """
    boundary = inside ^ ndimage.binary_erosion(inside)
    dist = np.minimum(ndimage.distance_transform_edt(~boundary), cap)
    rows, cols = np.nonzero(valid & ~ndimage.binary_erosion(valid))
    h, w = valid.shape
    shifts = range(-radius, radius + 1)
    cost = np.full((len(shifts), len(shifts)), cap)
    for i, dr in enumerate(shifts):
        for j, dc in enumerate(shifts):
            r, c = rows + dr, cols + dc
            ok = (r >= 0) & (r < h) & (c >= 0) & (c < w)
            cost[i, j] = (dist[r[ok], c[ok]].sum() + cap * (~ok).sum()) / len(rows)
    bi, bj = np.unravel_index(cost.argmin(), cost.shape)
    return {
        "method": f"mean distance (cells, capped at {cap:g}) from data-edge cells to the final-perimeter "
                  f"boundary, for data shifts up to ±{radius} cells; offset is [east, south] in cells",
        "edge_cells": int(len(rows)),
        "within_1_cell_at_zero": round(float((dist[rows, cols] <= 1).mean()), 4),
        "mean_dist_at_zero": round(float(cost[radius, radius]), 4),
        "best_mean_dist": round(float(cost[bi, bj]), 4),
        "best_offset_px": [int(shifts[bj]), int(shifts[bi])],
        "background_median": round(float(np.median(cost)), 4),
    }


def perimeter_stats(dnbr: np.ndarray, cls: np.ndarray, inside: np.ndarray, grid: Grid) -> dict:
    valid = np.isfinite(dnbr)
    vin, vout = valid & inside, valid & ~inside
    n_in, n_vin = int(inside.sum()), int(vin.sum())
    counts = np.bincount(cls[vin], minlength=6)[1:]
    acres_per_cell = grid.cell_area_m2 / M2_PER_ACRE
    mean_in = float(dnbr[vin].mean()) if n_vin else None
    mean_out = float(dnbr[vout].mean()) if vout.any() else None
    return {
        "perimeter": {
            "cells": n_in,
            "valid_cells": n_vin,
            "coverage": round(n_vin / n_in, 4),
            "area_acres": round(n_in * acres_per_cell, 1),
            "covered_acres": round(n_vin * acres_per_cell, 1),
            "class_fraction_of_valid": {
                k: round(float(c) / n_vin, 4) if n_vin else None for k, c in zip(CLASS_LABELS, counts)
            },
            "class_acres": {k: round(float(c) * acres_per_cell, 1) for k, c in zip(CLASS_LABELS, counts)},
            "median_dnbr": round(float(np.median(dnbr[vin])), 4) if n_vin else None,
        },
        "mean_dnbr": {
            "inside": round(mean_in, 4) if mean_in is not None else None,
            "outside": round(mean_out, 4) if mean_out is not None else None,
            "difference": round(mean_in - mean_out, 4) if None not in (mean_in, mean_out) else None,
            "n_valid_inside": n_vin,
            "n_valid_outside": int(vout.sum()),
        },
        "valid_inside_fraction": round(n_vin / int(valid.sum()), 4),
        "grid_valid_fraction": round(float(valid.mean()), 4),
    }


def manifest_notes(stats: dict) -> str:
    p, m, a = stats["perimeter"], stats["mean_dnbr"], stats["georef_check"]
    cov, res = p["coverage"], stats["source"]["native_res_m"][0]
    notes = (
        f"Provisional JPL AVIRIS-3 dNBR (866/2198 nm), reprojected bilinearly from {res:g} m UTM 11N "
        f"to the ~16 m analysis grid. Valid data covers {cov:.1%} of the final perimeter "
        f"({p['covered_acres']:,.0f} of {p['area_acres']:,.0f} acres); the rest is left as no data. "
        f"Mean dNBR {m['inside']} inside vs {m['outside']} outside (n={m['n_valid_outside']} edge cells; "
        f"JPL clipped the product to a burn perimeter). Data edge best matches the perimeter edge at "
        f"offset {a['best_offset_px']} cells ({a['within_1_cell_at_zero']:.0%} of edge cells within 1 cell). "
        "severity.png: R = dNBR [-0.1, 1.0] -> 1..255 (0 = no data); G = class 0 none, 1 unburned <0.1, "
        "2 low, 3 moderate-low, 4 moderate-high, 5 high >=0.66."
    )
    if cov < 0.9:
        notes += (f" GAP: AVIRIS-3 flight lines miss {1 - cov:.0%} of the final perimeter; "
                  "no Sentinel-2 fallback is implemented yet.")
    return notes


def main() -> None:
    fire = load_fire()
    if fire.id not in PRODUCTS:
        raise SystemExit(f"s08_severity: no AVIRIS-3 dNBR product listed for '{fire.id}'")
    url = BASE_URL + PRODUCTS[fire.id]
    src = download(url, fire.raw_dir / "dnbr" / PRODUCTS[fire.id])
    grid = Grid.for_fire(fire)

    native, transform, crs, info = load_dnbr(src)
    dnbr = to_grid(native, transform, crs, grid)
    valid = np.isfinite(dnbr)
    if not valid.any():
        raise SystemExit("s08_severity: the dNBR product does not overlap the analysis grid")
    cls = classify(dnbr)

    perimeter = fire.read_json("final_perimeter.geojson")
    inside = grid.rasterize([f["geometry"] for f in perimeter["features"]]).astype(bool)

    np.save(fire.work_dir / "dnbr.npy", dnbr)
    Image.fromarray(encode_png(dnbr)).save(fire.out_dir / "severity.png")

    stats = {
        "source": {
            "url": url,
            "product": "JPL AVIRIS-3 provisional dNBR, NIR 866 nm / SWIR 2198 nm",
            "pre_date": "2024-09-05",
            "post_date": "2025-01-16",
            "provisional": True,
            "units": "unitless dNBR",
            "valid_range": [-VALID_ABS_MAX, VALID_ABS_MAX],
            **info,
        },
        "grid": {
            "width": grid.width,
            "height": grid.height,
            "bounds": list(grid.bounds),
            "pixel_m": [round(v, 2) for v in grid.pixel_m],
            "resampling": "bilinear",
        },
        "encoding": {
            "red": "dNBR clipped to [-0.1, 1.0] -> 1..255 linearly; 0 = no data; "
                   "dnbr = -0.1 + (R - 1) / 254 * 1.1",
            "green": {"0": "no data", **{str(i + 1): k for i, k in enumerate(CLASS_LABELS)}},
            "blue": "0",
            "class_edges": CLASS_EDGES,
        },
        **perimeter_stats(dnbr, cls, inside, grid),
        "georef_check": edge_alignment(valid, inside),
    }
    stats["notes"] = manifest_notes(stats)
    fire.write_json("severity_stats.json", stats)
    add_source(
        fire,
        layer="Burn severity (dNBR)",
        source="JPL AVIRIS-3 provisional dNBR (2024-09-05 to 2025-01-16)",
        url=BASE_URL,
        status="REAL",
        attribution="NASA JPL AVIRIS-3 (provisional product)",
        notes=stats["notes"],
    )

    p, m, a = stats["perimeter"], stats["mean_dnbr"], stats["georef_check"]
    print(f"{fire.name}: {info['native_valid_px']:,} native px ({info['masked_out_of_range_px']} masked "
          f"|dNBR|>{VALID_ABS_MAX:g}) -> {int(valid.sum()):,} grid cells")
    print(f"perimeter coverage {p['coverage']:.1%}; classes {p['class_fraction_of_valid']}")
    print(f"mean dNBR inside {m['inside']} vs outside {m['outside']} (n_out={m['n_valid_outside']}); "
          f"edge chamfer {a['mean_dist_at_zero']:.2f} cells at offset 0, best {a['best_offset_px']} "
          f"(background {a['background_median']:.2f})")
    print(f"wrote {fire.out_dir / 'severity.png'}, severity_stats.json and {fire.work_dir / 'dnbr.npy'}")


if __name__ == "__main__":
    main()
