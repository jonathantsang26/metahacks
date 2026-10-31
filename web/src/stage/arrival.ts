/**
 * Arrival-time encoding shared by the fire shader and the hover inspector.
 *
 * BUILD.md §3 / WORKSTREAMS.md §1: red channel 1–254 is
 * `(code − 1) / 253` of `aoi.window_utc`, and 255 means never burned.
 * Row 0 is north. This module does not change that file format; it only
 * reads an in-memory grid already built the same way.
 */

export type ArrivalGrid = {
  /** Red-channel codes, row-major, row 0 = north. */
  codes: Uint8Array;
  width: number;
  height: number;
  /** [west, south, east, north], the same bounds as dem.png. */
  bounds: [number, number, number, number];
  /** True for the synthetic shader test; false once a real arrival.png is sampled. */
  simulated: boolean;
};

export type BurnReadout =
  | {kind: 'never'}
  | {kind: 'future'; at: number}
  | {kind: 'burned'; at: number; agoMs: number};

/**
 * Fraction of the replay window for an arrival code.
 * Integer codes 1–254 match the shader (`(code − 1) / 253`).
 * 255, and anything the shader treats as never burned (`code >= 254.5`), is null.
 */
export function arrivalFraction(code: number): number | null {
  if (!Number.isFinite(code) || code >= 254.5 || code < 0.5) return null;
  const quantized = Math.min(254, Math.max(1, Math.round(code)));
  return (quantized - 1) / 253;
}

/** Absolute arrival time in epoch ms, or null when the cell never burns. */
export function arrivalMillis(code: number, start: number, end: number): number | null {
  const fraction = arrivalFraction(code);
  if (fraction === null || !(end > start)) return null;
  return start + fraction * (end - start);
}

/**
 * Nearest-texel sample. Texel (x, y) covers
 * `[x/width, (x+1)/width) × [y/height, (y+1)/height)`, which is the same
 * cell the shader reads when the arrival texture uses nearest filtering.
 * Returns null outside the grid.
 */
export function sampleArrivalCode(grid: ArrivalGrid, lon: number, lat: number): number | null {
  const [west, south, east, north] = grid.bounds;
  if (!(east > west) || !(north > south)) return null;
  if (lon < west || lon > east || lat < south || lat > north) return null;
  if (grid.width < 1 || grid.height < 1) return null;
  const u = (lon - west) / (east - west);
  const v = (north - lat) / (north - south);
  const x = Math.min(grid.width - 1, Math.floor(u * grid.width));
  const y = Math.min(grid.height - 1, Math.floor(v * grid.height));
  const code = grid.codes[y * grid.width + x];
  return code === undefined ? null : code;
}

/** Burn status of one cell at replay time `t` (epoch ms). */
export function burnReadout(code: number, t: number, start: number, end: number): BurnReadout {
  const at = arrivalMillis(code, start, end);
  if (at === null) return {kind: 'never'};
  if (t < at) return {kind: 'future', at};
  return {kind: 'burned', at, agoMs: t - at};
}
