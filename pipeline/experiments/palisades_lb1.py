"""One-off check: at length-to-breadth cap 1.0, would Palisades' start time still be withheld?

The shipped Palisades fit (ignition.json) selects cap 1.5, where the spread-rate scale k sits at
the model's ceiling, and withholds the start time. Its `lb_selection` table shows the cap-1.0 fit
with k = 37.7, below the ceiling, at a loss only ~0.024 h worse. This script refits Palisades at
cap 1.0 exactly as the product fit does (s11.invert on every footprint in the fit horizon, the
search confined to the first footprint) and applies the shipped uncertainty and timing logic at the
committed calibration temperature (ignition.json `calibration.tau_h`): the 90% region, the 90%
start-time interval and each of the three conditions that withhold the start time.

As a control it also refits the shipped cap (ignition.json `map.lb_max`) and checks that the same
code reproduces the committed estimate, interval and region. Nothing shipped is changed: s11 is
imported, not modified, and the only file written is experiments/palisades_lb1.json.

Each fit is also compared with CAL FIRE's reported start time and incident location (aoi.json),
as s11's real hold-out does: evaluation only, never a fitting input, and a reported location, not
an investigated origin.

Caveat recorded in the output: the committed temperature was calibrated on synthetic cases built
and inverted at the shipped cap. Recalibrating at cap 1.0 means rerunning the synthetic benchmark
(~100 min); this check uses the committed value, as a one-off.

Run from pipeline/: uv run python -m experiments.palisades_lb1   (about 4 min per fit on 4 cores)
Writes: experiments/palisades_lb1.json
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from shapely.geometry import Point, shape

from ember import spread as sp
from ember.config import load_fire
from steps import s11_ignition as s11
from steps.s06_arrival import parse_t

FIRE_ID = "palisades"
CAP = 1.0


def region_cut_ties(post: np.ndarray, n: int) -> dict:
    """Cells tied with the last cell inside the 90% region (cells sharing a lattice owner have equal
    posterior), and how many of them made it in: the tie order decides the region's exact shape."""
    flat = post.ravel()
    order = np.argsort(flat)[::-1]  # as s11.credible_region orders them
    cut = flat[order[n - 1]]
    return {"tied_cells": int((flat == cut).sum()), "tied_cells_inside": int((flat[order[:n]] == cut).sum())}


def fit_at(model: s11.Model, masks, times, lb: float, tau: float, calibrated: bool, ref: dict | None) -> dict:
    """The product fit at one length-to-breadth cap, with the shipped uncertainty and timing logic."""
    full = s11.weighted(masks, times)
    model.lb = lb
    t_start = time.time()
    est = s11.invert(model, full, full.masks[0], tau)  # posterior at tau, as the product recomputes it
    seconds = round(time.time() - t_start)
    grid = model.grid
    unc = s11.uncertainty(est, grid, tau)
    tm = s11.timing(est, unc, calibrated)
    lo, hi = unc["t90_h"]
    width = hi - lo
    region, n_cells, area_km2 = s11.credible_region(est["posterior"], grid)
    fwd = sp.arrival(model.terrain, model.wind, (est["row"], est["col"]), est["t0_h"], k=est["k"], lb_max=lb)
    ious = [round(sp.iou(fwd <= t, m), 3) for m, t in zip(masks, times)]
    lon, lat = (float(v) for v in grid.to_lonlat(est["col"], est["row"]))

    # The posterior over the stage-1 grid at tau: how far it leans on the k ceiling, and how the
    # interval width would move with the temperature (context only; tau is the calibrated one).
    w = s11.weights(est["grid_losses"], tau)
    ks = est["grid_cands"][:, 3]
    k_lo, k_med, k_hi = s11.weighted_quantile(ks, w, [0.05, 0.5, 0.95])
    width_by_tau = {}
    for t in s11.TAUS_H:
        u = s11.uncertainty(est, grid, t)
        width_by_tau[str(t)] = {"t90_width_h": round(u["t90_h"][1] - u["t90_h"][0], 2), "r90_m": round(u["r90_m"], 1)}

    # Where the start-time interval sits on the lag grid: the search allows starts from
    # LAGS_H[0] = 0.5 h before the first footprint back to LAGS_H[-1] (or the start of the wind).
    t_first = float(times[0])
    lags = {"map_h": round(t_first - est["t0_h"], 2), "t90_h": [round(t_first - hi, 2), round(t_first - lo, 2)],
            "latest_allowed_h": float(s11.LAGS_H[0]),
            "t90_ends_at_latest_allowed_start": bool(abs(hi - (t_first - s11.LAGS_H[0])) < 1e-6)}

    k_ceiling = float(s11.K_GRID[-1])
    row = {
        "lb_max": lb,
        "map": {"lonlat": [round(lon, 6), round(lat, 6)], "row": est["row"], "col": est["col"],
                "t": s11.iso_h(model, est["t0_h"]), "k": round(est["k"], 3), "loss_h": round(est["loss_h"], 4)},
        "candidates_evaluated": est["evaluated"],
        "r90_m": round(unc["r90_m"], 1),
        "t90": [s11.iso_h(model, t) for t in (lo, hi)],
        "t90_width_h": round(width, 2),
        "region90_cells": n_cells,
        "region90_km2": round(area_km2, 2),
        "region90_cut": region_cut_ties(est["posterior"], n_cells),
        "gates": {
            "interval_wider_than_6h": bool(width > s11.TIMING_MAX_WIDTH_H),
            "k_at_ceiling": bool(est["k"] >= k_ceiling),
            "uncalibrated": not calibrated,
        },
        "start_time_withheld": not tm["identifiable"],
        "timing": tm,  # s11.timing's own verdict and reasons, unchanged
        "start_lag_before_first_footprint": lags,
        "posterior_k": {"q05": round(float(k_lo), 3), "median": round(float(k_med), 3), "q95": round(float(k_hi), 3),
                        "mass_at_or_above_ceiling": round(float(w[ks >= k_ceiling].sum()), 3)},
        "t90_width_by_tau": width_by_tau,
        "modeled_vs_observed_iou": ious,
        "mean_iou": round(float(np.mean(ious)), 3),
        "seconds": seconds,
    }
    if ref:
        d_ref = s11.dist_m(grid, (est["row"], est["col"]), (ref["row"], ref["col"]))
        row["vs_cal_fire_reference"] = {
            "map_minus_reference_h": round(est["t0_h"] - ref["t_h"], 2),
            "reference_within_t90": bool(lo <= ref["t_h"] <= hi),
            "t90_misses_reference_by_h": round(max(0.0, lo - ref["t_h"], ref["t_h"] - hi), 2),
            "map_distance_m": round(d_ref, 1),
            "reference_within_r90": bool(d_ref <= unc["r90_m"]),
            "reference_inside_region90": bool(shape(region).contains(Point(ref["lonlat"]))),
        }
    row["region90"] = region
    return row


def main() -> None:
    fire = load_fire(FIRE_ID)
    shipped = json.loads((fire.out_dir / "ignition.json").read_text())
    tau = float(shipped["calibration"]["tau_h"])
    calibrated = bool(shipped["uncertainty_calibrated"])
    shipped_lb = float(shipped["map"]["lb_max"])
    committed_row = {r["lb_max"]: r for r in shipped["lb_selection"]}

    model = s11.build_model(fire)
    masks, times = s11.observations(fire, model)
    inc = fire.read_json("aoi.json")["official"].get("incident")
    ref = None
    if inc:
        ref_c, ref_r = model.grid.to_px(*inc["reported_location"])
        ref = {"t_h": (parse_t(inc["start_utc"]) - model.w0).total_seconds() / 3600, "row": float(ref_r),
               "col": float(ref_c), "lonlat": inc["reported_location"]}

    fits = {}
    for lb in (CAP, shipped_lb):
        fits[f"{lb:g}"] = row = fit_at(model, masks, times, lb, tau, calibrated, ref)
        print(json.dumps({k: v for k, v in row.items() if k not in ("region90", "t90_width_by_tau")}), flush=True)

    lb1, ctrl = fits[f"{CAP:g}"], fits[f"{shipped_lb:g}"]
    # Do the refits match what the shipped pipeline committed?
    ctrl_region, shipped_region = shape(ctrl.pop("region90")), shape(shipped["region90"])
    reproduction = {
        "cap_1_matches_committed_lb_selection": bool(
            lb1["map"]["loss_h"] == committed_row[CAP]["loss_h"] and lb1["map"]["k"] == committed_row[CAP]["k"]),
        "shipped_cap_matches_committed_estimate_interval_and_timing": bool(
            ctrl["map"]["lonlat"] == [shipped["map"]["lon"], shipped["map"]["lat"]]
            and ctrl["map"]["t"] == shipped["map"]["t"] and ctrl["map"]["k"] == shipped["map"]["k"]
            and ctrl["map"]["loss_h"] == committed_row[shipped_lb]["loss_h"]
            and ctrl["t90"] == shipped["t90"] and ctrl["r90_m"] == shipped["r90_m"]
            and ctrl["timing"] == shipped["timing"]),
        "shipped_cap_region90": {
            "cells": ctrl["region90_cells"], "committed_cells": shipped["region90_cells"],
            "km2": ctrl["region90_km2"], "committed_km2": shipped["region90_km2"],
            "symmetric_difference_fraction_of_committed_area":
                round(float(ctrl_region.symmetric_difference(shipped_region).area / shipped_region.area), 4)},
    }
    px, py = model.grid.pixel_m
    map_shift_m = float(np.hypot((lb1["map"]["row"] - ctrl["map"]["row"]) * py, (lb1["map"]["col"] - ctrl["map"]["col"]) * px))
    t_shift_h = (parse_t(lb1["map"]["t"]) - parse_t(ctrl["map"]["t"])).total_seconds() / 3600

    out = Path(__file__).with_name(f"{FIRE_ID}_lb1.json")
    out.write_text(json.dumps({
        "fire": FIRE_ID,
        "question": "At length-to-breadth cap 1.0, would Palisades' start time still be withheld?",
        "answer": {"start_time_withheld_at_cap_1": lb1["start_time_withheld"],
                   "reasons": lb1["timing"]["reasons"], "gates": lb1["gates"],
                   "t": lb1["map"]["t"], "t90": lb1["t90"], "t90_width_h": lb1["t90_width_h"], "k": lb1["map"]["k"],
                   **({"reference_within_t90": lb1["vs_cal_fire_reference"]["reference_within_t90"],
                       "t90_misses_reference_by_h": lb1["vs_cal_fire_reference"]["t90_misses_reference_by_h"]}
                      if ref else {})},
        "setup": {
            "tau_h": tau, "tau_source": "committed ignition.json calibration.tau_h (all-observations calibration)",
            "uncertainty_calibrated": calibrated,
            "calibration_note": f"tau was calibrated on synthetic cases generated and inverted at cap {shipped_lb:g}; "
                                "it is not recalibrated at cap 1.0 here",
            "timing_max_width_h": s11.TIMING_MAX_WIDTH_H,
            "k_ceiling": float(s11.K_GRID[-1]),
            "k_ceiling_note": "the gate is k >= the top of the stage-1 k grid; stage 2 can reach "
                              f"{float(s11.K_GRID[-1]) * 1.2:g} (k x 1.2), the value the shipped fit reports",
            "observations_used": len(masks), "first_observation": s11.iso_h(model, times[0]),
            "model_cell_m": round(px, 1),
            "reference": ({"source": inc["source"], "t": inc["start_utc"], "lonlat": inc["reported_location"],
                           "note": "Reported start time and incident location, not an investigated origin; "
                                   "evaluation only, never a fitting input."} if inc else None),
        },
        "reproduction": reproduction,
        "cap_1_vs_shipped": {"map_shift_m": round(map_shift_m, 1), "start_time_shift_h": round(t_shift_h, 2),
                             "loss_diff_h": round(lb1["map"]["loss_h"] - ctrl["map"]["loss_h"], 4),
                             "t90_width_diff_h": round(lb1["t90_width_h"] - ctrl["t90_width_h"], 2)},
        "fits": fits,
    }, indent=2) + "\n")
    print("wrote", out.name)


if __name__ == "__main__":
    main()
