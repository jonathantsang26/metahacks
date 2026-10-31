import type {IncomingMessage, ServerResponse} from 'node:http';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import handler from '../analyst.js';
import {PER_VISITOR, REPORT_COST} from '../_lib/ratelimit.js';

/**
 * The deployed route (the default export) with the model mocked: the limiter wiring, a report's
 * cost and the Retry-After header as Vercel would send them. The fake model answers at once.
 */
vi.mock('../_lib/model.js', () => ({
  createChatClient: () => ({
    create: async () => ({
      choices: [{message: {content: null, tool_calls: [{id: 'f1', type: 'function', function: {name: 'final_answer', arguments: JSON.stringify({paragraphs: []})}}]}}]
    })
  })
}));

type Sent = {status: number; headers: Record<string, string>; body: {error?: string}};

async function post(body: unknown, ip: string): Promise<Sent> {
  const headers: Record<string, string> = {};
  let status = 0;
  let text = '';
  const res = {
    set statusCode(v: number) {
      status = v;
    },
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = String(v)),
    end: (t: string) => void (text = t)
  } as unknown as ServerResponse;
  const req = {method: 'POST', body, headers: {}, socket: {remoteAddress: ip}} as unknown as IncomingMessage;
  await handler(req, res);
  return {status, headers, body: JSON.parse(text)};
}

const saved = process.env.MODEL_API_KEY;
beforeAll(() => void (process.env.MODEL_API_KEY = 'test-key: the model is mocked'));
afterAll(() => void (saved === undefined ? delete process.env.MODEL_API_KEY : (process.env.MODEL_API_KEY = saved)));

describe('POST /api/analyst rate limit', () => {
  it('charges a report REPORT_COST, refuses past the visitor limit with Retry-After, and still fits a question', async () => {
    const ip = '192.0.2.10';
    const reports = Math.floor(PER_VISITOR.max / REPORT_COST);
    for (let i = 0; i < reports; i++) expect((await post({question: 'Draft the incident report.', mode: 'report'}, ip)).status).toBe(200);
    const refused = await post({question: 'Draft the incident report.', mode: 'report'}, ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    const left = PER_VISITOR.max - reports * REPORT_COST;
    expect(refused.body.error).toMatch(new RegExp(`${left} questions? (is|are) left`));
    for (let i = 0; i < left; i++) expect((await post({question: 'When did the fire reach Lake Ave?'}, ip)).status).toBe(200);
    expect((await post({question: 'When did the fire reach Lake Ave?'}, ip)).status).toBe(429);
  });

  it('counts each visitor separately', async () => {
    expect((await post({question: 'When did the fire reach Lake Ave?'}, '192.0.2.11')).status).toBe(200);
  });
});
