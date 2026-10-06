// @vitest-environment jsdom
// Base-filter registration guard: every style layer addAllLayers() adds with an
// inline `filter` must register that same filter via registerBaseFilter(), or
// filters.ts's effectiveFilter() — which rebuilds a layer's filter from the
// registered base — would erase it the first time a legend filter or a `where`
// condition is applied. Runs the real builders against a recording fake map.
import { describe, it, expect, vi } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { addAllLayers } from './add-all-layers.js';
import { effectiveFilter } from '../filters.js';

function recordingMap() {
  const layers = new Map<string, LayerSpecification>();
  const sources = new Set<string>();
  const known: Record<string, unknown> = {
    addLayer: (spec: LayerSpecification) => { layers.set(spec.id, spec); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getFilter: (id: string) => (layers.get(id) as { filter?: unknown } | undefined)?.filter,
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    getZoom: () => 0,
    getContainer: () => document.createElement('div'),
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  return { map, layers };
}

describe('base filters', () => {
  const { map, layers } = recordingMap();
  state.map = map as unknown as typeof state.map;
  addAllLayers();
  state.map = null;

  it('added a plausible number of style layers', () => {
    expect(layers.size).toBeGreaterThan(100);
  });

  // Added by highlights.ts, which no applier or `where` ever re-filters.
  const EXEMPT = new Set(['highlight-poly-fill']);

  for (const [id, spec] of layers) {
    if (EXEMPT.has(id)) continue;
    it(`${id}: effectiveFilter reproduces its inline filter`, () => {
      expect(effectiveFilter(id)).toEqual((spec as { filter?: unknown }).filter ?? null);
    });
  }
});
