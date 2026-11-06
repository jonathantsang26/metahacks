/**
 * What the agent sees of the incident screen (docs/CONTRACTS.md, "Application state keys").
 *
 * - `navigation` is written by the app's one route-state hook (app/hooks/use-navigation-state.ts),
 *   which merges `useIncidentNav` below into its state while /incident is open. The incident screen
 *   feeds this store from its zustand stores (time scrubbing debounced, see IncidentSync).
 * - `selection` is written here, tab-scoped (`selection:<TAB_ID>`), when the user clicks a map
 *   point or a drone is selected (by the plan UI or by the agent's `select-drone` map command).
 *
 * This module is SSR-safe (no window access at import) because root.tsx imports it.
 */
import {setClientAppState} from '@agent-native/core/client/hooks';
import {create} from 'zustand';
import {TAB_ID} from '@/lib/tab-id';

export type IncidentTab = 'incident' | 'drones' | 'risk';

export type IncidentNavigation = {
  view: 'incident';
  fire: string;
  /** ISO UTC. */
  t: string;
  tab: IncidentTab;
  planId: string | null;
  selectedDroneId: string | null;
  visibleLayers: string[];
};

export type DroneSelection = {
  kind: 'drone';
  planId: string;
  droneId: string;
  label: string;
  lon: number;
  lat: number;
  capturedAt: string;
};
export type MapPointSelection = {kind: 'map-point'; lon: number; lat: number; label: string; capturedAt: string};
export type IncidentSelection = DroneSelection | MapPointSelection;

type IncidentNavStore = {
  /** null while /incident is not mounted (or the fire is still loading). */
  nav: Omit<IncidentNavigation, 'planId' | 'selectedDroneId'> | null;
  /** The plan the rail shows; set by the plan UI with `setActivePlanId`. */
  planId: string | null;
  selectedDroneId: string | null;
  selection: IncidentSelection | null;
};

export const useIncidentNav = create<IncidentNavStore>(() => ({
  nav: null,
  planId: null,
  selectedDroneId: null,
  selection: null
}));

/** Navigation state for /incident, or null before the screen has loaded its fire. */
export function incidentNavigationState(s: IncidentNavStore): IncidentNavigation | null {
  if (!s.nav) return null;
  return {...s.nav, planId: s.planId, selectedDroneId: s.selectedDroneId};
}

/** Called by the incident screen (debounced for `t`). Keeps array identity when unchanged. */
export function setIncidentNav(next: IncidentNavStore['nav']) {
  const prev = useIncidentNav.getState().nav;
  if (
    prev &&
    next &&
    prev.fire === next.fire &&
    prev.t === next.t &&
    prev.tab === next.tab &&
    prev.visibleLayers.join(',') === next.visibleLayers.join(',')
  )
    return;
  useIncidentNav.setState({nav: next});
}

function writeSelection(selection: IncidentSelection | null) {
  useIncidentNav.setState({selection});
  setClientAppState(`selection:${TAB_ID}`, selection, {requestSource: TAB_ID}).catch(() => {
    // A dropped selection write only means the agent sees the previous selection.
  });
}

/** Tell the agent which plan the rail is showing (plan UI). */
export function setActivePlanId(planId: string | null) {
  if (useIncidentNav.getState().planId === planId) return;
  useIncidentNav.setState({planId});
}

/**
 * Select a drone of a plan: highlights it in navigation (`selectedDroneId`, `planId`) and writes
 * the `selection` app-state key so the agent can act on "this drone". The plan UI calls this when
 * the user clicks a drone row or watch point; the incident screen calls it for the agent's
 * `select-drone` map command (with the position from `registerDroneLocator`, if any).
 */
export function selectDrone(d: {planId: string; droneId: string; lon?: number; lat?: number; label?: string}) {
  useIncidentNav.setState({planId: d.planId, selectedDroneId: d.droneId});
  const located = d.lon === undefined || d.lat === undefined ? droneLocator?.(d.planId, d.droneId) : null;
  const lon = d.lon ?? located?.lon;
  const lat = d.lat ?? located?.lat;
  if (lon === undefined || lat === undefined) return;
  writeSelection({
    kind: 'drone',
    planId: d.planId,
    droneId: d.droneId,
    label: d.label ?? located?.label ?? `Drone ${d.droneId}`,
    lon,
    lat,
    capturedAt: new Date().toISOString()
  });
}

/** Clear the drone highlight and the selection (e.g. the selected drone was removed). */
export function clearSelection() {
  useIncidentNav.setState({selectedDroneId: null});
  writeSelection(null);
}

/** The user clicked a point on the map. */
export function selectMapPoint(lon: number, lat: number, label?: string) {
  useIncidentNav.setState({selectedDroneId: null});
  writeSelection({
    kind: 'map-point',
    lon,
    lat,
    label: label ?? `Map point ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    capturedAt: new Date().toISOString()
  });
}

/** The selected drone id (and its plan), for the plan UI to highlight. */
export const useSelectedDrone = () => {
  const planId = useIncidentNav(s => s.planId);
  const droneId = useIncidentNav(s => s.selectedDroneId);
  return {planId, droneId};
};

type DroneLocator = (planId: string, droneId: string) => {lon: number; lat: number; label?: string} | null;
let droneLocator: DroneLocator | null = null;

/**
 * The plan UI may register how to find a drone's watch point, so an agent `select-drone` command
 * (which carries only ids) can still write a full `selection`. Returns an unregister function.
 */
export function registerDroneLocator(locate: DroneLocator): () => void {
  droneLocator = locate;
  return () => {
    if (droneLocator === locate) droneLocator = null;
  };
}
