"""Debris-flow models: M1 and its units, spatial context without responses, soil-moisture parsing,
random forests that never fall as rain rises, the model_eval.json contract and the saved models."""

import json
from datetime import date

import numpy as np
import pytest

from ember import debris as db
from ember.config import REPO_DIR
from steps import s14_debris_models as s14

MODEL_EVAL = REPO_DIR / "web" / "public" / "data" / "debris_flow" / "model_eval.json"
MODEL_IDS = {"m1_published", "m1_refit", "rf_m1vars", "mlp_m1vars", "rf_extended", "mlp_extended", "mlp_context"}
ON_MAP = {"m1_refit", "rf_extended"}
SAVED = {"m1_refit", "rf_extended", "mlp_extended"}


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
    assert set(db.FEATURES_CONTEXT) <= set(db.FEATURE_DESCRIPTIONS)
    assert db.MODELS_PATH.parent.name == "debris_flow"


def test_spatial_context_is_only_in_the_context_variant():
    assert not any(f.startswith("ctx_") for f in db.FEATURES_EXTENDED)
    assert db.FEATURES_CONTEXT == db.FEATURES_EXTENDED + [f"ctx_{c}" for c in db.CONTEXT_OF]
    models = s14.make_models()
    assert models["rf_extended"][0] == models["mlp_extended"][0] == db.FEATURES_EXTENDED
    assert models["mlp_context"][0] == db.FEATURES_CONTEXT
    assert not any(f.startswith("ctx_") for mid, (features, _) in models.items() if mid != "mlp_context" for f in features)


def _rain_grid(features, rows, i15=np.arange(0.0, 60.5, 0.5)):
    """Each row's features repeated over a grid of I15 (R15 replaced): (len(i15), rows, features)."""
    j = features.index("R15")
    X = np.repeat(rows[None], len(i15), axis=0)
    X[:, :, j] = db.r15_mm(i15)[:, None]
    return X


def test_random_forests_never_fall_as_rain_rises():
    assert db.monotonic_cst(db.FEATURES_EXTENDED) == [0, 0, 0, 1, 0, 0, 0]
    # Training data in which debris flows FALL with rainfall over part of its range, so an
    # unconstrained forest would follow them down; soil moisture has gaps (the imputer must keep
    # the constraint aligned with its columns).
    rng = np.random.default_rng(1)
    n = 600
    cols = {f: rng.uniform(0, 1, n) for f in db.FEATURES_EXTENDED}
    cols["R15"] = rng.uniform(0, 15, n)
    cols["soil_moisture_0_7cm"][rng.uniform(size=n) < 0.2] = np.nan
    y = ((cols["T"] + np.where(cols["R15"] < 7, cols["R15"] / 7, 2 - cols["R15"] / 7) + rng.normal(0, 0.3, n)) > 1.2).astype(int)
    models = s14.make_models()
    probe = db.feature_matrix(cols, db.FEATURES_EXTENDED)[:50]
    for mid in ("rf_m1vars", "rf_extended"):
        features, est = models[mid]
        assert est[-1].monotonic_cst == db.monotonic_cst(features)
        e = est.fit(db.feature_matrix(cols, features), y)
        X = _rain_grid(features, probe[:, [db.FEATURES_EXTENDED.index(f) for f in features]])
        p = e.predict_proba(X.reshape(-1, len(features)))[:, 1].reshape(X.shape[:2])
        assert np.all(np.diff(p, axis=0) >= -1e-12), mid
    # the same forest without the constraint does fall somewhere: the data really are adversarial
    features, est = models["rf_extended"]
    free = est.set_params(randomforestclassifier__monotonic_cst=None).fit(db.feature_matrix(cols, features), y)
    X = _rain_grid(features, probe)
    p = free.predict_proba(X.reshape(-1, len(features)))[:, 1].reshape(X.shape[:2])
    assert np.any(np.diff(p, axis=0) < -1e-3)


def test_within_storm_ranks_within_each_fire_and_storm():
    # Fire A and fire B share a storm date; A's second storm has only debris flows, so it is skipped.
    #   (A, s1): flows at 0.9, 0.4; non-flows at 0.1, 0.5           → 3 of 4 pairs ranked right, 0.75
    #   (B, s1): a flow at 0.2; non-flows at 0.3, 0.1, 0.05, 0.4, 0 → 3 of 5, 0.6
    # Grouped by fire alone, A would score 0.5625; grouped by storm alone, there would be one group.
    cols = {
        "fire": np.array(["A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "B", "A"]),
        "storm": np.array(["s1", "s1", "s1", "s1", "s1", "s1", "s1", "s1", "s2", "s1", "s1", "s2"]),
    }
    y = np.array([1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])
    p = np.array([0.9, 0.2, 0.1, 0.3, 0.5, 0.1, 0.4, 0.05, 0.1, 0.4, 0.0, 0.2])
    keys = s14.storm_keys(cols)
    assert [int(m.sum()) for m in s14.storm_groups(y, keys)] == [4, 6]
    ws = s14.within_storm(y, p, keys)
    assert ws == {"groups": 2, "records": 10, "median_roc_auc": 0.675, "weighted_roc_auc": 0.66}  # (0.75·4 + 0.6·6) / 10


def _fold_toy(n=180, seed=4):
    """Three fires of two storms each, every FEATURES_CONTEXT column, a few missing soil moistures."""
    rng = np.random.default_rng(seed)
    fire = np.repeat(np.array(["A", "B", "C"]), n // 3)
    cols = {f: rng.uniform(0, 1, n) for f in db.FEATURES_CONTEXT}
    cols.update({"R15": rng.uniform(1, 10, n), "log_area_km2": rng.uniform(-2, 1, n), "days_since_fire": rng.uniform(1, 1000, n)})
    cols["soil_moisture_0_7cm"][rng.uniform(size=n) < 0.1] = np.nan
    y = ((cols["T"] + cols["R15"] / 10 + rng.normal(0, 0.3, n)) > 1.0).astype(int)
    return fire, cols, y


def test_a_fold_never_sees_the_held_out_fire():
    models = s14.make_models()
    fire, cols, y = _fold_toy()
    test = fire == "B"
    assert 0 < y[~test].sum() < (~test).sum() and 0 < y[test].sum() < test.sum()
    X = {mid: db.feature_matrix(cols, features) for mid, (features, _) in models.items()}
    perms = np.stack([np.random.default_rng(5 + r).permutation(len(y)) for r in range(s14.PERM_REPEATS)])
    base = s14.run_fold(models, X, y, test, perms)
    # The held-out fire's responses flipped: every prediction, permuted ones included, is unchanged.
    flipped = s14.run_fold(models, X, np.where(test, 1 - y, y), test, perms)
    for mid, (p, pp) in base.items():
        assert p.shape == (test.sum(),) and np.array_equal(p, flipped[mid][0]), mid
        assert (pp is None) is (mid not in s14.IMPORTANCE_OF) and (pp is None or np.array_equal(pp, flipped[mid][1])), mid
    # More held-out records with extreme inputs, a missing soil moisture and their own responses: the
    # original held-out records' predictions are unchanged, so no imputer or scaler sees them either.
    k = 30
    extra = {f: np.full(k, 50.0) for f in db.FEATURES_CONTEXT}
    extra["soil_moisture_0_7cm"][::2] = np.nan
    cols2 = {f: np.concatenate([cols[f], extra[f]]) for f in db.FEATURES_CONTEXT}
    test2 = np.concatenate([test, np.ones(k, bool)])
    y2 = np.concatenate([y, np.arange(k) % 2])
    X2 = {mid: db.feature_matrix(cols2, features) for mid, (features, _) in models.items()}
    perms2 = np.stack([np.random.default_rng(5 + r).permutation(len(y2)) for r in range(s14.PERM_REPEATS)])
    more = s14.run_fold(models, X2, y2, test2, perms2)
    for mid, (p, _) in base.items():
        np.testing.assert_allclose(more[mid][0][: len(p)], p, rtol=0, atol=1e-12, err_msg=mid)


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
        assert set(m) == {"id", "label", "features", "cv", "n", "flows", "pooled", "per_fire", "within_storm", "analogue", "on_map"}
        ws = m["within_storm"]
        assert set(ws) == {"groups", "records", "median_roc_auc", "weighted_roc_auc"}
        assert 0 < ws["groups"] and 2 * ws["groups"] <= ws["records"] <= m["n"]
        assert _in01(ws["median_roc_auc"]) and _in01(ws["weighted_roc_auc"])
        assert m["on_map"] is (m["id"] in ON_MAP)
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
    assert models["mlp_context"]["features"] == db.FEATURES_CONTEXT
    # m1_published is scored on its own (fewer) records, the trained models on every usable one
    assert models["m1_published"]["within_storm"]["records"] < models["m1_refit"]["within_storm"]["records"]
    assert len({(models[i]["within_storm"]["groups"], models[i]["within_storm"]["records"]) for i in MODEL_IDS - {"m1_published"}}) == 1

    assert set(ev["importance"]) == {"rf_extended", "mlp_extended", "mlp_context"}
    for mid, rows in ev["importance"].items():
        assert {r["feature"] for r in rows} == set(models[mid]["features"])
        assert all(np.isfinite(r["drop_in_auc"]) for r in rows)
    assert ev["notes"] and all(isinstance(n, str) and n for n in ev["notes"])
    # compared with USGS, never "validated" (cross-validation is the scheme's name)
    assert not any("validat" in n.lower().replace("cross-validation", "") for n in ev["notes"])


needs_models = pytest.mark.skipif(not db.MODELS_PATH.exists(), reason="work/debris_flow/models.joblib is built by step 14 (gitignored)")


@needs_models
def test_saved_models_predict_likelihoods():
    models = db.load_models()
    assert set(models) == SAVED
    df = {f: np.array([0.4, 0.1]) for f in db.FEATURES_EXTENDED}
    df["R15"] = np.array([6.0, 6.0])
    df["soil_moisture_0_7cm"] = np.array([np.nan, 0.2])  # the estimators impute a missing value,
    df["T"] = np.array([0.4, np.nan])                     # m1_refit included
    for mid, entry in models.items():
        assert entry["features"] in (db.FEATURES_M1, db.FEATURES_EXTENDED)
        p = db.predict(entry, df)
        assert p.shape == (2,) and np.all((p >= 0) & (p <= 1))
        assert set(entry["context_distance_m"]) == {"q25", "median", "q75"} and entry["spatial_k"] == db.SPATIAL_K
        assert 0 < entry["flows_train"] < entry["n_train"]


@needs_models
def test_saved_m1_refit_coefficients_give_its_likelihoods():
    entry = db.load_models()["m1_refit"]
    c = entry["coefficients"]
    assert set(c) == set(db.M1_15) and all(isinstance(v, float) for v in c.values())
    rng = np.random.default_rng(2)
    df = {"T": rng.uniform(0, 1, 200), "F": rng.uniform(0, 1, 200), "S": rng.uniform(0, 0.5, 200), "I15": rng.uniform(0, 60, 200)}
    df["R15"] = db.r15_mm(df["I15"])
    assert db.predict(entry, df) == pytest.approx(db.m1_likelihood(df["T"], df["F"], df["S"], df["I15"], c), abs=1e-12)
    assert c != db.M1_15


@needs_models
def test_saved_random_forest_never_falls_as_rain_rises():
    entry = db.load_models()["rf_extended"]
    assert entry["monotonic_cst"] == db.monotonic_cst(entry["features"]) == list(entry["estimator"][-1].monotonic_cst)
    rng = np.random.default_rng(3)
    n = 300
    rows = np.column_stack([rng.uniform(0, 1, n), rng.uniform(0, 1, n), rng.uniform(0, 0.6, n), np.zeros(n),
                            rng.uniform(-2, 2, n), rng.uniform(1, 1500, n), rng.uniform(0.05, 0.45, n)])
    rows[::7, 6] = np.nan  # an imputed soil moisture keeps the constraint
    X = _rain_grid(entry["features"], rows)
    p = entry["estimator"].predict_proba(X.reshape(-1, X.shape[2]))[:, 1].reshape(X.shape[:2])
    assert np.all(np.diff(p, axis=0) >= -1e-12)
    assert np.any(np.diff(p, axis=0) > 0)
