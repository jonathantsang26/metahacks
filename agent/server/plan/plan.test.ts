import {describe, expect, it} from 'vitest';
import {fireStore} from '../fire/actions-support.js';
import {FireStore} from '../fire/data.js';
import {loadFront} from './front.js';
import {makeProj} from './geom.js';
import {burnedBetween, evenlySpaced, hindsightAt, shareInside} from './hindsight.js';
import {scoreGeometry, scorePlanAt} from './score.js';
import {gustLookup, GUST_LIMIT_MS} from './wind.js';

const proj = makeProj(-118, 34);
const ll = (x: number, y: number) => proj.toLonLat(x, y);
/** A straight 2 km front along y = 0. */
const front = [[ll(0, 0), ll(2000, 0)]];
const calm = () => 5;

describe('scoreGeometry (pure)', () => {
  it('measures the front and the covered part of it', () => {
    const [lon, lat] = ll(500, 0);
    const s = scoreGeometry({proj, front, drones: [{droneId: 'D1', lon, lat, radiusM: 400}], homes: [], gustAt: calm});
    expect(s.frontKm).toBeCloseTo(2, 2);
    expect(s.coveredKm).toBeCloseTo(0.8, 1);
    expect(s.frontCoveragePct).toBeCloseTo(40, 0);
    expect(s.groundedCount).toBe(0);
  });

  it('does not double count overlapping circles', () => {
    const [lon, lat] = ll(500, 0);
    const one = scoreGeometry({proj, front, drones: [{droneId: 'D1', lon, lat, radiusM: 400}], homes: [], gustAt: calm});
    const two = scoreGeometry({
      proj,
      front,
      drones: [
        {droneId: 'D1', lon, lat, radiusM: 400},
        {droneId: 'D2', lon, lat, radiusM: 400}
      ],
      homes: [],
      gustAt: calm
    });
    expect(two.coveredKm).toBe(one.coveredKm);
    expect(two.perDrone[0]!.uniqueFrontKm).toBe(0);
    expect(two.perDrone[0]!.frontKmInView).toBe(one.coveredKm);
  });

  it('grounds drones over the gust limit and drops their coverage', () => {
    const [lon, lat] = ll(500, 0);
    const s = scoreGeometry({proj, front, drones: [{droneId: 'D1', lon, lat, radiusM: 400}], homes: [ll(500, 100)], gustAt: () => GUST_LIMIT_MS + 0.1});
    expect(s.groundedCount).toBe(1);
    expect(s.coveredKm).toBe(0);
    expect(s.homesNearFront).toBe(1);
    expect(s.homesWatched).toBe(0);
    expect(s.gaps[0]!.flyable).toBe(false);
  });

  it('counts homes within 500 m of the front and those watched', () => {
    const [lon, lat] = ll(500, 0);
    const homes = [ll(500, 300), ll(1500, 300), ll(1000, 900)];
    const s = scoreGeometry({proj, front, drones: [{droneId: 'D1', lon, lat, radiusM: 400}], homes, gustAt: calm});
    expect(s.homesNearFront).toBe(2);
    expect(s.homesWatched).toBe(1);
  });

  it('scores coverage of the fast-moving front separately', () => {
    const fronts = [front[0]!, [ll(0, 3000), ll(1000, 3000)]];
    const [lon, lat] = ll(500, 3000);
    const s = scoreGeometry({proj, front: fronts, fastLines: [false, true], drones: [{droneId: 'D1', lon, lat, radiusM: 400}], homes: [], gustAt: calm});
    expect(s.fastFrontKm).toBeCloseTo(1, 2);
    expect(s.fastCoveragePct).toBeCloseTo(80, 0);
  });
});

describe('hindsight pieces (pure)', () => {
  it('spaces points evenly along the front', () => {
    const pts = evenlySpaced(proj, front, 4).map(p => proj.toXY(p.lon, p.lat));
    expect(pts.map(([x]) => Math.round(x))).toEqual([250, 750, 1250, 1750]);
  });
  it('counts cells inside circles', () => {
    const cells = [ll(0, 0), ll(1000, 0)].map(([lon, lat]) => ({lon, lat}));
    const [lon, lat] = ll(0, 0);
    expect(shareInside(proj, cells, [{lon, lat, radiusM: 100}])).toEqual({inside: 1, total: 2, pct: 50});
  });
});

const hasEaton = new FireStore('eaton').exists();

describe.skipIf(!hasEaton)('Eaton (real data)', () => {
  const store = () => fireStore('eaton');
  const at = (t: string) => Date.parse(t);

  it('20Z: Muse front, 8 flyable wind cells, plan beats the even-spacing baseline in hindsight', () => {
    const t = at('2025-01-08T20:00:00Z');
    const f = loadFront(store(), t)!;
    expect(f.method).toBe('muse');
    expect(f.frontKm).toBeCloseTo(27.9, 1);
    expect(gustLookup(store(), t).cells.filter(c => c.flyable)).toHaveLength(8);
    const drones = [
      [-118.11245, 34.19149],
      [-118.10499, 34.18744],
      [-118.09926, 34.18318],
      [-118.09151, 34.17892],
      [-118.1192, 34.194],
      [-118.0721, 34.1716]
    ].map(([lon, lat], i) => ({droneId: `D${i + 1}`, lon: lon!, lat: lat!, radiusM: 400}));
    const s = scorePlanAt(store(), t, drones);
    expect(s.groundedCount).toBe(0);
    expect(s.frontCoveragePct).toBeGreaterThan(15);
    expect(s.fastCoveragePct).toBeGreaterThan(s.frontCoveragePct);
    const h = hindsightAt(store(), t, drones);
    expect(h.burnedHa).toBeGreaterThan(100);
    expect(h.plan.flying).toBe(6);
    expect(h.plan.insidePct).toBeGreaterThanOrEqual(h.baseline.insidePct);
  });

  it('18Z: every wind cell is over the 12 m/s limit, so every drone is grounded', () => {
    const t = at('2025-01-08T18:00:00Z');
    expect(gustLookup(store(), t).cells.every(c => !c.flyable)).toBe(true);
    const s = scorePlanAt(store(), t, [{droneId: 'D1', lon: -118.10928, lat: 34.1885, radiusM: 400}]);
    expect(s.groundedCount).toBe(1);
    expect(s.coveredKm).toBe(0);
  });

  it('burned area in an hour comes from arrival codes in (t, t+1h]', () => {
    const r = store().arrival();
    const a = burnedBetween(r, at('2025-01-08T16:00:00Z'), at('2025-01-08T17:00:00Z'));
    const b = burnedBetween(r, at('2025-01-08T16:00:00Z'), at('2025-01-08T18:00:00Z'));
    expect(a.cells.length).toBeGreaterThan(0);
    expect(b.cells.length).toBeGreaterThan(a.cells.length);
  });

  it('16Z: hindsight of a plan on the flyable fast front beats the baseline', () => {
    const t = at('2025-01-08T16:00:00Z');
    const drones = [
      [-118.13702, 34.1976],
      [-118.12706, 34.19744],
      [-118.11898, 34.19513],
      [-118.0752, 34.19745]
    ].map(([lon, lat], i) => ({droneId: `D${i + 1}`, lon: lon!, lat: lat!, radiusM: 400}));
    const h = hindsightAt(store(), t, drones);
    expect(h.plan.insidePct).toBeGreaterThan(h.baseline.insidePct);
  });
});
