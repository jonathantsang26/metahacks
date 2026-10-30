/**
 * Vectors sit on the terrain by sampling the CPU heightmap once per dataset; layers then reuse
 * the draped arrays so nothing is re-sampled per frame.
 */
import type {Dem} from './dem';

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};

const M_PER_DEG = 111_320;

/** Every ring (outer and holes) of a Polygon or MultiPolygon. */
export function ringsOf(g: Polygonal): number[][][] {
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
}

/** [lon, lat] vertices lifted to `lift` meters above the terrain. */
export function drape(dem: Dem, coords: number[][], lift: number): number[][] {
  return coords.map(([lon, lat]) => [lon, lat, dem.heightAt(lon, lat) + lift]);
}

/** Like drape, but splits segments longer than `stepM` so long lines follow ridges and valleys. */
export function drapeDense(dem: Dem, coords: number[][], lift: number, stepM: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (i > 0) {
      const [lon0, lat0] = coords[i - 1];
      const n = Math.ceil(distanceM(lon0, lat0, lon, lat) / stepM);
      for (let k = 1; k < n; k++) {
        const x = lon0 + ((lon - lon0) * k) / n;
        const y = lat0 + ((lat - lat0) * k) / n;
        out.push([x, y, dem.heightAt(x, y) + lift]);
      }
    }
    out.push([lon, lat, dem.heightAt(lon, lat) + lift]);
  }
  return out;
}

/** Runs of consecutive vertices over the terrain, so a line leaving the mesh is not drawn in the air. */
export function insideRuns(dem: Dem, path: number[][]): number[][][] {
  const runs: number[][][] = [];
  let run: number[][] = [];
  for (const p of path) {
    if (dem.contains(p[0], p[1])) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  // A closed ring that crosses its own seam inside the terrain: the last run continues into the first.
  const [first, last] = [path[0], path[path.length - 1]];
  const closed = Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
  if (runs.length > 1 && closed && dem.contains(first[0], first[1]))
    runs[0] = [...runs.pop()!, ...runs[0].slice(1)];
  return runs.filter(r => r.length > 1);
}

/** The part of `ring` inside the box [x0, y0, x1, y1] (Sutherland-Hodgman, one box side at a time). */
function clipRing(ring: number[][], [x0, y0, x1, y1]: number[]): number[][] {
  const [a0, an] = [ring[0], ring[ring.length - 1]];
  let pts = a0[0] === an[0] && a0[1] === an[1] ? ring.slice(0, -1) : ring;
  const sides: [number, number, number][] = [
    [0, x0, 1],
    [0, x1, -1],
    [1, y0, 1],
    [1, y1, -1]
  ];
  for (const [axis, bound, dir] of sides) {
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const inA = (a[axis] - bound) * dir >= 0;
      const inB = (b[axis] - bound) * dir >= 0;
      if (inA !== inB) {
        const f = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      }
      if (inB) out.push(b);
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}

/** Planar area of a ring in squared degrees; only for comparing shapes at one place. */
export function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(sum / 2);
}

/**
 * A polygon (outer ring, then holes) cut into pieces no larger than a grid square of about
 * `stepM` meters, each vertex lifted `lift` meters above the terrain. PolygonLayer triangulates
 * flat, so an uncut polygon spans its interior with long triangles that sink under ridges and
 * float over valleys; small pieces follow the ground. The grid is anchored on the terrain's
 * corner, so neighbouring polygons share its lines, and nothing outside the terrain is kept.
 */
export function drapeFill(dem: Dem, polygon: number[][][], lift: number, stepM: number): number[][][][] {
  const [w, s, e, n] = dem.meta.bounds;
  const dy = stepM / M_PER_DEG;
  const dx = stepM / (M_PER_DEG * Math.cos((((s + n) / 2) * Math.PI) / 180));
  let [x0, y0, x1, y1] = [e, n, w, s];
  for (const [x, y] of polygon[0]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const minArea = dx * dy * 1e-6;
  const pieces: number[][][][] = [];
  for (let c = Math.floor((Math.max(x0, w) - w) / dx); w + c * dx < Math.min(x1, e); c++) {
    for (let r = Math.floor((Math.max(y0, s) - s) / dy); s + r * dy < Math.min(y1, n); r++) {
      const box = [w + c * dx, s + r * dy, Math.min(e, w + (c + 1) * dx), Math.min(n, s + (r + 1) * dy)];
      const outer = clipRing(polygon[0], box);
      if (outer.length < 3 || ringArea(outer) < minArea) continue;
      const holes = polygon
        .slice(1)
        .map(h => clipRing(h, box))
        .filter(h => h.length >= 3 && ringArea(h) >= minArea);
      // A square wholly inside a hole leaves nothing to fill.
      if (ringArea(outer) - holes.reduce((sum, h) => sum + ringArea(h), 0) < minArea) continue;
      pieces.push([outer, ...holes].map(ring => drape(dem, ring, lift)));
    }
  }
  return pieces;
}

/** Equirectangular distance in meters; fine at fire scale. */
export function distanceM(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const kx = M_PER_DEG * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  return Math.hypot((lon1 - lon0) * kx, (lat1 - lat0) * M_PER_DEG);
}

/** Moves (lon, lat) by east/north meters. */
export function offsetM(lon: number, lat: number, east: number, north: number): [number, number] {
  return [lon + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + north / M_PER_DEG];
}
