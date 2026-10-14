// Search highlights on a fake map: the line/polygon highlight layers start
// hidden, show when search sets line features, and hide again on clear (an
// empty visible source still costs 3D terrain a per-frame drape).
// Deps: highlights.ts, state.ts.
import { describe, it, expect } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { addHighlightLayers, setHighlightFeatures, clearHighlights } from './highlights.js';

function fakeMap() {
  const vis = new Map<string, unknown>();
  const map = {
    addSource: () => {},
    addLayer: (spec: { id: string; layout?: { visibility?: string } }) =>
      vis.set(spec.id, spec.layout?.visibility ?? 'visible'),
    getSource: () => ({ setData: () => {} }),
    setLayoutProperty: (id: string, _k: string, v: unknown) => vis.set(id, v),
  };
  return { map: map as unknown as MaplibreMap, vis };
}

const line: GeoJSON.Feature = {
  type: 'Feature', properties: {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
};
const point: GeoJSON.Feature = {
  type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] },
};

describe('highlight line layers', () => {
  it('stay hidden while empty, show with line features, hide on clear', () => {
    const { map, vis } = fakeMap();
    state.map = map;
    state.mapReady = true;
    addHighlightLayers();
    expect(vis.get('highlight-lines')).toBe('none');
    expect(vis.get('highlight-poly-fill')).toBe('none');

    setHighlightFeatures([point]);
    expect(vis.get('highlight-lines')).toBe('none');

    setHighlightFeatures([line, point]);
    expect(vis.get('highlight-lines')).toBe('visible');
    expect(vis.get('highlight-poly-fill')).toBe('visible');

    clearHighlights();
    expect(vis.get('highlight-lines')).toBe('none');
    expect(vis.get('highlight-poly-fill')).toBe('none');
    state.map = null;
    state.mapReady = false;
  });
});
