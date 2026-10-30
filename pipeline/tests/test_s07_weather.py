"""Step 07 contract + unit tests: offline, against committed weather.json / weather_station.json."""

import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from steps.s07_weather import (
    MPH_TO_MPS,
    _get,
    distance_km,
    flag_isolated_drops,
    gridmet_days,
    grid_points,
    parse_dods_ascii,
    station_hourly,
    wind_dir_from,
    wind_uv,
)

UTC = timezone.utc


def _utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _window(fire):
    """The unpadded window step 07 ran with. Step 06 may later tighten aoi.json's window, so the
    tests check that aoi.json's window stays inside the series rather than demanding equality."""
    aoi = fire.read_json("aoi.json")
    w0, w1 = fire.read_json("weather.json")["summary"]["window_utc"]
    return _utc(w0), _utc(w1), aoi


def _ang(a, b):
    return abs((a - b + 180) % 360 - 180)


# ---------------------------------------------------------------- unit


def test_wind_uv_is_toward_and_dir_is_from():
    u, v = wind_uv([10, 10, 10], [0, 90, 225])
    # From north → air moves south; from east → moves west; from SW → moves NE.
    assert np.allclose([u[0], v[0]], [0, -10], atol=1e-9)
    assert np.allclose([u[1], v[1]], [-10, 0], atol=1e-9)
    assert u[2] > 0 and v[2] > 0
    assert np.allclose(wind_dir_from(u, v), [0, 90, 225])


def _row(t, sknt="", drct="", gust="", tmpf="", relh=""):
    return {"station": "X", "valid": t, "sknt": sknt, "drct": drct, "gust": gust, "tmpf": tmpf, "relh": relh}


def test_station_hourly_binning_and_vector_mean():
    start = datetime(2025, 1, 8, 0, tzinfo=UTC)
    rows = [
        _row("2025-01-08 00:53", sknt="10", drct="350", tmpf="50", relh="20"),
        _row("2025-01-08 01:05", sknt="10", drct="10", tmpf="52", relh="10"),
        _row("2025-01-08 00:40", gust="40"),               # 5-min record with only a gust
        _row("2025-01-08 01:53", sknt="0", drct="0", relh="30"),
    ]
    out = station_hourly(rows, start, start + timedelta(hours=3))
    h1 = out[1]
    assert h1["t"] == "2025-01-08T01:00:00Z"
    assert h1["wind_dir_deg"] == 0                    # vector mean of 350° and 10°, not 180°
    assert h1["wind_mph"] == pytest.approx(11.5, abs=0.1)
    assert h1["rh_pct"] == 15.0 and h1["temp_c"] == pytest.approx(10.6, abs=0.1)
    assert h1["gust_mph"] == pytest.approx(40 * 1.15078, abs=0.1)   # hour ending 01:00
    assert out[2]["wind_mph"] == 0.0 and out[2]["wind_dir_deg"] is None   # calm
    assert out[0]["wind_mph"] is None


def test_parse_dods_ascii():
    text = (
        "Dataset {\n    Grid {\n    } burning_index_g;\n} MET/bi/bi_2025.nc;\n"
        "---------------------------------------------\n"
        "burning_index_g.burning_index_g[2][1][2]\n[0][0], 54, 55\n[1][0], 0, 92\n\n"
        "burning_index_g.day[2]\n45661.0, 45662.0\n\n"
    )
    assert parse_dods_ascii(text, "burning_index_g") == [54, 55, 0, 92]
    assert parse_dods_ascii(text, "burning_index_g.day") == [45661.0, 45662.0]


def test_gridmet_days_end_at_07z():
    days = np.arange(45656.0, 45670.0)              # 2025-01-01 .. 2025-01-14
    start = datetime(2025, 1, 7, tzinfo=UTC)
    keep = gridmet_days(days, start, start + timedelta(days=1))
    # Jan 6 covers Jan 6 07Z → Jan 7 07Z, so it overlaps a window that starts Jan 7 00Z.
    assert [int(days[i]) - 45656 + 1 for i in keep] == [6, 7]


def test_flag_isolated_drops():
    rows = [{"erc": 86, "bi": 54}, {"erc": 62, "bi": 0}, {"erc": 88, "bi": 92}, {"erc": 80, "bi": 85}]
    flag_isolated_drops(rows)
    assert len(rows[1]["qc"]) == 2 and "qc" not in rows[2]


def test_bad_cached_response_is_discarded(tmp_path):
    dest = tmp_path / "asos.csv"
    dest.write_text("<html>Service unavailable</html>")

    def parse(body):
        if not body.startswith(b"station,"):
            raise SystemExit("unexpected response")
        return body

    with pytest.raises(SystemExit):
        _get("http://offline.invalid/", dest, parse=parse)   # cached, so no network call
    assert not dest.exists()


def test_grid_points_layout():
    pts = grid_points([-118.0, 34.0, -117.0, 35.0])
    assert len(pts) == 9 and pts[4] == [-117.5, 34.5]
    assert pts[0][1] > pts[6][1] and pts[0][0] < pts[2][0]   # north row first, west → east


# ---------------------------------------------------------------- contract


def test_weather_json_contract(fire):
    start, end, aoi = _window(fire)
    w = fire.read_json("weather.json")
    assert {"hourly", "daily", "source", "point"} <= w.keys() and w["source"]
    pad0, pad1 = start - timedelta(days=1), end + timedelta(days=1)
    assert w["window_utc"] == [pad0.strftime("%Y-%m-%dT%H:%M:%SZ"), pad1.strftime("%Y-%m-%dT%H:%M:%SZ")]
    a0, a1 = (_utc(t) for t in aoi["window_utc"])
    assert pad0 < a0 and a1 < pad1, "aoi.json window moved outside weather.json; rerun step 07"
    hourly = w["hourly"]
    assert len(hourly) == (pad1 - pad0) // timedelta(hours=1)
    ts = [_utc(h["t"]) for h in hourly]
    assert ts[0] == pad0 and all(b - a == timedelta(hours=1) for a, b in zip(ts, ts[1:]))
    for h in hourly:
        assert set(h) == {"t", "wind_mph", "wind_dir_deg", "gust_mph", "temp_c", "rh_pct"}
        assert 0 <= h["wind_mph"] < 120 and 0 <= h["gust_mph"] < 150
        assert 0 <= h["wind_dir_deg"] < 360 and 0 <= h["rh_pct"] <= 100 and -20 < h["temp_c"] < 45
    # ERA5-Land cells are 0.1°, so the snapped point stays within one cell of the AOI center.
    assert abs(w["point"][0] - aoi["center"][0]) <= 0.1 and abs(w["point"][1] - aoi["center"][1]) <= 0.1

    in_win = [h for h in hourly if start <= _utc(h["t"]) < end]
    assert w["summary"]["peak_gust_mph"] == max(h["gust_mph"] for h in in_win)
    assert w["summary"]["min_rh_pct"] == min(h["rh_pct"] for h in in_win)


def test_weather_daily_contract(fire):
    start, end, _ = _window(fire)
    daily = fire.read_json("weather.json")["daily"]
    dates = [datetime.fromisoformat(d["date"]).date() for d in daily]
    assert all(b - a == timedelta(days=1) for a, b in zip(dates, dates[1:]))
    assert dates[0] <= start.date() and dates[-1] >= (end - timedelta(hours=1)).date()
    for d in daily:
        assert {"date", "erc", "bi", "fm100", "fm1000"} <= d.keys()
        assert 0 <= d["erc"] <= 150 and 0 <= d["bi"] <= 300
        assert 1 <= d["fm100"] <= 40 and 1 <= d["fm1000"] <= 40
        assert d["erc_3x3"][0] <= d["erc"] <= d["erc_3x3"][1]


def test_station_contract_and_recomputed_stats(fire):
    start, end, aoi = _window(fire)
    w = fire.read_json("weather.json")
    s = fire.read_json("weather_station.json")
    assert {"station", "name", "lon", "lat", "hourly", "comparison"} <= s.keys()
    assert s["distance_km"] <= 40 and s["coverage"] >= 0.9
    assert [h["t"] for h in s["hourly"]] == [h["t"] for h in w["hourly"]]
    for h in s["hourly"]:
        assert set(h) == {"t", "wind_mph", "gust_mph", "wind_dir_deg", "rh_pct", "temp_c"}
        assert h["rh_pct"] is None or 0 <= h["rh_pct"] <= 100
        assert h["wind_dir_deg"] is None or 0 <= h["wind_dir_deg"] < 360
    assert distance_km(aoi["center"][0], aoi["center"][1], s["lon"], s["lat"]) == pytest.approx(
        s["distance_km"], abs=0.1)

    c = s["comparison"]
    keys = {"wind_bias_mph", "wind_corr", "rh_bias_pct", "rh_corr", "n_hours",
            "max_gust_station_mph", "max_gust_reanalysis_mph"}
    assert keys <= c.keys() and all(c[k] is not None for k in keys)
    assert -1 <= c["wind_corr"] <= 1 and -1 <= c["rh_corr"] <= 1
    n_win = (end - start) // timedelta(hours=1)
    assert c["n_hours"] >= 0.9 * n_win

    # Recompute from the two committed series (the reanalysis side is rounded to 0.1, hence tolerances).
    pairs = [(m, o) for m, o in zip(w["hourly"], s["hourly"])
             if start <= _utc(m["t"]) < end and o["wind_mph"] is not None]
    mw = np.array([m["wind_mph"] for m, _ in pairs])
    ow = np.array([o["wind_mph"] for _, o in pairs])
    assert len(pairs) == c["n_hours"]
    assert np.mean(mw - ow) == pytest.approx(c["wind_bias_mph"], abs=0.11)
    assert np.corrcoef(mw, ow)[0, 1] == pytest.approx(c["wind_corr"], abs=0.01)
    rh = [(m["rh_pct"], o["rh_pct"]) for m, o in zip(w["hourly"], s["hourly"])
          if start <= _utc(m["t"]) < end and o["rh_pct"] is not None]
    assert len(rh) == c["n_hours_rh"]
    assert np.mean([a - b for a, b in rh]) == pytest.approx(c["rh_bias_pct"], abs=0.11)
    gusts = [o["gust_mph"] for o in s["hourly"] if start <= _utc(o["t"]) < end and o["gust_mph"] is not None]
    assert max(gusts) == c["max_gust_station_mph"]
    assert c["max_gust_reanalysis_mph"] == w["summary"]["peak_gust_mph"]


def test_manifest_has_weather_sources(fire):
    sources = {s["layer"]: s for s in fire.read_json("manifest.json")["sources"]}
    for layer in ("Weather (hourly)", "Fire danger (daily)", "Weather station"):
        assert sources[layer]["status"] == "REAL"
    assert "ERA5" in sources["Weather (hourly)"]["source"]


def test_weather_grid_matches_center_series(fire):
    path = fire.work_dir / "weather_grid.json"
    if not path.exists():
        pytest.skip("work/<fire>/weather_grid.json is gitignored; run the step to create it")
    g = json.loads(path.read_text())
    w = fire.read_json("weather.json")
    aoi = fire.read_json("aoi.json")
    assert len(g["points"]) == 9 and np.allclose(g["points"][4], aoi["center"], atol=2e-6)
    assert g["t"] == [h["t"] for h in w["hourly"]]
    assert np.array(g["u_mps"]).shape == np.array(g["v_mps"]).shape == (9, len(g["t"]))
    u, v = np.array(g["u_mps"][4]), np.array(g["v_mps"][4])
    speed = np.array([h["wind_mph"] for h in w["hourly"]]) * MPH_TO_MPS
    assert np.allclose(np.hypot(u, v), speed, atol=0.06)
    dirs = np.array([h["wind_dir_deg"] for h in w["hourly"]])
    moving = speed > 1.0
    assert _ang(wind_dir_from(u, v)[moving], dirs[moving]).max() < 3
