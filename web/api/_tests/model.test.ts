import {describe, expect, it} from 'vitest';
import {runAnalyst} from '../_lib/analyst.js';
import {FireStore} from '../_lib/data.js';
import {createChatClient, MODEL_BASE_URL} from '../_lib/model.js';

/**
 * The real Meta client (OpenAI SDK, Meta's base URL) over a recorded HTTP transport: the requests
 * the SDK actually sends, and its parsing and error handling of Meta-shaped replies. No network.
 */

type Sent = {url: string; auth: string | null; body: Record<string, any>};
type Reply = {status?: number; json: unknown};

function transport(replies: Reply[]): {fetch: typeof fetch; sent: Sent[]} {
  const sent: Sent[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({url: String(input), auth: headers.get('authorization'), body: JSON.parse(String(init?.body))});
    const r = replies[sent.length - 1];
    if (!r) throw new Error(`no recorded reply for request ${sent.length}`);
    return new Response(JSON.stringify(r.json), {status: r.status ?? 200, headers: {'content-type': 'application/json'}});
  };
  return {fetch: fake as typeof fetch, sent};
}

const completion = (message: Record<string, unknown>) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 0,
  model: 'muse-spark-1.3',
  choices: [{index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: {role: 'assistant', content: null, ...message}}]
});
const toolCall = (id: string, name: string, args: unknown) => ({id, type: 'function', function: {name, arguments: JSON.stringify(args)}});

const store = new FireStore('eaton');
const ask = (question: string) => ({question, fire: 'eaton', history: [], mode: 'answer' as const});

describe('Meta client over a recorded transport', () => {
  it('sends tool-calling requests to Meta and answers each parallel call by id', async () => {
    const t = transport([
      {json: completion({tool_calls: [toolCall('call_1', 'weather_at', {t: '2025-01-08T07:00:00Z'}), toolCall('call_2', 'fire_state_at', {t: '2025-01-08T07:00:00Z'})]})},
      {json: completion({tool_calls: [toolCall('call_3', 'final_answer', {paragraphs: [{text: 'Wind and size at that hour are in the cited results.', cite_ids: ['c1']}]})]})}
    ]);
    const chat = createChatClient('test-key', {fetch: t.fetch});
    const {response, audit} = await runAnalyst(ask('Wind and fire size at 11 PM on Jan 7?'), {chat, store});

    expect(t.sent).toHaveLength(2);
    for (const s of t.sent) {
      expect(s.url).toBe(`${MODEL_BASE_URL}/chat/completions`);
      expect(s.auth).toBe('Bearer test-key');
      expect(s.body.model).toBe('muse-spark-1.3');
    }
    const names = (t.sent[0].body.tools as {function: {name: string}}[]).map(x => x.function.name);
    expect(names).toEqual(expect.arrayContaining(['place_lookup', 'street_fire_timeline', 'weather_at', 'final_answer']));
    const toolMsgs = (t.sent[1].body.messages as {role: string; tool_call_id?: string}[]).filter(m => m.role === 'tool');
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['call_1', 'call_2']);
    expect(response.tool_calls.map(c => c.name)).toEqual(['weather_at', 'fire_state_at']);
    expect(response.paragraphs).toHaveLength(1);
    expect(audit).toMatchObject({rounds: 2, final_answer: true, invalid_cite_ids: 0});
  });

  it('falls back to tool_choice "auto" when Meta rejects a named tool_choice with a 400', async () => {
    const plain = completion({content: 'The fire was reported on Jan 7.'});
    const t = transport([
      {json: completion({tool_calls: [toolCall('call_1', 'events', {})]})},
      {json: plain},
      {status: 400, json: {error: {message: 'tool_choice by name is not supported', type: 'invalid_request_error'}}},
      {json: completion({tool_calls: [toolCall('call_2', 'final_answer', {paragraphs: [{text: 'The data does not show it.', cite_ids: []}]})]})}
    ]);
    const chat = createChatClient('test-key', {fetch: t.fetch});
    const {audit} = await runAnalyst(ask('When was it reported?'), {chat, store});

    expect(t.sent.map(s => s.body.tool_choice)).toEqual(['auto', 'auto', {type: 'function', function: {name: 'final_answer'}}, 'auto']);
    expect(audit.final_answer).toBe(true);
  });

  it('surfaces an auth failure instead of retrying', async () => {
    const t = transport([{status: 401, json: {error: {message: 'invalid api key'}}}]);
    const chat = createChatClient('test-key', {fetch: t.fetch});
    await expect(runAnalyst(ask('When was it reported?'), {chat, store})).rejects.toMatchObject({status: 401});
    expect(t.sent).toHaveLength(1);
  });
});
