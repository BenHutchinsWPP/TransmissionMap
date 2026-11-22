// .claude/skills/drive-app/scenarios/stale.mjs
// The `stale` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { PREVIEW, check, CAM, log, open, settle, st, PASSES, ensureNorm, refContext, midRun, bye, retryPass, pcheck, pdump, quiet } from '../harness.mjs';

export default async function stale(ctx) {
  if (PREVIEW) { check('stale runs on the dev server (it reads state)', false); return; }
  const FEEDS = [
    { feed: 'wildfire', layer: 'wildfire-live', dialog: 'wildfireStaleDialog', age: 'wildfireStaleAge', re: 'wildfireStaleReenable', dis: 'wildfireStaleDismiss', chip: 'wildfireAge', group: ['wildfire-live', 'wildfire-smoke', 'wildfire-incidents'] },
    { feed: 'nws', layer: 'nws-alerts', dialog: 'nwsStaleDialog', age: 'nwsStaleAge', re: 'nwsStaleReenable', dis: 'nwsStaleDismiss', chip: 'nwsAge', group: ['nws-alerts'] },
    { feed: 'odin', layer: 'odin-outages', dialog: 'odinStaleDialog', age: 'odinStaleAge', re: 'odinStaleReenable', dis: 'odinStaleDismiss', chip: 'odinAge', group: ['odin-outages'] },
  ];
  for (const pass of PASSES) await retryPass(pass, async pass => {
    log(`\n  pass ${pass.name}`);
    const out = { feeds: {} };
    const { c, feed } = await refContext(ctx, pass);
    const errs = [];
    for (const F of FEEDS) {
      feed[F.feed] = 'stale';
      const { page, errors } = await open(c, CAM);
      await settle(page);
      if (F.feed === 'nws' && await midRun(page, pass)) out.langSwitchedBefore = F.feed;
      const rec = [];
      const state = async step => {
        await ensureNorm(page);
        rec.push(await page.evaluate(([F, step]) => {
          const dlg = document.getElementById(F.dialog);
          const lc = document.getElementById('legendContainer');
          return {
            step, dialogOpen: dlg.open, ageText: document.getElementById(F.age)?.textContent ?? null, chip: document.getElementById(F.chip)?.textContent ?? null,
            chipClass: document.getElementById(F.chip)?.className ?? null, legendHidden: lc.hidden,
            focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? '#' + document.activeElement.id : ''}` : null,
            dialog: window.__norm(dlg),
          };
        }, [F, step]));
        rec.at(-1).layers = await st(page, `Object.fromEntries(${JSON.stringify(F.group)}.map(i => [i, !!state.layerVisibility[i]]))`);
      };
      const toggleOn = () => page.evaluate(l => {
        const cb = document.querySelector(`input[type=checkbox][data-layer-id="${l}"]`);
        if (cb && !cb.checked) cb.click();
      }, F.layer);
      await state('before');
      await toggleOn();
      const opened = await page.waitForFunction(id => document.getElementById(id).open, F.dialog, { timeout: 30000 }).then(() => true, () => false);
      pcheck(pass, `[${pass.name}] ${F.feed}: the stale dialog opens`, opened);
      await page.waitForTimeout(500);
      await state('stale:dialog');
      pcheck(pass, `[${pass.name}] ${F.feed}: layer switched off`, !rec.at(-1).layers[F.layer]);
      await page.click('#' + F.dis);
      await page.waitForTimeout(300);
      await state('dismissed');
      await toggleOn();
      const again = await page.waitForFunction(id => document.getElementById(id).open, F.dialog, { timeout: 30000 }).then(() => true, () => false);
      pcheck(pass, `[${pass.name}] ${F.feed}: switching on again meets the gate`, again);
      await state('stale:dialog-again');
      await page.click('#' + F.re);
      await page.waitForTimeout(500);
      await settle(page);
      await state('re-enabled');
      pcheck(pass, `[${pass.name}] ${F.feed}: Re-enable closes the dialog and restores the layer`, !rec.at(-1).dialogOpen && !!rec.at(-1).layers[F.layer]);
      out.feeds[F.feed] = rec;
      errs.push(...errors);
      feed[F.feed] = 'fresh';
      await page.close();
    }
    pcheck(pass, `[${pass.name}] no page errors`, errs.filter(quiet).length === 0, errs.filter(quiet).join(' | '));
    pdump(pass, 'stale', pass.name, out);
    await bye(c);
  });
}
