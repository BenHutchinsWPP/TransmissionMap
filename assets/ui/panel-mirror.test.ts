// @vitest-environment jsdom
// The panel mirror on a recording fake map built by the real layer builders:
// after any applied view (Reset, a story, Undo, a view file), a language change
// or a region pick, every panel control shows what `state` says — the heat ramp
// of a visible heat-mode layer, the year slider, the mode and colour-by buttons,
// the selects, the filter chips, the sliders, the basemap controls and the
// region dropdown — and, for every curated story, the whole panel matches the
// view the story applied. A view that keeps the region and language keeps the
// rows too, so an Undo leaves an open filter panel and the focused control.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('../basemap.js', async () => {
  const { state } = await import('../state.js');
  return {
    switchBasemap: vi.fn((b: string) => { state.basemap = b; }),
    switchProjection: vi.fn((p: string) => { state.projection = p; }),
    setBasemapLabels: vi.fn(),
  };
});
vi.mock('../terrain.js', async () => {
  const { state } = await import('../state.js');
  return {
    setTerrain3d: vi.fn((on: boolean) => { state.terrain3d = on; }),
    setBuildings3d: vi.fn((on: boolean) => { state.buildings3d = on; }),
    setHillshade: vi.fn((on: boolean) => { state.hillshade = on; }),
  };
});

import { state } from '../state.js';
import { emit, on } from '../state-bus.js';
import { addAllLayers } from '../layers/add-all-layers.js';
import { LAYERS } from '../../src/registry/index.js';
import { EXPERIENCES } from '../../src/registry/experiences.js';
import { experienceUrlState } from '../experiences.js';
import { applyView, seedView } from '../view-state.js';
import { beginExperience, endExperienceLink, experienceIsDirty } from '../experience-link.js';
import { heatRampShown, setLayerVisibility } from '../visibility.js';
import { hasPanelRow, PANEL_GROUPS } from './ui-layer-rows.js';
import { wireLangChanged, wireRegionSelect } from './ui.js';
import { renderPanel, syncPanel, commitArea, commitSelection, commitWhere, conditionLabel, whereLabel } from './panel-mirror.js';
import { mwToPos } from '../filters.js';
import { loadDictionary, setLocale } from '../../src/i18n/index.js';
import { wireGenModeToggle, wireRouteConcernSelect, wireGridOpsSelects, wireLayerFilterPanels } from './ui-filters.js';
import { parseUrlState } from '../url-state-codec.js';
import { CONCERNS, CONCERN_GROUPS } from '../../src/colors/route-constraints.js';
import { areaFlag } from '../../src/registry/area-filter.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };

// As in view-state-paint.test.ts.
function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  // A held source's setUrl lands its metadata at once.
  const handlers: Record<string, ((e: object) => void)[]> = {};
  const known: Record<string, unknown> = {
    on: (t: string, h: (e: object) => void) => { (handlers[t] ??= []).push(h); },
    off: (t: string, h: (e: object) => void) => { handlers[t] = (handlers[t] ?? []).filter(f => f !== h); },
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {
      setUrl: () => [...(handlers.sourcedata ?? [])].forEach(h => h({ type: 'sourcedata', sourceId: id, sourceDataType: 'metadata' })),
    } : undefined),
    getZoom: () => 5,
    getCenter: () => ({ lat: 39.5, lng: -98.35 }),
    getBearing: () => 0,
    getPitch: () => 0,
    getContainer: () => document.createElement('div'),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint?.[p],
    getLayoutProperty: (id: string, p: string) => layers.get(id)?.layout?.[p],
    setPaintProperty: (id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.paint = { ...l.paint, [p]: v };
    },
    setLayoutProperty: (id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.layout = { ...l.layout, [p]: v };
    },
    setFilter: (id: string, f: unknown) => { layers.get(id)!.filter = f ?? undefined; },
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  state.map = map as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
}

const GEN = 'eia-generators';

wireLangChanged();
wireGenModeToggle();
wireRouteConcernSelect();
wireGridOpsSelects();

let urlWrites = 0;
on('url:write', () => { urlWrites++; });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  endExperienceLink();
  state.regionScope = 'usa';
  document.body.innerHTML = `
    <input type="radio" name="basemap" value="light"><input type="radio" name="basemap" value="dark">
    <input type="radio" name="projection" value="mercator"><input type="radio" name="projection" value="globe">
    <input type="checkbox" id="terrain3dToggle"><input type="checkbox" id="buildings3dToggle">
    <input type="checkbox" id="hillshadeToggle"><input type="checkbox" id="basemapLabelsToggle">
    <div id="mwSliderRange"></div>
    <input type="range" id="mwSliderMin" min="0" max="4000"><input type="range" id="mwSliderMax" min="0" max="4000">
    <input id="mwMinInput"><input id="mwMaxInput">
    <output id="smokeOpacityReadout"></output><input type="range" id="smokeOpacitySlider" min="0" max="100">
    <div class="layers-body">
      ${PANEL_GROUPS.map(g => `<div class="layer-section" data-collapsible><div id="layer-rows-${g}"></div></div>`).join('')}
    </div>
    <div id="areaRow">
      <button id="areaClear" hidden></button>
      <div id="areaBox"><span id="areaChips"></span><input id="areaInput"></div>
      <div id="areaSummary" hidden><span id="areaSummaryText"></span></div>
    </div>
    <div id="selRow" hidden><span id="selChipLabel"></span><button id="selModeBtn"><span id="selModeText"></span></button></div>
    <div id="regionDropdown">
      <button id="regionDropdownBtn"></button>
      <span id="regionActiveIcon"></span><span id="regionActiveText"></span>
      <div id="regionMenu" hidden>
        <button class="region-menu-item" data-region="usa"><span class="region-menu-label">USA</span></button>
        <button class="region-menu-item" data-region="global"><span class="region-menu-label">Global</span></button>
      </div>
    </div>`;
  recordingMap();
  renderPanel();
  urlWrites = 0;
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const panelView = () => ({ scope: state.regionScope, visible: state.layerVisibility });
const modeOf = (id: string) => state.genMode[id] || LAYERS.find(l => l.id === id)!.defaultMode || 'icons';

/** Every mirrored control in the panel against `state`. */
function expectPanelMatchesState(where = '') {
  for (const entry of LAYERS) {
    if (!hasPanelRow(entry, panelView())) continue;
    const on = !!state.layerVisibility[entry.id];
    const cb = q<HTMLInputElement>(`input[type=checkbox][data-layer-id="${entry.id}"]`);
    expect(cb?.checked, `${where} ${entry.id} checkbox`).toBe(on);
    const flag = on ? areaFlag(entry, state.area, modeOf(entry.id)) : null;
    expect(q(`[data-area-flag="${entry.id}"]`)!.hidden, `${where} ${entry.id} area flag`).toBe(!flag);
    if (entry.heatLayerId || entry.modes) {
      const mode = modeOf(entry.id);
      expect(q(`#${entry.id}-heat-ramp`)!.hidden, `${where} ${entry.id} ramp`).toBe(!heatRampShown(entry, on, mode));
      const active = [...document.querySelectorAll<HTMLElement>(`[data-gen-mode-layer="${entry.id}"].gen-mode-btn--active`)];
      expect(active.map(b => b.dataset.genMode), `${where} ${entry.id} mode`).toEqual([mode]);
    }
    const whereChip = q(`[data-where-chip="${entry.id}"]`);
    if (whereChip) expect(whereChip.hidden, `${where} ${entry.id} where chip`).toBe(!state.where[entry.id]?.length);
    for (const b of entry.filterBuckets ?? []) {
      const chip = q<HTMLInputElement>(`input[data-filter-layer="${entry.id}"][data-bucket-id="${b.id}"]`)!;
      expect(chip.checked, `${where} ${entry.id}/${b.id} chip`).toBe(!!state.layerFilters[entry.id]?.has(b.id));
    }
  }
  // Rows a region leaves out (and that are off) are skipped: there is no control to check.
  const active = (attr: string, want: string) => {
    if (!q(`[${attr}]`)) return;
    const got = [...document.querySelectorAll<HTMLElement>(`[${attr}].gen-mode-btn--active`)].map(b => b.getAttribute(attr));
    expect(got, `${where} ${attr}`).toEqual([want]);
  };
  active('data-ogf-colorby', state.ogfColorBy);
  active('data-westtec-colorby', state.westtecColorBy);
  const select = (sel: string, want: string) => {
    const el = q<HTMLSelectElement>(sel);
    if (el) expect(el.value, `${where} ${sel}`).toBe(want);
  };
  select('select[data-weather-var-select]', state.weatherVar);
  select('select[data-nri-hazard-select]', state.nriHazard);
  select('select[data-route-concern-select]', state.routeConcern);
  if (hasPanelRow(LAYERS.find(l => l.id === GEN)!, panelView())) {
    const slider = q<HTMLInputElement>('#yearSlider')!;
    expect(slider.value, `${where} year`).toBe(String(state.yearFilter.year));
    expect(slider.classList.contains('year-slider--off'), `${where} year off`).toBe(!state.yearFilter.enabled);
    if (state.yearFilter.enabled) expect(q('#yearReadout')!.textContent).toBe(String(state.yearFilter.year));
  }
  const chipCodes = [...document.querySelectorAll<HTMLElement>('#areaChips [data-area-code]')].map(b => b.dataset.areaCode);
  expect(chipCodes, `${where} area chips`).toEqual(state.area?.codes ?? []);
  expect(q('#areaClear')!.hidden, `${where} area clear`).toBe(!state.area);
  const flagged = [...document.querySelectorAll('[data-area-flag]')].filter(f => !(f as HTMLElement).hidden).length;
  expect(q('#areaSummary')!.hidden, `${where} area summary`).toBe(!flagged);
  expect(q<HTMLInputElement>('#mwSliderMin')!.value, `${where} MW min`).toBe(String(mwToPos(state.mwFilter.min)));
  expect(q<HTMLInputElement>('#mwSliderMax')!.value, `${where} MW max`).toBe(String(mwToPos(state.mwFilter.max)));
  expect(q<HTMLInputElement>('#smokeOpacitySlider')!.value, `${where} smoke`).toBe(String(Math.round(state.smokeOpacity * 100)));
  const radio = (name: string) => q<HTMLInputElement>(`input[name=${name}]:checked`)?.value;
  if (q(`input[name=basemap][value="${state.basemap}"]`)) expect(radio('basemap'), `${where} basemap`).toBe(state.basemap);
  expect(radio('projection'), `${where} projection`).toBe(state.projection);
  for (const [id, v] of [['terrain3dToggle', state.terrain3d], ['buildings3dToggle', state.buildings3d],
    ['hillshadeToggle', state.hillshade], ['basemapLabelsToggle', state.basemapLabels]] as const) {
    expect(q<HTMLInputElement>(`#${id}`)!.checked, `${where} ${id}`).toBe(v);
  }
  const regions = [...document.querySelectorAll<HTMLElement>('.region-menu-item--active')].map(i => i.dataset.region);
  expect(regions, `${where} region`).toEqual([state.regionScope]);
}

describe('panel mirror', () => {
  it('the route-concern select follows a pick, Reset and an Undo replay', () => {
    const sel = q<HTMLSelectElement>('select[data-route-concern-select]')!;
    expect([...sel.querySelectorAll('optgroup')]).toHaveLength(CONCERN_GROUPS.length);
    expect([...sel.options].map(o => o.value)).toEqual(CONCERNS.map(c => c.id));
    expect(sel.value).toBe('what-constrains');
    sel.value = 'floodplain';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.routeConcern).toBe('floodplain');
    expect(urlWrites).toBe(1);
    applyView({});                                            // Reset
    expect(state.routeConcern).toBe('what-constrains');
    expect(sel.value).toBe('what-constrains');
    applyView(parseUrlState(new URLSearchParams('rc=floodplain')));   // what Undo replays
    expect(q<HTMLSelectElement>('select[data-route-concern-select]')!.value).toBe('floodplain');
    expectPanelMatchesState();
  });

  it('the Grid Operations numbers checkbox shows auto, follows the grouping, an explicit value and Reset', () => {
    const box = () => q<HTMLInputElement>('input[data-grid-numbers-toggle]')!;
    const group = q<HTMLSelectElement>('select[data-grid-group-select]')!;
    expect(box().checked).toBe(true);                         // auto, by BA
    group.value = 'wecc';
    group.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.gridNumbers).toBeNull();
    expect(box().checked).toBe(false);                        // auto follows the grouping
    box().checked = true;
    box().dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.gridNumbers).toBe(true);
    applyView(parseUrlState(new URLSearchParams('gg=w&gn=0')));
    expect(state.gridNumbers).toBe(false);
    expect(box().checked).toBe(false);
    applyView(parseUrlState(new URLSearchParams('gn=1')));
    expect(box().checked).toBe(true);
    applyView({});                                            // Reset
    expect(state.gridNumbers).toBeNull();
    expect(box().checked).toBe(true);
  });

  it('shows the heat ramp of a visible heat-mode layer after a view applies', () => {
    applyView({ layerVisibility: { [GEN]: true }, genMode: { [GEN]: 'heat' } });
    expect(q(`#${GEN}-heat-ramp`)!.hidden).toBe(false);
    expectPanelMatchesState();
  });

  it('keeps the year slider on the filtered year across a language change', () => {
    applyView({ yearFilter: { enabled: true, year: 1990 } });
    emit('lang:changed', { locale: 'en' });
    expect(q<HTMLInputElement>('#yearSlider')!.value).toBe('1990');
    expect(q('#yearReadout')!.textContent).toBe('1990');
    expectPanelMatchesState();
  });

  it('reads the cleared year filter in the active language', async () => {
    await loadDictionary('fr');
    setLocale('fr');
    try {
      emit('lang:changed', { locale: 'fr' });
      expect(q('#yearReadout')!.textContent).toBe('Toutes les années');
    } finally {
      setLocale('en');
    }
  });

  it('repaints a layer\'s row whenever it is switched, by whoever switched it', () => {
    state.genMode[GEN] = 'heat';
    renderPanel();
    expect(q<HTMLInputElement>(`[data-layer-id="${GEN}"]`)!.checked).toBe(false);
    expect(q(`#${GEN}-heat-ramp`)!.hidden).toBe(true);
    setLayerVisibility(GEN, true);
    expect(q<HTMLInputElement>(`[data-layer-id="${GEN}"]`)!.checked).toBe(true);
    expect(q(`#${GEN}-heat-ramp`)!.hidden).toBe(false);
    setLayerVisibility(GEN, false);
    expect(q<HTMLInputElement>(`[data-layer-id="${GEN}"]`)!.checked).toBe(false);
    expect(q(`#${GEN}-heat-ramp`)!.hidden).toBe(true);
  });

  it('a mode click moves the active button and shows the ramp', () => {
    applyView({ layerVisibility: { [GEN]: true } });
    q(`.gen-mode-btn[data-gen-mode-layer="${GEN}"][data-gen-mode="both"]`)!.click();
    expect(state.genMode[GEN]).toBe('both');
    expect(q(`#${GEN}-heat-ramp`)!.hidden).toBe(false);
    expectPanelMatchesState();
  });

  it('keeps an open filter panel and the focused chip when a view keeps the region and language', () => {
    applyView({ layerVisibility: { [GEN]: true } });
    const panel = q(`#filter-panel-${GEN}`)!;
    panel.hidden = false;
    const chip = panel.querySelector<HTMLInputElement>('input[data-bucket-id]')!;
    chip.focus();
    chip.checked = !chip.checked;
    emit('view:applied');
    expect(q(`#filter-panel-${GEN}`)).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(document.activeElement).toBe(chip);
    expectPanelMatchesState();
  });

  it('rebuilds the rows and moves the menu when a view changes the region', () => {
    expect(q(`[data-layer-id="${GEN}"]`)).not.toBeNull();
    applyView({ region: 'global' });
    expect(q(`[data-layer-id="${GEN}"]`)).toBeNull();
    expect(document.getElementById('regionActiveText')!.textContent).toBe('Global');
    expectPanelMatchesState();
  });

  it('keeps the row of a switched-on layer the region leaves out, checked', () => {
    applyView({ layerVisibility: { [GEN]: true } });
    applyView({ region: 'global', layerVisibility: { [GEN]: true } });
    const cb = q<HTMLInputElement>(`input[type=checkbox][data-layer-id="${GEN}"]`);
    expect(cb?.checked).toBe(true);
    expect(cb!.closest<HTMLElement>('.layer-section')!.style.display).toBe('');
    expectPanelMatchesState();
  });

  it('adds the row when a view switches on a layer the region leaves out', () => {
    applyView({ region: 'global' });
    expect(q(`[data-layer-id="${GEN}"]`)).toBeNull();
    applyView({ region: 'global', layerVisibility: { [GEN]: true } });
    expect(q<HTMLInputElement>(`input[type=checkbox][data-layer-id="${GEN}"]`)?.checked).toBe(true);
    expectPanelMatchesState();
  });

  it('adds the row when code switches on a layer the region leaves out', () => {
    applyView({ region: 'global' });
    expect(q(`[data-layer-id="${GEN}"]`)).toBeNull();
    setLayerVisibility(GEN, true);   // as a stale-feed recovery would
    expect(q<HTMLInputElement>(`input[type=checkbox][data-layer-id="${GEN}"]`)?.checked).toBe(true);
  });

  it('an ordinary toggle repaints the row without rebuilding the panel', () => {
    const row = q(`[data-layer-id="${GEN}"]`)!;
    setLayerVisibility(GEN, true);
    setLayerVisibility(GEN, false);
    expect(q(`[data-layer-id="${GEN}"]`)).toBe(row);
  });

  it('an out-of-scope layer switched off keeps its row until the next applied view drops it', () => {
    applyView({ region: 'global' });
    setLayerVisibility(GEN, true);
    const row = q(`[data-layer-id="${GEN}"]`);
    expect(row).not.toBeNull();
    setLayerVisibility(GEN, false);
    expect(q(`[data-layer-id="${GEN}"]`)).toBe(row);
    emit('view:applied');
    expect(q(`[data-layer-id="${GEN}"]`)).toBeNull();
  });

  it('rebuilds the rows on an applied view after a language change that skipped them', async () => {
    const row = q(`[data-layer-id="${GEN}"]`);
    await loadDictionary('fr');
    setLocale('fr');
    try {
      emit('view:applied');
      expect(q(`[data-layer-id="${GEN}"]`)).not.toBe(row);
      expect(q(`[data-filter-toggle="${GEN}"]`)!.textContent).toBe('Filtrer');
    } finally {
      setLocale('en');
    }
  });

  it('flags the visible rows an area does not reach, and Reset clears every flag', () => {
    const flagOf = (id: string) => q(`[data-area-flag="${id}"]`)!;
    applyView({
      area: { kind: 'states', codes: ['TX'] },
      layerVisibility: { padus: true, 'osm-datacenters': true, 'hifld-transmission-lines': true, crithab: true },
      genMode: { 'osm-datacenters': 'clusters' },
    });
    expect(flagOf('padus').hidden).toBe(false);
    expect(flagOf('padus').dataset.flag).toBe('area.reason.noField');
    expect(flagOf('padus').getAttribute('aria-label')).toMatch(/Not filtered by area: .+/);
    expect(q('#areaSummaryText')!.textContent).toBe('Layers not filtered: 3');   // padus, crithab, datacenter clusters
    expect(flagOf('osm-datacenters').hidden).toBe(false);
    expect(flagOf('osm-datacenters').dataset.flag).toBe('area.clustersUnfiltered');
    expect(flagOf('hifld-transmission-lines').hidden).toBe(true);
    expect(flagOf('nlr-wind-100m').hidden).toBe(true);   // switched off
    expectPanelMatchesState('area');

    state.area = null;
    syncPanel();
    expect([...document.querySelectorAll<HTMLElement>('[data-area-flag]')].filter(f => !f.hidden)).toEqual([]);

    state.area = { kind: 'states', codes: ['TX'] };
    syncPanel();
    expect(flagOf('padus').hidden).toBe(false);
    applyView({});
    expect([...document.querySelectorAll<HTMLElement>('[data-area-flag]')].filter(f => !f.hidden)).toEqual([]);
  });

  it('paints the Area chips from state, and Reset and Undo-style applies repaint them', () => {
    applyView({ area: { kind: 'states', codes: ['TX', 'NM'] } });
    const chips = () => [...document.querySelectorAll<HTMLElement>('#areaChips [data-area-code]')].map(b => b.dataset.areaCode);
    expect(chips()).toEqual(['NM', 'TX']);
    expect(q<HTMLInputElement>('#areaInput')!.placeholder).toBe('Add more…');
    applyView({ area: { kind: 'counties', codes: ['48201'] } });
    expect(chips()).toEqual(['48201']);
    applyView({});
    expect(chips()).toEqual([]);
    expect(q('#areaClear')!.hidden).toBe(true);
    expect(q<HTMLInputElement>('#areaInput')!.placeholder).toBe('Filter to an area…');
    expectPanelMatchesState('area reset');
  });

  it('commitArea is one url:write and repaints the row notes and chips', () => {
    setLayerVisibility('padus', true);
    urlWrites = 0;
    expect(commitArea({ kind: 'states', codes: ['TX'] })).toBeNull();
    expect(urlWrites).toBe(1);
    expect(q('[data-area-flag="padus"]')!.hidden).toBe(false);
    expect(q('#areaSummary')!.hidden).toBe(false);
    expect(commitArea({ kind: 'states', codes: ['ZZ'] })).not.toBeNull();
    expect(urlWrites).toBe(1);
    expect(commitArea(null)).toBeNull();
    expect(q('[data-area-flag="padus"]')!.hidden).toBe(true);
    expectPanelMatchesState('commitArea');
  });

  it('paints the Selection row from state: a link or Undo shows it, Reset hides it', () => {
    expect(q('#selRow')!.hidden).toBe(true);
    applyView({ sel: { mode: 'keep', ids: { [GEN]: ['1:1', '2:1'], 'hifld-substations': ['107655'] } } });
    expect(q('#selRow')!.hidden).toBe(false);
    expect(q('#selChipLabel')!.textContent).toBe('3 selected');
    expect(q('#selChipLabel')!.title).toContain('2 · ');
    expect(q('#selModeText')!.textContent).toBe('Keep');
    applyView({});
    expect(q('#selRow')!.hidden).toBe(true);
  });

  it('commitSelection is one url:write and repaints the chip; a refused one writes nothing', () => {
    expect(commitSelection({ mode: 'isolate', ids: { [GEN]: ['1:1'] } })).toBeNull();
    expect(urlWrites).toBe(1);
    expect(q('#selRow')!.hidden).toBe(false);
    expect(q('#selModeText')!.textContent).toBe('Isolate');
    expect(commitSelection({ mode: 'isolate', ids: { [GEN]: Array.from({ length: 501 }, (_, i) => `${i}:1`) } })).not.toBeNull();
    expect(urlWrites).toBe(1);
    expect(state.sel?.ids[GEN]).toEqual(['1:1']);
    expect(commitSelection(null)).toBeNull();
    expect(urlWrites).toBe(2);
    expect(q('#selRow')!.hidden).toBe(true);
  });

  it('a layer with conditions shows its `where` chip: a link or Undo shows it, Reset hides it', () => {
    const chip = () => q(`[data-where-chip="${GEN}"]`)!;
    expect(chip().hidden).toBe(true);
    applyView({ where: { [GEN]: [{ field: 'nameplate_mw', op: '>=', value: 100 }] } });
    expect(chip().hidden).toBe(false);
    expect(chip().querySelector('.layer-where-text')!.textContent).toBe('Nameplate (MW) ≥ 100');
    expect(chip().title).toBe('Filtered: Nameplate (MW) ≥ 100');
    expect(chip().querySelector('.layer-where-clear')!.getAttribute('aria-label')).toMatch(/^Clear the filter on /);
    expectPanelMatchesState('where link');
    applyView({});
    expect(chip().hidden).toBe(true);
    expect(q('[data-where-chip="railroads"]')).toBeNull();   // no field schema: no chip
  });

  it('commitWhere is one url:write and repaints the chip; its × clears the layer\'s conditions in one write', () => {
    wireLayerFilterPanels();
    urlWrites = 0;
    expect(commitWhere(GEN, [{ field: 'nameplate_mw', op: '>=', value: 100 }, { field: 'nameplate_mw', op: '<=', value: 500 }])).toBeNull();
    expect(urlWrites).toBe(1);
    expect(q(`[data-where-chip="${GEN}"] .layer-where-text`)!.textContent).toBe('Nameplate (MW) 100–500');
    expect(commitWhere(GEN, [{ field: 'no_such_field', op: '=', value: 1 }])).not.toBeNull();
    expect(urlWrites).toBe(1);
    q<HTMLButtonElement>(`[data-where-clear="${GEN}"]`)!.click();
    expect(urlWrites).toBe(2);
    expect(state.where[GEN]).toBeUndefined();
    expect(q(`[data-where-chip="${GEN}"]`)!.hidden).toBe(true);
  });

  it('names conditions in a few words', () => {
    expect(conditionLabel({ field: 'nominal_kv', op: '>=', value: 230 })).toBe('Nominal (kV) ≥ 230');
    expect(conditionLabel({ field: 'fuel', op: 'in', value: ['SUN', 'WND'] })).toBe('Fuel: SUN, WND');
    expect(conditionLabel({ field: 'fuel', op: 'not_in', value: ['SUN'] })).toBe('Fuel ≠ SUN');
    expect(conditionLabel({ field: 'states', op: 'contains_any', value: ['TX', 'NM', 'OK', 'LA', 'AR'] })).toBe('States: TX, NM, OK +2 more');
    expect(whereLabel([{ field: 'a', op: '=', value: 1 }, { field: 'b', op: '=', value: 2 }])).toBe('2 filters');
    expect(whereLabel([{ field: 'a', op: '>', value: 1 }, { field: 'a', op: '<', value: 9 }])).toBe('A > 1 · A < 9');
  });

  it('collapses a long Area into one chip that clears it', () => {
    applyView({ area: { kind: 'counties', codes: ['48201', '48113', '48029', '48439', '48453', '48085', '48121'] } });
    const xs = document.querySelectorAll<HTMLElement>('#areaChips .area-chip-x');
    expect(xs.length).toBe(1);
    expect(xs[0].dataset.areaAction).toBe('clear');
    expect(q('#areaChips')!.textContent).toContain('7 selected');
  });

  it('switching a row on under an area shows its flag; off hides it', () => {
    state.area = { kind: 'states', codes: ['TX'] };
    setLayerVisibility('padus', true);
    expect(q('[data-area-flag="padus"]')!.hidden).toBe(false);
    expect(q('#areaSummary')!.hidden).toBe(false);
    setLayerVisibility('padus', false);
    expect(q('#areaSummary')!.hidden).toBe(true);
    expect(q('[data-area-flag="padus"]')!.hidden).toBe(true);
  });

  it.each(EXPERIENCES.map(e => [e.id, e] as const))('matches state after story %s', (_id, exp) => {
    applyView(experienceUrlState(exp.state));
    expectPanelMatchesState(exp.id);
  });
});

describe('region dropdown', () => {
  it('repaints the button label from the item after a language change', () => {
    state.regionScope = 'global';
    syncPanel();
    document.querySelector('.region-menu-item[data-region="global"] .region-menu-label')!.textContent = 'Mondial';
    emit('lang:changed', { locale: 'en' });
    expect(document.getElementById('regionActiveText')!.textContent).toBe('Mondial');
  });

  it('a pick re-renders the rows, writes the link once and leaves an active story pristine', () => {
    wireRegionSelect();
    beginExperience('some-story');
    emit('url:write');
    urlWrites = 0;
    document.querySelector<HTMLButtonElement>('.region-menu-item[data-region="global"]')!.click();
    expect(state.regionScope).toBe('global');
    expect(urlWrites).toBe(1);
    expect(experienceIsDirty()).toBe(false);
    expect(q(`[data-layer-id="${GEN}"]`)).toBeNull();
    expect(document.getElementById('regionActiveText')!.textContent).toBe('Global');
    expect(location.hash).toContain('region=global');
  });

  it('re-picking the active region writes nothing', () => {
    wireRegionSelect();
    document.querySelector<HTMLButtonElement>('.region-menu-item[data-region="usa"]')!.click();
    expect(urlWrites).toBe(0);
  });
});
