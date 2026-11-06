import {z} from 'zod';
import {DRONE_IDS, FIRES} from './service.js';

/** Zod pieces shared by the plan-domain actions (inputs and output contracts). */

export const fireSchema = z.enum(FIRES).default('eaton').describe('Fire id: "eaton" or "palisades"; defaults to "eaton".');
export const timeSchema = z.string().min(10).describe('UTC ISO-8601 time inside the replay window, e.g. "2025-01-08T23:30:00Z".');
export const droneIdSchema = z.enum(DRONE_IDS).describe('Drone id, "D1" to "D6".');
export const lonSchema = z.number().min(-180).max(180).describe('Longitude of the watch point, decimal degrees (negative west).');
export const latSchema = z.number().min(-90).max(90).describe('Latitude of the watch point, decimal degrees.');
export const radiusSchema = z
  .number()
  .min(100)
  .max(600)
  .describe('Radius in meters of ground the drone keeps in view around its watch point, 100 to 600; default 400 (a 120 m altitude thermal camera orbiting the point). Keep 400 unless the person asks for a wider orbit: a bigger circle is not a better plan, it is a less detailed view.');

const point = z.object({lon: z.number(), lat: z.number()});

export const planOut = z.object({
  id: z.string(),
  fire: z.string(),
  t: z.string(),
  hourKey: z.string(),
  status: z.enum(['draft', 'approved']),
  approvedAt: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.enum(['agent', 'person'])
});

export const assignmentOut = z.object({
  droneId: z.string(),
  lon: z.number(),
  lat: z.number(),
  radiusM: z.number(),
  locked: z.boolean(),
  reason: z.string(),
  updatedAt: z.string(),
  updatedBy: z.enum(['agent', 'person'])
});

export const scoreOut = z.looseObject({
  fire: z.string(),
  t: z.string(),
  tEnd: z.string(),
  t_local: z.string(),
  tEnd_local: z.string(),
  frontKm: z.number(),
  coveredKm: z.number(),
  frontCoveragePct: z.number(),
  fastFrontKm: z.number(),
  fastCoveredKm: z.number(),
  fastCoveragePct: z.number(),
  homesNearFront: z.number(),
  homesWatched: z.number(),
  groundedCount: z.number(),
  activeCount: z.number(),
  perDrone: z.array(
    z.object({
      droneId: z.string(),
      lon: z.number(),
      lat: z.number(),
      radiusM: z.number(),
      gustMs: z.number().nullable(),
      grounded: z.boolean(),
      frontKmInView: z.number(),
      uniqueFrontKm: z.number(),
      homesInView: z.number()
    })
  ),
  gaps: z.array(z.object({lengthKm: z.number(), mid: point, homesNear: z.number(), gustMs: z.number().nullable(), flyable: z.boolean(), fast: z.boolean()})),
  forecast: z.object({file: z.string(), issuedAt: z.string(), validAt: z.string(), method: z.string(), status: z.literal('saved')}).nullable(),
  method: z.string().nullable(),
  fastAdvanceM: z.number(),
  gustHours: z.array(z.string()),
  windCells: z.array(z.object({bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), gustMs: z.number(), flyable: z.boolean()})),
  gustLimitMs: z.number(),
  flightAglM: z.number(),
  nearFrontM: z.number(),
  defaultRadiusM: z.number(),
  label: z.string()
});

const evidence = z.object({layer: z.string(), label: z.string(), t: z.string().optional(), lon: z.number().optional(), lat: z.number().optional()});
export const citeIn = z.object({
  action: z.string().min(1).max(60).describe('Name of the action whose result supports the paragraph, e.g. "score-plan", "weather-at", "structures-near", "get-forecast-front".'),
  args: z.record(z.string(), z.unknown()).default({}).describe('The exact input you called that action with, e.g. {"planId": "..."} or {"fire": "eaton", "t": "2025-01-08T23:30:00Z"}.')
});
export const paragraphOut = z.object({
  text: z.string(),
  cites: z.array(z.object({action: z.string(), args: z.record(z.string(), z.unknown())})),
  evidence: z.array(evidence),
  verified: z.boolean(),
  editedBy: z.enum(['agent', 'person']).optional(),
  editedAt: z.string().optional()
});
export const droppedOut = z.object({text: z.string(), reason: z.string(), detail: z.array(z.string())});
export const briefingOut = z.object({
  id: z.string(),
  planId: z.string(),
  paragraphs: z.array(paragraphOut),
  dropped: z.array(droppedOut),
  updatedAt: z.string(),
  updatedBy: z.enum(['agent', 'person'])
});

export const bundleOut = z.object({
  plan: planOut,
  assignments: z.array(assignmentOut),
  score: scoreOut,
  briefing: briefingOut.nullable()
});

export const detectionOut = z.object({
  id: z.string(),
  fire: z.string(),
  t: z.string(),
  lon: z.number(),
  lat: z.number(),
  confidence: z.number(),
  source: z.string(),
  createdAt: z.string(),
  updatedBy: z.enum(['agent', 'person'])
});
