"""Step 14: post-fire debris-flow models, trained and scored on USGS's observed inventory.

The record is USGS's runoff-generated postfire debris-flow inventory (Graber et al. 2026): one
row per watershed and storm, with M1's inputs (T, F, S), the storm's peak 15-minute intensity and
whether a debris flow followed. It covers 80 fires from 2000–2024 and none from 2025, so nothing
here can score the Eaton or Palisades maps; step 15 compares the models with USGS's assessment.

Six models, all scored leave-one-fire-out (every record of the held-out fire is unseen in training):

  * m1_published  USGS M1 (Staley et al. 2017) with its published coefficients. It was fitted on
                  the Staley et al. (2016) inventory, which this one reproduces, so it is scored
                  only on records outside that inventory.
  * m1_refit      M1's form (T·R, F·R, S·R, unpenalized logistic regression) refitted per fold
  * rf_m1vars, mlp_m1vars      random forest and MLP on M1's four inputs
  * rf_extended, mlp_extended  plus features that exist for a design storm: upstream area and
                  spatial context (mean T/F/S/R15 of the k nearest watersheds in the same fire and
                  storm; their features only, never their responses), which vary between
                  watersheds within a storm; and days since fire and antecedent soil moisture
                  (ERA5-Land, day before the storm), which vary within a fire only between storms
                  (soil moisture also between 0.1° cells), so set the level of a design-storm map
                  rather than its ranking

Per model: pooled out-of-fold ROC AUC, PR AUC (average precision), Brier and base rate; the median
and IQR of per-fire ROC AUC over fires with both outcomes; the held-out Station Fire (2009, San
Gabriel front) as the analogue for Eaton; permutation importance of the extended models. Pooled
and per-fire AUC also credit ranking between storms, so the notes add ROC AUC within each fire and
storm, the ranking a design-storm map shows. Then m1_refit, rf_extended and mlp_extended are
refitted on all usable records for step 15.

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
IMPORTANCE_OF = ("rf_extended", "mlp_extended")
PERM_GROUPS = {"R15 + ctx_R15": ("R15", "ctx_R15")}  # near-duplicates, also permuted together
FINAL = ("m1_refit", "rf_extended", "mlp_extended")

LABELS = {
    "m1_published": "USGS M1, published coefficients (Staley et al. 2017)",
    "m1_refit": "M1 form refitted (logistic, T·R, F·R, S·R)",
    "rf_m1vars": "Random forest, M1's four inputs",
    "mlp_m1vars": "Neural network (MLP), M1's four inputs",
    "rf_extended": "Random forest, extended features",
    "mlp_extended": "Neural network (MLP), extended features",
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
    on held-out fires. Each estimator imputes missing values with its training medians."""
    def rf():
        return RandomForestClassifier(n_estimators=300, min_samples_leaf=5, max_features="sqrt", n_jobs=1, random_state=SEED)

    def mlp():
        return MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, max_iter=400, early_stopping=True,
                             n_iter_no_change=20, random_state=SEED)
    return {
        "m1_refit": (db.FEATURES_M1, make_pipeline(SimpleImputer(strategy="median"), FunctionTransformer(db.m1_interactions),
                                                   LogisticRegression(C=np.inf, max_iter=1000))),
        "rf_m1vars": (db.FEATURES_M1, make_pipeline(SimpleImputer(strategy="median"), rf())),
        "mlp_m1vars": (db.FEATURES_M1, make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), mlp())),
        "rf_extended": (db.FEATURES_EXTENDED, make_pipeline(SimpleImputer(strategy="median"), rf())),
        "mlp_extended": (db.FEATURES_EXTENDED, make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), mlp())),
    }


def perm_sets(features: list[str]) -> list[list[int]]:
    """Columns permuted together: each feature alone, then each PERM_GROUPS group."""
    return [[j] for j in range(len(features))] + [[features.index(f) for f in g] for g in PERM_GROUPS.values()]


def run_fold(models: dict, X: dict, y: np.ndarray, test: np.ndarray, perms: np.ndarray) -> dict:
    """Fit every model without the held-out fire; predict it, and predict it again with each
    extended feature (and each PERM_GROUPS group, jointly) replaced by its value at a random record
    (perms) for permutation importance."""
    out = {}
    for mid, (features, est) in models.items():
        e = clone(est).fit(X[mid][~test], y[~test])
        Xt = X[mid][test]
        p = e.predict_proba(Xt)[:, 1]
        pp = None
        if mid in IMPORTANCE_OF:
            ti = np.flatnonzero(test)
            sets = perm_sets(features)
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


def within_storm(y: np.ndarray, p: np.ndarray, keys: np.ndarray) -> dict:
    """ROC AUC within each (fire, storm) that has both outcomes: the ranking of watersheds under
    one storm, which is what a design-storm map shows. Median, and mean weighted by records."""
    aucs, ns = [], []
    for k in np.unique(keys):
        sel = keys == k
        if 0 < y[sel].sum() < sel.sum():
            aucs.append(roc_auc_score(y[sel], p[sel]))
            ns.append(int(sel.sum()))
    return {"groups": len(aucs), "records": sum(ns), "median": float(np.median(aucs)),
            "weighted": float(np.average(aucs, weights=ns))}


def within_share(v: np.ndarray, keys: np.ndarray) -> float:
    """Share of a feature's variance that lies within (fire, storm) groups."""
    v = np.asarray(v, float)
    within = sum(((v[keys == k] - v[keys == k].mean()) ** 2).sum() for k in np.unique(keys))
    return float(within / ((v - v.mean()) ** 2).sum())


def r4(x) -> float:
    return round(float(x), 4) + 0.0  # + 0.0 turns -0.0 into 0.0


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
    oof_perm = {mid: np.zeros((len(perm_sets(models[mid][0])), PERM_REPEATS, n)) for mid in IMPORTANCE_OF}
    for f, out in zip(fires, folds):
        test = fire == f
        for mid, (p, pp) in out.items():
            oof[mid][test] = p
            if pp is not None:
                oof_perm[mid][:, :, test] = pp

    outside = ~cols["staley2016"]
    p_m1 = db.m1_likelihood(cols["T"], cols["F"], cols["S"], cols["I15"])
    entries = [{
        "id": "m1_published", "label": LABELS["m1_published"], "features": db.FEATURES_M1,
        "cv": "none: published coefficients, scored only on records outside the Staley et al. (2016) inventory M1 was fitted on",
        "n": int(outside.sum()), "flows": int(y[outside].sum()),
        "pooled": scores(y[outside], p_m1[outside]), "per_fire": per_fire(y[outside], p_m1[outside], fire[outside]),
        "analogue": analogue(y, p_m1, cols, outside),
    }]
    for mid, (features, _) in models.items():
        entries.append({
            "id": mid, "label": LABELS[mid], "features": features, "cv": "leave-one-fire-out",
            "n": n, "flows": int(y.sum()), "pooled": scores(y, oof[mid]), "per_fire": per_fire(y, oof[mid], fire),
            "analogue": analogue(y, oof[mid], cols, np.ones(n, bool)),
        })

    importance, group_drop = {}, {}
    for mid in IMPORTANCE_OF:
        base = roc_auc_score(y, oof[mid])
        names = models[mid][0] + list(PERM_GROUPS)
        drops = {f: float(np.mean([base - roc_auc_score(y, oof_perm[mid][j, r]) for r in range(PERM_REPEATS)]))
                 for j, f in enumerate(names)}
        importance[mid] = [{"feature": f, "drop_in_auc": r4(drops[f])}
                           for f in sorted(models[mid][0], key=lambda f: -drops[f])]
        group_drop[mid] = {g: drops[g] for g in PERM_GROUPS}

    # Ranking within one fire and storm (what a design-storm map shows), and how much of each
    # extended feature varies there at all.
    within = {"m1_published": within_storm(y[outside], p_m1[outside], keys[outside])}
    within.update({mid: within_storm(y, oof[mid], keys) for mid in models})
    within_outside = {mid: within_storm(y[outside], oof[mid][outside], keys[outside]) for mid in models}
    share = {f: within_share(cols[f], keys) for f in ("days_since_fire", "soil_moisture_0_7cm", "log_area_km2", "T", "R15")}
    sm_flat = sum(len(np.unique(sm[keys == k])) == 1 for k in np.unique(keys))

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
    lr = final["m1_refit"]["estimator"][-1]
    refit = dict(zip(("B", "Ct", "Cf", "Cs"), [float(lr.intercept_[0]), *map(float, lr.coef_[0])]))
    # size of each refitted term on the log-odds scale, averaged over the usable records
    term = {k: float(np.mean(np.abs(refit[c] * cols[v] * cols["R15"]))) for k, c, v in (("T·R", "Ct", "T"), ("F·R", "Cf", "F"), ("S·R", "Cs", "S"))}

    # The trained models on the same records m1_published is scored on, for a like-for-like comparison.
    same_rows = ", ".join(f"{mid} {roc_auc_score(y[outside], oof[mid][outside]):.3f}" for mid in models)
    n_staley = int(cols["staley2016"].sum())
    station = (fire == ANALOGUE[0]) & (cols["year"] == ANALOGUE[1])
    biggest = max(set(fire), key=lambda f: (fire == f).sum())
    no_big = outside & (fire != biggest)
    no_big_rows = ", ".join(f"{mid} {roc_auc_score(y[no_big], oof[mid][no_big]):.3f}" for mid in models)
    st = cols["staley2016"]
    years = sorted({int(r["FireYear"]) for r in raw})
    states = sorted({r["FireState"] for r in raw})
    one_class = len(fires) - entries[1]["per_fire"]["fires"]
    w = lambda mid, ws=within: f"{mid} {ws[mid]['median']:.3f} / {ws[mid]['weighted']:.3f}"
    notes = [
        f"The inventory covers {len({r['FireName'] for r in raw})} fires from {years[0]}–{years[-1]} in {', '.join(states)}. "
        "It has no 2025 fires, so it holds no observed debris-flow outcomes for Eaton or Palisades, and nothing here scores the "
        "models there: on the Risk tab the models are compared with USGS's assessment, which measures agreement with USGS, not accuracy.",
        f"{biggest} contributes {(fire == biggest).sum():,} of the {n:,} usable records ({(fire == biggest).mean():.0%}). Pooled metrics "
        "weight every record equally, so large fires dominate them; the per-fire median weights every fire equally.",
        "Pooled and per-fire ROC AUC also credit ranking records of different storms against each other, and most rainfall "
        f"variation is between storms ({1 - share['R15']:.0%} of R15's variance lies between fire-storm groups). A design-storm map "
        "ranks watersheds within one fire under one storm, so the closer measure is ROC AUC within each fire and storm that has both "
        f"outcomes ({within['m1_refit']['groups']} such groups, {within['m1_refit']['records']:,} records). Median / record-weighted "
        "mean: " + ", ".join(w(mid) for mid in models) + f". On m1_published's own records ({within['m1_published']['groups']} "
        f"groups, {within['m1_published']['records']:,} records): " + w("m1_published") + ", "
        + ", ".join(w(mid, within_outside) for mid in models) + ".",
        f"Days since fire and antecedent soil moisture are storm-level: {share['days_since_fire']:.1%} and "
        f"{share['soil_moisture_0_7cm']:.1%} of their variance lies within a fire and storm (soil moisture has a single value in "
        f"{sm_flat:,} of the {len(np.unique(keys)):,} fire-storm groups), against {share['log_area_km2']:.0%} for log area and "
        f"{share['T']:.0%} for T. On a design-storm map both are one value for every watershed, so they set the level of the "
        "likelihood there, not the ranking, and their permutation importance is credit for ranking storms, not watersheds.",
        f"{n_staley:,} usable records ({len(set(fire[st]))} fires, including all {int(station.sum())} Station Fire records) "
        f"come from the Staley et al. (2016) inventory M1 was fitted on, so m1_published is scored only on the other {int(outside.sum()):,} "
        "and has no Station Fire analogue. On those same records the out-of-fold ROC AUCs of the trained models are: " + same_rows + ".",
        f"On those {int(outside.sum()):,} records M1's published likelihoods average {p_m1[outside].mean():.3f} against an observed "
        f"debris-flow rate of {y[outside].mean():.3f}; on the {n_staley:,} Staley et al. (2016) records they average "
        f"{p_m1[st].mean():.3f} against {y[st].mean():.3f}. It ranks watersheds well (ROC AUC) but its likelihoods run high, far "
        "more on the newer records, which is what its Brier score reflects. The newer inventories record many more non-flows per debris flow, so "
        "part of that gap may reflect how sites were sampled rather than the watersheds.",
        f"{biggest} is {(outside & (fire == biggest)).sum():,} of those {int(outside.sum()):,} records "
        f"({(fire[outside] == biggest).mean():.0%}). Without it ({int(no_big.sum()):,} records) m1_published scores ROC AUC "
        f"{roc_auc_score(y[no_big], p_m1[no_big]):.3f} and Brier {brier_score_loss(y[no_big], p_m1[no_big]):.3f}, and the trained "
        "models' out-of-fold ROC AUCs on the same records are: " + no_big_rows + ".",
        "M1's form refitted on all usable records gives " + ", ".join(f"{k} = {v:.2f}" for k, v in refit.items())
        + " (published: " + ", ".join(f"{k} = {v:.2f}" for k, v in db.M1_15.items()) + "). The refitted F·R coefficient is near zero "
        "and of the opposite sign to M1's: on this inventory mean dNBR adds little once T and S are in the model (on the log-odds scale "
        "the terms average " + ", ".join(f"{k} {v:.2f}" for k, v in term.items()) + " in absolute value). This fit is saved as "
        "m1_refit in work/debris_flow/models.joblib for the per-fire step.",
        f"Cross-validation is leave-one-fire-out over {len(fires)} folds: every record of the held-out fire is unseen when the models "
        "are fitted. It is not unseen in the design of the variables: T's definition (moderate/high severity and steeper than 23°) "
        "and M1's interaction form were chosen by USGS on the Staley et al. (2016) inventory, which holds every Station Fire record, "
        "so the Station fold is held out from fitting, not from variable design. "
        f"Per-fire ROC AUC needs both outcomes, so {one_class} fires with only debris flows or only non-flows are left out of it. "
        "Records of the same watershed in different storms are not independent; holding out whole fires keeps them together.",
        "PR AUC is average precision. Hyperparameters were fixed before evaluation, not tuned on held-out fires: random forests of "
        "300 trees with at least 5 records per leaf; MLPs with hidden layers of 32 and 16 units, L2 penalty 0.001 and early stopping "
        "on a random 10% of the training records held aside, on standardized inputs. No class reweighting.",
        f"Antecedent soil moisture: {db.SOIL_MOISTURE_SOURCE}, at the observation location ({n_requests} requests, one per fire and run "
        f"of storm dates no more than {SOIL_GAP_DAYS} days apart). It is ~9 km reanalysis, not a measurement. "
        + (f"{sm_missing:,} of {n:,} records had no value and take the training median." if sm_missing
           else f"All {n:,} records have a value; none needed imputing."),
        f"Spatial context: mean T, F, S and R15 of the {db.SPATIAL_K} nearest other watersheds (by outlet) in the same fire and storm, from "
        f"their features only, never their responses. {alone:,} records alone in their storm use their own values; {short:,} have fewer "
        f"than {db.SPATIAL_K} neighbours and use those they have. In the inventory the neighbours are observation points: "
        f"{shared_rows:,} records share their fire, storm and location with another ({shared_locs:,} locations), so their nearest "
        f"neighbour is 0 m away and partly repeats their own features. The mean distance to the context neighbours has median "
        f"{ctx_q[1]:,.0f} m (IQR {ctx_q[0]:,.0f}–{ctx_q[2]:,.0f} m); USGS's segment networks, which the per-fire step applies the "
        "models to, are much denser, so context there averages closer watersheds than in training (these quartiles are saved with "
        f"the models for comparison). ctx_R15 equals R15 in {ctx_r15_same:.0%} of records, where the neighbours share the "
        "watershed's rainfall; under a design storm every watershed gets the same I15, so it equals R15 everywhere.",
        "Vegetation recovery from satellite NDVI is not included; days since fire stands in for it. Soil bulk density is not used: "
        "we had no per-watershed source for it across these fires, and a value constant within a fire would act as a fire identifier "
        "under leave-one-fire-out. Storm accumulation, duration, 30- and 60-minute intensities and rainfall ratios are not used: a "
        "design storm specifies only I15, and many records lack them.",
        "Permutation importance is the drop in pooled out-of-fold ROC AUC when one feature is replaced by its value at a random record "
        f"(mean of {PERM_REPEATS} permutations, each record still predicted by its own fold's model). Correlated features (T and ctx_T, "
        "for example) share credit, so a small drop does not mean a feature is unused. A near-duplicate works the other way: ctx_R15 "
        f"correlates {r15_corr:.2f} with R15, so permuting it alone creates R15/ctx_R15 pairs that never occur, and its drop "
        "overstates what it adds on its own. Permuting R15 and ctx_R15 together drops ROC AUC by "
        + ", ".join(f"{group_drop[mid]['R15 + ctx_R15']:.3f} ({mid})" for mid in IMPORTANCE_OF) + ".",
    ]

    out = {
        "inventory": {**INVENTORY, "records": len(raw), "fires": len({r["FireName"] for r in raw}),
                      "debris_flows": sum(r["Response"] == "1" for r in raw),
                      "used_records": n, "used_fires": len(fires), "used_flows": int(y.sum()), "filters": filters},
        "cv": {"scheme": "leave-one-fire-out", "folds": len(fires)},
        "features": {f: db.FEATURE_DESCRIPTIONS[f] for f in db.FEATURES_EXTENDED},
        "models": entries,
        "importance": importance,
        "notes": notes,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    path = db.save_models(final)

    for e in entries:
        a = e["analogue"]
        print(f"  {e['id']:<13} n={e['n']:>5} AUC={e['pooled']['roc_auc']:.3f} PR={e['pooled']['pr_auc']:.3f} "
              f"Brier={e['pooled']['brier']:.3f} per-fire median={e['per_fire']['median_roc_auc']:.3f} "
              f"(IQR {e['per_fire']['iqr'][0]:.3f}–{e['per_fire']['iqr'][1]:.3f}, {e['per_fire']['fires']} fires)"
              + (f"  Station AUC={a['roc_auc']:.3f} Brier={a['brier']:.3f}" if a else "  Station: n/a")
              + f"  within-storm median={within[e['id']]['median']:.3f} weighted={within[e['id']]['weighted']:.3f}"
              f" ({within[e['id']]['groups']} groups)")
    print(f"wrote {OUT_PATH} and {path} in {time.time() - t_start:.0f} s")


if __name__ == "__main__":
    main()
