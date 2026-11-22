// .claude/skills/drive-app/scenarios/sandbox.mjs
// The `sandbox` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { PREVIEW, URL_BASE, CAM, log, check, ready, reply } from '../harness.mjs';

  // The analysis sandbox: public/sandbox.html in its <iframe sandbox="allow-scripts">.
  // Dev drives assets/sandbox/sandbox-host.ts; a preview build has no import of
  // it yet, so there the scenario speaks the same wire protocol from the page,
  // under the page's own production CSP (frame-src 'self').
export default async function sandbox(ctx) {
    const page = await ctx.newPage();
    const errors = [], refused = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => {
      const t = m.text();
      if (/Refused to|Content Security Policy|example\.org/.test(t)) refused.push(t);
      else if (m.type() === 'error') errors.push('console: ' + t);
    });
    await ready(page, { url: URL_BASE + '#' + CAM });
    await page.evaluate(() => { window.__ticks = 0; setInterval(() => window.__ticks++, 100); });

    const run = (code, inputs = {}) => page.evaluate(async ([code, inputs, preview]) => {
      if (!preview) {
        const m = await import('/assets/sandbox/sandbox-host.ts');
        const r = await m.runInSandbox(code, inputs);
        return r.ok ? { ok: true, value: r.result.value, ms: r.result.ms } : { ok: false, reason: r.reason };
      }
      if (!window.__sbx) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.hidden = true;
        f.src = '/sandbox.html';
        const ready = new Promise(res => addEventListener('message', function h(e) {
          if (e.source === f.contentWindow && e.data?.type === 'ready') { removeEventListener('message', h); res(e.data.worker); }
        }));
        document.body.append(f);
        window.__sbx = { f, ready, n: 0 };
      }
      const s = window.__sbx;
      if (!(await s.ready)) return { ok: false, reason: 'no worker' };
      const id = ++s.n, nonce = crypto.randomUUID().replace(/-/g, '');
      return new Promise(res => {
        const t = setTimeout(() => { removeEventListener('message', h); res({ ok: false, reason: 'no reply within 12 s' }); }, 12000);
        function h(e) {
          if (e.source !== s.f.contentWindow || e.data?.nonce !== nonce) return;
          clearTimeout(t); removeEventListener('message', h);
          res(e.data.ok ? { ok: true, value: e.data.value, ms: e.data.ms } : { ok: false, reason: e.data.error, ms: e.data.ms });
        }
        addEventListener('message', h);
        s.f.contentWindow.postMessage({ id, nonce, code, inputs: JSON.stringify(inputs) }, '*');
      });
    }, [code, inputs, PREVIEW]);

    let r = await run('return 1 + 1');
    check('1 + 1 → 2', r.ok && r.value === 2, JSON.stringify(r));
    const sq = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    r = await run('return { bbox: bbox(input), km2: Math.round(areaKm2(input)) }', sq);
    check('the geo kit and `input` are there', r.ok && r.value.bbox.join() === '0,0,1,1' && r.value.km2 > 12000, JSON.stringify(r));
    r = await run('setTimeout(() => done("later"), 50)');
    check('done(value) answers asynchronously', r.ok && r.value === 'later', JSON.stringify(r));
    r = await run("try { await fetch('https://example.org/'); return 'fetched'; } catch (e) { return 'blocked: ' + e.name; }");
    check('fetch is blocked', r.ok && /^blocked/.test(r.value), JSON.stringify(r));
    r = await run("importScripts('https://example.org/x.js'); return 'loaded'");
    check('importScripts is blocked', !r.ok, JSON.stringify(r));
    r = await run("try { return eval('1'); } catch (e) { return 'blocked: ' + e.name; }");
    check('eval is blocked', r.ok && /^blocked: EvalError/.test(r.value), JSON.stringify(r));
    r = await run("try { indexedDB.open('x'); return 'opened'; } catch (e) { return 'blocked: ' + e.name; }");
    check('no storage (IndexedDB)', r.ok && /^blocked/.test(r.value), JSON.stringify(r));
    r = await run("return 'x'.repeat(1100000)");
    check('a result over 1 MB is refused', !r.ok && /1 MB/.test(r.reason), JSON.stringify(r).slice(0, 200));

    const t0 = await page.evaluate(() => window.__ticks), w0 = Date.now();
    r = await run('while (true) {}');
    const ticks = (await page.evaluate(() => window.__ticks)) - t0, wall = Date.now() - w0;
    check('while(true) is stopped at ~10 s', !r.ok && wall >= 9500 && wall < 12500, `${JSON.stringify(r)} wall=${wall} ms`);
    check('the page stays responsive meanwhile', ticks >= 0.8 * wall / 100, `${ticks} ticks of 100 ms in ${wall} ms`);
    r = await run('return 1 + 1');
    check('the sandbox runs again after a timeout', r.ok && r.value === 2, JSON.stringify(r));

    if (!PREVIEW) {
      r = await run('return 1', { big: 'x'.repeat(5 * 1024 * 1024) });
      check('input over 5 MB is refused', !r.ok && /5 MB/.test(r.reason), JSON.stringify(r));
      r = await run('return 1', { type: 'FeatureCollection', features: Array.from({ length: 50001 }, () => ({})) });
      check('input over 50 000 features is refused', !r.ok && /50001 features/.test(r.reason), JSON.stringify(r));
    }

    // The frame tries to navigate itself (CDP evaluates in it; model code never could: it runs in the worker).
    const frame = page.frames().find(f => f.url().endsWith('/sandbox.html'));
    check('the frame is from /sandbox.html', !!frame);
    const attr = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.getAttribute('sandbox')));
    check('its sandbox attribute is exactly allow-scripts', attr.length === 1 && attr[0] === 'allow-scripts', JSON.stringify(attr));
    await frame.evaluate(() => { location.href = 'https://example.org/'; }).catch(() => {});
    await page.waitForTimeout(2500);
    const urls = page.frames().map(f => f.url());
    if (PREVIEW) {
      check('self-navigation is blocked (frame-src \'self\')', !urls.some(u => u.startsWith('https://example.org')), urls.join(' , '));
    } else {
      r = await run('return 1 + 1');
      check('after the frame navigates away, the host makes a new one', r.ok && r.value === 2 && !page.frames().some(f => f.url().startsWith('https://example.org')), JSON.stringify(r));
    }
    log('refusals heard (expected):', refused.length, refused.map(t => t.slice(0, 110)).join(' | '));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await page.close();

    // A third-party page embeds /sandbox.html without the sandbox attribute: the
    // document then has the app's origin, so the runner must stay inert. The
    // control, a properly sandboxed frame, shows the same observers do hear a
    // ready and a worker. (Another origin on loopback, localhost ↔ 127.0.0.1:
    // Chromium's local network access checks refuse a public origin framing
    // localhost, and an opaque-origin frame under any origin but the app's. The launch turns those checks off
    // so the other loopback origin can frame the app.)
    const app = new URL(URL_BASE);
    const other = `${app.protocol}//${app.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${app.port}`;
    const embed = async (host, sandboxed) => {
      const p = await ctx.newPage();
      const url = host + '/__embed-test';
      await p.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>embed</title>' }));
      const workers = [];
      p.on('worker', w => workers.push(w.url()));
      await p.goto(url);
      const got = await p.evaluate(async ([src, sandboxed]) => {
        const got = [];
        const f = document.createElement('iframe');
        if (sandboxed) f.setAttribute('sandbox', 'allow-scripts');
        f.src = src;
        addEventListener('message', e => { if (e.source === f.contentWindow) got.push(e.data); });
        const loaded = new Promise(r => f.addEventListener('load', r, { once: true }));
        document.body.append(f);
        await loaded;
        await new Promise(r => setTimeout(r, 2000));
        return got;
      }, [URL_BASE + 'sandbox.html', sandboxed]);
      const f = p.frames().find(f => f.url().endsWith('/sandbox.html'));
      const origin = f ? await f.evaluate(() => self.origin).catch(e => 'error: ' + e.message) : 'no frame';
      await p.close();
      return { got, workers, origin };
    };
    const bare = await embed(other, false);
    check('unsandboxed embed: the frame has the app origin', bare.origin === app.origin, bare.origin);
    check('unsandboxed embed: no message arrives in 2 s (no ready)', bare.got.length === 0, JSON.stringify(bare.got));
    check('unsandboxed embed: no worker is created', bare.workers.length === 0, bare.workers.join(' , '));
    const control = await embed(app.origin, true);
    check('control: a sandboxed frame sends ready with a worker, and a worker is seen',
      control.origin === 'null' && control.got.length === 1 && control.got[0]?.type === 'ready' && control.got[0].worker === true && control.workers.length > 0,
      `${control.origin} ${JSON.stringify(control.got)} workers=${control.workers.length}`);
}
