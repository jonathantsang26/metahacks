"""Per-fire debris-flow files: M1 reproduces USGS from the file's own T/F/S, every contract column for every
design storm, likelihoods in [0, 1], the debris_flow_stats.json contract, and counts in it repeat from the file."""

import json
import re

import numpy as np
import pytest

from ember import debris as db
from steps.s15_debris_fire import CLASS_LABELS, DESIGN_I15

PREFIXES = ("usgs", "m1", "rf", "mlp")
STATS_KEYS = {"source", "design_i15_mm_h", "scenario", "segments", "m1_check", "agreement", "likelihood_class_counts_24",
              "usgs_median_thresholds_mm_h", "notes"}


def _load(fire, name):
    path = fire.out_dir / name
    if not path.exists():
        pytest.skip(f"{fire.id}: no {name}")
    return json.loads(path.read_text())


def _props(fire):
    fc = _load(fire, "debris_flow.geojson")
    assert fc["type"] == "FeatureCollection" and fc["features"]
    return fc, [f["properties"] for f in fc["features"]]


def test_m1_from_the_files_inputs_matches_usgs(fire):
    _, props = _props(fire)
    T, F, S = (np.array([p[k] for p in props], float) for k in ("T", "F", "S"))
    for i in DESIGN_I15:
        usgs = np.array([p[f"usgs_p_{i}"] for p in props], float)
        assert np.max(np.abs(db.m1_likelihood(T, F, S, i) - usgs)) < 1e-6
        assert np.max(np.abs(np.array([p[f"m1_p_{i}"] for p in props], float) - usgs)) < 1e-6


def test_every_contract_field_for_every_design_storm(fire):
    fc, props = _props(fire)
    need = {"id", "area_km2", "T", "F", "S", "usgs_hazard_24"} | {f"{m}_p_{i}" for m in PREFIXES for i in DESIGN_I15}
    for p in props:
        assert need <= set(p), sorted(need - set(p))
        assert all(isinstance(p[k], (int, float)) and np.isfinite(p[k]) for k in need)
        assert p["usgs_hazard_24"] in (1, 2, 3) and p["area_km2"] > 0
        assert 0 <= p["T"] <= 1 and p["F"] >= 0 and p["S"] >= 0
    assert len({p["id"] for p in props}) == len(props)
    aoi = json.loads((fire.out_dir / "aoi.json").read_text())
    lon0, lat0 = aoi["center"]
    for f in fc["features"]:
        c = f["geometry"]["coordinates"]
        assert f["geometry"]["type"] == "LineString" and len(c) >= 2 and len({tuple(x) for x in c}) >= 2
        assert all(abs(x - lon0) < 1 and abs(y - lat0) < 1 for x, y in c)  # lon/lat near the fire, not projected metres


def test_likelihoods_are_probabilities(fire):
    _, props = _props(fire)
    for m in PREFIXES:
        for i in DESIGN_I15:
            v = np.array([p[f"{m}_p_{i}"] for p in props], float)
            assert ((v >= 0) & (v <= 1)).all(), f"{m}_p_{i}"


def test_stats_follow_the_contract(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    assert STATS_KEYS <= set(s)
    assert set(s["source"]) >= {"title", "doi", "url", "license"} and s["source"]["doi"].startswith("10.5066/")
    assert s["design_i15_mm_h"] == list(DESIGN_I15)
    sc = s["scenario"]
    assert set(sc) >= {"date", "days_since_fire", "soil_moisture_0_7cm", "soil_moisture_source"}
    assert isinstance(sc["days_since_fire"], int) and sc["days_since_fire"] > 0
    assert sc["soil_moisture_0_7cm"] is None or 0 < sc["soil_moisture_0_7cm"] < 1
    assert s["segments"] == len(props)
    assert 0 <= s["m1_check"]["max_abs_diff_vs_usgs"] < 1e-9
    assert set(s["agreement"]) == {"m1", "rf", "mlp"}
    for a in s["agreement"].values():
        assert -1 <= a["spearman_vs_usgs_24"] <= 1 and 0 <= a["class_agreement_24"] <= 1
    assert set(s["likelihood_class_counts_24"]) == set(PREFIXES)
    for counts in s["likelihood_class_counts_24"].values():
        assert list(counts) == list(CLASS_LABELS) and sum(counts.values()) == len(props)
    th = s["usgs_median_thresholds_mm_h"]
    assert 0 < th["I15_50"] < th["I15_75"]
    assert s["notes"] and all(isinstance(n, str) and n for n in s["notes"])
    text = " ".join(s["notes"]).lower()
    assert "not validated" in text and "scenario is a choice" in text


def test_class_counts_match_the_file(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    for m, counts in s["likelihood_class_counts_24"].items():
        p = np.array([q[f"{m}_p_24"] for q in props], float)
        got = np.bincount(np.clip(np.floor(p * 5), 0, 4).astype(int), minlength=5)
        assert list(counts.values()) == got.tolist()


def test_falling_likelihood_counts_match_the_file(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    note = next(n for n in s["notes"] if "falls somewhere between consecutive design storms" in n)
    stated = {m: (int(a.replace(",", "")), int(b.replace(",", ""))) for m, a, b in re.findall(r"\b(rf|mlp) ([\d,]+) of ([\d,]+)", note)}
    assert set(stated) == {"rf", "mlp"}
    for m, (falls, n) in stated.items():
        p = np.array([[q[f"{m}_p_{i}"] for q in props] for i in DESIGN_I15], float)
        assert n == len(props) and falls == int((np.diff(p, axis=0) < 0).any(axis=0).sum()), m
