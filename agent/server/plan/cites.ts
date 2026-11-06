import {FireStore} from '../fire/data.js';
import {createToolRunner} from '../fire/tools.js';
import type {Cite} from '../fire/types.js';
import {mentionsCause, containsAddress, ungroundedNumbers, verifyAnswer} from '../fire/verify.js';
import type {BriefingCite, BriefingEvidence, BriefingParagraph, DroppedParagraph} from '../db/schema.js';
import {loadFront} from './front.js';
import {hindsightAt} from './hindsight.js';

/**
 * Briefing verification, the way web/api/_lib/analyst.ts checks the analyst: every cited action
 * is re-run on the server, its output becomes the evidence behind fresh cite ids, and
 * server/fire/verify.ts drops paragraphs with cause or address language, without a working cite,
 * or with a number or time that none of their cited outputs contains.
 */

/** Data actions (data-actions worker) that are ports of a server/fire/tools.ts tool. */
export const DATA_ACTION_TOOLS: Record<string, string> = {
  'place-lookup': 'place_lookup',
  'arrival-at': 'arrival_at',
  'street-fire-timeline': 'street_fire_timeline',
  'fire-state-at': 'fire_state_at',
  'weather-at': 'weather_at',
  'fire-events': 'events',
  'structures-near': 'structures_near',
  'ignition-summary': 'ignition_summary',
  'exposure-stats': 'exposure_stats'
};

/** What a plan-domain cite resolves to: the current plan's numbers, computed on the server. */
export type PlanEvidence = {
  planId: string;
  fire: string;
  /** get-drone-plan output for the plan being briefed. */
  bundle: () => Promise<{plan: unknown; assignments: unknown; score: unknown}>;
  drones: {droneId: string; lon: number; lat: number; radiusM: number}[];
  t: string;
};

type Resolved = {ok: true; result: unknown; cites: Omit<Cite, 'id'>[]} | {ok: false; error: string};

const camelToSnake: Record<string, string> = {radiusM: 'radius_m'};

async function runRegistered(name: string, args: Record<string, unknown>): Promise<Resolved | null> {
  // The generated registry is bundler-safe; imported lazily because it imports this module's actions too.
  const reg = (await import('../../.generated/actions-registry.js')).default as Record<string, {default?: unknown}>;
  const def = reg[name]?.default as {run?: (a: unknown) => unknown; readOnly?: boolean; http?: {method?: string} | false} | undefined;
  if (!def?.run) return null;
  const readOnly = def.readOnly === true || (def.http && def.http.method === 'GET');
  if (!readOnly) return {ok: false, error: `${name} changes data, so it cannot be re-run to check a briefing; cite a read action`};
  try {
    const out = (await def.run(args)) as unknown;
    if (out && typeof out === 'object' && 'result' in out && 'cites' in out && Array.isArray((out as {cites: unknown}).cites)) {
      const o = out as {result: unknown; cites: Omit<Cite, 'id'>[]};
      return {ok: true, result: o.result, cites: o.cites};
    }
    return {ok: true, result: out, cites: [{layer: name, label: `${name} result`}]};
  } catch (e) {
    return {ok: false, error: (e as Error).message};
  }
}

export async function resolveCite(cite: BriefingCite, plan: PlanEvidence, runner: ReturnType<typeof createToolRunner>, registry: Map<string, Cite>, evidence: Map<string, unknown>): Promise<{ids: string[]; error?: string}> {
  const add = (r: Resolved): {ids: string[]; error?: string} => {
    if (!r.ok) return {ids: [], error: `${cite.action}: ${r.error}`};
    const ids = r.cites.map(c => {
      const id = `p${registry.size + 1}`;
      const full: Cite = {id, ...c};
      registry.set(id, full);
      evidence.set(id, {result: r.result, cite: full});
      return id;
    });
    return {ids};
  };
  const args = cite.args ?? {};
  const fire = typeof args.fire === 'string' ? args.fire : plan.fire;

  const tool = DATA_ACTION_TOOLS[cite.action];
  if (tool) {
    if (fire !== plan.fire) return {ids: [], error: `${cite.action}: cites must be about ${plan.fire}, the plan's fire`};
    const toolArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (k !== 'fire') toolArgs[camelToSnake[k] ?? k] = v;
    const before = new Set(runner.registry.keys());
    const out = runner.run(tool, JSON.stringify(toolArgs));
    if (!out.ok) return {ids: [], error: `${cite.action}: ${(JSON.parse(out.content) as {error?: string}).error ?? 'failed'}`};
    const ids = [...runner.registry.keys()].filter(k => !before.has(k));
    for (const id of ids) {
      registry.set(id, runner.registry.get(id)!);
      evidence.set(id, runner.evidence.get(id));
    }
    return {ids};
  }

  const samePlan = typeof args.planId !== 'string' || args.planId === plan.planId;
  switch (cite.action) {
    case 'score-plan':
    case 'get-drone-plan': {
      if (!samePlan) return {ids: [], error: `${cite.action}: cite this plan (${plan.planId}), not another one`};
      const b = await plan.bundle();
      // score-plan returns only the score; get-drone-plan also the drones (the briefing itself is left out).
      const result = cite.action === 'score-plan' ? b.score : {plan: b.plan, assignments: b.assignments, score: b.score};
      return add({ok: true, result, cites: [{layer: 'dronePlan', t: plan.t, label: `Drone plan score for ${plan.t}`}]});
    }
    case 'hindsight-check':
      if (!samePlan) return {ids: [], error: `hindsight-check: cite this plan (${plan.planId}), not another one`};
      return add({ok: true, result: hindsightAt(new FireStore(plan.fire), Date.parse(plan.t), plan.drones), cites: [{layer: 'arrival', t: plan.t, label: 'Hindsight: next-hour burned area vs drone footprints'}]});
    case 'get-forecast-front': {
      const t = typeof args.t === 'string' ? Date.parse(args.t) : Date.parse(plan.t);
      const f = Number.isFinite(t) ? loadFront(new FireStore(fire), t) : null;
      if (!f) return {ids: [], error: 'get-forecast-front: no cached forecast for that time'};
      // The same numbers get-forecast-front returns, without the polygon and line coordinates.
      return add({ok: true, result: {issuedAt: f.issuedAt, forecastFor: f.validAt, method: f.method, frontKm: f.frontKm, frontPieces: f.pieces, status: 'CACHED'}, cites: [{layer: 'forecast', t: f.validAt, label: `Forecast front (${f.method}), issued ${f.issuedAt}`}]});
    }
    default: {
      if (!/^[a-z0-9-]{1,60}$/.test(cite.action)) return {ids: [], error: `unknown action "${cite.action}"`};
      const registered = await runRegistered(cite.action, args);
      return registered ? add(registered) : {ids: [], error: `unknown action "${cite.action}"`};
    }
  }
}

export type VerifiedBriefing = {paragraphs: BriefingParagraph[]; dropped: DroppedParagraph[]};

/** Re-runs every cite and keeps the paragraphs verify.ts accepts; the rest come back with reasons. */
export async function verifyBriefing(input: {text: string; cites: BriefingCite[]}[], plan: PlanEvidence): Promise<VerifiedBriefing> {
  const runner = createToolRunner(new FireStore(plan.fire));
  const registry = new Map<string, Cite>();
  const evidence = new Map<string, unknown>();
  const out: VerifiedBriefing = {paragraphs: [], dropped: []};
  for (const p of input) {
    const ids: string[] = [];
    const errors: string[] = [];
    for (const c of p.cites) {
      const r = await resolveCite(c, plan, runner, registry, evidence);
      ids.push(...r.ids);
      if (r.error) errors.push(r.error);
    }
    const v = verifyAnswer([{text: p.text, cite_ids: ids}], registry, {evidence});
    if (v.paragraphs.length) {
      const kept = v.paragraphs[0]!;
      out.paragraphs.push({
        text: kept.text,
        cites: p.cites,
        evidence: kept.cites.map(({id: _id, ...c}): BriefingEvidence => c),
        verified: true
      });
      continue;
    }
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (v.dropped.guardrail) {
      const detail = [mentionsCause(text) ? 'talks about what started the fire or who is responsible' : '', containsAddress(text) ? 'contains a street address or house number' : ''].filter(Boolean);
      out.dropped.push({text, reason: 'guardrail', detail});
    } else if (v.dropped.uncited) {
      out.dropped.push({text, reason: 'uncited', detail: errors.length ? errors : ['no cite returned anything to check against']});
    } else {
      const cites = ids.map(id => registry.get(id)!).filter(Boolean);
      const bad = ungroundedNumbers(text, cites, {evidence});
      out.dropped.push({text, reason: 'ungrounded', detail: bad.map(b => `"${b}" is not in any cited result`)});
    }
  }
  return out;
}
