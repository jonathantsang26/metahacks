"""Debris-flow models: M1 and its units, spatial context without responses, soil-moisture parsing, the
model_eval.json contract."""

import json
from datetime import date

import numpy as np
import pytest

from ember import debris as db
from ember.config import REPO_DIR

MODEL_EVAL = REPO_DIR / "web" / "public" / "data" / "debris_flow" / "model_eval.json"
MODEL_IDS = {"m1_published", "m1_refit", "rf_m1vars", "mlp_m1vars", "rf_extended", "mlp_extended"}


def test_m1_matches_a_hand_computed_value():
    # T = 0.3, F = 0.4, S = 0.25, I15 = 24 mm/h → R = 6 mm,
    # X = -3.63 + 0.41·0.3·6 + 0.67·0.4·6 + 0.70·0.25·6 = -0.234, p = 1 / (1 + e^0.234)
    assert db.m1_likelihood(0.3, 0.4, 0.25, 24.0) == pytest.approx(0.441765, abs=1e-6)
    p = db.m1_likelihood(np.array([0.0, 0.3]), np.array([0.0, 0.4]), np.array([0.0, 0.25]), np.array([0.0, 24.0]))
    assert p[0] == pytest.approx(1 / (1 + np.exp(3.63))) and p[1] == pytest.approx(0.441765, abs=1e-6)


def test_r_is_the_15_minute_accumulation():
    # USGS median-thresholds.csv (Eaton): I15_50 17.53 mm/h ↔ R15_50 4.38 mm
    assert db.r15_mm(17.53) == pytest.approx(4.38, abs=0.005)
    assert db.r15_mm(17.532391526031127) == pytest.approx(4.383097881507782, abs=1e-12)
    X = np.array([[0.3, 0.4, 0.25, 6.0]])
    assert db.m1_interactions(X) == pytest.approx(np.array([[1.8, 2.4, 1.5]]))


def _toy(n=40, seed=0):
    rng = np.random.default_rng(seed)
    return {
        "fire": np.where(np.arange(n) < n // 2, "A", "B"),
        "storm": np.where(np.arange(n) % 2 == 0, "20200101", "20200201"),
        "lat": 34 + rng.uniform(0, 0.1, n), "lon": -118 + rng.uniform(0, 0.1, n),
        "T": rng.uniform(0, 1, n), "F": rng.uniform(0, 1, n), "S": rng.uniform(0, 0.5, n), "R15": rng.uniform(1, 10, n),
        "Response": rng.integers(0, 2, n), "y": rng.integers(0, 2, n),
    }


def test_spatial_context_never_reads_the_response():
    df = _toy()
    a = db.spatial_context(df, k=3)
    flipped = {**df, "Response": 1 - df["Response"], "y": 1 - df["y"]}
    b = db.spatial_context(flipped, k=3)
    stripped = db.spatial_context({k: v for k, v in df.items() if k not in ("Response", "y")}, k=3)
    for key in a:
        assert np.array_equal(a[key], b[key]) and np.array_equal(a[key], stripped[key])


def test_spatial_context_stays_within_fire_and_storm_and_excludes_self():
    df = _toy()
    ctx = db.spatial_context(df, k=3)
    assert set(ctx) == {f"ctx_{c}" for c in db.CONTEXT_OF} | {"ctx_n", "ctx_dist_m"}
    keys = np.char.add(df["fire"].astype(str), df["storm"].astype(str))
    m_lat = db.meters_per_degree(34.0)[1]
    for i in range(len(df["T"])):
        same = np.flatnonzero((keys == keys[i]) & (np.arange(len(keys)) != i))
        coslat = np.cos(np.radians(df["lat"][keys == keys[i]].mean()))
        d = np.hypot(df["lat"][same] - df["lat"][i], (df["lon"][same] - df["lon"][i]) * coslat)
        nearest = same[np.argsort(d)[:3]]
        assert ctx["ctx_n"][i] == 3
        assert ctx["ctx_T"][i] == pytest.approx(df["T"][nearest].mean())
        assert ctx["ctx_dist_m"][i] == pytest.approx(np.sort(d)[:3].mean() * m_lat, rel=1e-9)
    # a watershed alone in its storm keeps its own values
    lone = {k: v[:1] for k, v in df.items()}
    c = db.spatial_context(lone, k=3)
    assert c["ctx_n"][0] == 0 and c["ctx_T"][0] == df["T"][0] and np.isnan(c["ctx_dist_m"][0])


class _Response:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.content = json.dumps(payload).encode()
        self.text = self.content.decode()


def _fake_archive(calls: list):
    """Stands in for requests.get: one location per requested cell, hourly values that encode the
    cell and the day (day d at cell latitude a: 0.1 + (a − 34) + 0.01·d, +0.02 in the second half
    of the day, so the daily mean is that + 0.01), with two missing hours at cell 34.3 on day 0."""
    def get(url, params, headers, timeout):
        calls.append(params)
        start, end = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        days = (end - start).days + 1
        locs = []
        for a, b in zip(params["latitude"].split(","), params["longitude"].split(",")):
            a = float(a)
            v = [0.1 + (a - 34) + 0.01 * d + (0.02 if h >= 12 else 0.0) for d in range(days) for h in range(24)]
            if a == 34.3:
                v[0] = v[12] = None
            locs.append({"latitude": a, "longitude": float(b), "hourly": {"time": list(range(24 * days)), db.SOIL_VAR: v}})
        return _Response(200, locs)
    return get


def test_soil_moisture_parses_daily_means_per_point(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(db.requests, "get", _fake_archive(calls))
    # two points in cell (34.0, -118.0), one in (34.3, -118.3); dates two days apart (day 1 unused)
    lat, lon = [34.01, 34.26, 34.04], [-118.04, -118.31, -118.01]
    dates = [date(2020, 1, 3), date(2020, 1, 1)]
    sm = db.fetch_soil_moisture(lat, lon, dates, cache_dir=tmp_path)
    assert len(calls) == 1 and calls[0]["latitude"] == "34.0,34.3" and calls[0]["longitude"] == "-118.0,-118.3"
    assert calls[0]["start_date"] == "2020-01-01" and calls[0]["end_date"] == "2020-01-03"
    assert calls[0]["hourly"] == db.SOIL_VAR and calls[0]["models"] == db.SOIL_MODEL
    expect = np.array([[0.13, 0.11], [0.43, 0.41], [0.13, 0.11]])  # rows: points, columns: dates as given
    assert sm.shape == (3, 2) and sm == pytest.approx(expect, abs=1e-12)
    # the response is cached: a second call makes no request
    assert db.fetch_soil_moisture(lat, lon, dates, cache_dir=tmp_path) == pytest.approx(expect, abs=1e-12)
    assert len(calls) == 1


def test_soil_moisture_failures_are_nan_and_a_bad_request_is_not_retried(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(db.time, "sleep", lambda s: pytest.fail("a 400 must not be retried"))
    monkeypatch.setattr(db.requests, "get", lambda *a, **k: calls.append(1) or _Response(400, {"error": True, "reason": "bad"}))
    sm = db.fetch_soil_moisture([34.0], [-118.0], [date(2020, 1, 1)], cache_dir=tmp_path)
    assert len(calls) == 1 and np.isnan(sm).all() and "request failed" in capsys.readouterr().out
    assert not list(tmp_path.iterdir())  # nothing cached
    # a response with the wrong number of locations: NaN, and says so
    monkeypatch.setattr(db.requests, "get", lambda *a, **k: _Response(200, []))
    sm = db.fetch_soil_moisture([34.0, 34.5], [-118.0, -118.0], [date(2020, 1, 2)], cache_dir=tmp_path)
    assert np.isnan(sm).all() and "0 locations returned for 2 requested" in capsys.readouterr().out


def test_extended_features_extend_m1_and_are_described():
    assert db.FEATURES_EXTENDED[:4] == db.FEATURES_M1 == ["T", "F", "S", "R15"]
    assert set(db.FEATURES_EXTENDED) <= set(db.FEATURE_DESCRIPTIONS)
    assert db.MODELS_PATH.parent.name == "debris_flow"


def _in01(x):
    return isinstance(x, (int, float)) and 0 <= x <= 1


def test_model_eval_follows_the_contract():
    ev = json.loads(MODEL_EVAL.read_text())
    assert set(ev) == {"inventory", "cv", "features", "models", "importance", "notes"}
    inv = ev["inventory"]
    for k in ("title", "doi", "url", "records", "fires", "debris_flows", "used_records", "used_fires", "used_flows", "filters"):
        assert k in inv
    assert 0 < inv["used_records"] <= inv["records"] and 0 < inv["used_fires"] <= inv["fires"]
    assert 0 < inv["used_flows"] <= inv["debris_flows"]
    assert inv["filters"] and all(isinstance(f, str) for f in inv["filters"])
    assert ev["cv"]["scheme"] == "leave-one-fire-out" and ev["cv"]["folds"] == inv["used_fires"]
    assert ev["features"] and all(isinstance(v, str) and v for v in ev["features"].values())

    models = {m["id"]: m for m in ev["models"]}
    assert set(models) == MODEL_IDS and len(ev["models"]) == len(MODEL_IDS)
    for m in ev["models"]:
        for k in ("id", "label", "features", "cv", "n", "flows", "pooled", "per_fire", "analogue"):
            assert k in m
        assert set(m["features"]) <= set(ev["features"])
        assert 0 < m["flows"] < m["n"] <= inv["used_records"]
        assert set(m["pooled"]) == {"roc_auc", "pr_auc", "brier", "base_rate"}
        assert all(_in01(v) for v in m["pooled"].values())
        assert m["pooled"]["base_rate"] == pytest.approx(m["flows"] / m["n"], abs=1e-4)
        pf = m["per_fire"]
        assert 0 < pf["fires"] <= inv["used_fires"] and _in01(pf["median_roc_auc"])
        assert len(pf["iqr"]) == 2 and all(_in01(v) for v in pf["iqr"]) and pf["iqr"][0] <= pf["median_roc_auc"] <= pf["iqr"][1]
        a = m["analogue"]
        if a is not None:
            assert set(a) == {"fire", "year", "n", "flows", "roc_auc", "brier"}
            assert a["fire"] == "Station" and a["year"] == 2009 and 0 < a["flows"] < a["n"]
            assert _in01(a["roc_auc"]) and _in01(a["brier"])
    # M1's published coefficients were fitted on the 2016 inventory, which holds every Station Fire record.
    assert models["m1_published"]["analogue"] is None and models["m1_published"]["n"] < models["m1_refit"]["n"]
    assert all(models[i]["analogue"] is not None for i in MODEL_IDS - {"m1_published"})
    assert models["rf_extended"]["features"] == db.FEATURES_EXTENDED and models["rf_m1vars"]["features"] == db.FEATURES_M1

    assert set(ev["importance"]) == {"rf_extended", "mlp_extended"}
    for mid, rows in ev["importance"].items():
        assert {r["feature"] for r in rows} == set(models[mid]["features"])
        assert all(np.isfinite(r["drop_in_auc"]) for r in rows)
    assert ev["notes"] and all(isinstance(n, str) and n for n in ev["notes"])
    # compared with USGS, never "validated" (cross-validation is the scheme's name)
    assert not any("validat" in n.lower().replace("cross-validation", "") for n in ev["notes"])


@pytest.mark.skipif(not db.MODELS_PATH.exists(), reason="work/debris_flow/models.joblib is built by step 14 (gitignored)")
def test_saved_models_predict_likelihoods():
    models = db.load_models()
    assert {"m1_refit", "rf_extended", "mlp_extended"} <= set(models)
    df = {f: np.array([0.4, 0.1]) for f in db.FEATURES_EXTENDED}
    df["R15"] = np.array([6.0, 6.0])
    df["soil_moisture_0_7cm"] = np.array([np.nan, 0.2])  # the estimators impute a missing value,
    df["T"] = np.array([0.4, np.nan])                     # m1_refit included
    for mid, entry in models.items():
        assert entry["features"] in (db.FEATURES_M1, db.FEATURES_EXTENDED)
        p = db.predict(entry, df)
        assert p.shape == (2,) and np.all((p >= 0) & (p <= 1))
        assert set(entry["context_distance_m"]) == {"q25", "median", "q75"} and entry["spatial_k"] == db.SPATIAL_K
