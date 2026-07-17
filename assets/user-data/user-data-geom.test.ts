import { describe, it, expect } from 'vitest';
import { collectCoords, coordsBounds, haversineMeters } from './user-data-geom.js';

describe('collectCoords', () => {
  it('returns [] for null/empty', () => {
    expect(collectCoords(null)).toEqual([]);
    expect(collectCoords({ type: 'Unknown' } as unknown as GeoJSON.Geometry)).toEqual([]);
  });

  it('wraps a Point coordinate', () => {
    expect(collectCoords({ type: 'Point', coordinates: [1, 2] })).toEqual([[1, 2]]);
  });

  it('passes LineString / MultiPoint coordinates through', () => {
    const coords = [[0, 0], [1, 1]];
    expect(collectCoords({ type: 'LineString', coordinates: coords })).toEqual(coords);
    expect(collectCoords({ type: 'MultiPoint', coordinates: coords })).toEqual(coords);
  });

  it('flattens Polygon rings one level', () => {
    const poly = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1]]] };
    expect(collectCoords(poly)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it('flattens MultiPolygon two levels', () => {
    const mp = { type: 'MultiPolygon' as const, coordinates: [[[[0, 0], [1, 1]]], [[[2, 2]]]] };
    expect(collectCoords(mp)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('recurses into GeometryCollection', () => {
    const gc = {
      type: 'GeometryCollection' as const,
      geometries: [
        { type: 'Point' as const, coordinates: [5, 5] },
        { type: 'LineString' as const, coordinates: [[6, 6], [7, 7]] },
      ],
    };
    expect(collectCoords(gc)).toEqual([[5, 5], [6, 6], [7, 7]]);
  });
});

describe('coordsBounds', () => {
  it('returns null for empty input', () => {
    expect(coordsBounds([])).toBeNull();
  });

  it('computes min/max lng/lat', () => {
    expect(coordsBounds([[-1, 3], [4, -2], [2, 5]])).toEqual({
      minLng: -1, minLat: -2, maxLng: 4, maxLat: 5,
    });
  });

  it('handles a single coordinate', () => {
    expect(coordsBounds([[10, 20]])).toEqual({
      minLng: 10, minLat: 20, maxLng: 10, maxLat: 20,
    });
  });
});

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters([0, 0], [0, 0])).toBe(0);
  });

  it('is symmetric', () => {
    const a = haversineMeters([0, 0], [1, 1]);
    const b = haversineMeters([1, 1], [0, 0]);
    expect(a).toBeCloseTo(b, 6);
  });

  it('~111 km per degree of latitude at the equator', () => {
    const m = haversineMeters([0, 0], [0, 1]);
    expect(m).toBeGreaterThan(110_000);
    expect(m).toBeLessThan(112_000);
  });
});
