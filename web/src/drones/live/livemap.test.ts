import {beforeEach, describe, expect, it} from 'vitest';
import {parseDjiSrt} from '../../lib/dji-srt';
import {distanceM} from '../../stage/drape';
import {convexHull, fadeAlpha, FADE_MIN, fireEdgeNow, MAX_HITS, nextHitId, projectDets, resolvePose, useLiveHits, type LiveHit, type ManualPose} from './livemap';
import type {Det} from './decode';

// Synthetic poses, terrain and boxes only: none of this is real flight data.
const LON0 = -118.1;
const LAT0 = 34.2;
const flat = (z: number) => () => z;
const W = 1280;
const H = 720;
const cam = {hfovDeg: 90, width: W, height: H};
const manual: ManualPose = {lat: LAT0, lon: LON0, altAglM: 100, headingDeg: 0, pitchDeg: -90, hfovDeg: 90};
const meta = (onMap = true) => ({tMs: 1000, videoTimeS: null, pose: 'manual' as const, sourceName: 'synthetic', nextId: nextHitId, onMap: () => onMap});

describe('pose', () => {
  it('manual: altitude AGL sits on the DEM under the drone', () => {
    const r = resolvePose('manual', manual, null, null, flat(500));
    if ('error' in r) throw new Error(r.error);
    expect(r.pose.altMslM).toBe(600);
    expect(r.ground.dem).toBeDefined();
  });

  it('manual off the DEM: flat ground at 0 m and the AGL height', () => {
    const r = resolvePose('manual', manual, null, null, () => null);
    if ('error' in r) throw new Error(r.error);
    expect(r.pose.altMslM).toBe(100);
    expect(r.ground.flatElevM).toBe(0);
  });

  it('manual: rejects a missing or bad pose', () => {
    expect('error' in resolvePose('manual', null, null, null, flat(0))).toBe(true);
    expect('error' in resolvePose('manual', {...manual, altAglM: -5}, null, null, flat(0))).toBe(true);
    expect('error' in resolvePose('manual', {...manual, lat: NaN}, null, null, flat(0))).toBe(true);
  });

  it('SRT: interpolates the track at the video time and falls back to the form for heading and pitch', () => {
    const srt = parseDjiSrt(
      [
        '1\n00:00:00,000 --> 00:00:01,000\n[latitude: 34.2] [longitude: -118.1] [rel_alt: 50.0 abs_alt: 999]\n',
        '2\n00:00:01,000 --> 00:00:02,000\n[latitude: 34.201] [longitude: -118.1] [rel_alt: 70.0 abs_alt: 999]\n'
      ].join('\n')
    );
    expect(srt.frames.length).toBe(2);
    const r = resolvePose('srt', {...manual, headingDeg: 45, pitchDeg: -30}, srt, 0.5, flat(300));
    if ('error' in r) throw new Error(r.error);
    expect(r.pose.yawDeg).toBe(45);
    expect(r.pose.pitchDeg).toBe(-30);
    // rel_alt over the DEM at the first block (no HOME recorded).
    expect(r.pose.altMslM).toBeGreaterThanOrEqual(350);
    expect(r.pose.altMslM).toBeLessThanOrEqual(370);
    expect('error' in resolvePose('srt', manual, srt, null, flat(300))).toBe(true);
    expect('error' in resolvePose('srt', manual, null, 0.5, flat(300))).toBe(true);
  });
});

describe('projectDets', () => {
  const nadir = {lat: LAT0, lon: LON0, altMslM: 600, yawDeg: 0, pitchDeg: -90};

  it('nadir camera: a centred box lands under the drone, its corners around it', () => {
    const det: Det = {box: [W / 2 - 20, H / 2 - 20, W / 2 + 20, H / 2 + 20], cls: 0, score: 0.8};
    const [h] = projectDets([det], ['fire'], nadir, cam, {dem: flat(500)}, meta());
    expect(distanceM(h.lon, h.lat, LON0, LAT0)).toBeLessThan(0.5);
    expect(h.cls).toBe('fire');
    expect(h.conf).toBe(0.8);
    expect(h.corners.length).toBe(4);
    // 40 px of a 1280 px, 90° frame at 100 m: about 6.25 m across.
    const across = distanceM(h.corners[0][0], h.corners[0][1], h.corners[1][0], h.corners[1][1]);
    expect(across).toBeGreaterThan(5.5);
    expect(across).toBeLessThan(7);
    expect(h.pose).toBe('manual');
    expect(h.radiusM).toBeGreaterThan(0);
  });

  it('heading east, looking down 45°: the hit is about 100 m east', () => {
    const pose = {lat: LAT0, lon: LON0, altMslM: 600, yawDeg: 90, pitchDeg: -45};
    const det: Det = {box: [W / 2 - 10, H / 2 - 30, W / 2 + 10, H / 2], cls: 0, score: 0.5};
    const [h] = projectDets([det], ['fire'], pose, cam, {dem: flat(500)}, meta());
    // Bottom-centre anchor on the frame's centre row.
    expect(h.lon).toBeGreaterThan(LON0);
    expect(Math.abs(distanceM(h.lon, h.lat, LON0, LAT0) - 100)).toBeLessThan(2);
  });

  it('drops boxes above the horizon and keeps only corners that reach the ground', () => {
    const level = {lat: LAT0, lon: LON0, altMslM: 600, yawDeg: 0, pitchDeg: 0};
    const sky: Det = {box: [600, 0, 680, 100], cls: 0, score: 0.5};
    expect(projectDets([sky], ['fire'], level, cam, {dem: flat(500)}, meta())).toEqual([]);
    const straddle: Det = {box: [600, 300, 680, 600], cls: 0, score: 0.5};
    const [h] = projectDets([straddle], ['fire'], level, cam, {dem: flat(500)}, meta());
    expect(h.corners.length).toBe(2);
  });

  it('flags hits outside the map', () => {
    const det: Det = {box: [600, 340, 680, 380], cls: 0, score: 0.5};
    const [h] = projectDets([det], ['fire'], nadir, cam, {dem: flat(500)}, meta(false));
    expect(h.onMap).toBe(false);
  });
});

const hit = (lon: number, lat: number, tMs: number, onMap = true): LiveHit => ({
  id: nextHitId(),
  tMs,
  videoTimeS: null,
  lon,
  lat,
  elevM: 0,
  conf: 0.5,
  cls: 'fire',
  corners: [],
  radiusM: 10,
  ground: 'dem',
  pose: 'manual',
  onMap,
  sourceName: 'synthetic'
});

describe('hull and fade', () => {
  it('convex hull drops interior and collinear points', () => {
    const h = convexHull([
      [0, 0],
      [2, 0],
      [1, 0],
      [2, 2],
      [0, 2],
      [1, 1],
      [0, 0]
    ]);
    expect(h).toHaveLength(4);
    expect(h).toEqual(
      expect.arrayContaining([
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2]
      ])
    );
    expect(
      convexHull([
        [0, 0],
        [1, 1]
      ])
    ).toHaveLength(2);
  });

  it('fire edge now: hull of recent on-map hits only, closed', () => {
    const d = 0.001;
    const hits = [
      hit(LON0, LAT0, 9000),
      hit(LON0 + d, LAT0, 9500),
      hit(LON0 + d, LAT0 + d, 9800),
      hit(LON0, LAT0 + d, 9900),
      hit(LON0 + d / 2, LAT0 + d / 2, 9950),
      // Too old, and off the map: both left out.
      hit(LON0 + 0.05, LAT0, 0),
      hit(LON0 - 0.05, LAT0, 9990, false)
    ];
    const ring = fireEdgeNow(hits, 10_000, 5000)!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThanOrEqual(LON0 - 1e-9);
      expect(lon).toBeLessThanOrEqual(LON0 + d + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(LAT0 - 1e-9);
      expect(lat).toBeLessThanOrEqual(LAT0 + d + 1e-9);
    }
    expect(fireEdgeNow(hits.slice(0, 2), 10_000, 5000)).toBeNull();
    expect(fireEdgeNow(hits, 100_000, 5000)).toBeNull();
  });

  it('fade: 1 when new, falling linearly to the floor', () => {
    expect(fadeAlpha(0)).toBe(1);
    expect(fadeAlpha(50, 100, 0.2)).toBeCloseTo(0.6);
    expect(fadeAlpha(1e9)).toBe(FADE_MIN);
  });
});

describe('store', () => {
  beforeEach(() => useLiveHits.getState().clear());

  it('accumulates, caps at MAX_HITS keeping the newest, and clears', () => {
    const s = useLiveHits.getState();
    s.add([hit(LON0, LAT0, 1)]);
    s.add([]);
    expect(useLiveHits.getState().hits).toHaveLength(1);
    s.add(Array.from({length: MAX_HITS + 5}, (_, i) => hit(LON0, LAT0, i + 2)));
    const hits = useLiveHits.getState().hits;
    expect(hits).toHaveLength(MAX_HITS);
    expect(hits[hits.length - 1].tMs).toBe(MAX_HITS + 6);
    s.clear();
    expect(useLiveHits.getState().hits).toHaveLength(0);
  });
});
