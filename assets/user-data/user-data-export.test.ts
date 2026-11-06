import { describe, it, expect } from 'vitest';
import { geomToKML, toCsv } from './user-data-export.js';

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

describe('toCsv', () => {
  it('writes note rows after the data and before the source row', () => {
    const lines = toCsv([{ a: 1 }], ['a'], '<a href="x">EIA-860</a>', ['Filters: Area: Texas, Fort Worth', '=cmd']).split('\r\n');
    expect(lines).toEqual(['a', '1', '"Filters: Area: Texas, Fort Worth"', "'=cmd", 'Source: EIA-860', '']);
  });

  it('writes a header and CRLF lines in field order', () => {
    expect(toCsv([{ b: 2, a: 1 }], ['a', 'b'])).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ n: 'Smith, "Big" Plant', m: 'line1\nline2' }], ['n', 'm']);
    expect(csv).toBe('n,m\r\n"Smith, ""Big"" Plant","line1\nline2"\r\n');
  });

  it('leaves missing values empty and numbers as they are', () => {
    expect(toCsv([{ a: null, c: -5 }], ['a', 'b', 'c'])).toBe('a,b,c\r\n,,-5\r\n');
  });

  it('prefixes formula-like strings with an apostrophe', () => {
    const rows = [{ v: '=HYPERLINK("http://x","y")' }, { v: '+1' }, { v: '-2' }, { v: '@SUM(A1)' }, { v: 'ok' }];
    expect(toCsv(rows, ['v']).split('\r\n')).toEqual([
      'v', `"'=HYPERLINK(""http://x"",""y"")"`, "'+1", "'-2", "'@SUM(A1)", 'ok', '',
    ]);
  });

  it('ends with the source credit as text, with the ODbL notice for OSM', () => {
    const osm = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";
    const last = toCsv([], ['a'], osm).split('\r\n').at(-2);
    expect(last).toBe('"Source: © OpenStreetMap contributors, ODbL 1.0 (https://opendatacommons.org/licenses/odbl/)"');
    expect(toCsv([], ['a'], '<a href="https://atlas.eia.gov/">EIA U.S. Energy Atlas</a>').split('\r\n').at(-2))
      .toBe('Source: EIA U.S. Energy Atlas');
  });
});
