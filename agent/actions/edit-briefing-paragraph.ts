import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {and, eq} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {briefings, dronePlans} from '../server/db/schema.js';
import {verifyBriefing} from '../server/plan/cites.js';
import {briefingOut} from '../server/plan/schemas.js';
import {briefingView, bundle, editorOf, listAssignments, nowIso, orgOf} from '../server/plan/service.js';

const errors = defineActionErrors('not_found', 'bad_input');

export default defineAction({
  description:
    'Replace the text of one briefing paragraph (the person\'s inline edit, or a correction the person asked for). The edit is kept as written and marked "edited by person" (or agent); its numbers are re-checked against the paragraph\'s cites and the result is returned as recheck, but the paragraph is not dropped.',
  schema: z.object({
    briefingId: z.string().describe('Briefing id (briefing.id from get-drone-plan or save-briefing).'),
    index: z.number().int().min(0).describe('0-based paragraph index.'),
    text: z.string().min(1).max(1200).describe('The new paragraph text.')
  }),
  outputSchema: z.object({
    briefing: briefingOut,
    recheck: z.object({grounded: z.boolean(), detail: z.array(z.string())}),
    message: z.string()
  }),
  errors,
  http: {method: 'POST'},
  run: async (args, ctx) => {
    const org = orgOf(ctx);
    const by = editorOf(ctx);
    const db = getDb();
    const rows = await db
      .select({b: briefings, p: dronePlans})
      .from(briefings)
      .innerJoin(dronePlans, eq(dronePlans.id, briefings.planId))
      .where(and(eq(briefings.id, args.briefingId), eq(dronePlans.orgId, org)))
      .limit(1);
    const hit = rows[0];
    if (!hit) return errors.noWrite(`No briefing with id ${args.briefingId}.`, 'not_found', {statusCode: 404});
    const para = hit.b.paragraphs[args.index];
    if (!para) return errors.noWrite(`The briefing has ${hit.b.paragraphs.length} paragraph(s); index ${args.index} does not exist.`, 'bad_input');

    const plan = hit.p;
    const drones = (await listAssignments(plan.id)).map(a => ({droneId: a.droneId, lon: a.lon, lat: a.lat, radiusM: a.radiusM}));
    const v = await verifyBriefing([{text: args.text, cites: para.cites}], {planId: plan.id, fire: plan.fire, t: plan.t, drones, bundle: async () => bundle(plan)});
    const grounded = v.paragraphs.length === 1;
    const now = nowIso();
    const paragraphs = hit.b.paragraphs.map((p, i) =>
      i === args.index ? {...p, text: args.text.replace(/\s+/g, ' ').trim(), verified: grounded, editedBy: by, editedAt: now} : p
    );
    const [row] = await db.update(briefings).set({paragraphs, updatedAt: now, updatedBy: by}).where(eq(briefings.id, hit.b.id)).returning();
    const detail = grounded ? [] : v.dropped.flatMap(d => [d.reason, ...d.detail]);
    if (!row) throw new Error('briefings write returned no row');
    return {
      briefing: briefingView(row),
      recheck: {grounded, detail},
      message: grounded
        ? `Paragraph ${args.index} edited by ${by}; its numbers still match its cites.`
        : `Paragraph ${args.index} edited by ${by} and kept as written, but it no longer checks against its cites: ${detail.join('; ')}.`
    };
  }
});
