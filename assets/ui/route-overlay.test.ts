// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createRouteOverlay, ORDER, SOURCES, type OverlayMap } from './route-overlay.js';
import { SURFACE_PALETTE, type RouteSurface, type WeightImage } from '../route/route.js';

interface Fake extends Omit<OverlayMap, 'addSource' | 'triggerRepaint'> {
  layers: Map<string, Record<string, any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  sources: Map<string, unknown>;
  order: string[];
  addSource: Mock<OverlayMap['addSource']>;
  triggerRepaint: Mock<() => void>;
  calls: string[];
  paint: Record<string, unknown>;
  rendered: (() => void)[];
  repaints: number;
}

function fakeMap(): Fake {
  const m = {
    layers: new Map<string, Record<string, unknown>>(), sources: new Map(), order: [] as string[], calls: [] as string[], paint: {} as Record<string, unknown>, rendered: [] as (() => void)[], repaints: 0,
    getLayer(id: string) { return m.layers.get(id); },
    addLayer(spec: { id: string }, before?: string) {
      m.calls.push(`addLayer ${spec.id}`);
      m.layers.set(spec.id, { ...spec, before });
      const i = before ? m.order.indexOf(before) : -1;
      if (i >= 0) m.order.splice(i, 0, spec.id); else m.order.push(spec.id);
    },
    removeLayer(id: string) { m.calls.push(`removeLayer ${id}`); m.layers.delete(id); m.order.splice(m.order.indexOf(id), 1); },
    getSource(id: string) { return m.sources.get(id); },
    addSource: vi.fn((id: string, spec: unknown) => { m.calls.push(`addSource ${id}`); m.sources.set(id, { ...(spec as object), setData: vi.fn() }); }),
    removeSource(id: string) { m.calls.push(`removeSource ${id}`); m.sources.delete(id); },
    setPaintProperty(layer: string, name: string, value: unknown) {
      m.paint[`${layer}/${name}`] = value;
      const l = m.layers.get(layer);
      if (l) l.paint = { ...(l.paint as object), [name]: value };
    },
    once(_t: 'render', fn: () => void) { m.rendered.push(fn); },
    triggerRepaint: vi.fn(() => { m.repaints++; }),
    queryRenderedFeatures: () => [{ id: 'f' }],
  };
  return m as unknown as Fake;
}

const line: GeoJSON.LineString = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const ids = (m: Fake) => [...m.layers.keys()];

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
  }) as unknown as CanvasRenderingContext2D);
}
const COORDS: [[number, number], [number, number], [number, number], [number, number]] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const surfaceOf = (): RouteSurface => ({
  bands: [0.02, 0.05, 0.1, 0.2], cellsByBand: [1, 0, 0, 0], clipped: false, edgeCellsInBands: 0, bufferM: 0, classes: new Uint8Array(4),
  window: { c0: 0, r0: 0, w: 2, h: 2 } as unknown as RouteSurface['window'],
  image: { rgba: new Uint8ClampedArray(16).fill(255), width: 2, height: 2, coordinates: COORDS },
});
const weightOf = (mode: 'route' | 'cost' = 'route'): WeightImage => ({ rgba: new Uint8ClampedArray(16).fill(9), width: 2, height: 2, coordinates: COORDS, mode });

afterEach(() => vi.restoreAllMocks());

describe('route overlay', () => {
  it('inserts a layer below the next present one of ORDER', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.route(fc);
    expect(m.layers.get('rp-route-casing')?.before).toBeUndefined();   // nothing above it yet
    expect(m.layers.get('rp-route')?.before).toBeUndefined();
    ov.alternatives([{ path: line, alt: 0, name: 'Alt 1', colour: '#111' }]);
    expect(m.layers.get('rp-alts')?.before).toBe('rp-route-casing');
    expect(m.layers.get('rp-alts-label')?.before).toBe('rp-route-casing');
    ov.ghost(line);
    expect(m.layers.get('rp-ghost-casing')?.before).toBe('rp-alts');
    expect(m.layers.get('rp-ghost')?.before).toBe('rp-alts');
    ov.marker({ lngLat: [0, 0], label: 'x' });
    expect(m.layers.get('rp-marker')?.before).toBeUndefined();
  });

  it('clear(false) keeps the ghost, clear(true) removes everything', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.ghost(line);
    ov.route(fc);
    ov.crossings([{ lngLat: [0, 0], kind: 'river', mi: 1 }], ['river']);
    ov.clear(false);
    expect(ids(m).sort()).toEqual(['rp-ghost', 'rp-ghost-casing']);
    expect([...m.sources.keys()]).toEqual(['rp-ghost']);
    ov.clear(true);
    expect(ids(m)).toEqual([]);
    expect(m.sources.size).toBe(0);
  });

  it('removes layers before their sources, top layer first', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.route(fc);
    m.calls.length = 0;
    ov.clear(true);
    expect(m.calls).toEqual(['removeLayer rp-route', 'removeLayer rp-route-casing', 'removeSource rp-route']);
  });

  it('empty alternatives and crossings, and a null marker, remove', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.alternatives([{ path: line, alt: 0, name: 'A', colour: '#111' }]);
    ov.crossings([{ lngLat: [0, 0], kind: 'road', mi: 2 }], ['road']);
    ov.marker({ lngLat: [0, 0], label: 'x' });
    expect(ids(m).sort()).toEqual(['rp-alts', 'rp-alts-label', 'rp-cross', 'rp-marker', 'rp-marker-label']);
    ov.alternatives([]);
    ov.crossings([], []);
    ov.marker(null);
    expect(ids(m)).toEqual([]);
    expect(m.sources.size).toBe(0);
  });

  it('searchArea returns the legend km and draws area and chord; clearSearchArea removes them', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    const km = ov.searchArea([-120, 39], [-119, 39.5]);
    expect(km).toBeGreaterThan(0);
    expect(ids(m)).toEqual(['rp-area-fill', 'rp-area-line', 'rp-chord']);
    ov.clearSearchArea();
    expect(ids(m)).toEqual([]);
    expect(m.sources.size).toBe(0);
  });

  it('recolour updates only an existing route source', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.recolour(fc);
    expect(m.sources.size).toBe(0);
    const setData = vi.fn();
    m.sources.set('rp-route', { setData });
    ov.recolour(fc);
    expect(setData).toHaveBeenCalledWith(fc);
  });

  it('a second route call re-uses the source and layers', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.route(fc);
    m.sources.set('rp-route', { setData: vi.fn() });
    m.calls.length = 0;
    ov.route(fc);
    expect(m.calls).toEqual([]);
    expect(ov.has('rp-route')).toBe(true);
  });

  it('surface: drawn, then released; bands and holes only while shown', () => {
    stubCanvas();
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    expect(ov.surfaceBands()).toBeNull();
    const sf = surfaceOf();
    expect(ov.surface(sf, 0.05)).toBe('drawn');
    expect(m.layers.has('rp-surface')).toBe(true);
    expect(ov.surfaceBands()).toEqual(sf.bands);
    expect(ov.surfaceHole([5, 5])).toBe(false);
    m.sources.set('rp-surface', { play: vi.fn(), pause: vi.fn() });
    expect(ov.surface(sf, 0.1)).toBe('drawn');
    expect(m.repaints).toBe(1);
    expect(ov.surface(null, 0.1)).toBe('released');
    expect(ids(m)).toEqual([]);
    expect(ov.surfaceBands()).toBeNull();
    expect(SURFACE_PALETTE.length).toBeGreaterThan(1);
  });

  it('surface fails without a 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const ov = createRouteOverlay(() => fakeMap());
    expect(ov.surface(surfaceOf(), 0.05)).toBe('failed');
  });

  it('showWeight: drawn, kept, failed; the RGBA is dropped once drawn', () => {
    stubCanvas();
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    const img = weightOf('cost');
    expect(ov.showWeight(img)).toBe('drawn');
    expect(img.rgba.length).toBe(0);
    expect(m.layers.has('rp-weight')).toBe(true);
    expect(ov.weightHeld()).toEqual({ src: img, mode: 'cost' });
    expect(ov.showWeight(img)).toBe('kept');
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const other = createRouteOverlay(() => fakeMap());
    expect(other.showWeight(weightOf())).toBe('failed');
  });

  it('hideWeight keeps the canvas of the held image; releaseWeight drops it', () => {
    stubCanvas();
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    const img = weightOf();
    ov.showWeight(img);
    ov.hideWeight(img);
    expect(m.layers.has('rp-weight')).toBe(false);
    expect(ov.weightHeld()?.src).toBe(img);
    ov.hideWeight(weightOf());
    expect(ov.weightHeld()).toBeNull();
    ov.showWeight(weightOf());
    ov.releaseWeight();
    expect(ov.weightHeld()).toBeNull();
  });

  it('dimWeight sets 0.25 or 0.8 only while the layer is on', () => {
    stubCanvas();
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    ov.dimWeight(true);
    expect(m.paint).toEqual({});
    ov.showWeight(weightOf());
    ov.dimWeight(true);
    expect(m.paint['rp-weight/raster-opacity']).toBe(0.25);
    ov.dimWeight(false);
    expect(m.paint['rp-weight/raster-opacity']).toBe(0.8);
  });

  it('routeFeatureAt answers only with the route layer', () => {
    const m = fakeMap();
    const ov = createRouteOverlay(() => m);
    expect(ov.routeFeatureAt([1, 1])).toBeUndefined();
    ov.route(fc);
    expect(ov.routeFeatureAt([1, 1])).toEqual({ id: 'f' });
  });

  it('paints in ORDER: the casing under the route, the weight under the casing', () => {
    stubCanvas();
    const map = fakeMap();
    const ov = createRouteOverlay(() => map);
    ov.route(fc);
    ov.showWeight(weightOf());
    expect(map.order.indexOf('rp-route-casing')).toBeLessThan(map.order.indexOf('rp-route'));
    expect(map.order.indexOf('rp-weight')).toBeLessThan(map.order.indexOf('rp-route-casing'));
  });

  it('the crossing layer filters on the kinds it is given', () => {
    const map = fakeMap();
    const ov = createRouteOverlay(() => map);
    const pts = [{ lngLat: [0, 0] as [number, number], kind: 'pipeline', mi: 1 }];
    ov.crossings(pts, ['pipeline']);
    expect(JSON.stringify(map.layers.get('rp-cross')!.filter)).toContain('pipeline');
    ov.crossings(pts, ['road']);
    expect(JSON.stringify(map.layers.get('rp-cross')!.filter)).not.toContain('pipeline');
  });

  it('a new surface threshold reuses the canvas source: replays it and adds no second source', () => {
    stubCanvas();
    const map = fakeMap();
    const ov = createRouteOverlay(() => map);
    const sf = surfaceOf();
    ov.surface(sf, 0.05);
    const src = map.sources.get('rp-surface') as unknown as { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
    src.play = vi.fn();
    src.pause = vi.fn();
    const added = map.addSource.mock.calls.filter((c) => c[0] === 'rp-surface').length;
    ov.surface(sf, 0.02);
    ov.surface(sf, 0.10);
    expect(src.play).toHaveBeenCalledTimes(2);
    expect(map.triggerRepaint).toHaveBeenCalled();
    expect(map.addSource.mock.calls.filter((c) => c[0] === 'rp-surface').length).toBe(added);
  });

  it('surfaceHole is true on a transparent pixel enclosed by drawn ones, false on a drawn pixel and outside', () => {
    stubCanvas();
    const map = fakeMap();
    const ov = createRouteOverlay(() => map);
    const c1 = [...SURFACE_PALETTE[1]], none = [0, 0, 0, 0];
    const rgba = new Uint8ClampedArray([c1, c1, c1, c1, none, c1, c1, c1, c1].flat());   // a 3 x 3 ring
    const sf = { ...surfaceOf(), image: { rgba, width: 3, height: 3, coordinates: COORDS } };
    expect(ov.surface(sf, 0.05)).toBe('drawn');
    expect(ov.surfaceHole([0.5, 0.5])).toBe(true);
    expect(ov.surfaceHole([0.2, 0.8])).toBe(false);
    expect(ov.surfaceHole([2, 0.5])).toBe(false);
  });

  it('the weight layer is 0.8 opaque and drops while another mode is pending; the same canvas source takes a repaint', () => {
    stubCanvas();
    const map = fakeMap();
    const ov = createRouteOverlay(() => map);
    ov.showWeight(weightOf());
    const paint = () => (map.getLayer('rp-weight') as unknown as { paint: Record<string, number> }).paint['raster-opacity'];
    expect(paint()).toBe(0.8);
    ov.dimWeight(true);
    expect(paint()).toBeLessThan(0.8);
    ov.dimWeight(false);
    expect(paint()).toBe(0.8);
    expect(map.addSource.mock.calls.filter((c) => c[0] === 'rp-weight')).toHaveLength(1);
  });

  it('is a no-op without a map', () => {
    const ov = createRouteOverlay(() => null);
    ov.route(fc); ov.recolour(fc); ov.alternatives([{ path: line, alt: 0, name: 'A', colour: '#111' }]);
    ov.crossings([{ lngLat: [0, 0], kind: 'road', mi: 1 }], ['road']); ov.marker({ lngLat: [0, 0], label: 'x' }); ov.marker(null);
    ov.ghost(line); ov.ghost(null); ov.clear(true); ov.clearSearchArea(); ov.releaseWeight(); ov.dimWeight(true); ov.hideWeight(null);
    expect(ov.searchArea([-120, 39], [-119, 39.5])).toBeGreaterThan(0);
    expect(ov.has('rp-route')).toBe(false);
    expect(ov.surface(surfaceOf(), 0.05)).toBe('released');
    expect(ov.showWeight(weightOf())).toBe('failed');
    expect(ov.surfaceBands()).toBeNull();
    expect(ov.surfaceHole([0, 0])).toBe(false);
    expect(ov.routeFeatureAt([0, 0])).toBeUndefined();
    expect(ov.weightHeld()).toBeNull();
  });

  it('every layer id is rp- prefixed and in ORDER; sources too', () => {
    expect(ORDER.every((i) => i.startsWith('rp-'))).toBe(true);
    expect(SOURCES.every((i) => i.startsWith('rp-'))).toBe(true);
  });
});
