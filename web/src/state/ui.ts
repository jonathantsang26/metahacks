import {create} from 'zustand';

export type Tab = 'incident' | 'drones' | 'resources';
export type ViewMode = '2d' | '3d';

/** DESIGN.md §5.1 layer list. `ready` is false when this build has no data for the layer. */
export type LayerId =
  | 'terrain'
  | 'imagery'
  | 'burnScar'
  | 'fireSpread'
  | 'perimeters'
  | 'ignition'
  | 'spine'
  | 'wind'
  | 'suppression'
  | 'structures'
  | 'roads'
  | 'labels'
  | 'boundaries';

export type LayerDef = {
  id: LayerId;
  label: string;
  visible: boolean;
  opacity: number | null;
  ready: boolean;
  /** Why the layer has no data yet, shown while not ready. */
  pending?: string;
};

export const LAYERS: LayerDef[] = [
  {id: 'terrain', label: 'Terrain (3D)', visible: true, opacity: 1, ready: true},
  {id: 'imagery', label: 'Aerial Imagery', visible: false, opacity: 1, ready: false, pending: 'no imagery source'},
  {id: 'burnScar', label: 'Burn Scar (dNBR)', visible: true, opacity: 0.9, ready: true},
  {id: 'fireSpread', label: 'Fire Spread (Modeled)', visible: true, opacity: 1, ready: true},
  {id: 'perimeters', label: 'Mapped Perimeters', visible: true, opacity: null, ready: true},
  {id: 'ignition', label: 'Ignition Probability', visible: true, opacity: 0.8, ready: true},
  {id: 'spine', label: 'Spread Spine', visible: true, opacity: null, ready: true},
  {id: 'wind', label: 'Weather (Wind Vectors)', visible: false, opacity: 0.7, ready: true},
  {id: 'suppression', label: 'Suppression (Drops & Line)', visible: false, opacity: null, ready: false, pending: 'stretch goal'},
  {id: 'structures', label: 'Structures', visible: false, opacity: null, ready: true},
  {id: 'roads', label: 'Roads & Trails', visible: false, opacity: null, ready: true},
  {id: 'labels', label: 'Place Labels', visible: true, opacity: null, ready: true},
  {id: 'boundaries', label: 'Administrative Boundaries', visible: false, opacity: null, ready: false, pending: 'not in this build'}
];

export type Hover = {
  x: number;
  y: number;
  lon: number;
  lat: number;
} | null;

/** A request for the stage to ease the camera somewhere; `seq` makes repeated requests distinct. */
export type FlyTo = {lon: number; lat: number; zoom?: number; seq: number} | null;

type UiState = {
  tab: Tab;
  viewMode: ViewMode;
  bearing: number;
  layers: Record<LayerId, LayerDef>;
  hover: Hover;
  flyTo: FlyTo;
  /** Structure id picked on the map (Analysis → Homes). */
  selectedStructure: number | null;
  setTab: (tab: Tab) => void;
  setViewMode: (mode: ViewMode) => void;
  setBearing: (bearing: number) => void;
  setLayer: (id: LayerId, patch: Partial<Pick<LayerDef, 'visible' | 'opacity'>>) => void;
  setHover: (hover: Hover) => void;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  selectStructure: (id: number | null) => void;
};

export const useUi = create<UiState>(set => ({
  tab: 'incident',
  viewMode: '3d',
  bearing: 0,
  layers: Object.fromEntries(LAYERS.map(l => [l.id, l])) as Record<LayerId, LayerDef>,
  hover: null,
  flyTo: null,
  selectedStructure: null,
  setTab: tab => set({tab}),
  setViewMode: viewMode => set({viewMode}),
  setBearing: bearing => set({bearing}),
  setLayer: (id, patch) => set(s => ({layers: {...s.layers, [id]: {...s.layers[id], ...patch}}})),
  setHover: hover => set({hover}),
  requestFlyTo: (lon, lat, zoom) => set(s => ({flyTo: {lon, lat, zoom, seq: (s.flyTo?.seq ?? 0) + 1}})),
  selectStructure: selectedStructure => set({selectedStructure})
}));
