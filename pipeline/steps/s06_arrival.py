"""Step 06: arrival-time raster (when each cell burned) and the series derived from it.

Inputs:  perimeters.geojson (step 05, cumulative footprints with times), final_perimeter.geojson,
         aoi.json (window, official start), work/<fire>/elevation.npy, hotspots.geojson (step 04,
         optional: refines arrival where a satellite saw fire earlier than the perimeters imply)
Outputs: arrival.png       R = 1..254 → (code−1)/253 of aoi.window_utc, 255 = never burned;
                           G = interpolation confidence (255 = interval ≤ 2 h … 64 = ≥ 12 h)
         arrival_meta.json observation intervals, seed and method
         series.json       hourly cumulative area (acres) and head rate of spread (chains/hr)
         spine.geojson     path from the first-burned area to the farthest early run, with
                           waypoints every 6 local hours
         profile.json      elevation and arrival time along the spine
         work/<fire>/arrival_hours.npy  float32 hours since the window start, NaN = unburned

Interpolation: between consecutive footprints M_{k-1} ⊂ M_k observed at T_{k-1} < T_k, a newly
burned cell's arrival is T_{k-1} + (T_k − T_{k-1}) · d_in / (d_in + d_out), where d_in is its
distance to M_{k-1} and d_out its distance to the edge of M_k. The first footprint is seeded from
CAL FIRE's official start time and reported location. This is an interpolation of observations,
not a model run; step 11 fits the physics model to the footprints directly.

Run: uv run python -m steps.s06_arrival
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter

from ember.config import load_fire
from ember.grid import Grid
from ember.manifest import add_source

ACRE_M2 = 4046.8564
CHAIN_M = 20.1168
RUN_HORIZON_H = 12.0  # the spine follows the first 12 hours of spread


def parse_t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_footprints(fire, grid: Grid, w0: datetime):
    fc = json.loads((fire.out_dir / "perimeters.geojson").read_text())
    feats = sorted(fc["features"], key=lambda f: f["properties"]["t"])
    times, masks = [], []
    cum = np.zeros(grid.shape, bool)
    for f in feats:
        m = grid.rasterize([f["geometry"]]).astype(bool) | cum  # enforce cumulative
        if m.sum() <= cum.sum():
            continue  # no new burned cells at this grid resolution
        cum = m
        times.append((parse_t(f["properties"]["t"]) - w0).total_seconds() / 3600)
        masks.append(m)
    return np.array(times), masks


def seed_cell(fire, grid: Grid, first: np.ndarray, w0: datetime, t_first: float):
    inc = fire.read_json("aoi.json")["official"].get("incident")
    rows, cols = np.nonzero(first)
    if inc:
        lon, lat = inc["reported_location"]
        c, r = (int(round(v)) for v in grid.to_px(lon, lat))
        t_seed = (parse_t(inc["start_utc"]) - w0).total_seconds() / 3600
        source = "CAL FIRE official start and reported location"
    else:
        r, c = int(np.median(rows)), int(np.median(cols))
        t_seed = t_first - 1.0
        source = "first footprint median cell, first observation − 1 h"
    if not (0 <= r < grid.height and 0 <= c < grid.width and first[r, c]):
        i = np.argmin((rows - r) ** 2 + (cols - c) ** 2)  # snap into the first footprint
        r, c = int(rows[i]), int(cols[i])
    return (r, c), min(t_seed, t_first - 0.25), source


def interpolate(masks, times, seed_rc, t_seed, sampling):
    arrival = np.full(masks[0].shape, np.nan, np.float32)
    confidence = np.zeros(masks[0].shape, np.uint8)
    prev = np.zeros_like(masks[0])
    prev[seed_rc] = True
    t_prev = t_seed
    intervals = []
    for m, t in zip(masks, times):
        new = m & ~prev
        if new.any():
            d_in = distance_transform_edt(~prev, sampling=sampling)
            d_out = distance_transform_edt(m, sampling=sampling)
            frac = d_in / np.maximum(d_in + d_out, 1e-6)
            arrival[new] = (t_prev + (t - t_prev) * frac[new]).astype(np.float32)
            hours = t - t_prev
            confidence[new] = int(np.clip(255 - (hours - 2) * (191 / 10), 64, 255))
        intervals.append({"from_h": t_prev, "to_h": float(t), "new_cells": int(new.sum())})
        prev, t_prev = prev | m, t
    arrival[tuple(seed_rc)] = t_seed
    confidence[tuple(seed_rc)] = 255
    return arrival, confidence, intervals


def refine_with_hotspots(fire, grid: Grid, arrival: np.ndarray, w0: datetime) -> int:
    path = fire.out_dir / "hotspots.geojson"
    if not path.exists():
        return 0
    n = 0
    for f in json.loads(path.read_text())["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        c, r = (int(round(v)) for v in grid.to_px(lon, lat))
        if not (0 <= r < grid.height and 0 <= c < grid.width) or np.isnan(arrival[r, c]):
            continue
        t = (parse_t(f["properties"]["t"]) - w0).total_seconds() / 3600
        if t < arrival[r, c]:
            arrival[r, c] = t
            n += 1
    return n


def encode(arrival: np.ndarray, confidence: np.ndarray, window_h: float) -> np.ndarray:
    code = np.full(arrival.shape, 255, np.uint8)
    burned = ~np.isnan(arrival)
    code[burned] = (1 + np.round(253 * np.clip(arrival[burned] / window_h, 0, 1))).astype(np.uint8)
    return np.dstack([code, confidence, np.zeros_like(code)])


def series(arrival: np.ndarray, grid: Grid, window_h: float, w0: datetime):
    px, py = grid.pixel_m
    smooth = gaussian_filter(np.nan_to_num(arrival, nan=np.nanmax(arrival) + 24), 1.5)
    gy, gx = np.gradient(smooth, py, px)  # hours per meter
    speed = 1.0 / np.maximum(np.hypot(gx, gy), 1e-6)  # m/h
    burned = ~np.isnan(arrival)
    ts, area, ros = [], [], []
    for h in range(int(np.floor(window_h)) + 1):
        ts.append(iso(w0 + timedelta(hours=h)))
        area.append(round(float((arrival[burned] <= h).sum() * grid.cell_area_m2 / ACRE_M2), 1))
        front = burned & (arrival > h - 1) & (arrival <= h)
        ros.append(round(float(np.percentile(speed[front], 90) / CHAIN_M), 1) if front.sum() >= 20 else 0.0)
    return {"t": ts, "area_acres": area, "ros_chains_hr": ros}


def trace_spine(arrival: np.ndarray, seed_rc, grid: Grid, horizon_h: float):
    # The head of the initial run: the cell burned within the horizon that lies farthest from
    # the seed. A short horizon isolates the first wind-driven run before the fire spreads in
    # every direction (for Eaton, the overnight run west into Altadena).
    px, py = grid.pixel_m
    rr, cc = np.indices(arrival.shape)
    early = ~np.isnan(arrival) & (arrival <= horizon_h)
    dist = np.hypot((rr - seed_rc[0]) * py, (cc - seed_rc[1]) * px)
    dist[~early] = -1
    head = np.unravel_index(np.argmax(dist), dist.shape)
    smooth = gaussian_filter(np.nan_to_num(arrival, nan=np.nanmax(arrival) + 48), 3)
    path = [head]
    r, c = head
    for _ in range(4 * max(arrival.shape)):
        if abs(r - seed_rc[0]) <= 2 and abs(c - seed_rc[1]) <= 2:
            break
        win = smooth[max(r - 1, 0):r + 2, max(c - 1, 0):c + 2]
        dr, dc = np.unravel_index(np.argmin(win), win.shape)
        nr, nc = max(r - 1, 0) + dr, max(c - 1, 0) + dc
        if (nr, nc) == (r, c):
            break  # local minimum: finish with a straight segment to the seed
        r, c = nr, nc
        path.append((r, c))
    path.append(tuple(seed_rc))
    return path[::-1]


def spine_outputs(path, arrival, elev, grid: Grid, w0: datetime, tz: ZoneInfo):
    lon, lat = grid.to_lonlat(np.array([p[1] for p in path]), np.array([p[0] for p in path]))
    coords = [[round(float(x), 6), round(float(y), 6)] for x, y in zip(lon, lat)]
    t_h = np.array([arrival[p] for p in path], float)
    t_h = np.fmax.accumulate(np.nan_to_num(t_h, nan=np.nanmin(t_h)))  # monotone along the run
    px, py = grid.pixel_m
    steps = [0.0] + [float(np.hypot((b[0] - a[0]) * py, (b[1] - a[1]) * px)) for a, b in zip(path, path[1:])]
    dist_km = np.cumsum(steps) / 1000
    features = [{"type": "Feature", "properties": {"kind": "spine"},
                 "geometry": {"type": "LineString", "coordinates": coords}}]
    # Waypoints where the run crosses whole local-clock multiples of `every` hours (in the
    # incident's time zone), spaced so a short run still gets 3–6 labels.
    span = t_h[-1] - t_h[0]
    every = next((h for h in (1, 2, 3, 6, 12) if span / h <= 6), 24)
    local0 = w0.astimezone(tz)
    offset = (local0.hour % every) + local0.minute / 60  # local clock at t=0, modulo `every`
    mark = t_h[0] + ((-(offset + t_h[0])) % every)
    while mark <= t_h[-1]:
        i = int(np.searchsorted(t_h, mark))
        if 0 < i < len(path):
            when = w0 + timedelta(hours=float(mark))
            features.append({"type": "Feature",
                             "properties": {"kind": "waypoint", "t": iso(when),
                                            "label": when.astimezone(tz).strftime("%b %-d, %H:%M")},
                             "geometry": {"type": "Point", "coordinates": coords[i]}})
        mark += every
    elev_along = [float(elev[p]) for p in path]
    sample = np.unique(np.searchsorted(dist_km, np.arange(0, dist_km[-1] + 1e-9, 0.1)).clip(0, len(path) - 1))
    profile = {
        "distance_km": [round(float(dist_km[i]), 3) for i in sample],
        "elevation_m": [round(elev_along[i], 1) for i in sample],
        "t": [iso(w0 + timedelta(hours=float(t_h[i]))) for i in sample],
    }
    return {"type": "FeatureCollection", "features": features}, profile


def main() -> None:
    fire = load_fire()
    aoi = fire.read_json("aoi.json")
    grid = Grid.for_fire(fire)
    w0, w1 = (parse_t(s) for s in aoi["window_utc"])
    window_h = (w1 - w0).total_seconds() / 3600
    px, py = grid.pixel_m

    times, masks = load_footprints(fire, grid, w0)
    final = grid.rasterize([f["geometry"] for f in fire.read_json("final_perimeter.geojson")["features"]]).astype(bool)
    seed_rc, t_seed, seed_source = seed_cell(fire, grid, masks[0], w0, float(times[0]))
    arrival, confidence, intervals = interpolate(masks, times, seed_rc, t_seed, (py, px))

    # Cells inside CAL FIRE's final perimeter that no timed footprint covers: burned by the last
    # observation at the latest, flagged with the lowest confidence.
    late = final & np.isnan(arrival)
    arrival[late] = times[-1]
    confidence[late] = 32
    n_refined = refine_with_hotspots(fire, grid, arrival, w0)

    np.save(fire.work_dir / "arrival_hours.npy", arrival)
    Image.fromarray(encode(arrival, confidence, window_h)).save(fire.out_dir / "arrival.png")
    fire.write_json("arrival_meta.json", {
        "window_utc": aoi["window_utc"],
        "encoding": "R: 1..254 = (code-1)/253 of the window, 255 = never burned; G: confidence",
        "seed": {"source": seed_source, "t": iso(w0 + timedelta(hours=t_seed)),
                 "lonlat": [round(float(v), 6) for v in grid.to_lonlat(seed_rc[1], seed_rc[0])]},
        "intervals": [{**iv, "from": iso(w0 + timedelta(hours=iv["from_h"])),
                       "to": iso(w0 + timedelta(hours=iv["to_h"]))} for iv in intervals],
        "late_cells_from_final_perimeter": int(late.sum()),
        "hotspot_refinements": n_refined,
        "burned_acres": round(float((~np.isnan(arrival)).sum() * grid.cell_area_m2 / ACRE_M2), 1),
    })

    fire.write_json("series.json", series(arrival, grid, window_h, w0))
    elev = np.load(fire.work_dir / "elevation.npy")
    path = trace_spine(arrival, seed_rc, grid, horizon_h=t_seed + RUN_HORIZON_H)
    spine, profile = spine_outputs(path, arrival, elev, grid, w0, ZoneInfo(aoi["timezone"]))
    fire.write_json("spine.geojson", spine)
    fire.write_json("profile.json", profile)

    add_source(
        fire, layer="Fire progression (arrival time)", source="Interpolated from timed NIFC perimeters",
        url="", status="REAL",
        notes=f"{len(masks)} observed footprints; first interval seeded by {seed_source}; "
              f"{int(late.sum())} cells only in the final perimeter; {n_refined} hotspot refinements.",
    )
    gaps = [iv["to_h"] - iv["from_h"] for iv in intervals]
    print(f"{len(masks)} footprints, seed {seed_source} at {t_seed:.2f} h; longest gap {max(gaps):.1f} h; "
          f"burned {(~np.isnan(arrival)).sum() * grid.cell_area_m2 / ACRE_M2:,.0f} acres; spine {len(path)} cells")


if __name__ == "__main__":
    main()
