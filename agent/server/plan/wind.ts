import type {FireStore} from '../fire/data.js';
import {isoUtc} from '../fire/time.js';

/**
 * Gust at flight height, the way the Meta build's swarm sim checks it (pipeline/sim/env.py
 * gust_at, world.py gust/_partition): HRRR's hourly 10 m gust (max of the preceding hour) on the
 * rows x cols partition of aoi.bbox in wind_field.json, nearest partition cell, scaled to the
 * 120 m flight height by the 1/7 power law. A drone may not fly when it exceeds 12 m/s, the
 * DJI Matrice 4TD wind rating.
 */

export const GUST_LIMIT_MS = 12;
export const FLIGHT_AGL_M = 120;
export const SHEAR_EXP = 1 / 7;
export const MPH = 0.44704;
const SCALE = (FLIGHT_AGL_M / 10) ** SHEAR_EXP;

type WindField = {rows: number; cols: number; t: string[]; gust_mph: number[][]};

export type GustLookup = {
  /** Highest flight-height gust (m/s) over the planned hour at a point, or null when not covered. */
  at(lon: number, lat: number): number | null;
  /** The HRRR hours (labels, each the max of its preceding hour) that overlap the planned hour. */
  hours: string[];
  /** Every partition cell with its max flight-height gust over the planned hour. */
  cells: {bbox: [number, number, number, number]; gustMs: number; flyable: boolean}[];
  source: string;
};

/** Gust lookup for the hour [tMs, tMs + 1 h]: the max over every hourly record overlapping it. */
export function gustLookup(store: FireStore, tMs: number): GustLookup {
  const wf = store.optionalJson<WindField>('wind_field.json');
  const [w, s, e, n] = store.aoi().bbox;
  if (!wf) return {at: () => null, hours: [], cells: [], source: 'wind_field.json not available'};
  const rows = Number(wf.rows);
  const cols = Number(wf.cols);
  // Label L covers (L - 1 h, L]; it overlaps [t, t + 1 h] when t < L < t + 2 h.
  const idx = wf.t.map((lab, i) => ({i, ms: Date.parse(lab)})).filter(({ms}) => ms > tMs && ms < tMs + 2 * 3.6e6);
  const maxGust = (k: number) => {
    const series = wf.gust_mph[k];
    return idx.length && series ? Math.max(...idx.map(({i}) => series[i] ?? 0)) * MPH * SCALE : null;
  };
  const cells: GustLookup['cells'] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const g = maxGust(r * cols + c);
      if (g === null) continue;
      const bbox: [number, number, number, number] = [w + ((e - w) * c) / cols, n - ((n - s) * (r + 1)) / rows, w + ((e - w) * (c + 1)) / cols, n - ((n - s) * r) / rows];
      cells.push({bbox: bbox.map(v => Math.round(v * 1e5) / 1e5) as typeof bbox, gustMs: Math.round(g * 10) / 10, flyable: g <= GUST_LIMIT_MS});
    }
  }
  return {
    hours: idx.map(({ms}) => isoUtc(ms)),
    cells,
    source: 'HRRR 3 km hourly 10 m gust (wind_field.json), scaled to 120 m by the 1/7 power law',
    at(lon, lat) {
      if (!idx.length) return null;
      const c = Math.min(cols - 1, Math.max(0, Math.floor(((lon - w) / (e - w)) * cols)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor(((n - lat) / (n - s)) * rows)));
      return maxGust(r * cols + c);
    }
  };
}
