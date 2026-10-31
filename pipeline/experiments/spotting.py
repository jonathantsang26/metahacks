"""Feasibility check: does a deterministic ember-spotting edge move Palisades off the k ceiling?

Under every wind tried, the Palisades fit's spread-rate scale k sits at the model's ceiling
(README: "Palisades is beyond the model"). The obvious missing mechanism is spotting. Before
changing the shipped model and rerunning the 3-hour benchmark, this script asks the cheap
question on the real fit only.

Spotting here is one extra edge per burning cell: when the HRRR wind at the cell and time is at
least SPOT_WIND mph, the cell SPOT_M metres downwind (along the wind vector) ignites SPOT_TAU
hours later unless the front reaches it first. It is deterministic, so fits stay reproducible.
The kernel is a copy of ember.spread._arrival with that edge added; the shipped model is not
touched. Each setting refits the full Palisades fit (every perimeter in the fit horizon) at the
fire's length-to-breadth cap, and reports k, the fit loss, the start time and the forward
run's footprint IoU.

Run from pipeline/: uv run python -m experiments.spotting [fire]
Writes: experiments/spotting_<fire>.json
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
from numba import njit, prange

from ember import spread as sp
from steps import s11_ignition as s11

SETTINGS = [  # (SPOT_M, SPOT_WIND mph, SPOT_TAU h); (0, ...) is the shipped model
    (0.0, 0.0, 0.0),
    (500.0, 25.0, 0.25),
    (1000.0, 25.0, 0.25),
    (2000.0, 25.0, 0.25),
    (1000.0, 15.0, 0.25),
    (2000.0, 15.0, 0.25),
]


@njit(cache=False)
def _arrival_spot(seed_r, seed_c, t0, r0, waf, up_e, up_n, tan_s, dx, dy, wind_u, wind_v, wind_t0, wind_dt,
                  widx, wwts, k, lb_max, t_stop, offsets, passed, spot_m, spot_wind, spot_tau, out):
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
            sp._sift_down(heap, pos, out, 0, n)
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
            ros = sp._ros(r0[ur, uc], waf[ur, uc], up_e[ur, uc], up_n[ur, uc], tan_s[ur, uc],
                          wu, wv, be[j], bn[j], k, lb_max)
            na = tu + dist[j] / ros
            if na < out[v]:
                out[v] = na
                if pos[v] == -1:
                    heap[n] = v
                    pos[v] = n
                    n += 1
                    sp._sift_up(heap, pos, out, n - 1)
                else:
                    sp._sift_up(heap, pos, out, pos[v])
        # Spotting: one deterministic ember edge downwind (u/v point where the air moves).
        ws = np.sqrt(wu * wu + wv * wv)
        if spot_m > 0.0 and ws >= spot_wind:
            vc = uc + int(np.round(spot_m * (wu / ws) / dx))
            vr = ur - int(np.round(spot_m * (wv / ws) / dy))
            if 0 <= vr < H and 0 <= vc < W:
                v = vr * W + vc
                if pos[v] != -2 and r0[vr, vc] > 0.0:
                    na = tu + spot_tau
                    if na < out[v]:
                        out[v] = na
                        if pos[v] == -1:
                            heap[n] = v
                            pos[v] = n
                            n += 1
                            sp._sift_up(heap, pos, out, n - 1)
                        else:
                            sp._sift_up(heap, pos, out, pos[v])
    return out


@njit(parallel=True)
def _batch_spot(cands, r0, waf, up_e, up_n, tan_s, dx, dy, wind_u, wind_v, wind_t0, wind_dt, widx, wwts,
                t_stop, offsets, passed, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap,
                spot_m, spot_wind, spot_tau):
    M = cands.shape[0]
    H, W = r0.shape
    losses = np.empty(M)
    for m in prange(M):
        out = np.empty(H * W)
        _arrival_spot(int(cands[m, 0]), int(cands[m, 1]), cands[m, 2], r0, waf, up_e, up_n, tan_s,
                      dx, dy, wind_u, wind_v, wind_t0, wind_dt, widx, wwts, cands[m, 3], cands[m, 4], t_stop,
                      offsets, passed, spot_m, spot_wind, spot_tau, out)
        losses[m] = sp._loss(out, inside_idx, inside_ptr, band_idx, band_ptr, obs_t, obs_w, cap)
    return losses


SPOT = [0.0, 0.0, 0.0]


def batch_losses(terrain, wind, obs, cands, cap_h=24.0, packed=None):
    ins, ip, bnd, bp = packed if packed is not None else obs.packed(terrain)
    cands = np.asarray(cands, np.float64)
    if cands.shape[1] == 4:
        cands = np.hstack([cands, np.full((len(cands), 1), sp.LB_MAX)])
    widx, wwts = wind.stencil(*terrain.shape)
    return _batch_spot(np.ascontiguousarray(cands), terrain.r0, terrain.waf, terrain.up_e, terrain.up_n,
                       terrain.tan_slope, terrain.dx, terrain.dy, wind.u_mph, wind.v_mph, wind.t0_h, wind.dt_h,
                       widx, wwts, float(obs.t_h.max() + cap_h), sp.OFFSETS, sp.PASSED, ins, ip, bnd, bp,
                       obs.t_h.astype(np.float64), obs.w, float(cap_h), *SPOT)


def arrival(terrain, wind, seed_rc, t0_h, k=1.0, t_stop_h=1e9, lb_max=sp.LB_MAX):
    H, W = terrain.shape
    out = np.empty(H * W)
    widx, wwts = wind.stencil(H, W)
    _arrival_spot(int(seed_rc[0]), int(seed_rc[1]), float(t0_h), terrain.r0, terrain.waf, terrain.up_e,
                  terrain.up_n, terrain.tan_slope, terrain.dx, terrain.dy, wind.u_mph, wind.v_mph,
                  wind.t0_h, wind.dt_h, widx, wwts, float(k), float(lb_max), float(t_stop_h), sp.OFFSETS,
                  sp.PASSED, *SPOT, out)
    return out.reshape(H, W)


def main() -> None:
    fire_id = sys.argv[1] if len(sys.argv) > 1 else "palisades"
    import os
    os.environ["FIRE"] = fire_id
    fire = s11.load_fire()
    model = s11.build_model(fire)
    masks, times = s11.observations(fire, model)
    full = s11.weighted(masks, times)
    model.lb = float(json.loads((fire.out_dir / "ignition.json").read_text())["map"]["lb_max"])
    sp.batch_losses, sp.arrival = batch_losses, arrival  # s11.invert calls these through the module
    rows = []
    for spot_m, spot_wind, spot_tau in SETTINGS:
        SPOT[:] = [spot_m, spot_wind, spot_tau]
        t = time.time()
        est = s11.invert(model, full, full.masks[0])
        fwd = arrival(model.terrain, model.wind, (est["row"], est["col"]), est["t0_h"], k=est["k"], lb_max=model.lb)
        ious = [round(sp.iou(fwd <= ti, m), 3) for m, ti in zip(masks, times)]
        row = {"spot_m": spot_m, "spot_wind_mph": spot_wind, "spot_delay_h": spot_tau, "k": round(est["k"], 3),
               "k_at_ceiling": bool(est["k"] >= s11.K_GRID[-1]), "loss_h": round(est["loss_h"], 3),
               "t": s11.iso_h(model, est["t0_h"]), "iou_by_observation": ious, "mean_iou": round(float(np.mean(ious)), 3),
               "seconds": round(time.time() - t)}
        rows.append(row)
        print(json.dumps(row), flush=True)
    out = Path(__file__).with_name(f"spotting_{fire_id}.json")
    out.write_text(json.dumps({"fire": fire_id, "lb_max": model.lb, "model_cell_m": round(model.grid.pixel_m[0], 1),
                               "k_ceiling": float(s11.K_GRID[-1]), "settings": rows}, indent=2) + "\n")
    print("wrote", out.name)


if __name__ == "__main__":
    main()
