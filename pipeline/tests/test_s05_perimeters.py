"""Contract checks for step 05 (perimeters.geojson, spots.geojson) against the committed outputs.

Areas are re-measured here with the spherical ember.geo.meters_per_degree, independently of the
step's own WGS84 frame; the two differ by ~0.25%, well inside the tolerances below.
"""

import json
from datetime import datetime

import pytest
import shapely
from shapely.geometry import box, shape

from ember.geo import meters_per_degree
from steps.s05_perimeters import is_placeholder

M2_PER_ACRE = 4046.8564224
SOURCE = "NIFC Operational Data Archive 2025"
PROPS = {"t", "acres", "acres_union", "acres_observed", "acres_reported", "source", "method", "object_ids",
         "in_window"}
# InFORM placeholder triangles in the NIFC archive (3 distinct vertices, sized to the reported acreage):
# Eaton 381 (0.1 ac), 382/385/388 (400 ac), 405 (2,227 ac); Palisades 379/408 (2,920 ac).
KNOWN_PLACEHOLDERS = {"eaton": {381, 382, 385, 388, 405}, "palisades": {379, 408}}


def _read(fire, name):
    path = fire.out_dir / name
    assert path.exists(), f"{path} missing: run FIRE={fire.id} uv run python -m steps.s05_perimeters"
    return json.loads(path.read_text())


@pytest.fixture
def aoi(fire):
    return fire.read_json("aoi.json")


@pytest.fixture
def perimeters(fire):
    return _read(fire, "perimeters.geojson")["features"]


@pytest.fixture
def spots(fire):
    return _read(fire, "spots.geojson")["features"]


def _acres(geom, lat0):
    m_lon, m_lat = meters_per_degree(lat0)
    return shapely.transform(geom, lambda c: c * [m_lon, m_lat]).area / M2_PER_ACRE


def _time(t):
    assert isinstance(t, str) and t.endswith("Z"), t
    return datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ")


def test_file_size(fire):
    assert (fire.out_dir / "perimeters.geojson").stat().st_size < 1_500_000


def test_properties(perimeters, aoi):
    assert len(perimeters) >= 5
    start, end = aoi["window_utc"]
    for f in perimeters:
        p = f["properties"]
        assert PROPS <= set(p)
        _time(p["t"])
        assert p["source"] == SOURCE
        assert p["object_ids"] and all(isinstance(i, int) for i in p["object_ids"])
        assert isinstance(p["in_window"], bool) and p["in_window"] == (start <= p["t"] <= end)
        assert p["acres_reported"] is None or p["acres_reported"] > 0
        assert 0 < p["acres"] <= p["acres_union"] + 0.1
        assert p["acres_observed"] >= 5  # stubs are excluded from the series
    assert any(f["properties"]["in_window"] for f in perimeters)


def test_series_is_sorted_and_cumulative(perimeters):
    times = [_time(f["properties"]["t"]) for f in perimeters]
    assert times == sorted(times) and len(set(times)) == len(times)
    acres = [f["properties"]["acres"] for f in perimeters]
    assert all(b >= a for a, b in zip(acres, acres[1:]))
    union = [f["properties"]["acres_union"] for f in perimeters]
    assert all(b >= a for a, b in zip(union, union[1:]))


def test_final_area_matches_official(perimeters, aoi):
    final, official = perimeters[-1]["properties"]["acres"], aoi["official"]["final_acres"]
    assert abs(final / official - 1) < 0.03, (final, official)


def test_geometry_valid_and_in_aoi(perimeters, aoi):
    lat0 = (aoi["bbox"][1] + aoi["bbox"][3]) / 2
    region = box(*aoi["bbox"]).buffer(1e-6)
    for f in perimeters:
        g = shape(f["geometry"])
        assert g.geom_type in ("Polygon", "MultiPolygon") and g.is_valid and not g.is_empty
        assert region.contains(g)
        # The stored acres come from the unsimplified footprint; simplification moves it a little.
        assert abs(_acres(g, lat0) / f["properties"]["acres"] - 1) < 0.015, f["properties"]["t"]


def test_footprints_never_shrink(perimeters):
    shapes = [shape(f["geometry"]) for f in perimeters]
    for prev, cur in zip(shapes, shapes[1:]):
        # Only simplification slop may stick out of the next footprint.
        assert prev.difference(cur).area < 0.005 * prev.area


def test_last_footprint_matches_final_perimeter(fire, perimeters):
    final = shapely.make_valid(shape(fire.read_json("final_perimeter.geojson")["features"][0]["geometry"]))
    last = shape(perimeters[-1]["geometry"])
    iou = last.intersection(final).area / last.union(final).area
    assert iou > 0.95, iou


def test_spots(spots, perimeters, aoi):
    times = {f["properties"]["t"] for f in perimeters}
    region = box(*aoi["bbox"])
    lat0 = (aoi["bbox"][1] + aoi["bbox"][3]) / 2
    for f in spots:
        p, g = f["properties"], shape(f["geometry"])
        assert p["t"] in times
        assert 0 < p["acres"] < 50
        assert isinstance(p["in_window"], bool)
        assert g.is_valid and region.contains(g)
        assert _acres(g, lat0) < 50


def test_manifest_entry(fire):
    sources = {s["layer"]: s for s in fire.read_json("manifest.json")["sources"]}
    entry = sources["Perimeters (time series)"]
    assert entry["status"] == "REAL" and entry["source"] == SOURCE
    assert "Operational_Data_Archive_2025/FeatureServer/6" in entry["url"]
    assert "observations kept" in entry["notes"]


def test_placeholder_rule():
    triangle = shapely.Polygon([(0, 1), (1, 0), (-1, 0)])
    assert is_placeholder(triangle)
    assert not is_placeholder(box(0, 0, 1, 1))
    assert not is_placeholder(triangle.difference(shapely.Point(0, 0.3).buffer(0.1)))  # triangle with a hole
    assert not is_placeholder(shapely.MultiPolygon([triangle, shapely.transform(triangle, lambda c: c + [5, 0])]))
    assert not is_placeholder(shapely.Point(0, 0).buffer(1))


def test_no_placeholders_in_outputs(fire, perimeters, spots):
    placeholders = KNOWN_PLACEHOLDERS.get(fire.id, set())
    for f in perimeters + spots:
        assert not placeholders & set(f["properties"]["object_ids"]), f["properties"]["t"]


def test_audit_drops_every_placeholder(fire, perimeters):
    path = fire.work_dir / "perimeters_raw.json"
    if not path.exists():
        pytest.skip(f"{path} is gitignored; run the step to create it")
    records = json.loads(path.read_text())["records"]
    kept = {r["object_id"] for r in records if r["kept"]}
    for r in records:
        if r["placeholder"]:
            assert r["vertices"] == 3 and not r["kept"], r["object_id"]
        if r["kept"]:
            assert r["vertices"] > 3, r["object_id"]
    assert KNOWN_PLACEHOLDERS.get(fire.id, set()) <= {r["object_id"] for r in records if r["placeholder"]}
    used = {i for f in perimeters for i in f["properties"]["object_ids"]}
    assert used == kept
