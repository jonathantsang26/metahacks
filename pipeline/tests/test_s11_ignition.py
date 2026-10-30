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
