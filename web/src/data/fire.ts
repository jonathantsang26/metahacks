import {useEffect, useState} from 'react';

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
  status: 'REAL' | 'MODELED' | 'SIM';
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

const FIRE_ID = new URLSearchParams(location.search).get('fire') ?? 'eaton';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} (run the pipeline: cd pipeline && make all)`);
  return r.json() as Promise<T>;
}

export function useFireData(): {data: FireData | null; error: string | null} {
  const [data, setData] = useState<FireData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const base = `/data/${FIRE_ID}`;
    Promise.all([
      getJson<Aoi>(`${base}/aoi.json`),
      getJson<DemMeta>(`${base}/dem.json`),
      getJson<{sources: ManifestSource[]}>(`${base}/manifest.json`),
      getJson<PerimeterCollection>(`${base}/final_perimeter.geojson`)
    ])
      .then(([aoi, dem, manifest, perimeter]) => setData({id: FIRE_ID, base, aoi, dem, manifest, perimeter}))
      .catch(e => setError(String(e.message ?? e)));
  }, []);
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
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
