// .claude/skills/drive-app/scenarios/proximity.mjs
// The `proximity` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW, URL_BASE, OUT, CAM, log, check, open, ready, st, shot } from '../harness.mjs';

  // Proximity check (Tools ▸ Proximity check…) on a 30,000-row CSV: timings and checks.
  // Dev or preview (preview is the one to judge: `node drive.mjs --preview proximity`).
  // The map is reached through a harness-only trap that captures the MapLibre Map when it
  // sets `_controls`, so the same code runs against a production bundle. A CSV is
  // generated (seeded Gaussian clusters, like fixtures d2) unless TM_PX_CSV names one;
  // TM_PX_ROWS (default 30000) sizes the generated file, TM_PX_RUNS (default 5) the repeats.
  // Timed: file chosen → Groups grid rows shown and map idle, at ~1 mile and 25 km;
  // a threshold change → both px sources set, loaded and the map idle (the 250 ms
  // debounce reported apart from the work after it); the sync cost of each setData.
  // Headless SwiftShader renders slower than a GPU; the numbers are an upper bound for drawing.
export default async function proximity(ctx) {
    const RUNS = Number(process.env.TM_PX_RUNS ?? 5);
    const ONLY_MI = process.env.TM_PX_LARGE === '0'; // skip the 25 km runs
    const VISUAL = process.env.TM_PX_VISUAL !== '0';
    const ROWS = Number(process.env.TM_PX_ROWS ?? 30000);
    let csv = process.env.TM_PX_CSV;
    if (!csv) {
      csv = path.join(OUT, `px-${ROWS}.csv`);
      let a = 42;
      const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const g = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      const lines = ['id,name,latitude,longitude'];
      while (lines.length <= ROWS) {
        const lon0 = -125 + r() * 58.5, lat0 = 24.5 + r() * 25, sd = 2 + r() * 18, k = 5 + Math.floor(r() * 30);
        for (let j = 0; j < k && lines.length <= ROWS; j++) {
          const lat = Math.max(-89, Math.min(89, lat0 + g() * sd / 111.19));
          const lon = lon0 + g() * sd / (111.19 * Math.cos(lat0 * Math.PI / 180));
          lines.push(`S${lines.length},Site ${lines.length},${lat.toFixed(6)},${lon.toFixed(6)}`);
        }
      }
      fs.writeFileSync(csv, lines.join('\n') + '\n');
    }
    const c = await ctx.browser().newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await c.addInitScript(() => {
      Object.defineProperty(Object.prototype, '_controls', {
        configurable: true,
        set(v) {
          Object.defineProperty(this, '_controls', { value: v, writable: true, configurable: true, enumerable: true });
          if (typeof this.getSource === 'function' && !window.__map) window.__map = this;
        },
      });
    });
    const page = await c.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('dialog', d => d.dismiss());
    await ready(page, { url: URL_BASE + '#' + CAM });
    await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 });
    await page.waitForTimeout(3000);
    // The in-page probe: event times on the page's clock.
    await page.evaluate(() => {
      const map = window.__map, now = () => performance.now();
      const px = window.__px = { run: null, long: [], fires: [], last: {} };
      new PerformanceObserver(l => { for (const e of l.getEntries()) px.long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] });
      const st = window.setTimeout;
      window.setTimeout = function (fn, d, ...a) {
        if (d === 250 && typeof fn === 'function') { const f = fn; fn = function () { px.fires.push(now()); return f.apply(this, arguments); }; }
        return st.call(this, fn, d, ...a);
      };
      const patch = id => {
        const s = map.getSource(id), sd = s.setData.bind(s);
        s.setData = d => { px.last[id] = d; const t0 = now(); const r = sd(d); if (px.run) px.run.calls[id] = [t0, now()]; return r; };
      };
      const add = map.addSource.bind(map);
      map.addSource = (id, spec) => {
        const t0 = now(); const r = add(id, spec);
        if (id.startsWith('px-')) { px.last[id] = spec.data; if (px.run) px.run.calls[id] = [t0, now()]; patch(id); }
        return r;
      };
      map.on('sourcedata', e => { if (px.run && e.sourceId?.startsWith('px-') && e.isSourceLoaded) px.run.loaded[e.sourceId] = now(); });
      map.on('idle', () => { if (px.run) px.run.idle = now(); });
      document.addEventListener('change', e => { if (px.run && e.target.classList?.contains('px-file')) px.run.t0 = now(); }, true);
      document.addEventListener('input', e => { if (px.run && e.target.id === 'px-th') px.run.tIn = now(); }, true);
      document.addEventListener('change', e => { if (px.run && e.target.classList?.contains('px-unit')) px.run.tIn = now(); }, true);
      new MutationObserver(() => {
        const r = px.run; if (!r) return;
        if (!r.picker && document.getElementById('csvImport')) {
          r.picker = now();
          const idSel = document.getElementById('csvIdSel'); if (idSel) idSel.value = '0';
          r.click = now(); document.getElementById('csvImport').click();
        }
        if (r.click && !r.grid && document.querySelector('.px-grid .tabulator-row')) r.grid = now();
      }).observe(document.body, { childList: true, subtree: true });
      px.arm = () => { px.run = { calls: {}, loaded: {}, idle: 0, fireIdx: px.fires.length, longIdx: px.long.length }; };
      px.done = (needGrid) => {
        const r = px.run; if (!r) return false;
        const ids = ['px-points'];
        if (!ids.every(i => r.calls[i] && r.loaded[i] > r.calls[i][0])) return false;
        if (needGrid && !r.grid) return false;
        return r.idle > Math.max(...ids.map(i => r.loaded[i]));
      };
      px.result = () => ({ ...px.run, fire: px.fires[px.run.fireIdx], long: px.long.slice(px.run.longIdx), status: document.querySelector('.px-status')?.textContent ?? '' });
    });
    const arm = () => page.evaluate(() => window.__px.arm());
    const finish = async (needGrid) => {
      await page.waitForFunction(g => window.__px.done(g), needGrid, { timeout: 120000, polling: 50 });
      await page.waitForTimeout(300);
      return page.evaluate(() => window.__px.result());
    };
    const mapHas = () => page.evaluate(() => ({
      px: window.__map.getStyle().layers.map(l => l.id).filter(i => i.startsWith('px-')),
      src: Object.keys(window.__map.getStyle().sources).filter(i => i.startsWith('px-')),
    }));
    const openTab = async () => {
      await page.click('#toolsMenuBtn');
      await page.click('[data-action="open-proximity"]');
      await page.waitForSelector('.px .px-file', { state: 'attached', timeout: 30000 });
    };
    const closeTab = async () => { await page.click('.td-tab-x[data-pane="prox"]'); await page.waitForTimeout(500); };
    const setThreshold = async (v, u) => {
      await page.selectOption('.px-unit', u);
      await page.fill('#px-th', String(v));
    };
    const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const mx = a => Math.max(...a);
    const f = n => (Math.round(n * 10) / 10).toString();
    const loadRuns = {};
    const all = { rows: ROWS, csv: path.basename(csv), load: {}, change: {}, setData: {} };

    // 1. File chosen → grid rows and map idle, at ~1 mile and at 25 km. Each run on a closed tab.
    for (const [label, v, u] of [['1mi', 1, 'mi'], ['25km', 25, 'km']].filter(x => !ONLY_MI || x[0] === '1mi')) {
      const runs = [];
      for (let k = 0; k < RUNS; k++) {
        await openTab();
        await setThreshold(v, u);
        await arm();
        await page.setInputFiles('.px-file', csv);
        const r = await finish(true);
        runs.push({
          toPicker: r.picker - r.t0, afterClick: r.idle - r.click, toGrid: r.grid - r.click,
          toLoaded: r.loaded['px-points'] - r.click,
          addPoints: r.calls['px-points'][1] - r.calls['px-points'][0],
          buildFeatures: r.calls['px-points'][0] - r.click, status: r.status,
          long: r.long.reduce((s, l) => s + l[1], 0),
        });
        runs[k].total = runs[k].toPicker + runs[k].afterClick;
        if (k === 0) {
          check(`${label}: the Groups table fills`, await page.evaluate(() => document.querySelectorAll('.px-grid .tabulator-row').length) > 0, r.status);
          const has = await mapHas();
          check(`${label}: the map has px-points and px-bubbles (circle) on the one px-points source`, has.px.includes('px-points') && has.px.includes('px-bubbles') && has.src.length === 1 && has.src[0] === 'px-points', has.px.join(','));
          await page.waitForTimeout(800);
          await shot(page, `proximity-1-load-${label}`);
        }
        await closeTab();
        const gone = await mapHas();
        if (k === 0) check(`${label}: closing the tab removes every px- layer and source`, gone.px.length === 0 && gone.src.length === 0, JSON.stringify(gone));
      }
      all.load[label] = runs;
    }

    // 2. Threshold changes on a loaded file: 25 km (↔ 30 km), then ~1 mile (↔ 1.2 mi).
    await openTab();
    await setThreshold(ONLY_MI ? 1 : 25, ONLY_MI ? 'mi' : 'km');
    await arm();
    await page.setInputFiles('.px-file', csv);
    await finish(true);
    for (const [label, a, b, u] of [['25km', 30, 25, 'km'], ['1mi', 1, 1.2, 'mi']].filter(x => !ONLY_MI || x[0] === '1mi')) {
      if (label === '1mi') { await setThreshold(a, u); await arm(); await finish(false); }
      const runs = [];
      let statusBefore = await page.textContent('.px-status');
      for (let k = 0; k < RUNS + 1; k++) {
        await page.waitForTimeout(400);
        await arm();
        await page.fill('#px-th', String(k % 2 === 0 ? (label === '25km' ? a : b) : (label === '25km' ? b : a)));
        const r = await finish(false);
        if (k === 0 && label === '25km') { /* the first run absorbs warm-up; kept in the list but flagged */ }
        runs.push({
          debounce: r.fire - r.tIn, afterFire: r.idle - r.fire,
          preSetData: r.calls['px-points'][0] - r.fire,
          setPoints: r.calls['px-points'][1] - r.calls['px-points'][0],
          toLoaded: r.loaded['px-points'] - r.fire, toIdle: r.idle - r.fire,
          status: r.status, long: r.long.reduce((s, l) => s + l[1], 0),
        });
      }
      all.change[label] = runs;
      // The runs alternate two thresholds and may end on the first one, so each run's status is held to the one before it.
      const seen = [statusBefore, ...runs.map(x => x.status)];
      check(`${label}: a threshold change redraws (both sources set, status refreshed)`, runs.every(x => Number.isFinite(x.toIdle)) && seen.slice(1).every((x, i) => x !== seen[i]), seen.join(' → '));
      await shot(page, `proximity-2-change-${label}`);
    }
    const has2 = await mapHas();
    check('the map still has the px- layers after the changes', has2.px.includes('px-bubbles') && has2.px.includes('px-points'), has2.px.join(','));
    await closeTab();
    check('close removes px- layers and sources', (await mapHas()).px.length === 0);

    // 3. setData on its own, direct from the page (px-points, 30k grouped at ~1 mi and at 25 km).
    // The data is read back from the sources' own GeoJSON and set again; worker parse to loaded is timed apart.
    await openTab();
    for (const [label, v, u] of [['1mi', 1, 'mi'], ['25km', 25, 'km']].filter(x => !ONLY_MI || x[0] === '1mi')) {
      await setThreshold(v, u);
      await arm();
      await page.setInputFiles('.px-file', csv);
      await finish(true);
      const rs = [];
      for (let k = 0; k < RUNS; k++) {
        await page.waitForTimeout(300);
        rs.push(await page.evaluate(async () => {
          const map = window.__map, now = () => performance.now(), out = {};
          for (const id of ['px-points']) {
            const s = map.getSource(id);
            const data = window.__px.last[id];
            const n = data.features.length;
            const t0 = now();
            const done = new Promise(res => { const h = e => { if (e.sourceId === id && e.isSourceLoaded) { map.off('sourcedata', h); res(now()); } }; map.on('sourcedata', h); });
            s.setData(data);
            const t1 = now();
            const tl = await Promise.race([done, new Promise(r => setTimeout(() => r(NaN), 60000))]);
            await new Promise(res => { map.once('idle', res); map.triggerRepaint(); });
            out[id] = { features: n, sync: t1 - t0, toLoaded: tl - t0, toIdle: now() - t0 };
          }
          return out;
        }));
      }
      all.setData[label] = rs;
    }
    await closeTab();

    // 4. Looks: bubbles of a pair overlap at the fly-to zoom, near the tile-buffer zoom limit, and on the globe at 60-70°N.
    if (VISUAL) {
      const idleShot = async (name, wait = 600) => {
        await page.evaluate(() => new Promise(res => { window.__map.once('idle', res); window.__map.triggerRepaint(); }));
        await page.waitForTimeout(wait);
        await page.evaluate(() => new Promise(res => { window.__map.once('idle', res); window.__map.triggerRepaint(); }));
        return shot(page, name);
      };
      const mapAt = (lng, lat, z) => page.evaluate(([x, y, zz]) => window.__map.jumpTo({ center: [x, y], zoom: zz, bearing: 0, pitch: 0 }), [lng, lat, z]);
      await openTab();
      await setThreshold(1, 'mi');
      await arm();
      await page.setInputFiles('.px-file', csv);
      await finish(true);
      const pair = await page.evaluate(() => {
        const fs = window.__px.last['px-points'].features, by = new Map();
        for (const f of fs) { const g = f.properties.g; (by.get(g) ?? by.set(g, []).get(g)).push(f); }
        const km = (a, b) => { const R = Math.PI / 180, d = Math.sin((b[1] - a[1]) * R / 2) ** 2 + Math.cos(a[1] * R) * Math.cos(b[1] * R) * Math.sin((b[0] - a[0]) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(d)); };
        for (const [, m] of by) if (m.length === 2) {
          const d = km(m[0].geometry.coordinates, m[1].geometry.coordinates);
          if (d > 1.0 && d < 1.4) return { a: m[0].geometry.coordinates, b: m[1].geometry.coordinates, d };
        }
        return null;
      });
      check('a two-point group 1.0 to 1.4 km apart exists in the data', !!pair, JSON.stringify(pair));
      // A row click selects only: the camera stays put and the point and its group are outlined.
      const zBefore = await page.evaluate(() => window.__map.getZoom());
      await page.click('.px-grid .tabulator-row');
      await page.waitForTimeout(2500);
      const rowZ = await page.evaluate(() => window.__map.getZoom());
      check('a row click moves no camera (zoom unchanged)', Math.abs(rowZ - zBefore) < 1e-6, `${f(zBefore)} -> ${f(rowZ)}`);
      await idleShot('proximity-3-rowclick-select');
      // The row's ↗ "Zoom to" button is the only control that flies to the point.
      await page.click('.px-grid .tabulator-row .px-fly');
      await page.waitForTimeout(2500);
      const flyZ = await page.evaluate(() => window.__map.getZoom());
      await idleShot('proximity-3b-zoomto-flyto');
      log(`Zoom to (px-fly) flew to zoom ${f(flyZ)}`);
      if (pair) {
        const mid = [(pair.a[0] + pair.b[0]) / 2, (pair.a[1] + pair.b[1]) / 2];
        await mapAt(mid[0], mid[1], 13.2);
        await idleShot('proximity-4-pair-z13');
        await mapAt(mid[0], mid[1], 14.5);
        await idleShot('proximity-5-pair-z14_5');
        const z = 14 ;
        const corner = await page.evaluate(([x, y, zz]) => { const n = 2 ** zz; return [Math.round((x + 180) / 360 * n) / n * 360 - 180, 0]; }, [pair.a[0], pair.a[1], z]);
        const maxZ = await page.evaluate(() => window.__map.getLayer('px-bubbles').maxzoom);
        log(`bubble layers' maxzoom: ${f(maxZ)}`);
        await mapAt(pair.a[0], pair.a[1], maxZ - 0.15);
        await idleShot('proximity-6-near-maxzoom');
        await mapAt(corner[0], pair.a[1], maxZ - 0.15);
        await idleShot('proximity-7-near-maxzoom-tile-edge');
        await mapAt(pair.a[0], pair.a[1], maxZ + 0.6);
        await idleShot('proximity-8-past-maxzoom');
        const past = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['px-bubbles'] }).length);
        log(`rendered px-bubbles features past maxzoom: ${past}`);
      }
      await closeTab();
      // A high-latitude set: pairs and triples ~280 km apart at 58-72°N, threshold 400 km, on the globe.
      const hi = path.join(OUT, 'px-hilat.csv');
      const rows = ['id,name,latitude,longitude'];
      let n = 0;
      for (const [lat0, lon0] of [[60, -150], [64, -120], [62, -100], [66, 20], [70, 30], [60, 10], [68, 90], [61, 60], [72, -50], [59, -60], [65, 130], [63, 170]]) {
        const dl = 280 / (111.2 * Math.cos(lat0 * Math.PI / 180));
        for (const [la, lo] of [[lat0, lon0], [lat0 + 2.5, lon0], [lat0, lon0 + dl]]) rows.push(`H${n++},Hi ${n},${la.toFixed(4)},${lo.toFixed(4)}`);
      }
      fs.writeFileSync(hi, rows.join('\n') + '\n');
      await openTab();
      await setThreshold(400, 'km');
      await arm();
      await page.setInputFiles('.px-file', hi);
      await finish(true);
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.querySelector('.td-collapse')?.click());
      await page.evaluate(() => document.querySelector('input[name=projection][value=globe]').click());
      await page.waitForTimeout(1500);
      check('the globe projection is on', await page.evaluate(() => window.__map.getProjection?.()?.type === 'globe'));
      for (const [name, lng, lat, z] of [['globe-alaska-z3', -150, 62, 3], ['globe-norway-z2_5', 20, 67, 2.5], ['globe-siberia-z3_5', 90, 68, 3.5], ['globe-world-z1_5', 20, 55, 1.5]]) {
        await mapAt(lng, lat, z);
        await idleShot(`proximity-9-${name}`, 1200);
      }
      const hasHi = await mapHas();
      check('globe: the bubble layers draw (px-bubbles present)', hasHi.px.includes('px-bubbles'));
      await page.evaluate(() => document.querySelector('input[name=projection][value=mercator]')?.click());
      await closeTab();
    }

    // Report.
    const stat = (runs, key) => `${f(med(runs.map(x => x[key])))} / ${f(mx(runs.map(x => x[key])))}`;
    log('\nPROXIMITY TIMINGS (ms, median / max over runs; rows=' + ROWS + ', ' + all.csv + ', ' + (PREVIEW ? 'preview build' : 'dev server') + ', headless SwiftShader)');
    for (const [label, runs] of Object.entries(all.load)) {
      log(`load @${label}: [${runs[0].status}]`);
      log(`  chosen→picker ${stat(runs, 'toPicker')} | confirm→grid ${stat(runs, 'toGrid')} | confirm→sources loaded ${stat(runs, 'toLoaded')} | confirm→idle ${stat(runs, 'afterClick')} | TOTAL chosen→idle ${stat(runs, 'total')} | features→first addSource ${stat(runs, 'buildFeatures')} | addSource points ${stat(runs, 'addPoints')} | longtasks ${stat(runs, 'long')}`);
    }
    for (const [label, runs] of Object.entries(all.change)) {
      log(`change @${label}: [${runs[runs.length - 1].status}]`);
      log(`  debounce ${stat(runs, 'debounce')} | fire→first setData ${stat(runs, 'preSetData')} | setData sync points ${stat(runs, 'setPoints')} | fire→loaded ${stat(runs, 'toLoaded')} | fire→idle ${stat(runs, 'toIdle')} | longtasks ${stat(runs, 'long')}`);
    }
    for (const [label, runs] of Object.entries(all.setData)) {
      for (const id of ['px-points']) {
        const rr = runs.map(x => x[id]);
        log(`setData @${label} ${id} (${rr[0].features} features): sync ${stat(rr, 'sync')} | →loaded ${stat(rr, 'toLoaded')} | →idle ${stat(rr, 'toIdle')}`);
      }
    }
    fs.writeFileSync(path.join(OUT, 'proximity-timings.json'), JSON.stringify(all, null, 1));
    log('raw runs', path.join(OUT, 'proximity-timings.json'));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await c.close();
}
