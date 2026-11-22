// .claude/skills/drive-app/scenarios/area.mjs
// The `area` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { CAM, log, check, open, settle, mod, st, hashFor, shot, hashOf, paramsOf, reset } from '../harness.mjs';

  // An Area link filters HIFLD lines by state and OSM lines by admin-1;
  // a second state picked in the field adds to it, Undo takes it back, Reset
  // clears it, and the ERCOT story sets a BA area that an edit leaves the story.
export default async function area(ctx) {
    const TX_CAM = '5.4/31.2/-99.4';
    // Every map layer of `layerId` on the map → its filter, as JSON.
    const filters = (page, layerId) => page.evaluate(async id => {
      const { state } = await import('/assets/state.ts');
      const { layerById, LAYERS } = await import('/src/registry/index.ts');
      return Object.fromEntries(layerById(id).mapLayerIds
        .filter(ml => state.map.getLayer(ml))
        .map(ml => [ml, JSON.stringify(state.map.getFilter(ml) ?? null)]));
    }, layerId);
    const allHave = (f, s) => Object.keys(f).length > 0 && Object.values(f).every(v => v.includes(s));
    const noneHave = (f, s) => Object.values(f).every(v => !v.includes(s));
    const flagShown = (page, id) => page.evaluate(i => {
      const el = document.querySelector(`[data-area-flag="${i}"]`);
      return !!el && !el.hidden;
    }, id);
    const chips = page => page.evaluate(() => document.getElementById('areaChips')?.textContent ?? '');
    const areaOf = async page => JSON.stringify(await st(page, 'state.area'));

    const probe = await open(ctx, TX_CAM);
    const layers = {
      ...(await st(probe.page, 'state.layerVisibility')),
      'hifld-transmission-lines': true, 'osm-transmission-lines': true, padus: true,
    };
    const plain = await hashFor(probe.page, { layerVisibility: layers }, TX_CAM);
    const linked = await hashFor(probe.page,
      { layerVisibility: layers, area: { kind: 'states', codes: ['TX'] } }, TX_CAM);
    await probe.page.close();
    log('area link', linked);

    // The same layers without an area: the filters Reset must come back to.
    const base = await open(ctx, plain);
    const baseHifld = await filters(base.page, 'hifld-transmission-lines');
    const baseOsm = await filters(base.page, 'osm-transmission-lines');
    await base.page.close();

    // (1) The link.
    const { page, errors } = await open(ctx, linked);
    check('link sets area TX', (await areaOf(page)) === '{"kind":"states","codes":["TX"]}');
    const hifld = await filters(page, 'hifld-transmission-lines');
    const osm = await filters(page, 'osm-transmission-lines');
    check('every HIFLD line layer filters on |TX|', allHave(hifld, '|TX|'), `${Object.keys(hifld).length} layers`);
    check('every OSM band layer filters on |USAB|', allHave(osm, '|USAB|'), `${Object.keys(osm).length} layers`);
    check('the Area row shows Texas', (await chips(page)).includes('Texas'), await chips(page));
    check('the PAD-US row shows the not-filtered flag', await flagShown(page, 'padus'));
    check('the HIFLD row shows no flag', !(await flagShown(page, 'hifld-transmission-lines')));
    await shot(page, 'area-1-texas-link');

    // (2) New Mexico picked in the field adds to Texas.
    await page.click('#areaInput');
    await page.keyboard.type('new mexico', { delay: 40 });
    await page.waitForSelector('#areaOpt0');
    await page.waitForTimeout(300);
    check('first result is New Mexico', (await page.textContent('#areaOpt0')).includes('New Mexico'));
    await page.keyboard.press('Enter');
    await settle(page);
    check('pick adds NM', (await areaOf(page)) === '{"kind":"states","codes":["NM","TX"]}');
    check('link has af=s.NM.TX', paramsOf(await hashOf(page)).includes('af=s.NM.TX'), await hashOf(page));
    check('HIFLD lines filter on |NM| too', allHave(await filters(page, 'hifld-transmission-lines'), '|NM|'));
    await page.evaluate(() => document.activeElement?.blur());

    // (3) Undo.
    await mod(page, '/assets/undo.ts', m => m.undo());
    await settle(page);
    const undone = paramsOf(await hashOf(page));
    check('Undo → af=s.TX', /(^|&)af=s\.TX(&|$)/.test(undone), undone);
    check('Undo repaints the Area row', !(await chips(page)).includes('New Mexico'), await chips(page));

    // (4) Reset.
    await reset(page);
    check('Reset clears the area', (await st(page, 'state.area')) === null);
    check('Reset drops af from the link', !(await hashOf(page)).includes('af='), await hashOf(page));
    check('Reset hides the PAD-US flag', !(await flagShown(page, 'padus')));
    check('Reset empties the Area row', (await chips(page)).trim() === '', await chips(page));
    const resetHifld = await filters(page, 'hifld-transmission-lines');
    const resetOsm = await filters(page, 'osm-transmission-lines');
    check('HIFLD filters back to base', noneHave(resetHifld, '|TX|')
      && Object.entries(resetHifld).every(([k, v]) => !(k in baseHifld) || baseHifld[k] === v));
    check('OSM filters back to base', noneHave(resetOsm, '|USAB|')
      && Object.entries(resetOsm).every(([k, v]) => !(k in baseOsm) || baseOsm[k] === v));
    await shot(page, 'area-2-after-reset');
    check('no console errors', errors.length === 0, errors.join(' | '));
    await page.close();

    // (5) The ERCOT story.
    const story = await open(ctx, CAM + '?exp=ercot-island-grid');
    const sp = story.page;
    await settle(sp);
    check('story sets area BA ERCO', (await areaOf(sp)) === '{"kind":"ba","codes":["ERCO"]}');
    check('story link keeps exp and af', /exp=ercot-island-grid/.test(await hashOf(sp))
      && paramsOf(await hashOf(sp)).includes('af=b.ERCO'), await hashOf(sp));
    const storyHifld = await filters(sp, 'hifld-transmission-lines');
    check('HIFLD lines filter on |ERCO| and 345 kV', allHave(storyHifld, '|ERCO|') && allHave(storyHifld, '345'));
    check('generators filter on |ERCO|', allHave(await filters(sp, 'eia-generators'), '|ERCO|'));
    check('the Area row names ERCOT', (await chips(sp)).includes('ERCOT'), await chips(sp));
    check('the BA boundary row shows the flag', await flagShown(sp, 'eia-ba'));
    await shot(sp, 'area-3-ercot-story');
    await mod(sp, '/assets/visibility.ts', m => m.setLayerVisibility('railroads', true));
    await settle(sp);
    check('an edit drops exp from the link', !(await hashOf(sp)).includes('exp='), await hashOf(sp));
    check('the edit keeps the area', paramsOf(await hashOf(sp)).includes('af=b.ERCO'));
    check('no console errors (story)', story.errors.length === 0, story.errors.join(' | '));
}
