import type {IncomingMessage, ServerResponse} from 'node:http';
import {BudgetError, memoryStore, storeFromEnv, type BudgetStore} from './_lib/budget.js';
import {clientId, createLimiter, type Limit, type Limiter} from './_lib/ratelimit.js';
import {PRICE_PER_IMAGE_USD, requestBody, SamApiError, segmentFrame, TEXT_PROMPT, type Box, type SamResult} from './_lib/sam.js';

/**
 * POST /api/sam: SAM 3.1 outlines for one live frame. Body: {image: "data:image/jpeg;base64,…",
 * width, height, boxes?: [[x1, y1, x2, y2], …]} in that frame's pixels. With boxes, they are SAM's
 * object prompts (SAM refines Sentinel's detections); without, the text prompt "fire". SAM's
 * protocol does not take both in one request. Returns {outlines, width, height, ms, prompt}.
 *
 * Spend is capped per UTC day (SAM_DAILY_BUDGET_USD, default $5, never above $25) in the same
 * Upstash store as the analyst, under its own key, and rate-limited per visitor. The key never
 * leaves the server and is never logged.
 */

export const MAX_IMAGE_BYTES = 1_000_000;
const MAX_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16 * 1024;
const MAX_SIDE = 1280;
const MAX_BOXES = 6;
export const DEFAULT_DAILY_USD = 5;
export const MAX_DAILY_USD = 25;
/** The client sends at most one frame per ~2 s, so 40 a minute leaves room and stops a runaway loop. */
export const SAM_PER_VISITOR: Limit = {max: 40, windowMs: 60_000};
export const SAM_GLOBAL: Limit = {max: 160, windowMs: 60_000};

type Env = Record<string, string | undefined>;
type Result = {status: number; body: unknown; headers?: Record<string, string>};
export type SamDeps = {
  limiter?: Limiter;
  client?: string;
  /** The day's budget store; defaults to the shared store, or memory with ANALYST_BUDGET_LOCAL=1. */
  store?: (day: string) => BudgetStore | null;
  fetch?: typeof fetch;
  now?: () => number;
};

const limiter = createLimiter(SAM_PER_VISITOR, SAM_GLOBAL);
const localDays = new Map<string, BudgetStore>();

export function dailyCapUsd(env: Env): number {
  const v = Number(env.SAM_DAILY_BUDGET_USD);
  return Math.min(Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_USD, MAX_DAILY_USD);
}

function defaultStore(env: Env) {
  return (day: string): BudgetStore | null => {
    const shared = storeFromEnv(env, `sam:spent_micro_usd:${day}`);
    if (shared) return shared;
    if (env.ANALYST_BUDGET_LOCAL !== '1') return null;
    let s = localDays.get(day);
    if (!s) {
      localDays.clear();
      localDays.set(day, (s = memoryStore()));
    }
    return s;
  };
}

type SamRequest = {image: string; width: number; height: number; boxes: Box[]};

export function parseSamRequest(body: unknown): SamRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  const m = typeof b.image === 'string' ? b.image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/) : null;
  if (!m) return '"image" must be a JPEG data URL (data:image/jpeg;base64,…).';
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return `"image" is larger than ${MAX_IMAGE_BYTES / 1e6} MB; send a downscaled frame.`;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return '"image" is not a JPEG.';
  const side = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= MAX_SIDE;
  if (!side(b.width) || !side(b.height)) return `"width" and "height" must be the frame's size in pixels (16–${MAX_SIDE}).`;
  const w = b.width as number;
  const h = b.height as number;
  if (b.boxes !== undefined && !Array.isArray(b.boxes)) return '"boxes" must be an array of [x1, y1, x2, y2].';
  const boxes: Box[] = [];
  for (const x of (b.boxes as unknown[] | undefined) ?? []) {
    if (!Array.isArray(x) || x.length !== 4 || !x.every(v => typeof v === 'number' && Number.isFinite(v))) return 'Each box must be [x1, y1, x2, y2] numbers.';
    const [x1, y1, x2, y2] = x as Box;
    if (x2 <= x1 || y2 <= y1 || x2 <= 0 || y2 <= 0 || x1 >= w || y1 >= h) continue; // empty or off-frame
    boxes.push([x1, y1, x2, y2]);
    if (boxes.length === MAX_BOXES) break;
  }
  return {image: b.image as string, width: w, height: h, boxes};
}

/** Never let the key into a message, whatever the upstream echoed. */
const redact = (s: string, key: string) => (key ? s.split(key).join('[redacted]') : s);

export async function handleSam(body: unknown, env: Env = process.env, deps: SamDeps = {}): Promise<Result> {
  const key = env.MODEL_API_KEY?.trim();
  if (!key) return {status: 503, body: {error: 'SAM 3.1 outlines are unavailable: the server has no Model API key.', code: 'no_key'}};
  const req = parseSamRequest(body);
  if (typeof req === 'string') return {status: 400, body: {error: req}};
  const now = deps.now ?? Date.now;
  const v = (deps.limiter ?? limiter).take(deps.client ?? 'unknown');
  if (!v.ok) {
    const per = `${v.limit.max} frames per ${v.limit.windowMs / 1000} s`;
    return {
      status: 429,
      body: {error: `SAM 3.1 is limited to ${per} ${v.scope === 'visitor' ? 'per visitor' : 'across all visitors'}.`, code: 'rate_limited', retryAfterS: v.retryAfterS},
      headers: {'Retry-After': String(v.retryAfterS)}
    };
  }
  const day = new Date(now()).toISOString().slice(0, 10);
  const store = (deps.store ?? defaultStore(env))(day);
  if (!store) return {status: 503, body: {error: 'Spend tracking is not configured, so SAM 3.1 outlines are paused rather than spending untracked.', code: 'no_store'}};
  const cap = dailyCapUsd(env);
  const cost = Math.ceil(PRICE_PER_IMAGE_USD * 1e6);
  try {
    if (!(await store.reserve(cost, Math.ceil(cap * 1e6)))) {
      throw new BudgetError(`SAM 3.1 outlines have used today's $${cap} budget, so they are paused until 00:00 UTC.`);
    }
  } catch (e) {
    if (e instanceof BudgetError) return {status: 503, body: {error: e.message, code: 'budget'}};
    console.error('[sam] budget store failed:', redact(String((e as Error).message ?? e), key));
    return {status: 503, body: {error: 'Spend tracking is unavailable, so SAM 3.1 outlines are paused.', code: 'no_store'}};
  }
  const prompt = req.boxes.length ? {boxes: req.boxes, width: req.width, height: req.height} : {text: TEXT_PROMPT};
  const t0 = now();
  let result: SamResult;
  try {
    result = await segmentFrame(key, requestBody(req.image, prompt), req, deps.fetch);
  } catch (e) {
    const status = e instanceof SamApiError ? e.status : 0;
    // Refused up front (4xx other than a timeout): nothing was billed, so the reservation comes back.
    if (status >= 400 && status < 500 && status !== 408) await store.adjust(-cost).catch(() => undefined);
    const cause = (e as {cause?: {code?: string}}).cause?.code;
    const msg = redact(`${(e as Error).message ?? e}${cause ? ` (${cause})` : ''}`, key);
    console.error(`[sam] request failed: ${msg}`);
    const timeout = (e as Error).name === 'TimeoutError';
    return {status: 502, body: {error: timeout ? 'SAM 3.1 did not answer in time.' : msg, code: status === 429 ? 'upstream_rate_limited' : 'upstream'}};
  }
  return {
    status: 200,
    body: {
      outlines: result.outlines,
      width: result.width,
      height: result.height,
      ms: now() - t0,
      prompt: req.boxes.length ? 'boxes' : TEXT_PROMPT,
      ...(result.diagnostics.length ? {diagnostics: result.diagnostics} : {})
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage & {body?: unknown}): Promise<unknown> {
  // Vercel pre-parses JSON bodies (and throws from the getter on bad JSON); Vite does not.
  let pre: unknown;
  try {
    pre = req.body;
  } catch {
    throw new SyntaxError('invalid JSON');
  }
  if (pre !== undefined) return typeof pre === 'string' ? JSON.parse(pre) : pre;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RangeError('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export default async function handler(req: IncomingMessage & {body?: unknown}, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, {error: 'Use POST with a JSON body: {image, width, height, boxes?}.'});
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, e instanceof RangeError ? 413 : 400, {error: e instanceof RangeError ? 'Body too large.' : 'Body is not valid JSON.'});
  }
  const out = await handleSam(body, process.env, {client: clientId(req)});
  send(res, out.status, out.body, out.headers);
}
