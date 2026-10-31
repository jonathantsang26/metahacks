import assert from 'node:assert/strict';
import test from 'node:test';

import {arrivalFraction, arrivalMillis, burnReadout, sampleArrivalCode, type ArrivalGrid} from '../src/stage/arrival.ts';
import {formatElapsed} from '../src/lib/format.ts';

const HOUR = 3_600_000;
const START = Date.parse('2025-01-08T00:00:00Z');
const END = Date.parse('2025-01-13T00:00:00Z');

test('arrival codes 1–254 map onto the replay window and 255 never burns', () => {
  assert.equal(arrivalFraction(1), 0);
  assert.equal(arrivalFraction(254), 1);
  assert.equal(arrivalFraction(255), null);
  assert.equal(arrivalFraction(0), null);
  assert.equal(arrivalFraction(254.6), null);
  assert.equal(arrivalMillis(1, START, END), START);
  assert.equal(arrivalMillis(254, START, END), END);
  assert.equal(arrivalMillis(255, START, END), null);

  let prev = -1;
  for (let code = 1; code <= 254; code++) {
    const fraction = arrivalFraction(code);
    assert.ok(fraction !== null && fraction >= 0 && fraction <= 1);
    assert.ok(fraction > prev);
    prev = fraction;
  }
  // Code 128 is the shader's (128 − 1) / 253, not 128/255.
  assert.equal(arrivalFraction(128), 127 / 253);
});

test('nearest sample uses row 0 as north and rejects points outside the grid', () => {
  const grid: ArrivalGrid = {
    codes: new Uint8Array([
      10, 20, // north row
      30, 255 // south row
    ]),
    width: 2,
    height: 2,
    bounds: [-118, 34, -117, 35],
    simulated: true
  };
  // Northwest texel.
  assert.equal(sampleArrivalCode(grid, -117.75, 34.75), 10);
  // Northeast texel.
  assert.equal(sampleArrivalCode(grid, -117.25, 34.75), 20);
  // Southwest texel.
  assert.equal(sampleArrivalCode(grid, -117.75, 34.25), 30);
  // Southeast texel: never burned.
  assert.equal(sampleArrivalCode(grid, -117.25, 34.25), 255);
  // Corners stay inside their texel.
  assert.equal(sampleArrivalCode(grid, -118, 35), 10);
  assert.equal(sampleArrivalCode(grid, -117, 34), 255);
  assert.equal(sampleArrivalCode(grid, -118.01, 34.5), null);
  assert.equal(sampleArrivalCode(grid, -117.5, 35.01), null);
});

test('burn readout switches from future to burned as t crosses arrival', () => {
  const at = arrivalMillis(128, START, END)!;
  assert.deepEqual(burnReadout(255, START, START, END), {kind: 'never'});
  assert.deepEqual(burnReadout(128, at - 1, START, END), {kind: 'future', at});
  const burned = burnReadout(128, at + 2 * HOUR, START, END);
  assert.deepEqual(burned, {kind: 'burned', at, agoMs: 2 * HOUR});
});

test('elapsed time reads as hours and minutes', () => {
  assert.equal(formatElapsed(20_000), 'less than 1 min');
  assert.equal(formatElapsed(5 * 60_000), '5 min');
  assert.equal(formatElapsed((42 * 60 + 29) * 60_000), '42 h 29 min');
});
