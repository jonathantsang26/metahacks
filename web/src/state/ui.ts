import {create} from 'zustand';

export type Tab = 'incident' | 'drones' | 'resources';
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
  | 'labels';

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
  {id: 'labels', label: 'Place Labels', visible: true, opacity: null, ready: true}
];

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
  setTab: (tab: Tab) => void;
  setViewMode: (mode: ViewMode) => void;
  setBearing: (bearing: number) => void;
  setLayer: (id: LayerId, patch: Partial<Pick<LayerDef, 'visible' | 'opacity'>>) => void;
  setHover: (hover: Hover) => void;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  setHighlight: (highlight: Highlight) => void;
  selectStructure: (id: number | null) => void;
};

export const useUi = create<UiState>(set => ({
  tab: 'incident',
  viewMode: '3d',
  bearing: 0,
  layers: Object.fromEntries(LAYERS.map(l => [l.id, l])) as Record<LayerId, LayerDef>,
  hover: null,
  flyTo: null,
  highlight: null,
  selectedStructure: null,
  setTab: tab => set({tab}),
  setViewMode: viewMode => set({viewMode}),
  setBearing: bearing => set({bearing}),
  setLayer: (id, patch) => set(s => ({layers: {...s.layers, [id]: {...s.layers[id], ...patch}}})),
  setHover: hover => set({hover}),
  requestFlyTo: (lon, lat, zoom) => set(s => ({flyTo: {lon, lat, zoom, seq: (s.flyTo?.seq ?? 0) + 1}})),
  setHighlight: highlight => set({highlight}),
  selectStructure: selectedStructure => set({selectedStructure})
}));
