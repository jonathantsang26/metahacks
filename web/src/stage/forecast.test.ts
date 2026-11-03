import {describe, expect, it} from 'vitest';
import fixture from './__fixtures__/TEST-ONLY-forecast-fixture.json';
import {forecastTimes, leadLabel, parseIndex, pickEntry, pickForecast, type ForecastCollection, type IssuedForecast} from './forecast';

// Hand-made test fixture, not a forecast of any fire.
const files = fixture.files as unknown as Record<string, ForecastCollection>;
const issued: IssuedForecast[] = parseIndex(fixture.index).map(e => ({file: e.file, fc: files[e.file], ...forecastTimes(files[e.file])!}));
const at = (iso: string) => Date.parse(iso);

describe('forecast index', () => {
  it('reads a list of names, {files}, and entries with issue times', () => {
    expect(parseIndex(['a.geojson'])).toEqual([{file: 'a.geojson', issuedMs: null}]);
    expect(parseIndex({files: ['a.geojson', 'b.geojson']}).map(e => e.file)).toEqual(['a.geojson', 'b.geojson']);
    expect(parseIndex([{file: 'c.geojson', issued_utc: '2025-01-08T03:00:00Z'}])[0].issuedMs).toBe(at('2025-01-08T03:00:00Z'));
    expect(parseIndex({nope: 1})).toEqual([]);
    expect(parseIndex(null)).toEqual([]);
  });

  it('picks the entry to fetch: latest issued at or before t', () => {
    const e = parseIndex([
      {file: 'a', issued_utc: '2025-01-08T03:00:00Z'},
      {file: 'b', issued_utc: '2025-01-08T04:00:00Z'}
    ]);
    expect(pickEntry(e, at('2025-01-08T03:59:00Z'))?.file).toBe('a');
    expect(pickEntry(e, at('2025-01-08T04:00:00Z'))?.file).toBe('b');
    expect(pickEntry(e, at('2025-01-08T02:00:00Z'))).toBeNull();
  });
});

describe('forecast in force', () => {
  it('reads issue and valid times from the features', () => {
    expect(issued[0].issuedMs).toBe(at('2025-01-08T03:00:00Z'));
    expect(issued[0].validMs).toBe(at('2025-01-08T04:00:00Z'));
  });

  it('is the latest issued <= t', () => {
    expect(pickForecast(issued, at('2025-01-08T03:30:00Z'))?.file).toBe('TEST-issued-0300Z.geojson');
    expect(pickForecast(issued, at('2025-01-08T04:00:00Z'))?.file).toBe('TEST-issued-0400Z.geojson');
    expect(pickForecast(issued, at('2025-01-08T04:59:00Z'))?.file).toBe('TEST-issued-0400Z.geojson');
  });

  it('is none before the first issue or once the latest has expired', () => {
    expect(pickForecast(issued, at('2025-01-08T02:59:00Z'))).toBeNull();
    expect(pickForecast(issued, at('2025-01-08T05:01:00Z'))).toBeNull();
    expect(pickForecast([], at('2025-01-08T03:30:00Z'))).toBeNull();
  });

  it('labels the lead time', () => {
    expect(leadLabel(0, 3600_000)).toBe('+1 h');
    expect(leadLabel(0, 45 * 60_000)).toBe('+45 min');
    expect(leadLabel(0, 90 * 60_000)).toBe('+1.5 h');
  });
});
