"""Key events are derived, ordered and traceable to a source."""

KINDS = {"reported_start", "ignition_estimate", "rapid_growth", "spot_fire", "ridge_crossing", "peak_gust", "containment"}


def test_events_are_ordered_unique_and_sourced(fire):
    events = fire.read_json("events.json")
    assert events and [e["t"] for e in events] == sorted(e["t"] for e in events)
    assert len({e["id"] for e in events}) == len(events)
    for e in events:
        assert e["kind"] in KINDS and e["source"] and e["label"]
        assert -180 <= e["lon"] <= 180 and -90 <= e["lat"] <= 90


def test_reported_start_matches_cal_fire(fire):
    inc = fire.read_json("aoi.json")["official"]["incident"]
    start = [e for e in fire.read_json("events.json") if e["kind"] == "reported_start"]
    assert start and start[0]["t"] == inc["start_utc"]
