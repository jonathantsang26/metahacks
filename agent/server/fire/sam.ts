import {MODEL_BASE_URL} from './model.js';
import {decodeMask, traceOutline} from './samcodec.js';

/**
 * SAM 3.1 on one live frame through the Meta Model API (Responses API, streamed), the same request
 * pipeline/steps/s12c_sam_video.py and tools/smoke_meta.py send for an image: a text concept prompt
 * ("fire") or Sentinel's boxes as object prompts, the JPEG as a data URL, confidence requested.
 * The streamed output text is SAM's segmentation protocol: one `<0f>` line for an image, then
 * comma-separated `id<|box;…|><|mask;…|>` records (protocol: github.com/meta-models/meta-sam).
 */

export const SAM_MODEL = 'sam-3.1';
export const TEXT_PROMPT = 'fire';
/** Meta Model API image price for SAM 3.1: $2.50 per 1k images (as in s12c_sam_video.py). */
export const PRICE_PER_IMAGE_USD = 0.0025;
/** Per-call timeout; vercel.json gives the route 30 s. */
export const SAM_TIMEOUT_MS = 20_000;

/** A detector box in frame pixels, [x1, y1, x2, y2]. */
export type Box = [number, number, number, number];

export type SamOutline = {
  /** SAM's object id within this response. */
  id: string;
  /** Half-open box, frame pixels. */
  bounds: Box;
  conf: number | null;
  /** Closed polygons [x0, y0, x1, y1, …] in frame pixels. */
  polygons: number[][];
};

export type SamResult = {outlines: SamOutline[]; width: number; height: number; diagnostics: string[]};

/** Object-prompt text for boxes, the token format meta-sam-parser's buildObjectPrompt writes (x2, y2 inclusive). */
export function objectPrompt(boxes: Box[], width: number, height: number): string {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const parts = boxes.map((b, i) => {
    const x1 = clamp(b[0], width - 1);
    const y1 = clamp(b[1], height - 1);
    const x2 = Math.max(x1, clamp(b[2], width) - 1);
    const y2 = Math.max(y1, clamp(b[3], height) - 1);
    return `${i}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${width};h=${height}|>`;
  });
  return `<0f>${parts.join(',')}`;
}

export function requestBody(image: string, prompt: {text: string} | {boxes: Box[]; width: number; height: number}) {
  const text = 'text' in prompt ? prompt.text : objectPrompt(prompt.boxes, prompt.width, prompt.height);
  return {
    model: SAM_MODEL,
    input: [{type: 'message', role: 'user', content: [{type: 'input_text', text}, {type: 'input_image', image_url: image}]}],
    stream: true,
    metadata: {include_confidence: 'true'}
  };
}

export class SamApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Reads the Responses API SSE stream and returns the output text; throws unless it completed. */
export async function readStream(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let text = '';
  let done = '';
  let completed = false;
  const onData = (payload: string) => {
    if (payload === '[DONE]') return;
    let e: {type?: string; delta?: string; text?: string; response?: {status?: string; incomplete_details?: {reason?: string}; error?: {message?: string}}};
    try {
      e = JSON.parse(payload);
    } catch {
      return;
    }
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') text += e.delta;
    else if (e.type === 'response.output_text.done' && typeof e.text === 'string') done = e.text;
    else if (e.type === 'response.completed') completed = true;
    else if (e.type === 'response.incomplete') throw new SamApiError(`SAM 3.1 response incomplete: ${e.response?.incomplete_details?.reason ?? 'no reason given'}`, 502);
    else if (e.type === 'response.failed' || e.type === 'error') throw new SamApiError(`SAM 3.1 response failed: ${e.response?.error?.message ?? 'no reason given'}`, 502);
  };
  for (;;) {
    const {value, done: end} = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
    if (end) break;
  }
  if (buf.startsWith('data:')) onData(buf.slice(5).trim());
  if (!completed) throw new SamApiError('SAM 3.1 stream ended before the response completed.', 502);
  return done || text;
}

const fields = (token: string) => {
  const out: Record<string, string> = {};
  for (const f of token.split(';').slice(1)) {
    const i = f.indexOf('=');
    if (i > 0) out[f.slice(0, i).trim()] = f.slice(i + 1).trim();
  }
  return out;
};
const conf = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/** Output text → outlines in frame pixels. Malformed records are skipped and reported in `diagnostics`. */
export function parseOutput(output: string, frame: {width: number; height: number}): SamResult {
  const outlines: SamOutline[] = [];
  const diagnostics: string[] = [];
  let width = frame.width;
  let height = frame.height;
  for (const line of output.split('\n')) {
    const frameRecords = line.trim().match(/^<(\d+)f>(.*)$/)?.[2];
    if (frameRecords === undefined) continue;
    const records = frameRecords.matchAll(/(\d+)<\|(box;[^|]*)\|><\|(mask;[^|]*)\|>/g);
    for (const [, id, boxTok, maskTok] of records) {
      try {
        // The pattern's groups are all required, so a match always has them.
        if (id === undefined || boxTok === undefined || maskTok === undefined) throw new Error('record is incomplete');
        const b = fields(boxTok);
        const k = fields(maskTok);
        const at = (n: string) => Number(b[n]);
        const [x1, y1, x2, y2, w, h] = [at('x1'), at('y1'), at('x2'), at('y2'), at('w'), at('h')];
        if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('box is missing a corner');
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) [width, height] = [w, h];
        const data = maskTok.slice(maskTok.indexOf('data=') + 5);
        const c1 = data.indexOf(',');
        const c2 = data.indexOf(',', c1 + 1);
        if (!k.data || c1 < 0 || c2 < 0) throw new Error('mask has no data');
        const mh = Number(data.slice(0, c1));
        const mw = Number(data.slice(c1 + 1, c2));
        const raster = decodeMask(data.slice(c2 + 1), mw, mh);
        // x2, y2 are inclusive on the wire; the raster covers the half-open box.
        const bounds: Box = [x1, y1, x2 + 1, y2 + 1];
        const sx = (bounds[2] - bounds[0]) / mw;
        const sy = (bounds[3] - bounds[1]) / mh;
        const r1 = (v: number) => Math.round(v * 10) / 10;
        const polygons = traceOutline(raster, mw, mh).map(loop => loop.map((v, i) => r1(i % 2 ? bounds[1] + v * sy : bounds[0] + v * sx)));
        outlines.push({id, bounds, conf: conf(k.c ?? b.c), polygons});
      } catch (e) {
        diagnostics.push(`object ${id}: ${(e as Error).message}`);
      }
    }
  }
  return {outlines, width, height, diagnostics};
}

/** One SAM 3.1 call. `fetchImpl` is the HTTP transport; tests pass a mock. The key goes only in the header. */
export async function segmentFrame(
  key: string,
  body: ReturnType<typeof requestBody>,
  frame: {width: number; height: number},
  fetchImpl: typeof fetch = fetch
): Promise<SamResult> {
  const r = await fetchImpl(`${MODEL_BASE_URL}/responses`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SAM_TIMEOUT_MS)
  });
  if (!r.ok || !r.body) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    throw new SamApiError(`The Model API returned ${r.status}${detail ? `: ${detail}` : ''}`, r.status);
  }
  return parseOutput(await readStream(r.body), frame);
}
