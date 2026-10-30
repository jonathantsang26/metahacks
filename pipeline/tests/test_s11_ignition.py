"""Back-trace outputs, and a recovery check on the real Eaton model grid (committed fixture)."""

import numpy as np
from shapely.geometry import Point, shape

from ember import spread as sp
from steps import s11_ignition as s11


def test_ignition_outputs(fire):
    ign = fire.read_json("ignition.json")
    region = shape(ign["region90"])
    assert region.buffer(0.002).contains(Point(ign["map"]["lon"], ign["map"]["lat"]))
    assert ign["candidates_evaluated"] > 1000
    assert len(ign["modeled_vs_observed_iou"]) == ign["observations_used"]
    syn = fire.read_json("eval/ignition_synthetic.json")
    assert syn["summary"]["n"] == len(syn["cases"]) >= 5
    hold = fire.read_json("eval/ignition_holdout.json")
    assert len(hold["held_out"]) == s11.HOLDOUT_N


def test_backtrace_recovers_a_known_ignition_on_real_terrain(fire):
    model = s11.build_model(fire)  # falls back to the committed fixture without work/ arrays
    terr = model.terrain
    rows, cols = np.nonzero(np.isclose(terr.r0, 60.0))  # chaparral
    i = len(rows) // 2
    truth = (int(rows[i]), int(cols[i]))
    t0 = 3.0
    arr = sp.arrival(terr, model.wind, truth, t0, k=1.4, t_stop_h=t0 + 30)
    times = np.array([t0 + 4, t0 + 9, t0 + 20])
    masks = [arr <= t for t in times]
    est = s11.invert(model, s11.weighted(masks, times), masks[0])
    assert s11.dist_m(model.grid, (est["row"], est["col"]), truth) <= 200
    assert abs(est["t0_h"] - t0) <= 1.5


def test_uncertainty_is_calibrated_and_gates_the_timeline(fire):
    ign = fire.read_json("ignition.json")
    assert ign["r90_m"] >= 0 and ign["t90"][0] <= ign["t90"][1]
    syn = fire.read_json("eval/ignition_synthetic.json")
    for key in ("calibration", "calibration_all_observations"):
        cal = syn[key]
        assert cal["tau_h"] in s11.TAUS_H and cal["calibration_cases"] + cal["test_cases"] >= 5
    # The product fit uses all observations, so it uses the temperature calibrated on that scenario.
    assert ign["calibration"]["tau_h"] == syn["calibration_all_observations"]["tau_h"]
    assert all("all_observations" in c for c in syn["cases"])
    # The timeline shows an estimated start only when the back-trace pins it down.
    shown = any(e["kind"] == "ignition_estimate" for e in fire.read_json("events.json"))
    assert shown == ign["timing"]["identifiable"]


def test_calibrate_picks_the_smallest_covering_temperature():
    cases = [{"coverage_by_tau": {str(t): {"r90_m": 100 * t, "t90_width_h": t, "distance": t >= 0.6, "time": t >= 1.2}
                                  for t in s11.TAUS_H}} for _ in range(10)]
    cal = s11.calibrate(cases)
    assert cal["tau_h"] == 1.2 and cal["reached_on_calibration_half"]
    assert cal["test_coverage"] == {"distance": 1.0, "time": 1.0}


def test_weighted_quantile():
    v, w = np.array([3.0, 1.0, 2.0]), np.array([0.2, 0.5, 0.3])
    assert s11.weighted_quantile(v, w, 0.5) == 1.0
    assert s11.weighted_quantile(v, w, 0.6) == 2.0
    assert s11.weighted_quantile(v, w, 0.95) == 3.0
