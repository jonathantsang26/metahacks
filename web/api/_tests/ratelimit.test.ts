import {describe, expect, it} from 'vitest';
import {handleAnalyst, parseRequest} from '../analyst.js';
import {clientId, createLimiter, GLOBAL, limitMessage, PER_VISITOR, REPORT_COST, type Limit} from '../_lib/ratelimit.js';
import type {AnalystRequest} from '../_lib/types.js';

const MIN = 60_000;
const visitor: Limit = {max: 3, windowMs: 10 * MIN};
const global: Limit = {max: 5, windowMs: 60 * MIN};

function clock(start = 1_000_000) {
  let t = start;
  return {now: () => t, advance: (ms: number) => (t += ms)};
}

describe('createLimiter', () => {
  it('allows a visitor up to the limit, then says when to retry', () => {
    const c = clock();
    const l = createLimiter(visitor, global, c.now);
    expect([l.take('a'), l.take('a'), l.take('a')].every(v => v.ok)).toBe(true);
    c.advance(4 * MIN);
    expect(l.take('a')).toEqual({ok: false, scope: 'visitor', limit: visitor, retryAfterS: 6 * 60, cost: 1, left: 0});
  });

  it('slides: hits older than the window stop counting', () => {
    const c = clock();
    const l = createLimiter(visitor, global, c.now);
    for (let i = 0; i < 3; i++) l.take('a');
    c.advance(10 * MIN);
    expect(l.take('a').ok).toBe(true);
  });

  it('keeps visitors apart but caps everyone together', () => {
    const c = clock();
    const l = createLimiter(visitor, global, c.now);
    for (let i = 0; i < 3; i++) expect(l.take('a').ok).toBe(true);
    for (let i = 0; i < 2; i++) expect(l.take('b').ok).toBe(true);
    const v = l.take('c');
    expect(v).toMatchObject({ok: false, scope: 'global'});
    expect(v.ok || v.retryAfterS).toBe(60 * 60);
  });

  it('charges a report several questions, and a refused request spends nothing', () => {
    const c = clock();
    const l = createLimiter({max: 4, windowMs: 10 * MIN}, {max: 100, windowMs: 60 * MIN}, c.now);
    l.take('a', 2);
    expect(l.take('a', REPORT_COST)).toMatchObject({ok: false, scope: 'visitor'});
    expect(l.take('a', 1).ok).toBe(true);
    expect(l.take('a', 1).ok).toBe(true);
    expect(l.take('a', 1).ok).toBe(false);
  });

  it('waits for enough old hits to expire for a multi-hit request', () => {
    const c = clock();
    const l = createLimiter({max: 3, windowMs: 10 * MIN}, {max: 100, windowMs: 60 * MIN}, c.now);
    l.take('a');
    c.advance(MIN);
    l.take('a');
    c.advance(MIN);
    l.take('a');
    // A report (3 hits) needs all three gone: the newest leaves 10 min after it was taken.
    expect(l.take('a', 3)).toMatchObject({ok: false, scope: 'visitor', retryAfterS: 10 * 60});
    // One question needs only the oldest gone: 8 min from now.
    expect(l.take('a', 1)).toMatchObject({ok: false, scope: 'visitor', retryAfterS: 8 * 60});
  });

  it('when both windows are full, gives the longer wait so a retry then succeeds', () => {
    const c = clock();
    const l = createLimiter({max: 2, windowMs: 10 * MIN}, {max: 2, windowMs: 60 * MIN}, c.now);
    l.take('a');
    l.take('a');
    const v = l.take('a');
    expect(v).toMatchObject({ok: false, scope: 'global', retryAfterS: 60 * 60});
    c.advance(10 * MIN);
    expect(l.take('a').ok).toBe(false);
    c.advance(50 * MIN);
    expect(l.take('a').ok).toBe(true);
  });

  it('keeps one visitor well under the global budget at the shipped limits', () => {
    expect(PER_VISITOR.max * (GLOBAL.windowMs / PER_VISITOR.windowMs)).toBeLessThanOrEqual(GLOBAL.max / 2);
  });
});

describe('clientId', () => {
  const req = (headers: Record<string, string>, remoteAddress = '10.0.0.9') => ({headers, socket: {remoteAddress}}) as never;

  it("uses Vercel's x-real-ip, then the first x-forwarded-for entry", () => {
    expect(clientId(req({'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1'}), true)).toBe('203.0.113.7');
    expect(clientId(req({'x-forwarded-for': '198.51.100.1, 10.1.1.1'}), true)).toBe('198.51.100.1');
  });

  it('ignores forwarding headers off Vercel, where any client could set them', () => {
    expect(clientId(req({'x-real-ip': '203.0.113.7'}), false)).toBe('10.0.0.9');
  });
});

describe('handleAnalyst rate limit', () => {
  const env = {MODEL_API_KEY: 'not-used: the limiter refuses before any model call'};

  it('answers 429 with Retry-After and never reaches the model once a visitor is over the limit', async () => {
    const limiter = createLimiter({max: 1, windowMs: 10 * MIN}, {max: 100, windowMs: 60 * MIN});
    limiter.take('v');
    const out = await handleAnalyst({question: 'When did the fire reach Lake Ave?'}, env, undefined, {client: 'v', limiter});
    expect(out.status).toBe(429);
    expect((out.body as {error: string}).error).toMatch(/1 analyst questions per 10 minutes per visitor/);
    expect(Number(out.headers?.['Retry-After'])).toBeGreaterThan(0);
  });

  it('does not count requests that fail validation or name an unknown fire', async () => {
    const limiter = createLimiter({max: 1, windowMs: 10 * MIN}, {max: 100, windowMs: 60 * MIN});
    const guard = {client: 'v', limiter};
    expect((await handleAnalyst({}, env, undefined, guard)).status).toBe(400);
    expect((await handleAnalyst({question: 'q', fire: 'atlantis'}, env, undefined, guard)).status).toBe(404);
    expect(limiter.take('v').ok).toBe(true);
  });
});

describe('limitMessage', () => {
  it('tells a visitor refused a report that a question still fits', () => {
    const l = createLimiter({max: 4, windowMs: 10 * MIN}, {max: 100, windowMs: 60 * MIN});
    l.take('a', 2);
    const v = l.take('a', REPORT_COST);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(limitMessage(v)).toMatch(/report counts as 3\. 2 questions are left: ask a question now, or try the report again in \d+ min\.$/);
  });

  it('never says the global limit is reached while a question still fits', () => {
    const l = createLimiter({max: 100, windowMs: 10 * MIN}, {max: 4, windowMs: 60 * MIN});
    l.take('a', 3);
    const v = l.take('b', REPORT_COST);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(limitMessage(v)).not.toMatch(/reached its limit/);
  });

  it('rounds the wait up to whole minutes', () => {
    expect(limitMessage({ok: false, scope: 'global', limit: global, retryAfterS: 61, cost: 1, left: 0})).toMatch(/limit of 5 analyst questions per 60 minutes across all visitors\. Try again in 2 min\.$/);
  });
});

describe('parseRequest history size', () => {
  it('keeps only the most recent turns that fit in 8,000 characters, each cut to 2,000', () => {
    const turn = (i: number) => ({role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(3000)});
    const req = parseRequest({question: 'q', history: Array.from({length: 12}, (_, i) => turn(i))}) as AnalystRequest;
    expect(req.history.map(h => h.content.length)).toEqual([2000, 2000, 2000, 2000]);
    expect(req.history.at(-1)!.content.startsWith('11')).toBe(true);
    expect(req.history.reduce((a, h) => a + h.content.length, 0)).toBeLessThanOrEqual(8000);
  });

  it("leaves a normal conversation's history alone", () => {
    const history = [{role: 'user', content: 'When did it reach Lake Ave?'}, {role: 'assistant', content: 'x'.repeat(1200)}];
    expect((parseRequest({question: 'q', history}) as AnalystRequest).history).toEqual(history);
  });
});
