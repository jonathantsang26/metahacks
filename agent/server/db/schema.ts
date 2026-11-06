import {sql} from 'drizzle-orm';
import {boolean, doublePrecision, index, jsonb, pgTable, text, uniqueIndex} from 'drizzle-orm/pg-core';

/**
 * Drone planning for a replayed fire. Plans are a team's shared incident work product, scoped
 * by organization (org_id = '' when the request has no org, as in local dev with auth off).
 * Times are UTC ISO strings. updated_by is "agent" or "person", from the action run context.
 */

/** One plan per (org, fire, hour). hour_key is t floored to the hour. */
export const dronePlans = pgTable(
  'drone_plans',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().default(''),
    fire: text('fire').notNull(),
    hourKey: text('hour_key').notNull(),
    t: text('t').notNull(),
    status: text('status', {enum: ['draft', 'approved']}).notNull().default('draft'),
    approvedAt: text('approved_at'),
    createdAt: text('created_at').notNull().default(sql`now()`),
    updatedAt: text('updated_at').notNull().default(sql`now()`),
    updatedBy: text('updated_by', {enum: ['agent', 'person']}).notNull().default('person')
  },
  table => [uniqueIndex('drone_plans_org_fire_hour').on(table.orgId, table.fire, table.hourKey)]
);

/** Drones D1..D6 of a plan: a watch point and the radius of ground its camera keeps in view. */
export const droneAssignments = pgTable(
  'drone_assignments',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    droneId: text('drone_id').notNull(),
    lon: doublePrecision('lon').notNull(),
    lat: doublePrecision('lat').notNull(),
    radiusM: doublePrecision('radius_m').notNull().default(400),
    locked: boolean('locked').notNull().default(false),
    reason: text('reason').notNull().default(''),
    updatedAt: text('updated_at').notNull().default(sql`now()`),
    updatedBy: text('updated_by', {enum: ['agent', 'person']}).notNull().default('person')
  },
  table => [uniqueIndex('drone_assignments_plan_drone').on(table.planId, table.droneId)]
);

export type BriefingCite = {action: string; args: Record<string, unknown>};
export type BriefingEvidence = {layer: string; label: string; t?: string; lon?: number; lat?: number};
export type BriefingParagraph = {
  text: string;
  cites: BriefingCite[];
  /** Labels and map locations of what the cited actions returned, for the UI. */
  evidence: BriefingEvidence[];
  /** True when save-briefing re-ran the cites and every number in the text matched them. */
  verified: boolean;
  editedBy?: 'agent' | 'person';
  editedAt?: string;
};
export type DroppedParagraph = {text: string; reason: string; detail: string[]};

/** One briefing per plan; save-briefing replaces it. */
export const briefings = pgTable(
  'briefings',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    paragraphs: jsonb('paragraphs').$type<BriefingParagraph[]>().notNull(),
    dropped: jsonb('dropped').$type<DroppedParagraph[]>().notNull(),
    createdAt: text('created_at').notNull().default(sql`now()`),
    updatedAt: text('updated_at').notNull().default(sql`now()`),
    updatedBy: text('updated_by', {enum: ['agent', 'person']}).notNull().default('person')
  },
  table => [uniqueIndex('briefings_plan').on(table.planId)]
);

/** Detector hits (live or replayed), logged for the map and the agent. */
export const detections = pgTable(
  'detections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().default(''),
    fire: text('fire').notNull(),
    t: text('t').notNull(),
    lon: doublePrecision('lon').notNull(),
    lat: doublePrecision('lat').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    source: text('source').notNull(),
    createdAt: text('created_at').notNull().default(sql`now()`),
    updatedBy: text('updated_by', {enum: ['agent', 'person']}).notNull().default('person')
  },
  table => [index('detections_org_fire_t').on(table.orgId, table.fire, table.t)]
);
