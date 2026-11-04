"""The real data a rollout replays: terrain, arrival times and wind, in a local metric frame.

Local frame: x east and y north in meters from the AOI's south-west corner (equirectangular about
the AOI's center latitude, which is accurate to well under a cell over a ~20 km AOI).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import cached_property
from pathlib import Path

import numpy as np
from PIL import Image

REPO_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_DIR / "web" / "public" / "data"
EARTH_R = 6378137.0
MPH = 0.44704  # m/s per mph


def parse_t(s: str) -> float:
    """ISO-8601 UTC to epoch seconds."""
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class World:
    fire: str
    root: Path = DATA_DIR
    #: Wind at flight altitude from the 10 m HRRR wind: power law with exponent 1/7 (neutral surface layer).
    wind_shear_exp: float = 1 / 7
    _cache: dict = field(default_factory=dict, repr=False)

    def _json(self, name: str):
        if name not in self._cache:
            self._cache[name] = json.loads((self.root / self.fire / name).read_text())
        return self._cache[name]

    # ------------------------------------------------------------- frame
    @cached_property
    def bounds(self) -> tuple[float, float, float, float]:
        w, s, e, n = self._json("dem.json")["bounds"]
        return w, s, e, n

    @cached_property
    def m_per_deg(self) -> tuple[float, float]:
        w, s, e, n = self.bounds
        m_lat = math.pi * EARTH_R / 180.0
        return m_lat * math.cos(math.radians((s + n) / 2)), m_lat

    @cached_property
    def size_m(self) -> tuple[float, float]:
        w, s, e, n = self.bounds
        mx, my = self.m_per_deg
        return (e - w) * mx, (n - s) * my

    def to_local(self, lon, lat):
        w, s, _, _ = self.bounds
        mx, my = self.m_per_deg
        return (np.asarray(lon) - w) * mx, (np.asarray(lat) - s) * my

    def to_lonlat(self, x, y):
        w, s, _, _ = self.bounds
        mx, my = self.m_per_deg
        return w + np.asarray(x) / mx, s + np.asarray(y) / my

    # ------------------------------------------------------------- grid
    @cached_property
    def grid_shape(self) -> tuple[int, int]:
        g = self._json("dem.json")["analysis_grid"]
        return int(g["height"]), int(g["width"])

    @cached_property
    def cell_m(self) -> tuple[float, float]:
        h, w = self.grid_shape
        return self.size_m[0] / w, self.size_m[1] / h

    def cell_of(self, x, y):
        """(row, col) of local points; row 0 is the north edge, as in every pipeline raster."""
        h, w = self.grid_shape
        cx, cy = self.cell_m
        col = np.clip((np.asarray(x) / cx).astype(int), 0, w - 1)
        row = np.clip(h - 1 - (np.asarray(y) / cy).astype(int), 0, h - 1)
        return row, col

    @cached_property
    def cell_xy(self) -> tuple[np.ndarray, np.ndarray]:
        """Cell-center local coordinates, each (H, W)."""
        h, w = self.grid_shape
        cx, cy = self.cell_m
        xs = (np.arange(w) + 0.5) * cx
        ys = (h - 1 - np.arange(h) + 0.5) * cy
        return np.meshgrid(xs, ys)

    # ------------------------------------------------------------- terrain
    @cached_property
    def elevation(self) -> np.ndarray:
        """Elevation (m) on the analysis grid, decoded from dem.png (terrain-RGB, decoder in dem.json)."""
        meta = self._json("dem.json")
        dec = meta["decoder"]
        rgb = np.asarray(Image.open(self.root / self.fire / "dem.png").convert("RGB")).astype(np.float64)
        z = rgb[..., 0] * dec["rScaler"] + rgb[..., 1] * dec["gScaler"] + rgb[..., 2] * dec["bScaler"] + dec["offset"]
        h, w = self.grid_shape
        # dem.png and the analysis grid share bounds; resample by cell centers (bilinear).
        zh, zw = z.shape
        r = (np.arange(h) + 0.5) / h * zh - 0.5
        c = (np.arange(w) + 0.5) / w * zw - 0.5
        return _bilinear(z, *np.meshgrid(r, c, indexing="ij"))

    def ground(self, x, y) -> np.ndarray:
        """Terrain height (m) under local points (bilinear on the analysis grid)."""
        h, w = self.grid_shape
        cx, cy = self.cell_m
        c = np.asarray(x) / cx - 0.5
        r = h - 1 - (np.asarray(y) / cy - 0.5)
        return _bilinear(self.elevation, r, c)

    # ------------------------------------------------------------- fire
    @cached_property
    def window(self) -> tuple[float, float]:
        a, b = self._json("arrival_meta.json")["window_utc"]
        return parse_t(a), parse_t(b)

    @cached_property
    def arrival(self) -> np.ndarray:
        """Arrival time (epoch s) per cell, +inf where the fire never arrived. Interpolated between perimeters."""
        rgb = np.asarray(Image.open(self.root / self.fire / "arrival.png").convert("RGB"))
        code = rgb[..., 0].astype(np.float64)
        t0, t1 = self.window
        out = t0 + (code - 1) / 253.0 * (t1 - t0)
        out[code >= 255] = np.inf
        out[code < 1] = np.inf
        return out

    def burning(self, t: float, active_s: float = 3600.0) -> np.ndarray:
        """Cells whose interpolated arrival is within the last `active_s` seconds: the replayed active front."""
        a = self.arrival
        return (a <= t) & (a > t - active_s)

    # ------------------------------------------------------------- wind
    @cached_property
    def _wind(self):
        wf = self._json("wind_field.json")
        t = np.array([parse_t(s) for s in wf["t"]])
        u = np.array(wf["u_mph"], dtype=float).T * MPH  # (T, cells)
        v = np.array(wf["v_mph"], dtype=float).T * MPH
        g = np.array(wf["gust_mph"], dtype=float).T * MPH
        return t, u, v, g, int(wf["rows"]), int(wf["cols"])

    def wind(self, t: float, x, y, agl: float = 10.0) -> tuple[np.ndarray, np.ndarray]:
        """Wind (u east, v north; m/s, the direction the air moves toward) at local points, at `agl` meters.

        HRRR's hourly 10 m field on its rows x cols partition of the AOI, linear in time, nearest
        partition cell in space, scaled to altitude by the power law.
        """
        ts, u, v, _, rows, cols = self._wind
        i = min(max(int(np.searchsorted(ts, t)) - 1, 0), len(ts) - 2)
        f = min(max((t - ts[i]) / (ts[i + 1] - ts[i]), 0.0), 1.0)
        k = self._partition(x, y, rows, cols)
        scale = (max(agl, 10.0) / 10.0) ** self.wind_shear_exp
        uu = ((1 - f) * u[i] + f * u[i + 1])[k] * scale
        vv = ((1 - f) * v[i] + f * v[i + 1])[k] * scale
        return uu, vv

    def gust(self, t: float, x, y) -> np.ndarray:
        ts, _, _, g, rows, cols = self._wind
        i = min(max(int(np.searchsorted(ts, t, side="right")) - 1, 0), len(ts) - 1)
        return g[i][self._partition(x, y, rows, cols)]

    def _partition(self, x, y, rows, cols):
        W, H = self.size_m
        c = np.clip((np.asarray(x) / W * cols).astype(int), 0, cols - 1)
        r = np.clip(((1 - np.asarray(y) / H) * rows).astype(int), 0, rows - 1)
        return r * cols + c

    # ------------------------------------------------------------- public facts
    @cached_property
    def events(self) -> list[dict]:
        return self._json("events.json")

    @cached_property
    def aoi(self) -> dict:
        return self._json("aoi.json")

    def safe_base(self, near_lonlat: tuple[float, float] | None = None, clearance_m: float = 1500.0) -> tuple[float, float]:
        """A staging point that the fire never reaches, at least `clearance_m` from the final burned area,
        nearest to `near_lonlat` (default: the AOI's south-center). Chosen from the final footprint only so
        the base is safe for the whole replay; it is a simulation setting, not a claim about real staging."""
        from scipy.ndimage import distance_transform_edt

        burned = np.isfinite(self.arrival)
        cx, cy = self.cell_m
        dist = distance_transform_edt(~burned, sampling=(cy, cx))
        ok = dist >= clearance_m
        X, Y = self.cell_xy
        if near_lonlat is None:
            tx, ty = self.size_m[0] / 2, 0.0
        else:
            tx, ty = self.to_local(*near_lonlat)
        d2 = np.where(ok, (X - tx) ** 2 + (Y - ty) ** 2, np.inf)
        r, c = np.unravel_index(int(np.argmin(d2)), d2.shape)
        return float(X[r, c]), float(Y[r, c])


def _bilinear(z: np.ndarray, r, c) -> np.ndarray:
    h, w = z.shape
    r = np.clip(np.asarray(r, dtype=float), 0, h - 1)
    c = np.clip(np.asarray(c, dtype=float), 0, w - 1)
    r0 = np.minimum(r.astype(int), h - 2)
    c0 = np.minimum(c.astype(int), w - 2)
    fr, fc = r - r0, c - c0
    return (z[r0, c0] * (1 - fr) * (1 - fc) + z[r0 + 1, c0] * fr * (1 - fc)
            + z[r0, c0 + 1] * (1 - fr) * fc + z[r0 + 1, c0 + 1] * fr * fc)
