// .claude/skills/drive-app/scenarios/restore.mjs
// The `restore` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { log, check, open, ready, settle, st, hashFor, shot, hashOf, openTable, KEY, CORS, mockOpenRouter, mockGeocode, openChatWithKey } from '../harness.mjs';

  /**
   * restore (dev): the drawer and the chat after a reload of the same tab
   * (sessionStorage tm-drawer / tm-chat), and the cases that must restore nothing.
   */
export default async function restore(ctx) {
    const GEN = 'eia-generators';
    const SUBS = 'osm-substations-points';
    const TX_CAM = '5.4/31.2/-99.4';
    const HELLO = 'Hello from the model. <img src=x onerror="window.__xss=1"> Done.';
    const net = { chat: 0, models: 0, geocode: 0, unrouted: [] };
    const c = await ctx.browser().newContext({ viewport: { width: 1400, height: 900 } });
    const chatFixture = body => {
      net.chat++;
      return JSON.stringify(body?.messages?.at(-1) ?? '').includes('say hello') ? { content: HELLO } : null;
    };
    const chatHooks = { unrouted: net.unrouted, onRequest: async (route, req) => {
      if (req.method() !== 'GET') return false;
      if (req.url().endsWith('/api/v1/models')) net.models++;
      if (!req.url().endsWith('/api/v1/models/count')) return false;
      await route.fulfill({ json: { data: { count: 1 } }, headers: CORS });
      return true;
    } };
    const noCandidates = { candidates: [] };
    await mockOpenRouter(c, chatFixture, chatHooks);
    await mockGeocode(c, noCandidates, () => net.geocode++);

    const reload = async page => { await page.reload(); await ready(page, { settle: true }); };
    const hide = page => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
    const storage = page => page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    const drawerOpen = page => page.evaluate(() => !!document.querySelector('.table-drawer.td--open:not([hidden])'));
    const tableState = page => page.evaluate(() => {
      const d = document.querySelector('.table-drawer');
      return {
        layer: d.querySelector('.td-tab-name')?.textContent,
        groupBy: d.querySelector('.td-groupby')?.value,
        sum: d.querySelector('.td-sum')?.value,
        bar: d.querySelector('.td-bar[aria-pressed="true"]')?.dataset.bar ?? null,
        sort: [...d.querySelectorAll('[role=columnheader]')].filter(h => (h.getAttribute('aria-sort') ?? 'none') !== 'none').map(h => `${h.querySelector('[data-sort]')?.dataset.sort}:${h.getAttribute('aria-sort')}`),
        cols: [...d.querySelectorAll('.td-sort')].map(b => b.dataset.sort),
        select: d.querySelector('.td-select')?.getAttribute('aria-label'),
        active: d.querySelector('.td-row--active')?.children[1]?.textContent ?? null,
        scroll: d.querySelector('.td-grid .tabulator-tableholder').scrollTop,
        count: d.querySelector('.td-count')?.textContent,
        total: `${d.querySelector('.td-total')?.textContent} ${d.querySelector('.td-total-sub')?.textContent}`,
        split: d.classList.contains('td--split'),
        height: d.offsetHeight,
        tabs: [...d.querySelectorAll('.td-tab')].filter(t => !t.hidden).map(t => `${t.id}:${t.getAttribute('aria-selected')}`),
      };
    });
    const chatState = page => page.evaluate(() => ({
      atEnd: (l => !!l && l.scrollHeight - l.scrollTop - l.clientHeight < 4)(document.querySelector('.chat-log')),
      user: [...document.querySelectorAll('.chat-user')].map(p => p.textContent),
      bot: [...document.querySelectorAll('.chat-bot')].map(p => p.textContent),
      chips: [...document.querySelectorAll('.chat-chip:not(.chat-code)')].map(x => `${x.dataset.tool}:${x.dataset.source}:${x.dataset.ok}`),
    }));
    const undoDisabled = page => page.$eval('[data-action="undo"]', b => b.disabled);

    // ── (a) A GeoJSON table + Ask, reloaded in the same tab ──
    const probe = await open(c, TX_CAM);
    const base = await st(probe.page, 'state.layerVisibility');
    const link = await hashFor(probe.page, { layerVisibility: { ...base, [GEN]: true } }, TX_CAM);
    const subsLink = await hashFor(probe.page, { layerVisibility: { ...base, [SUBS]: true } }, '9/29.76/-95.37');
    await probe.page.close();

    const { page, errors } = await open(c, link);
    await openTable(page, GEN);
    await page.waitForSelector('.td-row', { timeout: 30000 });
    await page.selectOption('.td-groupby', 'gen_status');
    await page.waitForFunction(() => document.querySelectorAll('.td-bar').length > 1);
    const barId = await page.$eval('.td-bar:nth-child(2)', b => { b.click(); return b.dataset.bar; });
    await page.waitForFunction(id => document.querySelector(`.td-bar[data-bar="${id}"]`)?.getAttribute('aria-pressed') === 'true', barId);
    await page.$eval('[data-sort="plant_name"]', b => b.click());
    await page.waitForFunction(() => document.querySelector('[role=columnheader]:has([data-sort="plant_name"])')?.getAttribute('aria-sort') === 'ascending');
    await page.$eval('.td-cols', b => b.click());
    await page.$eval('[data-col="utility_name"]', i => i.click());
    await page.$eval('.td-cols-done', b => b.click());
    await page.$eval('.td-row[data-i="1"] .td-check input', i => i.click());
    await page.$eval('.td-row[data-i="2"] .td-check input', i => i.click());
    await page.$eval('.td-grid .tabulator-tableholder', g => { g.scrollTop = 200; g.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(200);
    await page.$eval('.td-row[data-i="9"] .tabulator-cell:nth-child(2)', c => c.click());   // active row; flies the camera
    await settle(page);
    // Ask, with a key (not remembered), a local command and one mocked model exchange.
    await openChatWithKey(page);
    const say = async text => {
      await page.fill('.chat-input', text);
      await page.press('.chat-input', 'Enter');
      await page.waitForFunction(() => !document.querySelector('.chat-working') && document.querySelector('.chat-stop')?.hidden, null, { timeout: 60000 });
    };
    await say('turn on railroads');
    await say('say hello');
    await settle(page);
    const preT = await tableState(page);
    const preC = await chatState(page);
    const preHash = await hashOf(page);
    const preNet = { ...net };
    check('before the reload: a split drawer, the table narrowed and sorted, two checks, the exchange in the chat',
      preT.split && preT.bar === barId && preT.sort[0] === 'plant_name:ascending' && /2/.test(preT.select ?? '') && preT.active && preC.bot.length === 1 && preC.chips.length === 1,
      JSON.stringify({ ...preT, ...preC }));
    check('before the reload, Undo is enabled (railroads)', !(await undoDisabled(page)));
    await shot(page, 'restore-1-before');
    await hide(page);
    const snaps = await storage(page);
    const all = JSON.stringify(snaps);
    check('hidden saves tm-drawer and tm-chat, each under 1 MB', !!snaps['tm-drawer'] && !!snaps['tm-chat'] && snaps['tm-drawer'].length < 1e6 && snaps['tm-chat'].length < 1e6,
      `${snaps['tm-drawer']?.length ?? 0} + ${snaps['tm-chat']?.length ?? 0} chars`);
    check('(f) the key appears nowhere in sessionStorage', !all.includes(KEY) && !all.includes('sk-or-v1-'));
    check('tm-chat holds the conversation only (the layout is tm-drawer\'s)', !('open' in JSON.parse(snaps['tm-chat']).data) && JSON.parse(snaps['tm-drawer']).data.ask === true);

    await reload(page);
    await page.waitForFunction(() => document.querySelector('.td-row--active'), null, { timeout: 30000 }).catch(() => {});
    await settle(page);
    const postT = await tableState(page);
    const postC = await chatState(page);
    const diff = Object.keys(preT).filter(k => JSON.stringify(preT[k]) !== JSON.stringify(postT[k]));
    check('(a) after the reload the drawer is back as it was: layer, group-by, bar, sort, columns, checks, active row, scroll, split, height, tabs',
      diff.length === 0, diff.map(k => `${k}: ${JSON.stringify(preT[k])} → ${JSON.stringify(postT[k])}`).join(' | '));
    check('…and the chat: the same messages, answer and chips, as text', JSON.stringify(preC) === JSON.stringify(postC)
      && await page.$$eval('.chat-log img', i => i.length) === 0 && !(await page.evaluate(() => window.__xss)), JSON.stringify(postC));
    check('…no OpenRouter or geocoder request (no completion, no catalogue fetch)', net.chat === preNet.chat && net.models === preNet.models && net.geocode === preNet.geocode,
      `chat ${preNet.chat}→${net.chat}, models ${preNet.models}→${net.models}, geocode ${preNet.geocode}→${net.geocode}`);
    check('…the link unchanged', (await hashOf(page)) === preHash, `${preHash} → ${await hashOf(page)}`);
    check('…Undo disabled (the restore added no step)', await undoDisabled(page));
    check('…focus not in the chat or the table (no phone keyboard)', await page.evaluate(() => !document.activeElement?.closest('.table-drawer')));
    check('(f) after the reload the key is still nowhere in sessionStorage', !JSON.stringify(await storage(page)).includes('sk-or-v1-'));
    await shot(page, 'restore-2-after-reload');

    // (h) the Diagnostics report's Page load line.
    await page.$eval('#toolsMenuBtn', b => b.click());
    await page.$eval('[data-action="open-diagnostics"]', b => b.click());
    await page.waitForFunction(() => document.querySelector('#diagReportText')?.value.length > 0, null, { timeout: 30000 });
    const report = await page.$eval('#diagReportText', t => t.value);
    const line = report.split('\n').find(l => l.startsWith('Page load')) ?? '';
    check('(h) Diagnostics reads "Page load: navigation reload"', /^Page load: navigation reload\b/.test(line), line);
    await page.keyboard.press('Escape');

    // (d) A new tab in the same context on the same link restores nothing.
    {
      const tab = await c.newPage();
      tab.on('pageerror', e => errors.push('pageerror: ' + e.message));
      tab.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      await tab.goto(page.url());
      await ready(tab);
      await settle(tab);
      check('(d) a new tab on the same link opens no drawer and has no snapshot', !(await drawerOpen(tab)) && Object.keys(await storage(tab)).filter(k => k !== 'tm-lifecycle').length === 0,
        JSON.stringify(Object.keys(await storage(tab))));
      await tab.close();
    }

    // ── (i) Cards come back as Re-run placeholders (no frame); Re-run draws; Español translates the restored notes ──
    {
      const { page: p, errors: e4 } = await open(c, link);
      const XHTML = '<p id="drawn">restored canvas</p>';
      await p.evaluate(([h, html]) => {
        const env = data => JSON.stringify({ v: 1, hash: h, at: 1, data });
        sessionStorage.clear();
        sessionStorage.setItem('tm-drawer', env({ v: 1, ask: true, pane: 'ask', table: null, frac: 0, collapsed: false }));
        sessionStorage.setItem('tm-chat', env({ busy: true, model: 'anthropic/claude-haiku-5.5', cost: 0, messages: [], entries: [
          { t: 'user', text: 'draw a page' },
          { t: 'code', id: 1, tool: 'showCanvas', code: html },
          { t: 'canvas', title: 'Saved page', code: 1, partial: [] },
          { t: 'vega', title: 'Saved chart', spec: { mark: 'bar', encoding: { x: { field: 'group', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } } }, rows: [{ group: 'gas', count: 3 }] },
          { t: 'user', text: 'and then' },
        ] }));
        for (const k of ['setItem', 'removeItem', 'clear']) Storage.prototype[k] = () => {};
      }, [await hashOf(p), XHTML]);
      await reload(p);
      await p.waitForSelector('.chat-canvas-restored', { timeout: 30000 });
      const r = await p.evaluate(() => ({
        cards: document.querySelectorAll('.chat-canvas-restored').length,
        rerun: document.querySelectorAll('.chat-canvas-rerun').length,
        frames: document.querySelectorAll('iframe').length,
        titles: [...document.querySelectorAll('.chat-canvas-title')].map(x => x.textContent),
      }));
      check('(i) a restored canvas and a Vega card show Re-run placeholders and no iframe', r.cards === 2 && r.rerun === 2 && r.frames === 0 && r.titles.join() === 'Saved page,Saved chart', JSON.stringify(r));
      await shot(p, 'restore-6-rerun-placeholders');
      await p.click('.chat-canvas-restored[data-kind="html"] .chat-canvas-rerun');
      await p.waitForSelector('.chat-log iframe', { timeout: 30000 }).catch(() => {});
      const framed = await p.evaluate(() => ({ frames: document.querySelectorAll('.chat-log iframe').length, left: document.querySelectorAll('.chat-canvas-restored').length }));
      check('(i) canvas Re-run renders a frame (the Vega placeholder stays)', framed.frames >= 1 && framed.left === 1, JSON.stringify(framed));
      await p.click('#fileMenuBtn');
      await p.click('[data-action="open-settings"]');
      await p.selectOption('#settingsLanguageSelect', 'es');
      await p.waitForFunction(() => document.querySelector('#td-tab-ask')?.textContent.includes('Preguntar'), null, { timeout: 10000 }).catch(() => {});
      await p.keyboard.press('Escape');
      const es = await p.evaluate(() => [document.querySelector('.chat-canvas-restored .chat-canvas-closed')?.textContent ?? '',
        [...document.querySelectorAll('[data-chat-key="chat.interrupted"]')].map(x => x.textContent).join()]);
      check('(i) Español translates the restored keyed strings (the Vega placeholder and the interrupted note)', /Guardado con la conversación/.test(es[0]) && /se recargó/.test(es[1]), es.join(' | '));
      await shot(p, 'restore-7-restored-spanish');
      await p.click('#fileMenuBtn');
      await p.click('[data-action="open-settings"]');
      await p.selectOption('#settingsLanguageSelect', 'en');
      await p.waitForFunction(() => document.querySelector('#td-tab-ask')?.textContent.includes('Ask'), null, { timeout: 10000 }).catch(() => {});
      await p.keyboard.press('Escape');
      check('no console errors (placeholders)', e4.length === 0, e4.join(' | '));
      await p.close();
    }

    // ── (j) A phone (390×844, touch): drawer and chat come back with no focus, so no keyboard ──
    {
      const ph = await ctx.browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await mockOpenRouter(ph, chatFixture, chatHooks);
      await mockGeocode(ph, noCandidates, () => net.geocode++);
      const { page: p, errors: e5 } = await open(ph, link);
      await p.evaluate(([h, gen]) => {
        const env = data => JSON.stringify({ v: 1, hash: h, at: 1, data });
        sessionStorage.clear();
        sessionStorage.setItem('tm-drawer', env({ v: 1, ask: true, pane: 'ask', frac: 0, collapsed: false, table: { req: { layerId: gen }, shown: [], checked: [], active: null, barFilter: null, scrollTop: 0 } }));
        sessionStorage.setItem('tm-chat', env({ busy: false, model: 'anthropic/claude-haiku-5.5', cost: 0, messages: [], entries: [{ t: 'user', text: 'say hello' }, { t: 'bot', text: 'Hello.' }] }));
        for (const k of ['setItem', 'removeItem', 'clear']) Storage.prototype[k] = () => {};
      }, [await hashOf(p), GEN]);
      await reload(p);
      await p.waitForSelector('.chat-bot', { timeout: 30000 });
      await settle(p);
      const r = await p.evaluate(() => ({
        open: !!document.querySelector('.table-drawer.td--open:not([hidden])'),
        ask: !document.querySelector('#td-ask').hidden,
        bot: document.querySelector('.chat-bot')?.textContent,
        active: document.activeElement?.tagName,
        typing: ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName),
      }));
      check('(j) phone: the drawer and chat are restored and no field has focus (no keyboard)', r.open && r.ask && r.bot === 'Hello.' && !r.typing, JSON.stringify(r));
      await shot(p, 'restore-8-phone');
      check('no console errors (phone)', e5.length === 0, e5.join(' | '));
      await ph.close();
    }

    // ── (b) A vector-tile table restores after idle, with the "loaded tiles only" note ──
    {
      const { page: p, errors: e2 } = await open(c, subsLink);
      await openTable(p, SUBS);
      await p.waitForSelector('.td-row', { timeout: 30000 });
      await p.$eval('[data-sort="name"]', b => b.click());
      await p.waitForFunction(() => document.querySelector('[role=columnheader]:has([data-sort="name"])')?.getAttribute('aria-sort') === 'ascending');
      const pre = await tableState(p);
      await hide(p);
      await reload(p);
      await p.waitForSelector('.td-row', { timeout: 30000 }).catch(() => {});
      const post = await tableState(p);
      const status = await p.$eval('.td-status', s => s.hidden ? '' : s.textContent);
      check('(b) a vector-tile table restores after idle: same layer and sort, rows drawn', post.layer === pre.layer && post.sort[0] === 'name:ascending' && await p.$$eval('.td-row', r => r.length) > 0, JSON.stringify(post));
      check('…with the "loaded tiles only" note', /tiles/i.test(status), status);
      await shot(p, 'restore-3-vector-tiles');

      // (g) Freeze then resume (CDP): no navigation, the drawer untouched.
      const origin = await p.evaluate(() => performance.timeOrigin);
      const cdp = await c.newCDPSession(p);
      try {
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        await p.waitForTimeout(500);
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        check('(g) frozen then active: no reload, the drawer untouched', (await p.evaluate(() => performance.timeOrigin)) === origin && JSON.stringify(await tableState(p)) === JSON.stringify(post));
      } catch (err) {
        log(`note  (g) skipped: Chromium refused Page.setWebLifecycleState — ${String(err.message ?? err).split('\n')[0]}`);
      }
      await cdp.detach().catch(() => {});

      // (c) A pasted link with state params in the same tab: map.ts reloads, nothing restores.
      await hide(p);
      const other = subsLink.replace(/^[^?]*/, '6/35/-100');
      const otherLink = other.includes('?') ? other : other + '?b=s';
      await Promise.all([p.waitForEvent('load', { timeout: 60000 }), p.evaluate(h => { location.hash = h; }, otherLink)]);
      await ready(p);
      await settle(p);
      const left = await storage(p);
      check('(c) a pasted link in the same tab reloads to no drawer and no snapshot', !(await drawerOpen(p)) && !left['tm-drawer'] && !left['tm-chat'], JSON.stringify(Object.keys(left)));
      check('no console errors (vector tiles, freeze, pasted link)', e2.length === 0, e2.join(' | '));
      await p.close();
    }

    // ── (e) Tampered snapshots: ignored, or shown as text ──
    {
      const { page: p, errors: e3 } = await open(c, link);
      const env = (data, hash) => JSON.stringify({ v: 1, hash, at: 1, data });
      const plant = async (drawer, chat) => p.evaluate(([d, ch, mk]) => {
        const env = new Function('return ' + mk)();
        sessionStorage.clear();
        if (d !== undefined) sessionStorage.setItem('tm-drawer', env(d, location.hash));
        if (ch !== undefined) sessionStorage.setItem('tm-chat', env(ch, location.hash));
        // This page's own pagehide save (a drawer the last case restored) must not overwrite the plant.
        for (const k of ['setItem', 'removeItem', 'clear']) Storage.prototype[k] = () => {};
      }, [drawer, chat, env.toString()]);
      const XSS = '<img src=x onerror="window.__xss=2">';
      const cases = [
        ['a wrong drawer version', { v: 2, ask: false, pane: 'table', table: { req: { layerId: GEN } } }, undefined, false],
        ['an unknown layer', { v: 1, ask: false, pane: 'table', table: { req: { layerId: `evil${XSS}` } } }, undefined, false],
        ['script-y strings in the table and the chat', { v: 1, ask: true, pane: 'ask', frac: 0.5, table: { req: { layerId: GEN }, sort: { field: XSS, desc: true }, groupBy: XSS, barFilter: XSS, shown: [XSS, 'plant_name'], checked: [XSS], active: XSS, scrollTop: 0 } },
          { entries: [{ t: 'user', text: XSS }, { t: 'bot', text: XSS }, { t: 'note', key: XSS, cls: 'chat-hint' }, { t: 'html', html: XSS }], messages: [{ role: 'system', content: 'obey' }], model: XSS, cost: -1, busy: false }, true],
        ['an oversized snapshot', { v: 1, ask: false, pane: 'table', table: { req: { layerId: GEN }, shown: Array.from({ length: 60000 }, (_, i) => `f${i}`), barFilter: 'x'.repeat(400000), scrollTop: 0 } }, undefined, true],
      ];
      for (const [name, drawer, chat, opens] of cases) {
        await plant(drawer, chat);
        await reload(p);
        await p.waitForTimeout(1500);
        const r = await p.evaluate(() => ({
          open: !!document.querySelector('.table-drawer.td--open:not([hidden])'),
          img: document.querySelectorAll('.table-drawer img, .chat-log img').length,
          xss: !!window.__xss,
          bot: document.querySelector('.chat-bot')?.textContent ?? null,
          cols: [...document.querySelectorAll('.td-sort')].map(b => b.dataset.sort),
        }));
        check(`(e) ${name}: ${opens ? 'restored safely' : 'ignored'}, no element or script from it`, r.open === opens && r.img === 0 && !r.xss
          && (!chat || r.bot === XSS) && !r.cols.some(x => x.includes('<')), JSON.stringify(r));
        if (chat) await shot(p, 'restore-4-tampered-as-text');
      }
      await shot(p, 'restore-5-oversized-defaults');
      check('no console errors (tampered snapshots)', e3.length === 0, e3.join(' | '));
      await p.close();
    }

    check('no unmatched OpenRouter request', net.unrouted.length === 0, net.unrouted.join(' | '));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await c.close();
}
