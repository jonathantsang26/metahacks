"""Per-fire debris-flow files: USGS's column repeats from the file's own T/F/S with the published M1 and the
m1 column with the recalibrated coefficients in the stats, every contract column for every design storm and no
MLP column, likelihoods in [0, 1] that never fall as I15 rises, the debris_flow_stats.json contract, and the
per-storm agreement, class counts and means in it repeat from the file; and the files agree with step 14's outputs
(the recalibrated coefficients saved with m1_refit, the scenario's days since fire, the models marked on_map)."""

import json
import os

import numpy as np
import pytest
from scipy.stats import spearmanr

from ember import debris as db
from steps.s14_debris_models import OUT_PATH as MODEL_EVAL, SCENARIO_DAYS
from steps.s15_debris_fire import CLASS_LABELS, DESIGN_I15, M1_MODEL, MAP_MODELS, ML_MODELS

STATS_KEYS = {"source", "design_i15_mm_h", "scenario", "segments", "m1_check", "m1_recalibrated", "agreement_by_i15",
              "likelihood_class_counts", "mean_likelihood", "analogue", "usgs_median_thresholds_mm_h", "notes"}


def _load(fire, name):
    path = fire.out_dir / name
    if not path.exists():
        pytest.skip(f"{fire.id}: no {name}")
    return json.loads(path.read_text())


def _props(fire):
    fc = _load(fire, "debris_flow.geojson")
    assert fc["type"] == "FeatureCollection" and fc["features"]
    return fc, [f["properties"] for f in fc["features"]]


def _column(props, model, i):
    return np.array([p[f"{model}_p_{i}"] for p in props], float)


def test_both_m1_columns_repeat_from_the_files_inputs(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    T, F, S = (np.array([p[k] for p in props], float) for k in ("T", "F", "S"))
    coef = {k: s["m1_recalibrated"][k] for k in ("B", "Ct", "Cf", "Cs")}
    for i in DESIGN_I15:
        usgs = _column(props, "usgs", i)
        assert np.max(np.abs(db.m1_likelihood(T, F, S, i) - usgs)) < 1e-6  # published M1 = USGS's (m1_check)
        assert np.max(np.abs(db.m1_likelihood(T, F, S, i, coef) - _column(props, "m1", i))) < 1e-6
    # m1 is the recalibration, not a copy of USGS's column.
    assert np.max(np.abs(_column(props, "m1", 24) - _column(props, "usgs", 24))) > 0.01


def test_every_contract_field_for_every_design_storm(fire):
    fc, props = _props(fire)
    need = {"id", "area_km2", "T", "F", "S", "usgs_hazard_24"} | {f"{m}_p_{i}" for m in MAP_MODELS for i in DESIGN_I15}
    for p in props:
        assert need <= set(p), sorted(need - set(p))
        assert not [k for k in p if k.startswith("mlp_")], "the MLP is evaluated, not mapped"
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
    for m in MAP_MODELS:
        for i in DESIGN_I15:
            v = _column(props, m, i)
            assert ((v >= 0) & (v <= 1)).all(), f"{m}_p_{i}"


@pytest.mark.parametrize("model", ["m1", "rf"])
def test_likelihood_never_falls_as_rain_rises(fire, model):
    _, props = _props(fire)
    p = np.array([_column(props, model, i) for i in DESIGN_I15])
    falls = (np.diff(p, axis=0) < 0).any(axis=0)
    assert not falls.any(), f"{model}: {int(falls.sum())} segments fall between consecutive design storms"


def test_stats_follow_the_contract(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    assert set(s) == STATS_KEYS
    assert set(s["source"]) >= {"title", "doi", "url", "license"} and s["source"]["doi"].startswith("10.5066/")
    assert s["design_i15_mm_h"] == list(DESIGN_I15)
    sc = s["scenario"]
    assert set(sc) >= {"date", "days_since_fire", "soil_moisture_0_7cm", "soil_moisture_source"}
    assert isinstance(sc["days_since_fire"], int) and sc["days_since_fire"] > 0
    assert sc["days_since_fire"] == SCENARIO_DAYS  # step 14's days-since-fire note describes this scenario
    assert sc["soil_moisture_0_7cm"] is None or 0 < sc["soil_moisture_0_7cm"] < 1
    assert s["segments"] == len(props)
    assert 0 <= s["m1_check"]["max_abs_diff_vs_usgs"] < 1e-9
    rc = s["m1_recalibrated"]
    assert set(rc) == {"B", "Ct", "Cf", "Cs", "records"} and isinstance(rc["records"], int) and rc["records"] > 0
    storms = {str(i) for i in DESIGN_I15}
    for key in ("agreement_by_i15", "likelihood_class_counts", "mean_likelihood"):
        assert set(s[key]) == storms, key
        assert all(set(v) == set(MAP_MODELS) for v in s[key].values()), key
    for by_model in s["agreement_by_i15"].values():
        for a in by_model.values():
            assert set(a) == {"spearman_vs_usgs", "class_agreement"}
            assert -1 <= a["spearman_vs_usgs"] <= 1 and 0 <= a["class_agreement"] <= 1
        assert by_model["usgs"] == {"spearman_vs_usgs": 1.0, "class_agreement": 1.0}
    for by_model in s["likelihood_class_counts"].values():
        for counts in by_model.values():
            assert list(counts) == list(CLASS_LABELS) and sum(counts.values()) == len(props)
    assert all(0 <= p <= 1 for by_model in s["mean_likelihood"].values() for p in by_model.values())
    th = s["usgs_median_thresholds_mm_h"]
    assert 0 < th["I15_50"] < th["I15_75"]
    assert s["notes"] and all(isinstance(n, str) and n for n in s["notes"])
    text = " ".join(s["notes"]).lower()
    assert "compared with usgs's assessment" in text and "scenario is a choice" in text
    assert "not a validation" in text and "validated" not in text  # m1_check is an implementation check; no model is validated
    assert "extrapolation" in text and "sampled non-events" in text


def test_analogue(fire):
    s = _load(fire, "debris_flow_stats.json")
    a = s["analogue"]
    assert set(a) == {"fire", "note"} and isinstance(a["note"], str) and a["note"]
    if fire.id == "eaton":
        assert a["fire"] == "Station"
        if MODEL_EVAL.exists():  # the fire step 14 holds out and scores as its analogue
            held = {m["analogue"]["fire"] for m in json.loads(MODEL_EVAL.read_text())["models"] if m.get("analogue")}
            assert held == {a["fire"]}
    elif fire.id == "palisades":
        assert a["fire"] is None and "no recorded debris flow" in a["note"]
    else:
        assert a["fire"] is None or a["fire"]


# DEBRIS_TESTS_OFFLINE=1 runs as if pipeline/work/ were absent.
needs_models = pytest.mark.skipif(bool(os.environ.get("DEBRIS_TESTS_OFFLINE")) or not db.MODELS_PATH.exists(),
                                  reason="work/debris_flow/models.joblib is built by step 14 (gitignored)")


def test_recalibrated_coefficients_are_the_ones_model_eval_reports(fire):
    # Offline twin of the next test: model_eval.json carries m1_refit's final coefficients, so a step-14 rerun that
    # moves them, without a step-15 rerun, fails here too.
    s = _load(fire, "debris_flow_stats.json")
    if not MODEL_EVAL.exists():
        pytest.skip("no model_eval.json")
    ev = json.loads(MODEL_EVAL.read_text())
    m = next(m for m in ev["models"] if m["id"] == M1_MODEL)
    rc = s["m1_recalibrated"]
    for k in ("B", "Ct", "Cf", "Cs"):
        assert rc[k] == pytest.approx(m["coefficients"][k], abs=1e-12), k
    assert rc["records"] == m["n"] == ev["inventory"]["used_records"]


@needs_models
def test_recalibrated_coefficients_are_the_saved_m1_refits(fire):
    # A step-14 rerun without a step-15 rerun leaves these files stale; this catches it.
    s = _load(fire, "debris_flow_stats.json")
    entry = db.load_models()[M1_MODEL]
    rc = s["m1_recalibrated"]
    for k in ("B", "Ct", "Cf", "Cs"):
        assert rc[k] == pytest.approx(entry["coefficients"][k], abs=1e-12), k
    assert rc["records"] == entry["n_train"]


def test_the_mapped_models_are_the_ones_marked_on_map():
    if not MODEL_EVAL.exists():
        pytest.skip("no model_eval.json")
    on_map = {m["id"] for m in json.loads(MODEL_EVAL.read_text())["models"] if m["on_map"]}
    assert on_map == {M1_MODEL} | {mid for _, mid in ML_MODELS}


def test_per_storm_stats_match_the_file(fire):
    s = _load(fire, "debris_flow_stats.json")
    _, props = _props(fire)
    for i in DESIGN_I15:
        usgs = _column(props, "usgs", i)
        for m in MAP_MODELS:
            p = _column(props, m, i)
            got = np.bincount(np.clip(np.floor(p * 5), 0, 4).astype(int), minlength=5)
            assert list(s["likelihood_class_counts"][str(i)][m].values()) == got.tolist(), (m, i)
            assert s["mean_likelihood"][str(i)][m] == pytest.approx(p.mean(), abs=5e-5), (m, i)
            a = s["agreement_by_i15"][str(i)][m]
            assert a["spearman_vs_usgs"] == pytest.approx(spearmanr(p, usgs).statistic, abs=5e-5), (m, i)
            same = np.mean(np.clip(np.floor(p * 5), 0, 4) == np.clip(np.floor(usgs * 5), 0, 4))
            assert a["class_agreement"] == pytest.approx(same, abs=5e-5), (m, i)
