/**
 * Stage-side loading: GPU images with an explicit failure state, lazily fetched big files, and
 * the shapes of the two pipeline files the shared types do not cover.
 */
import {useEffect, useState} from 'react';
import type {FireData} from '../data/fire';
import {loadFireJson} from '../data/files';

/**
 * arrival_meta.json (step 06): the window the arrival codes are relative to, the seed the first
 * interval grows from, and the observation intervals each burned cell was interpolated across.
 */
export type ArrivalMeta = {
  window_utc: [string, string];
  seed?: {source: string; t: string; lonlat: [number, number]};
  intervals?: {from: string; to: string; from_h: number; to_h: number; new_cells: number}[];
};

/** severity_stats.json (step 08), the fields the stage reads. */
export type SeverityStats = {
  source: {product: string};
  encoding: {class_edges: number[]};
  perimeter: {coverage: number};
};

/**
 * Step 06's green channel for a cell interpolated across an interval of `ms`: 255 for ≤ 2 h,
 * falling to 64 for ≥ 12 h (s06_arrival.interpolate). Used only to tell which interval a cell
 * near an interval boundary belongs to, since its decoded arrival is quantized to one code step.
 */
export function intervalConfidence(ms: number): number {
  return Math.min(255, Math.max(64, Math.trunc(255 - (ms / 3_600_000 - 2) * (191 / 10))));
}

/** The observation interval a burned cell was interpolated across, or null. */
export function bracketingInterval(meta: ArrivalMeta | null, at: number, green: number, step: number) {
  let best: NonNullable<ArrivalMeta['intervals']>[number] | null = null;
  let bestErr = Infinity;
  for (const iv of meta?.intervals ?? []) {
    const from = Date.parse(iv.from);
    const to = Date.parse(iv.to);
    if (at < from - step || at > to + step) continue;
    // Matching confidence first; between equals (adjacent long gaps), the one containing `at`.
    const err = Math.abs(intervalConfidence(to - from) - green) * 1e9 + Math.max(0, from - at, at - to);
    if (err < bestErr) {
      best = iv;
      bestErr = err;
    }
  }
  return best;
}

export type ImageState ={status: 'loading' | 'ok' | 'error'; image: HTMLImageElement | null};

const images = new Map<string, Promise<HTMLImageElement>>();

/**
 * Loads public/data/<fire>/<file> as a decoded image for a texture prop. Unlike useRaster it
 * tells "still loading" from "missing", which decides whether the stage falls back.
 */
export function useFireImage(fire: FireData, file: string): ImageState {
  const [state, setState] = useState<ImageState>({status: 'loading', image: null});
  useEffect(() => {
    let live = true;
    setState({status: 'loading', image: null});
    const url = `${fire.base}/${file}`;
    let p = images.get(url);
    if (!p) {
      const img = new Image();
      img.src = url;
      p = img.decode().then(() => img);
      images.set(url, p);
    }
    p.then(
      image => live && setState({status: 'ok', image}),
      () => live && setState({status: 'error', image: null})
    );
    return () => {
      live = false;
    };
  }, [fire, file]);
  return state;
}

/** useFireJson that starts fetching only once `when` has been true (big files behind hidden layers). */
export function useFireJsonWhen<T>(fire: FireData, file: string, when: boolean): {data: T | null; error: string | null} {
  const [wanted, setWanted] = useState(when);
  const [state, setState] = useState<{data: T | null; error: string | null}>({data: null, error: null});
  if (when && !wanted) setWanted(true);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadFireJson<T>(fire, file).then(
      data => live && setState({data, error: null}),
      e => live && setState({data: null, error: String(e.message ?? e)})
    );
    return () => {
      live = false;
    };
  }, [fire, file, wanted]);
  return state;
}
