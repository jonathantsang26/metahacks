import type {IncomingMessage} from 'node:http';

/**
 * Rate limits for the public analyst: each question spends Meta API credits on the server's key,
 * and the deployed demo has no sign-in. Two sliding windows, both in this instance's memory:
 * one per visitor (client IP) and one for everyone.
 *
 * Memory is per serverless instance, so a cold start, a redeploy or a second instance starts
 * fresh, and a burst that makes Vercel start more instances multiplies GLOBAL. Nothing here bounds
 * spend across instances: that needs a spending cap on the key or a Vercel Firewall rate-limit rule.
 */

export type Limit = {max: number; windowMs: number};

/** At most 20 per hour per visitor, a third of GLOBAL, so one visitor can't hold the whole budget. */
export const PER_VISITOR: Limit = {max: 10, windowMs: 30 * 60_000};
export const GLOBAL: Limit = {max: 60, windowMs: 60 * 60_000};
/** A drafted report makes several times the tool and model calls of one question. */
export const REPORT_COST = 3;
/** Visitors tracked at once; past this the oldest are dropped (a flood of new IPs still meets GLOBAL). */
const MAX_VISITORS = 10_000;

type Refusal = {
  ok: false;
  scope: 'visitor' | 'global';
  limit: Limit;
  /** Seconds until this request (at its cost) would fit in both windows. */
  retryAfterS: number;
  cost: number;
  /** Hits still free right now in the binding window: a cheaper request may fit. */
  left: number;
};
export type Verdict = {ok: true} | Refusal;

export function createLimiter(perVisitor: Limit = PER_VISITOR, global: Limit = GLOBAL, now: () => number = Date.now) {
  const visitors = new Map<string, number[]>();
  const all: number[] = [];

  const prune = (hits: number[], windowMs: number, t: number) => {
    while (hits.length && hits[0] <= t - windowMs) hits.shift();
  };
  // Seconds until enough of the oldest hits leave the window for `cost` more to fit.
  const wait = (hits: number[], limit: Limit, cost: number, t: number) => {
    if (!hits.length) return Math.ceil(limit.windowMs / 1000);
    const i = Math.min(hits.length - 1, hits.length + cost - limit.max - 1);
    return Math.max(1, Math.ceil((hits[i] + limit.windowMs - t) / 1000));
  };

  return {
    /** Spends `cost` hits for `visitor` if both windows have room; otherwise spends nothing. */
    take(visitor: string, cost = 1): Verdict {
      const t = now();
      prune(all, global.windowMs, t);
      let hits = visitors.get(visitor);
      if (hits) prune(hits, perVisitor.windowMs, t);
      else hits = [];
      // Check both windows and report the one that frees up last, so the advertised wait is enough.
      const refusals: Refusal[] = [];
      if (hits.length + cost > perVisitor.max) {
        refusals.push({ok: false, scope: 'visitor', limit: perVisitor, retryAfterS: wait(hits, perVisitor, cost, t), cost, left: perVisitor.max - hits.length});
      }
      if (all.length + cost > global.max) {
        refusals.push({ok: false, scope: 'global', limit: global, retryAfterS: wait(all, global, cost, t), cost, left: global.max - all.length});
      }
      if (refusals.length) return refusals.reduce((a, b) => (b.retryAfterS > a.retryAfterS ? b : a));
      for (let i = 0; i < cost; i++) {
        hits.push(t);
        all.push(t);
      }
      visitors.delete(visitor); // re-insert so Map order is least recently used first
      visitors.set(visitor, hits);
      if (visitors.size > MAX_VISITORS) visitors.delete(visitors.keys().next().value!);
      return {ok: true};
    }
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

/**
 * The caller's IP. On Vercel, x-real-ip and x-forwarded-for are set by Vercel's edge, which
 * overwrites any client-sent value; elsewhere (npm run dev) the socket address is used.
 */
export function clientId(req: Pick<IncomingMessage, 'headers' | 'socket'>, onVercel = !!process.env.VERCEL): string {
  if (onVercel) {
    const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
    const ip = first(req.headers['x-real-ip']) || first(req.headers['x-forwarded-for']);
    if (ip) return ip;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function limitMessage(v: Refusal): string {
  const mins = Math.ceil(v.retryAfterS / 60);
  const per = `${v.limit.max} analyst questions per ${v.limit.windowMs / 60_000} minutes`;
  const who = v.scope === 'visitor' ? 'per visitor' : 'across all visitors';
  // A refused report (cost > 1) may still leave room for a plain question.
  if (v.cost > 1 && v.left > 0) {
    return `This public demo allows ${per} ${who}, and a report counts as ${v.cost}. ${v.left} ${v.left === 1 ? 'question is' : 'questions are'} left: ask a question now, or try the report again in ${mins} min.`;
  }
  return v.scope === 'visitor'
    ? `This public demo allows ${per} per visitor (a report counts as ${REPORT_COST}). Try again in ${mins} min.`
    : `The public demo's analyst has reached its limit of ${per} across all visitors. Try again in ${mins} min.`;
}
