import {defineAction} from '@agent-native/core/action';
import {readAppState, readAppStateForCurrentTab} from '@agent-native/core/application-state';
import {z} from 'zod';
import {loadFront} from '../server/plan/front.js';
import {bundle, findPlan, findPlanByHour, FIRES, orgOf, parsePlanTime, scoreLine, store, type PlanBundle} from '../server/plan/service.js';

function planSummary(b: PlanBundle) {
  const s = b.score;
  const grounded = new Map(s.perDrone.map(d => [d.droneId, d]));
  return {
    id: b.plan.id,
    fire: b.plan.fire,
    t: b.plan.t,
    status: b.plan.status,
    updatedBy: b.plan.updatedBy,
    drones: b.assignments.map(a => ({
      droneId: a.droneId,
      lon: a.lon,
      lat: a.lat,
      radiusM: a.radiusM,
      locked: a.locked,
      grounded: grounded.get(a.droneId)?.grounded ?? false,
      gustMs: grounded.get(a.droneId)?.gustMs ?? null,
      reason: a.reason
    })),
    score: {
      frontKm: s.frontKm,
      coveredKm: s.coveredKm,
      frontCoveragePct: s.frontCoveragePct,
      fastFrontKm: s.fastFrontKm,
      fastCoveragePct: s.fastCoveragePct,
      method: s.method,
      homesNearFront: s.homesNearFront,
      homesWatched: s.homesWatched,
      groundedCount: s.groundedCount,
      topGaps: s.gaps.slice(0, 3),
      summary: scoreLine(s)
    },
    briefing: b.briefing
      ? {id: b.briefing.id, paragraphs: b.briefing.paragraphs.length, dropped: b.briefing.dropped.length, edited: b.briefing.paragraphs.filter(p => p.editedBy).length}
      : null
  };
}

export default defineAction({
  description:
    'Fresh snapshot of what the person sees: navigation (fire, time t, tab, selected drone, visible layers), the selection (a drone or a map point), whether a cached forecast covers t, and the drone plan for that hour with its drones (locked/grounded), score summary, top uncovered gaps and briefing status. Basic navigation is already in <current-screen>; call this before planning or after the person edits.',
  schema: z.object({}),
  outputSchema: z.looseObject({}),
  http: false,
  readOnly: true,
  run: async (_args, ctx) => {
    const screen: Record<string, unknown> = {};
    type Nav = {fire?: string; t?: string; planId?: string | null};
    let navigation: Nav | null;
    try {
      navigation = (await readAppState('navigation')) as Nav | null;
    } catch (e) {
      return {note: `Screen state is not readable here: ${(e as Error).message}`};
    }
    if (navigation) screen.navigation = navigation;
    try {
      const selection = await readAppStateForCurrentTab('selection');
      if (selection) screen.selection = selection;
    } catch {
      // No tab in this context (CLI): selection is per browser tab.
    }
    if (!navigation) {
      screen.note = 'No navigation state yet. Is the app open?';
      return screen;
    }
    const fire = (FIRES as readonly string[]).includes(navigation.fire ?? '') ? (navigation.fire as string) : 'eaton';
    const org = orgOf(ctx);
    let plan = navigation.planId ? await findPlan(org, navigation.planId) : null;
    if (!plan && navigation.t) {
      const pt = parsePlanTime(fire, navigation.t);
      if (!('error' in pt)) {
        const f = loadFront(store(fire), pt.ms);
        screen.forecast = f
          ? {status: 'CACHED', issuedAt: f.issuedAt, forecastFor: f.validAt, method: f.method, frontKm: f.frontKm}
          : {status: 'none', note: 'No cached forecast was issued for this hour, so no plan can be made or scored here.'};
        plan = await findPlanByHour(org, fire, pt.hourKey);
        if (!plan) screen.plan = {exists: false, hourKey: pt.hourKey, next: f ? 'create-drone-plan' : 'pick an hour with a forecast'};
      }
    }
    if (plan) screen.plan = planSummary(await bundle(plan));
    screen.labels = 'Replay of a past fire. Forecast CACHED, arrival MODELED, drones SIMULATED (none flew).';
    return screen;
  }
});
