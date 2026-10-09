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
import { renderPanel, syncPanel } from './panel-mirror.js';
import { mwToPos } from '../filters.js';
import { loadDictionary, setLocale } from '../../src/i18n/index.js';
import { wireGenModeToggle } from './ui-filters.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };

// As in view-state-paint.test.ts.
function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  const known: Record<string, unknown> = {
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
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
const modeOf = (id: string) => state.genMode[id] || LAYERS.find(l => l.id === id)!.defaultMode || 'icons';

/** Every mirrored control in the panel against `state`. */
function expectPanelMatchesState(where = '') {
  for (const entry of LAYERS) {
    if (!hasPanelRow(entry)) continue;
    const on = !!state.layerVisibility[entry.id];
    const cb = q<HTMLInputElement>(`input[type=checkbox][data-layer-id="${entry.id}"]`);
    expect(cb?.checked, `${where} ${entry.id} checkbox`).toBe(on);
    if (entry.heatLayerId || entry.modes) {
      const mode = modeOf(entry.id);
      expect(q(`#${entry.id}-heat-ramp`)!.hidden, `${where} ${entry.id} ramp`).toBe(!heatRampShown(entry, on, mode));
      const active = [...document.querySelectorAll<HTMLElement>(`[data-gen-mode-layer="${entry.id}"].gen-mode-btn--active`)];
      expect(active.map(b => b.dataset.genMode), `${where} ${entry.id} mode`).toEqual([mode]);
    }
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
  if (hasPanelRow(LAYERS.find(l => l.id === GEN)!)) {
    const slider = q<HTMLInputElement>('#yearSlider')!;
    expect(slider.value, `${where} year`).toBe(String(state.yearFilter.year));
    expect(slider.classList.contains('year-slider--off'), `${where} year off`).toBe(!state.yearFilter.enabled);
    if (state.yearFilter.enabled) expect(q('#yearReadout')!.textContent).toBe(String(state.yearFilter.year));
  }
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
