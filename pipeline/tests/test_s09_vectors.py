"""Step 09 contract tests: structures, roads, labels and gazetteer (offline, committed outputs)."""

import json
from functools import cache

import numpy as np
import pytest
import shapely
from PIL import Image
from shapely.geometry import shape
from shapely.ops import unary_union

from ember.config import load_fire
from ember.geo import terrarium_decode
from steps.s09_vectors import (
    DAMAGE_CLASSES,
    ROAD_CLASSES,
    STRUCTURE_KEYS,
    TRAIL_CLASSES,
    build_structures,
    keep_way,
    normalize_damage,
    normalize_street,
    parse_ele,
)

# Written independently of the step's own regex, so a bad edit there cannot hide a leak.
FORBIDDEN = ("addr", "street", "city", "zip", "apn", "parcel", "owner", "year", "assess",
             "value", "comment", "lat", "lon", "community", "globalid")
DINS_PRIVATE_FIELDS = ("SITEADDRESS", "STREETNAME", "STREETNUMBER", "ZIPCODE", "APN",
                       "YEARBUILT", "ASSESSEDIMPROVEDVALUE", "CITY", "COMMUNITY")
EPS = 6e-6  # coordinates are rounded to 5 dp after clipping to a 6 dp bbox


@cache
def _load(fire_id: str, name: str):
    return json.loads((load_fire(fire_id).out_dir / name).read_text())


def _in_bbox(lon, lat, bbox, eps=0.0):
    w, s, e, n = bbox
    return w - eps <= lon <= e + eps and s - eps <= lat <= n + eps


# ---------------------------------------------------------------- structures


def test_structures_keys_are_privacy_safe(fire):
    raw = (fire.out_dir / "structures.geojson").read_text()
    assert not any(f in raw for f in DINS_PRIVATE_FIELDS)
    fc = _load(fire.id, "structures.geojson")
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) > 1000
    keys = set()
    for f in fc["features"]:
        keys |= set(f["properties"])
        assert set(f["properties"]) == set(STRUCTURE_KEYS)
    assert {"id", "damage", "structure_type", "roof", "eaves", "vents", "siding"} <= keys
    assert not [k for k in keys if any(bad in k.lower() for bad in FORBIDDEN)]


def test_structures_values_and_coordinates(fire):
    bbox = _load(fire.id, "aoi.json")["bbox"]
    feats = _load(fire.id, "structures.geojson")["features"]
    ids = [f["properties"]["id"] for f in feats]
    assert len(set(ids)) == len(ids) and all(isinstance(i, int) for i in ids)
    assert {f["properties"]["damage"] for f in feats} <= set(DAMAGE_CLASSES)
    for f in feats:
        assert f["geometry"]["type"] == "Point"
        lon, lat = f["geometry"]["coordinates"]
        assert _in_bbox(lon, lat, bbox)
        assert abs(round(lon, 5) - lon) < 1e-9 and abs(round(lat, 5) - lat) < 1e-9


def test_destroyed_structures_sit_inside_final_perimeter(fire):
    """Georeferencing check against an independent layer: DINS points vs the CAL FIRE perimeter."""
    perim = unary_union([shape(f["geometry"]) for f in _load(fire.id, "final_perimeter.geojson")["features"]])
    feats = _load(fire.id, "structures.geojson")["features"]
    lon, lat = np.array([f["geometry"]["coordinates"] for f in feats]).T
    inside = shapely.contains_xy(perim, lon, lat)
    damage = np.array([f["properties"]["damage"] for f in feats])
    destroyed = damage == "Destroyed"
    assert destroyed.sum() > 1000
    assert inside[destroyed].mean() > 0.95
    assert inside[damage == "No Damage"].mean() < inside[destroyed].mean()


def test_build_structures_drops_private_fields():
    leaky = {
        "OBJECTID": 7, "DAMAGE": "Destroyed (>50%)", "STRUCTURETYPE": "Single Family Residence Single Story",
        "ROOFCONSTRUCTION": "Asphalt", "EAVES": "Unenclosed", "VENTSCREEN": "Unscreened",
        "EXTERIORSIDING": "Wood", "SITEADDRESS": "123 Example St", "APN": "5555-555-555",
        "YEARBUILT": 1950, "STREETNAME": "Example", "CITY": "Altadena", "ZIPCODE": 91001,
        "ASSESSEDIMPROVEDVALUE": 1e6, "LATITUDE": 34.2, "LONGITUDE": -118.1,
    }
    feats = [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-118.1234567, 34.2]}, "properties": leaky},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-100.0, 34.2]}, "properties": {**leaky, "OBJECTID": 8}},
        {"type": "Feature", "geometry": None, "properties": {**leaky, "OBJECTID": 9}},
    ]
    fc, dropped = build_structures(feats, [-118.2, 34.1, -118.0, 34.3])
    assert dropped == {"no_geometry": 1, "outside_bbox": 1}
    (only,) = fc["features"]
    assert set(only["properties"]) == set(STRUCTURE_KEYS)
    assert only["properties"]["damage"] == "Destroyed" and only["properties"]["id"] == 7
    assert only["geometry"]["coordinates"] == [-118.12346, 34.2]
    text = json.dumps(fc)
    assert "Example" not in text and "5555" not in text and "1950" not in text


def test_normalize_damage():
    raw = ["Destroyed (>50%)", "Major (25-50%)", "Minor (10-25%)", "Affected (>0-10%)", "Inaccessible", "No Damage"]
    assert [normalize_damage(r) for r in raw] == ["Destroyed", "Major", "Minor", "Affected", "Inaccessible", "No Damage"]
    with pytest.raises(ValueError):
        normalize_damage("Smoke")
    with pytest.raises(ValueError):
        normalize_damage(None)


# ---------------------------------------------------------------- roads


def test_roads_contract(fire):
    path = fire.out_dir / "roads.geojson"
    assert path.stat().st_size < 3_000_000
    bbox = _load(fire.id, "aoi.json")["bbox"]
    feats = _load(fire.id, "roads.geojson")["features"]
    assert len(feats) > 1000
    classes = set(ROAD_CLASSES) | set(TRAIL_CLASSES)
    for f in feats:
        p = f["properties"]
        assert set(p) == {"name", "highway"} and p["highway"] in classes
        if p["highway"] in TRAIL_CLASSES:
            assert p["name"]
        assert f["geometry"]["type"] == "LineString" and len(f["geometry"]["coordinates"]) >= 2
        assert all(_in_bbox(x, y, bbox, EPS) for x, y in f["geometry"]["coordinates"])
    assert {"residential", "primary"} <= {f["properties"]["highway"] for f in feats}


def test_keep_way():
    assert keep_way({"highway": "residential"})
    assert keep_way({"highway": "path", "name": "Mount Lowe Railway Trail"})
    assert not keep_way({"highway": "path"})
    assert not keep_way({"highway": "footway", "name": "Lake Avenue", "footway": "sidewalk"})
    assert not keep_way({"highway": "service", "name": "Driveway"})


# ---------------------------------------------------------------- labels


def test_labels_contract(fire):
    bbox = _load(fire.id, "aoi.json")["bbox"]
    labels = _load(fire.id, "labels.json")
    assert isinstance(labels, list)
    kinds = {lab["kind"] for lab in labels}
    assert {"peak", "place"} <= kinds <= {"peak", "place", "water"}
    seen = set()
    for lab in labels:
        assert set(lab) == {"name", "kind", "lon", "lat", "ele_m"}
        assert lab["name"].strip() and (lab["name"], lab["kind"]) not in seen
        seen.add((lab["name"], lab["kind"]))
        assert _in_bbox(lab["lon"], lab["lat"], bbox)
        if lab["kind"] != "peak":
            assert lab["ele_m"] is None
        elif lab["ele_m"] is not None:
            assert -10 < lab["ele_m"] < 4500


def test_peak_elevations_match_dem(fire):
    """OSM ele tags against the terrarium DEM at the same lon/lat: catches swapped or shifted coordinates."""
    dem = _load(fire.id, "dem.json")
    w, s, e, n = dem["bounds"]
    elev = terrarium_decode(np.asarray(Image.open(fire.out_dir / "dem.png").convert("RGB")))
    h, wd = elev.shape
    errs = []
    for lab in _load(fire.id, "labels.json"):
        if lab["kind"] != "peak" or lab["ele_m"] is None:
            continue
        r = round((n - lab["lat"]) / (n - s) * (h - 1))
        c = round((lab["lon"] - w) / (e - w) * (wd - 1))
        local_max = elev[max(r - 2, 0):r + 3, max(c - 2, 0):c + 3].max()  # DEM smooths summits
        errs.append(abs(float(local_max) - lab["ele_m"]))
    assert len(errs) >= 3
    assert np.median(errs) < 15 and max(errs) < 60


def test_parse_ele():
    assert parse_ele("1741") == 1741.0
    assert parse_ele("1121.969") == 1122.0
    assert parse_ele("5710 ft") == pytest.approx(1740.4)
    assert parse_ele("5,710'") == pytest.approx(1740.4)
    assert parse_ele("approx 900") is None and parse_ele(None) is None


# ---------------------------------------------------------------- gazetteer


def test_gazetteer_contract(fire):
    bbox = _load(fire.id, "aoi.json")["bbox"]
    gaz = _load(fire.id, "gazetteer.json")
    roads = _load(fire.id, "roads.geojson")["features"]
    assert len(gaz) > 500
    for key, entry in gaz.items():
        assert set(entry) == {"name", "segments", "bbox"}
        assert normalize_street(key) == key and normalize_street(entry["name"]) == key
        bw, bs, be, bn = entry["bbox"]
        assert bw <= be and bs <= bn and entry["segments"] >= 1
        assert _in_bbox(bw, bs, bbox, EPS) and _in_bbox(be, bn, bbox, EPS)
    named = sum(1 for f in roads if f["properties"]["name"] and normalize_street(f["properties"]["name"]))
    assert sum(e["segments"] for e in gaz.values()) == named


def test_normalize_street():
    assert normalize_street("North Lake Avenue") == "n lake ave"
    assert normalize_street("N. Lake Ave.") == "n lake ave"
    assert normalize_street("Eaton Canyon Drive") == "eaton cyn dr"
    assert normalize_street("  West   Mountain View  Street ") == "w mtn view st"
    assert normalize_street("St. John's Place") == "st johns pl"
    assert normalize_street("Sunset Boulevard") == "sunset blvd"
    assert normalize_street("Old West Road") == "old west rd"  # directions only at the start
    assert normalize_street("Kenyon-Devore Trail") == "kenyon devore trail"
    for name in ("North Lake Avenue", "Court Lane", "East Canyon Court"):
        once = normalize_street(name)
        assert normalize_street(once) == once


# ---------------------------------------------------------------- manifest


def test_manifest_entries(fire):
    sources = {s["layer"]: s for s in _load(fire.id, "manifest.json")["sources"]}
    dins = sources["Structures (damage inspection)"]
    assert dins["status"] == "REAL" and "POSTFIRE_MASTER_DATA_SHARE" in dins["url"]
    assert "address, parcel, owner and year-built fields deliberately dropped" in dins["notes"]
    osm = sources["Roads, peaks & places"]
    assert osm["status"] == "REAL" and osm["attribution"] == "(c) OpenStreetMap contributors (ODbL)"
