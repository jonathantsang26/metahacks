/**
 * Fire-spread forecasts exported by the pipeline to public/data/<fire>/forecast/: index.json lists one
 * GeoJSON FeatureCollection per issue time. Every feature is a FORECAST, never an observation.
 */

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};

export type ForecastMethod = 'physics' | 'muse' | string;
export type ForecastProps = {issued_utc: string; valid_utc: string; method: ForecastMethod; status: 'FORECAST' | string};
export type ForecastFeature = {type: 'Feature'; geometry: Polygonal; properties: ForecastProps};
export type ForecastCollection = {type: 'FeatureCollection'; features: ForecastFeature[]};

/** One index entry: a file name, plus its issue time when the index records it (then only that file is fetched). */
export type IndexEntry = {file: string; issuedMs: number | null};

/** Accepts ["a.geojson", …], {files: [...]}, or entries {file, issued_utc}. Unknown shapes give []. */
export function parseIndex(json: unknown): IndexEntry[] {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as {files?: unknown}).files) ? (json as {files: unknown[]}).files : [];
  const out: IndexEntry[] = [];
  for (const e of list) {
    if (typeof e === 'string') out.push({file: e, issuedMs: null});
    else if (e && typeof e === 'object' && typeof (e as {file?: unknown}).file === 'string') {
      const issued = (e as {issued_utc?: unknown}).issued_utc;
      const ms = typeof issued === 'string' ? Date.parse(issued) : NaN;
      out.push({file: (e as {file: string}).file, issuedMs: Number.isFinite(ms) ? ms : null});
    }
  }
  return out;
}

export type IssuedForecast = {file: string; issuedMs: number; validMs: number; fc: ForecastCollection};

/** A collection's issue and valid times, from its features (the earliest issue, the latest valid time). */
export function forecastTimes(fc: ForecastCollection): {issuedMs: number; validMs: number} | null {
  let issued = Infinity;
  let valid = -Infinity;
  for (const f of fc.features ?? []) {
    const a = Date.parse(f.properties?.issued_utc);
    const b = Date.parse(f.properties?.valid_utc);
    if (Number.isFinite(a)) issued = Math.min(issued, a);
    if (Number.isFinite(b)) valid = Math.max(valid, b);
  }
  return Number.isFinite(issued) && Number.isFinite(valid) ? {issuedMs: issued, validMs: valid} : null;
}

/**
 * The forecast in force at t: the latest issued at or before t, as long as t has not passed its valid
 * time (a stale forecast is not shown as if it still looked ahead). Null when none qualifies.
 */
export function pickForecast<T extends {issuedMs: number; validMs: number}>(items: T[], tMs: number): T | null {
  let best: T | null = null;
  for (const it of items) if (it.issuedMs <= tMs && (!best || it.issuedMs > best.issuedMs)) best = it;
  return best && tMs <= best.validMs ? best : null;
}

/** Among index entries that carry issue times, the one to fetch for t (latest issued ≤ t). */
export function pickEntry(entries: IndexEntry[], tMs: number): IndexEntry | null {
  let best: IndexEntry | null = null;
  for (const e of entries) if (e.issuedMs !== null && e.issuedMs <= tMs && (!best || e.issuedMs > best.issuedMs!)) best = e;
  return best;
}

/** "+1 h", "+45 min", "+1.5 h": the lead time between issue and valid time. */
export function leadLabel(issuedMs: number, validMs: number): string {
  const min = Math.round((validMs - issuedMs) / 60000);
  if (min < 60) return `+${min} min`;
  return `+${(min / 60).toFixed(1).replace(/\.0$/, '')} h`;
}

export const METHOD_LABEL = (m: string) => (m === 'physics' ? 'PHYSICS' : m === 'muse' ? 'MUSE' : m.toUpperCase());
