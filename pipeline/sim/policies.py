"""Baseline swarm policies. Each sees only `SwarmSim.observe()` and returns waypoints in km.

A policy is any object with `name` and `decide(obs) -> {"waypoints_km": {drone_id: [[x, y], ...]}, ...}`.
"""

from __future__ import annotations

import math

import numpy as np


def _usable(obs):
    return [d for d in obs["drones"] if d["mode"] in ("base", "fly")]


class Lawnmower:
    """Fixed coverage: the AOI split into one vertical strip per drone, swept back and forth."""

    name = "lawnmower"

    def __init__(self, spacing_km: float = 1.0):
        self.spacing = spacing_km

    def decide(self, obs):
        W, H = obs["area_km"]
        drones = obs["drones"]
        n = len(drones)
        out = {}
        for d in drones:
            if d["mode"] not in ("base", "fly") or d["waypoints_left"] > 0:
                continue
            x0 = W * d["id"] / n
            x1 = W * (d["id"] + 1) / n
            xs = np.arange(x0 + self.spacing / 2, x1, self.spacing)
            wps = []
            for k, x in enumerate(xs):
                ys = (0.3, H - 0.3) if k % 2 == 0 else (H - 0.3, 0.3)
                wps += [[round(float(x), 2), ys[0]], [round(float(x), 2), ys[1]]]
            out[d["id"]] = wps[:8]
        return {"waypoints_km": out}


class Greedy:
    """Track what the swarm has seen: each free drone goes to the nearest observed active cluster's
    downwind edge and orbits it; with nothing seen yet, an expanding search around the reported start."""

    name = "greedy"

    def __init__(self, orbit_km: float = 0.6):
        self.orbit = orbit_km

    def decide(self, obs):
        clusters = [c for c in obs["fire_clusters"][1:]]
        drones = _usable(obs)
        W, H = obs["area_km"]
        wind = obs["wind_at_base"]
        th = math.radians(wind["toward_deg"])
        down = np.array([math.sin(th), math.cos(th)])
        targets = []
        for c in clusters:
            x0, y0, x1, y1 = c["extent_km"]
            ctr = np.array(c["center_km"])
            half = max(x1 - x0, y1 - y0) / 2
            targets.append(ctr + down * (half + 0.3))  # the downwind (head) side
            targets.append(ctr)
        if not targets and obs["reported_start_km"]:
            s = np.array(obs["reported_start_km"])
            r = 0.8 + obs["minutes_elapsed"] / 60 * 0.8
            targets = [s + down * r * 0.6] + [s + r * np.array([math.cos(a), math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 6, endpoint=False)]
        if not targets:
            # No information: hold near the AOI center.
            targets = [np.array([W / 2, H / 2])]
        out = {}
        free = list(drones)
        k = 0
        while free:
            t = targets[k % len(targets)]
            j = min(range(len(free)), key=lambda q: math.hypot(free[q]["x_km"] - t[0], free[q]["y_km"] - t[1]))
            d = free.pop(j)
            phase = d["id"] * math.pi / 3
            orbit = [[float(np.clip(t[0] + self.orbit * math.cos(phase + a), 0, W)), float(np.clip(t[1] + self.orbit * math.sin(phase + a), 0, H))]
                     for a in np.linspace(0, 2 * math.pi, 6, endpoint=False)]
            out[d["id"]] = [[round(x, 2), round(y, 2)] for x, y in orbit]
            k += 1
        return {"waypoints_km": out}


POLICIES = {"lawnmower": Lawnmower, "greedy": Greedy}
