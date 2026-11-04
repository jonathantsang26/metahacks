import {describe, expect, it} from 'vitest';
import {createSamPoller, polygonPath, sendSize, type Grab, type PollerEvent, type Post} from './sam';

/** The live SAM throttle: one frame per interval at most, only with a box, never queued, and it stops cleanly. */

const grab = (t: number): Grab => ({image: 'data:image/jpeg;base64,/9j/', width: 640, height: 360, capturedAt: t});

function harness(reply: (n: number) => {status: number; body: any; retryAfterS?: number}) {
  let t = 0;
  const events: PollerEvent[] = [];
  const pending: (() => void)[] = [];
  let calls = 0;
  const post: Post = () => {
    const n = calls++;
    return new Promise(res => pending.push(() => res(reply(n))));
  };
  const p = createSamPoller(post, e => events.push(e), () => t, 2000);
  return {
    p,
    events,
    get calls() {
      return calls;
    },
    advance: (ms: number) => (t += ms),
    /** Resolve the oldest in-flight request and let its handler run. */
    flush: async () => {
      pending.shift()?.();
      await new Promise(r => setTimeout(r, 0));
    },
    now: () => t
  };
}

const ok = {status: 200, body: {outlines: [{id: '0', bounds: [1, 2, 3, 4], conf: 0.9, polygons: [[1, 2, 3, 2, 3, 4]]}], width: 640, height: 360, ms: 900, prompt: 'fire'}};

describe('createSamPoller', () => {
  it('sends nothing without a Sentinel box, and never grabs a frame it will not send', async () => {
    const h = harness(() => ok);
    let grabs = 0;
    expect(await h.p.tick(false, () => (grabs++, grab(0)))).toBe(false);
    expect(h.calls).toBe(0);
    expect(grabs).toBe(0);
  });

  it('sends at most one frame per interval and skips (never queues) while one is in flight', async () => {
    const h = harness(() => ok);
    void h.p.tick(true, () => grab(h.now()));
    expect(h.calls).toBe(1);
    h.advance(2500); // due again, but the first is still out
    void h.p.tick(true, () => grab(h.now()));
    void h.p.tick(true, () => grab(h.now()));
    expect(h.calls).toBe(1);
    expect(h.p.stats.skipped).toBe(2);
    await h.flush();
    expect(h.events[0]).toMatchObject({kind: 'result', frame: {outlines: [{id: '0'}], rttMs: 2500, apiMs: 900}});
    void h.p.tick(true, () => grab(h.now())); // due and free: goes now
    expect(h.calls).toBe(2);
    h.advance(1000);
    await h.flush();
    void h.p.tick(true, () => grab(h.now())); // free but only 1 s since the last send
    expect(h.calls).toBe(2);
    h.advance(1000);
    void h.p.tick(true, () => grab(h.now()));
    expect(h.calls).toBe(3);
  });

  it('stops on a refusal that will not change (no key), with the server message', async () => {
    const h = harness(() => ({status: 503, body: {error: 'SAM 3.1 outlines are unavailable: the server has no Model API key.', code: 'no_key'}}));
    void h.p.tick(true, () => grab(0));
    await h.flush();
    expect(h.events).toEqual([{kind: 'unavailable', message: 'SAM 3.1 outlines are unavailable: the server has no Model API key.'}]);
    h.advance(60_000);
    expect(await h.p.tick(true, () => grab(h.now()))).toBe(false);
    expect(h.calls).toBe(1);
  });

  it('reports a missing route (static hosting) as unavailable', async () => {
    const h = harness(() => ({status: 404, body: null}));
    void h.p.tick(true, () => grab(0));
    await h.flush();
    expect(h.events[0]).toMatchObject({kind: 'unavailable'});
  });

  it('backs off for Retry-After on 429, then resumes', async () => {
    const h = harness(n => (n === 0 ? {status: 429, body: {error: 'limited'}, retryAfterS: 30} : ok));
    void h.p.tick(true, () => grab(0));
    await h.flush();
    expect(h.events[0]).toEqual({kind: 'error', message: 'limited', retryInMs: 30_000});
    h.advance(29_000);
    void h.p.tick(true, () => grab(h.now()));
    expect(h.calls).toBe(1);
    h.advance(1_000);
    void h.p.tick(true, () => grab(h.now()));
    expect(h.calls).toBe(2);
  });

  it('survives a network failure with a short back-off', async () => {
    let t = 0;
    const events: PollerEvent[] = [];
    const p = createSamPoller(async () => Promise.reject(new Error('offline')), e => events.push(e), () => t, 2000);
    await p.tick(true, () => grab(0));
    expect(events[0]).toMatchObject({kind: 'error', retryInMs: 5000});
    expect(p.stats.inFlight).toBe(false);
    t = 4000;
    expect(await p.tick(true, () => grab(t))).toBe(false);
    t = 5000;
    expect(await p.tick(true, () => grab(t))).toBe(true);
  });
});

describe('helpers', () => {
  it('downscales the longest side to 640 px and never upscales', () => {
    expect(sendSize(1280, 720)).toEqual({width: 640, height: 360, scale: 0.5});
    expect(sendSize(480, 640)).toEqual({width: 480, height: 640, scale: 1});
  });
  it('writes polygons as closed SVG subpaths', () => {
    expect(polygonPath([[0, 0, 4, 0, 4, 3], [1, 1, 2, 1, 2, 2]])).toBe('M0 0L4 0L4 3ZM1 1L2 1L2 2Z');
  });
});
