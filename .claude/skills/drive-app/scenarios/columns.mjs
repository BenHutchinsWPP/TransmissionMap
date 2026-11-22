// .claude/skills/drive-app/scenarios/columns.mjs
// The `columns` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { PREVIEW, URL_BASE, log, check, open, ready, settle, mod, st, hashFor, shot, openTable, call, chatRig, lineRig, templateKit } from '../harness.mjs';

  // Columns files: tiled layers listed in src/registry/columns.ts answer the table, the
  // templates and the chat's aggregate for the whole dataset from data/analysis/columns/
  // (dev server only: the dataset is unpublished). (1) The OSM lines table under Area Texas at
  // zoom 5, layer on and off, = the pyarrow reference count (tmp/columns-ref; a dataset read
  // is the layer's filters over the whole dataset whatever the zoom), no partial note, a row's
  // fly button lands on and highlights that row's line; (2) compare-regions on a layer switched
  // off draws, whole dataset, with the Area; (3) a mocked chat aggregate tells the model
  // `complete: true` and the reference total; (4) data/analysis/ answered 404 -> the view-scoped
  // wording; (5) the world table opened twice in one fresh page (the second open hits the warm
  // byte cache), the size prompt answered on the first open.
export default async function columns(ctx) {
    if (PREVIEW) { check('the columns scenario needs the dev server (data/analysis/ is unpublished)', false); return; }
    const OSM = 'osm-transmission-lines', SUBS = 'osm-substations-points', TX_CAM = '5/31.2/-99.4';
    const TX = { kind: 'states', codes: ['TX'] };
    const REF_TX = 32087;   // tmp/columns-ref/columns-reference.json: osm_transmission_lines, admin1_US-TX, USAB
    const PARTIAL = 'Only the features in the map tiles loaded for this view';
    const line = page => page.evaluate(() => {
      const s = document.querySelector('.td-status');
      return { count: document.querySelector('.td-count')?.textContent ?? '', note: document.querySelector('.td-note')?.textContent ?? '', status: !s || s.hidden ? '' : s.textContent, error: s?.dataset.kind === 'error' };
    });
    // Open a layer's table, answering the size prompt when it comes; `prompt` is its text, or false.
    // The previous open's rows and count are blanked first, so only the new load can satisfy the wait;
    // a table error ends it at once.
    const openAnswering = async (page, id, tag = 'table') => {
      await page.evaluate(() => {
        document.querySelectorAll('.td-row').forEach(r => r.removeAttribute('data-i'));
        const c = document.querySelector('.td-count');
        if (c) c.textContent = '';
      });
      await openTable(page, id);
      let prompt = false;
      const end = Date.now() + 120000;
      for (;;) {
        const l = await line(page);
        if (l.error) throw new Error('table error: ' + l.status);
        const btn = await page.$('.td-status button.td-btn');
        if (btn && !prompt) { prompt = l.status; await shot(page, `columns-size-prompt-${tag}`); await btn.click(); }
        else if (!btn && /\d/.test(l.count) && await page.$('.td-row[data-i]')) break;
        if (Date.now() > end) throw new Error('table did not load: ' + JSON.stringify(l));
        await page.waitForTimeout(250);
      }
      await settle(page);
      return prompt;
    };
    const closeTable = page => mod(page, '/assets/ui/ui-table.ts', m => m.closeTable());

    const probe = await open(ctx, TX_CAM);
    const vis = { ...(await st(probe.page, 'state.layerVisibility')), [OSM]: true, [SUBS]: false };
    const linkTx = await hashFor(probe.page, { layerVisibility: vis, area: TX }, TX_CAM);
    const linkTxOff = await hashFor(probe.page, { layerVisibility: { ...vis, [OSM]: false }, area: TX }, TX_CAM);
    const linkWorld = await hashFor(probe.page, { layerVisibility: vis }, TX_CAM);
    await probe.page.close();

    // (1) The Texas table.
    const { page, errors } = await open(ctx, linkTx);
    const p1 = await openAnswering(page, OSM, 'tx');
    const c1 = await line(page);
    log('  table:', JSON.stringify(c1), 'prompt:', JSON.stringify(p1));
    // A dataset read is the layer's filters over the whole dataset at any zoom: layer on at z5 = the reference.
    const total = c => Number(c.count.match(/of ([\d,]+)/)?.[1].replace(/,/g, '') ?? c.count.match(/[\d,]+/)?.[0].replace(/,/g, ''));
    check('OSM lines table, Area Texas, zoom 5, layer on: total = the pyarrow reference count', total(c1) === REF_TX, `${c1.count}; reference ${REF_TX.toLocaleString('en')}`);
    check('no partial note', !c1.status.includes(PARTIAL) && !/loaded tiles|current view only/.test(c1.note), JSON.stringify(c1));
    await shot(page, 'columns-1-table-tx');
    const cam0 = await st(page, 'state.map.getCenter().toArray()');
    await page.locator('.td-row[data-i="0"] .td-zoom-btn').click();
    await settle(page);
    await page.waitForTimeout(1500);
    const cam1 = await st(page, 'state.map.getCenter().toArray()');
    // Row 0's id: the drawer snapshot (saved when the tab is hidden) names the active row.
    const hl = await page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      const dq = await import('/assets/dataset-query.ts');
      const feats = async id => (await state.map.getSource(id)?.getData())?.features ?? [];
      const all = [...await feats('highlight-pts'), ...await feats('highlight-lines')];
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      let active = null;
      try { active = JSON.parse(sessionStorage.getItem('tm-drawer')).data.table.active; } catch { /* unread */ }
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      // The highlight keeps no feature id: the active row's id is read back from the columns file and its fields compared.
      const f = ['name', 'nominal_kv', 'operator'];
      const r = active === null ? null : await dq.query('osm-transmission-lines', { ids: [Number(active)], fields: f });
      const row = r?.ok ? r.result.rows[0]?.props : null;
      return { n: all.length, lines: (await feats('highlight-lines')).length, active: active === null ? null : String(active), row, same: !!row && all.length === 1 && f.every(k => (all[0].properties?.[k] ?? null) === (row[k] ?? null)) };
    });
    check('a row\'s fly button flies there', cam0.join() !== cam1.join(), `${cam0.map(v => v.toFixed(2))} -> ${cam1.map(v => v.toFixed(2))}`);
    check('...and highlights that row\'s line (its name, kV and operator = those of row 0\'s id)', hl.active !== null && hl.lines >= 1 && hl.same, JSON.stringify(hl));
    await shot(page, 'columns-1b-row-flown');
    await closeTable(page);
    check('no console errors (Texas table, row fly and highlight)', errors.length === 0, errors.join(' | '));
    await page.close();
    // The same table with the layer off lists every feature: the pyarrow reference count.
    const off = await open(ctx, linkTxOff);
    await openAnswering(off.page, OSM, 'tx-off');
    const c1b = await line(off.page);
    check('same table, layer off: total = the pyarrow reference count', total(c1b) === REF_TX && !c1b.status.includes(PARTIAL), `${c1b.count} vs ${REF_TX.toLocaleString('en')}`);
    await shot(off.page, 'columns-1c-table-tx-layer-off');
    await off.page.close();

    // (2) compare-regions on a layer that is off.
    const k = await templateKit(ctx);
    await k.page.goto('about:blank');
    await ready(k.page, { url: URL_BASE + '#' + linkTx, settle: true });
    check('substations layer is off for the template', (await st(k.page, `state.layerVisibility['${SUBS}']`)) === false);
    await k.openViz();
    const opts = await k.page.evaluate(async id => { const { formChoices } = await import('/assets/templates/show-template.ts'); const { templateById } = await import('/assets/templates/catalogue.ts'); const f = formChoices(templateById('compare-regions'), id); return { by: f.by.map(x => x.name), split: f.split.map(x => x.name), tiled: f.tiled }; }, SUBS);
    log('  compare-regions choices:', JSON.stringify(opts));
    const cmp = await k.showViz(SUBS, 'compare-regions', { by: opts.by[0], split: 'states' });
    const cardText = cmp.card ? await cmp.card.evaluate(c => c.textContent) : '';
    log('  card:', JSON.stringify(cmp.info), 'status:', cmp.status, 'posted:', cmp.posted.join());
    check('compare-regions draws on the switched-off layer (no "switch the layer on" refusal)', !!cmp.card && cmp.posted.some(t => t === 'drawn' || t === 'rendered') && !/switch .* on|turn .* on/i.test(cmp.status + cardText), `${cmp.status} | ${cmp.info?.title}`);
    // The card's own data: the spec the frame was sent (data.values), and the card's partial notes.
    const sent = cmp.frame ? await cmp.frame.evaluate(() => {
      const found = [];
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o.data && Array.isArray(o.data.values)) found.push(o.data.values);
        for (const x in o) walk(o[x]);
      };
      walk(window.__tmIn ?? []);
      return found.sort((a, b) => b.length - a.length)[0] ?? [];
    }).catch(() => []) : [];
    const partialNotes = cmp.card ? await cmp.card.$$eval('.chat-canvas-partial', ns => ns.map(n => n.textContent)) : ['no card'];
    const regionsIn = [...new Set(sent.map(r => r.rkey))];
    log('  card row sample:', JSON.stringify(sent.slice(0, 3)), 'split field: states');
    log('  card rows:', sent.length, 'regions:', JSON.stringify(regionsIn), 'partial notes:', JSON.stringify(partialNotes));
    check('...and its own data is the whole dataset (the card carries no partial note) with Area TX only', sent.length > 0 && partialNotes.length === 0 && regionsIn.length === 1 && regionsIn[0] === 'TX' && !/only the loaded|partial|view/i.test(cmp.info?.errors ?? ''), JSON.stringify({ rows: sent.length, regionsIn, partialNotes }));
    await k.cardShot(cmp.card, 'columns-2-compare-regions');
    check('no console errors (templates)', k.rig.errors.length === 0, k.rig.errors.join(' | '));
    await k.rig.close();

    // (3) A mocked chat aggregate on a columns layer.
    const chat = await chatRig(ctx, body => {
      const ms = body?.messages ?? [];
      const u = ms.map(m => m.role).lastIndexOf('user');
      if (!String(ms[u]?.content ?? '').toLowerCase().includes('breakdown')) return null;
      const tools = ms.slice(u + 1).filter(m => m.role === 'tool').length;
      if (tools === 0) return { tool_calls: [call('g1', 'aggregate', { layerId: OSM, area: TX, groupBy: 'nominal_kv' })] };
      return { content: 'Counted.' };
    }, { cam: TX_CAM });
    await chat.say('what is the breakdown of lines by voltage');
    const told = chat.toolMsgs().get('g1') ?? '';
    log('  tool g1:', told.slice(0, 300));
    const toldTotal = Number(told.match(/"total":\s*(\d+)/)?.[1]);
    check('chat aggregate on a columns layer tells the model complete: true and the reference total', /"complete":true/.test(told) && toldTotal === REF_TX, `total ${toldTotal}; ${told.slice(0, 200)}`);
    await shot(chat.page, 'columns-3-chat-aggregate');
    check('no console errors (chat)', chat.errors.length === 0, chat.errors.join(' | '));
    await chat.close();

    // (4) data/analysis/ answered 404: the view-scoped wording.
    const hits = [];
    const rig = await lineRig(ctx, { viewport: { width: 1400, height: 900 } }, async c => {
      await c.route(/\/data\/analysis\//, r => { hits.push(r.request().url()); return r.fulfill({ status: 404, body: '404: Not Found', headers: { 'access-control-allow-origin': '*' } }); });
    });
    await rig.go(linkTx);
    await openAnswering(rig.page, OSM, '404');
    const c4 = await line(rig.page);
    log('  404 table:', JSON.stringify(c4));
    check('index.json was requested and answered 404', hits.some(u => /index\.json/.test(u)), hits.join(' '));
    check('index.json 404: the table says it lists the loaded tiles only', c4.status.includes(PARTIAL), JSON.stringify(c4));
    await shot(rig.page, 'columns-4-index-404');
    const loud = rig.errors.filter(e => !/status of 404/.test(e));
    check('no console errors but the browser\'s own 404 line', loud.length === 0, rig.errors.join(' | '));
    await rig.close();

    // (5) The world table twice in one fresh page: the second open reads from the warm byte cache.
    const w = await open(ctx, linkWorld);
    const opens = [];
    for (const n of [1, 2]) {
      const t0 = Date.now();
      const prompt = await openAnswering(w.page, OSM, `world-${n}`);
      const c = await line(w.page);
      opens.push({ n, prompt, count: c.count, ms: Date.now() - t0 });
      await shot(w.page, `columns-5-world-open-${n}`);
      await closeTable(w.page);
      await w.page.waitForTimeout(500);
    }
    log('  world opens:', JSON.stringify(opens));
    const wtotal = o => Number(o.count.match(/of ([\d,]+)/)?.[1].replace(/,/g, '') ?? o.count.match(/[\d,]+/)?.[0].replace(/,/g, ''));
    check('world table: the size prompt appeared on open 1, and both opens list the same non-zero total', !!opens[0].prompt && wtotal(opens[0]) > 0 && wtotal(opens[0]) === wtotal(opens[1]), JSON.stringify(opens));
    check(`world table: no console error or pageerror across both opens (size prompt: open 1 ${opens[0].prompt ? 'yes' : 'no'}, open 2 ${opens[1].prompt ? 'yes' : 'no'})`, w.errors.length === 0, w.errors.join(' | '));
    await w.page.close();
}
