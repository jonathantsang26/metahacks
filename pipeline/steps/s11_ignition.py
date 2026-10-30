"""Step 11: forensic ignition back-trace — where and when did the fire start?

Inverts the spread model (ember/spread.py) against the observed perimeters: for many candidate
(ignition cell, start time, spread-rate scale k) it simulates arrival times and scores them
against every observed footprint (inside should have burned by then, a band outside should not).
A two-stage search (coarse lattice, then a fine neighbourhood around the best candidates) finds
the maximum-likelihood ignition; relative likelihoods over all evaluated candidates give the
posterior heatmap, a 90% radius around the estimate and a 90% start-time interval. Their
temperature is calibrated per fire on its own synthetic cases (simulation-based calibration), and
the start time is reported only when that interval is narrow and the spread rate is not at the
model's ceiling.

Evaluation (all written under eval/):
  * Synthetic recovery benchmark: known ignitions on the real terrain, fuels and hourly wind,
    simulated with perturbed physics (per-fuel rates ±25–30%, wind ±15%) and noisy perimeters
    (±1 cell), observed on the fire's real perimeter schedule; the first two observations are
    held out, exactly as for the real fire. Errors are compared with naive baselines.
  * Real hold-out: fit only on perimeters after the first two, then predict the held-out
    footprints and compare the estimate with CAL FIRE's official start time and reported
    incident location (a reported location, not an investigated origin; never a fitting input).

Inputs:  perimeters.geojson (05), weather.json (07), work/<fire>/landcover.npy (03),
         work/<fire>/elevation.npy (02), aoi.json
Outputs: ignition.json, ignition_posterior.png (R = relative posterior 0–255),
         modeled_arrival.png (same encoding as arrival.png), eval/ignition_synthetic.json,
         eval/ignition_holdout.json

Run: uv run python -m steps.s11_ignition [--eval-only] [--cases 20]
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from dataclasses import dataclass
from datetime import timedelta

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_erosion
from shapely.geometry import box, mapping
from shapely.ops import unary_union

from ember import spread as sp
from ember.config import PIPELINE_DIR, load_fire
from ember.grid import Grid
from ember.manifest import add_source
from steps.s06_arrival import encode, iso, parse_t

FACTOR = 6                  # model cell = 6 analysis cells (~95 m)
FIT_HORIZON_H = 48          # fit observations within 48 h of the first one
HOLDOUT_N = 2               # the first two observations are held out in evaluation
K_GRID = 0.5 * np.sqrt(2) ** np.arange(15)   # 0.5 … 64: ERA5 point wind understates channelled gusts
LAGS_H = 0.5 * np.sqrt(2) ** np.arange(16)   # start 0.5 … 90 h before the first fitted footprint
K_TRUE_RANGE = (4.0, 16.0)  # synthetic truth spread-rate scale, log-uniform
EARLY_WEIGHT_H = 6.0       # observation weight 1 / (1 + Δt / 6 h): early footprints pin the start time
TAU_H = 0.15                # default temperature of the relative likelihood, in loss hours
TAUS_H = (0.15, 0.3, 0.6, 1.2, 2.4, 4.8, 9.6, 19.2, 38.4)  # candidates for the per-fire calibration
COVERAGE = 0.9
TIMING_MAX_WIDTH_H = 6.0    # report a start time only when its 90% interval is at most this wide
EARTH_M_PER_DEG = 111_320.0


# ----------------------------------------------------------------------------- model setup


def block_mode(arr: np.ndarray, f: int) -> np.ndarray:
    h, w = (arr.shape[0] // f) * f, (arr.shape[1] // f) * f
    blocks = arr[:h, :w].reshape(h // f, f, w // f, f)
    codes = np.unique(blocks)
    counts = np.stack([(blocks == c).sum(axis=(1, 3)) for c in codes])
    return codes[np.argmax(counts, axis=0)]


@dataclass
class Model:
    grid: Grid          # coarse model grid
    terrain: sp.Terrain
    wind: sp.Wind
    w0: object          # window start (datetime)


def fixture_path(fire) -> Path:
    return PIPELINE_DIR / "fixtures" / fire.id / "model_inputs.npz"


def coarse_inputs(fire) -> tuple[Grid, np.ndarray, np.ndarray]:
    """Coarse elevation and land cover on the model grid.

    Built from the full-resolution work arrays when they exist (and saved as a small committed
    fixture), otherwise loaded from that fixture, so `make eval` runs offline from a clean clone.
    """
    path = fixture_path(fire)
    if (fire.work_dir / "elevation.npy").exists() and (fire.work_dir / "landcover.npy").exists():
        grid, elev = Grid.for_fire(fire).resample(np.load(fire.work_dir / "elevation.npy"), FACTOR)
        landcover = block_mode(np.load(fire.work_dir / "landcover.npy"), FACTOR)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, elev=elev.astype(np.float32), landcover=landcover.astype(np.uint8),
                            grid=np.array([grid.west, grid.south, grid.east, grid.north, grid.width, grid.height]))
        return grid, elev, landcover
    z = np.load(path)
    w, s, e, n, width, height = z["grid"]
    return Grid(w, s, e, n, int(width), int(height)), z["elev"].astype(float), z["landcover"]


def build_model(fire) -> Model:
    grid, elev, landcover = coarse_inputs(fire)
    px, py = grid.pixel_m
    d_row, d_col = np.gradient(elev)
    dz_e, dz_n = d_col / px, -d_row / py
    slope = np.degrees(np.arctan(np.hypot(dz_e, dz_n)))
    aspect = (np.degrees(np.arctan2(-dz_e, -dz_n)) + 360) % 360  # downslope direction
    terrain = sp.terrain_from_rasters(landcover, slope, aspect, px, py)

    aoi = fire.read_json("aoi.json")
    w0 = parse_t(aoi["window_utc"][0])
    hourly = fire.read_json("weather.json")["hourly"]
    t_h = np.array([(parse_t(h["t"]) - w0).total_seconds() / 3600 for h in hourly])
    wind = sp.Wind.from_hourly(t_h, np.array([h["wind_mph"] for h in hourly], float),
                               np.array([h["wind_dir_deg"] for h in hourly], float))
    return Model(grid, terrain, wind, w0)


def observations(fire, model: Model):
    """Cumulative observed footprints on the model grid, within the fit horizon."""
    feats = sorted(fire.read_json("perimeters.geojson")["features"], key=lambda f: f["properties"]["t"])
    masks, times, cum = [], [], np.zeros(model.grid.shape, bool)
    for f in feats:
        t = (parse_t(f["properties"]["t"]) - model.w0).total_seconds() / 3600
        m = model.grid.rasterize([f["geometry"]]).astype(bool) | cum
        if times and t - times[0] > FIT_HORIZON_H:
            break
        if m.sum() > cum.sum():
            masks.append(m)
            times.append(t)
            cum = m
    return masks, np.array(times)


# ----------------------------------------------------------------------------- inversion


MAX_LATTICE = 150  # coarse candidate cells; spacing grows with the footprint


def lattice(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Candidate cells on a regular lattice inside the mask, and the lattice spacing in cells."""
    rows, cols = np.nonzero(mask)
    step = max(1, int(np.ceil(np.sqrt(len(rows) / MAX_LATTICE))))
    keep = (rows % step == 0) & (cols % step == 0)
    if keep.sum() < 12:  # small footprints: use every cell
        keep[:], step = True, 1
    return np.stack([rows[keep], cols[keep]], axis=1), step


def invert(model: Model, obs: sp.Observations, candidate_mask: np.ndarray, tau_h: float = TAU_H) -> dict:
    """Two-stage search over (cell, t0, k); returns the MAP, the relative posterior per cell, and
    every evaluated candidate with its loss (for uncertainty summaries at any temperature)."""
    terr = model.terrain
    packed = obs.packed(terr)
    burnable = candidate_mask & (terr.r0 > 0)
    t_first = float(obs.t_h[0])
    t_min = model.wind.t0_h  # no wind before the weather series starts

    cells, step = lattice(burnable)
    radius = max(2, step // 2 + 1)  # stage 2 covers the gaps between lattice points
    # Log-spaced lags: the start-time uncertainty grows with how long before the first map it was.
    t0s = t_first - LAGS_H[t_first - LAGS_H >= t_min]
    grid1 = np.array([(r, c, t, k) for r, c in cells for t in t0s for k in K_GRID], float)
    loss1 = sp.batch_losses(terr, model.wind, obs, grid1, packed=packed)

    # Stage 2: refine the 8 best distinct (cell, k) combinations.
    order = np.argsort(loss1)
    seeds, seen = [], set()
    for i in order:
        key = (int(grid1[i, 0]), int(grid1[i, 1]), grid1[i, 3])
        if key not in seen:
            seen.add(key)
            seeds.append(grid1[i])
        if len(seeds) == 8:
            break
    rr, cc = np.nonzero(burnable)
    fine = []
    for r, c, t, k in seeds:
        near = (np.abs(rr - r) <= radius) & (np.abs(cc - c) <= radius)
        stride = max(1, radius // 3)
        sel = near & (rr % stride == 0) & (cc % stride == 0) if stride > 1 else near
        half = max(1.5, 0.3 * (t_first - t))  # spans the neighbouring lags
        t2s = np.linspace(max(t - half, t_min), min(t + half, t_first - 0.1), 13)
        for r2, c2 in zip(rr[sel], cc[sel]):
            for t2 in t2s:
                for k2 in (k / 1.2, k, k * 1.2):
                    fine.append((r2, c2, t2, k2))
    grid2 = np.unique(np.array(fine, float), axis=0)
    loss2 = sp.batch_losses(terr, model.wind, obs, grid2, packed=packed)

    cands = np.vstack([grid1, grid2])
    losses = np.concatenate([loss1, loss2])
    best = cands[np.argmin(losses)]
    return {"row": int(best[0]), "col": int(best[1]), "t0_h": float(best[2]), "k": float(best[3]),
            "loss_h": float(losses.min()), "posterior": cell_posterior(cands, losses, terr.shape, tau_h),
            "evaluated": int(len(cands)), "cands": cands, "losses": losses}


def weights(losses: np.ndarray, tau_h: float) -> np.ndarray:
    w = np.exp(-(losses - losses.min()) / tau_h)
    return w / w.sum()


def cell_posterior(cands: np.ndarray, losses: np.ndarray, shape, tau_h: float) -> np.ndarray:
    post = np.zeros(shape)
    np.add.at(post, (cands[:, 0].astype(int), cands[:, 1].astype(int)), weights(losses, tau_h))
    return post


def weighted_quantile(v: np.ndarray, w: np.ndarray, q) -> np.ndarray:
    order = np.argsort(v)
    cw = np.cumsum(w[order])
    return v[order][np.minimum(np.searchsorted(cw, np.asarray(q) * cw[-1]), len(v) - 1)]


def uncertainty(est: dict, grid: Grid, tau_h: float) -> dict:
    """90% radius around the MAP cell and 90% start-time interval, at temperature tau_h."""
    c, w = est["cands"], weights(est["losses"], tau_h)
    px, py = grid.pixel_m
    d = np.hypot((c[:, 0] - est["row"]) * py, (c[:, 1] - est["col"]) * px)
    lo, hi = weighted_quantile(c[:, 2], w, [(1 - COVERAGE) / 2, (1 + COVERAGE) / 2])
    return {"r90_m": float(weighted_quantile(d, w, COVERAGE)), "t90_h": (float(lo), float(hi))}


def timing(est: dict, unc: dict) -> dict:
    """Whether the data pin down the start time (decided from the fit alone, never the reference)."""
    width = unc["t90_h"][1] - unc["t90_h"][0]
    reasons = []
    if width > TIMING_MAX_WIDTH_H:
        reasons.append(f"90% start-time interval is {width:.1f} h wide (limit {TIMING_MAX_WIDTH_H:g} h)")
    if est["k"] >= K_GRID[-1]:
        reasons.append("spread-rate scale is at the model's ceiling: the reanalysis wind is too weak to grow the "
                       "observed footprints, so start time and spread rate trade off")
    return {"identifiable": not reasons, "reasons": reasons, "interval90_width_h": round(width, 2)}


def credible_region(post: np.ndarray, grid: Grid, mass: float = 0.9):
    order = np.argsort(post.ravel())[::-1]
    n = int(np.searchsorted(np.cumsum(post.ravel()[order]), mass)) + 1
    rows, cols = np.unravel_index(order[:n], post.shape)
    dx = (grid.east - grid.west) / grid.width
    dy = (grid.north - grid.south) / grid.height
    boxes = [box(grid.west + c * dx, grid.north - (r + 1) * dy, grid.west + (c + 1) * dx, grid.north - r * dy)
             for r, c in zip(rows, cols)]
    region = unary_union(boxes).simplify(dx / 2)
    lon, lat = region.centroid.x, region.centroid.y
    area_km2 = region.area * EARTH_M_PER_DEG ** 2 * np.cos(np.radians(lat)) / 1e6
    return mapping(region), n, float(area_km2)


# ----------------------------------------------------------------------------- baselines & metrics


def dist_m(grid: Grid, rc_a, rc_b) -> float:
    px, py = grid.pixel_m
    return float(np.hypot((rc_a[0] - rc_b[0]) * py, (rc_a[1] - rc_b[1]) * px))


def centroid_baseline(mask: np.ndarray) -> tuple[float, float]:
    rows, cols = np.nonzero(mask)
    return float(rows.mean()), float(cols.mean())


def area_backcast_baseline(obs: sp.Observations, cell_area: float) -> float:
    """Start time from extrapolating sqrt(area) — a linear radius growth — back to zero."""
    r = np.sqrt(np.array([m.sum() for m in obs.masks]) * cell_area)
    t = obs.t_h
    if len(t) < 2:
        return float(t[0])
    slope, intercept = np.polyfit(t, r, 1)
    return float(-intercept / slope) if slope > 0 else float(t[0])


def weighted(masks, times) -> sp.Observations:
    t = np.asarray(times, float)
    return sp.Observations(list(masks), t, weights=1.0 / (1.0 + (t - t[0]) / EARLY_WEIGHT_H))


def holdout_split(masks, times):
    fit = weighted(masks[HOLDOUT_N:], times[HOLDOUT_N:])
    held = list(zip(masks[:HOLDOUT_N], times[:HOLDOUT_N]))
    return fit, held


# ----------------------------------------------------------------------------- synthetic benchmark


def synthetic_case(model: Model, schedule: np.ndarray, rng: np.random.Generator, case: int) -> dict | None:
    terr = model.terrain
    H, W = terr.shape
    margin = 15
    wild = np.isin(np.round(terr.r0), [18.0, 60.0, 90.0])  # tree, shrub, grass
    wild[:margin], wild[-margin:], wild[:, :margin], wild[:, -margin:] = False, False, False, False
    rows, cols = np.nonzero(wild)
    i = rng.integers(len(rows))
    truth_rc = (int(rows[i]), int(cols[i]))
    t0 = float(rng.uniform(2.0, 8.0))
    # Fast, wind-driven fires like the ones this tool targets: the real Eaton fit needs k ≈ 11.
    k_true = float(np.exp(rng.uniform(np.log(K_TRUE_RANGE[0]), np.log(K_TRUE_RANGE[1]))))

    # Truth physics differs from the model used for inversion (model error).
    r0_true = terr.r0.copy()
    for rate in np.unique(terr.r0[terr.r0 > 0]):
        r0_true[terr.r0 == rate] *= rng.uniform(0.75, 1.3)
    true_terr = sp.Terrain(r0_true, terr.waf, terr.up_e, terr.up_n, terr.tan_slope, terr.dx, terr.dy)
    scale = rng.uniform(0.85, 1.15)
    true_wind = sp.Wind(model.wind.u_mph * scale, model.wind.v_mph * scale, model.wind.t0_h, model.wind.dt_h)
    truth = sp.arrival(true_terr, true_wind, truth_rc, t0, k=k_true, t_stop_h=t0 + schedule[-1] + 1)

    masks, times = [], []
    for off in schedule:
        m = truth <= t0 + off
        noise = rng.integers(3)  # mapping error: erode, keep or dilate by one cell
        m = binary_erosion(m) if noise == 0 else (binary_dilation(m) if noise == 2 else m)
        if m.sum() >= 5 and (not masks or m.sum() > masks[-1].sum()):
            masks.append(m | (masks[-1] if masks else False))
            times.append(t0 + off)
    if len(masks) < HOLDOUT_N + 2:
        return None
    fit, _ = holdout_split(masks, np.array(times))
    est = invert(model, fit, fit.masks[0])
    base_rc = centroid_baseline(fit.masks[0])
    base_t = area_backcast_baseline(fit, model.grid.cell_area_m2)
    err_m = dist_m(model.grid, (est["row"], est["col"]), truth_rc)
    coverage = {}
    for tau in TAUS_H:
        u = uncertainty(est, model.grid, tau)
        coverage[str(tau)] = {"r90_m": round(u["r90_m"], 1), "t90_width_h": round(u["t90_h"][1] - u["t90_h"][0], 2),
                              "distance": bool(err_m <= u["r90_m"]),
                              "time": bool(u["t90_h"][0] - 1e-6 <= t0 <= u["t90_h"][1] + 1e-6)}
    return {
        "case": case, "truth": {"row": truth_rc[0], "col": truth_rc[1], "t0_h": round(t0, 3), "k": round(k_true, 3)},
        "estimate": {"row": est["row"], "col": est["col"], "t0_h": round(est["t0_h"], 3), "k": round(est["k"], 3)},
        "backtrace_dist_m": round(err_m, 1),
        "baseline_dist_m": round(dist_m(model.grid, base_rc, truth_rc), 1),
        "backtrace_time_err_min": round(abs(est["t0_h"] - t0) * 60, 1),
        "baseline_time_err_min": round(abs(base_t - t0) * 60, 1),
        "first_fit_obs_after_h": round(float(fit.t_h[0] - t0), 2),
        "coverage_by_tau": coverage,
    }


def calibrate(cases: list[dict]) -> dict:
    """Pick the smallest temperature whose 90% radius and interval cover the truth in at least 90%
    of the even-numbered cases; report coverage on the odd-numbered cases it never saw."""
    cal, test = cases[0::2], cases[1::2]

    def cover(subset, tau, key):
        return float(np.mean([c["coverage_by_tau"][str(tau)][key] for c in subset])) if subset else float("nan")

    by_tau = {str(t): {"calibration": {"distance": round(cover(cal, t, "distance"), 2), "time": round(cover(cal, t, "time"), 2)},
                       "test": {"distance": round(cover(test, t, "distance"), 2), "time": round(cover(test, t, "time"), 2)}}
              for t in TAUS_H}
    ok = [t for t in TAUS_H if cover(cal, t, "distance") >= COVERAGE and cover(cal, t, "time") >= COVERAGE]
    tau = ok[0] if ok else TAUS_H[-1]
    return {"tau_h": tau, "target": COVERAGE, "reached_on_calibration_half": bool(ok),
            "calibration_cases": len(cal), "test_cases": len(test),
            "test_coverage": by_tau[str(tau)]["test"],
            "median_test_r90_m": round(float(np.median([c["coverage_by_tau"][str(tau)]["r90_m"] for c in test])), 1) if test else None,
            "median_test_t90_width_h": round(float(np.median([c["coverage_by_tau"][str(tau)]["t90_width_h"] for c in test])), 2) if test else None,
            "by_tau": by_tau}


def summarize(cases: list[dict]) -> dict:
    def stats(key):
        v = np.array([c[key] for c in cases])
        return {"median": round(float(np.median(v)), 1), "p90": round(float(np.percentile(v, 90)), 1)}
    wins_d = np.mean([c["backtrace_dist_m"] < c["baseline_dist_m"] for c in cases])
    wins_t = np.mean([c["backtrace_time_err_min"] < c["baseline_time_err_min"] for c in cases])
    return {
        "n": len(cases),
        "distance_m": {"backtrace": stats("backtrace_dist_m"), "baseline_first_footprint_centroid": stats("baseline_dist_m")},
        "start_time_error_min": {"backtrace": stats("backtrace_time_err_min"), "baseline_area_backcast": stats("baseline_time_err_min")},
        "backtrace_beats_baseline": {"distance": round(float(wins_d), 2), "time": round(float(wins_t), 2)},
    }


# ----------------------------------------------------------------------------- outputs


def upsample(coarse: np.ndarray, fine: Grid) -> np.ndarray:
    r = np.minimum(np.arange(fine.height) // FACTOR, coarse.shape[0] - 1)
    c = np.minimum(np.arange(fine.width) // FACTOR, coarse.shape[1] - 1)
    return coarse[np.ix_(r, c)]


def iso_h(model: Model, t_h: float) -> str:
    return iso(model.w0 + timedelta(hours=float(t_h)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-only", action="store_true", help="only (re)write eval/*.json")
    ap.add_argument("--cases", type=int, default=20,
                    help="synthetic benchmark cases (0 = reuse the calibration in eval/ignition_synthetic.json)")
    args = ap.parse_args()

    fire = load_fire()
    model = build_model(fire)
    grid = model.grid
    masks, times = observations(fire, model)
    aoi = fire.read_json("aoi.json")
    inc = aoi["official"].get("incident")
    ref_t = (parse_t(inc["start_utc"]) - model.w0).total_seconds() / 3600 if inc else None
    eval_dir = Path(os.environ.get("EVAL_DIR") or fire.out_dir / "eval")
    eval_dir.mkdir(parents=True, exist_ok=True)

    # Synthetic recovery benchmark on this fire's terrain, wind and observation schedule: each
    # synthetic fire is observed with the same delays after ignition as the real one was. It also
    # calibrates the posterior temperature used for every uncertainty this step reports.
    syn_path = eval_dir / "ignition_synthetic.json"
    if args.cases > 0:
        schedule = times - (ref_t if inc else float(times[0]) - 4.0)
        schedule = schedule[schedule > 0]
        rng = np.random.default_rng(20250107)
        cases = []
        i = 0
        while len(cases) < args.cases and i < args.cases * 4:
            c = synthetic_case(model, schedule, rng, i)
            if c:
                cases.append(c)
            i += 1
        synthetic = {"config": {"cases": args.cases, "seed": 20250107, "model_cell_m": round(grid.pixel_m[0], 1),
                                "holdout_first_n": HOLDOUT_N, "schedule_h_after_ignition": [round(float(s), 2) for s in schedule],
                                "start_lags_h": [round(float(v), 2) for v in LAGS_H], "k_grid": [round(float(v), 2) for v in K_GRID],
                                "truth_perturbation": f"per-fuel R0 x U(0.75,1.3), wind x U(0.85,1.15), k log-uniform in {list(K_TRUE_RANGE)}, ±1-cell perimeter noise"},
                     "summary": summarize(cases), "calibration": calibrate(cases), "cases": cases}
        syn_path.write_text(json.dumps(synthetic, indent=2) + "\n")
        print("synthetic:", json.dumps(synthetic["summary"]))
    else:
        synthetic = json.loads(syn_path.read_text())
    cal = synthetic.get("calibration") or {"tau_h": TAU_H}
    tau = float(cal["tau_h"])
    print("calibration:", json.dumps({k: cal[k] for k in cal if k != "by_tau"}))

    # Real hold-out: never sees the first two footprints or the CAL FIRE reference.
    fit, held = holdout_split(masks, times)
    est = invert(model, fit, fit.masks[0], tau)
    unc = uncertainty(est, grid, tau)
    pred = sp.arrival(model.terrain, model.wind, (est["row"], est["col"]), est["t0_h"], k=est["k"])
    holdout = {
        "fit_observations": [iso_h(model, t) for t in fit.t_h],
        "held_out": [{"t": iso_h(model, t), "observed_cells": int(m.sum()),
                      "predicted_cells": int((pred <= t).sum()), "iou": round(sp.iou(pred <= t, m), 3)}
                     for m, t in held],
        "estimate": {"lonlat": [round(float(v), 6) for v in grid.to_lonlat(est["col"], est["row"])],
                     "t": iso_h(model, est["t0_h"]), "k": round(est["k"], 3),
                     "r90_m": round(unc["r90_m"], 1), "t90": [iso_h(model, t) for t in unc["t90_h"]],
                     "timing": timing(est, unc), "tau_h": tau},
        "baselines": {
            "first_fit_footprint_centroid_lonlat": [round(float(v), 6) for v in grid.to_lonlat(*centroid_baseline(fit.masks[0])[::-1])],
            "area_backcast_t": iso_h(model, area_backcast_baseline(fit, grid.cell_area_m2)),
        },
    }
    if inc:
        ref_c, ref_r = grid.to_px(*inc["reported_location"])
        base_rc = centroid_baseline(fit.masks[0])
        d_ref = dist_m(grid, (est["row"], est["col"]), (ref_r, ref_c))
        holdout["reference"] = {"source": inc["source"], "url": inc["url"], "t": inc["start_utc"],
                                "lonlat": inc["reported_location"],
                                "note": "Reported incident location, not an investigated origin."}
        holdout["errors"] = {
            "backtrace_distance_m": round(d_ref, 1),
            "baseline_distance_m": round(dist_m(grid, base_rc, (ref_r, ref_c)), 1),
            "backtrace_time_error_min": round((est["t0_h"] - ref_t) * 60, 1),
            "baseline_time_error_min": round((area_backcast_baseline(fit, grid.cell_area_m2) - ref_t) * 60, 1),
            "reference_within_r90": bool(d_ref <= unc["r90_m"]),
            "reference_within_t90": bool(unc["t90_h"][0] <= ref_t <= unc["t90_h"][1]),
        }
    (eval_dir / "ignition_holdout.json").write_text(json.dumps(holdout, indent=2) + "\n")
    print("holdout:", json.dumps(holdout.get("errors", {})), [h["iou"] for h in holdout["held_out"]],
          json.dumps(holdout["estimate"]["timing"]))
    if args.eval_only:
        return

    # Product: best estimate using every observation in the fit horizon.
    full = weighted(masks, times)
    best = invert(model, full, full.masks[0], tau)
    unc = uncertainty(best, grid, tau)
    tm = timing(best, unc)
    region, n_cells, area_km2 = credible_region(best["posterior"], grid)
    modeled = sp.arrival(model.terrain, model.wind, (best["row"], best["col"]), best["t0_h"], k=best["k"])
    agreement = [round(sp.iou(modeled <= t, m), 3) for m, t in zip(masks, times)]
    fine = Grid.for_fire(fire)
    w1 = parse_t(aoi["window_utc"][1])
    window_h = (w1 - model.w0).total_seconds() / 3600
    modeled_fine = upsample(np.where(np.isfinite(modeled), modeled, np.nan).astype(np.float32), fine)
    Image.fromarray(encode(modeled_fine, np.full(modeled_fine.shape, 255, np.uint8), window_h)).save(fire.out_dir / "modeled_arrival.png")
    post = upsample(best["posterior"] / best["posterior"].max(), fine)
    Image.fromarray((post * 255).astype(np.uint8)).save(fire.out_dir / "ignition_posterior.png")

    lon, lat = grid.to_lonlat(best["col"], best["row"])
    fire.write_json("ignition.json", {
        "map": {"lon": round(float(lon), 6), "lat": round(float(lat), 6),
                "t": iso_h(model, best["t0_h"]), "k": round(best["k"], 3)},
        "r90_m": round(unc["r90_m"], 1), "t90": [iso_h(model, t) for t in unc["t90_h"]], "timing": tm,
        "region90": region, "region90_cells": n_cells, "region90_km2": round(area_km2, 2),
        "loss_h": round(best["loss_h"], 3), "candidates_evaluated": best["evaluated"],
        "observations_used": len(masks), "first_observation": iso_h(model, times[0]),
        "modeled_vs_observed_iou": agreement,
        "calibration": {k: cal[k] for k in cal if k != "by_tau"},
        "holdout": {k: holdout[k] for k in ("held_out", "errors") if k in holdout},
        "synthetic_summary": synthetic["summary"],
        "model_card": "Elliptical rate-of-spread model with per-fuel base rates (ESA WorldCover classes), "
                      "power-law wind and tan²-slope terms, single-point ERA5 wind; no spotting, crown fire, "
                      f"suppression or spatial wind. Relative posterior over evaluated candidates, tau = {tau:g} h "
                      "(calibrated on this fire's synthetic cases).",
    })
    for layer, notes in (("Ignition probability", f"Back-trace over {best['evaluated']:,} candidates; 90% radius {unc['r90_m']:.0f} m."),
                         ("Fire spread (modeled)", f"Forward run from the estimate; IoU vs observed footprints {agreement}.")):
        add_source(fire, layer=layer, source="Sentinel Ember back-trace (pipeline step 11)", url="", status="MODELED", notes=notes)
    print(f"estimate {lon:.5f},{lat:.5f} at {iso_h(model, best['t0_h'])} k={best['k']:.2f}; 90% radius {unc['r90_m']:.0f} m, "
          f"t90 {[iso_h(model, t) for t in unc['t90_h']]}; timing {json.dumps(tm)}; IoU {agreement}")


if __name__ == "__main__":
    main()
