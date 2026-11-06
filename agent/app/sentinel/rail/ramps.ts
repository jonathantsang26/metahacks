/**
 * CSS gradients built from the map shader's own color stops (stage/fire-extension.ts), so the rail's
 * legend and layer thumbnails cannot drift from what the terrain draws.
 */
import {POSTERIOR_RAMP, SCAR_RAMP} from '../stage/fire-extension';

type RGB = readonly [number, number, number];
const rgba = ([r, g, b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`;

/**
 * Ignition posterior legend: relative posterior p = 0 → 1, at the shader's alpha 0.25 + 0.65p, so
 * the faint low end reads as faint here too.
 */
export const POSTERIOR_LEGEND = `linear-gradient(90deg, ${rgba(POSTERIOR_RAMP[0], 0.25)}, ${rgba(
  POSTERIOR_RAMP[1],
  0.575
)} 50%, ${rgba(POSTERIOR_RAMP[2], 0.9)})`;

/** Layer thumbnail: highest posterior in the middle, as the heat sits around the estimate. */
export const POSTERIOR_THUMB = `radial-gradient(circle, ${rgba(POSTERIOR_RAMP[2])} 0 18%, ${rgba(
  POSTERIOR_RAMP[1]
)} 45%, ${rgba(POSTERIOR_RAMP[0])} 75%)`;

/** Layer thumbnail for the burn-scar wash, low → high dNBR. */
export const SCAR_THUMB = `linear-gradient(135deg, ${rgba(SCAR_RAMP[0])}, ${rgba(SCAR_RAMP[1])})`;
