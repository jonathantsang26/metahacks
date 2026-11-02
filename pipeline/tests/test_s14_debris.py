"""Debris-flow models: M1 and its units, spatial context without responses, soil-moisture parsing,
random forests that never fall as rain rises, within-storm ROC AUC and its cluster-bootstrap
intervals, the model_eval.json contract and the saved models.

The saved-model tests run twice: on step 14's models.joblib (skipped without pipeline/work/) and on
models trained here on tests/fixtures/debris_inventory_sample.csv, a sample of USGS's inventory, so
they run offline. DEBRIS_TESTS_OFFLINE=1 runs as if pipeline/work/ were absent."""

import csv
import importlib.util
import io
import json
import os
from datetime import date
from pathlib import Path

import numpy as np
import pytest
from sklearn.metrics import roc_auc_score

from ember import debris as db
from ember.config import REPO_DIR
from steps import s14_debris_models as s14

MODEL_EVAL = REPO_DIR / "web" / "public" / "data" / "debris_flow" / "model_eval.json"
MODEL_IDS = {"m1_published", "m1_refit", "rf_m1vars", "mlp_m1vars", "rf_extended", "mlp_extended", "mlp_context"}
ON_MAP = {"m1_refit", "rf_extended"}
SAVED = {"m1_refit", "rf_extended", "mlp_extended"}
WITHIN_KEYS = {"groups", "records", "median_roc_auc", "weighted_roc_auc", "ci95_median", "ci95_weighted"}
PAIRED_KEYS = {"groups", "median_diff", "ci95", "weighted_diff", "ci95_weighted", "ci95_check", "ci95_weighted_check"}

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_CSV = FIXTURES / "debris_inventory_sample.csv"
OFFLINE = bool(os.environ.get("DEBRIS_TESTS_OFFLINE"))
needs_inventory = pytest.mark.skipif(OFFLINE or not (db.DEBRIS_WORK / s14.INVENTORY_CSV).exists(),
                                     reason="work/debris_flow/USGS_RG_PFDF_Inventory_v1.csv is downloaded by step 14 (gitignored)")


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
    # (0.75·4 + 0.6·6) / 10. A resample of two groups draws (A, s1) twice, (B, s1) twice or each once, so
    # both figures lie between 0.6 and 0.75, and each end comes up in about a quarter of the 1,000 resamples.
    assert ws == {"groups": 2, "records": 10, "median_roc_auc": 0.675, "weighted_roc_auc": 0.66,
                  "ci95_median": [0.6, 0.75], "ci95_weighted": [0.6, 0.75]}
    # (B, s1) is the larger group: 6 of the 10 records, left out of a resample of two groups a quarter of the time.
    big = s14.largest_group(y, keys)
    assert {k: big[k] for k in ("index", "key", "records", "total", "next")} == {
        "index": 1, "key": "B\x1fs1", "records": 6, "total": 10, "next": 4}
    assert big["left_out"] == pytest.approx(0.25, abs=0.05)
    # Paired with itself, or with any order-preserving change of itself, the difference is exactly zero.
    zero = {"groups": 2, "median_diff": 0.0, "ci95": [0.0, 0.0], "weighted_diff": 0.0, "ci95_weighted": [0.0, 0.0],
            "ci95_check": [0.0, 0.0], "ci95_weighted_check": [0.0, 0.0]}
    assert s14.paired_within_storm(y, p, p, keys) == s14.paired_within_storm(y, p ** 3 / 2, p, keys) == zero
    # Reversed, (A, s1) scores 0.25 and (B, s1) 0.4: medians 0.325 − 0.675, weighted (0.25·4 + 0.4·6) / 10 − 0.66.
    d = s14.paired_within_storm(y, -p, p, keys)
    assert d["median_diff"] == pytest.approx(-0.35) and d["weighted_diff"] == pytest.approx(-0.32)
    assert d["ci95"] == [-0.5, -0.2] and d["ci95_weighted"] == [-0.5, -0.2]
    assert d["ci95_check"] == [-0.5, -0.2] and d["ci95_weighted_check"] == [-0.5, -0.2]  # the larger draw agrees


def test_the_cluster_bootstrap_resamples_whole_groups_and_pairs_the_models():
    idx = s14.boot_groups(5)
    assert idx.shape == (s14.N_BOOT, 5) and idx.min() == 0 and idx.max() == 4
    assert np.array_equal(idx, s14.boot_groups(5))  # fixed by the seed and the group count: every model gets the same draws
    assert s14.boot_groups(5, s14.N_BOOT_CHECK).shape == (s14.N_BOOT_CHECK, 5) and s14.N_BOOT_CHECK > s14.N_BOOT
    aucs, ns = np.array([0.5, 0.6, 0.7, 0.8, 0.9]), np.array([2, 4, 6, 8, 10])
    med, wtd = s14.boot_stats(aucs, ns, idx)
    for r in (0, 17, s14.N_BOOT - 1):  # each resample's figures are those of the groups it drew
        assert med[r] == np.median(aucs[idx[r]]) and wtd[r] == pytest.approx(np.average(aucs[idx[r]], weights=ns[idx[r]]))
    # A model better by 0.05 in every group is better by 0.05 in every resample: paired, the interval is that one value,
    # while the two models' own intervals overlap.
    med2, wtd2 = s14.boot_stats(aucs + 0.05, ns, idx)
    assert s14.ci95(med2 - med) == pytest.approx([0.05, 0.05]) and s14.ci95(wtd2 - wtd) == pytest.approx([0.05, 0.05])
    assert s14.ci95(med2)[0] < s14.ci95(med)[1] and s14.ci95(wtd2)[0] < s14.ci95(wtd)[1]
    assert s14.excludes_zero([0.01, 0.2]) and s14.excludes_zero([-0.2, -0.01]) and not s14.excludes_zero([-0.01, 0.2])


def test_the_paired_verdict_needs_both_draws_to_exclude_zero():
    def diff(ci, ci_w, chk=None, chk_w=None):
        return {"groups": 9, "median_diff": 0.0, "ci95": ci, "weighted_diff": 0.0, "ci95_weighted": ci_w,
                "ci95_check": chk or ci, "ci95_weighted_check": chk_w or ci_w}
    # a − m1_published: weighted below zero at both draws; a − m1_refit: weighted below zero at 1,000 resamples only
    # (borderline), median touching zero (includes it); b − m1_published: both include zero.
    vs = {"m1_refit": {"published": diff([-0.1, 0.05], [-0.1, 0.05]), "refit": None},
          "a": {"published": diff([-0.1, 0.05], [-0.1, -0.01], chk_w=[-0.1, -0.012]),
                "refit": diff([-0.2, 0.0], [-0.117, -0.0015], chk_w=[-0.1162, 0.0016])}}
    v = s14.paired_verdict(vs)
    assert v.startswith(f"Paired intervals that exclude zero at both {s14.N_BOOT:,} and {s14.N_BOOT_CHECK:,} resamples: "
                        "a − m1_published (record-weighted, below zero). Borderline: a − m1_refit (record-weighted): its upper "
                        f"end is -0.0015 at {s14.N_BOOT:,} resamples and +0.0016 at {s14.N_BOOT_CHECK:,}, so it includes zero "
                        "with more resamples. The other 4 of the 6 include zero. None lies above zero")
    assert v.endswith("The 6 intervals are 95% each, not adjusted for multiple comparisons.")
    # The reverse borderline (excludes zero only with more resamples), and one above zero, are named as such.
    vs["a"]["refit"] = diff([-0.2, 0.0], [-0.01, 0.2], chk=[-0.2, -0.001], chk_w=[0.004, 0.2])
    v = s14.paired_verdict(vs)
    assert "its upper end is +0.0000 at" in v and "its lower end is -0.0100 at" in v and "excludes zero with more resamples" in v
    assert "None lies above zero" not in v and "The other 3 of the 6" in v
    vs["a"] = {"published": diff([-0.1, 0.05], [-0.1, 0.05]), "refit": diff([-0.1, 0.05], [-0.1, 0.05])}
    assert s14.paired_verdict(vs).startswith("None of the 6 paired intervals excludes zero")


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


def _interval(ci, lo=0.0, hi=1.0):
    assert isinstance(ci, list) and len(ci) == 2 and all(isinstance(v, float) for v in ci) and lo <= ci[0] <= ci[1] <= hi, ci


def _check_within(by_id: dict):
    """within_storm, within_storm_on_m1_records and vs_m1 of every model ({model_id: fields}), as
    model_eval.json carries them: every model also on m1_published's groups, each trained model's
    differences from M1 on the same groups."""
    pub = by_id["m1_published"]
    assert pub["within_storm_on_m1_records"] == pub["within_storm"] and pub["vs_m1"] is None
    for mid, m in by_id.items():
        for key in ("within_storm", "within_storm_on_m1_records"):
            ws = m[key]
            assert set(ws) == WITHIN_KEYS, (mid, key)
            assert 0 < ws["groups"] and 2 * ws["groups"] <= ws["records"]
            assert _in01(ws["median_roc_auc"]) and _in01(ws["weighted_roc_auc"])
            _interval(ws["ci95_median"])
            _interval(ws["ci95_weighted"])
        on_m1 = m["within_storm_on_m1_records"]
        assert (on_m1["groups"], on_m1["records"]) == (pub["within_storm"]["groups"], pub["within_storm"]["records"]), mid
        if mid == "m1_published":
            continue
        assert set(m["vs_m1"]) == {"published", "refit"} and (m["vs_m1"]["refit"] is None) is (mid == "m1_refit")
        for ref, d in m["vs_m1"].items():
            if d is None:
                continue
            own, m1 = ((on_m1, pub["within_storm"]) if ref == "published"
                       else (m["within_storm"], by_id["m1_refit"]["within_storm"]))
            assert set(d) == PAIRED_KEYS and d["groups"] == own["groups"] == m1["groups"], (mid, ref)
            # the point estimates are the differences of the figures in the table (each rounded to 4 dp)
            assert d["median_diff"] == pytest.approx(own["median_roc_auc"] - m1["median_roc_auc"], abs=1.5e-4), (mid, ref)
            assert d["weighted_diff"] == pytest.approx(own["weighted_roc_auc"] - m1["weighted_roc_auc"], abs=1.5e-4), (mid, ref)
            for k in ("ci95", "ci95_weighted", "ci95_check", "ci95_weighted_check"):
                _interval(d[k], -1, 1)


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
        assert set(m) == {"id", "label", "features", "cv", "n", "flows", "pooled", "per_fire", "within_storm",
                          "within_storm_on_m1_records", "vs_m1", "analogue", "on_map"} | ({"coefficients"} if m["id"] == "m1_refit" else set())
        assert m["within_storm"]["records"] <= m["n"]
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
    _check_within(models)
    assert set(models["m1_refit"]["coefficients"]) == set(db.M1_15)
    assert all(isinstance(v, float) for v in models["m1_refit"]["coefficients"].values())
    # A note says what the intervals say: which paired intervals exclude zero at both draws, which only at one
    # (borderline), or that none does; and that they are not adjusted for multiple comparisons.
    paired = [d for m in models.values() if m["vs_m1"] for d in m["vs_m1"].values() if d]
    zero = [(s14.excludes_zero(d[k]), s14.excludes_zero(d[f"{k}_check"])) for d in paired for k in ("ci95", "ci95_weighted")]
    apart, edge = sum(a and b for a, b in zero), sum(a != b for a, b in zero)
    verdict = [n for n in ev["notes"] if "paired intervals" in n.lower()]
    assert len(verdict) == 1 and verdict[0].endswith(s14.paired_verdict({m["id"]: m["vs_m1"] for m in ev["models"] if m["vs_m1"]}))
    assert (f"The other {len(zero) - apart - edge} of the {len(zero)} include zero" in verdict[0] if apart or edge
            else f"None of the {len(zero)} paired intervals excludes zero" in verdict[0])
    assert ("Borderline: " in verdict[0]) is bool(edge) and "not adjusted for multiple comparisons" in verdict[0]
    # The intervals note names the fire-storm group that carries the most record weight.
    assert any(n.startswith("Intervals:") and "The largest fire-storm group" in n for n in ev["notes"])

    assert set(ev["importance"]) == {"rf_extended", "mlp_extended", "mlp_context"}
    for mid, rows in ev["importance"].items():
        assert {r["feature"] for r in rows} == set(models[mid]["features"])
        assert all(np.isfinite(r["drop_in_auc"]) for r in rows)
    assert ev["notes"] and all(isinstance(n, str) and n for n in ev["notes"])
    # compared with USGS, never "validated" (cross-validation is the scheme's name)
    assert not any("validat" in n.lower().replace("cross-validation", "") for n in ev["notes"])


# ---------------------------------------------------------------- the inventory sample (tests/fixtures)


def _fixture_rows() -> list[dict]:
    return list(csv.DictReader(io.StringIO(FIXTURE_CSV.read_text(encoding="utf-8"))))


@pytest.fixture(scope="module")
def fixture_cols() -> dict:
    """The sample's usable records as step 14's columns, with spatial context and a stand-in soil
    moisture (step 14 fetches the real one): one value per fire and storm, a tenth of them missing."""
    cols = s14.columns(s14.usable(_fixture_rows())[0])
    _, storm = np.unique(s14.storm_keys(cols), return_inverse=True)
    rng = np.random.default_rng(7)
    sm = rng.uniform(0.05, 0.4, storm.max() + 1)
    sm[rng.uniform(size=len(sm)) < 0.1] = np.nan
    cols["soil_moisture_0_7cm"] = sm[storm]
    cols.update(db.spatial_context(cols))
    return cols


@pytest.fixture(scope="module")
def fixture_models(fixture_cols, tmp_path_factory) -> dict:
    """Step 14's saved models (s14.fit_final), trained on the sample and saved and loaded as step 14 does."""
    models = s14.make_models()
    X = {mid: db.feature_matrix(fixture_cols, models[mid][0]) for mid in s14.FINAL}
    ctx_q = np.nanpercentile(fixture_cols["ctx_dist_m"], [25, 50, 75])
    final = s14.fit_final(models, X, fixture_cols["y"], ctx_q, n_jobs=1)
    return db.load_models(db.save_models(final, tmp_path_factory.mktemp("debris_flow") / "models.joblib"))


@pytest.fixture(scope="module", params=["fixture", "saved"])
def saved_models(request) -> dict:
    """The models step 15 maps: trained on the sample here, and step 14's own (skipped without work/)."""
    if request.param == "saved":
        if OFFLINE or not db.MODELS_PATH.exists():
            pytest.skip("work/debris_flow/models.joblib is built by step 14 (gitignored)")
        return db.load_models()
    return request.getfixturevalue("fixture_models")


@pytest.fixture(scope="module")
def fixture_oof(fixture_cols) -> dict:
    """m1_refit's and rf_extended's out-of-fold likelihoods on the sample, leave-one-fire-out (s14.run_fold)."""
    y, fire = fixture_cols["y"], fixture_cols["fire"]
    models = {mid: s14.make_models()[mid] for mid in ("m1_refit", "rf_extended")}
    X = {mid: db.feature_matrix(fixture_cols, features) for mid, (features, _) in models.items()}
    perms = np.stack([np.random.default_rng(r).permutation(len(y)) for r in range(s14.PERM_REPEATS)])
    oof = {mid: np.zeros(len(y)) for mid in models}
    for f in np.unique(fire):
        for mid, (p, _) in s14.run_fold(models, X, y, fire == f, perms).items():
            oof[mid][fire == f] = p
    return oof


def test_the_fixture_is_a_stratified_sample_with_what_step_14_needs():
    rows = _fixture_rows()
    assert 200 <= len(rows) <= 400
    kept, filters = s14.usable(rows)
    assert len(kept) < len(rows) and len(filters) == 8  # the filters drop some
    cols = s14.columns(kept)
    y, keys, outside = cols["y"], s14.storm_keys(cols), ~cols["staley2016"]
    assert len(set(cols["fire"])) >= 5 and 0 < y.sum() < len(y)
    assert (s14.ANALOGUE in set(zip(cols["fire"].tolist(), cols["year"].tolist())))
    # fire-storm groups with both outcomes on M1's records and beyond them, a fire with one outcome, and an early storm
    assert 0 < len(s14.storm_groups(y[outside], keys[outside])) < len(s14.storm_groups(y, keys))
    assert any(len(set(y[cols["fire"] == f])) == 1 for f in set(cols["fire"]))
    assert (cols["days_since_fire"] <= s14.SCENARIO_DAYS).any()


@needs_inventory
def test_the_fixture_is_the_scripts_sample_of_the_inventory():
    spec = importlib.util.spec_from_file_location("make_debris_fixture", FIXTURES / "make_debris_fixture.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    raw = s14.load_inventory()
    inventory = {r["UniqueObservationID"]: r for r in raw}
    rows = _fixture_rows()
    assert list(rows[0]) == list(raw[0])  # every column, in the inventory's order
    assert all(inventory[r["UniqueObservationID"]] == r for r in rows)  # verbatim
    assert script.sample(raw) == rows


def test_within_storm_fields_on_the_fixture(fixture_cols, fixture_oof):
    cols = fixture_cols
    y, keys, outside = cols["y"], s14.storm_keys(cols), ~cols["staley2016"]
    p_m1 = db.m1_likelihood(cols["T"], cols["F"], cols["S"], cols["I15"])
    fields = s14.within_fields(y, keys, outside, p_m1, fixture_oof)
    assert set(fields) == {"m1_published", "m1_refit", "rf_extended"}
    _check_within(fields)
    # rf_extended minus m1_published, by hand: the record-weighted mean of the per-group differences
    groups = s14.storm_groups(y[outside], keys[outside])
    rf, m1, yo = fixture_oof["rf_extended"][outside], p_m1[outside], y[outside]
    d = [roc_auc_score(yo[g], rf[g]) - roc_auc_score(yo[g], m1[g]) for g in groups]
    got = fields["rf_extended"]["vs_m1"]["published"]
    assert got["groups"] == len(groups)
    assert got["weighted_diff"] == pytest.approx(np.average(d, weights=[g.sum() for g in groups]), abs=1e-4)
    # The differences are paired: drawn from the same resamples, so a model paired with a copy of itself scores 0 [0, 0].
    same = s14.within_fields(y, keys, outside, fixture_oof["m1_refit"], {"m1_refit": fixture_oof["m1_refit"]})
    assert same["m1_refit"]["vs_m1"]["published"] == {"groups": len(groups), "median_diff": 0.0, "ci95": [0.0, 0.0],
                                                      "weighted_diff": 0.0, "ci95_weighted": [0.0, 0.0],
                                                      "ci95_check": [0.0, 0.0], "ci95_weighted_check": [0.0, 0.0]}


def test_saved_models_predict_likelihoods(saved_models):
    models = saved_models
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


def test_saved_m1_refit_coefficients_give_its_likelihoods(saved_models):
    entry = saved_models["m1_refit"]
    c = entry["coefficients"]
    assert set(c) == set(db.M1_15) and all(isinstance(v, float) for v in c.values())
    rng = np.random.default_rng(2)
    df = {"T": rng.uniform(0, 1, 200), "F": rng.uniform(0, 1, 200), "S": rng.uniform(0, 0.5, 200), "I15": rng.uniform(0, 60, 200)}
    df["R15"] = db.r15_mm(df["I15"])
    assert db.predict(entry, df) == pytest.approx(db.m1_likelihood(df["T"], df["F"], df["S"], df["I15"], c), abs=1e-12)
    assert c != db.M1_15


def test_saved_random_forest_never_falls_as_rain_rises(saved_models):
    entry = saved_models["rf_extended"]
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
