import {describe, expect, it} from 'vitest';
import {extractNumbers, extractTimes, scoreAnswer} from '../../scripts/eval-analyst.js';

const truth = Date.parse('2025-01-08T15:10:40Z');

describe('analyst eval scoring', () => {
  it('reads ISO and local PST times', () => {
    expect(extractTimes('First burn at 2025-01-08T15:10:40Z.')).toEqual([truth]);
    expect(extractTimes('at 7:10 AM PST on Wednesday, Jan 8')).toEqual([Date.parse('2025-01-08T15:10:00Z')]);
    expect(extractTimes('Jan 7, 2025, 11:00 PM PST')).toEqual([Date.parse('2025-01-08T07:00:00Z')]);
  });

  it('scores times within ±30 minutes', () => {
    expect(scoreAnswer({kind: 'time', ms: truth}, 'around 7:35 AM PST on Jan 8').pass).toBe(true);
    expect(scoreAnswer({kind: 'time', ms: truth}, 'around 7:45 AM PST on Jan 8').pass).toBe(false);
  });

  it('reads numbers but not dates or clock times', () => {
    expect(extractNumbers('By Jan 8, 2025 at 4:00 AM PST, 3,772.2 acres had burned.')).toEqual([3772.2]);
  });

  it('scores numbers within ±5%', () => {
    expect(scoreAnswer({kind: 'number', value: 45.9}, 'Gusts reached 47 mph.').pass).toBe(true);
    expect(scoreAnswer({kind: 'number', value: 45.9}, 'Gusts reached 49 mph.').pass).toBe(false);
  });
});
