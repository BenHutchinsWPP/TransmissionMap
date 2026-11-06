// @vitest-environment jsdom
// The county overlay on a recording fake map built by the real layer builders:
// a paint writes only `tpl_v` feature-state on the shared county source (NRI's
// keys untouched), adds its fill + outline just above the county choropleths
// and a legend card; the next paint replaces it (one at a time, old keys
// removed); clear takes the keys, layers and legend away, only for the current
// token; Reset (map-api reset and applyView via the panel's path) clears it;
// neither a paint nor a clear writes the link or records an undo step; the
// colours are written again on the idle after new county tiles load; a failed
// frame's clear with restore brings back the overlay it replaced (not when
// that one's card is gone, or was cleared meanwhile); the legend card is
// rendered again on lang:changed. The card side: a template card's Clear
// button shows only while its overlay is the current one (and again after a
// restore), × clears it, and a Re-run that swaps the card out clears it.
// Deps: real county-overlay, layer-plan, add-all-layers, map-api, undo,
//       ui-canvas; basemap/terrain/table-open/service-render mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('./basemap.js', () => ({ switchBasemap: vi.fn(), switchProjection: vi.fn(), setBasemapLabels: vi.fn() }));
vi.mock('./terrain.js', () => ({ setTerrain3d: vi.fn(), setBuildings3d: vi.fn(), setHillshade: vi.fn() }));
vi.mock('./ui/table-open.js', () => ({ openTable: vi.fn(async () => {}), zoomToSelection: vi.fn(async () => {}) }));
vi.mock('./services/service-render.js', () => ({ renderServices: vi.fn() }));

import { state } from './state.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { seedView } from './view-state.js';
import { emit, on } from './state-bus.js';
import './url-state.js';
import { historyStamp } from './undo.js';
import { reset, setLayerVisible } from './map-api.js';
import { COUNTY_SRC } from './constants.js';
import { paintCountyOverlay, clearCountyOverlay, countyOverlayToken, countyOverlayHeld, onCountyOverlay, ownCountyOverlay, OVERLAY_KEY, OVERLAY_LAYERS } from './county-overlay.js';
import { canvasCard } from './ui/ui-canvas.js';
import { disposeAllCanvases } from './sandbox/canvas-host.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };
const fs = new Map<string, Record<string, unknown>>();
const handlers: Record<string, ((e: unknown) => void)[]> = {};
let order: string[] = [];

function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  order = [];
  const known: Record<string, unknown> = {
    on: (ev: string, fn: (e: unknown) => void) => { (handlers[ev] ??= []).push(fn); }, off: () => {},
    addLayer: (spec: Spec, before?: string) => {
      layers.set(spec.id, structuredClone(spec));
      const i = before ? order.indexOf(before) : -1;
      if (i >= 0) order.splice(i, 0, spec.id); else order.push(spec.id);
    },
    removeLayer: (id: string) => { layers.delete(id); order = order.filter(x => x !== id); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? { setUrl: () => {} } : undefined),
    getStyle: () => ({ layers: order.map(id => ({ id })) }),
    getZoom: () => 5, getCenter: () => ({ lat: 39.5, lng: -98.35 }), getBearing: () => 0, getPitch: () => 0,
    getContainer: () => document.createElement('div'),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint?.[p],
    getLayoutProperty: (id: string, p: string) => layers.get(id)?.layout?.[p],
    setPaintProperty: (id: string, p: string, v: unknown) => { const l = layers.get(id)!; l.paint = { ...l.paint, [p]: v }; },
    setLayoutProperty: (id: string, p: string, v: unknown) => { const l = layers.get(id)!; l.layout = { ...l.layout, [p]: v }; },
    setFilter: () => {},
    setFeatureState: (t: { source: string; id: string }, s: Record<string, unknown>) => {
      expect(t.source).toBe(COUNTY_SRC);
      fs.set(t.id, { ...fs.get(t.id), ...s });
    },
    removeFeatureState: (t: { id: string }, key: string) => { const s = { ...fs.get(t.id) }; delete s[key]; fs.set(t.id, s); },
  };
  state.map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() }) as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
}

let writes = 0;
on('url:write', () => { writes++; });
const LEGEND = { title: 'Substations by county', classes: [{ colour: '#ffffcc', label: '1–3' }, { colour: '#253494', label: '4–9' }], note: 'Counties with none are not shaded.' };

beforeEach(() => {
  vi.useFakeTimers();
  clearCountyOverlay();
  fs.clear();
  for (const k of Object.keys(handlers)) delete handlers[k];
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'legendContainer', hidden: true }));
  recordingMap();
  emit('map:ready');
  vi.advanceTimersByTime(500);
  writes = 0;
});
afterEach(() => { disposeAllCanvases(); vi.useRealTimers(); });

const legend = () => document.getElementById('tplCountyLegend');

describe('county overlay', () => {
  it('paints tpl_v feature-state only, on valid GEOIDs, with its layers above the county choropleths and a legend', () => {
    fs.set('48201', { nri_r: 3 });
    const token = paintCountyOverlay({ '48201': '#253494', '39049': '#ffffcc', TX: '#000000', '01001': 'red' }, LEGEND);
    expect(countyOverlayToken()).toBe(token);
    expect(fs.get('48201')).toEqual({ nri_r: 3, [OVERLAY_KEY]: '#253494' });
    expect(fs.get('39049')).toEqual({ [OVERLAY_KEY]: '#ffffcc' });
    expect(fs.has('TX')).toBe(false);
    expect(fs.has('01001')).toBe(false);
    for (const id of OVERLAY_LAYERS) expect(state.map!.getLayer(id)).toBeTruthy();
    const nri = order.indexOf('fema-nri-line');
    expect(nri).toBeGreaterThanOrEqual(0);
    expect(order.slice(nri + 1, nri + 3)).toEqual([...OVERLAY_LAYERS]);
    const l = legend()!;
    expect(l.textContent).toContain('Substations by county');
    expect(l.querySelectorAll('.legend-item')).toHaveLength(2);
    expect(document.getElementById('legendContainer')!.hidden).toBe(false);
  });

  it('one at a time: the next paint replaces the colours and the old keys go', () => {
    const a = paintCountyOverlay({ '48201': '#253494', '39049': '#ffffcc' }, LEGEND);
    const b = paintCountyOverlay({ '06037': '#41b6c4' }, { ...LEGEND, title: 'Plants by county' });
    expect(b).not.toBe(a);
    expect(fs.get('48201')).toEqual({});
    expect(fs.get('06037')).toEqual({ [OVERLAY_KEY]: '#41b6c4' });
    expect(document.querySelectorAll('#tplCountyLegend')).toHaveLength(1);
    expect(legend()!.textContent).toContain('Plants by county');
    expect(clearCountyOverlay(a)).toBe(false);
    expect(countyOverlayToken()).toBe(b);
  });

  it('clear removes keys, layers and legend, leaves other keys, and tells listeners', () => {
    fs.set('48201', { nri_r: 3 });
    const fn = vi.fn();
    const off = onCountyOverlay(fn);
    const token = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    expect(clearCountyOverlay(token)).toBe(true);
    expect(fs.get('48201')).toEqual({ nri_r: 3 });
    for (const id of OVERLAY_LAYERS) expect(state.map!.getLayer(id)).toBeUndefined();
    expect(legend()).toBeNull();
    expect(countyOverlayToken()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    // A second paint after a clear adds the layers again.
    paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    expect(state.map!.getLayer(OVERLAY_LAYERS[0])).toBeTruthy();
  });

  it('the legend card has its own Clear', () => {
    paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    legend()!.querySelector<HTMLButtonElement>('.tpl-overlay-clear')!.click();
    expect(countyOverlayToken()).toBeNull();
  });

  it('is not view state: no link write and no undo step for a paint or a clear', () => {
    const stamp = historyStamp();
    const token = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    clearCountyOverlay(token);
    vi.advanceTimersByTime(1000);
    expect(writes).toBe(0);
    expect(historyStamp()).toBe(stamp);
  });

  it('Reset clears it; a view change that is not Reset (an undoable layer switch) leaves it', () => {
    paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    setLayerVisible('eia-generators', true);
    expect(countyOverlayToken()).not.toBeNull();
    reset();
    expect(countyOverlayToken()).toBeNull();
    expect(fs.get('48201')).toEqual({});
  });

  it('a failed frame\'s clear with restore brings back the overlay it replaced', () => {
    const a = paintCountyOverlay({ '48201': '#253494' }, { ...LEGEND, title: 'A' });
    const b = paintCountyOverlay({ '06037': '#41b6c4' }, { ...LEGEND, title: 'B' });
    expect(countyOverlayHeld(a)).toBe(true);
    expect(clearCountyOverlay(b, { restore: true })).toBe(true);
    expect(countyOverlayToken()).toBe(a);
    expect(fs.get('48201')).toEqual({ [OVERLAY_KEY]: '#253494' });
    expect(fs.get('06037')).toEqual({});
    expect(legend()!.textContent).toContain('A');
    expect(state.map!.getLayer(OVERLAY_LAYERS[0])).toBeTruthy();
    // Restored once: nothing further back is held.
    expect(clearCountyOverlay(a, { restore: true })).toBe(true);
    expect(countyOverlayToken()).toBeNull();
  });

  it('no restore when the replaced overlay\'s card is gone or it was cleared meanwhile', () => {
    const a = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    ownCountyOverlay(a, () => false);
    const b = paintCountyOverlay({ '06037': '#41b6c4' }, LEGEND);
    clearCountyOverlay(b, { restore: true });
    expect(countyOverlayToken()).toBeNull();
    const c = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    const d = paintCountyOverlay({ '06037': '#41b6c4' }, LEGEND);
    expect(clearCountyOverlay(c)).toBe(false);
    expect(countyOverlayHeld(c)).toBe(false);
    clearCountyOverlay(d, { restore: true });
    expect(countyOverlayToken()).toBeNull();
    expect(fs.get('48201')).toEqual({});
  });

  it('a legend given as a function is rendered again on lang:changed', () => {
    let lang = 'en';
    paintCountyOverlay({ '48201': '#253494' }, () => ({ ...LEGEND, title: `title-${lang}`, note: `note-${lang}` }));
    expect(legend()!.textContent).toContain('title-en');
    lang = 'fr';
    emit('lang:changed', { locale: 'fr' });
    expect(legend()!.textContent).toContain('title-fr');
    expect(legend()!.textContent).toContain('note-fr');
    expect(document.querySelectorAll('#tplCountyLegend')).toHaveLength(1);
  });

  it('writes the colours again on the idle after county tiles load', () => {
    paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    fs.clear();
    for (const fn of handlers.sourcedata ?? []) fn({ sourceId: COUNTY_SRC, isSourceLoaded: true });
    for (const fn of handlers.idle ?? []) fn({});
    expect(fs.get('48201')).toEqual({ [OVERLAY_KEY]: '#253494' });
  });
});

describe('a template card that painted the overlay', () => {
  const card = (overlay: number) => {
    const c = canvasCard('t', { kind: 'html', payload: '<p>x</p>' }, { template: true, overlay });
    document.body.append(c.el);
    return c.el;
  };

  it('offers Clear map colours while its overlay is current; Clear clears it', () => {
    const token = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    const el = card(token);
    const btn = el.querySelector<HTMLButtonElement>('.chat-canvas-clear')!;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('Clear map colours');
    btn.click();
    expect(countyOverlayToken()).toBeNull();
    expect(btn.hidden).toBe(true);
  });

  it('hides Clear once another card paints, and × then leaves the new overlay alone', () => {
    const el = card(paintCountyOverlay({ '48201': '#253494' }, LEGEND));
    const next = paintCountyOverlay({ '06037': '#41b6c4' }, LEGEND);
    expect(el.querySelector<HTMLButtonElement>('.chat-canvas-clear')!.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('.chat-canvas-close')!.click();
    expect(countyOverlayToken()).toBe(next);
  });

  it('a restore shows the replaced card\'s Clear again', () => {
    const el = card(paintCountyOverlay({ '48201': '#253494' }, LEGEND));
    const next = paintCountyOverlay({ '06037': '#41b6c4' }, LEGEND);
    const btn = el.querySelector<HTMLButtonElement>('.chat-canvas-clear')!;
    expect(btn.hidden).toBe(true);
    clearCountyOverlay(next, { restore: true });
    expect(btn.hidden).toBe(false);
  });

  it('a Re-run that swaps the card out clears its overlay for good', async () => {
    const token = paintCountyOverlay({ '48201': '#253494' }, LEGEND);
    const c = canvasCard('t', { kind: 'html', payload: '<p>x</p>' }, {
      template: true, overlay: token,
      rerun: async (old: HTMLElement) => { old.replaceWith(document.createElement('div')); return null; },
    });
    document.body.append(c.el);
    disposeAllCanvases();
    const again = c.el.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!;
    expect(again).toBeTruthy();
    again.click();
    await vi.waitFor(() => expect(countyOverlayToken()).toBeNull());
    expect(fs.get('48201')).toEqual({});
    // Gone for good: a later failed frame does not bring it back.
    const next = paintCountyOverlay({ '06037': '#41b6c4' }, LEGEND);
    clearCountyOverlay(next, { restore: true });
    expect(countyOverlayToken()).toBeNull();
  });

  it('× on the current card clears the map colours', () => {
    const el = card(paintCountyOverlay({ '48201': '#253494' }, LEGEND));
    el.querySelector<HTMLButtonElement>('.chat-canvas-close')!.click();
    expect(countyOverlayToken()).toBeNull();
  });
});
