// .claude/skills/drive-app/drive.mjs
//
// Playwright helpers for driving TransmissionMap headless, plus named
// scenarios. See SKILL.md. Copy this file into the session scratchpad and run
// it from there (`node drive.mjs <scenario>`), so `playwright-core` resolves
// from the scratchpad's node_modules, never the repo's.
//
// Env: TM_URL (default http://localhost:5199/), TM_WORK (screenshots and
// downloads; default ./shots), TM_CHROME (Chromium binary; default the newest
// cached Playwright Chromium).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const URL_BASE = process.env.TM_URL ?? 'http://localhost:5199/';
export const OUT = path.resolve(process.env.TM_WORK ?? './shots');
fs.mkdirSync(OUT, { recursive: true });

// The camera every scenario starts from: zoom/lat/lng over the central US.
export const CAM = '5/39/-98';

let failures = 0;
export const log = (...a) => console.log(...a);
export function check(name, ok, detail = '') {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function cachedChromium() {
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    : [];
  for (const d of dirs) {
    const bin = path.join(root, d, 'chrome-linux64/chrome');
    if (fs.existsSync(bin)) return bin;
  }
  return undefined; // playwright-core's own lookup; needs `npx playwright install chromium`
}

export async function launch() {
  // MapLibre needs WebGL; headless gets it from SwiftShader.
  const browser = await chromium.launch({
    executablePath: process.env.TM_CHROME ?? cachedChromium(),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    // The first-visit disclaimer dialog blocks every click.
    localStorage.setItem('tm_disclaimer_accepted', '1');
    // Headless can't answer a save picker; saves fall back to a download.
    delete window.showSaveFilePicker;
  });
  return { browser, context };
}

/**
 * Open the app at `#hash` in a fresh page and wait until the map has loaded
 * and its tiles have settled. Returns the page and the errors it logs.
 */
export async function open(context, hash = CAM) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // Reset asks window.confirm; headless dismisses it by default, which
  // silently cancels the Reset. Accept confirms, dismiss alerts.
  page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : d.dismiss()));
  await page.goto(URL_BASE + '#' + hash);
  await page.waitForFunction(() => {
    const logo = document.getElementById('logo');
    return logo && !logo.classList.contains('spin');
  }, null, { timeout: 60000 });
  await settle(page);
  return { page, errors };
}

/**
 * Wait for MapLibre's `idle`: no camera motion, every requested tile and
 * source loaded, the last frame drawn. The short pause first lets fetches the
 * last action started get under way; polling areTilesLoaded() alone reports
 * true before a just-shown layer or the basemap labels have even requested.
 */
export async function settle(page, timeout = 20000) {
  await page.waitForTimeout(750);
  const idle = await page.evaluate(async t => {
    const { state } = await import('/assets/state.ts');
    const m = state.map;
    return new Promise(res => {
      const timer = setTimeout(() => res(false), t);
      m.once('idle', () => { clearTimeout(timer); res(true); });
      m.triggerRepaint();
    });
  }, timeout);
  if (!idle) log(`settle: no idle within ${timeout} ms; the screenshot may show tiles still loading`);
}

/**
 * Import an app module in the page and call `fn(module, arg)` there. Vite
 * serves the same module instances the app runs, so this drives live state.
 */
export const mod = (page, modPath, fn, arg) => page.evaluate(async ([p, f, a]) => {
  const m = await import(p);
  return new Function('m', 'a', `return (${f})(m, a)`)(m, a);
}, [modPath, fn.toString(), arg]);

/** Evaluate `expr` in the page with the app's `state` in scope. */
export const st = (page, expr) => page.evaluate(async e => {
  const { state } = await import('/assets/state.ts');
  return new Function('state', `return ${e}`)(state);
}, expr);

/** A full hash for `view` (a partial UrlStateData), built by the app's own codec. */
export const hashFor = (page, view, cam = CAM) => mod(page, '/assets/url-state-codec.ts', (m, [v, c]) => {
  const params = m.formatUrlState({ ...m.defaultView(), ...v }).join('&');
  return params ? `${c}?${params}` : c;
}, [view, cam]);

export async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  log('shot', file);
  return file;
}

/**
 * Notices the user can see. The 3D rotate hint is also [role=status] and
 * sits hidden in the page, so filter on visibility before counting.
 */
export const visibleNotices = page => page.evaluate(() =>
  [...document.querySelectorAll('[role=status]')]
    .filter(e => !e.hidden && getComputedStyle(e).display !== 'none')
    .map(e => ({ text: e.textContent.trim(), top: e.getBoundingClientRect().top, cls: e.className })));

export const hashOf = page => page.evaluate(() => location.hash);
export const paramsOf = hash => hash.split('?')[1] ?? '';

async function reset(page) {
  await page.click('#resetLayersBtn');
  await settle(page);
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = {
  // A labels-off link boots without place names; Reset brings them back.
  async labels(ctx) {
    const { page, errors } = await open(ctx, CAM + '?lb=0');
    check('lb=0 sets labels off', (await st(page, 'state.basemapLabels')) === false);
    check('labels toggle unchecked', !(await page.isChecked('#basemapLabelsToggle')));
    await shot(page, 'labels-1-off');
    await reset(page);
    check('Reset turns labels on', (await st(page, 'state.basemapLabels')) === true);
    check('labels toggle checked', await page.isChecked('#basemapLabelsToggle'));
    check('link drops lb', !(await hashOf(page)).includes('lb='), await hashOf(page));
    await shot(page, 'labels-2-after-reset');
    check('no console errors', errors.length === 0, errors.join(' | '));
  },

  // A vx link filters transmission to >= 345 kV and paints railroads red;
  // Reset clears both sections from state, the map and the link.
  async vx(ctx) {
    const probe = await open(ctx);
    const layers = { ...(await st(probe.page, 'state.layerVisibility')), 'osm-transmission-lines': true, railroads: true };
    const plain = await hashFor(probe.page, { layerVisibility: layers });
    const linked = await hashFor(probe.page, {
      layerVisibility: layers,
      where: { 'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: 345 }] },
      style: { railroads: { color: '#ff0000', size: 3 } },
    });
    await probe.page.close();
    log('vx link', linked, `(${linked.length} chars)`);

    const before = await open(ctx, plain);
    await shot(before.page, 'vx-1-without');
    await before.page.close();

    const { page, errors } = await open(ctx, linked);
    check('where applied', JSON.stringify(await st(page, 'state.where')).includes('"nominal_kv"'));
    check('railroads line-color is the override',
      (await st(page, "state.map.getPaintProperty('railroads', 'line-color')")) === '#ff0000');
    check('link keeps vx', (await hashOf(page)).includes('vx='));
    check('no dropped-settings notice', (await visibleNotices(page)).length === 0);
    await shot(page, 'vx-2-with');
    await reset(page);
    check('Reset clears where', JSON.stringify(await st(page, 'state.where')) === '{}');
    check('Reset clears style', JSON.stringify(await st(page, 'state.styleOverrides')) === '{}');
    check('Reset drops vx from the link', !(await hashOf(page)).includes('vx='));
    await shot(page, 'vx-3-after-reset');
    check('no console errors', errors.length === 0, errors.join(' | '));
  },

  // A link with three bad entries shows one top-centre notice counting 3,
  // keeps the valid entry, and rewrites the link without the bad ones.
  async notice(ctx) {
    const probe = await open(ctx);
    const linked = await hashFor(probe.page, {
      where: {
        'no-such-layer': [{ field: 'x', op: '==', value: 1 }],                        // unknown layer
        'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: '345' }], // wrong value type
      },
      style: { 'osm-generators': { color: '#00ff00', opacity: 0.5 } },                // colour on an icon layer
    });
    await probe.page.close();
    // open() settles first; the notice stays up for 8 s, so read it straight away.
    const { page, errors } = await open(ctx, linked);
    const notices = await visibleNotices(page);
    check('exactly one visible notice', notices.length === 1, JSON.stringify(notices));
    check('notice counts 3', /\(3\)/.test(notices[0]?.text ?? ''), notices[0]?.text);
    check('notice sits at the top', (notices[0]?.top ?? 999) < 150);
    check('valid opacity kept, bad colour dropped',
      JSON.stringify(await st(page, 'state.styleOverrides')) === '{"osm-generators":{"opacity":0.5}}');
    await shot(page, 'notice-1');
    check('no console errors', errors.length === 0, errors.join(' | '));
  },

  // Save view… downloads a .tmview.json; opening it on a fresh default page
  // restores the identical view.
  async viewfile(ctx) {
    const { page, errors } = await open(ctx, CAM + '?lb=0');
    await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('railroads', true));
    await mod(page, '/assets/style-overrides.ts', m => m.setStyle('railroads', { color: '#ff00ff', size: 2 }));
    await mod(page, '/assets/url-state.ts', m => m.writeUrlState());
    await settle(page);
    const saved = await hashOf(page);
    await shot(page, 'viewfile-1-before-save');
    await page.click('.menu-btn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=save-view]')]);
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('file is a v1 tmview', json.format === 'tmview' && json.v === 1, dl.suggestedFilename());
    await page.close();

    const fresh = await open(ctx);
    await shot(fresh.page, 'viewfile-2-fresh');
    await fresh.page.setInputFiles('#fileOpenInput', file);
    await settle(fresh.page);
    const opened = await hashOf(fresh.page);
    check('opened link equals saved link', paramsOf(opened) === paramsOf(saved), `${saved}  vs  ${opened}`);
    check('labels off after open', (await st(fresh.page, 'state.basemapLabels')) === false);
    await shot(fresh.page, 'viewfile-3-opened');
    check('no console errors', errors.length === 0 && fresh.errors.length === 0, [...errors, ...fresh.errors].join(' | '));
  },

  // The weather-live opacity override scales the wash and its border lines,
  // and clearing it restores both exactly.
  async weather(ctx) {
    const { page, errors } = await open(ctx, '4/38/-97');
    await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('weather-live', true));
    await settle(page);
    const wash = () => st(page, "Math.max(...['weather-live','weather-live-b'].map(id => state.map.getPaintProperty(id, 'raster-opacity') ?? 0))");
    const border = () => st(page, "JSON.stringify(state.map.getPaintProperty('weather-admin-lines-states', 'line-opacity'))");
    const w0 = await wash(), b0 = await border();
    await shot(page, 'weather-1-default');
    check('setStyle accepted', (await mod(page, '/assets/style-overrides.ts', m => m.setStyle('weather-live', { opacity: 0.25 }))) === null);
    await settle(page);
    const w1 = await wash();
    check('wash scaled x0.25', Math.abs(w1 - w0 * 0.25) < 1e-6, `${w0} → ${w1}`);
    check('border lines scaled too', (await border()) !== b0, `${b0} → ${await border()}`);
    await shot(page, 'weather-2-x0.25');
    await mod(page, '/assets/style-overrides.ts', m => m.clearStyle('weather-live'));
    await settle(page);
    check('clear restores the wash', (await wash()) === w0);
    check('clear restores the borders', (await border()) === b0);
    check('no console errors', errors.length === 0, errors.join(' | '));
  },
};

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = process.argv.slice(2);
  const run = names.length === 0 || names[0] === 'all' ? Object.keys(SCENARIOS) : names;
  const unknown = run.filter(n => !SCENARIOS[n]);
  if (unknown.length) {
    console.error(`unknown scenario: ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}, all`);
    process.exit(2);
  }
  const { browser, context } = await launch();
  try {
    for (const n of run) {
      log(`\n── ${n}`);
      await SCENARIOS[n](context);
    }
  } finally {
    await browser.close();
  }
  log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'} · screenshots in ${OUT}`);
  process.exit(failures ? 1 : 0);
}
