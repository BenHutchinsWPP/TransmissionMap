// @vitest-environment jsdom
// Feature search finds only what the map draws: a feature an Area filter (or
// any layer filter) hides is not a result.
import { describe, it, expect } from 'vitest';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification } from 'maplibre-gl';
import { drawnBy } from './ui-search.js';
import { toMapLibreFilter } from '../../src/registry/condition-compile.js';

const plant = (states: string | undefined, type: GeoJSON.Geometry['type'] = 'Point'): GeoJSON.Feature => ({
  type: 'Feature',
  properties: states === undefined ? { plant_name: 'x' } : { plant_name: 'x', states },
  geometry: (type === 'Point' ? { type, coordinates: [0, 0] } : { type: 'LineString', coordinates: [[0, 0], [1, 1]] }) as GeoJSON.Geometry,
});

describe('drawnBy', () => {
  const inTexas = toMapLibreFilter('eia_generators', [{ field: 'states', op: 'contains_any', value: ['TX'] }]) as unknown as FilterSpecification;

  it('drops a feature the Area filter hides', () => {
    const drawn = drawnBy([inTexas], featureFilter, 5);
    expect(drawn(plant('|TX|'))).toBe(true);
    expect(drawn(plant('|NM|TX|'))).toBe(true);
    expect(drawn(plant('|NM|'))).toBe(false);
    expect(drawn(plant(undefined))).toBe(false);
  });

  it('keeps a feature any one map layer draws', () => {
    const pointsOnly = ['==', ['geometry-type'], 'Point'] as FilterSpecification;
    const drawn = drawnBy([pointsOnly, inTexas], featureFilter, 5);
    expect(drawn(plant('|NM|'))).toBe(true);
    expect(drawn(plant('|NM|', 'LineString'))).toBe(false);
  });

  it('keeps everything when a map layer has no filter, or there is none to read', () => {
    expect(drawnBy([inTexas, null], featureFilter, 5)(plant('|NM|'))).toBe(true);
    expect(drawnBy([], featureFilter, 5)(plant('|NM|'))).toBe(true);
  });
});
