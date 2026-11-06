// Linked-service loading: capped fetch, the ArcGIS error envelope and token
// refusal, paging, Esri JSON conversion, the per-view loader (zoom gate,
// debounced refetch, stale answers dropped). fetch is mocked throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { state } from '../state.js';
import { setLocale } from '../../src/i18n/index.js';
import {
  fetchText, fetchJson, envelopeError, esriGeometry, esriToFeatures, loadArcgisFeatures,
  detectDrawKind, loadService, unloadService, serviceStatus, serviceStatusText, onServiceStatus,
  MAX_PAGES, PAGE_SIZE_MAX,
} from './service-load.js';
import type { LinkedService, ServiceSpec } from './service-spec.js';

type Reply = unknown | (() => Promise<Response>);
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
let n = 0;
const uniqueUrl = () => `https://example.gov/arcgis/rest/services/T${++n}/FeatureServer`;

function mockFetch(route: (url: URL) => Reply) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const r = route(url);
    return typeof r === 'function' ? (r as () => Promise<Response>)() : json(r);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const info = (over: Record<string, unknown> = {}) => ({
  geometryType: 'esriGeometryPoint', maxRecordCount: 1000,
  advancedQueryCapabilities: { supportsPagination: true }, supportedQueryFormats: 'JSON, geoJSON', ...over,
});
const pts = (k: number) => Array.from({ length: k }, (_, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [i, 0] } }));
const isQuery = (u: URL) => u.pathname.endsWith('/query');

beforeEach(() => setLocale('en'));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fetchText / fetchJson', () => {
  it('refuses a body past the cap as it streams', async () => {
    mockFetch(() => () => Promise.resolve(new Response('x'.repeat(5000))));
    const r = await fetchText('https://a.gov/x', 1000, 1000);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/more data/) });
  });

  it('refuses on a Content-Length past the cap', async () => {
    mockFetch(() => () => Promise.resolve(new Response('{}', { headers: { 'content-length': '999999' } })));
    expect((await fetchText('https://a.gov/x', 1000, 1000)).ok).toBe(false);
  });

  it('times out', async () => {
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_, rej) =>
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const r = await fetchText('https://a.gov/x', 1000, 10);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/too long/) });
  });

  it('reports an HTTP error and non-JSON', async () => {
    mockFetch(() => () => Promise.resolve(new Response('nope', { status: 500 })));
    expect(await fetchJson('https://a.gov/x', 1000, 1000)).toEqual({ ok: false, reason: expect.stringMatching(/500/) });
    mockFetch(() => () => Promise.resolve(new Response('<html>')));
    expect(await fetchJson('https://a.gov/x', 1000, 1000)).toEqual({ ok: false, reason: expect.stringMatching(/map data/) });
  });

  it('reads the ArcGIS error envelope on an HTTP 200', async () => {
    mockFetch(() => ({ error: { code: 400, message: 'Invalid query', details: ['bad where'] } }));
    const r = await fetchJson('https://a.gov/x', 1000, 1000);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('Invalid query bad where') });
  });

  it('turns a token error into the sign-in refusal', () => {
    const signIn = "This service needs a sign-in, which isn't supported.";
    expect(envelopeError({ error: { code: 499, message: 'Token Required' } })).toBe(signIn);
    expect(envelopeError({ error: { code: 498, message: 'Invalid token.' } })).toBe(signIn);
    expect(envelopeError({ error: { code: 403, message: 'Token Required' } })).toBe(signIn);
    expect(envelopeError({ features: [] })).toBeNull();
  });
});

describe('Esri JSON → GeoJSON', () => {
  it('converts points, multipoints and lines', () => {
    expect(esriGeometry({ x: 1, y: 2 })).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(esriGeometry({ points: [[1, 2], [3, 4]] })).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
    expect(esriGeometry({ paths: [[[0, 0], [1, 1]]] })).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    expect(esriGeometry({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] })!.type).toBe('MultiLineString');
    expect(esriGeometry(null)).toBeNull();
    expect(esriGeometry({ x: 'a' })).toBeNull();
  });

  it('groups polygon rings: clockwise outers, counter-clockwise holes', () => {
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];     // clockwise
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];          // counter-clockwise
    const outer2 = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];
    expect(esriGeometry({ rings: [outer, hole] })).toEqual({ type: 'Polygon', coordinates: [outer, hole] });
    expect(esriGeometry({ rings: [outer, hole, outer2] })).toEqual({ type: 'MultiPolygon', coordinates: [[outer, hole], [outer2]] });
  });

  it('carries attributes as properties and skips a feature without geometry', () => {
    const fs = esriToFeatures({ features: [{ attributes: { a: 1 }, geometry: { x: 1, y: 2 } }, { attributes: { a: 2 } }] });
    expect(fs).toEqual([{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } }]);
    expect(esriToFeatures({})).toBeNull();
  });
});

describe('loadArcgisFeatures', () => {
  const bbox: [number, number, number, number] = [-100, 30, -99, 31];

  it('pages by resultOffset until exceededTransferLimit is false', async () => {
    const spec: ServiceSpec = { kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' };
    const calls = mockFetch(u => {
      if (!isQuery(u)) return info();
      const off = Number(u.searchParams.get('resultOffset'));
      return off === 0
        ? { type: 'FeatureCollection', features: pts(1000), properties: { exceededTransferLimit: true } }
        : { type: 'FeatureCollection', features: pts(500) };
    });
    const r = await loadArcgisFeatures(spec, bbox);
    expect(r.ok && r.result.features.length).toBe(1500);
    expect(r.ok && r.result.truncated).toBe(false);
    const qs = calls.filter(isQuery);
    expect(qs.map(q => q.searchParams.get('resultOffset'))).toEqual(['0', '1000']);
    const p = qs[0].searchParams;
    expect(Object.fromEntries(p)).toMatchObject({
      geometry: '-100,30,-99,31', geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', f: 'geojson', resultRecordCount: '1000',
      maxAllowableOffset: '0.00025', geometryPrecision: '5',
    });
    expect(calls[0].pathname).toMatch(/\/FeatureServer\/0$/);
    expect(calls[0].searchParams.get('f')).toBe('json');
  });

  it('stops at the page cap and reports truncation; page size is capped too', async () => {
    const spec: ServiceSpec = { kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '3' };
    const calls = mockFetch(u => isQuery(u)
      ? { type: 'FeatureCollection', features: pts(2000), exceededTransferLimit: true }
      : info({ maxRecordCount: 50000 }));
    const r = await loadArcgisFeatures(spec, bbox);
    expect(r.ok && r.result).toMatchObject({ truncated: true });
    expect(r.ok && r.result.features.length).toBe(MAX_PAGES * PAGE_SIZE_MAX);
    expect(calls.filter(isQuery)).toHaveLength(MAX_PAGES);
    expect(calls.find(isQuery)!.searchParams.get('resultRecordCount')).toBe(String(PAGE_SIZE_MAX));
  });

  it('stops paging on a page whose first object id repeats the last page\'s', async () => {
    const spec: ServiceSpec = { kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' };
    const page = pts(1000).map((f, i) => ({ ...f, id: i + 1 }));
    const calls = mockFetch(u => isQuery(u)
      ? { type: 'FeatureCollection', features: page, exceededTransferLimit: true }
      : info());
    const r = await loadArcgisFeatures(spec, bbox);
    expect(r.ok && r.result).toMatchObject({ truncated: true });
    expect(r.ok && r.result.features.length).toBe(1000);
    expect(calls.filter(isQuery)).toHaveLength(2);
  });

  it('stops paging on a short page, and reads Esri JSON object ids by the layer\'s objectIdField', async () => {
    const spec: ServiceSpec = { kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' };
    const short = mockFetch(u => isQuery(u)
      ? { type: 'FeatureCollection', features: pts(10), exceededTransferLimit: true }
      : info());
    const r = await loadArcgisFeatures(spec, bbox);
    expect(r.ok && r.result).toMatchObject({ truncated: true });
    expect(short.filter(isQuery)).toHaveLength(1);
    const esri = (n: number) => Array.from({ length: 2 }, () => ({ attributes: { FID: n }, geometry: { x: 0, y: 0 } }));
    const calls = mockFetch(u => isQuery(u)
      ? { features: esri(7), exceededTransferLimit: true }
      : info({ supportedQueryFormats: 'JSON', maxRecordCount: 2, objectIdField: 'FID' }));
    const e = await loadArcgisFeatures({ ...spec, url: uniqueUrl() }, bbox);
    expect(e.ok && e.result.features.length).toBe(2);
    expect(calls.filter(isQuery)).toHaveLength(2);
  });

  it('falls back to f=json and converts; no paging params without pagination support', async () => {
    const spec: ServiceSpec = { kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '1' };
    const calls = mockFetch(u => isQuery(u)
      ? { features: [{ attributes: { name: 'L1' }, geometry: { paths: [[[0, 0], [1, 1]]] } }], exceededTransferLimit: true }
      : info({ supportedQueryFormats: 'JSON, PBF', advancedQueryCapabilities: {} }));
    const r = await loadArcgisFeatures(spec, bbox);
    expect(r.ok && r.result).toEqual({
      truncated: true,
      features: [{ type: 'Feature', properties: { name: 'L1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }],
    });
    const q = calls.find(isQuery)!.searchParams;
    expect(q.get('f')).toBe('json');
    expect(q.has('resultOffset')).toBe(false);
  });

  it('refuses a token-protected layer and a layer with no geometry', async () => {
    mockFetch(() => ({ error: { code: 499, message: 'Token Required' } }));
    const r = await loadArcgisFeatures({ kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' }, bbox);
    expect(r).toEqual({ ok: false, reason: "This service needs a sign-in, which isn't supported." });
    mockFetch(() => ({ type: 'Group Layer' }));
    const g = await loadArcgisFeatures({ kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' }, bbox);
    expect(g.ok).toBe(false);
  });

  it('reports an error envelope on a query page', async () => {
    mockFetch(u => isQuery(u) ? { error: { code: 400, message: 'Unable to complete operation.' } } : info());
    const r = await loadArcgisFeatures({ kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0' }, bbox);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('Unable to complete operation.') });
  });
});

describe('loadService (per view)', () => {
  let zoom = 10;
  let moveend: (() => void) | null = null;
  const setData = vi.fn();
  const started: string[] = [];
  const service = (over: Partial<LinkedService> = {}): LinkedService => ({
    id: (started[started.length] = 'svc' + (++n)), kind: 'arcgis-feature', url: uniqueUrl(), host: 'example.gov', layer: '0',
    title: 'T', credit: 'C', visible: true, style: { kind: 'circle', color: '#ff0000', opacity: 1 }, ...over,
  });

  beforeEach(() => {
    zoom = 10;
    setData.mockClear();
    state.map = {
      getZoom: () => zoom,
      getBounds: () => ({ getWest: () => -200, getSouth: () => 30, getEast: () => -99, getNorth: () => 31 }),
      getSource: () => ({ setData }),
      on: (ev: string, fn: () => void) => { if (ev === 'moveend') moveend = fn; },
    } as unknown as typeof state.map;
  });
  afterEach(() => { started.splice(0).forEach(unloadService); state.map = null; });

  it('empties the source and asks to zoom in below the minzoom, without fetching', async () => {
    const calls = mockFetch(() => info());
    zoom = 7;
    const s = service();
    await loadService(s);
    expect(calls).toHaveLength(0);
    expect(setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: [] });
    expect(serviceStatus(s.id)).toEqual({ state: 'zoom-in', minzoom: 8 });
    expect(serviceStatusText(serviceStatus(s.id))).toBe('Zoom in to load');
  });

  it('queries the clamped view bbox and reports a truncated view', async () => {
    const calls = mockFetch(u => isQuery(u)
      ? { type: 'FeatureCollection', features: pts(3), exceededTransferLimit: true }
      : info({ advancedQueryCapabilities: {} }));
    const s = service();
    const seen: unknown[] = [];
    const off = onServiceStatus((id, st) => { if (id === s.id) seen.push(st?.state); });
    await loadService(s);
    off();
    expect(calls.find(isQuery)!.searchParams.get('geometry')).toBe('-180,30,-99,31');
    expect(seen).toEqual(['loading', 'truncated']);
    expect(serviceStatusText(serviceStatus(s.id))).toBe('Showing first 3');
    expect(setData.mock.lastCall![0].features).toHaveLength(3);
  });

  it('drops an answer that lands after a newer request', async () => {
    let releaseFirst!: () => void;
    let q = 0;
    mockFetch(u => {
      if (!isQuery(u)) return info();
      const k = ++q;
      const body = { type: 'FeatureCollection', features: pts(k === 1 ? 7 : 2) };
      return k === 1 ? () => new Promise<Response>(res => { releaseFirst = () => res(json(body)); }) : body;
    });
    const s = service();
    const first = loadService(s);
    await vi.waitFor(() => expect(q).toBe(1));
    await loadService(s);
    releaseFirst();
    await first;
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.lastCall![0].features).toHaveLength(2);
    expect(serviceStatus(s.id)).toEqual({ state: 'ok', count: 2 });
  });

  it('refetches once per settled move (400 ms debounce)', async () => {
    let q = 0;
    mockFetch(u => { if (isQuery(u)) q++; return isQuery(u) ? { type: 'FeatureCollection', features: [] } : info(); });
    const s = service();
    await loadService(s);
    expect(q).toBe(1);
    vi.useFakeTimers();
    moveend!(); moveend!(); moveend!();
    await vi.advanceTimersByTimeAsync(399);
    expect(q).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(serviceStatus(s.id)?.state).toBe('ok'));
    expect(q).toBe(2);
  });

  it('fetches a GeoJSON URL once, and not while hidden', async () => {
    const calls = mockFetch(() => ({ type: 'FeatureCollection', features: pts(4) }));
    const hidden = service({ kind: 'geojson', url: 'https://a.gov/x.geojson', layer: undefined, visible: false });
    await loadService(hidden);
    expect(calls).toHaveLength(0);
    const s = { ...hidden, visible: true };
    await loadService(s);
    await loadService(s);
    expect(calls).toHaveLength(1);
    expect(serviceStatus(s.id)).toEqual({ state: 'ok', count: 4 });
  });
});

describe('detectDrawKind', () => {
  it('reads an ArcGIS layer geometry type and a GeoJSON first geometry', async () => {
    const base = uniqueUrl();
    mockFetch(() => info({ geometryType: 'esriGeometryPolyline' }));
    expect(await detectDrawKind({ kind: 'arcgis-feature', url: base, layer: '0', host: 'example.gov' } as ServiceSpec)).toBe('line');
    mockFetch(() => ({ type: 'FeatureCollection', features: pts(2) }));
    expect(await detectDrawKind({ kind: 'geojson', url: 'https://example.gov/a.geojson', host: 'example.gov' } as ServiceSpec)).toBe('circle');
  });

  it('returns the reason text when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const r = await detectDrawKind({ kind: 'geojson', url: 'https://example.gov/b.geojson', host: 'example.gov' } as ServiceSpec);
    expect(['fill', 'line', 'circle']).not.toContain(r);
  });
});
