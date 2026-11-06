import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {detections} from '../server/db/schema.js';
import {detectionOut, fireSchema, latSchema, lonSchema, timeSchema} from '../server/plan/schemas.js';
import {editorOf, inFireBbox, nextId, nowIso, orgOf, parsePlanTime} from '../server/plan/service.js';

const errors = defineActionErrors('bad_input');

export default defineAction({
  description:
    'Log one fire detection (a detector hit on a frame or a person\'s report) at a point and time, with confidence 0-1 and a source label such as "sam-outline" or "person". Shown on the map as liveHits and listed by list-detections.',
  schema: z.object({
    fire: fireSchema,
    t: timeSchema.describe('UTC time of the detection.'),
    lon: lonSchema.describe('Longitude of the detection.'),
    lat: latSchema.describe('Latitude of the detection.'),
    confidence: z.number().min(0).max(1).describe('Detector confidence, 0 to 1.'),
    source: z.string().min(1).max(80).describe('Where the hit came from, e.g. "sam-outline", "footage", "person".')
  }),
  outputSchema: z.object({detection: detectionOut, message: z.string()}),
  errors,
  http: {method: 'POST'},
  run: async (args, ctx) => {
    const pt = parsePlanTime(args.fire, args.t);
    if ('error' in pt) return errors.noWrite(pt.error, 'bad_input');
    if (!inFireBbox(args.fire, args.lon, args.lat)) return errors.noWrite(`${args.lon}, ${args.lat} is outside the ${args.fire} map area.`, 'bad_input');
    const [row] = await getDb()
      .insert(detections)
      .values({id: nextId('det'), orgId: orgOf(ctx), fire: args.fire, t: pt.iso, lon: args.lon, lat: args.lat, confidence: args.confidence, source: args.source, createdAt: nowIso(), updatedBy: editorOf(ctx)})
      .returning();
    if (!row) throw new Error('detections insert returned no row');
    const {orgId: _o, ...detection} = row;
    return {detection, message: `Logged detection ${row.id} at ${row.t}.`};
  }
});
