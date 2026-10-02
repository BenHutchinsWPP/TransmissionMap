import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LAYERS, LAYER_SOURCES, layerById } from './index.js';
import { CLICKABLE_LAYERS, UNOWNED_CLICKABLE } from '../../assets/popup.js';

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

describe('CLICKABLE_LAYERS click hit-test priority', () => {
  // The order queryRenderedFeatures used before priority became a declared,
  // per-layer number — the first entry is the feature a click resolves to,
  // and the whole order is the disambiguation picker's row order. A silent
  // reordering here changes which feature a click opens, so this checks
  // element-for-element equality, not set equality.
  const EXPECTED = [
    "ogf-planned-lines",
    "westtec-lines",
    "osm-substations-points-hv", "osm-substations-points-lv",
    "hifld-substations-hv", "hifld-substations-lv",
    "osm-substations-polygons-fill",
    "osm-plants-polygons-fill",
    "osm-plant-icons",
    "wecc-paths-circles",
    "eia-gen-circles",
    "osm-gen-circles",
    "hifld-natgas-points", "hifld-petroleum-facilities",
    "osm-pipelines-points",
    "nrel-hydrothermal-points",
    "mines-icons",
    "osm-dc-circles",
    "osm-dc-points",
    "osm-dc-heat-points",
    "osm-transmission-lines-kv100-hv", "osm-transmission-lines-kv125-hv",
    "osm-transmission-lines-kv200-hv", "osm-transmission-lines-kv300-hv",
    "osm-transmission-lines-kv50-mv",
    "osm-transmission-lines-lv",
    "osm-transmission-lines-unknown",
    "hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown",
    "hifld-natgas-interstate", "hifld-natgas-intrastate",
    "hifld-natgas-hgl", "hifld-natgas-gathering",
    "osm-pipelines-lines",
    "eia-crude-pipelines", "eia-product-pipelines",
    "railroads",
    "nws-alerts-fill",
    "nws-zone-fill", "nws-county-fill",
    "wildfire-smoke-fill",
    "wildfire-incidents-circle",
    "wildfire-hotspots-circle",
    "wildfire-perimeters-fill",
    "tribal-fill", "bia-tribal-fill", "padus-fill", "crithab-fill",
    "nerc-fill", "ba-fill", "eiaba-fill", "retail-fill",
    "odin-outages-fill",
    "boem-wind-leases-fill",
    "us-zcta-fill", "us-counties-fill", "us-states-fill", "admin1-fill", "countries-fill",
  ];

  it('derived CLICKABLE_LAYERS matches the original hand-ordered array, element for element', () => {
    expect(CLICKABLE_LAYERS).toEqual(EXPECTED);
  });

  it('every clickable id is unique', () => {
    const unique = new Set(CLICKABLE_LAYERS);
    expect(unique.size).toBe(CLICKABLE_LAYERS.length);
  });

  it('every clickable id has a distinct priority', () => {
    const priorities = [
      ...LAYERS.flatMap(l => Object.values(l.clickPriority ?? {})),
      ...Object.values(UNOWNED_CLICKABLE),
    ];
    const unique = new Set(priorities);
    expect(unique.size).toBe(priorities.length);
  });
});

// assets/ui/ui-credits.ts can replace this markup at runtime with entries
// rendered from the generated manifest, but only once a fetched payload
// validates — a failed fetch, offline load, or malformed payload always
// leaves this markup on screen instead. That makes it the credits dialog's
// permanent no-network fallback, not a one-time placeholder, so it still
// needs to name every registered source correctly on its own.
describe('Data Credits dialog fallback markup consistency', () => {
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

