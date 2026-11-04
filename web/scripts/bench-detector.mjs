/**
 * Measures the Live detector's per-frame latency in a real browser (npm run bench:detector).
 *
 * Starts the Vite dev server, opens bench/detector.html in headless Chrome through playwright-core,
 * and runs the app's own createDetector()/detect() (onnxruntime-web, WASM) on real 1280x720 frames of
 * a bundled drone clip. Prints the result and writes it as JSON (default bench/detector-latency.json).
 *
 * The page is not cross-origin isolated (neither is the deployed app: no COOP/COEP headers), so
 * onnxruntime-web runs on one thread, as it does for users.
 *
 *   node scripts/bench-detector.mjs [--runs 200] [--frames 20] [--warmup 10] [--clip <url>] [--out <file>]
 *
 * CHROME_PATH=<binary> picks the browser; otherwise installed Google Chrome, then Playwright's own
 * Chromium. The clip is H.264, so the browser needs that codec (Google Chrome has it).
 */
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const runs = Number(arg('runs', 200));
const frames = Number(arg('frames', 20));
const warmup = Number(arg('warmup', 10));
const clip = arg('clip', '/data/eaton/footage/clips/blm-north-bank.mp4');
const out = path.resolve(webRoot, arg('out', 'bench/detector-latency.json'));

async function launch() {
  if (process.env.CHROME_PATH) return {browser: await chromium.launch({executablePath: process.env.CHROME_PATH}), which: `CHROME_PATH=${process.env.CHROME_PATH}`};
  try {
    return {browser: await chromium.launch({channel: 'chrome'}), which: 'Google Chrome (channel chrome)'};
  } catch {
    return {browser: await chromium.launch(), which: "Playwright's Chromium"};
  }
}

const server = await createServer({root: webRoot, logLevel: 'error', server: {port: 0, host: '127.0.0.1'}});
await server.listen();
const base = server.resolvedUrls.local[0];
const {browser, which} = await launch();
try {
  const page = await browser.newPage();
  page.on('console', m => m.type() === 'error' && console.error('[page]', m.text()));
  page.on('response', res => res.status() >= 400 && !res.url().endsWith('/favicon.ico') && console.error('[page]', res.status(), res.url()));
  const q = new URLSearchParams({clip, frames: String(frames), warmup: String(warmup), runs: String(runs)});
  await page.goto(`${base}bench/detector.html?${q}`);
  await page.waitForFunction(() => window.__bench, null, {timeout: 600_000, polling: 500});
  const r = await page.evaluate(() => window.__bench);
  if (r.error) throw new Error(r.error);
  const cpus = os.cpus();
  const result = {
    what: 'Sentinel fire detector, Drones → Live code path (createDetector/detect in src/drones/live/detector.ts), headless browser',
    date: new Date().toISOString(),
    command: `node scripts/bench-detector.mjs --runs ${runs} --frames ${frames} --warmup ${warmup}`,
    browser: `${which} ${browser.version()}`,
    machine: {platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: cpus[0]?.model, logical_cpus: cpus.length},
    timing_note: 'pre = letterbox drawImage + getImageData + float CHW tensor; infer = session.run; post = decode + class-wise NMS; total_detect_call = the whole detect() call. Video decode and drawing boxes are not included.',
    ...r
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const m = result.ms;
  console.log(`${result.browser} · ${result.machine.cpu} · ${result.backend}, ${result.threads} thread(s)`);
  for (const k of Object.keys(m)) console.log(`${k.padEnd(18)} median ${m[k].median} ms · p90 ${m[k].p90} ms · min ${m[k].min} · max ${m[k].max} (n ${m[k].n})`);
  console.log(`wrote ${path.relative(webRoot, out)}`);
} finally {
  await browser.close();
  await server.close();
}
