import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {writeAppStateForCurrentTab} from '@agent-native/core/application-state';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {droneAssignments, dronePlans} from '../server/db/schema.js';
import {isoUtc} from '../server/fire/time.js';
import {bundleOut} from '../server/plan/schemas.js';
import {bundle, editorOf, findPlan, nowIso, orgOf, scoreLine, store} from '../server/plan/service.js';

const errors = defineActionErrors('not_found', 'empty_plan');

export default defineAction({
  description:
    'Approve a drone plan: locks every drone, marks the plan approved, and moves the map to the next hour (writes a map-command set-time to t + 1 h). Returns the approved plan with its score and nextT, the start of the next planning hour. Approval is a replay step for a simulated plan; no drone flies.',
  schema: z.object({planId: z.string().describe('Plan id to approve.')}),
  outputSchema: bundleOut.extend({
    nextT: z.string(),
    nextTInWindow: z.boolean(),
    mapCommand: z.object({written: z.boolean(), note: z.string()}),
    message: z.string(),
    nextRequiredAction: z.string()
  }),
  errors,
  http: {method: 'POST'},
  run: async ({planId}, ctx) => {
    const org = orgOf(ctx);
    const by = editorOf(ctx);
    const plan = await findPlan(org, planId);
    if (!plan) return errors.noWrite(`No drone plan with id ${planId}.`, 'not_found', {statusCode: 404});
    const db = getDb();
    const now = nowIso();
    const count = await db.transaction(async tx => {
      const locked = await tx.update(droneAssignments).set({locked: true, updatedAt: now, updatedBy: by}).where(eq(droneAssignments.planId, plan.id)).returning({id: droneAssignments.id});
      if (!locked.length) return errors.noWrite('The plan has no drones to approve.', 'empty_plan');
      await tx.update(dronePlans).set({status: 'approved', approvedAt: now, updatedAt: now, updatedBy: by}).where(eq(dronePlans.id, plan.id));
      return locked.length;
    });

    const nextMs = Date.parse(plan.t) + 3.6e6;
    const nextT = isoUtc(nextMs);
    const w1 = Date.parse(store(plan.fire).aoi().window_utc[1]);
    const inWindow = nextMs <= w1;
    let mapCommand = {written: false, note: 'next hour is past the end of the replay window'};
    if (inWindow) {
      try {
        await writeAppStateForCurrentTab('map-command', {kind: 'set-time', t: nextT, _writeId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`});
        mapCommand = {written: true, note: `map moves to ${nextT}`};
      } catch (e) {
        mapCommand = {written: false, note: `could not reach the open map: ${(e as Error).message}`};
      }
    }
    const b = await bundle((await findPlan(org, plan.id))!);
    return {
      ...b,
      nextT,
      nextTInWindow: inWindow,
      mapCommand,
      message: `Approved plan ${plan.id} (${count} drone(s) locked) by ${by}. ${scoreLine(b.score)} Next hour starts ${nextT}.`,
      nextRequiredAction: 'create-drone-plan'
    };
  }
});
