import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {and, eq} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {droneAssignments, dronePlans} from '../server/db/schema.js';
import {DEFAULT_RADIUS_M} from '../server/plan/score.js';
import {bundleOut, droneIdSchema, latSchema, lonSchema, radiusSchema} from '../server/plan/schemas.js';
import {bundle, editorOf, findPlan, inFireBbox, MAX_DRONES, nowIso, orgOf, scoreLine} from '../server/plan/service.js';

const errors = defineActionErrors('not_found', 'bad_input', 'drone_locked', 'too_many_drones');

export default defineAction({
  description:
    'Add, move, resize, lock/unlock, re-explain or remove one drone of a plan (upsert by droneId). Used by the map when the person drags a watch point and by the agent for single tweaks; for several drones at once use create-drone-plan. The agent may not change a locked drone. Any edit puts an approved plan back to draft. Returns the plan and the new score.',
  schema: z.object({
    planId: z.string().describe('Plan id.'),
    droneId: droneIdSchema,
    lon: lonSchema.optional().describe('New watch point longitude (required when adding a drone).'),
    lat: latSchema.optional().describe('New watch point latitude (required when adding a drone).'),
    radiusM: radiusSchema.optional(),
    locked: z.boolean().optional().describe('true pins the drone so create-drone-plan and the agent leave it alone; false unpins it (person only).'),
    reason: z.string().max(240).optional().describe('Why this watch point, a few words.'),
    remove: z.boolean().optional().describe('true removes the drone from the plan.')
  }),
  outputSchema: bundleOut.extend({message: z.string()}),
  errors,
  http: {method: 'POST'},
  run: async (args, ctx) => {
    const org = orgOf(ctx);
    const by = editorOf(ctx);
    const plan = await findPlan(org, args.planId);
    if (!plan) return errors.noWrite(`No drone plan with id ${args.planId}.`, 'not_found', {statusCode: 404});
    if ((args.lon === undefined) !== (args.lat === undefined)) return errors.noWrite('Pass lon and lat together.', 'bad_input');
    if (args.lon !== undefined && args.lat !== undefined && !inFireBbox(plan.fire, args.lon, args.lat)) {
      return errors.noWrite(`Watch point ${args.lon}, ${args.lat} is outside the ${plan.fire} map area.`, 'bad_input');
    }
    const db = getDb();
    const now = nowIso();
    let verb = '';
    await db.transaction(async tx => {
      await tx.select({id: dronePlans.id}).from(dronePlans).where(eq(dronePlans.id, plan.id)).for('update');
      const all = await tx.select().from(droneAssignments).where(eq(droneAssignments.planId, plan.id));
      const cur = all.find(a => a.droneId === args.droneId);
      if (cur?.locked && by === 'agent') {
        return errors.noWrite(`${args.droneId} is locked (pinned by the person or by approval); the agent leaves it as it is.`, 'drone_locked', {statusCode: 409});
      }
      if (args.remove) {
        if (!cur) return errors.noWrite(`${args.droneId} is not in this plan.`, 'not_found', {statusCode: 404});
        await tx.delete(droneAssignments).where(eq(droneAssignments.id, cur.id));
        verb = 'removed';
      } else if (cur) {
        await tx
          .update(droneAssignments)
          .set({
            ...(args.lon !== undefined ? {lon: args.lon, lat: args.lat} : {}),
            ...(args.radiusM !== undefined ? {radiusM: args.radiusM} : {}),
            ...(args.locked !== undefined ? {locked: args.locked} : {}),
            ...(args.reason !== undefined ? {reason: args.reason} : {}),
            updatedAt: now,
            updatedBy: by
          })
          .where(and(eq(droneAssignments.id, cur.id)));
        verb = 'updated';
      } else {
        if (args.lon === undefined || args.lat === undefined) return errors.noWrite(`${args.droneId} is not in the plan yet; pass lon and lat to add it.`, 'bad_input');
        if (all.length >= MAX_DRONES) return errors.noWrite(`The plan already has ${MAX_DRONES} drones.`, 'too_many_drones');
        await tx.insert(droneAssignments).values({
          id: `${plan.id}:${args.droneId}`,
          planId: plan.id,
          droneId: args.droneId,
          lon: args.lon,
          lat: args.lat,
          radiusM: args.radiusM ?? DEFAULT_RADIUS_M,
          locked: args.locked ?? false,
          reason: args.reason ?? '',
          updatedAt: now,
          updatedBy: by
        });
        verb = 'added';
      }
      await tx.update(dronePlans).set({status: 'draft', approvedAt: null, updatedAt: now, updatedBy: by}).where(eq(dronePlans.id, plan.id));
    });
    const b = await bundle((await findPlan(org, plan.id))!);
    return {...b, message: `${args.droneId} ${verb} by ${by}. ${scoreLine(b.score)}`};
  }
});
