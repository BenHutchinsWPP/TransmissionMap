// ─── Test environment for the bottom drawer (tests only) ────────────────────
// jsdom has no ResizeObserver or matchMedia, and the drawer reads the map's
// canvas and container: installDrawerEnv() stubs both globals (matchMedia
// answers `compact` for every query, default false), adds a `.map-container`
// to the body and sets a minimal state.map (getCanvas, getContainer,
// fitBounds, getZoom, getLayer); jsdom lays nothing out, so inside the
// table's grid (.td-grid, Tabulator; also the proximity .px-grid and the Method .rm-grid) elements measure 600 × 800 px and a row
// 26 px high, enough for its virtual renderer to draw rows; resetDrawerEnv()
// undoes all of it.
// Used by *.test.ts files that open the drawer (ui-table.test.ts) and by method-grid.test.ts.
// mockMarker() returns a stand-in for maplibre-gl's Marker (setLngLat, addTo,
// remove, getLngLat, on, setDraggable, getElement; chainable, with `emit(name)`
// to fire a registered handler). Use it inside the hoisted-safe factory:
//   vi.mock('maplibre-gl', async () => ({ default: { Marker: (await import('./test-drawer-env.js')).mockMarker() } }));
// Deps: vitest (vi), state.ts.

import { vi } from 'vitest';
import { state } from '../state.js';

export interface DrawerEnv {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  map: { fitBounds: ReturnType<typeof vi.fn>; getZoom: () => number };
}

const SIZES = ['clientHeight', 'offsetHeight', 'clientWidth', 'offsetWidth'] as const;
let sized: Map<string, PropertyDescriptor | undefined> | null = null;   // HTMLElement's own getters, to put back

/** Stub the browser APIs and the map the drawer needs; `compact` is what
 *  matchMedia answers (a phone or a short screen). */
export function installDrawerEnv(opts: { compact?: boolean } = {}): DrawerEnv {
  if (!sized) {
    sized = new Map(SIZES.map(k => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]));
    for (const k of SIZES) {
      // The getter jsdom defines (on Element or HTMLElement), shadowed on HTMLElement.
      let proto: object | null = HTMLElement.prototype, own: PropertyDescriptor | undefined;
      while (proto && !(own = Object.getOwnPropertyDescriptor(proto, k))) proto = Object.getPrototypeOf(proto);
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get(this: HTMLElement) {
          if (!this.closest('.td-grid, .px-grid, .rm-grid')) return own?.get?.call(this) ?? 0;
          if (k.endsWith('Width')) return 800;
          return this.classList.contains('tabulator-row') ? 26 : 600;
        },
      });
    }
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: !!opts.compact, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }));
  let container = document.querySelector<HTMLElement>('.map-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'map-container';
    document.body.append(container);
  }
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  container.append(canvas);
  const map = {
    getCanvas: () => canvas,
    getContainer: () => container,
    fitBounds: vi.fn(),
    getZoom: () => 4,
    getLayer: () => undefined,
  };
  state.map = map as unknown as typeof state.map;
  return { container, canvas, map };
}

/** Undo installDrawerEnv: the globals and state.map. The drawer itself is a
 *  module singleton and stays in the container. */
export function resetDrawerEnv(): void {
  for (const [k, d] of sized ?? []) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  sized = null;
  vi.unstubAllGlobals();
  state.map = null;
}

/** A minimal maplibre-gl Marker double; `instances` records every one built. */
export function mockMarker() {
  return class MockMarker {
    static instances: MockMarker[] = [];
    lngLat: [number, number] = [0, 0];
    el = document.createElement('div');
    handlers: Record<string, Array<() => void>> = {};
    draggable = false;
    constructor() { MockMarker.instances.push(this); }
    setLngLat(ll: [number, number]) { this.lngLat = ll; return this; }
    getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
    addTo() { document.body.append(this.el); return this; }
    remove() { this.el.remove(); return this; }
    on(name: string, fn: () => void) { (this.handlers[name] ??= []).push(fn); return this; }
    setDraggable(v: boolean) { this.draggable = v; return this; }
    getElement() { return this.el; }
    emit(name: string) { (this.handlers[name] ?? []).forEach(f => f()); }
  };
}
