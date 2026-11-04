import {lonLatToEnu, pixelToGround, type CameraIntrinsics, type CameraPose, type GroundOptions} from '../../lib/dronegeo';
import type {PoseSource} from './livemap';
import type {SamFrame} from './sam';

/**
 * LIVE SAM 3.1 outlines on the map. /api/sam traces each SAM mask into pixel outlines
 * (api/_lib/samcodec.ts traceOutline); here each outline is simplified to at most MAX_VERTS vertices
 * and every vertex is ray-cast through the same camera model as the detector's hits (dronegeo.ts
 * pixelToGround) onto the DEM, giving a ground polygon per mask. Vertices whose rays miss the ground
 * (above the horizon, beyond range) are dropped; a polygon left with fewer than three is skipped.
 * Holes in a mask are not drawn: only its outer outlines are projected.
 */

/** Vertices kept per outline after simplification. */
export const MAX_VERTS = 64;
/** Starting simplification tolerance, pixels of the frame SAM saw. */
export const SIMPLIFY_PX = 1.5;
/** Kept mask polygons; older ones drop off first. */
export const MAX_MASKS = 300;

export type LiveMask = {
  id: number;
  /** Date.now() when the mask was placed. */
  tMs: number;
  /** performance.now() when the frame SAM saw was grabbed. */
  frameAt: number;
  /** performance.now() when the polygon was added to the store (set by the caller). */
  mappedAt?: number;
  /** Position in the video file of that frame, when known. */
  videoTimeS: number | null;
  /** SAM's object id within its response. */
  objectId: string;
  conf: number | null;
  /** Ground polygon, [lon, lat, elev], open (no repeated closing point). */
  ring: [number, number, number][];
  /** Ground area of the polygon, m² (planar, local ENU). */
  areaM2: number;
  /** Outline vertices after simplification, and how many of them missed the ground. */
  vertices: number;
  dropped: number;
  ground: 'dem' | 'flat' | 'mixed';
  pose: PoseSource;
  onMap: boolean;
  sourceName: string;
};

type Pt = [number, number];

/** Signed shoelace area of a flat [x0, y0, x1, y1, …] ring. */
export function signedArea(flat: number[]): number {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
  }
  return a / 2;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker on an open polyline; keeps both ends. */
function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > best) [best, at] = [d, k];
    }
    if (best > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * A closed ring (flat [x0, y0, …], no repeated closing point) simplified with Douglas–Peucker, split
 * at the vertex farthest from the first so the ring's extent survives. The tolerance starts at
 * `tolPx` and doubles until at most `maxVerts` vertices are left.
 */
export function simplifyRing(flat: number[], tolPx = SIMPLIFY_PX, maxVerts = MAX_VERTS): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length <= 3) return pts;
  let far = 0;
  let fd = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) [fd, far] = [d, k];
  }
  const a = pts.slice(0, far + 1);
  const b = pts.slice(far).concat([pts[0]]);
  for (let tol = tolPx; ; tol *= 2) {
    const out = dp(a, tol).concat(dp(b, tol).slice(1, -1));
    if (out.length <= maxVerts || tol > 1e6) return out;
  }
}

/** The outer loops of an outline: those wound like its largest loop (traceOutline winds holes the other way). */
export function outerLoops(polygons: number[][]): number[][] {
  const areas = polygons.map(signedArea);
  let big = 0;
  areas.forEach((a, i) => Math.abs(a) > Math.abs(areas[big]) && (big = i));
  const sign = Math.sign(areas[big] ?? 0);
  return polygons.filter((_, i) => sign !== 0 && Math.sign(areas[i]) === sign);
}

/**
 * One SAM response → ground polygons. `cam` is the camera at the size of the frame SAM saw (the
 * downscaled one its outlines are in), with the same field of view as the video.
 */
export function projectMasks(
  frame: Pick<SamFrame, 'outlines' | 'capturedAt'>,
  pose: CameraPose,
  cam: CameraIntrinsics,
  ground: GroundOptions,
  meta: {tMs: number; videoTimeS: number | null; pose: PoseSource; sourceName: string; nextId: () => number; onMap: (lon: number, lat: number) => boolean}
): LiveMask[] {
  const out: LiveMask[] = [];
  for (const o of frame.outlines) {
    for (const loop of outerLoops(o.polygons)) {
      const px = simplifyRing(loop);
      const ring: [number, number, number][] = [];
      const enu: Pt[] = [];
      const sources = new Set<'dem' | 'flat'>();
      for (const [u, v] of px) {
        const g = pixelToGround(pose, cam, u, v, ground);
        if (!g) continue;
        ring.push([g.lon, g.lat, g.elevM]);
        enu.push([g.east, g.north]);
        sources.add(g.source);
      }
      if (ring.length < 3) continue;
      const lon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      out.push({
        id: meta.nextId(),
        tMs: meta.tMs,
        frameAt: frame.capturedAt,
        videoTimeS: meta.videoTimeS,
        objectId: o.id,
        conf: o.conf,
        ring,
        areaM2: Math.abs(signedArea(enu.flat())),
        vertices: px.length,
        dropped: px.length - ring.length,
        ground: sources.size > 1 ? 'mixed' : sources.has('dem') ? 'dem' : 'flat',
        pose: meta.pose,
        onMap: meta.onMap(lon, lat),
        sourceName: meta.sourceName
      });
    }
  }
  return out;
}

/** A mask polygon in local ENU meters from (lon0, lat0). */
export function ringEnu(lon0: number, lat0: number, ring: [number, number, number][]): Pt[] {
  return ring.map(c => lonLatToEnu(lon0, lat0, c[0], c[1]));
}
