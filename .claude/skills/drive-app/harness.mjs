// .claude/skills/drive-app/harness.mjs
//
// Shared Playwright helpers for drive.mjs and scenarios/*.mjs: launch, open, ready, settle, shots,
// check/log recording (`failures` is read by drive.mjs), the chat, line-tool and templates rigs, and
// the reference scenarios' pass/dump helpers. One module instance holds all shared state. Copy it
// beside drive.mjs in the scratchpad (SKILL.md), so `playwright-core` resolves from there.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// --preview points at `npm run preview` (a production build) instead of the dev server.
export const PREVIEW = process.argv.includes('--preview');
export const URL_BASE = process.env.TM_URL ?? (PREVIEW ? 'http://localhost:4173/' : 'http://localhost:5199/');
export const OUT = path.resolve(process.env.TM_WORK ?? './shots');
fs.mkdirSync(OUT, { recursive: true });

// The camera every scenario starts from: zoom/lat/lng over the central US.
export const CAM = '5/39/-98';

export let failures = 0;
export const log = (...a) => console.log(...a);
export function check(name, ok, detail = '') {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

export function cachedChromium() {
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
    // LocalNetworkAccessChecks off: current Chromium refuses a loopback page
    // framing another loopback origin (the sandbox scenario's third-party embed
    // of localhost from 127.0.0.1) with an error page. A harness-browser setting only.
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--disable-features=LocalNetworkAccessChecks'],
  });
  // Every context, this one and the scenarios' own, starts with the chat usage notice
  // and the first-visit disclaimer accepted, and accepts the route notice each time it opens (the disclaimer dialog blocks every click;
  // the notice dialogs are covered by the unit tests). The analysis sandbox's opaque-origin frame has
  // no storage: skip it there. Headless can't answer a save picker; saves fall back to a download.
  const seedNotices = () => {
    try { localStorage.setItem('tm-notice-chat', '1'); localStorage.setItem('tm_disclaimer_accepted', '1'); } catch { /* sandboxed frame */ }
    delete window.showSaveFilePicker;
    // The route notice is asked on every open of the Route pane (memory only): accept it as it appears.
    new MutationObserver(() => {
      document.querySelector('dialog[aria-labelledby="route-notice-title"] .disclaimer-accept')?.click();
    }).observe(document, { childList: true, subtree: true });
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => { const c = await newContext(...a); await c.addInitScript(seedNotices); return c; };
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
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
  await ready(page, { url: URL_BASE + '#' + hash, settle: true });
  return { page, errors };
}

/**
 * The page-boot step every scenario shares: goto `url` (when given), wait for the logo to stop
 * spinning (the app has booted), then, with `settle: true`, for the map to settle.
 */
export async function ready(page, { url, settle: andSettle = false } = {}) {
  if (url) await page.goto(url);
  await page.waitForFunction(() => { const l = document.getElementById('logo'); return l && !l.classList.contains('spin'); }, null, { timeout: 60000 });
  if (andSettle) await settle(page);
}

/**
 * Wait for MapLibre's `idle`: no camera motion, every requested tile and
 * source loaded, the last frame drawn. The short pause first lets fetches the
 * last action started get under way; polling areTilesLoaded() alone reports
 * true before a just-shown layer or the basemap labels have even requested.
 */
export async function settle(page, timeout = 20000) {
  // A preview build has no dev-server modules to import: wait it out there.
  if (PREVIEW && page.url().startsWith(URL_BASE)) return page.waitForTimeout(3000);
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

/** A layer row's Show in table (its ⋯ menu); the row's section may be collapsed. */
export async function openTable(page, id) {
  await page.evaluate(i => {
    const sec = document.querySelector(`[data-table-layer="${i}"]`)?.closest('.layer-section.collapsed');
    sec?.querySelector('.collapse-btn')?.click();
  }, id);
  await page.locator(`#layer-menu-btn-${id}`).scrollIntoViewIfNeeded();
  await page.click(`#layer-menu-btn-${id}`);
  await page.click(`#layer-menu-${id} [data-table-layer="${id}"]`);
}

/** Pixels drawn on a canvas (the first one in `root`, a page or frame, or the one `sel` names); throws when there is none. */
export const inked = (root, sel = 'canvas') => root.$eval(sel, cv => {
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
});

export async function reset(page) {
  await page.click('#resetLayersBtn');
  await settle(page);
}

/**
 * A mocked map chat for the `vega` and `canvas` scenarios: a fresh context at
 * 1400×1300 whose openrouter.ai requests are answered by `fixture(body)` (null:
 * answered 599 and listed in `unrouted`), example.org answered by a stub (and
 * counted), the chat opened with a key and the drawer dragged taller.
 *
 * Console rule (these two scenarios only): the canvas frame's console and
 * pageerror events reach Playwright with no frame id. Written code logs with
 * an empty URL and `<anonymous>` stacks, the runner as canvas.html, libraries
 * from their CDN; those go to `frame`, never to `errors`. Everything else — the
 * page's own errors — stays in `errors`, which the scenario holds to zero.
 */
export const CANVAS_CDN = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|tiles\.openfreemap\.org)\//;
// opts (the `templates` scenario): chat false = no chat opened and no key set;
// init = one more init script; viewport / cam / contextOptions override the defaults.
export const KEY = 'sk-or-v1-' + 'ef'.repeat(32);
export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, http-referer, x-title', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
export const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
export const reply = message => ({ choices: [{ message: { role: 'assistant', content: null, ...message } }], usage: { cost: 0.0001 } });
/**
 * Answer openrouter.ai from a fixture. `fixture(body, req)` returns the reply's message (or null: the
 * request is pushed to `unrouted` and refused). `onRequest(route, req)` runs first; a truthy result
 * means it answered the request itself.
 */
export async function mockOpenRouter(c, fixture, { unrouted, onRequest } = {}) {
  await c.route('https://openrouter.ai/**', async route => {
    const req = route.request();
    if (await onRequest?.(route, req)) return;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === 'GET' && req.url().endsWith('/api/v1/models')) return route.fulfill({ json: { data: [] }, headers: CORS });
    if (req.method() === 'POST' && req.url().endsWith('/api/v1/chat/completions')) {
      const r = fixture(req.postDataJSON(), req);
      if (r) return route.fulfill({ json: reply(r), headers: CORS });
    }
    unrouted?.push(`${req.method()} ${req.url()}`);
    return route.fulfill({ status: 599, headers: CORS, body: '' });
  });
}
/** Answer the Esri geocoder with `json`; `onHit` counts the requests. */
export const mockGeocode = (c, json, onHit) => c.route('https://geocode-api.arcgis.com/**', route => { onHit(); return route.fulfill({ json, headers: CORS }); });
/** Tools ▸ Ask the map…, up to the chat input. */
export async function openChat(page) {
  await page.click('#toolsMenuBtn');
  await page.click('[data-action="open-chat"]');
  await page.waitForSelector('#td-ask:not([hidden]) .chat-input', { timeout: 20000 });
}
export async function openChatWithKey(page) {
  await openChat(page);
  await page.fill('.chat-key-input', KEY);
  await page.click('.chat-connect');
}
export async function chatRig(ctx, fixture, opts = {}) {
  const rig = { bodies: [], models: [], unrouted: [], errors: [], frame: [], exampleHits: [], downloads: [], hits: [] };
  const c = await ctx.browser().newContext({ viewport: opts.viewport ?? { width: 1400, height: 1300 }, acceptDownloads: true, ...opts.contextOptions });
  if (opts.init) await c.addInitScript(opts.init);
  await mockOpenRouter(c, (body, req) => {
    rig.bodies.push(req.postData() ?? '');
    if (body?.model !== 'anthropic/claude-haiku-5.5') rig.models.push(String(body?.model));
    return fixture(body);
  }, { unrouted: rig.unrouted, onRequest: (_route, req) => { rig.hits.push(`${req.method()} ${req.url()}`); } });
  // A frame that does reach example.org (dev, where no page CSP stops a navigation) gets a stub.
  await c.route('https://example.org/**', route => {
    rig.exampleHits.push(`${route.request().resourceType()} ${route.request().url()}`);
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>example</title><p>outside</p>' });
  });
  const page = await c.newPage();
  page.on('pageerror', e => {
    const s = String(e.stack ?? '');
    const own = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/(?!canvas\.html)/.test(s);
    const cdn = /https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|tiles\.openfreemap\.org)\//.test(s);
    (!own && (s.includes('<anonymous>') || s.includes('canvas.html') || cdn) ? rig.frame : rig.errors).push('pageerror: ' + e.message);
  });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const u = m.location()?.url ?? '';
    (u === '' || /\/canvas\.html$/.test(u) || CANVAS_CDN.test(u) ? rig.frame : rig.errors).push(`console: ${m.text()} @${u || '""'}`);
  });
  page.on('download', d => rig.downloads.push(d));
  await ready(page, { url: URL_BASE + '#' + (opts.cam ?? '5.4/31.2/-99.4'), settle: true });
  await page.evaluate(() => { window.__ticks = 0; setInterval(() => window.__ticks++, 100); });
  rig.page = page;
  rig.context = c;
  rig.close = () => c.close();
  if (opts.chat !== false) {
    await openChatWithKey(page);
    const g = await page.$eval('.td-grip', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.mouse.move(g[0], g[1]);
    await page.mouse.down();
    await page.mouse.move(g[0], g[1] - 420, { steps: 8 });
    await page.mouse.up();
  }
  rig.say = async text => {
    await page.fill('.chat-input', text);
    await page.press('.chat-input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.chat-working') && document.querySelector('.chat-stop')?.hidden, null, { timeout: 90000 });
  };
  /** Each call's tool message as first sent (later requests resend it as a history stub), by call id. */
  rig.toolMsgs = () => {
    const seen = new Map();
    for (const b of rig.bodies) for (const m of JSON.parse(b).messages ?? []) if (m.role === 'tool' && !seen.has(m.tool_call_id)) seen.set(m.tool_call_id, m.content);
    return seen;
  };
  /** The Playwright frame of the `i`-th canvas card (0-based; negative from the end), or null. */
  rig.cardFrame = async i => {
    const cards = await page.$$('.chat-canvas');
    const card = cards.at(i);
    const f = card && await card.$('iframe');
    return f ? f.contentFrame() : null;
  };
  /** Poll `fn` in a frame until it returns something truthy (or `ms` passes); null on timeout. */
  rig.until = async (frame, fn, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await frame.evaluate(fn).catch(() => null);
      if (v) return v;
      await page.waitForTimeout(250);
    }
    return null;
  };
  rig.cardShot = async (i, name) => {
    await page.$$eval('.chat-canvas', (cs, i) => cs.at(i)?.scrollIntoView({ block: 'start' }), i);
    await page.waitForTimeout(300);
    return shot(page, name);
  };
  return rig;
}

// ── Scenarios ───────────────────────────────────────────────────────────────



// ── The line tools' rig (lines, lines-absent) ────────────────────────────────
export const DEV_URL = process.env.TM_DEV_URL ?? 'http://localhost:5199/';
export const DATA_HOST = process.env.TM_DATA_HOST;
// What a production build reads its data from: DATA_HOST in assets/constants.ts.
export const PROD_DATA = 'https://data.wpptx.org/';

/**
 * The app page in a fresh context (`setup(context)` adds routes first), plus, on a
 * preview build, a twin page on the dev server (`O`) at the same viewport whose app
 * modules the checks read; on the dev server `O` is the page itself. With
 * TM_DATA_HOST every data-host request goes to that host, the page's URL and CSP
 * unchanged, so the browser's CORS and range handling meet that host's headers.
 * `reads` lists every data/analysis/ response as [url, status]. `go(hash)` loads the
 * link afresh in both (a hash with state params reloads the app anyway).
 */
export async function lineRig(ctx, opts, setup = async () => {}) {
  if (PREVIEW && !DATA_HOST) { check('a preview run of the line tools needs TM_DATA_HOST, the stand-in data host (SKILL.md)', false); return null; }
  const init = () => {
    window.__csp = [];
    addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  };
  const c = await ctx.browser().newContext({ ...opts, ignoreHTTPSErrors: !!DATA_HOST });
  await c.addInitScript(init);
  await setup(c);
  if (DATA_HOST) await c.route(PROD_DATA + '**', r => r.continue({ url: DATA_HOST + r.request().url().slice(PROD_DATA.length) }));
  const errors = [], reads = [];
  const page = await c.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()} @ ${m.location()?.url ?? ''}`); });
  page.on('dialog', d => d.dismiss());
  page.on('response', r => { if (r.url().includes('/data/analysis/')) reads.push([r.url(), r.status()]); });
  const oc = PREVIEW ? await ctx.browser().newContext(opts) : null;
  if (oc) await oc.addInitScript(init);
  const O = oc ? await oc.newPage() : page;
  const load = async (p, base, hash) => {
    await p.goto('about:blank');
    await ready(p, { url: base + '#' + hash });
  };
  const go = async hash => {
    await load(page, URL_BASE, hash);
    if (oc) {
      await load(O, DEV_URL, hash);
      await O.waitForFunction(async () => !!(await import('/assets/state.ts')).state.map, null, { timeout: 60000 });
      await settle(O);
    }
    await settle(page);
  };
  return { c, page, O, errors, reads, go, close: async () => { await c.close(); await oc?.close(); } };
}

/**
 * A screen point on a line of `layerId` where a tap hits that one line only (with
 * room for the popup above), plus its feature: `accept` is an expression over its
 * properties `p`, `fid` asks for that line, `box` is [left, right margin, top, bottom
 * as a fraction of the height].
 */
export const pickLine = (page, layerId, { accept = 'true', fid = null, box = [380, 420, 330, 0.55] } = {}) => page.evaluate(async ([id, accept, want, box]) => {
  const ok = new Function('p', `return ${accept}`);
  const { state } = await import('/assets/state.ts');
  const { layerById, LAYERS } = await import('/src/registry/index.ts');
  const { featureId } = await import('/assets/feature-id.ts');
  const m = state.map, ids = layerById(id).mapLayerIds.filter(l => m.getLayer(l));
  const clickable = LAYERS.flatMap(l => l.mapLayerIds).filter(l => m.getLayer(l));
  const all = m.queryRenderedFeatures({ layers: ids });
  const W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
  // Any line long enough to tap; a line asked for by id may be a short one (one segment).
  const cands = all.filter(f => f.geometry.type === 'LineString' && f.geometry.coordinates.length >= (want === null ? 4 : 2) && ok(f.properties)
      && (want === null || String(featureId(id, f)) === String(want)))
    .sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length);
  for (const f of cands) {
    const cs = f.geometry.coordinates;
    for (let k = want === null ? 1 : 0; k + 1 < cs.length; k++) {
      const a = m.project(cs[k]), b = m.project(cs[k + 1]);
      const p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (p.x < box[0] || p.x > W - box[1] || p.y < box[2] || p.y > H * box[3]) continue;
      const hits = m.queryRenderedFeatures([[p.x - 8, p.y - 8], [p.x + 8, p.y + 8]], { layers: clickable });
      if (hits.some(h => featureId(id, h) !== featureId(id, f))) continue;
      const fid = featureId(id, f);
      if (fid === undefined) continue;
      return { x: p.x, y: p.y, fid, props: f.properties, tileVerts: cs.length };
    }
  }
  return null;
}, [layerId, accept, fid, box]);

export async function tapAt(page, p, touch = false) {
  const r = await page.$eval('.maplibregl-canvas', e => { const b = e.getBoundingClientRect(); return [b.x, b.y]; });
  if (touch) await page.touchscreen.tap(r[0] + p.x, r[1] + p.y);
  else await page.mouse.click(r[0] + p.x, r[1] + p.y);
}

/**
 * Open a line's Line tab: on the dev server through line-open.ts; on a build as a
 * visitor does, a tap at `at` and the popup's Line tools. True once the tab is up.
 */
export async function openTools(rig, layerId, fid, props, at, touch = false) {
  const { page } = rig;
  if (!PREVIEW) await mod(page, '/assets/ui/line-open.ts', (m, [l, f, p]) => m.openLineTools({ layerId: l, fid: f, properties: p }), [layerId, fid, props]);
  else {
    if (!at) return false;
    await tapAt(page, at, touch);
    const btn = await page.waitForSelector('.maplibregl-popup .popup-line-tools-btn', { timeout: 20000 }).catch(() => null);
    if (!btn) { log('no Line tools in the popup:', await page.$eval('.maplibregl-popup', e => e.textContent.slice(0, 120)).catch(() => 'no popup')); return false; }
    if (touch) await btn.tap(); else await btn.click();
  }
  return !!(await page.waitForSelector('#td-line:not([hidden]) .lt-grid', { timeout: 30000 }).catch(() => null));
}

/** The "Copied from map" My Data layer: its feature count and last feature (from the saved store, which a build also has). */
export const myDataCopies = page => page.evaluate(() => {
  try {
    const l = JSON.parse(localStorage.getItem('tm-user-data') ?? '{}').userLayers?.find(x => x.filename === 'Copied from map');
    return l ? { n: l.geojson.features.length, f: l.geojson.features.at(-1) } : null;
  } catch { return null; }
});

/** Open `layerId`'s table from its panel row; whether "Copy N checked lines" shows (waiting for it when `expect`). */
export async function tableCopyShown(page, layerId, expect) {
  await page.evaluate(i => document.querySelector(`[data-table-layer="${i}"]`)?.closest('.layer-section.collapsed')?.querySelector('.collapse-btn')?.click(), layerId);
  await page.locator(`#layer-menu-btn-${layerId}`).scrollIntoViewIfNeeded();
  await page.click(`#layer-menu-btn-${layerId}`);
  await page.click(`#layer-menu-${layerId} [data-table-layer="${layerId}"]`);
  await page.waitForSelector('.td-row', { timeout: 30000 }).catch(() => {});
  if (expect) await page.waitForSelector('.td-copy:not([hidden])', { timeout: 15000 }).catch(() => {});
  else await page.waitForTimeout(3000);
  return page.evaluate(() => { const b = document.querySelector('.td-copy'); return !!b && !b.hidden && !!b.offsetParent; });
}

// The templates scenario's rig and helpers, shared by its three parts: a no-key chat rig over Texas
// with the frames' messages tapped, the Visualize pane driver (showViz), ink and pixel probes, the
// action toast, downloads with their CSV/PNG checks, and a click on a mark found by colour (clickAct).
// nearest is catalogued ready: false (assets/templates/catalogue.ts): neither the gallery nor the chat offers it,

// The templates scenario's rig and helpers, shared by its three parts: a no-key chat rig over Texas
// with the frames' messages tapped, the Visualize pane driver (showViz), ink and pixel probes, the
// action toast, downloads with their CSV/PNG checks, and a click on a mark found by colour (clickAct).
// nearest is catalogued ready: false (assets/templates/catalogue.ts): neither the gallery nor the chat offers it,
// so its steps are skipped and the gallery is held to showing no nearest card.
export const NEAREST_READY = false;

export async function templateKit(ctx) {
  const GEN = 'eia-generators', SUBS = 'hifld-substations', GAS = 'hifld-natgas-points';
  const OGF = 'ogf-planned-transmission', OSMTX = 'osm-transmission-lines';
  const LABEL = 'TransmissionMap template';
  const TX_CAM = '5.4/31.2/-99.4';
  // Messages the frames post to the page (top window), and what the page posts each frame (inside it).
  const taps = () => {
    if (window.top === window) {
      window.__tmMsgs = [];
      addEventListener('message', e => { const t = e.data && e.data.type; if (typeof t === 'string') window.__tmMsgs.push(t); });
    } else {
      addEventListener('message', e => {
        if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
        (window.__tmIn ||= []).push(e.data);
        if (window.__tmIn.length > 4) window.__tmIn.shift();
      });
    }
  };
  const rig = await chatRig(ctx, () => null, { chat: false, init: taps, cam: TX_CAM });
  const { page } = rig;
  const msgs = () => page.evaluate(() => window.__tmMsgs.slice());
  const idle = () => settle(page);
  const openViz = async () => {
    await page.click('#toolsMenuBtn');
    await page.click('[data-action="open-visualize"]');
    await page.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
  };
  const frameOf = async card => (await card?.$('iframe'))?.contentFrame() ?? null;
  /** Pick layer + template in the pane, fill the form, Show; wait for the frame's word and the button back. */
  const showViz = async (layer, tpl, form = {}) => {
    // layer null: Show the form as it stands (a layer change would reset it).
    if (layer) {
      await page.selectOption('.tv-layer', layer);
      await page.click(`.tv-card[data-template="${tpl}"]`);
    }
    for (const k of ['by', 'split', 'time', 'measure', 'mode', 'layer2']) if (form[k] !== undefined) await page.selectOption(`.tv-${k}`, form[k]);
    await page.$$eval('.tv-cards > *', cs => cs.forEach(c => { c.dataset.seen = ''; }));
    const m0 = (await msgs()).length;
    const t0 = Date.now();
    await page.click('.tv-show');
    let posted = [];
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      posted = (await msgs()).slice(m0).filter(t => t === 'drawn' || t === 'rendered' || t === 'error');
      const back = await page.$eval('.tv-show', b => !b.disabled).catch(() => false);
      if (back && (posted.length || await page.$eval('.tv-status', s => s.dataset.kind === 'error').catch(() => false))) break;
      await page.waitForTimeout(250);
    }
    // An html frame may post drawn after rendered (its map or chart settles later).
    const html = await page.$eval('.tv-cards > .chat-canvas:not([data-seen])', c => c.dataset.kind === 'html').catch(() => false);
    for (const until = Date.now() + 15000; html && !posted.some(t => t === 'drawn' || t === 'error') && Date.now() < until;) {
      await page.waitForTimeout(250);
      posted = (await msgs()).slice(m0).filter(t => t === 'drawn' || t === 'rendered' || t === 'error');
    }
    await page.waitForTimeout(400);
    const card = await page.$('.tv-cards > .chat-canvas:not([data-seen])');
    const info = card && await card.evaluate(c => ({ label: c.querySelector('.chat-canvas-label')?.textContent, title: c.querySelector('.chat-canvas-title')?.textContent,
      kind: c.dataset.kind, template: c.hasAttribute('data-template'), errors: c.querySelector('.chat-canvas-errors')?.textContent ?? '' }));
    const status = await page.$eval('.tv-status', s => s.textContent);
    return { card, frame: await frameOf(card), info, posted, status, ms: Date.now() - t0 };
  };
  // Ink: canvases in the frame (WebGL ones drawn through a 2D copy; both maps keep their drawing buffer).
  const ink = frame => frame.evaluate(() => {
    let n = 0;
    for (const cv of document.querySelectorAll('canvas')) {
      if (!cv.width || !cv.height) continue;
      const c = document.createElement('canvas');
      c.width = Math.min(cv.width, 900); c.height = Math.min(cv.height, 700);
      const x = c.getContext('2d');
      x.drawImage(cv, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 16) if (d[i + 3] && !(d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245)) n++;
    }
    return n;
  }).catch(() => -1);
  // A canvas's pixels kept in the frame under `key`; diff() counts the samples that moved since (dimming moves thousands).
  const pixels = (frame, sel, key, compare) => frame.evaluate(([s, k, cmp]) => {
    const cv = document.querySelector(s);
    if (!cv || !cv.width) return -1;
    const c = document.createElement('canvas');
    c.width = Math.min(cv.width, 900); c.height = Math.min(cv.height, 700);
    const x = c.getContext('2d');
    x.drawImage(cv, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    window.__px ||= {};
    if (!cmp) { window.__px[k] = d; return 0; }
    const b = window.__px[k];
    if (!b || b.length !== d.length) return -1;
    let n = 0;
    for (let i = 0; i < d.length; i += 8) if (Math.abs(d[i] - b[i]) > 24) n++;
    return n;
  }, [sel, key, compare]).catch(() => -1);
  const snap = (frame, sel = 'canvas', key = 'base') => pixels(frame, sel, key, false);
  const diff = (frame, sel = 'canvas', key = 'base') => pixels(frame, sel, key, true);
  const MOVED = 300, STILL = 60;
  // Template actions (templates/template-actions.ts): the toast, the link's params, live state on dev.
  const toastText = (pg = page) => pg.$eval('.tpl-toast', t => t.textContent).catch(() => null);
  const waitToast = async (ms = 3000) => { const end = Date.now() + ms; let t = null; while (Date.now() < end && !(t = await toastText())) await page.waitForTimeout(100); return t; };
  const clearToast = () => page.evaluate(() => document.querySelectorAll('.tpl-toast').forEach(t => t.remove()));
  const undoToast = async () => { await page.click('.tpl-toast .tpl-toast-undo'); await page.waitForTimeout(600); };
  const params = h => h.split('?')[1] ?? '';
  const camOf = h => h.split('?')[0];
  const live = expr => PREVIEW ? Promise.resolve(null) : st(page, expr);
  /** Client point → page point for a frame inside `card`. */
  const inFrame = async (card, pt) => { const b = await (await card.$('iframe')).boundingBox(); return [b.x + pt.x, b.y + pt.y]; };
  /** A pixel of `sel`'s canvas matching `test(r, g, b)`, away from the edges, as a frame client point; null if none. */
  const findPixel = (frame, sel, test) => frame.evaluate(([s, t]) => {
    const cv = document.querySelector(s);
    if (!cv || !cv.width) return null;
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d');
    x.drawImage(cv, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const r = cv.getBoundingClientRect(), sx = r.width / cv.width, sy = r.height / cv.height;
    const ok = new Function('r', 'g', 'b', `return ${t}`);
    for (let y = Math.floor(c.height * 0.25); y < c.height * 0.85; y += 2) {
      for (let px = Math.floor(c.width * 0.12); px < c.width * 0.85; px += 2) {
        const i = (y * c.width + px) * 4;
        if (ok(d[i], d[i + 1], d[i + 2])) return { x: r.left + px * sx, y: r.top + y * sy };
      }
    }
    return null;
  }, [sel, test.toString().replace(/^\(r, g, b\) => /, '')]).catch(() => null);
  const menuItems = frame => frame.$$eval('.kit-menu button', bs => bs.map(b => b.textContent)).catch(() => []);
  const cardShot = async (card, name) => {
    await card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    await page.waitForTimeout(400);
    return shot(page, name);
  };
  const dl = async (action, prefix) => {
    const before = rig.downloads.length;
    await action();
    const end = Date.now() + 20000;
    while (rig.downloads.length === before && Date.now() < end) await page.waitForTimeout(100);
    const d = rig.downloads[before];
    if (!d) return null;
    const file = path.join(OUT, `${prefix}-${d.suggestedFilename()}`);
    await d.saveAs(file);
    return { name: d.suggestedFilename(), file, buf: fs.readFileSync(file) };
  };
  const csvChecks = (name, f, credit) => {
    const text = f?.buf.toString('utf8') ?? '';
    const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    check(`${name} CSV: BOM, CRLF, a header and ≥ 2 rows`, text.charCodeAt(0) === 0xFEFF && lines.length >= 3, `${f?.name} ${lines.length} lines · ${lines[0]}`);
    check(`${name} CSV: no unguarded = + @ or text - cell`, lines.every(l => !/(^|,)"?([=+@]|-(?![\d.]))/.test(l)),
      lines.filter(l => /(^|,)"?([=+@]|-(?![\d.]))/.test(l)).slice(0, 2).join(' | '));
    check(`${name} CSV: the credit row (as text)`, (credit ? lines.slice(-3).some(l => l.includes(credit.slice(0, 24))) : lines.slice(-2).some(l => /^"?Source: /.test(l)))
      && !/<[a-z/]/i.test(text), lines.slice(-2).join(' | '));
    return lines;
  };
  const pngChecks = (name, f) => {
    const ok = f && f.buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const w = ok ? f.buf.readUInt32BE(16) : 0, h = ok ? f.buf.readUInt32BE(20) : 0;
    check(`${name} PNG: a real PNG, named .png`, ok && w > 200 && h > 150 && /\.png$/.test(f.name), `${f?.name} ${w}×${h}`);
    return ok;
  };
  // A PNG decoded on a blank page: pixels off the most common colour, and the density ramp's warm ones.
  const pngInk = async f => {
    const p = await rig.context.newPage();
    await p.goto('about:blank');
    const r = await p.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const count = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3; count.set(k, (count.get(k) ?? 0) + 1); }
      const bg = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const br = (bg >> 10) << 3, bgG = ((bg >> 5) & 31) << 3, bb = (bg & 31) << 3;
      let off = 0, warm = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bb) > 40) off++;
        if (d[i] > 190 && d[i + 2] < 140 && d[i] - d[i + 2] > 80) warm++;
      }
      return { off, warm, total: d.length / 4 };
    }, f.buf.toString('base64'));
    await p.close();
    return r;
  };
  // An html card's kit: Table toggle, CSV and PNG from the frame's own Download menu.
  const kitChecks = async (name, card, frame, tag) => {
    await card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    const credit = await frame.evaluate(() => TM_INPUT.credit).catch(() => '');
    // A template frame's download saves at once on the visitor's own click in it (transient user
    // activation with the frame focused, one per click — canvas-host.ts); else a "Save <name>" button.
    const how = [];
    const viaFrame = async nth => {
      const n0 = await card.$$eval('.chat-canvas-save', b => b.length);
      if (!await frame.isVisible('.kit-dl-menu')) await frame.click('.kit-dl > summary');
      await frame.click(`.kit-dl-menu .kit-btn >> nth=${nth}`);
      const save = await card.waitForSelector(`.chat-canvas-save >> nth=${n0}`, { timeout: 1500 }).catch(() => null);
      how.push(save ? `Save button "${await save.textContent()}"` : 'direct');
      await save?.evaluate(b => b.click());
    };
    const csv = await dl(() => viaFrame(0), tag);
    csvChecks(name, csv, credit);
    const png = await dl(() => viaFrame(1), tag);
    pngChecks(name, png);
    check(`${name}: CSV and PNG each save on the one click in the frame (no Save button)`, how.length === 2 && how.every(h => h === 'direct') && csv && png, how.join(' / '));
    await frame.evaluate(() => { const d = document.querySelector('.kit-dl'); if (d) d.open = false; }).catch(() => {});
    const tb = await frame.$('.kit-tools > .kit-btn');
    await tb?.click();
    await page.waitForTimeout(200);
    const t1 = await frame.evaluate(() => ({ pressed: document.querySelector('.kit-tools > .kit-btn')?.getAttribute('aria-pressed'),
      rows: document.querySelectorAll('.kit-table tbody tr').length, shown: !!document.querySelector('.kit-table')?.offsetParent })).catch(e => ({ e: e.message }));
    await tb?.click();
    const t2 = await frame.evaluate(() => document.querySelector('.kit-tools > .kit-btn')?.getAttribute('aria-pressed')).catch(() => null);
    check(`${name}: the Table toggle shows the rows and hides them again`, t1.pressed === 'true' && t1.rows > 0 && t1.shown && t2 === 'false', JSON.stringify({ ...t1, after: t2 }));
    await page.waitForTimeout(1500);
    return { csv, png };
  };
  const vegaDownloads = async (name, card, tag) => {
    await card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    const png = await dl(() => card.$eval('.chat-canvas-png', b => b.click()), tag);
    pngChecks(name, png);
    const csv = await dl(() => card.$eval('.chat-canvas-csv', b => b.click()), tag);
    csvChecks(name, csv, null);
    check(`${name}: the PNG is named from the card's title, as the CSV`, !!png && png.name !== 'chart.png' && png.name.replace(/\.png$/, '') === csv?.name.replace(/\.csv$/, ''), `${png?.name} · ${csv?.name}`);
    // The card's actions sit in its header row, above the frame.
    const inHead = await card.evaluate(c => !!c.querySelector('.chat-canvas-head .chat-canvas-png'));
    check(`${name}: PNG/CSV/Table sit in the card's header row`, inHead);
    // The page-side Table toggle: the injected rows as a text-only table.
    const tb = await card.$('.chat-canvas-table-btn');
    await tb?.click();
    const t1 = await card.evaluate(c => ({ pressed: c.querySelector('.chat-canvas-table-btn')?.getAttribute('aria-pressed'),
      rows: c.querySelectorAll('.chat-canvas-table tbody tr').length, shown: !!c.querySelector('.chat-canvas-table')?.offsetParent,
      head: [...c.querySelectorAll('.chat-canvas-table th')].map(t => t.textContent) }));
    await tb?.click();
    const t2 = await card.evaluate(c => ({ pressed: c.querySelector('.chat-canvas-table-btn')?.getAttribute('aria-pressed'), shown: !!c.querySelector('.chat-canvas-table')?.offsetParent }));
    check(`${name}: the card's Table toggle shows the injected rows and hides them`, t1.pressed === 'true' && t1.rows > 0 && t1.shown && t2.pressed === 'false' && !t2.shown, JSON.stringify({ ...t1, after: t2 }).slice(0, 300));
  };
  const cardOk = (name, r, word) => {
    check(`${name}: one card labelled "${LABEL}"`, r.info?.label === LABEL && r.info.template, JSON.stringify(r.info));
    check(`${name}: the frame posted ${word}`, r.posted.includes(word) && !r.posted.includes('error'), `${r.posted.join(',')} in ${r.ms} ms · status "${r.status}" ${r.info?.errors ?? ''}`);
  };

  /** A pixel of the frame's canvas in [y0, y1] (fractions) matching test(r,g,b), as a page point. */
  const pixelAt = async (card, frame, test, y0 = 0.1, y1 = 0.95, x0 = 0.05, x1 = 0.95) => {
    const pt = await frame.evaluate(([t, a, b, c, d]) => {
      const cv = document.querySelector('canvas');
      if (!cv || !cv.width) return null;
      const k = document.createElement('canvas'); k.width = cv.width; k.height = cv.height;
      const x = k.getContext('2d'); x.drawImage(cv, 0, 0);
      const px = x.getImageData(0, 0, k.width, k.height).data;
      const r = cv.getBoundingClientRect(), sx = r.width / cv.width, sy = r.height / cv.height;
      const ok = new Function('r', 'g', 'b', `return ${t}`);
      for (let yy = Math.floor(k.height * a); yy < k.height * b; yy += 2) for (let xx = Math.floor(k.width * c); xx < k.width * d; xx += 2) {
        const i = (yy * k.width + xx) * 4;
        if (ok(px[i], px[i + 1], px[i + 2])) {
          // The middle of the mark: its run to the right and down from the first matching pixel.
          let e = xx, f = yy;
          while (e + 1 < k.width && ok(...px.slice((yy * k.width + e + 1) * 4, (yy * k.width + e + 1) * 4 + 3))) e++;
          const mx = Math.round((xx + e) / 2);
          while (f + 1 < k.height && ok(...px.slice(((f + 1) * k.width + mx) * 4, ((f + 1) * k.width + mx) * 4 + 3))) f++;
          return { x: r.left + mx * sx, y: r.top + Math.round((yy + f) / 2) * sy };
        }
      }
      return null;
    }, [test, y0, y1, x0, x1]).catch(() => null);
    return pt ? inFrame(card, pt) : null;
  };
  const SAT = '(Math.max(r, g, b) - Math.min(r, g, b)) > 60';
  const clickAct = async (card, frame, test, y0, y1, label, wantField, x0, x1) => {
    await card.evaluate(c => c.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    const at = await pixelAt(card, frame, test, y0, y1, x0, x1);
    await clearToast();
    const L0 = await hashOf(page);
    if (!at) { check(`${label}: a mark to click`, false); return null; }
    log(`  ${label}: click at ${at.map(Math.round)}`);
    await page.mouse.click(at[0], at[1]);
    const t1 = await waitToast(4000);
    const L1 = await hashOf(page);
    const w1 = await live(`JSON.stringify(state.where)`);
    log(`  toast: ${t1}`);
    check(`${label}: a click filters the map (toast with Undo; where on ${wantField}; the link carries it)`,
      /the map shows only .+Undo/.test(t1 ?? '') && params(L1) !== params(L0) && (PREVIEW || (w1 ?? '').includes(`"${wantField}"`)), `${t1} · ${w1}`);
    return { L0, at, where: w1 };
  };
  const undoCheck = async (label, L0) => {
    await undoToast();
    check(`${label}: the toast's Undo restores the link`, params(await hashOf(page)) === params(L0) && !(await toastText()), params(await hashOf(page)).slice(0, 80));
  };

  return { GEN, SUBS, GAS, OGF, OSMTX, LABEL, TX_CAM, taps, rig, page, msgs, idle, openViz, frameOf, showViz, ink, pixels, snap, diff, MOVED, STILL, toastText, waitToast, clearToast, undoToast, params, camOf, live, inFrame, findPixel, menuItems, cardShot, dl, csvChecks, pngChecks, pngInk, kitChecks, vegaDownloads, cardOk, pixelAt, SAT, clickAct, undoCheck };
}

// Check scenarios for the refactor: each writes JSON dumps (normalised DOM and
// small state records) beside its shots, so a later tree is held to BASE by a
// byte comparison of two dump directories (`--dump=DIR`, or TM_DUMP, default
// <TM_WORK>/dumps). Each runs three passes — desktop 1280×800 `en`, phone
// 390×844 `en`, desktop `ar` (RTL) switched to `es` once mid-run — under a
// frozen clock with every live feed answered from fixtures/ (SKILL.md).
// Dev server only, except the drawer's Route pane (--preview).
export const REPO = process.env.TM_REPO ?? new URL('../../../', import.meta.url).pathname;
export const FIXDIR = path.join(REPO, '.claude/skills/drive-app/fixtures');
export const fixtureBytes = f => fs.readFileSync(path.join(FIXDIR, f));
export const FIXED_NOW = '2026-11-20T12:00:00.000Z';
export const DUMP_ARG = process.argv.find(a => a.startsWith('--dump='));
export const DUMP_DIR = path.resolve(DUMP_ARG ? DUMP_ARG.slice(7) : (process.env.TM_DUMP ?? path.join(OUT, 'dumps')));
export const ALL_PASSES = [
  { name: 'desktop-en', viewport: { width: 1280, height: 800 }, lang: 'en' },
  { name: 'phone-en', viewport: { width: 390, height: 844 }, lang: 'en', phone: true },
  { name: 'desktop-ar', viewport: { width: 1280, height: 800 }, lang: 'ar', toEs: true },
];
export const PASSES = ALL_PASSES.filter(p => !process.env.TM_PASS || process.env.TM_PASS.split(',').includes(p.name));   // TM_PASS=desktop-ar narrows a run
export const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
export const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(byKey)) : x), 1);
/** Write `<scenario>-<pass>[-preview].json` into the dump directory. */
export function writeDump(scenario, pass, obj) {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const f = path.join(DUMP_DIR, `${scenario}-${pass}${PREVIEW ? '-preview' : ''}.json`);
  fs.writeFileSync(f, stable({ scenario, pass, preview: PREVIEW, fixedNow: FIXED_NOW, ...obj }) + '\n');
  log('dump', f);
}
// Runs in the page: an element as normalised markup — attributes sorted, whitespace collapsed (a whitespace-only text node stays one space),
// form values and checks as pseudo-attributes, Tabulator's random body ids starred; script/style/canvas content and the Diagnostics
// badge (lit by whichever basemap request failed) left out.
export const NORM = el => {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const walk = n => {
    if (n.nodeType === 3) return esc(n.textContent.replace(/\s+/g, ' '));
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || n.id === 'fileMenuBadge') return '';
    const at = [...n.attributes].map(a => [a.name, a.value.replace(/\s+/g, ' ').replace(/blob:[^"' )]*/g, 'blob:*').replace(/tabulator-table-body-[a-z0-9]+/g, 'tabulator-table-body-*')]);
    if (/^(input|textarea|select)$/.test(tag)) at.push(['@value', String(n.value)]);
    if (tag === 'input' && (n.type === 'checkbox' || n.type === 'radio')) at.push(['@checked', String(n.checked)], ['@indeterminate', String(n.indeterminate)]);
    if (tag === 'dialog') at.push(['@open', String(n.open)]);
    at.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const kids = tag === 'canvas' ? '' : [...n.childNodes].map(walk).join('');
    return `<${tag}${at.map(([k, v]) => ` ${k}="${v}"`).join('')}>${kids}</${tag}>`;
  };
  return walk(el);
};
export const ensureNorm = page => page.evaluate(`(() => { window.__norm = ${NORM.toString()}; })()`);
/** Normalised markup of the first element `sel` matches (null when none). */
export async function normHtml(page, sel) {
  await ensureNorm(page);
  return page.evaluate(s => { const e = document.querySelector(s); return e ? window.__norm(e) : null; }, sel);
}

/** A context for one pass: frozen clock, every live feed answered from fixtures/, nothing else mocked but OpenRouter and PUDL. */
export async function refContext(ctx, pass, feeds = {}, opts = {}) {
  const feed = { wildfire: 'fresh', nws: 'fresh', odin: 'fresh', ...feeds };
  const c = await ctx.browser().newContext({
    viewport: pass.viewport, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true,
    ...(pass.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  LIVE.push(c);
  // opts.clock false: a reload restore (TM_DRAWER_INJECT) needs the browser's navigation entry, which the fake clock hides.
  if (opts.clock !== false) await c.clock.setFixedTime(FIXED_NOW);
  await c.addInitScript(lang => { try { if (!localStorage.getItem('tm-lang')) localStorage.setItem('tm-lang', lang); } catch { /* blocked */ } }, pass.lang);
  const CORS_ANY = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  await c.route(/\/data\/layers\/(wildfire_live\.geojson\.gz|nws_alerts\.geojson|odin_outages\.json|weather_live\/[^?#]*)(\?.*)?$/, route => {
    const name = new URL(route.request().url()).pathname.split('/data/layers/')[1];
    if (name === 'wildfire_live.geojson.gz') return route.fulfill({ body: zlib.gzipSync(fixtureBytes(`wildfire-${feed.wildfire}.geojson`)), contentType: 'application/octet-stream', headers: CORS_ANY });
    if (name === 'nws_alerts.geojson') return route.fulfill({ body: fixtureBytes(`nws-${feed.nws}.geojson`), contentType: 'application/json', headers: CORS_ANY });
    if (name === 'odin_outages.json') return route.fulfill({ body: fixtureBytes(`odin-${feed.odin}.json`), contentType: 'application/json', headers: CORS_ANY });
    if (name === 'weather_live/meta.json') return route.fulfill({ body: fixtureBytes('weather-meta.json'), contentType: 'application/json', headers: CORS_ANY });
    if (/\.(webp|png)$/.test(name)) return route.fulfill({ body: fixtureBytes('tile.png'), contentType: 'image/png', headers: CORS_ANY });
    if (/\.i16\.gz$/.test(name)) return route.fulfill({ body: zlib.gzipSync(Buffer.alloc(4)), contentType: 'application/octet-stream', headers: CORS_ANY });
    return route.fulfill({ status: 404, body: '', headers: CORS_ANY });
  });
  await c.route('https://mesonet.agron.iastate.edu/json/tms.json', r => r.fulfill({ body: fixtureBytes('radar-tms.json'), contentType: 'application/json', headers: CORS_ANY }));
  await c.route(/^https:\/\/(mesonet\.agron\.iastate\.edu\/cache\/|geo\.weather\.gc\.ca\/)/, r => r.fulfill({ body: fixtureBytes('tile.png'), contentType: 'image/png', headers: CORS_ANY }));
  await c.route(/pudl\.catalyst\.coop/, r => r.abort());
  // Grid Ops reads its hour through assets/grid-ops/eia930-read.ts; the dev server hands out a fixed hour instead.
  await c.route(/\/assets\/grid-ops\/eia930-read\.ts(\?.*)?$/, r => r.fulfill({ body: fixtureBytes('eia930-read-stub.js'), contentType: 'text/javascript' }));
  await mockOpenRouter(c, () => null);
  return { c, feed };
}

/** File ▸ Settings ▸ language; returns once the Tools button has re-translated. */
export async function switchLang(page, code) {
  const before = await page.textContent('#toolsMenuBtn');
  await page.click('#fileMenuBtn');
  await page.click('[data-action="open-settings"]');
  await page.selectOption('#settingsLanguageSelect', code);
  await page.waitForFunction(b => document.querySelector('#toolsMenuBtn')?.textContent !== b, before, { timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
/** The one mid-run en → es switch of the `ar` pass. */
export const midRun = async (page, pass) => { if (pass.toEs && !pass.done) { pass.done = true; await switchLang(page, 'es'); return true; } return false; };

export const TABS = { ask: '#td-tab-ask', table: '#td-tab', viz: '#td-tab-viz', line: '#td-tab-line', prox: '#td-tab-prox', gops: '#td-tab-gops', route: '#td-tab-route' };
export const PANELS = { ask: '#td-ask', table: '#td-panel', viz: '#td-viz', line: '#td-line', prox: '#td-prox', gops: '#td-gops', route: '#td-route' };
/** The drawer as a record: height, flags, tabs, panels, focus. */
export const drawerState = page => page.evaluate(([tabs, panels]) => {
  const d = document.querySelector('.table-drawer');
  if (!d) return { drawer: false, activeElement: document.activeElement?.tagName?.toLowerCase() ?? null };
  const q = s => document.querySelector(s);
  const hid = s => { const e = q(s); return e ? e.hidden : null; };
  // Computed, not only the `hidden` property: what the visitor can see.
  const vis = s => { const e = q(s); if (!e) return null; const c = getComputedStyle(e); return { display: c.display, visibility: c.visibility, rects: e.getClientRects().length, offsetParent: e.offsetParent !== null }; };
  const grip = q('.td-grip'), col = q('.td-collapse'), map = d.parentElement;
  const a = document.activeElement;
  return {
    drawer: true, hidden: d.hidden, classes: [...d.classList].sort().join(' '), styleHeight: d.style.height, offsetHeight: d.offsetHeight,
    grip: { now: grip?.getAttribute('aria-valuenow'), max: grip?.getAttribute('aria-valuemax'), min: grip?.getAttribute('aria-valuemin') },
    collapseExpanded: col?.getAttribute('aria-expanded'), collapseLabel: col?.getAttribute('aria-label'), collapseText: col?.textContent,
    mapHasDrawer: map?.classList.contains('has-drawer') ?? null, mapDrawerH: map?.style.getPropertyValue('--drawer-h') ?? null,
    activeTab: Object.entries(tabs).filter(([, s]) => q(s)?.getAttribute('aria-selected') === 'true').map(([k]) => k),
    visibleTabs: Object.entries(tabs).filter(([, s]) => q(s) && !q(s).hidden).map(([k]) => k),
    tabsHidden: Object.fromEntries(Object.entries(tabs).map(([k, s]) => [k, hid(s)])),
    panelsHidden: Object.fromEntries(Object.entries(panels).map(([k, s]) => [k, hid(s)])),
    tabsVisibility: Object.fromEntries(Object.entries(tabs).map(([k, s]) => [k, vis(s)])),
    panelsVisibility: Object.fromEntries(Object.entries(panels).map(([k, s]) => [k, vis(s)])),
    routeActionsHidden: hid('.td-route-actions'),
    activeElement: a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` : null,
  };
}, [TABS, PANELS]);
export async function snap(page, step, sels) {
  const out = { step, state: await drawerState(page) };
  if (sels) { out.html = {}; for (const s of sels) out.html[s] = await normHtml(page, s); }
  return out;
}
/** A grip drag, as a visitor's: up by `dy` px. */
export async function dragGrip(page, dy = 200) {
  const g = await page.$eval('.td-grip', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.mouse.move(g[0], g[1]);
  await page.mouse.down();
  await page.mouse.move(g[0], g[1] - dy, { steps: 8 });
  await page.mouse.up();
}
export async function closePane(page, name) {
  const x = `.td-tab-x[data-pane="${name}"]`;
  if (await page.isVisible(x)) { await page.click(x); await page.waitForTimeout(200); }
}
/** Table: the row's ⋯ menu ▸ Show in table (on a phone through the layer panel). */
export async function openTableAny(page, id) {
  if (await page.isVisible('#layersToggleBtn')) await page.click('#layersToggleBtn');
  await openTable(page, id);
  await page.waitForSelector('.td-row', { timeout: 30000 });
  if (await page.isVisible('#closeLayers')) await page.click('#closeLayers');
}
export const openAskAny = async page => {
  await openChat(page);
  if (await page.isVisible('.chat-key-input')) { await page.fill('.chat-key-input', KEY); await page.click('.chat-connect'); }
};
export const SHELL = ['.table-drawer', '.td-tabs'];   // the drawer's root and tab strip, dumped at the collapsed and Esc steps
export const PANE_DEFS = {
  table: { sels: ['.td-head', '.td-summary', '#td-panel'] },
  ask: { sels: ['.td-head', '#td-ask'] },
  viz: { sels: ['.td-head', '#td-viz'] },
  line: { sels: ['.td-head', '#td-line'] },
  prox: { sels: ['.td-head', '#td-prox'] },
  gops: { sels: ['.td-head', '#td-gops'] },
  route: { sels: ['.td-head', '#td-route'] },
};
/**
 * One pane through its own opener: open, collapse, expand, Esc (focus return), reopen, close.
 * `short` (after a grip drag) is open + close only.
 */
export async function paneLife(page, name, open, short = false) {
  const steps = [], sels = PANE_DEFS[name].sels, tag = (short ? 'drag:' : '') + name;
  await open(page);
  await settle(page);
  steps.push(await snap(page, `${tag}:open`, sels));
  if (!short) {
    if (await page.isVisible('.td-collapse')) {
      await page.click('.td-collapse'); await page.waitForTimeout(300);
      steps.push(await snap(page, `${tag}:collapsed`, SHELL));
      await page.click('.td-collapse'); await page.waitForTimeout(300);
      steps.push(await snap(page, `${tag}:expanded`));
    }
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    steps.push(await snap(page, `${tag}:esc`, SHELL));
    if (!(await page.isVisible(`.td-tab-x[data-pane="${name}"]`))) {
      await open(page); await settle(page);
      steps.push(await snap(page, `${tag}:reopen`, sels));
    }
  }
  await closePane(page, name);
  steps.push(await snap(page, `${tag}:closed`));
  return steps;
}
export const hideTab = page => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
/** Close a page or context without waiting on a wedged renderer for more than 10 s. */
export const bye = x => Promise.race([x.close().catch(() => {}), new Promise(r => setTimeout(r, 10000))]);
// The machine is shared and the software renderer starves under load, so a pass that makes no end within its
// budget is abandoned (its contexts closed) and run again from the start; a dump is written only by a finished pass.
export const LIVE = [];
export async function retryPass(pass, body, minutes = 25, tries = 3) {
  const lang0 = pass.lang;
  for (let attempt = 1; ; attempt++) {
    // Each attempt runs on its own copy of the pass; an abandoned one is marked dead and writes no dump and records no check.
    const p = { ...pass, lang: lang0, done: false, dead: false };
    LIVE.length = 0;
    const run = body(p);
    run.catch(() => {});
    let timer;
    const res = await Promise.race([run.then(() => 'done'), new Promise(r => { timer = setTimeout(() => r('stalled'), minutes * 60000); })]);
    clearTimeout(timer);
    if (res === 'done') return;
    p.dead = true;
    log(`  pass ${pass.name} stalled (attempt ${attempt})`);
    await Promise.all(LIVE.splice(0).map(bye));
    if (attempt === tries) { check(`pass ${pass.name} finished`, false, `stalled ${tries} times`); return; }
  }
}
/** check / writeDump of a pass body: silent once the attempt was abandoned. */
export const pcheck = (p, ...a) => { if (!p.dead) check(...a); };
export const pdump = (p, ...a) => { if (!p.dead) writeDump(...a); };
export const dialogsClosed = page => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
export const quiet = e => !/Failed to load resource|net::ERR|status of 4\d\d|ERR_/.test(e);
