import type * as Ort from 'onnxruntime-web';
// The runtime's .wasm binaries, served by Vite as assets (the bundled builds embed their .mjs glue).
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortAsyncifyWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import {DEFAULT_META, letterbox, postprocess, rgbaToChw, type Det, type ModelMeta} from './decode';

/**
 * Sentinel in the browser: the YOLOv8n fire/smoke weights exported to ONNX (public/models/, synced
 * from the Meta build), run with onnxruntime-web. The runtime's .wasm files are imported with `?url`
 * so Vite serves them from this site, and nothing loads from a CDN at run time.
 */

export type Backend = 'wasm' | 'webgpu';

const BASE = '/';
export const MODEL_URL = `${BASE}models/sentinel_fire.onnx`;
export const META_URL = `${MODEL_URL}.json`;

export type FrameResult = {
  dets: Det[];
  /** Letterbox + pixel read + tensor build, ms. */
  preMs: number;
  /** session.run alone, ms. */
  inferMs: number;
  /** Decode + NMS, ms. */
  postMs: number;
};

export type Detector = {
  meta: ModelMeta;
  backend: Backend;
  threads: number;
  /** Fetch + session creation, ms. */
  loadMs: number;
  detect: (src: CanvasImageSource, srcW: number, srcH: number, conf?: number) => Promise<FrameResult>;
  dispose: () => void;
};

async function loadOrt(backend: Backend): Promise<typeof Ort> {
  const ort = backend === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = {wasm: backend === 'webgpu' ? ortAsyncifyWasmUrl : ortWasmUrl};
  // Threads need cross-origin isolation (SharedArrayBuffer); without it the runtime uses one.
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  return ort;
}

type MetaFile = {
  classes?: string[];
  imgsz?: number;
  input?: {name?: string; shape?: number[]};
  output?: {name?: string};
  postprocessing?: {conf?: number; nms_iou?: number; max_det?: number};
  metadata_props?: Record<string, string>;
};

/** sentinel_fire.onnx.json, written by pipeline/tools/export_sentinel_onnx.py; the defaults match it. */
async function loadMeta(): Promise<ModelMeta> {
  const res = await fetch(META_URL);
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return DEFAULT_META;
  const j = (await res.json()) as MetaFile;
  return {
    ...DEFAULT_META,
    input: j.input?.name ?? DEFAULT_META.input,
    output: j.output?.name,
    imgsz: j.imgsz ?? j.input?.shape?.[2] ?? DEFAULT_META.imgsz,
    classes: j.classes ?? DEFAULT_META.classes,
    conf: j.postprocessing?.conf ?? DEFAULT_META.conf,
    iou: j.postprocessing?.nms_iou ?? DEFAULT_META.iou,
    maxDet: j.postprocessing?.max_det ?? DEFAULT_META.maxDet
  };
}

export async function createDetector(backend: Backend = 'wasm'): Promise<Detector> {
  const start = performance.now();
  const [ort, meta, model] = await Promise.all([
    loadOrt(backend),
    loadMeta(),
    fetch(MODEL_URL).then(r => {
      if (!r.ok) throw new Error(`${MODEL_URL}: HTTP ${r.status}`);
      const type = r.headers.get('content-type') ?? '';
      if (type.includes('text/html')) throw new Error(`${MODEL_URL} is not in this build`);
      return r.arrayBuffer();
    })
  ]);
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: [backend],
    graphOptimizationLevel: 'all'
  });
  const input = session.inputNames.includes(meta.input) ? meta.input : session.inputNames[0];
  const output = meta.output && session.outputNames.includes(meta.output) ? meta.output : session.outputNames[0];
  const size = meta.imgsz;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx) throw new Error('2D canvas unavailable');
  const chw = new Float32Array(3 * size * size);
  let busy = false;

  async function detect(src: CanvasImageSource, srcW: number, srcH: number, conf = meta.conf): Promise<FrameResult> {
    if (busy) throw new Error('detector busy');
    busy = true;
    try {
      const t0 = performance.now();
      const lb = letterbox(srcW, srcH, size);
      ctx!.fillStyle = 'rgb(114,114,114)';
      ctx!.fillRect(0, 0, size, size);
      ctx!.drawImage(src, lb.padX, lb.padY, lb.w, lb.h);
      rgbaToChw(ctx!.getImageData(0, 0, size, size).data, size, chw);
      const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
      const t1 = performance.now();
      const out = await session.run({[input as string]: tensor});
      const t2 = performance.now();
      const y = out[output!];
      const data = (await y!.getData()) as Float32Array;
      const dets = postprocess(data, y!.dims, lb, srcW, srcH, conf, meta.iou, meta.maxDet);
      for (const t of Object.values(out)) t.dispose?.();
      const t3 = performance.now();
      return {dets, preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2};
    } finally {
      busy = false;
    }
  }

  return {
    meta,
    backend,
    threads: ort.env.wasm.numThreads ?? 1,
    loadMs: performance.now() - start,
    detect,
    dispose: () => void session.release()
  };
}
