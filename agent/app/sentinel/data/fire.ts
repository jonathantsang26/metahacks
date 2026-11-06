import {useEffect, useState} from 'react';
import {useTime} from '../state/time';

/** Shapes of the files the pipeline writes to public/data/<fire>/. */
export type Aoi = {
  id: string;
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
    /** CAL FIRE's reported start and incident location: a report, not an investigated origin. */
    incident?: {start_utc: string; reported_location: [number, number]; acres: number | null; url: string; source: string};
  };
};

export type DemMeta = {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  pixel_m: [number, number];
  elevation_m: [number, number];
  decoder: {rScaler: number; gScaler: number; bScaler: number; offset: number};
};

export type ManifestSource = {
  layer: string;
  source: string;
  url: string;
  /** The pipeline's provenance label for the source (manifest.json); not shown on screen. */
  status: string;
  attribution: string;
  notes: string;
  retrieved: string;
};

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};
export type PerimeterCollection = {
  type: 'FeatureCollection';
  features: {type: 'Feature'; properties: {name: string; acres: number | null}; geometry: Polygonal}[];
};

export type FireData = {
  id: string;
  base: string;
  aoi: Aoi;
  dem: DemMeta;
  manifest: {sources: ManifestSource[]};
  perimeter: PerimeterCollection;
};

/** The fires the pipeline has built; `?fire=<id>` picks one. */
export const FIRES = [
  {id: 'eaton', name: 'Eaton Fire'},
  {id: 'palisades', name: 'Palisades Fire'}
] as const;

export type FireId = (typeof FIRES)[number]['id'];
export const DEFAULT_FIRE: FireId = 'eaton';
/**
 * Where a link without `?t=` opens: the judged replay hour (Eaton, 2025-01-08 08:00 PST), the hour
 * the "Start here" guide plans. Other fires open at the start of their window, as in the Meta build.
 */
export const DEFAULT_T: Partial<Record<FireId, string>> = {eaton: '2025-01-08T16:00:00Z'};
export const isFireId = (v: unknown): v is FireId => FIRES.some(f => f.id === v);

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} (run the pipeline: cd pipeline && make all)`);
  return r.json() as Promise<T>;
}

/**
 * Loads one fire. The incident route remounts the screen per fire (keyed on `?fire=`), so this
 * runs once per fire; `initialT` (`?t=`) opens the replay at that moment.
 */
export function useFireData(fireId: FireId, initialT?: string | null): {data: FireData | null; error: string | null} {
  const [data, setData] = useState<FireData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const base = `/data/${fireId}`;
    Promise.all([
      getJson<Aoi>(`${base}/aoi.json`),
      getJson<DemMeta>(`${base}/dem.json`),
      getJson<{sources: ManifestSource[]}>(`${base}/manifest.json`),
      getJson<PerimeterCollection>(`${base}/final_perimeter.geojson`)
    ])
      .then(([aoi, dem, manifest, perimeter]) => {
        if (cancelled) return;
        // Set the replay window before the first render that has data, so no panel reads 0–1 ms.
        useTime.getState().setRange(Date.parse(aoi.window_utc[0]), Date.parse(aoi.window_utc[1]));
        // `?t=<ISO time>` opens the replay at that moment (clamped to the window), for shareable links.
        const t = Date.parse(initialT ?? DEFAULT_T[fireId] ?? '');
        if (Number.isFinite(t)) useTime.getState().setTime(t);
        setData({id: fireId, base, aoi, dem, manifest, perimeter});
      })
      .catch(e => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
    // initialT is read once per fire load; later ?t= changes go through the URL sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireId]);
  return {data, error};
}

/** Outer rings of every polygon, for drawing and hit-testing. */
export function perimeterRings(fc: PerimeterCollection): number[][][] {
  const rings: number[][][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') rings.push(...g.coordinates);
    else for (const poly of g.coordinates) rings.push(...poly);
  }
  return rings;
}

/** Even-odd point-in-polygon over all rings (holes included). */
export function insideRings(rings: number[][][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
    }
  }
  return inside;
}
