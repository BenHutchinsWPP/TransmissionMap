// .claude/skills/drive-app/scenarios/vx.mjs
// The `vx` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { log, check, open, st, hashFor, shot, visibleNotices, hashOf, reset } from '../harness.mjs';

  // A vx link filters transmission to >= 345 kV and paints railroads red;
  // Reset clears both sections from state, the map and the link.
export default async function vx(ctx) {
    const probe = await open(ctx);
    const layers = { ...(await st(probe.page, 'state.layerVisibility')), 'osm-transmission-lines': true, railroads: true };
    const plain = await hashFor(probe.page, { layerVisibility: layers });
    const linked = await hashFor(probe.page, {
      layerVisibility: layers,
      where: { 'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: 345 }] },
      style: { railroads: { color: '#ff0000', size: 3 } },
    });
    await probe.page.close();
    log('vx link', linked, `(${linked.length} chars)`);

    const before = await open(ctx, plain);
    await shot(before.page, 'vx-1-without');
    await before.page.close();

    const { page, errors } = await open(ctx, linked);
    check('where applied', JSON.stringify(await st(page, 'state.where')).includes('"nominal_kv"'));
    check('railroads line-color is the override',
      (await st(page, "state.map.getPaintProperty('railroads', 'line-color')")) === '#ff0000');
    check('link keeps vx', (await hashOf(page)).includes('vx='));
    check('no dropped-settings notice', (await visibleNotices(page)).length === 0);
    await shot(page, 'vx-2-with');
    await reset(page);
    check('Reset clears where', JSON.stringify(await st(page, 'state.where')) === '{}');
    check('Reset clears style', JSON.stringify(await st(page, 'state.styleOverrides')) === '{}');
    check('Reset drops vx from the link', !(await hashOf(page)).includes('vx='));
    await shot(page, 'vx-3-after-reset');
    check('no console errors', errors.length === 0, errors.join(' | '));
}
