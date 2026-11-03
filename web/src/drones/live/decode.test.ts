import {describe, expect, it} from 'vitest';
import {decodeYolo, fmtStreamClock, iou, letterbox, median, nmsByClass, postprocess, rate, rgbaToChw, unletterbox, type Det} from './decode';

/** Builds a [1, 4 + nc, n] YOLO output from per-anchor rows [cx, cy, w, h, ...scores]. */
function yolo(anchors: number[][]): {data: Float32Array; dims: number[]} {
  const rows = anchors[0].length;
  const n = anchors.length;
  const data = new Float32Array(rows * n);
  anchors.forEach((a, i) => a.forEach((v, r) => (data[r * n + i] = v)));
  return {data, dims: [1, rows, n]};
}

describe('letterbox', () => {
  it('fits a 16:9 frame into 416 with centred vertical padding', () => {
    const lb = letterbox(1280, 720, 416);
    expect(lb.scale).toBeCloseTo(0.325);
    expect(lb.w).toBe(416);
    expect(lb.h).toBe(234);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(91);
  });
  it('pads horizontally for a portrait frame', () => {
    const lb = letterbox(720, 1280, 416);
    expect(lb.h).toBe(416);
    expect(lb.w).toBe(234);
    expect(lb.padX).toBe(91);
    expect(lb.padY).toBe(0);
  });
  it('round-trips a box through input space', () => {
    const lb = letterbox(1280, 720, 416);
    const src: [number, number, number, number] = [100, 200, 400, 500];
    const inp: [number, number, number, number] = [src[0] * lb.scale + lb.padX, src[1] * lb.scale + lb.padY, src[2] * lb.scale + lb.padX, src[3] * lb.scale + lb.padY];
    unletterbox(inp, lb, 1280, 720).forEach((v, i) => expect(v).toBeCloseTo(src[i], 6));
  });
  it('clips boxes that run into the padding', () => {
    const lb = letterbox(1280, 720, 416);
    expect(unletterbox([-10, 0, 500, 416], lb, 1280, 720)).toEqual([0, 0, 1280, 720]);
  });
});

describe('rgbaToChw', () => {
  it('splits RGBA into planar RGB scaled to [0, 1] and drops alpha', () => {
    const rgba = new Uint8ClampedArray([255, 0, 51, 255, 0, 102, 255, 0]);
    // size 1 reads only the first pixel.
    const chw = Array.from(rgbaToChw(rgba, 1));
    expect(chw).toHaveLength(3);
    expect(chw[0]).toBeCloseTo(1);
    expect(chw[1]).toBeCloseTo(0);
    expect(chw[2]).toBeCloseTo(0.2);
  });
  it('lays out a 2×2 image channel by channel', () => {
    const px = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120]
    ];
    const rgba = new Uint8ClampedArray(px.flatMap(p => [...p, 255]));
    const out = Array.from(rgbaToChw(rgba, 2)).map(v => Math.round(v * 255));
    expect(out).toEqual([10, 40, 70, 100, 20, 50, 80, 110, 30, 60, 90, 120]);
  });
});

describe('decodeYolo', () => {
  it('reads cx,cy,w,h and the best class per anchor, dropping anchors under conf', () => {
    const {data, dims} = yolo([
      [100, 100, 20, 40, 0.9, 0.1],
      [200, 50, 10, 10, 0.2, 0.6],
      [300, 300, 50, 50, 0.1, 0.24]
    ]);
    const dets = decodeYolo(data, dims, 0.25);
    expect(dets).toHaveLength(2);
    expect(dets[0].cls).toBe(0);
    expect(dets[0].score).toBeCloseTo(0.9);
    expect(dets[0].box).toEqual([90, 80, 110, 120]);
    expect(dets[1].cls).toBe(1);
    expect(dets[1].box).toEqual([195, 45, 205, 55]);
  });
  it('accepts a 2-D [rows, n] shape', () => {
    const {data} = yolo([[10, 10, 4, 4, 0.5, 0]]);
    expect(decodeYolo(data, [6, 1], 0.25)).toHaveLength(1);
  });
  it('rejects a shape with no class rows', () => {
    expect(() => decodeYolo(new Float32Array(4), [1, 4, 1], 0.25)).toThrow();
  });
});

describe('nmsByClass', () => {
  const d = (box: [number, number, number, number], cls: number, score: number): Det => ({box, cls, score});
  it('computes IoU', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150);
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
  it('suppresses overlapping boxes of the same class, keeping the highest score', () => {
    const kept = nmsByClass([d([0, 0, 10, 10], 0, 0.5), d([1, 1, 11, 11], 0, 0.9), d([50, 50, 60, 60], 0, 0.3)], 0.45);
    expect(kept.map(k => k.score)).toEqual([0.9, 0.3]);
  });
  it('never suppresses across classes', () => {
    const kept = nmsByClass([d([0, 0, 10, 10], 0, 0.9), d([0, 0, 10, 10], 1, 0.8)], 0.45);
    expect(kept).toHaveLength(2);
  });
  it('keeps boxes whose overlap is at or under the threshold', () => {
    // IoU 1/3 < 0.45
    const kept = nmsByClass([d([0, 0, 10, 10], 0, 0.9), d([5, 0, 15, 10], 0, 0.8)], 0.45);
    expect(kept).toHaveLength(2);
  });
  it('at the default IoU 0.7, keeps a same-class box overlapping 0.6 but drops one overlapping 0.8', () => {
    const base = d([0, 0, 100, 100], 0, 0.9);
    // [25,0,125,100] → IoU 75/125 = 0.6; [11,0,111,100] → 89/111 ≈ 0.80
    expect(nmsByClass([base, d([25, 0, 125, 100], 0, 0.8)], 0.7)).toHaveLength(2);
    expect(nmsByClass([base, d([11, 0, 111, 100], 0, 0.8)], 0.7)).toHaveLength(1);
  });
  it('caps the number of detections', () => {
    const many = Array.from({length: 10}, (_, i) => d([i * 20, 0, i * 20 + 10, 10], 0, 1 - i / 100));
    expect(nmsByClass(many, 0.45, 3)).toHaveLength(3);
  });
});

describe('postprocess', () => {
  it('decodes, suppresses and maps back to source pixels', () => {
    const lb = letterbox(1280, 720, 416);
    // A 416-space box centred at (208, 208) of 104×52 → source centre (640, 360), 320×160.
    const {data, dims} = yolo([
      [208, 208, 104, 52, 0.8, 0.05],
      [209, 208, 104, 52, 0.7, 0.05],
      [10, 10, 4, 4, 0.01, 0.02]
    ]);
    const dets = postprocess(data, dims, lb, 1280, 720, 0.25, 0.45);
    expect(dets).toHaveLength(1);
    const [x1, y1, x2, y2] = dets[0].box;
    expect(x1).toBeCloseTo(480, 4);
    expect(x2).toBeCloseTo(800, 4);
    expect(y1).toBeCloseTo(280, 4);
    expect(y2).toBeCloseTo(440, 4);
  });
});

describe('stats', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('rate over timestamps', () => {
    expect(rate([0])).toBeNull();
    expect(rate([0, 100, 200, 300, 400])).toBeCloseTo(10);
  });
  it('formats stream time', () => {
    expect(fmtStreamClock(3.21)).toBe('0:03.2');
    expect(fmtStreamClock(83.44)).toBe('1:23.4');
  });
});
