// @vitest-environment jsdom
// The real route panel with the real dictionaries: opened from the Tools item or the right-click menu,
// it shows English route text and no raw `route.*` key, and a language switch with it open reaches the
// Spanish text. Only the solver, popup, batch, map input, MapLibre and the layer loader are mocked.
// Deps: route-panel-open.js, ui-route.js (real), ui-table.js, i18n (real), test-drawer-env.js, route-tabs/fixture.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const input = vi.hoisted(() => ({ ctx: null as null | ((e: unknown) => void) }));
vi.mock('../route/route-open.js', () => ({
  routeLine: vi.fn(() => new Promise(() => {})),
  inspectCell: vi.fn(() => new Promise(() => {})),
  repaintWeight: vi.fn(() => new Promise(() => {})),
  repaintRows: vi.fn(() => new Promise(() => {})),
  exactCrossings: vi.fn(() => new Promise(() => {})),
  dropWindow: vi.fn(),
  cancelRoute: vi.fn(() => false),
}));
vi.mock('../popup.js', () => ({ setRouteTapClaims: vi.fn() }));
vi.mock('./route-batch.js', () => ({ mountBatch: () => ({ dispose: vi.fn() }) }));
vi.mock('../map-input.js', () => ({
  onMapTap: () => () => {},
  onMapPoint: () => () => {},
  onMapHover: () => () => {},
  onMapPointLeave: () => () => {},
  onMapContextMenu: (f: (e: unknown) => void) => { input.ctx = f; return () => {}; },
}));
vi.mock('maplibre-gl', async () => {
  const Marker = (await import('./test-drawer-env.js')).mockMarker();
  return { Marker, default: { Marker } };
});
vi.mock('../layers/layer-data.js', () => ({ loadSource: async () => {} }));

import { wireRouteEntry } from './route-panel-open.js';
import { closeRoute } from './ui-table.js';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import { state } from '../state.js';
import { emit } from '../state-bus.js';
import { t, loadDictionary, setLocale, updateDomTranslations } from '../../src/i18n/index.js';
import en from '../../src/i18n/locales/en.js';
import enRoute from '../../src/i18n/route/en.js';
import esRoute from '../../src/i18n/route/es.js';
import es from '../../src/i18n/locales/es.js';
import { acceptNotice, ROUTE_NOTICE_VERSION } from './notice-gate.js';

const RAW = /\broute\.[a-z]/;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Every text node and attribute value under the route panel's surfaces that still shows a raw key. */
function rawKeys(): string[] {
  const roots = ['#td-route', '.td-route-actions', '.td-tabs', '#legendContainer'].flatMap((s) => [...document.querySelectorAll(s)]);
  const bad: string[] = [];
  for (const r of roots) {
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (RAW.test(n.textContent ?? '')) bad.push(`text: ${n.textContent}`);
    for (const el of [r, ...r.querySelectorAll('*')]) {
      for (const a of el.getAttributeNames()) {
        if (a.startsWith('data-i18n')) continue;   // the key itself, not what is shown
        if (RAW.test(el.getAttribute(a) ?? '')) bad.push(`${a}: ${el.getAttribute(a)}`);
      }
    }
  }
  return bad;
}
// the chunk and its libraries load on first use
const opened = () => vi.waitFor(() => { if (!document.querySelector('#td-route .rp-inputs')) throw new Error('not open'); }, { timeout: 4000 });
const shown = () => document.querySelector('#td-route')!.textContent ?? '';

beforeEach(() => {
  acceptNotice('route', ROUTE_NOTICE_VERSION);
  const env = installDrawerEnv();
  const layers = new Map<string, unknown>(); const sources = new Map<string, unknown>();
  state.map = {
    ...env.map, doubleClickZoom: { enable() {}, disable() {} },
    addSource: (id: string, s: unknown) => { sources.set(id, s); }, getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (s: { id: string }) => { layers.set(s.id, s); }, getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => { layers.delete(id); }, setPaintProperty() {}, queryRenderedFeatures: () => [], once() {}, triggerRepaint() {},
    on() {}, off() {},
  } as unknown as typeof state.map;
  state.sourcesData = {};
  document.body.insertAdjacentHTML('beforeend',
    '<div id="legendContainer"></div><div class="menu-dropdown"><button class="menu-item" data-action="open-diagnostics">D</button></div>');
  input.ctx = null;
  setLocale('en');
});
afterEach(async () => {
  closeRoute(); resetDrawerEnv(); setLocale('en'); await loadDictionary('en');
  document.querySelectorAll('#legendContainer, .menu-dropdown, [role=menu]').forEach((e) => e.remove());   // the drawer stays: ui-table keeps its nodes
});

describe('route panel strings through the real entry points', () => {
  it('Tools item: English route text, no raw key, then Spanish after a language switch', async () => {
    wireRouteEntry();
    const item = document.querySelector<HTMLElement>('.menu-item:not([data-action])')!;
    expect(item.textContent).toBe(en['route.menu']);
    item.click();
    await opened();
    expect(shown().length).toBeGreaterThan(50);
    expect(shown()).toContain(enRoute['route.idle']);
    expect(rawKeys()).toEqual([]);
    expect(document.querySelector('#td-tab-route')!.textContent).toContain(en['route.tab']);

    // Settings' own sequence
    await loadDictionary('es');
    setLocale('es');
    updateDomTranslations();
    emit('lang:changed', { locale: 'es' });
    await flush();
    expect(rawKeys()).toEqual([]);
    expect(document.querySelector('#td-tab-route')!.textContent).toContain(es['route.tab']);
    expect(shown()).toContain(esRoute['route.idle']);
    expect(esRoute['route.idle']).not.toBe(enRoute['route.idle']);
    expect(t('route.idle')).toBe(esRoute['route.idle']);
  });

  it('right-click path: Route from here loads the strings before the panel draws', async () => {
    wireRouteEntry();
    input.ctx!({ lngLat: { lng: -119.3, lat: 45.9 }, originalEvent: { clientX: 5, clientY: 6 } });
    const from = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')][0];
    expect(from.textContent).toBe(en['route.ctxFrom']);
    from.click();
    await opened();
    expect(shown().length).toBeGreaterThan(50);
    expect(shown()).toContain(enRoute['route.idle']);
    expect(rawKeys()).toEqual([]);
  });
});
