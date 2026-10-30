/**
 * Burned area at any time from the CPU copy of arrival.png, so the Fire Area readout counts the
 * cells the map draws as burned. Arrival codes are 1/253 steps of the arrival window, so the
 * area is a step function of t: acres per code are summed once per raster, and each t is then a
 * binary search over the distinct arrival times.
 */
import {useEffect, useMemo, useState} from 'react';
import type {FireData} from '../data/fire';
import {decodeArrival, useRaster, type Raster} from '../data/raster';
import type {ArrivalIntervals} from './scale';

const M2_PER_ACRE = 4046.8564224;
/** Mean Earth radius (m), for cell sizes from the raster's lon/lat bounds. */
const EARTH_R = 6_371_008.8;
const RAD = Math.PI / 180;

export type BurnedArea = {
  /** Distinct arrival times (epoch ms, ascending) and the acres burned at or before each. */
  times: number[];
  acres: number[];
  /** Mean cell edge (m) and the time between arrival codes (ms). */
  cellM: number;
  stepMs: number;
};

/** Square metres burned per arrival code (index = red value), with each row's cell area at its latitude. */
function areaByCode(r: Raster): {m2: Float64Array; cellM: number} {
  const [w, s, e, n] = r.bounds;
  const dy = ((n - s) * RAD * EARTH_R) / r.height;
  const m2 = new Float64Array(256);
  let sumDx = 0;
  for (let row = 0; row < r.height; row++) {
    const lat = n - ((row + 0.5) / r.height) * (n - s);
    const dx = ((e - w) * RAD * EARTH_R * Math.cos(lat * RAD)) / r.width;
    sumDx += dx;
    const cell = dx * dy;
    for (let col = 0, k = row * r.width * 4; col < r.width; col++, k += 4) m2[r.data[k]] += cell;
  }
  return {m2, cellM: Math.sqrt((sumDx / r.height) * dy)};
}

/**
 * The arrival window the codes are relative to: arrival_meta.json's, else the AOI's (step 06
 * keeps them equal; the map makes the same choice).
 */
export function arrivalWindow(fire: FireData, meta: ArrivalIntervals | null): [number, number] {
  const [a, b] = meta?.window_utc ?? fire.aoi.window_utc;
  return [Date.parse(a), Date.parse(b)];
}

const probes = new Map<string, Promise<boolean>>();

/**
 * Whether public/data/<fire>/<file> fails to load or decode. useRaster gives null both while
 * loading and on failure, so this asks the browser separately (the file comes from its cache).
 */
function useImageFailed(fire: FireData, file: string): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const url = `${fire.base}/${file}`;
    let p = probes.get(url);
    if (!p) {
      const img = new Image();
      img.src = url;
      p = img.decode().then(
        () => false,
        () => true
      );
      probes.set(url, p);
    }
    p.then(f => live && setFailed(f));
    return () => {
      live = false;
    };
  }, [fire, file]);
  return failed;
}

/** The burned area, or null with `error` set once arrival.png has failed to load or decode. */
export function useBurnedArea(fire: FireData, span: [number, number]): {area: BurnedArea | null; error: boolean} {
  const raster = useRaster(fire, 'arrival.png');
  const failed = useImageFailed(fire, 'arrival.png');
  const byCode = useMemo(() => raster && areaByCode(raster), [raster]);
  const [w0, w1] = span;
  const area = useMemo(() => {
    if (!byCode) return null;
    const times: number[] = [];
    const acres: number[] = [];
    let total = 0;
    // 1–254 burn (254 = at or after the window's end); 255 never burns.
    for (let code = 1; code <= 254; code++) {
      if (!byCode.m2[code]) continue;
      total += byCode.m2[code] / M2_PER_ACRE;
      times.push(decodeArrival(code, w0, w1)!);
      acres.push(total);
    }
    return {times, acres, cellM: byCode.cellM, stepMs: (w1 - w0) / 253};
  }, [byCode, w0, w1]);
  return {area, error: area === null && failed};
}

/** Acres burned at or before `ms` (0 before the first arrival). */
export function acresAt(b: BurnedArea, ms: number): number {
  let lo = 0;
  let hi = b.times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b.times[mid] <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? 0 : b.acres[found];
}
