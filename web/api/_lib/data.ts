import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';

/** Reads public/data/<fire>/ (the same files the web app serves), with mtime-checked caching. */

export const FIRE_ID = /^[a-z0-9_-]{1,40}$/;

export type Aoi = {
  name: string;
  location: string;
  timezone: string;
  bbox: [number, number, number, number];
  center: [number, number];
  window_utc: [string, string];
  official: {
    final_acres: number | null;
    alarm_date: string | null;
    containment_date: string | null;
    incident?: {start_utc: string; reported_location: [number, number]; source: string};
  };
};
export type DemMeta = {bounds: [number, number, number, number]};

export type ArrivalRaster = {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  startMs: number;
  windowMs: number;
  /** RGBA, row 0 = north. */
  rgba: Uint8Array;
};

export type ArrivalSample =
  | {inBounds: false}
  | {inBounds: true; burned: false; confidence: number}
  | {inBounds: true; burned: true; ms: number; confidence: number};

export class MissingDataError extends Error {}

type Entry = {mtimeMs: number; value: unknown};
const cache = new Map<string, Entry>();

export class FireStore {
  readonly dir: string;

  constructor(
    readonly fire: string,
    root: string = process.cwd()
  ) {
    if (!FIRE_ID.test(fire)) throw new Error(`invalid fire id: ${JSON.stringify(fire)}`);
    this.dir = path.join(root, 'public', 'data', fire);
  }

  exists(): boolean {
    return existsSync(path.join(this.dir, 'aoi.json'));
  }

  has(file: string): boolean {
    return existsSync(path.join(this.dir, file));
  }

  /** Cached by (file, mtime), so a pipeline re-run is picked up by a long-lived dev server. */
  private load<T>(file: string, parse: (buf: Buffer) => T, tag = 'raw'): T {
    const full = path.join(this.dir, file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      throw new MissingDataError(`${this.fire}/${file} is not available`);
    }
    const key = `${tag}:${full}`;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
    const value = parse(readFileSync(full));
    cache.set(key, {mtimeMs, value});
    return value;
  }

  json<T>(file: string): T {
    return this.load(file, buf => JSON.parse(buf.toString('utf8')) as T, 'json');
  }

  optionalJson<T>(file: string): T | null {
    return this.has(file) ? this.json<T>(file) : null;
  }

  /** A value derived from one file, recomputed when that file changes. */
  derived<T>(file: string, tag: string, build: (store: FireStore) => T): T {
    return this.load(file, () => build(this), `derived:${tag}`);
  }

  aoi(): Aoi {
    return this.json<Aoi>('aoi.json');
  }

  arrival(): ArrivalRaster {
    return this.load(
      'arrival.png',
      buf => {
        const png = PNG.sync.read(buf);
        const aoi = this.aoi();
        const [w0, w1] = aoi.window_utc.map(Date.parse);
        return {
          width: png.width,
          height: png.height,
          bounds: this.json<DemMeta>('dem.json').bounds,
          startMs: w0,
          windowMs: w1 - w0,
          rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)
        };
      },
      'arrival'
    );
  }
}

/**
 * Decodes one cell: red 1..254 → (code−1)/253 of the window, 255 → never burned, green →
 * confidence. The PNG spans dem.json bounds with row 0 = north, at its own width/height.
 */
export function sampleArrival(r: ArrivalRaster, lon: number, lat: number): ArrivalSample {
  const [w, s, e, n] = r.bounds;
  const col = Math.floor(((lon - w) / (e - w)) * r.width);
  const row = Math.floor(((n - lat) / (n - s)) * r.height);
  if (col < 0 || row < 0 || col >= r.width || row >= r.height) return {inBounds: false};
  const i = (row * r.width + col) * 4;
  const code = r.rgba[i];
  const confidence = r.rgba[i + 1] / 255;
  if (code < 1 || code > 254) return {inBounds: true, burned: false, confidence};
  return {inBounds: true, burned: true, ms: r.startMs + ((code - 1) / 253) * r.windowMs, confidence};
}

/** Minutes per arrival code step: the time resolution of arrival.png. */
export function arrivalStepMin(r: ArrivalRaster): number {
  return r.windowMs / 253 / 60_000;
}
