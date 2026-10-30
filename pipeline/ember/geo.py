"""Small geo helpers: Web Mercator tile math, terrarium encoding, ArcGIS queries."""

from __future__ import annotations

import math
import time
from pathlib import Path

import numpy as np
import requests

TILE = 256
EARTH_R = 6378137.0

# ---------------------------------------------------------------- tiles


def lonlat_to_global_px(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Global Web Mercator pixel coordinates at zoom z (origin top-left)."""
    n = TILE * 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def meters_per_degree(lat: float) -> tuple[float, float]:
    """(m per degree lon, m per degree lat) at a latitude."""
    m_lat = math.pi * EARTH_R / 180.0
    return m_lat * math.cos(math.radians(lat)), m_lat


def fetch_cached(url: str, dest: Path, *, retries: int = 3) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            dest.write_bytes(r.content)
            return dest
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return dest


# ---------------------------------------------------------------- terrarium


def terrarium_decode(rgb: np.ndarray) -> np.ndarray:
    """RGB uint8 (H, W, 3) -> elevation in meters (float32)."""
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    return r * 256.0 + g + b / 256.0 - 32768.0


def terrarium_encode(elev: np.ndarray) -> np.ndarray:
    """Elevation in meters -> RGB uint8 (H, W, 3), same scheme deck.gl decodes with
    elevationDecoder {rScaler: 256, gScaler: 1, bScaler: 1/256, offset: -32768}."""
    v = np.clip(elev.astype(np.float64) + 32768.0, 0, 65535.996)
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - r * 256.0 - g) * 256.0)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


# ---------------------------------------------------------------- ArcGIS


def arcgis_query_geojson(layer_url: str, where: str, out_fields: str, *, page: int = 2000) -> dict:
    """Page through an ArcGIS FeatureServer layer and return one GeoJSON FeatureCollection."""
    features: list[dict] = []
    offset = 0
    while True:
        r = requests.get(
            f"{layer_url}/query",
            params={
                "where": where,
                "outFields": out_fields,
                "outSR": 4326,
                "f": "geojson",
                "resultOffset": offset,
                "resultRecordCount": page,
            },
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json().get("features", [])
        features.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return {"type": "FeatureCollection", "features": features}


def geometry_bounds(geom: dict) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a GeoJSON Polygon/MultiPolygon."""
    coords = geom["coordinates"]
    rings = coords if geom["type"] == "Polygon" else [ring for poly in coords for ring in poly]
    xs = [p[0] for ring in rings for p in ring]
    ys = [p[1] for ring in rings for p in ring]
    return min(xs), min(ys), max(xs), max(ys)
