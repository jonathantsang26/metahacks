/**
 * SYNTHETIC test pattern for render path A. It is not fire data.
 *
 * Fills the official final perimeter with arrival times that grow with distance from a
 * point near its north edge. Because the burn is clipped to the real perimeter while the
 * perimeter outline is drawn separately from DEM samples, any UV flip or offset in the
 * shader shows up immediately as the two not lining up.
 *
 * Replaced by pipeline step 06's arrival.png (BUILD.md §3).
 */
import type {PerimeterCollection} from '../data/fire';
import {perimeterRings} from '../data/fire';

export function syntheticArrival(
  perimeter: PerimeterCollection,
  bounds: [number, number, number, number],
  width = 1024
): HTMLCanvasElement {
  const [w, s, e, n] = bounds;
  const height = Math.round((width * (n - s)) / (e - w) / Math.cos(((s + n) / 2) * (Math.PI / 180)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', {willReadFrequently: true})!;

  const toPx = ([lon, lat]: number[]): [number, number] => [
    ((lon - w) / (e - w)) * width,
    ((n - lat) / (n - s)) * height
  ];

  // Rasterize the perimeter as a mask (even-odd keeps holes unburned).
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  let minY = height;
  let sumX = 0;
  let count = 0;
  for (const ring of perimeterRings(perimeter)) {
    ring.forEach((pt, i) => {
      const [x, y] = toPx(pt);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      minY = Math.min(minY, y);
      sumX += x;
      count++;
    });
    ctx.closePath();
  }
  ctx.fill('evenodd');

  const mask = ctx.getImageData(0, 0, width, height);
  const out = ctx.createImageData(width, height);
  const ox = sumX / Math.max(count, 1);
  const oy = minY + height * 0.08;
  let maxD = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.data[(y * width + x) * 4] > 127) maxD = Math.max(maxD, Math.hypot(x - ox, (y - oy) * 0.8));
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const burned = mask.data[i] > 127;
      // Slight angular wobble so the front looks like a front, not a circle.
      const wobble = 1 + 0.08 * Math.sin(Math.atan2(y - oy, x - ox) * 5);
      const d = (Math.hypot(x - ox, (y - oy) * 0.8) / maxD) * wobble;
      const code = burned ? 1 + Math.round(Math.min(1, d * 0.85) * 253) : 255;
      out.data[i] = code;
      out.data[i + 1] = code;
      out.data[i + 2] = code;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}
