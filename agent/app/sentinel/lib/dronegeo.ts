/**
 * Drone camera geometry: from a pose (position, altitude, heading, gimbal angles, field of view) and
 * a pixel in the frame to a point on the terrain, plus the frame's ground footprint and the map point
 * (with an error budget) for a detection box.
 *
 * Frames and conventions
 * - Local ENU tangent plane at the drone: x east, y north, z up, meters. The earth's curvature is
 *   ignored (about 2 m of drop at 5 km), which is fine at drone ranges.
 * - Altitude: `altMslM` is the camera's height above mean sea level, the same datum as the DEM
 *   (dem.png is in meters above sea level). DJI's rel_alt is height above the takeoff point, not above
 *   ground: use `resolveAltitude` (dji-srt.ts) or add the takeoff ground elevation yourself.
 * - `yawDeg`: the camera's heading, degrees clockwise from true north (the gimbal yaw, not the
 *   aircraft's, when the gimbal can pan).
 * - `pitchDeg`: DJI gimbal convention, 0 = level with the horizon, −90 = straight down (nadir).
 * - `rollDeg`: positive turns the camera clockwise about its optical axis, as seen from behind it
 *   (the frame's right side drops). Gimbals hold this near 0.
 * - Pixels: (u, v) in source-video pixels, u right, v down, (0, 0) the top-left corner of the frame,
 *   (width, height) the bottom-right. The camera is an ideal pinhole with square pixels and the
 *   principal point at the frame's centre; lens distortion is not modelled.
 * - `hfovDeg`: the horizontal field of view of the frames as recorded. Video modes often crop the
 *   sensor, so this can be narrower than the photo-mode figure on a spec sheet.
 */

import {frameTimeUtc, telemetryAt, type TelemetryFrame} from './dji-srt';

/** Ground elevation (m above sea level) at a point, or null where the DEM has no coverage. */
export type DemSampler = (lon: number, lat: number) => number | null;

export type CameraPose = {
  lat: number;
  lon: number;
  /** Camera height above mean sea level, m. */
  altMslM: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg?: number;
};

export type CameraIntrinsics = {hfovDeg: number; width: number; height: number};

export type GroundOptions = {
  /** Terrain to intersect. Without one, or where it returns null, the flat plane below is used. */
  dem?: DemSampler | undefined;
  /**
   * Elevation (m above sea level) of the flat fallback plane. Default: the DEM under the drone if it
   * covers that point, else 0.
   */
  flatElevM?: number | undefined;
  /** Give up past this slant range, m. Default 20 000. */
  maxRangeM?: number | undefined;
  /**
   * Steepest terrain gradient (rise over run) the march assumes, which sets a step that cannot jump
   * over a ridge. Default 3 (72°); a DEM at 10–30 m resolution rarely exceeds it.
   */
  maxSlope?: number | undefined;
  /** Smallest march step, m; the crossing is then refined by bisection. Default 0.5. */
  minStepM?: number | undefined;
  /** Highest terrain anywhere (e.g. DemMeta.elevation_m[1]): lets a rising ray stop early. */
  maxTerrainElevM?: number | undefined;
};

export type GroundHit = {
  lon: number;
  lat: number;
  /** Ground elevation at the hit, m above sea level. */
  elevM: number;
  /** Local ENU offset from the drone, m. */
  east: number;
  north: number;
  /** Distance along the ray from the camera, m. */
  slantRangeM: number;
  /** Horizontal distance from the drone, m. */
  groundRangeM: number;
  /** Angle of the ray below the horizontal, degrees (90 = straight down). */
  depressionDeg: number;
  /** Whether the hit came from the DEM or the flat fallback plane. */
  source: 'dem' | 'flat';
};

const DEG = Math.PI / 180;
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

type Vec3 = [number, number, number];

/** Meters per radian of latitude (north) and of longitude (east) at a latitude. */
function radii(latDeg: number): {m: number; nCos: number} {
  const s = Math.sin(latDeg * DEG);
  const w = 1 - WGS84_E2 * s * s;
  const m = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5);
  const n = WGS84_A / Math.sqrt(w);
  return {m, nCos: n * Math.cos(latDeg * DEG)};
}

/** ENU meters from an origin to lon/lat (tangent-plane approximation, good to a few km). */
export function enuToLonLat(lon0: number, lat0: number, east: number, north: number): [number, number] {
  const {m, nCos} = radii(lat0);
  return [lon0 + east / nCos / DEG, lat0 + north / m / DEG];
}

/** lon/lat to ENU meters from an origin (inverse of enuToLonLat). */
export function lonLatToEnu(lon0: number, lat0: number, lon: number, lat: number): [number, number] {
  const {m, nCos} = radii(lat0);
  return [(lon - lon0) * DEG * nCos, (lat - lat0) * DEG * m];
}

/** The camera's forward, right and up axes in ENU. */
export function cameraAxes(pose: Pick<CameraPose, 'yawDeg' | 'pitchDeg' | 'rollDeg'>): {fwd: Vec3; right: Vec3; up: Vec3} {
  const y = pose.yawDeg * DEG;
  const p = pose.pitchDeg * DEG;
  const r = (pose.rollDeg ?? 0) * DEG;
  const fwd: Vec3 = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  const right0: Vec3 = [Math.cos(y), -Math.sin(y), 0];
  const up0 = cross(right0, fwd);
  // Roll about the forward axis: positive drops the right side.
  const right: Vec3 = sub(scale(right0, Math.cos(r)), scale(up0, Math.sin(r)));
  const up: Vec3 = add(scale(up0, Math.cos(r)), scale(right0, Math.sin(r)));
  return {fwd, right, up};
}

/** Focal length in pixels for a horizontal FOV. */
export function focalPx(cam: CameraIntrinsics): number {
  return cam.width / 2 / Math.tan((cam.hfovDeg * DEG) / 2);
}

/** Unit ray (ENU) through pixel (u, v). */
export function pixelRay(pose: CameraPose, cam: CameraIntrinsics, u: number, v: number): Vec3 {
  const {fwd, right, up} = cameraAxes(pose);
  const f = focalPx(cam);
  const xn = (u - cam.width / 2) / f;
  const yn = (v - cam.height / 2) / f;
  return norm(add(fwd, sub(scale(right, xn), scale(up, yn))));
}

/**
 * Where a ray from the camera meets the ground: the DEM where it has coverage, else the flat plane.
 * Null when the ray never reaches the ground within `maxRangeM` (above the horizon, or over terrain
 * that falls away) or when the camera itself is at or below the ground.
 */
export function intersectRay(pose: CameraPose, dir: Vec3, opts: GroundOptions = {}): GroundHit | null {
  const maxRange = opts.maxRangeM ?? 20000;
  const dem = opts.dem;
  const underDrone = dem ? dem(pose.lon, pose.lat) : null;
  const flat = opts.flatElevM ?? underDrone ?? 0;

  const hit = (t: number, elevM: number, source: 'dem' | 'flat'): GroundHit => {
    const east = dir[0] * t;
    const north = dir[1] * t;
    const [lon, lat] = enuToLonLat(pose.lon, pose.lat, east, north);
    const groundRangeM = Math.hypot(east, north);
    return {
      lon, lat, elevM, east, north, slantRangeM: t, groundRangeM,
      depressionDeg: Math.asin(Math.max(-1, Math.min(1, -dir[2]))) / DEG,
      source
    };
  };

  if (!dem) {
    if (dir[2] >= -1e-12) return null;
    const h = pose.altMslM - flat;
    if (h <= 0) return null;
    const t = h / -dir[2];
    return t <= maxRange ? hit(t, flat, 'flat') : null;
  }

  const ground = (t: number): {z: number; source: 'dem' | 'flat'} => {
    const [lon, lat] = enuToLonLat(pose.lon, pose.lat, dir[0] * t, dir[1] * t);
    const z = dem(lon, lat);
    return z === null || !Number.isFinite(z) ? {z: flat, source: 'flat'} : {z, source: 'dem'};
  };
  const gap = (t: number) => pose.altMslM + dir[2] * t - ground(t).z;

  if (gap(0) <= 0) return null;
  const maxSlope = opts.maxSlope ?? 3;
  const minStep = opts.minStepM ?? 0.5;
  const horiz = Math.hypot(dir[0], dir[1]);
  // How fast the gap can shrink per meter of ray: the ray's descent plus terrain rising under it.
  const closing = Math.max(1e-6, -dir[2] + maxSlope * horiz);
  let t0 = 0;
  let g0 = gap(0);
  while (t0 < maxRange) {
    const z = pose.altMslM + dir[2] * t0;
    if (dir[2] >= 0 && opts.maxTerrainElevM !== undefined && z > opts.maxTerrainElevM && z > flat) return null;
    const step = Math.min(500, Math.max(minStep, g0 / closing));
    const t1 = Math.min(maxRange, t0 + step);
    const g1 = gap(t1);
    if (g1 <= 0) {
      let lo = t0;
      let hi = t1;
      for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) > 0) lo = mid;
        else hi = mid;
      }
      const g = ground(hi);
      return hit(hi, g.z, g.source);
    }
    if (t1 >= maxRange) break;
    t0 = t1;
    g0 = g1;
  }
  return null;
}

/** Pixel (u, v) to the ground. Null above the horizon or beyond `maxRangeM`. */
export function pixelToGround(pose: CameraPose, cam: CameraIntrinsics, u: number, v: number, opts: GroundOptions = {}): GroundHit | null {
  return intersectRay(pose, pixelRay(pose, cam, u, v), opts);
}

export type Footprint = {
  /** Top-left, top-right, bottom-right, bottom-left; null where that corner's ray misses the ground. */
  corners: (GroundHit | null)[];
  /** Closed [lon, lat] ring of the four corners, or null when any corner misses (oblique views that show sky). */
  polygon: [number, number][] | null;
};

/** The ground footprint of the whole frame. */
export function frameFootprint(pose: CameraPose, cam: CameraIntrinsics, opts: GroundOptions = {}): Footprint {
  const px: [number, number][] = [[0, 0], [cam.width, 0], [cam.width, cam.height], [0, cam.height]];
  const corners = px.map(([u, v]) => pixelToGround(pose, cam, u, v, opts));
  const polygon = corners.every(c => c !== null)
    ? [...corners.map(c => [c!.lon, c!.lat] as [number, number]), [corners[0]!.lon, corners[0]!.lat] as [number, number]]
    : null;
  return {corners, polygon};
}

/** Adapts the stage's Dem class (src/stage/dem.ts) to a sampler. */
export function demSampler(dem: {contains(lon: number, lat: number): boolean; heightAt(lon: number, lat: number): number}): DemSampler {
  return (lon, lat) => (dem.contains(lon, lat) ? dem.heightAt(lon, lat) : null);
}

// ---------------------------------------------------------------------------------------------
// Detections → map points

/** A live-detector box: [x1, y1, x2, y2] in source-video pixels (same shape as drones/footage.ts). */
export type DetectionBox = {box: [number, number, number, number]; cls: string; conf: number};

/**
 * Error budget, 1σ-style inputs. Defaults are rough figures for a consumer DJI drone with an
 * uncorrected GNSS and compass; none of them is calibrated against ground truth.
 */
export type ErrorModel = {
  /** Horizontal GNSS error, m. Default 2.5. */
  gpsM?: number;
  /** Camera altitude error, m (barometer drift, takeoff elevation). Default 3. */
  altitudeM?: number;
  /** Heading error, degrees (compass). Default 3. */
  yawDeg?: number;
  /** Gimbal pitch error, degrees. Default 1. */
  pitchDeg?: number;
  /** Vertical DEM error where the DEM is hit, m. Default 5. */
  demM?: number;
  /** Vertical error of the flat fallback plane, m. Default 20. */
  flatM?: number;
  /** Pixel error of the anchor point along the look direction, pixels. Default 2. */
  anchorPx?: number;
};

export type Uncertainty = {
  /** Root-sum-square of the terms below, m. A rough 1σ radius, not a calibrated interval. */
  radiusM: number;
  gpsM: number;
  altitudeM: number;
  terrainM: number;
  attitudeM: number;
  pixelM: number;
};

export type LocatedDetection = {
  lon: number;
  lat: number;
  elevM: number;
  cls: string;
  conf: number;
  /** Which point of the box was projected. */
  anchor: 'bottom-center' | 'center';
  /** The pixel that was projected. */
  pixel: [number, number];
  slantRangeM: number;
  groundRangeM: number;
  depressionDeg: number;
  source: 'dem' | 'flat';
  uncertainty: Uncertainty;
};

/**
 * Projects a detection box to the ground for a known pose.
 *
 * Anchor: the box's bottom-centre by default. Flames sit on the ground, and with a camera looking
 * down the bottom edge of a box is its nearest ground contact; the centre of a smoke box is in the
 * air and would project behind the source. Use 'center' for a nadir camera, where the two coincide
 * in meaning and the centre is steadier.
 *
 * Null when the anchor's ray misses the ground.
 */
export function locateBox(
  det: DetectionBox,
  pose: CameraPose,
  cam: CameraIntrinsics,
  opts: GroundOptions & {anchor?: 'bottom-center' | 'center'; errors?: ErrorModel} = {}
): LocatedDetection | null {
  const anchor = opts.anchor ?? 'bottom-center';
  const [x1, y1, x2, y2] = det.box;
  const u = (x1 + x2) / 2;
  const v = anchor === 'center' ? (y1 + y2) / 2 : Math.max(y1, y2);
  const g = pixelToGround(pose, cam, u, v, opts);
  if (!g) return null;
  return {
    lon: g.lon, lat: g.lat, elevM: g.elevM,
    cls: det.cls, conf: det.conf, anchor, pixel: [u, v],
    slantRangeM: g.slantRangeM, groundRangeM: g.groundRangeM, depressionDeg: g.depressionDeg, source: g.source,
    uncertainty: errorBudget(g, pose, cam, [x1, x2], v, opts)
  };
}

function errorBudget(
  g: GroundHit,
  pose: CameraPose,
  cam: CameraIntrinsics,
  [x1, x2]: [number, number],
  v: number,
  opts: GroundOptions & {errors?: ErrorModel}
): Uncertainty {
  const e = opts.errors ?? {};
  // Grazing angle, floored so a ray skimming the ground gives a large but finite error.
  const graze = Math.max(0.5, g.depressionDeg) * DEG;
  const tanG = Math.tan(graze);
  const sinG = Math.sin(graze);

  const gpsM = e.gpsM ?? 2.5;
  // A vertical error dz moves the hit dz / tan(grazing) along the ground.
  const altitudeM = (e.altitudeM ?? 3) / tanG;
  const terrainM = (g.source === 'dem' ? (e.demM ?? 5) : (e.flatM ?? 20)) / tanG;
  // Heading error swings the point sideways; pitch error slides it along the look direction.
  const yawM = g.groundRangeM * (e.yawDeg ?? 3) * DEG;
  const pitchM = (g.slantRangeM * (e.pitchDeg ?? 1) * DEG) / sinG;
  const attitudeM = Math.hypot(yawM, pitchM);

  // Pixel term: half the ground width of the box's bottom edge (where along it the fire is), plus the
  // anchor's pixel error along the look direction, both measured by projecting neighbouring pixels.
  const left = pixelToGround(pose, cam, Math.min(x1, x2), v, opts);
  const right = pixelToGround(pose, cam, Math.max(x1, x2), v, opts);
  const halfWidth = left && right ? Math.hypot(left.east - right.east, left.north - right.north) / 2 : 0;
  const u = (x1 + x2) / 2;
  const px = e.anchorPx ?? 2;
  const below = pixelToGround(pose, cam, u, v + px, opts);
  const above = pixelToGround(pose, cam, u, v - px, opts);
  const along = below && above ? Math.hypot(below.east - above.east, below.north - above.north) / 2 : g.slantRangeM * (px / focalPx(cam)) / sinG;
  const pixelM = Math.hypot(halfWidth, along);

  const radiusM = Math.hypot(gpsM, altitudeM, terrainM, attitudeM, pixelM);
  return {radiusM, gpsM, altitudeM, terrainM, attitudeM, pixelM};
}

// ---------------------------------------------------------------------------------------------
// Telemetry → pose → timestamped map point

/**
 * The camera's height above sea level for a telemetry block.
 * - 'rel+takeoff' (preferred): rel_alt (height above the takeoff point) + the takeoff point's ground
 *   elevation, given as `takeoffElevM` or read from the DEM at `takeoff` (or at the recorded HOME
 *   point). The video may start mid-flight, so the first block's position is not assumed to be the
 *   takeoff point.
 * - 'abs': abs_alt as recorded. Its datum (barometric, GNSS ellipsoid or geoid) varies by model and
 *   can be off by tens of meters; it is used only when nothing better is available.
 */
export function resolveAltitude(
  f: TelemetryFrame,
  opts: {takeoffElevM?: number | undefined; takeoff?: {lon: number; lat: number} | undefined; dem?: DemSampler | undefined} = {}
): {altMslM: number; source: 'rel+takeoff' | 'abs'} | null {
  if (f.relAltM !== undefined) {
    let ground = opts.takeoffElevM;
    const home = opts.takeoff ?? (f.homeLat !== undefined && f.homeLon !== undefined ? {lon: f.homeLon, lat: f.homeLat} : undefined);
    if (ground === undefined && home && opts.dem) ground = opts.dem(home.lon, home.lat) ?? undefined;
    if (ground !== undefined) return {altMslM: ground + f.relAltM, source: 'rel+takeoff'};
  }
  if (f.absAltM !== undefined) return {altMslM: f.absAltM, source: 'abs'};
  return null;
}

export type PoseOptions = {
  takeoffElevM?: number | undefined;
  takeoff?: {lon: number; lat: number} | undefined;
  dem?: DemSampler | undefined;
  /** Used when the block records no gimbal yaw / pitch / roll (most consumer models record none). */
  yawDeg?: number | undefined;
  pitchDeg?: number | undefined;
  rollDeg?: number | undefined;
};

/** A camera pose from a telemetry block, or null (with the reason) when something needed is missing. */
export function poseFromTelemetry(f: TelemetryFrame, opts: PoseOptions = {}): {pose: CameraPose; altSource: 'rel+takeoff' | 'abs'} | {error: string} {
  const alt = resolveAltitude(f, opts);
  if (!alt) return {error: 'no altitude: give takeoffElevM (or a takeoff point and a DEM) for rel_alt, or record abs_alt'};
  const yawDeg = f.gimbalYawDeg ?? opts.yawDeg;
  const pitchDeg = f.gimbalPitchDeg ?? opts.pitchDeg;
  if (yawDeg === undefined) return {error: 'no heading: the telemetry has no gimbal yaw and none was given'};
  if (pitchDeg === undefined) return {error: 'no gimbal pitch: the telemetry has none and none was given'};
  return {
    pose: {lat: f.lat, lon: f.lon, altMslM: alt.altMslM, yawDeg, pitchDeg, rollDeg: f.gimbalRollDeg ?? opts.rollDeg ?? 0},
    altSource: alt.source
  };
}

/** A detection from the live detector at a moment in the video. */
export type TimedDetection = DetectionBox & {
  /** Seconds into the video the telemetry track belongs to (frame index / fps, plus any clip offset). */
  videoTimeS: number;
};

export type MapDetection = LocatedDetection & {
  /** UTC ISO time of the frame, or null when the SRT has no date-time or no UTC offset was given. */
  t: string | null;
  videoTimeS: number;
  altSource: 'rel+takeoff' | 'abs';
  pose: CameraPose;
};

/**
 * Detection box + the telemetry track → a timestamped map point with an uncertainty radius.
 * The telemetry is interpolated to the detection's video time. Returns {error} instead of a point
 * when the time is outside the track, the pose is incomplete, or the anchor ray misses the ground.
 */
export function detectionToMapPoint(
  det: TimedDetection,
  frames: TelemetryFrame[],
  cam: CameraIntrinsics,
  opts: PoseOptions & GroundOptions & {anchor?: 'bottom-center' | 'center'; errors?: ErrorModel; utcOffsetMin?: number} = {}
): MapDetection | {error: string} {
  const f = telemetryAt(frames, det.videoTimeS);
  if (!f) return {error: `no telemetry at ${det.videoTimeS.toFixed(2)} s`};
  const p = poseFromTelemetry(f, opts);
  if ('error' in p) return p;
  const loc = locateBox(det, p.pose, cam, opts);
  if (!loc) return {error: 'the box anchor looks above the horizon or beyond range'};
  return {...loc, t: frameTimeUtc(f, opts.utcOffsetMin), videoTimeS: det.videoTimeS, altSource: p.altSource, pose: p.pose};
}

// ---------------------------------------------------------------------------------------------
// Small vector helpers

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}
