"""Step 05: time-stamped fire perimeters from the NIFC 2025 operational archive.

The archive keeps every saved version of each incident polygon, so most rows are re-saves,
attribute edits or polygons whose attributes were carried over from the previous version.
This step turns that history into a clean, cumulative growth series:

  1. Observation time = PolygonDateTime when it is set and believable, else DateCurrent.
     PolygonDateTime is "stale" when it was set by an earlier version with a different
     polygon (the geometry was redrawn but the field was carried over; Palisades keeps
     01-08 14:31Z on every version from 11,800 to 23,500 acres). Stale times fall back to
     DateCurrent, as BUILD.md §5 asks; each record's time source is in the audit file.
  2. Acres are computed from the geometry in a local WGS84 frame at the AOI center (see
     Frame); GISAcres is kept only as `acres_reported`.
  3. Duplicates are dropped: same time with area within 1%, or a geometry whose symmetric
     difference with an earlier kept observation is under 1% of its area (a re-save).
  4. Records under 5 acres (auto-generated stubs) are dropped from the series, and so are
     InFORM placeholders: a single polygon with exactly 3 distinct vertices. InFORM draws
     an isosceles triangle with a horizontal base, sized to the reported acreage, before
     anyone maps the fire (Eaton 382 at 400 ac and 405 at 2,227 ac; Palisades 379 at
     2,920 ac). Eaton's are centred 3.6 km from its reported origin and do not contain it.
     These are not perimeters. The MapMethod label "Auto-generated for InFORM" does not
     identify them, because real mapped polygons (Eaton 390, Palisades 452 and 463) carry
     it too; the vertex count does. They stay in the audit file, and they still count as
     the versions that set a PolygonDateTime in rule 1. Without them the first mapped
     perimeter is Eaton 07:06Z (4.8 h after the reported start) and Palisades 20:34Z on
     Jan 8 (26 h after), so FIRMS has to carry Palisades' first day (BUILD.md §4).
  5. The footprint at observation k is the union of all kept observations up to k, so a
     re-mapped shrinkage never un-burns ground. Early maps are coarse, though (Eaton's 07:12Z
     map 390 reaches ~220 acres past the final map and its first-evening map 484 ~960;
     Palisades' 544 ~770), so the union is clipped to the final extent: the latest
     archive version inside the AOI. Intersecting with a fixed shape keeps the series
     monotone, and only ground the incident's own final map says never burned is removed.
     `acres_union` keeps the unclipped figure.
  6. Components under 50 acres that are more than 10 m from every component of 50+ acres
     are listed in spots.geojson at the first observation where they appear. They stay in
     the cumulative footprint too, because the final perimeter includes them.
  7. Every observation carries in_window relative to aoi.json window_utc.
Records or polygon parts entirely outside the AOI bbox are dropped first: the name filter
also matches other incidents called PALISADES (Washington, Wyoming), and two Palisades
versions carry stray slivers well east of the AOI.

Inputs:  aoi.json (bbox, window_utc, official acres), final_perimeter.geojson (frame check only)
         NIFC Operational_Data_Archive_2025/FeatureServer/6, where UPPER(IncidentName) = nifc_name
Outputs: perimeters.geojson             cumulative footprint per kept observation, sorted by t
         spots.geojson                  candidate spot fires {t, acres}
         work/<fire>/perimeters_raw.json  every record: both times, computed area, keep/drop reason
         manifest.json                  "Perimeters (time series)"

Run: cd pipeline && FIRE=eaton uv run python -m steps.s05_perimeters
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np
import requests
import shapely
from shapely.geometry import box, mapping, shape

from ember.config import Fire, load_fire
from ember.manifest import add_source

NIFC_LAYER = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "Operational_Data_Archive_2025/FeatureServer/6"
)
SOURCE = "NIFC Operational Data Archive 2025"
OUT_FIELDS = "OBJECTID,DateCurrent,PolygonDateTime,GISAcres,FeatureCategory,MapMethod,IRWINID"
USER_AGENT = "sentinel-ember-hackathon/0.1 (github.com/jonathantsang26/metahacks)"

M2_PER_ACRE = 4046.8564224
SAME_PD_S = 60          # rule 1: PolygonDateTime values this close are the same stamp
SAME_AREA = 0.01       # rule 3: area within 1% at the same time
SAME_SHAPE = 0.01       # rule 3: symmetric difference under 1% of the record's area
STUB_ACRES = 5.0        # rule 4
PLACEHOLDER_VERTICES = 3  # rule 4: InFORM's synthetic triangle
SPOT_ACRES = 50.0       # rule 6
TOUCH_M = 10.0          # rule 6: closer than this counts as touching (digitizing slop)
SIMPLIFY_DEG = 0.00005  # ~5 m
MAX_BYTES = 1_500_000


# ---------------------------------------------------------------- fetch


def fetch_archive(fire: Fire) -> dict:
    """All archive records for the fire as one GeoJSON FeatureCollection (cached in raw/)."""
    cache = fire.raw_dir / "nifc_perimeters.geojson"
    if cache.exists() and cache.stat().st_size > 0:
        return json.loads(cache.read_text())
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    features: list[dict] = []
    page = 2000
    while True:
        params = {
            "where": f"UPPER(IncidentName) = '{fire.nifc_name}'",
            "outFields": OUT_FIELDS,
            "outSR": 4326,
            "orderByFields": "DateCurrent",
            "f": "geojson",
            "resultOffset": len(features),
            "resultRecordCount": page,
        }
        batch = _get_json(session, f"{NIFC_LAYER}/query", params).get("features", [])
        features.extend(batch)
        if len(batch) < page:
            break
    fc = {"type": "FeatureCollection", "features": features}
    cache.write_text(json.dumps(fc))
    return fc


def _get_json(session: requests.Session, url: str, params: dict, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            # ArcGIS reports query errors with HTTP 200 and an "error" body.
            if "error" in data:
                raise requests.RequestException(f"ArcGIS error: {data['error']}")
            return data
        except (requests.RequestException, ValueError):
            if attempt == retries - 1:
                raise
            time.sleep(2.0 * 2**attempt)
    raise AssertionError("unreachable")


# ---------------------------------------------------------------- geometry


class Frame:
    """Local frame in meters east/north of the AOI center, for areas and distances.

    Scales come from the WGS84 radii of curvature at the center latitude. The spherical
    ember.geo.meters_per_degree overstates areas here by ~0.25%; this frame reproduces
    CAL FIRE's GIS_ACRES for the final perimeters to 0.01% (frame_check prints it). Over a
    ~15 km AOI the scale varies by under 0.1% and averages out.
    """

    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        a, e2 = 6378137.0, 6.69437999014e-3
        s2 = math.sin(math.radians(lat0)) ** 2
        meridian = a * (1 - e2) / (1 - e2 * s2) ** 1.5
        normal = a / math.sqrt(1 - e2 * s2)
        self.m_lat = math.radians(1) * meridian
        self.m_lon = math.radians(1) * normal * math.cos(math.radians(lat0))

    def to_m(self, geom):
        return shapely.transform(geom, lambda c: (c - [self.lon0, self.lat0]) * [self.m_lon, self.m_lat])

    def to_deg(self, geom):
        return shapely.transform(geom, lambda c: c / [self.m_lon, self.m_lat] + [self.lon0, self.lat0])


def polygonal(geom):
    """Valid (Multi)Polygon from any geometry: make_valid can return lines and points too."""
    geom = shapely.make_valid(geom)
    parts = [p for p in shapely.get_parts(geom) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def split_by_aoi(geom, aoi_box):
    """(parts touching the AOI, parts entirely outside it)."""
    parts = shapely.get_parts(geom)
    hit = shapely.intersects(parts, aoi_box)
    return shapely.union_all(parts[hit]), shapely.union_all(parts[~hit])


def acres(geom_m) -> float:
    return geom_m.area / M2_PER_ACRE


def distinct_vertices(geom) -> int:
    coords = shapely.get_coordinates(geom)
    return len(np.unique(coords, axis=0)) if len(coords) else 0


def is_placeholder(geom) -> bool:
    """Rule 4: one polygon, no holes, exactly 3 distinct vertices (InFORM's acreage triangle)."""
    parts = shapely.get_parts(geom)
    if len(parts) != 1 or parts[0].geom_type != "Polygon" or len(parts[0].interiors):
        return False
    return distinct_vertices(parts[0]) == PLACEHOLDER_VERTICES


def near_identical(a_m, b_m) -> bool:
    """True when a's symmetric difference with b is under SAME_SHAPE of a's area."""
    limit = SAME_SHAPE * a_m.area
    if abs(a_m.area - b_m.area) >= limit:  # cheap reject: |A| - |B| bounds the symdiff
        return False
    return a_m.symmetric_difference(b_m).area < limit


# ---------------------------------------------------------------- records


@dataclass
class Record:
    oid: int
    date_current: datetime
    polygon_dt: datetime | None
    gis_acres: float | None
    method: str | None
    category: str | None
    irwin_id: str | None
    geom_m: object                     # polygon parts inside the AOI, in the local meter frame
    acres_outside: float = 0.0
    parts_outside: int = 0
    vertices: int = 0                  # distinct vertices of the archived geometry, as served
    placeholder: bool = False
    t: datetime | None = None
    time_source: str = ""
    kept: bool = False
    reason: str = ""
    duplicate_of: int | None = None
    acres: float = field(init=False)

    def __post_init__(self):
        self.acres = acres(self.geom_m)


def _utc(ms: int | None) -> datetime | None:
    return None if ms is None else datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_records(fc: dict, frame: Frame, aoi_box) -> list[Record]:
    records = []
    for f in fc["features"]:
        p = f["properties"]
        raw = shape(f["geometry"]) if f.get("geometry") else shapely.Polygon()
        geom = polygonal(raw)
        inside, outside = split_by_aoi(geom, aoi_box) if not geom.is_empty else (geom, geom)
        records.append(Record(
            oid=int(p["OBJECTID"]),
            date_current=_utc(p.get("DateCurrent")),
            polygon_dt=_utc(p.get("PolygonDateTime")),
            gis_acres=p.get("GISAcres"),
            method=(p.get("MapMethod") or "").strip() or None,
            category=p.get("FeatureCategory"),
            irwin_id=p.get("IRWINID"),
            geom_m=frame.to_m(inside),
            acres_outside=acres(frame.to_m(outside)),
            parts_outside=len(shapely.get_parts(outside)),
            vertices=distinct_vertices(raw),
            placeholder=is_placeholder(raw),
        ))
    return sorted(records, key=lambda r: (r.date_current, r.oid))


def assign_times(records: list[Record]) -> None:
    """Rule 1, with stale PolygonDateTime detection (see module docstring).

    The first saved version carrying a PolygonDateTime value is the one that set it. A later
    version with the same value keeps that time only if its polygon is near-identical to the
    setter's; otherwise the field was carried over and is stale. Copies of the value can
    lose their milliseconds, so values within SAME_PD_S count as the same.
    """
    with_pd = [r for r in records if r.polygon_dt is not None]  # sorted by DateCurrent
    for r in records:
        pd, dc = r.polygon_dt, r.date_current
        if pd is None:
            r.t, r.time_source = dc, "DateCurrent (PolygonDateTime null)"
        elif (pd - dc).total_seconds() > SAME_PD_S:
            r.t, r.time_source = dc, "DateCurrent (PolygonDateTime after DateCurrent)"
        elif (first := next(a for a in with_pd if abs((a.polygon_dt - pd).total_seconds()) <= SAME_PD_S)) is r:
            r.t, r.time_source = pd, "PolygonDateTime"
        elif near_identical(r.geom_m, first.geom_m):
            r.t, r.time_source = pd, f"PolygonDateTime (same polygon as {first.oid}, which set it)"
        else:
            r.t, r.time_source = dc, f"DateCurrent (PolygonDateTime stale: set by {first.oid} for a different polygon)"


def select(records: list[Record]) -> list[Record]:
    """Rules 3 and 4: mark each record kept or dropped with a reason. Returns kept records.

    Placeholders are checked before stubs and re-saves, so every InFORM triangle (the 0.1-acre
    one and the re-saved copies too) carries the same, most specific reason in the audit.
    """
    kept: list[Record] = []
    for r in sorted(records, key=lambda r: (r.t, r.date_current, r.oid)):
        if r.geom_m.is_empty:
            r.reason = "outside AOI (another incident with the same name)" if r.parts_outside else "no geometry"
            continue
        if r.placeholder:
            r.reason = (f"InFORM placeholder: {PLACEHOLDER_VERTICES}-vertex triangle sized to the reported acreage "
                        f"(MapMethod {r.method!r}), not a mapped perimeter")
            continue
        if r.acres < STUB_ACRES:
            r.reason = f"stub under {STUB_ACRES:g} acres"
            continue
        same_time = next((k for k in kept if k.t == r.t and abs(k.acres - r.acres) <= SAME_AREA * r.acres), None)
        if same_time:
            r.reason, r.duplicate_of = "duplicate (same time, area within 1%)", same_time.oid
            continue
        resave = next((k for k in kept if near_identical(r.geom_m, k.geom_m)), None)
        if resave:
            r.reason, r.duplicate_of = "re-save (symmetric difference under 1% of an earlier observation)", resave.oid
            continue
        r.kept, r.reason = True, "kept"
        kept.append(r)
    return kept


# ---------------------------------------------------------------- series


@dataclass
class Observation:
    t: datetime
    records: list[Record]
    footprint_m: object       # cumulative union up to and including t, clipped to the final extent
    union_m: object           # the same union, unclipped
    observed_m: object        # this observation's own polygons


def final_extent(records: list[Record]) -> Record:
    """The latest-saved version inside the AOI that maps the whole fire.

    "Whole" means at least half the largest version's area, so a partial add-on record
    (Eaton's 18-acre fragment set) saved last could never become the clip shape.
    """
    largest = max(r.acres for r in records)
    whole = [r for r in records if r.acres >= 0.5 * largest]
    return max(whole, key=lambda r: (r.date_current, r.oid))


def cumulative(kept: list[Record], extent_m) -> list[Observation]:
    """Rule 5: group kept records by time, union them cumulatively, clip to the final extent."""
    groups: dict[datetime, list[Record]] = {}
    for r in kept:  # group at the output's one-second resolution so no two features share a t
        groups.setdefault(r.t.replace(microsecond=0), []).append(r)
    series, union = [], shapely.Polygon()
    for t in sorted(groups):
        observed = shapely.union_all([r.geom_m for r in groups[t]])
        union = shapely.union(union, observed)
        series.append(Observation(t, groups[t], polygonal(shapely.intersection(union, extent_m)), union, observed))
    return series


def find_spots(series: list[Observation], extent_m) -> list[tuple[Observation, object]]:
    """Rule 6: small components detached from the main footprint, at first appearance.

    Components come from the unclipped union, so they are shapes an observation actually
    drew; clipping first would carve the final map's own fragments out of early coarse
    boxes and date them hours too early. A spot is then kept only where the final extent
    confirms it burned.
    """
    spots, previous = [], shapely.Polygon()
    for obs in series:
        parts = shapely.get_parts(obs.union_m)
        areas = shapely.area(parts) / M2_PER_ACRE
        big = areas >= SPOT_ACRES
        big[np.argmax(areas)] = True  # the largest component is always the main footprint
        main = shapely.union_all(parts[big])
        for part in parts[~big]:
            if shapely.distance(part, main) > TOUCH_M and not shapely.intersects(part, previous):
                confirmed = polygonal(shapely.intersection(part, extent_m))
                if not confirmed.is_empty:
                    spots.append((obs, confirmed))
        previous = obs.union_m
    return spots


# ---------------------------------------------------------------- output


def _round(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 6), round(coords[1], 6)]
    return [_round(c) for c in coords]


def to_geojson(geom_m, frame: Frame, tolerance: float) -> dict | None:
    """Lon/lat GeoJSON geometry, simplified and snapped to 6 decimals; None if nothing is left."""
    g = frame.to_deg(geom_m)
    for candidate in (shapely.simplify(g, tolerance, preserve_topology=True), g):
        snapped = polygonal(shapely.set_precision(candidate, 1e-6))  # GEOS keeps the result valid
        if not snapped.is_empty:
            m = mapping(snapped)
            return {"type": m["type"], "coordinates": _round(m["coordinates"])}
    return None


def in_window(t: datetime, window: list[str]) -> bool:
    return window[0] <= iso(t) <= window[1]


def perimeter_features(series: list[Observation], frame: Frame, window: list[str], tolerance: float) -> list[dict]:
    feats = []
    for obs in series:
        main = max(obs.records, key=lambda r: r.acres)
        methods = sorted({r.method for r in obs.records if r.method})
        feats.append({
            "type": "Feature",
            "properties": {
                "t": iso(obs.t),
                "acres": round(acres(obs.footprint_m), 1),
                "acres_union": round(acres(obs.union_m), 1),
                "acres_observed": round(acres(obs.observed_m), 1),
                "acres_reported": None if main.gis_acres is None else round(main.gis_acres, 1),
                "source": SOURCE,
                "method": "; ".join(methods) or None,
                "object_ids": [r.oid for r in obs.records],
                "in_window": in_window(obs.t, window),
            },
            "geometry": to_geojson(obs.footprint_m, frame, tolerance),
        })
    return feats


def spot_features(spots, frame: Frame, window: list[str]) -> list[dict]:
    feats = []
    for obs, part in spots:
        geometry = to_geojson(part, frame, SIMPLIFY_DEG)
        if geometry is None:
            continue
        feats.append({
            "type": "Feature",
            "properties": {
                "t": iso(obs.t),
                "acres": round(acres(part), 2),
                "object_ids": [r.oid for r in obs.records if shapely.intersects(r.geom_m, part)],
                "in_window": in_window(obs.t, window),
            },
            "geometry": geometry,
        })
    return feats


def dumps(fc: dict) -> str:
    return json.dumps(fc, separators=(",", ":")) + "\n"


def write_perimeters(fire: Fire, series, frame, window) -> tuple[int, float]:
    """Simplify at ~5 m, coarsening only if the file would exceed MAX_BYTES."""
    tolerance = SIMPLIFY_DEG
    while True:
        text = dumps({"type": "FeatureCollection", "features": perimeter_features(series, frame, window, tolerance)})
        if len(text) <= MAX_BYTES:
            break
        if tolerance > 20 * SIMPLIFY_DEG:
            raise SystemExit(f"perimeters.geojson is {len(text):,} bytes at tolerance {tolerance:.6f} deg, "
                             f"still over {MAX_BYTES:,}; not writing an oversize file")
        tolerance *= 1.5
    (fire.out_dir / "perimeters.geojson").write_text(text)
    return len(text), tolerance


def audit(fire: Fire, records: list[Record], series: list[Observation], extent: Record, window: list[str]) -> None:
    rows = []
    for r in records:
        rows.append({
            "object_id": r.oid,
            "irwin_id": r.irwin_id,
            "date_current": iso(r.date_current),
            "polygon_datetime": iso(r.polygon_dt) if r.polygon_dt else None,
            "t": iso(r.t),
            "time_source": r.time_source,
            "in_window": in_window(r.t, window),
            "acres_computed": round(r.acres, 2),
            "acres_reported": r.gis_acres,
            "acres_outside_aoi": round(r.acres_outside, 2),
            "parts_outside_aoi": r.parts_outside,
            "vertices": r.vertices,
            "placeholder": r.placeholder,
            "acres_outside_final_extent": round(acres(r.geom_m.difference(extent.geom_m)), 1) if r.kept else None,
            "map_method": r.method,
            "feature_category": r.category,
            "kept": r.kept,
            "reason": r.reason,
            "duplicate_of": r.duplicate_of,
        })
    out = {
        "fire": fire.id,
        "source": SOURCE,
        "url": NIFC_LAYER,
        "final_extent_object_id": extent.oid,
        "series": [
            {"t": iso(o.t), "acres": round(acres(o.footprint_m), 1), "acres_union": round(acres(o.union_m), 1),
             "object_ids": [r.oid for r in o.records]}
            for o in series
        ],
        "records": rows,
    }
    (fire.work_dir / "perimeters_raw.json").write_text(json.dumps(out, indent=2) + "\n")


def frame_check(fire: Fire, frame: Frame) -> str:
    """Area of the CAL FIRE final perimeter in our frame vs its GIS_ACRES, as evidence for rule 2."""
    path = fire.out_dir / "final_perimeter.geojson"
    if not path.exists():
        return ""
    feat = json.loads(path.read_text())["features"][0]
    reported = feat["properties"].get("acres")
    if not reported:
        return ""
    measured = acres(frame.to_m(polygonal(shape(feat["geometry"]))))
    return (f"Area check: the CAL FIRE final perimeter measures {measured:,.1f} ac in this frame "
            f"vs its GIS_ACRES {reported:,.1f} ({100 * (measured / reported - 1):+.2f}%).")


def placeholder_note(aoi: dict, records: list[Record], series: list[Observation]) -> str:
    """Name the dropped InFORM triangles and say how late the first mapped perimeter is."""
    inside = [r for r in records if r.placeholder and not r.geom_m.is_empty]
    first = series[0]
    gap = ""
    if inc := aoi["official"].get("incident"):
        start = datetime.fromisoformat(inc["start_utc"].replace("Z", "+00:00"))
        gap = f", {(first.t - start).total_seconds() / 3600:.1f} h after the reported start {inc['start_utc']}"
    note = (f"First mapped perimeter: {iso(first.t)} (version {', '.join(str(r.oid) for r in first.records)}, "
            f"{acres(first.observed_m):,.0f} ac{gap}).")
    if not inside:
        return note
    listed = "; ".join(f"{r.oid} at {iso(r.t)}, {r.acres:,.1f} ac" for r in inside)
    return (f"Dropped {len(inside)} InFORM placeholder versions (single 3-vertex triangles sized to the "
            f"reported acreage, not mapped perimeters): {listed}. " + note)


def describe(fire, aoi, frame, records, kept, series, spots, extent, tolerance, window) -> str:
    """Manifest notes: what was kept, what was dropped and why, and the area checks."""
    official = aoi["official"]["final_acres"]
    final, union = acres(series[-1].footprint_m), acres(series[-1].union_m)
    stale = sum("stale" in r.time_source for r in records)
    resaves = sum("re-save" in r.reason or "duplicate" in r.reason for r in records)
    stubs = sum(r.reason.startswith("stub") for r in records)
    other = sum(r.reason.startswith("outside AOI") for r in records)
    slivers = [r for r in records if r.parts_outside and not r.geom_m.is_empty]
    outside = sorted(((acres(r.geom_m.difference(extent.geom_m)), r.oid) for r in kept), reverse=True)
    notes = [
        f"{len(series)} observations kept from {len(records)} archive versions, {iso(series[0].t)} to "
        f"{iso(series[-1].t)} ({sum(in_window(o.t, window) for o in series)} inside the replay window).",
        f"Time = PolygonDateTime, else DateCurrent; {stale} versions carried a stale PolygonDateTime "
        f"(set by an earlier version with a different polygon) and use DateCurrent.",
        placeholder_note(aoi, records, series),
        f"Dropped: {resaves} re-saves or duplicates (under 1% different), {stubs} stub(s) under {STUB_ACRES:g} ac"
        + (f", {other} versions of other incidents with the same name outside the AOI" if other else "")
        + (f", {sum(r.parts_outside for r in slivers)} stray polygon parts outside the AOI "
           f"({sum(r.acres_outside for r in slivers):.2f} ac) in versions {', '.join(str(r.oid) for r in slivers)}"
           if slivers else "") + ".",
        f"Each feature is the cumulative union of observations so far, clipped to the final extent "
        f"(version {extent.oid}, {extent.acres:,.0f} ac). Unclipped, the union ends at {union:,.0f} ac "
        f"({100 * (union / official - 1):+.1f}% vs official); most of the excess is early mapping outside the final "
        f"extent: " + ", ".join(f"{oid} {a:,.0f} ac" for a, oid in outside[:3] if a >= 1) + ".",
        f"Final cumulative {final:,.0f} ac vs official {official:,.0f} ac ({100 * (final / official - 1):+.1f}%).",
        frame_check(fire, frame),
        f"{len(spots)} candidate spot components (< {SPOT_ACRES:g} ac, > {TOUCH_M:g} m from the main footprint) "
        f"in spots.geojson, timed by the observation that first maps them, not by when they ignited.",
    ]
    if tolerance > SIMPLIFY_DEG:
        notes.append(f"Simplified at {tolerance:.6f} deg to fit {MAX_BYTES / 1e6:.1f} MB.")
    return " ".join(n for n in notes if n)


def aoi_center(aoi: dict) -> tuple[float, float]:
    west, south, east, north = aoi["bbox"]
    return (west + east) / 2, (south + north) / 2


# ---------------------------------------------------------------- main


def main() -> None:
    fire = load_fire()
    aoi = fire.read_json("aoi.json")
    window = aoi["window_utc"]
    frame = Frame(*aoi_center(aoi))

    fc = fetch_archive(fire)
    if not fc["features"]:
        raise SystemExit(f"No NIFC archive records for IncidentName {fire.nifc_name}")
    records = parse_records(fc, frame, box(*aoi["bbox"]))
    assign_times(records)
    kept = select(records)
    if not kept:
        raise SystemExit(f"No usable NIFC perimeters inside the AOI for {fire.nifc_name}")
    extent = final_extent(records)
    series = cumulative(kept, extent.geom_m)
    spots = find_spots(series, extent.geom_m)

    size, tolerance = write_perimeters(fire, series, frame, window)
    spot_fc = {"type": "FeatureCollection", "features": spot_features(spots, frame, window)}
    (fire.out_dir / "spots.geojson").write_text(dumps(spot_fc))
    audit(fire, records, series, extent, window)
    add_source(fire, layer="Perimeters (time series)", source=SOURCE, url=NIFC_LAYER, status="REAL",
               attribution="National Interagency Fire Center (NIFC)",
               notes=describe(fire, aoi, frame, records, kept, series, spots, extent, tolerance, window))

    official = aoi["official"]["final_acres"]
    final = acres(series[-1].footprint_m)
    print(f"{fire.name}: {len(series)} observations from {len(records)} versions, "
          f"{len(spot_fc['features'])} spots, perimeters.geojson {size / 1e6:.2f} MB, final extent {extent.oid}")
    print(placeholder_note(aoi, records, series))
    for obs in series:
        flag = "" if in_window(obs.t, window) else "  (outside window)"
        print(f"  {iso(obs.t)}  {acres(obs.footprint_m):9,.1f} ac  (union {acres(obs.union_m):9,.1f}, "
              f"observed {acres(obs.observed_m):9,.1f})  {[r.oid for r in obs.records]}{flag}")
    print(f"final {final:,.1f} ac vs official {official:,.1f} ac ({100 * (final / official - 1):+.2f}%)")
    print(frame_check(fire, frame))


if __name__ == "__main__":
    main()
