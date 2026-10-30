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
    used on an edge is the wind at the source cell, interpolated to 15-minute steps in time and
    bilinearly in space from a coarse grid of wind points (one point = spatially uniform wind).

Not modelled: spotting/ember transport, crown fire, suppression, fuel moisture dynamics, and
wind structure finer than the wind grid (HRRR, 3 km: valley channelling below that is missed).
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
LB_MAX = 8.0       # default cap on the length-to-breadth ratio (Anderson's curve saturates near 8)
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
    """Wind on a regular time axis (hours since the replay start), on a coarse grid of points.

    u_mph / v_mph are (T, P): P = rows × cols points at the centers of a rows × cols partition
    of the model domain, north row first, west to east. rows = cols = 1 is spatially uniform.
    """

    u_mph: np.ndarray     # float64 (T, P), toward-east component
    v_mph: np.ndarray     # float64 (T, P), toward-north component
    t0_h: float           # hours of the first sample
    dt_h: float = WIND_DT_H
    rows: int = 1
    cols: int = 1

    def __post_init__(self):
        self.u_mph = np.ascontiguousarray(np.asarray(self.u_mph, float).reshape(len(self.u_mph), -1))
        self.v_mph = np.ascontiguousarray(np.asarray(self.v_mph, float).reshape(len(self.v_mph), -1))
        if self.u_mph.shape != self.v_mph.shape or self.u_mph.shape[1] != self.rows * self.cols:
            raise ValueError(f"wind arrays {self.u_mph.shape} do not match a {self.rows}×{self.cols} grid")

    @classmethod
    def from_hourly(cls, t_h: np.ndarray, speed_mph: np.ndarray, dir_from_deg: np.ndarray) -> "Wind":
        """Spatially uniform wind from one hourly series (meteorological FROM direction)."""
        to = np.radians((np.asarray(dir_from_deg) + 180.0) % 360.0)
        u, v = speed_mph * np.sin(to), speed_mph * np.cos(to)
        grid = np.arange(t_h[0], t_h[-1] + 1e-9, WIND_DT_H)
        return cls(np.interp(grid, t_h, u), np.interp(grid, t_h, v), float(t_h[0]))

    @classmethod
    def from_field(cls, t_h: np.ndarray, u_mph: np.ndarray, v_mph: np.ndarray, rows: int, cols: int) -> "Wind":
        """Gridded wind from hourly (T, P) toward-components, resampled to 15-minute steps."""
        grid = np.arange(t_h[0], t_h[-1] + 1e-9, WIND_DT_H)
        resample = lambda a: np.stack([np.interp(grid, t_h, a[:, p]) for p in range(a.shape[1])], axis=1)
        return cls(resample(np.asarray(u_mph, float)), resample(np.asarray(v_mph, float)), float(t_h[0]),
                   rows=rows, cols=cols)

    def scaled(self, factor: float) -> "Wind":
        return Wind(self.u_mph * factor, self.v_mph * factor, self.t0_h, self.dt_h, self.rows, self.cols)

    def shifted(self, hours: float) -> "Wind":
        """The same wind history, arriving `hours` later (a timing error in the weather model)."""
        return Wind(self.u_mph, self.v_mph, self.t0_h + hours, self.dt_h, self.rows, self.cols)

    def mean(self) -> "Wind":
        """Spatially uniform wind: the domain mean of every time step."""
        return Wind(self.u_mph.mean(axis=1), self.v_mph.mean(axis=1), self.t0_h, self.dt_h)

    def stencil(self, H: int, W: int) -> tuple[np.ndarray, np.ndarray]:
        """Bilinear interpolation from the wind points to every cell of an H × W grid:
        four point indices and four weights per cell, flat row-major."""
        def axis(n_cells, n_pts):
            x = np.clip((np.arange(n_cells) + 0.5) * n_pts / n_cells - 0.5, 0, n_pts - 1)
            lo = np.minimum(np.floor(x).astype(np.int64), max(n_pts - 2, 0))
            hi = np.minimum(lo + 1, n_pts - 1)
            return lo, hi, x - lo
        r0, r1, fy = axis(H, self.rows)
        c0, c1, fx = axis(W, self.cols)
        R0, C0 = np.meshgrid(r0, c0, indexing="ij")
        R1, C1 = np.meshgrid(r1, c1, indexing="ij")
        FY, FX = np.meshgrid(fy, fx, indexing="ij")
        idx = np.stack([R0 * self.cols + C0, R0 * self.cols + C1, R1 * self.cols + C0, R1 * self.cols + C1], -1)
        wts = np.stack([(1 - FY) * (1 - FX), (1 - FY) * FX, FY * (1 - FX), FY * FX], -1)
        return np.ascontiguousarray(idx.reshape(-1, 4)), np.ascontiguousarray(wts.reshape(-1, 4))


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
def _ros(r0, waf, up_e, up_n, tan_s, wu, wv, bear_e, bear_n, k, lb_max):
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
    lb = min(max(lb, 1.0), lb_max)
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
             wind_u, wind_v, wind_t0, wind_dt, widx, wwts, k, lb_max, t_stop, offsets, passed, out):
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
        wu = 0.0
        wv = 0.0
        for q in range(4):
            wu += wwts[u, q] * wind_u[wi, widx[u, q]]
            wv += wwts[u, q] * wind_v[wi, widx[u, q]]
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
                       wu, wv, be[j], bn[j], k, lb_max)
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
def _batch_losses(cands, r0, waf, up_e, up_n, tan_s, dx, dy, wind_u, wind_v, wind_t0, wind_dt, widx, wwts,
                  t_stop, offsets, passed, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap):
    """cands: (M, 5) rows of (row, col, t0_hours, k, lb_max). Returns (M,) losses."""
    M = cands.shape[0]
    H, W = r0.shape
    losses = np.empty(M)
    for m in prange(M):
        out = np.empty(H * W)
        _arrival(int(cands[m, 0]), int(cands[m, 1]), cands[m, 2], r0, waf, up_e, up_n, tan_s,
                 dx, dy, wind_u, wind_v, wind_t0, wind_dt, widx, wwts, cands[m, 3], cands[m, 4], t_stop,
                 offsets, passed, out)
        losses[m] = _loss(out, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap)
    return losses


# ----------------------------------------------------------------------------- Python API


def arrival(terrain: Terrain, wind: Wind, seed_rc: tuple[int, int], t0_h: float, k: float = 1.0,
            t_stop_h: float = 1e9, lb_max: float = LB_MAX) -> np.ndarray:
    """Arrival time (hours) of fire from one ignition cell; inf where it never arrives."""
    H, W = terrain.shape
    out = np.empty(H * W)
    widx, wwts = wind.stencil(H, W)
    _arrival(int(seed_rc[0]), int(seed_rc[1]), float(t0_h), terrain.r0, terrain.waf, terrain.up_e,
             terrain.up_n, terrain.tan_slope, terrain.dx, terrain.dy, wind.u_mph, wind.v_mph,
             wind.t0_h, wind.dt_h, widx, wwts, float(k), float(lb_max), float(t_stop_h), OFFSETS, PASSED, out)
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
    """Loss for many (row, col, t0_h, k[, lb_max]) candidates, evaluated in parallel."""
    ins, ip, bnd, bp = packed if packed is not None else obs.packed(terrain)
    cands = np.asarray(cands, np.float64)
    if cands.shape[1] == 4:
        cands = np.hstack([cands, np.full((len(cands), 1), LB_MAX)])
    t_stop = float(obs.t_h.max() + cap_h)
    widx, wwts = wind.stencil(*terrain.shape)
    return _batch_losses(np.ascontiguousarray(cands, np.float64), terrain.r0, terrain.waf,
                         terrain.up_e, terrain.up_n, terrain.tan_slope, terrain.dx, terrain.dy,
                         wind.u_mph, wind.v_mph, wind.t0_h, wind.dt_h, widx, wwts, t_stop, OFFSETS, PASSED,
                         ins, ip, bnd, bp, obs.t_h.astype(np.float64), obs.w, float(cap_h))


def loss(arr: np.ndarray, terrain: Terrain, obs: Observations, cap_h: float = 24.0, packed=None) -> float:
    ins, ip, bnd, bp = packed if packed is not None else obs.packed(terrain)
    return float(_loss(arr.ravel(), ins, ip, bnd, bp, obs.t_h.astype(np.float64), obs.w, float(cap_h)))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 1.0
