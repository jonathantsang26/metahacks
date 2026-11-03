"""The MuJoCo swarm simulation and its Gymnasium wrapper.

Physics (MuJoCo): the fire's terrain is a heightfield; each drone is a free rigid body pushed by a
thrust force (capped at `max_thrust_ratio` x its weight), gravity and quadratic aerodynamic drag
against the local HRRR wind. It is a point-mass model with no attitude dynamics: enough for wind
drift, climb limits and terrain strikes, not for flight-control research. Terrain strikes are
MuJoCo contacts and end that drone's flight.

Sensing: every `sense_s` seconds each airborne drone checks line of sight from its camera to the
ground cells within `sensor_range_m` against the same terrain; a visible cell inside the replayed fire (arrival <= t) is
recorded as seen, with the time it was first seen burning. Policies see only these observations,
the current-hour wind and the public reported start, never the arrival raster itself.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import mujoco
import numpy as np
from scipy import ndimage

from .world import World, iso, parse_t

G = 9.81
RHO = 1.1  # kg/m^3, air density at about 1 km elevation


@dataclass(frozen=True)
class DroneSpec:
    """A fixed-wing VTOL survey drone class. Values are round, documented assumptions, not a product."""

    mass_kg: float = 3.0
    max_thrust_ratio: float = 2.5
    max_airspeed: float = 34.0  # m/s at full horizontal thrust; sets the drag area
    cruise_speed: float = 22.0  # m/s ground-speed command
    climb_rate: float = 5.0  # m/s
    agl_m: float = 150.0  # survey height above ground
    endurance_s: float = 60 * 60  # at hover-equivalent thrust
    reserve: float = 0.15  # battery fraction kept for margin on top of the trip home
    swap_s: float = 5 * 60  # battery swap at base
    sensor_range_m: float = 600.0  # ground radius a thermal camera resolves at survey height
    wind_ceiling: float = 26.0  # m/s at flight height; above it a drone may not launch and is recalled

    @property
    def drag_area(self) -> float:
        """Cd*A such that full horizontal thrust balances drag at max_airspeed."""
        horiz = self.mass_kg * G * np.sqrt(self.max_thrust_ratio**2 - 1)
        return 2 * horiz / (RHO * self.max_airspeed**2)


@dataclass
class SimConfig:
    fire: str = "eaton"
    n_drones: int = 6
    t_start: str = "2025-01-08T02:30:00Z"
    duration_s: float = 12 * 3600
    decision_s: float = 15 * 60
    physics_dt: float = 0.05
    control_every: int = 4  # control at 5 Hz
    sense_s: float = 10.0
    sensor_stride: int = 3  # sample every 3rd cell for line of sight (about 47 m)
    track_s: float = 30.0  # track sampling for the replay file
    seed: int = 0
    base_lonlat: tuple[float, float] | None = None
    spec: DroneSpec = field(default_factory=DroneSpec)


MODES = ("base", "fly", "rtb", "swap", "lost")


class SwarmSim:
    """One rollout. Call `run(policy)` or drive it with `advance(plan)` per decision interval."""

    def __init__(self, cfg: SimConfig, world: World | None = None):
        self.cfg = cfg
        self.world = world or World(cfg.fire)
        self.spec = cfg.spec
        self.rng = np.random.default_rng(cfg.seed)
        self.t0 = parse_t(cfg.t_start)
        self.t = self.t0
        self.t_end = self.t0 + cfg.duration_s
        self.base = np.array(self.world.safe_base(cfg.base_lonlat))
        self._build_model()
        n = cfg.n_drones
        self.mode = ["base"] * n
        self.battery = np.ones(n)
        self.swap_until = np.zeros(n)
        self.plan: list[list[np.ndarray]] = [[] for _ in range(n)]
        self._hold: dict[int, np.ndarray] = {}
        self.flight_s = np.zeros(n)
        self.grounded_wind_s = 0.0
        self.crashes: list[dict] = []
        self.recalls: list[dict] = []
        H, W = self.world.grid_shape
        self.seen_t = np.full((H, W), np.inf)  # first time each cell was seen inside the fire
        self.seen_active_t = np.full((H, W), -np.inf)  # last time each cell was seen actively burning
        self.visit_t = np.full((H, W), -np.inf)  # last time each cell was in a camera's view
        self.tracks: list[list[list[float]]] = [[] for _ in range(n)]
        self._next_sense = self.t
        self._next_track = self.t
        self._sensor_offsets = self._make_offsets()

    # ----------------------------------------------------------------- model
    def _build_model(self):
        w = self.world
        z = w.elevation
        zmin, zmax = float(z.min()), float(z.max())
        H, W = z.shape
        sx, sy = w.size_m
        n = self.cfg.n_drones
        drones = "".join(
            f'<body name="d{i}" pos="{self.base[0]:.1f} {self.base[1]:.1f} {zmax + 50 + i}">'
            f'<freejoint/><geom name="g{i}" type="sphere" size="0.6" mass="{self.spec.mass_kg}" '
            f'contype="1" conaffinity="0" group="1"/></body>'
            for i in range(n)
        )
        xml = f"""<mujoco model="swarm">
  <option timestep="{self.cfg.physics_dt}" gravity="0 0 -{G}" integrator="implicitfast"/>
  <asset><hfield name="terrain" nrow="{H}" ncol="{W}" size="{sx / 2:.2f} {sy / 2:.2f} {max(zmax - zmin, 1):.2f} 10"/></asset>
  <worldbody>
    <geom name="terrain" type="hfield" hfield="terrain" pos="{sx / 2:.2f} {sy / 2:.2f} {zmin:.2f}" contype="0" conaffinity="1" group="0"/>
    {drones}
  </worldbody>
</mujoco>"""
        m = mujoco.MjModel.from_xml_string(xml)
        # MuJoCo's first hfield row is the south edge; the analysis grid's row 0 is north.
        m.hfield_data[:] = (np.flipud(z) - zmin).ravel() / max(zmax - zmin, 1)
        self.m, self.d = m, mujoco.MjData(m)
        self.zmin = zmin
        self.terrain_geom = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "terrain")
        self.drone_geoms = [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, f"g{i}") for i in range(n)]
        self.drone_bodies = [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, f"d{i}") for i in range(n)]
        # Parked drones sit above the base, frozen, until launched.
        self._park_all()
        mujoco.mj_forward(m, self.d)

    def _qadr(self, i):
        j = self.m.body_jntadr[self.drone_bodies[i]]
        return self.m.jnt_qposadr[j], self.m.jnt_dofadr[j]

    def _park(self, i):
        qa, va = self._qadr(i)
        gz = float(self.world.ground(*self.base))
        self.d.qpos[qa:qa + 3] = [self.base[0] + 4 * i, self.base[1], gz + 2.0]
        self.d.qpos[qa + 3:qa + 7] = [1, 0, 0, 0]
        self.d.qvel[va:va + 6] = 0

    def _park_all(self):
        for i in range(self.cfg.n_drones):
            self._park(i)

    def pos(self, i) -> np.ndarray:
        qa, _ = self._qadr(i)
        return self.d.qpos[qa:qa + 3].copy()

    def vel(self, i) -> np.ndarray:
        _, va = self._qadr(i)
        return self.d.qvel[va:va + 3].copy()

    # ----------------------------------------------------------------- helpers
    def wind_at(self, x, y) -> tuple[np.ndarray, np.ndarray]:
        return self.world.wind(self.t, x, y, agl=self.spec.agl_m)

    def wind_speed_at(self, x, y) -> float:
        u, v = self.wind_at(x, y)
        return float(np.hypot(u, v))

    def airborne(self, i) -> bool:
        return self.mode[i] in ("fly", "rtb")

    # ----------------------------------------------------------------- plan
    def set_plan(self, plan: dict[int, list]) -> list[str]:
        """Replace each named drone's waypoint queue (local meters). Returns a note per rejected item."""
        notes = []
        sx, sy = self.world.size_m
        for i, wps in plan.items():
            if not (0 <= i < self.cfg.n_drones):
                notes.append(f"no drone {i}")
                continue
            if self.mode[i] == "lost":
                notes.append(f"drone {i} is lost")
                continue
            q = []
            for wp in wps[:8]:
                x, y = float(wp[0]), float(wp[1])
                if not (np.isfinite(x) and np.isfinite(y)):
                    continue
                q.append(np.array([np.clip(x, 0, sx), np.clip(y, 0, sy)]))
            self.plan[i] = q
            self._hold.pop(i, None)
        return notes

    # ----------------------------------------------------------------- stepping
    def advance(self, until: float):
        """Run physics, safety, sensing and bookkeeping up to time `until`."""
        cfg, spec, m, d = self.cfg, self.spec, self.m, self.d
        ctrl_dt = cfg.physics_dt * cfg.control_every
        n = cfg.n_drones
        qa = np.array([self._qadr(i)[0] for i in range(n)])
        va = np.array([self._qadr(i)[1] for i in range(n)])
        qidx = qa[:, None] + np.arange(3)[None, :]
        vidx = va[:, None] + np.arange(3)[None, :]
        bodies = np.array(self.drone_bodies)
        base_gz = float(self.world.ground(*self.base))
        while self.t < until - 1e-9:
            P = d.qpos[qidx].copy()
            V = d.qvel[vidx].copy()
            U, W = self.world.wind(self.t, P[:, 0], P[:, 1], agl=spec.agl_m)
            wind_speed = np.hypot(U, W)
            bu, bv = self.wind_at(*self.base)
            base_wind = float(np.hypot(bu, bv))
            for i in range(n):
                self._mode_logic(i, base_wind, P[i], float(wind_speed[i]), U[i], W[i], base_gz)
            fly = np.array([self.airborne(i) for i in range(n)])
            d.xfrc_applied[:] = 0
            if fly.any():
                F = self._control_all(P, V, U, W, fly)
                d.xfrc_applied[bodies[fly], :3] = F[fly]
                self.flight_s[fly] += ctrl_dt
            mujoco.mj_step(m, d, nstep=cfg.control_every)
            for i in range(n):
                if not self.airborne(i):
                    self._park(i)
            self.t += ctrl_dt
            self._check_contacts()
            if self.t >= self._next_sense:
                self._sense()
                self._next_sense += cfg.sense_s
            if self.t >= self._next_track:
                self._record_tracks()
                self._next_track += cfg.track_s
            if base_wind > spec.wind_ceiling:
                self.grounded_wind_s += ctrl_dt

    def _mode_logic(self, i, base_wind, p, local_wind, u, v, base_gz):
        spec = self.spec
        mode = self.mode[i]
        if mode == "lost":
            return
        if mode == "swap":
            if self.t >= self.swap_until[i]:
                self.mode[i], self.battery[i] = "base", 1.0
            return
        if mode == "base":
            if self.plan[i] and base_wind <= spec.wind_ceiling:
                self.mode[i] = "fly"
                _, va = self._qadr(i)
                self.d.qvel[va:va + 6] = 0
            return
        if mode == "fly":
            if local_wind > spec.wind_ceiling:
                self._recall(i, f"wind {local_wind:.0f} m/s over the {spec.wind_ceiling:.0f} m/s ceiling")
            elif self.battery[i] <= self._home_cost(p, u, v) + spec.reserve:
                self._recall(i, "battery reserve")
            # With no waypoints left a drone holds where it is until the next decision.
        dx, dy = p[0] - self.base[0], p[1] - self.base[1]
        if self.mode[i] == "rtb" and dx * dx + dy * dy < 1600 and p[2] - base_gz < 60:
            self.mode[i] = "swap"
            self.swap_until[i] = self.t + spec.swap_s
            self.plan[i] = []

    def _home_cost(self, p, u, v) -> float:
        """Battery fraction needed to fly home against the current wind, at a 1.6 thrust/weight cruise."""
        hx, hy = self.base[0] - p[0], self.base[1] - p[1]
        dist = math.hypot(hx, hy)
        if dist < 1:
            return 0.0
        along = (u * hx + v * hy) / dist
        ground = max(self.spec.cruise_speed + along, 2.0)
        return dist / ground * self._drain(1.6)

    def _recall(self, i, why):
        self.mode[i] = "rtb"
        self.recalls.append({"t": iso(self.t), "drone": i, "why": why})

    def _control_all(self, P, V, U, W, fly) -> np.ndarray:
        """Thrust + drag per drone: a velocity-capped P loop on position, drag compensated, thrust capped
        (lift first, the rest horizontal). Terrain following clears the highest ground in the next 400 m."""
        spec = self.spec
        n = len(P)
        goals = np.zeros((n, 2))
        for i in range(n):
            if not fly[i]:
                goals[i] = P[i, :2]
                continue
            if self.mode[i] == "rtb":
                goals[i] = self.base
                continue
            q = self.plan[i]
            while q and (q[0][0] - P[i, 0]) ** 2 + (q[0][1] - P[i, 1]) ** 2 < 3600:
                q.pop(0)
            if q:
                goals[i] = q[0]
            else:
                hold = self._hold.setdefault(i, P[i, :2].copy())
                goals[i] = hold
        vec = goals - P[:, :2]
        dist = np.hypot(vec[:, 0], vec[:, 1])
        dirn = np.where(dist[:, None] > 1e-6, vec / np.maximum(dist, 1e-6)[:, None], 0.0)
        ahead = np.linspace(0, 1, 9)[None, :] * np.minimum(dist, 400.0)[:, None]
        px = P[:, 0:1] + ahead * dirn[:, 0:1]
        py = P[:, 1:2] + ahead * dirn[:, 1:2]
        gz = self.world.ground(px, py).max(axis=1)
        alt = spec.agl_m + 12.0 * np.arange(n)  # per-drone height offset keeps paths separated
        rtb = np.array([self.mode[i] == "rtb" for i in range(n)])
        landing = rtb & (dist < 300)
        alt = np.where(landing, 20.0 + dist / 8, alt)
        err_z = gz + alt - P[:, 2]
        speed = np.minimum(spec.cruise_speed, 0.25 * dist)
        v_cmd = np.column_stack([dirn * speed[:, None], np.clip(0.5 * err_z, -spec.climb_rate, spec.climb_rate)])
        a_cmd = 1.2 * (v_cmd - V)
        # Drag against the local wind plus turbulence scaled by the hour's gust excess.
        gust = self.world.gust(self.t, P[:, 0], P[:, 1])
        shear = (spec.agl_m / 10) ** self.world.wind_shear_exp
        sigma = np.maximum(gust - np.hypot(U, W) / shear, 0) * 0.3
        turb = self.rng.normal(0, 1, (n, 2)) * sigma[:, None]
        rel = V - np.column_stack([U + turb[:, 0], W + turb[:, 1], np.zeros(n)])
        drag = -0.5 * RHO * spec.drag_area * np.linalg.norm(rel, axis=1)[:, None] * rel
        thrust = spec.mass_kg * (a_cmd + np.array([0, 0, G])) - drag
        tmax = spec.max_thrust_ratio * spec.mass_kg * G
        tz = np.clip(thrust[:, 2], 0, tmax)
        hmax = np.sqrt(np.maximum(tmax**2 - tz**2, 0))
        hn = np.hypot(thrust[:, 0], thrust[:, 1])
        scale = np.where(hn > hmax, hmax / np.maximum(hn, 1e-9), 1.0)
        thrust = np.column_stack([thrust[:, 0] * scale, thrust[:, 1] * scale, tz])
        ratio = np.linalg.norm(thrust, axis=1) / (spec.mass_kg * G)
        dt = self.cfg.physics_dt * self.cfg.control_every
        drain = np.maximum(ratio, 0.3) ** 1.5 / spec.endurance_s * dt
        self.battery = np.where(fly, np.maximum(self.battery - drain, 0), self.battery)
        for i in np.nonzero(fly & (self.battery <= 0))[0]:
            self._lose(int(i), "battery empty")
        return thrust + drag

    def _drain(self, thrust_ratio: float) -> float:
        """Battery fraction per second at a given thrust/weight."""
        return (max(thrust_ratio, 0.3) ** 1.5) / self.spec.endurance_s

    def _lose(self, i, why):
        self.mode[i] = "lost"
        self.plan[i] = []
        self.crashes.append({"t": iso(self.t), "drone": i, "why": why, "lonlat": [round(float(c), 6) for c in self.world.to_lonlat(*self.pos(i)[:2])]})
        qa, va = self._qadr(i)
        self.d.qvel[va:va + 6] = 0

    def _check_contacts(self):
        for k in range(self.d.ncon):
            c = self.d.contact[k]
            for i, g in enumerate(self.drone_geoms):
                if self.mode[i] in ("fly", "rtb") and ((c.geom1 == g and c.geom2 == self.terrain_geom) or (c.geom2 == g and c.geom1 == self.terrain_geom)):
                    p = self.pos(i)
                    if np.hypot(*(p[:2] - self.base)) > 60:
                        self._lose(i, "terrain strike")

    # ----------------------------------------------------------------- sensing
    def _make_offsets(self):
        cx, cy = self.world.cell_m
        r = self.spec.sensor_range_m
        s = self.cfg.sensor_stride
        kr = int(r / cy) // s * s
        kc = int(r / cx) // s * s
        dr, dc = np.mgrid[-kr:kr + 1:s, -kc:kc + 1:s]
        keep = (dr * cy) ** 2 + (dc * cx) ** 2 <= r**2
        return dr[keep], dc[keep]

    def _sense(self):
        w = self.world
        H, W = w.grid_shape
        X, Y = w.cell_xy
        s = self.cfg.sensor_stride
        for i in range(self.cfg.n_drones):
            if not self.airborne(i):
                continue
            p = self.pos(i)
            r0, c0 = w.cell_of(p[0], p[1])
            rr, cc = r0 + self._sensor_offsets[0], c0 + self._sensor_offsets[1]
            ok = (rr >= 0) & (rr < H) & (cc >= 0) & (cc < W)
            rr, cc = rr[ok], cc[ok]
            tz = w.elevation[rr, cc] + 2.0
            # Line of sight: the ray from the camera to each cell must clear the terrain at 12 points.
            f = np.linspace(0.08, 0.92, 12)[None, :]
            lx = p[0] + (X[rr, cc][:, None] - p[0]) * f
            ly = p[1] + (Y[rr, cc][:, None] - p[1]) * f
            lz = p[2] + (tz[:, None] - p[2]) * f
            visible = np.all(w.ground(lx, ly) < lz, axis=1)
            rr, cc = rr[visible], cc[visible]
            # Each sampled cell stands for its stride x stride block.
            for a in range(s):
                for b in range(s):
                    r2 = np.clip(rr + a - s // 2, 0, H - 1)
                    c2 = np.clip(cc + b - s // 2, 0, W - 1)
                    self._observe(r2, c2)

    def _observe(self, r, c):
        a = self.world.arrival[r, c]
        self.visit_t[r, c] = self.t
        burned = a <= self.t
        rb, cb = r[burned], c[burned]
        self.seen_t[rb, cb] = np.minimum(self.seen_t[rb, cb], self.t)
        active = burned & (a > self.t - 3600)
        self.seen_active_t[r[active], c[active]] = self.t

    def _record_tracks(self):
        w = self.world
        for i in range(self.cfg.n_drones):
            p = self.pos(i)
            lon, lat = w.to_lonlat(p[0], p[1])
            self.tracks[i].append([round(self.t - self.t0, 1), round(float(lon), 6), round(float(lat), 6), round(float(p[2]), 1), MODES.index(self.mode[i]), round(float(self.battery[i]), 3)])

    # ----------------------------------------------------------------- observation for policies
    def observe(self) -> dict:
        """What a policy may know at time t: drone states, the swarm's own observations, the current-hour
        wind and the public reported start. Coordinates in km from the AOI's south-west corner."""
        w = self.world
        drones = []
        for i in range(self.cfg.n_drones):
            p = self.pos(i)
            ws = self.wind_speed_at(p[0], p[1])
            drones.append({
                "id": i, "mode": self.mode[i], "x_km": round(p[0] / 1000, 2), "y_km": round(p[1] / 1000, 2),
                "battery": round(float(self.battery[i]), 2), "wind_ms": round(ws, 1),
                "waypoints_left": len(self.plan[i]),
            })
        u, v = self.wind_at(*self.base)
        rep = next((e for e in w.events if e["kind"] == "reported_start" and parse_t(e["t"]) <= self.t), None)
        obs = {
            "t": iso(self.t),
            "minutes_elapsed": round((self.t - self.t0) / 60),
            "minutes_left": round((self.t_end - self.t) / 60),
            "area_km": [round(w.size_m[0] / 1000, 2), round(w.size_m[1] / 1000, 2)],
            "base_km": [round(self.base[0] / 1000, 2), round(self.base[1] / 1000, 2)],
            "wind_at_base": {"speed_ms": round(float(np.hypot(u, v)), 1), "toward_deg": round(float(np.degrees(np.arctan2(u, v)) % 360)),
                             "ceiling_ms": self.spec.wind_ceiling},
            "wind_grid": self._wind_grid(),
            "drones": drones,
            "fire_clusters": self._clusters(),
            "coverage": self._coverage(),
            "reported_start_km": None,
        }
        if rep:
            x, y = w.to_local(rep["lon"], rep["lat"])
            obs["reported_start_km"] = [round(float(x) / 1000, 2), round(float(y) / 1000, 2)]
        return obs

    def _wind_grid(self) -> list[dict]:
        sx, sy = self.world.size_m
        out = []
        for fy in (0.17, 0.5, 0.83):
            for fx in (0.17, 0.5, 0.83):
                u, v = self.wind_at(fx * sx, fy * sy)
                out.append({"x_km": round(fx * sx / 1000, 1), "y_km": round(fy * sy / 1000, 1),
                            "speed_ms": round(float(np.hypot(u, v)), 1), "toward_deg": round(float(np.degrees(np.arctan2(u, v)) % 360))})
        return out

    def _clusters(self, k: int = 6) -> list[dict]:
        """Groups of cells the swarm has seen actively burning in the last 30 min, largest first."""
        recent = self.seen_active_t >= self.t - 1800
        seen_ever = np.isfinite(self.seen_t)
        lab, n = ndimage.label(ndimage.binary_dilation(recent, iterations=6))
        X, Y = self.world.cell_xy
        out = []
        for j in range(1, n + 1):
            mask = (lab == j) & recent
            cnt = int(mask.sum())
            if not cnt:
                continue
            xs, ys = X[mask], Y[mask]
            out.append({
                "center_km": [round(float(xs.mean()) / 1000, 2), round(float(ys.mean()) / 1000, 2)],
                "extent_km": [round(float(xs.min()) / 1000, 2), round(float(ys.min()) / 1000, 2), round(float(xs.max()) / 1000, 2), round(float(ys.max()) / 1000, 2)],
                "active_cells_seen": cnt,
                "minutes_since_seen": round(float(self.t - self.seen_active_t[mask].max()) / 60),
            })
        out.sort(key=lambda c: -c["active_cells_seen"])
        burned_seen_ha = float(seen_ever.sum()) * self.world.cell_m[0] * self.world.cell_m[1] / 1e4
        return [{"burned_area_seen_ha": round(burned_seen_ha)}] + out[:k]

    def _coverage(self, block_km: float = 2.0) -> list[dict]:
        """Per 2 km block: minutes since any camera last looked at it (null = never)."""
        w = self.world
        sx, sy = w.size_m
        X, Y = w.cell_xy
        nb_x, nb_y = int(np.ceil(sx / 1000 / block_km)), int(np.ceil(sy / 1000 / block_km))
        bx = np.minimum((X / 1000 / block_km).astype(int), nb_x - 1)
        by = np.minimum((Y / 1000 / block_km).astype(int), nb_y - 1)
        idx = by * nb_x + bx
        last = np.full(nb_x * nb_y, -np.inf)
        np.maximum.at(last, idx.ravel(), self.visit_t.ravel())
        out = []
        for k in range(nb_x * nb_y):
            x0, y0 = (k % nb_x) * block_km, (k // nb_x) * block_km
            out.append({"block_km": [x0, y0], "minutes_since_seen": None if not np.isfinite(last[k]) else round(float(self.t - last[k]) / 60)})
        return out

    # ----------------------------------------------------------------- run + metrics
    def run(self, policy, log=None) -> dict:
        """Run the whole episode, asking `policy.decide(obs)` every decision interval."""
        decisions = []
        while self.t < self.t_end - 1e-9:
            obs = self.observe()
            out = policy.decide(obs)
            plan = {int(k): [(float(x) * 1000, float(y) * 1000) for x, y in v] for k, v in out.get("waypoints_km", {}).items()}
            notes = self.set_plan(plan)
            decisions.append({"t": obs["t"], **{k: v for k, v in out.items() if k != "waypoints_km"},
                              "waypoints_km": {str(k): v for k, v in out.get("waypoints_km", {}).items()}, "rejected": notes})
            if log:
                log(f"{obs['t']} {policy.name}: {sum(len(v) for v in plan.values())} waypoints, {sum(m in ('fly', 'rtb') for m in self.mode)} airborne")
            self.advance(min(self.t + self.cfg.decision_s, self.t_end))
        self._record_tracks()
        return {"decisions": decisions, "metrics": self.metrics()}

    def metrics(self, latency_s: float = 30 * 60, event_radius_m: float = 500.0) -> dict:
        w = self.world
        a = w.arrival
        in_window = (a >= self.t0) & (a <= self.t_end - latency_s)
        lat = self.seen_t[in_window] - a[in_window]
        on_time = float(np.mean(lat <= latency_s)) if in_window.any() else 0.0
        seen = np.isfinite(lat)
        # Map awareness: the share of the burned area the swarm had seen, sampled hourly.
        aware = []
        for t in np.arange(self.t0 + 3600, self.t_end + 1, 3600):
            burned = a <= t
            if burned.any():
                aware.append(float(np.mean(self.seen_t[burned] <= t)))
        X, Y = w.cell_xy
        events = []
        for e in w.events:
            te = parse_t(e["t"])
            if not (self.t0 <= te <= self.t_end) or e.get("date_only") or e["kind"] in ("reported_start", "peak_gust", "containment"):
                continue
            ex, ey = w.to_local(e["lon"], e["lat"])
            near = ((X - ex) ** 2 + (Y - ey) ** 2 <= event_radius_m**2) & (a <= self.t_end)
            first = float(self.seen_t[near & (self.seen_t >= te - 1800)].min()) if near.any() else np.inf
            events.append({"id": e["id"], "kind": e["kind"], "label": e["label"], "t": e["t"],
                           "first_seen_min": None if not np.isfinite(first) else round((first - te) / 60, 1)})
        return {
            "front_cells": int(in_window.sum()),
            "front_seen_within_30min": round(on_time, 4),
            "front_seen_ever": round(float(np.mean(seen)) if in_window.any() else 0.0, 4),
            "median_latency_min": round(float(np.median(lat[seen])) / 60, 1) if seen.any() else None,
            "mean_map_awareness": round(float(np.mean(aware)), 4) if aware else 0.0,
            "events": events,
            "flight_hours": round(float(self.flight_s.sum()) / 3600, 2),
            "wind_grounded_hours": round(self.grounded_wind_s / 3600, 2),
            "crashes": self.crashes,
            "recalls": len(self.recalls),
        }


# --------------------------------------------------------------------- Gymnasium wrapper
try:
    import gymnasium as gym
    from gymnasium import spaces
except ImportError:  # pragma: no cover
    gym = None

if gym is not None:

    class SwarmEnv(gym.Env):
        """RL view of the same simulation: one step = one decision interval.

        Action: one target point per drone in [-1, 1]^2 (scaled to the AOI). Observation: three coarse
        maps (seen burning in the last 30 min, seen burned ever, minutes since last viewed, each 32 x 44)
        and per-drone [x, y, battery, airborne, local wind]. Reward: newly seen burned cells this step,
        weighted 3x when first seen within 30 min of arrival.
        """

        metadata = {"render_modes": []}
        MAP = (32, 44)

        def __init__(self, cfg: SimConfig | None = None, world: World | None = None):
            self.cfg = cfg or SimConfig()
            self.world = world or World(self.cfg.fire)
            n = self.cfg.n_drones
            self.action_space = spaces.Box(-1, 1, shape=(n, 2), dtype=np.float32)
            self.observation_space = spaces.Dict({
                "maps": spaces.Box(0, 1, shape=(3, *self.MAP), dtype=np.float32),
                "drones": spaces.Box(-np.inf, np.inf, shape=(n, 5), dtype=np.float32),
            })
            self.sim: SwarmSim | None = None

        def reset(self, *, seed=None, options=None):
            super().reset(seed=seed)
            cfg = self.cfg if seed is None else SimConfig(**{**self.cfg.__dict__, "seed": seed})
            self.sim = SwarmSim(cfg, self.world)
            self._seen_prev = 0
            return self._obs(), {}

        def step(self, action):
            sim = self.sim
            sx, sy = sim.world.size_m
            act = np.clip(np.asarray(action, dtype=float), -1, 1)
            sim.set_plan({i: [((act[i, 0] + 1) / 2 * sx, (act[i, 1] + 1) / 2 * sy)] for i in range(sim.cfg.n_drones)})
            t_before = sim.t
            sim.advance(min(sim.t + sim.cfg.decision_s, sim.t_end))
            new = (sim.seen_t > t_before) & np.isfinite(sim.seen_t)
            with np.errstate(invalid="ignore"):
                fresh = new & (sim.seen_t - sim.world.arrival <= 1800)
            reward = float(new.sum() + 2 * fresh.sum()) / 1000.0
            done = sim.t >= sim.t_end - 1e-9
            return self._obs(), reward, done, False, {"metrics": sim.metrics() if done else None}

        def _obs(self):
            sim = self.sim
            t = sim.t

            def pool(x):
                h, w = x.shape
                ph, pw = self.MAP
                ys = (np.arange(ph + 1) * h // ph)
                xs = (np.arange(pw + 1) * w // pw)
                return np.array([[x[ys[r]:ys[r + 1], xs[c]:xs[c + 1]].max() for c in range(pw)] for r in range(ph)])

            maps = np.stack([
                pool((sim.seen_active_t >= t - 1800).astype(float)),
                pool(np.isfinite(sim.seen_t).astype(float)),
                pool(np.clip((t - sim.visit_t) / 7200, 0, 1)),
            ]).astype(np.float32)
            sx, sy = sim.world.size_m
            dr = []
            for i in range(sim.cfg.n_drones):
                p = sim.pos(i)
                dr.append([p[0] / sx, p[1] / sy, sim.battery[i], float(sim.airborne(i)), sim.wind_speed_at(p[0], p[1]) / 30])
            return {"maps": maps, "drones": np.array(dr, dtype=np.float32)}
