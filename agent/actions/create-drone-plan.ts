import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {and, eq, inArray} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {droneAssignments, dronePlans} from '../server/db/schema.js';
import {loadFront} from '../server/plan/front.js';
import {DEFAULT_RADIUS_M} from '../server/plan/score.js';
import {bundleOut, droneIdSchema, fireSchema, latSchema, lonSchema, radiusSchema, timeSchema} from '../server/plan/schemas.js';
import {bundle, DRONE_IDS, editorOf, inFireBbox, MAX_DRONES, nextId, nowIso, orgOf, parsePlanTime, scoreLine, store} from '../server/plan/service.js';

const errors = defineActionErrors('bad_input', 'no_forecast', 'too_many_drones', 'drone_locked');

export default defineAction({
  description:
    'Create or replace the drone plan for a fire hour in one atomic call: up to 6 drones (D1-D6), each a watch point with a radius and a short reason. Replaces every unlocked drone of that hour\'s plan; locked drones (pinned by the person or by approve-plan) are kept and any drone you send with a locked id is skipped. Needs a cached forecast for t. Returns the plan, all drones, and the new score so you can iterate. Drones are simulated; nothing flies.',
  schema: z.object({
    fire: fireSchema,
    t: timeSchema.describe('Start of the planned hour, UTC ISO, e.g. "2025-01-08T23:30:00Z". One plan per fire per clock hour.'),
    drones: z
      .array(
        z.object({
          droneId: droneIdSchema.optional().describe('Drone id "D1"-"D6". Omit to take the lowest free unlocked id.'),
          lon: lonSchema,
          lat: latSchema,
          radiusM: radiusSchema.optional(),
          reason: z.string().max(240).default('').describe('Why this watch point, in a few words, e.g. "west flank near homes, flyable cell".')
        })
      )
      .max(MAX_DRONES)
      .describe('The drones to place, at most 6 including the locked ones kept.'),
    keepLocked: z.boolean().default(true).describe('Keep locked drones (default true). Only a person may pass false to replace locked drones too.')
  }),
  outputSchema: bundleOut.extend({skipped: z.array(z.object({droneId: z.string(), reason: z.string()})), message: z.string(), nextRequiredAction: z.string()}),
  errors,
  http: {method: 'POST'},
  run: async (args, ctx) => {
    const org = orgOf(ctx);
    const by = editorOf(ctx);
    const pt = parsePlanTime(args.fire, args.t);
    if ('error' in pt) return errors.noWrite(pt.error, 'bad_input');
    if (!loadFront(store(args.fire), pt.ms)) {
      return errors.noWrite(`No cached forecast covers ${args.fire} at ${pt.iso}, so there is no front to plan against. Pick an hour with a forecast (eaton: 2025-01-08T05Z to 2025-01-10T18Z).`, 'no_forecast');
    }
    for (const d of args.drones) {
      if (!inFireBbox(args.fire, d.lon, d.lat)) return errors.noWrite(`Watch point ${d.lon}, ${d.lat} is outside the ${args.fire} map area.`, 'bad_input');
    }
    const ids = args.drones.map(d => d.droneId).filter(Boolean);
    if (new Set(ids).size !== ids.length) return errors.noWrite('Each droneId may appear once.', 'bad_input');
    if (!args.keepLocked && by === 'agent') {
      return errors.noWrite('Locked drones were pinned by the person or by approval; the agent keeps them. Call again with keepLocked true.', 'drone_locked');
    }

    const db = getDb();
    const now = nowIso();
    const result = await db.transaction(async tx => {
      let plan = (
        await tx
          .select()
          .from(dronePlans)
          .where(and(eq(dronePlans.orgId, org), eq(dronePlans.fire, args.fire), eq(dronePlans.hourKey, pt.hourKey)))
          .for('update')
          .limit(1)
      )[0];
      if (!plan) {
        plan = (
          await tx
            .insert(dronePlans)
            .values({id: nextId('plan'), orgId: org, fire: args.fire, hourKey: pt.hourKey, t: pt.iso, status: 'draft', createdAt: now, updatedAt: now, updatedBy: by})
            .returning()
        )[0];
      }
      if (!plan) throw new Error('drone_plans insert returned no row');
      const existing = await tx.select().from(droneAssignments).where(eq(droneAssignments.planId, plan.id));
      const kept = args.keepLocked ? existing.filter(a => a.locked) : [];
      const lockedIds = new Set(kept.map(a => a.droneId));
      const skipped: {droneId: string; reason: string}[] = [];
      const wanted = args.drones.filter(d => {
        if (d.droneId && lockedIds.has(d.droneId)) {
          skipped.push({droneId: d.droneId, reason: 'locked: kept as it is'});
          return false;
        }
        return true;
      });
      if (kept.length + wanted.length > MAX_DRONES) {
        return errors.noWrite(`${kept.length} locked drone(s) are kept, so at most ${MAX_DRONES - kept.length} more fit (got ${wanted.length}).`, 'too_many_drones');
      }
      const taken = new Set([...lockedIds, ...wanted.map(d => d.droneId).filter((x): x is NonNullable<typeof x> => !!x)]);
      const free = DRONE_IDS.filter(id => !taken.has(id));
      const rows = wanted.map(d => {
        const droneId = d.droneId ?? free.shift()!;
        return {
          id: `${plan.id}:${droneId}`,
          planId: plan.id,
          droneId,
          lon: d.lon,
          lat: d.lat,
          radiusM: d.radiusM ?? DEFAULT_RADIUS_M,
          locked: false,
          reason: d.reason,
          updatedAt: now,
          updatedBy: by
        };
      });
      const replace = existing.filter(a => !kept.includes(a)).map(a => a.id);
      if (replace.length) await tx.delete(droneAssignments).where(inArray(droneAssignments.id, replace));
      if (rows.length) await tx.insert(droneAssignments).values(rows);
      const [updated] = await tx.update(dronePlans).set({t: pt.iso, status: 'draft', approvedAt: null, updatedAt: now, updatedBy: by}).where(eq(dronePlans.id, plan.id)).returning();
      if (!updated) throw new Error('drone_plans update returned no row');
      return {plan: updated, skipped};
    });

    const b = await bundle(result.plan);
    return {
      ...b,
      skipped: result.skipped,
      message: `Plan ${b.plan.id} for ${args.fire} ${b.plan.t}: ${b.assignments.length} drone(s). ${scoreLine(b.score)}`,
      nextRequiredAction: 'score-plan'
    };
  }
});
