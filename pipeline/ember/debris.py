"""Post-fire debris-flow likelihood: USGS M1, the extended features and the saved models.

Shared by step 14 (models trained and scored on USGS's observed inventory, leave-one-fire-out)
and step 15 (the per-fire USGS stream segments under USGS's design storms).

M1 (Staley et al. 2017, 15-minute parameters) is the likelihood of a runoff-generated debris flow
from a watershed during a storm:

    p = 1 / (1 + exp(-X)),   X = B + Ct·T·R + Cf·F·R + Cs·S·R

  T  proportion of the upstream area burned at moderate/high severity AND steeper than 23°
  F  mean dNBR / 1000 of the upstream area
  S  mean soil KF-factor of the upstream area
  R  peak 15-minute rainfall ACCUMULATION in mm: R = I15 [mm/h] × 0.25

Column conventions. Functions here take a mapping of equal-length columns (a dict of numpy arrays;
a pandas DataFrame works too):
  fire, storm          group keys: the fire, and the storm (its start date in the inventory, the
                       design I15 for a scenario). Spatial context never crosses either.
  lat, lon             the watershed outlet, WGS84
  T, F, S, R15         M1's inputs, R15 in mm
  log_area_km2         log10 of the upstream area in km²
  days_since_fire      storm start minus fire ignition, days
  soil_moisture_0_7cm  ERA5-Land volumetric soil moisture 0–7 cm, mean of the UTC day before the
                       storm, m³/m³ (NaN when unavailable; the saved estimators impute it)
  ctx_T … ctx_R15      spatial context (spatial_context): means over the k nearest other rows in
                       the same fire and storm, from their features only. In the inventory a row
                       is an observation point, and several can share one location; on a USGS
                       segment network a row is a stream segment, and segments sit much closer.
                       Used only by the evaluated variant FEATURES_CONTEXT, not by FEATURES_EXTENDED:
                       under a design storm ctx_R15 equals R15, and the map's neighbours are much
                       nearer than the inventory's.

Area varies between watersheds within a storm. days_since_fire is one value per fire and storm,
and soil moisture varies only between 0.1° cells: both vary within a fire across storms, but are
constant (or nearly) across a design-storm map, where they set the level of the likelihood rather
than the ranking of watersheds.

Random forests are constrained to be non-decreasing in rainfall (monotonic_cst: +1 on R15, 0
elsewhere), as M1 is by its form: a likelihood that falls when rain rises has no place on a
design-storm map. Nothing constrains an MLP, so the MLPs are evaluated but not mapped.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import date, timedelta
from pathlib import Path

import joblib
import numpy as np
import requests
from scipy.spatial import cKDTree

from .config import WORK_DIR
from .geo import meters_per_degree

M1_15 = dict(B=-3.63, Ct=0.41, Cf=0.67, Cs=0.70)  # Staley et al. (2017), 15-minute rainfall
R_PER_I15 = 0.25  # R [mm] = I15 [mm/h] × 0.25 h

FEATURES_M1 = ["T", "F", "S", "R15"]
CONTEXT_OF = ["T", "F", "S", "R15"]  # columns whose neighbour means become ctx_<name>
SPATIAL_K = 5
FEATURES_EXTENDED = FEATURES_M1 + ["log_area_km2", "days_since_fire", "soil_moisture_0_7cm"]
FEATURES_CONTEXT = FEATURES_EXTENDED + [f"ctx_{c}" for c in CONTEXT_OF]  # the mlp_context variant: evaluated, not mapped
RISES_WITH = ("R15",)  # a random forest's likelihood is constrained to be non-decreasing in these
DESIGN_I15 = (16, 20, 24, 28, 32, 36, 40)  # mm/h, USGS's design storms

FEATURE_DESCRIPTIONS = {
    "T": "Proportion of the upstream area burned at moderate/high severity and steeper than 23° (inventory HM23)",
    "F": "Mean dNBR / 1000 of the upstream area (inventory dNBR/1000)",
    "S": "Mean soil KF-factor of the upstream area, STATSGO (inventory KF)",
    "R15": "Peak 15-minute rainfall accumulation, mm (= PeakI15 mm/h × 0.25)",
    "log_area_km2": "log10 of the upstream contributing area, km² (inventory UpstreamArea)",
    "days_since_fire": "Days from fire ignition to storm start; stands in for vegetation recovery (inventory DaysSinceFire). "
                       "One value per fire and storm, so constant across a design-storm map",
    "soil_moisture_0_7cm": "Antecedent soil moisture 0–7 cm, m³/m³: ERA5-Land (Open-Meteo archive), mean of the UTC day before the storm. "
                           "Varies only between 0.1° cells within a storm",
    **{f"ctx_{c}": f"Spatial context: mean {c} of the {SPATIAL_K} nearest other watersheds in the same fire and storm "
                   "(features only); used only by the mlp_context variant"
       for c in CONTEXT_OF},
}

DEBRIS_WORK = WORK_DIR / "debris_flow"
MODELS_PATH = DEBRIS_WORK / "models.joblib"
SOIL_CACHE = DEBRIS_WORK / "soil_moisture"

OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive"
SOIL_MODEL = "era5_land"
SOIL_VAR = "soil_moisture_0_to_7cm"  # hourly, m³/m³; checked against the API before first use
SOIL_MOISTURE_SOURCE = (f"Open-Meteo archive API, models={SOIL_MODEL}, hourly {SOIL_VAR} (ECMWF ERA5-Land reanalysis, 0.1° grid), "
                        "mean of the 24 UTC hours of the day before the storm")
USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"


# ---------------------------------------------------------------- M1


def r15_mm(i15_mm_h):
    """Peak 15-minute accumulation (mm) from the peak 15-minute intensity (mm/h)."""
    return np.asarray(i15_mm_h, float) * R_PER_I15


def m1_likelihood(T, F, S, i15_mm_h, params: dict = M1_15) -> np.ndarray:
    """USGS M1 likelihood for watershed inputs T, F, S under a peak 15-minute intensity (mm/h)."""
    R = r15_mm(i15_mm_h)
    X = params["B"] + (params["Ct"] * np.asarray(T, float) + params["Cf"] * np.asarray(F, float)
                       + params["Cs"] * np.asarray(S, float)) * R
    return 1.0 / (1.0 + np.exp(-X))


def monotonic_cst(features: list[str]) -> list[int]:
    """RandomForestClassifier(monotonic_cst=...) for these features: +1 (the likelihood does not
    fall as the feature rises) on RISES_WITH, 0 (unconstrained) elsewhere."""
    return [1 if f in RISES_WITH else 0 for f in features]


def m1_interactions(X: np.ndarray) -> np.ndarray:
    """[T, F, S, R15] → M1's three terms [T·R, F·R, S·R] (the m1_refit model's first stage)."""
    X = np.asarray(X, float)
    return X[:, :3] * X[:, 3:4]


# ---------------------------------------------------------------- features


def feature_matrix(df, features: list[str]) -> np.ndarray:
    return np.column_stack([np.asarray(df[f], float) for f in features])


def spatial_context(df, k: int = SPATIAL_K, columns: list[str] = CONTEXT_OF) -> dict[str, np.ndarray]:
    """Mean of each column over the k nearest OTHER watersheds (by outlet) in the same fire and storm.

    Reads only fire, storm, lat, lon and `columns` (features), never a response. A group with
    fewer than k + 1 watersheds uses the neighbours it has; a watershed alone in its group gets its
    own values. Returns {ctx_<column>: values} plus ctx_n, the number of neighbours used, and
    ctx_dist_m, their mean distance in metres (NaN when alone), so training and use can be compared.
    """
    fire, storm = np.asarray(df["fire"]), np.asarray(df["storm"])
    lat, lon = np.asarray(df["lat"], float), np.asarray(df["lon"], float)
    vals = feature_matrix(df, columns)
    out = vals.copy()
    n_used = np.zeros(len(lat), int)
    dist = np.full(len(lat), np.nan)
    keys = np.array([f"{a}\x1f{b}" for a, b in zip(fire, storm)])
    for key in np.unique(keys):
        idx = np.flatnonzero(keys == key)
        if len(idx) < 2:
            continue
        m_lon, m_lat = meters_per_degree(float(lat[idx].mean()))
        xy = np.column_stack([lon[idx] * m_lon, lat[idx] * m_lat])
        kk = min(k, len(idx) - 1)
        d, nb = cKDTree(xy).query(xy, k=kk + 1)
        for row, (cand, cd) in enumerate(zip(np.atleast_2d(nb), np.atleast_2d(d))):
            keep = cand != row  # drop self even when coordinates repeat
            others, od = cand[keep][:kk], cd[keep][:kk]
            out[idx[row]] = vals[idx[others]].mean(axis=0)
            n_used[idx[row]] = len(others)
            dist[idx[row]] = od.mean()
    ctx = {f"ctx_{c}": out[:, j] for j, c in enumerate(columns)}
    ctx["ctx_n"] = n_used
    ctx["ctx_dist_m"] = dist
    return ctx


# ---------------------------------------------------------------- soil moisture (Open-Meteo)


def _retryable(e: requests.RequestException) -> bool:
    """429, 5xx, a dropped connection or a timeout can pass; any other 4xx will not."""
    if getattr(e, "response", None) is not None:
        return e.response.status_code == 429 or e.response.status_code >= 500
    return isinstance(e, (requests.ConnectionError, requests.Timeout))


def _get_json(params: dict, dest: Path, retries: int = 5) -> list[dict]:
    """GET the archive API with the project User-Agent, cached at dest; 429/5xx back off (the
    minute limit needs up to a minute), other 4xx fail at once. A response that does not parse is
    not cached."""
    if not (dest.exists() and dest.stat().st_size > 0):
        dest.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(retries):
            try:
                r = requests.get(OPEN_METEO, params=params, headers={"User-Agent": USER_AGENT}, timeout=120)
                if r.status_code >= 400:
                    raise requests.HTTPError(f"{r.status_code} from Open-Meteo: {r.text[:200]}", response=r)
                dest.write_bytes(r.content)
                break
            except requests.RequestException as e:
                if attempt == retries - 1 or not _retryable(e):
                    raise
                time.sleep(5.0 * 2**attempt)
    try:
        data = json.loads(dest.read_bytes())
        if isinstance(data, dict):
            if data.get("error"):
                raise ValueError(data.get("reason"))
            data = [data]
        return data
    except (ValueError, json.JSONDecodeError):
        dest.unlink(missing_ok=True)
        raise


def fetch_soil_moisture(lat, lon, dates, cache_dir: Path = SOIL_CACHE) -> np.ndarray:
    """ERA5-Land 0–7 cm soil moisture (m³/m³), daily mean over each UTC date, at each point.

    lat, lon: equal-length sequences of points (or scalars); dates: a sequence of datetime.date.
    Points are snapped to the 0.1° ERA5-Land grid and deduplicated, then ONE request covers every
    cell from the first date to the last (cached under cache_dir). Returns (n_points, n_dates),
    NaN where the request failed or a day has no data.
    """
    lat, lon = np.atleast_1d(np.asarray(lat, float)), np.atleast_1d(np.asarray(lon, float))
    dates = [d if isinstance(d, date) else date.fromisoformat(str(d)) for d in dates]
    out = np.full((len(lat), len(dates)), np.nan)
    if not len(lat) or not dates:
        return out
    cells = np.round(np.column_stack([lat, lon]), 1)
    uniq, inv = np.unique(cells, axis=0, return_inverse=True)
    inv = np.asarray(inv).ravel()
    start, end = min(dates), max(dates)
    params = {
        "latitude": ",".join(f"{a:.1f}" for a in uniq[:, 0]),
        "longitude": ",".join(f"{b:.1f}" for b in uniq[:, 1]),
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "hourly": SOIL_VAR, "models": SOIL_MODEL, "timezone": "GMT",
    }
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:12]
    try:
        data = _get_json(params, Path(cache_dir) / f"sm_{start:%Y%m%d}_{end:%Y%m%d}_{key}.json")
    except (requests.RequestException, ValueError) as e:
        print(f"  soil moisture: request failed ({e}); {len(lat)} points × {len(dates)} dates left as NaN")
        return out
    if len(data) != len(uniq):
        print(f"  soil moisture: {len(data)} locations returned for {len(uniq)} requested; "
              f"{len(lat)} points × {len(dates)} dates left as NaN")
        return out
    days = (end - start).days + 1
    daily = np.full((len(uniq), days), np.nan)
    for c, loc in enumerate(data):
        v = np.array([np.nan if x is None else x for x in loc.get("hourly", {}).get(SOIL_VAR, [])], float)
        if len(v) == 24 * days:
            with np.errstate(all="ignore"):
                daily[c] = np.nanmean(v.reshape(days, 24), axis=1) if np.isfinite(v).any() else np.nan
    col = np.array([(d - start).days for d in dates])
    return daily[inv][:, col]


def antecedent_date(storm_start: date) -> date:
    return storm_start - timedelta(days=1)


# ---------------------------------------------------------------- saved models


def save_models(models: dict, path: Path = MODELS_PATH) -> Path:
    """models = {model_id: {"estimator": fitted sklearn estimator, "features": [...], ...}}.

    Every estimator (m1_refit included) takes feature_matrix(df, features) and imputes missing
    values itself (median of its training rows), so a NaN soil moisture is handled the same way as
    in training. Step 14 saves m1_refit, rf_extended and mlp_extended, fitted on every usable
    record. Each entry also carries n_train, flows_train, train_medians, spatial_k and
    context_distance_m (the quartiles of the training rows' mean distance to their spatial-context
    neighbours, to compare with the spacing on a segment map; no saved model uses the context).
    m1_refit carries "coefficients" {B, Ct, Cf, Cs}, in M1_15's shape, so
    m1_likelihood(T, F, S, i15, entry["coefficients"]) gives its likelihood; rf_* entries carry
    "monotonic_cst".
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(models, path)
    return path


def load_models(path: Path = MODELS_PATH) -> dict:
    return joblib.load(path)


def predict(entry: dict, df) -> np.ndarray:
    """Likelihood from one saved model entry for rows of df (columns named by its features)."""
    return entry["estimator"].predict_proba(feature_matrix(df, entry["features"]))[:, 1]
