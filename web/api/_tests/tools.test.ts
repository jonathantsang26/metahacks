import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {FireStore} from '../_lib/data.js';
import {createToolRunner} from '../_lib/tools.js';

// Runs against the real Eaton files in public/data/eaton (vitest runs from web/).
const store = new FireStore('eaton');
const aoi = JSON.parse(readFileSync('public/data/eaton/aoi.json', 'utf8')) as {window_utc: [string, string]};
const [W0, W1] = aoi.window_utc.map(Date.parse);
const ALTADENA: [number, number] = [-118.13166, 34.18986];

type Out = {result: Record<string, any>; cites: {id: string; layer: string; t?: string; label: string}[]; error?: string};

function call(name: string, args: unknown, runner = createToolRunner(store)): Out & {ok: boolean} {
  const out = runner.run(name, JSON.stringify(args));
  return {...(JSON.parse(out.content) as Out), ok: out.ok};
}

describe('place_lookup', () => {
  it('finds North Lake Avenue for "Lake Ave" and "Lake Avenue"', () => {
    for (const q of ['Lake Ave', 'Lake Avenue', 'lake ave.']) {
      const {result, cites} = call('place_lookup', {name: q});
      const lake = result.matches.find((m: {name: string}) => m.name === 'North Lake Avenue');
      expect(lake).toMatchObject({kind: 'street', match: 'exact'});
      expect(lake.lon).toBeGreaterThan(-118.14);
      expect(lake.lon).toBeLessThan(-118.12);
      expect(cites.length).toBe(result.matches.length);
      expect(result.matches.length).toBeLessThanOrEqual(5);
    }
  });

  it('ranks the exact directional name first', () => {
    const {result} = call('place_lookup', {name: 'North Lake Avenue'});
    expect(result.matches[0]).toMatchObject({name: 'North Lake Avenue', match: 'exact'});
  });

  it('searches labels too (peaks and places)', () => {
    const {result} = call('place_lookup', {name: 'Mount Wilson'});
    const kinds = result.matches.filter((m: {name: string}) => m.name === 'Mount Wilson').map((m: {kind: string}) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['peak', 'place']));
  });

  it('returns no matches, with a citable "no match" cite, for an unknown name', () => {
    const {result, cites} = call('place_lookup', {name: 'Nowhere Boulevard Xyz'});
    expect(result.matches).toEqual([]);
    expect(cites).toHaveLength(1);
  });
});

describe('arrival_at', () => {
  it('a point inside the final perimeter burned, at a time inside the window', () => {
    const {result, cites} = call('arrival_at', {lon: ALTADENA[0], lat: ALTADENA[1]});
    expect(result.burned).toBe(true);
    expect(result.inside_final_perimeter).toBe(true);
    const t = Date.parse(result.t);
    expect(t).toBeGreaterThanOrEqual(W0);
    expect(t).toBeLessThanOrEqual(W1);
    expect(result.t_local).toMatch(/P[SD]T$/);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(cites[0]).toMatchObject({layer: 'arrival', t: result.t});
  });

  it('a point well outside the perimeter did not burn; a point off the map is not covered', () => {
    const south = call('arrival_at', {lon: -118.1323, lat: 34.1445}).result;
    expect(south).toMatchObject({burned: false, inside_final_perimeter: false});
    expect(call('arrival_at', {lon: -120, lat: 36}).result.covered).toBe(false);
  });

  it('a point only the final perimeter covers gets an upper bound, not an arrival time', () => {
    // arrival.png green = 32 here: no timed perimeter covers this cell.
    const {result, cites} = call('arrival_at', {lon: -118.086531, lat: 34.235283});
    expect(result).toMatchObject({burned: true, arrival_time_known: false, inside_final_perimeter: true});
    expect(result.t).toBeUndefined();
    expect(result.burned_by_latest.t).toMatch(/Z$/);
    expect(cites[0].label).toMatch(/at the latest/);
  });

  it('rejects bad arguments without registering cites', () => {
    const runner = createToolRunner(store);
    const out = call('arrival_at', {lon: 'west'}, runner);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/lon/);
    expect(runner.registry.size).toBe(0);
  });
});

describe('street_fire_timeline', () => {
  it('returns first and last burn times for Lake Ave, which crosses the burn', () => {
    const {result, cites} = call('street_fire_timeline', {name: 'Lake Ave'});
    expect(result.found).toBe(true);
    expect(result.streets).toContain('North Lake Avenue');
    expect(result.n_points).toBeGreaterThan(50);
    expect(result.burned_fraction).toBeGreaterThan(0);
    expect(result.burned_fraction).toBeLessThan(1);
    const first = Date.parse(result.first_burn.t);
    const last = Date.parse(result.last_burn.t);
    expect(first).toBeGreaterThanOrEqual(W0);
    expect(last).toBeGreaterThanOrEqual(first);
    expect(last).toBeLessThanOrEqual(W1);
    expect(cites.find(c => c.label.startsWith('First burn'))?.t).toBe(result.first_burn.t);
  });

  it('agrees with arrival_at at the first-burn point', () => {
    const {result} = call('street_fire_timeline', {name: 'North Lake Avenue'});
    const at = call('arrival_at', {lon: result.first_burn.lon, lat: result.first_burn.lat}).result;
    expect(at.t).toBe(result.first_burn.t);
  });

  it('says the data does not show an unknown street', () => {
    const {result} = call('street_fire_timeline', {name: 'Imaginary Lane'});
    expect(result.found).toBe(false);
  });
});

describe('structures_near', () => {
  it('returns counts only: no ids, coordinates or address fields', () => {
    const {result, cites} = call('structures_near', {lon: ALTADENA[0], lat: ALTADENA[1], radius_m: 1000});
    expect(result.total).toBeGreaterThan(100);
    const sum = Object.values(result.by_damage as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.total);
    expect(Object.keys(result.construction)).toEqual(['roof', 'vents', 'eaves', 'window_pane']);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) keys.push(k), walk(x);
    };
    walk(result);
    for (const k of keys) expect(k).not.toMatch(/^(id|ids|address|addr|apn|parcel|owner|coordinates|geometry)$/i);
    // The only coordinates anywhere are the query center's.
    expect(JSON.stringify(result.construction)).not.toMatch(/-118\.\d{3}/);
    expect(cites).toHaveLength(1);
  });

  it('clamps the radius to 2000 m', () => {
    expect(call('structures_near', {lon: ALTADENA[0], lat: ALTADENA[1], radius_m: 50_000}).result.radius_m).toBe(2000);
  });
});

describe('time-keyed tools', () => {
  const weather = JSON.parse(readFileSync('public/data/eaton/weather.json', 'utf8')) as {hourly: {t: string; gust_mph: number}[]};
  const series = JSON.parse(readFileSync('public/data/eaton/series.json', 'utf8')) as {t: string[]; area_acres: number[]};

  it('weather_at picks the nearest hour and labels local time', () => {
    const h = weather.hourly.find(x => x.t === '2025-01-08T07:00:00Z')!;
    const {result} = call('weather_at', {t: '2025-01-08T07:20:00Z'});
    expect(result.t).toBe(h.t);
    expect(result.gust_mph).toBe(h.gust_mph);
    expect(result.t_local).toBe('Tue, Jan 7, 2025, 11:00 PM PST');
  });

  it('fire_state_at returns series area at the nearest hour', () => {
    const i = series.t.indexOf('2025-01-08T12:00:00Z');
    const {result} = call('fire_state_at', {t: '2025-01-08T11:45:00Z'});
    expect(result.t).toBe(series.t[i]);
    expect(result.area_acres).toBe(series.area_acres[i]);
  });

  it('reports times outside the data as not covered', () => {
    expect(call('fire_state_at', {t: '2024-06-01T00:00:00Z'}).result.covered).toBe(false);
    expect(call('weather_at', {t: 'yesterday'}).ok).toBe(false);
  });
});

describe('ignition_summary and exposure_stats', () => {
  it('labels the ignition estimate as a model estimate, not an investigated origin', () => {
    const {result, cites} = call('ignition_summary', {});
    expect(result.disclaimer).toMatch(/not an investigated origin/);
    expect(cites.some(c => c.layer === 'ignition')).toBe(true);
  });

  it('withholds the start time when the back-trace cannot identify it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'analyst-'));
    const dir = path.join(root, 'public', 'data', 'eaton');
    mkdirSync(dir, {recursive: true});
    copyFileSync('public/data/eaton/aoi.json', path.join(dir, 'aoi.json'));
    const ig = JSON.parse(readFileSync('public/data/eaton/ignition.json', 'utf8'));
    ig.timing = {identifiable: false, reasons: ['90% start-time interval is 30.0 h wide (limit 6 h)'], interval90_width_h: 30};
    writeFileSync(path.join(dir, 'ignition.json'), JSON.stringify(ig));
    const {result, cites} = call('ignition_summary', {}, createToolRunner(new FireStore('eaton', root)));
    expect(result.estimate.t).toBeUndefined();
    expect(result.estimate.start_time).toMatch(/not identifiable/);
    expect(JSON.stringify(result.estimate)).not.toContain(ig.map.t);
    expect(cites.find(c => c.layer === 'ignition')?.t).toBeUndefined();
  });

  it.runIf(store.has('exposure_stats.json'))('returns contrasts with the association caveat', () => {
    const {result} = call('exposure_stats', {feature: 'vent screens'});
    expect(result.contrasts[0].feature).toBe('vents');
    expect(typeof result.contrasts[0].odds_ratio).toBe('number');
    expect(result.how_to_read).toMatch(/association/i);
    expect(typeof result.caveat).toBe('string');
  });

  it('skips gracefully when events.json and exposure_stats.json are missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'analyst-'));
    mkdirSync(path.join(root, 'public', 'data', 'eaton'), {recursive: true});
    copyFileSync('public/data/eaton/aoi.json', path.join(root, 'public', 'data', 'eaton', 'aoi.json'));
    const runner = createToolRunner(new FireStore('eaton', root));
    for (const name of ['events', 'exposure_stats', 'ignition_summary']) {
      const out = call(name, {}, runner);
      expect(out.ok).toBe(true);
      expect(out.result.available).toBe(false);
      expect(out.cites.length).toBeGreaterThan(0);
    }
    // A required layer that is missing is an error the model sees, not a crash.
    expect(call('arrival_at', {lon: ALTADENA[0], lat: ALTADENA[1]}, runner).ok).toBe(false);
  });
});

describe('cite registry', () => {
  it('assigns sequential ids across calls and registers every cite', () => {
    const runner = createToolRunner(store);
    const a = call('place_lookup', {name: 'Lake Ave'}, runner).cites;
    const b = call('weather_at', {t: '2025-01-08T07:00:00Z'}, runner).cites;
    const ids = [...a, ...b].map(c => c.id);
    expect(ids).toEqual(ids.map((_, i) => `c${i + 1}`));
    expect([...runner.registry.keys()]).toEqual(ids);
  });

  it('rejects an invalid fire id before touching the filesystem', () => {
    expect(() => new FireStore('../secrets')).toThrow(/invalid fire id/);
  });
});
