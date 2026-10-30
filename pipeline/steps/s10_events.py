"""Step 10: key events, derived from the data rather than typed in.

Inputs:  aoi.json, series.json + spine.geojson + profile.json (06), work/<fire>/arrival_hours.npy,
         spots.geojson (05), weather.json (07), ignition.json (11, optional),
         hotspots.geojson (04, optional)
Outputs: events.json  [{id, kind, label, t, lon, lat, source, date_only?}] sorted by time

Kinds: reported_start, ignition_estimate, rapid_growth, spot_fire, ridge_crossing, peak_gust,
containment. Each event records the file or service it was derived from.

Run: uv run python -m steps.s10_events
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
from shapely.geometry import shape

from ember.config import load_fire
from ember.grid import Grid
from ember.manifest import add_source
from steps.s06_arrival import iso, parse_t

RIDGE_PROMINENCE_M = 40.0
SPOT_MIN_ACRES = 2.0


def event(kind, label, t, lonlat, source, **extra):
    return {"kind": kind, "label": label, "t": t, "lon": round(float(lonlat[0]), 6),
            "lat": round(float(lonlat[1]), 6), "source": source, **extra}


def rapid_growth(fire, grid: Grid, w0: datetime):
    s = fire.read_json("series.json")
    area = np.array(s["area_acres"])
    growth = np.diff(area)
    i = int(np.argmax(growth))
    arrival = np.load(fire.work_dir / "arrival_hours.npy")
    rows, cols = np.nonzero((arrival > i) & (arrival <= i + 1))
    lonlat = grid.to_lonlat(cols.mean(), rows.mean()) if len(rows) else fire.read_json("aoi.json")["center"]
    return event("rapid_growth", f"Rapid growth (+{growth[i]:,.0f} acres/h)", s["t"][i + 1], lonlat, "series.json")


def first_spot(fire, w1: datetime):
    path = fire.out_dir / "spots.geojson"
    if not path.exists():
        return None
    spots = [f for f in json.loads(path.read_text())["features"] if parse_t(f["properties"]["t"]) <= w1]
    # Skip slivers and near-perfect circles: the archive holds 50 ft buffers around points that
    # are not mapped spot fires.
    def plausible(f):
        g = shape(f["geometry"])
        circularity = 4 * np.pi * g.area / max(g.length, 1e-12) ** 2
        return (f["properties"].get("acres") or 0) >= SPOT_MIN_ACRES and circularity < 0.95
    spots = [f for f in spots if plausible(f)]
    if not spots:
        return None
    f = min(spots, key=lambda f: f["properties"]["t"])
    c = shape(f["geometry"]).centroid
    acres = f["properties"].get("acres") or 0
    return event("spot_fire", f"Spot fire mapped ({acres:.0f} acre{'' if round(acres) == 1 else 's'})",
                 f["properties"]["t"], (c.x, c.y), "spots.geojson (NIFC perimeters)")


def ridge_crossing(fire):
    prof = fire.read_json("profile.json")
    z = np.array(prof["elevation_m"])
    spine = next(f for f in fire.read_json("spine.geojson")["features"] if f["properties"]["kind"] == "spine")
    coords = spine["geometry"]["coordinates"]
    d = np.array(prof["distance_km"])
    total = d[-1] if d[-1] > 0 else 1.0
    for i in range(1, len(z) - 1):
        left, right = z[:i].min(), z[i + 1:].min()
        if z[i] == z[max(0, i - 3):i + 4].max() and z[i] - max(left, right) >= RIDGE_PROMINENCE_M:
            pt = coords[min(int(round(d[i] / total * (len(coords) - 1))), len(coords) - 1)]
            return event("ridge_crossing", f"Ridge crossing ({z[i]:,.0f} m)", prof["t"][i], pt, "profile.json")
    return None


def main() -> None:
    fire = load_fire()
    aoi = fire.read_json("aoi.json")
    grid = Grid.for_fire(fire)
    w0, w1 = (parse_t(s) for s in aoi["window_utc"])
    tz = ZoneInfo(aoi["timezone"])
    events = []

    inc = aoi["official"].get("incident")
    if inc:
        events.append(event("reported_start", "Reported start (CAL FIRE)", inc["start_utc"],
                            inc["reported_location"], "CAL FIRE incidents API"))
    ign = fire.out_dir / "ignition.json"
    if ign.exists():
        m = json.loads(ign.read_text())["map"]
        events.append(event("ignition_estimate", "Ignition (est.)", m["t"], (m["lon"], m["lat"]),
                            "ignition.json (back-trace estimate)"))
    events.append(rapid_growth(fire, grid, w0))
    for e in (first_spot(fire, w1), ridge_crossing(fire)):
        if e:
            events.append(e)

    hourly = [h for h in fire.read_json("weather.json")["hourly"] if w0 <= parse_t(h["t"]) <= w1]
    peak = max(hourly, key=lambda h: h.get("gust_mph") or 0)
    events.append(event("peak_gust", f"Peak gust {peak['gust_mph']:.0f} mph (reanalysis)", peak["t"],
                        aoi["center"], "weather.json (ERA5 via Open-Meteo)"))

    cont = aoi["official"].get("containment_date")
    if cont:
        local_noon = datetime.fromisoformat(cont).replace(hour=12, tzinfo=tz)
        events.append(event("containment", "Containment (CAL FIRE)", iso(local_noon), aoi["center"],
                            "CAL FIRE 2025 perimeters", date_only=True))

    events.sort(key=lambda e: e["t"])
    for i, e in enumerate(events):
        e["id"] = f"e{i + 1}"
    fire.write_json("events.json", events)
    add_source(fire, layer="Key events", source="Derived from series, perimeters, spine, weather and CAL FIRE",
               url="", status="MODELED", notes=", ".join(e["kind"] for e in events))
    for e in events:
        print(f"{e['t']}  {e['kind']:<18} {e['label']}")


if __name__ == "__main__":
    main()
