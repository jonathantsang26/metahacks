"""Step 04 unit tests: offline. No FIRMS_MAP_KEY is needed; requests.get is replaced, so nothing is
sent to FIRMS. Covers the source list (NOAA-20 and NOAA-21 by default, Suomi NPP's archive only
for windows before its cutoff), the area-API request URLs, and the step end to end in a temp dir."""

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone

import pytest

from steps import s04_firms as s04

UTC = timezone.utc
KEY = "test-map-key-0123"
BBOX = [-118.183793, 34.143926, -117.991329, 34.255798]
PREFIX = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/"


def _utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _parts(url):
    """(key, source, bbox, days, date) from an area-API URL."""
    assert url.startswith(PREFIX)
    key, source, bbox, days, day = url[len(PREFIX):].split("/")
    return key, source, bbox, int(days), date.fromisoformat(day)


def _days_covered(urls):
    out = []
    for url in urls:
        _, _, _, days, day = _parts(url)
        out += [day + timedelta(days=i) for i in range(days)]
    return out


def _window(fire):
    aoi = fire.read_json("aoi.json")
    w0, w1 = (_utc(s) for s in aoi["window_utc"])
    return w0, w1, aoi


def test_default_sources_are_noaa20_and_noaa21_not_snpp():
    assert s04.SOURCES == ["VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT", "MODIS_SP"]
    assert not any("SNPP" in s for s in s04.SOURCES)
    assert s04.SNPP_SOURCE == "VIIRS_SNPP_SP"
    assert s04.SNPP_END == datetime(2026, 11, 2, 15, 40, tzinfo=UTC)


def test_one_product_per_satellite():
    # SP and NRT of the same satellite would return the same detections twice; the step does not
    # merge them, so the list must never hold both.
    def satellite(source):
        return source.rsplit("_", 1)[0]

    for start, end in [(datetime(2025, 1, 7, tzinfo=UTC), datetime(2025, 1, 14, tzinfo=UTC)),
                       (datetime(2026, 12, 1, tzinfo=UTC), datetime(2026, 12, 6, tzinfo=UTC))]:
        names = [s for s, _ in s04.sources_for(start, end)]
        assert len({satellite(s) for s in names}) == len(names)


def test_historical_window_keeps_snpp_archive(fire):
    w0, w1, _ = _window(fire)
    plan = s04.sources_for(w0, w1)
    assert [s for s, _ in plan] == s04.SOURCES + [s04.SNPP_SOURCE]
    assert all(last == w1 for _, last in plan)  # Jan 2025 ends long before the cutoff


def test_window_after_cutoff_drops_snpp():
    for start in (s04.SNPP_END, datetime(2026, 12, 1, tzinfo=UTC)):
        plan = s04.sources_for(start, start + timedelta(days=4))
        assert [s for s, _ in plan] == s04.SOURCES
        assert all(last == start + timedelta(days=4) for _, last in plan)


def test_window_across_cutoff_asks_snpp_only_up_to_it():
    start, end = datetime(2026, 10, 30, 6, tzinfo=UTC), datetime(2026, 11, 5, tzinfo=UTC)
    plan = dict(s04.sources_for(start, end))
    assert plan[s04.SNPP_SOURCE] == s04.SNPP_END
    assert all(plan[s] == end for s in s04.SOURCES)
    urls = s04.request_urls(KEY, s04.SNPP_SOURCE, BBOX, start, plan[s04.SNPP_SOURCE])
    assert max(_days_covered(urls)) == date(2026, 11, 2)


def test_request_url_format():
    urls = s04.request_urls(KEY, "VIIRS_NOAA20_SP", BBOX, datetime(2025, 1, 8, tzinfo=UTC),
                            datetime(2025, 1, 13, tzinfo=UTC))
    assert urls == [
        f"{PREFIX}{KEY}/VIIRS_NOAA20_SP/-118.1838,34.1439,-117.9913,34.2558/5/2025-01-08",
        f"{PREFIX}{KEY}/VIIRS_NOAA20_SP/-118.1838,34.1439,-117.9913,34.2558/1/2025-01-13",
    ]


def test_request_urls_cover_each_window_day_once(fire):
    w0, w1, aoi = _window(fire)
    bbox = ",".join(f"{v:.4f}" for v in aoi["bbox"])
    for source, last in s04.sources_for(w0, w1):
        urls = s04.request_urls(KEY, source, aoi["bbox"], w0, last)
        for url in urls:
            key, src, b, days, _ = _parts(url)
            assert (key, src, b) == (KEY, source, bbox) and 1 <= days <= s04.MAX_DAYS
        days = _days_covered(urls)
        span = (last.date() - w0.date()).days + 1
        assert days == [w0.date() + timedelta(days=i) for i in range(span)]


def test_request_urls_use_whole_utc_days():
    # a window that starts late in a day and ends early in another still asks for the last day
    urls = s04.request_urls(KEY, "VIIRS_NOAA21_NRT", BBOX, datetime(2025, 1, 7, 18, tzinfo=UTC),
                            datetime(2025, 1, 10, 6, tzinfo=UTC))
    assert _days_covered(urls) == [date(2025, 1, 7) + timedelta(days=i) for i in range(4)]
    assert len(urls) == 1 and _parts(urls[0])[3] == 4


class _Response:
    def __init__(self, text, status_code=200, url=""):
        self.text, self.status_code, self.url = text, status_code, url

    def raise_for_status(self):
        if self.status_code >= 400:
            raise s04.requests.HTTPError(f"{self.status_code} Client Error: Bad Request for url: {self.url}")


def _fake_firms(calls, fail=()):
    """Stands in for requests.get: one detection per requested day, at an hour that encodes the
    source, so the merged list can be checked for order and provenance. Sources in `fail` answer
    the way FIRMS answers an unknown source."""
    hour = {s: 10 + i for i, s in enumerate(s04.SOURCES + [s04.SNPP_SOURCE])}

    def get(url, timeout):
        calls.append(url)
        _, source, _, days, day = _parts(url)
        if source in fail:
            return _Response("Invalid source: " + source)
        buf = io.StringIO()
        w = csv.DictWriter(buf, ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp"])
        w.writeheader()
        for i in range(days):
            w.writerow({"latitude": 34.2, "longitude": -118.1, "acq_date": (day + timedelta(days=i)).isoformat(),
                        "acq_time": f"{hour[source]}05", "satellite": source.split("_")[1], "confidence": "n",
                        "frp": 5.5})
        return _Response(buf.getvalue())
    return get


def test_fetch_parses_rows_from_every_chunk(monkeypatch):
    calls = []
    monkeypatch.setattr(s04.requests, "get", _fake_firms(calls))
    rows = s04.fetch(KEY, "VIIRS_NOAA20_SP", BBOX, datetime(2025, 1, 8, tzinfo=UTC), datetime(2025, 1, 13, tzinfo=UTC))
    assert len(calls) == 2 and len(rows) == 6
    f = s04.to_feature(rows[-1], "VIIRS_NOAA20_SP")
    assert f["properties"]["t"] == "2025-01-13T10:05:00Z" and f["properties"]["source"] == "VIIRS_NOAA20_SP"


def test_fetch_errors_never_carry_the_key(monkeypatch):
    def get(url, timeout):
        return _Response("", status_code=400, url=url)

    monkeypatch.setattr(s04.requests, "get", get)
    with pytest.raises(RuntimeError) as err:
        s04.fetch(KEY, "VIIRS_NOAA20_SP", BBOX, datetime(2025, 1, 8, tzinfo=UTC), datetime(2025, 1, 9, tzinfo=UTC))
    assert KEY not in str(err.value) and "<FIRMS_MAP_KEY>" in str(err.value)
    monkeypatch.setattr(s04.requests, "get", _fake_firms([], fail={"VIIRS_SNPP_SP"}))
    with pytest.raises(RuntimeError, match="Invalid source"):
        s04.fetch(KEY, "VIIRS_SNPP_SP", BBOX, datetime(2025, 1, 8, tzinfo=UTC), datetime(2025, 1, 9, tzinfo=UTC))


class _TmpFire:
    """The fire's id and aoi.json, with outputs written to a temp dir instead of web/public/data."""

    def __init__(self, fire, out_dir):
        self.id, self.out_dir = fire.id, out_dir
        (out_dir / "aoi.json").write_text(json.dumps(fire.read_json("aoi.json")))

    def read_json(self, name):
        return json.loads((self.out_dir / name).read_text())

    def write_json(self, name, data):
        (self.out_dir / name).write_text(json.dumps(data))


@pytest.mark.parametrize("fail", [(), ("VIIRS_SNPP_SP",)])
def test_step_end_to_end(fire, tmp_path, monkeypatch, capsys, fail):
    tmp = _TmpFire(fire, tmp_path)
    calls = []
    monkeypatch.setattr(s04, "load_fire", lambda: tmp)
    monkeypatch.setenv("FIRMS_MAP_KEY", KEY)
    monkeypatch.setattr(s04.requests, "get", _fake_firms(calls, fail=set(fail)))
    s04.main()
    w0, w1, _ = _window(fire)
    used = [s for s, _ in s04.sources_for(w0, w1) if s not in fail]
    asked = {_parts(u)[1] for u in calls}
    assert asked == set(s04.SOURCES) | {s04.SNPP_SOURCE}
    feats = tmp.read_json("hotspots.geojson")["features"]
    n_days = (w1.date() - w0.date()).days + 1
    assert len(feats) == n_days * len(used)
    assert [f["properties"]["source"] for f in feats[:len(used)]] == used  # first day, by hour
    ts = [f["properties"]["t"] for f in feats]
    assert ts == sorted(ts)
    entry = next(s for s in tmp.read_json("manifest.json")["sources"] if s["layer"] == "Active-fire detections")
    assert entry["notes"] == f"{len(feats)} detections from {', '.join(used)}."
    assert KEY not in (tmp_path / "manifest.json").read_text() + (tmp_path / "hotspots.geojson").read_text()
    out = capsys.readouterr().out
    assert ("Invalid source: VIIRS_SNPP_SP" in out) == bool(fail) and KEY not in out


def test_step_without_key_writes_nothing(fire, tmp_path, monkeypatch, capsys):
    tmp = _TmpFire(fire, tmp_path)
    monkeypatch.setattr(s04, "load_fire", lambda: tmp)
    monkeypatch.setattr(s04, "REPO_DIR", tmp_path)  # no .env to fall back on
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    monkeypatch.setattr(s04.requests, "get", lambda *a, **k: pytest.fail("no request without a key"))
    s04.main()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["aoi.json"]
    assert "FIRMS_MAP_KEY not set" in capsys.readouterr().out
