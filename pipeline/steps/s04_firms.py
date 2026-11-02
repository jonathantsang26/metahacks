"""Step 04: NASA FIRMS active-fire detections in the AOI and replay window.

Needs a free FIRMS MAP_KEY (FIRMS_MAP_KEY in the environment or the repo-root .env). Without
it the step exits cleanly and step 06 interpolates between perimeters alone.

Inputs:  aoi.json (bbox, window)
Outputs: hotspots.geojson  Points with properties {t (UTC ISO), frp, confidence, satellite, source}
Sources: VIIRS 375 m on NOAA-20 (standard/science-quality "_SP") and NOAA-21 (near real time), and
         MODIS. Suomi NPP's VIIRS active-fire data end at 15:40 UTC on 2 Nov 2026 (NOAA notice of
         30 Oct 2026); FIRMS's transition notice says what it observed before then stays available,
         so its "_SP" archive is asked only for windows that start before that cutoff, and only up
         to it. Each satellite comes from exactly one product, so no detection is returned twice.
         The area API returns at most 5 days per call, so the window is fetched in chunks of whole
         UTC days.

Run: uv run python -m steps.s04_firms
"""

from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timedelta, timezone

import requests

from ember.config import REPO_DIR, load_fire
from ember.manifest import add_source

API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
MAX_DAYS = 5  # the area API's DAY_RANGE limit
SOURCES = ["VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT", "MODIS_SP"]
SNPP_SOURCE = "VIIRS_SNPP_SP"  # historical windows only
SNPP_END = datetime(2026, 11, 2, 15, 40, tzinfo=timezone.utc)


def map_key() -> str | None:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    env = REPO_DIR / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    return key or None


def sources_for(start: datetime, end: datetime) -> list[tuple[str, datetime]]:
    """(FIRMS source, last instant to ask it for) for a replay window: NOAA-20, NOAA-21 and MODIS
    always, Suomi NPP's archive only when the window starts before S-NPP's cutoff."""
    out = [(source, end) for source in SOURCES]
    if start < SNPP_END:
        out.append((SNPP_SOURCE, min(end, SNPP_END)))
    return out


def request_urls(key: str, source: str, bbox: list[float], start: datetime, end: datetime) -> list[str]:
    """Area-API URLs covering every UTC day from start's to end's, at most MAX_DAYS per call."""
    urls, day, last = [], start.date(), end.date()
    while day <= last:
        days = min(MAX_DAYS, (last - day).days + 1)
        urls.append(API.format(key=key, source=source, bbox=",".join(f"{v:.4f}" for v in bbox),
                               days=days, date=day.isoformat()))
        day += timedelta(days=days)
    return urls


def fetch(key: str, source: str, bbox: list[float], start: datetime, end: datetime) -> list[dict]:
    rows = []
    for url in request_urls(key, source, bbox, start, end):
        try:
            r = requests.get(url, timeout=120)
            r.raise_for_status()
        except requests.RequestException as err:  # the message carries the URL, so drop the key
            msg = str(err).replace(key, "<FIRMS_MAP_KEY>") if key else str(err)
            raise RuntimeError(f"FIRMS {source}: {msg}") from None
        if r.text.lstrip().startswith(("Invalid", "Error")):
            raise RuntimeError(f"FIRMS {source}: {r.text[:200]}")
        rows += list(csv.DictReader(io.StringIO(r.text)))
    return rows


def to_feature(row: dict, source: str) -> dict:
    hhmm = row["acq_time"].zfill(4)
    t = datetime.strptime(f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
        "properties": {
            "t": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "frp": float(row.get("frp") or 0),
            "confidence": row.get("confidence"),
            "satellite": row.get("satellite") or source,
            "source": source,
        },
    }


def main() -> None:
    fire = load_fire()
    key = map_key()
    if not key:
        print("FIRMS_MAP_KEY not set: skipping hotspots (step 06 uses perimeters only).")
        return
    aoi = fire.read_json("aoi.json")
    start, end = (datetime.fromisoformat(s.replace("Z", "+00:00")) for s in aoi["window_utc"])
    features, used = [], []
    for source, last in sources_for(start, end):
        try:
            features += [to_feature(r, source) for r in fetch(key, source, aoi["bbox"], start, last)]
            used.append(source)
        except RuntimeError as err:
            print(err)
    features.sort(key=lambda f: f["properties"]["t"])
    fire.write_json("hotspots.geojson", {"type": "FeatureCollection", "features": features})
    add_source(fire, layer="Active-fire detections", source="NASA FIRMS (VIIRS 375 m, MODIS)",
               url="https://firms.modaps.eosdis.nasa.gov/", status="REAL",
               notes=f"{len(features)} detections from {', '.join(used) or 'no source'}.")
    print(f"{len(features)} detections")


if __name__ == "__main__":
    main()
