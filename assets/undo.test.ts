// @vitest-environment jsdom
// Undo/redo of the view on a recording fake map built by the real layer
// builders: undo walks back to the baseline and redo forward, a slider drag is
// one entry — burst writes, and a real MW / year / smoke slider dragged slower
// than the replace window, which commits once on 'change', and a year drag that
// switched the filter on, which also commits on pointer release even when it
// ends at its start value — a change undone within the replace window leaves no step,
// resetHistory re-baselines, a commit after an undo clears redo, an undone `where` change
// fetches nothing, opens no dialog and writes the URL once, the stack caps at
// 50, and a write that changes no view param (a language change) is no entry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('./basemap.js', async () => {
  const { state } = await import('./state.js');
  return {
    switchBasemap: vi.fn((b: string) => { state.basemap = b; }),
    switchProjection: vi.fn((p: string) => { state.projection = p; }),
    setBasemapLabels: vi.fn(),
  };
});
vi.mock('./terrain.js', async () => {
  const { state } = await import('./state.js');
  return {
    setTerrain3d: vi.fn((on: boolean) => { state.terrain3d = on; }),
    setBuildings3d: vi.fn((on: boolean) => { state.buildings3d = on; }),
    setHillshade: vi.fn((on: boolean) => { state.hillshade = on; }),
  };
});

import { state } from './state.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { setWhere } from './filters.js';
import { setLayerVisibility } from './visibility.js';
import { seedView, currentView } from './view-state.js';
import { emit } from './state-bus.js';
import { formatUrlState } from './url-state-codec.js';
import './url-state.js';
import { undo, redo, canUndo, canRedo, resetHistory } from './undo.js';
import { wireMwFilter, wireSmokeOpacity, wireYearFilter } from './ui/ui-filters.js';

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
      if (v === undefined) delete l.paint[p];
    },
    setLayoutProperty: (id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.layout = { ...l.layout, [p]: v };
      if (v === undefined) delete l.layout[p];
    },
    setFilter: (id: string, f: unknown) => {
      const l = layers.get(id)!;
      l.filter = f ?? undefined;
      if (f == null) delete l.filter;
    },
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  state.map = map as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
  return layers;
}

const snap = () => formatUrlState(currentView()).join('&');
// A finished control: state written, then its own url:write (ADR-0002).
function commit(opacity: number) {
  state.smokeOpacity = opacity;
  emit('url:write');
  vi.advanceTimersByTime(500);
}

beforeEach(() => {
  vi.useFakeTimers();
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  recordingMap();
  emit('map:ready');
  vi.advanceTimersByTime(500);
});
afterEach(() => { vi.useRealTimers(); });

wireYearFilter();   // delegated on document: wire once

// A real drag: `input` events slower than REPLACE_MS apart, then one `change`.
function drag(el: HTMLInputElement, values: number[]) {
  for (const v of values) {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function undoSteps() { let n = 0; while (undo()) n++; return n; }

describe('a slow slider drag is one undo step', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input type="range" id="mwSliderMin" min="0" max="4000" value="0">
      <input type="range" id="mwSliderMax" min="0" max="4000" value="4000">
      <input id="mwMinInput"><input id="mwMaxInput">
      <input type="range" id="smokeOpacitySlider" min="0" max="100" value="70">
      <input type="range" id="yearSlider" min="1900" max="2100" value="2000">`;
    wireMwFilter();
    wireSmokeOpacity();
  });

  it.each([
    ['MW max', 'mwSliderMax', [3800, 3500, 3200, 3000]],
    ['MW min', 'mwSliderMin', [200, 500, 800, 1000]],
    ['year', 'yearSlider', [1960, 1970, 1980, 1990]],
    ['smoke opacity', 'smokeOpacitySlider', [60, 50, 40, 30]],
  ] as const)('%s', (_name, id, values) => {
    const baseline = snap();
    const el = document.getElementById(id) as HTMLInputElement;
    drag(el, [...values]);
    expect(snap()).not.toBe(baseline);
    expect(undoSteps()).toBe(1);
    expect(snap()).toBe(baseline);
  });
});

describe('a year drag that switches the filter on commits on release', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="yearPlayBtn"></button>
      <input type="range" id="yearSlider" min="1900" max="2100" value="2000">`;
  });
  const slider = () => document.getElementById('yearSlider') as HTMLInputElement;
  const release = () => document.dispatchEvent(new Event('pointerup', { bubbles: true }));

  it('released at its start value (no change event): one step, the filter on', () => {
    state.yearFilter.year = 2000;
    const baseline = snap();
    for (const v of [2015, 2000]) {
      slider().value = String(v);
      slider().dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(500);
    }
    release();
    expect(state.yearFilter.enabled).toBe(true);
    expect(snap()).not.toBe(baseline);
    expect(undoSteps()).toBe(1);
    expect(snap()).toBe(baseline);
  });

  it('released elsewhere (release, then change): still one step', () => {
    const baseline = snap();
    drag(slider(), [1960, 1990]);   // ends with change
    release();
    expect(undoSteps()).toBe(1);
    expect(snap()).toBe(baseline);
  });

  it('grabbing the thumb during playback and releasing in place commits the year shown', () => {
    document.getElementById('yearPlayBtn')!.click();
    vi.advanceTimersByTime(state.yearPlayback.speedMs * 3 + 1);
    const shown = state.yearFilter.year;
    slider().value = String(shown);
    slider().dispatchEvent(new Event('input', { bubbles: true }));
    release();
    expect(state.yearPlayback.active).toBe(false);
    const committed = snap();
    undo();
    expect(snap()).not.toBe(committed);   // the release was a step of its own
    redo();
    expect(snap()).toBe(committed);
  });

  it('a pointer release with no year drag commits nothing', () => {
    release();
    expect(canUndo()).toBe(false);
  });
});

describe('undo / redo', () => {
  it('N commits then N undos is the baseline; redo restores the last', () => {
    const baseline = snap();
    expect(canUndo()).toBe(false);
    for (const o of [0.2, 0.4, 0.6]) commit(o);
    const last = snap();
    expect(last).not.toBe(baseline);
    for (let i = 0; i < 3; i++) expect(undo()).toBe(true);
    expect(snap()).toBe(baseline);
    expect(undo()).toBe(false);
    for (let i = 0; i < 3; i++) expect(redo()).toBe(true);
    expect(snap()).toBe(last);
    expect(canRedo()).toBe(false);
  });

  it('20 writes within 100 ms are one entry', () => {
    const baseline = snap();
    for (let i = 1; i <= 20; i++) {
      state.smokeOpacity = i / 40;
      emit('url:write');
      vi.advanceTimersByTime(5);
    }
    expect(undo()).toBe(true);
    expect(snap()).toBe(baseline);
    expect(canUndo()).toBe(false);
  });

  it('a commit after an undo clears redo', () => {
    commit(0.2);
    commit(0.4);
    undo();
    expect(canRedo()).toBe(true);
    commit(0.8);
    expect(canRedo()).toBe(false);
  });

  it('undoing a where change fetches nothing, opens no dialog and writes the URL once', () => {
    expect(setWhere('osm-substations-points', [{ field: 'nominal_kv', op: '>=', value: 345 }])).toBeNull();
    emit('url:write');
    vi.advanceTimersByTime(500);
    expect(state.where).not.toEqual({});

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const showModal = vi.fn();
    const realShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = showModal;
    const replaceState = vi.spyOn(history, 'replaceState');
    try {
      expect(undo()).toBe(true);
      expect(state.where).toEqual({});
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(showModal).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenCalledTimes(1);
    } finally {
      replaceState.mockRestore();
      vi.unstubAllGlobals();
      HTMLDialogElement.prototype.showModal = realShowModal;
    }
  });

  it('holds 50 entries', () => {
    for (let i = 1; i <= 60; i++) commit(i / 100);
    let n = 0;
    while (undo()) n++;
    expect(n).toBe(49);
    expect(state.smokeOpacity).toBe(0.11);
  });

  it('a layer switched from its checkbox is one undoable entry', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const on = !state.layerVisibility['osm-substations-points'];
    setLayerVisibility('osm-substations-points', on);
    expect(canUndo()).toBe(true);
    undo();
    expect(!!state.layerVisibility['osm-substations-points']).toBe(!on);
    vi.unstubAllGlobals();
  });

  it('a change undone by hand within the replace window leaves no step', () => {
    commit(0.2);
    state.smokeOpacity = 0.5;
    emit('url:write');
    vi.advanceTimersByTime(100);
    state.smokeOpacity = 0.2;
    emit('url:write');
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });

  it('resetHistory makes the view on the map the baseline', () => {
    commit(0.2);
    commit(0.4);
    undo();
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(true);
    resetHistory();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    commit(0.8);
    undo();
    expect(state.smokeOpacity).toBe(0.2);
  });

  it('a write that changes no view param is no entry', () => {
    emit('lang:changed', { locale: 'fr' });
    expect(canUndo()).toBe(false);
  });
});
