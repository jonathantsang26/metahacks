import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {memoryStore} from '../_lib/budget.js';
import {createLimiter} from '../_lib/ratelimit.js';
import {objectPrompt, parseOutput, PRICE_PER_IMAGE_USD} from '../_lib/sam.js';
import {decodeMask, traceOutline} from '../_lib/samcodec.js';
import {handleSam, parseSamRequest} from '../sam.js';

/**
 * /api/sam over a mocked Model API: the request it sends, parsing of SAM 3.1's streamed output, and
 * the budget and rate-limit refusals. The mask fixtures are real SAM 3.1 payloads from Meta's
 * meta-sam-parser docs, with the rasters Meta's Python decoder produces for them.
 */

type Fx = {w: number; h: number; payload: string; raster: string};
const fx: Record<string, Fx> = JSON.parse(readFileSync(new URL('./fixtures/sam_masks.json', import.meta.url), 'utf8'));
const asString = (r: Uint8Array) => Array.from(r).join('');

describe('mask codec', () => {
  for (const [name, f] of Object.entries(fx)) {
    it(`decodes ${name} (${f.payload[0] === '~' ? 'lossless' : 'one_bit'}) exactly as the Python parser`, () => {
      expect(asString(decodeMask(f.payload, f.w, f.h))).toBe(f.raster);
    });
  }
  it('rejects a corrupted payload', () => {
    expect(() => decodeMask(fx.a.payload.slice(0, -3), fx.a.w, fx.a.h)).toThrow();
    expect(() => decodeMask('#abc', 4, 4)).toThrow(/encoding/);
  });
  it('traces a filled square as one 4-corner loop and a hole as a second loop', () => {
    const sq = new Uint8Array(16).fill(0);
    for (const i of [5, 6, 9, 10]) sq[i] = 1;
    expect(traceOutline(sq, 4, 4)).toHaveLength(1);
    const loop = traceOutline(sq, 4, 4)[0];
    expect(loop.length).toBe(8);
    expect(new Set(loop)).toEqual(new Set([1, 3]));
    const ring = new Uint8Array(9).fill(1);
    ring[4] = 0;
    expect(traceOutline(ring, 3, 3)).toHaveLength(2);
  });
});

const line = (id: number, f: Fx, box: [number, number], c = 0.91) =>
  `${id}<|box;x1=${box[0]};y1=${box[1]};x2=${box[0] + f.w - 1};y2=${box[1] + f.h - 1};w=320;h=334;c=${c}|><|mask;x=0;y=0;c=${c};data=${f.h},${f.w},${f.payload}|>`;
const OUTPUT = `<0f>${line(0, fx.a, [211, 228])},${line(2, fx.b, [155, 228], 0.5)}\n`;

function sse(text: string, {complete = true, split = 37} = {}): string {
  const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  const lane = {item_id: 'm1', output_index: 0, content_index: 0};
  let s = ev({type: 'response.created'});
  for (let i = 0; i < text.length; i += split) s += ev({type: 'response.output_text.delta', ...lane, delta: text.slice(i, i + split)});
  s += ev({type: 'response.output_text.done', ...lane, text});
  if (complete) s += ev({type: 'response.completed', response: {status: 'completed'}});
  return s + 'data: [DONE]\n\n';
}

type Sent = {url: string; auth: string | null; accept: string | null; body: any};
function api(reply: {status?: number; text: string}) {
  const sent: Sent[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sent.push({url: String(input), auth: h.get('authorization'), accept: h.get('accept'), body: JSON.parse(String(init?.body))});
    // Deliver the stream in small, uneven chunks to exercise buffering across reads.
    const bytes = new TextEncoder().encode(reply.text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 101) c.enqueue(bytes.slice(i, i + 101));
        c.close();
      }
    });
    return new Response(stream, {status: reply.status ?? 200, headers: {'content-type': 'text/event-stream'}});
  };
  return {fetch: f as typeof fetch, sent};
}

// Smallest valid-looking JPEG: SOI marker and padding.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')}`;
const ENV = {MODEL_API_KEY: 'sk-test-secret', ANALYST_BUDGET_LOCAL: '1'};
const deps = (over: Partial<Parameters<typeof handleSam>[2]> = {}) => {
  const store = memoryStore();
  return {store: () => store, limiter: createLimiter({max: 100, windowMs: 60_000}, {max: 100, windowMs: 60_000}), client: 'a', ...over, _store: store};
};

describe('parseOutput', () => {
  it('returns each object with frame-pixel polygons inside its box, and its confidence', () => {
    const r = parseOutput(OUTPUT, {width: 320, height: 334});
    expect(r.diagnostics).toEqual([]);
    expect(r.outlines.map(o => [o.id, o.conf, o.bounds])).toEqual([
      ['0', 0.91, [211, 228, 271, 255]],
      ['2', 0.5, [155, 228, 203, 255]]
    ]);
    for (const o of r.outlines) {
      expect(o.polygons.length).toBeGreaterThan(0);
      for (const p of o.polygons)
        p.forEach((v, i) => {
          const [lo, hi] = i % 2 ? [o.bounds[1], o.bounds[3]] : [o.bounds[0], o.bounds[2]];
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        });
    }
  });
  it('treats an empty lane as no fire, and skips a malformed record without losing the others', () => {
    expect(parseOutput('', {width: 10, height: 10}).outlines).toEqual([]);
    const bad = `<0f>${line(0, fx.a, [211, 228])},1<|box;x1=1;y1=1;x2=5;y2=5;w=320;h=334|><|mask;x=0;y=0;data=5,5,~!!!!!|>`;
    const r = parseOutput(bad, {width: 320, height: 334});
    expect(r.outlines.map(o => o.id)).toEqual(['0']);
    expect(r.diagnostics).toHaveLength(1);
  });
  it('writes box object prompts with inclusive x2/y2, clamped to the frame', () => {
    expect(objectPrompt([[10, 20, 40, 60], [-5, 0, 700, 30.4]], 640, 480)).toBe(
      '<0f>0<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|>,1<|box;x1=0;y1=0;x2=639;y2=29;w=640;h=480|>'
    );
  });
});

describe('POST /api/sam', () => {
  it('sends the SAM 3.1 Responses request with the text prompt "fire" and returns outlines', async () => {
    const m = api({text: sse(OUTPUT)});
    const out = await handleSam({image: JPEG, width: 320, height: 334}, ENV, {...deps(), fetch: m.fetch});
    expect(out.status).toBe(200);
    expect(m.sent).toHaveLength(1);
    const s = m.sent[0];
    expect(s.url).toBe('https://api.meta.ai/v1/responses');
    expect(s.auth).toBe('Bearer sk-test-secret');
    expect(s.accept).toBe('text/event-stream');
    expect(s.body).toEqual({
      model: 'sam-3.1',
      input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'fire'}, {type: 'input_image', image_url: JPEG}]}],
      stream: true,
      metadata: {include_confidence: 'true'}
    });
    const body = out.body as any;
    expect(body.prompt).toBe('fire');
    expect(body.outlines).toHaveLength(2);
    expect([body.width, body.height]).toEqual([320, 334]);
    expect(JSON.stringify(body)).not.toContain('sk-test-secret');
  });

  it('uses detector boxes as object prompts instead of the text prompt when given', async () => {
    const m = api({text: sse(OUTPUT)});
    const out = await handleSam({image: JPEG, width: 320, height: 334, boxes: [[211, 228, 271, 255], [0, 0, 0, 0]]}, ENV, {...deps(), fetch: m.fetch});
    expect(out.status).toBe(200);
    expect(m.sent[0].body.input[0].content[0].text).toBe('<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>');
    expect((out.body as any).prompt).toBe('boxes');
  });

  it('is unavailable without a key, and never calls the API', async () => {
    const m = api({text: sse(OUTPUT)});
    const out = await handleSam({image: JPEG, width: 320, height: 334}, {}, {...deps(), fetch: m.fetch});
    expect(out.status).toBe(503);
    expect((out.body as any).code).toBe('no_key');
    expect(m.sent).toHaveLength(0);
  });

  it('rejects bodies that are not a downscaled JPEG frame', () => {
    expect(parseSamRequest({image: 'data:image/png;base64,AAAA', width: 10, height: 10})).toMatch(/JPEG/);
    expect(parseSamRequest({image: JPEG, width: 4000, height: 10})).toMatch(/width/);
    expect(parseSamRequest({image: 'data:image/jpeg;base64,AAAA', width: 100, height: 100})).toMatch(/not a JPEG/);
  });

  it('refuses without spend tracking, rather than spending untracked', async () => {
    const m = api({text: sse(OUTPUT)});
    const out = await handleSam({image: JPEG, width: 320, height: 334}, {MODEL_API_KEY: 'k'}, {...deps(), store: undefined, fetch: m.fetch});
    expect(out.status).toBe(503);
    expect((out.body as any).code).toBe('no_store');
    expect(m.sent).toHaveLength(0);
  });

  it('stops at the daily dollar cap, and counts $0.0025 per frame', async () => {
    const m = api({text: sse(OUTPUT)});
    const d = deps();
    const env = {...ENV, SAM_DAILY_BUDGET_USD: '0.006'}; // room for two frames
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await handleSam({image: JPEG, width: 320, height: 334}, env, {...d, fetch: m.fetch})).status);
    expect(codes).toEqual([200, 200, 503]);
    expect(m.sent).toHaveLength(2);
    expect(await d._store.spent()).toBe(2 * PRICE_PER_IMAGE_USD * 1e6);
  });

  it('keeps a separate budget per UTC day', async () => {
    const m = api({text: sse(OUTPUT)});
    const days = new Map<string, ReturnType<typeof memoryStore>>();
    const store = (day: string) => days.get(day) ?? (days.set(day, memoryStore()), days.get(day)!);
    let t = Date.UTC(2026, 10, 3, 23, 59);
    const d = {...deps(), store, now: () => t, fetch: m.fetch};
    await handleSam({image: JPEG, width: 320, height: 334}, ENV, d);
    t += 2 * 60_000;
    await handleSam({image: JPEG, width: 320, height: 334}, ENV, d);
    expect([...days.keys()]).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('rate-limits per visitor with Retry-After, before spending', async () => {
    const m = api({text: sse(OUTPUT)});
    const d = {...deps({limiter: createLimiter({max: 1, windowMs: 60_000}, {max: 100, windowMs: 60_000})}), fetch: m.fetch};
    expect((await handleSam({image: JPEG, width: 320, height: 334}, ENV, d)).status).toBe(200);
    const out = await handleSam({image: JPEG, width: 320, height: 334}, ENV, d);
    expect(out.status).toBe(429);
    expect(out.headers?.['Retry-After']).toMatch(/^\d+$/);
    expect(m.sent).toHaveLength(1);
    expect(await d._store.spent()).toBe(PRICE_PER_IMAGE_USD * 1e6);
  });

  it('refunds an up-front API refusal, keeps a stream that did not complete, and never echoes the key', async () => {
    const d = deps();
    const refused = api({status: 401, text: '{"error":"bad key sk-test-secret"}'});
    const out = await handleSam({image: JPEG, width: 320, height: 334}, ENV, {...d, fetch: refused.fetch});
    expect(out.status).toBe(502);
    expect(JSON.stringify(out.body)).not.toContain('sk-test-secret');
    expect(await d._store.spent()).toBe(0);
    const cut = api({text: sse(OUTPUT, {complete: false})});
    const out2 = await handleSam({image: JPEG, width: 320, height: 334}, ENV, {...d, fetch: cut.fetch});
    expect(out2.status).toBe(502);
    expect(await d._store.spent()).toBe(PRICE_PER_IMAGE_USD * 1e6);
  });
});
