// .claude/skills/drive-app/scenarios/chart.mjs
// The `chart` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW, OUT, log, check, mod, shot, inked, call, chatRig } from '../harness.mjs';

  // The chat's charts: a mocked model charts EIA capacity in Texas by fuel as
  // a bar and a pie and solar added per year as a line (runAnalysis with
  // `chart`, in the sandbox); the cards' PNG and CSV are downloaded and read
  // back. openrouter.ai is answered from fixtures only.
export default async function chart(ctx) {
    const TX = { kind: 'states', codes: ['TX'] };
    const EXISTING = [{ field: 'gen_status', op: '=', value: 'existing' }];
    const AGG = { layerId: 'eia-generators', area: TX, where: EXISTING, groupBy: 'energy_source', sum: ['nameplate_mw'] };
    const FUEL_IN = [{ layer: 'eia-generators', where: [{ field: 'states', op: 'contains', value: 'TX' }, ...EXISTING], fields: ['energy_source', 'nameplate_mw'], limit: 5000 }];
    const fuelCode = pie => [
      "const by = {};",
      "for (const f of input['eia-generators'].features) {",
      "  const k = f.properties.energy_source ?? '—';",
      "  by[k] = (by[k] || 0) + (Number(f.properties.nameplate_mw) || 0);",
      "}",
      "let top = Object.entries(by).sort((a, b) => b[1] - a[1]);",
      pie ? "if (top.length > 8) top = [...top.slice(0, 7), ['Other', top.slice(7).reduce((s, e) => s + e[1], 0)]];" : "",
      "return { title: 'Existing capacity in Texas by fuel', unit: 'MW', xLabel: 'Fuel',",
      "  categories: top.map(e => e[0]), series: [{ name: 'MW', values: top.map(e => Math.round(e[1] * 100) / 100) }] };",
    ].join('\n');
    const CODE = [
      "const by = {};",
      "for (const f of input['eia-generators'].features) {",
      "  const y = Number(f.properties.op_year), mw = Number(f.properties.nameplate_mw);",
      "  if (y >= 2012 && Number.isFinite(mw)) by[y] = (by[y] || 0) + mw;",
      "}",
      "const ys = Object.keys(by).sort();",
      "return { title: 'Solar capacity added in Texas by year', unit: 'MW', xLabel: 'op_year',",
      "  categories: ys, series: [{ name: 'nameplate_mw', values: ys.map(y => Math.round(by[y])) }] };",
    ].join('\n');
    const toolMsgs = [];
    function fixture(body) {
      const msgs = body?.messages ?? [];
      const u = msgs.map(m => m.role).lastIndexOf('user');
      const text = String(msgs[u]?.content ?? '').toLowerCase();
      const after = msgs.slice(u + 1).filter(m => m.role === 'tool');
      toolMsgs.push(...after.map(m => m.content));
      if (text.includes('by fuel')) {
        if (after.length === 0) return ({ tool_calls: [call('a1', 'runAnalysis', { code: fuelCode(false), chart: 'bar', inputs: FUEL_IN }), call('a2', 'runAnalysis', { code: fuelCode(true), chart: 'pie', inputs: FUEL_IN })] });
        if (after.length === 2) return ({ content: 'Gas leads Texas capacity; the charts are above.' });
      }
      if (text.includes('solar by year')) {
        if (after.length === 0) return ({ tool_calls: [call('b1', 'runAnalysis', { code: CODE, chart: 'line', inputs: [{ layer: 'eia-generators',
          where: [{ field: 'states', op: 'contains', value: 'TX' }, { field: 'energy_source', op: '=', value: 'SUN' }], fields: ['op_year', 'nameplate_mw'] }] })] });
        if (after.length === 1) return ({ content: 'Solar additions by year are charted.' });
      }
      return null;
    }
    // A taller drawer (the rig drags the grip up), so a whole card fits in a screenshot.
    const rig = await chatRig(ctx, fixture, { viewport: { width: 1400, height: 1300 } });
    const { page, errors, unrouted, say } = rig;
    await say('chart existing capacity in texas by fuel');
    const cards = await page.$$eval('.chat-chart', fs => fs.map(f => ({ type: f.dataset.type, title: f.querySelector('figcaption').textContent, aria: f.querySelector('canvas').getAttribute('aria-label') })));
    check('two runAnalysis chips, both done', JSON.stringify(await page.$$eval('.chat-chip:not(.chat-code)[data-tool="runAnalysis"]', cs => cs.map(c => c.dataset.ok))) === '["true","true"]');
    check('a bar and a pie card follow them', cards.map(x => x.type).join(',') === 'bar,pie', JSON.stringify(cards.map(x => x.type)));
    check('the cards are titled from the value', cards.every(x => x.title === 'Existing capacity in Texas by fuel'), cards[0]?.title);
    check('the bar leads with NG', /: NG /.test(cards[0]?.aria ?? ''), cards[0]?.aria);
    check('both canvases drew', (await inked(page, '.chat-chart[data-type="bar"] canvas')) > 1000 && (await inked(page, '.chat-chart[data-type="pie"] canvas')) > 1000);
    const shown = toolMsgs.filter(m => m.includes('chartShown'));
    check('the model is told the chart was shown, and not sent it', shown.length >= 2 && toolMsgs.every(m => !m.includes('"chart":{')), `${shown.length} of ${toolMsgs.length}`);
    await page.$eval('.chat-chart[data-type="bar"]', f => f.scrollIntoView({ block: 'start' }));
    await shot(page, 'chart-1-bar');
    await page.$eval('.chat-chart[data-type="pie"]', f => f.scrollIntoView({ block: 'start' }));
    await shot(page, 'chart-2-pie');

    // Downloads: PNG and CSV of the bar.
    const save = async btn => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
      const file = path.join(OUT, 'chart-dl-' + dl.suggestedFilename());
      await dl.saveAs(file);
      return { name: dl.suggestedFilename(), file, buf: fs.readFileSync(file) };
    };
    const png = await save('.chat-chart[data-type="bar"] .chat-chart-png');
    const sig = png.buf.subarray(0, 8).toString('hex');
    const w = png.buf.readUInt32BE(16), h = png.buf.readUInt32BE(20);
    check('PNG: a real PNG, 1760 px wide (880 at 2×), named from the title', sig === '89504e470d0a1a0a' && w === 1760 && h > 200 && /-bar\.png$/.test(png.name), `${png.name} ${w}×${h}`);
    log('saved', png.file);
    const csv = await save('.chat-chart[data-type="bar"] .chat-chart-csv');
    const text = csv.buf.toString('utf8');
    const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    check('CSV: BOM, header Fuel,MW', text.charCodeAt(0) === 0xFEFF && lines[0] === 'Fuel,MW', lines[0]);
    check('CSV: NG row first, numbers, then the title and the EIA source rows', /^NG,\d/.test(lines[1] ?? '') && lines.slice(1).some(l => l === 'Existing capacity in Texas by fuel (MW)') && /Source: .*EIA/.test(lines.at(-1)), lines.slice(1, 3).join(' | ') + ' … ' + lines.at(-1));
    check('CSV: no unguarded = + @ - cell', lines.every(l => !/(^|,)[=+@-]/.test(l)));
    if (!PREVIEW) {
      const want = await mod(page, '/assets/dataset-query.ts', async (m, a) => {
        const r = await m.aggregate(a.layerId, { area: a.area, where: a.where, groupBy: a.groupBy, sum: a.sum });
        return r.ok ? r.result.groups.reduce((s, g) => s + (g.sums.nameplate_mw ?? 0), 0) : null;
      }, AGG);
      const got = lines.slice(1).filter(l => /^[^,]+,-?[\d.]+$/.test(l)).reduce((s, l) => s + Number(l.split(',').at(-1)), 0);
      check('CSV: its rows sum to aggregate() over the same options', typeof want === 'number' && Math.abs(got - want) < 0.01 * lines.length, `${got} vs ${want}`);
    }
    log('saved', csv.file);

    await say('chart solar by year');
    check('the analysis code shows before its chip', await page.$$eval('.chat-code', x => x.length) === 3 && /Solar capacity added/.test(await page.$$eval('.chat-code pre', x => x.at(-1)?.textContent ?? '')));
    const ra = await page.$$eval('.chat-chip:not(.chat-code)[data-tool="runAnalysis"]', cs => cs.map(c => [c.dataset.ok, c.querySelector('.chat-chip-why')?.textContent ?? '']));
    check('runAnalysis chip done', ra.length === 3 && ra[2][0] === 'true', JSON.stringify(ra));
    check('a line card follows it', await page.$$eval('.chat-chart[data-type="line"]', x => x.length) === 1);
    check('the line canvas drew', (await inked(page, '.chat-chart[data-type="line"] canvas')) > 500);
    await page.$eval('.chat-chart[data-type="line"]', f => f.scrollIntoView({ block: 'start' }));
    await shot(page, 'chart-3-line');
    const pie = await save('.chat-chart[data-type="pie"] .chat-chart-png');
    log('saved', pie.file);

    // A phone-width window: the cards redraw at the new width, the pie's legend below it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const fit = await page.$$eval('.chat-chart canvas', cs => cs.map(cv => [Math.round(cv.getBoundingClientRect().width), Math.round(cv.width / (devicePixelRatio || 1))]));
    check('phone width: every canvas redrawn to its card (no overflow)', fit.every(([w, px]) => w <= 390 && Math.abs(px - w) <= 1), JSON.stringify(fit));
    await page.$eval('.chat-chart[data-type="pie"]', f => f.scrollIntoView({ block: 'start' }));
    await shot(page, 'chart-4-phone-pie');

    check('every openrouter.ai request matched a fixture', unrouted.length === 0, unrouted.join(' | '));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await rig.close();
}
