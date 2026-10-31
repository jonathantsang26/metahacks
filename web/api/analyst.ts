import type {IncomingMessage, ServerResponse} from 'node:http';
import {DEFAULT_MODEL, runAnalyst} from './_lib/analyst.js';
import {FIRE_ID, FireStore} from './_lib/data.js';
import {createChatClient} from './_lib/model.js';
import {clientId, createLimiter, limitMessage, REPORT_COST, type Limiter} from './_lib/ratelimit.js';
import type {AnalystRequest, HistoryTurn} from './_lib/types.js';

/**
 * POST /api/analyst: the Muse Spark analyst. Vercel runs the default export; `npm run dev` runs
 * the same export through a Vite middleware (vite.config.ts). The model key never leaves the server.
 */

const MAX_QUESTION = 2000;
const MAX_HISTORY = 12;
const MAX_TURN = 2000;
/** History is resent on every model round, so its total size, not just its turn count, sets a request's cost. */
const MAX_HISTORY_CHARS = 8000;
const MAX_BODY = 64 * 1024;
/** Leaves room for one forced final call (20 s timeout) inside vercel.json's maxDuration of 60 s. */
const LOOP_BUDGET_MS = 35_000;

type Result = {status: number; body: unknown; headers?: Record<string, string>};
/** Who is asking, and the limiter that decides whether they may spend a model call now. */
type Guard = {client: string; limiter: Limiter};

const limiter = createLimiter();

export function parseRequest(body: unknown): AnalystRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (typeof b.question !== 'string' || !b.question.trim()) return '"question" must be a non-empty string.';
  if (b.question.length > MAX_QUESTION) return `"question" is longer than ${MAX_QUESTION} characters.`;
  const fire = b.fire ?? 'eaton';
  if (typeof fire !== 'string' || !FIRE_ID.test(fire)) return '"fire" must be a fire id such as "eaton".';
  const mode = b.mode ?? 'answer';
  if (mode !== 'answer' && mode !== 'report') return '"mode" must be "answer" or "report".';
  if (b.history !== undefined && !Array.isArray(b.history)) return '"history" must be an array of {role, content}.';
  // Only user/assistant text turns are accepted: a client can't inject system or tool messages.
  const history: HistoryTurn[] = ((b.history as unknown[] | undefined) ?? [])
    .filter((h): h is HistoryTurn => {
      const t = h as Partial<HistoryTurn> | null;
      return !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && !!t.content.trim();
    })
    .slice(-MAX_HISTORY)
    .map(h => ({role: h.role, content: h.content.slice(0, MAX_TURN)}));
  // Keep the most recent turns that fit in MAX_HISTORY_CHARS.
  let total = 0;
  const kept = history.reverse().filter(h => (total += h.content.length) <= MAX_HISTORY_CHARS).reverse();
  return {question: b.question.trim(), fire, mode, history: kept};
}

export async function handleAnalyst(body: unknown, env: {MODEL_API_KEY?: string} = process.env, root?: string, guard?: Guard): Promise<Result> {
  const key = env.MODEL_API_KEY?.trim();
  if (!key) {
    return {
      status: 503,
      body: {error: 'MODEL_API_KEY is not set on the server, so the analyst is unavailable. It does not answer without the model.'}
    };
  }
  const req = parseRequest(body);
  if (typeof req === 'string') return {status: 400, body: {error: req}};
  const store = new FireStore(req.fire, root);
  if (!store.exists()) return {status: 404, body: {error: `No data for fire "${req.fire}".`}};
  // Counted only for requests that would reach the model.
  if (guard) {
    const v = guard.limiter.take(guard.client, req.mode === 'report' ? REPORT_COST : 1);
    if (!v.ok) return {status: 429, body: {error: limitMessage(v)}, headers: {'Retry-After': String(v.retryAfterS)}};
  }
  try {
    const run = await runAnalyst(req, {chat: createChatClient(key), store, model: DEFAULT_MODEL, deadline: Date.now() + LOOP_BUDGET_MS});
    return {status: 200, body: run.response};
  } catch (e) {
    const status = (e as {status?: unknown}).status;
    if (typeof status === 'number') {
      console.error(`[analyst] model API error ${status}: ${(e as Error).message}`);
      return {status: 502, body: {error: `The model API returned ${status}: ${(e as Error).message}`}};
    }
    console.error('[analyst] request failed', e);
    return {status: 500, body: {error: `Analyst failed: ${(e as Error).message}`}};
  }
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
    return send(res, 405, {error: 'Use POST with a JSON body: {question, fire?, history?, mode?}.'});
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, e instanceof RangeError ? 413 : 400, {error: e instanceof RangeError ? 'Body too large.' : 'Body is not valid JSON.'});
  }
  const out = await handleAnalyst(body, process.env, undefined, {client: clientId(req), limiter});
  send(res, out.status, out.body, out.headers);
}
