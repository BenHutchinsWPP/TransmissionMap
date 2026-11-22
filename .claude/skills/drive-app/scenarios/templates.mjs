// .claude/skills/drive-app/scenarios/templates.mjs
// The `templates` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import path from 'node:path';
import os from 'node:os';
import { PREVIEW, OUT, log, check, open, ready, settle, mod, st, shot, hashOf, inked, reset, call, openChat, chatRig, NEAREST_READY, templateKit, snap } from '../harness.mjs';

  // Page-owned templates (Tools ▸ Visualize…, the chat's showTemplate), in three
  // parts (TM_PARTS=base,spread,flows; default all): the first six templates over
  // layers of different families with no key, their in-card interactions,
  // CSV/PNG, the chat (a mocked model and a local phrase), a reload, a blocked
  // CDN and a phone (base); compare-regions, distribution, timeline by month and
  // the gallery form's split / layer2 / where2 / within (spread); flow, nearest
  // and buildout-map (flows). Frames must be on screen to draw (a
  // cross-origin frame outside the viewport gets no animation frames), so each
  // card is scrolled into view before it is read. Dev or preview; on preview
  // the layers are the published ones and nothing dev-only is called.
export default async function templates(ctx) {
    const parts = (process.env.TM_PARTS ?? 'base,spread,flows').split(',');
    if (parts.includes('base')) await templatesBase(ctx);
    if (parts.includes('spread')) await templatesSpread(ctx);
    if (parts.includes('flows')) await templatesFlows(ctx);
}

// Part 1 (base): the six first templates over five families, the chat, a reload, a blocked CDN, a phone.
async function templatesBase(ctx) {
  const { GEN, SUBS, GAS, OGF, OSMTX, LABEL, TX_CAM, taps, rig, page, msgs, idle, openViz, frameOf, showViz, ink, pixels, snap, diff, MOVED, STILL, toastText, waitToast, clearToast, undoToast, params, camOf, live, inFrame, findPixel, menuItems, cardShot, dl, csvChecks, pngChecks, pngInk, kitChecks, vegaDownloads, cardOk, pixelAt, SAT, clickAct, undoCheck } = await templateKit(ctx);
  // ── 1 · No key: Tools ▸ Visualize… over five families ──
  await openViz();
  check('Visualize opens with no key (no key form, no OpenRouter request)', !(await page.isVisible('.chat-key-input')) && rig.hits.length === 0, rig.hits.join(' | '));
  const layers = await page.$$eval('.tv-layer option', os => os.map(o => o.value));
  check('the layer picker lists the layers a template fits', [GEN, SUBS, GAS, OGF].every(l => layers.includes(l)), `${layers.length}: ${layers.slice(0, 8).join(',')}…`);
  await shot(page, 'templates-0-gallery');

  // composition — pipelines family (HIFLD natural-gas facilities by type)
  const comp = await showViz(GAS, 'composition', { by: 'fac_type' });
  cardOk('composition (natgas facilities)', comp, 'rendered');
  check('composition: the donut, list and bars drew', (await ink(comp.frame)) > 2000, String(await ink(comp.frame)));
  await cardShot(comp.card, 'templates-1-composition');
  await vegaDownloads('composition', comp.card, 'tpl-composition');
  // Hover a mark: the rest dim (canvas changes), leaving restores; a click keeps it lit.
  {
    await comp.card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    await page.waitForTimeout(300);
    await snap(comp.frame);
    const box = await (await comp.card.$('iframe')).boundingBox();
    let at = null, lit = 0;
    for (const fy of [0.55, 0.45, 0.65, 0.35]) {
      for (let x = box.x + 30; x < box.x + box.width - 20 && !at; x += 14) {
        await page.mouse.move(x, box.y + box.height * fy);
        await page.waitForTimeout(40);
        lit = await diff(comp.frame);
        if (lit > MOVED) at = [x, box.y + box.height * fy];
      }
      if (at) break;
    }
    await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 5 });
    await page.waitForTimeout(300);
    const back = await diff(comp.frame);
    check('composition: hovering a mark dims the other groups (cross-highlight), leaving restores', !!at && back < STILL, `at ${at} · ${lit} samples moved · ${back} after leaving`);
    if (at) {
      await clearToast();
      const L0 = await hashOf(page);
      await page.mouse.click(at[0], at[1]);
      await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 5 });
      await page.waitForTimeout(300);
      const kept = await diff(comp.frame);
      check('composition: a click keeps the group lit after the pointer leaves', kept > MOVED, `${kept} samples moved`);
      await cardShot(comp.card, 'templates-2-composition-picked');
      // The click is also the page's `where` action: the map shows only that group (a page-built condition), with Undo.
      const t1 = await waitToast();
      const L1 = await hashOf(page);
      const w1 = await live(`state.where[${JSON.stringify(GAS)}] ?? null`);
      const mapped = PREVIEW ? true : await mod(page, '/src/registry/index.ts', (m, id) => m.layerById(id).mapLayerIds, GAS)
        .then(ids => st(page, `${JSON.stringify(ids)}.some(id => JSON.stringify(state.map.getFilter(id) ?? '').includes('fac_type'))`));
      check('composition action: a click filters the map to the group ("Composition: the map shows only …" + Undo; where on fac_type; the link carries it)',
        /^Composition: the map shows only .+Undo/.test(t1 ?? '') && params(L1) !== params(L0) && /vx=/.test(L1)
          && (PREVIEW || (Array.isArray(w1) && w1.length === 1 && w1[0].field === 'fac_type' && mapped)),
        `${t1} · ${JSON.stringify(w1)} · map filter ${mapped} · ${params(L1).slice(0, 60)}`);
      await shot(page, 'templates-2b-composition-filtered');
      await undoToast();
      const w2 = await live(`state.where[${JSON.stringify(GAS)}] ?? null`);
      check('composition action: the toast\'s Undo restores the map and the link', params(await hashOf(page)) === params(L0) && (PREVIEW || w2 === null) && !(await toastText()),
        `${JSON.stringify(w2)} · ${params(await hashOf(page)).slice(0, 60)}`);
      await page.mouse.dblclick(at[0], at[1]);
      await page.waitForTimeout(900);
      check('composition: a click on the group already picked, and the double-click that clears it, change nothing', params(await hashOf(page)) === params(L0) && !(await toastText()),
        `${await toastText()} · ${params(await hashOf(page)).slice(0, 60)}`);
    }
  }

  // ranking — substations family (HIFLD substations by state)
  const rank = await showViz(SUBS, 'ranking', { by: 'states' });
  cardOk('ranking (HIFLD substations by state)', rank, 'rendered');
  check('ranking: the bars drew', (await ink(rank.frame)) > 1500, String(await ink(rank.frame)));
  await cardShot(rank.card, 'templates-3-ranking');
  await vegaDownloads('ranking', rank.card, 'tpl-ranking');

  // ranking race — generators by state through op_year (the slider)
  const race = await showViz(GEN, 'ranking', { by: 'state', time: 'op_year' });
  cardOk('ranking race (EIA generators by state, op_year)', race, 'rendered');
  {
    await race.card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    await snap(race.frame);
    const slider = await race.frame.evaluate(() => {
      const r = document.querySelector('input[type=range]');
      if (!r) return null;
      const was = r.value;
      r.value = String(Math.round((+r.min + +r.max) / 2));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return { min: r.min, max: r.max, was, now: r.value };
    }).catch(() => null);
    await page.waitForTimeout(600);
    const moved = await diff(race.frame);
    check('ranking race: a year slider, and moving it redraws the bars', !!slider && moved > MOVED, `${JSON.stringify(slider)} · ${moved}`);
    await cardShot(race.card, 'templates-4-ranking-race');
  }

  // timeline — generators, mode net (retirements below zero)
  const tl = await showViz(GEN, 'timeline', { time: 'op_year', mode: 'net' });
  cardOk('timeline net (EIA generators)', tl, 'rendered');
  {
    const neg = await tl.frame.evaluate(() => {
      const seen = { retire: 0, below: 0 };
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o.side === 'retire') { seen.retire++; if (typeof o.value === 'number' && o.value < 0) seen.below++; }
        for (const k in o) walk(o[k]);
      };
      walk(window.__tmIn ?? []);
      return seen;
    }).catch(() => null);
    check('timeline net: retirements sent as values below zero', neg && neg.retire > 0 && neg.below > 0, JSON.stringify(neg));
    check('timeline: the chart drew', (await ink(tl.frame)) > 1500, String(await ink(tl.frame)));
    await cardShot(tl.card, 'templates-5-timeline-net');
    await vegaDownloads('timeline', tl.card, 'tpl-timeline');
  }

  // lines-by-class — planned lines (OGF, a whole GeoJSON)
  const ogf = await showViz(OGF, 'lines-by-class');
  cardOk('lines-by-class (OGF planned)', ogf, 'drawn');
  {
    const b = await ogf.frame.evaluate(() => ({ scope: document.querySelector('.kit-scope')?.textContent, tiers: !!document.querySelector('.kit-tiers'),
      bars: document.querySelectorAll('.lbc-bar').length })).catch(e => ({ e: e.message }));
    check('lines-by-class (OGF): whole-layer scope, no tiers banner, bars drawn', /Every feature|whole|area/i.test(b.scope ?? '') && !b.tiers && b.bars > 0, JSON.stringify(b));
    check('lines-by-class (OGF): the map drew', (await ink(ogf.frame)) > 2000, String(await ink(ogf.frame)));
    await ogf.card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    await snap(ogf.frame, '.lbc-map canvas');
    await ogf.frame.hover('.lbc-bar >> nth=0');
    await page.waitForTimeout(500);
    const lit = await ogf.frame.evaluate(() => !!document.querySelector('.lbc-bars.lbc-dim') && !!document.querySelector('.lbc-bar.on')).catch(() => false);
    const moved = await diff(ogf.frame, '.lbc-map canvas');
    check('lines-by-class: hovering a bar lights its class on the map (the rest dim)', lit && moved > MOVED, `${lit} · ${moved}`);
    await cardShot(ogf.card, 'templates-6-lines-ogf-hover');
    await page.mouse.move(5, 5);
    await kitChecks('lines-by-class (OGF)', ogf.card, ogf.frame, 'tpl-lines-ogf');
  }

  // lines-by-class — OSM transmission (tiled): switch on, zoom 7 → current view + tiers hidden
  await page.evaluate(() => { location.hash = '#7/31.0/-97.0'; });
  await page.waitForTimeout(500);
  // HIFLD lines (tiled, off by default): the form offers Switch on and holds Show back.
  await page.selectOption('.tv-layer', 'hifld-transmission-lines');
  await page.click('.tv-card[data-template="lines-by-class"]');
  const offNote = await page.$eval('.tv-scope', s => s.textContent);
  check('a tiled layer switched off: the form offers Switch on and Show is disabled',
    await page.isVisible('.tv-switch-on') && await page.$eval('.tv-show', b => b.disabled), offNote);
  await page.selectOption('.tv-layer', OSMTX);
  await page.click('.tv-card[data-template="lines-by-class"]');
  if (await page.isVisible('.tv-switch-on')) await page.click('.tv-switch-on');
  else log('NOTE  OSM transmission lines are on by default, so no Switch on was needed');
  await idle();
  const osm = await showViz(OSMTX, 'lines-by-class');
  cardOk('lines-by-class (OSM transmission, z7)', osm, 'drawn');
  {
    const b = await osm.frame.evaluate(() => ({ scope: document.querySelector('.kit-scope')?.textContent, tiers: document.querySelector('.kit-tiers')?.textContent,
      bars: document.querySelectorAll('.lbc-bar').length })).catch(e => ({ e: e.message }));
    check('lines-by-class (OSM): the current-view banner', /Current view/.test(b.scope ?? ''), JSON.stringify(b));
    check('lines-by-class (OSM): the tiers-hidden banner names the hidden tiers by their kV range, not their ids',
      /Not drawn at this zoom:\s*(Low|Medium|High|Unknown) voltage/.test(b.tiers ?? '') && !/\b(lv|mv|hv)\b/.test(b.tiers ?? ''), String(b.tiers));
    check('lines-by-class (OSM): the map drew', (await ink(osm.frame)) > 2000, String(await ink(osm.frame)));
    await cardShot(osm.card, 'templates-7-lines-osm-view');
    await kitChecks('lines-by-class (OSM)', osm.card, osm.frame, 'tpl-lines-osm');
    // Actions: a class bar → "Show only this on the map" (a kV range the page builds); a line → Select / Zoom.
    await osm.card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
    await clearToast();
    const L0 = await hashOf(page);
    const bar = await osm.frame.evaluate(() => [...document.querySelectorAll('.lbc-bar title')].map(t => t.textContent)
      .findIndex(t => !/Unknown|Other|\(none\)/.test(t))).catch(() => -1);
    await osm.frame.click(`.lbc-bar >> nth=${Math.max(0, bar)}`);
    const items = await menuItems(osm.frame);
    if (items.length) await osm.frame.click('.kit-menu button >> nth=0');
    const t1 = await waitToast();
    const w1 = await live(`state.where[${JSON.stringify(OSMTX)}] ?? null`);
    check('lines-by-class action: a class bar offers "Show only this on the map" and filters the map to that kV class (a page-built range) with Undo',
      items[0] === 'Show only this on the map' && /^Lines by class: the map shows only .*kV.*Undo/.test(t1 ?? '') && params(await hashOf(page)) !== params(L0)
        && (PREVIEW || (Array.isArray(w1) && w1.length >= 1 && w1.every(c => c.field === 'nominal_kv' && ['>=', '<', '>'].includes(c.op)))),
      `${JSON.stringify(items)} · ${t1} · ${JSON.stringify(w1)}`);
    await shot(page, 'templates-7b-lines-osm-class-filtered');
    await undoToast();
    check('lines-by-class action: Undo restores the link', params(await hashOf(page)) === params(L0), params(await hashOf(page)).slice(0, 60));
    await osm.frame.evaluate(() => document.querySelector('.kit-menu')?.remove()).catch(() => {});
    await osm.frame.click('.lbc-bar >> nth=0').catch(() => {});      // unpin, so the whole map is lit again
    await osm.frame.evaluate(() => document.querySelector('.kit-menu')?.remove()).catch(() => {});
    await page.waitForTimeout(800);
    const pt = await findPixel(osm.frame, '.lbc-map canvas.maplibregl-canvas', (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 90);
    if (!pt) check('lines-by-class action: a line pixel to click on the mini-map', false, 'no saturated pixel found');
    else {
      const [x, y] = await inFrame(osm.card, pt);
      await page.mouse.click(x, y);
      await page.waitForTimeout(400);
      const li = await menuItems(osm.frame);
      if (li.length) await osm.frame.click('.kit-menu button >> nth=0');
      const t2 = await waitToast();
      const sel = await live(`state.sel?.ids?.[${JSON.stringify(OSMTX)}] ?? null`);
      check('lines-by-class action: a line offers Select / Zoom / Show in table, and Select selects that one line with Undo',
        JSON.stringify(li) === JSON.stringify(['Select on the map (1)', 'Zoom the map here', 'Show in table']) && /^Lines by class: selected 1 on the map.*Undo/.test(t2 ?? '')
          && (PREVIEW || (Array.isArray(sel) && sel.length === 1 && typeof sel[0] === 'number')),
        `${JSON.stringify(li)} · ${t2} · ${JSON.stringify(sel)}`);
      await shot(page, 'templates-7c-lines-osm-line-selected');
      await undoToast();
      check('lines-by-class action: Undo clears that selection', params(await hashOf(page)) === params(L0) && (PREVIEW || await live('state.sel') === null), params(await hashOf(page)).slice(0, 60));
      await page.mouse.click(x, y);
      await page.waitForTimeout(400);
      const c0 = camOf(await hashOf(page));
      const li3 = await menuItems(osm.frame);
      if (li3.length) await osm.frame.click('.kit-menu button >> nth=1');
      await page.waitForFunction(c => location.hash.split('?')[0] !== c, c0, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const h3 = await hashOf(page);
      if (camOf(h3) === c0) log(`  zoom: menu ${JSON.stringify(li3)}`);
      check('lines-by-class action: Zoom the map here moves the camera (≤ z14), with no view change and no toast', camOf(h3) !== c0 && params(h3) === params(L0)
        && Number(camOf(h3).replace('#', '').split('/')[0]) <= 14.01 && !(await toastText()), `${c0} → ${camOf(h3)}`);
      await page.evaluate(() => { location.hash = '#7/31.0/-97.0' + (location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''); });
      await page.waitForTimeout(800);
    }
  }

  // density — substations (HIFLD), 3D hex then 2D heat
  const den = await showViz(SUBS, 'density');
  cardOk('density (HIFLD substations)', den, 'drawn');
  {
    check('density: the map and hexagons drew', (await ink(den.frame)) > 2000, String(await ink(den.frame)));
    await cardShot(den.card, 'templates-8-density-3d');
    const { png } = await kitChecks('density', den.card, den.frame, 'tpl-density');
    if (png) {
      const px = await pngInk(png);
      check('density PNG: hexagons in it (non-background, warm ramp pixels)', px.off > px.total * 0.02 && px.warm > 200, JSON.stringify(px));
    }
    // Table on, then PNG at once: the export waits for the resized map's next fresh frame.
    {
      await den.frame.click('.kit-tools > .kit-btn');
      if (!await den.frame.isVisible('.kit-dl-menu')) await den.frame.click('.kit-dl > summary');
      const quick = await dl(() => den.frame.click('.kit-dl-menu .kit-btn >> nth=1'), 'tpl-density-after-table');
      const qx = quick ? await pngInk(quick) : null;
      check('density PNG right after the Table toggle: not blank (hexagons in it)', !!qx && qx.off > qx.total * 0.02 && qx.warm > 200, JSON.stringify(qx));
      const rows = await den.frame.evaluate(() => ({ n: document.querySelectorAll('.kit-table tbody tr').length,
        head: [...document.querySelectorAll('.kit-table th')].map(t => t.textContent) })).catch(e => ({ e: e.message }));
      check('density: the table lists the features (longitude, latitude), not one Count row', rows.n > 1 && rows.head?.includes('Longitude') && rows.head?.includes('Latitude'), JSON.stringify(rows).slice(0, 300));
      await den.frame.click('.kit-tools > .kit-btn');
      await page.waitForTimeout(1500);
    }
    // Actions: a column → Select its features (≤ 500) / Show in table / Zoom the map here.
    {
      await den.card.evaluate(c => c.scrollIntoView({ block: 'nearest' }));
      await clearToast();
      const L0 = await hashOf(page);
      // The Table toggle above rebuilt the map and deck (a resized frame gets new ones): let them draw.
      await page.waitForTimeout(3000);
      // A column in the density ramp (light yellow → dark red): red well above blue, unlike the grey basemap.
      // The palest columns (the ramp's first colour) hold the fewest features, so Select is offered.
      const pt = await findPixel(den.frame, '.maplibregl-canvas', (r, g, b) => r > 235 && g > 215 && b > 130 && b < 200 && r - b > 50)
        ?? await findPixel(den.frame, '.maplibregl-canvas', (r, g, b) => r > 150 && r - b > 60);
      if (!pt) check('density action: a hexagon to click', false, 'no warm pixel found');
      else {
        const [x, y] = await inFrame(den.card, pt);
        await page.mouse.click(x, y);
        await page.waitForTimeout(600);
        const items = await menuItems(den.frame);
        const n = Number((items[0] ?? '').match(/\((\d[\d,]*)\)/)?.[1]?.replace(/,/g, '') ?? NaN);
        if (/^Select on the map/.test(items[0] ?? '')) {
          await den.frame.click('.kit-menu button >> nth=0');
          const t1 = await waitToast();
          const sel = await live(`state.sel?.ids?.[${JSON.stringify(SUBS)}] ?? null`);
          check('density action: a column offers Select (its features) / Show in table / Zoom, and Select selects them with Undo',
            items.length === 3 && items[2] === 'Zoom the map here' && n > 0 && n <= 500 && new RegExp(`^Density: selected ${n.toLocaleString('en')} on the map.*Undo`).test(t1 ?? '')
              && (PREVIEW || (Array.isArray(sel) && sel.length === n)), `${JSON.stringify(items)} · ${t1} · ${Array.isArray(sel) ? sel.length : sel}`);
          await shot(page, 'templates-8b-density-selected');
          await undoToast();
          check('density action: Undo clears that selection', params(await hashOf(page)) === params(L0), params(await hashOf(page)).slice(0, 60));
        } else {
          const c0 = camOf(await hashOf(page));
          if (items.length) await den.frame.click('.kit-menu button >> nth=0');
          // A long flight writes the camera to the link on its moveend.
          await page.waitForFunction(c => location.hash.split('?')[0] !== c, c0, { timeout: 10000 }).catch(() => {});
          const h1 = await hashOf(page);
          check('density action: a column of > 500 features offers only Zoom the map here, which moves the camera (no toast, no view change)',
            JSON.stringify(items) === JSON.stringify(['Zoom the map here']) && camOf(h1) !== c0 && params(h1) === params(L0) && !(await toastText()), `${JSON.stringify(items)} · ${c0} → ${camOf(h1)}`);
          await shot(page, 'templates-8b-density-zoomed');
        }
      }
    }
    const before = await den.frame.evaluate(() => [...document.querySelectorAll('.dn-seg button')].map(b => `${b.dataset.value}:${b.getAttribute('aria-pressed')}`)).catch(() => []);
    await snap(den.frame, '.maplibregl-canvas');
    const heat = before.find(x => /heat/.test(x))?.split(':')[0];
    if (heat) await den.frame.click(`.dn-seg button[data-value="${heat}"]`);
    await page.waitForTimeout(2500);
    const after = await den.frame.evaluate(() => [...document.querySelectorAll('.dn-seg button')].map(b => `${b.dataset.value}:${b.getAttribute('aria-pressed')}`)).catch(() => []);
    check('density: the 2D/3D toggle switches to the flat heatmap and redraws', !!heat && after.includes(`${heat}:true`) && (await diff(den.frame, '.maplibregl-canvas')) > MOVED,
      `${before.join(',')} → ${after.join(',')} · ${await diff(den.frame, '.maplibregl-canvas')}`);
    await cardShot(den.card, 'templates-9-density-2d');
  }
  check('no OpenRouter request in the whole gallery run', rig.hits.length === 0, rig.hits.join(' | '));

  // ── 4b · Per region (points-per-polygon): counties paint the main map, states draw in the frame ──
  // The county overlay (county-overlay.ts) is session only: no link write, no undo step, one at a
  // time, cleared by Reset, not repainted after a reload.
  const overlayOn = () => page.evaluate(() => { const l = document.getElementById('tplCountyLegend');
    return l ? { items: l.querySelectorAll('.legend-item').length, title: l.querySelector('.legend-title-label')?.textContent, shown: !!l.offsetParent } : null; });
  const overlayLayer = () => live(`(() => { const m = state.map; const ids = ['48201', '48113', '48453', '48029', '48439'];
    return { layer: !!m.getLayer('tpl-county-fill'), states: ids.map(id => m.getFeatureState({ source: 'county_boundaries', sourceLayer: 'county_boundaries', id }).tpl_v ?? null),
      lit: m.getLayer('tpl-county-fill') ? m.queryRenderedFeatures({ layers: ['tpl-county-fill'] }).filter(f => f.state && f.state.tpl_v).length : 0 }; })()`);
  const stamp = () => PREVIEW ? Promise.resolve(null) : mod(page, '/assets/undo.ts', m => m.historyStamp());
  {
    const link0 = await hashOf(page), stamp0 = await stamp();
    const ppc = await showViz(SUBS, 'points-per-polygon', { by: 'counties' });
    cardOk('per county (HIFLD substations)', ppc, 'drawn');
    await idle();
    const leg = await overlayOn();
    check('per county: a legend card for the map colours, with its classes', leg?.shown && leg.items >= 3, JSON.stringify(leg));
    const fr = await ppc.frame?.evaluate(() => ({ rows: document.querySelectorAll('.ppp-row').length, note: document.querySelector('.ppp-note')?.textContent,
      map: !!document.querySelector('.maplibregl-canvas'), first: document.querySelector('.ppp-name')?.textContent })).catch(e => ({ e: e.message }));
    check('per county: the frame ranks the counties by name, with no in-frame map', fr?.rows >= 5 && !fr.map && /main map/.test(fr.note ?? '') && /County|Parish/.test(fr.first ?? ''), JSON.stringify(fr));
    check('per county: the card offers Clear map colours', await ppc.card.$eval('.chat-canvas-clear', b => !b.hidden).catch(() => false));
    const ov = await overlayLayer();
    if (ov) check('per county: the overlay layer is on, Texas counties carry tpl_v colours and render', ov.layer && ov.states.filter(Boolean).length >= 3 && ov.lit > 50, JSON.stringify(ov));
    check('per county: painting wrote no link and added no undo step', await hashOf(page) === link0 && await stamp() === stamp0, `${await hashOf(page) === link0} · ${stamp0} → ${await stamp()}`);
    await shot(page, 'templates-9b-per-county-map');
    await cardShot(ppc.card, 'templates-9c-per-county-card');
    // A county row → "Show only this on the map": a where on counties (contains_any), its own undo step.
    await ppc.frame.click('.ppp-row');
    await page.waitForTimeout(300);
    const items = await menuItems(ppc.frame);
    await ppc.frame.click('.kit-menu button >> nth=0');
    const t = await waitToast();
    const filtered = await hashOf(page);
    const where = await live(`JSON.stringify(state.where['${SUBS}'] ?? [])`);
    check('per county: a row filters the layer to that county (toast with Undo)', /only/.test(t ?? '') && filtered !== link0 && (PREVIEW || /"counties","op":"contains_any"/.test(where ?? '')), `${items.join(' / ')} · ${t} · ${where}`);
    await undoToast();
    await clearToast();
    check('per county: Undo takes the filter back and leaves the map colours', await hashOf(page) === link0 && !!(await overlayOn()), await hashOf(page));

    // A second per-county card replaces the first's colours (one at a time).
    const ppg = await showViz(GEN, 'points-per-polygon', { by: 'counties', measure: 'nameplate_mw' });
    cardOk('per county (EIA generators, MW)', ppg, 'drawn');
    const leg2 = await overlayOn();
    const firstClear = await ppc.card.$eval('.chat-canvas-clear', b => b.hidden).catch(() => null);
    check('per county: the next card replaces the colours; the first card\'s Clear goes', leg2 && leg2.title !== leg.title && firstClear === true
      && await page.$$eval('.tpl-overlay-legend', l => l.length) === 1, `${leg?.title} → ${leg2?.title} · first Clear hidden ${firstClear}`);

    // By states: the frame draws the states (in-frame MapLibre) and the main map is not painted by it.
    const pps = await showViz(GEN, 'points-per-polygon', { by: 'states', measure: 'nameplate_mw' });
    cardOk('per state (EIA generators, MW)', pps, 'drawn');
    await page.waitForTimeout(1500);
    const sf = await pps.frame?.evaluate(() => ({ features: (TM_INPUT.features || []).length, rows: document.querySelectorAll('.ppp-row').length,
      first: document.querySelector('.ppp-name')?.textContent, legend: document.querySelectorAll('.ppp-legend > span').length })).catch(e => ({ e: e.message }));
    const sink = await ink(pps.frame);
    check('per state: the frame draws the states\' outlines and ranks them by name', sf?.features >= 40 && sf.rows >= 5 && sf.legend >= 3 && sink > 2000 && !/^[A-Z]{2}$/.test(sf.first ?? ''), `${JSON.stringify(sf)} · ink ${sink}`);
    check('per state: the county colours stay those of the per-county card', (await overlayOn())?.title === leg2?.title);
    await cardShot(pps.card, 'templates-9d-per-state-frame');
    // Hover a filled state in the frame: the tooltip names it.
    const blue = await findPixel(pps.frame, '.maplibregl-canvas', (r, g, b) => b > 150 && r < 120);
    if (blue) {
      const [x, y] = await inFrame(pps.card, blue);
      await page.mouse.move(x, y);
      await page.waitForTimeout(500);
      const tip = await pps.frame.evaluate(() => { const t = document.querySelector('.ppp-tip'); return t && !t.hidden ? t.textContent : null; }).catch(() => null);
      check('per state: hovering a state shows its name and value', !!tip && tip.length > 3, String(tip));
    }

    // Reset clears the overlay: legend, layer, the card's Clear.
    page.once('dialog', d => d.accept());
    await page.$eval('#resetLayersBtn', b => b.click());
    await idle();
    const ovR = await overlayLayer();
    check('Reset clears the county colours (legend, layer) and the card\'s Clear', !(await overlayOn()) && (!ovR || !ovR.layer)
      && await ppg.card.$eval('.chat-canvas-clear', b => b.hidden).catch(() => null) === true, JSON.stringify(ovR));
    await shot(page, 'templates-9e-after-reset');

    // Paint once more, so the reload below shows a restore does not repaint the map.
    const again = await showViz(SUBS, 'points-per-polygon', { by: 'counties' });
    check('per county again before the reload: painted', again.posted.includes('drawn') && !!(await overlayOn()), again.posted.join(','));
    // × on the older per-region cards (they do not own the colours now) leaves the current ones.
    for (const c of [ppc, ppg, pps]) await c.card.$eval('.chat-canvas-close', b => b.click()).catch(() => {});
    await page.waitForTimeout(300);
    check('× on cards that do not own the colours leaves them', !!(await overlayOn()) && await again.card.$eval('.chat-canvas-clear', b => !b.hidden).catch(() => false));
  }

  // ── 5 · The CDN blocked for one template: the kit's fallback with the table ──
  await rig.context.route('https://cdn.jsdelivr.net/**', r => r.abort());
  const cut = await showViz(GAS, 'density');
  await rig.context.unroute('https://cdn.jsdelivr.net/**');
  {
    const f = await cut.frame?.evaluate(() => ({ fallback: document.querySelector('.kit-fallback')?.textContent,
      table: document.querySelectorAll('.kit-table tbody tr').length, open: !!document.querySelector('.kit-table')?.offsetParent })).catch(e => ({ e: e.message }));
    check('CDN blocked: "library did not load" with the table open', /library did not load/.test(f?.fallback ?? '') && f.table > 0 && f.open, JSON.stringify(f));
    check('CDN blocked: the result is a failure (the frame posted error, no drawn)', cut.posted.includes('error') && !cut.posted.includes('drawn'), `${cut.posted.join(',')} · status "${cut.status}"`);
    check('CDN blocked: the pane\'s status says the chart library did not load', /chart library did not load/.test(cut.status ?? '') && !/could not start/.test(cut.status ?? ''), String(cut.status));
    if (cut.card) await cardShot(cut.card, 'templates-10-cdn-blocked');
  }

  // ── 3b · A local phrase in the chat, no key: no OpenRouter completion ──
  await openChat(page);
  await page.waitForTimeout(1000);
  const hits0 = rig.hits.length;
  const m0 = (await msgs()).length;
  await page.fill('.chat-input', 'fuel mix in Texas');
  await page.press('.chat-input', 'Enter');
  await page.waitForSelector('#td-ask .chat-canvas[data-template]', { timeout: 60000 }).catch(() => null);
  const end = Date.now() + 30000;
  while (Date.now() < end && !(await msgs()).slice(m0).some(t => t === 'rendered' || t === 'drawn' || t === 'error')) await page.waitForTimeout(250);
  await page.waitForTimeout(500);
  const local = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('#td-ask .chat-chip:not(.chat-code)')].map(x => `${x.dataset.tool}:${x.dataset.source}:${x.dataset.ok}`),
    label: document.querySelector('#td-ask .chat-canvas[data-template] .chat-canvas-label')?.textContent,
    title: document.querySelector('#td-ask .chat-canvas[data-template] .chat-canvas-title')?.textContent,
  }));
  check('"fuel mix in Texas": a local showTemplate chip and a template card in Ask', local.chips.includes('showTemplate:local:true') && local.label === LABEL, JSON.stringify(local));
  check('"fuel mix in Texas": drawn with no OpenRouter request', rig.hits.length === hits0 && (await msgs()).slice(m0).includes('rendered'), rig.hits.slice(hits0).join(' | '));
  await page.$eval('#td-ask .chat-canvas[data-template]', c => c.scrollIntoView({ block: 'nearest' })).catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, 'templates-11-local-phrase');

  // ── 4 · Reload the tab: Visualize and chat template cards come back ──
  const vizBefore = await page.$$eval('.tv-cards > .chat-canvas', cs => cs.map(c => `${c.dataset.kind}:${c.querySelector('.chat-canvas-title')?.textContent}`));
  const linkBefore = await hashOf(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  const hits1 = rig.hits.length;
  await page.reload();
  await ready(page);
  await idle();
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({
    viz: [...document.querySelectorAll('.tv-cards > .chat-canvas')].map(c => ({ kind: c.dataset.kind, title: c.querySelector('.chat-canvas-title')?.textContent,
      restored: c.classList.contains('chat-canvas-restored'), frame: !!c.querySelector('iframe'), rerun: !!c.querySelector('.chat-canvas-rerun') })),
    chat: [...document.querySelectorAll('#td-ask .chat-canvas[data-template]')].map(c => ({ kind: c.dataset.kind, frame: !!c.querySelector('iframe'),
      rerun: !!c.querySelector('.chat-canvas-rerun'), label: c.querySelector('.chat-canvas-label')?.textContent })),
    undo: document.querySelector('[data-action="undo"]')?.disabled,
  }));
  // The snapshot keeps the newest six cards (MAX_VIZ_CARDS); older ones were already Re-run placeholders.
  const sameCards = JSON.stringify(after.viz.map(c => `${c.kind}:${c.title}`)) === JSON.stringify(vizBefore.slice(0, 6));
  check('reload: the newest six Visualize cards come back in order', sameCards && after.viz.length > 0, `${vizBefore.length} → ${after.viz.length}`);
  // A restore redraws Vega cards only into free frame slots (chat first, ≤ 3 live page-wide, no eviction).
  const liveFrames = after.viz.filter(c => c.frame).length + after.chat.filter(c => c.frame).length;
  check('reload: Vega cards redrawn into free frame slots only (≤ 3 live), the rest and html cards as Re-run placeholders',
    liveFrames <= 3 && after.viz.some(c => c.kind === 'vega' && c.frame)
      && after.viz.every(c => c.frame ? c.kind === 'vega' && !c.restored : c.restored && c.rerun),
    `${liveFrames} live · ` + JSON.stringify(after.viz.map(c => `${c.kind}:${c.frame ? 'frame' : ''}${c.rerun ? 'rerun' : ''}`)));
  if (local.label) check('reload: the chat template card comes back (Vega redrawn) labelled as a template', after.chat.length === 1 && after.chat[0].label === LABEL
    && (after.chat[0].kind === 'vega' ? after.chat[0].frame : after.chat[0].rerun), JSON.stringify(after.chat));
  check('reload: no OpenRouter request, link unchanged, Undo disabled', rig.hits.length === hits1 && await hashOf(page) === linkBefore && after.undo === true,
    `${rig.hits.slice(hits1).join(' | ')} · ${await hashOf(page) === linkBefore} · undo ${after.undo}`);
  {
    const ov = await overlayLayer();
    const ppcBack = after.viz.filter(c => /Counties/.test(c.title ?? ''));
    check('reload: the county colours are not repainted; the per-county card is a Re-run placeholder', !(await page.$('#tplCountyLegend')) && (!ov || !ov.layer)
      && ppcBack.length > 0 && ppcBack.every(c => c.restored && c.rerun && !c.frame), `${JSON.stringify(ov)} · ${JSON.stringify(ppcBack)}`);
  }
  await shot(page, 'templates-12-restored-chat');
  if (await page.isVisible('#td-tab-viz')) await page.click('#td-tab-viz');
  await page.waitForTimeout(500);
  await shot(page, 'templates-13-restored-viz');
  const html = await page.$('.tv-cards > .chat-canvas-restored[data-kind="html"]');
  if (html) {
    const m1 = (await msgs()).length;
    await html.$eval('.chat-canvas-rerun', b => b.click());
    const e2 = Date.now() + 60000;
    while (Date.now() < e2 && !(await msgs()).slice(m1).some(t => t === 'drawn' || t === 'error')) await page.waitForTimeout(250);
    check('reload: Re-run draws the html template again', (await msgs()).slice(m1).includes('drawn'), (await msgs()).slice(m1).join(','));
    const live = await page.$('.tv-cards > .chat-canvas[data-kind="html"]:not(.chat-canvas-restored)');
    if (live) await cardShot(live, 'templates-14-rerun');
  }
  check('every openrouter.ai request matched a fixture', rig.unrouted.length === 0, rig.unrouted.join(' | '));
  log('frame console (filtered, expected):', rig.frame.length, rig.frame.map(t => t.slice(0, 120)).join(' | '));
  check('no console errors (the page\'s own)', rig.errors.length === 0, rig.errors.join(' | '));
  await rig.close();

  // ── 3 · A mocked model calls showTemplate ──
  // A model's own canvas posting every action a template may: the page must ignore each.
  const FREE = '<p>free-form</p><script>TM.action("where",{layer:"eia-generators",field:"energy_source",bin:"gas"});'
    + 'TM.action("select",{layer:"eia-generators",ids:["1:1"]});TM.action("fly",{bbox:[-100,30,-99,31]});TM.action("table",{layer:"eia-generators"});</script>';
  let hint = '';
  const chat = await chatRig(ctx, body => {
    const ms = body?.messages ?? [];
    const u = ms.map(m => m.role).lastIndexOf('user');
    const text = String(ms[u]?.content ?? '').toLowerCase();
    const tools = ms.slice(u + 1).filter(m => m.role === 'tool');
    if (text.includes('fleet look like')) {
      if (tools.length === 0) return { tool_calls: [call('t1', 'showTemplate', { template: 'composition', layer: GEN, by: 'energy_source', measure: 'nameplate_mw' })] };
      if (tools.length === 1) return { content: 'Gas leads; the card is above.' };
    }
    if (text.includes('free-form')) {
      if (tools.length === 0) return { tool_calls: [call('t9', 'showCanvas', { title: 'Free-form', html: FREE })] };
      if (tools.length === 1) return { content: 'Drawn.' };
    }
    if (text.includes('vintages')) {
      if (tools.length === 0) return { tool_calls: [call('t2', 'showTemplate', { template: 'timeline', layer: GEN, time: 'energy_source' })] };
      if (tools.length === 1) { hint = tools[0].content; return { tool_calls: [call('t3', 'showTemplate', { template: 'timeline', layer: GEN, time: 'op_year', by: 'energy_source' })] }; }
      if (tools.length === 2) return { content: 'Here it is by opening year.' };
    }
    return null;
  }, { init: taps, cam: TX_CAM });
  {
    const p = chat.page;
    await chat.say('what does the fleet look like?');
    const t1 = chat.toolMsgs().get('t1') ?? '';
    const d1 = (() => { try { return JSON.parse(t1).data; } catch { return null; } })();
    check('model showTemplate: a done chip and a template card in Ask', await p.$$eval('#td-ask .chat-chip:not(.chat-code)[data-tool="showTemplate"]', cs => cs.map(c => c.dataset.ok).join()) === 'true'
      && await p.$eval('#td-ask .chat-canvas[data-template] .chat-canvas-label', e => e.textContent).catch(() => '') === LABEL);
    check('model showTemplate: the tool message is the page summary only, ≤ 1 KB', !!d1 && d1.shown === true && typeof d1.summary === 'object' && Buffer.byteLength(t1) <= 1024
      && Object.keys(d1).every(k => ['shown', 'template', 'layer', 'scope', 'complete', 'partial', 'truncated', 'tiersHidden', 'summary'].includes(k))
      && !/rows|<|html|TM_INPUT|"values"|\$schema|kit/i.test(t1), `${Buffer.byteLength(t1)} B: ${t1.slice(0, 300)}`);
    await p.$eval('#td-ask .chat-canvas[data-template]', c => c.scrollIntoView({ block: 'nearest' })).catch(() => {});
    await p.waitForTimeout(800);
    await shot(p, 'templates-15-model-card');
    await chat.say('how did vintages change over the decades?');
    check('a wrong-role field is refused with the valid fields named (the hint reaches the model)', /"error"/.test(hint) && /op_year/.test(hint), hint.slice(0, 300));
    const d3 = (() => { try { return JSON.parse(chat.toolMsgs().get('t3') ?? '').data; } catch { return null; } })();
    check('the model\'s fixed call shows the timeline', d3?.shown === true && d3.template === 'timeline', JSON.stringify(d3)?.slice(0, 200));
    const chips = await p.$$eval('#td-ask .chat-chip:not(.chat-code)[data-tool="showTemplate"]', cs => cs.map(c => c.dataset.ok).join());
    check('chips: done, failed (with its reason), done', chips === 'true,false,true', chips);
    await p.$$eval('#td-ask .chat-canvas[data-template]', cs => cs.at(-1)?.scrollIntoView({ block: 'nearest' }));
    await p.waitForTimeout(800);
    await shot(p, 'templates-16-model-refusal-fixed');
    // Reload this tab: the chat's template cards come back (Vega redrawn), with a Visualize card beside them.
    await p.click('#toolsMenuBtn');
    await p.click('[data-action="open-visualize"]');
    await p.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
    await p.selectOption('.tv-layer', GAS);
    await p.click('.tv-card[data-template="ranking"]');
    await p.click('.tv-show');
    await p.waitForSelector('.tv-cards > .chat-canvas iframe', { timeout: 30000 });
    await p.waitForTimeout(2500);
    const link = await hashOf(p);
    const before = await p.$$eval('#td-ask .chat-canvas[data-template] .chat-canvas-title', ts => ts.map(t => t.textContent));
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
    const h0 = chat.hits.length;
    await p.reload();
    await ready(p);
    await settle(p);
    if (await p.isVisible('#td-tab-ask')) await p.click('#td-tab-ask');
    await p.waitForTimeout(6000);
    const back = await p.evaluate(() => ({
      cards: [...document.querySelectorAll('#td-ask .chat-canvas[data-template]')].map(c => ({ title: c.querySelector('.chat-canvas-title')?.textContent, kind: c.dataset.kind,
        label: c.querySelector('.chat-canvas-label')?.textContent, frame: !!c.querySelector('iframe'), restored: c.classList.contains('chat-canvas-restored') })),
      viz: [...document.querySelectorAll('.tv-cards > .chat-canvas')].map(c => `${c.dataset.kind}:${c.querySelector('iframe') ? 'frame' : 'placeholder'}`),
      undo: document.querySelector('[data-action="undo"]')?.disabled,
    }));
    check('reload: the chat\'s template cards come back, Vega ones redrawn, labelled as templates', JSON.stringify(back.cards.map(c => c.title)) === JSON.stringify(before)
      && back.cards.length === 2 && back.cards.every(c => c.kind === 'vega' && c.frame && !c.restored && c.label === LABEL), JSON.stringify(back.cards));
    check('reload: the Visualize card comes back too', back.viz.length === 1 && back.viz[0] === 'vega:frame', back.viz.join(','));
    check('reload: no OpenRouter request, link unchanged, Undo disabled', chat.hits.length === h0 && await hashOf(p) === link && back.undo === true,
      `${chat.hits.slice(h0).join(' | ')} · link ${await hashOf(p) === link} · undo ${back.undo}`);
    await p.$$eval('#td-ask .chat-canvas[data-template]', cs => cs.at(-1)?.scrollIntoView({ block: 'nearest' }));
    await p.waitForTimeout(600);
    await shot(p, 'templates-17-model-cards-restored');
    const all = [...chat.toolMsgs().values()];
    check('every tool message ≤ 1 KB', all.every(m => Buffer.byteLength(m) <= 1024), all.map(m => Buffer.byteLength(m)).join(','));
    check('every request asks the default model, anthropic/claude-haiku-5.5', chat.models.length === 0 && chat.bodies.length === 5, `${chat.bodies.length} requests ${chat.models.join(',')}`);
    check('every openrouter.ai request matched a fixture (model chat)', chat.unrouted.length === 0, chat.unrouted.join(' | '));
    // A free-form showCanvas frame posting TM.action: nothing happens (no where, selection, camera move, table or toast).
    {
      const L0 = await hashOf(p);
      const s0 = PREVIEW ? null : await st(p, 'JSON.stringify([state.where, state.sel])');
      const m0 = await p.evaluate(() => window.__tmMsgs.length);
      // The reload above dropped the key (Remember was off): connect it again.
      if (!await p.isVisible('.chat-key-input')) await p.click('.chat-key-btn');
      await p.fill('.chat-key-input', 'sk-or-v1-' + 'ef'.repeat(32));
      await p.click('.chat-connect');
      await chat.say('draw a free-form canvas');
      const end = Date.now() + 30000;
      while (Date.now() < end && !(await p.evaluate(m => window.__tmMsgs.slice(m), m0)).includes('action')) await p.waitForTimeout(250);
      await p.waitForTimeout(2000);
      const posted = await p.evaluate(m => window.__tmMsgs.slice(m), m0);
      const s1 = PREVIEW ? null : await st(p, 'JSON.stringify([state.where, state.sel])');
      const tableOpen = await p.$eval('#td-tab', b => b.getAttribute('aria-selected') === 'true').catch(() => false);
      check('a free-form showCanvas frame posting TM.action (where, select, fly, table) changes nothing: link, state, camera, table, toast',
        posted.filter(t => t === 'action').length === 4 && await hashOf(p) === L0 && s1 === s0 && !(await toastText(p)) && !tableOpen,
        `${posted.join(',')} · link ${await hashOf(p) === L0} · state ${s1 === s0} · toast ${await toastText(p)} · table ${tableOpen}`);
      await p.$$eval('#td-ask .chat-canvas', cs => cs.at(-1)?.scrollIntoView({ block: 'nearest' }));
      await p.waitForTimeout(400);
      await shot(p, 'templates-17b-free-form-ignored');
    }
    log('frame console (filtered, expected):', chat.frame.length, chat.frame.map(t => t.slice(0, 120)).join(' | '));
    check('no console errors (the page\'s own, model chat)', chat.errors.length === 0, chat.errors.join(' | '));
    await chat.close();
  }

  // ── 6 · Phone 390×844, touch ──
  const ph = await chatRig(ctx, () => null, { chat: false, init: taps, cam: TX_CAM, viewport: { width: 390, height: 844 },
    contextOptions: { deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  {
    const p = ph.page;
    if (await p.isVisible('#layersToggleBtn')) await p.click('#layersToggleBtn');
    await p.waitForTimeout(600);
    for (const id of [OSMTX, GEN]) {
      await p.evaluate(i => document.querySelector(`[data-layer-id="${i}"]`)?.closest('.layer-section.collapsed')?.querySelector('.collapse-btn')?.click(), id);
    }
    await p.waitForTimeout(600);
    const rows = await p.evaluate(() => {
      const names = [...document.querySelectorAll('.layer-name')].filter(e => e.offsetParent && e.getBoundingClientRect().top < innerHeight);
      const btns = [...document.querySelectorAll('.layer-row')].filter(r => r.offsetParent)
        .map(r => [...r.querySelectorAll('button')].filter(b => !b.closest('.layer-menu') && b.checkVisibility()).length);
      const viz = btns.filter(n => n > 1).length;
      return { n: names.length, narrow: names.filter(e => e.clientWidth < 120 && e.scrollWidth > e.clientWidth + 1).map(e => `${e.textContent}:${e.clientWidth}`), viz };
    });
    check('phone: layer names visible in the layer panel, each row one ⋯ menu button', rows.n >= 5 && rows.narrow.length === 0 && rows.viz === 0, JSON.stringify(rows));
    await shot(p, 'templates-18-phone-layers');
    if (await p.isVisible('#closeLayers')) await p.click('#closeLayers');
    await p.click('#toolsMenuBtn');
    await p.click('[data-action="open-visualize"]');
    await p.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
    await p.selectOption('.tv-layer', GAS);
    await p.click('.tv-card[data-template="composition"]');
    const ms0 = await p.evaluate(() => window.__tmMsgs.length);
    await p.click('.tv-show');
    const e3 = Date.now() + 60000;
    while (Date.now() < e3 && !(await p.evaluate(m => window.__tmMsgs.slice(m), ms0)).some(t => t === 'rendered' || t === 'error')) await p.waitForTimeout(250);
    await p.waitForTimeout(800);
    const geo = await p.evaluate(() => {
      const side = document.querySelector('.tv-side').getBoundingClientRect(), cards = document.querySelector('.tv-cards').getBoundingClientRect();
      const card = document.querySelector('.tv-cards > .chat-canvas')?.getBoundingClientRect();
      return { side: [Math.round(side.left), Math.round(side.width)], cards: [Math.round(cards.left), Math.round(cards.top), Math.round(cards.width)], sideBottom: Math.round(side.bottom),
        card: card && [Math.round(card.left), Math.round(card.right)], scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, w: innerWidth };
    });
    check('phone: Visualize is one column (the form over the cards)', geo.cards[1] >= geo.sideBottom - 1 && geo.cards[2] > 300, JSON.stringify(geo));
    check('phone: the template card fits the width', !!geo.card && geo.card[0] >= 0 && geo.card[1] <= geo.w, JSON.stringify(geo.card));
    const sx = await p.evaluate(() => { scrollTo(200, scrollY); const x = scrollX; scrollTo(0, scrollY); return x; });
    check('phone: no page horizontal scroll', geo.scroll <= geo.w && sx === 0, `scrollWidth ${geo.scroll} vs ${geo.w}, scrollX after scrollTo(200) ${sx}`);
    const info = await ph.page.evaluate(() => { const r = document.getElementById('infoButton')?.getBoundingClientRect(); return r ? Math.round(r.right) : null; });
    check('phone: the top bar fits (body.scrollWidth ≤ the window, the info button in view)', geo.body <= geo.w && info !== null && info <= geo.w, `body.scrollWidth ${geo.body} vs ${geo.w}, info button right ${info}`);
    await ph.page.screenshot({ path: path.join(OUT, 'templates-20-phone-header.png'), clip: { x: 0, y: 0, width: geo.w, height: 120 } });
    await p.$eval('.tv-cards > .chat-canvas', c => c.scrollIntoView({ block: 'nearest' })).catch(() => {});
    await p.waitForTimeout(400);
    await shot(p, 'templates-19-phone-card');
    check('no console errors (the page\'s own, phone)', ph.errors.length === 0, ph.errors.join(' | '));
    await ph.close();
  }
}

// Part 2 (spread): compare-regions, distribution and timeline by month, GeoJSON and tiled, their
// actions and downloads, the gallery's split / layer2 / where2 / within form, a reload, a phone.
async function templatesSpread(ctx) {
  const { GEN, SUBS, GAS, OGF, OSMTX, LABEL, TX_CAM, taps, rig, page, msgs, idle, openViz, frameOf, showViz, ink, pixels, snap, diff, MOVED, STILL, toastText, waitToast, clearToast, undoToast, params, camOf, live, inFrame, findPixel, menuItems, cardShot, dl, csvChecks, pngChecks, pngInk, kitChecks, vegaDownloads, cardOk, pixelAt, SAT, clickAct, undoCheck } = await templateKit(ctx);
  const SUBS2 = 'hifld-substations', DCM = 'dc-moratoriums', OSMTX2 = 'osm-transmission-lines';
  await openViz();

  // compare-regions, GeoJSON: HIFLD substations by voltage, split by state (the 6 largest).
  const cr = await showViz(SUBS2, 'compare-regions');
  cardOk('compare-regions (HIFLD substations)', cr, 'rendered');
  check('compare-regions: inked', (await ink(cr.frame)) > 3000, String(await ink(cr.frame)));
  await cardShot(cr.card, 'templates-s-1-compare-hifld');
  await vegaDownloads('compare-regions', cr.card, 'templates-s-compare');
  {
    // A panel bar (a kV colour, below the region bars) → where on max_kv.
    const a = await clickAct(cr.card, cr.frame, SAT + ' && !(Math.abs(r - 96) < 20 && Math.abs(g - 134) < 20 && Math.abs(b - 176) < 20)', 0.45, 0.95, 'compare-regions panel bar', 'max_kv');
    if (a) { await shot(page, 'templates-s-1b-compare-bar-filtered'); await cardShot(cr.card, 'templates-s-1c-compare-bar-picked'); await undoCheck('compare-regions panel bar', a.L0); }
    await page.waitForTimeout(700);
    // A region bar (the blue of the top view) → where states contains_any.
    const b = await clickAct(cr.card, cr.frame, 'Math.abs(r - 96) < 26 && Math.abs(g - 134) < 26 && Math.abs(b - 176) < 26', 0.12, 0.4, 'compare-regions region bar', 'states');
    if (b) { check('compare-regions region bar: contains_any on states', /"states","op":"contains_any"/.test(b.where ?? '') || PREVIEW, b.where); await undoCheck('compare-regions region bar', b.L0); }
  }
  // The share view.
  await cr.frame.selectOption('select', 'share').catch(() => {});
  await page.waitForTimeout(500);
  await cardShot(cr.card, 'templates-s-1d-compare-share');

  // compare-regions with an Area of three states (dev): the panels are those states.
  if (!PREVIEW) {
    await mod(page, '/assets/ui/panel-mirror.ts', m => m.commitArea({ kind: 'states', codes: ['TX', 'CA', 'NY'] }));
    await page.waitForTimeout(500);
    const cr3 = await showViz(SUBS2, 'compare-regions');
    const regions = await cr3.frame.evaluate(() => [...document.querySelectorAll('svg text, text')].length).catch(() => 0);
    cardOk('compare-regions TX/CA/NY', cr3, 'rendered');
    const panels = await live(`null`);
    check('compare-regions TX/CA/NY: inked', (await ink(cr3.frame)) > 2000, String(await ink(cr3.frame)) + ' ' + String(regions) + String(panels ?? ''));
    await cardShot(cr3.card, 'templates-s-2-compare-tx-ca-ny');
    await mod(page, '/assets/ui/panel-mirror.ts', m => m.commitArea(null));
    await page.waitForTimeout(500);
  }

  // distribution, GeoJSON: EIA nameplate MW (log bins), ECDF toggle, a bar → range where.
  const ds = await showViz('eia-generators', 'distribution', { measure: 'nameplate_mw' });
  cardOk('distribution (EIA MW)', ds, 'rendered');
  check('distribution: inked', (await ink(ds.frame)) > 2000, String(await ink(ds.frame)));
  await cardShot(ds.card, 'templates-s-3-distribution-eia');
  await vegaDownloads('distribution', ds.card, 'templates-s-dist');
  {
    const a = await clickAct(ds.card, ds.frame, 'Math.abs(r - 78) < 20 && Math.abs(g - 121) < 20 && Math.abs(b - 167) < 20', 0.3, 0.85, 'distribution bar', 'nameplate_mw');
    if (a) {
      const w = PREVIEW ? null : JSON.parse(a.where ?? '{}')['eia-generators'];
      check('distribution bar: two page-built conditions on nameplate_mw (>= lo, < hi)', PREVIEW || (Array.isArray(w) && w.length === 2 && w[0].op === '>=' && w[1].op === '<' && w[0].value < w[1].value), JSON.stringify(w));
      await shot(page, 'templates-s-3b-distribution-filtered');
      await undoCheck('distribution bar', a.L0);
    }
    await snap(ds.frame);
    await ds.frame.selectOption('select', 'ecdf').catch(() => {});
    await page.waitForTimeout(600);
    check('distribution: the Cumulative share view redraws', (await diff(ds.frame)) > MOVED, String(await diff(ds.frame)));
    await cardShot(ds.card, 'templates-s-3c-distribution-ecdf');
  }

  // timeline by month, GeoJSON: data center moratoriums (last_event), a month bar → date-range where.
  const tm = await showViz(DCM, 'timeline');
  cardOk('timeline by month (moratoriums)', tm, 'rendered');
  check('timeline by month: inked', (await ink(tm.frame)) > 1500, String(await ink(tm.frame)));
  const sel = await tm.frame.$$eval('select option', os => os.map(o => o.textContent)).catch(() => []);
  check('timeline by month: view Per month / Cumulative, no year sliders', JSON.stringify(sel) === JSON.stringify(['Per month', 'Cumulative']) && !(await tm.frame.$('input[type=range]')), JSON.stringify(sel));
  await cardShot(tm.card, 'templates-s-4-timeline-months');
  await vegaDownloads('timeline by month', tm.card, 'templates-s-tl');
  {
    const a = await clickAct(tm.card, tm.frame, SAT, 0.3, 0.9, 'timeline month bar', 'last_event', 0.5, 0.98);
    if (a) {
      const w = PREVIEW ? null : JSON.parse(a.where ?? '{}')[DCM];
      check('timeline month bar: last_event >= YYYY-MM-01 and <= YYYY-MM-31', PREVIEW || (Array.isArray(w) && w.length === 2 && /-01$/.test(w[0].value) && /-31$/.test(w[1].value)), JSON.stringify(w));
      await shot(page, 'templates-s-4b-timeline-month-filtered');
      await undoCheck('timeline month bar', a.L0);
    }
    await snap(tm.frame);
    await tm.frame.selectOption('select', 'cum').catch(() => {});
    await page.waitForTimeout(600);
    check('timeline by month: Cumulative redraws', (await diff(tm.frame)) > MOVED, String(await diff(tm.frame)));
    await cardShot(tm.card, 'templates-s-4c-timeline-months-cum');
  }

  // Tiled: OSM transmission lines in the current view (switched on), compare-regions and distribution.
  await page.evaluate(h => { location.hash = h; }, '#7/31.0/-97.0' + (params(await hashOf(page)) ? '?' + params(await hashOf(page)) : ''));
  await page.waitForTimeout(1500);
  await idle();
  await page.selectOption('.tv-layer', OSMTX2);
  await page.click('.tv-card[data-template="compare-regions"]');
  if (await page.isVisible('.tv-switch-on')) { await page.click('.tv-switch-on'); await page.waitForTimeout(2500); await idle(); }
  const crt = await showViz(OSMTX2, 'compare-regions');
  cardOk('compare-regions (OSM lines, current view)', crt, 'rendered');
  check('compare-regions tiled: inked', (await ink(crt.frame)) > 2000, String(await ink(crt.frame)));
  await cardShot(crt.card, 'templates-s-5-compare-osm-view');
  await page.waitForTimeout(700);
  {
    const a = await clickAct(crt.card, crt.frame, SAT + ' && !(Math.abs(r - 96) < 20 && Math.abs(g - 134) < 20 && Math.abs(b - 176) < 20)', 0.45, 0.95, 'compare-regions tiled panel bar', 'nominal_kv');
    if (a) await undoCheck('compare-regions tiled panel bar', a.L0);
  }
  const dst = await showViz(OSMTX2, 'distribution', { measure: 'length_km' });
  cardOk('distribution (OSM line length, current view)', dst, 'rendered');
  check('distribution tiled: inked', (await ink(dst.frame)) > 1500, String(await ink(dst.frame)));
  await cardShot(dst.card, 'templates-s-6-distribution-osm-length');
  {
    await clearToast();
    const L0 = await hashOf(page);
    const at = await pixelAt(dst.card, dst.frame, 'Math.abs(r - 78) < 20 && Math.abs(g - 121) < 20 && Math.abs(b - 167) < 20', 0.3, 0.85);
    if (at) await page.mouse.click(at[0], at[1]);
    await page.waitForTimeout(1200);
    check('distribution over length: a bar click changes nothing (no field to filter on), and the card says so', !!at && params(await hashOf(page)) === params(L0) && !(await toastText()), String(at));
  }
  const dsk = await showViz(OSMTX2, 'distribution', { measure: 'nominal_kv' });
  cardOk('distribution (OSM kV, current view)', dsk, 'rendered');
  await cardShot(dsk.card, 'templates-s-7-distribution-osm-kv');
  {
    const a = await clickAct(dsk.card, dsk.frame, 'Math.abs(r - 78) < 20 && Math.abs(g - 121) < 20 && Math.abs(b - 167) < 20', 0.3, 0.85, 'distribution kV bar (tiled)', 'nominal_kv');
    if (a) await undoCheck('distribution kV bar (tiled)', a.L0);
  }

  // ── The gallery's form: split never by's field; nearest's layer2, one where2 condition, within ──
  {
    await page.selectOption('.tv-layer', GEN);
    await page.click('.tv-card[data-template="flow"]');
    const by = await page.$eval('.tv-by', s => s.value);
    const splits = await page.$$eval('.tv-split option', os => os.map(o => o.value));
    await page.selectOption('.tv-by', splits[0]);
    const splits2 = await page.$$eval('.tv-split option', os => os.map(o => o.value));
    check('form flow: split offers the fields other than by, and follows a by change', splits.length > 0 && !splits.includes(by)
      && !splits2.includes(splits[0]) && splits2.includes(by), `${by}: ${splits.join(',')} · ${splits[0]}: ${splits2.join(',')}`);
    await page.selectOption('.tv-layer', 'osm-datacenters');
    if (!NEAREST_READY) {
      await page.waitForTimeout(300);
      await page.waitForSelector('.tv-card[data-template="points-per-polygon"]', { timeout: 5000 }).catch(() => {});
      const cards = await page.$$eval('.tv-card', cs => cs.map(c => c.dataset.template));
      check('the gallery offers points-per-polygon but no nearest card (ready: false)', cards.includes('points-per-polygon') && !cards.includes('nearest'), cards.join(','));
    } else {
      await page.selectOption('.tv-layer', 'osm-datacenters');
      await page.click('.tv-card[data-template="nearest"]');
      const l2 = await page.$eval('.tv-layer2', s => s.value);
      const noMeasure = !(await page.$('.tv-measure')) && !(await page.$('.tv-top'));
      await page.selectOption('.tv-cond-field', 'max_kv');
      await page.selectOption('.tv-cond-op', '>=');
      const set = (sel, v) => page.$eval(sel, (e, x) => { e.value = x; e.dispatchEvent(new Event('change')); }, v);
      await set('.tv-cond-value', '230');
      const unit = await page.$eval('.tv-within', e => e.closest('label').textContent);
      await set('.tv-within', '5');
      await page.$eval('.tv-form', f => f.scrollIntoView({ block: 'end' }));
      await shot(page, 'templates-w10-nearest-form');
      const nf = await showViz(null, 'nearest');
      cardOk('nearest from the form (≥ 230 kV, 5 mi)', nf, 'drawn');
      const p2 = await nf.frame?.evaluate(() => ({ layer2: TM_INPUT.second?.layer, within: TM_INPUT.params.within, n2: TM_INPUT.second?.features.length })).catch(e => ({ e: e.message }));
      check('form nearest: HIFLD substations by default, no measure or top, within in the visitor\'s unit sent as km',
        l2 === SUBS && noMeasure && /\(mi\)/.test(unit) && p2?.layer2 === SUBS && Math.abs(p2.within - 8.05) < 0.01, `${l2} · ${unit} · ${JSON.stringify(p2)}`);
      await cardShot(nf.card, 'templates-w10-nearest-from-form');
    }
    // A world OSM layer by US states (the admin1 alias): the frame outlines the states.
    const ps = await showViz('osm-plants-points', 'points-per-polygon', { by: 'states' });
    cardOk('per state (OSM power plants, the states alias)', ps, 'drawn');
    const f = await ps.frame?.evaluate(() => ({ features: (TM_INPUT.features || []).length, rows: document.querySelectorAll('.ppp-row').length })).catch(e => ({ e: e.message }));
    check('per state on a world layer: ≥ 40 state outlines', f?.features >= 40 && f.rows >= 5, JSON.stringify(f));
    await cardShot(ps.card, 'templates-w10-per-state-osm');
    // The CDN blocked for a flow card: the kit's fallback with the table open.
    await rig.context.route('https://cdn.jsdelivr.net/**', r => r.abort());
    const cut = await showViz(GEN, 'flow');
    await rig.context.unroute('https://cdn.jsdelivr.net/**');
    const fb = await cut.frame?.evaluate(() => ({ fallback: document.querySelector('.kit-fallback')?.textContent,
      table: document.querySelectorAll('.kit-table tbody tr').length, open: !!document.querySelector('.kit-table')?.offsetParent })).catch(e => ({ e: e.message }));
    check('CDN blocked (flow): "library did not load" with the table open, no drawn', /library did not load/.test(fb?.fallback ?? '') && fb.table > 0 && fb.open
      && cut.posted.includes('error') && !cut.posted.includes('drawn'), `${JSON.stringify(fb)} · ${cut.posted.join(',')}`);
    if (cut.card) await cardShot(cut.card, 'templates-w10-flow-cdn-blocked');
  }

  // Reload: Vega cards come back into free frame slots (≤ 3 live), the rest as Re-run.
  const before = await page.$$eval('.tv-cards > .chat-canvas', cs => cs.map(c => c.querySelector('.chat-canvas-title')?.textContent));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  await page.reload();
  await ready(page);
  await idle();
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => [...document.querySelectorAll('.tv-cards > .chat-canvas')].map(c => ({ title: c.querySelector('.chat-canvas-title')?.textContent, frame: !!c.querySelector('iframe'), rerun: !!c.querySelector('.chat-canvas-rerun') })));
  check('reload: the newest six cards come back in order, ≤ 3 redrawn, the rest Re-run', JSON.stringify(after.map(c => c.title)) === JSON.stringify(before.slice(0, 6))
    && after.filter(c => c.frame).length <= 3 && after.filter(c => c.frame).length >= 1 && after.every(c => c.frame || c.rerun), JSON.stringify(after));
  await shot(page, 'templates-s-8-after-reload');
  const rr = await page.$('.tv-cards > .chat-canvas .chat-canvas-rerun');
  if (rr) {
    const m1 = (await msgs()).length;
    await rr.evaluate(b => b.closest('.chat-canvas').scrollIntoView({ block: 'start' }));
    await rr.click();
    const end = Date.now() + 30000;
    while (Date.now() < end && !(await msgs()).slice(m1).includes('rendered')) await page.waitForTimeout(250);
    check('reload: Re-run draws a restored card again', (await msgs()).slice(m1).includes('rendered'), (await msgs()).slice(m1).join(','));
  }
  check('no console errors (the page\'s own)', rig.errors.length === 0, rig.errors.join(' | '));

  // Phone 390×844: compare-regions one panel per row; distribution full width.
  const ph = await chatRig(ctx, () => null, { chat: false, init: taps, cam: TX_CAM, viewport: { width: 390, height: 844 }, contextOptions: { deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  {
    const p = ph.page;
    if (await p.isVisible('#closeLayers')) await p.click('#closeLayers');
    await p.click('#toolsMenuBtn');
    await p.click('[data-action="open-visualize"]');
    await p.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
    for (const [tpl, lyr, measure, name] of [['compare-regions', SUBS2, null, 'templates-s-9-phone-compare'], ['distribution', 'eia-generators', 'nameplate_mw', 'templates-s-10-phone-distribution'], ['timeline', DCM, null, 'templates-s-11-phone-timeline']]) {
      await p.selectOption('.tv-layer', lyr);
      await p.waitForTimeout(300);
      await p.$eval(`.tv-card[data-template="${tpl}"]`, b => { b.scrollIntoView({ block: 'center' }); b.click(); });
      await p.waitForTimeout(300);
      check(`phone ${tpl}: picked in the gallery`, await p.$eval(`.tv-card[data-template="${tpl}"]`, b => b.getAttribute('aria-pressed')) === 'true');
      if (measure) await p.selectOption('.tv-measure', measure);
      const ms0 = await p.evaluate(() => window.__tmMsgs.length);
      await p.$eval('.tv-show', b => { b.scrollIntoView({ block: 'center' }); b.click(); });
      const e3 = Date.now() + 60000;
      while (Date.now() < e3 && !(await p.evaluate(m => window.__tmMsgs.slice(m), ms0)).some(t => t === 'rendered' || t === 'error')) await p.waitForTimeout(250);
      await p.waitForTimeout(800);
      const geo = await p.evaluate(() => {
        const card = document.querySelector('.tv-cards > .chat-canvas')?.getBoundingClientRect();
        const fr = document.querySelector('.tv-cards > .chat-canvas iframe')?.getBoundingClientRect();
        return { card: card && [Math.round(card.left), Math.round(card.right)], frame: fr && [Math.round(fr.width), Math.round(fr.height)], scroll: document.documentElement.scrollWidth, w: innerWidth };
      });
      const posted = (await p.evaluate(m => window.__tmMsgs.slice(m), ms0));
      check(`phone ${tpl}: rendered, the card fits 390 px, no page horizontal scroll`, posted.includes('rendered') && !!geo.card && geo.card[0] >= 0 && geo.card[1] <= geo.w && geo.scroll <= geo.w, JSON.stringify(geo) + ' ' + posted.join(','));
      if (tpl === 'compare-regions') {
        const f = await (await p.$('.tv-cards > .chat-canvas iframe')).contentFrame();
        const wide = await f.evaluate(() => { const c = document.querySelector('canvas'); return c ? Math.round(c.getBoundingClientRect().width) : 0; });
        check('phone compare-regions: the chart fits its frame (one panel per row)', wide > 0 && wide <= geo.frame[0] + 2, `${wide} vs frame ${geo.frame}`);
      }
      await p.$eval('.tv-cards > .chat-canvas', c => c.scrollIntoView({ block: 'start' })).catch(() => {});
      await p.waitForTimeout(500);
      await shot(p, name);
      await p.$eval('.tv-cards > .chat-canvas iframe', f => f.scrollIntoView({ block: 'start' })).catch(() => {});
      await p.waitForTimeout(400);
      await (await p.$('.tv-cards > .chat-canvas iframe'))?.screenshot({ path: path.join(OUT, name + '-frame.png') });
    }
    check('no console errors (the page\'s own, phone)', ph.errors.length === 0, ph.errors.join(' | '));
    await ph.close();
  }
}

// Part 3 (flows): flow, nearest and buildout-map, their actions and downloads, a reload (html cards
// come back as Re-run), reduced motion, the chat's tiled-layer2 refusal and numbers-only summary, a phone.
async function templatesFlows(ctx) {
  const { GEN, SUBS, GAS, OGF, OSMTX, LABEL, TX_CAM, taps, rig, page, msgs, idle, openViz, frameOf, showViz, ink, pixels, snap, diff, MOVED, STILL, toastText, waitToast, clearToast, undoToast, params, camOf, live, inFrame, findPixel, menuItems, cardShot, dl, csvChecks, pngChecks, pngInk, kitChecks, vegaDownloads, cardOk, pixelAt, SAT, clickAct, undoCheck } = await templateKit(ctx);
  const DCM = 'dc-moratoriums';
  await openViz();
  const want = k => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
  page.on('crash', () => log('PAGE CRASHED'));
  page.on('framedetached', f => log('frame detached ' + f.url().slice(0, 60)));
  const txt = s => String(s ?? '').replace(/ /g, ' ');

  // ── flow: EIA fuel → states, HIFLD kV → states ──
  for (const [lyr, tag] of want('flow') ? [[GEN, 'eia'], [SUBS, 'subs']] : []) {
    const f = await showViz(lyr, 'flow');
    cardOk(`flow (${lyr})`, f, 'drawn');
    const n = await f.frame.evaluate(() => ({ nodes: document.querySelectorAll('.fl-node').length, links: document.querySelectorAll('.fl-link').length,
      names: [...document.querySelectorAll('.fl-node text')].slice(0, 6).map(t => t.firstChild.nodeValue) })).catch(e => ({ e: e.message }));
    check(`flow ${lyr}: a sankey of 3–40 nodes with links`, n.nodes > 2 && n.nodes <= 40 && n.links > 0, JSON.stringify(n));
    await cardShot(f.card, `templates-f-1-flow-${tag}`);
    if (tag !== 'eia') continue;
    await f.card.evaluate(c => c.scrollIntoView({ block: 'start' }));
    await f.frame.hover('.fl-node >> nth=0');
    await page.waitForTimeout(300);
    const op = await f.frame.$$eval('.fl-link', ls => ls.map(l => l.getAttribute('stroke-opacity')));
    check('flow: hovering a node lights its links and dims the rest', op.includes('0.72') && op.includes('0.07') && !op.includes('0.42'), [...new Set(op)].join(','));
    await cardShot(f.card, 'templates-f-1b-flow-hover');
    await clearToast();
    const L0 = await hashOf(page);
    await f.frame.click('.fl-node >> nth=0');
    await page.waitForTimeout(200);
    const items = await menuItems(f.frame);
    await f.frame.click('.kit-menu button >> nth=0');
    const t1 = await waitToast(4000);
    const w1 = await live('JSON.stringify(state.where)');
    check('flow: a node → "Show only this" → the map filters (toast with Undo; where on energy_source)', /the map shows only .+Undo/.test(t1 ?? '') && (PREVIEW || (w1 ?? '').includes('"energy_source"')) && params(await hashOf(page)) !== params(L0),
      `${items.join(' / ')} · ${t1} · ${w1}`);
    await shot(page, 'templates-f-1c-flow-filtered');
    await undoCheck('flow node', L0);
    const { png } = await kitChecks('flow', f.card, f.frame, 'templates-f-flow');
    if (png) { const k = await pngInk(png); check('flow PNG: the sankey is in it (not blank)', k.off > 2000, JSON.stringify(k)); }
  }

  // ── nearest: OSM data centers → HIFLD substations; EIA generators → HIFLD substations ──
  if (NEAREST_READY && want('neardc')) {
  const nr = await showViz('osm-datacenters', 'nearest');
  cardOk('nearest (OSM data centers → HIFLD substations)', nr, 'drawn');
  check('nearest: the map is inked', (await ink(nr.frame)) > 3000, String(await ink(nr.frame)));
  const scopeLine = await nr.frame.evaluate(() => document.querySelector('.kit-scope')?.textContent ?? '');
  check('nearest: beside US-only HIFLD the data centers are read in the US, and the scope line says so', /United States/.test(scopeLine), scopeLine);
  {
    const read = () => nr.frame.evaluate(() => ({ counts: document.querySelector('.nr-row.nr-stat')?.textContent, btn: [...document.querySelectorAll('.nr-side .kit-btn')].map(b => [b.textContent, b.disabled]).find(x => /beyond/i.test(x[0])),
      ecdf: document.querySelectorAll('.nr-side svg path').length, value: document.querySelector('.nr-row input[type=range]')?.value, max: document.querySelector('.nr-row input[type=range]')?.max }));
    const a = await read();
    await cardShot(nr.card, 'templates-f-2-nearest-dc');
    // The threshold from the far end down, until the counts differ from the start and the points beyond it can be selected (1–500).
    await nr.frame.evaluate(() => {
      const r = document.querySelector('.nr-row input[type=range]');
      const btn = () => [...document.querySelectorAll('.nr-side .kit-btn')].find(x => /beyond/i.test(x.textContent));
      const stat = () => document.querySelector('.nr-row.nr-stat')?.textContent, start = stat();
      for (let v = Number(r.max); v >= 0; v -= 5) { r.value = String(v); r.dispatchEvent(new Event('input')); if (!btn().disabled && stat() !== start) break; }
    });
    await page.waitForTimeout(400);
    const b = await read();
    check('nearest: the threshold slider changes the within / beyond counts', !!a.counts && a.counts !== b.counts && a.ecdf === 1, `${txt(a.counts)} → ${txt(b.counts)} (slider ${a.value} → ${b.value} of ${a.max})`);
    await cardShot(nr.card, 'templates-f-2b-nearest-threshold');
    if (b.btn && !b.btn[1]) {
      await clearToast();
      const L0 = await hashOf(page);
      await nr.frame.click('.nr-side .kit-btn:has-text("beyond")');
      const t1 = await waitToast(4000);
      const sel = await live('JSON.stringify(state.sel)');
      check('nearest: "Select the N beyond" selects them (toast with Undo)', /selected .+Undo/.test(t1 ?? '') && (PREVIEW || (sel ?? '').includes('osm-datacenters')), `${b.btn[0]} · ${t1} · ${String(sel).slice(0, 120)}`);
      await shot(page, 'templates-f-2c-nearest-selected');
      await undoCheck('nearest select beyond', L0);
    } else check('nearest: a threshold with ≤ 500 beyond to select', false, JSON.stringify(b.btn));
    const { png, csv: csvFile } = await kitChecks('nearest', nr.card, nr.frame, 'templates-f-nearest');
    if (png) { const k = await pngInk(png); check('nearest PNG: the map is in it', k.off > 2000, JSON.stringify(k)); }
    const csvHead = (await nr.frame.evaluate(() => document.querySelector('.kit-table thead')?.textContent ?? '').catch(() => '')) || String(csvFile?.buf ?? '').split('\r\n')[0];
    check('nearest CSV: id, label, distance, nearest columns', /ID/.test(csvHead) && /Distance \((km|mi)\)/.test(csvHead) && /Nearest/.test(csvHead), csvHead);
  }
  }
  if (NEAREST_READY) {
    const nr2 = await showViz(GEN, 'nearest');
    cardOk('nearest (EIA generators → HIFLD substations)', nr2, 'drawn');
    {
      const t = await nr2.frame.evaluate(() => ({ truncated: TM_INPUT.truncated, truncation: TM_INPUT.truncation ?? '', n: TM_INPUT.features.length, rows: TM_INPUT.rows.length, second: TM_INPUT.second.features.length, bytes: JSON.stringify(TM_INPUT).length }));
      check('nearest EIA: every generator measured and sent (no cut at 8 MB)', !t.truncated && t.n === t.rows, JSON.stringify(t));
      const counts = await nr2.frame.evaluate(() => document.querySelector('.nr-row.nr-stat')?.textContent);
      check('nearest EIA: the threshold starts at 10 mi with most plants within', /Within: [\d,]+ \(9\d/.test(txt(counts)), txt(counts));
    }
    await cardShot(nr2.card, 'templates-f-3-nearest-eia');
  }

  // ── buildout-map: EIA generators by year, data-center moratoriums by month ──
  const bo = await showViz(GEN, 'buildout-map');
  cardOk('buildout-map (EIA generators)', bo, 'drawn');
  {
    const step = () => bo.frame.$eval('.bo-step', e => e.textContent).catch(() => null);
    const s1 = await step();
    await page.waitForTimeout(2500);
    const s2 = await step();
    check('buildout-map: plays by itself (the year advances)', !!s1 && !!s2 && s1 !== s2 && /^\d{4}$/.test(s2), `${s1} → ${s2}`);
    await bo.frame.click('.bo-ctl .kit-btn');   // pause
    await bo.frame.$eval('.bo-ctl input[type=range]', r => { r.value = String(Math.floor(Number(r.max) * 0.7)); r.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(500);
    const s3 = await step(), s4 = (await page.waitForTimeout(1200), await step());
    const btn = await bo.frame.$eval('.bo-ctl .kit-btn', b => b.textContent);
    check('buildout-map: scrubbing jumps to a year and stays paused', !!s3 && s3 === s4 && btn === 'Play', `${s3} / ${s4} · ${btn}`);
    check('buildout-map: the map is inked', (await ink(bo.frame)) > 3000, String(await ink(bo.frame)));
    await cardShot(bo.card, 'templates-f-4-buildout-eia');
    const { png } = await kitChecks('buildout-map', bo.card, bo.frame, 'templates-f-buildout');
    if (png) { const k = await pngInk(png); check('buildout-map PNG: the current step is in it', k.off > 2000, JSON.stringify(k)); }
  }
  const bo2 = await showViz(DCM, 'buildout-map');
  cardOk('buildout-map (data-center moratoriums)', bo2, 'drawn');
  {
    await page.waitForTimeout(800);
    const s = await bo2.frame.$eval('.bo-step', e => e.textContent).catch(() => null);
    check('buildout-map on moratoriums: steps by month (not a bare year)', !!s && !/^\d{4}$/.test(s), String(s));
    await cardShot(bo2.card, 'templates-f-5-buildout-moratoriums');
  }
  check('no console errors (the page\'s own)', rig.errors.length === 0, rig.errors.join(' | '));

  // ── Reload: every html card comes back as Re-run ──
  const before = await page.$$eval('.tv-cards > .chat-canvas', cs => cs.map(c => c.querySelector('.chat-canvas-title')?.textContent));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  await page.reload();
  await ready(page);
  await idle();
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => [...document.querySelectorAll('.tv-cards > .chat-canvas')].map(c => ({ title: c.querySelector('.chat-canvas-title')?.textContent, frame: !!c.querySelector('iframe'), rerun: !!c.querySelector('.chat-canvas-rerun') })));
  check('reload: the html cards come back, each as Re-run (no frame)', after.length >= Math.min(6, before.length) && after.every(c => c.rerun && !c.frame), JSON.stringify(after).slice(0, 400));
  await shot(page, 'templates-f-6-after-reload');
  const rr = await page.$('.tv-cards > .chat-canvas .chat-canvas-rerun');
  if (rr) {
    const m1 = (await msgs()).length;
    await rr.evaluate(b => b.closest('.chat-canvas').scrollIntoView({ block: 'start' }));
    await rr.click();
    const end = Date.now() + 40000;
    while (Date.now() < end && !(await msgs()).slice(m1).includes('drawn')) await page.waitForTimeout(250);
    check('reload: Re-run draws a restored html card again', (await msgs()).slice(m1).includes('drawn'), (await msgs()).slice(m1).join(','));
    await page.waitForTimeout(600);
    await shot(page, 'templates-f-6b-rerun');
  }
  await rig.close();

  // ── Reduced motion: no autoplay ──
  const rm = await chatRig(ctx, () => null, { chat: false, init: taps, cam: TX_CAM, contextOptions: { reducedMotion: 'reduce' } });
  {
    const p = rm.page;
    await p.click('#toolsMenuBtn');
    await p.click('[data-action="open-visualize"]');
    await p.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
    await p.selectOption('.tv-layer', GEN);
    await p.click('.tv-card[data-template="buildout-map"]');
    const m0 = await p.evaluate(() => window.__tmMsgs.length);
    await p.click('.tv-show');
    const end = Date.now() + 60000;
    while (Date.now() < end && !(await p.evaluate(m => window.__tmMsgs.slice(m), m0)).includes('drawn')) await p.waitForTimeout(250);
    const f = await (await p.$('.tv-cards > .chat-canvas iframe')).contentFrame();
    const s1 = await f.$eval('.bo-step', e => e.textContent);
    await p.waitForTimeout(2500);
    const s2 = await f.$eval('.bo-step', e => e.textContent), btn = await f.$eval('.bo-ctl .kit-btn', b => b.textContent);
    const last = await f.$eval('.bo-ctl input[type=range]', r => r.value === r.max);
    check('reduced motion: buildout-map opens on the last year and never plays by itself', s1 === s2 && btn === 'Play' && last, `${s1} → ${s2} · ${btn} · last ${last}`);
    await p.$eval('.tv-cards > .chat-canvas', c => c.scrollIntoView({ block: 'start' }));
    await shot(p, 'templates-f-7-buildout-reduced-motion');
    await rm.close();
  }

  // ── The chat: a tiled layer2 is refused with the hint; the model is told numbers only ──
  if (NEAREST_READY) {
    const fx = body => {
      const ms = body?.messages ?? [];
      const tools = ms.slice(ms.map(m => m.role).lastIndexOf('user') + 1).filter(m => m.role === 'tool').length;
      if (tools === 0) return { tool_calls: [call('n1', 'showTemplate', { template: 'nearest', layer: 'osm-datacenters', layer2: 'osm-substations-points' })] };
      if (tools === 1) return { tool_calls: [call('n2', 'showTemplate', { template: 'nearest', layer: 'osm-datacenters', layer2: SUBS, where2: [{ field: 'max_kv', op: '>=', value: 230 }] })] };
      return { content: 'Shown.' };
    };
    const cr = await chatRig(ctx, fx, { cam: TX_CAM });
    await cr.say('How far are data centers from a 230 kV or higher substation?');
    await cr.page.waitForTimeout(1500);
    const tm = cr.toolMsgs();
    const m1 = String(tm.get('n1') ?? ''), m2 = String(tm.get('n2') ?? '');
    log(`  tool n1: ${m1.slice(0, 300)}`);
    log(`  tool n2: ${m2.slice(0, 500)}`);
    check('chat: a tiled layer2 is refused, naming the GeoJSON layers it takes', /tiled layer/.test(m1) && /hifld-substations/.test(m1), m1.slice(0, 200));
    let s = null;
    try { s = JSON.parse(m2); } catch { /* checked below */ }
    const sum = s?.data?.summary ?? s?.summary;
    const keys = sum ? Object.keys(sum).sort().join(',') : '';
    check('chat: nearest tells the model numbers only (no group or feature names)', !!sum?.nearest && !sum.top && !sum.links && Object.values(sum.nearest).every(v => typeof v === 'number') && !/"name"|"label"/.test(m2),
      `${keys} · ${JSON.stringify(sum?.nearest)}`);
    await cr.cardShot(-1, 'templates-f-8-chat-nearest');
    check('no console errors (chat)', cr.errors.length === 0, cr.errors.join(' | '));
    await cr.close();
  }

  // ── Phone 390×844: flow (top to bottom), nearest, buildout-map ──
  const ph = await chatRig(ctx, () => null, { chat: false, init: taps, cam: TX_CAM, viewport: { width: 390, height: 844 }, contextOptions: { deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  {
    const p = ph.page;
    if (await p.isVisible('#closeLayers')) await p.click('#closeLayers');
    await p.click('#toolsMenuBtn');
    await p.click('[data-action="open-visualize"]');
    await p.waitForSelector('#td-viz:not([hidden]) .tv-layer', { timeout: 30000 });
    for (const [tpl, lyr, name] of [['flow', GEN, 'templates-f-9-phone-flow'], ['nearest', 'osm-datacenters', 'templates-f-10-phone-nearest'], ['buildout-map', GEN, 'templates-f-11-phone-buildout']].filter(([tpl]) => NEAREST_READY || tpl !== 'nearest')) {
      await p.selectOption('.tv-layer', lyr);
      await p.waitForTimeout(300);
      await p.$eval(`.tv-card[data-template="${tpl}"]`, b => { b.scrollIntoView({ block: 'center' }); b.click(); });
      await p.waitForTimeout(300);
      const ms0 = await p.evaluate(() => window.__tmMsgs.length);
      await p.$eval('.tv-show', b => { b.scrollIntoView({ block: 'center' }); b.click(); });
      const e3 = Date.now() + 60000;
      while (Date.now() < e3 && !(await p.evaluate(m => window.__tmMsgs.slice(m), ms0)).some(t => t === 'drawn' || t === 'error')) await p.waitForTimeout(250);
      await p.waitForTimeout(800);
      const geo = await p.evaluate(() => {
        const card = document.querySelector('.tv-cards > .chat-canvas')?.getBoundingClientRect();
        return { card: card && [Math.round(card.left), Math.round(card.right)], scroll: document.documentElement.scrollWidth, w: innerWidth };
      });
      const posted = await p.evaluate(m => window.__tmMsgs.slice(m), ms0);
      check(`phone ${tpl}: drawn, the card fits 390 px, no page horizontal scroll`, posted.includes('drawn') && !!geo.card && geo.card[0] >= 0 && geo.card[1] <= geo.w && geo.scroll <= geo.w, JSON.stringify(geo) + ' ' + posted.join(','));
      const f = await (await p.$('.tv-cards > .chat-canvas iframe')).contentFrame();
      if (tpl === 'flow') {
        const g = await f.evaluate(() => { const s = document.querySelector('.fl svg'); return { w: Number(s.getAttribute('width')), h: Number(s.getAttribute('height')), up: !!document.querySelector('.fl-node text[transform^="rotate(-90"]') }; });
        check('phone flow: top to bottom (taller than wide), labels upright', g.h > g.w && g.up, JSON.stringify(g));
      }
      if (tpl === 'nearest') {
        const g = await f.evaluate(() => { const m = document.querySelector('.nr-map').getBoundingClientRect(), s = document.querySelector('.nr-side').getBoundingClientRect(); return { mapH: Math.round(m.height), below: s.top >= m.bottom - 1 }; });
        check('phone nearest: map 300 px over the chart', g.mapH === 300 && g.below, JSON.stringify(g));
      }
      if (tpl === 'buildout-map') {
        const g = await f.evaluate(() => { const m = document.querySelector('.bo-map').getBoundingClientRect(), c = document.querySelector('.bo-ctl').getBoundingClientRect(); return { mapH: Math.round(m.height), below: c.top >= m.bottom - 1 }; });
        check('phone buildout-map: map 340 px, controls under it', g.mapH === 340 && g.below, JSON.stringify(g));
      }
      await p.$eval('.tv-cards > .chat-canvas', c => c.scrollIntoView({ block: 'start' })).catch(() => {});
      await p.waitForTimeout(500);
      await shot(p, name);
      await p.$eval('.tv-cards > .chat-canvas iframe', fr => fr.scrollIntoView({ block: 'start' })).catch(() => {});
      await p.waitForTimeout(400);
      await (await p.$('.tv-cards > .chat-canvas iframe'))?.screenshot({ path: path.join(OUT, name + '-frame.png') });
    }
    check('no console errors (the page\'s own, phone)', ph.errors.length === 0, ph.errors.join(' | '));
    await ph.close();
  }
}
