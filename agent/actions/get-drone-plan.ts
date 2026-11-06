import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {bundleOut, fireSchema, timeSchema} from '../server/plan/schemas.js';
import {bundle, findPlan, findPlanByHour, orgOf, parsePlanTime} from '../server/plan/service.js';

const errors = defineActionErrors('bad_input', 'not_found');

export default defineAction({
  description:
    'Read the drone plan for a fire hour (pass fire + t) or by planId: the plan, its drones D1-D6 (watch point, radius, locked, reason), its live score (front coverage, homes watched, grounded drones, uncovered gaps, wind cells) and the briefing. Returns {plan: null} when no plan exists for that hour yet.',
  schema: z.object({
    planId: z.string().optional().describe('Plan id from an earlier plan action. Pass this or t.'),
    fire: fireSchema,
    t: timeSchema.optional().describe('Any UTC time in the plan hour, e.g. "2025-01-08T23:30:00Z". Pass this or planId.')
  }),
  outputSchema: z.union([bundleOut, z.object({plan: z.null(), fire: z.string(), hourKey: z.string(), message: z.string()})]),
  errors,
  http: {method: 'GET'},
  readOnly: true,
  run: async (args, ctx) => {
    const org = orgOf(ctx);
    if (args.planId) {
      const plan = await findPlan(org, args.planId);
      if (!plan) return errors.noWrite(`No drone plan with id ${args.planId}.`, 'not_found', {statusCode: 404});
      return bundle(plan);
    }
    if (!args.t) return errors.noWrite('Pass planId, or fire and t.', 'bad_input');
    const pt = parsePlanTime(args.fire, args.t);
    if ('error' in pt) return errors.noWrite(pt.error, 'bad_input');
    const plan = await findPlanByHour(org, args.fire, pt.hourKey);
    if (!plan) return {plan: null, fire: args.fire, hourKey: pt.hourKey, message: `No drone plan for ${args.fire} in the hour starting ${pt.hourKey}. Create one with create-drone-plan.`};
    return bundle(plan);
  }
});
