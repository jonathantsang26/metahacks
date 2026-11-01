import {describe, expect, it} from 'vitest';
import {handleAnalyst} from '../analyst.js';
import type {ChatClient, ChatReply, ChatRequest} from '../_lib/analyst.js';
import {actualCost, BudgetError, budgetedChat, capUsd, chooseStore, MAX_CAP_USD, MAX_COMPLETION_TOKENS, memoryStore, PRICE, upstashStore, worstCase} from '../_lib/budget.js';
import {DATA_TOOLS, FINAL_ANSWER_TOOL} from '../_lib/tools.js';

const req = (text = 'When did the fire reach Lake Ave?'): ChatRequest => ({
  model: 'muse-spark-1.3',
  messages: [{role: 'system', content: 'x'.repeat(4000)}, {role: 'user', content: text}],
  tools: [...DATA_TOOLS, FINAL_ANSWER_TOOL],
  tool_choice: 'auto'
});
const reply = (usage?: ChatReply['usage']): ChatReply => ({choices: [{message: {content: 'ok'}}], usage});

function chat(fn: (r: ChatRequest) => Promise<ChatReply>): ChatClient & {calls: ChatRequest[]} {
  const calls: ChatRequest[] = [];
  return {calls, create: async r => (calls.push(r), fn(r))};
}

describe('cost bounds', () => {
  it('prices usage with cached input at the cached rate', () => {
    // 10k prompt (4k cached) and 2k completion: 6k x 1.25 + 4k x 0.15 + 2k x 4.25 per 1M tokens.
    const usd = (6000 * PRICE.input + 4000 * PRICE.cachedInput + 2000 * PRICE.output) / 1e6;
    expect(actualCost({prompt_tokens: 10_000, completion_tokens: 2000, prompt_tokens_details: {cached_tokens: 4000}})).toBe(Math.ceil(usd * 1e6));
    expect(actualCost(null)).toBeNull();
  });

  it('bounds the worst case above any reply the request could produce', () => {
    const r = {...req(), max_completion_tokens: MAX_COMPLETION_TOKENS};
    const bytes = Buffer.byteLength(JSON.stringify({messages: r.messages, tools: r.tools}));
    // Input tokens can't exceed the bytes they encode; output can't exceed the cap.
    expect(worstCase(r)).toBeGreaterThanOrEqual(actualCost({prompt_tokens: bytes, completion_tokens: MAX_COMPLETION_TOKENS})!);
  });
});

describe('budgetedChat', () => {
  it('reserves the worst case, then settles to what the reply reports', async () => {
    const store = memoryStore();
    const inner = chat(async () => reply({prompt_tokens: 3000, completion_tokens: 500}));
    await budgetedChat(inner, store, 100).create(req());
    expect(inner.calls[0].max_completion_tokens).toBe(MAX_COMPLETION_TOKENS);
    expect(await store.spent()).toBe(actualCost({prompt_tokens: 3000, completion_tokens: 500}));
  });

  it('refuses before calling the model once the next call could pass the cap, and the total never passes it', async () => {
    const store = memoryStore();
    const inner = chat(async () => reply({prompt_tokens: 3000, completion_tokens: 500}));
    const capUsdValue = 0.5;
    const c = budgetedChat(inner, store, capUsdValue);
    let refused = 0;
    for (let i = 0; i < 100; i++) await c.create(req()).catch(e => (expect(e).toBeInstanceOf(BudgetError), refused++));
    expect(refused).toBeGreaterThan(0);
    expect(inner.calls.length).toBe(100 - refused);
    expect(await store.spent()).toBeLessThanOrEqual(capUsdValue * 1e6);
  });

  it('holds the cap under concurrent calls', async () => {
    const store = memoryStore();
    const inner = chat(async () => (await new Promise(r => setTimeout(r, 5)), reply()));
    const c = budgetedChat(inner, store, 0.3);
    const results = await Promise.allSettled(Array.from({length: 20}, () => c.create(req())));
    expect(results.some(r => r.status === 'rejected')).toBe(true);
    expect(await store.spent()).toBeLessThanOrEqual(0.3 * 1e6);
  });

  it('keeps the whole reservation when the reply has no usage', async () => {
    const store = memoryStore();
    await budgetedChat(chat(async () => reply()), store, 100).create(req());
    expect(await store.spent()).toBe(worstCase({...req(), max_completion_tokens: MAX_COMPLETION_TOKENS}));
  });

  it('refunds a request rejected up front (4xx) but not a timeout or a 5xx, which may have been billed', async () => {
    const fail = (status?: number) => chat(async () => Promise.reject(Object.assign(new Error('x'), status ? {status} : {})));
    for (const [status, refunded] of [[400, true], [429, true], [500, false], [undefined, false]] as const) {
      const store = memoryStore();
      await expect(budgetedChat(fail(status), store, 100).create(req())).rejects.toThrow();
      expect((await store.spent()) === 0).toBe(refunded);
    }
  });

  it('fails closed when the store is down: no model call', async () => {
    const inner = chat(async () => reply());
    const down = {reserve: () => Promise.reject(new Error('down')), adjust: async () => {}, spent: async () => 0};
    await expect(budgetedChat(inner, down, 100).create(req())).rejects.toBeInstanceOf(BudgetError);
    expect(inner.calls).toHaveLength(0);
  });
});

describe('upstashStore', () => {
  function fakeFetch(results: unknown[], status = 200) {
    const sent: unknown[][] = [];
    const f = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      const result = results[sent.length - 1];
      return new Response(JSON.stringify(result), {status});
    }) as unknown as typeof fetch;
    return {f, sent};
  }

  it('reserves with one atomic script and reads -1 as a refusal', async () => {
    const {f, sent} = fakeFetch([{result: 1234}, {result: -1}]);
    const s = upstashStore('https://example.upstash.io', 'token', f);
    expect(await s.reserve(1234, 5000)).toBe(true);
    expect(await s.reserve(9999, 5000)).toBe(false);
    expect(sent[0]).toEqual(['EVAL', expect.stringContaining('INCRBY'), '1', 'analyst:spent_micro_usd', '1234', '5000']);
  });

  it('throws on a reply that is not a number, rather than counting it as reserved', async () => {
    for (const result of [null, 'OK', '-1']) {
      await expect(upstashStore('u', 't', fakeFetch([{result}]).f).reserve(1, 2)).rejects.toThrow(/unexpected reply/);
    }
  });

  it('throws on an error reply or HTTP failure, so callers fail closed', async () => {
    await expect(upstashStore('u', 't', fakeFetch([{error: 'ERR max requests limit exceeded'}]).f).reserve(1, 2)).rejects.toThrow(/max requests/);
    await expect(upstashStore('u', 't', fakeFetch([{}], 500).f).reserve(1, 2)).rejects.toThrow(/HTTP 500/);
  });
});

describe('choosing the store', () => {
  it('refuses without a shared store, whatever the platform variables say, unless local use is opted into', async () => {
    for (const env of [{}, {VERCEL: '1'}, {ANALYST_BUDGET_LOCAL: 'yes'}]) expect(chooseStore(env, memoryStore)).toBeNull();
    expect(chooseStore({ANALYST_BUDGET_LOCAL: '1'}, memoryStore)).not.toBeNull();
    const out = await handleAnalyst({question: 'When did the fire reach Lake Ave?'}, {MODEL_API_KEY: 'unused'});
    expect(out.status).toBe(503);
    expect((out.body as {error: string}).error).toMatch(/Spend tracking is not configured/);
  });

  it('uses the shared store when its variables are set, under either naming', () => {
    expect(chooseStore({KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't'}, () => {
      throw new Error('local store must not be used');
    })).not.toBeNull();
    expect(chooseStore({UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't'}, memoryStore)).not.toBeNull();
  });

  it('never lets ANALYST_BUDGET_USD raise the cap past the owner limit', () => {
    expect(capUsd({})).toBe(100);
    expect(capUsd({ANALYST_BUDGET_USD: '40'})).toBe(40);
    expect(capUsd({ANALYST_BUDGET_USD: '1500'})).toBe(MAX_CAP_USD);
    expect(capUsd({ANALYST_BUDGET_USD: 'abc'})).toBe(100);
  });
});
