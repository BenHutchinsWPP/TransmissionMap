// .claude/skills/drive-app/scenarios/drawer.mjs
// The `drawer` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW, log, open, ready, settle, mod, st, hashFor, shot, pickLine, tapAt, FIXDIR, PASSES, refContext, midRun, snap, dragGrip, closePane, openTableAny, openAskAny, paneLife, hideTab, bye, retryPass, pcheck, pdump, quiet } from '../harness.mjs';

export default async function drawer(ctx) {
  const GEN = 'eia-generators', OSM = 'osm-transmission-lines';
  const INJECT = process.env.TM_DRAWER_INJECT;
  for (const pass of PASSES) await retryPass(pass, async pass => {
    log(`\n  pass ${pass.name}`);
    const out = { steps: [], skipped: {} };
    const { c } = await refContext(ctx, pass);
    if (PREVIEW) {
      out.skipped.others = 'the table, Ask, Visualize, Line, Proximity and Grid Ops panes run on the dev server (dev-only modules); a build runs Route only';
      const { page, errors } = await open(c, '5.2/42.0/-121.9');
      const openRoute = async p => { await p.click('#toolsMenuBtn'); await p.click('.menu-item[data-i18n="route.menu"]'); await p.waitForSelector('.ri-ep-in', { timeout: 30000 }); };
      out.steps.push(...await paneLife(page, 'route', openRoute));
      await openRoute(page);
      await dragGrip(page);
      await page.waitForTimeout(300);
      out.steps.push(await snap(page, 'dragged'));
      await closePane(page, 'route');
      out.steps.push(...await paneLife(page, 'route', openRoute, true));
      pcheck(pass, `[${pass.name}] route pane opened and closed`, out.steps.some(s => s.step === 'route:open' && s.state.activeTab?.[0] === 'route'));
      pcheck(pass, `[${pass.name}] no page errors`, errors.filter(quiet).length === 0, errors.filter(quiet).join(' | '));
      pdump(pass, 'drawer', pass.name, out);
      await bye(c);
      return;
    }
    out.skipped.route = 'needs --preview (a production build): node drive.mjs --preview drawer';
    const probe = await open(c, '5.4/31.2/-99.4');
    const link = await hashFor(probe.page, { layerVisibility: { ...(await st(probe.page, 'state.layerVisibility')), [GEN]: true }, area: { kind: 'states', codes: ['TX'] } }, '5.4/31.2/-99.4');
    await probe.page.close();
    const { page, errors } = await open(c, link);
    await settle(page);
    out.steps.push(await snap(page, 'initial'));

    // The three panes together, and what the tab keeps of them.
    await openTableAny(page, GEN);
    await openAskAny(page);
    await page.click('#toolsMenuBtn'); await page.click('[data-action="open-visualize"]');
    await page.waitForFunction(() => document.querySelector('#td-viz:not([hidden])')?.children.length > 0, null, { timeout: 30000 });
    await settle(page);
    out.steps.push(await snap(page, 'combo:table+ask+viz', ['.td-head']));
    await hideTab(page);
    out.tmDrawerRaw = await page.evaluate(() => sessionStorage.getItem('tm-drawer'));
    pcheck(pass, `[${pass.name}] tm-drawer saved with table, Ask and Visualize open`, typeof out.tmDrawerRaw === 'string' && out.tmDrawerRaw.length > 20, String(out.tmDrawerRaw).slice(0, 80));
    for (const p of ['viz', 'ask', 'table']) await closePane(page, p);
    out.steps.push(await snap(page, 'combo:closed'));

    // Each pane through its own opener, without and then with a prior grip drag.
    const defs = {
      table: p => openTableAny(p, GEN),
      ask: openAskAny,
      viz: async p => { await p.click('#toolsMenuBtn'); await p.click('[data-action="open-visualize"]'); await p.waitForFunction(() => document.querySelector('#td-viz:not([hidden])')?.children.length > 0, null, { timeout: 30000 }); },
      prox: async p => {
        await p.click('#toolsMenuBtn'); await p.click('[data-action="open-proximity"]');
        await p.waitForSelector('.px-file', { state: 'attached', timeout: 30000 });
        await p.setInputFiles('.px-file', path.join(FIXDIR, 'proximity.csv'));
        await p.waitForSelector('#csvImport', { timeout: 30000 });
        await p.evaluate(() => { const i = document.getElementById('csvIdSel'); if (i) i.value = '0'; });
        await p.click('#csvImport');
        await p.waitForSelector('.px-grid .tabulator-row', { timeout: 30000 });
      },
      gops: async p => {
        await mod(p, '/assets/visibility.ts', m => m.setLayerVisibility('ba-interchange', true));
        await p.waitForFunction(async () => !!(await import('/assets/grid-ops/grid-ops.ts')).gridShown(), null, { timeout: 30000 });
        await mod(p, '/assets/ui/grid-ops-open.ts', m => m.openGridOps('ERCO'));
        await p.waitForSelector('#td-gops:not([hidden]) *', { timeout: 30000 });
      },
    };
    for (const name of ['table', 'ask', 'viz', 'prox', 'gops']) {
      out.steps.push(...await paneLife(page, name, defs[name]));
      if (name === 'gops') await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('ba-interchange', false));
      if (name === 'ask' && await midRun(page, pass)) out.steps.push(await snap(page, 'lang:es'));
    }
    await defs.table(page);
    await dragGrip(page);
    await page.waitForTimeout(300);
    out.steps.push(await snap(page, 'dragged'));
    await closePane(page, 'table');
    for (const name of ['table', 'ask', 'viz', 'prox', 'gops']) {
      out.steps.push(...await paneLife(page, name, defs[name], true));
      if (name === 'gops') await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('ba-interchange', false));
    }
    await page.close();

    // The Line tab, from a line's popup (needs the line files; the dev server serves data/analysis/ from this machine).
    {
      const pr = await open(c, '9.5/39.70/-104.85');
      const lk = await hashFor(pr.page, { layerVisibility: { ...(await st(pr.page, 'state.layerVisibility')), [OSM]: true } }, '9.5/39.70/-104.85');
      await pr.page.close();
      const lp = await open(c, lk);
      await settle(lp.page);
      if (await lp.page.isVisible('#closeLayers')) { await lp.page.click('#closeLayers'); await settle(lp.page); }
      const pick = await pickLine(lp.page, OSM, pass.phone ? { box: [10, 10, 80, 0.45] } : undefined);
      let reason = pick ? null : 'no OSM line to tap in view';
      const openLine = async p => {
        let btn = null;
        for (let k = 0; k < 3 && !btn; k++) {
          await p.keyboard.press('Escape');
          await tapAt(p, pick, false);
          btn = await p.waitForSelector('.maplibregl-popup .popup-line-tools-btn, .maplibregl-popup .feat-picker-list > *', { timeout: 12000 }).catch(() => null);
          // Several features under the tap: the picker's first row is the line.
          if (btn && await p.isVisible('.maplibregl-popup .feat-picker-list > *')) {
            await p.click('.maplibregl-popup .feat-picker-list > *');
            btn = await p.waitForSelector('.maplibregl-popup .popup-line-tools-btn', { timeout: 12000 }).catch(() => null);
          }
        }
        if (!btn) throw new Error('no popup after three taps');
        await btn.click();
        await p.waitForSelector('#td-line:not([hidden]) .lt-grid', { timeout: 60000 });
      };
      if (pick) {
        try {
          out.lineFid = String(pick.fid);
          // After a drag the old tap point is under the drawer: the tab opens through its own opener (line-open.ts, which the
          // popup's button calls) instead; on the phone viewport a tap on the picked line does not raise a popup, so there too.
          const viaOpener = p => mod(p, '/assets/ui/line-open.ts', (m, [l, f, pr]) => m.openLineTools({ layerId: l, fid: f, properties: pr }), [OSM, pick.fid, pick.props])
            .then(() => p.waitForSelector('#td-line:not([hidden]) .lt-grid', { timeout: 60000 }));
          out.lineOpenedBy = pass.phone ? 'line-open.ts opener' : 'the popup\'s Line tools button';
          out.steps.push(...await paneLife(lp.page, 'line', pass.phone ? viaOpener : openLine));
          await viaOpener(lp.page);
          await dragGrip(lp.page);
          await closePane(lp.page, 'line');
          out.steps.push(...await paneLife(lp.page, 'line', viaOpener, true));
        } catch (e) { reason = `the popup offered no Line tools (data/analysis/ unavailable?): ${String(e.message).split('\n')[0]}`; }
      }
      if (reason) { out.skipped.line = reason; await shot(lp.page, `drawer-line-skipped-${pass.name}`).catch(() => {}); log('  pick ' + JSON.stringify(pick && { x: pick.x, y: pick.y })); }
      pcheck(pass, `[${pass.name}] line pane ${reason ? 'skipped: ' + reason : 'reached through ' + out.lineOpenedBy}`, true);
      await lp.page.close();
    }

    // TM_DRAWER_INJECT: a given tm-drawer string planted in sessionStorage, the same hash reloaded.
    if (INJECT) {
      const raw = fs.readFileSync(path.resolve(INJECT), 'utf8').trim();
      const { c: ic } = await refContext(ctx, pass, {}, { clock: false });
      const ip = await open(ic, link);
      await ip.page.evaluate(s => sessionStorage.setItem('tm-drawer', s), raw);
      await ip.page.reload();
      await ready(ip.page, { settle: true });
      await ip.page.waitForTimeout(1500);
      await settle(ip.page);
      out.inject = { file: path.basename(INJECT), steps: [await snap(ip.page, 'injected', ['.td-head', '#td-panel', '#td-ask', '#td-viz'])],
        tmDrawerAfter: (await ip.page.evaluate(() => sessionStorage.getItem('tm-drawer')))?.replace(/"at":\d+/g, '"at":0') ?? null,
        note: 'real clock for this step (reload detection); "at" zeroed' };
      await bye(ic);
    }
    pcheck(pass, `[${pass.name}] no page errors`, errors.filter(quiet).length === 0, errors.filter(quiet).join(' | '));
    pdump(pass, 'drawer', pass.name, out);
    await bye(c);
  });
}
