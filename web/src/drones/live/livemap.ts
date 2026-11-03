import {create} from 'zustand';
import {telemetryAt, type ParsedSrt} from '../../lib/dji-srt';
import {
  lonLatToEnu,
  enuToLonLat,
  locateBox,
  pixelToGround,
  poseFromTelemetry,
  type CameraIntrinsics,
  type CameraPose,
  type DemSampler,
  type GroundOptions
} from '../../lib/dronegeo';
import type {Det} from './decode';

/**
 * LIVE hits on the map: each box the in-browser detector draws, projected onto the terrain with the
 * drone's pose (a DJI SRT track next to the video, or a pose typed in by hand). Every hit is LIVE:
 * measured on this device from frames it processed. Hits from a hand-typed pose carry 'manual'.
 */

export type PoseSource = 'srt' | 'manual';

/** A pose typed in by hand. Altitude is above the ground under the drone. */
export type ManualPose = {lat: number; lon: number; altAglM: number; headingDeg: number; pitchDeg: number; hfovDeg: number};

export type LiveHit = {
  id: number;
  /** Date.now() when the box was drawn. */
  tMs: number;
  /** Position in the video file when known (file sources). */
  videoTimeS: number | null;
  lon: number;
  lat: number;
  elevM: number;
  conf: number;
  cls: string;
  /** Ground footprint of the box: its corners that reach the ground, [lon, lat, elev]. */
  corners: [number, number, number][];
  radiusM: number;
  ground: 'dem' | 'flat';
  pose: PoseSource;
  /** Whether the hit falls on this fire's map (inside the DEM). */
  onMap: boolean;
  /** Short name of the video source, so a hit can be traced to its clip. */
  sourceName: string;
};

/** A hit fades to FADE_MIN over FADE_MS of wall time, and then stays. */
export const FADE_MS = 120_000;
export const FADE_MIN = 0.25;
/** "Fire edge now": the hull of hits from the last EDGE_WINDOW_MS. */
export const EDGE_WINDOW_MS = 20_000;
/** Kept hits; older ones drop off first. */
export const MAX_HITS = 3000;

export function fadeAlpha(ageMs: number, fadeMs = FADE_MS, min = FADE_MIN): number {
  if (ageMs <= 0) return 1;
  if (ageMs >= fadeMs) return min;
  return 1 - (1 - min) * (ageMs / fadeMs);
}

/**
 * Pose for a moment of the video. SRT: telemetry interpolated to the video time, heading and pitch from
 * the gimbal fields, else from the manual form; altitude rel_alt + DEM at the home point (or the first
 * block), else abs_alt. Manual: the form, altitude AGL + DEM under the drone (flat ground at 0 m when
 * the DEM does not reach the drone).
 */
export function resolvePose(
  mode: PoseSource,
  manual: ManualPose | null,
  srt: ParsedSrt | null,
  videoTimeS: number | null,
  dem: DemSampler | undefined
): {pose: CameraPose; ground: GroundOptions} | {error: string} {
  if (mode === 'manual') {
    if (!manual) return {error: 'enter a pose'};
    const bad = (['lat', 'lon', 'altAglM', 'headingDeg', 'pitchDeg', 'hfovDeg'] as const).find(k => !Number.isFinite(manual[k]));
    if (bad) return {error: `pose field ${bad} is not a number`};
    if (manual.altAglM <= 0) return {error: 'altitude above ground must be positive'};
    const z = dem?.(manual.lon, manual.lat) ?? null;
    return {
      pose: {lat: manual.lat, lon: manual.lon, altMslM: (z ?? 0) + manual.altAglM, yawDeg: manual.headingDeg, pitchDeg: manual.pitchDeg, rollDeg: 0},
      ground: z === null ? {flatElevM: 0} : {dem}
    };
  }
  if (!srt || !srt.frames.length) return {error: 'load a DJI .SRT telemetry file'};
  if (videoTimeS === null) return {error: 'SRT needs a video file (the source has no video time)'};
  const f = telemetryAt(srt.frames, videoTimeS);
  if (!f) return {error: `no telemetry at ${videoTimeS.toFixed(1)} s`};
  const first = srt.frames[0];
  const p = poseFromTelemetry(f, {
    dem,
    takeoff: f.homeLat !== undefined && f.homeLon !== undefined ? {lon: f.homeLon, lat: f.homeLat} : {lon: first.lon, lat: first.lat},
    yawDeg: manual?.headingDeg,
    pitchDeg: manual?.pitchDeg
  });
  if ('error' in p) return p;
  return {pose: p.pose, ground: dem && dem(f.lon, f.lat) !== null ? {dem} : {}};
}

/**
 * One frame's boxes → map hits. The anchor follows locateBox: the box centre when the camera looks
 * nearly straight down, else the bottom-centre (flames' ground contact; a box centre would project
 * behind the fire). Corners that look above the horizon are left out of the footprint.
 */
export function projectDets(
  dets: Det[],
  classes: string[],
  pose: CameraPose,
  cam: CameraIntrinsics,
  ground: GroundOptions,
  meta: {tMs: number; videoTimeS: number | null; pose: PoseSource; sourceName: string; nextId: () => number; onMap: (lon: number, lat: number) => boolean}
): LiveHit[] {
  const out: LiveHit[] = [];
  const anchor = pose.pitchDeg <= -70 ? 'center' : 'bottom-center';
  for (const d of dets) {
    const loc = locateBox({box: d.box, cls: classes[d.cls] ?? `class ${d.cls}`, conf: d.score}, pose, cam, {...ground, anchor});
    if (!loc) continue;
    const [x1, y1, x2, y2] = d.box;
    const corners: [number, number, number][] = [];
    for (const [u, v] of [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2]
    ]) {
      const g = pixelToGround(pose, cam, u, v, ground);
      if (g) corners.push([g.lon, g.lat, g.elevM]);
    }
    out.push({
      id: meta.nextId(),
      tMs: meta.tMs,
      videoTimeS: meta.videoTimeS,
      lon: loc.lon,
      lat: loc.lat,
      elevM: loc.elevM,
      conf: loc.conf,
      cls: loc.cls,
      corners,
      radiusM: loc.uncertainty.radiusM,
      ground: loc.source,
      pose: meta.pose,
      onMap: meta.onMap(loc.lon, loc.lat),
      sourceName: meta.sourceName
    });
  }
  return out;
}

/** Andrew's monotone chain on planar points; counter-clockwise, no repeated closing point. */
export function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * "Fire edge now": the convex hull of the recent on-map hits (anchors and box corners), as a closed
 * lon/lat ring. The hull is built in local meters so it is not skewed by longitude scale. Null with
 * fewer than three distinct points.
 */
export function fireEdgeNow(hits: LiveHit[], nowMs: number, windowMs = EDGE_WINDOW_MS): [number, number][] | null {
  const recent = hits.filter(h => h.onMap && nowMs - h.tMs <= windowMs && h.tMs <= nowMs);
  if (!recent.length) return null;
  const lon0 = recent[0].lon;
  const lat0 = recent[0].lat;
  const pts: [number, number][] = [];
  for (const h of recent) {
    pts.push(lonLatToEnu(lon0, lat0, h.lon, h.lat));
    for (const c of h.corners) pts.push(lonLatToEnu(lon0, lat0, c[0], c[1]));
  }
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  const ring = hull.map(([e, n]) => enuToLonLat(lon0, lat0, e, n));
  ring.push(ring[0]);
  return ring;
}

type HitsState = {
  hits: LiveHit[];
  mode: PoseSource;
  manual: ManualPose | null;
  srt: ParsedSrt | null;
  srtName: string | null;
  /** Why the newest frame's boxes were not placed, if they were not. */
  lastError: string | null;
  add: (hits: LiveHit[]) => void;
  clear: () => void;
  set: (patch: Partial<Pick<HitsState, 'mode' | 'manual' | 'srt' | 'srtName' | 'lastError'>>) => void;
};

let seq = 0;
export const nextHitId = () => ++seq;

export const useLiveHits = create<HitsState>(set => ({
  hits: [],
  mode: 'manual',
  manual: null,
  srt: null,
  srtName: null,
  lastError: null,
  add: hits => set(s => (hits.length ? {hits: s.hits.concat(hits).slice(-MAX_HITS), lastError: null} : s)),
  clear: () => set({hits: [], lastError: null}),
  set: patch => set(patch)
}));
