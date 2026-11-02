/**
 * Browser smoke test of the demo path (npm test, npm run test:smoke). It builds the app into a
 * temporary directory, serves it with `vite preview` on a free port, and drives the locally
 * installed Google Chrome through playwright-core, so no browser is downloaded. Each view checks
 * its DOM text and then that the map draws: the WebGL context exists, a screenshot of the map
 * canvas has the terrain in it, and on Eaton the fire progression's colours are on it.
 *
 * CHROME_PATH=<binary> picks the browser (and is then the only one tried); with no Chrome found
 * the tests skip. SMOKE_DIST=<dir> serves an existing build instead of building.
 * SMOKE_SCREENSHOTS=<dir> saves each view's checked map screenshot there; a failed map check
 * always saves its last screenshot to the temporary directory and names it in the failure.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {PNG} from 'pngjs';
import {build, preview} from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readData = file => JSON.parse(readFileSync(path.join(webRoot, 'public/data', file), 'utf8'));

// deck.gl's TerrainLayer parses dem.png in a loaders.gl worker that it fetches from unpkg.com, for
// the installed loaders.gl version. Where unpkg is unreachable (a sandbox, CI without network) the
// worker fails and the terrain never draws; the fire layers, which live in its shader, go with it.
// The test serves that file from node_modules instead, so the map check needs no network.
const UNPKG_LOADERS = /^https:\/\/unpkg\.com\/@loaders\.gl\/([\w-]+)@([^/]+)\/dist\/([\w.-]+\.js)$/;

/** The installed copy of a loaders.gl worker script, or null if that package or version is not installed. */
function localLoadersFile(url) {
  const [, pkg, version, file] = url.match(UNPKG_LOADERS);
  const dir = path.join(webRoot, 'node_modules/@loaders.gl', pkg);
  try {
    if (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version !== version) return null;
    return readFileSync(path.join(dir, 'dist', file));
  } catch {
    return null;
  }
}

/** Runs in the page before the app: records every WebGL context that fails to be created or is lost. */
function recordWebglFailures() {
  const failures = (window.__webglFailures = []);
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (!ctx && /webgl/i.test(type)) failures.push(`getContext('${type}') returned null`);
    return ctx;
  };
  // Capture phase: neither event bubbles, but both pass the window on the way to the canvas.
  addEventListener('webglcontextcreationerror', e => failures.push(`context creation error: ${e.statusMessage || 'no message'}`), true);
  addEventListener('webglcontextlost', () => failures.push('context lost'), true);
}

// The map viewport is the element holding deck.gl's wrapper; its other children are DOM overlays
// (map key, compass, controls) that are drawn over the canvas and are hidden while screenshotting,
// or a blank canvas would still pass on the map key's pixels. The background is the same viewport
// with the canvas hidden too: the stage's CSS gradient, pixel for pixel.
const VIEWPORT = ':has(> #deckgl-wrapper)';
const ONLY_CANVAS = `${VIEWPORT} > :not(#deckgl-wrapper) { visibility: hidden !important; }`;
const NO_CANVAS = `${ONLY_CANVAS} #deckgl-wrapper { visibility: hidden !important; }`;

// Thresholds, from the three views at 1440×900 in headless Chrome with SwiftShader (headful Chrome
// under xvfb gives identical numbers): the terrain covers 60–74% of the map. Without the terrain
// the paths, labels and perimeter fills alone cover 6–18%, so the bar sits well above that.
const MIN_DRAWN = 0.4;
// Eaton at 2025-01-08T23:30Z: the front covers 0.50% and the char 4.3%. With the Fire Progression
// layer off the same classifiers find 0.08% and 0.35%; with Burn Scar and Ignition off too, 0.03%
// and 0.6% on the bare terrain.
const MIN_FRONT = 0.0015;
const MIN_CHAR = 0.02;
/** How long a view's terrain may take to draw after its DOM checks pass (SwiftShader takes ~10 s). */
const DRAW_TIMEOUT = 45_000;

/**
 * Shares of the map's pixels: `drawn` differs from the background by more than antialiasing noise;
 * `front` and `char` are the fire progression's colours from src/stage/fire-extension.ts as the
 * terrain shader lights them: FRONT [255, 115, 20] (emissive, so it stays bright orange) and CHAR
 * [51, 43, 36] (a dark warm grey, darker or lighter with the slope).
 */
function measure(map, bg) {
  let drawn = 0, front = 0, char = 0;
  const d = map.data, b = bg.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], bl = d[i + 2];
    if (Math.max(Math.abs(r - b[i]), Math.abs(g - b[i + 1]), Math.abs(bl - b[i + 2])) > 24) drawn++;
    if (r > 200 && g > 70 && g < 200 && bl < 90 && r - g > 50) front++;
    if (Math.max(r, g, bl) < 75 && r >= g && g >= bl && r - bl < 30) char++;
  }
  const n = d.length / 4;
  return {drawn: drawn / n, front: front / n, char: char / n};
}

const pct = x => `${(x * 100).toFixed(2)}%`;

// Headless Chrome uses the GPU where it has one; without one, newer Chrome falls back to software
// WebGL (SwiftShader) only with this flag. Forcing SwiftShader everywhere made each page ~3× slower.
const CHROME_ARGS = ['--enable-unsafe-swiftshader'];

/** The browser, or why there is none. A Chrome that exists but fails to start is an error, not a skip. */
async function launchChrome() {
  const exe = process.env.CHROME_PATH;
  if (exe) {
    if (!existsSync(exe)) return {skip: `CHROME_PATH=${exe} does not exist`};
    return {browser: await chromium.launch({executablePath: exe, args: CHROME_ARGS})};
  }
  try {
    return {browser: await chromium.launch({channel: 'chrome', args: CHROME_ARGS})};
  } catch (e) {
    if (/is not found|doesn't exist/i.test(String(e?.message))) return {skip: 'Google Chrome is not installed'};
    throw e;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const {port} = s.address();
      s.close(() => resolve(port));
    });
  });
}

const {browser, skip} = await launchChrome();
const SKIP = skip && `no browser for the smoke test: ${skip}; set CHROME_PATH to a Chrome or Chromium binary to run it`;

describe('demo path in Chrome', {skip: SKIP, timeout: 240_000}, () => {
  let server;
  let origin;
  let outDir;

  before(async () => {
    outDir = process.env.SMOKE_DIST
      ? path.resolve(webRoot, process.env.SMOKE_DIST)
      : mkdtempSync(path.join(tmpdir(), 'ember-smoke-'));
    if (!process.env.SMOKE_DIST) await build({root: webRoot, logLevel: 'error', build: {outDir, emptyOutDir: true}});
    const port = await freePort();
    server = await preview({
      root: webRoot,
      logLevel: 'silent',
      build: {outDir},
      preview: {host: '127.0.0.1', port, strictPort: true, open: false}
    });
    origin = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    if (outDir && !process.env.SMOKE_DIST) rmSync(outDir, {recursive: true, force: true});
  });

  /** A fresh page per URL: the fire and the tab are read from the query once, at module load. */
  async function open(t, query) {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    page.setDefaultTimeout(20_000);
    // Uncaught errors are reported, not failed on: the assertions below say whether the page works.
    page.on('pageerror', e => t.diagnostic(`page error: ${e.message}`));
    await page.addInitScript(recordWebglFailures);
    await page.route(UNPKG_LOADERS, route => {
      const body = localLoadersFile(route.request().url());
      if (body) return route.fulfill({body, contentType: 'text/javascript'});
      t.diagnostic(`no installed copy of ${route.request().url()}; fetching it`);
      return route.continue();
    });
    await page.goto(`${origin}/${query}`, {waitUntil: 'domcontentloaded'});
    t.after(() => page.close());
    return page;
  }

  /**
   * The map draws: deck.gl's canvas has a WebGL2 context and none failed, and a screenshot of the
   * canvas alone differs from the viewport's background on at least MIN_DRAWN of its pixels (and,
   * with `fire`, shows the fire progression's front and char). Screenshots are retaken until the
   * terrain has loaded or DRAW_TIMEOUT passes. `name` names the saved screenshot.
   */
  async function assertMapDraws(t, page, name, {fire = false} = {}) {
    // Attached, not visible: a hidden canvas must fail on its pixels, not time out here.
    await page.locator('#deckgl-overlay').waitFor({state: 'attached'});
    const gl = await page.evaluate(() => {
      // The same context type on the same canvas returns deck.gl's own context, or null if it has none.
      const ctx = document.querySelector('#deckgl-overlay').getContext('webgl2');
      const info = ctx?.getExtension('WEBGL_debug_renderer_info');
      return {failures: [...new Set(window.__webglFailures)], renderer: ctx && ctx.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : ctx.RENDERER)};
    });
    assert.deepEqual(gl.failures, [], `WebGL failed in Chrome: ${gl.failures.join('; ')}`);
    assert.ok(gl.renderer, "deck.gl's canvas has no WebGL2 context");
    t.diagnostic(`WebGL renderer: ${gl.renderer}`);

    const viewport = page.locator('#deckgl-wrapper').locator('xpath=..');
    const sameSize = (a, b) => a?.width === b.width && a?.height === b.height;
    const deadline = Date.now() + DRAW_TIMEOUT;
    let bg, shot, m, ok;
    for (;;) {
      const map = PNG.sync.read((shot = await viewport.screenshot({style: ONLY_CANVAS})));
      // The background is retaken only when the viewport has changed size.
      if (!sameSize(bg, map)) bg = PNG.sync.read(await viewport.screenshot({style: NO_CANVAS}));
      m = sameSize(bg, map) ? measure(map, bg) : {drawn: 0, front: 0, char: 0};
      ok = m.drawn >= MIN_DRAWN && (!fire || (m.front >= MIN_FRONT && m.char >= MIN_CHAR));
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }
    const failures = await page.evaluate(() => [...new Set(window.__webglFailures)]);
    const summary =
      `${pct(m.drawn)} of the map drawn (min ${pct(MIN_DRAWN)})` +
      (fire ? `, fire front ${pct(m.front)} (min ${pct(MIN_FRONT)}), char ${pct(m.char)} (min ${pct(MIN_CHAR)})` : '');
    t.diagnostic(`map ${name}: ${summary}`);
    if (process.env.SMOKE_SCREENSHOTS) {
      const dir = path.resolve(webRoot, process.env.SMOKE_SCREENSHOTS);
      mkdirSync(dir, {recursive: true});
      writeFileSync(path.join(dir, `${name}.png`), shot);
    }
    assert.deepEqual(failures, [], `WebGL failed in Chrome: ${failures.join('; ')}`);
    if (!ok) {
      const file = path.join(tmpdir(), `ember-smoke-${name}.png`);
      writeFileSync(file, shot);
      assert.fail(`the map did not draw within ${DRAW_TIMEOUT / 1000} s: ${summary}; last screenshot ${file}`);
    }
  }

  /** The right-hand rail on the Incident tab. */
  const rail = page => page.locator('aside', {has: page.getByRole('heading', {name: 'Incident Overview', exact: true})});

  /** The bottom-left map key (MapNotes): the box around its "Map key" header row. */
  const mapKey = page => page.getByText('Map key', {exact: true}).locator('xpath=../..');

  test('Eaton at 2025-01-08T23:30:00Z: withheld start, sources, timeline, fire area, map with the fire', async t => {
    const page = await open(t, '?fire=eaton&t=2025-01-08T23:30:00Z');

    // Rail, Incident Overview: ignition.json timing.reasons, behind the identifiability gate.
    const overview = rail(page);
    await overview.getByText('Start time withheld: 90% start-time interval is 10.6 h wide (limit 6 h)', {exact: true}).waitFor();
    // Analysis status counts manifest.json's sources; nothing is simulated.
    await overview.getByText('12 real · 8 modeled sources · none simulated', {exact: true}).waitFor();

    // The map key lists the real arrival layer and the withheld ignition; the SIM fallback is absent.
    const key = mapKey(page);
    await key.getByText('Fire Progression (Interpolated)', {exact: true}).waitFor();
    await key.getByText('Ignition estimate · start time withheld', {exact: true}).waitFor();
    assert.equal(await page.getByText('the fire progression shown is a synthetic shader test').count(), 0);

    // Timeline tooltip at t, in the fire's own time zone.
    await page.getByText('Jan 8, 15:30 PST', {exact: true}).waitFor();

    // Fire Area readout: acres at t from arrival.png, "<n> ac" in the chart's title row.
    const area = page
      .locator('div', {has: page.getByText('Fire Area', {exact: true})})
      .last()
      .getByText(/^\d[\d,]*(\.\d)? ac$/);
    const acres = parseFloat((await area.textContent()).replace(/,/g, ''));
    assert.ok(acres > 0, `Fire Area readout is ${acres}`);

    // Evidence tab: one row per manifest source, with its status.
    const manifest = readData('eaton/manifest.json');
    const tabs = page.locator('section', {has: page.getByRole('button', {name: 'Evidence', exact: true})});
    await tabs.getByRole('button', {name: 'Evidence', exact: true}).click();
    await tabs.getByText(manifest.sources[0].layer, {exact: true}).waitFor();
    const shown = await tabs.locator('li .font-mono').allTextContents();
    assert.deepEqual(shown, manifest.sources.map(s => s.status));
    assert.equal(shown.filter(s => s === 'REAL').length, 12);
    assert.equal(shown.filter(s => s === 'MODELED').length, 8);
    assert.equal(shown.filter(s => s === 'SIM').length, 0);

    // The terrain draws with the fire progression on it: the arrival layer at t, not only its key.
    await assertMapDraws(t, page, 'eaton', {fire: true});
  });

  test('Palisades: withheld start with the 7.5 h width and the spread-rate ceiling, map', async t => {
    const page = await open(t, '?fire=palisades');
    await rail(page)
      .getByText(
        "Start time withheld: 90% start-time interval is 7.5 h wide (limit 6 h); spread-rate scale is at the model's ceiling: " +
          'the modeled wind and fuels cannot grow the observed footprints fast enough, so start time and spread rate trade off',
        {exact: true}
      )
      .waitFor();
    await rail(page).getByText('12 real · 8 modeled sources · none simulated', {exact: true}).waitFor();
    await mapKey(page).getByText('Fire Progression (Interpolated)', {exact: true}).waitFor();
    await assertMapDraws(t, page, 'palisades');
  });

  test('Eaton Risk tab: rail, model comparison, the map key follows the selected model, map', async t => {
    const page = await open(t, '?fire=eaton&tab=risk');
    await page.getByRole('heading', {name: 'Post-fire debris flows', exact: true}).waitFor();
    await page.getByRole('heading', {name: 'Scored on observed debris flows', exact: true}).waitFor();

    // The comparison table: one row per model_eval.json model, by its short name (EVAL_SHORT in
    // src/stage/debris-layer.ts; an id it does not list shows as itself).
    const ev = readData('debris_flow/model_eval.json').models;
    const SHORT = {
      m1_published: 'M1 published',
      m1_refit: 'M1 recalibrated',
      rf_m1vars: 'RF · M1 inputs',
      rf_extended: 'RF · extended',
      mlp_m1vars: 'MLP · M1 inputs',
      mlp_extended: 'MLP · extended',
      mlp_context: 'MLP · context'
    };
    const table = page.locator('div.grid', {has: page.getByText('Brier', {exact: true})});
    assert.ok(ev.length > 0, 'model_eval.json lists no models');
    for (const m of ev) await table.getByText(SHORT[m.id] ?? m.id, {exact: true}).waitFor();

    // The dock's skill chart reads the selected model's row: pooled, then within-storm median / weighted.
    const skill = (short, id) => {
      const m = ev.find(r => r.id === id);
      return `${short} ${m.pooled.roc_auc.toFixed(2)} · storm ${m.within_storm.median_roc_auc.toFixed(2)} / ${m.within_storm.weighted_roc_auc.toFixed(2)}`;
    };
    await page.getByText('Skill on past fires (ROC AUC)', {exact: true}).waitFor();
    await page.getByText(skill('USGS', 'm1_published'), {exact: true}).waitFor();

    // The debris layer's map key names the model the rail selects, under the default 24 mm/h storm.
    const key = mapKey(page);
    await key.getByText('Debris-flow likelihood · USGS · I15 24 mm/h', {exact: true}).waitFor();
    await page.getByRole('button', {name: 'M1 recalibrated', exact: true}).click();
    await key.getByText('Debris-flow likelihood · M1 recalibrated · I15 24 mm/h', {exact: true}).waitFor();
    await page.getByText(skill('M1 recalibrated', 'm1_refit'), {exact: true}).waitFor();
    await assertMapDraws(t, page, 'eaton-risk');
  });
});
