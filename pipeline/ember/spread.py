"""Anisotropic fire-spread travel times on a grid, and the loss used to invert them.

Physics (deliberately simple, documented in the model card in step 11):
  * Base no-wind, flat-ground rate of spread R0 (m/h) per land-cover class, scaled by a
    global calibration factor k that the inversion fits.
  * Effective wind = midflame wind (10 m wind × wind adjustment factor, per fuel) plus a
    slope-equivalent wind pointing upslope (Rothermel-style tan² slope term).
  * Head rate R_h = k · R0 · (1 + C · U_eff^B).
  * Spread in other directions follows an ellipse with the ignition at its rear focus:
    R(α) = R_h (1 − e) / (1 − e cos α), with eccentricity from Anderson's (1983)
    length-to-breadth ratio LB(U_eff) and α the angle from the effective-wind direction.
  * Arrival times come from a time-dependent Dijkstra over a 16-neighbour stencil; the wind
    used on an edge is the 15-minute-interpolated wind at the source cell's arrival time.

Not modelled: spotting/ember transport, crown fire, suppression, fuel moisture dynamics, and
any spatial variation of wind (one reanalysis point drives the whole domain).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numba import njit, prange

# 16-neighbour stencil: (drow, dcol)
OFFSETS = np.array(
    [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1),
     (-1, -2), (-1, 2), (1, -2), (1, 2), (-2, -1), (-2, 1), (2, -1), (2, 1)],
    np.int64,
)


def _passed_cells(offsets: np.ndarray) -> np.ndarray:
    """For each move, the two cells it cuts past (relative offsets).

    Diagonal and knight moves may only cross between burnable cells; otherwise the stencil
    would let fire hop a one-cell river or road, which is spotting this model does not claim.
    Axis moves list the target itself twice.
    """
    out = np.empty((len(offsets), 2, 2), np.int64)
    for j, (dr, dc) in enumerate(offsets):
        if dr == 0 or dc == 0:
            out[j] = [(dr, dc), (dr, dc)]
        elif abs(dr) == abs(dc):
            out[j] = [(dr, 0), (0, dc)]
        elif abs(dc) == 2:
            out[j] = [(0, dc // 2), (dr, dc // 2)]
        else:
            out[j] = [(dr // 2, 0), (dr // 2, dc)]
    return out


PASSED = _passed_cells(OFFSETS)

C_WIND = 0.32      # head-rate wind coefficient (U in mph)
B_WIND = 1.5       # wind exponent
C_SLOPE = 3.0      # slope factor φ_s = C_SLOPE · tan²(slope)
NEVER = np.inf
WIND_DT_H = 0.25   # wind is resampled to 15-minute steps

# ESA WorldCover code → (R0 m/h, wind adjustment factor). R0 = 0 means non-burnable.
FUEL_TABLE = {
    10: (18.0, 0.20),   # tree cover (timber litter / understory)
    20: (60.0, 0.40),   # shrubland (chaparral)
    30: (90.0, 0.40),   # grassland
    40: (40.0, 0.40),   # cropland
    50: (15.0, 0.30),   # built-up: structure-to-structure spread, very uncertain
    60: (3.0, 0.40),    # bare / sparse
    70: (0.0, 0.0),     # snow / ice
    80: (0.0, 0.0),     # water
    90: (10.0, 0.40),   # herbaceous wetland
    95: (10.0, 0.30),   # mangroves
    100: (5.0, 0.40),   # moss / lichen
}


@dataclass
class Terrain:
    """Per-cell inputs on the (coarse) model grid. Rows run north → south."""

    r0: np.ndarray        # float64 (H, W), m/h; 0 = non-burnable
    waf: np.ndarray       # float64 (H, W)
    up_e: np.ndarray      # float64 (H, W), upslope unit vector, east component
    up_n: np.ndarray      # float64 (H, W), upslope unit vector, north component
    tan_slope: np.ndarray  # float64 (H, W)
    dx: float             # cell size east-west, m
    dy: float             # cell size north-south, m

    @property
    def shape(self):
        return self.r0.shape


@dataclass
class Wind:
    """Spatially uniform wind on a regular time axis (hours since the replay start)."""

    u_mph: np.ndarray     # float64 (T,), toward-east component
    v_mph: np.ndarray     # float64 (T,), toward-north component
    t0_h: float           # hours of the first sample
    dt_h: float = WIND_DT_H

    @classmethod
    def from_hourly(cls, t_h: np.ndarray, speed_mph: np.ndarray, dir_from_deg: np.ndarray) -> "Wind":
        to = np.radians((np.asarray(dir_from_deg) + 180.0) % 360.0)
        u, v = speed_mph * np.sin(to), speed_mph * np.cos(to)
        grid = np.arange(t_h[0], t_h[-1] + 1e-9, WIND_DT_H)
        return cls(np.interp(grid, t_h, u), np.interp(grid, t_h, v), float(t_h[0]))


def terrain_from_rasters(landcover: np.ndarray, slope_deg: np.ndarray, aspect_deg: np.ndarray,
                         dx: float, dy: float) -> Terrain:
    """landcover = WorldCover codes; aspect = downslope direction, degrees clockwise from north."""
    r0 = np.zeros(landcover.shape)
    waf = np.zeros(landcover.shape)
    for code, (rate, factor) in FUEL_TABLE.items():
        sel = landcover == code
        r0[sel], waf[sel] = rate, factor
    up = np.radians((aspect_deg + 180.0) % 360.0)
    return Terrain(
        r0=r0, waf=waf, up_e=np.sin(up), up_n=np.cos(up),
        tan_slope=np.tan(np.radians(np.clip(slope_deg, 0, 60))), dx=float(dx), dy=float(dy),
    )


# ----------------------------------------------------------------------------- kernels


@njit(cache=True, inline="always")
def _ros(r0, waf, up_e, up_n, tan_s, wu, wv, bear_e, bear_n, k):
    """Rate of spread (m/h) from a cell along unit bearing (bear_e, bear_n)."""
    ue = waf * wu
    un = waf * wv
    phi_s = C_SLOPE * tan_s * tan_s
    us = (phi_s / C_WIND) ** (1.0 / B_WIND) if phi_s > 0 else 0.0
    ue += us * up_e
    un += us * up_n
    u = np.sqrt(ue * ue + un * un)
    rh = k * r0 * (1.0 + C_WIND * u ** B_WIND)
    if u < 1e-6:
        return rh
    lb = 0.936 * np.exp(0.2566 * u) + 0.461 * np.exp(-0.1548 * u) - 0.397
    lb = min(max(lb, 1.0), 8.0)
    e = np.sqrt(1.0 - 1.0 / (lb * lb))
    cos_a = (ue * bear_e + un * bear_n) / u
    return rh * (1.0 - e) / (1.0 - e * cos_a)


@njit(cache=True)
def _sift_up(heap, pos, key, i):
    node = heap[i]
    while i > 0:
        parent = (i - 1) >> 1
        pn = heap[parent]
        if key[pn] <= key[node]:
            break
        heap[i] = pn
        pos[pn] = i
        i = parent
    heap[i] = node
    pos[node] = i


@njit(cache=True)
def _sift_down(heap, pos, key, i, n):
    node = heap[i]
    while True:
        child = 2 * i + 1
        if child >= n:
            break
        if child + 1 < n and key[heap[child + 1]] < key[heap[child]]:
            child += 1
        if key[heap[child]] >= key[node]:
            break
        heap[i] = heap[child]
        pos[heap[child]] = i
        i = child
    heap[i] = node
    pos[node] = i


@njit(cache=True)
def _arrival(seed_r, seed_c, t0, r0, waf, up_e, up_n, tan_s, dx, dy,
             wind_u, wind_v, wind_t0, wind_dt, k, t_stop, offsets, passed, out):
    """Time-dependent Dijkstra from one ignition cell; fills out (flat, hours) in place."""
    H, W = r0.shape
    N = H * W
    for i in range(N):
        out[i] = np.inf
    heap = np.empty(N, np.int64)
    pos = np.full(N, -1, np.int64)
    s = seed_r * W + seed_c
    out[s] = t0
    heap[0] = s
    pos[s] = 0
    n = 1
    nt = wind_u.shape[0]
    n_off = offsets.shape[0]
    dist = np.empty(n_off)
    be = np.empty(n_off)
    bn = np.empty(n_off)
    for j in range(n_off):
        e_m = offsets[j, 1] * dx
        n_m = -offsets[j, 0] * dy
        dist[j] = np.sqrt(e_m * e_m + n_m * n_m)
        be[j] = e_m / dist[j]
        bn[j] = n_m / dist[j]
    while n > 0:
        u = heap[0]
        n -= 1
        if n > 0:
            heap[0] = heap[n]
            pos[heap[0]] = 0
            _sift_down(heap, pos, out, 0, n)
        pos[u] = -2
        tu = out[u]
        if tu > t_stop:
            break
        ur = u // W
        uc = u - ur * W
        if r0[ur, uc] <= 0.0:
            continue
        wi = int((tu - wind_t0) / wind_dt)
        wi = 0 if wi < 0 else (nt - 1 if wi >= nt else wi)
        wu = wind_u[wi]
        wv = wind_v[wi]
        for j in range(n_off):
            vr = ur + offsets[j, 0]
            vc = uc + offsets[j, 1]
            if vr < 0 or vr >= H or vc < 0 or vc >= W:
                continue
            v = vr * W + vc
            if pos[v] == -2 or r0[vr, vc] <= 0.0:
                continue
            if (r0[ur + passed[j, 0, 0], uc + passed[j, 0, 1]] <= 0.0
                    or r0[ur + passed[j, 1, 0], uc + passed[j, 1, 1]] <= 0.0):
                continue
            ros = _ros(r0[ur, uc], waf[ur, uc], up_e[ur, uc], up_n[ur, uc], tan_s[ur, uc],
                       wu, wv, be[j], bn[j], k)
            na = tu + dist[j] / ros
            if na < out[v]:
                out[v] = na
                if pos[v] == -1:
                    heap[n] = v
                    pos[v] = n
                    n += 1
                    _sift_up(heap, pos, out, n - 1)
                else:
                    _sift_up(heap, pos, out, pos[v])
    return out


@njit(cache=True)
def _loss(arr, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap):
    """Weighted mean hinge violation in hours over all observations.

    Cells inside an observed footprint should have arrived by its time; cells in a band just
    outside should not have. Unreached cells count as `cap` hours late. The loss is zero at the
    truth for perfect observations (tests/test_spread.py). A two-sided "edge" term (|A − T| on the
    mapped perimeter) was tried and rejected: flanks that stalled against slow fuel burned hours
    before the observation, so it biased the start time.
    """
    total = 0.0
    K = obs_t.shape[0]
    for k in range(K):
        t = obs_t[k]
        s_in = 0.0
        for i in range(inside_ptr[k], inside_ptr[k + 1]):
            a = arr[inside_idx[i]]
            late = a - t if np.isfinite(a) else cap
            if late > 0:
                s_in += min(late, cap)
        s_out = 0.0
        for i in range(band_ptr[k], band_ptr[k + 1]):
            early = t - arr[band_idx[i]]
            if early > 0:
                s_out += min(early, cap)
        n_i = max(inside_ptr[k + 1] - inside_ptr[k], 1)
        n_b = max(band_ptr[k + 1] - band_ptr[k], 1)
        total += obs_w[k] * (s_in / n_i + s_out / n_b)
    return total / max(obs_w.sum(), 1e-12)


@njit(cache=True, parallel=True)
def _batch_losses(cands, r0, waf, up_e, up_n, tan_s, dx, dy, wind_u, wind_v, wind_t0, wind_dt,
                  t_stop, offsets, passed, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap):
    """cands: (M, 4) rows of (row, col, t0_hours, k). Returns (M,) losses."""
    M = cands.shape[0]
    H, W = r0.shape
    losses = np.empty(M)
    for m in prange(M):
        out = np.empty(H * W)
        _arrival(int(cands[m, 0]), int(cands[m, 1]), cands[m, 2], r0, waf, up_e, up_n, tan_s,
                 dx, dy, wind_u, wind_v, wind_t0, wind_dt, cands[m, 3], t_stop, offsets, passed, out)
        losses[m] = _loss(out, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap)
    return losses


# ----------------------------------------------------------------------------- Python API


def arrival(terrain: Terrain, wind: Wind, seed_rc: tuple[int, int], t0_h: float, k: float = 1.0,
            t_stop_h: float = 1e9) -> np.ndarray:
    """Arrival time (hours) of fire from one ignition cell; inf where it never arrives."""
    H, W = terrain.shape
    out = np.empty(H * W)
    _arrival(int(seed_rc[0]), int(seed_rc[1]), float(t0_h), terrain.r0, terrain.waf, terrain.up_e,
             terrain.up_n, terrain.tan_slope, terrain.dx, terrain.dy, wind.u_mph, wind.v_mph,
             wind.t0_h, wind.dt_h, float(k), float(t_stop_h), OFFSETS, PASSED, out)
    return out.reshape(H, W)


@dataclass
class Observations:
    """Observed cumulative footprints (bool masks on the model grid) and their times (hours)."""

    masks: list[np.ndarray]
    t_h: np.ndarray
    band_m: float = 1500.0
    weights: np.ndarray | None = None  # per-observation loss weights (default: equal)

    @property
    def w(self) -> np.ndarray:
        return np.ones(len(self.t_h)) if self.weights is None else np.asarray(self.weights, float)

    def packed(self, terrain: Terrain):
        """Flat index lists for the loss kernel: burnable cells inside, and a band outside."""
        from scipy.ndimage import distance_transform_edt

        burnable = terrain.r0 > 0
        inside, band, ip, bp = [], [], [0], [0]
        for m in self.masks:
            dist_out = distance_transform_edt(~m, sampling=(terrain.dy, terrain.dx))
            ins = np.flatnonzero((m & burnable).ravel())
            bnd = np.flatnonzero(((~m) & burnable & (dist_out <= self.band_m)).ravel())
            inside.append(ins)
            band.append(bnd)
            ip.append(ip[-1] + len(ins))
            bp.append(bp[-1] + len(bnd))
        cat = lambda xs: np.concatenate(xs).astype(np.int64) if xs else np.zeros(0, np.int64)
        return cat(inside), np.array(ip, np.int64), cat(band), np.array(bp, np.int64)


def batch_losses(terrain: Terrain, wind: Wind, obs: Observations, cands: np.ndarray,
                 cap_h: float = 24.0, packed=None) -> np.ndarray:
    """Loss for many (row, col, t0_h, k) candidates, evaluated in parallel."""
    ins, ip, bnd, bp = packed if packed is not None else obs.packed(terrain)
    t_stop = float(obs.t_h.max() + cap_h)
    return _batch_losses(np.ascontiguousarray(cands, np.float64), terrain.r0, terrain.waf,
                         terrain.up_e, terrain.up_n, terrain.tan_slope, terrain.dx, terrain.dy,
                         wind.u_mph, wind.v_mph, wind.t0_h, wind.dt_h, t_stop, OFFSETS, PASSED,
                         ins, ip, bnd, bp, obs.t_h.astype(np.float64), obs.w, float(cap_h))


def loss(arr: np.ndarray, terrain: Terrain, obs: Observations, cap_h: float = 24.0, packed=None) -> float:
    ins, ip, bnd, bp = packed if packed is not None else obs.packed(terrain)
    return float(_loss(arr.ravel(), ins, ip, bnd, bp, obs.t_h.astype(np.float64), obs.w, float(cap_h)))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 1.0
