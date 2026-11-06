import type {ActionRunContext} from '@agent-native/core/action';
import {and, asc, eq} from 'drizzle-orm';
import {fireStore} from '../fire/actions-support.js';
import type {FireStore} from '../fire/data.js';
import {isoUtc, parseTime} from '../fire/time.js';
import {getDb} from '../db/index.js';
import {briefings, droneAssignments, dronePlans, type BriefingParagraph, type DroppedParagraph} from '../db/schema.js';
import {scorePlanAt, type PlanScore} from './score.js';

/** Shared plumbing for the plan-domain actions. */

export {FIRES, type FireId} from '../fire/actions-support.js';
import type {FireId} from '../fire/actions-support.js';
export const DRONE_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const;
export type DroneId = (typeof DRONE_IDS)[number];
export const MAX_DRONES = DRONE_IDS.length;
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 600;

export type Editor = 'agent' | 'person';

/** Plans are a team's shared work product: scoped to the request's org ('' when there is none). */
export function orgOf(ctx?: ActionRunContext): string {
  return ctx?.orgId ?? '';
}

/**
 * Who made the change, from the run context: the in-app agent, external agents and automations
 * are "agent"; the browser and plain HTTP are "person". The CLI is how coding agents drive the
 * app in development, so it counts as "agent".
 */
export function editorOf(ctx?: ActionRunContext): Editor {
  const c = ctx?.caller;
  return c === 'frontend' || c === 'http' || c === 'mcp-widget' || c === 'mcp-widget-write' ? 'person' : 'agent';
}

export const nowIso = () => new Date().toISOString();

/** The fire's data store (FIRE_DATA_ROOT aware); fails with data_missing when the files are absent. */
export function store(fire: string): FireStore {
  return fireStore(fire as FireId);
}

/** Parses t, rounds to the minute, and checks it is inside the fire's replay window. */
export function parsePlanTime(fire: string, t: string): {ms: number; iso: string; hourKey: string} | {error: string} {
  const p = parseTime(t);
  if (!p) return {error: `t must be an ISO-8601 UTC time such as 2025-01-08T23:30:00Z (got ${JSON.stringify(t)})`};
  const ms = Math.round(p.ms / 60_000) * 60_000;
  const s = store(fire);
  const w0 = Date.parse(s.aoi().window_utc[0]);
  const w1 = Date.parse(s.aoi().window_utc[1]);
  if (ms < w0 || ms > w1) return {error: `t ${isoUtc(ms)} is outside the ${fire} replay window ${isoUtc(w0)} to ${isoUtc(w1)}`};
  return {ms, iso: isoUtc(ms), hourKey: isoUtc(Math.floor(ms / 3.6e6) * 3.6e6)};
}

export function inFireBbox(fire: string, lon: number, lat: number): boolean {
  const [w, s, e, n] = store(fire).aoi().bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

export type PlanRow = typeof dronePlans.$inferSelect;
export type AssignmentRow = typeof droneAssignments.$inferSelect;
export type BriefingRow = typeof briefings.$inferSelect;

export type PlanView = {
  id: string;
  fire: string;
  t: string;
  hourKey: string;
  status: 'draft' | 'approved';
  approvedAt: string | null;
  updatedAt: string;
  updatedBy: Editor;
};
export type AssignmentView = {droneId: string; lon: number; lat: number; radiusM: number; locked: boolean; reason: string; updatedAt: string; updatedBy: Editor};
export type BriefingView = {id: string; planId: string; paragraphs: BriefingParagraph[]; dropped: DroppedParagraph[]; updatedAt: string; updatedBy: Editor};
export type PlanBundle = {plan: PlanView; assignments: AssignmentView[]; score: PlanScore; briefing: BriefingView | null};

export const planView = (p: PlanRow): PlanView => ({
  id: p.id,
  fire: p.fire,
  t: p.t,
  hourKey: p.hourKey,
  status: p.status,
  approvedAt: p.approvedAt,
  updatedAt: p.updatedAt,
  updatedBy: p.updatedBy
});
const assignmentView = (a: AssignmentRow): AssignmentView => ({
  droneId: a.droneId,
  lon: a.lon,
  lat: a.lat,
  radiusM: a.radiusM,
  locked: a.locked,
  reason: a.reason,
  updatedAt: a.updatedAt,
  updatedBy: a.updatedBy
});
export const briefingView = (b: BriefingRow): BriefingView => ({
  id: b.id,
  planId: b.planId,
  paragraphs: b.paragraphs,
  dropped: b.dropped,
  updatedAt: b.updatedAt,
  updatedBy: b.updatedBy
});

export async function findPlan(org: string, planId: string): Promise<PlanRow | null> {
  const rows = await getDb()
    .select()
    .from(dronePlans)
    .where(and(eq(dronePlans.id, planId), eq(dronePlans.orgId, org)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPlanByHour(org: string, fire: string, hourKey: string): Promise<PlanRow | null> {
  const rows = await getDb()
    .select()
    .from(dronePlans)
    .where(and(eq(dronePlans.orgId, org), eq(dronePlans.fire, fire), eq(dronePlans.hourKey, hourKey)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAssignments(planId: string): Promise<AssignmentRow[]> {
  return getDb().select().from(droneAssignments).where(eq(droneAssignments.planId, planId)).orderBy(asc(droneAssignments.droneId));
}

export async function findBriefing(planId: string): Promise<BriefingRow | null> {
  const rows = await getDb().select().from(briefings).where(eq(briefings.planId, planId)).limit(1);
  return rows[0] ?? null;
}

export function scoreFor(plan: Pick<PlanRow, 'fire' | 't'>, assignments: Pick<AssignmentRow, 'droneId' | 'lon' | 'lat' | 'radiusM'>[]): PlanScore {
  return scorePlanAt(
    store(plan.fire),
    Date.parse(plan.t),
    assignments.map(a => ({droneId: a.droneId, lon: a.lon, lat: a.lat, radiusM: a.radiusM}))
  );
}

export async function bundle(plan: PlanRow): Promise<PlanBundle> {
  const [assignments, briefing] = await Promise.all([listAssignments(plan.id), findBriefing(plan.id)]);
  return {
    plan: planView(plan),
    assignments: assignments.map(assignmentView),
    score: scoreFor(plan, assignments),
    briefing: briefing ? briefingView(briefing) : null
  };
}

/** A one-line summary of a score, for messages and view-screen. */
export function scoreLine(s: PlanScore): string {
  if (!s.forecast) return 'No forecast covers this hour, so the plan cannot be scored.';
  return `${s.method} forecast: ${s.coveredKm} of ${s.frontKm} km of front in view (${s.frontCoveragePct}%; fast-moving front ${s.fastCoveredKm} of ${s.fastFrontKm} km, ${s.fastCoveragePct}%), ${s.homesWatched} of ${s.homesNearFront} homes near the front watched, ${s.groundedCount} drone(s) grounded by gusts over ${s.gustLimitMs} m/s.`;
}

export function nextId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
