// @vitest-environment jsdom
// applyLayerPlan() against one recording fake map: the guards, source-before-
// layer order, beforeId, starting visibility, base-filter registration and the
// held tiled sources (no url until a layer on them is first shown) it owns.
// Then the whole boot: every style layer addAllLayers() adds keeps its inline
// filter through filters.ts's effectiveFilter(), which rebuilds a layer's
// filter from the registered base whenever a legend filter or a `where` runs.
// And every source it adds: credited (or on the pinned uncredited list) — each
// registry layer's with its own `data.credit` — and, when it starts empty, one
// the loader knows how to fill.
// Deps: layer-plan.ts, base-filters.ts, add-all-layers.ts, filters.ts, state.ts,
// layer-source.ts (layerDataUrl, layerSourceId), constants.ts (EMPTY_FC),
// src/registry (LAYERS).
import { describe, it, expect, vi } from 'vitest';
import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { applyLayerPlan, setMapLayerVisibility, type LayerPlan } from './layer-plan.js';
import { BASE_LAYER_FILTERS } from './base-filters.js';
import { addAllLayers } from './add-all-layers.js';
import { effectiveFilter } from '../filters.js';
import { EMPTY_FC } from '../constants.js';
import { layerDataUrl, layerSourceId } from './layer-source.js';
import { LAYERS } from '../../src/registry/index.js';

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

  it('starts each layer as its registry layer is in state, unless it pins its own visibility', () => {
    const { map, layers } = recordingMap();
    state.layerVisibility = { padus: true, crithab: false };
    const vis = (id: string) => (layers.get(id) as { layout?: { visibility?: string } }).layout?.visibility;
    applyLayerPlan(map, [
      { source: 's', spec: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      { layer: line('padus-fill', 's') },                                   // padus's mapLayerIds
      { layer: line('crithab-fill', 's') },
      { layer: { ...line('padus-outline', 's'), layout: { visibility: 'none', 'line-cap': 'round' } } as LayerSpecification },
      { layer: { ...line('mines-icons', 's'), layout: { 'line-cap': 'round' } } as LayerSpecification },
      { layer: line('no-such-layer', 's') },                                // no registry layer: off
    ]);
    expect(['padus-fill', 'crithab-fill', 'padus-outline', 'no-such-layer'].map(vis))
      .toEqual(['visible', 'none', 'none', 'none']);
    expect((layers.get('mines-icons') as { layout: unknown }).layout).toEqual({ visibility: 'none', 'line-cap': 'round' });
    state.layerVisibility = {};
  });

  it('every style layer belongs to at most one registry layer', () => {
    const ids = LAYERS.flatMap(l => l.mapLayerIds);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe('held tiled sources', () => {
  /** A map whose sources record setUrl; land() fires a source's metadata or error. */
  function heldMap() {
    const rec = recordingMap();
    const handlers: Record<string, ((e: object) => void)[]> = {};
    const urls: Record<string, string> = {};
    const vis: Record<string, string> = {};
    Object.assign(rec.map, {
      addSource: (id: string, spec: unknown) => rec.sources.set(id, { spec, setUrl: (u: string) => { urls[id] = u; } }),
      on: (t: string, h: (e: object) => void) => { (handlers[t] ??= []).push(h); },
      off: (t: string, h: (e: object) => void) => { handlers[t] = handlers[t].filter(f => f !== h); },
      setLayoutProperty: (id: string, _p: string, v: string) => { vis[id] = v; },
    });
    const land = (sourceId: string, type = 'sourcedata') =>
      [...(handlers[type] ?? [])].forEach(h => h({ type, sourceId, sourceDataType: 'metadata' }));
    return { ...rec, urls, vis, land };
  }
  const tiled = (id: string, url: string): LayerPlan[number] => ({ source: id, spec: { type: 'vector', url } });

  it('adds a source no starting layer draws without its url; one a layer draws, with it', () => {
    const { map, sources } = heldMap();
    state.layerVisibility = { padus: true };
    applyLayerPlan(map, [
      tiled('off', 'pmtiles://off'), tiled('on', 'pmtiles://on'),
      { layer: line('crithab-fill', 'off') }, { layer: line('padus-fill', 'on') },
    ]);
    state.layerVisibility = {};
    expect((sources.get('off') as { spec: object }).spec).toEqual({ type: 'vector' });
    expect((sources.get('on') as { spec: object }).spec).toEqual({ type: 'vector', url: 'pmtiles://on' });
  });

  it('first show sets the url; layers wait hidden for the metadata, the last visibility asked wins', () => {
    const { map, urls, vis, land } = heldMap();
    applyLayerPlan(map, [tiled('h', 'pmtiles://h'), { layer: line('h-1', 'h') }, { layer: line('h-2', 'h') }]);
    setMapLayerVisibility(map, 'h-1', 'visible');
    setMapLayerVisibility(map, 'h-2', 'visible');
    setMapLayerVisibility(map, 'h-2', 'none');
    expect(urls).toEqual({ h: 'pmtiles://h' });
    expect(vis).toEqual({});
    land('h');
    expect(vis).toEqual({ 'h-1': 'visible', 'h-2': 'none' });
    setMapLayerVisibility(map, 'h-2', 'visible');
    expect(vis['h-2']).toBe('visible');
  });

  it('a failed load leaves the layers hidden and the source held for the next show', () => {
    const { map, urls, vis, land } = heldMap();
    applyLayerPlan(map, [tiled('f', 'pmtiles://f'), { layer: line('f-1', 'f') }]);
    setMapLayerVisibility(map, 'f-1', 'visible');
    land('f', 'error');
    expect(vis).toEqual({});
    delete urls.f;
    setMapLayerVisibility(map, 'f-1', 'visible');
    expect(urls).toEqual({ f: 'pmtiles://f' });
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

  it('credits each registry layer\'s source with that layer\'s data.credit', () => {
    for (const l of LAYERS.filter(l => l.data)) {
      expect(spec(layerSourceId(l.id))?.attribution, l.id).toBe(l.data!.credit);
    }
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
