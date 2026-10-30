/**
 * Axis and sampling helpers for the dock charts. Every domain comes from the file being drawn;
 * nothing here knows a fire's numbers.
 */
import {useEffect, useRef, useState} from 'react';

const NICE = [1, 2, 2.5, 5, 10];

/** Round-number ticks covering [lo, hi] in at most `maxIntervals` steps. */
export function niceTicks(lo: number, hi: number, maxIntervals = 3): {lo: number; hi: number; step: number; ticks: number[]} {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / maxIntervals;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = mag * 10;
  for (const m of NICE) {
    const s = m * mag;
    if (Math.ceil(hi / s - 1e-9) - Math.floor(lo / s + 1e-9) <= maxIntervals) {
      step = s;
      break;
    }
  }
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  return {lo: a, hi: b, step, ticks};
}

/** Decimal places needed to write `step` exactly (0.25 → 2, 5 → 0). */
function decimals(step: number): number {
  let d = 0;
  while (d < 4 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d++;
  return d;
}

/** "12.5k", "800", "0.25": tick label at the precision the step needs; thousands as "k" when compact. */
export function tickLabel(v: number, step: number, compact = true): string {
  if (!compact && step >= 1) return Math.round(v).toLocaleString('en-US');
  if (Math.abs(v) >= 1000 && step >= 100) return `${Number((v / 1000).toFixed(decimals(step / 1000)))}k`;
  return String(Number(v.toFixed(decimals(step))));
}

/** Whole numbers with separators; one decimal below 10 ("6.5", "1,130"). */
export function formatValue(v: number): string {
  return Math.abs(v) < 10 && v !== Math.round(v)
    ? v.toFixed(1)
    : Math.round(v).toLocaleString('en-US');
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Rate of spread is spiky: one hour can be 30–50× the rest (a whole perimeter interval burns
 * at once in the arrival raster). When the peak is more than twice the 90th percentile of the
 * non-zero hours, the axis stops at twice that percentile. Returns that top and the peak.
 */
export function robustTop(values: number[]): {top: number; max: number} {
  const nonzero = values.filter(v => v > 0).sort((a, b) => a - b);
  const max = nonzero.length ? nonzero[nonzero.length - 1] : 0;
  if (!max) return {top: 1, max};
  return {top: Math.min(max, 2 * percentile(nonzero, 0.9)), max};
}

/**
 * Rate-of-spread axis top shared by the chart and the timeline's activity band. `capped` is
 * judged against the rounded top, so it is true exactly when some hour is drawn clipped.
 */
export function rosAxis(ros: number[]): {top: number; capped: boolean} {
  // The first sample covers the hour before the window opens, so it is not drawn.
  const {top, max} = robustTop(ros.slice(1));
  const hi = niceTicks(0, top, 3).hi;
  return {top: hi, capped: max > hi};
}

/**
 * arrival_meta.json (step 06), the part the dock reads: the window the arrival codes are relative
 * to and the perimeter-to-perimeter intervals.
 */
export type ArrivalIntervals = {window_utc?: [string, string]; intervals: {from: string; to: string; new_cells: number}[]};

/**
 * The arrival raster packs every cell between two mapped perimeters into the time between
 * them, so perimeters mapped minutes apart inflate the speed of the hour that holds them.
 * Returns the densest such interval overlapping (a, b]: under an hour long and filling cells
 * faster than the fire's average over all intervals (so a 1-cell sliver doesn't count).
 */
export function shortInterval(
  meta: ArrivalIntervals | null,
  a: number,
  b: number
): {minutes: number; cells: number} | null {
  const ivs = (meta?.intervals ?? []).map(iv => {
    const from = Date.parse(iv.from);
    const to = Date.parse(iv.to);
    return {from, to, minutes: (to - from) / 60_000, cells: iv.new_cells};
  });
  const total = ivs.reduce((s, iv) => s + iv.minutes, 0);
  const avgRate = total > 0 ? ivs.reduce((s, iv) => s + iv.cells, 0) / total : Infinity;
  let best: {minutes: number; cells: number; rate: number} | null = null;
  for (const iv of ivs) {
    const overlaps = iv.minutes === 0 ? iv.to > a && iv.to <= b : iv.from < b && iv.to > a;
    if (!(overlaps && iv.minutes >= 0 && iv.minutes < 60)) continue;
    const rate = iv.cells / Math.max(iv.minutes, 0.01);
    if (rate > avgRate && (!best || rate > best.rate)) best = {...iv, rate};
  }
  return best && {minutes: best.minutes, cells: best.cells};
}

/** "6 min", "<1 min". */
export function formatMinutes(m: number): string {
  return m < 1 ? '<1 min' : `${Math.round(m)} min`;
}

/** Linear interpolation of `values` sampled at sorted epoch-ms `times`, clamped at both ends. */
export function interpolate(times: number[], values: number[], ms: number): number | null {
  const n = times.length;
  if (!n) return null;
  if (ms <= times[0]) return values[0];
  if (ms >= times[n - 1]) return values[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const f = (ms - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + f * (values[hi] - values[lo]);
}

/** First index whose time is at or after `ms` (the hour in progress for an hour-ending series). */
export function indexAtOrAfter(times: number[], ms: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] >= ms) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}

/** Content-box size of an element, tracked with a ResizeObserver. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({width: 0, height: 0});
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({width: entry.contentRect.width, height: entry.contentRect.height})
    );
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
