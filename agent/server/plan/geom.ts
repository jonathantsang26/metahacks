import {metersPerDegree} from '../fire/geo.js';

/**
 * Local flat projection for one fire (equirectangular about a reference latitude). At the scale of
 * one fire (< 25 km) the error is well under 0.1%, the same approximation server/fire/geo.ts uses.
 */
export type Proj = {
  toXY(lon: number, lat: number): [number, number];
  toLonLat(x: number, y: number): [number, number];
};

export function makeProj(lon0: number, lat0: number): Proj {
  const [mx, my] = metersPerDegree(lat0);
  return {
    toXY: (lon, lat) => [(lon - lon0) * mx, (lat - lat0) * my],
    toLonLat: (x, y) => [lon0 + x / mx, lat0 + y / my]
  };
}

/** A polyline in meters, resampled so consecutive points are at most stepM apart (both ends kept). */
export function resample(line: [number, number][], stepM: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i]!;
    const [bx, by] = line[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepM));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  const last = line[line.length - 1];
  if (last) out.push(last);
  return out;
}

export function polylineLengthM(line: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
  return s;
}

/** Bucket grid over points in meters, for radius queries. */
export class PointGrid<T> {
  private cells = new Map<string, {x: number; y: number; v: T}[]>();
  constructor(readonly cellM: number) {}
  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }
  add(x: number, y: number, v: T) {
    const k = this.key(Math.floor(x / this.cellM), Math.floor(y / this.cellM));
    let b = this.cells.get(k);
    if (!b) this.cells.set(k, (b = []));
    b.push({x, y, v});
  }
  /** Nearest point within maxM, or null. */
  nearest(x: number, y: number, maxM: number): {v: T; d: number} | null {
    const r = Math.ceil(maxM / this.cellM);
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    let best: {v: T; d: number} | null = null;
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        const b = this.cells.get(this.key(i, j));
        if (!b) continue;
        for (const p of b) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= maxM && (!best || d < best.d)) best = {v: p.v, d};
        }
      }
    }
    return best;
  }
}

export const round = (v: number, places: number) => {
  const p = 10 ** places;
  return Math.round(v * p) / p;
};
