import {create} from 'zustand';

export type Tab = 'incident' | 'drones' | 'resources';
export type ViewMode = '2d' | '3d';

/** DESIGN.md §5.1 layer list. `ready` is false until the pipeline step that feeds it exists. */
export type LayerId =
  | 'terrain'
  | 'imagery'
  | 'burnScar'
  | 'fireSpread'
  | 'ignition'
  | 'wind'
  | 'suppression'
  | 'structures'
  | 'roads'
  | 'boundaries';

export type LayerDef = {
  id: LayerId;
  label: string;
  visible: boolean;
  opacity: number | null;
  ready: boolean;
  /** Pipeline step that produces the data, shown while not ready. */
  step?: string;
};

export const LAYERS: LayerDef[] = [
  {id: 'terrain', label: 'Terrain (3D)', visible: true, opacity: 1, ready: true},
  {id: 'imagery', label: 'Aerial Imagery', visible: true, opacity: 1, ready: false, step: '08'},
  {id: 'burnScar', label: 'Burn Scar (dNBR)', visible: true, opacity: 0.9, ready: false, step: '08'},
  {id: 'fireSpread', label: 'Fire Spread', visible: true, opacity: 1, ready: true},
  {id: 'ignition', label: 'Ignition Probability', visible: true, opacity: 0.8, ready: false, step: '11'},
  {id: 'wind', label: 'Weather (Wind Vectors)', visible: false, opacity: 0.7, ready: false, step: '07'},
  {id: 'suppression', label: 'Suppression (Drops & Line)', visible: true, opacity: null, ready: false, step: '13'},
  {id: 'structures', label: 'Structures', visible: false, opacity: null, ready: false, step: '09'},
  {id: 'roads', label: 'Roads & Trails', visible: false, opacity: null, ready: false, step: '09'},
  {id: 'boundaries', label: 'Administrative Boundaries', visible: false, opacity: null, ready: false, step: '09'}
];

export type Hover = {
  x: number;
  y: number;
  lon: number;
  lat: number;
} | null;

type UiState = {
  tab: Tab;
  viewMode: ViewMode;
  bearing: number;
  layers: Record<LayerId, LayerDef>;
  hover: Hover;
  setTab: (tab: Tab) => void;
  setViewMode: (mode: ViewMode) => void;
  setBearing: (bearing: number) => void;
  setLayer: (id: LayerId, patch: Partial<Pick<LayerDef, 'visible' | 'opacity'>>) => void;
  setHover: (hover: Hover) => void;
};

export const useUi = create<UiState>(set => ({
  tab: 'incident',
  viewMode: '3d',
  bearing: 0,
  layers: Object.fromEntries(LAYERS.map(l => [l.id, l])) as Record<LayerId, LayerDef>,
  hover: null,
  setTab: tab => set({tab}),
  setViewMode: viewMode => set({viewMode}),
  setBearing: bearing => set({bearing}),
  setLayer: (id, patch) => set(s => ({layers: {...s.layers, [id]: {...s.layers[id], ...patch}}})),
  setHover: hover => set({hover})
}));
