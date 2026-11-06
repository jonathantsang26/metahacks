import {FireStore, type ArrivalRaster} from '../fire/data.js';
import {metersPerDegree} from '../fire/geo.js';
import {isoUtc} from '../fire/time.js';
import {loadFront} from './front.js';
import {makeProj, polylineLengthM, round, type Proj} from './geom.js';
import type {DroneInput} from './score.js';
import {GUST_LIMIT_MS, gustLookup} from './wind.js';

/**
 * Hindsight: what actually burned in the planned hour (the MODELED arrival raster, interpolated
 * between official perimeters), and how much of it fell inside the watch circles of the drones
 * that could fly. A naive baseline, the same number of drones spaced evenly along the forecast
 * front, gives the number something to be compared with.
 */

/** arrival.png's green value for cells only the final perimeter covers: no resolved arrival time. */
const LATE_CONFIDENCE = 32 / 255;

export type BurnCell = {lon: number; lat: number};

/** Cells whose interpolated arrival falls in (t0, t1], skipping cells with no resolved time. */
export function burnedBetween(r: ArrivalRaster, t0: number, t1: number): {cells: BurnCell[]; cellAreaM2: number} {
  const [w, s, e, n] = r.bounds;
  const [mx, my] = metersPerDegree((s + n) / 2);
  const cellAreaM2 = (((e - w) * mx) / r.width) * (((n - s) * my) / r.height);
  // Codes for the window, so the loop compares bytes, not times.
  const codeOf = (ms: number) => 1 + ((ms - r.startMs) / r.windowMs) * 253;
  const lo = codeOf(t0);
  const hi = codeOf(t1);
  const cells: BurnCell[] = [];
  for (let row = 0; row < r.height; row++) {
    for (let col = 0; col < r.width; col++) {
      const i = (row * r.width + col) * 4;
      const code = r.rgba[i]!;
      if (code < 1 || code > 254 || code <= lo || code > hi) continue;
      if (r.rgba[i + 1]! / 255 <= LATE_CONFIDENCE) continue;
      cells.push({lon: w + ((col + 0.5) / r.width) * (e - w), lat: n - ((row + 0.5) / r.height) * (n - s)});
    }
  }
  return {cells, cellAreaM2};
}

/** Pure: share of cells inside any circle. */
export function shareInside(proj: Proj, cells: BurnCell[], circles: {lon: number; lat: number; radiusM: number}[]): {inside: number; total: number; pct: number} {
  const cs = circles.map(c => {
    const [x, y] = proj.toXY(c.lon, c.lat);
    return {x, y, r: c.radiusM};
  });
  let inside = 0;
  for (const cell of cells) {
    const [x, y] = proj.toXY(cell.lon, cell.lat);
    if (cs.some(c => Math.hypot(x - c.x, y - c.y) <= c.r)) inside++;
  }
  return {inside, total: cells.length, pct: cells.length ? round((100 * inside) / cells.length, 1) : 0};
}

/** Pure: n points spaced evenly by arc length along the front pieces taken end to end. */
export function evenlySpaced(proj: Proj, front: number[][][], n: number): {lon: number; lat: number}[] {
  const lines = front.map(l => l.map(([lon, lat]) => proj.toXY(lon!, lat!)));
  const total = lines.reduce((a, l) => a + polylineLengthM(l), 0);
  if (!n || !total) return [];
  const out: {lon: number; lat: number}[] = [];
  for (let k = 0; k < n; k++) {
    let target = ((k + 0.5) / n) * total;
    for (const l of lines) {
      const len = polylineLengthM(l);
      if (target > len) {
        target -= len;
        continue;
      }
      for (let i = 1; i < l.length; i++) {
        const a = l[i - 1]!;
        const b = l[i]!;
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (target <= seg || i === l.length - 1) {
          const f = seg ? Math.min(1, target / seg) : 0;
          const [lon, lat] = proj.toLonLat(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
          out.push({lon: round(lon, 5), lat: round(lat, 5)});
          break;
        }
        target -= seg;
      }
      break;
    }
  }
  return out;
}

export type Hindsight = {
  fire: string;
  t: string;
  tEnd: string;
  burnedHa: number;
  burnedCells: number;
  plan: {drones: number; flying: number; insideHa: number; insidePct: number};
  baseline: {method: string; drones: number; flying: number; insideHa: number; insidePct: number; points: {lon: number; lat: number; grounded: boolean}[]};
  arrivalStepMin: number;
  label: string;
};

export function hindsightAt(store: FireStore, tMs: number, drones: DroneInput[]): Hindsight {
  const r = store.arrival();
  const [lon0, lat0] = store.aoi().center;
  const proj = makeProj(lon0, lat0);
  const gust = gustLookup(store, tMs);
  const flies = (lon: number, lat: number) => {
    const g = gust.at(lon, lat);
    return g === null || g <= GUST_LIMIT_MS;
  };
  const {cells, cellAreaM2} = burnedBetween(r, tMs, tMs + 3.6e6);
  const ha = (n: number) => round((n * cellAreaM2) / 1e4, 1);

  const flying = drones.filter(d => flies(d.lon, d.lat));
  const plan = shareInside(proj, cells, flying);

  const front = loadFront(store, tMs);
  const radius = drones.length ? drones.reduce((a, d) => a + d.radiusM, 0) / drones.length : 400;
  const pts = front ? evenlySpaced(proj, front.front, drones.length) : [];
  const basePts = pts.map(p => ({...p, grounded: !flies(p.lon, p.lat)}));
  const base = shareInside(
    proj,
    cells,
    basePts.filter(p => !p.grounded).map(p => ({...p, radiusM: radius}))
  );

  return {
    fire: store.fire,
    t: isoUtc(tMs),
    tEnd: isoUtc(tMs + 3.6e6),
    burnedHa: ha(cells.length),
    burnedCells: cells.length,
    plan: {drones: drones.length, flying: flying.length, insideHa: ha(plan.inside), insidePct: plan.pct},
    baseline: {
      method: `${drones.length} drones spaced evenly along the forecast front, radius ${Math.round(radius)} m, same gust rule`,
      drones: basePts.length,
      flying: basePts.filter(p => !p.grounded).length,
      insideHa: ha(base.inside),
      insidePct: base.pct,
      points: basePts
    },
    arrivalStepMin: round(r.windowMs / 253 / 60_000, 1),
    label:
      'HINDSIGHT on MODELED data: the burned area in the hour comes from the arrival raster, which is interpolated between official perimeters (about 28 min steps), not observed. Drones are SIMULATED; none flew.'
  };
}
