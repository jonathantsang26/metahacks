import numpy as np

from ember.geo import terrarium_decode, terrarium_encode
from ember.grid import Grid


def test_terrarium_round_trip():
    elev = np.array([[0.0, 145.8], [1877.3, -10.5]], np.float32)
    out = terrarium_decode(terrarium_encode(elev))
    assert np.allclose(out, elev, atol=1 / 256 + 1e-4)


def test_grid_pixel_round_trip(fire):
    g = Grid.for_fire(fire)
    col, row = np.array([0, g.width - 1, 37]), np.array([0, g.height - 1, 11])
    lon, lat = g.to_lonlat(col, row)
    c2, r2 = g.to_px(lon, lat)
    assert np.allclose(c2, col) and np.allclose(r2, row)
    assert abs(g.pixel_m[0] - 15.8) < 1.5 and abs(g.pixel_m[1] - 15.8) < 1.5


def test_rasterize_box(fire):
    g = Grid.for_fire(fire)
    w, s, e, n = g.bounds
    box = {"type": "Polygon", "coordinates": [[[w, s], [(w + e) / 2, s], [(w + e) / 2, n], [w, n], [w, s]]]}
    mask = g.rasterize([box])
    assert 0.45 < mask.mean() < 0.55 and mask[:, 0].all() and not mask[:, -1].any()
