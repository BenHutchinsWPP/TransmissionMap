// service-spec.ts: kind sniffing from real service URLs, normalisation, every
// refusal of the trust-boundary validators, and the compiled MapLibre specs.
import { describe, it, expect } from 'vitest';
import {
  normaliseServiceUrl, parseServiceUrl, validateServiceSpec, validateStyle, validateLinkedService,
  validateLinkedServices, styleToLayers, tileTemplate, type LinkedService, type ServiceKind,
} from './service-spec.js';

const ok = <T>(o: { ok: true; result: T } | { ok: false; reason: string }): T => {
  if (!o.ok) throw new Error('refused: ' + o.reason);
  return o.result;
};

describe('parseServiceUrl sniffs the kind', () => {
  const cases: [string, ServiceKind, string, string?][] = [
    ['https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0',
      'arcgis-feature', 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer', '0'],
    ['https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/Rights_of_Way/FeatureServer',
      'arcgis-feature', 'https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/Rights_of_Way/FeatureServer'],
    ['https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
      'arcgis-export', 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer'],
    ['https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1',
      'arcgis-feature', 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer', '1'],
    ['https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
      'arcgis-image', 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer'],
    ['https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms?service=WMS&LAYERS=NLCD_2021_Land_Cover_L48',
      'wms', 'https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms', 'NLCD_2021_Land_Cover_L48'],
    ['https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer',
      'wms', 'https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer'],
    ['https://nowcoast.noaa.gov/geoserver/ows', 'wms', 'https://nowcoast.noaa.gov/geoserver/ows'],
    ['https://sdmdataaccess.sc.egov.usda.gov/Spatial/SDM.wms', 'wms', 'https://sdmdataaccess.sc.egov.usda.gov/Spatial/SDM.wms'],
    ['https://wms.gebco.net/mapserv?service=WMS&request=GetCapabilities', 'wms', 'https://wms.gebco.net/mapserv'],
    ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      'xyz', 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    ['https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
      'xyz', 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png'],
    ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      'xyz', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'],
    ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
      'geojson', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'],
    ['https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
      'geojson', 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'],
    ['https://r2-public.protomaps.com/protomaps-sample-datasets/cb_2018_us_zcta510_500k.pmtiles',
      'pmtiles-raster', 'https://r2-public.protomaps.com/protomaps-sample-datasets/cb_2018_us_zcta510_500k.pmtiles'],
  ];
  it.each(cases)('%s', (raw, kind, url, layer) => {
    const spec = ok(parseServiceUrl(raw));
    expect(spec.kind).toBe(kind);
    expect(spec.url).toBe(url);
    expect(spec.layer).toBe(layer);
    expect(spec.host).toBe(new URL(url).hostname);
  });

  it('rewrites a GoogleMapsCompatible WMTS-REST template to {z}/{y}/{x}', () => {
    const spec = ok(parseServiceUrl('https://tiles.example.org/wmts/1.0.0/layer/default/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png'));
    expect(spec).toMatchObject({ kind: 'xyz', url: 'https://tiles.example.org/wmts/1.0.0/layer/default/GoogleMapsCompatible/{z}/{y}/{x}.png' });
  });

  it('refuses a WMTS template in another matrix set, or a {time} placeholder', () => {
    expect(parseServiceUrl('https://t.example.org/wmts/layer/EPSG4326/{TileMatrix}/{TileRow}/{TileCol}.png').ok).toBe(false);
    expect(parseServiceUrl('https://t.example.org/wmts/layer/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png').ok).toBe(false);
    expect(parseServiceUrl('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/{time}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png').ok).toBe(false);
    expect(parseServiceUrl('https://t.example.org/{z}/{x}.png').ok).toBe(false);
  });

  it('reads the WMS version; 1.3.0 is the default and not stored', () => {
    expect(ok(parseServiceUrl('https://mrdata.usgs.gov/services/sgmc?service=WMS&version=1.1.1&layers=sgmc')).version).toBe('1.1.1');
    expect(ok(parseServiceUrl('https://wms.gebco.net/mapserv?service=WMS&version=1.3.0')).version).toBeUndefined();
  });

  it('takes a kind hint where the path cannot tell, and refuses a contradicting one', () => {
    expect(parseServiceUrl('https://mrdata.usgs.gov/services/sgmc').ok).toBe(false);
    expect(ok(parseServiceUrl('https://mrdata.usgs.gov/services/sgmc', 'wms')).kind).toBe('wms');
    expect(ok(parseServiceUrl('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28', 'arcgis-export')))
      .toMatchObject({ kind: 'arcgis-export', layer: '28' });
    expect(parseServiceUrl('https://services2.arcgis.com/x/arcgis/rest/services/A/FeatureServer/0', 'wms').ok).toBe(false);
    expect(parseServiceUrl('https://example.com/a.geojson', 'bogus' as ServiceKind).ok).toBe(false);
  });

  it.each(['token', 'access_token', 'api_key', 'apikey', 'key', 'TOKEN', 'ApiKey'])('refuses a URL carrying a %s param', p => {
    const r = parseServiceUrl(`https://services.arcgis.com/o/arcgis/rest/services/S/FeatureServer/0/query?where=1%3D1&${p}=abc`);
    expect(r).toEqual({ ok: false, reason: 'This service needs a sign-in or key, which isn\'t supported.' });
    expect(normaliseServiceUrl(`https://example.com/a.geojson?${p}=abc`).ok).toBe(false);
  });

  it('takes LAYERS only for a WMS', () => {
    expect(ok(parseServiceUrl('https://example.com/a.geojson?layers=x'))).toEqual(
      { kind: 'geojson', url: 'https://example.com/a.geojson', host: 'example.com' });
    expect(ok(normaliseServiceUrl('https://example.com/a.geojson?layers=x'))).toEqual({ url: 'https://example.com/a.geojson' });
    expect(ok(parseServiceUrl('https://mrdata.usgs.gov/services/sgmc?layers=sgmc', 'wms')).layer).toBe('sgmc');
  });

  it('refuses a MapServer export whose layers is not show:N', () => {
    const root = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export?bbox=1,2,3,4&layers=';
    for (const l of ['hide:3', 'show:1,2', 'include:3', 'exclude:3', '3'])
      expect(parseServiceUrl(root + l).ok, l).toBe(false);
    expect(ok(parseServiceUrl(root + 'SHOW:3'))).toMatchObject({ kind: 'arcgis-export', layer: '3' });
  });

  it('reads GoogleMapsCompatible from the path only, and placeholders in their exact case', () => {
    expect(parseServiceUrl('https://t.example.org/wmts/layer/EPSG4326/{TileMatrix}/{TileRow}/{TileCol}.png?m=GoogleMapsCompatible').ok).toBe(false);
    const lower = parseServiceUrl('https://t.example.org/wmts/layer/GoogleMapsCompatible/{tilematrix}/{tilerow}/{tilecol}.png');
    expect(lower.ok).toBe(false);
    if (!lower.ok) expect(lower.reason).not.toMatch(/undefined/);
    expect(parseServiceUrl('https://t.example.org/wmts/layer/GoogleMapsCompatible/{TileMatrix}/{tilerow}/{TileCol}.png').ok).toBe(false);
    expect(ok(parseServiceUrl('https://t.example.org/wmts/GoogleMapsCompatible/%7BTileMatrix%7D/%7bTileRow%7d/{TileCol}.png')).url)
      .toBe('https://t.example.org/wmts/GoogleMapsCompatible/{z}/{y}/{x}.png');
  });

  it('sniffs WMS by whole segment or .wms extension, after .json/.geojson', () => {
    expect(parseServiceUrl('https://example.com/cmwms/data').ok).toBe(false);
    expect(parseServiceUrl('https://example.com/wmsdata/layer').ok).toBe(false);
    expect(ok(parseServiceUrl('https://example.com/wms/countries.geojson')).kind).toBe('geojson');
    expect(ok(parseServiceUrl('https://example.com/wms/a.json?service=WMS')).kind).toBe('geojson');
    expect(ok(parseServiceUrl('https://example.com/geo/wms/')).kind).toBe('wms');
  });

  it('refuses http, credentials, junk, unknown kinds and odd ArcGIS paths', () => {
    expect(parseServiceUrl('http://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer').ok).toBe(false);
    expect(parseServiceUrl('https://u:p@example.com/a.geojson').ok).toBe(false);
    expect(parseServiceUrl('not a url').ok).toBe(false);
    expect(parseServiceUrl('https://example.com/page.html').ok).toBe(false);
    expect(parseServiceUrl('https://atlas.eia.gov/arcgis/rest/services').ok).toBe(false);
    expect(parseServiceUrl('https://h.example.gov/arcgis/rest/services/A/MapServer/legend').ok).toBe(false);
  });
});

describe('normaliseServiceUrl', () => {
  const root = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
  it.each([
    [root + '/0', { url: root, layer: '0' }],
    [root + '/28/query?where=1%3D1&outFields=*&f=geojson', { url: root, layer: '28' }],
    [root + '/export?bbox=1,2,3,4&layers=show:3&f=image', { url: root, layer: '3' }],
    [root + '?f=json#frag', { url: root }],
    [root + '/', { url: root }],
    ['https://hazards.fema.gov/ArcGIS/REST/Services/public/NFHL/mapserver', { url: root }],
    ['https://HAZARDS.fema.gov/arcgis/rest/services/public/NFHL/MapServer', { url: root }],
    ['https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=1,2,3,4',
      { url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer' }],
    ['https://nowcoast.noaa.gov/geoserver/ows?SERVICE=WMS&REQUEST=GetMap&LAYERS=a:b,c:d&BBOX=1,2,3,4',
      { url: 'https://nowcoast.noaa.gov/geoserver/ows', layer: 'a:b,c:d' }],
  ])('%s', (raw, want) => {
    expect(ok(normaliseServiceUrl(raw))).toEqual(want);
  });

  it.each([
    ['an unsniffable path', 'https://example.com/page.html'],
    ['an empty layer segment', root + '//0'],
    ['a path parameter', root + '/0;x'],
    ['an extra segment after query', root + '/0/query/extra'],
    ['a percent-encoded layer index', root + '/%30'],
    ['an ArcGIS service list', 'https://atlas.eia.gov/arcgis/rest/services'],
  ])('refuses %s', (_, raw) => {
    expect(normaliseServiceUrl(raw).ok).toBe(false);
  });

  it('takes a kind hint where the path cannot tell; its output always validates', () => {
    expect(ok(normaliseServiceUrl('https://mrdata.usgs.gov/services/sgmc?layers=sgmc', 'wms')))
      .toEqual({ url: 'https://mrdata.usgs.gov/services/sgmc', layer: 'sgmc' });
    for (const raw of [root + '/28/query?f=geojson', root + '/export?layers=show:3', 'https://nowcoast.noaa.gov/geoserver/ows?LAYERS=a:b']) {
      const n = ok(normaliseServiceUrl(raw));
      const kind = ok(parseServiceUrl(raw)).kind;
      expect(ok(validateServiceSpec({ kind, ...n }))).toMatchObject(n);
    }
  });

  it('refuses http and a normalised URL over 1,024 characters', () => {
    expect(normaliseServiceUrl('http://example.com/a.geojson').ok).toBe(false);
    expect(normaliseServiceUrl('https://example.com/' + 'a'.repeat(1010) + '.geojson').ok).toBe(false);
    expect(normaliseServiceUrl('https://example.com/a.geojson?q=' + 'a'.repeat(3000)).ok).toBe(true);
  });
});

describe('validateServiceSpec', () => {
  it('returns the canonical copy, host recomputed', () => {
    expect(ok(validateServiceSpec({ kind: 'arcgis-feature', url: 'https://h.example.gov/ArcGIS/rest/services/A/FeatureServer/2/', host: 'evil.net' })))
      .toEqual({ kind: 'arcgis-feature', url: 'https://h.example.gov/arcgis/rest/services/A/FeatureServer', host: 'h.example.gov', layer: '2' });
  });
  it('refuses a bad kind, a kind that does not fit, a bad layer, or a layer that contradicts the URL', () => {
    expect(validateServiceSpec({ kind: 'mvt', url: 'https://a.example/x.pmtiles' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'xyz', url: 'https://a.example/x.geojson' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'arcgis-feature', url: 'https://h.example/arcgis/rest/services/A/FeatureServer', layer: 'x' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'arcgis-feature', url: 'https://h.example/arcgis/rest/services/A/FeatureServer/1', layer: '2' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'geojson', url: 'https://a.example/x.geojson', layer: '1' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'wms', url: 'https://a.example/wms', layer: 'a"><script>' }).ok).toBe(false);
    expect(validateServiceSpec({ kind: 'wms', url: 'https://a.example/wms', version: '2.0' }).ok).toBe(false);
    expect(validateServiceSpec('https://a.example/x.geojson').ok).toBe(false);
  });
});

describe('validateStyle', () => {
  const base = { kind: 'line', color: '#a1b2c3', opacity: 0.8 };
  it('accepts scalars and a colour-by', () => {
    expect(ok(validateStyle({ ...base, width: 2, minzoom: 5 }))).toEqual({ ...base, width: 2, minzoom: 5 });
    expect(ok(validateStyle({ kind: 'circle', color: '#fff', opacity: 1, radius: 3,
      by: { field: 'PrimSource', categories: [['Coal', '#000'], ['Wind', '#0f0']] } })).by?.categories).toHaveLength(2);
    expect(ok(validateStyle({ ...base, by: { field: 'kv', stops: [[100, '#000'], [500, '#f00']] } })).by?.stops).toHaveLength(2);
  });
  it.each<[string, unknown]>([
    ['bad colour', { ...base, color: 'red' }],
    ['8-digit colour', { ...base, color: '#11223344' }],
    ['colour expression', { ...base, color: ['get', 'c'] }],
    ['opacity > 1', { ...base, opacity: 1.5 }],
    ['opacity expression', { ...base, opacity: ['interpolate', ['linear'], ['zoom'], 4, 0, 10, 1] }],
    ['width > 20', { ...base, width: 21 }],
    ['radius > 30', { ...base, kind: 'circle', radius: 31 }],
    ['radius expression', { ...base, kind: 'circle', radius: ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 6] }],
    ['minzoom > 22', { ...base, minzoom: 23 }],
    ['NaN', { ...base, opacity: NaN }],
    ['unknown kind', { ...base, kind: 'heatmap' }],
    ['unknown key', { ...base, paint: { 'line-color': '#000' } }],
    ['bad field', { ...base, by: { field: 'a b', categories: [['x', '#000']] } }],
    ['field expression', { ...base, by: { field: ['get', 'x'], categories: [['x', '#000']] } }],
    ['comma-string categories', { ...base, by: { field: 'f', categories: 'Coal, Wind' } }],
    ['> 24 categories', { ...base, by: { field: 'f', categories: Array.from({ length: 25 }, (_, i) => [String(i), '#000']) } }],
    ['mixed category types', { ...base, by: { field: 'f', categories: [['a', '#000'], [1, '#fff']] } }],
    ['duplicate category', { ...base, by: { field: 'f', categories: [['a', '#000'], ['a', '#fff']] } }],
    ['stops not increasing', { ...base, by: { field: 'f', stops: [[5, '#000'], [1, '#fff']] } }],
    ['stops and categories', { ...base, by: { field: 'f', stops: [[1, '#000'], [2, '#fff']], categories: [['a', '#000']] } }],
    ['colour-by on raster', { kind: 'raster', color: '#000', opacity: 1, by: { field: 'f', categories: [['a', '#000']] } }],
    ['not an object', [base]],
  ])('refuses %s', (_, style) => {
    expect(validateStyle(style).ok).toBe(false);
  });
});

const svc = (over: Partial<LinkedService> = {}): LinkedService => ({
  id: 's1', kind: 'arcgis-feature', host: 'services2.arcgis.com', layer: '0',
  url: 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer',
  title: 'US Power Plants', style: { kind: 'circle', color: '#336699', opacity: 0.85 }, visible: true,
  credit: 'U.S. Energy Information Administration', ...over,
});

describe('validateLinkedService(s)', () => {
  it('accepts a valid list', () => {
    expect(ok(validateLinkedServices([svc(), svc({ id: 's2', libraryId: 'eia-power-plants' })]))).toHaveLength(2);
  });
  it('refuses more than 5 services', () => {
    expect(validateLinkedServices(Array.from({ length: 6 }, (_, i) => svc({ id: 's' + i }))).ok).toBe(false);
  });
  it('refuses a list over 3,000 characters', () => {
    const list = Array.from({ length: 5 }, (_, i) => svc({ id: 's' + i, title: 'T'.repeat(190), credit: 'C'.repeat(290) }));
    expect(validateLinkedServices(list.slice(0, 2)).ok).toBe(true);
    expect(validateLinkedServices(list).ok).toBe(false);
  });
  it('refuses duplicate ids, http, a style that does not fit the kind, a missing layer, unknown keys', () => {
    expect(validateLinkedServices([svc(), svc()]).ok).toBe(false);
    expect(validateLinkedService(svc({ url: 'http://services2.arcgis.com/a/arcgis/rest/services/B/FeatureServer' })).ok).toBe(false);
    expect(validateLinkedService(svc({ style: { kind: 'raster', color: '#000', opacity: 1 } })).ok).toBe(false);
    expect(validateLinkedService(svc({ kind: 'xyz', url: 'https://t.example/{z}/{x}/{y}.png', layer: undefined })).ok).toBe(false);
    expect(validateLinkedService(svc({ layer: undefined })).ok).toBe(false);
    expect(validateLinkedService({ ...svc(), onload: 'x' }).ok).toBe(false);
    expect(validateLinkedService(svc({ id: 'a b' })).ok).toBe(false);
    expect(validateLinkedService(svc({ style: { kind: 'circle', color: '#000', opacity: 1, radius: ['get', 'r'] as unknown as number } })).ok).toBe(false);
  });
});

describe('styleToLayers', () => {
  it('draws a feature service from an empty GeoJSON source the renderer fills', () => {
    const { sourceId, source, layers } = styleToLayers(svc({ style: { kind: 'circle', color: '#336699', opacity: 0.5, radius: 3, minzoom: 5,
      by: { field: 'PrimSource', categories: [['Coal', '#000000'], ['Wind', '#00ff00']] } } }));
    expect(sourceId).toBe('svc-s1');
    expect(source).toEqual({ type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ id: 'svc-s1-circle', type: 'circle', source: 'svc-s1', minzoom: 5, layout: { visibility: 'visible' } });
    expect((layers[0] as { paint: Record<string, unknown> }).paint['circle-color'])
      .toEqual(['match', ['get', 'PrimSource'], 'Coal', '#000000', 'Wind', '#00ff00', '#336699']);
  });

  it('compiles stops to an interpolate and hides an invisible service', () => {
    const { layers } = styleToLayers(svc({ visible: false, style: { kind: 'line', color: '#000', opacity: 1, width: 2, by: { field: 'kv', stops: [[100, '#000'], [500, '#f00']] } } }));
    expect(layers[0]).toMatchObject({ type: 'line', layout: { visibility: 'none' },
      paint: { 'line-width': 2, 'line-color': ['interpolate', ['linear'], ['to-number', ['get', 'kv'], 0], 100, '#000', 500, '#f00'] } });
  });

  const raster = { kind: 'raster' as const, color: '#000', opacity: 0.6 };
  it('builds MapServer export tiles, with layers=show:N when a layer is set', () => {
    const url = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
    const s = svc({ kind: 'arcgis-export', url, host: 'hazards.fema.gov', layer: undefined, style: raster });
    expect(tileTemplate(s)).toBe(url + '/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image');
    expect(tileTemplate({ ...s, layer: '28' })).toMatch(/&layers=show:28$/);
    const { source, layers } = styleToLayers(s);
    expect(source).toEqual({ type: 'raster', tiles: [tileTemplate(s)], tileSize: 256 });
    expect(layers[0]).toMatchObject({ id: 'svc-s1-raster', type: 'raster', paint: { 'raster-opacity': 0.6 } });
  });

  it('builds ImageServer exportImage tiles', () => {
    const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
    expect(tileTemplate({ kind: 'arcgis-image', url, host: '' }))
      .toBe(url + '/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image');
  });

  it('builds WMS GetMap in EPSG:3857 (CRS for 1.3.0, SRS for 1.1.1)', () => {
    const url = 'https://nowcoast.noaa.gov/geoserver/ows';
    const t13 = tileTemplate({ kind: 'wms', url, host: '', layer: 'a:b,c' });
    expect(t13).toContain('VERSION=1.3.0');
    expect(t13).toContain('&CRS=EPSG:3857&BBOX={bbox-epsg-3857}');
    expect(t13).toContain('LAYERS=a%3Ab%2Cc');
    const t11 = tileTemplate({ kind: 'wms', url, host: '', layer: 'x', version: '1.1.1' });
    expect(t11).toContain('VERSION=1.1.1');
    expect(t11).toContain('&SRS=EPSG:3857');
    expect(t11).not.toContain('CRS=');
  });

  it('passes xyz through and serves PMTiles through the pmtiles:// protocol', () => {
    const xyz = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
    expect(styleToLayers(svc({ kind: 'xyz', url: xyz, layer: undefined, style: raster })).source).toEqual({ type: 'raster', tiles: [xyz], tileSize: 256 });
    const pm = 'https://r2-public.protomaps.com/protomaps-sample-datasets/x.pmtiles';
    expect(styleToLayers(svc({ kind: 'pmtiles-raster', url: pm, layer: undefined, style: raster })).source)
      .toEqual({ type: 'raster', url: 'pmtiles://' + pm, tileSize: 256 });
  });
});
