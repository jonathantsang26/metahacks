import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {hindsightAt} from '../server/plan/hindsight.js';
import {findPlan, listAssignments, orgOf, store} from '../server/plan/service.js';

const errors = defineActionErrors('not_found');

const share = z.object({drones: z.number(), flying: z.number(), insideHa: z.number(), insidePct: z.number()});

export default defineAction({
  description:
    'Hindsight for a plan: how much ground actually burned in the planned hour (MODELED arrival raster) and what share of it fell inside the watch circles of the plan\'s flyable drones, next to a naive baseline (the same number of drones spaced evenly along the forecast front, same gust rule). Use after approving, to show what the plan would have caught. Never claim drones flew.',
  schema: z.object({planId: z.string().describe('Plan id.')}),
  outputSchema: z.object({
    fire: z.string(),
    t: z.string(),
    tEnd: z.string(),
    burnedHa: z.number(),
    burnedCells: z.number(),
    plan: share,
    baseline: share.extend({method: z.string(), points: z.array(z.object({lon: z.number(), lat: z.number(), grounded: z.boolean()}))}),
    arrivalStepMin: z.number(),
    label: z.string()
  }),
  errors,
  http: {method: 'GET'},
  readOnly: true,
  run: async ({planId}, ctx) => {
    const plan = await findPlan(orgOf(ctx), planId);
    if (!plan) return errors.noWrite(`No drone plan with id ${planId}.`, 'not_found', {statusCode: 404});
    const drones = (await listAssignments(plan.id)).map(a => ({droneId: a.droneId, lon: a.lon, lat: a.lat, radiusM: a.radiusM}));
    return hindsightAt(store(plan.fire), Date.parse(plan.t), drones);
  }
});
