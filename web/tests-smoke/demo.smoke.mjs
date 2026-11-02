/**
 * Browser smoke test of the demo path (npm test, npm run test:smoke). It builds the app into a
 * temporary directory, serves it with `vite preview` on a free port, and drives the locally
 * installed Google Chrome through playwright-core, so no browser is downloaded. Only DOM text is
 * asserted: headless WebGL may not draw the terrain, and that is not a failure here.
 *
 * CHROME_PATH=<binary> picks the browser (and is then the only one tried); with no Chrome found
 * the tests skip. SMOKE_DIST=<dir> serves an existing build instead of building.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {build, preview} from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readData = file => JSON.parse(readFileSync(path.join(webRoot, 'public/data', file), 'utf8'));

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

describe('demo path in Chrome', {skip: SKIP, timeout: 120_000}, () => {
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
    await page.goto(`${origin}/${query}`, {waitUntil: 'domcontentloaded'});
    t.after(() => page.close());
    return page;
  }

  /** The right-hand rail on the Incident tab. */
  const rail = page => page.locator('aside', {has: page.getByRole('heading', {name: 'Incident Overview', exact: true})});

  /** The bottom-left map key (MapNotes): the box around its "Map key" header row. */
  const mapKey = page => page.getByText('Map key', {exact: true}).locator('xpath=../..');

  test('Eaton at 2025-01-08T23:30:00Z: withheld start, sources, timeline, fire area', async t => {
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
  });

  test('Palisades: withheld start with the 7.5 h width and the spread-rate ceiling', async t => {
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
  });

  test('Eaton Risk tab: rail, model comparison, and the map key follows the selected model', async t => {
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
  });
});
