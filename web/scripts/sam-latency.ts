/**
 * Measure SAM 3.1 round-trip latency on one frame, the way Live mode sends it: a ≤ 640 px JPEG to
 * POST /api/sam. Each call is one billed SAM 3.1 image ($0.0025).
 *
 *   ffmpeg -ss 10 -i public/data/eaton/footage/clips/blm-north-bank.mp4 -frames:v 1 -vf scale=640:-2 /tmp/frame.jpg
 *   npm run sam:latency -- /tmp/frame.jpg                      # through `npm run dev` on :5173 (browser path)
 *   npm run sam:latency -- /tmp/frame.jpg --url http://localhost:3000   # through `vercel dev`
 *   npm run sam:latency -- /tmp/frame.jpg --direct              # in-process handler → Meta only
 *   options: --n 10 (calls, 2 s apart, as Live mode paces them)  --boxes x1,y1,x2,y2  (object prompt)
 */
import {readFileSync} from 'node:fs';
import {handleSam} from '../api/sam.js';
import {localEnv, modelApiKey, NO_KEY_MESSAGE} from './_env.js';

function jpegSize(b: Buffer): {width: number; height: number} {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7)};
    i += 2 + len;
  }
  throw new Error('not a baseline/progressive JPEG');
}

const args = process.argv.slice(2);
const VALUED = ['--url', '--n', '--boxes'];
const file = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error('usage: npm run sam:latency -- <frame.jpg> [--url http://localhost:5173 | --direct] [--n 10] [--boxes x1,y1,x2,y2]');
  process.exit(2);
}
const bytes = readFileSync(file);
const {width, height} = jpegSize(bytes);
const body = {
  image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  width,
  height,
  ...(opt('boxes') ? {boxes: [opt('boxes')!.split(',').map(Number)]} : {})
};
const n = Number(opt('n') ?? 5);
const direct = args.includes('--direct');
const url = `${opt('url') ?? 'http://localhost:5173'}/api/sam`;
if (direct && !modelApiKey()) {
  console.error(NO_KEY_MESSAGE);
  process.exit(1);
}
console.log(`${file}: ${width}×${height}, ${(bytes.length / 1024).toFixed(0)} KB · ${direct ? 'in-process handler' : url} · ${n} calls (≈ $${(n * 0.0025).toFixed(4)})`);

const rtts: number[] = [];
for (let i = 0; i < n; i++) {
  const t0 = performance.now();
  let status: number;
  let out: any;
  if (direct) {
    const r = await handleSam(body, {...localEnv(), ANALYST_BUDGET_LOCAL: localEnv().ANALYST_BUDGET_LOCAL ?? '1'}, {client: 'cli'});
    [status, out] = [r.status, r.body];
  } else {
    const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    [status, out] = [r.status, await r.json().catch(() => null)];
  }
  const ms = performance.now() - t0;
  if (status !== 200) {
    console.log(`  ${i + 1}: HTTP ${status} ${out?.error ?? ''}`);
    if (status === 503) break;
  } else {
    rtts.push(ms);
    console.log(`  ${i + 1}: round trip ${ms.toFixed(0)} ms · Model API ${out.ms} ms · ${out.outlines.length} outline(s) · prompt ${out.prompt}`);
  }
  if (i < n - 1) await new Promise(r => setTimeout(r, Math.max(0, 2000 - ms)));
}
if (rtts.length) {
  const s = [...rtts].sort((a, b) => a - b);
  console.log(`median ${s[Math.floor(s.length / 2)].toFixed(0)} ms · min ${s[0].toFixed(0)} · max ${s[s.length - 1].toFixed(0)} (first call includes connection setup)`);
}
