import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {scoreOut} from '../server/plan/schemas.js';
import {findPlan, listAssignments, orgOf, scoreFor} from '../server/plan/service.js';

const errors = defineActionErrors('not_found');

export default defineAction({
  description:
    'Score a drone plan for its hour: forecast front length (km), front km inside the watch circles of drones that can fly (union, no double counting) and coverage %, homes (inspected structures not yet burned) within 500 m of the front and how many are watched, drones grounded by gusts over 12 m/s at 120 m, per-drone numbers, the uncovered gaps with most homes (with flyable flags), and wind cells. Geometry on a cached forecast; cite it in the briefing as {action: "score-plan", args: {planId}}.',
  schema: z.object({planId: z.string().describe('Plan id from create-drone-plan or get-drone-plan.')}),
  outputSchema: scoreOut,
  errors,
  http: {method: 'GET'},
  readOnly: true,
  run: async ({planId}, ctx) => {
    const plan = await findPlan(orgOf(ctx), planId);
    if (!plan) return errors.noWrite(`No drone plan with id ${planId}.`, 'not_found', {statusCode: 404});
    return scoreFor(plan, await listAssignments(plan.id));
  }
});
