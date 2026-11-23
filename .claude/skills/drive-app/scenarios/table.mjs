// .claude/skills/drive-app/scenarios/table.mjs
// The `table` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { URL_BASE, OUT, check, open, settle, mod, st, hashFor, shot, hashOf, paramsOf, openTable, reset } from '../harness.mjs';

  // The table drawer over EIA generators with the Area set to Texas: the
  // summary against aggregate(), a sort, the CSV, keyboard moves, a row click
  // that lands above the drawer, three rows selected → isolate/keep from the
  // chip's menu → Undo → Reset; the size note before a > 2 MiB file; the
  // popup's "Show in table"; then the same drawer as a phone bottom sheet.
export default async function table(ctx) {
    const TX_CAM = '5.4/31.2/-99.4';
    const GEN = 'eia-generators';
    const withInit = async opts => {
      const c = await ctx.browser().newContext({ acceptDownloads: true, ...opts });
      // The range copy is read back from the clipboard.
      await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(URL_BASE).origin });
      return c;
    };
    // The grid is Tabulator: its scroller takes focus, its header holds the
    // sort and ▾ buttons, a cell's column is its tabulator-field (f0, f1, …).
    const HOLDER = '.td-grid .tabulator-tableholder';
    const colCells = (page, field, n = 5) => page.evaluate(([f, k]) => {
      const key = document.querySelector(`.td-grid .tabulator-col:has([data-sort="${f}"])`)?.getAttribute('tabulator-field');
      return [...document.querySelectorAll('.td-row')].sort((a, b) => a.dataset.i - b.dataset.i).slice(0, k)
        .map(r => r.querySelector(`.tabulator-cell[tabulator-field="${key}"]`)?.textContent ?? '');
    }, [field, n]);
    const desk = await withInit({ viewport: { width: 1440, height: 900 } });
    const probe = await open(desk, TX_CAM);
    const layers = { ...(await st(probe.page, 'state.layerVisibility')), [GEN]: true };
    const link = await hashFor(probe.page, { layerVisibility: layers, area: { kind: 'states', codes: ['TX'] } }, TX_CAM);
    await probe.page.close();

    const { page, errors } = await open(desk, link);
    const rows = () => page.locator('.td-row');
    await openTable(page, GEN);
    await page.waitForSelector('.td-row', { timeout: 30000 });
    await settle(page);

    // (1) Summary = aggregate() over the same options (the layer is on, so asDrawn).
    const expected = await mod(page, '/assets/query/dataset-query.ts', async m => {
      const r = await m.aggregate('eia-generators', { asDrawn: true, groupBy: 'energy_source', sum: ['nameplate_mw'] });
      const sum = r.result.groups.reduce((a, g) => a + g.sums.nameplate_mw, 0);
      const gas = r.result.groups.filter(g => g.key === 'NG' || g.key === 'OG').reduce((a, g) => a + g.sums.nameplate_mw, 0);
      return { sum, gas, total: r.result.total };
    });
    const shown = await page.evaluate(() => ({
      total: document.querySelector('.td-total').textContent,
      sub: document.querySelector('.td-total-sub').textContent,
      gas: document.querySelector('[data-bar="gas"] .td-bar-val')?.textContent,
      pills: [...document.querySelectorAll('.td-pill')].map(p => p.textContent),
    }));
    const gw = n => `${(n / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} GW`;
    check('summary total = aggregate sum', shown.total === gw(expected.sum), `${shown.total} vs ${gw(expected.sum)}`);
    check('summary rows = aggregate total', shown.sub === `${expected.total.toLocaleString('en')} rows`, shown.sub);
    check('Gas bar = NG + OG', shown.gas === gw(expected.gas), `${shown.gas} vs ${gw(expected.gas)}`);
    check('pills name the map and Texas', shown.pills.some(p => p.includes('Texas')) && shown.pills.some(p => /map/i.test(p)), shown.pills.join(' | '));
    check('a pill names the drawn statuses', shown.pills.includes('Status: Existing, Planned Retirement'), shown.pills.join(' | '));
    check('rows sorted by MW, descending', await page.getAttribute('[role=columnheader]:has([data-sort="nameplate_mw"])', 'aria-sort') === 'descending');
    check('virtualised: far fewer row nodes than rows', (await rows().count()) < 120, `${await rows().count()} nodes`);
    await shot(page, 'table-1-open-desk');

    // (2) Sort ascending, then by plant name.
    await page.click('[data-sort="nameplate_mw"]');
    await page.waitForFunction(() => document.querySelector('[role=columnheader]:has([data-sort="nameplate_mw"])')?.getAttribute('aria-sort') === 'ascending');
    await page.waitForTimeout(300);
    const firstMw = (await colCells(page, 'nameplate_mw')).map(t => Number(t.replace(/,/g, '')));
    check('ascending sort', firstMw.every((v, i) => i === 0 || v >= firstMw[i - 1]), firstMw.join(','));
    await page.click('[data-sort="nameplate_mw"]');
    await page.waitForFunction(() => document.querySelector('[role=columnheader]:has([data-sort="nameplate_mw"])')?.getAttribute('aria-sort') === 'descending');

    // (3) CSV: header, formula guard, credit row.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.td-csv')]);
    const csvPath = path.join(OUT, 'table-eia.csv');
    await dl.saveAs(csvPath);
    const raw = fs.readFileSync(csvPath, 'utf8');
    check('CSV starts with a UTF-8 BOM', raw.charCodeAt(0) === 0xFEFF);
    const csv = raw.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    const nRows = await page.evaluate(() => document.querySelector('.td-count').textContent);
    check('CSV header starts with plant_name', csv[0].startsWith('plant_name,'), csv[0].slice(0, 80));
    check('CSV credit row last', /^"?Source: /.test(csv.at(-1)) && /EIA/.test(csv.at(-1)), csv.at(-1));
    check('CSV filter note before the credit', /^"?Filters: .*Status: Existing, Planned Retirement/.test(csv.at(-2)) && csv.at(-2).includes('Texas'), csv.at(-2));
    check('CSV row count = table rows', `${(csv.length - 3).toLocaleString('en')} rows` === nRows || nRows.startsWith((csv.length - 3).toLocaleString('en')), `${csv.length - 3} vs ${nRows}`);
    check('CSV has no unguarded formula cell', !csv.slice(1, -2).some(l => /(^|,)"?[=+@]/.test(l)));

    check('CSV keeps every column, hidden ones too', ['utility_name', 'counties', 'fid'].every(c => csv[0].split(',').includes(c)), csv[0]);

    // (3b) Columns: the default set, a toggle off and on, All, Default; Esc
    // closes the panel (not the drawer) and returns focus to the button.
    const heads = () => page.evaluate(() => [...document.querySelectorAll('.td-grid .tabulator-col [data-sort]')].map(b => b.dataset.sort));
    check('default columns: 8 shown', (await heads()).length === 8 && (await page.textContent('.td-cols-n')) === '8/22', `${(await heads()).join(',')} · ${await page.textContent('.td-cols-n')}`);
    await page.click('.td-cols');
    check('Columns opens a panel with grouped checkboxes', await page.isVisible('#td-colpanel') && (await page.locator('#td-colpanel fieldset').count()) >= 3);
    await shot(page, 'table-9-columns-desk');
    await page.click('#td-colpanel [data-col="gen_status"]');
    check('unchecking a column hides it', !(await heads()).includes('gen_status') && (await heads()).length === 7);
    await page.click('#td-colpanel [data-col="gen_status"]');
    check('checking it shows it again', (await heads()).includes('gen_status'));
    await page.click('.td-cols-all');
    check('All shows 22', (await heads()).length === 22);
    await page.click('.td-cols-default');
    check('Default goes back to 8', (await heads()).length === 8);
    await page.focus('#td-colpanel [data-col="plant_name"]');
    await page.keyboard.press('Escape');
    check('Esc closes the panel, keeps the drawer, focuses the button',
      await page.isHidden('#td-colpanel') && await page.isVisible('.table-drawer')
      && await page.evaluate(() => document.activeElement?.classList.contains('td-cols')));

    // (4) Keyboard: the range starts at the first row; ↓↓ → row 3 active
    // (the range's one row); Space checks it; Enter flies.
    // The first data cell (the check and zoom columns come before it).
    await page.click('.td-row[data-i="0"] .tabulator-cell:nth-child(3)');
    await settle(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.td-row--active')?.dataset.i === '2', null, { timeout: 3000 }).catch(() => {});
    check('↓↓ makes row 3 active', await page.evaluate(() => document.querySelector('.td-row--active')?.dataset.i) === '2',
      await page.evaluate(() => document.querySelector('.td-row--active')?.dataset.i));
    await page.keyboard.press(' ');
    check('Space checks the active row', await page.getAttribute('.td-row[data-i="2"]', 'aria-selected') === 'true');
    const before = await st(page, 'state.map.getCenter().toArray()');
    await page.keyboard.press('Enter');
    await settle(page);
    const after = await st(page, 'state.map.getCenter().toArray()');
    check('Enter flies to the row', before.join() !== after.join(), `${before} → ${after}`);

    // (5) A row click flies and lands above the drawer, padding not kept.
    await page.locator('.td-row[data-i="0"] .tabulator-cell').nth(1).click();
    await settle(page);
    const landed = await page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      const m = state.map;
      const hl = (await m.getSource('highlight-pts').getData()).features;
      const pt = hl[0] && m.project(hl[0].geometry.coordinates);
      const drawerTop = document.querySelector('.table-drawer').getBoundingClientRect().top - m.getContainer().getBoundingClientRect().top;
      return { y: pt?.y, drawerTop, hl: hl.length, pad: m.getPadding() };
    });
    check('row click highlights the feature', landed.hl >= 1);
    check('the feature lands above the drawer', landed.y !== undefined && landed.y < landed.drawerTop, `y ${landed.y} < ${landed.drawerTop}`);
    check('camera padding is not kept', Object.values(landed.pad).every(v => v === 0), JSON.stringify(landed.pad));
    await shot(page, 'table-2-row-flown');

    // (5b) The row's highlight belongs to the table: a tap on open map and an
    // emptied search box (search's own clears) leave it.
    const hlCount = () => page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      return (await state.map.getSource('highlight-pts').getData()).features.length;
    });
    await page.mouse.click(420, 140);
    await page.waitForTimeout(300);
    check('a map tap keeps the row highlight', (await hlCount()) >= 1);
    await page.keyboard.press('Escape');   // a popup the tap may have opened
    check('Esc on a popup leaves the drawer open', !(await page.isHidden('.table-drawer')));
    await page.fill('#searchInput', ' ');
    await page.fill('#searchInput', '');
    await page.waitForTimeout(400);
    check('an emptied search box keeps the row highlight', (await hlCount()) >= 1);

    // (5c) Keyboard: the header and the rows are two tab stops; ←→ move in
    // the header; Enter on a header sorts and keeps focus there.
    await page.focus('.td-grip');
    let tabs = 0;
    while (tabs < 30 && !(await page.evaluate(() => !!document.activeElement?.closest('.td-grid .tabulator-header')))) {
      await page.keyboard.press('Tab'); tabs++;
    }
    check('Tab from the grip reaches the grid header in ≤ 11 stops', tabs <= 11, `${tabs}`);
    const where = () => page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}.${a?.className}`; });
    await page.keyboard.press('Tab');
    const inRows = await page.evaluate(() => document.activeElement?.classList.contains('tabulator-tableholder'));
    const at1 = await where();
    await page.keyboard.press('Tab');
    const leftGrid = await page.evaluate(() => !document.activeElement?.closest('.td-grid'));
    check('the header is one tab stop, the rows another', inRows && leftGrid, `${at1} → ${await where()}`);
    await page.focus('.td-grid .tabulator-header [data-head]:not([tabindex="-1"])');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const key3 = await page.evaluate(() => document.activeElement?.dataset.sort ?? document.activeElement?.dataset.filter);
    const onSort = await page.evaluate(() => !!document.activeElement?.dataset.sort);
    if (!onSort) await page.keyboard.press('ArrowLeft');
    const sortKey = await page.evaluate(() => document.activeElement?.dataset.sort);
    await page.keyboard.press('Enter');
    await page.waitForFunction(k => document.querySelector(`[role=columnheader]:has([data-sort="${k}"])`)?.getAttribute('aria-sort') !== 'none', sortKey);
    check('←→ move in the header; Enter sorts and focus stays on that header', await page.evaluate(k => document.activeElement?.dataset.sort === k, sortKey), `${key3} → ${sortKey}`);
    await page.click('[data-sort="nameplate_mw"]');
    await page.waitForFunction(() => document.querySelector('[role=columnheader]:has([data-sort="nameplate_mw"])')?.getAttribute('aria-sort') === 'descending');

    // (5d) A language change re-translates the open drawer, pills included.
    const es = await page.evaluate(async () => {
      const i18n = await import('/src/i18n/index.ts');
      const bus = await import('/assets/state-bus.ts');
      await i18n.loadDictionary('es');
      i18n.setLocale('es');
      i18n.updateDomTranslations();
      bus.emit('lang:changed', { locale: 'es' });
      const out = {
        groupBy: document.querySelector('.td-group-ctl span').textContent,
        want: i18n.t('table.groupBy'), pill: i18n.t('table.asDrawn'),
        pills: [...document.querySelectorAll('.td-pill')].map(p => p.textContent),
      };
      i18n.setLocale('en');
      i18n.updateDomTranslations();
      bus.emit('lang:changed', { locale: 'en' });
      return out;
    });
    check('es: the drawer reads "Agrupar por"', es.groupBy === es.want && es.want === 'Agrupar por', es.groupBy);
    check('es: the pills are Spanish', es.pills.includes(es.pill) && es.pill !== 'As on the map', es.pills.join(' | '));

    // (5e) A dragged cell range copies with Ctrl+C as TSV with a header line,
    // values raw (no grouping, full precision), which pastes into a spreadsheet.
    const cellAt = (i, f) => page.evaluate(([i, f]) => {
      const key = document.querySelector(`.td-grid .tabulator-col:has([data-sort="${f}"])`).getAttribute('tabulator-field');
      const r = document.querySelector(`.td-row[data-i="${i}"] .tabulator-cell[tabulator-field="${key}"]`).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, [i, f]);
    const a = await cellAt(0, 'plant_name'), b = await cellAt(2, 'nameplate_mw');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(200);
    const tsv = await page.evaluate(() => navigator.clipboard.readText());
    const lines = tsv.split('\n').map(l => l.split('\t'));
    const shownMw = await colCells(page, 'nameplate_mw', 3);
    const head = await heads();
    const want = head.slice(head.indexOf('plant_name'), head.indexOf('nameplate_mw') + 1);
    check('the copy has a header line naming the dragged columns', lines[0].join() === want.join(), lines[0].join());
    check('the copy has the 3 dragged rows', lines.length === 4 && lines.slice(1).every(l => l.length === want.length), `${lines.length} lines`);
    const mwAt = want.indexOf('nameplate_mw');
    check('MW copied raw (no grouping) and equal to the painted value', lines.slice(1).every((l, i) =>
      /^-?\d+(\.\d+)?$/.test(l[mwAt]) && Math.abs(Number(l[mwAt]) - Number(shownMw[i].replace(/,/g, ''))) < 0.051), lines.slice(1).map(l => l[mwAt]).join(' | ') + ' vs ' + shownMw.join(' | '));
    check('the status line says what was copied', /^Copied 3 rows × \d+ columns/.test(await page.textContent('.td-status')), await page.textContent('.td-status'));
    await shot(page, 'table-13-range-copied');

    // (5f) A column filter narrows the table AND the map and puts `where` in
    // the link; the ▾ and the layer row's chip show it; the chip's × clears it;
    // Undo brings it back.
    const rowCount = () => page.textContent('.td-count');
    const before5f = await rowCount();
    await page.click('.td-grid [data-filter="nameplate_mw"]');
    await page.waitForSelector('.td-filterpop:not([hidden])');
    await shot(page, 'table-14-filter-popover');
    await page.fill('.td-filterpop .td-fp-num >> nth=0', '500');
    await page.click('.td-fp-apply');
    await page.waitForFunction(b => document.querySelector('.td-count')?.textContent !== b, before5f, { timeout: 20000 });
    await settle(page);
    const after5f = await rowCount();
    const mwNow = (await colCells(page, 'nameplate_mw', 40)).map(t => Number(t.replace(/,/g, '')));
    check('filter: fewer rows, every one ≥ 500 MW', parseInt(after5f.replace(/,/g, '')) < parseInt(before5f.replace(/,/g, '')) && mwNow.every(v => v >= 500), `${before5f} → ${after5f}`);
    check('filter: state.where is the one condition', JSON.stringify(await st(page, 'state.where["eia-generators"]')) === JSON.stringify([{ field: 'nameplate_mw', op: '>=', value: 500 }]));
    check('filter: the link carries vx', paramsOf(await hashOf(page)).includes('vx='), await hashOf(page));
    const mapMw = await page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      return state.map.queryRenderedFeatures({ layers: ['eia-gen-circles'] }).map(f => Number(f.properties.nameplate_mw));
    });
    check('filter: the map draws only ≥ 500 MW', mapMw.length > 0 && mapMw.every(v => v >= 500), `${mapMw.length} drawn, min ${Math.min(...mapMw)}`);
    check('filter: the ▾ is marked', await page.evaluate(() => document.querySelector('.td-grid [data-filter="nameplate_mw"]').classList.contains('td-filter-btn--on')));
    const pills5f = await page.evaluate(() => [...document.querySelectorAll('.td-pill')].map(p => p.textContent));
    check('filter: a pill names it', pills5f.includes('Nameplate (MW) ≥ 500'), pills5f.join(' | '));
    const chip = `[data-where-chip="${GEN}"]`;
    await page.locator(chip).scrollIntoViewIfNeeded().catch(() => {});
    check('row chip: shown, naming the condition', await page.isVisible(chip) && (await page.textContent(`${chip} .layer-where-text`)) === 'Nameplate (MW) ≥ 500', await page.textContent(`${chip} .layer-where-text`));
    await shot(page, 'table-15-filtered-map-chip');
    await page.click(`[data-where-clear="${GEN}"]`);
    await page.waitForFunction(b => document.querySelector('.td-count')?.textContent === b, before5f, { timeout: 20000 }).catch(() => {});
    check('chip ×: the condition and the chip are gone, the table back', !(await st(page, 'state.where["eia-generators"]')) && await page.isHidden(chip) && (await rowCount()) === before5f, await rowCount());
    await mod(page, '/assets/undo.ts', m => m.undo());
    await settle(page);
    await page.waitForFunction(b => document.querySelector('.td-count')?.textContent !== b, before5f, { timeout: 20000 }).catch(() => {});
    check('Undo: the filter, the chip and the narrowed table are back', (await st(page, 'state.where["eia-generators"]'))?.length === 1 && await page.isVisible(chip) && (await rowCount()) === after5f, await rowCount());
    await shot(page, 'table-16-undo-filter');

    // (6) Check rows 1 and 2 too, select the three → chip → isolate.
    await rows().nth(0).locator('input[type=checkbox]').click();
    await rows().nth(1).locator('input[type=checkbox]').click();
    check('Select button counts 3', (await page.textContent('.td-select')).includes('3'), await page.textContent('.td-select'));
    await page.click('.td-select');
    await settle(page);
    const sel = await st(page, 'state.sel');
    check('3 ids selected, isolate', sel?.mode === 'isolate' && sel.ids[GEN]?.length === 3, JSON.stringify(sel));
    check('chip shows 3 selected', !(await page.isHidden('#selRow')) && (await page.textContent('#selChipLabel')) === '3 selected');
    check('link carries vx', paramsOf(await hashOf(page)).includes('vx='), await hashOf(page));
    const drawn = await page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      return state.map.queryRenderedFeatures({ layers: ['eia-gen-circles'] }).length;
    });
    check('isolate draws only the selection', drawn > 0 && drawn <= 3 * 4, `${drawn} rendered (tile copies count)`);
    await shot(page, 'table-3-isolated');

    // (7) Keep from the portalled menu, then Undo twice, Redo, Reset.
    await page.click('#selModeBtn');
    check('menu is portalled to body', await page.evaluate(() => document.querySelector('.sel-menu')?.parentElement === document.body));
    await shot(page, 'table-4-sel-menu');
    await page.click('.sel-menu-item:has-text("Keep")');
    await settle(page);
    check('Keep switches the mode', (await st(page, 'state.sel.mode')) === 'keep');
    check('chip says Keep', (await page.textContent('#selModeText')) === 'Keep');
    await mod(page, '/assets/undo.ts', m => m.undo());
    await settle(page);
    check('Undo → isolate', (await st(page, 'state.sel?.mode')) === 'isolate' && (await page.textContent('#selModeText')) === 'Isolate');
    await mod(page, '/assets/undo.ts', m => m.undo());
    await settle(page);
    check('Undo → no selection, chip hidden', (await st(page, 'state.sel')) === null && await page.isHidden('#selRow'));
    await mod(page, '/assets/undo.ts', m => m.redo());
    await settle(page);
    check('Redo → selection back', (await st(page, 'state.sel?.ids["eia-generators"]?.length')) === 3 && !(await page.isHidden('#selRow')));
    await reset(page);
    check('Reset clears the selection and chip', (await st(page, 'state.sel')) === null && await page.isHidden('#selRow'));
    check('Reset drops vx from the link', !(await hashOf(page)).includes('vx='), await hashOf(page));

    // (8) Esc closes the drawer and lifts the legends back down.
    await page.focus(HOLDER);
    await page.keyboard.press('Escape');
    check('Esc closes the drawer', await page.isHidden('.table-drawer'));
    check('has-drawer cleared', !(await page.evaluate(() => document.querySelector('.map-container').classList.contains('has-drawer'))));

    // (9) A file over 2 MiB states its size first; Cancel loads nothing.
    await openTable(page, 'osm-plants-points');
    await page.waitForSelector('.td-status:has-text("MB")', { timeout: 15000 }).catch(() => {});
    const note = await page.textContent('.td-status');
    check('size note before loading OSM plant points', /MB/.test(note ?? ''), note);
    await shot(page, 'table-5-size-note');
    await page.click('.td-status button:has-text("Cancel")').catch(() => {});
    check('Cancel loads nothing and closes', (await st(page, '!!state.sourcesLoaded["osm-plants-points"]')) === false && await page.isHidden('.table-drawer'));

    // (10) A popup's "Show in table" opens the drawer on that feature's row
    // (Reset switched EIA off, so switch it back on first).
    await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('eia-generators', true));
    await settle(page);
    const pt = await page.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      // One in open map: clear of the panel (right) and any drawer (bottom).
      const h = state.map.getContainer().clientHeight;
      return state.map.queryRenderedFeatures({ layers: ['eia-gen-circles'] })
        .map(f => state.map.project(f.geometry.coordinates))
        .filter(p => p.x > 300 && p.x < 900 && p.y > 120 && p.y < h * 0.55)
        .map(p => { const r = state.map.getContainer().getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; })[0];
    });
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      // Stacked units give a picker first; pick the first.
      await page.waitForSelector('.popup-table-btn, .feat-pick-btn', { timeout: 5000 }).catch(() => {});
      if (await page.$('.feat-pick-btn')) await page.click('.feat-pick-btn');
      await page.waitForSelector('.popup-table-btn', { timeout: 5000 }).catch(() => {});
      const has = await page.$('.popup-table-btn');
      check('popup offers Show in table', !!has);
      if (has) {
        await has.click();
        await page.waitForSelector('.td-row--active', { timeout: 20000 }).catch(() => {});
        check('the clicked feature is the active row', !!(await page.$('.td-row--active')));
        check('Show in table closes the popup', !(await page.$('.maplibregl-popup')));
        await shot(page, 'table-8-from-popup');
        await page.focus(HOLDER);
        await page.keyboard.press('Escape');
        check('Esc then focuses the map (the popup button is gone)', await page.evaluate(() => document.activeElement?.classList.contains('maplibregl-canvas')));
      }
    } else check('a generator to click', false);

    // (10b) The status line re-translates too: a vector layer's table read
    // from the loaded tiles says so (table.partial). Every queryable vector
    // layer has a columns file, so this page is refused data/analysis/ and the
    // table falls back to the tiles; switch to es and back.
    await desk.route('**/data/analysis/**', r => r.fulfill({ status: 404, body: '' }));
    const tiles = await open(desk, link);
    await openTable(tiles.page, 'osm-substations-points');
    await tiles.page.waitForSelector('.td-status[data-kind="warn"]:not([hidden])', { timeout: 30000 }).catch(() => {});
    const partial = await tiles.page.evaluate(async () => {
      const i18n = await import('/src/i18n/index.ts');
      const bus = await import('/assets/state-bus.ts');
      const line = () => document.querySelector('.td-status').textContent;
      const en = line();
      await i18n.loadDictionary('es');
      i18n.setLocale('es');
      i18n.updateDomTranslations();
      bus.emit('lang:changed', { locale: 'es' });
      const es = line(), want = i18n.t('table.partial');
      i18n.setLocale('en');
      i18n.updateDomTranslations();
      bus.emit('lang:changed', { locale: 'en' });
      return { en, es, want, back: line(), enWant: i18n.t('table.partial') };
    });
    check('status line: partial note in English', partial.en === partial.enWant && !!partial.en, partial.en);
    check('es: the status line is Spanish', partial.es === partial.want && partial.es !== partial.en, partial.es);
    check('en again: the status line is English', partial.back === partial.en, partial.back);
    const tileErrs = tiles.errors.filter(e => !/status of 404/.test(e));   // the refused index.json
    check('no console errors (tiles fallback)', tileErrs.length === 0, tileErrs.join(' | '));
    await tiles.page.close();
    await desk.unroute('**/data/analysis/**');
    await page.focus(HOLDER);
    await page.keyboard.press('Escape');
    check('no console errors', errors.length === 0, errors.join(' | '));
    await page.close();
    await desk.close();

    // (11) Phone: a bottom sheet with the map above it, and the chip.
    // Rows wholly visible below the grid's header; drawer controls a finger
    // misses (every button and check cell < 40 px; the grip < 20 px).
    const visibleRows = pg => pg.evaluate(() => {
      const g = document.querySelector('.td-grid').getBoundingClientRect();
      const h = document.querySelector('.td-grid .tabulator-header').getBoundingClientRect();
      return [...document.querySelectorAll('.td-row')].filter(r => {
        const b = r.getBoundingClientRect();
        return b.top >= h.bottom - 1 && b.bottom <= g.bottom + 1;
      }).length;
    });
    const smallTargets = pg => pg.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.table-drawer button, .table-drawer .td-check')) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        if (b.height < 40 || (el.classList.contains('td-check') && b.width < 40)) out.push(`${el.className} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
      const grip = document.querySelector('.td-grip').getBoundingClientRect().height;
      if (grip < 20) out.push(`grip ${grip}`);
      return out;
    });
    const phone = await withInit({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await open(phone, link);
    if (await p.page.isVisible('#layersToggleBtn')) await p.page.click('#layersToggleBtn');
    await openTable(p.page, GEN);
    await p.page.waitForSelector('.td-row', { timeout: 30000 });
    if (await p.page.isVisible('#closeLayers')) await p.page.click('#closeLayers');
    const geo = await p.page.evaluate(() => {
      const d = document.querySelector('.table-drawer').getBoundingClientRect();
      return { w: d.width, top: d.top, h: innerHeight, scroll: document.documentElement.scrollWidth };
    });
    check('phone sheet spans the width', Math.abs(geo.w - 390) < 2, `${geo.w}`);
    check('phone sheet leaves the map visible', geo.top > geo.h * 0.4, `top ${geo.top} of ${geo.h}`);
    check('no horizontal page scroll', geo.scroll <= 390, `${geo.scroll}`);
    await settle(p.page);
    const nPortrait = await visibleRows(p.page);
    check('phone portrait: ≥ 5 rows visible', nPortrait >= 5, `${nPortrait}`);
    check('phone portrait: touch targets ≥ 40 px', (await smallTargets(p.page)).length === 0, (await smallTargets(p.page)).join(', '));
    check('phone portrait: the summary is folded to one line',
      await p.page.getAttribute('.td-fold', 'aria-expanded') === 'false' && await p.page.isHidden('.td-summary-full')
      && /GW/.test(await p.page.textContent('.td-fold')), await p.page.textContent('.td-fold'));
    check('phone: the fold names the sort column', /▼ nameplate_mw/.test(await p.page.textContent('.td-fold-sort')), await p.page.textContent('.td-fold-sort'));
    // The Area pill comes before the legend-filter pills, inside the footer.
    const areaPill = await p.page.evaluate(() => {
      const pill = [...document.querySelectorAll('.td-pill')].find(x => x.textContent.includes('Texas'));
      const box = document.querySelector('.td-pills').getBoundingClientRect();
      const b = pill?.getBoundingClientRect();
      return b ? { left: b.left, right: b.right, boxRight: box.right, text: pill.textContent } : null;
    });
    check('phone: the Area pill shows in the footer', !!areaPill && areaPill.right <= areaPill.boxRight + 1 && areaPill.left >= 0, JSON.stringify(areaPill));
    await shot(p.page, 'table-6-open-phone');
    await p.page.tap('.td-fold');
    check('the fold opens the summary', await p.page.isVisible('.td-bars') && await p.page.getAttribute('.td-fold', 'aria-expanded') === 'true');
    check('expanded: no second total line, the bars come first', await p.page.isHidden('.td-total-line'));
    await shot(p.page, 'table-12-fold-open-phone');
    await p.page.tap('.td-fold');
    // The Columns sheet covers the drawer, its fields two to a row.
    await p.page.tap('.td-cols');
    const sheet = await p.page.evaluate(() => {
      const c = document.querySelector('#td-colpanel').getBoundingClientRect();
      const d = document.querySelector('.table-drawer').getBoundingClientRect();
      const item = document.querySelector('#td-colpanel .td-col').getBoundingClientRect();
      return { cw: c.width, dw: d.width, item: item.height };
    });
    check('phone: Columns opens a sheet over the drawer, rows ≥ 28 px', Math.abs(sheet.cw - sheet.dw) < 2 && sheet.item >= 28, JSON.stringify(sheet));
    const nCols = await p.page.evaluate(() => {
      const box = document.querySelector('#td-colpanel').getBoundingClientRect();
      return [...document.querySelectorAll('#td-colpanel .td-col')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.top >= box.top && r.bottom <= box.bottom;
      }).length;
    });
    check('phone: the Columns sheet shows ≥ 20 fields at once', nCols >= 20, `${nCols}`);
    await shot(p.page, 'table-10-columns-phone');
    // Scrolled to the last field, the Default / All / Done header stays in view.
    const pinned = await p.page.evaluate(() => {
      const c = document.querySelector('#td-colpanel');
      c.scrollTop = c.scrollHeight;
      const box = c.getBoundingClientRect();
      const done = c.querySelector('.td-cols-done').getBoundingClientRect();
      return { scrolled: c.scrollTop, top: done.top - box.top, bottom: box.bottom - done.bottom };
    });
    check('phone: Done stays in view at the end of the list', pinned.scrolled > 0 && pinned.top >= 0 && pinned.bottom >= 0, JSON.stringify(pinned));
    await shot(p.page, 'table-16-columns-scrolled-phone');
    await p.page.tap('.td-cols-done');
    check('Done closes the sheet', await p.page.isHidden('#td-colpanel'));
    // A value filter fills the drawer: the list takes the height, Apply stays in view.
    await p.page.tap('.td-grid [data-filter="gen_status"]');
    await p.page.waitForSelector('.td-filterpop:not([hidden])');
    const fp = await p.page.evaluate(() => {
      const pop = document.querySelector('.td-filterpop').getBoundingClientRect();
      const list = document.querySelector('.td-fp-list');
      const apply = document.querySelector('.td-fp-apply').getBoundingClientRect();
      return { cap: getComputedStyle(list).maxHeight, clipped: list.scrollHeight > list.clientHeight + 1, apply: apply.bottom, pop: pop.bottom };
    });
    check('phone: the value list is uncapped, unclipped, Apply in view', fp.cap === 'none' && !fp.clipped && fp.apply <= fp.pop, JSON.stringify(fp));
    await shot(p.page, 'table-15-filter-phone');
    await p.page.tap('.td-fp-cancel');
    // A long value list (energy_source, 20 codes) fits whole, two to a row.
    await p.page.tap('.td-cols'); await p.page.tap('.td-cols-all'); await p.page.tap('.td-cols-done');
    await p.page.locator('.td-grid [data-filter="energy_source"]').scrollIntoViewIfNeeded();
    await p.page.tap('.td-grid [data-filter="energy_source"]');
    await p.page.waitForSelector('.td-filterpop:not([hidden])');
    const fpLong = await p.page.evaluate(() => {
      const lb = document.querySelector('.td-fp-list').getBoundingClientRect();
      const opts = [...document.querySelectorAll('.td-fp-list .td-fp-opt:not([hidden])')];
      return { total: opts.length, shown: opts.filter(o => { const b = o.getBoundingClientRect(); return b.top >= lb.top - 1 && b.bottom <= lb.bottom + 1; }).length };
    });
    check('phone: a 20-value filter shows every value at once', fpLong.total >= 20 && fpLong.shown === fpLong.total, JSON.stringify(fpLong));
    await shot(p.page, 'table-17-filter-long-phone');
    await p.page.tap('.td-fp-cancel');
    await p.page.tap('.td-cols'); await p.page.tap('.td-cols-default'); await p.page.tap('.td-cols-done');
    await p.page.locator('.td-row').nth(0).locator('input[type=checkbox]').tap();
    await p.page.locator('.td-row').nth(1).locator('input[type=checkbox]').tap();
    await p.page.tap('.td-select');
    await settle(p.page);
    check('phone: chip shows 2 selected', (await p.page.textContent('#selChipLabel')) === '2 selected');
    await shot(p.page, 'table-7-chip-phone');
    check('no console errors (phone)', p.errors.length === 0, p.errors.join(' | '));
    await phone.close();

    // (12) Landscape phone (844×390): the actions in a side rail, rows
    // visible with the layer panel shown (the drawer stops at it) and hidden.
    const land = await withInit({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const l = await open(land, link);
    if (await l.page.isVisible('#layersToggleBtn')) await l.page.click('#layersToggleBtn');
    await openTable(l.page, GEN);
    await l.page.waitForSelector('.td-row', { timeout: 30000 });
    await settle(l.page);
    for (const panel of ['shown', 'hidden']) {
      if (panel === 'hidden' && await l.page.isVisible('#closeLayers')) { await l.page.click('#closeLayers'); await settle(l.page); }
      const n = await visibleRows(l.page);
      const rail = await l.page.evaluate(() => {
        const a = document.querySelector('.td-actions').getBoundingClientRect();
        const d = document.querySelector('.table-drawer').getBoundingClientRect();
        return { railLeft: a.left - d.left, railW: a.width, drawerW: d.width, drawerH: d.height };
      });
      check(`landscape (panel ${panel}): ≥ 2 rows visible`, n >= 2, `${n} rows · drawer ${Math.round(rail.drawerW)}×${Math.round(rail.drawerH)}`);
      check(`landscape (panel ${panel}): actions in a side rail`, rail.railLeft < 2 && rail.railW < 70, JSON.stringify(rail));
      check(`landscape (panel ${panel}): touch targets ≥ 40 px`, (await smallTargets(l.page)).length === 0, (await smallTargets(l.page)).join(', '));
      await shot(l.page, `table-11-landscape-panel-${panel}`);
    }
    check('no console errors (landscape)', l.errors.length === 0, l.errors.join(' | '));
    await land.close();
}
