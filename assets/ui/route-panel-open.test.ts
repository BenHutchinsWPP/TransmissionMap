// @vitest-environment jsdom
// Tests for the route planner entry points: gated by ROUTE_ENABLED, Tools menu
// item placement, the context menu staying shut while a tool is active, and the chat's
// planRouteFromChat refusing when routing is off.
// With the real dictionaries and a stand-in ui-route.js, each way in has the route strings loaded
// before the panel code runs.
// Deps: route-panel-open.js, map-input.js and ui-route.js (mocked), state.js, i18n.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const input = vi.hoisted(() => ({ fn: null as null | ((e: unknown) => void) }));
vi.mock('../map-input.js', () => ({
  onMapContextMenu: (f: (e: unknown) => void) => { input.fn = f; return () => {}; },
}));

const seen = vi.hoisted(() => ({ open: [] as string[], chat: [] as string[], t: null as null | ((k: string) => string) }));
vi.mock('./ui-route.js', () => ({
  openRoutePanel: () => { seen.open.push(seen.t!('route.notice.title')); },
  routeForChat: async () => { seen.chat.push(seen.t!('route.notice.title')); return { ok: true, value: {} }; },
}));

import { wireRouteEntry as initRoutePanelEntry } from './route-panel-open.js';
import { state } from '../state.js';

const evt = { lngLat: { lng: 1, lat: 2 }, originalEvent: { clientX: 5, clientY: 6 } };

beforeEach(() => {
  document.body.innerHTML =
    '<div class="menu-dropdown"><button class="menu-item" data-action="open-diagnostics">S</button></div>';
  input.fn = null;
  state.measure.active = false;
  state.routePick = false;
  state.editMode = 'view';
});

describe('initRoutePanelEntry', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('registers nothing when disabled', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const m = await import('./route-panel-open.js');
    expect(m.ROUTE_ENABLED).toBe(false);
    m.initRoutePanelEntry();
    expect(document.querySelectorAll('.menu-item').length).toBe(1);
    expect(input.fn).toBeNull();
  });

  it('planRouteFromChat refuses when routing is off, without loading the route chunk', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const m = await import('./route-panel-open.js');
    expect(await m.planRouteFromChat({ from: 'A', to: 'B' })).toEqual({ ok: false, reason: 'routing is available on the dev server only' });
  });

  it('inserts the Tools item before Diagnostics', () => {
    initRoutePanelEntry();
    const items = [...document.querySelectorAll('.menu-item')];
    expect(items.length).toBe(2);
    expect(items[1].getAttribute('data-action')).toBe('open-diagnostics');
    expect(items[0].hasAttribute('data-action')).toBe(false);
  });

  it('tags the item for language switches and collapses the Tools button on click', () => {
    document.body.innerHTML =
      '<button aria-expanded="true">File</button><div class="menu-dropdown"><button class="menu-item" data-action="open-diagnostics">S</button></div>';
    initRoutePanelEntry();
    const item = document.querySelector<HTMLElement>('.menu-item:not([data-action])')!;
    expect(item.dataset.i18n).toBe('route.menu');
    item.click();
    expect(document.querySelector('.menu-dropdown')!.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the context menu only when no tool is active', () => {
    initRoutePanelEntry();
    input.fn!(evt);
    expect(document.querySelectorAll('[role=menuitem]').length).toBe(2);
    for (const set of [() => { state.measure.active = true; }, () => { state.routePick = true; },
      () => { state.editMode = 'edit'; }]) {
      state.measure.active = false; state.routePick = false; state.editMode = 'view';
      set();
      input.fn!(evt);
      expect(document.querySelector('[role=menu]')).toBeNull();
    }
  });

  it('closes on Escape', () => {
    initRoutePanelEntry();
    input.fn!(evt);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role=menu]')).toBeNull();
  });
});

describe('route strings are loaded before the panel code runs', () => {
  beforeEach(async () => { await new Promise((r) => setTimeout(r, 50)); vi.resetModules(); seen.open.length = 0; seen.chat.length = 0; });
  const fresh = async () => {
    const i18n = await import('../../src/i18n/index.js');
    seen.t = i18n.t;
    expect(i18n.t('route.notice.title')).toBe('route.notice.title');
    return import('./route-panel-open.js');
  };

  it('the Tools item', async () => {
    const m = await fresh();
    m.wireRouteEntry();
    document.querySelector<HTMLElement>('.menu-item:not([data-action])')!.click();
    await vi.waitFor(() => expect(seen.open.length).toBeGreaterThan(0));
    expect(new Set(seen.open)).toEqual(new Set(['Before you plan a route']));
  });

  it('the right-click menu', async () => {
    const m = await fresh();
    m.wireRouteEntry();
    input.fn!(evt);
    document.querySelector<HTMLElement>('[role=menuitem]')!.click();
    await vi.waitFor(() => expect(seen.open.length).toBeGreaterThan(0));
    expect(new Set(seen.open)).toEqual(new Set(['Before you plan a route']));
  });

  it('planRouteFromChat', async () => {
    const m = await fresh();
    await m.planRouteFromChat({ from: 'A', to: 'B' });
    expect(seen.chat).toEqual(['Before you plan a route']);
  });
});
