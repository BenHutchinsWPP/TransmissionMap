// @vitest-environment jsdom
// ensureLayerData's fromZoom gate and its zoom-settle retry, against the real
// registry (hifld-natgas-points has fromZoom 3; hifld-petroleum-facilities
// shares its source) and a fake map whose 'zoomend' listener the test fires.
// Also pins the 'layer:data' emission and layerDataUrl()'s two inputs (each
// LayerDef.geojson, SOURCE_DATA_URLS) to the registry and DATA.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { state } from '../state.js';
import { on } from '../state-bus.js';
import { DATA } from '../constants.js';
import { ensureLayerData, layerDataUrl, SOURCE_DATA_URLS, LAYER_SOURCE_ALIAS } from './layer-data.js';
import { LAYERS, layerById } from '../../src/registry/index.js';

const fetchMock = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
vi.stubGlobal('fetch', fetchMock);
vi.spyOn(console, 'warn').mockImplementation(() => {});

function fakeMap(zoom: number) {
  const zoomend: (() => void)[] = [];
  const map = {
    getZoom: () => zoom,
    getSource: () => undefined,
    on: (ev: string, fn: () => void) => { if (ev === 'zoomend') zoomend.push(fn); },
  };
  state.map = map as unknown as typeof state.map;
  return { zoomTo(z: number) { zoom = z; zoomend.forEach(fn => fn()); } };
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockClear();
  state.layerVisibility = {};
  state.sourcesLoaded = {};
});

describe('ensureLayerData fromZoom gate', () => {
  it('holds a gated layer below its zoom and fetches it once on zoom-in', async () => {
    const map = fakeMap(2);
    state.layerVisibility['hifld-natgas-points'] = true;
    await ensureLayerData('hifld-natgas-points');
    expect(fetchMock).not.toHaveBeenCalled();
    map.zoomTo(4);
    map.zoomTo(5);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(DATA.hifld_natgas_points, undefined);
  });

  it('does not fetch a held layer switched off before the zoom-in', async () => {
    const map = fakeMap(2);
    state.layerVisibility['hifld-natgas-points'] = true;
    await ensureLayerData('hifld-natgas-points');
    state.layerVisibility['hifld-natgas-points'] = false;
    map.zoomTo(4);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch a held layer whose data loaded meanwhile', async () => {
    const map = fakeMap(2);
    state.layerVisibility['hifld-natgas-points'] = true;
    await ensureLayerData('hifld-natgas-points');
    state.sourcesLoaded['hifld-natgas-points'] = true;
    map.zoomTo(4);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps holding a layer while the zoom stays below its gate', async () => {
    const map = fakeMap(1);
    state.layerVisibility['hifld-natgas-points'] = true;
    await ensureLayerData('hifld-natgas-points');
    map.zoomTo(2);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    map.zoomTo(3);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a gated layer on the next zoom settle after its fetch fails', async () => {
    const map = fakeMap(4);
    state.layerVisibility['hifld-natgas-points'] = true;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await ensureLayerData('hifld-natgas-points');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    map.zoomTo(5);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(DATA.hifld_natgas_points, undefined);
  });

  it('gates a layer sharing a gated source, and fetches that source once on zoom-in', async () => {
    const map = fakeMap(2);
    state.layerVisibility['hifld-petroleum-facilities'] = true;
    await ensureLayerData('hifld-petroleum-facilities');
    expect(fetchMock).not.toHaveBeenCalled();
    map.zoomTo(4);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(DATA.hifld_natgas_points, undefined);
  });
});

describe('ensureLayerData layer:data emission', () => {
  it('emits layer:data with the alias-resolved source id once the fetch lands', async () => {
    fakeMap(4);
    const emitted: string[] = [];
    on('layer:data', ({ id }) => emitted.push(id));
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] };
    fetchMock.mockResolvedValueOnce(new Response(gzipSync(strToU8(JSON.stringify(fc)))) as never);
    await ensureLayerData('hifld-petroleum-facilities');
    expect(emitted).toEqual(['hifld-natgas-points']);
    expect(state.sourcesData['hifld-natgas-points']).toHaveLength(1);
  });

  it('keeps a newer pull that landed while the lazy fetch was in flight', async () => {
    fakeMap(4);
    const pull = (utc: string) => [{ type: 'Feature' as const, properties: { generated_utc: utc }, geometry: null }];
    const fresher = pull('2026-10-10T12:00:00Z');
    state.sourcesData['hifld-natgas-points'] = fresher;
    const emitted: string[] = [];
    on('layer:data', ({ id }) => emitted.push(id));
    const fc = { type: 'FeatureCollection', features: pull('2026-10-10T11:55:00Z') };
    fetchMock.mockResolvedValueOnce(new Response(gzipSync(strToU8(JSON.stringify(fc)))) as never);
    await ensureLayerData('hifld-natgas-points');
    expect(state.sourcesData['hifld-natgas-points']).toBe(fresher);
    expect(state.sourcesLoaded['hifld-natgas-points']).toBe(true);
    expect(emitted).toEqual([]);
    delete state.sourcesData['hifld-natgas-points'];
  });
});

describe('layerDataUrl', () => {
  const dataPaths = new Set<string>(Object.values(DATA));

  it('every LayerDef.geojson names a GeoJSON file in DATA', () => {
    for (const layer of LAYERS.filter(l => l.geojson)) {
      const url = (DATA as Record<string, string>)[layer.geojson!];
      expect(url, `${layer.id}: "${layer.geojson}" is not a DATA key`).toBeDefined();
      expect(url, `${layer.id}: ${url} is not GeoJSON`).toMatch(/\.geojson(\.gz)?$/);
      expect(layerDataUrl(layer.id)).toBe(url);
    }
  });

  it('keys SOURCE_DATA_URLS by source-only ids and points each at a DATA path', () => {
    for (const [id, url] of Object.entries(SOURCE_DATA_URLS)) {
      expect(layerById(id), `${id} is a registry id — set its geojson instead`).toBeFalsy();
      expect(dataPaths.has(url), `${id} → ${url} is not a DATA path`).toBe(true);
    }
  });

  it('every alias target is a source the loader can fill', () => {
    for (const [id, target] of Object.entries(LAYER_SOURCE_ALIAS)) {
      expect(layerDataUrl(target), `${id} → ${target} has no data URL`).toBeDefined();
    }
  });
});
