/**
 * CPU copies of the pipeline's PNG rasters (arrival, fuel, severity, ignition posterior).
 * They share dem.png's bounds, row 0 = north, so a (lon, lat) maps to the same pixel in each.
 */
import {useEffect, useState} from 'react';
import type {FireData} from './fire';

export class Raster {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly bounds: [number, number, number, number],
    /** RGBA, row-major. */
    readonly data: Uint8ClampedArray
  ) {}

  static async load(url: string, bounds: [number, number, number, number]): Promise<Raster> {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', {willReadFrequently: true})!;
    ctx.drawImage(img, 0, 0);
    return new Raster(img.width, img.height, bounds, ctx.getImageData(0, 0, img.width, img.height).data);
  }

  /** Nearest pixel at (lon, lat), or null outside the bounds. */
  pixel(lon: number, lat: number): {col: number; row: number} | null {
    const [w, s, e, n] = this.bounds;
    if (lon < w || lon > e || lat < s || lat > n) return null;
    const col = Math.min(this.width - 1, Math.floor(((lon - w) / (e - w)) * this.width));
    const row = Math.min(this.height - 1, Math.floor(((n - lat) / (n - s)) * this.height));
    return {col, row};
  }

  /** Red channel at (lon, lat), or null outside the bounds. */
  red(lon: number, lat: number): number | null {
    const p = this.pixel(lon, lat);
    return p ? this.data[(p.row * this.width + p.col) * 4] : null;
  }
}

/**
 * arrival.png's red channel (BUILD.md §3): 1–254 → (code − 1) / 253 of the window, 255 → never
 * burned. Returns epoch ms, or null for never burned / outside.
 */
export function decodeArrival(code: number | null, windowStart: number, windowEnd: number): number | null {
  if (code === null || code >= 255 || code < 1) return null;
  return windowStart + ((code - 1) / 253) * (windowEnd - windowStart);
}

const cache = new Map<string, Promise<Raster>>();

/** Loads public/data/<fire>/<file> as a Raster once per session; null while loading or if missing. */
export function useRaster(fire: FireData, file: string): Raster | null {
  const [raster, setRaster] = useState<Raster | null>(null);
  useEffect(() => {
    let live = true;
    const url = `${fire.base}/${file}`;
    let p = cache.get(url);
    if (!p) {
      p = Raster.load(url, fire.dem.bounds);
      cache.set(url, p);
    }
    p.then(r => live && setRaster(r)).catch(() => live && setRaster(null));
    return () => {
      live = false;
    };
  }, [fire, file]);
  return raster;
}
