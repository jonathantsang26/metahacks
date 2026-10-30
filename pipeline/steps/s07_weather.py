"""Step 07: hourly weather, daily fire danger, and a weather-station cross-check.

Inputs (no-key HTTP, cached under raw/<fire>/weather/):
  aoi.json            center, bbox and window_utc (from step 01; step 06 may tighten the window)
  Open-Meteo archive  models=era5_seamless: ERA5 wind (0.25°) + ERA5-Land temperature / RH (0.1°),
                      hourly, at the AOI center, a 3×3 grid across the bbox and the chosen station.
                      models=ecmwf_ifs (9 km) at the same points, used only as a sensitivity check.
  gridMET             daily ERC, BI, 100-h and 1000-h dead fuel moisture (4 km) via OPeNDAP ASCII
  IEM ASOS            airport observations from the CA_ASOS network, for the cross-check
Outputs:
  weather.json             {hourly: [{t, wind_mph, wind_dir_deg, gust_mph, temp_c, rh_pct}],
                            daily: [{date, erc, bi, fm100, fm1000}], source, point: [lon, lat], ...}
  weather_station.json     {station, name, lon, lat, hourly: [...], comparison: {...}, ...}
  work/<fire>/weather_grid.json
                           {points: [[lon, lat] ×9], t: [...], u_mps: [[...] per point], v_mps: [...]}
                           points run row-major, north row first, west to east; points[4] = AOI center.
Conventions:
  wind_dir_deg is meteorological: the direction the wind blows FROM, clockwise from north.
  u_mps / v_mps are the vector the air moves TOWARD (u east, v north):
      u = -speed·sin(dir), v = -speed·cos(dir)
  Hourly series cover aoi.window_utc padded by one day on each side, half-open, UTC.
  Comparisons and summaries use the unpadded window. Biases are reanalysis minus station.
  gridMET "days" end at ~07 UTC the next calendar day (midnight MST); a date is kept when that
  24 h period overlaps the padded window.

Run: uv run python -m steps.s07_weather
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

from ember.config import Fire, load_fire
from ember.geo import meters_per_degree
from ember.manifest import add_source

USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"
OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive"
GRIDMET = "http://thredds.northwestknowledge.net:8080/thredds/dodsC/MET/{var}/{var}_{year}.nc"
IEM_ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
IEM_NETWORK = "https://mesonet.agron.iastate.edu/geojson/network/{network}.geojson"
ASOS_NETWORK = "CA_ASOS"

PRIMARY_MODEL = "era5_seamless"
SENSITIVITY_MODEL = "ecmwf_ifs"
HOURLY_VARS = ["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]

# Short name → variable inside the gridMET file (discovered from the .dds) is resolved at run time.
GRIDMET_VARS = ["erc", "bi", "fm100", "fm1000"]
GRIDMET_FILL = 32767

STATION_RADIUS_KM = 40.0
STATION_MIN_COVERAGE = 0.9   # share of window hours with both wind and RH reported

MPH_TO_MPS = 0.44704
KT_TO_MPH = 1.15078
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)

# ---------------------------------------------------------------- http


def _get(url: str, dest: Path, params=None, *, parse=None, retries: int = 4):
    """GET with the project User-Agent, cached at dest, retried with exponential backoff.

    `parse(bytes)` validates and decodes the body; if it raises, the cached file is deleted so a
    bad 200 response (an HTML error page, say) is not replayed on every later run.
    """
    if not (dest.exists() and dest.stat().st_size > 0):
        dest.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(retries):
            try:
                r = requests.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=120)
                if r.status_code == 429 or r.status_code >= 500:
                    raise requests.HTTPError(f"{r.status_code} from {r.url}", response=r)
                r.raise_for_status()
                dest.write_bytes(r.content)
                break
            except requests.RequestException:
                if attempt == retries - 1:
                    raise
                time.sleep(2.0 * 2**attempt)
    body = dest.read_bytes()
    if parse is None:
        return body
    try:
        return parse(body)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


def _cache_path(fire: Fire, label: str, url: str, params, ext: str) -> Path:
    key = hashlib.sha1(requests.Request("GET", url, params=params).prepare().url.encode()).hexdigest()[:12]
    return fire.raw_dir / "weather" / f"{label}_{key}.{ext}"


# ---------------------------------------------------------------- time + geometry


def parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def hours(start: datetime, end: datetime) -> list[datetime]:
    n = int((end - start) / HOUR)
    return [start + i * HOUR for i in range(n)]


def grid_points(bbox: list[float]) -> list[list[float]]:
    """Centers of a 3×3 partition of the bbox, north row first, west to east."""
    w, s, e, n = bbox
    fx = [w + (e - w) * f for f in (1 / 6, 1 / 2, 5 / 6)]
    fy = [n - (n - s) * f for f in (1 / 6, 1 / 2, 5 / 6)]
    return [[round(x, 6), round(y, 6)] for y in fy for x in fx]


def distance_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    m_lon, m_lat = meters_per_degree((lat1 + lat2) / 2)
    return math.hypot((lon2 - lon1) * m_lon, (lat2 - lat1) * m_lat) / 1000


# ---------------------------------------------------------------- wind math


def wind_uv(speed, dir_from_deg):
    """Meteorological speed + FROM direction → (u, v) of the air's motion TOWARD."""
    rad = np.radians(np.asarray(dir_from_deg, float))
    speed = np.asarray(speed, float)
    return -speed * np.sin(rad), -speed * np.cos(rad)


def wind_dir_from(u, v):
    """(u, v) TOWARD → meteorological FROM direction in [0, 360)."""
    return (np.degrees(np.arctan2(-np.asarray(u, float), -np.asarray(v, float))) + 360.0) % 360.0


def pearson(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 3 or np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


# ---------------------------------------------------------------- Open-Meteo


def fetch_open_meteo(fire: Fire, model: str, points: list[list[float]], start: datetime, end: datetime) -> list[dict]:
    """One archive request for every point; the response is a list in request order."""
    params = {
        "latitude": ",".join(f"{lat:.6f}" for _, lat in points),
        "longitude": ",".join(f"{lon:.6f}" for lon, _ in points),
        "start_date": start.date().isoformat(),
        "end_date": (end - HOUR).date().isoformat(),
        "hourly": ",".join(HOURLY_VARS),
        "wind_speed_unit": "mph",
        "timezone": "GMT",
        "models": model,
    }

    def parse(body: bytes) -> list[dict]:
        data = json.loads(body)
        if isinstance(data, dict):
            if data.get("error"):
                raise SystemExit(f"Open-Meteo error: {data.get('reason')}")
            data = [data]
        if len(data) != len(points):
            raise SystemExit(f"Open-Meteo returned {len(data)} locations for {len(points)} requested")
        return data

    return _get(OPEN_METEO, _cache_path(fire, f"open_meteo_{model}", OPEN_METEO, params, "json"), params,
                parse=parse)


def om_series(loc: dict, model: str, start: datetime, end: datetime, *, strict: bool) -> dict:
    """Hourly arrays for [start, end) from one Open-Meteo location; None → NaN (or fail if strict)."""
    h = loc["hourly"]
    times = [parse_utc(t + ":00Z") for t in h["time"]]
    want = hours(start, end)
    idx = {t: i for i, t in enumerate(times)}
    missing = [t for t in want if t not in idx]
    if missing:
        raise SystemExit(f"Open-Meteo {model}: {len(missing)} hours missing, first {iso(missing[0])}")
    out = {"t": want, "lon": loc["longitude"], "lat": loc["latitude"]}
    for var in HOURLY_VARS:
        vals = h.get(f"{var}_{model}", h.get(var))
        arr = np.array([np.nan if vals[idx[t]] is None else vals[idx[t]] for t in want], float)
        if strict and np.isnan(arr).any():
            raise SystemExit(f"Open-Meteo {model}: {var} has {int(np.isnan(arr).sum())} null hours in the window")
        out[var] = arr
    return out


def grid_spread(series: list[dict]) -> dict:
    """How different the 3×3 points really are: reanalysis cells are coarser than the AOI."""
    uv = [wind_uv(s["wind_speed_10m"] * MPH_TO_MPS, s["wind_direction_10m"]) for s in series]
    u = np.array([p[0] for p in uv])
    v = np.array([p[1] for p in uv])
    speed = np.hypot(u, v)
    key = np.round(np.nan_to_num(np.stack([u, v], axis=1), nan=-999.0), 3)
    distinct = len({k.tobytes() for k in key})
    rms_vs_center = np.sqrt(np.nanmean((u - u[4]) ** 2 + (v - v[4]) ** 2, axis=1))
    rh = np.array([s["relative_humidity_2m"] for s in series])
    return {
        "distinct_wind_series": distinct,
        "max_rms_vector_diff_vs_center_mps": round(float(np.nanmax(rms_vs_center)), 2),
        "mean_hourly_speed_range_mps": round(float(np.nanmean(speed.max(0) - speed.min(0))), 2),
        "mean_hourly_rh_range_pct": round(float(np.nanmean(rh.max(0) - rh.min(0))), 1),
    }


# ---------------------------------------------------------------- gridMET


def parse_dods_ascii(text: str, var: str) -> list[float]:
    """Values of `var` from an OPeNDAP .ascii response, flattened in index order."""
    lines = text.split("\n")
    head = next((i for i, ln in enumerate(lines) if ln.startswith(f"{var}.{var}[") or ln.startswith(f"{var}[")), None)
    if head is None:
        raise ValueError(f"{var} not found in OPeNDAP response")
    vals: list[float] = []
    for ln in lines[head + 1:]:
        if not ln.strip():
            break
        row = ln.split(",")
        if ln.startswith("["):
            row = row[1:]  # drop the "[i][j]" index prefix
        vals.extend(float(x) for x in row if x.strip())
    return vals


def gridmet_coords(fire: Fire, var: str, year: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    url = GRIDMET.format(var=var, year=year) + ".ascii?lat,lon,day"

    def parse(body: bytes):
        text = body.decode()
        return tuple(np.array(parse_dods_ascii(text, k)) for k in ("lat", "lon", "day"))

    return _get(url, fire.raw_dir / "weather" / f"gridmet_{var}_{year}_coords.txt", parse=parse)


def gridmet_var(fire: Fire, var: str, year: int) -> tuple[str, float]:
    """Discover the data variable name (from .dds) and its scale factor (from .das)."""
    base = GRIDMET.format(var=var, year=year)

    def parse_dds(body: bytes) -> str:
        names = re.findall(r"^\s+\w+\s+([\w\-]+)\[day = \d+\]\[lat = \d+\]\[lon = \d+\];", body.decode(), re.M)
        if len(names) != 1:
            raise SystemExit(f"gridMET {var}: expected one [day][lat][lon] variable, found {names}")
        return names[0]

    def parse_das(body: bytes) -> float:
        block = body.decode().split(f"{name} {{", 1)[1].split("}", 1)[0]
        m = re.search(r"scale_factor ([\d.eE+-]+);", block)
        return float(m.group(1)) if m else 1.0

    name = _get(base + ".dds", fire.raw_dir / "weather" / f"gridmet_{var}_{year}.dds", parse=parse_dds)
    return name, _get(base + ".das", fire.raw_dir / "weather" / f"gridmet_{var}_{year}.das", parse=parse_das)


def gridmet_days(day_values: np.ndarray, start: datetime, end: datetime) -> list[int]:
    """Indices of gridMET days (each ~07Z to 07Z next day) overlapping [start, end)."""
    epoch = datetime(1900, 1, 1, tzinfo=timezone.utc)
    keep = []
    for i, d in enumerate(day_values):
        d0 = epoch + timedelta(days=float(d)) + timedelta(hours=7)
        if d0 < end and d0 + DAY > start:
            keep.append(i)
    return keep


def fetch_gridmet(fire: Fire, lon: float, lat: float, start: datetime, end: datetime) -> tuple[list[dict], dict]:
    year = fire.year
    if start.year != year or (end - HOUR).year != year:
        raise SystemExit(f"gridMET: window {iso(start)}..{iso(end)} is outside {year}")
    lats, lons, days = gridmet_coords(fire, "erc", year)
    i, j = int(np.argmin(np.abs(lats - lat))), int(np.argmin(np.abs(lons - lon)))
    di = gridmet_days(days, start, end)
    if not di or di != list(range(di[0], di[-1] + 1)):
        raise SystemExit(f"gridMET: no contiguous days for {iso(start)}..{iso(end)}")
    d0, d1 = di[0], di[-1]
    n = d1 - d0 + 1
    epoch = date(1900, 1, 1)
    rows = [{"date": (epoch + timedelta(days=float(days[k]))).isoformat()} for k in range(d0, d1 + 1)]
    names = {}
    for short in GRIDMET_VARS:
        name, scale = gridmet_var(fire, short, year)
        names[short] = name
        # A 3×3 cell neighborhood: the center feeds the series, the rest bounds its spatial spread.
        sel = f"[{d0}:1:{d1}][{i - 1}:1:{i + 1}][{j - 1}:1:{j + 1}]"
        url = GRIDMET.format(var=short, year=year) + ".ascii?" + requests.utils.quote(name + sel, safe="-_:")

        def parse(body: bytes, name=name, short=short) -> np.ndarray:
            text = body.decode()
            vals = np.array(parse_dods_ascii(text, name), float).reshape(n, 3, 3)
            if not np.allclose(parse_dods_ascii(text, f"{name}.day"), days[d0:d1 + 1]):
                raise SystemExit(f"gridMET {short}: day coordinate mismatch")
            return vals

        vals = _get(url, fire.raw_dir / "weather" / f"gridmet_{short}_{year}_{d0}-{d1}_{i}_{j}.txt", parse=parse)
        vals = np.where(vals == GRIDMET_FILL, np.nan, vals * scale)
        if np.isnan(vals[:, 1, 1]).any():
            raise SystemExit(f"gridMET {short}: fill value at the center cell ({lats[i]:.4f}, {lons[j]:.4f})")
        for k, row in enumerate(rows):
            row[short] = round(float(vals[k, 1, 1]), 1)
            if short == "erc":
                row["erc_3x3"] = [round(float(np.nanmin(vals[k])), 1), round(float(np.nanmax(vals[k])), 1)]
    flag_isolated_drops(rows)
    cell = {"lon": round(float(lons[j]), 6), "lat": round(float(lats[i]), 6), "variables": names}
    return rows, cell


def flag_isolated_drops(rows: list[dict], keys=("erc", "bi"), drop: float = 20.0) -> None:
    """Values are kept as published; a day that sits ≥ `drop` below both neighbors gets a `qc` note
    so the UI and analyst don't quote it as a real lull."""
    for k in range(1, len(rows) - 1):
        notes = [f"{key}: isolated drop vs adjacent days (as published)" for key in keys
                 if min(rows[k - 1][key], rows[k + 1][key]) - rows[k][key] >= drop]
        if notes:
            rows[k]["qc"] = notes


# ---------------------------------------------------------------- IEM ASOS


def station_candidates(fire: Fire, lon: float, lat: float, start: datetime, end: datetime) -> list[dict]:
    url = IEM_NETWORK.format(network=ASOS_NETWORK)
    gj = _get(url, fire.raw_dir / "weather" / f"iem_{ASOS_NETWORK}.geojson", parse=json.loads)
    out = []
    for f in gj["features"]:
        p = f["properties"]
        slon, slat = f["geometry"]["coordinates"]
        began = p.get("archive_begin")
        ended = p.get("archive_end")
        if began and date.fromisoformat(began[:10]) > start.date():
            continue
        if ended and date.fromisoformat(ended[:10]) < end.date():
            continue
        d = distance_km(lon, lat, slon, slat)
        if d <= STATION_RADIUS_KM:
            out.append({"station": p.get("sid") or f["id"], "name": p.get("sname", ""), "lon": slon, "lat": slat,
                        "elevation_m": p.get("elevation"), "distance_km": round(d, 1)})
    return sorted(out, key=lambda c: c["distance_km"])


def fetch_asos(fire: Fire, stations: list[str], start: datetime, end: datetime) -> list[dict]:
    # Whole UTC days with a day of margin: binning reaches 60 min before `start`, and day2 is an
    # exclusive date bound. station_hourly trims to [start, end).
    first, last = start - DAY, end + DAY
    params = [("station", s) for s in stations] + [("data", d) for d in ("sknt", "drct", "gust", "tmpf", "relh")] + [
        ("year1", first.year), ("month1", first.month), ("day1", first.day),
        ("year2", last.year), ("month2", last.month), ("day2", last.day),
        ("tz", "Etc/UTC"), ("format", "onlycomma"), ("latlon", "yes"), ("missing", "empty"), ("trace", "empty"),
    ]

    def parse(body: bytes) -> list[dict]:
        text = body.decode()
        if not text.startswith("station,"):
            raise SystemExit(f"IEM ASOS: unexpected response: {text[:200]!r}")
        return list(csv.DictReader(io.StringIO(text)))

    return _get(IEM_ASOS, _cache_path(fire, "iem_asos", IEM_ASOS, params, "csv"), params, parse=parse)


def _num(s: str) -> float:
    return float(s) if s not in ("", "M", None) else math.nan


def station_hourly(rows: list[dict], start: datetime, end: datetime) -> list[dict]:
    """Aggregate raw observations (routine, special and 5-minute) onto the UTC hours of [start, end).

    Speed, direction, temperature and RH use observations within ±30 min of the hour, to match
    instantaneous reanalysis values. Gust uses the hour ending at t (Open-Meteo's definition) and is
    the peak of reported gusts and sustained speeds, because METARs omit gusts below ~10 kt spread.
    Direction is a vector mean; it is null when every observation in the bin is calm or variable.
    """
    want = hours(start, end)
    idx = {t: k for k, t in enumerate(want)}
    bins = [{"spd": [], "u": [], "v": [], "tmp": [], "rh": [], "peak": []} for _ in want]
    for r in rows:
        ts = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        spd = _num(r["sknt"]) * KT_TO_MPH
        gust = _num(r["gust"]) * KT_TO_MPH
        near = (ts + timedelta(minutes=30)).replace(minute=0)
        ending = ts.replace(minute=0) + (HOUR if ts.minute else timedelta(0))
        if near in idx:
            b = bins[idx[near]]
            if not math.isnan(spd):
                b["spd"].append(spd)
                drct = _num(r["drct"])
                if spd > 0 and not math.isnan(drct):
                    u, v = wind_uv(spd, drct)
                    b["u"].append(float(u))
                    b["v"].append(float(v))
            if not math.isnan(_num(r["tmpf"])):
                b["tmp"].append((_num(r["tmpf"]) - 32) * 5 / 9)
            if not math.isnan(_num(r["relh"])):
                b["rh"].append(_num(r["relh"]))
        if ending in idx:
            peaks = [x for x in (spd, gust) if not math.isnan(x)]
            bins[idx[ending]]["peak"].extend(peaks)

    def mean(xs, nd):
        return round(float(np.mean(xs)), nd) if xs else None

    out = []
    for t, b in zip(want, bins):
        direction = None
        if b["u"]:
            direction = round(float(wind_dir_from(np.mean(b["u"]), np.mean(b["v"]))))
        out.append({
            "t": iso(t),
            "wind_mph": mean(b["spd"], 1),
            "gust_mph": round(max(b["peak"]), 1) if b["peak"] else None,
            "wind_dir_deg": direction % 360 if direction is not None else None,
            "rh_pct": mean(b["rh"], 1),
            "temp_c": mean(b["tmp"], 1),
        })
    return out


def coverage(hourly: list[dict], start: datetime, end: datetime) -> float:
    inside = [h for h in hourly if start <= parse_utc(h["t"]) < end]
    ok = [h for h in inside if h["wind_mph"] is not None and h["rh_pct"] is not None]
    return len(ok) / max(len(inside), 1)


def compare(station: list[dict], model: dict, start: datetime, end: datetime) -> dict:
    """Station vs reanalysis on the hours both report, inside [start, end). Bias = reanalysis − station."""
    mi = {iso(t): k for k, t in enumerate(model["t"])}
    ws, wm, rs, rm, gs = [], [], [], [], []
    for h in station:
        t = parse_utc(h["t"])
        if not (start <= t < end) or h["t"] not in mi:
            continue
        k = mi[h["t"]]
        if h["wind_mph"] is not None and not np.isnan(model["wind_speed_10m"][k]):
            ws.append(h["wind_mph"])
            wm.append(model["wind_speed_10m"][k])
        if h["rh_pct"] is not None and not np.isnan(model["relative_humidity_2m"][k]):
            rs.append(h["rh_pct"])
            rm.append(model["relative_humidity_2m"][k])
        if h["gust_mph"] is not None:
            gs.append(h["gust_mph"])
    ws, wm, rs, rm = map(np.array, (ws, wm, rs, rm))
    in_win = np.array([start <= t < end for t in model["t"]])
    gust_model = model["wind_gusts_10m"][in_win]

    def r(x, nd=2):
        return None if x is None else round(float(x), nd)

    return {
        "wind_bias_mph": r(np.mean(wm - ws), 1) if len(ws) else None,
        "wind_corr": r(pearson(ws, wm)) if len(ws) else None,
        "wind_rmse_mph": r(np.sqrt(np.mean((wm - ws) ** 2)), 1) if len(ws) else None,
        "rh_bias_pct": r(np.mean(rm - rs), 1) if len(rs) else None,
        "rh_corr": r(pearson(rs, rm)) if len(rs) else None,
        "n_hours": int(len(ws)),
        "n_hours_rh": int(len(rs)),
        "max_gust_station_mph": r(max(gs), 1) if gs else None,
        "max_gust_reanalysis_mph": r(np.nanmax(gust_model), 1),
        "mean_wind_station_mph": r(np.mean(ws), 1) if len(ws) else None,
        "mean_wind_reanalysis_mph": r(np.mean(wm), 1) if len(wm) else None,
    }


# ---------------------------------------------------------------- outputs


def hourly_records(s: dict) -> list[dict]:
    out = []
    for k, t in enumerate(s["t"]):
        out.append({
            "t": iso(t),
            "wind_mph": round(float(s["wind_speed_10m"][k]), 1),
            "wind_dir_deg": int(round(float(s["wind_direction_10m"][k]))) % 360,
            "gust_mph": round(float(s["wind_gusts_10m"][k]), 1),
            "temp_c": round(float(s["temperature_2m"][k]), 1),
            "rh_pct": round(float(s["relative_humidity_2m"][k]), 1),
        })
    return out


def window_summary(s: dict, start: datetime, end: datetime) -> dict:
    k = [i for i, t in enumerate(s["t"]) if start <= t < end]
    g = int(k[int(np.argmax(s["wind_gusts_10m"][k]))])
    w = int(k[int(np.argmax(s["wind_speed_10m"][k]))])
    h = int(k[int(np.argmin(s["relative_humidity_2m"][k]))])
    return {
        "window_utc": [iso(start), iso(end)],
        "peak_gust_mph": round(float(s["wind_gusts_10m"][g]), 1), "peak_gust_t": iso(s["t"][g]),
        "peak_wind_mph": round(float(s["wind_speed_10m"][w]), 1), "peak_wind_t": iso(s["t"][w]),
        "min_rh_pct": round(float(s["relative_humidity_2m"][h]), 1), "min_rh_t": iso(s["t"][h]),
    }


def choose_station(candidates: list[dict], rows: list[dict], start: datetime, end: datetime,
                   pad_start: datetime, pad_end: datetime) -> tuple[dict, list[dict]]:
    """Nearest candidate whose window coverage (wind and RH) reaches STATION_MIN_COVERAGE."""
    by_station: dict[str, list[dict]] = {}
    for r in rows:
        by_station.setdefault(r["station"], []).append(r)
    for c in candidates:
        c["hourly"] = station_hourly(by_station.get(c["station"], []), pad_start, pad_end)
        c["coverage"] = round(coverage(c["hourly"], start, end), 3)
    ok = [c for c in candidates if c["coverage"] >= STATION_MIN_COVERAGE]
    if not ok:
        raise SystemExit(f"IEM ASOS: no station within {STATION_RADIUS_KM:.0f} km reaches "
                         f"{STATION_MIN_COVERAGE:.0%} hourly coverage; candidates: "
                         + ", ".join(f"{c['station']} {c['coverage']:.0%}" for c in candidates))
    return ok[0], candidates


def main() -> None:
    fire = load_fire()
    aoi = fire.read_json("aoi.json")
    start, end = (parse_utc(t) for t in aoi["window_utc"])
    pad_start, pad_end = start - DAY, end + DAY
    lon, lat = aoi["center"]

    # Station first, so the reanalysis can also be sampled at the station's own location.
    candidates = station_candidates(fire, lon, lat, pad_start, pad_end)
    if not candidates:
        raise SystemExit(f"IEM ASOS: no {ASOS_NETWORK} station within {STATION_RADIUS_KM:.0f} km")
    asos_rows = fetch_asos(fire, [c["station"] for c in candidates], pad_start, pad_end)
    station, candidates = choose_station(candidates, asos_rows, start, end, pad_start, pad_end)

    grid = grid_points(aoi["bbox"])
    points = [[lon, lat]] + grid + [[station["lon"], station["lat"]]]
    om = fetch_open_meteo(fire, PRIMARY_MODEL, points, pad_start, pad_end)
    center = om_series(om[0], PRIMARY_MODEL, pad_start, pad_end, strict=True)
    grid_series = [om_series(loc, PRIMARY_MODEL, pad_start, pad_end, strict=True) for loc in om[1:10]]
    at_station = om_series(om[10], PRIMARY_MODEL, pad_start, pad_end, strict=True)

    alt = fetch_open_meteo(fire, SENSITIVITY_MODEL, points, pad_start, pad_end)
    alt_center = om_series(alt[0], SENSITIVITY_MODEL, pad_start, pad_end, strict=False)
    alt_grid = [om_series(loc, SENSITIVITY_MODEL, pad_start, pad_end, strict=False) for loc in alt[1:10]]

    daily, gm_cell = fetch_gridmet(fire, lon, lat, pad_start, pad_end)

    # ---- weather.json
    summary = window_summary(center, start, end)
    point = [round(center["lon"], 6), round(center["lat"], 6)]
    source = ("Open-Meteo historical archive, models=era5_seamless: ERA5 reanalysis wind and gusts (0.25°) "
              "with ERA5-Land temperature and RH (0.1°); gridMET daily fire danger (Abatzoglou 2013, 4 km)")
    fire.write_json("weather.json", {
        "hourly": hourly_records(center),
        "daily": daily,
        "source": source,
        "point": point,
        "requested_point": [lon, lat],
        "model": PRIMARY_MODEL,
        "window_utc": [iso(pad_start), iso(pad_end)],
        "summary": summary,
        "gridmet_cell": [gm_cell["lon"], gm_cell["lat"]],
        "units": {"wind_mph": "mph, 10 m", "gust_mph": "mph, 10 m, max of preceding hour", "temp_c": "°C, 2 m",
                  "rh_pct": "%, 2 m", "wind_dir_deg": "degrees, direction wind blows FROM",
                  "fm100": "% dead fuel moisture", "fm1000": "% dead fuel moisture"},
    })

    # ---- work/<fire>/weather_grid.json
    uv = [wind_uv(s["wind_speed_10m"] * MPH_TO_MPS, s["wind_direction_10m"]) for s in grid_series]
    spread = {PRIMARY_MODEL: grid_spread(grid_series), SENSITIVITY_MODEL: grid_spread(alt_grid)}
    (fire.work_dir / "weather_grid.json").write_text(json.dumps({
        "points": grid,
        "cells": [[s["lon"], s["lat"]] for s in grid_series],
        "t": [iso(t) for t in center["t"]],
        "u_mps": [[round(float(x), 2) for x in u] for u, _ in uv],
        "v_mps": [[round(float(x), 2) for x in v] for _, v in uv],
        "model": PRIMARY_MODEL,
        "layout": "points row-major, north row first, west to east; u_mps[i] is the series at points[i]; "
                  "cells = the grid cell Open-Meteo reports per point (ERA5-Land 0.1°; wind comes from "
                  "the coarser ERA5 0.25° grid, so compare series, not cells)",
        "convention": "u/v = vector the air moves TOWARD (u east, v north), m/s",
        "spread": spread,
    }) + "\n")

    # ---- weather_station.json
    cmp_center = compare(station["hourly"], center, start, end)
    cmp_at_station = compare(station["hourly"], at_station, start, end)
    cmp_alt = compare(station["hourly"], alt_center, start, end)
    others = [
        {k: c[k] for k in ("station", "name", "lon", "lat", "elevation_m", "distance_km", "coverage")}
        | {"comparison": compare(c["hourly"], center, start, end)}
        for c in candidates if c is not station
    ]
    fire.write_json("weather_station.json", {
        "station": station["station"],
        "name": station["name"],
        "lon": station["lon"],
        "lat": station["lat"],
        "elevation_m": station["elevation_m"],
        "distance_km": station["distance_km"],
        "coverage": station["coverage"],
        "hourly": station["hourly"],
        "comparison": cmp_center,
        "comparison_reanalysis_at_station": cmp_at_station,
        f"comparison_{SENSITIVITY_MODEL}": cmp_alt,
        "selection": f"nearest {ASOS_NETWORK} station within {STATION_RADIUS_KM:.0f} km with ≥"
                     f"{STATION_MIN_COVERAGE:.0%} of window hours reporting wind and RH",
        "others": others,
        "notes": "comparison = station vs the reanalysis at the AOI center (what the pipeline uses); "
                 "comparison_reanalysis_at_station = vs the reanalysis cell at the station; biases are "
                 "reanalysis minus station over the unpadded window.",
    })

    # ---- manifest
    alt_peak = float(np.nanmax(alt_center["wind_gusts_10m"][[start <= t < end for t in alt_center["t"]]]))
    add_source(
        fire, layer="Weather (hourly)", source="ERA5 / ERA5-Land reanalysis via Open-Meteo",
        url="https://open-meteo.com/en/docs/historical-weather-api", status="REAL",
        attribution="Open-Meteo.com (CC BY 4.0); contains modified Copernicus Climate Change Service information",
        notes=(f"models=era5_seamless at cell {point} for {aoi['center']}; 3×3 grid gives "
               f"{spread[PRIMARY_MODEL]['distinct_wind_series']}/9 distinct wind series. Window peak gust "
               f"{summary['peak_gust_mph']} mph, min RH {summary['min_rh_pct']}%. ECMWF IFS 9 km "
               f"(sensitivity only) peaks at {alt_peak:.0f} mph at the same point."),
    )
    add_source(
        fire, layer="Fire danger (daily)", source="gridMET (Abatzoglou 2013) ERC, BI, 100-h and 1000-h fuel moisture",
        url=GRIDMET.format(var="erc", year=fire.year), status="REAL",
        attribution="Abatzoglou, J.T. (2013), Int. J. Climatology, doi:10.1002/joc.3413",
        notes=(f"Nearest 4 km cell {gm_cell['lon']:.4f}, {gm_cell['lat']:.4f}; days end ~07 UTC (midnight MST). "
               f"erc_3x3 is the min/max over the surrounding 3×3 cells. QC-flagged days (kept as published): "
               + (", ".join(f"{d['date']} ({'; '.join(d['qc'])})" for d in daily if d.get("qc")) or "none")),
    )
    add_source(
        fire, layer="Weather station", source=f"IEM ASOS {station['station']} {station['name']}",
        url="https://mesonet.agron.iastate.edu/request/download.phtml", status="REAL",
        attribution="Iowa Environmental Mesonet, Iowa State University",
        notes=(f"{station['distance_km']} km from the AOI center, {station['coverage']:.0%} hourly coverage. "
               f"vs reanalysis center: wind bias {cmp_center['wind_bias_mph']} mph, r={cmp_center['wind_corr']}; "
               f"RH bias {cmp_center['rh_bias_pct']}%, r={cmp_center['rh_corr']}; n={cmp_center['n_hours']} h. "
               "Skipped nearer stations: " + (", ".join(f"{c['station']} ({c['coverage']:.0%} coverage)"
                                                         for c in candidates
                                                         if c["distance_km"] < station["distance_km"]) or "none")),
    )

    # ---- report
    print(f"{fire.name}: {PRIMARY_MODEL} cell {point} (requested {aoi['center']})")
    print(f"  window peak gust {summary['peak_gust_mph']} mph at {summary['peak_gust_t']}, "
          f"peak wind {summary['peak_wind_mph']} mph, min RH {summary['min_rh_pct']}% at {summary['min_rh_t']}")
    print(f"  {SENSITIVITY_MODEL} peak gust {alt_peak:.1f} mph")
    print("  ERC " + ", ".join(f"{d['date'][5:]}:{d['erc']:.0f}" for d in daily)
          + f"  (gridMET cell {gm_cell['lon']:.4f}, {gm_cell['lat']:.4f})")
    print(f"  grid spread {spread}")
    print(f"  station {station['station']} {station['name']} {station['distance_km']} km, "
          f"coverage {station['coverage']:.0%}")
    for label, c in (("center", cmp_center), ("at-station", cmp_at_station), (SENSITIVITY_MODEL, cmp_alt)):
        print(f"    vs {label}: {c}")
    for o in others:
        print(f"    other {o['station']} {o['distance_km']} km cov {o['coverage']:.0%}: "
              f"wind bias {o['comparison']['wind_bias_mph']} r={o['comparison']['wind_corr']}, "
              f"RH bias {o['comparison']['rh_bias_pct']} r={o['comparison']['rh_corr']}")


if __name__ == "__main__":
    main()
