import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {fireSchema, timeSchema} from '../server/plan/schemas.js';
import {parsePlanTime, store} from '../server/plan/service.js';
import {FLIGHT_AGL_M, GUST_LIMIT_MS, gustLookup} from '../server/plan/wind.js';

const errors = defineActionErrors('bad_input');

export default defineAction({
  description:
    'Where drones can fly in the hour starting t: the 4 x 6 HRRR wind cells over the fire, each with its bbox [west, south, east, north], the highest gust at 120 m flight height over the hour (m/s) and flyable (gust <= 12 m/s, the DJI Matrice 4TD rating). A drone whose watch point is in a non-flyable cell is grounded and sees nothing. Call before placing drones.',
  schema: z.object({fire: fireSchema, t: timeSchema.describe('Start of the planned hour, UTC ISO.')}),
  outputSchema: z.object({
    fire: z.string(),
    t: z.string(),
    gustHours: z.array(z.string()),
    gustLimitMs: z.number(),
    flightAglM: z.number(),
    flyableCount: z.number(),
    cells: z.array(z.object({bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), gustMs: z.number(), flyable: z.boolean()})),
    source: z.string(),
    label: z.string()
  }),
  errors,
  http: {method: 'GET'},
  readOnly: true,
  run: async ({fire, t}) => {
    const pt = parsePlanTime(fire, t);
    if ('error' in pt) return errors.noWrite(pt.error, 'bad_input');
    const g = gustLookup(store(fire), pt.ms);
    return {
      fire,
      t: pt.iso,
      gustHours: g.hours,
      gustLimitMs: GUST_LIMIT_MS,
      flightAglM: FLIGHT_AGL_M,
      flyableCount: g.cells.filter(c => c.flyable).length,
      cells: g.cells,
      source: g.source,
      label: 'Estimated wind: HRRR 3 km hourly gust (max of each hour overlapping the planned hour), scaled from 10 m to 120 m by the 1/7 power law, as in the Meta swarm sim. Coarse: real flow over the ridges is more complex.'
    };
  }
});
