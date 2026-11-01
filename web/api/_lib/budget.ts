import type {ChatClient, ChatReply, ChatRequest} from './analyst.js';

/**
 * A hard dollar cap on Meta API spend. Meta bills pay-as-you-go and its console spend limit only
 * sends an alert (dev.meta.ai/help/billing/spend-limit-alert), so the cap lives here: before each
 * model call, one shared counter atomically reserves the call's worst-case cost and refuses if
 * that would pass the cap; after the call it settles to the cost the reply's `usage` reports.
 * The worst case is an upper bound (input bytes, the output cap), so the total never passes the cap.
 */

/** muse-spark-1.3, Standard mode, USD per 1M tokens (dev.meta.ai/docs/pricing-rate-limits, 2026-10-31). */
export const PRICE = {input: 1.25, cachedInput: 0.15, output: 4.25};
/** Output cap per call, reasoning included (Chat Completions counts both against it). */
export const MAX_COMPLETION_TOKENS = 16_384;
export const DEFAULT_CAP_USD = 100;
/** The owner's limit for this key: no ANALYST_BUDGET_USD value can raise the cap past it. */
export const MAX_CAP_USD = 150;
/** Each store call gives up after this, so a hung store fails closed quickly instead of at maxDuration. */
const STORE_TIMEOUT_MS = 3000;
const KEY = 'analyst:spent_micro_usd';

const micro = (usd: number) => Math.ceil(usd * 1e6);

export class BudgetError extends Error {
  constructor(
    message: string,
    readonly status = 503
  ) {
    super(message);
  }
}

/** Spend in integer micro-dollars, shared by every caller of the key. */
export type BudgetStore = {
  /** Adds `amount` if the total stays at or under `cap`; false (and nothing added) otherwise. */
  reserve(amount: number, cap: number): Promise<boolean>;
  adjust(amount: number): Promise<void>;
  spent(): Promise<number>;
};

/** One process only: for `npm run dev` and tests, never the deployed site. */
export function memoryStore(): BudgetStore {
  let total = 0;
  return {
    async reserve(amount, cap) {
      if (total + amount > cap) return false;
      total += amount;
      return true;
    },
    async adjust(amount) {
      total += amount;
    },
    async spent() {
      return total;
    }
  };
}

// Check and add in one step: Redis runs a script atomically, so concurrent reservations can't overshoot.
const RESERVE = "local c=tonumber(redis.call('GET',KEYS[1]) or '0'); local a=tonumber(ARGV[1]); if c+a>tonumber(ARGV[2]) then return -1 end; return redis.call('INCRBY',KEYS[1],a)";

/** Upstash Redis over its REST API with plain fetch. Any failure throws, so callers fail closed. */
export function upstashStore(url: string, token: string, fetchImpl: typeof fetch = fetch): BudgetStore {
  async function send(command: (string | number)[]): Promise<unknown> {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(command.map(String)),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
    });
    const body = (await r.json().catch(() => null)) as {result?: unknown; error?: string} | null;
    if (!r.ok || !body || body.error !== undefined) throw new Error(`budget store: ${body?.error ?? `HTTP ${r.status}`}`);
    return body.result;
  }
  return {
    async reserve(amount, cap) {
      // The script returns -1 or the new total; anything else is not a reservation.
      const r = await send(['EVAL', RESERVE, 1, KEY, amount, cap]);
      if (typeof r !== 'number') throw new Error(`budget store: unexpected reply ${JSON.stringify(r)}`);
      return r !== -1;
    },
    async adjust(amount) {
      if (amount) await send(['INCRBY', KEY, amount]);
    },
    async spent() {
      return Number((await send(['GET', KEY])) ?? 0);
    }
  };
}

type BudgetEnv = {
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  ANALYST_BUDGET_USD?: string;
  /** "1" allows an untracked in-process budget when no shared store is configured (local runs only). */
  ANALYST_BUDGET_LOCAL?: string;
};

/** The shared store when the Upstash variables (as the Vercel Marketplace names them) are set. */
export function storeFromEnv(env: BudgetEnv): BudgetStore | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore(url, token) : null;
}

export function capUsd(env: BudgetEnv): number {
  const v = Number(env.ANALYST_BUDGET_USD);
  return Math.min(Number.isFinite(v) && v > 0 ? v : DEFAULT_CAP_USD, MAX_CAP_USD);
}

/**
 * The store a caller must use: the shared one, or an in-process one only when ANALYST_BUDGET_LOCAL=1
 * says so explicitly. Null means refuse: a missing setting never falls back to untracked spend.
 */
export function chooseStore(env: BudgetEnv, local: () => BudgetStore): BudgetStore | null {
  return storeFromEnv(env) ?? (env.ANALYST_BUDGET_LOCAL === '1' ? local() : null);
}

export const NO_STORE_MESSAGE =
  'Spend tracking is not configured (no Upstash Redis store), so the analyst is paused rather than spending untracked.';

/**
 * An upper bound on a call's cost. Every input token encodes at least one byte, so the request's
 * JSON size (with room for the chat template) bounds the input tokens, priced with no cache
 * discount; the output is bounded by MAX_COMPLETION_TOKENS.
 */
export function worstCase(req: ChatRequest): number {
  const bytes = Buffer.byteLength(JSON.stringify({messages: req.messages, tools: req.tools}), 'utf8');
  const inputTokens = bytes + 64 * req.messages.length + 1024;
  return micro((inputTokens * PRICE.input + MAX_COMPLETION_TOKENS * PRICE.output) / 1e6);
}

/** The billed cost from a reply's usage, or null when the reply has none. */
export function actualCost(usage: ChatReply['usage']): number | null {
  if (!usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return micro(((usage.prompt_tokens - cached) * PRICE.input + cached * PRICE.cachedInput + usage.completion_tokens * PRICE.output) / 1e6);
}

/** Rejected before any generation: nothing was billed, so the reservation comes back. */
function rejectedUpFront(e: unknown): boolean {
  const status = (e as {status?: unknown})?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

/** Wraps a chat client so every call is reserved against the cap first and settled after. */
export function budgetedChat(inner: ChatClient, store: BudgetStore, cap: number): ChatClient {
  const capMicro = micro(cap);
  return {
    async create(req) {
      const full = {...req, max_completion_tokens: MAX_COMPLETION_TOKENS};
      const reserved = worstCase(full);
      let ok: boolean;
      try {
        ok = await store.reserve(reserved, capMicro);
      } catch (e) {
        console.error('[analyst] budget store failed', e);
        throw new BudgetError('Spend tracking is unavailable, so the analyst is paused rather than spending untracked.');
      }
      if (!ok) throw new BudgetError(`The public demo's analyst has used its $${cap} budget for the Meta API, so it is paused.`);
      let reply: ChatReply;
      try {
        reply = await inner.create(full);
      } catch (e) {
        // A timeout or 5xx may still have been billed, so only an up-front rejection is refunded.
        if (rejectedUpFront(e)) await store.adjust(-reserved).catch(err => console.error('[analyst] budget refund failed', err));
        throw e;
      }
      const actual = actualCost(reply.usage);
      // Without usage the full reservation stands. Actual cost is at most the reservation by construction,
      // so settling only gives back; it is recorded either way so the total matches what was billed.
      if (actual !== null && actual !== reserved) await store.adjust(actual - reserved).catch(err => console.error('[analyst] budget settle failed', err));
      return reply;
    }
  };
}
