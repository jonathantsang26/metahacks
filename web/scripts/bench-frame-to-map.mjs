/**
 * Frame-to-map latency of Drones → Live, measured in the real app (npm run bench:frame-to-map).
 *
 * Starts the Vite dev server, opens the app on Eaton's Drones tab in headless Chrome, types a manual
 * drone pose (the map centre, 120 m AGL, heading 0°, gimbal −45°), and plays the bundled test clip
 * (blm-north-bank.mp4) through the "Video file…" input, so it runs as any other video file does.
 * Every hit and every SAM 3.1 mask polygon carries frameAt (when its frame was shown, or grabbed for
 * SAM) and mappedAt (when it was added to the map store), both performance.now(); this reads them
 * back from the app's own store and reports frame → map. A requestAnimationFrame after each add
 * stands in for "drawn": deck.gl redraws on the next animation frame after its layers change.
 *
 * /api/sam is mocked: the browser's request is answered at once with one fixed mask outline (no SAM
 * call, no network, no key), so the mask numbers exclude SAM 3.1's own inference and the network.
 * They still include the frame grab, JPEG encode, the local request/JSON round trip, the outline
 * simplification and the ray casts onto the DEM.
 *
 * It runs twice: with the map drawn, as users see it, and with the map canvas hidden, which isolates
 * the pipeline from WebGL rendering (on a machine without a GPU Chrome renders WebGL in software and
 * each map redraw blocks the main thread; set F2M_GPU_NOTE to describe the GPU when there is one).
 *
 *   node scripts/bench-frame-to-map.mjs [--seconds 60] [--warmup 5] [--viewport 1440x900]
 *     [--map drawn,hidden] [--screenshots <dir>] [--out bench/frame-to-map.json]
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
const seconds = Number(arg('seconds', 60));
const warmupS = Number(arg('warmup', 5));
const clip = arg('clip', 'public/data/eaton/footage/clips/blm-north-bank.mp4');
const out = path.resolve(webRoot, arg('out', 'bench/frame-to-map.json'));
const [vw, vh] = arg('viewport', '1440x900').split('x').map(Number);
const modes = arg('map', 'drawn,hidden').split(',');
/** Optional directory for a screenshot of each run's last moment. */
const shots = arg('screenshots', null);
const gpuNote = process.env.F2M_GPU_NOTE ?? 'none (headless Chrome renders WebGL with SwiftShader, on the CPU)';
const POSE = {altAglM: '120', headingDeg: '0', pitchDeg: '-45'};

/** The fixed SAM answer: a 96-vertex ellipse (as a pixel staircase would be after tracing) in the frame's lower middle. */
function mockSam(width, height) {
  const ring = [];
  for (let i = 0; i < 96; i++) {
    const a = (-2 * Math.PI * i) / 96;
    ring.push(Math.round(width * (0.5 + 0.12 * Math.cos(a))), Math.round(height * (0.72 + 0.1 * Math.sin(a))));
  }
  const xs = ring.filter((_, i) => i % 2 === 0);
  const ys = ring.filter((_, i) => i % 2 === 1);
  return {
    outlines: [{id: '0', bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], conf: 0.9, polygons: [ring]}],
    width,
    height,
    ms: 0,
    prompt: 'fire'
  };
}

const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = v => Math.round(v * 10) / 10;
  return s.length ? {median: r(q(0.5)), p90: r(q(0.9)), min: r(s[0]), max: r(s[s.length - 1]), n: s.length} : {n: 0};
};

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

/** One run in a fresh page. `map`: 'drawn' as users see it, or 'hidden' (the map canvas display:none, so deck.gl draws nothing). */
async function run(map) {
  const page = await browser.newPage({viewport: {width: vw, height: vh}});
  page.on('console', m => m.type() === 'error' && console.error('[page]', m.text()));
  let samCalls = 0;
  await page.route('**/api/sam', async route => {
    const body = route.request().postDataJSON();
    samCalls++;
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(mockSam(body.width, body.height))});
  });
  await page.addInitScript(hide => {
    window.__longTasks = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__longTasks.push(e.duration))).observe({type: 'longtask', buffered: true});
    if (hide)
      addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = '#deckgl-wrapper { display: none !important; }';
        document.head.appendChild(st);
      });
  }, map === 'hidden');
  await page.goto(`${base}?fire=eaton&tab=drones`);

  // A typed-in pose over the map.
  await page.getByRole('button', {name: 'MANUAL POSE'}).click();
  await page.getByRole('button', {name: 'Map centre'}).click();
  for (const [k, v] of Object.entries(POSE)) await page.locator(`[data-pose=${k}]`).fill(v);
  await page.getByRole('button', {name: 'Apply pose'}).click();

  // Record, in the page, the first animation frame after each hit or mask reaches the store.
  await page.evaluate(async () => {
    const {useLiveHits} = await import('/src/drones/live/livemap.ts');
    const seen = new Set();
    const painted = (window.__painted = {hits: [], masks: []});
    useLiveHits.subscribe(s => {
      for (const [kind, xs] of [['hits', s.hits], ['masks', s.masks]]) {
        const fresh = xs.filter(x => !seen.has(`${kind}${x.id}`) && x.mappedAt !== undefined && x.frameAt !== undefined);
        if (!fresh.length) continue;
        for (const x of fresh) seen.add(`${kind}${x.id}`);
        requestAnimationFrame(() => {
          const t = performance.now();
          for (const x of fresh) painted[kind].push({id: x.id, frameAt: x.frameAt, paintedAt: t});
        });
      }
    });
  });

  await page.locator('input[type=file][accept="video/*"]').setInputFiles(path.resolve(webRoot, clip));
  await page.waitForFunction(() => document.querySelector('[data-testid=live-stats] [data-k=infer]')?.textContent?.includes('ms'), null, {timeout: 120_000});
  console.log(`map ${map}: running ${seconds} s of the clip…`);
  await page.waitForTimeout(seconds * 1000);
  if (shots) await page.screenshot({path: path.join(shots, `frame-to-map-${map}.png`)});

  const r = await page.evaluate(async () => {
    const {useLiveHits} = await import('/src/drones/live/livemap.ts');
    const {useLive} = await import('/src/drones/live/live.ts');
    const {useSam} = await import('/src/drones/live/sam.ts');
    const s = useLiveHits.getState();
    const l = useLive.getState();
    const pick = x => ({id: x.id, frameAt: x.frameAt, mappedAt: x.mappedAt, onMap: x.onMap});
    return {
      hits: s.hits.filter(h => h.frameAt !== undefined).map(pick),
      masks: s.masks.map(m => ({...pick(m), vertices: m.vertices, dropped: m.dropped, areaM2: m.areaM2})),
      painted: window.__painted,
      lastError: s.lastError,
      longTasks: window.__longTasks,
      live: {
        backend: l.backend,
        threads: l.model?.threads,
        frame: [l.stats.frameW, l.stats.frameH],
        framesSeen: l.stats.framesSeen,
        framesProcessed: l.stats.framesProcessed,
        procFps: l.stats.procFps && Math.round(l.stats.procFps * 100) / 100,
        inferMsMedian: l.stats.inferMs && Math.round(l.stats.inferMs),
        frameToBoxesDrawnMsMedian: l.stats.e2eMs && Math.round(l.stats.e2eMs),
        e2eBasis: l.stats.e2eBasis
      },
      samRttMs: useSam.getState().rtts,
      samError: useSam.getState().error ?? useSam.getState().unavailable
    };
  });
  await page.close();
  if (!r.hits.length) throw new Error(`map ${map}: no hits were placed (${r.lastError ?? 'no error'}); is the detector finding fire in the clip?`);

  // Drop the first warmupS seconds (model warm-up, first SAM call).
  const t0 = Math.min(...r.hits.map(h => h.frameAt)) + warmupS * 1000;
  const keep = xs => xs.filter(x => x.frameAt >= t0);
  const hits = keep(r.hits);
  const masks = keep(r.masks);
  return {
    ms: {
      frame_to_map_hit: stats(hits.map(h => h.mappedAt - h.frameAt)),
      frame_to_map_mask_excl_sam: stats(masks.map(m => m.mappedAt - m.frameAt)),
      ...(map === 'drawn'
        ? {
            frame_to_map_hit_next_frame: stats(keep(r.painted.hits).map(h => h.paintedAt - h.frameAt)),
            frame_to_map_mask_excl_sam_next_frame: stats(keep(r.painted.masks).map(m => m.paintedAt - m.frameAt))
          }
        : {}),
      sam_mock_round_trip: stats(r.samRttMs)
    },
    counts: {hits: hits.length, hits_on_map: hits.filter(h => h.onMap).length, masks: masks.length, masks_on_map: masks.filter(m => m.onMap).length, sam_requests_mocked: samCalls},
    mask_example: r.masks[0] ? {vertices_after_simplify: r.masks[0].vertices, dropped_above_horizon: r.masks[0].dropped, area_m2: Math.round(r.masks[0].areaM2)} : null,
    main_thread_long_tasks: {count: r.longTasks.length, total_ms: Math.round(r.longTasks.reduce((a, b) => a + b, 0)), ms: stats(r.longTasks)},
    live: r.live,
    sam_error: r.samError
  };
}

try {
  const runs = {};
  for (const map of modes) runs[`map_${map}`] = await run(map);
  const cpus = os.cpus();
  const result = {
    what: 'Frame → map latency of Drones → Live in the real app (Vite dev server), headless browser, bundled test clip played as a video file, typed-in pose',
    date: new Date().toISOString(),
    command: `node scripts/bench-frame-to-map.mjs --seconds ${seconds} --warmup ${warmupS} --viewport ${vw}x${vh} --map ${modes.join(',')}`,
    browser: `${which} ${browser.version()}`,
    machine: {platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: cpus[0]?.model, logical_cpus: cpus.length, gpu: gpuNote},
    clip: path.relative(webRoot, path.resolve(webRoot, clip)),
    viewport: [vw, vh],
    pose: {kind: 'manual (typed)', lat_lon: 'Eaton map centre (Map centre button)', alt_agl_m: Number(POSE.altAglM), heading_deg: Number(POSE.headingDeg), pitch_deg: Number(POSE.pitchDeg), hfov_deg: 73},
    timing_note: [
      "hit: frameAt = the video frame's presentation time (requestVideoFrameCallback; capture time for a camera) → mappedAt = the projected hit added to the map store. Includes waiting for the detector to be free, detection (YOLOv8n, onnxruntime-web WASM, on the main thread), drawing the boxes, the live loop's 250 ms publish tick, and the ray cast onto the DEM.",
      'mask: frameAt = when the frame was grabbed for SAM → mappedAt = the projected polygon added to the map store. /api/sam is MOCKED with a fixed outline answered at once: SAM 3.1 inference and the network to the Meta Model API are EXCLUDED. Included: JPEG encode, the local request/JSON round trip (through Playwright request interception), outline simplification and the ray casts. SAM is sent at most one frame every 2 s.',
      '*_next_frame (map drawn only): the first requestAnimationFrame callback after the add; deck.gl redraws its layers in that frame, so this approximates on-screen time. Not a pixel readback.',
      'map_drawn: the 3D map is drawn as users see it. This machine has no GPU, so Chrome renders WebGL in software (SwiftShader) and each deck.gl redraw blocks the main thread for seconds (see main_thread_long_tasks); detection, the publish tick and the SAM request all wait behind it. map_hidden: the same run with the map canvas display:none, so deck.gl draws nothing; this isolates the pipeline (detect → project → store) from software rendering. Neither is a GPU measurement.',
      `The first ${warmupS} s of samples are dropped as warm-up. Dev server (unminified React).`
    ],
    runs
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.browser} · ${result.machine.cpu} · viewport ${vw}x${vh}`);
  for (const [name, r] of Object.entries(runs)) {
    console.log(`${name}: ${r.live.backend}, ${r.live.threads} thread(s), ${r.live.procFps} fps processed · long tasks ${r.main_thread_long_tasks.count}, median ${r.main_thread_long_tasks.ms.median} ms`);
    for (const [k, m] of Object.entries(r.ms)) console.log(`  ${k.padEnd(40)} median ${m.median} ms · p90 ${m.p90} ms · min ${m.min} · max ${m.max} (n ${m.n})`);
    console.log(`  hits ${r.counts.hits} (${r.counts.hits_on_map} on map) · masks ${r.counts.masks} (${r.counts.masks_on_map} on map) · SAM requests (mocked) ${r.counts.sam_requests_mocked}`);
  }
  console.log(`wrote ${path.relative(webRoot, out)}`);
} finally {
  await browser.close();
  await server.close();
}
