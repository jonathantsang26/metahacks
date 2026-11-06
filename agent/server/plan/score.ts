import {FireStore, sampleArrival} from '../fire/data.js';
import {isoUtc, localLabel} from '../fire/time.js';
import {FAST_ADVANCE_M, frontSamples, loadFront, type Front} from './front.js';
import {makeProj, PointGrid, round, type Proj} from './geom.js';
import {FLIGHT_AGL_M, GUST_LIMIT_MS, gustLookup} from './wind.js';

/**
 * Plan score: simple geometry, not the MuJoCo sim. Each drone watches a circle around its watch
 * point; the score is how much of the forecast front and how many homes near it fall inside the
 * circles of drones the wind lets fly.
 *
 * Why 400 m by default: at 120 m above ground the M4TD thermal camera, tilted 45°, sees a wedge
 * about 70 to 200 m ahead, and the Meta sim models the panning gimbal as a 150 m circle around the
 * drone at any instant. A drone holding a watch point flies a slow orbit of about 250 m around it
 * over the hour, so the ground it keeps in view is a circle of roughly 250 + 150 = 400 m. It is
 * an order of magnitude for planning, not a sensor model.
 */

export const DEFAULT_RADIUS_M = 400;
/** Homes within this distance of the front count as near it. */
export const NEAR_FRONT_M = 500;
const STEP_M = 20;
const GAP_CHUNK_M = 1000;

export type DroneInput = {droneId: string; lon: number; lat: number; radiusM: number};
export type DroneScore = {
  droneId: string;
  lon: number;
  lat: number;
  radiusM: number;
  gustMs: number | null;
  grounded: boolean;
  /** Front length inside this drone's circle, counting overlap with other drones. */
  frontKmInView: number;
  /** Front length only this drone sees. */
  uniqueFrontKm: number;
  homesInView: number;
};
export type Gap = {lengthKm: number; mid: {lon: number; lat: number}; homesNear: number; gustMs: number | null; flyable: boolean; fast: boolean};

export type GeometryScore = {
  frontKm: number;
  coveredKm: number;
  frontCoveragePct: number;
  /** Front on stretches the forecast expects to advance >= 200 m in the hour (the head), and how much of it is in view. */
  fastFrontKm: number;
  fastCoveredKm: number;
  fastCoveragePct: number;
  homesNearFront: number;
  homesWatched: number;
  groundedCount: number;
  activeCount: number;
  perDrone: DroneScore[];
  /** Stretches of front (0.2 to 1 km) no flying drone sees: flyable first, then fast-moving, then most homes; at most 10. */
  gaps: Gap[];
};

export type GeometryInput = {
  proj: Proj;
  /** Front as MultiLineString coordinates [lon, lat]. */
  front: number[][][];
  /** Per front line: true when it is fast-moving (forecast advance >= 200 m). */
  fastLines?: boolean[] | undefined;
  drones: DroneInput[];
  /** Structures still standing ahead of the fire at t, as [lon, lat]. */
  homes: [number, number][];
  gustAt: (lon: number, lat: number) => number | null;
  gustLimitMs?: number;
  nearFrontM?: number;
  stepM?: number;
};

/** Pure: front coverage (union of circles, no double counting), homes near the front and watched, grounding. */
export function scoreGeometry(input: GeometryInput): GeometryScore {
  const {proj, drones} = input;
  const limit = input.gustLimitMs ?? GUST_LIMIT_MS;
  const nearM = input.nearFrontM ?? NEAR_FRONT_M;
  const samples = frontSamples(input.front, proj, input.stepM ?? STEP_M);

  const ds = drones.map(d => {
    const [x, y] = proj.toXY(d.lon, d.lat);
    const gust = input.gustAt(d.lon, d.lat);
    return {...d, x, y, gust, grounded: gust !== null && gust > limit};
  });
  const active = ds.filter(d => !d.grounded);
  const inCircle = (d: {x: number; y: number; radiusM: number}, x: number, y: number) => Math.hypot(x - d.x, y - d.y) <= d.radiusM;

  let frontM = 0;
  let coveredM = 0;
  let fastM = 0;
  let fastCoveredM = 0;
  const isFast = (piece: number) => !!input.fastLines?.[piece];
  const perIn = new Map<string, number>(ds.map(d => [d.droneId, 0]));
  const perUnique = new Map<string, number>(ds.map(d => [d.droneId, 0]));
  const covered: boolean[] = [];
  const grid = new PointGrid<number>(nearM);
  samples.forEach((s, i) => {
    frontM += s.lenM;
    grid.add(s.x, s.y, i);
    const seers = active.filter(d => inCircle(d, s.x, s.y));
    covered.push(seers.length > 0);
    if (seers.length) coveredM += s.lenM;
    if (isFast(s.piece)) {
      fastM += s.lenM;
      if (seers.length) fastCoveredM += s.lenM;
    }
    const only = seers.length === 1 ? seers[0] : undefined;
    if (only) perUnique.set(only.droneId, perUnique.get(only.droneId)! + s.lenM);
    for (const d of ds) if (inCircle(d, s.x, s.y)) perIn.set(d.droneId, perIn.get(d.droneId)! + s.lenM);
  });

  // Homes near the front, keyed to their nearest front sample (for gap ranking).
  let homesNear = 0;
  let homesWatched = 0;
  const homesBySample = new Map<number, number>();
  const perHomes = new Map<string, number>(ds.map(d => [d.droneId, 0]));
  for (const [lon, lat] of input.homes) {
    const [x, y] = proj.toXY(lon, lat);
    const near = grid.nearest(x, y, nearM);
    if (!near) continue;
    homesNear++;
    homesBySample.set(near.v, (homesBySample.get(near.v) ?? 0) + 1);
    let watched = false;
    for (const d of ds) {
      if (!inCircle(d, x, y)) continue;
      perHomes.set(d.droneId, perHomes.get(d.droneId)! + 1);
      if (!d.grounded) watched = true;
    }
    if (watched) homesWatched++;
  }

  // Uncovered runs within each front piece, cut into stretches of at most GAP_CHUNK_M so each
  // gap's midpoint is a usable watch point (a 400 m circle sees about 0.8 km of a straight front).
  const gaps: (Gap & {m: number})[] = [];
  let run: number[] = [];
  const emit = (idx: number[]) => {
    const m = idx.reduce((a, i) => a + samples[i]!.lenM, 0);
    if (m < 200) return;
    const midS = samples[idx[Math.floor(idx.length / 2)]!]!;
    const [lon, lat] = proj.toLonLat(midS.x, midS.y);
    const g = input.gustAt(lon, lat);
    gaps.push({
      m,
      lengthKm: round(m / 1000, 2),
      mid: {lon: round(lon, 5), lat: round(lat, 5)},
      homesNear: idx.reduce((a, i) => a + (homesBySample.get(i) ?? 0), 0),
      gustMs: g === null ? null : round(g, 1),
      flyable: g === null || g <= limit,
      fast: isFast(midS.piece)
    });
  };
  const flush = () => {
    let chunk: number[] = [];
    let m = 0;
    for (const i of run) {
      chunk.push(i);
      m += samples[i]!.lenM;
      if (m >= GAP_CHUNK_M) {
        emit(chunk);
        chunk = [];
        m = 0;
      }
    }
    emit(chunk);
    run = [];
  };
  samples.forEach((s, i) => {
    if (i > 0 && samples[i - 1]!.piece !== s.piece) flush();
    if (covered[i]) flush();
    else run.push(i);
  });
  flush();
  // Flyable first (a gap in a grounded cell cannot be watched), then fast-moving, then most homes.
  gaps.sort((a, b) => Number(b.flyable) - Number(a.flyable) || Number(b.fast) - Number(a.fast) || b.homesNear - a.homesNear || b.m - a.m);

  const km = (m: number) => round(m / 1000, 2);
  return {
    frontKm: km(frontM),
    coveredKm: km(coveredM),
    frontCoveragePct: frontM ? round((100 * coveredM) / frontM, 1) : 0,
    fastFrontKm: km(fastM),
    fastCoveredKm: km(fastCoveredM),
    fastCoveragePct: fastM ? round((100 * fastCoveredM) / fastM, 1) : 0,
    homesNearFront: homesNear,
    homesWatched,
    groundedCount: ds.filter(d => d.grounded).length,
    activeCount: active.length,
    perDrone: ds.map(d => ({
      droneId: d.droneId,
      lon: d.lon,
      lat: d.lat,
      radiusM: d.radiusM,
      gustMs: d.gust === null ? null : round(d.gust, 1),
      grounded: d.grounded,
      frontKmInView: km(perIn.get(d.droneId)!),
      uniqueFrontKm: km(perUnique.get(d.droneId)!),
      homesInView: perHomes.get(d.droneId)!
    })),
    gaps: gaps.slice(0, 10).map(({m: _m, ...g}) => g)
  };
}

/** Structures (DINS points) not inside the ground burned by t: the homes the front still threatens. */
export function homesAhead(store: FireStore, tMs: number): [number, number][] {
  const all = store.derived('structures.geojson', 'plan-points', s =>
    s.json<{features: {geometry: {coordinates: number[]}}[]}>('structures.geojson').features.map(f => [f.geometry.coordinates[0], f.geometry.coordinates[1]] as [number, number])
  );
  const r = store.arrival();
  return all.filter(([lon, lat]) => {
    const a = sampleArrival(r, lon, lat);
    return !(a.inBounds && a.burned && a.ms <= tMs);
  });
}

export type PlanScore = GeometryScore & {
  fire: string;
  t: string;
  tEnd: string;
  t_local: string;
  tEnd_local: string;
  forecast: {file: string; issuedAt: string; validAt: string; method: string; status: 'saved'} | null;
  /** Which forecast the front came from: "muse" (Muse Spark) or "physics" (fallback when Muse's reply was rejected). */
  method: string | null;
  fastAdvanceM: number;
  gustHours: string[];
  /** Flight-height gust per wind cell for the hour; drones in cells with flyable false are grounded. */
  windCells: {bbox: [number, number, number, number]; gustMs: number; flyable: boolean}[];
  gustLimitMs: number;
  flightAglM: number;
  nearFrontM: number;
  defaultRadiusM: number;
  label: string;
};

export function scoreLabel(hasFront: boolean): string {
  return hasFront
    ? 'Geometric estimate on the saved forecast; this is a replay and the drones are a plan (none flew). Coverage = share of the forecast front inside the watch circles of drones the HRRR gust lets fly (12 m/s at 120 m); homes are counts of inspected structures, never addresses.'
    : 'No forecast covers this hour, so there is no front to score. The drones are a plan (none flew).';
}

/** Score drones for a fire at t: loads the front, homes and gusts, then runs scoreGeometry. */
export function scorePlanAt(store: FireStore, tMs: number, drones: DroneInput[], front: Front | null = loadFront(store, tMs)): PlanScore {
  const [lon0, lat0] = store.aoi().center;
  const proj = makeProj(lon0, lat0);
  const gust = gustLookup(store, tMs);
  const geo = scoreGeometry({
    proj,
    front: front?.front ?? [],
    fastLines: front?.lineAdvanceM.map(a => a !== null && a >= FAST_ADVANCE_M),
    drones,
    homes: front ? homesAhead(store, tMs) : [],
    gustAt: gust.at
  });
  const tz = store.aoi().timezone;
  return {
    fire: store.fire,
    t: isoUtc(tMs),
    tEnd: isoUtc(tMs + 3.6e6),
    t_local: localLabel(tMs, tz),
    tEnd_local: localLabel(tMs + 3.6e6, tz),
    ...geo,
    forecast: front ? {file: front.forecastFile, issuedAt: front.issuedAt, validAt: front.validAt, method: front.method, status: 'saved'} : null,
    method: front?.method ?? null,
    fastAdvanceM: FAST_ADVANCE_M,
    gustHours: gust.hours,
    windCells: gust.cells,
    gustLimitMs: GUST_LIMIT_MS,
    flightAglM: FLIGHT_AGL_M,
    nearFrontM: NEAR_FRONT_M,
    defaultRadiusM: DEFAULT_RADIUS_M,
    label: scoreLabel(!!front)
  };
}
