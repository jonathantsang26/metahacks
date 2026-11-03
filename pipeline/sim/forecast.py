"""One-hour (and any-horizon) fire-spread forecasters, scored honestly. Every output is a FORECAST.

A forecaster gets a `FireState`: the burned footprint at issue time t, the footprint one observation
earlier (for the recent spread rate) and the gap between them. It returns the burned footprint it
expects at t + h. The edge is split into 16 sectors by bearing from the fire's centroid; a sector's
recent advance is the 90th-percentile distance of its newly burned cells to the earlier footprint.

- **persistence:** no growth.
- **uniform:** every edge advances by the recent mean advance rate (the mean over the 16 sectors),
  times h.
- **sector-rate:** each sector keeps its own recent advance rate (per-sector persistence).
- **physics:** the sector's recent rate, adjusted by wind and slope ahead of each cell compared with
  what that sector saw over the last interval: rate * h * clip(ell_f * slope_f / (ell_p * slope_p),
  1/2, 2). ell is Anderson's (1983) wind ellipse (length-to-breadth from the HRRR 10 m wind, midflame
  = 0.4 x 10 m, capped at 8 as in FARSITE); the slope factor doubles the rate per 10 deg upslope and
  halves it per 10 deg downslope (McArthur's rule), clipped to [1/4, 4]. Nothing is fitted across
  issue times.
- **ellipse:** v1 of the physics baseline, kept for the record: the pure ellipse x slope shape with
  one head rate fitted to the recent sector advance. It scored far worse and was replaced by physics.
- **muse:** Muse Spark reads a compact per-sector summary (edge, recent advance, wind, slope) and
  returns a spread distance per sector as a tool call. The code bounds it: distances are clipped to
  [0, MAX_RATE_M_PER_H * h], and a reply with missing, duplicate or non-numeric sectors is rejected
  (and scored as no growth); both are counted.

Scoring (`score`): the forecast's new growth (forecast minus the issue-time footprint) against the
true new growth: recall (share of newly burned ground caught), precision and IoU, pooled over every
eligible issue time.

    uv run --extra sim python -m sim.forecast                                          # cloud: the five non-model ones
    uv run --extra sim python -m sim.forecast --methods persistence uniform sector-rate ellipse physics muse --export --cap-usd 1.4
                                                                    # MODEL_API_KEY; scores, then writes app polygons
    uv run --extra sim python -m sim.forecast --methods physics --export --no-score    # app polygons only
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_erosion, distance_transform_edt

from .world import DATA_DIR, MPH, World, iso, parse_t

LABEL = "FORECAST"
N_SECTORS = 16
#: Physical ceiling on any forecast spread rate. Above the fastest wildfire runs on record (the Camp
#: Fire's head ran at roughly 5 to 6 km/h); anything beyond this is a modelling error, not a fire.
MAX_RATE_M_PER_H = 8000.0
LB_CAP = 8.0
MIDFLAME = 0.4  # midflame / 10 m wind
SLOPE_DOUBLING_DEG = 10.0
#: Official maps closer together than this are one observation (Eaton has pairs 3 and 6 min apart,
#: from different mapping methods); the later one is kept.
MERGE_S = 3600.0
DISCLAIMER = ("FORECAST. Spread forecasts made in hindsight from the fire's mapped edge, HRRR wind (analysis "
              "hours used as a stand-in for the forecast) and terrain. Not an operational product.")


# --------------------------------------------------------------------- state and geometry
@dataclass
class FireState:
    """The footprint at issue time `t` and one observation earlier (`prev`, `dt_prev_s` before)."""

    burned: np.ndarray
    prev: np.ndarray
    t: float
    dt_prev_s: float
    source: str = ""


class Geometry:
    """Per-state edge geometry: nearest-edge distances, sectors, recent per-sector advance."""

    def __init__(self, world: World, st: FireState, n: int = N_SECTORS):
        self.w, self.st, self.n = world, st, n
        cx, cy = world.cell_m
        self.cxy = (cx, cy)
        X, Y = world.cell_xy
        b = st.burned
        self.cx0, self.cy0 = (float(X[b].mean()), float(Y[b].mean())) if b.any() else (float(X.mean()), float(Y.mean()))
        self.dist, idx = distance_transform_edt(~b, sampling=(cy, cx), return_indices=True)
        self.nr, self.nc = idx
        # Sector of each cell: the bearing of its nearest burned cell from the fire's centroid.
        ex, ey = X[self.nr, self.nc], Y[self.nr, self.nc]
        self.sector = self._sector_of(ex, ey)
        # Direction of spread at each unburned cell: away from its nearest edge cell.
        dx, dy = X - ex, Y - ey
        nrm = np.hypot(dx, dy)
        nrm[nrm == 0] = 1.0
        self.ux, self.uy = dx / nrm, dy / nrm
        self.edge = b & ~binary_erosion(b)

    def _sector_of(self, x, y):
        brg = np.degrees(np.arctan2(x - self.cx0, y - self.cy0)) % 360
        return np.minimum((brg / (360 / self.n)).astype(int), self.n - 1)

    @cached_property
    def recent_advance_m(self) -> np.ndarray:
        """Per sector: the 90th percentile distance of newly burned cells (burned minus prev) to prev."""
        st = self.st
        new = st.burned & ~st.prev
        out = np.zeros(self.n)
        if not new.any() or not st.prev.any():
            return out
        X, Y = self.w.cell_xy
        cx, cy = self.cxy
        d = distance_transform_edt(~st.prev, sampling=(cy, cx))[new]
        s = self._sector_of(X[new], Y[new])
        for k in range(self.n):
            if (s == k).any():
                out[k] = float(np.percentile(d[s == k], 90))
        return out

    @property
    def recent_rate_m_per_h(self) -> np.ndarray:
        return self.recent_advance_m / max(self.st.dt_prev_s / 3600, 1e-6)

    def edge_km(self) -> np.ndarray:
        cx, _ = self.cxy
        return np.bincount(self.sector[self.edge], minlength=self.n) * cx / 1000


@dataclass
class Terrain:
    world: World

    @cached_property
    def grad(self):
        cx, cy = self.world.cell_m
        dr, dc = np.gradient(self.world.elevation, cy, cx)
        return dc, -dr  # dz/dx east, dz/dy north (row 0 is north)

    def slope_factor(self, ux, uy):
        gx, gy = self.grad
        deg = np.degrees(np.arctan(gx * ux + gy * uy))
        return np.clip(2.0 ** (deg / SLOPE_DOUBLING_DEG), 0.25, 4.0)


def mean_wind(world: World, t0: float, t1: float, x, y):
    """HRRR 10 m wind (m/s, toward) at points averaged over [t0, t1], sampled at least hourly."""
    k = max(2, int(math.ceil((t1 - t0) / 3600)) + 1)
    us, vs = zip(*(world.wind(t, x, y, agl=10) for t in np.linspace(t0, t1, k)))
    return np.mean(us, axis=0), np.mean(vs, axis=0)


def ellipse_shape(ux, uy, wu, wv):
    """Relative spread rate along (ux, uy) for a wind (wu, wv): 1 at the head, Anderson's ellipse."""
    speed = np.hypot(wu, wv)
    U = speed / MPH * MIDFLAME
    lb = np.clip(0.936 * np.exp(0.2566 * U) + 0.461 * np.exp(-0.1548 * U) - 0.397, 1.0, LB_CAP)
    e = np.sqrt(1 - 1 / lb**2)
    s = np.where(speed > 0, speed, 1.0)
    cos = (ux * wu + uy * wv) / s
    return (1 - e) / (1 - e * cos)


# --------------------------------------------------------------------- forecasters
def _grow(st: FireState, geo: Geometry, reach_m: np.ndarray) -> np.ndarray:
    return st.burned | (geo.dist <= reach_m)


def persistence(world, st, h_s, geo=None):
    return st.burned.copy()


def uniform(world, st, h_s, geo=None):
    geo = geo or Geometry(world, st)
    rate = min(float(geo.recent_rate_m_per_h.mean()), MAX_RATE_M_PER_H)
    return _grow(st, geo, np.full(st.burned.shape, rate * h_s / 3600))


def physics_reach(world: World, st: FireState, h_s: float, geo: Geometry, terrain: Terrain | None = None):
    """Per-cell reach (m) of the wind/slope ellipse, with R_head fitted to the recent sector advance."""
    terrain = terrain or Terrain(world)
    X, Y = world.cell_xy
    h = h_s / 3600
    # Past: shape of each newly burned cell under the wind of the last interval, per sector.
    adv = geo.recent_advance_m
    if not adv.any():
        return np.zeros(st.burned.shape), 0.0
    dtp = max(st.dt_prev_s, 60.0)
    t_prev = st.t - dtp
    ex, ey = X[geo.edge], Y[geo.edge]
    pu, pv = mean_wind(world, t_prev, st.t, ex, ey)
    fu, fv = mean_wind(world, st.t, st.t + h_s, ex, ey)
    # Expected relative advance per sector over the past interval: mean shape x slope along each
    # sector's outward bearing, evaluated at that sector's edge cells.
    sec = geo.sector[geo.edge]
    brg = np.radians((np.arange(geo.n) + 0.5) * 360 / geo.n)
    bx, by = np.sin(brg)[sec], np.cos(brg)[sec]
    rel = ellipse_shape(bx, by, pu, pv) * _slope_at(terrain, bx, by, geo.edge)
    m = np.array([rel[sec == k].mean() if (sec == k).any() else 0.0 for k in range(geo.n)])
    r_head = float((adv * m).sum() / max((m * m).sum(), 1e-9)) / (dtp / 3600)  # m/h at the head
    ratio = float(np.clip(np.hypot(fu, fv).mean() / max(np.hypot(pu, pv).mean(), 0.1), 0.5, 2.0))
    r_head = min(r_head * ratio, MAX_RATE_M_PER_H)
    # Future: each unburned cell, its own spread direction, local wind and slope.
    wu, wv = mean_wind(world, st.t, st.t + h_s, X, Y)
    shape = ellipse_shape(geo.ux, geo.uy, wu, wv) * terrain.slope_factor(geo.ux, geo.uy)
    return np.minimum(r_head * h * shape, MAX_RATE_M_PER_H * h), r_head


def _slope_at(terrain: Terrain, ux, uy, mask):
    gx, gy = terrain.grad
    deg = np.degrees(np.arctan(gx[mask] * ux + gy[mask] * uy))
    return np.clip(2.0 ** (deg / SLOPE_DOUBLING_DEG), 0.25, 4.0)


def sector_rate(world, st, h_s, geo=None):
    """Each sector keeps advancing at its own recent rate (no wind or slope): per-sector persistence."""
    geo = geo or Geometry(world, st)
    return from_sector_distances(st, geo, np.minimum(geo.recent_rate_m_per_h, MAX_RATE_M_PER_H) * h_s / 3600)


def ellipse(world, st, h_s, geo=None):
    """The pure wind/slope ellipse with one fitted head rate (v1 of the physics baseline, kept for the record)."""
    geo = geo or Geometry(world, st)
    reach, _ = physics_reach(world, st, h_s, geo)
    return _grow(st, geo, reach)


def physics_sector_reach(world: World, st: FireState, h_s: float, geo: Geometry, terrain: Terrain | None = None):
    """Per-cell reach (m): each sector keeps its recent observed rate, adjusted by how the wind and
    slope ahead of each cell differ from what that sector's edge saw over the last interval.

    reach(x) = rate[s] * h * clip( ell_f(x) * slope_f(x) / (ell_p[s] * slope_p[s]), 1/2, 2 )

    ell_f: Anderson's ellipse along x's spread direction under the coming wind; ell_p[s]: the same
    along the sector's bearing under the past wind, averaged over the sector's edge; slope_f: the
    slope factor ahead of x; slope_p[s]: the mean slope factor over the sector's recently burned cells.
    """
    terrain = terrain or Terrain(world)
    X, Y = world.cell_xy
    rate = geo.recent_rate_m_per_h
    if not rate.any():
        return np.zeros(st.burned.shape)
    dtp = max(st.dt_prev_s, 60.0)
    sec = geo.sector[geo.edge]
    brg = np.radians((np.arange(geo.n) + 0.5) * 360 / geo.n)
    bx, by = np.sin(brg), np.cos(brg)
    pu, pv = mean_wind(world, st.t - dtp, st.t, X[geo.edge], Y[geo.edge])
    ell_e = ellipse_shape(bx[sec], by[sec], pu, pv)
    ell_p = np.array([ell_e[sec == k].mean() if (sec == k).any() else 1.0 for k in range(geo.n)])
    new = st.burned & ~st.prev
    s_new = geo._sector_of(X[new], Y[new])
    slp_new = _slope_at(terrain, bx[s_new], by[s_new], new)
    slope_p = np.array([slp_new[s_new == k].mean() if (s_new == k).any() else 1.0 for k in range(geo.n)])
    wu, wv = mean_wind(world, st.t, st.t + h_s, X, Y)
    fut = ellipse_shape(geo.ux, geo.uy, wu, wv) * terrain.slope_factor(geo.ux, geo.uy)
    adj = np.clip(fut / (ell_p * slope_p)[geo.sector], 0.5, 2.0)
    return np.minimum(rate[geo.sector] * (h_s / 3600) * adj, MAX_RATE_M_PER_H * h_s / 3600)


def physics(world, st, h_s, geo=None):
    geo = geo or Geometry(world, st)
    return _grow(st, geo, physics_sector_reach(world, st, h_s, geo))


def from_sector_distances(st: FireState, geo: Geometry, dist_m) -> np.ndarray:
    d = np.asarray(dist_m, dtype=float)
    return _grow(st, geo, d[geo.sector])


# --------------------------------------------------------------------- Muse Spark forecaster
FORECAST_RULES = """You forecast wildfire spread from a summary of the fire's mapped edge. The fire's edge is split into sectors by compass bearing from the fire's centroid.
For each sector you get: the edge length, how far that part of the edge advanced over the recent interval, the HRRR 10 m wind over the coming horizon (speed and the compass direction the air moves toward, plus its component pushing outward from that sector), and the mean terrain slope just outside the edge along the sector's outward bearing (positive = upslope).
Return, for every sector, the distance in meters you expect that part of the edge to advance outward over the horizon. Fires run fastest downwind and upslope, and slow on flanks, backing edges and downslope. Use 0 where you expect no growth.
Never discuss what started the fire or who is responsible."""

FORECAST_TOOL = {
    "type": "function",
    "function": {
        "name": "forecast_spread",
        "description": "Outward spread distance per edge sector over the horizon.",
        "parameters": {
            "type": "object",
            "properties": {
                "sectors": {"type": "array", "items": {"type": "object", "properties": {
                    "sector": {"type": "integer"}, "distance_m": {"type": "number"}}, "required": ["sector", "distance_m"]}},
                "note": {"type": "string", "description": "One sentence: where the fire runs next and why."},
            },
            "required": ["sectors"],
        },
    },
}


def summarize_state(world: World, st: FireState, h_s: float, geo: Geometry | None = None,
                    terrain: Terrain | None = None) -> dict:
    """The compact per-sector picture the Muse Spark forecaster reads (no arrival raster, no truth)."""
    geo = geo or Geometry(world, st)
    terrain = terrain or Terrain(world)
    X, Y = world.cell_xy
    gx, gy = terrain.grad
    edge_km = geo.edge_km()
    band = (~st.burned) & (geo.dist <= 500)
    sectors = []
    for k in range(geo.n):
        brg = (k + 0.5) * 360 / geo.n
        bx, by = math.sin(math.radians(brg)), math.cos(math.radians(brg))
        e = geo.edge & (geo.sector == k)
        row = {"sector": k, "bearing_deg": round(brg), "edge_km": round(float(edge_km[k]), 2),
               "recent_advance_m": round(float(geo.recent_advance_m[k]))}
        if e.any():
            u, v = mean_wind(world, st.t, st.t + h_s, X[e], Y[e])
            u, v = float(u.mean()), float(v.mean())
            row["wind_ms"] = round(math.hypot(u, v), 1)
            row["wind_toward_deg"] = round(math.degrees(math.atan2(u, v)) % 360)
            row["wind_outward_ms"] = round(u * bx + v * by, 1)
        b = band & (geo.sector == k)
        if b.any():
            row["slope_pct"] = round(float(np.mean(gx[b] * bx + gy[b] * by)) * 100)
        sectors.append(row)
    area_ha = float(st.burned.sum()) * world.cell_m[0] * world.cell_m[1] / 1e4
    return {"issued_utc": iso(st.t), "horizon_h": round(h_s / 3600, 2), "recent_interval_h": round(st.dt_prev_s / 3600, 2),
            "burned_area_ha": round(area_ha), "max_rate_m_per_h": MAX_RATE_M_PER_H, "sectors": sectors}


def validate(args, n: int, h_s: float) -> tuple[np.ndarray | None, str | None, int]:
    """Model output -> per-sector distances (m), or (None, why) when malformed. Returns clipped count."""
    if not isinstance(args, dict) or not isinstance(args.get("sectors"), list):
        return None, "no sectors list", 0
    out = np.full(n, np.nan)
    cap = MAX_RATE_M_PER_H * h_s / 3600
    clipped = 0
    for s in args["sectors"]:
        try:
            k, d = int(s["sector"]), float(s["distance_m"])
        except (KeyError, TypeError, ValueError):
            return None, "malformed sector entry", 0
        if not 0 <= k < n or not math.isfinite(d):
            return None, f"sector {k} out of range or non-finite distance", 0
        if not math.isnan(out[k]):
            return None, f"sector {k} given twice", 0
        if d < 0 or d > cap:
            clipped += 1
        out[k] = min(max(d, 0.0), cap)
    if np.isnan(out).any():
        return None, f"{int(np.isnan(out).sum())} of {n} sectors missing", 0
    return out, None, clipped


class MuseForecaster:
    """Per-sector spread distances from Muse Spark (a real tool call), bounded and validated in code."""

    name = "muse"

    def __init__(self, client, model: str | None = None, cap_usd: float = 2.0, ledger=None):
        from .muse import MODEL, Ledger, MuseSwarm

        self.client, self.model = client, model or MODEL
        self.ledger = ledger or Ledger(cap_usd)
        self.transcript: list[dict] = []
        self._call = MuseSwarm._call.__get__(self)
        self.calls = self.rejected = self.clipped = 0
        self.log: list[dict] = []
        self.cache: dict = {}

    def distances(self, world, st, h_s, geo):
        from .muse import scrub

        summ = summarize_state(world, st, h_s, geo)
        key = (st.source, summ["issued_utc"], round(h_s))
        if key in self.cache:  # the same question (e.g. scoring, then export) is asked once
            return self.cache[key]
        args, err = self._call("forecaster", [{"role": "system", "content": FORECAST_RULES},
                                              {"role": "user", "content": json.dumps(summ, separators=(",", ":"))}], FORECAST_TOOL)
        self.calls += 1
        d, why, clipped = (None, err, 0) if err else validate(args, geo.n, h_s)
        self.clipped += clipped
        if d is None:
            self.rejected += 1
        self.log.append({"issued_utc": summ["issued_utc"], "horizon_h": summ["horizon_h"], "rejected": why,
                         "clipped": clipped, "distance_m": None if d is None else [round(float(x)) for x in d],
                         "note": scrub((args or {}).get("note", "")) if isinstance(args, dict) else ""})
        self.cache[key] = d
        return d

    def __call__(self, world, st, h_s, geo=None):
        geo = geo or Geometry(world, st)
        d = self.distances(world, st, h_s, geo)
        if d is None:  # rejected: scored as no growth, never filled in by another forecaster
            return st.burned.copy()
        return from_sector_distances(st, geo, d)


METHODS = {"persistence": persistence, "uniform": uniform, "sector-rate": sector_rate, "ellipse": ellipse, "physics": physics}


# --------------------------------------------------------------------- truth
def official_maps(world: World) -> list[tuple[float, np.ndarray]]:
    """The NIFC perimeters (in-window, cumulative) on the analysis grid, maps < 1 h apart merged,
    preceded by the official start as a single burned cell."""
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds

    H, W = world.grid_shape
    tr = from_bounds(*world.bounds, W, H)
    fc = world._json("perimeters.geojson")
    feats = sorted((f for f in fc["features"] if f["properties"].get("in_window", True)), key=lambda f: f["properties"]["t"])
    meta = world._json("arrival_meta.json")["seed"]
    seed = np.zeros((H, W), bool)
    r, c = world.cell_of(*world.to_local(*meta["lonlat"]))
    seed[r, c] = True
    out = [(parse_t(meta["t"]), seed)]
    cum = seed.copy()
    for f in feats:
        m = rasterize([(f["geometry"], 1)], out_shape=(H, W), transform=tr).astype(bool) | cum
        t = parse_t(f["properties"]["t"])
        if m.sum() <= cum.sum():
            continue
        cum = m
        if t - out[-1][0] < MERGE_S and len(out) > 1:
            out[-1] = (t, m)
        else:
            out.append((t, m))
    return out


def score(pred: np.ndarray, base: np.ndarray, truth: np.ndarray) -> dict:
    p, g = pred & ~base, truth & ~base
    tp, fp, fn = int((p & g).sum()), int((p & ~g).sum()), int((~p & g).sum())
    return {"tp": tp, "fp": fp, "fn": fn, **_rates(tp, fp, fn)}


def _rates(tp, fp, fn):
    return {"recall": tp / (tp + fn) if tp + fn else None, "precision": tp / (tp + fp) if tp + fp else None,
            "iou": tp / (tp + fp + fn) if tp + fp + fn else None}


def pool(rows: list[dict]) -> dict:
    tp, fp, fn = (sum(r[k] for r in rows) for k in ("tp", "fp", "fn"))
    ious = [r["iou"] for r in rows if r["iou"] is not None]
    return {"issues": len(rows), **_rates(tp, fp, fn), "mean_iou": float(np.mean(ious)) if ious else None}


def issue_times(world: World, maps) -> list[float]:
    """Every whole hour from 2 h after the official start up to the last official map's hour."""
    t0, t_last = maps[0][0], maps[-1][0]
    t = math.ceil((t0 + 7200) / 3600) * 3600
    return [float(x) for x in np.arange(t, t_last - 3600 + 1, 3600)]


def evaluate(world: World, methods: dict, log=None) -> dict:
    """(a) +1 h vs the modeled arrival map, hourly; (b) issued at each official map, scored at the next
    official map; (c) issued hourly from the modeled map, scored at the next official map (leaks)."""
    maps = official_maps(world)
    A = world.arrival
    out = {"a_modeled_1h": {m: [] for m in methods}, "b_official": {m: [] for m in methods},
           "c_hourly_to_next_official": {m: [] for m in methods}}
    times = issue_times(world, maps)
    for t in times:
        st = FireState(A <= t, A <= t - 3600, t, 3600, "modeled")
        if not st.prev.any():
            continue
        geo = Geometry(world, st)
        truth = A <= t + 3600
        nxt = next(((T, m) for T, m in maps if T > t), None)
        for name, f in methods.items():
            r = score(f(world, st, 3600, geo), st.burned, truth)
            out["a_modeled_1h"][name].append({"issued_utc": iso(t), **r})
            if nxt and name != "muse":  # (c) leaks the future map; not worth model calls
                T, m = nxt
                r = score(f(world, st, T - t, geo), st.burned, m | st.burned)
                out["c_hourly_to_next_official"][name].append({"issued_utc": iso(t), "valid_utc": iso(T), **r})
        if log:
            log(f"{iso(t)} " + " ".join(f"{n}={out['a_modeled_1h'][n][-1]['iou'] or 0:.2f}" for n in methods))
    for k in range(1, len(maps) - 1):
        (tp_, mp), (t, m), (tn, mn) = maps[k - 1], maps[k], maps[k + 1]
        st = FireState(m, mp, t, t - tp_, "official")
        geo = Geometry(world, st)
        for name, f in methods.items():
            r = score(f(world, st, tn - t, geo), m, mn)
            out["b_official"][name].append({"issued_utc": iso(t), "valid_utc": iso(tn), "horizon_h": round((tn - t) / 3600, 2), **r})
    for k, v in out.items():
        for name, rows in v.items():
            rows[:] = [r for r in rows if r["tp"] + r["fn"] > 0]  # recall needs some real new growth
    return {"label": LABEL, "disclaimer": DISCLAIMER, "fire": world.fire,
            "official_maps_utc": [iso(t) for t, _ in maps],
            "summary": {k: {n: pool(rows) for n, rows in v.items()} for k, v in out.items()},
            "per_issue": out}


# --------------------------------------------------------------------- for the swarm
class SwarmForecast:
    """The forecast edge a swarm commander can target, from public information only: the latest
    official map published by time t (and the one before it, for the recent rate) plus the cells the
    swarm itself has seen burned. Never the arrival raster.

    `targets(t, seen_t)` returns where the forecaster expects the fire to spread in the next hour: the
    band between its footprint for t and for t + 1 h (both forecast from the latest official map, and
    minus what the swarm has seen burned), split into areas by bearing from the fire's centroid.
    The Muse Spark forecaster is asked once per call for horizon t + 1 h; its per-sector distances are
    scaled linearly to horizon t for the inner edge of the band.
    """

    def __init__(self, world: World, method: str = "physics", muse: "MuseForecaster | None" = None, k: int = 6):
        self.world, self.method, self.muse, self.k = world, method, muse, k
        self.maps = official_maps(world)
        self.terrain = Terrain(world)

    def state(self, t: float) -> FireState | None:
        past = [(T, m) for T, m in self.maps if T <= t]
        if len(past) < 2:
            return None
        (tp, mp), (tl, ml) = past[-2], past[-1]
        return FireState(ml, mp, tl, tl - tp, "official")

    def targets(self, t: float, seen_t: np.ndarray | None = None) -> dict | None:
        st = self.state(t)
        if st is None:
            return None
        geo = Geometry(self.world, st)
        h0, h1 = t - st.t, t + 3600 - st.t
        if self.method == "muse":
            if self.muse is None:
                raise ValueError("method 'muse' needs a MuseForecaster attached")
            d1 = self.muse.distances(self.world, st, h1, geo)
            if d1 is None:
                return {"method": "muse", "from_map_utc": iso(st.t), "valid_utc": iso(t + 3600), "rejected": True, "growth_areas": []}
            f0, f1 = (from_sector_distances(st, geo, d1 * (h0 / h1)), from_sector_distances(st, geo, d1))
        elif self.method == "map-edge":  # ablation: no forecast, just a 300 m ring outside the latest map
            f0, f1 = st.burned, _grow(st, geo, np.full(st.burned.shape, 300.0))
        else:
            f0 = _grow(st, geo, physics_sector_reach(self.world, st, h0, geo, self.terrain)) if h0 > 0 else st.burned
            f1 = _grow(st, geo, physics_sector_reach(self.world, st, h1, geo, self.terrain))
        seen = np.isfinite(seen_t) & (seen_t <= t) if seen_t is not None else np.zeros_like(st.burned)
        band = f1 & ~f0 & ~seen
        X, Y = self.world.cell_xy
        cell_ha = self.world.cell_m[0] * self.world.cell_m[1] / 1e4
        areas = []
        for s in range(geo.n):
            m = band & (geo.sector == s)
            n = int(m.sum())
            if n * cell_ha < 2:
                continue
            areas.append({"center_km": [round(float(X[m].mean()) / 1000, 2), round(float(Y[m].mean()) / 1000, 2)],
                          "area_ha": round(n * cell_ha), "bearing_deg": round((s + 0.5) * 360 / geo.n)})
        areas.sort(key=lambda a: -a["area_ha"])
        return {"method": self.method, "status": LABEL, "from_map_utc": iso(st.t), "valid_utc": iso(t + 3600),
                "note": "Where the forecaster expects the fire to spread in the next hour, from the latest official map. "
                        "The front should be there: keep cameras on these areas.",
                "growth_areas": areas[: self.k]}


# --------------------------------------------------------------------- export for the app
def _polygons(world: World, mask: np.ndarray, tol_deg: float = 1e-4):
    from rasterio.features import shapes
    from rasterio.transform import from_bounds
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union

    H, W = world.grid_shape
    tr = from_bounds(*world.bounds, W, H)
    polys = [shape(g) for g, v in shapes(mask.astype(np.uint8), mask=mask, transform=tr) if v == 1]
    if not polys:
        return None
    geom = unary_union(polys).simplify(tol_deg, preserve_topology=True)
    g = mapping(geom)

    def rnd(c):
        return [rnd(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 5), round(c[1], 5)]

    return {"type": g["type"], "coordinates": rnd(g["coordinates"])}


def fname(t: float) -> str:
    return iso(t).replace(":", "")[:13] + "Z.geojson"  # 2025-01-08T04Z.geojson


def export(world: World, method: str, out_dir: Path, forecaster=None, times: list[float] | None = None) -> list[str]:
    """One FeatureCollection per hourly issue time with the +1 h forecast footprint; features of other
    methods already in a file are kept, so physics and muse share files."""
    out_dir.mkdir(parents=True, exist_ok=True)
    A = world.arrival
    f = forecaster or METHODS[method]
    written = []
    for t in times or issue_times(world, official_maps(world)):
        st = FireState(A <= t, A <= t - 3600, t, 3600, "modeled")
        if not st.prev.any():
            continue
        g = _polygons(world, f(world, st, 3600))
        if g is None:
            continue
        p = out_dir / fname(t)
        fc = json.loads(p.read_text()) if p.exists() else {"type": "FeatureCollection", "features": []}
        fc["features"] = [x for x in fc["features"] if x["properties"]["method"] != method]
        fc["features"].append({"type": "Feature", "geometry": g, "properties": {
            "issued_utc": iso(t), "valid_utc": iso(t + 3600), "method": method, "status": LABEL}})
        fc["features"].sort(key=lambda x: x["properties"]["method"])
        p.write_text(json.dumps(fc, separators=(",", ":")) + "\n")
        written.append(p.name)
    files = sorted({p.name for p in out_dir.glob("*Z.geojson")})
    (out_dir / "index.json").write_text(json.dumps(files, indent=0) + "\n")
    return written


# --------------------------------------------------------------------- CLI
def table(doc: dict) -> str:
    names = {"a_modeled_1h": "+1 h vs our modeled arrival map", "b_official": "issued at an official map, scored at the next official map",
             "c_hourly_to_next_official": "issued hourly from the modeled map, scored at the next official map (leaks: see caveats)"}
    lines = []
    for k, label in names.items():
        lines.append(f"\n{label}\n| Forecaster | Issue times | Caught (recall) | Precision | IoU (pooled) | Mean IoU |\n|---|---|---|---|---|---|")
        for n, s in doc["summary"][k].items():
            f = lambda x: "–" if x is None else f"{100 * x:.1f}%"  # noqa: E731
            lines.append(f"| {n} | {s['issues']} | {f(s['recall'])} | {f(s['precision'])} | {f(s['iou'])} | {f(s['mean_iou'])} |")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--fire", default="eaton")
    ap.add_argument("--methods", nargs="+", default=["persistence", "uniform", "sector-rate", "ellipse", "physics"], choices=[*METHODS, "muse"])
    ap.add_argument("--cap-usd", type=float, default=1.5, help="hard cap on Muse Spark spend for this run")
    ap.add_argument("--mock", action="store_true", help="Muse forecaster on the deterministic stand-in (never published)")
    ap.add_argument("--export", action="store_true", help="also write the app's +1 h forecast polygons (forecast/) for physics/muse")
    ap.add_argument("--no-score", action="store_true", help="with --export: skip scoring")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args(argv)
    world = World(a.fire)
    out = a.out or DATA_DIR / a.fire / "forecast"
    if a.mock and out.resolve().is_relative_to((DATA_DIR.parent.parent).resolve()):
        raise SystemExit("--mock output can't go under web/: pass --out to a scratch directory.")
    methods, muse = {}, None
    for m in a.methods:
        if m == "muse":
            from .muse import MockClient, make_client
            from .run import load_env_file

            if a.mock:
                muse = MuseForecaster(MockClient(), model="mock", cap_usd=a.cap_usd)
            else:
                load_env_file()
                muse = MuseForecaster(make_client(), cap_usd=a.cap_usd)
            methods[m] = muse
        else:
            methods[m] = METHODS[m]
    if a.no_score:
        _export(world, methods, out, muse)
        return
    doc = evaluate(world, methods, log=lambda s: print(s, file=sys.stderr, flush=True))
    if muse:
        doc["muse"] = {"model": muse.model, "calls": muse.calls, "rejected": muse.rejected, "clipped_sectors": muse.clipped,
                       "spent_usd": round(muse.ledger.spent_usd, 4), "cap_usd": a.cap_usd}
    out.mkdir(parents=True, exist_ok=True)
    # One eval.json: the Mac run with muse scores every method again and supersedes the cloud one.
    (out / "eval.json").write_text(json.dumps(doc, indent=1) + "\n")
    _write_muse_log(out, muse, "eval")
    print(table(doc))
    if muse:
        print(json.dumps(doc["muse"]))
    if a.export:
        _export(world, methods, out, muse)


def _export(world, methods, out, muse):
    for m, f in methods.items():
        if m in ("physics", "muse"):
            print(f"{m}: {len(export(world, m, out, f))} files", file=sys.stderr)
    _write_muse_log(out, muse, "export")


def _write_muse_log(out: Path, muse, kind: str):
    if muse:
        (out / f"muse_{kind}_log.json").write_text(json.dumps({"label": LABEL, "model": muse.model, "calls": muse.calls,
                                                               "rejected": muse.rejected, "clipped_sectors": muse.clipped,
                                                               "spent_usd": round(muse.ledger.spent_usd, 4), "forecasts": muse.log}, indent=1) + "\n")


if __name__ == "__main__":
    main()
