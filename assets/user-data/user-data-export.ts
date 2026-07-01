// ─── Export (download, KML/GeoJSON serialization) ────────────────────────────

import { state } from '../state.js';
import { escapeHtml } from '../utils/utils.js';

function downloadFile(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EXPORT_STYLE_KEYS: Record<string, string[]> = {
  Point:      ['marker-color'],
  LineString: ['stroke'],
  Polygon:    ['stroke', 'fill'],
};

function withExportStyle(f: GeoJSON.Feature) {
  const p = { ...(f.properties || {}) };
  const c = p.color || p.stroke || p.fill || p['marker-color'];
  if (c) {
    const base = (f.geometry?.type || '').replace(/^Multi/, '');
    for (const key of EXPORT_STYLE_KEYS[base] || []) {
      p[key] = p[key] || c;
    }
    if (base === 'Polygon' && p['fill-opacity'] == null) p['fill-opacity'] = 0.35;
  }
  return { ...f, properties: p };
}

// All of My Data: imported/copied layer features + drawn features.
function exportFeatures(): GeoJSON.Feature[] {
  const drawn = state.draw ? state.draw.getAll().features : [];
  const fromLayers = state.userLayers.flatMap(l => l.geojson.features);
  return [...fromLayers, ...drawn].map(withExportStyle);
}

export function saveGeoJSON() {
  const fc = { type: 'FeatureCollection', _tmSource: 'TransmissionMap', features: exportFeatures() };
  downloadFile(JSON.stringify(fc, null, 2), 'my-data.geojson', 'application/json');
}

export function saveKML() {
  downloadFile(featuresToKML(exportFeatures()), 'my-data.kml',
    'application/vnd.google-earth.kml+xml');
}

function featuresToKML(features: GeoJSON.Feature[]) {
  const placemarks = features.map((f: GeoJSON.Feature, i: number) => featureToPlacemark(f, i)).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n' +
    placemarks + '\n</Document>\n</kml>\n';
}

function featureToPlacemark(f: GeoJSON.Feature, i: number) {
  const p = f.properties || {};
  const name = p.name || p.Name || p.label || p.title || `Feature ${i + 1}`;
  return `<Placemark>\n<name>${escapeHtml(name)}</name>\n` +
    kmlStyle(p) + geomToKML(f.geometry) + '\n</Placemark>';
}

function kmlColor(hex: string | null | undefined, opacity: number | null | undefined) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return null;
  const h = m[1].toLowerCase();
  const a = Math.round((opacity == null ? 1 : Number(opacity)) * 255)
    .toString(16).padStart(2, '0');
  return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

function kmlStyle(p: Record<string, unknown>) {
  const stroke = kmlColor(p.stroke as string, p['stroke-opacity'] as number);
  const fill   = kmlColor(p.fill as string, p['fill-opacity'] as number);
  const icon   = kmlColor(p['marker-color'] as string, 1);
  if (!stroke && !fill && !icon) return '';
  let s = '<Style>';
  if (stroke) s += `<LineStyle><color>${stroke}</color><width>${Number(p['stroke-width']) || 2}</width></LineStyle>`;
  if (fill)   s += `<PolyStyle><color>${fill}</color></PolyStyle>`;
  if (icon)   s += `<IconStyle><color>${icon}</color></IconStyle>`;
  return s + '</Style>\n';
}

function ringStr(coords: number[][]) {
  return coords.map((c: number[]) => c.slice(0, 3).join(',')).join(' ');
}

function polygonKML(rings: number[][][]) {
  const outer = `<outerBoundaryIs><LinearRing><coordinates>${ringStr(rings[0])}</coordinates></LinearRing></outerBoundaryIs>`;
  const inner = rings.slice(1)
    .map((r: number[][]) => `<innerBoundaryIs><LinearRing><coordinates>${ringStr(r)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join('');
  return `<Polygon>${outer}${inner}</Polygon>`;
}

export function geomToKML(g: GeoJSON.Geometry | null | undefined): string {
  if (!g) return '';
  switch (g.type) {
    case 'Point':           return `<Point><coordinates>${g.coordinates.slice(0, 3).join(',')}</coordinates></Point>`;
    case 'LineString':      return `<LineString><coordinates>${ringStr(g.coordinates)}</coordinates></LineString>`;
    case 'Polygon':         return polygonKML(g.coordinates);
    case 'MultiPoint':      return `<MultiGeometry>${g.coordinates.map(c => geomToKML({ type: 'Point', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiLineString': return `<MultiGeometry>${g.coordinates.map(c => geomToKML({ type: 'LineString', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiPolygon':    return `<MultiGeometry>${g.coordinates.map(polygonKML).join('')}</MultiGeometry>`;
    case 'GeometryCollection': return `<MultiGeometry>${g.geometries.map(geomToKML).join('')}</MultiGeometry>`;
    default:                return '';
  }
}
