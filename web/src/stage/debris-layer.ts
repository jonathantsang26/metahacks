/**
 * Post-fire debris-flow likelihood (Risk tab): USGS's stream segments draped on the terrain,
 * coloured by the selected model's likelihood under the selected design storm and widened by
 * upstream area. Also what the Risk rail and dock share with the map: the model list, the
 * likelihood classes and their palette, and one cached loader for the debris-flow files
 * (model_eval.json is shared across fires, so it does not live under the fire's base path).
 */
import {useEffect, useMemo, useState} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import type {FireData} from '../data/fire';
import type {DebrisFlowSegments, DebrisFlowStats, DebrisModelEval} from '../data/files';
import type {DESIGN_I15, LayerDef, RiskModel} from '../state/ui';
import type {Dem} from './dem';
import {distanceM, drapeDense, insideRuns} from './drape';
import {NO_PART, type StagePart} from './evidence-layers';
import type {Swatch} from './overlays';

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
export type DesignStorm = (typeof DESIGN_I15)[number];
export type Segment = DebrisFlowSegments['features'][number];
type Loaded<T> = {data: T | null; error: string | null};

export type RiskModelDef = {
  id: RiskModel;
  label: string;
  short: string;
  /** What the column is, for the selector's tooltip and the map note. */
  about: string;
  /** The model_eval.json row that scores this column's model on USGS's observed inventory. */
  evalId: string;
  /** Line colour in the dock charts (validated as an adjacent-pair categorical set on --bg-chrome). */
  color: string;
};

/**
 * The three likelihood columns of debris_flow.geojson (WORKSTREAMS.md §1, contract v2). USGS's
 * column is the reference, scored by the published-coefficient row; the other two are the
 * on_map rows of model_eval.json. All three rise with rainfall. The MLPs are scored in
 * model_eval.json but not mapped: nothing constrains them to rise with rainfall.
 */
export const RISK_MODELS: RiskModelDef[] = [
  {
    id: 'usgs',
    label: 'USGS M1 (published)',
    short: 'USGS',
    about: "USGS's own likelihoods: M1 with its published coefficients (Staley et al. 2017), the reference",
    evalId: 'm1_published',
    color: '#2a78d6'
  },
  {
    id: 'm1',
    label: 'M1 recalibrated',
    short: 'M1 recalibrated',
    about: "M1's form refitted on every usable record of USGS's observed inventory",
    evalId: 'm1_refit',
    color: '#eb6834'
  },
  {
    id: 'rf',
    label: 'Random forest (monotone in rainfall)',
    short: 'RF',
    about:
      "A random forest fitted on USGS's observed inventory, constrained so its likelihood never falls as rainfall rises, under the stats file's scenario",
    evalId: 'rf_extended',
    color: '#1baf7a'
  }
];

export const riskModel = (id: RiskModel): RiskModelDef => RISK_MODELS.find(m => m.id === id) ?? RISK_MODELS[0];

/**
 * Row names for model_eval.json in the rail table and the dock chart, where the file's labels
 * ("Random forest, M1's four inputs" / "… extended features") truncate to the same text. The
 * full label stays in each row's tooltip; an id not listed here shows as itself.
 */
const EVAL_SHORT: Record<string, string> = {
  m1_published: 'M1 published',
  m1_refit: 'M1 recalibrated',
  rf_m1vars: 'RF · M1 inputs',
  rf_extended: 'RF · extended',
  mlp_m1vars: 'MLP · M1 inputs',
  mlp_extended: 'MLP · extended',
  mlp_context: 'MLP · context'
};
export const evalShort = (id: string) => EVAL_SHORT[id] ?? id;

/** The map column a model_eval.json row is behind, if any (USGS's for the published coefficients). */
export const columnForEval = (evalId: string): RiskModelDef | undefined => RISK_MODELS.find(m => m.evalId === evalId);

/**
 * debris_flow_stats.json's likelihood_class_counts key for class k ("0-20%" … "80-100%", ASCII
 * hyphen; LIKELIHOOD_CLASSES labels use an en dash).
 */
export const classKey = (k: number) => `${k * 20}-${(k + 1) * 20}%`;

/**
 * The Station Fire column and marker belong to a fire whose stats file names that fire as its
 * inventory analogue (Eaton); elsewhere (Palisades) the stats file's note says why there is none.
 */
export function analogueShown(stats: DebrisFlowStats | null, ev: DebrisModelEval | null): boolean {
  const fire = stats?.analogue?.fire;
  return !!fire && !!ev?.models.some(m => m.analogue?.fire === fire);
}

/** debris_flow.geojson's column for a model under a design storm. */
export const pKey = (model: RiskModel, i15: number) => `${model}_p_${i15}`;

/** A segment's likelihood (0–1), or null where the file has no finite value for it. */
export function likelihood(props: Segment['properties'], model: RiskModel, i15: number): number | null {
  const v: unknown = (props as Record<string, unknown>)[pKey(model, i15)];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** USGS's rainfall measure: the 15-minute accumulation of a peak 15-minute intensity, R15 = I15 × 0.25 h (mm). */
export const accumulationMm = (i15: number) => i15 * 0.25;

export function likelihoodText(p: number | null): string {
  if (p === null) return '—';
  return p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`;
}

const hex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;

/**
 * Five likelihood classes, one blue hue light → dark: blue stays clear of the burn-scar wash
 * (orange → red), the char and the purple ignition heat it is drawn over. The steps pass the
 * dataviz ordinal checks against --bg-chrome, so the dock's class bars use them unchanged.
 */
export const LIKELIHOOD_CLASSES: {label: string; rgb: RGB; css: string}[] = [
  ['0–20%', '#5598e7'],
  ['20–40%', '#2a78d6'],
  ['40–60%', '#1c5cab'],
  ['60–80%', '#104281'],
  ['80–100%', '#0b2a52']
].map(([label, css]) => ({label, css, rgb: hex(css)}));
/** A segment without a value for the selected column. */
export const NO_VALUE = {label: 'No value', rgb: [150, 146, 136] as RGB, css: 'rgb(150, 146, 136)'};

/** Class index 0–4 (p = 1 lands in the top class). */
export const classOf = (p: number) => Math.min(4, Math.max(0, Math.floor(p * 5)));

/** The point halfway along a segment's line, for flying the camera to it. */
export function segmentMidpoint(coords: number[][]): [number, number] {
  const steps = coords.slice(1).map((p, i) => distanceM(coords[i][0], coords[i][1], p[0], p[1]));
  let left = steps.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < steps.length; i++) {
    if (left <= steps[i] && steps[i] > 0) {
      const f = left / steps[i];
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
    }
    left -= steps[i];
  }
  return [coords[0][0], coords[0][1]];
}

const cache = new Map<string, Promise<unknown>>();

function loadJson<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // A dev server answers a missing file with its index page, which is not JSON.
      return r.json().catch(() => {
        throw new Error('not JSON (file missing?)');
      });
    });
    cache.set(url, p);
  }
  return p as Promise<T>;
}

/** Fetches `url` once per session, and only once `when` has been true (a file behind a hidden layer). */
export function useDebrisJson<T>(url: string, when = true): Loaded<T> {
  const [wanted, setWanted] = useState(when);
  const [state, setState] = useState<Loaded<T>>({data: null, error: null});
  if (when && !wanted) setWanted(true);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadJson<T>(url).then(
      data => live && setState({data, error: null}),
      e => live && setState({data: null, error: String(e.message ?? e)})
    );
    return () => {
      live = false;
    };
  }, [url, wanted]);
  return state;
}

/** Shared across fires: web/public/data/debris_flow/model_eval.json. */
export const MODEL_EVAL_URL = '/data/debris_flow/model_eval.json';

/** The fire's segments and stats; `base` is the fire's data folder (FireData.base). */
export function useRiskFiles(base: string, when = true) {
  return {
    segments: useDebrisJson<DebrisFlowSegments>(`${base}/debris_flow.geojson`, when),
    stats: useDebrisJson<DebrisFlowStats>(`${base}/debris_flow_stats.json`, when)
  };
}

type Item = {id: number; path: number[][]; width: number; props: Segment['properties']};

// Stream segments lie in valley bottoms; 12 m above the bilinear DEM clears the mesh (max error 2 m),
// and 40 m steps keep a line on the ground between USGS's vertices.
const LIFT_M = 12;
const STEP_M = 40;
/** Line width in pixels for the smallest and largest upstream area; ≥ 2.5 px so a click lands. */
const WIDTH_PX: [number, number] = [2.5, 7];
const CASING: RGBA = [255, 255, 255, 170];
const overlay = {depthCompare: 'always' as const, depthWriteEnabled: false};
const rgba = ([r, g, b]: RGB, a = 255): RGBA => [r, g, b, a];

/**
 * A key swatch with the map's white casing: the dark classes all but vanish on the key's dark
 * HUD (80–100% is ~1.1:1 against it). SwatchMark paints `color` as the square's background, so
 * one background layer insets the class colour 1 px and the base colour is the casing.
 */
const casedSwatch = (css: string, label: string): Swatch => ({
  color: `linear-gradient(${css}, ${css}) center / calc(100% - 2px) calc(100% - 2px) no-repeat, rgba(255, 255, 255, 0.75)`,
  label,
  shape: 'square'
});

export function useDebrisPart(
  fire: FireData,
  dem: Dem | null,
  layer: LayerDef,
  risk: {model: RiskModel; i15: DesignStorm; segment: number | null},
  setRisk: (patch: {segment: number}) => void
): StagePart {
  const {segments, stats} = useRiskFiles(fire.base, layer.visible);

  // Draped once per dataset; a model or storm change only recolours. Width grows with the square
  // root of upstream area (USGS's areas span over two orders of magnitude, most of them small).
  const items = useMemo<Item[] | null>(() => {
    const fc = segments.data;
    if (!dem || !fc) return null;
    const roots = fc.features.map(f => f.properties.area_km2).filter(a => a > 0).map(Math.sqrt);
    const lo = roots.reduce((a, b) => Math.min(a, b), Infinity);
    const hi = roots.reduce((a, b) => Math.max(a, b), 0);
    const out: Item[] = [];
    for (const f of fc.features) {
      const a = f.properties.area_km2;
      const k = hi > lo && a > 0 ? (Math.sqrt(a) - lo) / (hi - lo) : 0;
      const width = WIDTH_PX[0] + (WIDTH_PX[1] - WIDTH_PX[0]) * Math.min(1, Math.max(0, k));
      // Runs inside the terrain only, so a segment past the DEM's edge is not drawn in the air.
      for (const path of insideRuns(dem, drapeDense(dem, f.geometry.coordinates, LIFT_M, STEP_M)))
        out.push({id: f.properties.id, path, width, props: f.properties});
    }
    return out;
  }, [dem, segments.data]);

  const {model, i15, segment} = risk;
  const missing = useMemo(
    () => (segments.data ? segments.data.features.filter(f => likelihood(f.properties, model, i15) === null).length : 0),
    [segments.data, model, i15]
  );

  return useMemo(() => {
    if (!layer.visible) return NO_PART;
    if (segments.error)
      return {
        ...NO_PART,
        notes: [{id: 'debris', title: 'Debris-flow likelihood unavailable', detail: `debris_flow.geojson did not load (${segments.error})`}]
      };
    if (!items || !segments.data) return NO_PART;
    const m = riskModel(model);
    const opacity = layer.opacity ?? 1;
    const color = (d: Item): RGBA => {
      const p = likelihood(d.props, model, i15);
      return rgba(p === null ? NO_VALUE.rgb : LIKELIHOOD_CLASSES[classOf(p)].rgb);
    };
    const common = {
      getPath: (d: Item) => d.path as any,
      widthUnits: 'pixels' as const,
      capRounded: true,
      jointRounded: true,
      opacity
    };
    const picked = segment !== null ? items.filter(d => d.id === segment) : [];
    const layers: Layer[] = [
      new PathLayer<Item>({...common, id: 'debris-casing', data: items, getColor: CASING, getWidth: d => d.width + 2.5}),
      new PathLayer<Item>({
        ...common,
        id: 'debris',
        data: items,
        getColor: color,
        getWidth: d => d.width,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 220],
        onClick: ({object}: {object?: Item}) => {
          if (object) setRisk({segment: object.id});
          return true;
        },
        updateTriggers: {getColor: [model, i15]}
      })
    ];
    // The selected segment: an ink and white outline over everything, then its own class colour.
    if (picked.length)
      layers.push(
        new PathLayer<Item>({...common, id: 'debris-selected-halo', data: picked, getColor: [39, 35, 26, 235], getWidth: d => d.width + 8, parameters: overlay}),
        new PathLayer<Item>({...common, id: 'debris-selected-ring', data: picked, getColor: [255, 255, 255, 255], getWidth: d => d.width + 4, parameters: overlay}),
        new PathLayer<Item>({
          ...common,
          id: 'debris-selected',
          data: picked,
          getColor: color,
          getWidth: d => d.width,
          parameters: overlay,
          updateTriggers: {getColor: [model, i15]}
        })
      );

    const n = segments.data.features.length;
    const none = missing === n;
    const swatches: Swatch[] = LIKELIHOOD_CLASSES.map(c => casedSwatch(c.css, c.label));
    if (missing) swatches.push(casedSwatch(NO_VALUE.css, NO_VALUE.label));
    const src = stats.data?.source;
    const sc = stats.data?.scenario;
    return {
      layers,
      labels: [],
      notes: [
        {
          id: 'debris',
          tag: 'MODELED',
          title: `Debris-flow likelihood · ${m.short} · I15 ${i15} mm/h${none ? ' · no values' : ''}`,
          detail: [
            `${m.label}: the modeled chance that a debris flow starts from each stream segment's upstream area in a storm whose peak 15-minute rainfall is ${i15} mm/h (${accumulationMm(i15)} mm in 15 minutes)`,
            m.about,
            none
              ? `debris_flow.geojson has no ${pKey(model, i15)} values`
              : missing
                ? `${missing.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} segments have no ${pKey(model, i15)} value (grey)`
                : '',
            model !== 'usgs'
              ? "Calibrated to USGS's observed inventory under a design storm: its level depends on how each sub-inventory sampled storms without a debris flow, and it is not an observed rate for this fire"
              : '',
            model === 'rf' && sc
              ? `The RF map also depends on the scenario: ${sc.date}, ${sc.days_since_fire} days after the fire, and one soil-moisture value for every segment (${
                  sc.soil_moisture_0_7cm === null ? 'not available' : `${sc.soil_moisture_0_7cm.toFixed(3)} m³/m³, 0–7 cm`
                })`
              : '',
            `Line width grows with upstream area. Click a segment for its inputs`,
            src ? `Segments and USGS's likelihoods: ${src.title} (${src.doi}), ${src.license}` : 'Segments and USGS likelihoods: USGS postfire debris-flow hazard assessment',
            "No observed debris-flow records for this fire are in the data used here: the models are compared with USGS's assessment, not checked against outcomes"
          ]
            .filter(Boolean)
            .join('\n'),
          swatches
        }
      ]
    };
  }, [layer.visible, layer.opacity, segments.data, segments.error, stats.data, items, model, i15, segment, missing, setRisk]);
}
