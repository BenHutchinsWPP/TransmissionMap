// renderServices diffs state.services against a fake map: add, update (paint,
// visibility, style kind), remove; a service that is neither vetted nor
// approved gets no source and no fetch, only the 'pending-approval' status; a
// repaint with nothing changed fetches nothing; a source carries no HTML
// attribution; a library id survives only when the library entry it names matches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';

const approved = new Set<string>();
vi.mock('./service-trust.js', () => ({
  isAllowed: (s: { url: string }) => s.url.startsWith('https://vetted.gov/') || approved.has(s.url),
}));

import { state } from '../state.js';
import { renderServices, serviceLibraryEntry, libraryChecked } from './service-render.js';
import LIBRARY from '../../src/registry/service-library.json';
import { serviceStatus } from './service-load.js';
import type { LinkedService } from './service-spec.js';

function fakeMap() {
  const sources = new Map<string, SourceSpecification & { setData?: (d: unknown) => void }>();
  const layers: LayerSpecification[] = [{ id: 'base', type: 'background' } as LayerSpecification];
  const calls: string[] = [];
  const find = (id: string) => layers.find(l => l.id === id);
  return {
    sources, layers, calls,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: SourceSpecification) => { calls.push('addSource ' + id); sources.set(id, { ...s, setData: vi.fn() }); },
    removeSource: (id: string) => { calls.push('removeSource ' + id); sources.delete(id); },
    getLayer: (id: string) => find(id),
    addLayer: (l: LayerSpecification, before?: string) => {
      calls.push(`addLayer ${l.id}${before ? ' < ' + before : ''}`);
      const i = before ? layers.findIndex(x => x.id === before) : -1;
      layers.splice(i < 0 ? layers.length : i, 0, structuredClone(l));
    },
    removeLayer: (id: string) => { calls.push('removeLayer ' + id); layers.splice(layers.findIndex(l => l.id === id), 1); },
    setPaintProperty: (id: string, k: string, v: unknown) => { calls.push(`paint ${id} ${k}=${JSON.stringify(v)}`); },
    setLayoutProperty: (id: string, k: string, v: unknown) => { calls.push(`layout ${id} ${k}=${v}`); },
    getStyle: () => ({ layers }),
    getZoom: () => 10,
    getBounds: () => ({ getWest: () => -1, getSouth: () => -1, getEast: () => 1, getNorth: () => 1 }),
    on: () => {},
  };
}

const xyz = (over: Partial<LinkedService> = {}): LinkedService => ({
  id: 'a', kind: 'xyz', url: 'https://vetted.gov/tiles/{z}/{x}/{y}.png', host: 'vetted.gov',
  title: 'Tiles', credit: 'Vetted', visible: true, style: { kind: 'raster', color: '#000000', opacity: 0.8 }, ...over,
});
const gj = (over: Partial<LinkedService> = {}): LinkedService => ({
  id: 'g', kind: 'geojson', url: 'https://other.org/data.geojson', host: 'other.org',
  title: 'Data', credit: 'Other', visible: true, style: { kind: 'circle', color: '#ff0000', opacity: 1 }, ...over,
});

let map: ReturnType<typeof fakeMap>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  map = fakeMap();
  state.map = map as unknown as typeof state.map;
  state.mapReady = true;
  state.services = [];
  approved.clear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  state.services = [];
  renderServices();
  state.map = null;
  state.mapReady = false;
  vi.unstubAllGlobals();
});

describe('renderServices', () => {
  it('is a no-op before the map has loaded', () => {
    state.mapReady = false;
    state.services = [xyz()];
    renderServices();
    expect(map.calls).toEqual([]);
  });

  it('adds a vetted service below My Data and highlight layers, once', () => {
    map.layers.push({ id: 'user-1-fill', type: 'fill', source: 'user-1' } as LayerSpecification,
      { id: 'highlight-lines', type: 'line', source: 'h' } as LayerSpecification);
    state.services = [xyz()];
    renderServices();
    renderServices();
    expect(map.calls).toEqual(['addSource svc-a', 'addLayer svc-a-raster < user-1-fill']);
    expect(map.layers.map(l => l.id)).toEqual(['base', 'svc-a-raster', 'user-1-fill', 'highlight-lines']);
    expect((map.sources.get('svc-a') as { tiles: string[] }).tiles[0]).toBe('https://vetted.gov/tiles/{z}/{x}/{y}.png');
    expect(serviceStatus('a')).toEqual({ state: 'ok' });
  });

  it('updates paint and visibility in place', () => {
    state.services = [xyz()];
    renderServices();
    map.calls.length = 0;
    state.services = [xyz({ visible: false, style: { kind: 'raster', color: '#000000', opacity: 0.3 } })];
    renderServices();
    expect(map.calls).toEqual(['paint svc-a-raster raster-opacity=0.3', 'layout svc-a-raster visibility=none']);
  });

  it('swaps layers (not the source) on a style-kind change, and the source on a URL change', () => {
    approved.add('https://other.org/data.geojson');
    state.services = [gj()];
    renderServices();
    map.calls.length = 0;
    state.services = [gj({ style: { kind: 'fill', color: '#ff0000', opacity: 1 } })];
    renderServices();
    expect(map.calls).toEqual(['removeLayer svc-g-circle', 'addLayer svc-g-fill']);
    map.calls.length = 0;
    approved.add('https://other.org/b.geojson');
    state.services = [gj({ url: 'https://other.org/b.geojson', style: { kind: 'fill', color: '#ff0000', opacity: 1 } })];
    renderServices();
    expect(map.calls).toEqual(['removeLayer svc-g-fill', 'removeSource svc-g', 'addSource svc-g', 'addLayer svc-g-fill']);
  });

  it('removes a service that left the view, and clears its status', () => {
    state.services = [xyz()];
    renderServices();
    map.calls.length = 0;
    state.services = [];
    renderServices();
    expect(map.calls).toEqual(['removeLayer svc-a-raster', 'removeSource svc-a']);
    expect(serviceStatus('a')).toBeUndefined();
  });

  it('gives an unapproved, unvetted service no source and no fetch', async () => {
    state.services = [gj()];
    renderServices();
    await Promise.resolve();
    expect(map.calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(serviceStatus('g')).toEqual({ state: 'pending-approval' });
  });

  it('loads an approved service, and takes it down again when approval is gone', async () => {
    approved.add('https://other.org/data.geojson');
    state.services = [gj()];
    renderServices();
    await vi.waitFor(() => expect(serviceStatus('g')).toEqual({ state: 'ok', count: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(map.sources.get('svc-g')!.setData).toHaveBeenCalled();
    approved.clear();
    renderServices();
    expect(map.sources.has('svc-g')).toBe(false);
    expect(serviceStatus('g')).toEqual({ state: 'pending-approval' });
  });

  it('fetches a feature service once across repaints that change nothing, and when it is switched on', async () => {
    approved.add('https://other.org/data.geojson');
    state.services = [gj()];
    renderServices();
    await vi.waitFor(() => expect(serviceStatus('g')).toEqual({ state: 'ok', count: 0 }));
    renderServices();
    state.services = structuredClone(state.services);
    renderServices();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    approved.add('https://other.org/b.geojson');
    state.services = [...state.services, gj({ id: 'h', url: 'https://other.org/b.geojson', visible: false })];
    renderServices();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    state.services = [gj(), gj({ id: 'h', url: 'https://other.org/b.geojson', visible: true })];
    renderServices();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.lastCall![0])).toBe('https://other.org/b.geojson');
  });

  it('queries an ArcGIS layer once across repaints that change nothing (moveend does the rest)', async () => {
    const url = 'https://vetted.gov/arcgis/rest/services/X/FeatureServer';
    fetchMock.mockImplementation(async (u: string) => new Response(JSON.stringify(String(u).includes('/query?')
      ? { type: 'FeatureCollection', features: [] }
      : { geometryType: 'esriGeometryPoint', maxRecordCount: 1000, supportedQueryFormats: 'geoJSON' })));
    const queries = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/query?')).length;
    state.services = [gj({ id: 'f', kind: 'arcgis-feature', url, host: 'vetted.gov', layer: '0' })];
    renderServices();
    await vi.waitFor(() => expect(serviceStatus('f')).toEqual({ state: 'ok', count: 0 }));
    renderServices();
    state.services = structuredClone(state.services);
    renderServices();
    await new Promise(r => setTimeout(r, 0));
    expect(queries()).toBe(1);
  });

  it('gives a source no attribution, so an HTML credit never reaches MapLibre', () => {
    state.services = [xyz({ credit: '<img src=x onerror=alert(1)>' })];
    renderServices();
    expect(map.sources.get('svc-a')).not.toHaveProperty('attribution');
    expect(JSON.stringify([...map.sources.values()])).not.toContain('<img');
  });
});

describe('library ids', () => {
  const lib = (LIBRARY as unknown as LinkedService[]).find(e => e.kind === 'geojson')!;
  const fromLink = (over: Partial<LinkedService> = {}): LinkedService => gj({
    id: 'L', url: lib.url, host: new URL(lib.url).hostname, title: 'Link title', credit: 'Link credit',
    libraryId: (lib as unknown as { id: string }).id, ...over,
  });

  it('keeps a library id whose entry matches, taking the library\'s title and credit', async () => {
    state.services = [fromLink()];
    renderServices();
    await libraryChecked();
    expect(state.services[0]).toMatchObject({ libraryId: (lib as unknown as { id: string }).id, title: lib.title, credit: lib.credit });
    expect(serviceLibraryEntry(state.services[0])?.licence).toBeTruthy();
  });

  it('drops a library id whose entry has another url, kind or layer, keeping the link\'s text', async () => {
    for (const over of [{ url: 'https://other.org/data.geojson', host: 'other.org' }, { libraryId: 'no-such-entry' }, { layer: '3' }]) {
      state.services = [fromLink(over)];
      renderServices();
      await libraryChecked();
      expect(state.services[0].libraryId).toBeUndefined();
      expect(state.services[0]).toMatchObject({ title: 'Link title', credit: 'Link credit' });
      expect(serviceLibraryEntry(fromLink(over))).toBeUndefined();
    }
  });
});
