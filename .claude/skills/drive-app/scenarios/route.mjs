// .claude/skills/drive-app/scenarios/route.mjs
// The `route` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import { PREVIEW, URL_BASE, log, check, ready, settle, st, shot, DATA_HOST, PROD_DATA } from '../harness.mjs';

  // The route planner on a preview build, its data read from a stand-in data host
  // (SKILL.md § The route scenario). TM_DATA_HOST names the stand-in (started with
  // ROUTE_ID from assets/constants.ts) and TM_DATA_LOG its request log; every
  // data-host request goes there by context.route. The assertions read the stand-in's
  // log (a worker's requests included), not page events.
export default async function route(ctx) {
    if (!PREVIEW || !DATA_HOST || !process.env.TM_DATA_LOG) { check('the route scenario needs --preview, TM_DATA_HOST and TM_DATA_LOG (SKILL.md)', false); return; }
    const fs = await import('node:fs');
    const repo = process.env.TM_REPO ?? new URL('../../../../', import.meta.url).pathname;
    const id = /ROUTE_ID = "([0-9a-f]+)"/.exec(fs.readFileSync(repo + '/assets/constants.ts', 'utf8'))?.[1];
    check('ROUTE_ID read from assets/constants.ts', !!id, String(id));
    const LOG = process.env.TM_DATA_LOG, logAt = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
    const c = await ctx.browser().newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
    await c.route(PROD_DATA + '**', r => r.continue({ url: DATA_HOST + r.request().url().slice(PROD_DATA.length) }));
    const errors = [], page = await c.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()} @ ${m.location()?.url ?? ''}`); });
    const stray = [], failed = [], bad = [], screenStatus = [];
    c.on('request', r => { const u = r.url(); if (u.includes('/data/route/') && !u.startsWith(PROD_DATA)) stray.push(u); });
    c.on('requestfailed', r => { if (r.url().includes('/data/route/') && r.failure()?.errorText !== 'net::ERR_ABORTED') failed.push(`${r.url()} ${r.failure()?.errorText}`); });
    c.on('response', r => { if (r.url().includes('/report/screening/')) screenStatus.push([r.url(), r.status()]); if (r.url().includes('/data/route/') && r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    await ready(page, { url: URL_BASE + '#5.2/42.0/-121.9' });
    await settle(page);
    await page.click('#toolsMenuBtn');
    await page.click('.menu-item[data-i18n="route.menu"]');
    await page.waitForSelector('.ri-ep-in', { timeout: 20000 });
    const pick = async (n, q) => {
      const input = n ? page.locator('.ri-ep-in').last() : page.locator('.ri-ep-in').first();
      await input.fill(q);
      const opt = page.locator('.ri-opt').first();
      await opt.waitFor({ timeout: 30000 });
      const name = await opt.textContent();
      await opt.click();
      return name;
    };
    const A = await pick(0, 'Malin'), B = await pick(1, 'Captain Jack');
    check('two substations picked by search (Malin, Captain Jack)', /Malin/.test(A ?? '') && /Captain Jack/.test(B ?? ''), `${A} -> ${B}`);
    await page.click('.ri-primary');
    const solved = await page.waitForSelector('#rp-tab-cost[aria-selected]', { timeout: 120000 }).then(() => true, () => false);
    check('the route solved: result tabs shown', solved, await page.locator('.rp-error').allTextContents().then(t => t.join(' | ')).catch(() => ''));
    if (!solved) { await shot(page, 'route-unsolved'); await c.close(); return; }
    await settle(page);
    await shot(page, 'route-summary');
    await page.click('#rp-tab-cost');
    await page.waitForTimeout(1500);
    check('Cost tab shown with no error box', (await page.locator('#rp-tab-cost[aria-selected="true"]').count()) === 1 && (await page.locator('.rp-error').count()) === 0);
    await shot(page, 'route-cost');
    await page.click('#rp-tab-crossings');
    const read = page.locator('.rx-exact-btn');
    if (await read.count()) {
      await read.first().click();
      await page.waitForFunction(() => { const b = document.querySelector('.rx-exact-btn'); return !b || !b.disabled; }, null, { timeout: 90000 }).catch(() => {});
    }
    await page.waitForTimeout(1500);
    const notes = await page.locator('.rx-note').allTextContents();
    check('crossings read: no error line', !notes.some(n => /unavailable|failed|error/i.test(n)), notes.join(' | '));
    await shot(page, 'route-crossings');
    // The Routing constraints layer: switch on, a second concern.
    const cb = page.locator('input[data-layer-id="route-constraints"]');
    await cb.evaluate(e => { if (!e.checked) e.click(); });
    await settle(page);
    const sel = page.locator('select[data-route-concern-select]');
    if (await sel.count()) { const v = await sel.locator('option').evaluateAll(o => o.map(x => x.value)); await sel.selectOption(v[1] ?? v[0]).catch(() => {}); await page.getByRole('button', { name: 'I understand' }).click({ timeout: 2000 }).catch(() => {}); await settle(page); }
    await shot(page, 'route-constraints');
    await page.waitForTimeout(1500);
    const lines = fs.readFileSync(LOG, 'utf8').slice(logAt).split('\n').filter(l => /^(GET|HEAD) \/data\/route\//.test(l));
    const paths = lines.map(l => l.split(' ')[1].split('?')[0]);
    const count = p => paths.filter(x => x.startsWith(`/data/route/${id}/${p}`)).length;
    check('stand-in log: requests under data/route/<id>/250m/', count('250m/') > 0, String(count('250m/')));
    check('stand-in log: requests under data/route/<id>/report/', count('report/') > 0, String(count('report/')));
    check('stand-in log: requests under data/route/<id>/constraints/', count('constraints/') > 0, String(count('constraints/')));
    const other = paths.filter(x => !x.startsWith(`/data/route/${id}/`));
    check('stand-in log: no data/route/ request outside the versioned prefix', other.length === 0, other.slice(0, 3).join(' '));
    check('page and workers: no unversioned or page-relative data/route/ request', stray.length === 0, stray.slice(0, 3).join(' '));
    // net::ERR_ABORTED is the app cancelling a read (a superseded solve, a worker stop), not a failure.
    check('no failed or 4xx/5xx data/route/ request', failed.length === 0 && bad.length === 0, [...failed, ...bad].slice(0, 3).join(' | '));
    // Screening is aviation only: the manifest and aviation.json are read and no parquet is.
    const screen = paths.filter(x => x.startsWith(`/data/route/${id}/report/screening/`));
    const ok = u => screenStatus.some(([x, st]) => x.endsWith(u) && (st === 200 || st === 206));
    check('screening manifest requested and answered 200/206', screen.some(x => x.endsWith('/manifest.json')) && ok('/screening/manifest.json'), screen.join(' ').slice(0, 200));
    check('aviation.json requested and answered 200/206', screen.some(x => x.endsWith('/aviation.json')) && ok('/aviation.json'), screen.join(' ').slice(0, 200));
    const bld = screen.filter(x => x.endsWith('.parquet'));
    check('zero screening parquet requests', bld.length === 0, bld.slice(0, 3).join(' '));
    check('no console errors or pageerror (the page\'s own)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await c.close();
}
