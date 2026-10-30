import type {ChatCompletionFunctionTool} from 'openai/resources/chat/completions';
import {arrivalStepMin, FireStore, MissingDataError, sampleArrival, type ArrivalRaster} from './data.js';
import {bboxCenter, compass, densify, insideRings, metersPerDegree, polygonRings, type LonLat, type PolygonCollection} from './geo.js';
import {matchTier, normalizeName, TIER_RANK, type MatchTier} from './names.js';
import {localDate, localLabel, parseTime, roundToMinute, stamp} from './time.js';
import type {Cite, ToolCite, ToolOutput} from './types.js';

/** The analyst's tools: OpenAI function schemas plus implementations over public/data/<fire>/. */

type Args = Record<string, unknown>;
type Ctx = {store: FireStore; tz: string};
type Impl = (args: Args, ctx: Ctx) => ToolOutput;

export class ToolArgError extends Error {}

// ---------------------------------------------------------------- file shapes

type Gazetteer = Record<string, {name: string; segments: number; bbox: [number, number, number, number]}>;
type Label = {name: string; kind: string; lon: number; lat: number; ele_m: number | null};
type Roads = {features: {geometry: {type: string; coordinates: number[][]}; properties: {name: string | null}}[]};
type Series = {t: string[]; area_acres: number[]; ros_chains_hr: number[]};
type Hourly = {t: string; wind_mph: number; wind_dir_deg: number; gust_mph: number; temp_c: number; rh_pct: number};
type Weather = {hourly: Hourly[]; daily?: {date: string; erc?: number; bi?: number; fm100?: number; fm1000?: number}[]; source?: string; point?: LonLat};
type Spine = {features: {geometry: {type: string; coordinates: number[]}; properties: {kind?: string; t?: string; label?: string}}[]};
type FireEvent = {id?: string; kind: string; label: string; t: string; lon: number; lat: number; source?: string; date_only?: boolean};
type StructureProps = Record<string, string | number | null>;
type Structures = {features: {geometry: {coordinates: number[]}; properties: StructureProps}[]};
type Ignition = {
  map: {lon: number; lat: number; t: string};
  r90_m?: number;
  uncertainty_calibrated?: boolean;
  t90?: [string, string];
  timing?: {identifiable: boolean; reasons: string[]; interval90_width_h: number};
  region90_km2?: number;
  holdout?: {held_out?: {t: string; iou: number}[]; errors?: Record<string, number | boolean>};
  synthetic_summary?: unknown;
  model_card?: string;
};
type Contrast = {feature: string; label: string; n: number; or: number | null; ci95: [number, number] | null; unknown_rate?: unknown; by_stratum?: unknown};
type ExposureStats = {
  population?: string;
  n: number;
  destroyed: number;
  strata: {stratum: string; n: number; destroyed: number; rate: number; ci95: [number, number]}[];
  contrasts: Contrast[];
  regression?: {n?: number; terms?: {term: string; or: number; ci95: [number, number]}[]} | null;
  caveat: string;
};

// ---------------------------------------------------------------- helpers

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

function num(args: Args, key: string, fallback?: number): number {
  const v = args[key] ?? fallback;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolArgError(`${key} must be a number`);
  return n;
}

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolArgError(`${key} must be a non-empty string`);
  return v.trim().slice(0, 200);
}

function lonLat(args: Args): LonLat {
  const lon = num(args, 'lon');
  const lat = num(args, 'lat');
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new ToolArgError('lon/lat out of range (pass lon, lat in degrees)');
  return [lon, lat];
}

function time(args: Args): {ms: number; assumedUtc: boolean} {
  const raw = str(args, 't');
  const t = parseTime(raw);
  if (!t) throw new ToolArgError(`t must be an ISO-8601 time such as 2025-01-08T06:00:00Z (got ${JSON.stringify(raw)})`);
  return t;
}

const MAX_GAP_MS = 90 * 60_000;

function nearest(times: string[], ms: number): {i: number; gapMs: number} {
  let best = 0;
  let gap = Infinity;
  times.forEach((t, i) => {
    const d = Math.abs(Date.parse(t) - ms);
    if (d < gap) [best, gap] = [i, d];
  });
  return {i: best, gapMs: gap};
}

function finalRings(store: FireStore): number[][][] {
  return store.derived('final_perimeter.geojson', 'rings', s => polygonRings(s.json<PolygonCollection>('final_perimeter.geojson')));
}

/** Road polylines grouped by normalized street name. */
function roadIndex(store: FireStore): Map<string, {names: Set<string>; lines: number[][][]}> {
  return store.derived('roads.geojson', 'index', s => {
    const index = new Map<string, {names: Set<string>; lines: number[][][]}>();
    for (const f of s.json<Roads>('roads.geojson').features) {
      const name = f.properties.name;
      if (!name || f.geometry.type !== 'LineString') continue;
      const key = normalizeName(name);
      const entry = index.get(key) ?? {names: new Set(), lines: []};
      entry.names.add(name);
      entry.lines.push(f.geometry.coordinates);
      index.set(key, entry);
    }
    return index;
  });
}

const timeNote = (assumedUtc: boolean) => (assumedUtc ? {time_note: 'No time zone given; t was read as UTC.'} : {});

// ---------------------------------------------------------------- tools

const placeLookup: Impl = (args, {store}) => {
  const name = str(args, 'name');
  const q = normalizeName(name);
  if (!q) throw new ToolArgError('name has no letters or digits');
  type Hit = {name: string; kind: string; lon: number; lat: number; match: MatchTier; bbox?: number[]; segments?: number; ele_m?: number};
  const hits: Hit[] = [];
  for (const l of store.optionalJson<Label[]>('labels.json') ?? []) {
    const match = matchTier(normalizeName(l.name), q);
    if (match) hits.push({name: l.name, kind: l.kind, lon: l.lon, lat: l.lat, match, ...(l.ele_m != null ? {ele_m: l.ele_m} : {})});
  }
  for (const [key, g] of Object.entries(store.json<Gazetteer>('gazetteer.json'))) {
    const match = matchTier(key, q);
    if (!match) continue;
    const [lon, lat] = bboxCenter(g.bbox);
    hits.push({name: g.name, kind: 'street', lon: r5(lon), lat: r5(lat), match, bbox: g.bbox, segments: g.segments});
  }
  hits.sort((a, b) => TIER_RANK[a.match] - TIER_RANK[b.match] || (b.segments ?? 1e9) - (a.segments ?? 1e9));
  const top = hits.slice(0, 5);
  if (!top.length) {
    return {
      result: {query: name, matches: [], note: `No street or place in gazetteer.json or labels.json matches "${name}".`},
      cites: [{layer: 'gazetteer', label: `No match for "${name}"`}]
    };
  }
  return {
    result: {
      query: name,
      matches: top,
      note: 'For streets, lon/lat is the center of the street bounding box (it may not lie on the street); use street_fire_timeline for when a street burned.'
    },
    cites: top.map(h => ({layer: h.kind === 'street' ? 'roads' : 'labels', lon: h.lon, lat: h.lat, label: `${h.name} (${h.kind})`}))
  };
};

/** arrival.png's green value for cells only the final perimeter covers (step 06), as 0–1. */
const LATE_CONFIDENCE = 32 / 255;

const arrivalAt: Impl = (args, {store, tz}) => {
  const [lon, lat] = lonLat(args);
  const raster = store.arrival();
  const s = sampleArrival(raster, lon, lat);
  if (!s.inBounds) {
    return {
      result: {lon, lat, covered: false, note: `Outside the mapped area (bounds ${raster.bounds.join(', ')}). The data doesn't cover this point.`},
      cites: [{layer: 'arrival', lon, lat, label: 'Outside the mapped area'}]
    };
  }
  const inside = insideRings(finalRings(store), lon, lat);
  if (!s.burned) {
    return {
      result: {lon, lat, burned: false, inside_final_perimeter: inside, note: inside ? 'Inside the final perimeter, but no arrival time is recorded at this cell.' : 'The fire did not reach this point in the data.'},
      cites: [{layer: 'arrival', lon, lat, label: 'No fire arrival recorded here'}]
    };
  }
  const st = stamp(roundToMinute(s.ms), tz);
  if (s.confidence <= LATE_CONFIDENCE) {
    // Step 06 gives cells that only the final perimeter covers the last observation's time:
    // an upper bound, not an arrival time.
    return {
      result: {
        lon,
        lat,
        burned: true,
        arrival_time_known: false,
        burned_by_latest: st,
        inside_final_perimeter: inside,
        note: 'Inside the final perimeter but outside every timed perimeter, so the arrival time is not resolved: the fire reached this point by the time above at the latest.'
      },
      cites: [{layer: 'arrival', t: st.t, lon, lat, label: `Burned by ${st.t_local} at the latest (time not resolved)`}]
    };
  }
  const start = store.aoi().official.incident?.start_utc;
  return {
    result: {
      lon,
      lat,
      burned: true,
      ...st,
      ...(start ? {hours_after_reported_start: r1((s.ms - Date.parse(start)) / 3.6e6)} : {}),
      confidence: r2(s.confidence),
      inside_final_perimeter: inside,
      time_resolution_min: Math.round(arrivalStepMin(raster)),
      method: 'Interpolated between observed perimeters (arrival.png); approximate, not a model run.'
    },
    cites: [{layer: 'arrival', t: st.t, lon, lat, label: `Fire arrival ${st.t_local}`}]
  };
};

type Burn = {ms: number; lon: number; lat: number};
type StreetSample = {n: number; burned: number; first: Burn | null; last: Burn | null};

function sampleStreet(raster: ArrivalRaster, lines: number[][][]): StreetSample {
  const out: StreetSample = {n: 0, burned: 0, first: null, last: null};
  for (const line of lines) {
    for (const [lon, lat] of densify(line, 40)) {
      const s = sampleArrival(raster, lon, lat);
      if (!s.inBounds) continue;
      out.n++;
      if (!s.burned) continue;
      out.burned++;
      if (!out.first || s.ms < out.first.ms) out.first = {ms: s.ms, lon, lat};
      if (!out.last || s.ms > out.last.ms) out.last = {ms: s.ms, lon, lat};
    }
  }
  return out;
}

const streetFireTimeline: Impl = (args, {store, tz}) => {
  const name = str(args, 'name');
  const q = normalizeName(name);
  const index = roadIndex(store);
  const tiers = [...index.entries()].map(([key, v]) => ({key, v, tier: matchTier(key, q)}));
  let picked = tiers.filter(x => x.tier === 'exact');
  const prefix = tiers.filter(x => x.tier === 'prefix').sort((a, b) => b.v.lines.length - a.v.lines.length);
  // No exact name: take the single best prefix match rather than merging different streets.
  if (!picked.length) picked = prefix.slice(0, 1);
  const alsoMatching = prefix.filter(x => !picked.includes(x)).slice(0, 5).map(x => [...x.v.names].sort()[0]);
  if (!picked.length) {
    const suggestions = tiers.filter(x => x.tier).slice(0, 5).map(x => [...x.v.names][0]);
    return {
      result: {query: name, found: false, suggestions, note: `No street named "${name}" in roads.geojson. The data doesn't show it.`},
      cites: [{layer: 'roads', label: `No street matching "${name}"`}]
    };
  }
  const raster = store.arrival();
  const fmt = (b: Burn | null) => (b ? {...stamp(roundToMinute(b.ms), tz), lon: r5(b.lon), lat: r5(b.lat)} : null);
  const streets = picked
    .map(({v}) => ({name: [...v.names].sort()[0], segments: v.lines.length, ...sampleStreet(raster, v.lines)}))
    .sort((a, b) => b.n - a.n);
  const n = streets.reduce((a, s) => a + s.n, 0);
  const burned = streets.reduce((a, s) => a + s.burned, 0);
  const firsts = streets.map(s => s.first).filter((b): b is Burn => !!b);
  const lasts = streets.map(s => s.last).filter((b): b is Burn => !!b);
  const first = firsts.length ? firsts.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
  const last = lasts.length ? lasts.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  const display = streets.map(s => s.name).join(' / ');

  const cites: ToolCite[] = [];
  if (first && last) {
    cites.push({layer: 'arrival', t: fmt(first)!.t, lon: r5(first.lon), lat: r5(first.lat), label: `First burn on ${display}`});
    cites.push({layer: 'arrival', t: fmt(last)!.t, lon: r5(last.lon), lat: r5(last.lat), label: `Last burn on ${display}`});
    if (streets.length > 1) {
      for (const s of streets) if (s.first) cites.push({layer: 'arrival', t: fmt(s.first)!.t, lon: r5(s.first.lon), lat: r5(s.first.lat), label: `First burn on ${s.name}`});
    }
  } else {
    cites.push({layer: 'roads', label: `${display}: no burned points`});
  }
  return {
    result: {
      query: name,
      found: true,
      streets: streets.map(s => s.name),
      n_points: n,
      n_burned: burned,
      burned_fraction: n ? r2(burned / n) : 0,
      first_burn: fmt(first),
      last_burn: fmt(last),
      ...(streets.length > 1
        ? {
            by_street: streets.map(s => ({
              name: s.name,
              n_points: s.n,
              burned_fraction: s.n ? r2(s.burned / s.n) : 0,
              first_burn: fmt(s.first),
              last_burn: fmt(s.last)
            }))
          }
        : {}),
      ...(alsoMatching.length ? {also_matching: alsoMatching} : {}),
      sample_spacing_m: 40,
      time_resolution_min: Math.round(arrivalStepMin(raster)),
      note: burned ? 'Times come from the interpolated arrival raster and are approximate.' : 'None of the sampled points along this street burned in the data.'
    },
    cites
  };
};

const fireStateAt: Impl = (args, {store, tz}) => {
  const {ms, assumedUtc} = time(args);
  const s = store.json<Series>('series.json');
  const {i, gapMs} = nearest(s.t, ms);
  if (gapMs > MAX_GAP_MS) {
    return {
      result: {asked: stamp(ms, tz), covered: false, note: `series.json covers ${s.t[0]} to ${s.t[s.t.length - 1]} hourly; the data doesn't show this time.`},
      cites: [{layer: 'series', label: 'Fire area series (no data at that time)'}]
    };
  }
  const tMs = Date.parse(s.t[i]);
  const st = stamp(tMs, tz);
  const wp = (store.optionalJson<Spine>('spine.geojson')?.features ?? [])
    .filter(f => f.geometry.type === 'Point' && f.properties.t && Date.parse(f.properties.t) <= tMs && tMs - Date.parse(f.properties.t) <= 3.6e6)
    .sort((a, b) => Date.parse(b.properties.t!) - Date.parse(a.properties.t!))[0];
  const head = wp ? {...stamp(Date.parse(wp.properties.t!), tz), lon: wp.geometry.coordinates[0], lat: wp.geometry.coordinates[1]} : null;
  const cites: ToolCite[] = [{layer: 'series', t: st.t, label: `${s.area_acres[i].toLocaleString('en-US')} acres burned`}];
  if (head) cites.push({layer: 'spine', t: head.t, lon: head.lon, lat: head.lat, label: 'Head of the fire (spine waypoint)'});
  return {
    result: {
      asked: stamp(ms, tz),
      ...st,
      area_acres: s.area_acres[i],
      ros_chains_hr: s.ros_chains_hr[i],
      ros_mph: r2(s.ros_chains_hr[i] / 80),
      head,
      note: 'Nearest hour in series.json. Area is cumulative burned area from the arrival raster; ROS is the head rate of spread.',
      ...timeNote(assumedUtc)
    },
    cites
  };
};

const weatherAt: Impl = (args, {store, tz}) => {
  const {ms, assumedUtc} = time(args);
  const w = store.json<Weather>('weather.json');
  const {i, gapMs} = nearest(
    w.hourly.map(h => h.t),
    ms
  );
  if (gapMs > MAX_GAP_MS) {
    return {
      result: {asked: stamp(ms, tz), covered: false, note: `weather.json covers ${w.hourly[0]?.t} to ${w.hourly[w.hourly.length - 1]?.t}; the data doesn't show this time.`},
      cites: [{layer: 'weather', label: 'Hourly weather (no data at that time)'}]
    };
  }
  const h = w.hourly[i];
  const tMs = Date.parse(h.t);
  const st = stamp(tMs, tz);
  const daily = w.daily?.find(d => d.date === localDate(tMs, tz));
  const [lon, lat] = w.point ?? store.aoi().center;
  return {
    result: {
      asked: stamp(ms, tz),
      ...st,
      wind_mph: h.wind_mph,
      gust_mph: h.gust_mph,
      wind_dir_deg: h.wind_dir_deg,
      wind_from: compass(h.wind_dir_deg),
      temp_c: h.temp_c,
      temp_f: r1((h.temp_c * 9) / 5 + 32),
      rh_pct: h.rh_pct,
      ...(daily ? {daily_fire_danger: daily} : {}),
      source: w.source,
      note: 'Weather model (NOAA HRRR, 3 km) at the fire area center, not a station reading. Gust is the max of the preceding hour; direction is where the wind blows FROM.',
      ...timeNote(assumedUtc)
    },
    cites: [{layer: 'weather', t: st.t, lon, lat, label: `Wind ${h.wind_mph} mph from ${compass(h.wind_dir_deg)}, gusts ${h.gust_mph} mph, RH ${h.rh_pct}%`}]
  };
};

const events: Impl = (_args, {store, tz}) => {
  const ev = store.optionalJson<FireEvent[]>('events.json');
  if (!ev) {
    return {
      result: {available: false, note: 'events.json has not been produced for this fire; the data doesn’t show key events yet.'},
      cites: [{layer: 'events', label: 'Key events (not available)'}]
    };
  }
  return {
    result: {
      events: ev.map(e => ({id: e.id, kind: e.kind, label: e.label, ...stamp(Date.parse(e.t), tz), lon: e.lon, lat: e.lat, source: e.source, ...(e.date_only ? {date_only: true} : {})})),
      note: 'ignition_estimate is a model estimate, not an investigated origin. date_only events have a date but no reliable clock time.'
    },
    cites: ev.map(e => ({layer: 'events', t: e.t, lon: e.lon, lat: e.lat, label: e.label}))
  };
};

const DAMAGE_ORDER = ['Destroyed', 'Major', 'Minor', 'Affected', 'No Damage', 'Inaccessible'];
const CONSTRUCTION = ['roof', 'vents', 'eaves', 'window_pane'] as const;

const structuresNear: Impl = (args, {store}) => {
  const [lon, lat] = lonLat(args);
  const radius = Math.round(Math.min(2000, Math.max(25, num(args, 'radius_m', 500))));
  const [mx, my] = metersPerDegree(lat);
  const byDamage: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const construction: Record<string, Record<string, {n: number; destroyed: number}>> = Object.fromEntries(CONSTRUCTION.map(k => [k, {}]));
  let total = 0;
  for (const f of store.json<Structures>('structures.geojson').features) {
    const [x, y] = f.geometry.coordinates;
    const dx = (x - lon) * mx;
    const dy = (y - lat) * my;
    if (dx * dx + dy * dy > radius * radius) continue;
    const p = f.properties;
    const damage = String(p.damage ?? 'Unknown');
    const destroyed = damage === 'Destroyed' ? 1 : 0;
    total++;
    byDamage[damage] = (byDamage[damage] ?? 0) + 1;
    const cat = String(p.structure_category ?? 'Unknown');
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    for (const k of CONSTRUCTION) {
      const v = String(p[k] ?? 'Unknown');
      const cell = (construction[k][v] ??= {n: 0, destroyed: 0});
      cell.n++;
      cell.destroyed += destroyed;
    }
  }
  const ordered = Object.fromEntries(Object.entries(byDamage).sort(([a], [b]) => DAMAGE_ORDER.indexOf(a) - DAMAGE_ORDER.indexOf(b)));
  const destroyed = byDamage.Destroyed ?? 0;
  return {
    result: {
      center: {lon, lat},
      radius_m: radius,
      total,
      by_damage: ordered,
      destroyed_rate: total ? r2(destroyed / total) : null,
      by_category: byCategory,
      construction,
      source: 'CAL FIRE DINS damage inspections',
      note: total
        ? 'Counts only; individual homes are never identified.'
        : `No inspected structures within ${radius} m of this point; the data doesn't show any.`
    },
    cites: [{layer: 'structures', lon, lat, label: `${total} inspected structures within ${radius} m (${destroyed} destroyed)`}]
  };
};

const ignitionSummary: Impl = (_args, {store, tz}) => {
  const ig = store.optionalJson<Ignition>('ignition.json');
  const incident = store.aoi().official.incident;
  const reported = incident
    ? {
        ...stamp(Date.parse(incident.start_utc), tz),
        lon: incident.reported_location[0],
        lat: incident.reported_location[1],
        source: incident.source,
        note: 'Reported incident location, not an investigated origin.'
      }
    : null;
  const cites: ToolCite[] = [];
  if (reported) cites.push({layer: 'events', t: reported.t, lon: reported.lon, lat: reported.lat, label: 'Reported start (CAL FIRE)'});
  if (!ig) {
    cites.push({layer: 'ignition', label: 'Ignition estimate (not available)'});
    return {result: {available: false, reported_start: reported, note: 'ignition.json has not been produced; the data doesn’t show a model estimate.'}, cites};
  }
  // When the back-trace cannot pin down the start time, the model never sees one to repeat.
  const timed = ig.timing?.identifiable ?? true;
  const where = {lon: ig.map.lon, lat: ig.map.lat, radius90_m: ig.r90_m ?? null, uncertainty_calibrated: ig.uncertainty_calibrated ?? true};
  const est = timed
    ? {...stamp(Date.parse(ig.map.t), tz), ...where, interval90: ig.t90 ? ig.t90.map(t => stamp(Date.parse(t), tz)) : null}
    : {...where, start_time: 'not identifiable from the data', why: ig.timing?.reasons ?? []};
  cites.unshift(
    timed
      ? {layer: 'ignition', t: ig.map.t, lon: ig.map.lon, lat: ig.map.lat, label: 'Ignition (est.), model estimate'}
      : {layer: 'ignition', lon: ig.map.lon, lat: ig.map.lat, label: 'Ignition location (est.), start time not identifiable'}
  );
  return {
    result: {
      disclaimer:
        'A statistical back-trace of where and when the fire most likely started, fitted to its observed spread. It is a model estimate, not an investigated origin, and says nothing about how the fire began.',
      estimate: est,
      region90_km2: ig.region90_km2 ?? null,
      holdout: {
        method: 'Fitted on later observations only, then scored on the held-out earliest evidence. Distances and time errors are versus the CAL FIRE reported start.',
        held_out: (ig.holdout?.held_out ?? []).map(h => ({...stamp(Date.parse(h.t), tz), iou: h.iou})),
        errors: ig.holdout?.errors ?? null
      },
      synthetic_summary: ig.synthetic_summary ?? null,
      model_card: ig.model_card ?? null,
      reported_start: reported
    },
    cites
  };
};

function featureMatches(c: Contrast, query: string): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(t => t.length >= 3)
    .map(t => t.replace(/s$/, ''));
  const label = c.label.toLowerCase();
  return tokens.some(t => c.feature.startsWith(t) || label.includes(t));
}

const exposureStats: Impl = (args, {store}) => {
  const ex = store.optionalJson<ExposureStats>('exposure_stats.json');
  if (!ex) {
    return {
      result: {available: false, note: 'exposure_stats.json has not been produced for this fire; the data doesn’t show house-level associations yet.'},
      cites: [{layer: 'exposure_stats', label: 'House-level associations (not available)'}]
    };
  }
  const feature = typeof args.feature === 'string' && args.feature.trim() ? args.feature.trim().slice(0, 80) : null;
  const contrasts = feature ? ex.contrasts.filter(c => featureMatches(c, feature)) : ex.contrasts;
  if (feature && !contrasts.length) {
    return {
      result: {feature, found: false, available_features: ex.contrasts.map(c => c.feature), note: `No contrast for "${feature}"; the data doesn't show it.`},
      cites: [{layer: 'exposure_stats', label: `No house-level contrast for "${feature}"`}]
    };
  }
  const ci = (c: Contrast) => (c.ci95 ? `${c.ci95[0]}–${c.ci95[1]}` : 'n/a');
  const cites: ToolCite[] = contrasts.map(c => ({layer: 'exposure_stats', label: `${c.label}: odds ratio ${c.or ?? 'n/a'} (95% CI ${ci(c)})`}));
  if (!feature) cites.push({layer: 'exposure_stats', label: `Exposure strata (${ex.n.toLocaleString('en-US')} homes, ${ex.destroyed.toLocaleString('en-US')} destroyed)`});
  return {
    result: {
      caveat: ex.caveat,
      population: ex.population,
      n: ex.n,
      destroyed: ex.destroyed,
      how_to_read:
        'Mantel–Haenszel odds ratio of destruction within exposure strata, first-named group vs the reference group. Below 1 means lower odds of destruction among homes with the first-named feature. An association, not an effect of the feature.',
      contrasts: contrasts.map(c => ({
        feature: c.feature,
        label: c.label,
        n: c.n,
        odds_ratio: c.or,
        ci95: c.ci95,
        ...(c.unknown_rate ? {unknown_rate: c.unknown_rate} : {}),
        ...(feature ? {by_stratum: c.by_stratum} : {})
      })),
      ...(feature ? {} : {strata: ex.strata, regression: ex.regression?.terms?.map(t => ({term: t.term, odds_ratio: t.or, ci95: t.ci95})) ?? null})
    },
    cites
  };
};

// ---------------------------------------------------------------- registry

const IMPLS: Record<string, Impl> = {
  place_lookup: placeLookup,
  arrival_at: arrivalAt,
  street_fire_timeline: streetFireTimeline,
  fire_state_at: fireStateAt,
  weather_at: weatherAt,
  events,
  structures_near: structuresNear,
  ignition_summary: ignitionSummary,
  exposure_stats: exposureStats
};

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ChatCompletionFunctionTool => ({
  type: 'function',
  function: {name, description, parameters: {type: 'object', properties, required, additionalProperties: false}}
});

const LON = {type: 'number', description: 'Longitude, decimal degrees (negative west).'};
const LAT = {type: 'number', description: 'Latitude, decimal degrees.'};
const T = {type: 'string', description: 'UTC ISO-8601 time, e.g. 2025-01-08T06:00:00Z.'};

export const DATA_TOOLS: ChatCompletionFunctionTool[] = [
  fn('place_lookup', 'Find a street, neighborhood, peak or water feature by name. Returns up to 5 matches with lon/lat. Use it before any tool that needs coordinates.', {
    name: {type: 'string', description: 'Place or street name, e.g. "Lake Ave" or "Mount Wilson".'}
  }, ['name']),
  fn('arrival_at', 'When the fire reached a point: burned or not, arrival time (UTC and local), confidence 0-1, and whether the point is inside the final perimeter.', {lon: LON, lat: LAT}, ['lon', 'lat']),
  fn('street_fire_timeline', 'When the fire reached a named street: samples every segment of the street every ~40 m and returns the first and last burn times with their locations, and the burned fraction.', {
    name: {type: 'string', description: 'Street name, e.g. "Lake Ave" or "North Lake Avenue".'}
  }, ['name']),
  fn('fire_state_at', 'Fire size and head rate of spread at the nearest hour to t, plus the head position when known.', {t: T}, ['t']),
  fn('weather_at', 'Hourly wind, gust, direction, temperature and relative humidity at the nearest hour to t.', {t: T}, ['t']),
  fn('events', 'Key events of the fire (reported start, rapid growth, spot fires, peak gust, containment...) with times and locations.'),
  fn('structures_near', 'Counts of inspected structures within a radius of a point, by damage category, with roof, vent, eave and window breakdowns. Never identifies individual homes.', {
    lon: LON,
    lat: LAT,
    radius_m: {type: 'number', description: 'Radius in meters, 25 to 2000. Default 500.'}
  }, ['lon', 'lat']),
  fn('ignition_summary', 'The model estimate of where and when the fire started (a statistical back-trace, not an investigated origin), with its 90% region and hold-out errors.'),
  fn('exposure_stats', 'House-level associations between construction features (vents, eaves, roof, window_pane, siding, fences, decks, patio covers) and destruction, adjusted for exposure. Associations only.', {
    feature: {type: 'string', description: 'Optional feature, e.g. "vents" or "roof". Omit for all.'}
  })
];

export const FINAL_ANSWER_TOOL: ChatCompletionFunctionTool = fn(
  'final_answer',
  'Return the answer. Call it exactly once, alone, as the last step. Every paragraph must list the ids of the tool cites that support it.',
  {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {type: 'string', description: 'One short paragraph of plain prose, without cite ids in it.'},
          cite_ids: {type: 'array', items: {type: 'string'}, description: 'Ids such as "c3" from tool results in this conversation.'}
        },
        required: ['text', 'cite_ids'],
        additionalProperties: false
      }
    }
  },
  ['paragraphs']
);

export type ToolRun = {content: string; args: unknown; ok: boolean};

/** Runs tools for one analyst request and registers every cite they return under a fresh id,
 * with the tool output behind it (the evidence the verifier checks numbers against). */
export function createToolRunner(store: FireStore) {
  const registry = new Map<string, Cite>();
  const evidence = new Map<string, unknown>();
  const tz = store.aoi().timezone;
  let next = 1;

  function run(name: string, rawArgs: string): ToolRun {
    let args: Args;
    try {
      const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
      args = parsed as Args;
    } catch (e) {
      return {content: JSON.stringify({error: `arguments are not valid JSON: ${(e as Error).message}`}), args: rawArgs, ok: false};
    }
    const impl = IMPLS[name];
    if (!impl) return {content: JSON.stringify({error: `unknown tool "${name}"`}), args, ok: false};
    let out: ToolOutput;
    try {
      out = impl(args, {store, tz});
    } catch (e) {
      if (!(e instanceof ToolArgError || e instanceof MissingDataError)) console.error(`[analyst] tool ${name} failed`, e);
      return {content: JSON.stringify({error: (e as Error).message}), args, ok: false};
    }
    const cites = out.cites.map(c => {
      const cite: Cite = {id: `c${next++}`, ...c};
      registry.set(cite.id, cite);
      const shown = cite.t ? {...cite, t_local: localLabel(Date.parse(cite.t), tz)} : cite;
      evidence.set(cite.id, {result: out.result, cite: shown});
      return shown;
    });
    return {content: JSON.stringify({result: out.result, cites}), args, ok: true};
  }

  return {run, registry, evidence};
}

export type ToolRunner = ReturnType<typeof createToolRunner>;
