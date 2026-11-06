// @vitest-environment jsdom
// The Proximity map half over a fake map: layers added once and data replaced on a new
// result, removed in order on close, removed by the Reset helper, a tap on a point calls
// focusPoint with its index, a row click flies and filters, and the bubble layers carry
// the threshold's radius and stop at bubbleMaxZoom.
// Deps: proximity-map.ts, proximity/clear.ts, state.ts (state.map set to a fake), map-input.ts (mocked).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ tap: null as null | ((e: unknown, f: unknown[]) => void), tapOff: vi.fn() }));
vi.mock('../map-input.js', () => ({
  onMapTap: (_id: string, fn: (e: unknown, f: unknown[]) => void) => { mocks.tap = fn; return () => { mocks.tapOff(); mocks.tap = null; }; },
}));

const { state } = await import('../state.js');
const pm = await import('./proximity-map.js');
const { clearProximityMap } = await import('../proximity/clear.js');
const { bubbleRadiusExpr, bubbleMaxZoom, bubblePx } = await import('../proximity/bubbles.js');

function fakeMap() {
  const sources = new Map<string, { data: GeoJSON.FeatureCollection; setData(d: GeoJSON.FeatureCollection): void }>();
  const layers: string[] = [];
  const log: string[] = [];
  const filters: Record<string, unknown> = {};
  const paint: Record<string, unknown> = {};
  const range: Record<string, [number, number]> = {};
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: { data: GeoJSON.FeatureCollection }) => { log.push(`addSource ${id}`); sources.set(id, { data: spec.data, setData(d) { this.data = d; log.push(`setData ${id}`); } }); },
    getLayer: (id: string) => layers.includes(id) ? { id } : undefined,
    addLayer: (spec: { id: string }) => { log.push(`addLayer ${spec.id}`); layers.push(spec.id); },
    removeLayer: (id: string) => { log.push(`removeLayer ${id}`); layers.splice(layers.indexOf(id), 1); },
    removeSource: (id: string) => { log.push(`removeSource ${id}`); sources.delete(id); },
    setFilter: (id: string, f: unknown) => { filters[id] = f; },
    setPaintProperty: (id: string, k: string, v: unknown) => { paint[`${id} ${k}`] = v; },
    setLayerZoomRange: (id: string, lo: number, hi: number) => { range[id] = [lo, hi]; },
    fitBounds: vi.fn(), flyTo: vi.fn(), getZoom: () => 2,
  };
  return { map, sources, layers, log, filters, paint, range };
}

const lon = new Float64Array([-100, -100.001, -90]);
const lat = new Float64Array([40, 40, 30]);
const mk = (group: number[], km = 1) => ({ lon, lat, km, result: { group: Int32Array.from(group) } });

describe('proximity map half', () => {
  let f: ReturnType<typeof fakeMap>;
  let result: (s: ReturnType<typeof mk> | null) => void;
  let row: (i: number) => void;
  let fly: (i: number) => void;
  const focusPoint = vi.fn();
  beforeEach(() => {
    pm.resetProximityMapForTest();
    f = fakeMap();
    (state as { map: unknown }).map = f.map;
    focusPoint.mockClear();
    pm.startProximityMap({
      onResult: cb => { result = cb as typeof result; return () => {}; },
      onRow: cb => { row = cb; return () => {}; },
      onFly: cb => { fly = cb; return () => {}; },
      focusPoint,
      padding: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
    });
  });

  it('adds layers once, replaces data on a new result, fits once per file', () => {
    result(mk([1, 1, 0]));
    expect(f.layers).toEqual(['px-bubbles', 'px-points', 'px-focus', 'px-focus-pt']);
    expect(f.sources.get('px-points')!.data.features).toHaveLength(2);
    expect(f.map.fitBounds).toHaveBeenCalledTimes(1);
    f.log.length = 0;
    result(mk([1, 1, 2]));
    expect(f.log.filter(l => l.startsWith('addLayer') || l.startsWith('addSource'))).toEqual([]);
    expect(f.log).toContain('setData px-points');
    expect(f.sources.get('px-points')!.data.features).toHaveLength(3);
    expect(f.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('fits on the first result that has points, even when the first had no groups', () => {
    result(mk([0, 0, 0]));
    expect(f.map.fitBounds).not.toHaveBeenCalled();
    result(mk([1, 1, 0]));
    expect(f.map.fitBounds).toHaveBeenCalledTimes(1);
    result(mk([1, 1, 2]));
    expect(f.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('sizes the bubbles from the threshold and caps their zoom', () => {
    result(mk([1, 1, 0], 10));
    result(mk([1, 1, 0], 3));
    for (const id of ['px-bubbles', 'px-focus']) {
      expect(f.paint[`${id} circle-radius`]).toEqual(bubbleRadiusExpr(3));
      expect(f.range[id]).toEqual([0, bubbleMaxZoom(3, 1 / Math.cos(40 * Math.PI / 180))]);
    }
  });

  it('removes layers, then sources, on close', () => {
    result(mk([1, 1, 0]));
    f.log.length = 0;
    result(null);
    expect(f.log).toEqual(['removeLayer px-focus-pt', 'removeLayer px-focus', 'removeLayer px-points', 'removeLayer px-bubbles', 'removeSource px-points']);
    expect(mocks.tap).toBeNull();
  });

  it('the Reset helper removes them, and the next result redraws', () => {
    result(mk([1, 1, 0]));
    clearProximityMap();
    expect(f.layers).toEqual([]);
    expect(f.sources.size).toBe(0);
    result(mk([1, 1, 0]));
    expect(f.layers).toHaveLength(4);
    expect(f.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('a tap on a point focuses its row and highlights it', () => {
    result(mk([1, 1, 0]));
    mocks.tap!({}, [{ properties: { i: 1, g: 1 } }]);
    expect(focusPoint).toHaveBeenCalledWith(1);
    expect(f.filters['px-focus-pt']).toEqual(['==', ['get', 'i'], 1]);
    expect(f.filters['px-focus']).toEqual(['==', ['get', 'g'], 1]);
  });

  it('a row click outlines the point and group and does not move the camera', () => {
    result(mk([1, 1, 2]));
    row(2);
    expect(f.map.flyTo).not.toHaveBeenCalled();
    expect(f.filters['px-focus']).toEqual(['==', ['get', 'g'], 2]);
    expect(f.filters['px-focus-pt']).toEqual(['==', ['get', 'i'], 2]);
  });

  it('the zoom button flies to the point and filters its group', () => {
    result(mk([1, 1, 2]));
    fly(2);
    const arg = f.map.flyTo.mock.calls[0][0];
    expect(arg.center).toEqual([-90, 30]);
    expect(arg.zoom).toBeGreaterThan(3);
    expect(bubblePx(1, 1 / Math.cos(30 * Math.PI / 180), arg.zoom)).toBeCloseTo(100, 6);
    expect(f.filters['px-focus']).toEqual(['==', ['get', 'g'], 2]);
  });
});
