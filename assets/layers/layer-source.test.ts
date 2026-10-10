// @vitest-environment jsdom
// layer-source.ts: a registry layer's `data` declaration → its credited MapLibre
// source by kind, the GeoJSON URL the loader fetches, and the source a registry
// id shares. Then the registry-wide invariants the resolver relies on.
// Deps: layer-source.ts, constants.ts (DATA, EMPTY_FC), src/registry (LAYERS,
// layerById, OSM_CREDIT).
import { describe, it, expect } from 'vitest';
import { DATA, EMPTY_FC } from '../constants.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import { OSM_CREDIT } from '../../src/registry/sources.js';
import { layerSource, layerDataUrl, layerSourceId, pmtilesUrl, SOURCE_DATA_URLS } from './layer-source.js';

const step = (id: string, opts?: Parameters<typeof layerSource>[1]) =>
  layerSource(id, opts) as { source: string; spec: Record<string, unknown> };
const credit = (id: string) => layerById(id)!.data!.credit;

describe('layerSource', () => {
  it('turns a pmtiles layer into a credited vector source', () => {
    expect(step('padus')).toEqual({ source: 'padus', spec: {
      type: 'vector', url: pmtilesUrl('padus'), attribution: credit('padus'),
    } });
    expect(pmtilesUrl('padus')).toMatch(/^pmtiles:\/\/http.*\/data\/layers\/padus\.pmtiles$/);
  });

  it('turns a geojson layer into an empty credited source the loader fills', () => {
    const s = step('mines');
    expect(s.source).toBe('mines');
    expect(s.spec).toEqual({ type: 'geojson', data: EMPTY_FC, attribution: credit('mines') });
    expect(s.spec.data).toBe(EMPTY_FC);
  });

  it('turns a raster layer into a credited 256 px raster source', () => {
    expect(step('nlr-wind-100m').spec).toEqual({
      type: 'raster', url: pmtilesUrl('nlr_wind_100m'), tileSize: 256, attribution: credit('nlr-wind-100m'),
    });
  });

  it('takes a source id, file and extra options for a layer spread over several sources', () => {
    expect(step('osm-transmission-lines', { id: 'osm-transmission-lines-kv300', key: 'osm_transmission_lines_kv300' }))
      .toEqual({ source: 'osm-transmission-lines-kv300', spec: {
        type: 'vector', url: pmtilesUrl('osm_transmission_lines_kv300'), attribution: OSM_CREDIT,
      } });
    expect(step('osm-datacenters', { spec: { cluster: true } }).spec).toMatchObject({ type: 'geojson', cluster: true });
  });

  it('refuses a layer that declares no data', () => {
    expect(() => layerSource('weather-live')).toThrow(/declares no data/);
  });
});

describe('layerDataUrl and layerSourceId', () => {
  it('gives a geojson layer its file, a tiled layer none, a source-only id its row', () => {
    expect(layerDataUrl('mines')).toBe(DATA.mines);
    expect(layerDataUrl('padus')).toBeUndefined();
    expect(layerDataUrl('wecc-path-lines')).toBe(DATA.wecc_path_lines);
  });

  it('shares a source between layers declaring the same data, and follows the alias rows', () => {
    expect(layerSourceId('wildfire-smoke')).toBe('wildfire-live');
    expect(layerSourceId('wildfire-incidents')).toBe('wildfire-live');
    expect(layerSourceId('weather-live')).toBe('weather-admin-lines');
    expect(layerSourceId('padus')).toBe('padus');
  });

  it('every lazily loaded registry layer resolves to a source the loader can fill', () => {
    for (const l of LAYERS.filter(l => l.data?.kind === 'geojson' || layerSourceId(l.id) !== l.id)) {
      expect(layerDataUrl(layerSourceId(l.id)), l.id).toBeDefined();
    }
  });

  it('keys SOURCE_DATA_URLS by source-only ids and points each at a DATA path', () => {
    const paths = new Set<string>(Object.values(DATA));
    for (const [id, url] of Object.entries(SOURCE_DATA_URLS)) {
      expect(layerById(id), `${id} is a registry id — declare its data instead`).toBeFalsy();
      expect(paths.has(url), `${id} → ${url} is not a DATA path`).toBe(true);
    }
  });
});

describe('registry data declarations', () => {
  const declared = LAYERS.filter(l => l.data);
  const EXT = { pmtiles: /\.pmtiles$/, raster: /\.pmtiles$/, geojson: /\.geojson(\.gz)?$/ };

  it('name a DATA file of their kind', () => {
    for (const { id, data } of declared) {
      expect(DATA, `${id}: "${data!.key}" is not a DATA key`).toHaveProperty(data!.key);
      expect(DATA[data!.key], id).toMatch(EXT[data!.kind]);
    }
  });

  it('credit every source, OSM-derived ones starting with the OSM credit', () => {
    for (const { id, sourceId, data } of declared) {
      expect(data!.credit.trim(), id).not.toBe('');
      if (sourceId === 'osm') expect(data!.credit.startsWith(OSM_CREDIT), id).toBe(true);
    }
  });

  it('agree on kind and credit wherever they share a file', () => {
    for (const l of declared) {
      const owner = layerById(layerSourceId(l.id))!;
      expect({ kind: l.data!.kind, credit: l.data!.credit }, l.id)
        .toEqual({ kind: owner.data!.kind, credit: owner.data!.credit });
    }
  });
});
