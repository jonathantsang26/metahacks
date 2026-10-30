"""Physics and inversion checks for ember.spread on synthetic terrain (no data files needed)."""

import numpy as np
import pytest

from ember import spread as sp

N = 61
CELL = 50.0


def flat(code=20, slope_deg=0.0, aspect_deg=0.0):
    lc = np.full((N, N), code, np.uint8)
    return sp.terrain_from_rasters(lc, np.full((N, N), slope_deg), np.full((N, N), aspect_deg), CELL, CELL)


def calm():
    t = np.array([0.0, 100.0])
    return sp.Wind.from_hourly(t, np.zeros(2), np.zeros(2))


def steady(mph, dir_from_deg):
    t = np.array([0.0, 100.0])
    return sp.Wind.from_hourly(t, np.full(2, mph), np.full(2, dir_from_deg))


def test_no_wind_flat_spreads_at_base_rate_and_nearly_circular():
    terr = flat()
    a = sp.arrival(terr, calm(), (30, 30), 0.0)
    r0 = sp.FUEL_TABLE[20][0]
    d = 20 * CELL
    east, north, diag = a[30, 50], a[10, 30], a[16, 44]
    assert east == pytest.approx(d / r0, rel=0.02)
    assert north == pytest.approx(d / r0, rel=0.02)
    # 16-neighbour stencil keeps the off-axis metric error small.
    assert diag == pytest.approx(np.hypot(14, 14) * CELL / r0, rel=0.06)


def test_wind_from_west_pushes_fire_east():
    a = sp.arrival(flat(), steady(30, 270), (30, 30), 0.0)
    east, west, north = a[30, 50], a[30, 10], a[10, 30]
    assert east < north < west
    assert west / east > 5


def test_upslope_is_faster_than_downslope():
    # Aspect 90 = slope faces (descends toward) east, so upslope points west.
    a = sp.arrival(flat(slope_deg=25, aspect_deg=90), calm(), (30, 30), 0.0)
    assert a[30, 10] < a[30, 50]


def test_water_blocks_spread():
    lc = np.full((N, N), 20, np.uint8)
    lc[:, 40] = 80
    terr = sp.terrain_from_rasters(lc, np.zeros((N, N)), np.zeros((N, N)), CELL, CELL)
    a = sp.arrival(terr, calm(), (30, 30), 0.0)
    assert np.isfinite(a[30, 39]) and np.isinf(a[30, 41:]).all()


def test_wind_shift_changes_direction_over_time():
    t = np.array([0.0, 1.0, 1.01, 100.0])
    wind = sp.Wind.from_hourly(t, np.full(4, 30.0), np.array([270.0, 270.0, 0.0, 0.0]))
    a = sp.arrival(flat(), wind, (30, 30), 0.0)
    # Early on the fire runs east; after the shift to a north wind it runs south.
    assert a[30, 45] < a[45, 30] or a[50, 30] < a[30, 10]


def test_batch_matches_single_and_true_ignition_wins():
    terr = flat()
    wind = steady(15, 270)
    truth = sp.arrival(terr, wind, (30, 25), 0.0, k=1.0)
    obs_t = np.array([2.0, 4.0])
    obs = sp.Observations([truth <= t for t in obs_t], obs_t, band_m=500)
    packed = obs.packed(terr)
    cands = np.array([[30, 25, 0.0, 1.0], [25, 35, 0.0, 1.0], [30, 25, 1.0, 1.0], [30, 25, 0.0, 2.0]])
    losses = sp.batch_losses(terr, wind, obs, cands, packed=packed)
    single = sp.loss(sp.arrival(terr, wind, (25, 35), 0.0), terr, obs, packed=packed)
    assert losses[1] == pytest.approx(single, rel=1e-9)
    assert losses[0] == pytest.approx(0.0, abs=1e-9)
    assert losses[0] < min(losses[1:])


def field(rows, cols, u_of, v_of=lambda r, c: 0.0):
    """A steady rows × cols wind field; u_of / v_of give the toward-components per point."""
    t = np.array([0.0, 100.0])
    u = np.array([[u_of(r, c) for r in range(rows) for c in range(cols)]] * 2)
    v = np.array([[v_of(r, c) for r in range(rows) for c in range(cols)]] * 2)
    return sp.Wind.from_field(t, u, v, rows, cols)


def test_uniform_field_matches_single_point_wind():
    terr = flat()
    a = sp.arrival(terr, steady(20, 270), (30, 30), 0.0)
    b = sp.arrival(terr, field(3, 4, lambda r, c: 20.0), (30, 30), 0.0)  # 20 mph toward east everywhere
    np.testing.assert_allclose(a, b, rtol=1e-9)


def test_stencil_weights_interpolate_bilinearly():
    w = field(2, 3, lambda r, c: 10.0 * c + 100.0 * r)
    idx, wts = w.stencil(N, N)
    assert np.allclose(wts.sum(axis=1), 1.0)
    u = (wts * w.u_mph[0][idx]).sum(axis=1).reshape(N, N)
    # Monotone west → east and north → south, clamped flat beyond the outermost points.
    assert (np.diff(u, axis=1) >= -1e-9).all() and (np.diff(u, axis=0) >= -1e-9).all()
    assert u[0, 0] == pytest.approx(0.0) and u[-1, -1] == pytest.approx(120.0)


def test_spatial_wind_only_pushes_where_it_blows():
    # Wind toward the east in the western half of the domain, calm in the eastern half.
    w = field(1, 4, lambda r, c: 30.0 if c < 2 else 0.0)
    a = sp.arrival(flat(), w, (30, 30), 0.0)
    uniform = sp.arrival(flat(), steady(30, 270), (30, 30), 0.0)
    calm_a = sp.arrival(flat(), calm(), (30, 30), 0.0)
    # The eastward run slows once it leaves the windy half, but stays faster than no wind at all.
    assert uniform[30, 58] < a[30, 58] < calm_a[30, 58]
    assert w.mean().u_mph.shape == (w.u_mph.shape[0], 1)
