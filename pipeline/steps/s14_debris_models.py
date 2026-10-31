"""Step 14: post-fire debris-flow models, trained and scored on USGS's observed inventory.

The record is USGS's runoff-generated postfire debris-flow inventory (Graber et al. 2026): one
row per watershed and storm, with M1's inputs (T, F, S), the storm's peak 15-minute intensity and
whether a debris flow followed. It covers 80 fires from 2000–2024 and none from 2025, so nothing
here can score the Eaton or Palisades maps; step 15 compares the models with USGS's assessment.

Seven models. Six are fitted and scored leave-one-fire-out (every record of the held-out fire is
unseen in training); m1_published is not fitted here at all:

  * m1_published  USGS M1 (Staley et al. 2017) with its published coefficients. It was fitted on
                  the Staley et al. (2016) inventory, which this one includes, so it is scored
                  only on records outside that inventory, with no cross-validation.
  * m1_refit      M1's form (T·R, F·R, S·R, unpenalized logistic regression) refitted per fold
  * rf_m1vars, mlp_m1vars      random forest and MLP on M1's four inputs
  * rf_extended, mlp_extended  plus features that exist for a design storm: upstream area, which
                  varies between watersheds within a storm; and days since fire and antecedent
                  soil moisture (ERA5-Land, day before the storm), which vary within a fire only
                  between storms (soil moisture also between 0.1° cells), so set the level of a
                  design-storm map rather than its ranking
  * mlp_context   mlp_extended's features plus spatial context (mean T/F/S/R15 of the k nearest
                  watersheds in the same fire and storm; their features only, never their
                  responses): an evaluated variant, not mapped

Random forests are constrained to be non-decreasing in rainfall (R15), as M1 is by its form.

Per model: pooled out-of-fold ROC AUC, PR AUC (average precision), Brier and base rate; the median
and IQR of per-fire ROC AUC over fires with both outcomes; ROC AUC within each fire and storm with
both outcomes (within_storm, the ranking a design-storm map shows: pooled and per-fire AUC also
credit ranking storms against each other); the held-out Station Fire (2009, San Gabriel front) as
the analogue for Eaton; permutation importance of the extended models and the context variant.
on_map marks the models behind the map's m1_p_* and rf_p_* columns. Then m1_refit (M1
recalibrated, with its coefficients), rf_extended and mlp_extended are refitted on all usable
records for step 15.

Inputs:  work/debris_flow/USGS_RG_PFDF_Inventory_v1.csv (downloaded from ScienceBase if absent;
         DEBRIS_INVENTORY_DIR=<dir> copies a local copy instead), Open-Meteo ERA5-Land soil
         moisture (cached under work/debris_flow/soil_moisture/)
Outputs: web/public/data/debris_flow/model_eval.json
         work/debris_flow/models.joblib  {model_id: {estimator, features, ...}} (ember.debris.load_models)

Run: uv run python -m steps.s14_debris_models
"""

from __future__ import annotations

import csv
import io
import json
import os
import shutil
import time
from collections import Counter
from datetime import date

import numpy as np
import requests
from joblib import Parallel, delayed, parallel_config
from sklearn.base import clone
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

from ember import debris as db
from ember.config import REPO_DIR

INVENTORY = {"title": "USGS runoff-generated postfire debris-flow inventory (Graber et al. 2026)",
             "doi": "10.5066/P1R9VXC4", "url": "https://www.sciencebase.gov/catalog/item/69612c8ed4be02298529c522"}
INVENTORY_CSV = "USGS_RG_PFDF_Inventory_v1.csv"
INVENTORY_FILE_URL = ("https://www.sciencebase.gov/catalog/file/get/69612c8ed4be02298529c522"
                      "?f=__disk__33%2F41%2F73%2F3341735a5292e0943dec6938f37dc6765e4aa69b")
MISSING = "-9999"
STALEY_2016 = "Staley and others (2016)"  # PreviousUSGSInventory of M1's training records
ANALOGUE = ("Station", 2009)
OUT_PATH = REPO_DIR / "web" / "public" / "data" / "debris_flow" / "model_eval.json"

N_JOBS = 4
SEED = 0
SOIL_GAP_DAYS = 14   # storm dates closer than this share one soil-moisture request
PERM_REPEATS = 3
IMPORTANCE_OF = ("rf_extended", "mlp_extended", "mlp_context")
PERM_GROUPS = {"R15 + ctx_R15": ("R15", "ctx_R15")}  # near-duplicates, also permuted together where a model has both
FINAL = ("m1_refit", "rf_extended", "mlp_extended")
ON_MAP = ("m1_refit", "rf_extended")  # the map's m1_p_* (M1 recalibrated) and rf_p_*; usgs_p_* is USGS's own
# Days from ignition to the Risk tab's scenario storm (2025-02-13) for both Eaton and Palisades: step 15's scenario rule.
# Step 15 stops if its scenario differs, so a change there means rerunning this step.
SCENARIO_DAYS = 37

LABELS = {
    "m1_published": "USGS M1, published coefficients (Staley et al. 2017)",
    "m1_refit": "M1 recalibrated: M1's form refitted (logistic, T·R, F·R, S·R)",
    "rf_m1vars": "Random forest, M1's four inputs (monotone in rainfall)",
    "mlp_m1vars": "Neural network (MLP), M1's four inputs",
    "rf_extended": "Random forest, extended features (monotone in rainfall)",
    "mlp_extended": "Neural network (MLP), extended features",
    "mlp_context": "Neural network (MLP), extended features + spatial context",
}


# ---------------------------------------------------------------- inventory


def load_inventory() -> list[dict]:
    path = db.DEBRIS_WORK / INVENTORY_CSV
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        local = os.environ.get("DEBRIS_INVENTORY_DIR")
        if local and (os.path.exists(os.path.join(local, INVENTORY_CSV))):
            shutil.copy(os.path.join(local, INVENTORY_CSV), path)
        else:
            r = requests.get(INVENTORY_FILE_URL, headers={"User-Agent": db.USER_AGENT}, timeout=300)
            r.raise_for_status()
            path.write_bytes(r.content)
    rows = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))
    need = {"FireName", "FireYear", "FireState", "StormStart", "Response", "PeakI15", "HM23", "dNBR/1000", "KF",
            "UpstreamArea", "DaysSinceFire", "ObservationLatitude", "ObservationLongitude", "PreviousUSGSInventory"}
    if not rows or need - set(rows[0]):
        path.unlink(missing_ok=True)
        raise SystemExit(f"{INVENTORY_CSV}: unexpected columns (missing {sorted(need - set(rows[0] if rows else []))})")
    return rows


def describe(label: str, rows: list[dict]) -> str:
    fires = len({r["FireName"] for r in rows})
    flows = sum(r["Response"] == "1" for r in rows)
    return f"{label}: {len(rows):,} records, {fires} fires, {flows:,} debris flows"


def usable(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Every filter in order, each with the records, fires and flows left after it."""
    steps = [
        ("PeakI15 present", lambda r: r["PeakI15"] != MISSING),
        ("HM23 (T) present", lambda r: r["HM23"] != MISSING),
        ("dNBR/1000 (F) present", lambda r: r["dNBR/1000"] != MISSING),
        ("KF (S) present", lambda r: r["KF"] != MISSING),
        ("UpstreamArea present", lambda r: r["UpstreamArea"] != MISSING),
        ("StormStart, DaysSinceFire and observation location present",
         lambda r: all(r[k] != MISSING for k in ("StormStart", "DaysSinceFire", "ObservationLatitude", "ObservationLongitude"))),
        ("Guards: PeakI15 > 0, 0 ≤ HM23 ≤ 1, UpstreamArea > 0, Response 0/1",
         lambda r: float(r["PeakI15"]) > 0 and 0 <= float(r["HM23"]) <= 1 and float(r["UpstreamArea"]) > 0
         and r["Response"] in ("0", "1")),
    ]
    filters = [describe("All records", rows)]
    for label, keep in steps:
        rows = [r for r in rows if keep(r)]
        filters.append(describe(label, rows))
    return rows, filters


def columns(rows: list[dict]) -> dict[str, np.ndarray]:
    num = lambda k: np.array([float(r[k]) for r in rows])
    i15 = num("PeakI15")
    area = num("UpstreamArea")
    return {
        "fire": np.array([r["FireName"] for r in rows]),
        "year": np.array([int(r["FireYear"]) for r in rows]),
        "storm": np.array([r["StormStart"] for r in rows]),
        "lat": num("ObservationLatitude"), "lon": num("ObservationLongitude"),
        "y": np.array([int(r["Response"]) for r in rows]),
        "T": num("HM23"), "F": num("dNBR/1000"), "S": num("KF"),
        "I15": i15, "R15": db.r15_mm(i15),
        "log_area_km2": np.log10(area),
        "days_since_fire": num("DaysSinceFire"),
        "sub_inventory": np.array([r["PreviousUSGSInventory"] for r in rows]),
        "staley2016": np.array([r["PreviousUSGSInventory"] == STALEY_2016 for r in rows]),
    }


def ymd(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def soil_moisture(cols: dict) -> tuple[np.ndarray, int]:
    """Antecedent soil moisture per record: one request per fire and run of storm dates no more
    than SOIL_GAP_DAYS apart (one request when a fire's storms are close together)."""
    n = len(cols["y"])
    sm = np.full(n, np.nan)
    ante = np.array([db.antecedent_date(ymd(s)) for s in cols["storm"]])
    requests_made = 0
    for fire in np.unique(cols["fire"]):
        idx = np.flatnonzero(cols["fire"] == fire)
        dates = sorted(set(ante[idx]))
        runs, run = [], [dates[0]]
        for d in dates[1:]:
            if (d - run[-1]).days > SOIL_GAP_DAYS:
                runs.append(run)
                run = []
            run.append(d)
        runs.append(run)
        for run in runs:
            sel = idx[np.isin(ante[idx], run)]
            vals = db.fetch_soil_moisture(cols["lat"][sel], cols["lon"][sel], run)
            pos = {d: j for j, d in enumerate(run)}
            sm[sel] = vals[np.arange(len(sel)), [pos[d] for d in ante[sel]]]
            requests_made += 1
    return sm, requests_made


# ---------------------------------------------------------------- models


def make_models() -> dict:
    """{model_id: (features, unfitted estimator)}. Hyperparameters are fixed in advance, not tuned
    on held-out fires. Each estimator imputes missing values with its training medians, keeping
    every column (so a random forest's monotonic_cst stays aligned with its features). Random
    forests are constrained to be non-decreasing in R15 (db.monotonic_cst)."""
    def impute():
        return SimpleImputer(strategy="median", keep_empty_features=True)

    def rf(features):
        return RandomForestClassifier(n_estimators=300, min_samples_leaf=5, max_features="sqrt",
                                      monotonic_cst=db.monotonic_cst(features), n_jobs=1, random_state=SEED)

    def mlp():
        return MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, max_iter=400, early_stopping=True,
                             n_iter_no_change=20, random_state=SEED)
    return {
        "m1_refit": (db.FEATURES_M1, make_pipeline(impute(), FunctionTransformer(db.m1_interactions),
                                                   LogisticRegression(C=np.inf, max_iter=1000))),
        "rf_m1vars": (db.FEATURES_M1, make_pipeline(impute(), rf(db.FEATURES_M1))),
        "mlp_m1vars": (db.FEATURES_M1, make_pipeline(impute(), StandardScaler(), mlp())),
        "rf_extended": (db.FEATURES_EXTENDED, make_pipeline(impute(), rf(db.FEATURES_EXTENDED))),
        "mlp_extended": (db.FEATURES_EXTENDED, make_pipeline(impute(), StandardScaler(), mlp())),
        "mlp_context": (db.FEATURES_CONTEXT, make_pipeline(impute(), StandardScaler(), mlp())),
    }


def m1_coefficients(estimator) -> dict:
    """A fitted m1_refit pipeline's logistic regression as M1 coefficients {B, Ct, Cf, Cs} (M1_15's
    shape, for db.m1_likelihood)."""
    lr = estimator[-1]
    return dict(zip(("B", "Ct", "Cf", "Cs"), [float(lr.intercept_[0]), *map(float, lr.coef_[0])]))


def perm_sets(features: list[str]) -> tuple[list[str], list[list[int]]]:
    """Columns permuted together, with their names: each feature alone, then each PERM_GROUPS group
    whose members are all among the features."""
    groups = {g: m for g, m in PERM_GROUPS.items() if set(m) <= set(features)}
    return (list(features) + list(groups),
            [[j] for j in range(len(features))] + [[features.index(f) for f in m] for m in groups.values()])


def run_fold(models: dict, X: dict, y: np.ndarray, test: np.ndarray, perms: np.ndarray) -> dict:
    """Fit every model without the held-out fire; predict it, and predict it again with each
    feature (and each PERM_GROUPS group, jointly) of the IMPORTANCE_OF models replaced by its value
    at a random record (perms) for permutation importance."""
    out = {}
    for mid, (features, est) in models.items():
        e = clone(est).fit(X[mid][~test], y[~test])
        Xt = X[mid][test]
        p = e.predict_proba(Xt)[:, 1]
        pp = None
        if mid in IMPORTANCE_OF:
            ti = np.flatnonzero(test)
            _, sets = perm_sets(features)
            blocks = []
            for js in sets:
                for perm in perms:
                    Xp = Xt.copy()
                    Xp[:, js] = X[mid][perm[ti]][:, js]
                    blocks.append(Xp)
            pp = e.predict_proba(np.vstack(blocks))[:, 1].reshape(len(sets), len(perms), len(ti))
        out[mid] = (p, pp)
    return out


def scores(y: np.ndarray, p: np.ndarray) -> dict:
    return {"roc_auc": r4(roc_auc_score(y, p)), "pr_auc": r4(average_precision_score(y, p)),
            "brier": r4(brier_score_loss(y, p)), "base_rate": r4(y.mean())}


def per_fire(y: np.ndarray, p: np.ndarray, fire: np.ndarray) -> dict:
    aucs = [roc_auc_score(y[fire == f], p[fire == f]) for f in np.unique(fire) if 0 < y[fire == f].sum() < (fire == f).sum()]
    return {"fires": len(aucs), "median_roc_auc": r4(np.median(aucs)),
            "iqr": [r4(np.percentile(aucs, 25)), r4(np.percentile(aucs, 75))]}


def analogue(y: np.ndarray, p: np.ndarray, cols: dict, mask: np.ndarray) -> dict | None:
    sel = mask & (cols["fire"] == ANALOGUE[0]) & (cols["year"] == ANALOGUE[1])
    if not sel.any() or not 0 < y[sel].sum() < sel.sum():
        return None
    return {"fire": ANALOGUE[0], "year": ANALOGUE[1], "n": int(sel.sum()), "flows": int(y[sel].sum()),
            "roc_auc": r4(roc_auc_score(y[sel], p[sel])), "brier": r4(brier_score_loss(y[sel], p[sel]))}


def storm_keys(cols: dict) -> np.ndarray:
    return np.array([f"{a}\x1f{b}" for a, b in zip(cols["fire"], cols["storm"])])


def storm_groups(y: np.ndarray, keys: np.ndarray) -> list[np.ndarray]:
    """Masks of the (fire, storm) groups that have both outcomes."""
    return [m for m in (keys == k for k in np.unique(keys)) if 0 < y[m].sum() < m.sum()]


def within_storm(y: np.ndarray, p: np.ndarray, keys: np.ndarray) -> dict:
    """ROC AUC within each (fire, storm) that has both outcomes: the ranking of watersheds under
    one storm, which is what a design-storm map shows. Median, and mean weighted by records."""
    groups = storm_groups(y, keys)
    aucs, ns = [roc_auc_score(y[m], p[m]) for m in groups], [int(m.sum()) for m in groups]
    return {"groups": len(aucs), "records": sum(ns), "median_roc_auc": r4(np.median(aucs)),
            "weighted_roc_auc": r4(np.average(aucs, weights=ns))}


def pairs(y: np.ndarray, groups: np.ndarray | None = None) -> int:
    """(debris flow, non-flow) pairs, all of them or only those within one group."""
    if groups is None:
        return int(y.sum()) * int(len(y) - y.sum())
    return sum(pairs(y[groups == g]) for g in np.unique(groups))


def within_share(v: np.ndarray, keys: np.ndarray) -> float:
    """Share of a feature's variance that lies within (fire, storm) groups."""
    v = np.asarray(v, float)
    within = sum(((v[keys == k] - v[keys == k].mean()) ** 2).sum() for k in np.unique(keys))
    return float(within / ((v - v.mean()) ** 2).sum())


def falls_with_rain(estimator, features: list[str], cols: dict) -> tuple[int, float]:
    """Records whose likelihood falls between consecutive design storms (I15 16–40 mm/h, every other
    feature as recorded), and the largest such fall."""
    X = db.feature_matrix(cols, features)
    j = features.index("R15")
    p = []
    for i15 in db.DESIGN_I15:
        Xi = X.copy()
        Xi[:, j] = db.r15_mm(i15)
        p.append(estimator.predict_proba(Xi)[:, 1])
    d = np.diff(np.array(p), axis=0)
    return int((d < -1e-12).any(axis=0).sum()), float(max(0.0, -d.min()))


def r4(x) -> float:
    return round(float(x), 4) + 0.0  # + 0.0 turns -0.0 into 0.0


def signed(x: float) -> str:
    return f"{x:+.3f}"


# ---------------------------------------------------------------- main


def main() -> None:
    t_start = time.time()
    raw = load_inventory()
    rows, filters = usable(raw)
    cols = columns(rows)
    y, fire, n = cols["y"], cols["fire"], len(rows)
    print("\n".join(filters))

    sm, n_requests = soil_moisture(cols)
    cols["soil_moisture_0_7cm"] = sm
    sm_missing = int(np.isnan(sm).sum())
    print(f"soil moisture: {n_requests} Open-Meteo requests, {sm_missing} records missing (imputed with the training median)")
    ctx = db.spatial_context(cols, db.SPATIAL_K)
    cols.update({k: v for k, v in ctx.items() if k not in ("ctx_n", "ctx_dist_m")})
    alone = int((ctx["ctx_n"] == 0).sum())
    short = int(((ctx["ctx_n"] > 0) & (ctx["ctx_n"] < db.SPATIAL_K)).sum())
    ctx_q = np.nanpercentile(ctx["ctx_dist_m"], [25, 50, 75])
    keys = storm_keys(cols)
    # rows at the same fire, storm and location as another row: their nearest neighbour is 0 m away
    loc = np.char.add(keys, np.array([f"\x1f{a:.6f}\x1f{b:.6f}" for a, b in zip(cols["lat"], cols["lon"])]))
    _, loc_inv, loc_n = np.unique(loc, return_inverse=True, return_counts=True)
    shared_rows, shared_locs = int((loc_n[loc_inv] > 1).sum()), int((loc_n > 1).sum())
    ctx_r15_same = float(np.isclose(cols["ctx_R15"], cols["R15"]).mean())
    r15_corr = float(np.corrcoef(cols["R15"], cols["ctx_R15"])[0, 1])

    models = make_models()
    X = {mid: db.feature_matrix(cols, features) for mid, (features, _) in models.items()}
    fires = list(np.unique(fire))
    rng = np.random.default_rng(SEED)
    perms = np.stack([rng.permutation(n) for _ in range(PERM_REPEATS)])
    t0 = time.time()
    with parallel_config(backend="loky", inner_max_num_threads=1):
        folds = Parallel(n_jobs=N_JOBS, verbose=0)(delayed(run_fold)(models, X, y, fire == f, perms) for f in fires)
    print(f"{len(fires)} leave-one-fire-out folds × {len(models)} models in {time.time() - t0:.0f} s")

    oof = {mid: np.zeros(n) for mid in models}
    oof_perm = {mid: np.zeros((len(perm_sets(models[mid][0])[1]), PERM_REPEATS, n)) for mid in IMPORTANCE_OF}
    for f, out in zip(fires, folds):
        test = fire == f
        for mid, (p, pp) in out.items():
            oof[mid][test] = p
            if pp is not None:
                oof_perm[mid][:, :, test] = pp

    outside = ~cols["staley2016"]
    p_m1 = db.m1_likelihood(cols["T"], cols["F"], cols["S"], cols["I15"])
    within = {"m1_published": within_storm(y[outside], p_m1[outside], keys[outside])}
    within.update({mid: within_storm(y, oof[mid], keys) for mid in models})
    entries = [{
        "id": "m1_published", "label": LABELS["m1_published"], "features": db.FEATURES_M1,
        "cv": "none: published coefficients, scored only on records outside the Staley et al. (2016) inventory M1 was fitted on",
        "n": int(outside.sum()), "flows": int(y[outside].sum()),
        "pooled": scores(y[outside], p_m1[outside]), "per_fire": per_fire(y[outside], p_m1[outside], fire[outside]),
        "within_storm": within["m1_published"], "analogue": analogue(y, p_m1, cols, outside), "on_map": False,
    }]
    for mid, (features, _) in models.items():
        entries.append({
            "id": mid, "label": LABELS[mid], "features": features, "cv": "leave-one-fire-out",
            "n": n, "flows": int(y.sum()), "pooled": scores(y, oof[mid]), "per_fire": per_fire(y, oof[mid], fire),
            "within_storm": within[mid], "analogue": analogue(y, oof[mid], cols, np.ones(n, bool)), "on_map": mid in ON_MAP,
        })
    by_id = {e["id"]: e for e in entries}

    importance, group_drop = {}, {}
    for mid in IMPORTANCE_OF:
        base = roc_auc_score(y, oof[mid])
        features = models[mid][0]
        names, _ = perm_sets(features)
        drops = {f: float(np.mean([base - roc_auc_score(y, oof_perm[mid][j, r]) for r in range(PERM_REPEATS)]))
                 for j, f in enumerate(names)}
        importance[mid] = [{"feature": f, "drop_in_auc": r4(drops[f])} for f in sorted(features, key=lambda f: -drops[f])]
        group_drop[mid] = {g: drops[g] for g in names[len(features):]}

    # How much of each extended feature varies within one fire and storm at all, and how many of
    # the pairs pooled ROC AUC compares lie within one.
    within_outside = {mid: within_storm(y[outside], oof[mid][outside], keys[outside]) for mid in models}
    share = {f: within_share(cols[f], keys) for f in ("days_since_fire", "soil_moisture_0_7cm", "log_area_km2", "T", "R15")}
    sm_flat = sum(len(np.unique(sm[keys == k])) == 1 for k in np.unique(keys))
    # of the pairs pooled ROC AUC compares, and of those per-fire ROC AUC compares, the share within one storm
    pairs_in, pairs_in_outside = pairs(y, keys) / pairs(y), pairs(y[outside], keys[outside]) / pairs(y[outside])
    pairs_in_fire = pairs(y, keys) / pairs(y, fire)
    group_n = [int(m.sum()) for m in storm_groups(y, keys)]
    group_flows = [int(y[m].sum()) for m in storm_groups(y, keys)]

    final = {}
    for mid in FINAL:
        features, est = models[mid]
        e = clone(est)
        if mid.startswith("rf_"):
            e.set_params(randomforestclassifier__n_jobs=N_JOBS)
        e.fit(X[mid], y)
        final[mid] = {"estimator": e, "features": features, "spatial_k": db.SPATIAL_K, "n_train": n, "flows_train": int(y.sum()),
                      "train_medians": {f: r4(np.nanmedian(X[mid][:, j])) for j, f in enumerate(features)},
                      "context_distance_m": dict(zip(("q25", "median", "q75"), map(float, ctx_q)))}
        if mid.startswith("rf_"):
            final[mid]["monotonic_cst"] = db.monotonic_cst(features)
    refit = m1_coefficients(final["m1_refit"]["estimator"])
    final["m1_refit"]["coefficients"] = refit
    p_refit = final["m1_refit"]["estimator"].predict_proba(X["m1_refit"])[:, 1]
    gap = float(np.max(np.abs(p_refit - db.m1_likelihood(cols["T"], cols["F"], cols["S"], cols["I15"], refit))))
    if gap > 1e-9:
        raise SystemExit(f"m1_refit's coefficients differ from its estimator by {gap:.3g}")
    # size of each refitted term on the log-odds scale, averaged over the usable records
    term = {k: float(np.mean(np.abs(refit[c] * cols[v] * cols["R15"]))) for k, c, v in (("T·R", "Ct", "T"), ("F·R", "Cf", "F"), ("S·R", "Cs", "S"))}

    # Does a likelihood fall when rain rises? The saved models, and the same forest without its constraint.
    falls = {mid: falls_with_rain(final[mid]["estimator"], final[mid]["features"], cols) for mid in ("rf_extended", "mlp_extended")}
    free = clone(models["rf_extended"][1]).set_params(randomforestclassifier__monotonic_cst=None, randomforestclassifier__n_jobs=N_JOBS)
    falls["rf_extended unconstrained"] = falls_with_rain(free.fit(X["rf_extended"], y), db.FEATURES_EXTENDED, cols)
    if falls["rf_extended"][0]:
        raise SystemExit(f"rf_extended falls with rising rainfall for {falls['rf_extended'][0]} records despite its constraint")

    # The trained models on the same records m1_published is scored on, for a like-for-like comparison.
    same_rows = ", ".join(f"{mid} {roc_auc_score(y[outside], oof[mid][outside]):.3f}" for mid in models)
    n_staley = int(cols["staley2016"].sum())
    station = (fire == ANALOGUE[0]) & (cols["year"] == ANALOGUE[1])
    biggest = max(set(fire), key=lambda f: (fire == f).sum())
    no_big = outside & (fire != biggest)
    no_big_rows = ", ".join(f"{mid} {roc_auc_score(y[no_big], oof[mid][no_big]):.3f}" for mid in models)
    st = cols["staley2016"]
    subs = cols["sub_inventory"]
    sub_rates = ", ".join(f"{s} {y[subs == s].mean():.3f} ({int((subs == s).sum()):,} records)"
                          for s in sorted(set(subs), key=lambda s: -(subs == s).sum()))
    years = sorted({int(r["FireYear"]) for r in raw})
    states = sorted({r["FireState"] for r in raw})
    one_class = len(fires) - by_id["m1_refit"]["per_fire"]["fires"]
    w = lambda mid, ws=within: f"{mid} {ws[mid]['median_roc_auc']:.3f} / {ws[mid]['weighted_roc_auc']:.3f}"

    early = cols["days_since_fire"] <= SCENARIO_DAYS
    early_groups = Counter(keys[early])
    (top_key, top_n), = early_groups.most_common(1)
    top_fire, top_storm = top_key.split("\x1f")

    ctx_m, ext_m = by_id["mlp_context"], by_id["mlp_extended"]
    d_within = (ctx_m["within_storm"]["median_roc_auc"] - ext_m["within_storm"]["median_roc_auc"],
                ctx_m["within_storm"]["weighted_roc_auc"] - ext_m["within_storm"]["weighted_roc_auc"])
    verdict = ("Within storms it ranks better than mlp_extended on both measures" if min(d_within) > 0 else
               "Within storms it ranks no better than mlp_extended on either measure" if max(d_within) <= 0 else
               "Within storms the two measures disagree")
    ctx_imp = {r["feature"]: r["drop_in_auc"] for r in importance["mlp_context"]}

    notes = [
        f"The inventory covers {len({r['FireName'] for r in raw})} fires from {years[0]}–{years[-1]} in {', '.join(states)}. "
        "It has no 2025 fires, so it holds no observed debris-flow outcomes for Eaton or Palisades, and nothing here scores the "
        "models there: on the Risk tab the models are compared with USGS's assessment, which measures agreement with USGS, not accuracy.",
        "Seven models: six are fitted and scored leave-one-fire-out; m1_published is not fitted here (no cross-validation): its "
        "published coefficients are scored only on records outside the inventory they were fitted on. on_map marks the models behind "
        "the map's columns: m1_refit (M1 recalibrated, m1_p_*) and rf_extended (rf_p_*); the map's usgs_p_* is USGS's own published "
        "M1. The MLPs are scored here but not mapped, because nothing constrains them to rise with rainfall.",
        f"{biggest} contributes {(fire == biggest).sum():,} of the {n:,} usable records ({(fire == biggest).mean():.0%}). Pooled metrics "
        "weight every record equally, so large fires dominate them; the per-fire median weights every fire equally.",
        "Pooled ROC AUC mostly ranks records of different storms against each other: only "
        f"{pairs_in:.0%} of the (debris flow, non-flow) pairs it compares lie within one fire and storm "
        f"({pairs_in_outside:.0%} on m1_published's records), and {1 - share['R15']:.0%} of R15's variance lies between fire-storm "
        f"groups. Per-fire ROC AUC also ranks a fire's storms against each other ({pairs_in_fire:.0%} of its pairs lie within one "
        "storm). A design-storm map ranks watersheds within one fire under one storm, so each model's within_storm is ROC AUC within "
        f"each fire and storm that has both outcomes ({within['m1_refit']['groups']} such groups, {within['m1_refit']['records']:,} "
        f"records; for m1_published, {within['m1_published']['groups']} groups, {within['m1_published']['records']:,} records). On "
        "m1_published's records the trained models' within-storm median / record-weighted mean are: "
        + ", ".join(w(mid, within_outside) for mid in models) + f", against {w('m1_published')}. Most groups are small "
        f"(median {np.median(group_n):.0f} records and {np.median(group_flows):.0f} debris flows), so the median lands on fractions "
        "with small denominators; the record-weighted mean is less coarse.",
        f"Days since fire and antecedent soil moisture are storm-level: {share['days_since_fire']:.1%} and "
        f"{share['soil_moisture_0_7cm']:.1%} of their variance lies within a fire and storm (soil moisture has a single value in "
        f"{sm_flat:,} of the {len(np.unique(keys)):,} fire-storm groups), against {share['log_area_km2']:.0%} for log area and "
        f"{share['T']:.0%} for T. On a design-storm map both are one value for every watershed, so they set the level of the "
        "likelihood there, not the ranking, and their permutation importance is credit for ranking storms, not watersheds.",
        f"The Risk tab's scenario storm comes {SCENARIO_DAYS} days after ignition; the usable records have a median of "
        f"{np.median(cols['days_since_fire']):.0f} days since fire. Only {int(early.sum()):,} of them ({len(set(fire[early]))} fires, "
        f"{len(early_groups)} fire-storms, {int(y[early].sum())} debris flows) are from storms within {SCENARIO_DAYS} days of a fire, "
        f"and {top_n:,} of those are one storm: the {top_fire} Fire's of {ymd(top_storm):%Y-%m-%d}. What the extended models do at "
        f"{SCENARIO_DAYS} days rests mostly on that one storm, so the level of rf_p_* under the scenario is an extrapolation from "
        "little data.",
        f"{n_staley:,} usable records ({len(set(fire[st]))} fires, including all {int(station.sum())} Station Fire records) "
        f"come from the Staley et al. (2016) inventory M1 was fitted on, so m1_published is scored only on the other {int(outside.sum()):,} "
        "and has no Station Fire analogue. On those same records the out-of-fold ROC AUCs of the trained models are: " + same_rows + ".",
        f"On those {int(outside.sum()):,} records M1's published likelihoods average {p_m1[outside].mean():.3f} against an observed "
        f"debris-flow rate of {y[outside].mean():.3f}; on the {n_staley:,} Staley et al. (2016) records they average "
        f"{p_m1[st].mean():.3f} against {y[st].mean():.3f}. Its pooled ROC AUC ({by_id['m1_published']['pooled']['roc_auc']:.3f}) "
        f"mostly credits ranking storms against each other ({pairs_in_outside:.0%} of the pairs lie within one fire and storm); within "
        f"a fire and storm, the ranking a map shows, its median ROC AUC is {within['m1_published']['median_roc_auc']:.3f} "
        f"(record-weighted {within['m1_published']['weighted_roc_auc']:.3f}). Its likelihoods run high, far more on the newer records, which "
        "is what its Brier score reflects.",
        "Absolute likelihood levels depend on how each sub-inventory sampled non-events: the observed debris-flow rate is "
        f"{y[st].mean():.3f} in the Staley et al. (2016) records and {y[outside].mean():.3f} in the rest (by PreviousUSGSInventory: "
        f"{sub_rates}). M1 recalibrated (m1_refit fitted on all {n:,} usable records) averages {p_refit.mean():.3f} overall, "
        f"{p_refit[st].mean():.3f} on the Staley et al. (2016) records (observed {y[st].mean():.3f}) and {p_refit[outside].mean():.3f} "
        f"on the rest (observed {y[outside].mean():.3f}), so its level follows the mix of sub-inventories it was fitted on; M1's "
        "published coefficients were fitted on the Staley et al. (2016) inventory alone. Neither level is an observed rate for a "
        "2025 fire.",
        f"{biggest} is {(outside & (fire == biggest)).sum():,} of those {int(outside.sum()):,} records "
        f"({(fire[outside] == biggest).mean():.0%}). Without it ({int(no_big.sum()):,} records) m1_published scores ROC AUC "
        f"{roc_auc_score(y[no_big], p_m1[no_big]):.3f} and Brier {brier_score_loss(y[no_big], p_m1[no_big]):.3f}, and the trained "
        "models' out-of-fold ROC AUCs on the same records are: " + no_big_rows + ".",
        "M1 recalibrated: M1's form refitted on all usable records gives " + ", ".join(f"{k} = {v:.2f}" for k, v in refit.items())
        + " (published: " + ", ".join(f"{k} = {v:.2f}" for k, v in db.M1_15.items()) + "). "
        + ("The refitted F·R coefficient is near zero and of the opposite sign to M1's: on this inventory mean dNBR adds little once "
           "T and S are in the model" if refit["Cf"] * db.M1_15["Cf"] < 0 else "The refitted coefficients keep M1's signs")
        + " (on the log-odds scale the terms average " + ", ".join(f"{k} {v:.2f}" for k, v in term.items()) + " in absolute value). "
        "It is saved as m1_refit, with these coefficients, in work/debris_flow/models.joblib; the per-fire step maps it as m1_p_*.",
        f"Cross-validation is leave-one-fire-out over {len(fires)} folds: every record of the held-out fire is unseen when the models "
        "are fitted. It is not unseen in the design of the variables: T's definition (moderate/high severity and steeper than 23°) "
        "and M1's interaction form were chosen by USGS on the Staley et al. (2016) inventory, which holds every Station Fire record, "
        "so the Station fold is held out from fitting, not from variable design. "
        f"Per-fire ROC AUC needs both outcomes, so {one_class} fires with only debris flows or only non-flows are left out of it. "
        "Records of the same watershed in different storms are not independent; holding out whole fires keeps them together.",
        "PR AUC is average precision. Hyperparameters were fixed before evaluation, not tuned on held-out fires: random forests of "
        "300 trees with at least 5 records per leaf, constrained to be non-decreasing in R15 (scikit-learn monotonic_cst: +1 on R15, "
        "0 elsewhere); MLPs with hidden layers of 32 and 16 units, L2 penalty 0.001 and early stopping on a random 10% of the "
        "training records held aside, on standardized inputs. No class reweighting.",
        "A likelihood that falls when rain rises is unacceptable on a design-storm map, so the random forests are monotone in R15, "
        "as M1 is by its form. Check on all usable records at the seven design storms (I15 "
        f"{db.DESIGN_I15[0]}–{db.DESIGN_I15[-1]} mm/h, every other feature as recorded), counting records whose likelihood falls "
        "between consecutive storms: the saved rf_extended, "
        f"{falls['rf_extended'][0]:,} of {n:,}; the same forest fitted without the constraint, {falls['rf_extended unconstrained'][0]:,} "
        f"(largest fall {falls['rf_extended unconstrained'][1]:.3f}); the saved mlp_extended, {falls['mlp_extended'][0]:,} (largest "
        f"fall {falls['mlp_extended'][1]:.3f}).",
        f"Antecedent soil moisture: {db.SOIL_MOISTURE_SOURCE}, at the observation location ({n_requests} requests, one per fire and run "
        f"of storm dates no more than {SOIL_GAP_DAYS} days apart). It is ~9 km reanalysis, not a measurement. "
        + (f"{sm_missing:,} of {n:,} records had no value and take the training median." if sm_missing
           else f"All {n:,} records have a value; none needed imputing."),
        f"Spatial context is an evaluated variant, not one of the extended features: mlp_context adds the mean T, F, S and R15 of the "
        f"{db.SPATIAL_K} nearest other watersheds (by outlet) in the same fire and storm, from their features only, never their "
        "responses. Against mlp_extended it changes pooled ROC AUC by "
        f"{signed(ctx_m['pooled']['roc_auc'] - ext_m['pooled']['roc_auc'])}, Brier by "
        f"{signed(ctx_m['pooled']['brier'] - ext_m['pooled']['brier'])}, the per-fire median by "
        f"{signed(ctx_m['per_fire']['median_roc_auc'] - ext_m['per_fire']['median_roc_auc'])}, within-storm ROC AUC by "
        f"{signed(d_within[0])} (median) and {signed(d_within[1])} (record-weighted), and Station ROC AUC by "
        f"{signed(ctx_m['analogue']['roc_auc'] - ext_m['analogue']['roc_auc'])}. {verdict}. Its context features' permutation "
        "importance: " + ", ".join(f"ctx_{c} {ctx_imp[f'ctx_{c}']:.3f}" for c in db.CONTEXT_OF) + ".",
        "mlp_context is not mapped. Under a design storm every watershed gets the same I15, so ctx_R15 equals R15 everywhere (in the inventory "
        f"it does in {ctx_r15_same:.0%} of records). In the inventory the neighbours are observation points: {alone:,} records alone in "
        f"their storm use their own values, {short:,} have fewer than {db.SPATIAL_K} neighbours, and {shared_rows:,} share their fire, "
        f"storm and location with another ({shared_locs:,} locations), so their nearest neighbour is 0 m away. The mean distance to "
        f"the context neighbours has median {ctx_q[1]:,.0f} m (IQR {ctx_q[0]:,.0f}–{ctx_q[2]:,.0f} m); USGS's segment networks are "
        "much denser (step 15 reports their spacing), where the neighbours are segments upstream and downstream on the same channel "
        "and ties between equidistant segments change which are averaged. These quartiles are saved with the models.",
        "Vegetation recovery from satellite NDVI is not included; days since fire stands in for it. Soil bulk density is not used: "
        "we had no per-watershed source for it across these fires, and a value constant within a fire would act as a fire identifier "
        "under leave-one-fire-out. Storm accumulation, duration, 30- and 60-minute intensities and rainfall ratios are not used: a "
        "design storm specifies only I15, and many records lack them.",
        "Permutation importance is the drop in pooled out-of-fold ROC AUC when one feature is replaced by its value at a random record "
        f"(mean of {PERM_REPEATS} permutations, each record still predicted by its own fold's model), so like pooled ROC AUC it mostly "
        "credits ranking storms. Correlated features share credit, so a small drop does not mean a feature is unused. A near-duplicate "
        f"works the other way: in mlp_context, ctx_R15 correlates {r15_corr:.2f} with R15, so permuting it alone creates R15/ctx_R15 "
        "pairs that never occur, and its drop overstates what it adds on its own. Permuting R15 and ctx_R15 together drops "
        f"mlp_context's ROC AUC by {group_drop['mlp_context']['R15 + ctx_R15']:.3f}.",
    ]

    out = {
        "inventory": {**INVENTORY, "records": len(raw), "fires": len({r["FireName"] for r in raw}),
                      "debris_flows": sum(r["Response"] == "1" for r in raw),
                      "used_records": n, "used_fires": len(fires), "used_flows": int(y.sum()), "filters": filters},
        "cv": {"scheme": "leave-one-fire-out", "folds": len(fires)},
        "features": {f: db.FEATURE_DESCRIPTIONS[f] for f in db.FEATURES_CONTEXT},
        "models": entries,
        "importance": importance,
        "notes": notes,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    path = db.save_models(final)

    for e in entries:
        a, ws = e["analogue"], e["within_storm"]
        print(f"  {e['id']:<13} n={e['n']:>5} AUC={e['pooled']['roc_auc']:.3f} PR={e['pooled']['pr_auc']:.3f} "
              f"Brier={e['pooled']['brier']:.3f} per-fire median={e['per_fire']['median_roc_auc']:.3f} "
              f"(IQR {e['per_fire']['iqr'][0]:.3f}–{e['per_fire']['iqr'][1]:.3f}, {e['per_fire']['fires']} fires)"
              + (f"  Station AUC={a['roc_auc']:.3f} Brier={a['brier']:.3f}" if a else "  Station: n/a")
              + f"  within-storm median={ws['median_roc_auc']:.3f} weighted={ws['weighted_roc_auc']:.3f} ({ws['groups']} groups)"
              + ("  [map]" if e["on_map"] else ""))
    print("  M1 recalibrated: " + ", ".join(f"{k} = {v:.4f}" for k, v in refit.items()))
    print("  falls with rising rain: " + ", ".join(f"{k} {v[0]} (max {v[1]:.3f})" for k, v in falls.items()))
    print(f"wrote {OUT_PATH} and {path} in {time.time() - t_start:.0f} s")


if __name__ == "__main__":
    main()
