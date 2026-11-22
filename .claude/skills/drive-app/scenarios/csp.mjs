// .claude/skills/drive-app/scenarios/csp.mjs
// The `csp` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { URL_BASE, CAM, log, check, open, ready, shot, quiet } from '../harness.mjs';

export default async function csp(ctx) {
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation',
        e => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    });
    const PROBE = 'csp-selftest.invalid';
    const blocked = [];   // [step, entry] from the listener and the console
    let step = 'boot';

    async function page0(hash) {
      const page = await ctx.newPage();
      const errors = [];
      const net = { inflight: 0 };
      page.on('request', () => net.inflight++);
      page.on('requestfinished', () => net.inflight--);
      page.on('requestfailed', () => net.inflight--);
      page.on('pageerror', e => errors.push('pageerror: ' + e.message));
      page.on('console', m => {
        const t = m.text();
        if (/Refused to|Content Security Policy/.test(t)) { if (!t.includes(PROBE)) blocked.push([step, 'console: ' + t]); }
        else if (m.type() === 'error') errors.push('console: ' + t);
      });
      page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : d.dismiss()));
      await ready(page, { url: URL_BASE + '#' + hash });
      await quiet(page, net);
      return { page, errors, net };
    }
    // No request in flight for 1.5 s (live polls keep some going: capped), then a fixed settle.
    async function quiet(page, net, maxMs = 25000) {
      const t0 = Date.now();
      let busy = Date.now();
      while (Date.now() - t0 < maxMs) {
        if (net.inflight > 0) busy = Date.now();
        else if (Date.now() - busy >= 1500) break;
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1500);
    }
    async function collect(page, name) {
      const v = (await page.evaluate(() => window.__csp.splice(0))).filter(e => !e.includes(PROBE));
      for (const e of v) blocked.push([name, e]);
      check(`${name}: nothing refused`, v.length === 0 && !blocked.some(([s]) => s === name), v.join(' | '));
    }
    const click = (page, sel) => page.evaluate(s => {
      const el = document.querySelector(s);
      el?.click();
      document.querySelectorAll('dialog[open]').forEach(d => d.close());   // the tribal disclaimer
      return !!el;
    }, sel);

    // (1) The policy is there, and the listener hears a refusal.
    const a = await page0(CAM);
    const meta = await a.page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content').catch(() => null);
    check('the page carries the CSP meta', !!meta, meta ? `${meta.length} chars` : 'none — is this a preview build?');
    // http:, since connect-src admits any https: host (linked services); http: stays refused.
    await a.page.evaluate(u => fetch(u).catch(() => {}), `http://${PROBE}/`);
    await a.page.waitForTimeout(500);
    const heard = await a.page.evaluate(() => window.__csp.splice(0));
    check('the listener hears a refused fetch', heard.some(e => e.startsWith('connect-src') && e.includes(PROBE)), heard.join(' | '));
    await collect(a.page, 'boot');

    // (2) Every layer group, switched on group by group, then off again.
    const seen = new Set();
    async function groups(p, label) {
      const ids = await p.page.evaluate(() => [...document.querySelectorAll('[id^="layer-rows-"]')].map(e => e.id));
      for (const g of ids) {
        const layers = await p.page.evaluate(([gid, done]) =>
          [...document.querySelectorAll(`#${gid} input[type=checkbox][data-layer-id]`)]
            .map(e => e.dataset.layerId).filter(id => !done.includes(id)), [g, [...seen]]);
        if (!layers.length) continue;
        step = `${label} ${g}`;
        const on = [];
        for (const id of layers) {
          seen.add(id);
          if (await p.page.isChecked(`input[data-layer-id="${id}"]`)) continue;
          await click(p.page, `input[data-layer-id="${id}"]`);
          on.push(id);
        }
        await quiet(p.page, p.net);
        await shot(p.page, `csp-${label}-${g}`);
        await collect(p.page, step);
        log(`      ${on.length} switched on: ${on.join(', ')}`);
        for (const id of on) if (await p.page.isChecked(`input[data-layer-id="${id}"]`)) await click(p.page, `input[data-layer-id="${id}"]`);
      }
    }
    await groups(a, 'usa');

    // (3) Every basemap, and the globe.
    for (const bm of ['dark', 'street', 'topo', 'hydro', 'aerial', 'light']) {
      step = `basemap ${bm}`;
      await click(a.page, `input[name=basemap][value=${bm}]`);
      await quiet(a.page, a.net);
      await shot(a.page, `csp-basemap-${bm}`);
      await collect(a.page, step);
    }
    step = 'globe';
    await click(a.page, 'input[name=projection][value=globe]');
    await quiet(a.page, a.net);
    await collect(a.page, step);
    check('no console errors (layers, basemaps)', a.errors.length === 0, a.errors.join(' | '));
    await a.page.close();

    // (4) The global layer list: the rows the US list did not show.
    step = 'global';
    const g = await page0(CAM + '?region=global');
    await groups(g, 'global');
    check('no console errors (global)', g.errors.length === 0, g.errors.join(' | '));
    await g.page.close();

    // (5) Close up over Houston: hillshade, 3D terrain and buildings, then aerial (Esri above z15.5).
    step = 'close-up 3D';
    const c = await page0('16/29.7604/-95.3698');
    for (const id of ['hillshadeToggle', 'terrain3dToggle', 'buildings3dToggle']) await click(c.page, `#${id}`);
    await quiet(c.page, c.net);
    await shot(c.page, 'csp-3d');
    await collect(c.page, step);
    step = 'close-up aerial';
    await click(c.page, 'input[name=basemap][value=aerial]');
    await quiet(c.page, c.net);
    await shot(c.page, 'csp-aerial-z16');
    await collect(c.page, step);

    // (6) Place search: Enter reaches the geocoder; the first result (when the
    // key is accepted) flies there and drops a pin.
    step = 'geocoder';
    await c.page.fill('#geocoderInput', 'Denver');
    const answer = c.page.waitForResponse(r => r.url().startsWith('https://geocode-api.arcgis.com/'), { timeout: 15000 })
      .then(r => r.text(), () => null);
    await c.page.press('#geocoderInput', 'Enter');
    const body = await answer;
    check('place search reaches the geocoder', body !== null);
    const found = await c.page.waitForSelector('#geocoderResults .search-result-item', { timeout: 5000 }).then(() => true, () => false);
    if (found) await c.page.click('#geocoderResults .search-result-item');
    else log(`      no candidates to click; the geocoder answered ${String(body).slice(0, 80)}`);
    await quiet(c.page, c.net);
    await shot(c.page, 'csp-geocoder');
    await collect(c.page, step);
    check('no console errors (close up, search)', c.errors.length === 0, c.errors.join(' | '));
    await c.page.close();

    // (7) A story link, then Tools ▸ Diagnostics… (probes every allowlisted host).
    step = 'story';
    const s = await page0(CAM + '?exp=ercot-island-grid');
    await shot(s.page, 'csp-story');
    await collect(s.page, step);
    step = 'diagnostics';
    await click(s.page, '#toolsMenuBtn');
    await click(s.page, '[data-action="open-diagnostics"]');
    await s.page.waitForTimeout(6000);   // probes time out at 5 s
    await quiet(s.page, s.net);
    await shot(s.page, 'csp-diagnostics');
    await collect(s.page, step);
    check('no console errors (story, diagnostics)', s.errors.length === 0, s.errors.join(' | '));
    await s.page.close();

    check('no refusal anywhere', blocked.length === 0, blocked.map(([w, e]) => `${w}: ${e}`).join(' | '));
}
