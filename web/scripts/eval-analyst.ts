/**
 * Analyst eval (BUILD.md step 15): 15 questions whose answers are computed here, directly from
 * public/data/eaton, by code independent of the analyst's tools. Each question then goes through
 * the real analyst (the same runAnalyst + Muse Spark client as POST /api/analyst) and is scored:
 * times within ±30 min, numbers within ±5%, plus the citation validity rate.
 *
 *   npm run eval:analyst            needs MODEL_API_KEY; writes public/data/eaton/eval/analyst.json
 *   npm run eval:analyst -- --truth prints the computed ground truth only (no key, writes nothing)
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';
import {DEFAULT_MODEL, runAnalyst} from '../api/_lib/analyst.js';
import {FireStore} from '../api/_lib/data.js';
import {createChatClient} from '../api/_lib/model.js';
import type {AnalystResponse} from '../api/_lib/types.js';
import {modelApiKey, NO_KEY_MESSAGE, WEB_ROOT} from './_env.js';

const FIRE = 'eaton';
const DIR = path.join(WEB_ROOT, 'public', 'data', FIRE);
const TIME_TOL_MIN = 30;
const NUM_TOL = 0.05;

const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T;
const has = (file: string) => existsSync(path.join(DIR, file));

// ---------------------------------------------------------------- ground truth (independent code)

type Truth = {kind: 'time'; ms: number} | {kind: 'number'; value: number};
type Question = {id: string; question: string; truth: Truth; source: string};

/** Arrival raster in the pipeline's own convention (ember/grid.py: cell centers at integer px). */
function arrivalGrid() {
  const png = PNG.sync.read(readFileSync(path.join(DIR, 'arrival.png')));
  const [w, s, e, n] = read<{bounds: number[]}>('dem.json').bounds;
  const [t0, t1] = read<{window_utc: string[]}>('aoi.json').window_utc.map(Date.parse);
  const cell = (lon: number, lat: number) => {
    const col = Math.round(((lon - w) / (e - w)) * png.width - 0.5);
    const row = Math.round(((n - lat) / (n - s)) * png.height - 0.5);
    return col >= 0 && row >= 0 && col < png.width && row < png.height ? row * png.width + col : -1;
  };
  const code = (idx: number) => png.data[idx * 4];
  const hours = (c: number) => (c >= 1 && c <= 254 ? t0 + ((c - 1) / 253) * (t1 - t0) : null);
  return {cell, code, hours};
}

/** Earliest arrival over every raster cell the named street passes through (5 m walk). */
function streetFirstBurn(displayName: string): number | null {
  const g = arrivalGrid();
  const roads = read<{features: {geometry: {coordinates: number[][]}; properties: {name: string | null}}[]}>('roads.geojson');
  const cells = new Set<number>();
  for (const f of roads.features) {
    if (f.properties.name !== displayName) continue;
    const c = f.geometry.coordinates;
    for (let i = 0; i + 1 < c.length; i++) {
      const [x0, y0] = c[i];
      const [x1, y1] = c[i + 1];
      const lenM = Math.hypot((x1 - x0) * 92_000, (y1 - y0) * 111_000);
      const steps = Math.max(1, Math.ceil(lenM / 5));
      for (let k = 0; k <= steps; k++) {
        const idx = g.cell(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
        if (idx >= 0) cells.add(idx);
      }
    }
  }
  let best: number | null = null;
  for (const idx of cells) {
    const h = g.hours(g.code(idx));
    if (h !== null && (best === null || h < best)) best = h;
  }
  return best;
}

function arrivalAtPoint(lon: number, lat: number): number | null {
  const g = arrivalGrid();
  const idx = g.cell(lon, lat);
  return idx < 0 ? null : g.hours(g.code(idx));
}

function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

function destroyedWithin(lon: number, lat: number, radiusM: number): number {
  const s = read<{features: {geometry: {coordinates: number[]}; properties: {damage: string}}[]}>('structures.geojson');
  return s.features.filter(f => f.properties.damage === 'Destroyed' && haversineM(lon, lat, f.geometry.coordinates[0], f.geometry.coordinates[1]) <= radiusM).length;
}

function label(name: string, kind: string): {lon: number; lat: number} {
  const l = read<{name: string; kind: string; lon: number; lat: number}[]>('labels.json').find(x => x.name === name && x.kind === kind);
  if (!l) throw new Error(`labels.json has no ${kind} "${name}"`);
  return l;
}

function seriesAt(iso: string, key: 'area_acres' | 'ros_chains_hr'): number {
  const s = read<{t: string[]; area_acres: number[]; ros_chains_hr: number[]}>('series.json');
  const i = s.t.indexOf(iso);
  if (i < 0) throw new Error(`series.json has no hour ${iso}`);
  return s[key][i];
}

function weatherAt(iso: string, key: 'gust_mph' | 'rh_pct' | 'wind_mph'): number {
  const h = read<{hourly: Record<string, number | string>[]}>('weather.json').hourly.find(x => x.t === iso);
  if (!h) throw new Error(`weather.json has no hour ${iso}`);
  return Number(h[key]);
}

const T = ' Give the time in UTC (ISO 8601).';
const N = ' Give the number.';

function buildQuestions(): {questions: Question[]; skipped: {id: string; reason: string}[]} {
  const qs: Question[] = [];
  const skipped: {id: string; reason: string}[] = [];
  const add = (id: string, question: string, source: string, compute: () => Truth | null) => {
    try {
      const truth = compute();
      if (truth) qs.push({id, question, truth, source});
      else skipped.push({id, reason: 'no ground truth in the data'});
    } catch (e) {
      skipped.push({id, reason: (e as Error).message});
    }
  };
  const time = (ms: number | null): Truth | null => (ms === null ? null : {kind: 'time', ms});
  const value = (v: number): Truth => ({kind: 'number', value: v});

  for (const [i, street] of ['North Lake Avenue', 'East Altadena Drive', 'Kinneloa Canyon Road', 'Fair Oaks Avenue'].entries()) {
    add(`street_${i + 1}`, `When did the fire first reach ${street}?${T}`, 'roads.geojson × arrival.png', () => time(streetFirstBurn(street)));
  }
  for (const [i, place] of ['Altadena', 'Kinneloa Mesa'].entries()) {
    add(`place_${i + 1}`, `When did the fire reach ${place} (the neighborhood label point)?${T}`, 'labels.json × arrival.png', () => {
      const p = label(place, 'place');
      return time(arrivalAtPoint(p.lon, p.lat));
    });
  }
  add('area_1', `How many acres had burned by 2025-01-08T12:00:00Z?${N}`, 'series.json', () => value(seriesAt('2025-01-08T12:00:00Z', 'area_acres')));
  add('area_2', `How many acres had burned by 2025-01-09T00:00:00Z?${N}`, 'series.json', () => value(seriesAt('2025-01-09T00:00:00Z', 'area_acres')));
  add('ros_1', `What was the head rate of spread, in chains per hour, at 2025-01-08T08:00:00Z?${N}`, 'series.json', () =>
    value(seriesAt('2025-01-08T08:00:00Z', 'ros_chains_hr'))
  );
  add('gust_1', `What was the wind gust in mph at 2025-01-08T07:00:00Z?${N}`, 'weather.json', () => value(weatherAt('2025-01-08T07:00:00Z', 'gust_mph')));
  add('rh_1', `What was the relative humidity in percent at 2025-01-09T22:00:00Z?${N}`, 'weather.json', () => value(weatherAt('2025-01-09T22:00:00Z', 'rh_pct')));
  add('structures_1', `How many inspected structures within 1000 m of the Altadena place label were destroyed?${N}`, 'structures.geojson', () => {
    const p = label('Altadena', 'place');
    return value(destroyedWithin(p.lon, p.lat, 1000));
  });
  add('structures_2', `How many inspected structures within 1000 m of the Echo Mountain peak were destroyed?${N}`, 'structures.geojson', () => {
    const p = label('Echo Mountain', 'peak');
    return value(destroyedWithin(p.lon, p.lat, 1000));
  });
  add('ignition_1', `When does the model ignition estimate put the start of the fire?${T}`, 'ignition.json', () => time(Date.parse(read<{map: {t: string}}>('ignition.json').map.t)));
  add('exposure_1', `What is the odds ratio of destruction for fine-mesh or no vents versus coarse or unscreened vents?${N}`, 'exposure_stats.json', () => {
    if (!has('exposure_stats.json')) return null;
    const c = read<{contrasts: {feature: string; or: number | null}[]}>('exposure_stats.json').contrasts.find(x => x.feature === 'vents');
    return c?.or != null ? value(c.or) : null;
  });
  return {questions: qs, skipped};
}

// ---------------------------------------------------------------- scoring

const MONTHS: Record<string, number> = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};
const ISO = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(?:Z|UTC)?/g;
const LOCAL_A = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*(pst|pdt)?/gi;
const LOCAL_B = /\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*(pst|pdt)?,?\s+(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/gi;

function localMs(year: number, month: number, day: number, h12: number, min: number, ap: string, zone: string | undefined): number {
  const h = (h12 % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  const offset = zone?.toLowerCase() === 'pdt' ? 7 : 8;
  return Date.UTC(year, month, day, h + offset, min);
}

export function extractTimes(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(ISO)) out.push(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  for (const m of text.matchAll(LOCAL_A)) out.push(localMs(+(m[3] ?? 2025), MONTHS[m[1].toLowerCase()], +m[2], +m[4], +m[5], m[6], m[7]));
  for (const m of text.matchAll(LOCAL_B)) out.push(localMs(2025, MONTHS[m[5].toLowerCase()], +m[6], +m[1], +m[2], m[3], m[4]));
  return out;
}

export function extractNumbers(text: string): number[] {
  const stripped = text
    .replace(ISO, ' ')
    .replace(LOCAL_A, ' ')
    .replace(LOCAL_B, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?/gi, ' ');
  return [...stripped.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

export function scoreAnswer(truth: Truth, text: string): {pass: boolean; extracted: number[]} {
  if (truth.kind === 'time') {
    const times = extractTimes(text);
    return {pass: times.some(ms => Math.abs(ms - truth.ms) <= TIME_TOL_MIN * 60_000), extracted: times};
  }
  const nums = extractNumbers(text);
  const tol = Math.abs(truth.value) * NUM_TOL;
  return {pass: nums.some(v => Math.abs(v - truth.value) <= tol), extracted: nums};
}

type Row = {id: string; kind: Truth['kind']; pass: boolean} & Record<string, unknown>;

const showTruth = (t: Truth) => (t.kind === 'time' ? new Date(Math.round(t.ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z') : t.value);

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const {questions, skipped} = buildQuestions();
  if (process.argv.includes('--truth')) {
    for (const q of questions) console.log(`${q.id.padEnd(13)} ${String(showTruth(q.truth)).padEnd(22)} ${q.question}`);
    for (const s of skipped) console.log(`${s.id.padEnd(13)} SKIPPED: ${s.reason}`);
    return;
  }
  const key = modelApiKey();
  if (!key) {
    console.error(`${NO_KEY_MESSAGE}\nNo eval was run and eval/analyst.json was not written. (--truth prints the ground truth without a key.)`);
    process.exit(2);
  }
  const chat = createChatClient(key);
  const store = new FireStore(FIRE, WEB_ROOT);
  const rows: Row[] = [];
  let proposed = 0;
  let invalid = 0;
  for (const q of questions) {
    process.stdout.write(`${q.id} ... `);
    let response: AnalystResponse | null = null;
    let error: string | null = null;
    try {
      const run = await runAnalyst({question: q.question, fire: FIRE, history: [], mode: 'answer'}, {chat, store, model: DEFAULT_MODEL});
      response = run.response;
      proposed += run.audit.proposed_cite_ids;
      invalid += run.audit.invalid_cite_ids;
    } catch (e) {
      error = (e as Error).message;
    }
    const text = response?.paragraphs.map(p => p.text).join('\n') ?? '';
    const score = error ? {pass: false, extracted: [] as number[]} : scoreAnswer(q.truth, text);
    const citeSupported =
      q.truth.kind === 'time' ? (response?.paragraphs ?? []).some(p => p.cites.some(c => c.t && Math.abs(Date.parse(c.t) - (q.truth as {ms: number}).ms) <= TIME_TOL_MIN * 60_000)) : null;
    console.log(error ? `error: ${error}` : score.pass ? 'pass' : 'fail');
    rows.push({
      id: q.id,
      question: q.question,
      kind: q.truth.kind,
      truth: showTruth(q.truth),
      truth_source: q.source,
      answer: text,
      extracted: q.truth.kind === 'time' ? score.extracted.map(ms => new Date(ms).toISOString()) : score.extracted,
      pass: score.pass,
      cite_time_within_tolerance: citeSupported,
      cites: response?.paragraphs.flatMap(p => p.cites) ?? [],
      tool_calls: response?.tool_calls ?? [],
      dropped: response?.dropped ?? null,
      ...(response?.note ? {note: response.note} : {}),
      ...(error ? {error} : {})
    });
  }
  const rate = (rs: Row[]) => (rs.length ? Math.round((rs.filter(r => r.pass).length / rs.length) * 1000) / 1000 : null);
  const result = {
    accuracy: rate(rows),
    time_accuracy: rate(rows.filter(r => r.kind === 'time')),
    number_accuracy: rate(rows.filter(r => r.kind === 'number')),
    citation_validity: proposed ? Math.round(((proposed - invalid) / proposed) * 1000) / 1000 : null,
    cite_ids_proposed: proposed,
    cite_ids_invalid: invalid,
    n: rows.length,
    method: `${rows.length} questions with answers computed directly from public/data/${FIRE} by code independent of the analyst tools; answered by the analyst (runAnalyst, ${DEFAULT_MODEL}); a time passes within ±${TIME_TOL_MIN} min, a number within ±${NUM_TOL * 100}%, matched against any time or number in the returned (verified) paragraphs. Citation validity = model-proposed cite ids that a tool actually returned.`,
    model: DEFAULT_MODEL,
    date: new Date().toISOString().slice(0, 10),
    skipped,
    questions: rows
  };
  mkdirSync(path.join(DIR, 'eval'), {recursive: true});
  writeFileSync(path.join(DIR, 'eval', 'analyst.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\naccuracy ${result.accuracy} (time ${result.time_accuracy}, number ${result.number_accuracy}), citation validity ${result.citation_validity}, n=${result.n}`);
  console.log(`wrote ${path.join(DIR, 'eval', 'analyst.json')}`);
}

// Run only as a script, so tests can import the scorer.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'eval-analyst.ts'))) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
