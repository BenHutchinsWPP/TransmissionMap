import { describe, it, expect } from 'vitest';
import { geomToKML } from './user-data-export.js';

describe('geomToKML', () => {
  it('returns empty string for null/undefined', () => {
    expect(geomToKML(null)).toBe('');
    expect(geomToKML(undefined)).toBe('');
  });

  it('converts Point', () => {
    const g: GeoJSON.Point = { type: 'Point', coordinates: [-122.4194, 37.7749] };
    expect(geomToKML(g)).toBe('<Point><coordinates>-122.4194,37.7749</coordinates></Point>');
  });

  it('converts LineString', () => {
    const g: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [[-122, 37], [-121, 38]]
    };
    expect(geomToKML(g)).toBe('<LineString><coordinates>-122,37 -121,38</coordinates></LineString>');
  });

  it('converts Polygon (simple)', () => {
    const g: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-122, 37], [-121, 37], [-121, 38], [-122, 38], [-122, 37]]]
    };
    const expected = '<Polygon><outerBoundaryIs><LinearRing><coordinates>-122,37 -121,37 -121,38 -122,38 -122,37</coordinates></LinearRing></outerBoundaryIs></Polygon>';
    expect(geomToKML(g)).toBe(expected);
  });

  it('converts Polygon with holes', () => {
    const g: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [[-122, 37], [-121, 37], [-121, 38], [-122, 38], [-122, 37]],
        [[-121.5, 37.5], [-121.6, 37.5], [-121.6, 37.6], [-121.5, 37.6], [-121.5, 37.5]]
      ]
    };
    expect(geomToKML(g)).toContain('<outerBoundaryIs>');
    expect(geomToKML(g)).toContain('<innerBoundaryIs>');
  });

  it('converts MultiPoint', () => {
    const g: GeoJSON.MultiPoint = {
      type: 'MultiPoint',
      coordinates: [[-122, 37], [-121, 38]]
    };
    expect(geomToKML(g)).toBe('<MultiGeometry><Point><coordinates>-122,37</coordinates></Point><Point><coordinates>-121,38</coordinates></Point></MultiGeometry>');
  });

  it('converts MultiLineString', () => {
    const g: GeoJSON.MultiLineString = {
      type: 'MultiLineString',
      coordinates: [[[-122, 37], [-121, 38]], [[-120, 39], [-119, 40]]]
    };
    expect(geomToKML(g)).toContain('<LineString>');
    expect(geomToKML(g)).toContain('<MultiGeometry>');
  });

  it('converts MultiPolygon', () => {
    const g: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-122, 37], [-121, 37], [-121, 38], [-122, 38], [-122, 37]]],
        [[[-120, 39], [-119, 39], [-119, 40], [-120, 40], [-120, 39]]]
      ]
    };
    expect(geomToKML(g)).toContain('<Polygon>');
    expect(geomToKML(g)).toContain('<MultiGeometry>');
  });

  it('converts GeometryCollection', () => {
    const g: GeoJSON.GeometryCollection = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [-122, 37] },
        { type: 'LineString', coordinates: [[-122, 37], [-121, 38]] }
      ]
    };
    expect(geomToKML(g)).toBe('<MultiGeometry><Point><coordinates>-122,37</coordinates></Point><LineString><coordinates>-122,37 -121,38</coordinates></LineString></MultiGeometry>');
  });

  it('returns empty string for unknown geometry type', () => {
    // @ts-expect-error - testing invalid type
    expect(geomToKML({ type: 'Unknown' })).toBe('');
  });
});
