"""Step 04: NASA FIRMS active-fire detections in the AOI and replay window.

Needs a free FIRMS MAP_KEY (FIRMS_MAP_KEY in the environment or the repo-root .env). Without
it the step exits cleanly and step 06 interpolates between perimeters alone.

Inputs:  aoi.json (bbox, window)
Outputs: hotspots.geojson  Points with properties {t (UTC ISO), frp, confidence, satellite, source}
Sources: VIIRS 375 m on Suomi NPP, NOAA-20 and NOAA-21 (standard/science-quality "_SP"
         products where available, near-real-time otherwise) and MODIS. The area API returns at
         most 5 days per call, so the window is fetched in chunks.

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
SOURCES = ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT", "MODIS_SP"]


def map_key() -> str | None:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    env = REPO_DIR / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    return key or None


def fetch(key: str, source: str, bbox: list[float], start: datetime, end: datetime) -> list[dict]:
    rows, day = [], start
    while day <= end:
        days = min(5, (end - day).days + 1)
        url = API.format(key=key, source=source, bbox=",".join(f"{v:.4f}" for v in bbox),
                         days=days, date=day.strftime("%Y-%m-%d"))
        r = requests.get(url, timeout=120)
        r.raise_for_status()
        if r.text.lstrip().startswith(("Invalid", "Error")):
            raise RuntimeError(f"FIRMS {source}: {r.text[:200]}")
        rows += list(csv.DictReader(io.StringIO(r.text)))
        day += timedelta(days=days)
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
    features = []
    for source in SOURCES:
        try:
            features += [to_feature(r, source) for r in fetch(key, source, aoi["bbox"], start, end)]
        except (requests.RequestException, RuntimeError) as err:
            print(f"{source}: {err}")
    features.sort(key=lambda f: f["properties"]["t"])
    fire.write_json("hotspots.geojson", {"type": "FeatureCollection", "features": features})
    add_source(fire, layer="Active-fire detections", source="NASA FIRMS (VIIRS 375 m, MODIS)",
               url="https://firms.modaps.eosdis.nasa.gov/", status="REAL",
               notes=f"{len(features)} detections from {', '.join(SOURCES)}.")
    print(f"{len(features)} detections")


if __name__ == "__main__":
    main()
