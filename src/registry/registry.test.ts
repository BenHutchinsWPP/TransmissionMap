import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LAYERS, LAYER_SOURCES, layerById } from './index.js';

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
  const required = ['id', 'urlCode', 'label', 'group', 'sourceId', 'swatch', 'defaultOn', 'mapLayerIds'] as const;

  it('every layer has required fields', () => {
    for (const layer of LAYERS) {
      for (const field of required) {
        expect(layer[field], `layer "${layer.id}" missing field "${field}"`).toBeDefined();
      }
    }
  });

  it('every layer sourceId exists in LAYER_SOURCES', () => {
    for (const layer of LAYERS) {
      expect(LAYER_SOURCES[layer.sourceId], `layer "${layer.id}" has unregistered sourceId "${layer.sourceId}"`).toBeDefined();
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

describe('Data Credits dialog consistency', () => {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const creditsDialogMatch = html.match(/<dialog[^>]*id="creditsDialog"[^>]*>([\s\S]*?)<\/dialog>/);

  it('creditsDialog exists in index.html', () => {
    expect(creditsDialogMatch).not.toBeNull();
  });

  it('contains no duplicate data-source-credit entries', () => {
    const creditsHtml = creditsDialogMatch![1];
    const foundCredits = new Map<string, number>();
    const creditMatches = creditsHtml.matchAll(/data-source-credit="([^"]+)"/g);
    for (const match of creditMatches) {
      const id = match[1];
      foundCredits.set(id, (foundCredits.get(id) ?? 0) + 1);
    }
    for (const [id, count] of foundCredits) {
      expect(count, `duplicate data-source-credit="${id}" in creditsDialog`).toBe(1);
    }
  });

  it('every LAYER_SOURCES entry has a credit in creditsDialog', () => {
    const creditsHtml = creditsDialogMatch![1];
    for (const sourceId of Object.keys(LAYER_SOURCES)) {
      expect(creditsHtml.includes(`data-source-credit="${sourceId}"`), `missing data-source-credit for "${sourceId}" in index.html`).toBe(true);
    }
  });

  it('contains no obsolete or unrecognized data-source-credit entries', () => {
    const creditsHtml = creditsDialogMatch![1];
    const allowedExtras = new Set(['im3', 'usgs-terrain']);
    const creditMatches = creditsHtml.matchAll(/data-source-credit="([^"]+)"/g);
    for (const match of creditMatches) {
      const id = match[1];
      const isValid = id in LAYER_SOURCES || allowedExtras.has(id);
      expect(isValid, `obsolete or unknown data-source-credit="${id}" in creditsDialog`).toBe(true);
    }
  });
});

