import { describe, it, expect } from 'vitest';
import { LAYERS, layerById } from './index.js';

describe('layerById', () => {
  it('finds an existing layer by id', () => {
    const layer = layerById('osm-transmission-lines');
    expect(layer).not.toBeNull();
    expect(layer?.id).toBe('osm-transmission-lines');
  });

  it('returns null for unknown id', () => {
    expect(layerById('does-not-exist')).toBeNull();
  });
});

describe('LAYERS registry structure', () => {
  const required = ['id', 'urlCode', 'label', 'group', 'swatch', 'defaultOn', 'mapLayerIds'] as const;

  it('every layer has required fields', () => {
    for (const layer of LAYERS) {
      for (const field of required) {
        expect(layer[field], `layer "${layer.id}" missing field "${field}"`).toBeDefined();
      }
    }
  });

  it('mapLayerIds is a non-empty array on every layer', () => {
    for (const layer of LAYERS) {
      expect(Array.isArray(layer.mapLayerIds), `layer "${layer.id}".mapLayerIds not array`).toBe(true);
      expect(layer.mapLayerIds.length, `layer "${layer.id}" has empty mapLayerIds`).toBeGreaterThan(0);
    }
  });

  it('all layer id values are unique', () => {
    const ids = LAYERS.map(l => l.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all urlCode values are unique (URL state breaks on collision)', () => {
    const codes = LAYERS.map(l => l.urlCode);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('all mapLayerIds are unique across the entire registry', () => {
    const all = LAYERS.flatMap(l => l.mapLayerIds);
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });
});
