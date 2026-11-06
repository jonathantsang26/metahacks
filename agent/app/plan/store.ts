import {create} from 'zustand';
import {clearSelection, registerDroneLocator, selectDrone, setActivePlanId, useIncidentNav} from '@/sentinel/agent/context';
import {useUi} from '@/sentinel/state/ui';
import {useEffect, useRef} from 'react';
import type {Assignment} from './types';

/** A local edit shown before the server confirms it (optimistic UI). */
export type DroneOverride = {lon?: number; lat?: number; locked?: boolean; removed?: boolean};

type PlanUiState = {
  /** Mirrors the incident screen's selected drone (app/sentinel/agent/context.ts). */
  selected: {planId: string; droneId: string} | null;
  /** Drone under the pointer: the map should stop drag-panning so the marker can be dragged. */
  hoverDroneId: string | null;
  /** Drone being dragged and its live position. */
  dragging: {droneId: string; lon: number; lat: number} | null;
  /** Click-to-move fallback: the next map click moves this drone. */
  moveArmed: string | null;
  overrides: Record<string, DroneOverride>;
  error: string | null;
  /** Guide progress the server cannot see. */
  movedByHand: boolean;
  askedAboutDrone: boolean;
};

const selectedOf = (s: {planId: string | null; selectedDroneId: string | null}) => (s.planId && s.selectedDroneId ? {planId: s.planId, droneId: s.selectedDroneId} : null);

export const usePlanUi = create<PlanUiState>(() => ({
  selected: selectedOf(useIncidentNav.getState()),
  hoverDroneId: null,
  dragging: null,
  moveArmed: null,
  overrides: {},
  error: null,
  movedByHand: false,
  askedAboutDrone: false
}));

// One selection for the screen: the incident store owns it (the agent's select-drone command lands
// there too); the plan UI mirrors it for highlighting.
useIncidentNav.subscribe(s => {
  const next = selectedOf(s);
  const cur = usePlanUi.getState().selected;
  if (cur?.planId !== next?.planId || cur?.droneId !== next?.droneId) usePlanUi.setState({selected: next});
});

export function setOverride(droneId: string, o: DroneOverride | null) {
  usePlanUi.setState(s => {
    const next = {...s.overrides};
    if (o) next[droneId] = {...next[droneId], ...o};
    else delete next[droneId];
    return {overrides: next};
  });
}

export function setPlanError(error: string | null) {
  usePlanUi.setState({error});
}

/** Assignments with local, not-yet-confirmed edits applied. */
export function applyOverrides(list: Assignment[], overrides: Record<string, DroneOverride>, dragging: PlanUiState['dragging']): Assignment[] {
  const out: Assignment[] = [];
  for (const a of list) {
    const o = overrides[a.droneId];
    if (o?.removed) continue;
    let next = o ? {...a, ...(o.lon !== undefined && o.lat !== undefined ? {lon: o.lon, lat: o.lat} : {}), ...(o.locked !== undefined ? {locked: o.locked} : {})} : a;
    if (dragging?.droneId === a.droneId) next = {...next, lon: dragging.lon, lat: dragging.lat};
    out.push(next);
  }
  return out;
}

/** Fly the map camera (the incident screen's own fly-to, same as the agent's fly-to command). */
export function requestFlyTo(lon: number, lat: number, zoom?: number) {
  useUi.getState().requestFlyTo(lon, lat, zoom);
}

/**
 * Select a drone (or clear with null): highlight, `navigation.selectedDroneId`, and the
 * `selection` app-state key the agent reads, through the incident screen's helpers. Flies there
 * unless `fly: false`.
 */
export function selectPlanDrone(planId: string | null, drone: Pick<Assignment, 'droneId' | 'lon' | 'lat' | 'reason'> | null, opts: {fly?: boolean} = {}) {
  if (!planId || !drone) {
    usePlanUi.setState({moveArmed: null});
    clearSelection();
    return;
  }
  selectDrone({planId, droneId: drone.droneId, lon: drone.lon, lat: drone.lat, label: drone.reason ? `${drone.droneId}: ${drone.reason}` : `Drone ${drone.droneId}`});
  if (opts.fly !== false) requestFlyTo(drone.lon, drone.lat);
}

/**
 * Tells the incident screen which plan is on screen (navigation.planId) and how to find a drone's
 * position, so the agent's select-drone command (ids only) can write a full selection.
 */
export function usePlanBridge(planId: string | null, assignments: Assignment[]) {
  const latest = useRef(assignments);
  latest.current = assignments;
  useEffect(() => {
    setActivePlanId(planId);
  }, [planId]);
  useEffect(
    () =>
      registerDroneLocator((pid, droneId) => {
        if (pid !== planId) return null;
        const a = latest.current.find(x => x.droneId === droneId);
        return a ? {lon: a.lon, lat: a.lat, label: a.reason ? `${a.droneId}: ${a.reason}` : `Drone ${a.droneId}`} : null;
      }),
    [planId]
  );
}
