/**
 * SAM 3.1 mask payloads → binary rasters. A TypeScript port of the decoder in Meta's meta-sam-parser
 * (the Python package pipeline/ already depends on; pipeline/steps/s12c_sam_video.py), so the server
 * route needs no new dependency. Payloads are base85 (not base64) after a one-character marker:
 * `~` lossless (the API default, a coverage byte per pixel, ≥ 129 counts as inside) or `!` one_bit.
 * api/_tests/samcodec.test.ts checks it against rasters the Python decoder produced.
 */

const EXCLUDED = new Set(['"', '\\', ',', ';', '<', '>', '|']);
const VALUES = new Int16Array(128).fill(-1);
{
  let i = 0;
  for (let c = 0x21; c < 0x7f; c++) if (!EXCLUDED.has(String.fromCharCode(c))) VALUES[c] = i++;
}
const RADIX = 85;
const PREFIX = 5;
const TOP = 2 ** 24;
const BOTTOM = 2 ** 16;
const SYMBOLS = 256;

export class MaskDecodeError extends Error {}

const u32 = (v: number) => v >>> 0;

function digit(s: string, i: number): number {
  const c = s.charCodeAt(i);
  // VALUES has 128 entries, so c < 128 is in range (charCodeAt past the end is NaN and fails it).
  const v = c < 128 ? VALUES[c]! : -1;
  if (v < 0) throw new MaskDecodeError('mask payload has an invalid character');
  return v;
}

/** Base85 with a 5-digit length prefix, 4 bytes per 5 digits, a short tail for the remainder. */
export function unpack(payload: string): Uint8Array {
  if (payload.length < PREFIX) throw new MaskDecodeError('mask payload is missing its length prefix');
  let length = 0;
  for (let i = 0; i < PREFIX; i++) length = length * RADIX + digit(payload, i);
  const rem = length % 4;
  const expected = PREFIX + Math.floor(length / 4) * 5 + (rem ? rem + 1 : 0);
  if (payload.length !== expected) throw new MaskDecodeError('mask payload length does not match its prefix');
  const out = new Uint8Array(length);
  let src = PREFIX;
  let dst = 0;
  const full = length - rem;
  while (dst < full) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + digit(payload, src + i);
    if (v > 0xffffffff) throw new MaskDecodeError('mask payload has an out-of-range group');
    src += 5;
    out[dst] = v >>> 24;
    out[dst + 1] = (v >>> 16) & 0xff;
    out[dst + 2] = (v >>> 8) & 0xff;
    out[dst + 3] = v & 0xff;
    dst += 4;
  }
  if (rem) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + (i < rem + 1 ? digit(payload, src + i) : RADIX - 1);
    if (v > 0xffffffff) throw new MaskDecodeError('mask payload has an out-of-range tail');
    for (let i = 0; i < rem; i++) out[dst + i] = (v >>> (24 - i * 8)) & 0xff;
  }
  return out;
}

class RangeDecoder {
  private pos = 0;
  private low = 0;
  private range = 0xffffffff;
  private code = 0;
  private scaled = 0;
  constructor(private readonly input: Uint8Array) {
    if (input.length < 4) throw new MaskDecodeError('mask payload is missing its finalization');
    for (let i = 0; i < 4; i++) this.code = u32(this.code * 256 + this.read());
  }
  freq(total: number): number {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) throw new MaskDecodeError('mask payload has invalid coding state');
    const v = Math.floor(u32(this.code - this.low) / this.scaled);
    return v >= total ? total - 1 : v;
  }
  decode(cum: number, freq: number): void {
    this.low = u32(this.low + this.scaled * cum);
    this.range = this.scaled * freq;
    for (;;) {
      if (u32(this.low ^ u32(this.low + this.range)) < TOP) {
        // top byte settled
      } else if (this.range < BOTTOM) {
        this.range = u32(-this.low) & (BOTTOM - 1);
      } else break;
      this.code = u32(this.code * 256 + this.read());
      this.low = u32(this.low * 256);
      this.range = u32(this.range * 256);
    }
  }
  private read(): number {
    if (this.pos >= this.input.length) throw new MaskDecodeError('mask payload ended before decoding completed');
    return this.input[this.pos++]!;
  }
}

function paeth(l: number, u: number, ul: number): number {
  const e = l + u - ul;
  const dl = Math.abs(e - l);
  const du = Math.abs(e - u);
  const dul = Math.abs(e - ul);
  if (dl <= du && dl <= dul) return l;
  return du <= dul ? u : ul;
}

function predict(out: Uint8Array, o: number, x: number, y: number, mode: number, w: number): number {
  if (mode < 0 || mode >= 5) throw new MaskDecodeError('lossless mask payload uses an invalid predictor');
  // o is the current pixel (o = y * w + x), so each neighbour read is guarded onto an earlier pixel.
  const l = x > 0 ? out[o - 1]! : 0;
  const u = y > 0 ? out[o - w]! : 0;
  if (mode === 1) return u;
  if (mode === 2) return l;
  if (mode === 3) return (l + u) >> 1;
  const ul = x > 0 && y > 0 ? out[o - w - 1]! : 0;
  if (mode === 0) return paeth(l, u, ul);
  if (ul >= Math.max(l, u)) return Math.min(l, u);
  if (ul <= Math.min(l, u)) return Math.max(l, u);
  return l + u - ul;
}

function decodeLossless(payload: string, w: number, h: number): Uint8Array {
  const packed = unpack(payload.slice(1));
  const selector = packed[0];
  if (packed.length < 5 || selector === undefined) throw new MaskDecodeError('lossless mask payload is truncated');
  const dec = new RangeDecoder(packed.subarray(1));
  const n = w * h;
  const out = new Uint8Array(n);
  const res = new Uint8Array(n);
  const zeroCounts = new Uint32Array(32).fill(1);
  const one = new Uint16Array(SYMBOLS * SYMBOLS).fill(1);
  const oneTotals = new Int32Array(SYMBOLS).fill(SYMBOLS);
  const zero = new Uint16Array(SYMBOLS).fill(2);
  let zeroTotal = SYMBOLS * 2;
  const two = new Map<number, Uint16Array>();
  let prev = 0;
  // Non-null reads below: o < n indexes out/res and neighbours are guarded by x, y; zo + 1 < 32; prev,
  // sym < SYMBOLS index the model tables (fo + sym < SYMBOLS²); second has SYMBOLS + 1 entries.
  for (let o = 0; o < n; o++) {
    const x = o % w;
    const y = (o - x) / w;
    const zl = x > 0 ? +(res[o - 1]! === 0) : 1;
    const zu = y > 0 ? +(res[o - w]! === 0) : 1;
    const zul = x > 0 && y > 0 ? +(res[o - w - 1]! === 0) : 1;
    const zur = y > 0 && x < w - 1 ? +(res[o - w + 1]! === 0) : 1;
    const zo = (zl | (zu << 1) | (zul << 2) | (zur << 3)) << 1;
    const z = zeroCounts[zo]!;
    const nz = zeroCounts[zo + 1]!;
    const bit = dec.freq(z + nz) < z ? 0 : 1;
    dec.decode(bit ? z : 0, bit ? nz : z);
    zeroCounts[zo + bit]! += 32;
    if (zeroCounts[zo]! + zeroCounts[zo + 1]! >= 16384) {
      zeroCounts[zo] = zeroCounts[zo]! >> 1 || 1;
      zeroCounts[zo + 1] = zeroCounts[zo + 1]! >> 1 || 1;
    }
    let sym = 0;
    if (bit) {
      const above = o >= w ? res[o - w]! : 0;
      const key = (prev << 8) | above;
      let second = two.get(key);
      if (!second) two.set(key, (second = new Uint16Array(SYMBOLS + 1)));
      const fo = prev << 8;
      const total = second[SYMBOLS]! + oneTotals[prev]! + zeroTotal - (second[0]! + one[fo]! + zero[0]!);
      const target = dec.freq(total);
      let cum = 0;
      sym = 1;
      let f = second[1]! + one[fo + 1]! + zero[1]!;
      while (cum + f <= target) {
        cum += f;
        if (++sym >= SYMBOLS) throw new MaskDecodeError('lossless mask payload is malformed');
        f = second[sym]! + one[fo + sym]! + zero[sym]!;
      }
      dec.decode(cum, f);
      second[sym]! += 14 * 44;
      second[SYMBOLS]! += 14 * 44;
      if (second[SYMBOLS]! >= 14 * 3584) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += second[v]! >>= 1;
        second[SYMBOLS] = t;
      }
      one[fo + sym]! += 56;
      oneTotals[prev]! += 56;
      if (oneTotals[prev]! >= 8192) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += one[fo + v] = one[fo + v]! >> 1 || 1;
        oneTotals[prev] = t;
      }
      zero[sym]! += 32;
      zeroTotal += 32;
      if (zeroTotal >= 4096) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += zero[v]! >>= 1;
        zeroTotal = t;
      }
    }
    res[o] = sym;
    const delta = sym & 1 ? -((sym + 1) >> 1) : sym >> 1;
    out[o] = (predict(out, o, x, y, selector, w) + delta) & 0xff;
    prev = sym;
  }
  for (let o = 0; o < n; o++) out[o] = out[o]! >= 129 ? 1 : 0;
  return out;
}

function decodeOneBit(payload: string, w: number, h: number): Uint8Array {
  const dec = new RangeDecoder(unpack(payload.slice(1)));
  const counts = new Uint16Array(1 << 13).fill(1);
  const pw = w + 4;
  const padded = new Uint8Array(pw * (h + 2));
  const out = new Uint8Array(w * h);
  // Non-null reads below: padded has two border rows above and two columns each side, so every
  // context offset from p lands inside it; off + 1 < 2 << 12 since ctx has 12 bits.
  for (let y = 0; y < h; y++) {
    const row = (y + 2) * pw + 2;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const a = p - pw;
      const b = p - 2 * pw;
      const ctx =
        padded[p - 1]! |
        (padded[p - 2]! << 1) |
        (padded[a - 2]! << 2) |
        (padded[a - 1]! << 3) |
        (padded[a]! << 4) |
        (padded[a + 1]! << 5) |
        (padded[a + 2]! << 6) |
        (padded[b - 2]! << 7) |
        (padded[b - 1]! << 8) |
        (padded[b]! << 9) |
        (padded[b + 1]! << 10) |
        (padded[b + 2]! << 11);
      const off = ctx << 1;
      const z = counts[off]!;
      const o = counts[off + 1]!;
      const bit = dec.freq(z + o) < z ? 0 : 1;
      dec.decode(bit ? z : 0, bit ? o : z);
      padded[p] = bit;
      out[y * w + x] = bit;
      counts[off + bit]! += 14;
      if (counts[off]! + counts[off + 1]! >= 4096) {
        counts[off] = counts[off]! >> 1 || 1;
        counts[off + 1] = counts[off + 1]! >> 1 || 1;
      }
    }
  }
  return out;
}

/** Row-major 0/1 raster of `width × height` from a `data=H,W,<payload>` mask. */
export function decodeMask(payload: string, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 1 << 24) {
    throw new MaskDecodeError('mask dimensions are not positive and bounded');
  }
  if (payload.startsWith('~')) return decodeLossless(payload, width, height);
  if (payload.startsWith('!')) return decodeOneBit(payload, width, height);
  throw new MaskDecodeError(`unsupported mask encoding marker ${JSON.stringify(payload[0] ?? '')}`);
}

/**
 * Outline of a raster as closed polygons on pixel-cell corners: every edge between an inside and an
 * outside cell, chained into loops (inside on the left), with straight runs merged. Coordinates are
 * raster corners, 0..width and 0..height.
 */
export function traceOutline(raster: Uint8Array, w: number, h: number): number[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? raster[y * w + x] : 0);
  // Directed edges keyed by start corner; a corner can start two edges at a diagonal touch.
  const next = new Map<number, number[]>();
  const id = (x: number, y: number) => y * (w + 1) + x;
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const k = id(x1, y1);
    const list = next.get(k);
    if (list) list.push(id(x2, y2));
    else next.set(k, [id(x2, y2)]);
  };
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      // Horizontal edge on top of cell (x, y), between (x, y-1) above and (x, y) below.
      if (x < w && at(x, y - 1) !== at(x, y)) at(x, y) ? add(x + 1, y, x, y) : add(x, y, x + 1, y);
      // Vertical edge left of cell (x, y), between (x-1, y) and (x, y).
      if (y < h && at(x - 1, y) !== at(x, y)) at(x, y) ? add(x, y, x, y + 1) : add(x, y + 1, x, y);
    }
  }
  const loops: number[][] = [];
  for (const [start, ends] of next) {
    while (ends.length) {
      const pts: number[] = [];
      let cur = start;
      let to = ends.pop()!;
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        pts.push(cur % (w + 1), Math.floor(cur / (w + 1)));
        cur = to;
        if (cur === start) break;
        const list = next.get(cur);
        if (!list?.length) break;
        to = list.pop()!;
      }
      // Drop collinear vertices so straight runs are one segment.
      const out: number[] = [];
      const n = pts.length / 2;
      // pts holds n (x, y) pairs and every index below is reduced mod n, so the reads are in range.
      for (let i = 0; i < n; i++) {
        const [px, py] = [pts[((i + n - 1) % n) * 2]!, pts[((i + n - 1) % n) * 2 + 1]!];
        const [cx, cy] = [pts[i * 2]!, pts[i * 2 + 1]!];
        const [nx, ny] = [pts[((i + 1) % n) * 2]!, pts[((i + 1) % n) * 2 + 1]!];
        if ((cx - px) * (ny - cy) - (cy - py) * (nx - cx) !== 0) out.push(cx, cy);
      }
      if (out.length >= 6) loops.push(out);
    }
  }
  return loops;
}
