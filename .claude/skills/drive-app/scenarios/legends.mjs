// .claude/skills/drive-app/scenarios/legends.mjs
// The `legends` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { PREVIEW, check, CAM, log, open, settle, mod, PASSES, ensureNorm, refContext, midRun, bye, retryPass, pcheck, pdump, dialogsClosed, quiet } from '../harness.mjs';

export default async function legends(ctx) {
  if (PREVIEW) { check('legends runs on the dev server (it drives app modules)', false); return; }
  for (const pass of PASSES) await retryPass(pass, async pass => {
    log(`\n  pass ${pass.name}`);
    const { c } = await refContext(ctx, pass);
    log('  opening');
    const { page, errors } = await open(c, CAM);
    log('  opened');
    await settle(page);
    log('  settled');
    const lcOrder = () => page.evaluate(() => [...document.getElementById('legendContainer').children].map(e => ({ id: e.id || null, cls: e.className, hidden: e.hidden })));
    const out = { facets: [], initialOrder: await lcOrder(), triggers: {}, cards: {} };
    // Probe: every registry layer alone, which legend cards it shows (the default-on layers go off first).
    const probe = await page.evaluate(async () => {
      const { LAYERS } = await import('/src/registry/index.ts');
      const { FACETS } = await import('/src/colors/facets.ts');
      const { setLayerVisibility } = await import('/assets/visibility.ts');
      const { state } = await import('/assets/state.ts');
      const lc = document.getElementById('legendContainer');
      const shown = () => [...lc.children].filter(e => !e.hidden).map(e => e.id || e.className);
      const wasOn = LAYERS.filter(l => state.layerVisibility[l.id]).map(l => l.id);
      for (const id of wasOn) setLayerVisibility(id, false, false);
      const base = shown();
      const trig = {};
      for (const l of LAYERS) {
        setLayerVisibility(l.id, true, false);
        document.querySelectorAll('dialog[open]').forEach(d => d.close());
        const s = shown().filter(x => !base.includes(x));
        setLayerVisibility(l.id, false, false);
        if (s.length) trig[l.id] = s;
      }
      return { facets: FACETS.map(f => ({ key: f.key, legendId: f.legendId ?? `${f.key}Legend` })), wasOn, base, trig, layers: LAYERS.map(l => l.id) };
    });
    log(`  probed ${probe.layers.length} layers, ${Object.keys(probe.trig).length} show a legend card`);
    out.facets = probe.facets; out.defaultOn = probe.wasOn; out.baseShown = probe.base; out.triggers = probe.trig;
    const ids = Object.keys(probe.trig);
    // Each legend-bearing layer alone, on a fresh page (a long run on one page stalls the software renderer): idle, then the
    // container's child order and every shown card.
    await bye(page);
    const half = Math.ceil(ids.length / 2);
    let n = 0;
    let lc = null, lp = null;
    const fresh = async () => { if (lc) await bye(lc); ({ c: lc } = await refContext(ctx, pass)); lp = (await open(lc, CAM)).page; await settle(lp); };
    await fresh();
    for (const id of ids) {
      if (n++ === half && await midRun(lp, pass)) { out.langSwitchedBefore = id; pass.lang = 'es'; }
      // A page that stalls (the machine is shared; the software renderer starves) is abandoned with its context and the layer tried again.
      for (let attempt = 1; ; attempt++) {
        const t0 = Date.now();
        const work = (async () => {
          await mod(lp, '/assets/visibility.ts', (m, i) => m.setLayerVisibility(i, true, false), id);
          await dialogsClosed(lp);
          await settle(lp);
          await ensureNorm(lp);
          const r = await lp.evaluate(() => {
            const el = document.getElementById('legendContainer');
            return {
              containerHidden: el.hidden,
              order: [...el.children].map(e => ({ id: e.id || null, cls: e.className, hidden: e.hidden })),
              shown: Object.fromEntries([...el.children].filter(e => !e.hidden).map((e, i) => [e.id || `child${i}`, window.__norm(e)])),
            };
          });
          // One chip step per FACETS card shown with this layer that has chips: the first chip off, the card, the chip back on.
          r.chips = await lp.evaluate(async facets => {
            const out = {}, wait = () => new Promise(res => setTimeout(res, 300));
            for (const f of facets) {
              const card = document.getElementById(f.legendId);
              const cb = card && !card.hidden ? card.querySelector('input.legend-filter-cb') : null;
              if (!cb) continue;
              const was = window.__norm(card);
              cb.click(); await wait();
              const off = window.__norm(card);
              cb.click(); await wait();
              out[f.key] = { bucket: cb.dataset.bucketId, before: was, off, restored: window.__norm(card) === was };
            }
            return out;
          }, probe.facets);
          await mod(lp, '/assets/visibility.ts', (m, i) => m.setLayerVisibility(i, false, false), id);
          return r;
        })();
        work.catch(() => {});
        const got = await Promise.race([work, new Promise(r => setTimeout(() => r(null), 120000))]).catch(() => null);
        if (got) { out.cards[id] = got; log(`  legend of ${id} (${Date.now() - t0} ms)`); break; }
        log(`  legend of ${id}: stalled, attempt ${attempt}`);
        if (attempt === 3) throw new Error(`legend of ${id} stalled three times`);
        await fresh();
      }
    }
    await bye(lc);
    const unrestored = Object.entries(out.cards).flatMap(([l, c]) => Object.entries(c.chips ?? {}).filter(([, v]) => !v.restored).map(([k]) => `${l}:${k}`));
    if (unrestored.length) log(`  note: chip toggled back did not restore the card: ${unrestored.join(', ')}`);   // recorded in the dump as `restored`
    const covered = Object.fromEntries(out.facets.map(f => [f.key, ids.filter(i => probe.trig[i].includes(f.legendId))]));
    out.coverage = covered;
    const miss = out.facets.filter(f => !covered[f.key].length).map(f => f.key);
    pcheck(pass, `[${pass.name}] every FACETS legend card appears with some layer`, miss.length === 0, miss.join(', '));
    for (const id of ['wildfire-live', 'nws-alerts', 'odin-outages', 'weather-live', 'nexrad-radar'])
      pcheck(pass, `[${pass.name}] live/raster card for ${id}`, !!probe.trig[id], String(probe.trig[id]));
    // Switching every layer on in turn makes MapLibre log tile-bound errors of its own; listed, not failed.
    if (errors.filter(quiet).length) log(`  note: ${errors.filter(quiet).length} console error(s), first: ${errors.filter(quiet)[0].slice(0, 160)}`);
    pdump(pass, 'legends', pass.name, out);
    await bye(c);
  });
}
