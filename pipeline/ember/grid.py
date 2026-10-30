"""The analysis grid every raster step shares.

Defined by step 02 (dem.json → analysis_grid + bounds): a regular lon/lat grid, row 0 =
north, ~16 m cells, identical to work/<fire>/elevation.npy. Rasters written for the web
(arrival.png, severity.png, fuel.png) use this grid too; the web maps them onto the same
bounds as dem.png, so they line up with the terrain.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import Affine, from_bounds

from .config import Fire
from .geo import meters_per_degree


@dataclass(frozen=True)
class Grid:
    west: float
    south: float
    east: float
    north: float
    width: int
    height: int

    @classmethod
    def for_fire(cls, fire: Fire) -> "Grid":
        dem = fire.read_json("dem.json")
        g = dem["analysis_grid"]
        w, s, e, n = dem["bounds"]
        return cls(w, s, e, n, int(g["width"]), int(g["height"]))

    @property
    def shape(self) -> tuple[int, int]:
        return self.height, self.width

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return self.west, self.south, self.east, self.north

    @cached_property
    def transform(self) -> Affine:
        """Pixel-edge affine transform (lon/lat, EPSG:4326)."""
        return from_bounds(self.west, self.south, self.east, self.north, self.width, self.height)

    @cached_property
    def pixel_m(self) -> tuple[float, float]:
        m_lon, m_lat = meters_per_degree((self.south + self.north) / 2)
        return (self.east - self.west) / self.width * m_lon, (self.north - self.south) / self.height * m_lat

    @property
    def cell_area_m2(self) -> float:
        px, py = self.pixel_m
        return px * py

    @cached_property
    def lons(self) -> np.ndarray:
        """Cell-center longitudes, one per column."""
        dx = (self.east - self.west) / self.width
        return self.west + dx * (np.arange(self.width) + 0.5)

    @cached_property
    def lats(self) -> np.ndarray:
        """Cell-center latitudes, one per row (north → south)."""
        dy = (self.north - self.south) / self.height
        return self.north - dy * (np.arange(self.height) + 0.5)

    def to_px(self, lon, lat):
        """Fractional (col, row) for lon/lat (arrays or scalars); cell centers are integers."""
        col = (np.asarray(lon) - self.west) / (self.east - self.west) * self.width - 0.5
        row = (self.north - np.asarray(lat)) / (self.north - self.south) * self.height - 0.5
        return col, row

    def to_lonlat(self, col, row):
        lon = self.west + (np.asarray(col) + 0.5) * (self.east - self.west) / self.width
        lat = self.north - (np.asarray(row) + 0.5) * (self.north - self.south) / self.height
        return lon, lat

    def contains(self, lon: float, lat: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north

    def rasterize(self, geometries, fill: int = 0, value: int = 1, all_touched: bool = False) -> np.ndarray:
        """Burn GeoJSON geometries (lon/lat) into a uint8 mask on this grid."""
        shapes = [(g, value) for g in geometries if g]
        if not shapes:
            return np.full(self.shape, fill, np.uint8)
        return rasterize(
            shapes, out_shape=self.shape, transform=self.transform, fill=fill,
            all_touched=all_touched, dtype="uint8",
        )

    def resample(self, arr: np.ndarray, factor: int) -> "tuple[Grid, np.ndarray]":
        """Block-mean downsample by an integer factor (edges cropped) for coarse models."""
        h, w = (self.height // factor) * factor, (self.width // factor) * factor
        coarse = arr[:h, :w].reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3))
        dx = (self.east - self.west) / self.width
        dy = (self.north - self.south) / self.height
        g = Grid(self.west, self.north - h * dy, self.west + w * dx, self.north, w // factor, h // factor)
        return g, coarse
