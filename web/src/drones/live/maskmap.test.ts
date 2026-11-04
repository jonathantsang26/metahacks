import {beforeEach, describe, expect, it} from 'vitest';
import {lonLatToEnu, type CameraIntrinsics, type CameraPose, type DemSampler} from '../../lib/dronegeo';
import {nextHitId, useLiveHits} from './livemap';
import {MAX_MASKS, MAX_VERTS, outerLoops, projectMasks, ringEnu, signedArea, simplifyRing, type LiveMask} from './maskmap';
import type {SamOutline} from './sam';

// Synthetic poses, terrain and masks only: none of this is real flight data or a real SAM response.
const LON0 = -118.1;
const LAT0 = 34.2;
// The frame SAM sees: the live video downscaled to 640 px wide.
const W = 640;
const H = 360;
const cam: CameraIntrinsics = {hfovDeg: 90, width: W, height: H};
const F = W / 2; // focal length in px at hfov 90°
const flat = (z: number): DemSampler => () => z;
const meta = (onMap = true) => ({tMs: 1000, videoTimeS: null, pose: 'manual' as const, sourceName: 'synthetic', nextId: nextHitId, onMap: () => onMap});

/** A square mask's outline as traceOutline writes it: pixel corners, inside on the left (counter-clockwise on screen), with extra collinear points. */
function squareOutline(x1: number, y1: number, x2: number, y2: number): number[] {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [x1, y1, x1, my, x1, y2, mx, y2, x2, y2, x2, my, x2, y1, mx, y1];
}
const outline = (polygons: number[][], id = '0'): SamOutline => ({id, bounds: [0, 0, W, H], conf: 0.9, polygons});
const frame = (outlines: SamOutline[]) => ({outlines, capturedAt: 123});

/** Expect a projected ring to match `expected` ENU corners (any start, same cyclic order) within `tol` m. */
function expectRing(m: LiveMask, expected: [number, number][], tol: number) {
  const got = ringEnu(LON0, LAT0, m.ring);
  expect(got).toHaveLength(expected.length);
  const start = got.findIndex(p => Math.hypot(p[0] - expected[0][0], p[1] - expected[0][1]) < tol);
  expect(start).toBeGreaterThanOrEqual(0);
  expected.forEach((e, i) => {
    const p = got[(start + i) % got.length];
    expect(Math.hypot(p[0] - e[0], p[1] - e[1])).toBeLessThan(tol);
  });
}

describe('simplifyRing', () => {
  it('drops collinear points: a square outline comes back as its four corners', () => {
    const r = simplifyRing(squareOutline(10, 20, 110, 70));
    expect(r).toHaveLength(4);
    expect(new Set(r.map(p => p.join(',')))).toEqual(new Set(['10,20', '10,70', '110,70', '110,20']));
  });

  it('caps a dense staircase outline at MAX_VERTS and keeps its shape', () => {
    // A 100 px radius disc traced on whole pixels: ~800 staircase vertices.
    const ring: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = (-2 * Math.PI * i) / 2000;
      ring.push(Math.round(320 + 100 * Math.cos(a)), Math.round(180 + 100 * Math.sin(a)));
    }
    const r = simplifyRing(ring);
    expect(r.length).toBeLessThanOrEqual(MAX_VERTS);
    expect(r.length).toBeGreaterThanOrEqual(12);
    for (const [x, y] of r) expect(Math.abs(Math.hypot(x - 320, y - 180) - 100)).toBeLessThan(3);
    expect(Math.abs(signedArea(r.flat()))).toBeCloseTo(Math.PI * 100 * 100, -3);
  });
});

describe('outerLoops', () => {
  it('keeps the outer outline and drops a hole wound the other way', () => {
    const outer = squareOutline(0, 0, 50, 50);
    const hole = [20, 20, 30, 20, 30, 30, 20, 30]; // reversed winding
    expect(Math.sign(signedArea(outer))).toBe(-Math.sign(signedArea(hole)));
    expect(outerLoops([outer, hole])).toEqual([outer]);
    expect(outerLoops([hole, outer, squareOutline(60, 0, 70, 10)])).toEqual([outer, squareOutline(60, 0, 70, 10)]);
  });
});

describe('projectMasks', () => {
  it('nadir over flat ground: a square mask lands as the expected ground square', () => {
    // 100 m above flat ground at 500 m: 100 / F m per pixel, top of the frame toward the heading (north).
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 0, pitchDeg: -90};
    const [m] = projectMasks(frame([outline([squareOutline(220, 80, 420, 280)])]), pose, cam, {dem: flat(500)}, meta());
    const s = (100 / F) * 100; // 31.25 m
    expectRing(m, [[-s, s], [-s, -s], [s, -s], [s, s]], 0.05);
    expect(m.areaM2).toBeCloseTo((2 * s) ** 2, 0);
    expect(m.ring.every(c => Math.abs(c[2] - 500) < 1e-6)).toBe(true);
    expect(m).toMatchObject({vertices: 4, dropped: 0, ground: 'dem', frameAt: 123, objectId: '0', conf: 0.9, onMap: true, pose: 'manual'});
  });

  it('nadir, heading east: the same square is rotated onto the ground', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 90, pitchDeg: -90};
    // A mask in the top-right quarter of the frame: ahead (east) and to the right (south).
    const [m] = projectMasks(frame([outline([squareOutline(320, 80, 420, 180)])]), pose, cam, {dem: flat(500)}, meta());
    const s = (100 / F) * 100;
    // Heading east: the frame's top is east and its right is south.
    expectRing(m, [[s, 0], [0, 0], [0, -s], [s, -s]], 0.05);
  });

  it('nadir over a slope: each corner lands where its ray meets the tilted ground', () => {
    // Ground rises 0.2 m per m northward: z = 500 + 0.2 × north. Camera 700 m MSL, nadir, heading north.
    const slope: DemSampler = (lon, lat) => 500 + 0.2 * lonLatToEnu(LON0, LAT0, lon, lat)[1];
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 700, yawDeg: 0, pitchDeg: -90};
    const px: [number, number][] = [
      [220, 80],
      [220, 280],
      [420, 280],
      [420, 80]
    ];
    // Ray through (u, v): direction (xn, −yn, −1). Meets z = 500 + 0.2·north at t = 200 / (1 − 0.2·yn).
    const expected = px.map(([u, v]) => {
      const xn = (u - W / 2) / F;
      const yn = (v - H / 2) / F;
      const t = 200 / (1 - 0.2 * yn);
      return [xn * t, -yn * t] as [number, number];
    });
    const [m] = projectMasks(frame([outline([squareOutline(220, 80, 420, 280)])]), pose, cam, {dem: slope}, meta());
    expectRing(m, expected, 0.05);
    // The uphill (north) edge is nearer the camera, so the ground quad is a trapezoid, not a square.
    expect(expected[0][0]).not.toBeCloseTo(expected[1][0], 1);
    for (const c of m.ring) expect(c[2]).toBeCloseTo(500 + 0.2 * lonLatToEnu(LON0, LAT0, c[0], c[1])[1], 2);
  });

  it('oblique: vertices above the horizon are dropped, and a polygon left with < 3 points is skipped', () => {
    // Camera level with the horizon: the top half of the frame is sky.
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 0, pitchDeg: 0};
    const straddle = [300, 100, 300, 300, 320, 340, 340, 300, 340, 100]; // 2 of 5 above the horizon (v < 180)
    const [m] = projectMasks(frame([outline([straddle])]), pose, cam, {dem: flat(500)}, meta());
    expect(m.vertices).toBe(5);
    expect(m.dropped).toBe(2);
    expect(m.ring).toHaveLength(3);
    for (const [, n] of ringEnu(LON0, LAT0, m.ring)) expect(n).toBeGreaterThan(0); // all ahead of the drone
    // A mask whose bottom edge only is below the horizon: two points, skipped.
    expect(projectMasks(frame([outline([squareOutline(300, 100, 340, 200)])]), pose, cam, {dem: flat(500)}, meta())).toEqual([]);
    expect(projectMasks(frame([outline([squareOutline(300, 20, 340, 120)])]), pose, cam, {dem: flat(500)}, meta())).toEqual([]);
  });

  it('one ground polygon per outer loop, none for holes; onMap comes from the caller', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 0, pitchDeg: -90};
    const hole = [250, 150, 260, 150, 260, 160, 250, 160];
    const ms = projectMasks(
      frame([outline([squareOutline(220, 80, 300, 200), hole, squareOutline(400, 200, 440, 240)], '3'), outline([squareOutline(10, 10, 40, 40)], '4')]),
      pose,
      cam,
      {dem: flat(500)},
      meta(false)
    );
    expect(ms.map(m => m.objectId)).toEqual(['3', '3', '4']);
    expect(ms.every(m => m.ring.length === 4 && !m.onMap)).toBe(true);
  });
});

describe('mask store', () => {
  beforeEach(() => useLiveHits.getState().clear());
  it('keeps the newest MAX_MASKS and clears with the hits', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 0, pitchDeg: -90};
    const [m] = projectMasks(frame([outline([squareOutline(220, 80, 420, 280)])]), pose, cam, {dem: flat(500)}, meta());
    const s = useLiveHits.getState();
    s.addMasks([]);
    expect(useLiveHits.getState().masks).toHaveLength(0);
    s.addMasks(Array.from({length: MAX_MASKS + 7}, (_, i) => ({...m, id: i})));
    const masks = useLiveHits.getState().masks;
    expect(masks).toHaveLength(MAX_MASKS);
    expect(masks[0].id).toBe(7);
    s.clear();
    expect(useLiveHits.getState().masks).toHaveLength(0);
  });
});
