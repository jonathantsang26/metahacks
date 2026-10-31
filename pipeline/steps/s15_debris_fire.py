"""Step 15: post-fire debris-flow likelihood on USGS's stream segments for one fire.

USGS published a postfire debris-flow hazard assessment for each fire (made with wildcat v1.1.0):
a stream-segment network with M1's inputs per segment (T, F, S) and USGS's own likelihoods and
combined hazard classes under its design storms, I15 = 16–40 mm/h. This step puts four
likelihood columns on those segments for every design storm:

  * usgs_p_<I>  USGS's own value, copied
  * m1_p_<I>    our M1 implementation (ember.debris.m1_likelihood, published coefficients) from
                USGS's T, F and S. It equals USGS's by construction; the largest difference is
                recorded as m1_check, an implementation check, not a validation
  * rf_p_<I>, mlp_p_<I>  step 14's rf_extended and mlp_extended. They also need what M1 does
                not: upstream area, spatial context (computed from neighbouring segments as in
                training) and, for one scenario date, days since fire and antecedent soil moisture

There are no observed debris-flow outcomes for the 2025 fires in the data used here, so the
models are compared with USGS's assessment (rank correlation and likelihood-class agreement at
I15 = 24 mm/h); that is agreement with USGS, not accuracy. The scenario date is a choice, made
by a stated rule on reanalysis precipitation (scenario_date).

Inputs:  the fire's USGS assessment (GeoJSON.zip, configuration.txt, median-thresholds.csv), in
         work/<fire>/debris_flow/: copied from DEBRIS_ASSESSMENT_DIR/<fire>/ where that has
         them, the rest downloaded from the ScienceBase item; work/debris_flow/models.joblib
         and the inventory copy (14); aoi.json; Open-Meteo ERA5 precipitation and ERA5-Land soil
         moisture (cached under work/<fire>/debris_flow/)
Outputs: debris_flow.geojson, debris_flow_stats.json (WORKSTREAMS.md §1), two manifest entries

Run: FIRE=eaton uv run python -m steps.s15_debris_fire
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import shutil
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests
from scipy.spatial import cKDTree
from scipy.stats import spearmanr
from shapely.geometry import LineString, shape

from ember import debris as db
from ember.config import load_fire
from ember.geo import meters_per_degree
from ember.manifest import add_source
from steps.s06_arrival import parse_t
from steps.s14_debris_models import INVENTORY, columns, load_inventory, usable

ASSESSMENTS = {  # ScienceBase items of the USGS PWFDF collection; titles as the items give them
    "eaton": {"item": "6838d149d4be025925747189", "title": "Eaton 2025-01-08 v1.0 postfire debris-flow hazard assessment"},
    "palisades": {"item": "6838d17ed4be02592574719a", "title": "Palisades 2025-01-07 v1.0 postfire debris-flow hazard assessment"},
}
DOI = "10.5066/P14EWYME"  # the PWFDF collection's DOI, which both items cite
LICENSE = "CC0 1.0 Universal (public domain)"
CITATION = ("King, J.M., Kostelnik, J., Kean, J.W., Barnhart, K.R., Graber, A.P., Rengers, F.K., and Thomas, M.A., 2025, "
            "Post-Wildfire Debris-Flow Hazard Assessment (PWFDF) Collection: U.S. Geological Survey data release, "
            f"https://doi.org/{DOI}")
SB_ITEM = "https://www.sciencebase.gov/catalog/item/"
FILES = ("GeoJSON.zip", "configuration.txt", "median-thresholds.csv")
LONLAT_CRS = {"urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:OGC::CRS84", "EPSG:4326", "urn:ogc:def:crs:EPSG::4326"}

DESIGN_I15 = (16, 20, 24, 28, 32, 36, 40)  # mm/h, USGS's design storms (checked against configuration.txt)
COMPARE_AT = 24
MODELS = (("rf", "rf_extended"), ("mlp", "mlp_extended"))  # map column prefix → step 14 model id
CLASS_LABELS = ("0-20%", "20-40%", "40-60%", "60-80%", "80-100%")

SIMPLIFY_DEG = 2e-5  # ~2 m, under USGS's 10 m flow paths: drops collinear vertices, keeps the shape
COORD_DP = 5         # as s09; 4 decimals collapses the shortest (8 m) segments to a point
DP = 4
DP_M1 = 8            # T, F, S and the M1 likelihoods: enough to repeat the M1 check from the file to 1e-6

PRECIP_MODEL = "era5"     # Open-Meteo archive, ECMWF ERA5 (0.25°), the reanalysis behind ERA5-Land
STORM_MM = 25.4           # a scenario storm day: at least 1 inch of precipitation
SEARCH_DAYS = 120         # look this far past ignition (the first winter)

TIE_M = 1e-6  # neighbours this close to the k-th one's distance tie with it (at a confluence they coincide)


# ---------------------------------------------------------------- USGS assessment


def fetch_assessment(fire) -> Path:
    """The assessment's files in work/<fire>/debris_flow/: each file in FILES that is not there yet is
    copied from a local copy (DEBRIS_ASSESSMENT_DIR/<fire>/) when that has it, else downloaded from
    the ScienceBase item. Only GeoJSON.zip is required; a failed download of the others is reported
    and the step goes on without them."""
    dest = fire.work_dir / "debris_flow"
    dest.mkdir(parents=True, exist_ok=True)
    local = os.environ.get("DEBRIS_ASSESSMENT_DIR")
    src = Path(local) / fire.id if local else None
    for name in FILES:
        if not (dest / name).exists() and src and (src / name).exists():
            shutil.copy(src / name, dest / name)
    missing = [name for name in FILES if not (dest / name).exists()]
    if missing:
        url = SB_ITEM + ASSESSMENTS[fire.id]["item"]
        try:
            item = requests.get(url, params={"format": "json"}, headers={"User-Agent": db.USER_AGENT}, timeout=60)
            item.raise_for_status()
            urls = {f["name"]: f["url"] for f in item.json().get("files", [])}
            for name in missing:
                if name not in urls:
                    print(f"  ScienceBase item lists no {name}")
                    continue
                r = requests.get(urls[name], headers={"User-Agent": db.USER_AGENT}, timeout=300)
                r.raise_for_status()
                (dest / f"{name}.part").write_bytes(r.content)
                (dest / f"{name}.part").replace(dest / name)
                print(f"  downloaded {name} from {url}")
        except requests.RequestException as e:
            print(f"  ScienceBase download failed ({e}); still missing: {[n for n in missing if not (dest / n).exists()]}")
    if not (dest / "GeoJSON.zip").exists():
        raise SystemExit(f"no GeoJSON.zip for {fire.id} in {SB_ITEM}{ASSESSMENTS[fire.id]['item']}")
    return dest


def read_layer(z: zipfile.ZipFile, name: str) -> dict:
    member = next((n for n in z.namelist() if n.rsplit("/", 1)[-1] == name), None)
    if member is None:
        raise SystemExit(f"GeoJSON.zip has no {name}")
    return json.loads(z.read(member))


def to_lonlat(layer: dict) -> tuple[list[dict], str]:
    """Features in lon/lat. GeoJSON from wildcat is CRS84; a projected one is transformed with rasterio."""
    crs = ((layer.get("crs") or {}).get("properties") or {}).get("name", "urn:ogc:def:crs:OGC:1.3:CRS84")
    feats = layer["features"]
    if crs not in LONLAT_CRS:
        from rasterio.warp import transform_geom  # pyproj is not a dependency here
        src = re.sub(r"^urn:ogc:def:crs:EPSG::(\d+)$", r"EPSG:\1", crs)
        feats = [{**f, "geometry": transform_geom(src, "EPSG:4326", f["geometry"])} for f in feats]
    return feats, crs


def design_storms(dest: Path) -> list[int]:
    """I15_mm_hr from configuration.txt, which must match DESIGN_I15."""
    path = dest / "configuration.txt"
    if not path.exists():
        return list(DESIGN_I15)
    m = re.search(r"^I15_mm_hr\s*=\s*\[([^\]]*)\]", path.read_text(), re.M)
    got = [int(float(v)) for v in m.group(1).split(",")] if m else []
    if got != list(DESIGN_I15):
        raise SystemExit(f"configuration.txt design storms {got} differ from {list(DESIGN_I15)}")
    return got


def wildcat_version(dest: Path) -> str | None:
    path = dest / "configuration.txt"
    m = re.search(r"wildcat v([\d.]+)", path.read_text()) if path.exists() else None
    return m.group(1) if m else None


def median_thresholds(dest: Path, props: list[dict]) -> tuple[dict, str]:
    """USGS's median rainfall thresholds over segments (mm/h): median-thresholds.csv's segment row
    when the file is there (checked against the segments' own medians), else those medians."""
    med = {k: float(np.median([p[k] for p in props])) for k in ("I15_50", "I15_75")}
    path = dest / "median-thresholds.csv"
    if not path.exists():
        return med, "median over the segments of USGS's I15_50 and I15_75 (USGS's median-thresholds.csv was not available)"
    rows = {r["Type"]: r for r in csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig")))}
    row = rows.get("Segments (mm)")
    if row is None:
        raise SystemExit("median-thresholds.csv has no 'Segments (mm)' row")
    csv_vals = {k: float(row[k]) for k in med}
    gap = max(abs(csv_vals[k] - med[k]) for k in med)
    same = "exactly" if gap == 0 else f"to within {gap:.1g} mm/h"
    return csv_vals, f"median-thresholds.csv, 'Segments (mm)' row (equal to the median over the segments of I15_50 and I15_75 {same})"


def outlet_check(feats: list[dict], area: np.ndarray) -> tuple[int, int]:
    """Wildcat traces segments downstream, so the last vertex is the outlet. Where a segment starts at
    another's last vertex, count how often it drains the larger area (it should, every time)."""
    key = lambda c: (round(c[0], 6), round(c[1], 6))
    starts = {key(f["geometry"]["coordinates"][0]): i for i, f in enumerate(feats)}
    pairs = [(i, starts[key(f["geometry"]["coordinates"][-1])]) for i, f in enumerate(feats)
             if key(f["geometry"]["coordinates"][-1]) in starts]
    return len(pairs), sum(area[j] > area[i] for i, j in pairs)


def basin_area_ratio(basins: list[dict], area_by_id: dict) -> float:
    """Median of (basin polygon area / segment Area): ~1 when Area is in km²."""
    ratios = []
    for f in basins:
        sid = f["properties"].get("SegmentID")
        if sid not in area_by_id or not area_by_id[sid]:
            continue
        g = shape(f["geometry"])
        m_lon, m_lat = meters_per_degree(g.centroid.y)
        ratios.append(g.area * m_lon * m_lat / 1e6 / area_by_id[sid])
    return float(np.median(ratios)) if ratios else float("nan")


# ---------------------------------------------------------------- scenario


def hours_in(d: date, tz: ZoneInfo) -> int:
    """Hours in local day d: 24, or 23/25 on a daylight-saving change."""
    a, b = (datetime.combine(x, time(), tz).astimezone(timezone.utc) for x in (d, d + timedelta(days=1)))
    return round((b - a).total_seconds() / 3600)


def scenario_date(fire, lon: float, lat: float, ignition: date) -> dict:
    """The first local day after ignition with at least STORM_MM of ERA5 precipitation at the fire
    center, with that day's peak hourly rate and the wettest earlier day (the threshold range that
    picks the same date). The hourly series is requested in GMT and each hour's accumulation (the
    hour ending at its time stamp) is summed into the fire's local calendar day (PST/PDT). With
    timezone=America/Los_Angeles, Open-Meteo applied one fixed offset to a whole January–May
    request (UTC−7). A day with a missing hour has no total."""
    tz = ZoneInfo(fire.timezone)
    end = ignition + timedelta(days=SEARCH_DAYS)
    params = {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "start_date": (ignition - timedelta(days=1)).isoformat(),
              "end_date": (end + timedelta(days=1)).isoformat(), "hourly": "precipitation",
              "models": PRECIP_MODEL, "timezone": "GMT"}
    loc = db._get_json(params, fire.work_dir / "debris_flow" / f"precip_{PRECIP_MODEL}_gmt_{ignition:%Y%m%d}_{end:%Y%m%d}.json")[0]
    if loc.get("utc_offset_seconds", 0) != 0:
        raise SystemExit(f"Open-Meteo returned utc_offset_seconds {loc['utc_offset_seconds']} for timezone=GMT")
    by_day: dict[date, list[float]] = {}
    for t, v in zip(loc["hourly"]["time"], loc["hourly"]["precipitation"]):
        start = datetime.fromisoformat(t).replace(tzinfo=timezone.utc) - timedelta(hours=1)
        by_day.setdefault(start.astimezone(tz).date(), []).append(np.nan if v is None else float(v))
    days = [ignition + timedelta(days=i) for i in range(1, SEARCH_DAYS + 1)]
    full = lambda d: len(by_day.get(d, [])) == hours_in(d, tz) and bool(np.isfinite(by_day[d]).all())
    mm = np.array([float(np.sum(by_day[d])) if full(d) else np.nan for d in days])
    hit = next((i for i in range(len(days)) if mm[i] >= STORM_MM), None)
    if hit is None:
        raise SystemExit(f"no day with ≥ {STORM_MM} mm within {SEARCH_DAYS} days of ignition ({PRECIP_MODEL} at {lat:.3f}, {lon:.3f})")
    earlier = [i for i in range(hit) if np.isfinite(mm[i])]
    wettest = max(earlier, key=lambda i: mm[i]) if earlier else None
    return {"date": days[hit], "mm": float(mm[hit]), "peak_mm_h": float(np.max(by_day[days[hit]])),
            "grid": (float(loc["latitude"]), float(loc["longitude"])),
            "wettest_before": (days[wettest], float(mm[wettest])) if wettest is not None else None,
            "missing_days": int(np.isnan(mm).sum())}


def context_ties(rows: dict, k: int) -> tuple[np.ndarray, dict]:
    """Where db.spatial_context's k-th neighbour ties with the next one (usually segments ending at one
    point, such as two tributaries at a confluence), cKDTree keeps one of them by its own internal
    order, in training as here. For
    rows of one fire and storm, the rows with such a tie and their ctx_* columns with the other
    tied neighbours swapped in; the geometry is spatial_context's, so untied rows come out the same."""
    lat, lon = np.asarray(rows["lat"], float), np.asarray(rows["lon"], float)
    m_lon, m_lat = meters_per_degree(float(lat.mean()))
    xy = np.column_stack([lon * m_lon, lat * m_lat])
    vals = db.feature_matrix(rows, db.CONTEXT_OF)
    tree = cKDTree(xy)
    d, nb = tree.query(xy, k=k + 1)
    alt, tied = np.empty_like(vals), np.zeros(len(xy), bool)
    for i in range(len(xy)):
        keep = nb[i] != i
        chosen, dk = nb[i][keep][:k], d[i][keep][:k][-1]
        near = np.array([j for j in tree.query_ball_point(xy[i], dk + TIE_M) if j != i])
        dist = np.hypot(*(xy[near] - xy[i]).T)
        at_k = near[np.abs(dist - dk) <= TIE_M]
        swap_in = at_k[~np.isin(at_k, chosen)]
        tied[i] = len(swap_in) > 0
        pick = np.concatenate([near[dist < dk - TIE_M], swap_in, at_k[np.isin(at_k, chosen)]])[:k]
        alt[i] = vals[pick].mean(axis=0)
    return tied, {f"ctx_{c}": alt[:, j] for j, c in enumerate(db.CONTEXT_OF)}


# ---------------------------------------------------------------- output


def r(x, dp: int = DP):
    """Rounded float; None for NaN (bare NaN is not JSON)."""
    x = float(x)
    return None if not math.isfinite(x) else round(x, dp) + 0.0


def line(coords) -> list[list[float]]:
    out: list[list[float]] = []
    for x, y in LineString(coords).simplify(SIMPLIFY_DEG).coords:
        pt = [round(x, COORD_DP), round(y, COORD_DP)]
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def classes(p: np.ndarray) -> np.ndarray:
    """0–20 … 80–100%: floor(p × 5), p = 1 in the top class (as the web's classOf)."""
    return np.clip(np.floor(np.asarray(p, float) * 5), 0, 4).astype(int)


def agreement(p: np.ndarray, ref: np.ndarray) -> dict:
    return {"spearman_vs_usgs_24": r(spearmanr(p, ref).statistic), "class_agreement_24": r(np.mean(classes(p) == classes(ref)))}


def class_counts(p: np.ndarray) -> dict:
    c = np.bincount(classes(p), minlength=5)
    return {label: int(n) for label, n in zip(CLASS_LABELS, c)}


# ---------------------------------------------------------------- main


def main() -> None:
    fire = load_fire()
    if fire.id not in ASSESSMENTS:
        raise SystemExit(f"no USGS debris-flow assessment configured for {fire.id}")
    if not db.MODELS_PATH.exists():
        raise SystemExit(f"{db.MODELS_PATH} is missing: run steps.s14_debris_models first")
    meta = ASSESSMENTS[fire.id]
    aoi = fire.read_json("aoi.json")
    dest = fetch_assessment(fire)
    i15s = design_storms(dest)
    with zipfile.ZipFile(dest / "GeoJSON.zip") as z:
        feats, crs = to_lonlat(read_layer(z, "segments.geojson"))
        basins, _ = to_lonlat(read_layer(z, "basins.geojson"))
    feats = [f for f in feats if f["geometry"]["type"] == "LineString"]
    props = [f["properties"] for f in feats]
    need = {"SegmentID", "Area", "Terrain_M1", "Fire_M1", "Soil_M1", "H_24", "I15_50", "I15_75"} | {f"P_{i}" for i in i15s}
    bad = [p.get("SegmentID") for p in props if any(p.get(key) is None for key in need)]
    if not props or bad:
        raise SystemExit(f"segments.geojson: {len(props)} segments, {len(bad)} missing one of {sorted(need)}")
    n = len(feats)
    ids = np.array([p["SegmentID"] for p in props])
    area = np.array([p["Area"] for p in props], float)
    T, F, S = (np.array([p[k] for p in props], float) for k in ("Terrain_M1", "Fire_M1", "Soil_M1"))
    usgs = {i: np.array([p[f"P_{i}"] for p in props], float) for i in i15s}
    lon_o = np.array([f["geometry"]["coordinates"][-1][0] for f in feats], float)
    lat_o = np.array([f["geometry"]["coordinates"][-1][1] for f in feats], float)
    bx = aoi["bbox"]
    if not (bx[0] <= np.median(lon_o) <= bx[2] and bx[1] <= np.median(lat_o) <= bx[3]):
        raise SystemExit(f"segments ({crs}) do not land in the AOI after conversion to lon/lat")
    n_pairs, n_down = outlet_check(feats, area)
    ratio = basin_area_ratio(basins, dict(zip(ids.tolist(), area.tolist())))
    if not 0.9 < ratio < 1.1:
        raise SystemExit(f"basin polygon area / segment Area = {ratio:.3f}: Area is not in km²")
    print(f"{n} segments ({crs}); {n_down}/{n_pairs} downstream pairs drain more area; basin/Area ratio {ratio:.4f}")

    # M1 implementation check against USGS's own likelihoods, at full precision.
    m1 = {i: db.m1_likelihood(T, F, S, i) for i in i15s}
    max_diff = max(float(np.max(np.abs(m1[i] - usgs[i]))) for i in i15s)
    if max_diff > 1e-9:
        raise SystemExit(f"M1 differs from USGS's P_<I> by up to {max_diff:.3g}: check units (R = I15 × 0.25 h)")
    print(f"M1 vs USGS P_<I>: max |diff| = {max_diff:.3g} over {n} segments × {len(i15s)} storms")
    lg = [p.get(f"P_{COMPARE_AT}_LG") for p in props]
    lg_same = sum(CLASS_LABELS[c] == (v or "") for c, v in zip(classes(usgs[COMPARE_AT]), lg))

    # Scenario for the ML columns.
    start = parse_t(aoi["official"]["incident"]["start_utc"])
    ignition = start.astimezone(ZoneInfo(fire.timezone)).date()
    c_lon, c_lat = aoi["center"]
    sc = scenario_date(fire, c_lon, c_lat, ignition)
    days_since = (sc["date"] - ignition).days
    ante = db.antecedent_date(sc["date"])
    sm = float(db.fetch_soil_moisture([c_lat], [c_lon], [ante], cache_dir=fire.work_dir / "debris_flow" / "soil_moisture")[0, 0])
    print(f"scenario {sc['date']} ({sc['mm']:.1f} mm, peak {sc['peak_mm_h']:.1f} mm/h), {days_since} days after ignition "
          f"{ignition}, soil moisture {sm:.4f} on {ante}")

    # Features: one row per segment and design storm, spatial context within each storm as in training.
    models = db.load_models()
    k = int(models["rf_extended"].get("spatial_k", db.SPATIAL_K))
    reps = len(i15s)
    rows = {
        "fire": np.full(n * reps, fire.id), "storm": np.repeat(np.array(i15s), n),
        "lat": np.tile(lat_o, reps), "lon": np.tile(lon_o, reps),
        "T": np.tile(T, reps), "F": np.tile(F, reps), "S": np.tile(S, reps),
        "R15": db.r15_mm(np.repeat(np.array(i15s, float), n)),
        "log_area_km2": np.tile(np.log10(area), reps),
        "days_since_fire": np.full(n * reps, float(days_since)),
        "soil_moisture_0_7cm": np.full(n * reps, sm),
    }
    ctx = db.spatial_context(rows, k)
    rows.update({c: v for c, v in ctx.items() if c not in ("ctx_n", "ctx_dist_m")})
    ctx_q = np.nanpercentile(ctx["ctx_dist_m"][:n], [25, 50, 75])
    pred = {col: db.predict(models[mid], rows).reshape(reps, n) for col, mid in MODELS}
    pred = {col: {i: pred[col][j] for j, i in enumerate(i15s)} for col in pred}
    refit = db.predict(models["m1_refit"], rows).reshape(reps, n)[i15s.index(COMPARE_AT)]

    # Ties at the k-th neighbour: the same features with the other tied neighbours, at I15 = 24.
    at24 = slice(i15s.index(COMPARE_AT) * n, (i15s.index(COMPARE_AT) + 1) * n)
    rows24 = {c: v[at24] for c, v in rows.items()}
    tied, alt_ctx = context_ties(rows24, k)
    gap = max(float(np.max(np.abs(alt_ctx[c][~tied] - rows24[c][~tied]), initial=0)) for c in alt_ctx)
    if gap > 1e-9:
        raise SystemExit(f"context_ties differs from db.spatial_context by {gap:.3g} on untied segments")
    swapped = {**rows24, **alt_ctx}
    tie_dp = {col: np.abs(db.predict(models[mid], swapped) - db.predict(models[mid], rows24)) for col, mid in MODELS}
    tie_alt = {col: np.array([r(v) for v in db.predict(models[mid], swapped)]) for col, mid in MODELS}

    # GeoJSON: M1 inputs and likelihoods at DP_M1, the rest at DP.
    out_feats = []
    for j, f in enumerate(feats):
        p = props[j]
        pr = {"id": int(p["SegmentID"]), "area_km2": r(area[j]), "T": r(T[j], DP_M1), "F": r(F[j], DP_M1), "S": r(S[j], DP_M1),
              "usgs_hazard_24": int(p["H_24"])}
        pr.update({f"usgs_p_{i}": r(usgs[i][j], DP_M1) for i in i15s})
        pr.update({f"m1_p_{i}": r(m1[i][j], DP_M1) for i in i15s})
        for col in pred:
            pr.update({f"{col}_p_{i}": r(pred[col][i][j]) for i in i15s})
        out_feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line(f["geometry"]["coordinates"])},
                          "properties": pr})
    text = json.dumps({"type": "FeatureCollection", "features": out_feats}, separators=(",", ":"), allow_nan=False)
    (fire.out_dir / "debris_flow.geojson").write_text(text + "\n")

    # Agreement with USGS at I15 = 24, on the values as written.
    col = lambda key: np.array([f["properties"][f"{key}_p_{COMPARE_AT}"] for f in out_feats], float)
    ref = col("usgs")
    written = {key: col(key) for key in ("usgs", "m1", *pred)}
    agree = {key: agreement(written[key], ref) for key in ("m1", *pred)}
    counts = {key: class_counts(v) for key, v in written.items()}
    thresholds, th_source = median_thresholds(dest, props)
    refit_rho = float(spearmanr(refit, ref).statistic)
    tie_agree = {key: agreement(v, ref) for key, v in tie_alt.items()}
    # M1 rises with rainfall by its form; the trained models are not constrained to (counted as written).
    by_storm = lambda key: np.array([[f["properties"][f"{key}_p_{i}"] for f in out_feats] for i in i15s], float)
    falls = {key: int((np.diff(by_storm(key), axis=0) < 0).any(axis=0).sum()) for key in pred}

    # Training ranges, for the notes.
    inv = columns(usable(load_inventory())[0])
    train_days = inv["days_since_fire"]
    med = models["rf_extended"]["train_medians"]
    tq = models["rf_extended"]["context_distance_m"]
    wb = sc["wettest_before"]
    mean24 = ", ".join(f"{key} {written[key].mean():.3f}" for key in written)
    notes = [
        "These are predictions compared with USGS's assessment, not validated. The data used here hold no observed debris-flow "
        f"outcomes for the 2025 fires (USGS's inventory, {INVENTORY['doi']}, ends with 2024 fires), so agreement with USGS says how "
        "alike two models are on this fire, not which is closer to what happens.",
        f"m1_check is an implementation check, not a validation: our M1 (Staley et al. 2017, published 15-minute coefficients, "
        f"R = I15 × 0.25 h) recomputed from USGS's T, F and S matches USGS's likelihoods for all {n:,} segments and "
        f"{len(i15s)} design storms to within {max_diff:.1g}. m1_p_* therefore equals usgs_p_* by construction.",
        f"The scenario is a choice. Only RF and MLP use it (days since fire and antecedent soil moisture); M1 and USGS's columns do "
        f"not. Rule: the first local day after ignition with at least {STORM_MM} mm (1 inch) of precipitation at the AOI center in "
        f"ECMWF ERA5 (Open-Meteo archive, models={PRECIP_MODEL}, grid point {sc['grid'][0]:.2f}, {sc['grid'][1]:.2f}; hourly "
        f"accumulations, each for the hour ending at its GMT time stamp, summed into {fire.timezone} calendar days): "
        f"{sc['date']}, with {sc['mm']:.1f} mm (peak hourly {sc['peak_mm_h']:.1f} mm/h). "
        + (f"The wettest earlier day was {wb[0]} with {wb[1]:.1f} mm, so any threshold above {wb[1]:.1f} mm and up to "
           f"{sc['mm']:.1f} mm picks the same day. " if wb else "No earlier day had precipitation. ")
        + f"{SEARCH_DAYS} days searched, {sc['missing_days']} with no value. A 0.25° hourly reanalysis only picks the date; it is "
        "not a 15-minute intensity, and the design storms set I15 instead.",
        f"days_since_fire = {days_since}: from the CAL FIRE start ({aoi['official']['incident']['start_utc']}, local date {ignition}) to "
        f"{sc['date']}, in calendar days like the inventory's StormStart − FireIgnitionDate. That is early in recovery compared with "
        f"training: the usable inventory records have a median of {np.median(train_days):.0f} days, and "
        f"{np.mean(train_days <= days_since):.1%} of them are within {days_since} days.",
        f"Antecedent soil moisture (0–7 cm) on {ante}, the UTC day before the scenario date: "
        + (f"{sm:.4f} m³/m³ at the AOI center's ERA5-Land cell (training median {med['soil_moisture_0_7cm']:.4f}). "
           if math.isfinite(sm) else f"not available, so the models impute the training median {med['soil_moisture_0_7cm']:.4f}. ")
        + "It is one value for every segment, as is days since fire, so both set the level of the RF and MLP maps, not the "
        "ranking of segments; in training they varied between storms.",
        f"Spatial context: mean T, F, S and R15 of the {k} nearest other segments (by downstream end) in this fire and design storm, "
        f"from their features only, as in training. On this network the mean distance to those neighbours has median "
        f"{ctx_q[1]:,.0f} m (IQR {ctx_q[0]:,.0f}–{ctx_q[2]:,.0f} m), against {tq['median']:,.0f} m "
        f"(IQR {tq['q25']:,.0f}–{tq['q75']:,.0f} m) in training, and the neighbours include segments upstream and downstream on the "
        "same channel, whose watersheds nest. Under a design storm every segment has the same R15, so ctx_R15 = R15.",
        f"Ties in spatial context: where the {k}th and {k + 1}th nearest downstream ends are equally far (usually segments that "
        "end at the same point, such as two tributaries at a confluence), scipy's cKDTree keeps one of them by its internal "
        "order, in training as here; either is an "
        f"equally valid choice, and rf_p_* and mlp_p_* use cKDTree's. {int(tied.sum()):,} of {n:,} segments have such a tie. "
        "Taking the other tied segment instead changes the likelihood at 24 mm/h by up to "
        + " and ".join(f"{tie_dp[col].max():.3f} for {col} ({int((tie_dp[col] > 0.05).sum()):,} segments by more than 0.05)"
                       for col in tie_dp)
        + "; Spearman vs USGS would be "
        + ", ".join(f"{col} {tie_agree[col]['spearman_vs_usgs_24']:.4f} (as written {agree[col]['spearman_vs_usgs_24']:.4f})"
                    for col in tie_agree)
        + " and class agreement "
        + ", ".join(f"{col} {tie_agree[col]['class_agreement_24']:.4f} ({agree[col]['class_agreement_24']:.4f})"
                    for col in tie_agree)
        + ". So a single segment's RF or MLP value can depend on this choice by that much.",
        "T, F and S are USGS's values from its assessment inputs (its dNBR and burn-severity rasters, terrain and soil KF-factor), "
        "not computed from this project's AVIRIS-3 dNBR layer. area_km2 is USGS's Area (km²: the basin polygons' areas match it, "
        f"median ratio {ratio:.4f}). usgs_hazard_24 is USGS's combined hazard class at 24 mm/h (likelihood and volume together; "
        "1 low, 2 moderate, 3 high), copied as it is.",
        f"Likelihood classes are floor(p × 5) (0–20% … 80–100%); on USGS's likelihoods at 24 mm/h they reproduce USGS's own "
        f"P_24_LG labels for {lg_same:,} of {n:,} segments. Agreement and class counts use the values as written to "
        "debris_flow.geojson.",
        f"Mean likelihood at 24 mm/h: {mean24}. For comparison, step 14's m1_refit (M1's form refitted on the inventory) ranks "
        f"segments with Spearman {refit_rho:.3f} against USGS here; it is not a map column.",
        "M1's likelihood rises with I15 by its form; RF and MLP are not constrained to. Segments whose likelihood falls somewhere "
        "between consecutive design storms, on the values as written: "
        + ", ".join(f"{col} {falls[col]:,} of {n:,}" for col in falls) + ".",
        f"USGS's median thresholds: {th_source}.",
        f"Geometry: USGS's segments in lon/lat ({crs}), simplified at {SIMPLIFY_DEG:g}° (~2 m) and rounded to {COORD_DP} decimals. "
        f"T, F, S, usgs_p_* and m1_p_* keep {DP_M1} decimals so the M1 check can be repeated from this file; other values "
        f"{DP}. The downstream end is a segment's last vertex: in all {n_pairs:,} pairs where one segment starts at another's end, "
        f"the downstream one drains more area ({n_down:,} of {n_pairs:,}).",
    ]
    stats = {
        "source": {"title": f"USGS {meta['title']}", "doi": DOI, "url": SB_ITEM + meta["item"], "license": LICENSE},
        "design_i15_mm_h": list(i15s),
        "scenario": {"date": sc["date"].isoformat(), "days_since_fire": days_since,
                     "soil_moisture_0_7cm": r(sm),
                     "soil_moisture_source": f"{db.SOIL_MOISTURE_SOURCE}, at the AOI center ({c_lat:.4f}, {c_lon:.4f})"},
        "segments": n,
        "m1_check": {"max_abs_diff_vs_usgs": max_diff},
        "agreement": agree,
        "likelihood_class_counts_24": counts,
        "usgs_median_thresholds_mm_h": {key: r(v) for key, v in thresholds.items()},
        "notes": notes,
    }
    (fire.out_dir / "debris_flow_stats.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False, allow_nan=False) + "\n")

    version = wildcat_version(dest)
    add_source(fire, layer="Debris-flow segments (USGS)", source=f"USGS {meta['title']} (PWFDF collection)",
               url=SB_ITEM + meta["item"], status="MODELED", attribution=f"{CITATION}. {LICENSE}.",
               notes=f"{n:,} stream segments with M1's inputs (T, F, S) and USGS's M1 likelihoods and combined hazard classes at "
                     f"design storms I15 = {i15s[0]}–{i15s[-1]} mm/h" + (f", made with wildcat v{version}" if version else "")
                     + ". A model output, not observations. T and F come from the dNBR and burn severity in USGS's assessment "
                     "inputs, not this project's AVIRIS-3 dNBR layer.")
    add_source(fire, layer="Debris-flow models (this project)",
               source="Sentinel Ember: M1 reimplementation, random forest and MLP trained on USGS's postfire debris-flow inventory",
               url=INVENTORY["url"], status="MODELED",
               attribution=f"{INVENTORY['title']}, doi:{INVENTORY['doi']} (CC0); ERA5 and ERA5-Land via Open-Meteo.com (CC BY 4.0)",
               notes=f"Applied to USGS's {n:,} segments. M1 reproduces USGS to {max_diff:.1g} (implementation check). RF and MLP "
                     f"use a scenario of {sc['date']} ({days_since} days after ignition); Spearman vs USGS at 24 mm/h: "
                     + ", ".join(f"{key} {a['spearman_vs_usgs_24']:.3f}" for key, a in agree.items() if key != "m1")
                     + ". Compared with USGS's assessment, not validated: no observed 2025 outcomes.")
    print(f"wrote debris_flow.geojson ({len(text) / 1e6:.2f} MB) and debris_flow_stats.json")
    for key, a in agree.items():
        print(f"  {key:<4} Spearman {a['spearman_vs_usgs_24']:.4f}  same class {a['class_agreement_24']:.4f}  classes {counts[key]}")
    print(f"  usgs classes {counts['usgs']}; m1_refit Spearman {refit_rho:.4f}; context distance median {ctx_q[1]:.0f} m")
    print(f"  context ties: {int(tied.sum())} of {n} segments; other choice: "
          + ", ".join(f"{col} max |dp| {tie_dp[col].max():.3f} ({int((tie_dp[col] > 0.05).sum())} > 0.05), "
                      f"Spearman {tie_agree[col]['spearman_vs_usgs_24']:.4f}, same class {tie_agree[col]['class_agreement_24']:.4f}"
                      for col in tie_dp))


if __name__ == "__main__":
    main()
