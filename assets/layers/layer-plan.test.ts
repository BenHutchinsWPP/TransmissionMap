// @vitest-environment jsdom
// applyLayerPlan() against one recording fake map: the guards, source-before-
// layer order, beforeId, attribution and base-filter registration it owns.
// Then the whole boot: every style layer addAllLayers() adds keeps its inline
// filter through filters.ts's effectiveFilter(), which rebuilds a layer's
// filter from the registered base whenever a legend filter or a `where` runs.
// And every source it adds: credited (or on the pinned uncredited list), and,
// when it starts empty, one the loader knows how to fill.
// Deps: layer-plan.ts, base-filters.ts, add-all-layers.ts, filters.ts, state.ts,
// layer-data.ts (layerDataUrl), constants.ts (SOURCE_ATTRIB, EMPTY_FC).
import { describe, it, expect, vi } from 'vitest';
import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { applyLayerPlan, type LayerPlan } from './layer-plan.js';
import { BASE_LAYER_FILTERS } from './base-filters.js';
import { addAllLayers } from './add-all-layers.js';
import { effectiveFilter } from '../filters.js';
import { SOURCE_ATTRIB, EMPTY_FC } from '../constants.js';
import { layerDataUrl } from './layer-data.js';

/** Fake map recording each addSource/addLayer in call order. */
function recordingMap() {
  const calls: unknown[][] = [];
  const layers = new Map<string, LayerSpecification>();
  const sources = new Map<string, unknown>();
  const known: Record<string, unknown> = {
    addLayer: (spec: LayerSpecification, beforeId?: string) => {
      layers.set(spec.id, spec);
      calls.push(['layer', spec.id, beforeId]);
    },
    addSource: (id: string, spec: unknown) => { sources.set(id, spec); calls.push(['source', id]); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    getZoom: () => 0,
    getContainer: () => document.createElement('div'),
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  return { map: map as unknown as NonNullable<typeof state.map>, calls, layers, sources };
}

const line = (id: string, source: string, filter?: FilterSpecification) =>
  ({ id, type: 'line', source, ...(filter ? { filter } : {}) }) as LayerSpecification;

describe('applyLayerPlan', () => {
  it('adds every source before any layer, layers in plan order', () => {
    const { map, calls } = recordingMap();
    applyLayerPlan(map, [
      { source: 'a', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('a-1', 'a') },
      { source: 'b', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('b-1', 'b') },
      { layer: line('a-2', 'a') },
    ]);
    expect(calls.map(c => c.slice(0, 2).join(':'))).toEqual(['source:a', 'source:b', 'layer:a-1', 'layer:b-1', 'layer:a-2']);
  });

  it('registers each layer\'s own filter as its base, null without one', () => {
    const { map } = recordingMap();
    const f = ['==', ['get', 'k'], 1] as FilterSpecification;
    applyLayerPlan(map, [
      { source: 's', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('t-filtered', 's', f) },
      { layer: line('t-plain', 's') },
    ]);
    expect(BASE_LAYER_FILTERS['t-filtered']).toEqual(f);
    expect(BASE_LAYER_FILTERS['t-plain']).toBeNull();
  });

  it('skips a source or layer the map already has', () => {
    const { map, calls } = recordingMap();
    const plan: LayerPlan = [
      { source: 's', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('l', 's') },
    ];
    applyLayerPlan(map, plan);
    applyLayerPlan(map, plan);
    expect(calls).toHaveLength(2);
  });

  it('places a layer before beforeId only when the map has that layer', () => {
    const { map, calls } = recordingMap();
    applyLayerPlan(map, [
      { source: 's', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('missing-anchor', 's'), beforeId: 'nope' },
      { layer: line('anchored', 's'), beforeId: 'missing-anchor' },
    ]);
    expect(calls.slice(1)).toEqual([['layer', 'missing-anchor', undefined], ['layer', 'anchored', 'missing-anchor']]);
  });

  it('credits a source from SOURCE_ATTRIB by `attrib`, else its id, and keeps an inline credit', () => {
    const { map, sources } = recordingMap();
    const fc = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
    applyLayerPlan(map, [
      { source: 'mines', spec: { type: 'geojson', data: fc } },
      { source: 'twin', spec: { type: 'geojson', data: fc }, attrib: 'mines' },
      { source: 'mines-inline', spec: { type: 'geojson', data: fc, attribution: 'own' }, attrib: 'mines' },
      { source: 'uncredited', spec: { type: 'geojson', data: fc } },
    ]);
    const credit = (id: string) => (sources.get(id) as { attribution?: string }).attribution;
    expect(credit('mines')).toBe(SOURCE_ATTRIB.mines);
    expect(credit('twin')).toBe(SOURCE_ATTRIB.mines);
    expect(credit('mines-inline')).toBe('own');
    expect(sources.get('uncredited')).not.toHaveProperty('attribution');
  });
});

describe('addAllLayers base filters', () => {
  const { map, layers } = recordingMap();
  state.map = map;
  addAllLayers();
  state.map = null;

  it('added a plausible number of style layers', () => {
    expect(layers.size).toBeGreaterThan(100);
  });

  // Added by highlights.ts, which no applier or `where` ever re-filters.
  const EXEMPT = new Set(['highlight-poly-fill']);

  it('every style layer keeps its inline filter through effectiveFilter', () => {
    const lost = [...layers].filter(([id, spec]) => !EXEMPT.has(id)
      && JSON.stringify(effectiveFilter(id)) !== JSON.stringify((spec as { filter?: unknown }).filter ?? null));
    expect(lost.map(([id]) => id)).toEqual([]);
  });
});

describe('addAllLayers sources', () => {
  const { map, sources } = recordingMap();
  state.map = map;
  addAllLayers();
  state.map = null;
  const spec = (id: string) => sources.get(id) as { attribution?: string; data?: unknown };

  // Sources with no attribution of their own: the search highlights draw app
  // data, the weather images credit GFS beside the timebar (image sources take
  // no attribution), and the borders under the wash are public-domain Natural Earth.
  const UNCREDITED = [
    'highlight-lines', 'highlight-pts', 'weather-admin-lines', 'weather-live', 'weather-live-b',
  ];

  it('credits every source but the pinned uncredited ones', () => {
    expect([...sources.keys()].filter(id => !spec(id).attribution).sort()).toEqual(UNCREDITED);
  });

  it('keys every SOURCE_ATTRIB row by a source it adds', () => {
    expect(Object.keys(SOURCE_ATTRIB).filter(id => !sources.has(id))).toEqual([]);
  });

  // Empty GeoJSON sources ensureLayerData() never fills: the search highlights
  // (highlights.ts sets them), the unclustered data-centre copy (map-layers-load.ts
  // fills it from osm-datacenters), and the EIA petroleum pipelines, whose
  // registry entries are commented out in src/registry/pipelines.ts.
  const FILLED_ELSEWHERE = [
    'eia-crude-pipelines', 'eia-product-pipelines', 'highlight-lines', 'highlight-pts', 'osm-datacenters-plain',
  ];

  it('every source that starts empty has a data URL, or is filled elsewhere', () => {
    const unfilled = [...sources.keys()].filter(id => spec(id).data === EMPTY_FC && !layerDataUrl(id));
    expect(unfilled.sort()).toEqual(FILLED_ELSEWHERE);
  });
});
