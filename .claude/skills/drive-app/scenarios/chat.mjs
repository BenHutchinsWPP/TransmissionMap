// .claude/skills/drive-app/scenarios/chat.mjs
// The `chat` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import os from 'node:os';
import { PREVIEW, URL_BASE, log, check, open, ready, settle, shot, hashOf, KEY, CORS, call, reply, mockOpenRouter, mockGeocode, openChat, snap } from '../harness.mjs';

  // Production build only (`npm run preview`, then `node drive.mjs --preview csp`):
  // drives everything that fetches off the page — each layer group (US and
  // global lists), every basemap and the globe, hillshade, 3D terrain and
  // buildings, aerial close up, a place search, a story and the Diagnostics
  // probes — through links and the DOM only (a build has no dev-server modules
  // to import), and fails on any request the page's CSP refuses. A listener
  // installed before the page's scripts collects the violations; a deliberate
  // fetch to an unlisted host first proves it hears them.
  // The map chat (Tools ▸ Ask the map…), with openrouter.ai answered from
  // recorded fixtures by request interception: no live model call is made, and
  // a request no fixture answers fails the run. URL/DOM-driven, so it also runs
  // on a preview build (--preview chat, CSP on).
export default async function chat(ctx) {
    const TX = { kind: 'states', codes: ['TX'] };
    const EXISTING = [{ field: 'gen_status', op: '=', value: 'existing' }];
    const MODELS = { data: [
      { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000005' } },
      { id: 'example/tool-model', name: 'Tool model', supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      { id: 'example/free-model:free', name: 'Free model', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
      { id: 'example/no-tools', name: 'No tools', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
    ] };
    const ANSWER = 'Existing capacity in Texas, by fuel, is in the table. <img src=x onerror="window.__xss=1"> Gas leads.';
    // The recorded conversation: which reply a request gets depends on the
    // visitor's last message and how many tool results follow it.
    function fixture(body) {
      const msgs = body?.messages ?? [];
      const u = msgs.map(m => m.role).lastIndexOf('user');
      const text = String(msgs[u]?.content ?? '').toLowerCase();
      const tools = msgs.slice(u + 1).filter(m => m.role === 'tool').length;
      if (text.includes('grouped by fuel')) {
        if (tools === 0) return ({ tool_calls: [call('c1', 'setArea', { area: TX }),
          call('c2', 'aggregate', { layerId: 'eia-generators', area: TX, where: EXISTING, groupBy: 'energy_source', sum: ['nameplate_mw'] })] });
        if (tools === 2) return ({ tool_calls: [call('c3', 'showTable', { layerId: 'eia-generators', area: TX, where: EXISTING })] });
        if (tools === 3) return ({ content: ANSWER });
      }
      if (text.includes('table of plant points')) {
        if (tools === 0) return ({ tool_calls: [call('c5', 'showTable', { layerId: 'osm-plants-points' })] });
        if (tools === 1) return ({ content: 'Done.' });
      }
      if (text.includes('where is austin')) {
        if (tools === 0) return ({ tool_calls: [call('c4', 'fitTo', { place: 'Austin, Texas' })] });
        if (tools === 1) return ({ content: 'Done.' });
      }
      return null;
    }
    const net = { chat: [], models: 0, modelsAuth: [], unrouted: [], geocode: 0, special: 0, probe: [] };
    // Every page's pageerror and console.error, for the closing check. The one
    // expected entry is the browser's own line for the deliberate 401.
    const allErrors = [];
    const EXPECTED_401 = /Failed to load resource: the server responded with a status of 401/;
    const GEOCODE = { candidates: [{ address: 'Austin, Texas', score: 100, location: { x: -97.74, y: 30.27 }, extent: { xmin: -97.94, ymin: 30.1, xmax: -97.56, ymax: 30.5 } }] };

    async function newCtx(opts = {}) {
      const c = await ctx.browser().newContext({ viewport: { width: 1400, height: 900 }, ...opts });
      await c.addInitScript(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
      });
      await mockOpenRouter(c, (body, req) => {
        const r = fixture(body);
        net.chat.push({ body, auth: req.headers()['authorization'], matched: !!r });
        return r;
      }, { unrouted: net.unrouted, onRequest: async (route, req) => {
        const url = req.url();
        if (req.method() === 'GET' && url.endsWith('/api/v1/models')) { net.models++; net.modelsAuth.push(req.headers()['authorization'] ?? ''); await route.fulfill({ json: MODELS, headers: CORS }); return true; }
        // Tools ▸ Diagnostics… probes the host with a keyless GET.
        if (req.method() === 'GET' && url.endsWith('/api/v1/models/count')) { net.probe.push(req.headers()['authorization'] ?? ''); await route.fulfill({ json: { data: { count: 1 } }, headers: CORS }); return true; }
        if (req.method() === 'POST' && url.endsWith('/api/v1/chat/completions')) {
          const last = JSON.stringify(req.postDataJSON()?.messages?.at(-1) ?? '');
          // A 401 whose body echoes the key; a reply held back so Esc or Stop lands mid-request.
          if (last.includes('fail please')) { net.special++; await route.fulfill({ status: 401, headers: CORS, json: { error: { message: 'bad key ' + KEY } } }); return true; }
          if (last.includes('hang please')) {
            net.special++;
            await new Promise(r => setTimeout(r, 10000));
            await route.fulfill({ json: reply({ content: 'late' }), headers: CORS }).catch(() => {});
            return true;
          }
        }
        return false;
      } });
      await mockGeocode(c, GEOCODE, () => net.geocode++);
      return c;
    }
    async function boot(c, hash = '5.4/31.2/-99.4') {
      const page = await c.newPage();
      const errors = [];
      const consoleText = [];
      const failed = [];
      page.on('pageerror', e => { errors.push('pageerror: ' + e.message); allErrors.push('pageerror: ' + e.message); });
      page.on('console', m => {
        consoleText.push(m.text());
        if (m.type() === 'error') { errors.push('console: ' + m.text()); allErrors.push('console: ' + m.text()); }
      });
      // The Diagnostics probe drops its body unread, which Chromium reports as ERR_ABORTED.
      page.on('requestfailed', r => { if (r.url().includes('openrouter.ai') && !r.url().endsWith('/models/count')) failed.push(r.failure()?.errorText ?? ''); });
      page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : d.dismiss()));
      await ready(page, { url: URL_BASE + '#' + hash, settle: true });
      return { page, errors, consoleText, failed };
    }
    const idle = page => page.waitForFunction(() => !document.querySelector('.chat-working') && document.querySelector('.chat-stop')?.hidden, null, { timeout: 60000 });
    async function say(page, text, wait = true) {
      await page.fill('.chat-input', text);
      await page.press('.chat-input', 'Enter');
      if (wait) await idle(page);
    }
    const chips = page => page.$$eval('.chat-chip', cs => cs.map(c => ({ tool: c.dataset.tool, src: c.dataset.source, ok: c.dataset.ok === 'true' })));
    const keyStored = page => page.evaluate(() => localStorage.getItem('tm-openrouter-key'));
    async function connect(page, remember = false) {
      if (await page.isHidden('.chat-key')) await page.click('.chat-key-btn');
      await page.fill('.chat-key-input', KEY);
      if (remember) await page.check('.chat-remember-box');
      await page.click('.chat-connect');
    }
    // Every drawer control on screen, measured: [class, w, h] of those < 40 px.
    const smallTargets = page => page.evaluate(() => [...document.querySelectorAll('.table-drawer :is(button, select, input, a)')]
      .filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden' && e.type !== 'checkbox')
      .map(e => { const r = e.getBoundingClientRect(); return [e.className || e.tagName, Math.round(r.width), Math.round(r.height)]; })
      .filter(([, w, h]) => w > 0 && (h < 40 || w < 40)));

    // ── Desktop ──
    const c = await newCtx();
    let { page, errors } = await boot(c);
    await openChat(page);
    check('chat opens from Tools ▸ Ask the map…, Ask tab selected', await page.getAttribute('#td-tab-ask', 'aria-selected') === 'true');
    check('no key: the key form shows', await page.isVisible('.chat-key'));
    check('the disclaimer line is shown', /can be wrong/.test(await page.textContent('.chat-note')));
    check('model picker defaults to anthropic/claude-haiku-5.5', await page.inputValue('.chat-model') === 'anthropic/claude-haiku-5.5');

    // Local commands: no key, no network.
    await say(page, 'turn off pipelines');
    const opts = await page.$$eval('.chat-choose button', bs => bs.map(b => b.textContent));
    check('an ambiguous layer name offers choices', opts.length >= 2, opts.join(' | '));
    await page.click('.chat-choose button');
    await page.waitForSelector('.chat-chip[data-source="local"]');
    await say(page, 'turn on railroads');
    let cs = await chips(page);
    check('local commands ran as local chips', cs.length === 2 && cs.every(x => x.src === 'local' && x.ok), JSON.stringify(cs));
    check('railroads switched on (panel checkbox)', await page.isChecked('input[data-layer-id="railroads"]'));
    await say(page, 'how many power plants are in Texas?');
    check('a question without a key asks for one', await page.isVisible('.chat-key') && /needs a model/.test(await page.textContent('.chat-key-status')));
    // Opening the chat fetches the public catalogue once for the picker's prices: a keyless GET, no completion.
    check('local commands and the no-key question sent no completion, and the one catalogue fetch carries no Authorization', net.chat.length === 0 && net.models === 1 && net.modelsAuth.every(a => a === ''), JSON.stringify(net.modelsAuth));

    // Key entry: a wrong shape is refused; a good one stays in this tab only.
    await page.fill('.chat-key-input', 'sk-or-v1-short');
    await page.click('.chat-connect');
    check('a malformed key is refused', /not an OpenRouter key/.test(await page.textContent('.chat-key-status')));
    await connect(page);
    check('key connected for this tab only', await page.isHidden('.chat-key') && (await keyStored(page)) === null);

    // Model picker: More models… fetches the catalogue once, tool models only, free ones marked.
    await page.selectOption('.chat-model', '__more');
    await page.waitForSelector('.chat-model optgroup', { state: 'attached' });
    const more = await page.$$eval('.chat-model optgroup option', os => os.map(o => o.textContent));
    check('More models… lists the tool-calling catalogue', net.models === 1 && more.some(x => /^Tool model · .*\$0\.10\/\$0\.20$/.test(x)) && more.some(x => /^Free model · .*\(free/.test(x)) && !more.some(x => /No tools/.test(x)), more.join(' | '));
    check('the picked model stays anthropic/claude-haiku-5.5', await page.inputValue('.chat-model') === 'anthropic/claude-haiku-5.5');

    // The model: setArea + aggregate, then showTable, then an answer.
    await say(page, 'show EIA plants in Texas grouped by fuel');
    cs = await chips(page);
    const model = cs.filter(x => x.src === 'model');
    check('model chips: setArea, aggregate, showTable, all done', model.map(x => x.tool).join() === 'setArea,aggregate,showTable' && model.every(x => x.ok), JSON.stringify(model));
    // The drawer is tabbed: showTable adds the table tab and Ask stays selected (syncPanes, drawer.ts).
    await page.waitForSelector('#td-tab:not([hidden])', { timeout: 30000 });
    check('the table tab appeared, Ask stays selected, the table behind its tab', await page.getAttribute('#td-tab-ask', 'aria-selected') === 'true'
      && await page.isVisible('#td-ask') && await page.isHidden('#td-panel') && await page.$eval('.table-drawer', d => d.classList.contains('td--table-off')));
    await page.click('#td-tab');
    await page.waitForSelector('.td-row', { timeout: 30000 });
    check('the table tab shows the rows, Ask hidden', await page.isVisible('#td-panel') && await page.isHidden('#td-ask'));
    check('table tab names EIA', /EIA/.test(await page.textContent('#td-tab')));
    check('link carries af=s.TX', (await hashOf(page)).includes('af=s.TX'), await hashOf(page));
    const answer = await page.$$eval('.chat-bot', ps => ps.map(p => p.textContent).join('\n'));
    check('model text rendered as text, markup and all', answer.includes('<img src=x') && await page.$$eval('.chat-log img', i => i.length) === 0 && !(await page.evaluate(() => window.__xss)));
    check('cost line sums usage.cost', /\$0\.0003/.test(await page.textContent('.chat-cost')), await page.textContent('.chat-cost'));
    const sent = net.chat.filter(x => x.matched);
    check('3 requests, each with the key in Authorization, max_tokens and usage', sent.length === 3 && sent.every(x => x.auth === `Bearer ${KEY}` && x.body.max_tokens === 16384 && x.body.usage?.include === true && x.body.model === 'anthropic/claude-haiku-5.5'));
    const toolMsgs = sent.flatMap(x => x.body.messages.filter(m => m.role === 'tool').map(m => m.content));
    check('tool results go back wrapped and ≤ 8 KB', toolMsgs.length > 0 && toolMsgs.every(m => m.startsWith('{"data":') && Buffer.byteLength(m) <= 8192), toolMsgs.map(m => Buffer.byteLength(m)).join(','));
    check('the key is in no link and no storage', !(await page.evaluate(() => location.href)).includes('sk-or-') && (await keyStored(page)) === null);
    await settle(page);
    await shot(page, 'chat-1-desk');

    // Undo on the setArea chip takes the Area back off; the button then disables.
    await page.click('#td-tab-ask');
    const undoBtn = '.chat-chip[data-tool="setArea"] .chat-undo';
    check('setArea chip offers Undo', await page.isEnabled(undoBtn));
    await page.click(undoBtn);
    await page.waitForFunction(() => !location.hash.includes('af='), null, { timeout: 10000 }).catch(() => {});
    check('Undo drops af from the link', !(await hashOf(page)).includes('af='), await hashOf(page));
    check('that Undo is now disabled', await page.isDisabled(undoBtn));

    // A model's place name goes to the geocoder only after the visitor says so.
    await say(page, 'where is austin?', false);
    await page.waitForSelector('.chat-card .chat-confirm-yes');
    check('confirm prompt names the place and the geocoder host', /Austin, Texas.*geocode-api\.arcgis\.com/.test(await page.textContent('.chat-card')));
    await shot(page, 'chat-2-confirm');
    await page.click('.chat-confirm-no');
    await idle(page);
    check('declined: nothing sent to the geocoder, fitTo refused', net.geocode === 0 && (await chips(page)).at(-1)?.ok === false);
    const before = (await hashOf(page)).split('?')[0];
    await say(page, 'where is austin? search this time', false);
    await page.waitForSelector('.chat-card .chat-confirm-yes');
    await page.click('.chat-card:last-of-type .chat-confirm-yes');
    await idle(page);
    check('confirmed: one geocoder request, fitTo done', net.geocode === 1 && (await chips(page)).at(-1)?.ok === true);
    // The camera writes the link when its animation ends; software WebGL can take a while.
    await page.waitForFunction(() => { const [, lat, lng] = location.hash.slice(1).split('?')[0].split('/').map(Number);
      return Math.abs(lat - 30.3) < 0.5 && Math.abs(lng + 97.75) < 0.5; }, null, { timeout: 20000 }).catch(() => {});
    const cam = (await hashOf(page)).replace(/^#/, '').split('?')[0].split('/').map(Number);
    check('…and the map moved to Austin', Math.abs(cam[1] - 30.3) < 0.5 && Math.abs(cam[2] + 97.75) < 0.5, `${before} → ${cam.join('/')}`);

    // Esc closes the chat (the table stays), then the table; focus returns.
    await page.focus('.chat-input');
    await page.keyboard.press('Escape');
    check('Esc closes the chat, the table stays', await page.isHidden('#td-ask') && await page.isVisible('#td-panel'));
    check('focus returned to the Tools menu button', await page.evaluate(() => document.activeElement?.id === 'toolsMenuBtn'));
    await page.focus('.td-grid .tabulator-tableholder');
    await page.keyboard.press('Escape');
    check('Esc in the table closes the drawer', await page.isHidden('.table-drawer'));
    check('no CSP violations (desktop)', (await page.evaluate(() => window.__csp)).length === 0, (await page.evaluate(() => window.__csp)).join(' | '));
    check('no console errors (desktop)', errors.length === 0, errors.join(' | '));

    // A reload of this tab restores the conversation (sessionStorage tm-chat) but not an
    // unremembered key; a new tab (sessionStorage is per tab) starts empty. Forget clears a remembered key.
    const pre = {
      chips: await chips(page),
      user: await page.$$eval('.chat-user', ps => ps.map(p => p.textContent)),
      bot: await page.$$eval('.chat-bot', ps => ps.map(p => p.textContent)),
      chat: net.chat.length, geocode: net.geocode, hash: await hashOf(page),
    };
    await page.reload();
    await ready(page);
    const snap = await page.evaluate(() => ({ all: JSON.stringify(Object.entries(sessionStorage)), chat: sessionStorage.getItem('tm-chat') }));
    check('the conversation was saved to sessionStorage, and the key appears nowhere in it', !!snap.chat && !snap.all.includes(KEY) && !snap.all.includes('sk-or-v1-'), `${snap.chat?.length ?? 0} chars`);
    await openChat(page);
    const after = {
      chips: await chips(page),
      user: await page.$$eval('.chat-user', ps => ps.map(p => p.textContent)),
      bot: await page.$$eval('.chat-bot', ps => ps.map(p => p.textContent)),
    };
    check('after reload in the same tab, the conversation is restored: same chips, messages and answers, as text', JSON.stringify(after) === JSON.stringify({ chips: pre.chips, user: pre.user, bot: pre.bot })
      && await page.$$eval('.chat-log img', i => i.length) === 0 && !(await page.evaluate(() => window.__xss)), JSON.stringify(after.chips));
    check('…restored chips offer no Undo (the undo stack is gone)', await page.$$eval('.chat-undo', x => x.length) === 0);
    check('…and the restore sent no completion and no geocoder request, and left the link as it was',
      net.chat.length === pre.chat && net.geocode === pre.geocode && (await hashOf(page)) === pre.hash, `${pre.hash} → ${await hashOf(page)}`);
    check('after reload, an unremembered key is gone', /No key/.test(await page.textContent('.chat-key-status')) && (await keyStored(page)) === null);
    await say(page, 'how many power plants are in Texas?');
    check('…so the next model question shows the key form and sends nothing', await page.isVisible('.chat-key') && net.chat.length === pre.chat);
    await settle(page);
    await page.click('.chat-key-btn');
    await page.waitForFunction(() => document.querySelector('.chat-key')?.hidden, null, { timeout: 5000 }).catch(() => {});
    await shot(page, 'chat-3-restored');
    {
      const tab = await c.newPage();
      await tab.goto(page.url());
      await ready(tab);
      await openChat(tab);
      check('a new tab on the same link shows no conversation (sessionStorage is per tab)',
        await tab.$$eval('.chat-chip, .chat-user', x => x.length) === 0 && await tab.evaluate(() => sessionStorage.getItem('tm-chat')) === null);
      await tab.close();
    }
    await connect(page, true);
    check('Remember stores the key on this device', (await keyStored(page)) === KEY);
    await page.reload();
    await ready(page);
    await openChat(page);
    check('a remembered key survives reload', await page.isHidden('.chat-key'));
    await page.click('.chat-key-btn');
    check('…and says it is remembered', /remembered/.test(await page.textContent('.chat-key-status')));
    await page.click('.chat-forget');
    check('Forget removes it', (await keyStored(page)) === null && /forgotten/.test(await page.textContent('.chat-key-status')));
    // lang:changed re-translates the chat (File ▸ Settings… ▸ Español).
    await page.click('#fileMenuBtn');
    await page.click('[data-action="open-settings"]');
    await page.selectOption('#settingsLanguageSelect', 'es');
    await page.waitForFunction(() => document.querySelector('#td-tab-ask')?.textContent.includes('Preguntar'), null, { timeout: 10000 }).catch(() => {});
    await page.keyboard.press('Escape');
    const es = await page.evaluate(() => [document.querySelector('#td-tab-ask')?.textContent, document.querySelector('.chat-note')?.textContent,
      document.querySelector('.chat-input')?.placeholder, document.querySelector('.chat-cost')?.textContent, document.querySelector('.chat-key-status')?.textContent]);
    check('Spanish: tab, disclaimer, placeholder, cost and key status re-translate', es[0].includes('Preguntar') && /Verifícalas/.test(es[1])
      && /Pregunta/.test(es[2]) && /esta sesión/.test(es[3]) && /olvidado/.test(es[4]), es.join(' | '));
    check('no console errors (reloads)', errors.length === 0, errors.join(' | '));
    await c.close();

    // ── The no-op Undo, the key kept off the page, Remember, Esc and Stop mid-request ──
    {
      const k = await newCtx();
      const b = await boot(k);
      page = b.page;
      const rail = 'input[data-layer-id="railroads"]';
      await page.$eval(rail, x => x.click());
      await page.waitForFunction(s => document.querySelector(s)?.checked, rail, { timeout: 10000 });
      await openChat(page);
      await say(page, 'turn on railroads');
      check('a call that changed nothing (railroads already on) offers no Undo',
        await page.$$eval('.chat-chip[data-tool="setLayerVisible"] .chat-undo', x => x.length) === 0);
      check('…and the visitor\'s own step stands', await page.isChecked(rail));

      await connect(page);
      const keyOnPage = () => page.evaluate(key => document.documentElement.outerHTML.includes(key)
        || [...document.querySelectorAll('input, textarea')].some(i => i.value.includes(key)) || location.href.includes(key), KEY);
      check('after Connect, the key is in no markup, input value or link', !(await keyOnPage()));
      await say(page, 'fail please');
      const err = await page.$$eval('.chat-err', e => e.map(x => x.textContent).join(' | '));
      check('a 401 shows the fixed auth note, not its body', /did not accept the key/.test(err) && !err.includes('bad key'), err);
      check('…and the key is still in no markup, input value or link', !(await keyOnPage()));
      if (!PREVIEW) {
        const diag = await page.evaluate(async () => JSON.stringify((await import('/assets/diag-log.ts')).getDiagLog()));
        check('the key is not in the diagnostics log', !diag.includes(KEY));
      }
      await page.click('#toolsMenuBtn');
      await page.click('[data-action="open-diagnostics"]');
      await page.waitForFunction(() => document.querySelector('#diagReportText')?.value.length > 0, null, { timeout: 30000 });
      const report = await page.evaluate(() => document.querySelector('#diagReportText').value + '\n' + document.querySelector('#diagnosticsDialog').innerText);
      check('the key is not in the Diagnostics report or dialog', report.length > 100 && !report.includes(KEY));
      check('the Diagnostics probe of openrouter.ai sends no key', net.probe.length > 0 && net.probe.every(h => h === ''), `${net.probe.length} probe(s)`);
      await page.keyboard.press('Escape');
      check('the key is not in the console', !b.consoleText.some(x => x.includes(KEY)));

      // Remember: on writes the key to this device, off removes it; Forget clears both.
      await openChat(page);
      if (await page.isHidden('.chat-key')) await page.click('.chat-key-btn');
      await page.check('.chat-remember-box');
      const on = await keyStored(page);
      await page.uncheck('.chat-remember-box');
      const off = await keyStored(page);
      check('Remember on stores the key, off removes it', on === KEY && off === null, `${on === KEY}/${off}`);
      await page.check('.chat-remember-box');
      await page.click('.chat-forget');
      check('Forget clears storage, unticks Remember and shows the key form',
        (await keyStored(page)) === null && !(await page.isChecked('.chat-remember-box')) && await page.isVisible('.chat-key'));

      // A chat-opened table held at the size prompt: closing the drawer answers
      // it, so the chat is free for the next Send.
      await connect(page);
      await say(page, 'a table of plant points', false);
      await page.waitForSelector('.td-status:has-text("MB")', { timeout: 15000 }).catch(() => {});
      check('the chat\'s showTable stops at the size prompt', /MB/.test((await page.textContent('.td-status')) ?? ''));
      // × closes the table pane only; the chat beside it stays open and its
      // request resumes with the declined prompt, so the model's next reply shows.
      await page.click('.td-tab-x[data-pane="table"]');
      await idle(page).catch(() => {});
      const closed = await page.$$eval('.chat-bot', e => e.map(x => x.textContent));
      check('closing the table settles the prompt: the chat stays open, the model answers "Done.", Send back, no working line',
        closed.at(-1) === 'Done.' && await page.isVisible('#td-ask') && await page.isVisible('.chat-send') && !(await page.$('.chat-working')), closed.join(' | '));
      await say(page, 'turn off railroads');
      check('…and the chat takes the next Send', (await chips(page)).at(-1)?.tool === 'setLayerVisible' && !(await page.isChecked(rail)));

      // Esc mid-request closes the chat and aborts the fetch; Stop does the same.
      await say(page, 'hang please', false);
      await page.waitForSelector('.chat-working');
      check('Stop shows while a request is in flight', await page.isVisible('.chat-stop') && await page.isHidden('.chat-send'));
      await page.waitForTimeout(500);
      await page.focus('.chat-input');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('#td-ask')?.hidden, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      check('Esc mid-request closes the chat and aborts the fetch', await page.isHidden('#td-ask') && b.failed.some(x => /ABORTED/.test(x)), b.failed.join(' | '));
      await openChat(page);
      const notes = await page.$$eval('.chat-err', e => e.map(x => x.textContent));
      check('reopened: "Stopped.", Send back, no working line', notes.at(-1) === 'Stopped.' && await page.isVisible('.chat-send') && !(await page.$('.chat-working')), notes.join(' | '));
      await say(page, 'hang please', false);
      await page.waitForSelector('.chat-working');
      await page.waitForTimeout(500);
      await page.click('.chat-stop');
      await idle(page);
      await page.waitForTimeout(500);
      const stops = await page.$$eval('.chat-err', e => e.filter(x => x.textContent === 'Stopped.').length);
      // The declined size prompt is an answer, not a stop; Esc left the first "Stopped.".
      check('Stop aborts too: a second "Stopped.", Send back', stops === 2 && b.failed.filter(x => /ABORTED/.test(x)).length === 2 && await page.isVisible('.chat-send'), `${stops} notes · ${b.failed.join(' | ')}`);
      await shot(page, 'chat-4-stopped');
      const unexpected = b.errors.filter(x => !EXPECTED_401.test(x));
      check('no console errors (key, Remember, Esc and Stop) but the 401 line', unexpected.length === 0, unexpected.join(' | '));
      await k.close();
    }

    // ── Phones: portrait 390×844 and 360×740, landscape 844×390, and the
    // keyboard open (the layout viewport shrinks): portrait 390×450, landscape 844×220 ──
    for (const [w, h] of [[390, 844], [360, 740], [844, 390], [390, 450], [844, 220]]) {
      const pc = await newCtx({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      ({ page, errors } = await boot(pc));
      if (await page.isVisible('#closeLayers')) await page.click('#closeLayers');
      await openChat(page);
      await say(page, 'turn on railroads');
      await connect(page);
      await say(page, 'show EIA plants in Texas grouped by fuel');
      const tag = `${w}x${h}`;
      // Landscape with the keyboard open, the tabs make way for the conversation while the composer has focus.
      check(`${tag}: the answer stays in view, the table behind its tab${h <= 300 ? ' (tabs hidden while typing)' : ''}`, await page.getAttribute('#td-tab-ask', 'aria-selected') === 'true'
        && (h <= 300 ? await page.isHidden('.td-tabs') : await page.isVisible('#td-tab')) && await page.$eval('.table-drawer', d => d.classList.contains('td--table-off')) && await page.isHidden('#td-panel'));
      const lay = await page.evaluate(() => {
        const r = s => document.querySelector(s)?.getBoundingClientRect();
        return { scroll: document.documentElement.scrollWidth, input: r('.chat-input'), note: r('.chat-note'), log: r('.chat-log'), vh: innerHeight };
      });
      check(`${tag}: no page scroll; composer, note and conversation on screen`, lay.scroll <= w && lay.input.bottom <= lay.vh && lay.note.bottom <= lay.vh + 1 && lay.log.height >= 60, JSON.stringify(lay));
      const shape = await page.evaluate(() => {
        const r = s => document.querySelector(s).getBoundingClientRect();
        const n = document.querySelector('.chat-note');
        return { railed: r('.chat-bar').left >= r('.chat-log').right - 1, input: Math.round(r('.chat-input').width), noteCut: n.scrollWidth > n.clientWidth };
      });
      check(`${tag}: ${w > h ? 'landscape: model, cost and Key in the side column' : 'portrait layout, a full-width composer'}`,
        w > h ? shape.railed : !shape.railed && shape.input >= w * 0.5, JSON.stringify(shape));
      check(`${tag}: the disclaimer wraps, nothing cut`, !shape.noteCut);
      const chip = '.chat-chip[data-tool="aggregate"] .chat-chip-text';
      const h0 = await page.$eval(chip, d => d.getBoundingClientRect().height);
      await page.tap(`${chip} > summary`);
      const [open, h1] = await page.$eval(chip, d => [d.open, d.getBoundingClientRect().height]);
      check(`${tag}: a tap shows a chip's whole arguments`, open && h1 > h0, `${Math.round(h0)} → ${Math.round(h1)} px`);
      await page.tap(`${chip} > summary`);
      await page.focus('.chat-input');
      const small = await smallTargets(page);
      check(`${tag}: every drawer control ≥ 40 px`, small.length === 0, JSON.stringify(small));
      const fileH = await page.$eval('#toolsMenuBtn', b => b.getBoundingClientRect().height);
      check(`${tag}: the Tools button (the chat's way in) is ≥ 40 px tall`, fileH >= 40, `${fileH} px`);
      await settle(page);
      await shot(page, `chat-3-phone-${tag}`);
      // The keyboard closes before a tab is tapped.
      await page.evaluate(() => document.activeElement?.blur());
      await page.tap('#td-tab');
      await page.waitForSelector('.td-row', { timeout: 30000 });
      check(`${tag}: the Table tab shows the rows, Ask hidden`, await page.isVisible('#td-panel') && await page.isHidden('#td-ask'));
      await page.tap('#td-tab-ask');
      check(`${tag}: back to Ask`, await page.isVisible('#td-ask .chat-input'));
      check(`${tag}: no CSP violations`, (await page.evaluate(() => window.__csp)).length === 0);
      check(`${tag}: no console errors`, errors.length === 0, errors.join(' | '));
      await pc.close();
    }
    check('every openrouter.ai request matched a fixture (none reached the network)', net.unrouted.length === 0 && net.chat.every(x => x.matched), net.unrouted.join(' | '));
    const unexpected = allErrors.filter(x => !EXPECTED_401.test(x));
    check('no console errors (every page in the scenario)', unexpected.length === 0, unexpected.join(' | '));
}
