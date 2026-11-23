// .claude/skills/drive-app/scenarios/vega.mjs
// The `vega` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW, OUT, log, check, mod, inked, call, chatRig } from '../harness.mjs';

  // Vega-Lite charts: a model's `chart` object on runAnalysis, drawn in the
  // canvas frame (public/canvas.html). Layer: HIFLD natural-gas facilities (a
  // whole GeoJSON file, published too), counted by fac_type in the sandbox.
export default async function vega(ctx) {
    const LAYER = 'hifld-natgas-points';
    const S6 = 'https://vega.github.io/schema/vega-lite/v6.json';
    const BAR = { $schema: S6, title: 'Natural-gas facilities by type', mark: { type: 'bar', tooltip: true },
      encoding: { x: { field: 'group', type: 'nominal', sort: '-y', title: 'Facility type' }, y: { field: 'count', type: 'quantitative', title: 'Facilities' } } };
    const SCATTER = { title: 'Gas facilities: longitude vs latitude', layer: [
      { mark: { type: 'point', filled: true, tooltip: true }, encoding: { x: { field: 'lon', type: 'quantitative', scale: { zero: false } },
        y: { field: 'lat', type: 'quantitative', scale: { zero: false } }, color: { field: 'type', type: 'nominal' } } },
      { mark: { type: 'rule', color: 'firebrick', strokeDash: [4, 3] }, encoding: { y: { aggregate: 'mean', field: 'lat' } } }] };
    const CODE = "return input['hifld-natgas-points'].features.filter(f => f.geometry && f.geometry.type === 'Point')\n"
      + "  .map(f => ({ lon: +f.geometry.coordinates[0].toFixed(3), lat: +f.geometry.coordinates[1].toFixed(3), type: f.properties.fac_type }));";
    const URLSPEC = { data: { url: 'https://example.org/evil.csv' }, mark: 'bar', encoding: { x: { field: 'group', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } } };
    const FIXED = { mark: 'bar', title: 'Facilities by type (fixed spec)', encoding: { x: { field: 'group', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } } };
    const INVALID = { mark: 'blob', encoding: { x: { field: 'group', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } } };
    const GROUPS = "const by = {};\nfor (const f of input['hifld-natgas-points'].features) { const k = f.properties.fac_type ?? '—'; by[k] = (by[k] || 0) + 1; }\n"
      + "return Object.entries(by).map(([group, count]) => ({ group, count }));";
    const agg = chart => ({ code: GROUPS, chart, inputs: [{ layer: LAYER, fields: ['fac_type'] }] });
    function fixture(body) {
      const msgs = body?.messages ?? [];
      const u = msgs.map(m => m.role).lastIndexOf('user');
      const text = String(msgs[u]?.content ?? '').toLowerCase();
      const n = msgs.slice(u + 1).filter(m => m.role === 'tool').length;
      if (text.includes('of each type')) {
        if (n === 0) return { tool_calls: [call('v1', 'runAnalysis', agg(BAR))] };
        if (n === 1) return { content: 'Petroleum terminals lead; the chart is above.' };
      }
      if (text.includes('scatter')) {
        if (n === 0) return { tool_calls: [call('v2', 'runAnalysis', { code: CODE, chart: SCATTER, inputs: [{ layer: LAYER, fields: ['fac_type'], limit: 400 }] })] };
        if (n === 1) return { content: 'Here is where they sit.' };
      }
      if (text.includes('from a url')) {
        if (n === 0) return { tool_calls: [call('v3', 'runAnalysis', agg(URLSPEC))] };
        if (n === 1) return { tool_calls: [call('v4', 'runAnalysis', agg(FIXED))] };
        if (n === 2) return { content: 'Fixed: the page adds the data.' };
      }
      if (text.includes('blob chart')) {
        if (n === 0) return { tool_calls: [call('v5', 'runAnalysis', agg(INVALID))] };
        if (n === 1) return { content: 'That mark does not exist.' };
      }
      return null;
    }
    const rig = await chatRig(ctx, fixture);
    const { page } = rig;

    // 1 · runAnalysis counting by type, with a bar spec (tooltip).
    // A question goes to the model (local-commands.ts answers only imperative chart asks, such as
    // "chart gas facilities by type", with a template).
    await rig.say('how many gas facilities of each type?');
    check('runAnalysis chip done', JSON.stringify(await page.$$eval('.chat-chip:not(.chat-code)[data-tool="runAnalysis"]', cs => cs.map(c => c.dataset.ok))) === '["true"]');
    const card1 = await page.$$eval('.chat-canvas', cs => cs.map(c => ({ kind: c.dataset.kind, label: c.querySelector('.chat-canvas-label')?.textContent,
      title: c.querySelector('.chat-canvas-title')?.textContent, sandbox: c.querySelector('iframe')?.getAttribute('sandbox'), src: c.querySelector('iframe')?.getAttribute('src') })));
    check('one vega card in the labelled frame', card1.length === 1 && card1[0].kind === 'vega' && card1[0].label === 'Made by the model · runs in a sandbox'
      && card1[0].sandbox === 'allow-scripts' && /canvas\.html$/.test(card1[0].src ?? ''), JSON.stringify(card1));
    check('the card is titled from the spec', card1[0]?.title === BAR.title, card1[0]?.title);
    const f1 = await rig.cardFrame(0);
    check('the frame is an opaque origin', await f1?.evaluate(() => self.origin).catch(e => e.message) === 'null');
    check('the bar chart drew', (await inked(f1).catch(() => 0)) > 2000, String(await inked(f1).catch(() => 0)));
    // The tooltip: Vega's default handler sets a title on its container while hovering a mark.
    const box = await (await page.$('.chat-canvas iframe')).boundingBox();
    let tip = null;
    for (let x = box.x + 60; x < box.x + box.width - 10 && !tip; x += 12) {
      await page.mouse.move(x, box.y + box.height * 0.66);
      tip = await f1.evaluate(() => document.querySelector('[title]')?.getAttribute('title') ?? null).catch(() => null);
    }
    check('hovering a bar shows its tooltip (the encoding titles and values)', /^Facility type: .+\nFacilities: [\d,]+$/.test(tip ?? ''), JSON.stringify(tip));
    await rig.cardShot(0, 'vega-1-bar');

    const dl = async (btn, want) => {
      const before = rig.downloads.length;
      await page.click(btn);
      const end = Date.now() + 15000;
      while (rig.downloads.length === before && Date.now() < end) await page.waitForTimeout(100);
      const d = rig.downloads[before];
      if (!d) return null;
      const file = path.join(OUT, 'vega-dl-' + d.suggestedFilename());
      await d.saveAs(file);
      return { name: d.suggestedFilename(), file, buf: fs.readFileSync(file), want };
    };
    const png = await dl('.chat-canvas .chat-canvas-png');
    const sig = png?.buf.subarray(0, 8).toString('hex');
    const pw = png?.buf.readUInt32BE(16), ph = png?.buf.readUInt32BE(20);
    check('PNG: a real PNG at 2×, named .png', sig === '89504e470d0a1a0a' && pw > 800 && ph > 200 && /\.png$/.test(png?.name ?? ''), `${png?.name} ${pw}×${ph}`);
    const csv = await dl('.chat-canvas .chat-canvas-csv');
    const text = csv?.buf.toString('utf8') ?? '';
    const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    const body = lines.slice(1).filter(l => /^[^,]+,\d+$/.test(l));
    check('CSV: BOM, header group,count, then the title and source rows', text.charCodeAt(0) === 0xFEFF && lines[0] === 'group,count'
      && lines.at(-2) === BAR.title && /^Source: .*(HIFLD|EIA)/.test(lines.at(-1)), `${lines[0]} … ${lines.at(-2)} | ${lines.at(-1)}`);
    check('CSV: no unguarded = + @ - cell', lines.every(l => !/(^|,)[=+@-]/.test(l)));
    // The rows equal the injected rows: the value the model was told (both modes), and (dev) aggregate()'s groups.
    const told = JSON.parse(rig.toolMsgs().get('v1') ?? '{}').data;
    const fromTold = (Array.isArray(told?.value) ? told.value : []).map(g => `${g.group},${g.count}`).sort();
    check('CSV rows = the rows the model was told', told && body.slice().sort().join('|') === fromTold.join('|') && body.length >= 3, `${body.length} rows vs ${fromTold.length}`);
    if (!PREVIEW) {
      const want = await mod(page, '/assets/query/dataset-query.ts', async (q, layer) => {
        const r = await q.aggregate(layer, { groupBy: 'fac_type' });
        return r.ok ? r.result.groups.map(g => `${g.key ?? '—'},${g.count}`) : null;
      }, LAYER);
      check('CSV rows = aggregate() groups (dev)', want && want.slice().sort().join('|') === body.slice().sort().join('|'), `${want?.length} vs ${body.length}`);
    }
    check('the model is told chartShown, not the spec or rows', /"chartShown":true/.test(rig.toolMsgs().get('v1') ?? ''));

    // 2 · runAnalysis with a layered scatter + rule over flat rows.
    await rig.say('a scatter of where the facilities are');
    check('the analysis code shows before its chip, then a vega card', await page.$$eval('#td-ask .chat-code[data-tool="runAnalysis"]', x => x.length) === 2
      && await page.$$eval('.chat-canvas[data-kind="vega"]', x => x.length) === 2);
    const f2 = await rig.cardFrame(-1);
    check('the layered scatter drew', (await inked(f2).catch(() => 0)) > 1500, String(await inked(f2).catch(() => 0)));
    check('runAnalysis tool message: chartShown', /"chartShown":true/.test(rig.toolMsgs().get('v2') ?? ''), (rig.toolMsgs().get('v2') ?? '').slice(0, 160));
    await rig.cardShot(-1, 'vega-2-scatter');

    // 3 · a spec with data.url: refused page-side, the model fixes it once.
    const cardsBefore = await page.$$eval('.chat-canvas', x => x.length);
    await rig.say('chart them from a url');
    const t3 = rig.toolMsgs().get('v3') ?? '';
    check('data.url refused before any frame: a fixable reason in the next tool message', /"error":"the chart was not shown: remove \\"data(\.url)?\\": send no data/.test(t3), t3);
    check('the fixed spec draws one card (the refused one drew none)', await page.$$eval('.chat-canvas', x => x.length) === cardsBefore + 1
      && /"chartShown":true/.test(rig.toolMsgs().get('v4') ?? ''));
    check('the refused call shows a failed chip with the reason', await page.$$eval('.chat-chip:not(.chat-code)[data-tool="runAnalysis"][data-ok="false"] .chat-chip-why', x => x.map(e => e.textContent).join()).then(s => /remove "data/.test(s)));
    await rig.cardShot(-1, 'vega-3-fixed');

    // 4 · a spec Vega-Lite cannot compile: invalid-spec with its message.
    await rig.say('a blob chart please');
    const t5 = JSON.parse(rig.toolMsgs().get('v5') ?? '{}').data ?? {};
    check('invalid spec → chartError invalid-spec with a chartMessage', t5.chartError === 'invalid-spec' && typeof t5.chartMessage === 'string' && t5.chartMessage.length > 3
      && t5.chartMessage.length <= 300, JSON.stringify({ e: t5.chartError, m: t5.chartMessage }));
    const err4 = await page.$$eval('.chat-canvas', cs => cs.at(-1)?.querySelector('.chat-canvas-error')?.textContent ?? '');
    check('the card shows the refusal to the visitor', /chart spec was refused/.test(err4), err4);
    await rig.cardShot(-1, 'vega-4-invalid');

    // What reached the model: tool messages small, never a spec or injected rows.
    const tools = [...rig.toolMsgs().values()];
    check('tool messages ≤ 8 KB, none carrying a spec or data.values', tools.length === 5 && tools.every(m => m.length <= 8192
      && !/"\$schema"|"mark"|"encoding"|"values":\[/.test(m)), `${tools.length} msgs, max ${Math.max(...tools.map(m => m.length))} B`);
    check('every openrouter.ai request matched a fixture', rig.unrouted.length === 0, rig.unrouted.join(' | '));
    check('every request asks the default model, anthropic/claude-haiku-5.5', rig.models.length === 0, rig.models.join(' , '));
    log('frame console (filtered, expected):', rig.frame.length, rig.frame.map(t => t.slice(0, 120)).join(' | '));
    check('no console errors (the page\'s own)', rig.errors.length === 0, rig.errors.join(' | '));
    await rig.close();
}
