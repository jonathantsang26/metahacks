/** Rail-only geometry on the pipeline's files: distances and the HRRR wind grid at a point. */
import {indexAtOrBefore, type WindField} from '../data/files';

const EARTH_R_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle (haversine) distance in meters. */
export function greatCircleM(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const a =
    Math.sin(rad(lat1 - lat0) / 2) ** 2 + Math.cos(rad(lat0)) * Math.cos(rad(lat1)) * Math.sin(rad(lon1 - lon0) / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Hour index in wind_field.json at or before `ms`, or −1 when none is within `maxAgeMs`. */
export function windHour(wf: WindField, times: string[], ms: number, maxAgeMs: number): number {
  const k = indexAtOrBefore(times, ms);
  return k >= 0 && ms - Date.parse(times[k]) <= maxAgeMs && k < (wf.u_mph[0]?.length ?? 0) ? k : -1;
}

export type WindAt = {speed_mph: number; from_deg: number; gust_mph: number};

/**
 * Bilinear interpolation of hour `k` over the rows × cols grid (row-major, north row first, west
 * to east), clamped to the outermost points. u/v point where the air moves, so the direction the
 * wind blows FROM is atan2(−u, −v), clockwise from north.
 */
export function windAt(wf: WindField, k: number, lon: number, lat: number): WindAt {
  const {rows, cols, points} = wf;
  const lonW = points[0][0];
  const lonE = points[cols - 1][0];
  const latN = points[0][1];
  const latS = points[(rows - 1) * cols][1];
  const fc = cols > 1 ? Math.min(cols - 1, Math.max(0, ((lon - lonW) / (lonE - lonW)) * (cols - 1))) : 0;
  const fr = rows > 1 ? Math.min(rows - 1, Math.max(0, ((latN - lat) / (latN - latS)) * (rows - 1))) : 0;
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const dx = fc - c0;
  const dy = fr - r0;
  const at = (field: number[][]) =>
    (field[r0 * cols + c0][k] * (1 - dx) + field[r0 * cols + c1][k] * dx) * (1 - dy) +
    (field[r1 * cols + c0][k] * (1 - dx) + field[r1 * cols + c1][k] * dx) * dy;
  const u = at(wf.u_mph);
  const v = at(wf.v_mph);
  const from = (Math.atan2(-u, -v) * 180) / Math.PI;
  return {speed_mph: Math.hypot(u, v), from_deg: (from + 360) % 360, gust_mph: at(wf.gust_mph)};
}

/** Index of the wind_field point nearest (lon, lat). */
export function nearestWindPoint(wf: WindField, lon: number, lat: number): number {
  let best = 0;
  let bestD = Infinity;
  wf.points.forEach(([x, y], i) => {
    const d = greatCircleM(lon, lat, x, y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
