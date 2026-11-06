// @vitest-environment jsdom
// The map API on a recording fake map built by the real layer builders: each
// call commits once and is its own undo step, a refused call changes no state
// and writes nothing, the camera calls check their numbers and stay off the
// undo stack, fitTo resolves a place through the geocoder, showTable opens only
// a queryable layer, and the module never imports the agent's tool schemas.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
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
vi.mock('./ui/table-open.js', () => ({ openTable: vi.fn(async () => {}), zoomToSelection: vi.fn(async () => {}) }));
vi.mock('./services/service-render.js', () => ({ renderServices: vi.fn() }));
const probe = vi.hoisted(() => ({ detect: vi.fn(async (_s: unknown): Promise<string> => 'circle') }));
vi.mock('./services/service-load.js', async importOriginal => ({ ...(await importOriginal<object>()), detectDrawKind: probe.detect }));
const cp = vi.hoisted(() => ({
  rows: [] as { id: unknown }[][],
  result: null as unknown,
  avail: true as boolean | null,
}));
vi.mock('./user-data/copy-rows.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  copyAvailable: vi.fn(async () => cp.avail),
  copyRows: vi.fn(async (_id: string, rows: { id: unknown }[]) => {
    cp.rows.push(rows);
    return cp.result ?? { kind: 'copied', n: rows.length, simplified: 0 };
  }),
}));
const geo = vi.hoisted(() => ({ on: true }));
const qspy = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock('./dataset-query.js', async importOriginal => {
  const o = await importOriginal<typeof import('./dataset-query.js')>();
  return { ...o, query: ((id: string, opts: unknown) => (qspy.opts.push(opts), o.query(id, opts as never))) as typeof o.query };
});
vi.mock('./ui/ui-geocoder.js', () => ({
  placeSearchOn: () => geo.on,
  findPlaces: vi.fn(async (q: string) => q === 'Down' ? Promise.reject(new Error('498 Invalid Token')) : q === 'Nowhere' ? [] : [{
    address: 'Denver, Colorado', location: { x: -104.99, y: 39.74 },
    extent: { xmin: -105.1, ymin: 39.6, xmax: -104.8, ymax: 39.9 },
  }]),
}));

import { state } from './state.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { seedView, currentView } from './view-state.js';
import { emit, on } from './state-bus.js';
import { formatUrlState } from './url-state-codec.js';
import './url-state.js';
import { undo } from './undo.js';
import { openTable } from './ui/table-open.js';
import * as api from './map-api.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };

const cam = { flyTo: vi.fn(), fitBounds: vi.fn() };

// As in undo.test.ts, with the camera calls recorded.
function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  // A held source's setUrl lands its metadata at once.
  const handlers: Record<string, ((e: object) => void)[]> = {};
  const known: Record<string, unknown> = {
    on: (t: string, h: (e: object) => void) => { (handlers[t] ??= []).push(h); },
    off: (t: string, h: (e: object) => void) => { handlers[t] = (handlers[t] ?? []).filter(f => f !== h); },
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {
      setUrl: () => [...(handlers.sourcedata ?? [])].forEach(h => h({ type: 'sourcedata', sourceId: id, sourceDataType: 'metadata' })),
    } : undefined),
    getZoom: () => 5,
    getCenter: () => ({ lat: 39.5, lng: -98.35 }),
    getBearing: () => 0,
    getPitch: () => 0,
    flyTo: cam.flyTo,
    fitBounds: cam.fitBounds,
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
let writes = 0;
on('url:write', () => { writes++; });

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
  cam.flyTo.mockClear();
  cam.fitBounds.mockClear();
  writes = 0;
});
afterEach(() => { vi.useRealTimers(); });

const GEN = 'eia-generators';

describe('committing calls', () => {
  it('each commits once and is its own undo step, however fast they come', () => {
    const baseline = snap();
    expect(api.setLayerVisible('railroads', true).ok).toBe(true);
    expect(api.setWhere(GEN, [{ field: 'nameplate_mw', op: '>=', value: 100 }]).ok).toBe(true);
    expect(api.setArea({ kind: 'states', codes: ['TX'] }).ok).toBe(true);
    expect(writes).toBe(3);
    const after = snap();
    expect(after).not.toBe(baseline);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(snap()).toBe(baseline);
    expect(undo()).toBe(false);
  });

  it('set the view the link carries', () => {
    api.setBasemap('dark');
    api.setStyle('railroads', { color: '#ff0000' });
    api.setSelection({ mode: 'isolate', ids: { [GEN]: ['1:1'] } });
    const link = snap();
    expect(link).toContain('bm=d');
    expect(link).toContain('vx=');
    expect(state.styleOverrides.railroads).toEqual({ color: '#ff0000' });
    api.clearStyle('railroads');
    expect(state.styleOverrides.railroads).toBeUndefined();
  });

  it('reset is one step back to the defaults', () => {
    const baseline = snap();
    api.setLayerVisible('railroads', true);
    api.reset();
    expect(snap()).toBe(baseline);
    expect(undo()).toBe(true);
    expect(state.layerVisibility.railroads).toBe(true);
  });
});

describe('a refused call changes nothing', () => {
  it.each([
    ['unknown layer', () => api.setLayerVisible('no-such-layer', true)],
    ['on not a boolean', () => api.setLayerVisible('railroads', 'yes' as unknown as boolean)],
    ['unknown basemap', () => api.setBasemap('satellite')],
    ['unknown field', () => api.setWhere(GEN, [{ field: 'no_such_field', op: '=', value: 1 }])],
    ['where on a layer without a dataset', () => api.setWhere('nexrad-radar', [])],
    ['bad area kind', () => api.setArea({ kind: 'planets', codes: ['X'] } as never)],
    ['bad style', () => api.setStyle('railroads', { opacity: 7 })],
    ['bad selection mode', () => api.setSelection({ mode: 'mark', ids: {} } as never)],
    ['clearStyle on an unknown layer', () => api.clearStyle('no-such-layer')],
  ])('%s', (_name, call) => {
    const before = snap();
    const r = call();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\w/);
    expect(snap()).toBe(before);
    expect(writes).toBe(0);
  });

  it('before the map is ready', () => {
    state.mapReady = false;
    const r = api.setLayerVisible('railroads', true);
    expect(r).toEqual({ ok: false, reason: 'the map is still loading' });
  });
});

describe('camera', () => {
  it('setCamera flies, writes no view step, and checks its numbers', () => {
    expect(api.setCamera({ center: [-98, 39], zoom: 6 })).toEqual({ ok: true, result: { center: [-98, 39], zoom: 6 } });
    expect(cam.flyTo).toHaveBeenCalledWith({ center: [-98, 39], zoom: 6, essential: true });
    expect(writes).toBe(0);
    for (const bad of [{ zoom: 30 }, { center: [200, 0] }, { center: [0] }, { pitch: -1 }, { bearing: Number.NaN }]) {
      expect(api.setCamera(bad as never).ok).toBe(false);
    }
    expect(cam.flyTo).toHaveBeenCalledTimes(1);
  });

  it('fitTo takes a bbox or a place, not both or neither', async () => {
    expect((await api.fitTo({})).ok).toBe(false);
    expect((await api.fitTo({ bbox: [-100, 30, -90, 40], place: 'Texas' })).ok).toBe(false);
    expect((await api.fitTo({ bbox: [-100, 40, -90, 30] })).ok).toBe(false);
    expect((await api.fitTo({ bbox: [-100, 30, -90, 40] })).ok).toBe(true);
    expect(cam.fitBounds).toHaveBeenLastCalledWith([[-100, 30], [-90, 40]], expect.anything());
  });

  it('fitTo a place fits its extent, and says when there is none', async () => {
    expect(await api.fitTo({ place: 'Denver' })).toEqual({
      ok: true, result: { place: 'Denver, Colorado', bbox: [-105.1, 39.6, -104.8, 39.9] },
    });
    expect(cam.fitBounds).toHaveBeenLastCalledWith([[-105.1, 39.6], [-104.8, 39.9]], expect.anything());
    expect((await api.fitTo({ place: 'Nowhere' })).ok).toBe(false);
    expect((await api.fitTo({ place: 'x' })).ok).toBe(false);
    expect(writes).toBe(0);
  });

  it('fitTo tells "no place found", "unavailable" and "off" apart, never echoing the service', async () => {
    expect(await api.fitTo({ place: 'Nowhere' })).toEqual({ ok: false, reason: 'no place found for "Nowhere"' });
    expect(await api.fitTo({ place: 'Down' })).toEqual({ ok: false, reason: 'place search is unavailable right now' });
    geo.on = false;
    try {
      expect(await api.fitTo({ place: 'Denver' })).toEqual({ ok: false, reason: 'place search is off in this build' });
    } finally { geo.on = true; }
  });
});

describe('reading', () => {
  it('listLayers names every registry layer with its state', () => {
    const r = api.listLayers();
    if (!r.ok) throw new Error(r.reason);
    const gen = r.result.find(l => l.id === GEN)!;
    expect(gen.queryable).toBe(true);
    expect(r.result.find(l => l.id === 'nexrad-radar')!.queryable).toBe(false);
  });

  it('showTable opens only a queryable layer', async () => {
    expect((await api.showTable({ layerId: 'nexrad-radar' })).ok).toBe(false);
    expect((await api.showTable({ layerId: 'nope' })).ok).toBe(false);
    expect(openTable).not.toHaveBeenCalled();
    expect(await api.showTable({ layerId: GEN })).toEqual({ ok: true, result: { layerId: GEN } });
    expect(openTable).toHaveBeenCalledWith({ layerId: GEN });
  });

  it('shareLink is this page with the view in the hash', () => {
    api.setLayerVisible('railroads', true);
    const r = api.shareLink();
    if (!r.ok) throw new Error(r.reason);
    expect(r.result.url.startsWith(`${location.origin}${location.pathname}#`)).toBe(true);
    expect(r.result.url).toContain(snap().split('&')[0]);
  });
});

it('imports nothing from assets/agent/, so the schemas stay out of the main bundle', () => {
  const src = readFileSync('assets/map-api.ts', 'utf8');
  expect(src).not.toMatch(/from '\.\/agent\//);
  expect(src).not.toMatch(/import\('\.\/agent\//);
});

describe('linked services', () => {
  const approved = () => (sessionStorage.getItem('tm-svc-approved') ?? '[]');
  const UNVETTED = 'https://example.org/arcgis/rest/services/Foo/FeatureServer/0';

  beforeEach(() => { sessionStorage.clear(); recordingMap(); });

  it('a library id adds once, as its own undo step, approving nothing', async () => {
    const before = snap();
    const w = writes;
    const r = await api.addService({ libraryId: 'eia-crude-pipelines' });
    expect(r).toMatchObject({ ok: true, result: { host: 'services2.arcgis.com', vetted: true, pending: false, kind: 'arcgis-feature' } });
    expect(writes).toBe(w + 1);
    expect(state.services).toHaveLength(1);
    expect(state.services[0].libraryId).toBe('eia-crude-pipelines');
    expect(approved()).toBe('[]');
    undo();
    expect(state.services).toHaveLength(0);
    expect(snap()).toBe(before);
  });

  it('an unknown library id or a bad colour is refused, changing nothing', async () => {
    const w = writes;
    expect((await api.addService({ libraryId: 'nope' })).ok).toBe(false);
    expect((await api.addService({ libraryId: 'eia-crude-pipelines', color: 'red' })).ok).toBe(false);
    expect((await api.addService({})).ok).toBe(false);
    expect((await api.addService({ libraryId: 'a', url: UNVETTED })).ok).toBe(false);
    expect(writes).toBe(w);
    expect(state.services).toHaveLength(0);
  });

  it('an unconfirmed URL call approves nothing: an unvetted service is added pending', async () => {
    const r = await api.addService({ url: UNVETTED, layer: '0', draw: 'circle', color: '#ff0000' });
    expect(r).toMatchObject({ ok: true, result: { host: 'example.org', title: 'example.org', vetted: false, pending: true } });
    expect(approved()).toBe('[]');
    expect(state.services[0].style).toMatchObject({ kind: 'circle', color: '#ff0000' });
  });

  it('a confirmed URL call approves the normalised URL for the session', async () => {
    const r = await api.addService({ url: UNVETTED + '/query?f=json', layer: '0' }, { confirmed: true });
    expect(r).toMatchObject({ ok: true, result: { pending: false } });
    expect(JSON.parse(approved())).toEqual(['https://example.org/arcgis/rest/services/Foo/FeatureServer']);
  });

  const OTHER = 'https://probe.example.net/arcgis/rest/services/Bar/FeatureServer/0';
  it('without draw, a confirmed or vetted vector URL is drawn as its probed geometry; an unconfirmed unvetted one is never probed', async () => {
    probe.detect.mockClear();
    await api.addService({ url: OTHER, layer: '0' });
    expect(probe.detect).not.toHaveBeenCalled();
    expect(state.services[0].style.kind).toBe('line');
    await api.addService({ url: OTHER + '/query?f=json', layer: '0' }, { confirmed: true });
    expect(probe.detect).toHaveBeenCalledTimes(1);
    expect(state.services[1].style).toMatchObject({ kind: 'circle', radius: 4 });
    await api.addService({ url: OTHER, layer: '0', draw: 'fill' }, { confirmed: true });
    expect(probe.detect).toHaveBeenCalledTimes(1);
    probe.detect.mockResolvedValueOnce('no geometry');
    await api.addService({ url: 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Crude_Oil_Trunk_Pipelines_1/FeatureServer', layer: '0' });
    expect(probe.detect).toHaveBeenCalledTimes(2);
    expect(state.services[3].style.kind).toBe('line');
  });

  it('refuses http, a key in the URL and a layer-less WMS, approving nothing', async () => {
    for (const a of [{ url: 'http://example.org/x/FeatureServer/0' }, { url: UNVETTED + '?token=abc' },
      { url: 'https://example.org/wms?service=WMS', kind: 'wms' as const }]) {
      expect((await api.addService(a, { confirmed: true })).ok).toBe(false);
    }
    expect(approved()).toBe('[]');
    expect(state.services).toHaveLength(0);
  });

  it('lists and removes, each removal its own undo step', async () => {
    await api.addService({ libraryId: 'eia-crude-pipelines' });
    const list = api.listServices();
    expect(list.ok && list.result).toHaveLength(1);
    const id = state.services[0].id;
    expect(api.removeService('missing').ok).toBe(false);
    expect(api.removeService(id).ok).toBe(true);
    expect(state.services).toHaveLength(0);
    undo();
    expect(state.services).toHaveLength(1);
  });
});

describe('copyToMyData', () => {
  const unit = (fid: string, mw: number) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [-97, 31] },
    properties: { fid, energy_source: 'NG', gen_status: 'existing', nameplate_mw: mw, states: '|TX|', plant_name: 'SECRET-' + fid },
  }) as GeoJSON.Feature;
  const seed = (n: number) => {
    state.sourcesData[GEN] = Array.from({ length: n }, (_, i) => unit(`${i}:1`, 100 + i));
    state.sourcesLoaded[GEN] = true;
  };
  beforeEach(() => { cp.rows = []; cp.result = null; cp.avail = true; state.sourcesData = {}; state.sourcesLoaded = {}; seed(5); });

  it('queries the view, not the whole dataset', async () => {
    qspy.opts.length = 0;
    await api.copyToMyData({ layerId: GEN });
    expect(qspy.opts[0]).toMatchObject({ scope: 'view' });
  });

  it('copies the queried rows and tells counts only, with no url:write', async () => {
    const r = await api.copyToMyData({ layerId: GEN, where: [{ field: 'nameplate_mw', op: '>=', value: 102 }] });
    expect(r).toMatchObject({ ok: true, result: { outcome: 'copied', n: 3, total: 3, complete: true } });
    expect(cp.rows[0].map(x => x.id)).toEqual(['2:1', '3:1', '4:1']);
    expect(writes).toBe(0);
  });

  it('a download offer keeps simplified, missing and unread like a copy', async () => {
    const download = { kind: 'download', n: 5, chars: 2e6, fc: { type: 'FeatureCollection', features: [] }, filename: 'x.geojson',
      simplified: 1, missing: 2, unread: 3 };
    cp.result = download;
    const r = await api.copyToMyData({ layerId: GEN });
    expect(r).toMatchObject({ ok: true, result: { outcome: 'download-offered', simplified: 1, missing: 2, unread: 3 } });
    cp.result = { kind: 'copied', n: 5, simplified: 1, missing: 2, unread: 3 };
    expect(await api.copyToMyData({ layerId: GEN })).toMatchObject({ ok: true, result: { outcome: 'copied', simplified: 1, missing: 2, unread: 3 } });
  });

  it('with no where, copies what the view filters to (layer off: its where)', async () => {
    state.layerVisibility[GEN] = false;
    state.where[GEN] = [{ field: 'nameplate_mw', op: '>=', value: 103 }];
    const r = await api.copyToMyData({ layerId: GEN });
    delete state.where[GEN];
    expect(r).toMatchObject({ ok: true, result: { outcome: 'copied', n: 2, total: 2 } });
    expect(cp.rows[0].map(x => x.id)).toEqual(['3:1', '4:1']);
  });

  it('refuses bad where, area and ids with the validator text, and writes nothing', async () => {
    const bad = [
      await api.copyToMyData({ layerId: GEN, where: [{ field: 'nope', op: '=', value: 1 }] }),
      await api.copyToMyData({ layerId: GEN, area: { kind: 'bogus', codes: ['x'] } as never }),
      await api.copyToMyData({ layerId: GEN, ids: [{} as never] }),
      await api.copyToMyData({ layerId: GEN, ids: [] }),
      await api.copyToMyData({ layerId: 'nexrad-radar' }),
      await api.copyToMyData({ layerId: 'osm-substations-points' }),
    ];
    for (const r of bad) expect(r.ok).toBe(false);
    expect(cp.rows).toHaveLength(0);
  });

  it('refuses 501 ids, and more than 1,000 matches with the count', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `${i}:1`);
    expect(await api.copyToMyData({ layerId: GEN, ids })).toMatchObject({ ok: false, reason: expect.stringContaining('500') });
    seed(1001);
    const r = await api.copyToMyData({ layerId: GEN });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('1001') });
    expect(cp.rows).toHaveLength(0);
  });

  it('a line layer needs to be on, and its files available', async () => {
    expect(await api.copyToMyData({ layerId: 'hifld-transmission-lines' })).toEqual({ ok: false, reason: 'turn the layer on first' });
    state.layerVisibility['hifld-transmission-lines'] = true;
    cp.avail = null;
    expect(await api.copyToMyData({ layerId: 'hifld-transmission-lines' })).toMatchObject({ ok: false, reason: expect.stringContaining('not available') });
  });

  it('nothing matching is refused', async () => {
    expect(await api.copyToMyData({ layerId: GEN, where: [{ field: 'nameplate_mw', op: '>=', value: 99999 }] }))
      .toEqual({ ok: false, reason: 'nothing matches' });
  });

  it('asks above the threshold on the rows it then copies, even if the data changes meanwhile', async () => {
    expect(await api.copyToMyData({ layerId: GEN }, { confirmAbove: 0 })).toEqual({ ok: false, reason: "needs the visitor's confirm" });
    const confirm = vi.fn(async (_n: number, _name: string) => {
      seed(2);   // the source changes while the card is open
      return true;
    });
    const r = await api.copyToMyData({ layerId: GEN }, { confirmAbove: 4, confirm });
    expect(confirm).toHaveBeenCalledWith(5, expect.stringContaining('5'));
    expect(cp.rows[0]).toHaveLength(5);
    expect(r).toMatchObject({ ok: true, result: { n: 5 } });
    expect(confirm.mock.calls[0][0]).toBe(cp.rows[0].length);
  });

  it('does not ask at or below the threshold, and a declined card writes nothing', async () => {
    const confirm = vi.fn(async () => false);
    expect((await api.copyToMyData({ layerId: GEN }, { confirmAbove: 5, confirm })).ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    cp.rows = [];
    expect(await api.copyToMyData({ layerId: GEN }, { confirmAbove: 1, confirm })).toEqual({ ok: false, reason: 'the visitor declined' });
    expect(cp.rows).toHaveLength(0);
  });

  it('a download result is offered with its reason; refusals carry no feature value', async () => {
    const dl = { kind: 'download', n: 5, chars: 9, fc: { type: 'FeatureCollection', features: [] }, filename: 'x.geojson', storageFull: true };
    cp.result = dl;
    expect(await api.copyToMyData({ layerId: GEN })).toMatchObject({
      ok: true, result: { outcome: 'download-offered', reason: 'storage-full', download: dl },
    });
    cp.result = { kind: 'refused', reason: 'too-many' };
    const r = await api.copyToMyData({ layerId: GEN, ids: ['0:1', '1:1'] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('keeps copy-rows, line-copy and line-read out of the main bundle', () => {
    const src = readFileSync('assets/map-api.ts', 'utf8');
    expect(src).not.toMatch(/^import .*(copy-rows|line-copy|line-read)/m);
    expect(src).toMatch(/import\('\.\/user-data\/copy-rows\.js'\)/);
  });
});
