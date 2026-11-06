import {callAction} from '@agent-native/core/client/hooks';
import {create} from 'zustand';

/**
 * SAM 3.1 outlines on the live feed. Sentinel boxes every frame in the browser; SAM 3.1 runs on the
 * Meta Model API through the `sam-outline` action (the Meta build's /api/sam), so at most one frame is out at a time and at most one is sent per
 * INTERVAL_MS, and only while Sentinel has a box. A frame that comes due while one is in flight is
 * skipped, never queued, so the outline always comes from the newest frame sent and its age is shown.
 */

export const INTERVAL_MS = 2000;
/** Longest side of the frame sent to SAM, px. */
export const SEND_SIDE = 640;
export const JPEG_QUALITY = 0.75;
/** Outlines older than this are dropped rather than drawn over a scene that has moved on. */
export const MAX_AGE_MS = 8000;

export type SamOutline = {id: string; bounds: [number, number, number, number]; conf: number | null; polygons: number[][]};

export type SamFrame = {
  outlines: SamOutline[];
  /** Size of the frame SAM saw (the downscaled one); outlines are in its pixels. */
  width: number;
  height: number;
  prompt: string;
  /** performance.now() when the frame was grabbed. */
  capturedAt: number;
  /** The video's position when it was grabbed (file sources), for looking up SRT telemetry. */
  videoTimeS: number | null;
  /** Grab → response, ms (includes encode, upload, SAM and download). */
  rttMs: number;
  /** The server's measured Model API call, ms. */
  apiMs: number | null;
};

/** `text`: the prompt "fire". `boxes`: Sentinel's boxes as SAM's object prompts. */
export type SamMode = 'off' | 'text' | 'boxes';

export type Grab = {
  image: string;
  width: number;
  height: number;
  boxes?: [number, number, number, number][];
  capturedAt: number;
  /** video.currentTime at the grab, for a file source. */
  videoTimeS?: number | null;
};

type Reply = {status: number; body: any; retryAfterS?: number};
export type Post = (g: Grab) => Promise<Reply>;

export type PollerEvent =
  | {kind: 'result'; frame: SamFrame}
  | {kind: 'unavailable'; message: string}
  | {kind: 'error'; message: string; retryInMs: number};

/**
 * The throttle, separate from React and the DOM so it is testable: `tick` sends only if a box is
 * up, nothing is in flight, INTERVAL_MS has passed since the last send and no back-off is pending.
 * A refusal that will not change on its own (no key, no spend tracking, budget used) stops it.
 */
export function createSamPoller(post: Post, emit: (e: PollerEvent) => void, now: () => number = () => performance.now(), intervalMs = INTERVAL_MS) {
  let inFlight = false;
  let lastSent = -Infinity;
  let until = -Infinity;
  let stopped = false;
  let sent = 0;
  let skipped = 0;
  return {
    get stats() {
      return {sent, skipped, inFlight, stopped};
    },
    /** `grab` is called only when a frame will be sent, so a skipped tick costs nothing. */
    async tick(hasBox: boolean, grab: () => Grab | null): Promise<boolean> {
      if (stopped || !hasBox) return false;
      const t = now();
      if (t - lastSent < intervalMs || t < until) return false;
      if (inFlight) {
        skipped++;
        return false;
      }
      const g = grab();
      if (!g) return false;
      inFlight = true;
      lastSent = t;
      sent++;
      try {
        const r = await post(g);
        const b = r.body ?? {};
        if (r.status === 200) {
          emit({
            kind: 'result',
            frame: {outlines: b.outlines ?? [], width: b.width ?? g.width, height: b.height ?? g.height, prompt: b.prompt ?? '', capturedAt: g.capturedAt, videoTimeS: g.videoTimeS ?? null, rttMs: now() - g.capturedAt, apiMs: b.ms ?? null}
          });
        } else if (r.status === 503 || r.status === 404 || r.status === 405) {
          stopped = true;
          emit({
            kind: 'unavailable',
            message: r.status === 503 ? (b.error ?? 'SAM 3.1 outlines are unavailable.') : 'SAM 3.1 outlines are unavailable: this server has no sam-outline action.'
          });
        } else {
          const wait = r.status === 429 ? Math.max(1, r.retryAfterS ?? b.retryAfterS ?? 10) * 1000 : 5000;
          until = now() + wait;
          emit({kind: 'error', message: b.error ?? `SAM 3.1 request failed (${r.status}).`, retryInMs: wait});
        }
      } catch (e) {
        until = now() + 5000;
        emit({kind: 'error', message: `SAM 3.1 request failed: ${(e as Error).message ?? e}`, retryInMs: 5000});
      } finally {
        inFlight = false;
      }
      return true;
    }
  };
}

type ActionError = Error & {status?: number; retryAfterMs?: number; actionMessage?: string};

/**
 * POST a grab to the `sam-outline` action ({fire, imageBase64}, plus the frame size and Sentinel's
 * boxes as object prompts), mapped back to the HTTP-style reply the poller expects. The action keeps
 * the Meta build's spend caps: a refusal arrives as 503 (stop) or 429 (back off).
 */
export const postSam: Post = async g => {
  const fire = new URLSearchParams(window.location.search).get('fire') ?? 'eaton';
  try {
    const body = await callAction<any>(
      'sam-outline',
      {fire, imageBase64: g.image, width: g.width, height: g.height, ...(g.boxes ? {boxes: g.boxes} : {})},
      {method: 'POST', timeoutMs: 30_000}
    );
    // An action may report a refusal in its result rather than as an HTTP error.
    if (body && typeof body.error === 'string' && !Array.isArray(body.outlines)) {
      const status = typeof body.status === 'number' ? body.status : 503;
      return {status, body, retryAfterS: typeof body.retryAfterS === 'number' ? body.retryAfterS : undefined};
    }
    return {status: 200, body};
  } catch (e) {
    const err = e as ActionError;
    const status = err.status ?? 0;
    if (!status) throw err;
    const message = err.actionMessage ?? err.message;
    return {status, body: {error: message}, retryAfterS: err.retryAfterMs ? err.retryAfterMs / 1000 : undefined};
  }
};

/** Size of the frame sent: the video's, scaled so the longest side is at most SEND_SIDE. */
export function sendSize(w: number, h: number, side = SEND_SIDE): {width: number; height: number; scale: number} {
  const scale = Math.min(1, side / Math.max(w, h));
  return {width: Math.max(16, Math.round(w * scale)), height: Math.max(16, Math.round(h * scale)), scale};
}

/** Grabs the video's current frame as a downscaled JPEG, with Sentinel's boxes in its pixels. */
export function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, boxes: [number, number, number, number][] | null): Grab | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return null;
  const {width, height, scale} = sendSize(vw, vh);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const capturedAt = performance.now();
  const videoTimeS = video.currentTime;
  ctx.drawImage(video, 0, 0, width, height);
  const image = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const scaled = boxes?.map(b => b.map(v => Math.round(v * scale)) as [number, number, number, number]);
  return {image, width, height, capturedAt, videoTimeS, ...(scaled?.length ? {boxes: scaled} : {})};
}

/** Polygons as one SVG path (even-odd fill keeps holes open). */
export const polygonPath = (polygons: number[][]) =>
  polygons.map(p => `M${p.slice(0, 2).join(' ')}${Array.from({length: p.length / 2 - 1}, (_, i) => `L${p[2 * i + 2]} ${p[2 * i + 3]}`).join('')}Z`).join('');

type SamState = {
  mode: SamMode;
  frame: SamFrame | null;
  /** A clean, persistent reason the route can't be used (no key, no spend tracking, budget). */
  unavailable: string | null;
  /** A transient failure, retried after a back-off. */
  error: string | null;
  sent: number;
  rtts: number[];
  set: (patch: Partial<Omit<SamState, 'set'>>) => void;
};

export const useSam = create<SamState>(set => ({
  mode: 'text',
  frame: null,
  unavailable: null,
  error: null,
  sent: 0,
  rtts: [],
  set: patch => set(patch)
}));

export const NEXT_MODE: Record<SamMode, SamMode> = {text: 'boxes', boxes: 'off', off: 'text'};
