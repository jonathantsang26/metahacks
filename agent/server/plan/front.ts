import {isActionContractError} from '@agent-native/core/action';
import {getForecastFront, type FireId, type ForecastFront} from '../fire/actions-support.js';
import type {FireStore} from '../fire/data.js';
import {resample, type Proj} from './geom.js';

/**
 * The forecast front a plan is scored against. It is exactly what the get-forecast-front action
 * returns (server/fire/actions-support.ts getForecastFront: the advancing edge of the cached +1 h
 * forecast issued at the top of the hour at or before t), so the map, the agent and the score
 * all see the same line.
 */

export type Front = {
  front: number[][][];
  frontKm: number;
  forecastFile: string;
  issuedAt: string;
  validAt: string;
  method: string;
  pieces: ForecastFront['frontPieces'];
  /** maxAdvanceM of each line of front (same order), or null for stretches under 0.2 km that have no piece. */
  lineAdvanceM: (number | null)[];
};

/** A front stretch the forecast expects to run at least this far past the burned edge is fast-moving. */
export const FAST_ADVANCE_M = 200;

/** Distance in meters from a point to a lon/lat polyline (local flat approximation). */
function distToLineM(p: [number, number], line: number[][]): number {
  const [mx, my] = [111_320 * Math.cos((p[1] * Math.PI) / 180), 110_574];
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const ax = (a[0]! - p[0]) * mx, ay = (a[1]! - p[1]) * my;
    const bx = (b[0]! - p[0]) * mx, by = (b[1]! - p[1]) * my;
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
  }
  return best;
}

/** frontPieces carry no geometry: match each to the line its head point lies on (pieces are >= 0.2 km). */
function matchAdvance(lines: number[][][], pieces: ForecastFront['frontPieces']): (number | null)[] {
  const out: (number | null)[] = lines.map(() => null);
  for (const p of pieces) {
    let best = -1;
    let bestD = 15;
    lines.forEach((l, i) => {
      if (out[i] !== null) return;
      const d = distToLineM(p.headLonLat, l);
      if (d < bestD) [best, bestD] = [i, d];
    });
    if (best >= 0) out[best] = p.maxAdvanceM;
  }
  return out;
}

/** Front for the hour containing t, or null when no cached forecast was issued at that hour. */
export function loadFront(store: FireStore, tMs: number): Front | null {
  let f: ForecastFront;
  try {
    f = getForecastFront(store.fire as FireId, tMs);
  } catch (e) {
    if (isActionContractError(e) && e.errorCode === 'no_forecast') return null;
    throw e;
  }
  return {
    front: f.front.coordinates,
    frontKm: f.frontKm,
    forecastFile: `forecast/${f.issuedAt.slice(0, 13)}Z.geojson`,
    issuedAt: f.issuedAt,
    validAt: f.forecastFor,
    method: f.method,
    pieces: f.frontPieces,
    lineAdvanceM: matchAdvance(f.front.coordinates, f.frontPieces)
  };
}

/** Points along a set of lon/lat lines, in meters, with each sample's segment length. */
export function frontSamples(front: number[][][], proj: Proj, stepM: number): {x: number; y: number; lenM: number; piece: number}[] {
  const out: {x: number; y: number; lenM: number; piece: number}[] = [];
  front.forEach((line, piece) => {
    const pts = resample(
      line.map(([lon, lat]) => proj.toXY(lon!, lat!)),
      stepM
    );
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      out.push({x: (ax + bx) / 2, y: (ay + by) / 2, lenM: Math.hypot(bx - ax, by - ay), piece});
    }
  });
  return out;
}
