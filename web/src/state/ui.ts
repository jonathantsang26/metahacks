import {create} from 'zustand';

export type Tab = 'incident' | 'drones' | 'risk';
export type ViewMode = '2d' | '3d';

/**
 * DESIGN.md §5.1 layer list, limited to layers this build has data for (no aerial imagery,
 * suppression or administrative boundaries). `ready` is false only if a layer's file is missing.
 */
export type LayerId =
  | 'terrain'
  | 'burnScar'
  | 'fireSpread'
  | 'perimeters'
  | 'ignition'
  | 'spine'
  | 'wind'
  | 'structures'
  | 'roads'
  | 'labels'
  | 'debrisFlow';

export type LayerDef = {
  id: LayerId;
  label: string;
  visible: boolean;
  opacity: number | null;
  ready: boolean;
  /** Why the layer has no data, shown while not ready. */
  pending?: string;
};

export const LAYERS: LayerDef[] = [
  {id: 'terrain', label: 'Terrain (3D)', visible: true, opacity: 1, ready: true},
  {id: 'burnScar', label: 'Burn Scar (dNBR)', visible: true, opacity: 0.9, ready: true},
  {id: 'fireSpread', label: 'Fire Progression (Interpolated)', visible: true, opacity: 1, ready: true},
  {id: 'perimeters', label: 'Mapped Perimeters', visible: true, opacity: null, ready: true},
  {id: 'ignition', label: 'Ignition Probability', visible: true, opacity: 0.8, ready: true},
  {id: 'spine', label: 'Spread Spine', visible: true, opacity: null, ready: true},
  {id: 'wind', label: 'Weather (Wind Vectors)', visible: false, opacity: 0.7, ready: true},
  {id: 'structures', label: 'Structures', visible: false, opacity: null, ready: true},
  {id: 'roads', label: 'Roads & Trails', visible: false, opacity: null, ready: true},
  {id: 'labels', label: 'Place Labels', visible: true, opacity: null, ready: true},
  {id: 'debrisFlow', label: 'Debris-Flow Likelihood', visible: false, opacity: 1, ready: true}
];

/** Debris-flow models shown on the Risk tab (debris_flow.geojson: `<model>_p_<I15>`). */
/** usgs = USGS's published M1; m1 = M1 recalibrated on the inventory; rf = random forest (monotone in rainfall). */
export type RiskModel = 'usgs' | 'm1' | 'rf';
/** USGS's design storms: peak 15-minute rainfall intensity, mm/h. */
export const DESIGN_I15 = [16, 20, 24, 28, 32, 36, 40] as const;

export type Hover = {
  x: number;
  y: number;
  lon: number;
  lat: number;
} | null;

/** A request for the stage to ease the camera somewhere; `seq` makes repeated requests distinct. */
export type FlyTo = {lon: number; lat: number; zoom?: number; seq: number} | null;

/** A place to mark on the map while the pointer is over something that cites it (a citation chip). */
export type Highlight = {lon: number; lat: number; label?: string} | null;

type UiState = {
  tab: Tab;
  viewMode: ViewMode;
  bearing: number;
  layers: Record<LayerId, LayerDef>;
  hover: Hover;
  flyTo: FlyTo;
  highlight: Highlight;
  /** Structure id picked on the map (Analysis → Homes). */
  selectedStructure: number | null;
  /** Risk tab: which debris-flow model colours the segments, under which design storm. */
  risk: {model: RiskModel; i15: (typeof DESIGN_I15)[number]; segment: number | null};
  setTab: (tab: Tab) => void;
  setViewMode: (mode: ViewMode) => void;
  setBearing: (bearing: number) => void;
  setLayer: (id: LayerId, patch: Partial<Pick<LayerDef, 'visible' | 'opacity'>>) => void;
  setHover: (hover: Hover) => void;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  setHighlight: (highlight: Highlight) => void;
  selectStructure: (id: number | null) => void;
  setRisk: (patch: Partial<UiState['risk']>) => void;
};

/** `?tab=risk` opens a tab directly, for shareable links; Drones has no data, so it is never opened. */
const TAB_PARAM = new URLSearchParams(location.search).get('tab');
const INITIAL_TAB: Tab = TAB_PARAM === 'risk' ? 'risk' : 'incident';

export const useUi = create<UiState>(set => ({
  tab: INITIAL_TAB,
  viewMode: '3d',
  bearing: 0,
  layers: Object.fromEntries(
    LAYERS.map(l => [l.id, l.id === 'debrisFlow' && INITIAL_TAB === 'risk' ? {...l, visible: true} : l])
  ) as Record<LayerId, LayerDef>,
  hover: null,
  flyTo: null,
  highlight: null,
  selectedStructure: null,
  risk: {model: 'usgs', i15: 24, segment: null},
  setTab: tab => set(s => ({tab, layers: tab === 'risk' ? {...s.layers, debrisFlow: {...s.layers.debrisFlow, visible: true}} : s.layers})),
  setViewMode: viewMode => set({viewMode}),
  setBearing: bearing => set({bearing}),
  setLayer: (id, patch) => set(s => ({layers: {...s.layers, [id]: {...s.layers[id], ...patch}}})),
  setHover: hover => set({hover}),
  requestFlyTo: (lon, lat, zoom) => set(s => ({flyTo: {lon, lat, zoom, seq: (s.flyTo?.seq ?? 0) + 1}})),
  setHighlight: highlight => set({highlight}),
  selectStructure: selectedStructure => set({selectedStructure}),
  setRisk: patch => set(s => ({risk: {...s.risk, ...patch}}))
}));
