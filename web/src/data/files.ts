/**
 * The per-fire files the pipeline writes after steps 01–02 (WORKSTREAMS.md §1, A → B).
 * Each panel loads only what it reads, through one cache, so a missing file degrades that
 * panel alone instead of blocking the app.
 */
import {useEffect, useState} from 'react';
import type {FireData} from './fire';

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};
type Feature<G, P> = {type: 'Feature'; geometry: G; properties: P};
type Collection<G, P> = {type: 'FeatureCollection'; features: Feature<G, P>[]};

export type EventKind =
  | 'reported_start'
  | 'ignition_estimate'
  | 'rapid_growth'
  | 'spot_fire'
  | 'ridge_crossing'
  | 'peak_gust'
  | 'containment';

/** events.json, sorted by t. `date_only` events (containment) carry a date, not a time. */
export type FireEvent = {
  id: string;
  kind: EventKind;
  label: string;
  t: string;
  lon: number;
  lat: number;
  source: string;
  date_only?: boolean;
  /** rapid_growth: the span between mapped perimeters that the rate is averaged over. */
  interval?: [string, string];
};

/** series.json: hourly, from the arrival raster. */
export type Series = {t: string[]; area_acres: number[]; ros_chains_hr: number[]};

/** profile.json: elevation along the spread spine; t = arrival at each sample (null = never burned). */
export type Profile = {distance_km: number[]; elevation_m: number[]; t: (string | null)[]};

/** spine.geojson: the spine LineString plus timestamped waypoints. */
export type Spine = Collection<
  {type: 'LineString'; coordinates: number[][]} | {type: 'Point'; coordinates: [number, number]},
  {kind: 'spine'} | {kind: 'waypoint'; t: string; label: string}
>;

export type WeatherHour = {t: string; wind_mph: number; wind_dir_deg: number; gust_mph: number; temp_c: number; rh_pct: number};
export type WeatherDay = {date: string; erc: number | null; bi: number | null; fm100: number | null; fm1000?: number | null; qc?: string[]};

/** weather.json: the weather model at the AOI center (HRRR 3 km), not a station reading. */
export type Weather = {
  hourly: WeatherHour[];
  daily: WeatherDay[];
  source: string;
  model: string;
  model_label: string;
  point: [number, number];
  units: Record<string, string>;
  summary: {peak_gust_mph: number; peak_gust_t: string; min_rh_pct: number; min_rh_t: string};
};

/**
 * wind_field.json: hourly wind on a rows × cols grid of points over aoi.bbox, row-major,
 * north row first. u_mph[i][k] is point i at hour k; u/v point where the air moves.
 */
export type WindField = {
  model: string;
  rows: number;
  cols: number;
  points: [number, number][];
  t: string[];
  u_mph: number[][];
  v_mph: number[][];
  gust_mph: number[][];
  convention: string;
};

export type SyntheticSummary = {
  n: number;
  distance_m: {backtrace: {median: number; p90?: number}; baseline_first_footprint_centroid: {median: number; p90?: number}};
  start_time_error_min: {backtrace: {median: number; p90?: number}; baseline_area_backcast: {median: number; p90?: number}};
  backtrace_beats_baseline: {distance: number; time: number};
};

/** ignition.json (step 11). `timing.identifiable` false → show the location, never a start time. */
export type Ignition = {
  map: {lon: number; lat: number; t: string; k: number; lb_max: number};
  r90_m: number;
  t90: [string, string];
  timing: {identifiable: boolean; reasons: string[]; interval90_width_h: number};
  region90: Polygonal;
  region90_km2: number;
  observations_used: number;
  perimeters_total: number;
  first_observation: string;
  modeled_vs_observed_iou: number[];
  calibration: {
    tau_h: number;
    test_cases: number;
    test_coverage: {distance: number; time: number};
    median_test_r90_m: number;
    median_test_t90_width_h: number;
    test_start_time_shown: {cases: number; of: number};
  };
  /** False when no temperature tried reached 90% coverage: the radius and interval are the widest tried. */
  uncertainty_calibrated?: boolean;
  /** `errors` is written only when the fire has a CAL FIRE incident to compare against. */
  holdout: {
    held_out: {t: string; iou: number}[];
    uncertainty_calibrated?: boolean;
    errors?: {
      backtrace_distance_m: number;
      baseline_distance_m: number;
      backtrace_time_error_min: number;
      baseline_time_error_min: number;
      reference_within_r90: boolean;
      reference_within_t90: boolean;
      /** How far CAL FIRE's point lies outside the hold-out fit's first footprint (0 = inside). */
      reference_outside_first_fit_footprint_m?: number;
    };
  };
  /** How far CAL FIRE's point lies outside the first mapped footprint (0 = inside). */
  reference_outside_first_footprint_m: number | null;
  /** Synthetic benchmark fitted on every footprint, as the app's fit is. */
  synthetic_summary: SyntheticSummary;
  /** The same benchmark with the first two footprints held out, as the real hold-out is. */
  synthetic_summary_holdout?: SyntheticSummary;
  model_card: string;
};

/** perimeters.geojson: the observed (NIFC) perimeters, cumulative, sorted by t. */
export type Perimeters = Collection<Polygonal, {t: string; acres: number; source: string}>;

/** spots.geojson: spot fires mapped outside the main body. */
export type Spots = Collection<Polygonal, {t: string; acres: number}>;

/** structures.geojson (CAL FIRE DINS). No address, parcel, owner or year built, by design. */
export type Structures = Collection<
  {type: 'Point'; coordinates: [number, number]},
  {
    id: number;
    damage: 'Destroyed' | 'Major' | 'Minor' | 'Affected' | 'No Damage' | 'Inaccessible';
    structure_type: string;
    structure_category?: string;
    roof: string | null;
    eaves: string | null;
    vents: string | null;
    siding: string | null;
    window_pane?: string | null;
    deck_elevated?: string | null;
    fence_attached?: string | null;
  }
>;

export type Roads = Collection<{type: 'LineString'; coordinates: number[][]}, {name: string | null; highway: string}>;

export type PlaceLabel = {name: string; kind: 'peak' | 'place' | 'water'; lon: number; lat: number; ele_m: number | null};

export type FuelClasses = Record<string, {label: string; burnable: boolean}>;

/** exposure_stats.json (step 09b): destruction odds by construction feature at matched exposure. */
export type ExposureStats = {
  population: string;
  n: number;
  destroyed: number;
  gust_split_mph: number;
  gust_source: string;
  arrival_imputed: {n: number; note: string};
  strata: {stratum: string; n: number; destroyed: number; rate: number; ci95: [number, number]}[];
  contrasts: {
    feature: string;
    label: string;
    n: number;
    or: number | null;
    ci95: [number, number] | null;
    unknown_rate: {destroyed: number; surviving: number};
  }[];
  caveat: string;
  wildland_definition: string;
};

/** exposure.json: one column per field, one row per exposed residence (keyed by structure id). */
export type Exposure = {
  id: number[];
  arrival_t: (string | null)[];
  arrival_imputed: boolean[];
  gust_mph: (number | null)[];
  dist_wildland_m: (number | null)[];
  exposed: boolean[];
};

/** debris_flow.geojson: USGS stream segments with debris-flow likelihood per model and design storm. */
export type DebrisFlowSegments = Collection<
  {type: 'LineString'; coordinates: number[][]},
  {id: number; area_km2: number; T: number; F: number; S: number; usgs_hazard_24: 1 | 2 | 3} & Record<string, number>
>;

/** debris_flow_stats.json: provenance, the scenario behind the ML columns, and agreement with USGS. */
export type DebrisFlowStats = {
  source: {title: string; doi: string; url: string; license: string};
  design_i15_mm_h: number[];
  scenario: {date: string; days_since_fire: number; soil_moisture_0_7cm: number | null; soil_moisture_source: string};
  segments: number;
  m1_check: {max_abs_diff_vs_usgs: number};
  agreement: Record<string, {spearman_vs_usgs_24: number; class_agreement_24: number}>;
  likelihood_class_counts_24: Record<string, Record<string, number>>;
  usgs_median_thresholds_mm_h: {I15_50: number; I15_75: number};
  notes: string[];
};

type Scores = {roc_auc: number; pr_auc: number; brier: number; base_rate: number};

/** debris_flow/model_eval.json (shared across fires): the models scored on USGS's observed inventory. */
export type DebrisModelEval = {
  inventory: {title: string; doi: string; url: string; records: number; fires: number; debris_flows: number;
              used_records: number; used_fires: number; used_flows: number; filters: string[]};
  cv: {scheme: string; folds: number};
  features: Record<string, string>;
  models: {
    id: string; label: string; features: string[]; cv: string; n: number; flows: number;
    pooled: Scores; per_fire: {fires: number; median_roc_auc: number; iqr: [number, number]};
    analogue: {fire: string; year: number; n: number; flows: number; roc_auc: number; brier: number} | null;
  }[];
  importance: Record<string, {feature: string; drop_in_auc: number}[]>;
  notes: string[];
};

const cache = new Map<string, Promise<unknown>>();

/** Fetches public/data/<fire>/<file> once per session. */
export function loadFireJson<T>(fire: FireData, file: string): Promise<T> {
  const url = `${fire.base}/${file}`;
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r.json();
    });
    cache.set(url, p);
  }
  return p as Promise<T>;
}

export function useFireJson<T>(fire: FireData, file: string): {data: T | null; error: string | null} {
  const [state, setState] = useState<{data: T | null; error: string | null}>({data: null, error: null});
  useEffect(() => {
    let live = true;
    loadFireJson<T>(fire, file).then(
      data => live && setState({data, error: null}),
      e => live && setState({data: null, error: String(e.message ?? e)})
    );
    return () => {
      live = false;
    };
  }, [fire, file]);
  return state;
}

/** Index of the last entry of sorted ISO times at or before `ms` (−1 if none). */
export function indexAtOrBefore(times: string[], ms: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(times[mid]) <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
