import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {and, desc, eq, gte, lte} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {detections} from '../server/db/schema.js';
import {detectionOut, fireSchema} from '../server/plan/schemas.js';
import {orgOf} from '../server/plan/service.js';
import {isoUtc, parseTime} from '../server/fire/time.js';

const errors = defineActionErrors('bad_input');

export default defineAction({
  description: 'List logged fire detections for a fire, newest first, optionally only those between since and until (UTC ISO). At most limit rows (default 100).',
  schema: z.object({
    fire: fireSchema,
    since: z.string().optional().describe('Only detections at or after this UTC ISO time.'),
    until: z.string().optional().describe('Only detections at or before this UTC ISO time.'),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe('Maximum rows, 1-500; default 100.')
  }),
  outputSchema: z.object({detections: z.array(detectionOut), count: z.number()}),
  errors,
  http: {method: 'GET'},
  readOnly: true,
  run: async (args, ctx) => {
    const where = [eq(detections.orgId, orgOf(ctx)), eq(detections.fire, args.fire)];
    const since = args.since ? parseTime(args.since) : null;
    const until = args.until ? parseTime(args.until) : null;
    if (args.since && !since) return errors.noWrite('since must be a UTC ISO time.', 'bad_input');
    if (args.until && !until) return errors.noWrite('until must be a UTC ISO time.', 'bad_input');
    if (since) where.push(gte(detections.t, isoUtc(since.ms)));
    if (until) where.push(lte(detections.t, isoUtc(until.ms)));
    const rows = await getDb()
      .select()
      .from(detections)
      .where(and(...where))
      .orderBy(desc(detections.t))
      .limit(args.limit);
    const list = rows.map(({orgId: _o, ...d}) => d);
    return {detections: list, count: list.length};
  }
});
