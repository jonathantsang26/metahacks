"""Step 01: area of interest from the official final perimeter.

Reads the CAL FIRE 2025 perimeter for the configured fire and writes:
  final_perimeter.geojson  the final perimeter (name and acres only; no cause fields)
  aoi.json                 bbox (final perimeter + buffer), center, replay window, official acres

Run: uv run python -m steps.s01_aoi
"""

from __future__ import annotations

from datetime import datetime, timezone

import requests

from ember.config import load_fire
from ember.geo import arcgis_query_geojson, geometry_bounds, meters_per_degree
from ember.manifest import add_source

CALFIRE_2025 = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/"
    "2025_California_Fire_Perimeters_View/FeatureServer/0"
)
CALFIRE_INCIDENTS = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List"


def official_incident(fire) -> dict | None:
    """CAL FIRE's incident record: official start time and *reported* location.

    The reported location is where CAL FIRE pins the incident, not an investigated origin.
    Step 06 seeds its first interval with it; step 11 only ever uses it as an evaluation
    reference, never as a fitting input.
    """
    r = requests.get(CALFIRE_INCIDENTS, params={"inactive": "true", "year": fire.year}, timeout=60)
    r.raise_for_status()
    for inc in r.json():
        if inc.get("Name", "").strip().lower() == fire.name.lower():
            return {
                "start_utc": inc["Started"] if inc["Started"].endswith("Z") else inc["Started"] + "Z",
                "reported_location": [inc["Longitude"], inc["Latitude"]],
                "acres": inc.get("AcresBurned"),
                "url": inc.get("Url"),
                "source": "CAL FIRE incidents API",
            }
    return None


def _date(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def main() -> None:
    fire = load_fire()
    fc = arcgis_query_geojson(
        CALFIRE_2025,
        where=f"FIRE_NAME = '{fire.calfire_name}' AND YEAR_ = {fire.year}",
        out_fields="FIRE_NAME,GIS_ACRES,ALARM_DATE,CONT_DATE",
    )
    if not fc["features"]:
        raise SystemExit(f"No CAL FIRE perimeter found for {fire.calfire_name} {fire.year}")
    feat = max(fc["features"], key=lambda f: f["properties"].get("GIS_ACRES") or 0)
    p = feat["properties"]

    west, south, east, north = geometry_bounds(feat["geometry"])
    m_lon, m_lat = meters_per_degree((south + north) / 2)
    pad_lon = fire.buffer_km * 1000 / m_lon
    pad_lat = fire.buffer_km * 1000 / m_lat
    bbox = [west - pad_lon, south - pad_lat, east + pad_lon, north + pad_lat]

    fire.write_json(
        "final_perimeter.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": fire.name, "acres": p.get("GIS_ACRES")},
                    "geometry": feat["geometry"],
                }
            ],
        },
    )
    aoi = {
        "id": fire.id,
        "name": fire.name,
        "location": fire.location,
        "timezone": fire.timezone,
        "bbox": [round(v, 6) for v in bbox],
        "center": [round((bbox[0] + bbox[2]) / 2, 6), round((bbox[1] + bbox[3]) / 2, 6)],
        "window_utc": list(fire.window_utc),
        "official": {
            "final_acres": p.get("GIS_ACRES"),
            # CAL FIRE stores these as dates without a time of day.
            "alarm_date": _date(p.get("ALARM_DATE")),
            "containment_date": _date(p.get("CONT_DATE")),
            "incident": official_incident(fire),
        },
    }
    fire.write_json("aoi.json", aoi)
    if aoi["official"]["incident"]:
        add_source(
            fire,
            layer="Official start (reference)",
            source="CAL FIRE incidents API",
            url=aoi["official"]["incident"]["url"] or CALFIRE_INCIDENTS,
            status="REAL",
            notes="Official start time and reported incident location (not an investigated origin). "
                  "Seeds the first arrival interval; used only as an evaluation reference by the back-trace.",
        )
    add_source(
        fire,
        layer="Final perimeter",
        source="CAL FIRE 2025 California Fire Perimeters",
        url=CALFIRE_2025,
        status="REAL",
        notes="Final perimeter and official acres; used for the AOI and to validate Fire Area(t).",
    )

    w_km = (bbox[2] - bbox[0]) * m_lon / 1000
    h_km = (bbox[3] - bbox[1]) * m_lat / 1000
    print(f"{fire.name}: {p.get('GIS_ACRES'):,.0f} acres, AOI {w_km:.1f} × {h_km:.1f} km")
    print(f"bbox {aoi['bbox']}")
    print(f"wrote {fire.out_dir / 'aoi.json'}")


if __name__ == "__main__":
    main()
