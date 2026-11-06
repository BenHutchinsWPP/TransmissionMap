import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLayerInRegion, hasPanelRow, panelRows, PANEL_GROUPS } from './ui-layer-rows.js';
import { LAYERS } from '../../src/registry/index.js';
import { templatesFor } from '../templates/catalogue.js';
import { state } from '../state.js';
import { loadDictionary, setLocale } from '../../src/i18n/index.js';
import type { LayerDef } from '../../src/types.js';

const layer = (regions?: LayerDef['regions']) => ({ regions } as LayerDef);
const allOn = Object.fromEntries(LAYERS.map(l => [l.id, true]));

describe('row templates read no state for a value', () => {
  it('render the same rows whatever the area, each with one hidden area-flag node', () => {
    const render = () => JSON.stringify(panelRows(LAYERS, { scope: 'usa', visible: allOn }));
    const saved = state.area;
    let rows;
    try {
      state.area = null;
      const plain = render();
      state.area = { kind: 'states', codes: ['TX'] };
      expect(render()).toBe(plain);
      rows = JSON.parse(plain) as ReturnType<typeof panelRows>;
    } finally { state.area = saved; }
    const html = Object.values(rows).map(r => r.html).join('');
    const ids = Object.values(rows).flatMap(r => r.ids);
    expect(ids.length).toBe(LAYERS.length);
    expect(html.match(/class="layer-row">/g)?.length).toBe(ids.length);
    // Each flag is the hidden, empty button right after a .layer-row's label.
    const flags = html.match(/<div class="layer-row">\s*<label class="layer-label">[\s\S]*?<\/label>\s*<button type="button" class="layer-area-flag" data-area-flag="[^"]+" hidden><\/button>/g);
    expect(flags?.length).toBe(ids.length);
    expect(html.match(/data-area-flag="/g)?.length).toBe(ids.length);
  });

  it('a layer with a field schema gets one hidden, empty `where` chip before its ⋯ menu; others none', () => {
    const saved = state.where;
    try {
      state.where = { 'eia-generators': [{ field: 'nameplate_mw', op: '>=', value: 100 }] };
      for (const l of LAYERS) {
        const { html } = panelRows([l], { scope: 'usa', visible: { [l.id]: true } })[l.group];
        const chips = html.match(/<div class="layer-where" data-where-chip="([^"]+)" hidden><span class="layer-where-text"><\/span><button type="button" class="layer-where-clear" data-where-clear="\1">×<\/button><\/div>/g) ?? [];
        expect(chips.length, l.id).toBe(l.dataset ? 1 : 0);
        if (l.dataset && html.includes('layer-menu-btn')) expect(html.indexOf('data-where-chip') > html.indexOf('layer-menu-btn'), l.id).toBe(true);
      }
    } finally { state.where = saved; }
  });
});

describe('panelRows — the row set', () => {
  const def = (id: string, group: string, regions?: LayerDef['regions']) => ({ id, group, regions, downloads: {} } as LayerDef);
  const us = def('us', 'generators', ['usa']);
  const world = def('world', 'generators', ['global']);
  const plain = def('plain', 'rail');
  const fixture = [us, world, plain];
  const ids = (v: Parameters<typeof panelRows>[1]) => Object.values(panelRows(fixture, v)).flatMap(r => r.ids);

  it('usa lists every layer; global drops the US-only one unless it is switched on', () => {
    expect(ids({ scope: 'usa', visible: {} })).toEqual(['us', 'world', 'plain']);
    expect(ids({ scope: 'global', visible: {} })).toEqual(['world', 'plain']);
    expect(ids({ scope: 'global', visible: { us: true } })).toEqual(['us', 'world', 'plain']);
  });

  it('a hidden layer never gets a row, even when switched on', () => {
    const hidden = { ...world, hidden: true } as LayerDef;
    expect(hasPanelRow(hidden, { scope: 'usa', visible: { world: true } })).toBe(false);
  });

  it('returns every group in PANEL_GROUPS order, an empty one as no ids and no html', () => {
    const rows = panelRows(fixture, { scope: 'usa', visible: {} });
    expect(Object.keys(rows)).toEqual(PANEL_GROUPS);
    expect(rows.generators.ids).toEqual(['us', 'world']);
    expect(rows.transmission).toEqual({ ids: [], html: '' });
  });

  it('every registry group is a panel group', () => {
    expect(LAYERS.filter(l => !PANEL_GROUPS.includes(l.group)).map(l => l.id)).toEqual([]);
  });
});

describe('row aria-labels follow the locale', () => {
  it('no English group or select label in French', async () => {
    await loadDictionary('fr');
    setLocale('fr');
    try {
      const html = Object.values(panelRows(LAYERS, { scope: 'usa', visible: allOn })).map(r => r.html).join('');
      for (const en of ['Color ', 'Display mode for', 'Weather variable for', 'Hazard for']) {
        expect(html).not.toContain(`aria-label="${en}`);
      }
      expect(html).toContain('aria-label="Mode d&#39;affichage de');
    } finally { setLocale('en'); }
  });
});

describe('isLayerInRegion — layer-list scope', () => {
  it('usa lists every layer, US-only and worldwide alike', () => {
    expect(isLayerInRegion(layer(['usa']), 'usa')).toBe(true);
    expect(isLayerInRegion(layer(['global']), 'usa')).toBe(true);
    expect(isLayerInRegion(layer(undefined), 'usa')).toBe(true);
  });

  it('global hides US-only layers but keeps worldwide ones', () => {
    expect(isLayerInRegion(layer(['usa']), 'global')).toBe(false);
    expect(isLayerInRegion(layer(['global']), 'global')).toBe(true);
  });

  it('treats an unannotated layer as worldwide', () => {
    expect(isLayerInRegion(layer(undefined), 'global')).toBe(true);
    expect(isLayerInRegion(layer([]), 'global')).toBe(true);
  });

  it('global is a strict subset of usa across the real registry', () => {
    const usa = LAYERS.filter(l => isLayerInRegion(l, 'usa'));
    const global = LAYERS.filter(l => isLayerInRegion(l, 'global'));
    expect(usa.length).toBe(LAYERS.length);
    expect(global.length).toBeLessThan(usa.length);
    expect(global.every(l => usa.includes(l))).toBe(true);
  });
});


describe('the row menu', () => {
  const rows = panelRows(LAYERS, { scope: 'usa', visible: allOn });
  const html = Object.values(rows).map(r => r.html).join('');
  const rowHtml = (id: string) => {
    const start = html.indexOf(`data-layer-id="${id}"`);
    const next = html.indexOf('class="layer-row">', start);
    return html.slice(start, next < 0 ? undefined : next);
  };

  it('gives each row one ⋯ button, a menu button for its role=menu, and no other row button', () => {
    const buttons = html.match(/<button[^>]*class="icon-btn layer-menu-btn"[^>]*>/g) ?? [];
    expect(buttons.length).toBe(LAYERS.filter(l => rowHtml(l.id).includes('layer-menu-item')).length);
    for (const b of buttons) {
      expect(b).toContain('aria-haspopup="menu"');
      expect(b).toContain('aria-expanded="false"');
      const menu = /aria-controls="([^"]+)"/.exec(b)![1];
      expect(html).toContain(`id="${menu}" role="menu"`);
    }
    // The old per-action row buttons are gone: every action is a menu item.
    expect(html).not.toMatch(/class="icon-btn (filter|table|viz|dl|source)-btn/);
    expect(html).not.toContain('layer-actions');
  });

  it('names the button for its layer', () => {
    expect(html).toMatch(/aria-controls="layer-menu-eia-generators"\s+title="Layer options" aria-label="Options for [^"]+"/);
  });

  it('holds the sub-panel toggles as menuitemcheckbox items, unchecked', () => {
    const gen = rowHtml('eia-generators');
    expect(gen).toMatch(/role="menuitemcheckbox" aria-checked="false" tabindex="-1" data-filter-toggle="eia-generators"><span class="lm-icon" aria-hidden="true">/);
    expect(gen).toMatch(/role="menuitemcheckbox" aria-checked="false" tabindex="-1" id="genYearFilterBtn"/);
    expect(html.match(/id="genYearFilterBtn"/g)?.length).toBe(1);
    for (const l of LAYERS) if (l.filterBuckets) expect(html, l.id).toContain(`data-filter-toggle="${l.id}"`);
  });

  it('puts every item in a menu, reachable by the arrow keys (tabindex -1)', () => {
    const items = html.match(/<(button|a|summary)[^>]*class="layer-menu-item"[^>]*>/g) ?? [];
    expect(items.length).toBeGreaterThan(LAYERS.length);
    for (const i of items) expect(i).toMatch(/role="menuitem(checkbox)?"[^>]*tabindex="-1"/);
  });
});

describe('the Visualize item', () => {
  it('sits in a row menu exactly when a ready template fits the layer, on every screen size', () => {
    const rows = panelRows(LAYERS, { scope: 'usa', visible: allOn });
    const html = Object.values(rows).map(r => r.html).join('');
    for (const l of LAYERS) {
      expect(html.includes(`data-viz-layer="${l.id}"`), l.id).toBe(templatesFor(l.id).length > 0);
    }
    expect(html).toContain('data-viz-layer="eia-generators"><span class="lm-icon" aria-hidden="true">');
    expect(html).not.toContain('data-viz-layer="wind-speed"');
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.viz-btn/);
  });
});
