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
    cases = [{"coverage_by_tau": {str(t): {"r90_m": 100 * t, "t90_width_h": t * (1 + i), "distance": t >= 0.6, "time": t >= 1.2}
                                  for t in s11.TAUS_H},
              "estimate": {"k": 2.0}, "backtrace_time_err_min": 10.0 * i} for i in range(10)]
    cal = s11.calibrate(cases)
    assert cal["tau_h"] == 1.2 and cal["reached_on_calibration_half"]
    assert cal["test_coverage"] == {"distance": 1.0, "time": 1.0}
    # Selective metrics on the odd (unseen) cases: widths 1.2 × (2, 4, 6, 8, 10) h → cases 1 and 3 are within 6 h.
    shown = cal["test_start_time_shown"]
    assert shown["cases"] == 2 and shown["of"] == 5 and shown["median_time_err_min"] == 20.0


def test_weighted_quantile():
    v, w = np.array([3.0, 1.0, 2.0]), np.array([0.2, 0.5, 0.3])
    assert s11.weighted_quantile(v, w, 0.5) == 1.0
    assert s11.weighted_quantile(v, w, 0.6) == 2.0
    assert s11.weighted_quantile(v, w, 0.95) == 3.0


def test_length_to_breadth_cap_is_the_lowest_loss(fire):
    ign = fire.read_json("ignition.json")
    table = ign["lb_selection"]
    assert sorted(r["lb_max"] for r in table) == sorted(s11.LB_CHOICES)
    assert ign["map"]["lb_max"] == min(table, key=lambda r: r["loss_h"])["lb_max"]
    # The hold-out chooses its own cap, without the held-out footprints.
    hold = fire.read_json("eval/ignition_holdout.json")
    assert hold["estimate"]["lb_max"] == min(hold["lb_selection"], key=lambda r: r["loss_h"])["lb_max"]
    syn = fire.read_json("eval/ignition_synthetic.json")
    assert syn["config"]["lb_max"] == ign["map"]["lb_max"]


def test_wind_ablation_is_recorded(fire):
    ab = fire.read_json("eval/wind_ablation.json")["variants"]
    assert {"field", "uniform", "era5"} <= ab.keys()
    n_obs = fire.read_json("ignition.json")["observations_used"]
    for v in ab.values():
        assert 0 <= v["mean_iou"] <= 1 and len(v["iou_by_observation"]) == n_obs


def test_check_reports_identical_and_different_cases():
    def case(i, d):
        scores = {"backtrace_dist_m": d, "backtrace_time_err_min": 10.0, "baseline_dist_m": 500.0, "baseline_time_err_min": 60.0}
        return {"case": i, "estimate": {"row": 1}, **scores, "all_observations": dict(scores)}
    committed = {"cases": [case(0, 100.0), case(1, 200.0)]}
    assert s11.check_against([case(0, 100.0), case(1, 200.0)], committed)["identical"]
    diff = s11.check_against([case(0, 100.0), case(1, 250.0)], committed)
    assert not diff["identical"] and diff["cases"][1]["max_abs_diff"] == 50.0
