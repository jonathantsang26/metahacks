"""Step 15: post-fire debris-flow likelihood on USGS's stream segments for one fire.

USGS published a postfire debris-flow hazard assessment for each fire (made with wildcat v1.1.0):
a stream-segment network with M1's inputs per segment (T, F, S) and USGS's own likelihoods and
combined hazard classes under its design storms, I15 = 16–40 mm/h. This step puts three
likelihood columns on those segments for every design storm:

  * usgs_p_<I>  USGS's own value (M1 with Staley et al. 2017's published coefficients), copied
  * m1_p_<I>    M1 recalibrated: step 14's m1_refit, M1's three-interaction logistic form refitted
                on every usable inventory record, from USGS's T, F and S. Its coefficients go to
                debris_flow_stats.json m1_recalibrated
  * rf_p_<I>    step 14's rf_extended, a random forest constrained to be non-decreasing in
                rainfall. It also needs what M1 does not: upstream area and, for one scenario
                date, days since fire and antecedent soil moisture

No map column uses spatial context, and the MLPs are scored in step 14 but not mapped: nothing
constrains them to rise with rainfall. m1_check recomputes USGS's column with our M1 code and
the published coefficients: an implementation check, not a validation and not a result.

There are no observed debris-flow outcomes for the 2025 fires in the data used here, so the
models are compared with USGS's assessment (rank correlation and likelihood-class agreement under
every design storm); that is agreement with USGS, not accuracy. The scenario date is a choice,
made by a stated rule on reanalysis precipitation (scenario_date).

Inputs:  the fire's USGS assessment (GeoJSON.zip, configuration.txt, median-thresholds.csv), in
         work/<fire>/debris_flow/: copied from DEBRIS_ASSESSMENT_DIR/<fire>/ where that has
         them, the rest downloaded from the ScienceBase item; work/debris_flow/models.joblib,
         the inventory copy and model_eval.json (14); aoi.json; Open-Meteo ERA5 precipitation and
         ERA5-Land soil moisture (cached under work/<fire>/debris_flow/)
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
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests
from scipy.stats import spearmanr
from shapely.geometry import LineString, shape

from ember import debris as db
from ember.config import load_fire
from ember.geo import meters_per_degree
from ember.manifest import add_source
from steps.s06_arrival import parse_t
from steps.s14_debris_models import (INVENTORY, MISSING, OUT_PATH as MODEL_EVAL, SCENARIO_DAYS, columns, load_inventory,
                                     usable, ymd)

ASSESSMENTS = {  # ScienceBase items of the USGS PWFDF collection; titles as the items give them
    "eaton": {"item": "6838d149d4be025925747189", "title": "Eaton 2025-01-08 v1.0 postfire debris-flow hazard assessment"},
    "palisades": {"item": "6838d17ed4be02592574719a", "title": "Palisades 2025-01-07 v1.0 postfire debris-flow hazard assessment"},
}
DOI = "10.5066/P14EWYME"  # the PWFDF collection's DOI, which both items cite
LICENSE = "CC0 1.0 Universal (public domain)"
CITATION = ("King, J.M., Kostelnik, J., Kean, J.W., Barnhart, K.R., Graber, A.P., Rengers, F.K., and Thomas, M.A., 2026, "
            "Post-Wildfire Debris-Flow Hazard Assessment (PWFDF) Collection: U.S. Geological Survey data release, "
            f"https://doi.org/{DOI}")  # as the inventory's README cites it
SB_ITEM = "https://www.sciencebase.gov/catalog/item/"
FILES = ("GeoJSON.zip", "configuration.txt", "median-thresholds.csv")
LONLAT_CRS = {"urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:OGC::CRS84", "EPSG:4326", "urn:ogc:def:crs:EPSG::4326"}

# The inventory fire that stands in for this one, or none; both are checked against the inventory.
# "box" (lon/lat, west south east north) holds the inventory fires of that range, by the median of
# their observation points.
ANALOGUES = {
    "eaton": {"fire": ("Station", 2009), "where": "San Gabriel front"},
    "palisades": {"fire": None, "where": "Santa Monica Mountains", "box": (-119.10, 33.95, -118.35, 34.20)},
}

DESIGN_I15 = db.DESIGN_I15  # mm/h, USGS's design storms (checked against configuration.txt)
COMPARE_AT = 24
MAP_MODELS = ("usgs", "m1", "rf")  # the map's column prefixes
M1_MODEL = "m1_refit"  # step 14 model id behind m1_p_* (M1 recalibrated)
ML_MODELS = (("rf", "rf_extended"),)  # map column prefix → step 14 model id, for the scenario-driven columns
CLASS_LABELS = ("0-20%", "20-40%", "40-60%", "60-80%", "80-100%")

SIMPLIFY_DEG = 2e-5  # ~2 m, under USGS's 10 m flow paths: drops collinear vertices, keeps the shape
COORD_DP = 5         # as s09; 4 decimals collapses the shortest (8 m) segments to a point
DP = 4
DP_M1 = 8            # T, F, S and the M1 likelihoods: enough to repeat both M1 columns from the file to 1e-6

PRECIP_MODEL = "era5"     # Open-Meteo archive, ECMWF ERA5 (0.25°), the reanalysis behind ERA5-Land
STORM_MM = 25.4           # a scenario storm day: at least 1 inch of precipitation
SEARCH_DAYS = 120         # look this far past ignition (the first winter)


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


# ---------------------------------------------------------------- inventory context


def inventory_fires(rows: list[dict], kept: list[dict], lon0: float, lat0: float) -> dict:
    """Per inventory fire (name, year), from every record: records, debris flows, usable records and
    flows (step 14's filters), the median observation point and its distance from (lon0, lat0), km."""
    fires: dict[tuple[str, int], dict] = {}
    for rec in rows:
        f = fires.setdefault((rec["FireName"], int(rec["FireYear"])), {"records": 0, "flows": 0, "usable": 0, "usable_flows": 0,
                                                                       "lat": [], "lon": []})
        f["records"] += 1
        f["flows"] += rec["Response"] == "1"
        if MISSING not in (rec["ObservationLatitude"], rec["ObservationLongitude"]):
            f["lat"].append(float(rec["ObservationLatitude"]))
            f["lon"].append(float(rec["ObservationLongitude"]))
    for rec in kept:
        f = fires[(rec["FireName"], int(rec["FireYear"]))]
        f["usable"] += 1
        f["usable_flows"] += rec["Response"] == "1"
    m_lon, m_lat = meters_per_degree(lat0)
    for f in fires.values():
        f["lat"] = float(np.median(f["lat"])) if f["lat"] else math.nan
        f["lon"] = float(np.median(f["lon"])) if f["lon"] else math.nan
        f["km"] = float(np.hypot((f["lon"] - lon0) * m_lon, (f["lat"] - lat0) * m_lat) / 1000)
    return fires


def analogue(fire_id: str, fires: dict, model_eval: dict) -> dict:
    """{fire, note}: ANALOGUES[fire_id] checked against the inventory. A named analogue must have
    recorded debris flows and be the fire step 14 scores as its held-out analogue; with none, every
    inventory fire in the range's box must have no recorded debris flow."""
    cfg = ANALOGUES[fire_id]
    scored = {m["id"]: m["analogue"] for m in model_eval["models"] if m.get("analogue")}
    held = {(a["fire"], int(a["year"])) for a in scored.values()}
    if len(held) != 1:
        raise SystemExit(f"model_eval.json names {len(held)} analogue fires, expected one")
    held_key = held.pop()
    with_flows = sorted((f["km"], k) for k, f in fires.items() if f["flows"] and math.isfinite(f["km"]))
    if cfg["fire"]:
        key = cfg["fire"]
        a = fires.get(key)
        if a is None or not a["usable_flows"]:
            raise SystemExit(f"analogue {key} has no usable debris-flow records in the inventory")
        if key != held_key:
            raise SystemExit(f"analogue {key} is not the fire model_eval.json holds out ({held_key})")
        nearest = " (the inventory's nearest fire with a recorded debris flow)" if with_flows and with_flows[0][1] == key else ""
        on_map = {m["id"] for m in model_eval["models"] if m.get("on_map")}
        aucs = ", ".join(f"{mid} {scored[mid]['roc_auc']:.3f}" for mid in sorted(on_map) if mid in scored)
        note = (f"The {key[0]} Fire ({key[1]}, {cfg['where']}), {a['km']:.0f} km from this fire's AOI center by the median of its "
                f"observation points{nearest}: {a['usable']:,} usable inventory records, {a['usable_flows']:,} of them debris flows. "
                f"Step 14 holds it out as its own fold, so its scores in model_eval.json are on unseen records (ROC AUC of the "
                f"map's models: {aucs}). They score a past fire nearby, not this one. M1's form and its T variable were designed on "
                f"the Staley et al. (2016) inventory, which holds every {key[0]} record, so this comparison may favour M1 recalibrated.")
        return {"fire": key[0], "note": note}
    w, s, e, n = cfg["box"]
    inside = sorted((f["km"], k) for k, f in fires.items() if w <= f["lon"] <= e and s <= f["lat"] <= n)
    if not inside:
        raise SystemExit(f"no inventory fire in the {cfg['where']} box {cfg['box']}")
    if any(fires[k]["flows"] for _, k in inside):
        raise SystemExit(f"an inventory fire in the {cfg['where']} has recorded debris flows: set its analogue")
    listed = "; ".join(f"{k[0]} ({k[1]}): {fires[k]['records']:,} records, {fires[k]['usable']:,} usable, {km:.0f} km from this "
                       f"fire's AOI center" for km, k in inside)
    near_km, near = with_flows[0]
    held_where = next((c["where"] for c in ANALOGUES.values() if c["fire"] == held_key), None)
    note = (f"None. The inventory's fires in the {cfg['where']} ({listed}; by the median of their observation points, inside "
            f"lon {w:.2f} to {e:.2f}, lat {s:.2f} to {n:.2f}) have no recorded debris flow, so none can stand in for this fire. The nearest inventory "
            f"fire with one is {near[0]} ({near[1]}), {near_km:.0f} km away ({fires[near]['flows']:,} of {fires[near]['records']:,} "
            f"records). Step 14's held-out analogue, the {held_key[0]} Fire ({held_key[1]}"
            + (f", {held_where}" if held_where else "")
            + f"), is {fires[held_key]['km']:.0f} km away and is not an analogue for this fire.")
    return {"fire": None, "note": note}


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
    return {"spearman_vs_usgs": r(spearmanr(p, ref).statistic), "class_agreement": r(np.mean(classes(p) == classes(ref)))}


def class_counts(p: np.ndarray) -> dict:
    c = np.bincount(classes(p), minlength=5)
    return {label: int(n) for label, n in zip(CLASS_LABELS, c)}


def falls(by_storm: np.ndarray) -> tuple[int, float]:
    """(segments whose likelihood falls between some pair of consecutive storms, largest fall);
    by_storm is (storms, segments) in rising I15."""
    d = np.diff(by_storm, axis=0)
    return int((d < 0).any(axis=0).sum()), float(max(0.0, -d.min()))


def span(values) -> str:
    lo, hi = min(values), max(values)
    return f"{lo:.3f}" if lo == hi else f"{lo:.3f}–{hi:.3f}"


# ---------------------------------------------------------------- main


def main() -> None:
    fire = load_fire()
    if fire.id not in ASSESSMENTS:
        raise SystemExit(f"no USGS debris-flow assessment configured for {fire.id}")
    for path, why in ((db.MODELS_PATH, "models"), (MODEL_EVAL, "model_eval.json")):
        if not path.exists():
            raise SystemExit(f"{path} ({why}) is missing: run steps.s14_debris_models first")
    # The models step 14 marks on_map must be the ones mapped here (the analogue note quotes their scores).
    model_eval = json.loads(MODEL_EVAL.read_text())
    on_map = {m["id"] for m in model_eval["models"] if m.get("on_map")}
    mapped = {M1_MODEL} | {mid for _, mid in ML_MODELS}
    if on_map != mapped:
        raise SystemExit(f"model_eval.json marks {sorted(on_map)} on_map; this step maps {sorted(mapped)}")
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

    # Implementation check: our M1 code with the published coefficients against USGS's own likelihoods.
    max_diff = max(float(np.max(np.abs(db.m1_likelihood(T, F, S, i) - usgs[i]))) for i in i15s)
    if max_diff > 1e-9:
        raise SystemExit(f"M1 differs from USGS's P_<I> by up to {max_diff:.3g}: check units (R = I15 × 0.25 h)")
    print(f"m1_check (published coefficients) vs USGS P_<I>: max |diff| = {max_diff:.3g} over {n} segments × {len(i15s)} storms")
    lg = [p.get(f"P_{COMPARE_AT}_LG") for p in props]
    lg_same = sum(CLASS_LABELS[c] == (v or "") for c, v in zip(classes(usgs[COMPARE_AT]), lg))

    # Scenario for the RF column.
    start = parse_t(aoi["official"]["incident"]["start_utc"])
    ignition = start.astimezone(ZoneInfo(fire.timezone)).date()
    c_lon, c_lat = aoi["center"]
    sc = scenario_date(fire, c_lon, c_lat, ignition)
    days_since = (sc["date"] - ignition).days
    if days_since != SCENARIO_DAYS:  # step 14's days-since-fire note describes this scenario
        raise SystemExit(f"the scenario is {days_since} days after ignition; step 14's SCENARIO_DAYS is {SCENARIO_DAYS}: "
                         "update it and rerun steps.s14_debris_models")
    ante = db.antecedent_date(sc["date"])
    sm = float(db.fetch_soil_moisture([c_lat], [c_lon], [ante], cache_dir=fire.work_dir / "debris_flow" / "soil_moisture")[0, 0])
    print(f"scenario {sc['date']} ({sc['mm']:.1f} mm, peak {sc['peak_mm_h']:.1f} mm/h), {days_since} days after ignition "
          f"{ignition}, soil moisture {sm:.4f} on {ante}")

    # Features: one row per segment and design storm. No spatial context: no map model uses it.
    models = db.load_models()
    reps = len(i15s)
    rows = {
        "T": np.tile(T, reps), "F": np.tile(F, reps), "S": np.tile(S, reps),
        "R15": db.r15_mm(np.repeat(np.array(i15s, float), n)),
        "log_area_km2": np.tile(np.log10(area), reps),
        "days_since_fire": np.full(n * reps, float(days_since)),
        "soil_moisture_0_7cm": np.full(n * reps, sm),
    }
    per_storm = lambda v: {i: v.reshape(reps, n)[j] for j, i in enumerate(i15s)}

    # M1 recalibrated, from its coefficients; they must reproduce the saved estimator.
    refit = models[M1_MODEL]
    coef = {k: float(refit["coefficients"][k]) for k in ("B", "Ct", "Cf", "Cs")}
    m1 = {i: db.m1_likelihood(T, F, S, i, coef) for i in i15s}
    gap = max(float(np.max(np.abs(m1[i] - v))) for i, v in per_storm(db.predict(refit, rows)).items())
    if gap > 1e-9:
        raise SystemExit(f"m1_refit's coefficients differ from its estimator by {gap:.3g} on these segments")
    pred = {"m1": m1, **{col: per_storm(db.predict(models[mid], rows)) for col, mid in ML_MODELS}}

    # GeoJSON: M1 inputs and both M1 columns at DP_M1, the rest at DP.
    out_feats = []
    for j, f in enumerate(feats):
        p = props[j]
        pr = {"id": int(p["SegmentID"]), "area_km2": r(area[j]), "T": r(T[j], DP_M1), "F": r(F[j], DP_M1), "S": r(S[j], DP_M1),
              "usgs_hazard_24": int(p["H_24"])}
        pr.update({f"usgs_p_{i}": r(usgs[i][j], DP_M1) for i in i15s})
        pr.update({f"m1_p_{i}": r(m1[i][j], DP_M1) for i in i15s})
        for col, _ in ML_MODELS:
            pr.update({f"{col}_p_{i}": r(pred[col][i][j]) for i in i15s})
        out_feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line(f["geometry"]["coordinates"])},
                          "properties": pr})

    # Our map columns must rise (or stay level) with rainfall, on the values as written; USGS's is reported.
    written = {key: np.array([[f["properties"][f"{key}_p_{i}"] for f in out_feats] for i in i15s], float) for key in MAP_MODELS}
    drop = {key: falls(v) for key, v in written.items()}
    if any(drop[key][0] for key in ("m1", "rf")):
        raise SystemExit("a map column falls as I15 rises: " + ", ".join(f"{k} {c} segments" for k, (c, _) in drop.items() if c))
    m1_score = coef["Ct"] * T + coef["Cf"] * F + coef["Cs"] * S  # M1 recalibrated's slope in R for each segment
    mlp = db.predict(models["mlp_extended"], rows).reshape(reps, n) if "mlp_extended" in models else None
    mlp_drop = falls(np.round(mlp, DP)) if mlp is not None else None

    # Agreement with USGS, class counts and means for every design storm, on the values as written.
    at = {i: {key: written[key][j] for key in MAP_MODELS} for j, i in enumerate(i15s)}
    agree = {str(i): {key: agreement(v[key], v["usgs"]) for key in MAP_MODELS} for i, v in at.items()}
    counts = {str(i): {key: class_counts(v[key]) for key in MAP_MODELS} for i, v in at.items()}
    means = {str(i): {key: r(v[key].mean()) for key in MAP_MODELS} for i, v in at.items()}
    thresholds, th_source = median_thresholds(dest, props)

    # The inventory: training ranges, sampling and the analogue, for the notes.
    all_rows = load_inventory()
    kept = usable(all_rows)[0]
    inv = columns(kept)
    ana = analogue(fire.id, inventory_fires(all_rows, kept, c_lon, c_lat), model_eval)
    n_inv = len(inv["y"])
    if refit.get("n_train") != n_inv:
        raise SystemExit(f"{M1_MODEL} was fitted on {refit.get('n_train')} records; the usable inventory has {n_inv}")
    st = inv["staley2016"]
    p_inv = db.m1_likelihood(inv["T"], inv["F"], inv["S"], inv["I15"], coef)
    train_days = inv["days_since_fire"]
    early = train_days <= days_since
    groups = Counter(zip(inv["fire"][early], inv["year"][early], inv["storm"][early]))
    (top_fire, top_year, top_storm), top_n = groups.most_common(1)[0] if groups else (("", 0, ""), 0)
    early_fires = len({(f, y) for f, y, _ in groups})
    med = models["rf_extended"]["train_medians"]
    k = int(models["rf_extended"].get("spatial_k", db.SPATIAL_K))
    one = {"fire": np.full(n, fire.id), "storm": np.full(n, COMPARE_AT), "lat": lat_o, "lon": lon_o,
           "T": T, "F": F, "S": S, "R15": db.r15_mm(np.full(n, float(COMPARE_AT)))}
    spacing = np.nanpercentile(db.spatial_context(one, k)["ctx_dist_m"], [25, 50, 75])
    tq = models["rf_extended"]["context_distance_m"]
    wb = sc["wettest_before"]
    pub = db.M1_15
    s24 = str(COMPARE_AT)
    rho = {key: [agree[str(i)][key]["spearman_vs_usgs"] for i in i15s] for key in ("m1", "rf")}
    same = {key: [agree[str(i)][key]["class_agreement"] for i in i15s] for key in ("m1", "rf")}
    mean_at = lambda i: ", ".join(f"{key} {means[str(i)][key]:.3f}" for key in MAP_MODELS)

    notes = [
        "These likelihoods are compared with USGS's assessment; nothing here scores them against outcomes. The data used here "
        f"hold no observed debris-flow outcomes for the 2025 fires (USGS's inventory, {INVENTORY['doi']}, ends with 2024 fires), "
        "so agreement with USGS says how alike two models are on this fire, not which is closer to what happens.",
        "Map columns: usgs_p_* is USGS's own M1 (Staley et al. 2017, published 15-minute coefficients), copied; m1_p_* is M1 "
        "recalibrated; rf_p_* is step 14's rf_extended, a random forest constrained to rise with rainfall, under this file's "
        "scenario. The MLPs are scored in step 14 but not mapped: nothing constrains them to rise with rainfall"
        + (f", and here mlp_extended's likelihood (at {DP} decimals, as rf_p_* is written) would fall between consecutive design "
           f"storms on {mlp_drop[0]:,} of {n:,} segments (largest fall {mlp_drop[1]:.3f})." if mlp_drop else "."),
        f"M1 recalibrated (m1_p_*, coefficients in m1_recalibrated): M1's three-interaction logistic form refitted on all "
        f"{n_inv:,} usable inventory records (step 14's m1_refit), B = {coef['B']:.2f}, Ct = {coef['Ct']:.2f}, "
        f"Cf = {coef['Cf']:.3f}, Cs = {coef['Cs']:.2f}, against the published B = {pub['B']:.2f}, Ct = {pub['Ct']:.2f}, "
        f"Cf = {pub['Cf']:.2f}, Cs = {pub['Cs']:.2f}. Its likelihood rises with I15 wherever Ct·T + Cf·F + Cs·S > 0, which holds for "
        f"{int((m1_score > 0).sum()):,} of {n:,} segments here (smallest {m1_score.min():.4f}). Under one design storm every "
        "segment has the same R, so both M1 columns rank segments by Ct·T + Cf·F + Cs·S alone: m1's Spearman against USGS is "
        f"the same under every storm ({span(rho['m1'])}), while its levels and classes move with I15.",
        f"m1_check is an implementation check of our M1 code, not a validation and not a result: M1 with the published "
        f"coefficients (R = I15 × 0.25 h), recomputed from USGS's T, F and S, matches USGS's likelihoods for all {n:,} segments "
        f"and {len(i15s)} design storms to within {max_diff:.1g}. It is not a map column.",
        "Absolute likelihood levels depend on how each sub-inventory sampled non-events, not only on the watersheds: the observed "
        f"debris-flow rate is {inv['y'][st].mean():.3f} in the {int(st.sum()):,} Staley et al. (2016) records (the inventory "
        f"M1's published coefficients were fitted on) and {inv['y'][~st].mean():.3f} in the other {int((~st).sum()):,}. M1 "
        f"recalibrated averages {p_inv.mean():.3f} over all {n_inv:,} usable records ({p_inv[st].mean():.3f} on the Staley et al. "
        f"(2016) records, {p_inv[~st].mean():.3f} on the rest), and rf_extended was fitted on the same records. So the gap in "
        f"level between usgs_p_* and the other two columns (mean at {COMPARE_AT} mm/h: {mean_at(COMPARE_AT)}) partly reflects "
        "which records each was fitted on. None of these levels is an observed rate for this fire.",
        f"Agreement with USGS over the seven design storms (agreement_by_i15): Spearman m1 {span(rho['m1'])}, rf "
        f"{span(rho['rf'])}; same likelihood class m1 {span(same['m1'])}, rf {span(same['rf'])}. The usgs entries compare "
        "USGS with itself (1 by definition) and are there so every storm lists every map column.",
        f"The scenario is a choice. Only rf_p_* uses it: rf_extended takes days since fire and one antecedent soil-moisture "
        "value, the same for every segment, so the RF map depends on the scenario date and that one soil-moisture value; "
        f"usgs_p_* and m1_p_* do not. Rule: the first local day after ignition with at least {STORM_MM} mm (1 inch) of "
        f"precipitation at the AOI center in ECMWF ERA5 (Open-Meteo archive, models={PRECIP_MODEL}, grid point "
        f"{sc['grid'][0]:.2f}, {sc['grid'][1]:.2f}; hourly accumulations, each for the hour ending at its GMT time stamp, summed "
        f"into {fire.timezone} calendar days): {sc['date']}, with {sc['mm']:.1f} mm (peak hourly {sc['peak_mm_h']:.1f} mm/h). "
        + (f"The wettest earlier day was {wb[0]} with {wb[1]:.1f} mm, so any threshold above {wb[1]:.1f} mm and up to "
           f"{sc['mm']:.1f} mm picks the same day. " if wb else "No earlier day had precipitation. ")
        + f"{SEARCH_DAYS} days searched, {sc['missing_days']} with no value. A 0.25° hourly reanalysis only picks the date; it is "
        "not a 15-minute intensity, and the design storms set I15 instead.",
        f"days_since_fire = {days_since}: from the CAL FIRE start ({aoi['official']['incident']['start_utc']}, local date "
        f"{ignition}) to {sc['date']}, in calendar days like the inventory's StormStart − FireIgnitionDate. That is early in "
        f"recovery compared with training: the usable inventory records have a median of {np.median(train_days):.0f} days, and "
        f"only {int(early.sum()):,} of them ({early_fires} fires, {len(groups)} fire-storms, {int(inv['y'][early].sum()):,} "
        f"debris flows) are from storms within {days_since} days of a fire"
        + (f"; {top_n:,} of those are one storm, {top_fire} ({top_year}) on {ymd(top_storm)}" if top_n else "")
        + (". What rf_extended does this early rests mostly on that one storm, so" if top_n > early.sum() / 2 else ". So")
        + " the level of rf_p_* under this scenario is an extrapolation from little data.",
        f"Antecedent soil moisture (0–7 cm) on {ante}, the UTC day before the scenario date: "
        + (f"{sm:.4f} m³/m³ at the AOI center's ERA5-Land cell (training median {med['soil_moisture_0_7cm']:.4f}). "
           if math.isfinite(sm) else f"not available, so rf_extended imputes the training median {med['soil_moisture_0_7cm']:.4f}. ")
        + "It is one value for every segment, as is days since fire, so both set the level of the RF map, not the ranking of "
        "segments; in training they varied between storms.",
        "No map column uses spatial context; step 14 scores it only as the mlp_context variant, which is not mapped. For scale: "
        f"on this network the mean distance from a segment's downstream end to the {k} nearest others has median "
        f"{spacing[1]:,.0f} m (IQR {spacing[0]:,.0f}–{spacing[2]:,.0f} m), against {tq['median']:,.0f} m "
        f"(IQR {tq['q25']:,.0f}–{tq['q75']:,.0f} m) between the inventory's context neighbours, and here the neighbours include "
        "segments upstream and downstream on the same channel, whose watersheds nest.",
        f"Analogue: {ana['note']}",
        "T, F and S are USGS's values from its assessment inputs (its dNBR and burn-severity rasters, terrain and soil KF-factor), "
        "not computed from this project's AVIRIS-3 dNBR layer. area_km2 is USGS's Area (km²: the basin polygons' areas match it, "
        f"median ratio {ratio:.4f}). usgs_hazard_24 is USGS's combined hazard class at 24 mm/h (likelihood and volume together; "
        "1 low, 2 moderate, 3 high), copied as it is.",
        f"Likelihood classes are floor(p × 5) (0–20% … 80–100%); on USGS's likelihoods at 24 mm/h they reproduce USGS's own "
        f"P_24_LG labels for {lg_same:,} of {n:,} segments. Agreement, class counts and means use the values as written to "
        "debris_flow.geojson.",
        "On the values as written, no segment's m1_p_* or rf_p_* falls between consecutive design storms (rf_extended by its "
        "constraint, M1 recalibrated by its form and positive slopes here); this step stops if one does. "
        + (f"USGS's usgs_p_* falls on {drop['usgs'][0]:,} of {n:,} segments." if drop["usgs"][0] else
           "Nor does USGS's usgs_p_*."),
        f"USGS's median thresholds: {th_source}.",
        f"Geometry: USGS's segments in lon/lat ({crs}), simplified at {SIMPLIFY_DEG:g}° (~2 m) and rounded to {COORD_DP} decimals. "
        f"T, F, S, usgs_p_* and m1_p_* keep {DP_M1} decimals, and m1_recalibrated full precision, so both M1 columns can be "
        f"recomputed from these files; rf_p_* and other values {DP}. The downstream end is a segment's last vertex: in all "
        f"{n_pairs:,} pairs where one segment starts at another's end, the downstream one drains more area "
        f"({n_down:,} of {n_pairs:,}).",
    ]
    stats = {
        "source": {"title": f"USGS {meta['title']}", "doi": DOI, "url": SB_ITEM + meta["item"], "license": LICENSE},
        "design_i15_mm_h": list(i15s),
        "scenario": {"date": sc["date"].isoformat(), "days_since_fire": days_since,
                     "soil_moisture_0_7cm": r(sm),
                     "soil_moisture_source": f"{db.SOIL_MOISTURE_SOURCE}, at the AOI center ({c_lat:.4f}, {c_lon:.4f})"},
        "segments": n,
        "m1_check": {"max_abs_diff_vs_usgs": max_diff},
        "m1_recalibrated": {**coef, "records": n_inv},
        "agreement_by_i15": agree,
        "likelihood_class_counts": counts,
        "mean_likelihood": means,
        "analogue": ana,
        "usgs_median_thresholds_mm_h": {key: r(v) for key, v in thresholds.items()},
        "notes": notes,
    }
    # Both files together, after every check: a failed run leaves neither one new.
    text = json.dumps({"type": "FeatureCollection", "features": out_feats}, separators=(",", ":"), allow_nan=False)
    (fire.out_dir / "debris_flow.geojson").write_text(text + "\n")
    (fire.out_dir / "debris_flow_stats.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False, allow_nan=False) + "\n")

    version = wildcat_version(dest)
    add_source(fire, layer="Debris-flow segments (USGS)", source=f"USGS {meta['title']} (PWFDF collection)",
               url=SB_ITEM + meta["item"], status="MODELED", attribution=f"{CITATION}. {LICENSE}.",
               notes=f"{n:,} stream segments with M1's inputs (T, F, S) and USGS's M1 likelihoods and combined hazard classes at "
                     f"design storms I15 = {i15s[0]}–{i15s[-1]} mm/h" + (f", made with wildcat v{version}" if version else "")
                     + ". A model output, not observations. T and F come from the dNBR and burn severity in USGS's assessment "
                     "inputs, not this project's AVIRIS-3 dNBR layer.")
    add_source(fire, layer="Debris-flow models (this project)",
               source="Sentinel Ember: M1 recalibrated and a random forest (monotone in rainfall), fitted on USGS's postfire "
                      "debris-flow inventory",
               url=INVENTORY["url"], status="MODELED",
               attribution=f"{INVENTORY['title']}, doi:{INVENTORY['doi']} (CC0); ERA5 and ERA5-Land via Open-Meteo.com (CC BY 4.0)",
               notes=f"Applied to USGS's {n:,} segments: m1_p_* is M1's form refitted on {n_inv:,} inventory records; rf_p_* is a "
                     f"random forest constrained to rise with rainfall, under a scenario of {sc['date']} ({days_since} days after "
                     f"ignition). Spearman vs USGS at {COMPARE_AT} mm/h: "
                     + ", ".join(f"{key} {agree[s24][key]['spearman_vs_usgs']:.3f}" for key in ("m1", "rf"))
                     + ". Compared with USGS's assessment; there are no observed 2025 outcomes to score them against.")
    print(f"wrote debris_flow.geojson ({len(text) / 1e6:.2f} MB) and debris_flow_stats.json")
    print(f"  m1 recalibrated {coef}; slope Ct·T+Cf·F+Cs·S min {m1_score.min():.4f}; gap vs estimator {gap:.2g}")
    for i in i15s:
        a, c = agree[str(i)], counts[str(i)]
        print(f"  I15 {i:>2}: " + "  ".join(f"{key} rho {a[key]['spearman_vs_usgs']:.4f} same {a[key]['class_agreement']:.4f} "
                                             f"mean {means[str(i)][key]:.4f}" for key in MAP_MODELS))
        print("          classes " + "  ".join(f"{key} {list(c[key].values())}" for key in MAP_MODELS))
    print(f"  falls: {drop}; mlp_extended (not mapped) {mlp_drop}; spacing median {spacing[1]:.0f} m")
    print(f"  analogue: {ana}")


if __name__ == "__main__":
    main()
