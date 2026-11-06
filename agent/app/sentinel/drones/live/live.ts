import {create} from 'zustand';
import {median, rate, type Det} from './decode';
import type {Backend, Detector} from './detector';

/**
 * LIVE mode: Sentinel runs in the browser on frames of a live source as they arrive. Every number this
 * module reports is measured here, on this device, from the frames it actually processed.
 */

export type SourceKind = 'camera' | 'screen' | 'file';

export type LiveSource = {
  kind: SourceKind;
  /** Device or window label, or the file's name. */
  name: string;
  stream?: MediaStream;
  /** For a file or URL played in real time as a stream. */
  url?: string;
  /** Provenance shown on the feed, e.g. the bundled clip's "not this fire" note. */
  note?: string;
};

export type LiveStats = {
  /** Rolling medians over the last WINDOW processed frames, ms. */
  inferMs: number | null;
  preMs: number | null;
  postMs: number | null;
  /** Frame capture (camera) or presentation (other sources) → boxes drawn. */
  e2eMs: number | null;
  e2eBasis: 'capture' | 'presented';
  procFps: number | null;
  srcFps: number | null;
  framesSeen: number;
  framesProcessed: number;
  /** Seconds since the stream's first frame. */
  streamS: number;
  /** Seconds after the first frame that the first box appeared (capture/presentation time of that frame). */
  firstDetS: number | null;
  /** For a file: position in the file of that frame. */
  firstDetMediaS: number | null;
  dets: Det[];
  /** performance.now() of the frame `dets` came from (capture time for a camera, else when it was shown). */
  detsFrameAt: number | null;
  frameW: number;
  frameH: number;
};

/** One processed frame, for the dock charts. */
export type LiveSample = {t: number; inferMs: number; e2eMs: number; n: number; maxConf: number};

const EMPTY: LiveStats = {
  inferMs: null,
  preMs: null,
  postMs: null,
  e2eMs: null,
  e2eBasis: 'presented',
  procFps: null,
  srcFps: null,
  framesSeen: 0,
  framesProcessed: 0,
  streamS: 0,
  firstDetS: null,
  firstDetMediaS: null,
  dets: [],
  detsFrameAt: null,
  frameW: 0,
  frameH: 0
};

export type LiveStatus = 'idle' | 'starting' | 'loading' | 'running' | 'ended' | 'error';

type LiveState = {
  source: LiveSource | null;
  status: LiveStatus;
  error: string | null;
  backend: Backend;
  /** Detector name and threshold once loaded. */
  model: {arch: string; imgsz: number; conf: number; iou: number; classes: string[]; threads: number; loadMs: number} | null;
  stats: LiveStats;
  history: LiveSample[];
  showBoxes: boolean;
  expanded: boolean;
  open: (source: LiveSource) => void;
  close: () => void;
  set: (patch: Partial<Omit<LiveState, 'open' | 'close' | 'set'>>) => void;
};

function release(s: LiveSource | null) {
  s?.stream?.getTracks().forEach(t => t.stop());
  if (s?.url?.startsWith('blob:')) URL.revokeObjectURL(s.url);
}

export const useLive = create<LiveState>((set, get) => ({
  source: null,
  status: 'idle',
  error: null,
  backend: 'wasm',
  model: null,
  stats: EMPTY,
  history: [],
  showBoxes: true,
  expanded: false,
  open: source => {
    release(get().source);
    set({source, status: 'starting', error: null, stats: EMPTY, history: []});
  },
  close: () => {
    release(get().source);
    set({source: null, status: 'idle', error: null, stats: EMPTY, history: []});
  },
  set: patch => set(patch)
}));

/** Ask for a camera (a phone, drone controller or capture card can appear as one). */
export async function openCamera(deviceId?: string): Promise<LiveSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {...(deviceId ? {deviceId: {exact: deviceId}} : {}), width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}},
    audio: false
  });
  return {kind: 'camera', name: stream.getVideoTracks()[0]?.label || 'Camera', stream};
}

/** Capture a screen or window, e.g. a drone app's live view. */
export async function openScreen(): Promise<LiveSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: {ideal: 30}}, audio: false});
  return {kind: 'screen', name: stream.getVideoTracks()[0]?.label || 'Screen capture', stream};
}

const WINDOW = 30;

type FrameMeta = {now: number; presentedFrames: number; captureTime?: number | undefined; presentationTime?: number | undefined; mediaTime?: number | undefined};
type VideoFrameCb = (now: number, m: {presentedFrames: number; captureTime?: number; presentationTime?: number; mediaTime?: number}) => void;
type RvfcVideo = HTMLVideoElement & {requestVideoFrameCallback?: (cb: VideoFrameCb) => number; cancelVideoFrameCallback?: (id: number) => void};

const CYAN = '#4fe3f0';

/** Corner-bracket boxes, the same mark as the recorded player (DESIGN.md §7.1), in frame pixels. */
export function drawBoxes(ctx: CanvasRenderingContext2D, dets: Det[], classes: string[], px: number) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.strokeStyle = CYAN;
  ctx.fillStyle = CYAN;
  ctx.lineWidth = 2 * px;
  ctx.font = `${11 * px}px "JetBrains Mono", monospace`;
  for (const d of dets) {
    const [x1, y1, x2, y2] = d.box;
    const l = Math.min(14 * px, (x2 - x1) / 3, (y2 - y1) / 3);
    ctx.beginPath();
    for (const [x, y, dx, dy] of [
      [x1, y1, 1, 1],
      [x2, y1, -1, 1],
      [x1, y2, 1, -1],
      [x2, y2, -1, -1]
    ]) {
      ctx.moveTo(x! + dx! * l, y!);
      ctx.lineTo(x!, y!);
      ctx.lineTo(x!, y! + dy! * l);
    }
    ctx.stroke();
    const name = (classes[d.cls] ?? `class ${d.cls}`) === 'fire' ? 'FLAME' : (classes[d.cls] ?? `CLASS ${d.cls}`).toUpperCase();
    const above = y1 - 4 * px;
    ctx.fillText(`SENTINEL · ${name} ${d.score.toFixed(2)}`, x1 + (above < 12 * px ? 3 * px : 0), above < 12 * px ? y1 + 13 * px : above);
  }
}

/**
 * The live loop. Source frames are tracked with requestVideoFrameCallback; whenever the detector is
 * free it takes the newest frame the video holds, so frames that arrive mid-inference are dropped,
 * never queued. Boxes are drawn on a canvas over the video, and the frame's capture (or presentation)
 * time to the next animation frame after drawing is the end-to-end latency. "First detection" counts
 * from `streamStart`, so it includes the time the model took to load.
 */
export function runLive(video: HTMLVideoElement, overlay: HTMLCanvasElement, detector: Detector, streamStart: number): () => void {
  const v = video as RvfcVideo;
  let running = true;
  // Written by the frame callbacks; the cast stops TypeScript narrowing it to null in the loop.
  let latest = null as FrameMeta | null;
  let processedFrame = -1;
  // Stream start: the source's first decoded frame (performance.now()), before the model finished loading.
  let t0 = streamStart as number | null;
  const srcStamps: {t: number; f: number}[] = [];
  const procStamps: number[] = [];
  const infer: number[] = [];
  const pre: number[] = [];
  const post: number[] = [];
  const e2e: number[] = [];
  let basis: 'capture' | 'presented' = 'presented';
  let firstDetS: number | null = null;
  let firstDetMediaS: number | null = null;
  let dets: Det[] = [];
  let detsFrameAt: number | null = null;
  let processed = 0;
  let wake: (() => void) | null = null;
  let cbId = 0;
  const history: LiveSample[] = [];

  const onFrame: VideoFrameCb = (now, m) => {
    if (!running) return;
    latest = {now, presentedFrames: m.presentedFrames, captureTime: m.captureTime, presentationTime: m.presentationTime, mediaTime: m.mediaTime};
    if (t0 === null) t0 = m.captureTime ?? m.presentationTime ?? now;
    srcStamps.push({t: m.presentationTime ?? now, f: m.presentedFrames});
    while (srcStamps.length > 2 && srcStamps[srcStamps.length - 1]!.t - srcStamps[0]!.t > 2000) srcStamps.shift();
    wake?.();
    cbId = v.requestVideoFrameCallback!(onFrame);
  };

  // Fallback where requestVideoFrameCallback is missing: sample on animation frames, by currentTime.
  let rafId = 0;
  let lastMedia = -1;
  let rafFrames = 0;
  const onRaf = (now: number) => {
    if (!running) return;
    if (video.readyState >= 2 && video.currentTime !== lastMedia) {
      lastMedia = video.currentTime;
      rafFrames++;
      latest = {now, presentedFrames: rafFrames, mediaTime: video.currentTime};
      if (t0 === null) t0 = now;
      srcStamps.push({t: now, f: rafFrames});
      while (srcStamps.length > 2 && srcStamps[srcStamps.length - 1]!.t - srcStamps[0]!.t > 2000) srcStamps.shift();
      wake?.();
    }
    rafId = requestAnimationFrame(onRaf);
  };
  if (v.requestVideoFrameCallback) cbId = v.requestVideoFrameCallback(onFrame);
  else rafId = requestAnimationFrame(onRaf);

  const nextFrame = () => new Promise<void>(r => (wake = r));
  const painted = () => new Promise<number>(r => requestAnimationFrame(() => r(performance.now())));

  const ctx = overlay.getContext('2d')!;
  const push = (xs: number[], x: number) => {
    xs.push(x);
    if (xs.length > WINDOW) xs.shift();
  };

  const publish = () => {
    const now = performance.now();
    const src = srcStamps.length > 1 ? srcStamps[srcStamps.length - 1] : null;
    const srcFps = src && src.t > srcStamps[0]!.t ? ((src.f - srcStamps[0]!.f) * 1000) / (src.t - srcStamps[0]!.t) : null;
    while (procStamps.length > 2 && now - procStamps[0]! > 3000) procStamps.shift();
    useLive.getState().set({
      stats: {
        inferMs: median(infer),
        preMs: median(pre),
        postMs: median(post),
        e2eMs: median(e2e),
        e2eBasis: basis,
        procFps: rate(procStamps),
        srcFps,
        framesSeen: latest?.presentedFrames ?? 0,
        framesProcessed: processed,
        streamS: t0 === null ? 0 : (now - t0) / 1000,
        firstDetS,
        firstDetMediaS,
        dets,
        detsFrameAt,
        frameW: video.videoWidth,
        frameH: video.videoHeight
      },
      history: history.slice()
    });
  };
  const timer = setInterval(publish, 250);

  (async () => {
    while (running) {
      if (!latest || latest.presentedFrames === processedFrame || video.readyState < 2) {
        await nextFrame();
        continue;
      }
      const frame: FrameMeta = latest;
      processedFrame = frame.presentedFrames;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) continue;
      const stamp = frame.captureTime ?? frame.presentationTime ?? frame.now;
      basis = frame.captureTime !== undefined ? 'capture' : 'presented';
      let r;
      try {
        r = await detector.detect(video, w, h);
      } catch (e) {
        if (running) useLive.getState().set({status: 'error', error: `inference failed: ${(e as Error).message ?? e}`});
        return;
      }
      if (!running) return;
      if (overlay.width !== w || overlay.height !== h) {
        overlay.width = w;
        overlay.height = h;
      }
      dets = r.dets;
      detsFrameAt = stamp;
      const px = w / Math.max(1, overlay.clientWidth || w);
      if (useLive.getState().showBoxes) drawBoxes(ctx, dets, detector.meta.classes, px);
      else ctx.clearRect(0, 0, w, h);
      const drawn = await painted();
      processed++;
      push(infer, r.inferMs);
      push(pre, r.preMs);
      push(post, r.postMs);
      push(e2e, drawn - stamp);
      procStamps.push(drawn);
      if (dets.length && firstDetS === null && t0 !== null) {
        firstDetS = Math.max(0, (stamp - t0) / 1000);
        firstDetMediaS = frame.mediaTime ?? null;
      }
      history.push({
        t: t0 === null ? 0 : (stamp - t0) / 1000,
        inferMs: r.inferMs,
        e2eMs: drawn - stamp,
        n: dets.length,
        maxConf: Math.max(0, ...dets.map(d => d.score))
      });
      if (history.length > 3000) history.shift();
    }
  })();

  return () => {
    running = false;
    wake?.();
    clearInterval(timer);
    if (cbId) v.cancelVideoFrameCallback?.(cbId);
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  };
}
