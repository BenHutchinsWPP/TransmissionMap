// @vitest-environment jsdom
// Tests for hover.ts's route-pick guard: while state.routePick is set a tap on
// a hover-enabled polygon sets no highlight.
// Deps: hover.js, map-input.js (mocked), state.js, registry.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const input = vi.hoisted(() => ({ fills: new Map<string, (e: unknown, f: unknown[]) => void>() }));
vi.mock('./map-input.js', () => ({
  onMapTap: (a: unknown, b?: (e: unknown, f: unknown[]) => void) => {
    if (typeof a === 'string' && b) input.fills.set(a, b);
    return () => {};
  },
  tapBox: () => [[0, 0], [1, 1]],
}));

import { initPolygonHover } from './hover.js';
import { state } from './state.js';
import { LAYERS } from '../src/registry/index.js';

const layer = LAYERS.find(l => l.hoverField)!;
const fill = layer.mapLayerIds.find(id => id.endsWith('-fill'))!;

describe('polygon fill tap handler', () => {
  const setFilter = vi.fn();
  const setLayoutProperty = vi.fn();

  beforeEach(() => {
    input.fills.clear();
    setFilter.mockClear();
    setLayoutProperty.mockClear();
    state.routePick = false;
    state.measure.active = false;
    state.editMode = 'view';
    state.map = {
      getLayer: () => ({ source: 's', sourceLayer: 'sl' }),
      getSource: () => ({}),
      addLayer: () => {},
      setFilter,
      setLayoutProperty,
      setPaintProperty: () => {},
      getLayoutProperty: () => 'visible',
    } as unknown as typeof state.map;
    initPolygonHover();
  });

  const tap = () => input.fills.get(fill)!({}, [{ properties: { [layer.hoverField!]: 'X' } }]);

  it('sets a highlight when not picking', () => {
    tap();
    expect(setFilter).toHaveBeenCalled();
  });

  it('sets no highlight while a route end is being picked', () => {
    state.routePick = true;
    tap();
    expect(setFilter).not.toHaveBeenCalled();
    expect(setLayoutProperty).not.toHaveBeenCalled();
  });
});
