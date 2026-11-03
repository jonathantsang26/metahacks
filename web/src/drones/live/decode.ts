/**
 * Pure pre/post-processing for Sentinel's YOLOv8 ONNX export, kept free of onnxruntime and the DOM so
 * it can be unit tested (decode.test.ts). Matches Ultralytics' predict path: letterbox to a square
 * input with grey (114) padding, one class per anchor (the best score), then class-wise NMS.
 */

/** The fields the app needs, read from web/public/models/sentinel_fire.onnx.json (see detector.ts). */
export type ModelMeta = {
  input: string;
  imgsz: number;
  classes: string[];
  conf: number;
  iou: number;
  /** Optional extras the export may record; shown as-is when present. */
  output?: string;
  arch?: string;
  maxDet?: number;
};

export const DEFAULT_META: ModelMeta = {input: 'images', imgsz: 416, classes: ['fire', 'smoke'], conf: 0.25, iou: 0.7, maxDet: 300, arch: 'YOLOv8n'};

/** A box in some pixel space: x1, y1, x2, y2. */
export type Box = [number, number, number, number];
export type Det = {box: Box; cls: number; score: number};

export type Letterbox = {scale: number; padX: number; padY: number; w: number; h: number; size: number};

/** Ultralytics LetterBox (auto=False, center=True): scale to fit, centre, pad the rest. */
export function letterbox(srcW: number, srcH: number, size: number): Letterbox {
  const scale = Math.min(size / srcW, size / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const padX = Math.max(0, Math.round((size - w) / 2 - 0.1));
  const padY = Math.max(0, Math.round((size - h) / 2 - 0.1));
  return {scale, padX, padY, w, h, size};
}

/** RGBA pixels of the letterboxed canvas → float32 CHW RGB in [0, 1]. */
export function rgbaToChw(rgba: Uint8ClampedArray | Uint8Array, size: number, out = new Float32Array(3 * size * size)): Float32Array {
  const n = size * size;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = rgba[p] / 255;
    out[n + i] = rgba[p + 1] / 255;
    out[2 * n + i] = rgba[p + 2] / 255;
  }
  return out;
}

/**
 * YOLOv8 head output [1, 4 + nc, N] (row-major): rows cx, cy, w, h (input pixels), then one score
 * per class. Keeps anchors whose best class score is ≥ conf; boxes stay in input pixels.
 */
export function decodeYolo(data: Float32Array | number[], dims: readonly number[], conf: number): Det[] {
  const [, rows, n] = dims.length === 3 ? dims : [1, dims[0], dims[1]];
  const nc = rows - 4;
  if (nc < 1) throw new Error(`unexpected YOLO output shape [${dims.join(', ')}]`);
  const out: Det[] = [];
  for (let a = 0; a < n; a++) {
    let best = -1;
    let score = -Infinity;
    for (let c = 0; c < nc; c++) {
      const s = data[(4 + c) * n + a];
      if (s > score) {
        score = s;
        best = c;
      }
    }
    if (score < conf) continue;
    const cx = data[a];
    const cy = data[n + a];
    const w = data[2 * n + a];
    const h = data[3 * n + a];
    out.push({box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], cls: best, score});
  }
  return out;
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS within each class (boxes of different classes never suppress each other); highest score first. */
export function nmsByClass(dets: Det[], iouThr: number, maxDet = 300): Det[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: Det[] = [];
  for (const d of sorted) {
    if (kept.length >= maxDet) break;
    if (kept.some(k => k.cls === d.cls && iou(k.box, d.box) > iouThr)) continue;
    kept.push(d);
  }
  return kept;
}

/** Input-pixel box → source-frame pixels, clipped to the frame. */
export function unletterbox(box: Box, lb: Letterbox, srcW: number, srcH: number): Box {
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  return [
    clamp((box[0] - lb.padX) / lb.scale, srcW),
    clamp((box[1] - lb.padY) / lb.scale, srcH),
    clamp((box[2] - lb.padX) / lb.scale, srcW),
    clamp((box[3] - lb.padY) / lb.scale, srcH)
  ];
}

/** decode → NMS → source pixels: the whole post-processing step. */
export function postprocess(
  data: Float32Array | number[],
  dims: readonly number[],
  lb: Letterbox,
  srcW: number,
  srcH: number,
  conf: number,
  iouThr: number,
  maxDet = 300
): Det[] {
  return nmsByClass(decodeYolo(data, dims, conf), iouThr, maxDet).map(d => ({...d, box: unletterbox(d.box, lb, srcW, srcH)}));
}

/** Median of a sample (rolling windows are small, so a sort is fine). */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Events per second over the timestamps (ms) in a window: (count − 1) / span. */
export function rate(stamps: readonly number[]): number | null {
  if (stamps.length < 2) return null;
  const span = stamps[stamps.length - 1] - stamps[0];
  return span > 0 ? ((stamps.length - 1) * 1000) / span : null;
}

/** 83.4 s → "1:23.4". */
export const fmtStreamClock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
