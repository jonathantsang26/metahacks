/**
 * DJI .SRT flight telemetry: the subtitle track DJI drones write next to each video, one block per
 * frame (or per second on older models), with the GNSS position, altitude and, on some models,
 * the gimbal angles. Formats vary by model and firmware; the parser reads any `key: value` pairs it
 * finds and knows these layouts:
 *
 * - 'bracket' (Mini 2/3/4, Air 2/2S/3, Mavic 3, Matrice 30, M3E …):
 *     FrameCnt: 1, DiffTime: 33ms
 *     2024-05-01 14:22:31.123
 *     [iso: 100] … [latitude: 34.1] [longitude: -118.1] [rel_alt: 120.0 abs_alt: 450.1]
 *     and on enterprise models [gb_yaw: 120.3 gb_pitch: -45.0 gb_roll: 0.0]
 *   Some firmware spells it "longtitude" and puts spaces before the colons.
 * - 'legacy' (Phantom 3/4, Inspire 1):
 *     HOME(lon, lat) 2017.08.05 14:11:51
 *     GPS(lon, lat, n) BAROMETER:62.1
 * - 'inline' (Mavic Pro, Spark, Phantom 4 Pro):
 *     F/2.8, SS 320, ISO 100, EV 0, GPS (lon, lat, n), D 24.38m, H 6.80m, H.S 0.00m/s, V.S 0.00m/s
 *
 * Note the legacy and inline layouts put longitude first. The recorded date-time is the drone's local
 * clock with no zone; `utcOffsetMin` turns it into UTC.
 */

export type TelemetryFrame = {
  /** The subtitle block's number. */
  index: number;
  /** FrameCnt / SrtCnt when present. */
  frameCnt?: number;
  /** Subtitle start and end, seconds into the video. */
  startS: number;
  endS: number;
  /** The recorded local date-time, ms since the epoch read as if it were UTC (no zone is recorded). */
  localMs?: number;
  lat: number;
  lon: number;
  /** Height above the takeoff point, m (rel_alt, BAROMETER, H). */
  relAltM?: number;
  /** abs_alt / altitude: GNSS or barometric, datum varies by model; treat with care. */
  absAltM?: number;
  homeLat?: number;
  homeLon?: number;
  gimbalYawDeg?: number;
  gimbalPitchDeg?: number;
  gimbalRollDeg?: number;
  focalLenMm?: number;
  /** Every numeric key: value pair found, keys lower-cased. */
  raw: Record<string, number>;
};

export type SrtFormat = 'bracket' | 'legacy' | 'inline' | 'unknown';

export type ParsedSrt = {format: SrtFormat; frames: TelemetryFrame[]; warnings: string[]};

const TIMING = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
const DATETIME = /(\d{4})[-./](\d{2})[-./](\d{2})[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;
const NUM = '[-+]?\\d+(?:\\.\\d+)?';

function seconds(h: string, m: string, s: string, ms: string): number {
  return +h * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;
}

function pick(raw: Record<string, number>, ...keys: string[]): number | undefined {
  for (const k of keys) if (raw[k] !== undefined && Number.isFinite(raw[k])) return raw[k];
  return undefined;
}

/** Parses a DJI .SRT file. Blocks without a usable position (no fix, or 0, 0) are skipped. */
export function parseDjiSrt(text: string): ParsedSrt {
  const warnings: string[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const frames: TelemetryFrame[] = [];
  const formats = new Map<SrtFormat, number>();
  let noFix = 0;

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => TIMING.test(l));
    if (ti < 0) continue;
    const tm = TIMING.exec(lines[ti])!;
    const index = ti > 0 ? parseInt(lines[ti - 1], 10) : NaN;
    const body = lines.slice(ti + 1).join('\n').replace(/<[^>]*>/g, ' ');

    const raw: Record<string, number> = {};
    // key: value and key : value pairs (bracket layout, FrameCnt, BAROMETER:…).
    for (const m of body.matchAll(new RegExp(`([A-Za-z_][A-Za-z_.]*)\\s*:\\s*(${NUM})(?![\\d/])`, 'g'))) {
      raw[m[1].toLowerCase()] = parseFloat(m[2]);
    }
    // Inline layout's "H 6.80m", "D 24.38m": a short key, a space, a number with a unit.
    for (const m of body.matchAll(new RegExp(`(?:^|[,\\s])(H|D|H\\.S|V\\.S)\\s+(${NUM})\\s*m`, 'g'))) {
      raw[`inline_${m[1].toLowerCase()}`] = parseFloat(m[2]);
    }

    let format: SrtFormat = 'unknown';
    let lat = pick(raw, 'latitude', 'lat');
    let lon = pick(raw, 'longitude', 'longtitude', 'lon', 'lng');
    let relAltM = pick(raw, 'rel_alt', 'barometer');
    const absAltM = pick(raw, 'abs_alt', 'altitude');
    let homeLat: number | undefined;
    let homeLon: number | undefined;
    if (lat !== undefined && lon !== undefined) format = 'bracket';

    const gps = new RegExp(`GPS\\s*\\(\\s*(${NUM})\\s*,\\s*(${NUM})`).exec(body);
    if (gps && (lat === undefined || lon === undefined)) {
      lon = parseFloat(gps[1]);
      lat = parseFloat(gps[2]);
      format = /HOME\s*\(/.test(body) || raw.barometer !== undefined ? 'legacy' : 'inline';
    }
    const home = new RegExp(`HOME\\s*\\(\\s*(${NUM})\\s*,\\s*(${NUM})`).exec(body);
    if (home) {
      homeLon = parseFloat(home[1]);
      homeLat = parseFloat(home[2]);
    }
    if (relAltM === undefined && raw.inline_h !== undefined) relAltM = raw.inline_h;

    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      noFix++;
      continue;
    }
    formats.set(format, (formats.get(format) ?? 0) + 1);

    const dt = DATETIME.exec(body);
    const localMs = dt
      ? Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6], dt[7] ? +dt[7].padEnd(3, '0') : 0)
      : undefined;

    const frame: TelemetryFrame = {
      index: Number.isFinite(index) ? index : frames.length + 1,
      startS: seconds(tm[1], tm[2], tm[3], tm[4]),
      endS: seconds(tm[5], tm[6], tm[7], tm[8]),
      lat,
      lon,
      raw
    };
    const frameCnt = pick(raw, 'framecnt', 'srtcnt');
    if (frameCnt !== undefined) frame.frameCnt = frameCnt;
    if (localMs !== undefined && Number.isFinite(localMs)) frame.localMs = localMs;
    if (relAltM !== undefined) frame.relAltM = relAltM;
    if (absAltM !== undefined) frame.absAltM = absAltM;
    if (homeLat !== undefined && homeLon !== undefined) Object.assign(frame, {homeLat, homeLon});
    const gy = pick(raw, 'gb_yaw', 'gimbal_yaw');
    const gp = pick(raw, 'gb_pitch', 'gimbal_pitch');
    const gr = pick(raw, 'gb_roll', 'gimbal_roll');
    if (gy !== undefined) frame.gimbalYawDeg = gy;
    if (gp !== undefined) frame.gimbalPitchDeg = gp;
    if (gr !== undefined) frame.gimbalRollDeg = gr;
    const fl = pick(raw, 'focal_len');
    if (fl !== undefined) frame.focalLenMm = fl;
    frames.push(frame);
  }

  frames.sort((a, b) => a.startS - b.startS);
  if (noFix) warnings.push(`${noFix} block(s) without a GNSS fix were skipped`);
  if (!frames.length) warnings.push('no telemetry blocks with a position were found');
  else {
    if (frames.every(f => f.gimbalYawDeg === undefined)) warnings.push('no gimbal yaw recorded: the heading must come from elsewhere');
    if (frames.every(f => f.gimbalPitchDeg === undefined)) warnings.push('no gimbal pitch recorded: the pitch must come from elsewhere');
    if (frames.every(f => f.localMs === undefined)) warnings.push('no date-time recorded: detections get video time only');
  }
  let format: SrtFormat = 'unknown';
  let best = 0;
  for (const [f, n] of formats) if (n > best) [format, best] = [f, n];
  return {format, frames, warnings};
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Interpolates an angle in degrees the short way round. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

function lerpOpt(a: number | undefined, b: number | undefined, f: number, angle = false): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return angle ? lerpAngle(a, b, f) : lerp(a, b, f);
}

/**
 * Telemetry at a video time (seconds), linearly interpolated between the blocks around it (headings
 * the short way round). Null when the time is outside the track by more than `toleranceS` (default:
 * one block's length).
 */
export function telemetryAt(frames: TelemetryFrame[], videoTimeS: number, toleranceS?: number): TelemetryFrame | null {
  if (!frames.length) return null;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const tol = toleranceS ?? Math.max(0.05, last.endS - last.startS, first.endS - first.startS);
  if (videoTimeS < first.startS - tol || videoTimeS > last.endS + tol) return null;
  if (videoTimeS <= first.startS) return first;
  if (videoTimeS >= last.startS) return last;
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].startS <= videoTimeS) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const f = b.startS > a.startS ? (videoTimeS - a.startS) / (b.startS - a.startS) : 0;
  const out: TelemetryFrame = {
    index: a.index,
    startS: videoTimeS,
    endS: videoTimeS,
    lat: lerp(a.lat, b.lat, f),
    lon: lerp(a.lon, b.lon, f),
    raw: a.raw
  };
  const set = <K extends keyof TelemetryFrame>(k: K, v: TelemetryFrame[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('frameCnt', a.frameCnt);
  set('localMs', lerpOpt(a.localMs, b.localMs, f));
  set('relAltM', lerpOpt(a.relAltM, b.relAltM, f));
  set('absAltM', lerpOpt(a.absAltM, b.absAltM, f));
  set('homeLat', a.homeLat);
  set('homeLon', a.homeLon);
  set('gimbalYawDeg', lerpOpt(a.gimbalYawDeg, b.gimbalYawDeg, f, true));
  set('gimbalPitchDeg', lerpOpt(a.gimbalPitchDeg, b.gimbalPitchDeg, f));
  set('gimbalRollDeg', lerpOpt(a.gimbalRollDeg, b.gimbalRollDeg, f));
  set('focalLenMm', a.focalLenMm);
  return out;
}

/** The recorded local time as UTC ISO, given the drone clock's offset from UTC in minutes (e.g. −480 for PST). */
export function frameTimeUtc(frame: Pick<TelemetryFrame, 'localMs'>, utcOffsetMin: number | undefined): string | null {
  if (frame.localMs === undefined || utcOffsetMin === undefined) return null;
  return new Date(frame.localMs - utcOffsetMin * 60000).toISOString();
}

/**
 * Course over ground (degrees from north) between neighbouring blocks, a stand-in heading for
 * models that record no yaw. It is the direction of travel, so it is the camera's heading only
 * while the drone flies forward with the camera facing forward; null below `minSpeedMS` (default 2).
 */
export function courseOverGround(frames: TelemetryFrame[], i: number, minSpeedMS = 2): number | null {
  const a = frames[Math.max(0, i - 1)];
  const b = frames[Math.min(frames.length - 1, i + 1)];
  const dt = b.startS - a.startS;
  if (dt <= 0) return null;
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const north = (b.lat - a.lat) * 111132.95;
  const east = (b.lon - a.lon) * 111319.49 * Math.cos(latRad);
  if (Math.hypot(east, north) / dt < minSpeedMS) return null;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}
