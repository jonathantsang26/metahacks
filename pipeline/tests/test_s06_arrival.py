"""Arrival raster and derived series honour the observed perimeters (committed outputs)."""

import numpy as np
from PIL import Image

from ember.grid import Grid
from steps.s06_arrival import parse_t


def decode(fire):
    aoi = fire.read_json("aoi.json")
    w0, w1 = (parse_t(s) for s in aoi["window_utc"])
    code = np.asarray(Image.open(fire.out_dir / "arrival.png"))[..., 0].astype(float)
    hours = np.where(code == 255, np.nan, (code - 1) / 253 * (w1 - w0).total_seconds() / 3600)
    return hours, w0


def test_arrival_grid_matches_analysis_grid(fire):
    g = Grid.for_fire(fire)
    hours, _ = decode(fire)
    assert hours.shape == g.shape
    assert 0.02 < np.isfinite(hours).mean() < 0.9


def test_footprints_have_burned_by_their_observation_time(fire):
    g = Grid.for_fire(fire)
    hours, w0 = decode(fire)
    step = (parse_t(fire.read_json("aoi.json")["window_utc"][1]) - w0).total_seconds() / 3600 / 253
    for f in fire.read_json("perimeters.geojson")["features"]:
        t = (parse_t(f["properties"]["t"]) - w0).total_seconds() / 3600
        mask = g.rasterize([f["geometry"]]).astype(bool)
        inside = hours[mask]
        assert np.isfinite(inside).mean() > 0.98
        # 8-bit encoding quantizes to ~28 min; allow one code step.
        assert (inside[np.isfinite(inside)] <= t + step + 1e-6).mean() > 0.98


def test_series_and_spine_are_consistent(fire):
    s = fire.read_json("series.json")
    area = np.array(s["area_acres"])
    assert len(s["t"]) == len(area) == len(s["ros_chains_hr"])
    assert np.all(np.diff(area) >= -1e-6)
    assert abs(area[-1] - fire.read_json("arrival_meta.json")["burned_acres"]) / area[-1] < 0.05
    spine = fire.read_json("spine.geojson")["features"]
    line = [f for f in spine if f["properties"]["kind"] == "spine"][0]["geometry"]["coordinates"]
    assert len(line) >= 10
    p = fire.read_json("profile.json")
    assert len(p["distance_km"]) == len(p["elevation_m"]) == len(p["t"]) >= 5
    assert p["t"] == sorted(p["t"])
