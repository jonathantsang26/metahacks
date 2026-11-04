/**
 * In-browser latency of the Live detector, using the app's own code path: createDetector() from
 * src/drones/live/detector.ts (onnxruntime-web, WASM, the same wasmPaths and thread rule as the app),
 * and detector.detect(), which times letterbox + pixel read + tensor build (pre), session.run (infer)
 * and decode + NMS (post). Frames are real 1280x720 frames of a bundled drone clip, grabbed into
 * ImageBitmaps first so video decoding and seeking are not timed.
 *
 * Query: ?clip=<url>&frames=20&warmup=10&runs=200. The result is written to window.__bench.
 */
import {createDetector} from '../src/drones/live/detector';

type Stats = {n: number; median: number; p90: number; mean: number; min: number; max: number};
const q = new URLSearchParams(location.search);
const clip = q.get('clip') ?? '/data/eaton/footage/clips/blm-north-bank.mp4';
const nFrames = Number(q.get('frames') ?? 20);
const warmup = Number(q.get('warmup') ?? 10);
const runs = Number(q.get('runs') ?? 200);

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (x: number) => Math.round(x * 100) / 100;
  return {n: s.length, median: r(at(0.5)), p90: r(at(0.9)), mean: r(s.reduce((a, b) => a + b, 0) / s.length), min: r(s[0]), max: r(s[s.length - 1])};
}

async function grabFrames(url: string, n: number): Promise<{frames: ImageBitmap[]; times: number[]; w: number; h: number}> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  await new Promise<void>((ok, fail) => {
    v.onloadeddata = () => ok();
    v.onerror = () => fail(new Error(`cannot decode ${url} (${v.error?.message ?? 'no codec?'})`));
  });
  const frames: ImageBitmap[] = [];
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * v.duration;
    await new Promise<void>(ok => {
      v.onseeked = () => ok();
      v.currentTime = t;
    });
    frames.push(await createImageBitmap(v));
    times.push(Math.round(t * 100) / 100);
  }
  return {frames, times, w: v.videoWidth, h: v.videoHeight};
}

async function main() {
  const {frames, times, w, h} = await grabFrames(clip, nFrames);
  const detector = await createDetector('wasm');
  for (let i = 0; i < warmup; i++) await detector.detect(frames[i % frames.length], w, h);
  const pre: number[] = [];
  const infer: number[] = [];
  const post: number[] = [];
  const total: number[] = [];
  const dets: number[] = [];
  for (let i = 0; i < runs; i++) {
    const f = frames[i % frames.length];
    const t0 = performance.now();
    const r = await detector.detect(f, w, h);
    total.push(performance.now() - t0);
    pre.push(r.preMs);
    infer.push(r.inferMs);
    post.push(r.postMs);
    if (i < frames.length) dets.push(r.dets.length);
  }
  detector.dispose();
  return {
    clip,
    frame: {width: w, height: h, count: frames.length, times_s: times, detections_per_frame: dets},
    model: {imgsz: detector.meta.imgsz, conf: detector.meta.conf, iou: detector.meta.iou},
    backend: detector.backend,
    threads: detector.threads,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
    load_ms: Math.round(detector.loadMs),
    warmup,
    runs,
    ms: {pre: stats(pre), infer: stats(infer), post: stats(post), total_detect_call: stats(total)},
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency
  };
}

const w = window as unknown as {__bench?: unknown};
main().then(
  r => {
    w.__bench = r;
    document.getElementById('out')!.textContent = JSON.stringify(r, null, 2);
  },
  e => {
    w.__bench = {error: String((e as Error)?.message ?? e)};
    document.getElementById('out')!.textContent = String(e);
  }
);
