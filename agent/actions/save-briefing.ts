import {defineAction, defineActionErrors} from '@agent-native/core/action';
import {z} from 'zod';
import {getDb} from '../server/db/index.js';
import {briefings} from '../server/db/schema.js';
import {verifyBriefing} from '../server/plan/cites.js';
import {briefingOut, citeIn, droppedOut} from '../server/plan/schemas.js';
import {briefingView, bundle, editorOf, findPlan, listAssignments, nextId, nowIso, orgOf} from '../server/plan/service.js';

const errors = defineActionErrors('not_found', 'bad_input');

export default defineAction({
  description:
    'Save the crew briefing for a drone plan (replaces the previous one). Each paragraph lists the actions whose results support it as {action, args}, e.g. {action: "score-plan", args: {planId}} or {action: "weather-at", args: {fire, t}}. The server re-runs every cite and checks every number and clock time in the text against those results (rounding allowed): a paragraph with a number no cite returned, no working cite, an address, or talk of what started the fire is dropped and returned with the reason. Keep paragraphs short and copy numbers as the actions gave them.',
  schema: z.object({
    planId: z.string().describe('Plan id the briefing is for.'),
    paragraphs: z
      .array(
        z.object({
          text: z.string().min(1).max(1200).describe('One short paragraph of plain prose. Every number in it must appear in a cited result.'),
          cites: z.array(citeIn).min(1).max(8).describe('The actions (with the exact args you called them with) that support this paragraph.')
        })
      )
      .min(1)
      .max(10)
  }),
  outputSchema: z.object({
    briefing: briefingOut,
    kept: z.number(),
    dropped: z.array(droppedOut),
    message: z.string()
  }),
  errors,
  http: {method: 'POST'},
  run: async (args, ctx) => {
    const org = orgOf(ctx);
    const by = editorOf(ctx);
    const plan = await findPlan(org, args.planId);
    if (!plan) return errors.noWrite(`No drone plan with id ${args.planId}.`, 'not_found', {statusCode: 404});
    const drones = (await listAssignments(plan.id)).map(a => ({droneId: a.droneId, lon: a.lon, lat: a.lat, radiusM: a.radiusM}));
    const v = await verifyBriefing(
      args.paragraphs.map(p => ({text: p.text, cites: p.cites.map(c => ({action: c.action, args: c.args}))})),
      {planId: plan.id, fire: plan.fire, t: plan.t, drones, bundle: async () => bundle(plan)}
    );
    const now = nowIso();
    const [row] = await getDb()
      .insert(briefings)
      .values({id: nextId('brief'), planId: plan.id, paragraphs: v.paragraphs, dropped: v.dropped, createdAt: now, updatedAt: now, updatedBy: by})
      .onConflictDoUpdate({target: briefings.planId, set: {paragraphs: v.paragraphs, dropped: v.dropped, updatedAt: now, updatedBy: by}})
      .returning();
    if (!row) throw new Error('briefings write returned no row');
    return {
      briefing: briefingView(row),
      kept: v.paragraphs.length,
      dropped: v.dropped,
      message: v.dropped.length
        ? `Saved ${v.paragraphs.length} verified paragraph(s); dropped ${v.dropped.length}: ${v.dropped.map(d => `${d.reason} (${d.detail.join('; ')})`).join(' | ')}. Fix and save again if needed.`
        : `Saved ${v.paragraphs.length} verified paragraph(s).`
    };
  }
});
