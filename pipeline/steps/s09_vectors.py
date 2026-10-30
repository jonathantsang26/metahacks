"""Step 09: structures, roads, peaks, places and a street gazetteer.

Inputs:
  aoi.json, final_perimeter.geojson (step 01)
  CAL FIRE DINS damage inspections (ArcGIS FeatureServer, no key)
  OpenStreetMap via the Overpass API (no key)
Outputs (web/public/data/<fire>/):
  structures.geojson  DINS inspected structures as Points: {id, damage, structure_type,
                      structure_category, roof, eaves, vents, siding, window_pane, deck_on_grade,
                      deck_elevated, patio_cover, fence_attached, propane_tank_distance,
                      utility_structure_distance}. Address, parcel, owner, year-built, assessed
                      value and free-text fields are never requested from the server, so they
                      never reach raw/ or public/.
  roads.geojson       OSM roads, streets and named trails clipped to the AOI bbox:
                      LineStrings {name|null, highway}
  labels.json         [{name, kind: peak|place|water, lon, lat, ele_m}] (ele_m for peaks only)
  gazetteer.json      {"<normalized street>": {name, segments, bbox: [w, s, e, n]}} from roads.geojson
Raw responses are cached in raw/<fire>/vectors/.

Run: uv run python -m steps.s09_vectors
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import requests
import shapely
from shapely.geometry import LineString, MultiLineString, Point, Polygon, shape
from shapely.ops import polygonize, unary_union

from ember.config import Fire, load_fire
from ember.geo import meters_per_degree
from ember.manifest import add_source

USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"
DINS = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/"
    "POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0"
)
OVERPASS = "https://overpass-api.de/api/interpreter"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"

# ---------------------------------------------------------------- structures (DINS)

# The privacy allowlist: DINS field -> output key. Only these fields are requested (outFields),
# so street, city, zip, APN, owner, year built, assessed value and lat/lon attributes are never
# downloaded. Damage, construction and defensible-space attributes only.
DINS_FIELDS = {
    "OBJECTID": "id",
    "DAMAGE": "damage",
    "STRUCTURETYPE": "structure_type",
    "STRUCTURECATEGORY": "structure_category",
    "ROOFCONSTRUCTION": "roof",
    "EAVES": "eaves",
    "VENTSCREEN": "vents",
    "EXTERIORSIDING": "siding",
    "WINDOWPANE": "window_pane",
    "DECKPORCHONGRADE": "deck_on_grade",
    "DECKPORCHELEVATED": "deck_elevated",
    "PATIOCOVERCARPORT": "patio_cover",
    "FENCEATTACHEDTOSTRUCTURE": "fence_attached",
    "PROPANETANKDISTANCE": "propane_tank_distance",
    "UTILITYMISCSTRUCTUREDISTANCE": "utility_structure_distance",
}
STRUCTURE_KEYS = tuple(DINS_FIELDS.values())
# Belt and braces: no output key may even look like an identifying field.
PRIVATE_KEY = re.compile(r"addr|street|city|zip|apn|parcel|owner|year|value|comment|lat|lon", re.IGNORECASE)

DAMAGE_CLASSES = ("No Damage", "Affected", "Minor", "Major", "Destroyed", "Inaccessible")
COORD_DP = 5


def normalize_damage(raw: str | None) -> str:
    """'Destroyed (>50%)' -> 'Destroyed', 'Affected (>0-10%)' -> 'Affected', etc. Unknown values raise."""
    text = (raw or "").strip()
    for cls in DAMAGE_CLASSES:
        if text.lower().startswith(cls.lower()):
            return cls
    raise ValueError(f"unrecognized DINS damage value: {raw!r}")


def _clean(value):
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def build_structures(features: list[dict], bbox: list[float]) -> tuple[dict, dict]:
    """Allowlisted Point features inside bbox, plus counts of what was dropped and why."""
    west, south, east, north = bbox
    out, no_geom, outside = [], 0, 0
    for f in sorted(features, key=lambda f: f["properties"]["OBJECTID"]):
        g = f.get("geometry") or {}
        if g.get("type") != "Point" or not g.get("coordinates"):
            no_geom += 1
            continue
        lon, lat = (round(float(v), COORD_DP) for v in g["coordinates"][:2])
        if not (west <= lon <= east and south <= lat <= north):
            outside += 1
            continue
        p = f["properties"]
        props = {key: _clean(p.get(src)) for src, key in DINS_FIELDS.items()}
        props["damage"] = normalize_damage(p.get("DAMAGE"))
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": props})
    for feat in out:
        keys = set(feat["properties"])
        if keys != set(STRUCTURE_KEYS) or any(PRIVATE_KEY.search(k) for k in keys):
            raise AssertionError(f"structure properties outside the privacy allowlist: {sorted(keys)}")
    return {"type": "FeatureCollection", "features": out}, {"no_geometry": no_geom, "outside_bbox": outside}


# ---------------------------------------------------------------- HTTP


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def _request_json(session: requests.Session, method: str, url: str, *, retries: int = 5, **kw) -> dict:
    """JSON from an endpoint, retrying politely. ArcGIS reports errors as HTTP 200 + {"error": ...}
    and Overpass reports timeouts as HTTP 200 + a "remark", so both count as failures."""
    for attempt in range(retries):
        try:
            r = session.request(method, url, timeout=240, **kw)
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                raise RuntimeError(f"server error: {data['error']}")
            if "error" in str(data.get("remark", "")).lower():
                raise RuntimeError(f"Overpass: {data['remark']}")
            return data
        except (requests.RequestException, ValueError, RuntimeError) as e:
            if attempt == retries - 1:
                raise
            wait = 10 * 2**attempt
            print(f"  {url.split('/')[2]}: {e}; retrying in {wait}s")
            time.sleep(wait)
    raise AssertionError("unreachable")


def _digest(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:10]


def _cached(path: Path, fetch) -> dict:
    if path.exists() and path.stat().st_size > 0:
        return json.loads(path.read_text())
    data = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    return data


def fetch_dins(fire: Fire, session: requests.Session) -> list[dict]:
    """All DINS records for the fire, paged 2000 at a time and checked against the server count."""
    where = (f"UPPER(INCIDENTNAME) = '{fire.calfire_name.upper()}' "
             f"AND INCIDENTSTARTDATE >= DATE '{fire.year}-01-01' "
             f"AND INCIDENTSTARTDATE < DATE '{fire.year + 1}-01-01'")
    out_fields = ",".join(DINS_FIELDS)

    def fetch() -> dict:
        count = _request_json(session, "GET", f"{DINS}/query", params={
            "where": where, "returnCountOnly": "true", "f": "json"})["count"]
        features: list[dict] = []
        while len(features) < count:
            page = _request_json(session, "GET", f"{DINS}/query", params={
                "where": where, "outFields": out_fields, "outSR": 4326, "f": "geojson",
                "orderByFields": "OBJECTID", "resultOffset": len(features), "resultRecordCount": 2000})
            batch = page.get("features", [])
            if not batch:
                raise RuntimeError(f"DINS returned an empty page at offset {len(features)} of {count}")
            features.extend(batch)
        ids = {f["properties"]["OBJECTID"] for f in features}
        if len(features) != count or len(ids) != count:
            raise RuntimeError(f"DINS paging mismatch: {len(features)} rows, {len(ids)} ids, count {count}")
        return {"type": "FeatureCollection", "where": where, "count": count, "features": features}

    data = _cached(fire.raw_dir / "vectors" / f"dins_{_digest(where + out_fields)}.json", fetch)
    if not data["features"]:
        raise SystemExit(f"No DINS records for {fire.calfire_name} {fire.year}")
    return data["features"]


def overpass(fire: Fire, session: requests.Session, query: str, tag: str) -> dict:
    return _cached(fire.raw_dir / "vectors" / f"overpass_{tag}_{_digest(query)}.json",
                   lambda: _request_json(session, "POST", OVERPASS, data={"data": query}))


# ---------------------------------------------------------------- roads (OSM)

ROAD_CLASSES = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
                "residential", "living_street", "track")
TRAIL_CLASSES = ("path", "footway", "bridleway")
ROADS_MAX_BYTES = 3_000_000


def _overpass_bbox(bbox: list[float]) -> str:
    west, south, east, north = bbox
    return f"{south},{west},{north},{east}"


def roads_query(bbox: list[float]) -> str:
    b = _overpass_bbox(bbox)
    return (
        "[out:json][timeout:180];("
        f'way["highway"~"^({"|".join(ROAD_CLASSES)})$"]({b});'
        f'way["highway"~"^({"|".join(TRAIL_CLASSES)})$"]["name"]({b});'
        ");out geom tags;"
    )


def keep_way(tags: dict) -> bool:
    hw = tags.get("highway")
    if hw in ROAD_CLASSES:
        return tags.get("area") != "yes"
    # Named paths only when they are trails, not sidewalks or crossings tagged with a street name.
    return (hw in TRAIL_CLASSES and bool(tags.get("name")) and tags.get("area") != "yes"
            and tags.get("footway") not in ("sidewalk", "crossing"))


def _round_coords(coords) -> list[list[float]]:
    out: list[list[float]] = []
    for x, y in coords:
        pt = [round(x, COORD_DP), round(y, COORD_DP)]
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def _parts(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, LineString)]


def build_roads(elements: list[dict], bbox: list[float], tolerance: float) -> dict:
    """Clip each way to bbox; every clipped piece becomes its own LineString feature."""
    features = []
    for el in elements:
        if el.get("type") != "way" or len(el.get("geometry") or []) < 2 or not keep_way(el["tags"]):
            continue
        line = LineString([(p["lon"], p["lat"]) for p in el["geometry"]])
        for piece in _parts(shapely.clip_by_rect(line, *bbox)):
            coords = _round_coords(piece.simplify(tolerance).coords)
            if len(coords) < 2:
                continue
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"name": el["tags"].get("name"), "highway": el["tags"]["highway"]},
            })
    return {"type": "FeatureCollection", "features": features}


def _dump(data) -> str:
    return json.dumps(data, separators=(",", ":"))


def roads_within_budget(elements: list[dict], bbox: list[float]) -> tuple[dict, str, float]:
    """Simplify at ~1 m, then coarser only if needed to stay under ROADS_MAX_BYTES."""
    for tol in (1e-5, 2e-5, 4e-5, 8e-5):
        fc = build_roads(elements, bbox, tol)
        text = _dump(fc)
        if len(text.encode()) <= ROADS_MAX_BYTES:
            return fc, text, tol
    raise SystemExit(f"roads.geojson is {len(text) / 1e6:.1f} MB even at tolerance {tol}°")


# ---------------------------------------------------------------- labels (OSM)

PLACE_CLASSES = ("city", "town", "suburb", "neighbourhood", "village", "hamlet")
# Flowing water is a line, not a body; pools, fountains and treatment ponds are not landmarks.
WATER_EXCLUDE = {"stream", "river", "canal", "ditch", "drain", "wastewater", "pool",
                 "fountain", "reflecting_pool"}
WATER_MIN_M2 = 1000.0
# Numbered cells ("Spreading 10", "13") are operational IDs within a facility, not landmarks.
NUMBERED_UNIT = re.compile(r"(^|\s)\d+$")


def labels_query(bbox: list[float]) -> str:
    b = _overpass_bbox(bbox)
    return (
        "[out:json][timeout:180];("
        f'node["natural"="peak"]["name"]({b});'
        f'nwr["place"~"^({"|".join(PLACE_CLASSES)})$"]["name"]({b});'
        f'nwr["natural"="water"]["name"]({b});'
        f'nwr["landuse"="reservoir"]["name"]({b});'
        # Body verbosity (not `out tags geom`): relations need their member geometry.
        ");out geom;"
    )


def parse_ele(raw: str | None) -> float | None:
    """OSM ele tag -> meters. Accepts '1741', '1121.969', '5710 ft', "5,710'"; else None."""
    if not raw:
        return None
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*(m|ft|feet|')?\s*", raw.replace(",", ""))
    if not m:
        return None
    v = float(m[1]) * (0.3048 if m[2] in ("ft", "feet", "'") else 1.0)
    return round(v, 1)


def element_shape(el: dict):
    """Shapely geometry of an Overpass element returned with `out geom`."""
    if el["type"] == "node":
        return Point(el["lon"], el["lat"])
    if el["type"] == "way":
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry") or []]
        if len(pts) >= 4 and pts[0] == pts[-1]:
            return Polygon(pts)
        return LineString(pts) if len(pts) >= 2 else None
    # Relation: polygonize the outer rings (holes do not move a label much).
    lines = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
             for m in el.get("members", [])
             if m.get("type") == "way" and m.get("role") in ("outer", "") and len(m.get("geometry") or []) >= 2]
    polys = list(polygonize(lines))
    if polys:
        return unary_union(polys)
    return MultiLineString(lines) if lines else None


def label_point(geom) -> Point:
    """Centroid, or a point guaranteed inside when the centroid falls outside (crescent lakes)."""
    c = geom.centroid
    if geom.geom_type in ("Polygon", "MultiPolygon") and not geom.contains(c):
        return geom.representative_point()
    return c


def _area_m2(geom) -> float:
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        return 0.0
    m_lon, m_lat = meters_per_degree(geom.centroid.y)
    return geom.area * m_lon * m_lat


def _kind(tags: dict) -> str | None:
    if tags.get("natural") == "peak":
        return "peak"
    if tags.get("place") in PLACE_CLASSES:
        return "place"
    if tags.get("natural") == "water" or tags.get("landuse") == "reservoir":
        return "water"
    return None


def build_labels(elements: list[dict], bbox: list[float]) -> list[dict]:
    west, south, east, north = bbox
    points: dict[tuple[str, str], dict] = {}
    water: dict[str, list] = defaultdict(list)
    for el in elements:
        tags = el.get("tags", {})
        name, kind = (tags.get("name") or "").strip(), _kind(tags)
        if not name or kind is None:
            continue
        geom = element_shape(el)
        if geom is None or geom.is_empty:
            continue
        if kind == "water":
            if (tags.get("water") in WATER_EXCLUDE or tags.get("amenity") == "fountain"
                    or NUMBERED_UNIT.search(name)):
                continue
            water[name].append(geom)
            continue
        # Peaks and places: the first element wins; Overpass lists nodes before areas.
        if (name, kind) not in points:
            pt = label_point(geom)
            points[(name, kind)] = {"name": name, "kind": kind, "lon": pt.x, "lat": pt.y,
                                    "ele_m": parse_ele(tags.get("ele")) if kind == "peak" else None}
    for name, geoms in water.items():
        body = unary_union(geoms)
        if _area_m2(body) < WATER_MIN_M2:
            continue
        pt = label_point(body)
        points[(name, "water")] = {"name": name, "kind": "water", "lon": pt.x, "lat": pt.y, "ele_m": None}

    labels = []
    for lab in points.values():
        lab["lon"], lab["lat"] = round(lab["lon"], COORD_DP), round(lab["lat"], COORD_DP)
        if west <= lab["lon"] <= east and south <= lab["lat"] <= north:
            labels.append(lab)
    order = {"peak": 0, "place": 1, "water": 2}
    labels.sort(key=lambda d: (order[d["kind"]], -(d["ele_m"] or 0), d["name"]))
    return labels


# ---------------------------------------------------------------- gazetteer

STREET_WORDS = {"avenue": "ave", "street": "st", "road": "rd", "boulevard": "blvd", "drive": "dr",
                "lane": "ln", "place": "pl", "court": "ct", "canyon": "cyn", "mountain": "mtn"}
DIRECTIONS = {"north": "n", "south": "s", "east": "e", "west": "w"}


def normalize_street(name: str) -> str:
    """'North Lake Avenue' -> 'n lake ave'; 'Eaton Canyon Dr.' -> 'eaton cyn dr'. Idempotent."""
    s = re.sub(r"['’.]", "", name.lower())   # "St. John's" -> "st johns"
    tokens = re.sub(r"[\W_]+", " ", s).split()
    if tokens and tokens[0] in DIRECTIONS:
        tokens[0] = DIRECTIONS[tokens[0]]
    return " ".join(STREET_WORDS.get(t, t) for t in tokens)


def build_gazetteer(roads: dict) -> dict:
    names: dict[str, Counter] = defaultdict(Counter)
    boxes: dict[str, list[float]] = {}
    for f in roads["features"]:
        name = f["properties"]["name"]
        key = normalize_street(name) if name else ""
        if not key:
            continue
        names[key][name] += 1
        xs, ys = zip(*f["geometry"]["coordinates"])
        b = boxes.setdefault(key, [180.0, 90.0, -180.0, -90.0])
        b[:] = [min(b[0], *xs), min(b[1], *ys), max(b[2], *xs), max(b[3], *ys)]
    return {
        key: {
            # Display the most common spelling; ties go to the alphabetically first.
            "name": min(names[key].items(), key=lambda kv: (-kv[1], kv[0]))[0],
            "segments": sum(names[key].values()),
            "bbox": [round(v, COORD_DP) for v in boxes[key]],
        }
        for key in sorted(names)
    }


# ---------------------------------------------------------------- main


def damage_by_perimeter(structures: dict, perimeter: dict) -> dict[str, tuple[int, int]]:
    """{damage: (inside final perimeter, outside)} for the run report."""
    geom = unary_union([shape(f["geometry"]) for f in perimeter["features"]])
    lon, lat = np.array([f["geometry"]["coordinates"] for f in structures["features"]]).T
    inside = shapely.contains_xy(geom, lon, lat)
    damage = np.array([f["properties"]["damage"] for f in structures["features"]])
    return {d: (int((inside & (damage == d)).sum()), int((~inside & (damage == d)).sum()))
            for d in DAMAGE_CLASSES}


def main() -> None:
    fire = load_fire()
    bbox = fire.read_json("aoi.json")["bbox"]
    session = _session()

    dins = fetch_dins(fire, session)
    structures, dropped = build_structures(dins, bbox)
    (fire.out_dir / "structures.geojson").write_text(_dump(structures) + "\n")

    road_resp = overpass(fire, session, roads_query(bbox), "roads")
    roads, roads_text, tol = roads_within_budget(road_resp["elements"], bbox)
    (fire.out_dir / "roads.geojson").write_text(roads_text + "\n")

    label_resp = overpass(fire, session, labels_query(bbox), "labels")
    labels = build_labels(label_resp["elements"], bbox)
    (fire.out_dir / "labels.json").write_text(json.dumps(labels, indent=2) + "\n")

    gazetteer = build_gazetteer(roads)
    (fire.out_dir / "gazetteer.json").write_text(_dump(gazetteer) + "\n")

    n_struct = len(structures["features"])
    add_source(
        fire,
        layer="Structures (damage inspection)",
        source="CAL FIRE DINS (Damage Inspection), POSTFIRE_MASTER_DATA_SHARE",
        url=DINS,
        status="REAL",
        notes=("address, parcel, owner and year-built fields deliberately dropped. "
               f"{n_struct:,} of {len(dins):,} inspected structures kept "
               f"({dropped['outside_bbox']} outside the AOI bbox, {dropped['no_geometry']} without a location); "
               "only damage, construction and defensible-space fields are requested from the server."),
    )
    kinds = Counter(lab["kind"] for lab in labels)
    osm_base = road_resp.get("osm3s", {}).get("timestamp_osm_base", "unknown")
    add_source(
        fire,
        layer="Roads, peaks & places",
        source="OpenStreetMap via the Overpass API",
        url=OSM_COPYRIGHT,
        status="REAL",
        attribution="(c) OpenStreetMap contributors (ODbL)",
        notes=(f"{len(roads['features']):,} road/trail segments clipped to the AOI (simplified at {tol:g}°), "
               f"{kinds['peak']} peaks, {kinds['place']} places, {kinds['water']} water bodies; "
               f"{len(gazetteer):,} named streets in gazetteer.json. Current OSM (data as of {osm_base}), "
               "not a pre-fire snapshot."),
    )

    print(f"{fire.name}: {n_struct:,}/{len(dins):,} structures in bbox "
          f"(dropped {dropped['outside_bbox']} outside, {dropped['no_geometry']} no geometry)")
    print(f"  {'damage':<13}{'inside':>8}{'outside':>9}   (final perimeter)")
    for d, (i, o) in damage_by_perimeter(structures, fire.read_json("final_perimeter.geojson")).items():
        print(f"  {d:<13}{i:>8,}{o:>9,}")
    print(f"  structure keys: {', '.join(STRUCTURE_KEYS)}")
    print(f"roads: {len(roads['features']):,} segments, {len(roads_text) / 1e6:.2f} MB, tol {tol:g}°; "
          f"{len(gazetteer):,} named streets")
    print(f"labels: {dict(kinds)}")
    for lab in labels:
        if lab["kind"] == "peak":
            print(f"  peak {lab['name']}: " + (f"{lab['ele_m']} m" if lab["ele_m"] is not None else "no ele tag"))
    print(f"wrote structures.geojson, roads.geojson, labels.json, gazetteer.json to {fire.out_dir}")


if __name__ == "__main__":
    main()
