import {actionErrorMessage, callAction, useActionQuery} from '@agent-native/core/client/hooks';
import {keepPreviousData, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useMemo} from 'react';
import {useSearchParams} from 'react-router';
import {applyOverrides, selectPlanDrone, setOverride, setPlanError, usePlanUi} from './store';
import {normalizeBundle, normalizeFront, normalizeHindsight, normalizeWindCells, type WindCell, type Assignment, type LonLat, type PlanBundle} from './types';

export const FIRE_LABEL: Record<string, string> = {eaton: 'Eaton', palisades: 'Palisades'};
/** Both replay fires are in Los Angeles County. */
export const FIRE_TZ = 'America/Los_Angeles';
export const MAX_DRONES = 6;

/** Untyped action call: the plan actions are being written in parallel, so names stay strings here. */
export function act<T = unknown>(name: string, params: Record<string, unknown>, method?: 'GET' | 'POST'): Promise<T> {
  return callAction<T>(name, params as never, method ? {method} : undefined) as Promise<T>;
}

export function errorText(e: unknown): string {
  return actionErrorMessage(e) ?? (e instanceof Error ? e.message : String(e));
}

/** The fire and time this screen shows: props win, else the shareable URL params (same as the Meta build). */
export function usePlanContext(props?: {fire?: string | undefined; t?: string | undefined}) {
  const [params] = useSearchParams();
  const fire = props?.fire ?? params.get('fire') ?? 'eaton';
  const raw = props?.t ?? params.get('t') ?? '';
  const ms = Date.parse(raw);
  const t = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  return {fire, t};
}

/** "Jan 8, 15:30 PST" */
export function fireTime(iso: string | null | undefined, opts: {date?: boolean} = {}): string {
  if (!iso) return '–';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: FIRE_TZ,
    ...(opts.date === false ? {} : {month: 'short', day: 'numeric'}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  });
  return f.format(ms);
}

export function addHours(iso: string, h: number): string {
  return new Date(Date.parse(iso) + h * 3600_000).toISOString();
}

/** t floored to the clock hour, "2025-01-08T23:00:00Z". */
export function hourOf(t: string | null): string {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString().replace('.000Z', 'Z') : '';
}

const EMPTY: PlanBundle = {plan: null, assignments: [], score: null, briefing: null};

/** get-drone-plan for (fire, t), normalized, with local optimistic edits applied to the drones. */
export function usePlanData(fire: string, t: string | null, opts: {planId?: string} = {}) {
  // One plan per fire per clock hour (server/plan/service.ts hourKey), so every caller in the
  // hour shares one query instead of refetching as the clock moves within it.
  const hour = hourOf(t);
  const params = opts.planId ? {planId: opts.planId} : {fire, t: hour};
  const q = useActionQuery<unknown>('get-drone-plan', params as never, {
    enabled: !!opts.planId || !!t,
    placeholderData: keepPreviousData,
    retry: 1
  });
  const bundle = useMemo(() => (q.data ? normalizeBundle(q.data) : EMPTY), [q.data]);
  const overrides = usePlanUi(s => s.overrides);
  const dragging = usePlanUi(s => s.dragging);
  const assignments = useMemo(() => applyOverrides(bundle.assignments, overrides, dragging), [bundle.assignments, overrides, dragging]);
  return {
    ...bundle,
    assignments,
    serverAssignments: bundle.assignments,
    loading: q.isLoading,
    fetching: q.isFetching,
    error: q.error ? errorText(q.error) : null,
    // A missing action (plan-domain not merged yet) reads as "no plan" with a note.
    missing: !!q.error && /not.?found|404|unknown action/i.test(errorText(q.error))
  };
}

/** The cached +1 h forecast front (data-actions `get-forecast-front`), used when the score has no segments. */
export function useForecastFront(fire: string, t: string | null) {
  // Forecasts are issued at the top of the hour, so the hour is enough for the key.
  const q = useActionQuery<unknown>('get-forecast-front', {fire, t: hourOf(t)} as never, {
    enabled: !!t,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 5 * 60_000
  });
  return useMemo(() => (q.data ? normalizeFront(q.data) : null), [q.data]);
}

/**
 * Wind cells for the hour: plan-domain's `flyable-cells` read when it exists, else the score's
 * windCells (only there once a plan exists). A missing action just falls back, without retries.
 */
export function useWindCells(fire: string, t: string | null, fromScore: WindCell[] | null | undefined): WindCell[] {
  const q = useActionQuery<unknown>('flyable-cells', {fire, t: hourOf(t)} as never, {enabled: !!t, retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false});
  return useMemo(() => {
    const cells = q.data ? normalizeWindCells(q.data) : [];
    return cells.length ? cells : (fromScore ?? []);
  }, [q.data, fromScore]);
}

export function useHindsight(planId: string | null | undefined, enabled: boolean) {
  const q = useActionQuery<unknown>('hindsight-check', {planId: planId ?? ''} as never, {enabled: enabled && !!planId, retry: 1, staleTime: 5 * 60_000});
  return {data: useMemo(() => (q.data ? normalizeHindsight(q.data) : null), [q.data]), loading: q.isLoading, error: q.error ? errorText(q.error) : null};
}

/** Next unused id in D1..D6, or null when the plan is full. */
export function nextDroneId(list: Pick<Assignment, 'droneId'>[]): string | null {
  const used = new Set(list.map(a => a.droneId));
  for (let i = 1; i <= MAX_DRONES; i++) if (!used.has(`D${i}`)) return `D${i}`;
  return null;
}

/** Point on the front farthest from every existing drone (the "next free spot"). */
export function freeSpotOnFront(paths: LonLat[][], drones: Pick<Assignment, 'lon' | 'lat'>[]): LonLat | null {
  const pts = paths.flat();
  if (!pts.length) return null;
  if (!drones.length) {
    const longest = paths.reduce((a, b) => (b.length > a.length ? b : a), paths[0]!);
    return longest[Math.floor(longest.length / 2)] ?? null;
  }
  const kx = Math.cos(((pts[0]![1]) * Math.PI) / 180);
  let best: LonLat | null = null;
  let bestD = -1;
  for (const p of pts) {
    let d = Infinity;
    for (const a of drones) d = Math.min(d, ((p[0] - a.lon) * kx) ** 2 + (p[1] - a.lat) ** 2);
    if (d > bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * update-drone-assignment with optimistic UI: the local override shows at once, the action
 * commits, the plan query refetches (so the score updates), then the override is dropped. On
 * failure the override is rolled back and the error shown.
 */
export function useUpdateDrone() {
  const qc = useQueryClient();
  return useCallback(
    async (input: {planId: string; droneId: string; lon?: number; lat?: number; radiusM?: number; locked?: boolean; reason?: string; remove?: boolean}, optimistic?: Parameters<typeof setOverride>[1]) => {
      if (optimistic) setOverride(input.droneId, optimistic);
      setPlanError(null);
      try {
        const res = await act('update-drone-assignment', input, 'POST');
        await qc.invalidateQueries({queryKey: ['action']});
        return res;
      } catch (e) {
        setPlanError(`${input.droneId}: ${errorText(e)}`);
        return null;
      } finally {
        if (optimistic) setOverride(input.droneId, null);
      }
    },
    [qc]
  );
}

/** Clears the selection when the selected drone leaves the plan on screen (removed by anyone). */
export function useSelectionGuard(planId: string | null, assignments: Assignment[], loaded: boolean) {
  const selected = usePlanUi(s => s.selected);
  const overrides = usePlanUi(s => s.overrides);
  useEffect(() => {
    if (!selected || !planId || !loaded || selected.planId !== planId) return;
    if (overrides[selected.droneId]) return; // a pending edit, not a removal
    if (!assignments.some(a => a.droneId === selected.droneId)) selectPlanDrone(null, null);
  }, [selected, planId, assignments, loaded, overrides]);
}
