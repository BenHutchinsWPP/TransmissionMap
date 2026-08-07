// Focused smoke-opacity tests for map-layers-conditions.ts.
// Deps: state.ts (relative opacity) and the conditions layer builder.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { applySmokeOpacity } from './map-layers-conditions.js';

function mockMap(layerIds: string[]) {
  return {
    getLayer: vi.fn((id: string) => layerIds.includes(id) ? {} : undefined),
    setPaintProperty: vi.fn(),
  };
}

describe('applySmokeOpacity', () => {
  beforeEach(() => {
    state.map = null;
    state.smokeOpacity = 1;
  });

  it('scales every density opacity and the outline exactly', () => {
    const map = mockMap(['wildfire-smoke-fill', 'wildfire-smoke-line']);
    state.map = map as unknown as typeof state.map;
    state.smokeOpacity = 0.5;

    applySmokeOpacity();

    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-fill', 'fill-opacity', [
      'match', ['get', 'density'],
      'Light', 0.09,
      'Medium', 0.14,
      'Heavy', 0.19,
      0.1,
    ]);
    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-line', 'line-opacity', 0.25);
  });

  it('does nothing without a map or smoke layers', () => {
    applySmokeOpacity();

    const map = mockMap([]);
    state.map = map as unknown as typeof state.map;
    applySmokeOpacity();

    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });

  it('updates whichever smoke layer exists', () => {
    const map = mockMap(['wildfire-smoke-line']);
    state.map = map as unknown as typeof state.map;

    applySmokeOpacity();

    expect(map.setPaintProperty).toHaveBeenCalledTimes(1);
    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-line', 'line-opacity', 0.5);
  });

  it('supports 0% opacity', () => {
    const map = mockMap(['wildfire-smoke-fill', 'wildfire-smoke-line']);
    state.map = map as unknown as typeof state.map;
    state.smokeOpacity = 0;

    applySmokeOpacity();

    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-fill', 'fill-opacity', [
      'match', ['get', 'density'],
      'Light', 0,
      'Medium', 0,
      'Heavy', 0,
      0,
    ]);
    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-line', 'line-opacity', 0);
  });

  it('preserves base opacity at 100%', () => {
    const map = mockMap(['wildfire-smoke-fill', 'wildfire-smoke-line']);
    state.map = map as unknown as typeof state.map;

    applySmokeOpacity();

    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-fill', 'fill-opacity', [
      'match', ['get', 'density'],
      'Light', 0.18,
      'Medium', 0.28,
      'Heavy', 0.38,
      0.2,
    ]);
    expect(map.setPaintProperty).toHaveBeenCalledWith('wildfire-smoke-line', 'line-opacity', 0.5);
  });
});
