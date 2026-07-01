// ─── Geometry utilities + top-bar feature info ───────────────────────────────

export function collectCoords(geom: GeoJSON.Geometry | null | undefined): number[][] {
  if (!geom) return [];
  if (geom.type === 'Point') return [geom.coordinates];
  if (geom.type === 'LineString' || geom.type === 'MultiPoint') return geom.coordinates;
  if (geom.type === 'Polygon' || geom.type === 'MultiLineString') return geom.coordinates.flat();
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(collectCoords);
  return [];
}

export function coordsBounds(coords: number[][]) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return isFinite(minLng) ? { minLng, minLat, maxLng, maxLat } : null;
}

export function haversineMeters([lng1, lat1]: number[], [lng2, lat2]: number[]) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lineLengthMeters(geom: GeoJSON.Geometry) {
  const lines = geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates : [];
  let total = 0;
  for (const line of lines)
    for (let i = 1; i < line.length; i++) total += haversineMeters(line[i - 1], line[i]);
  return total;
}

function ringAreaMeters(ring: number[][] | null | undefined) {
  if (!ring || ring.length < 3) return 0;
  const R = 6378137, rad = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    area += (lng2 - lng1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs(area * R * R / 2);
}

function polygonAreaMeters(geom: GeoJSON.Geometry) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  let total = 0;
  for (const rings of polys) {
    if (!rings.length) continue;
    total += ringAreaMeters(rings[0]);
    for (let i = 1; i < rings.length; i++) total -= ringAreaMeters(rings[i]);
  }
  return total;
}

function featureInfoText(geom: GeoJSON.Geometry | null | undefined) {
  if (!geom) return '';
  const t = geom.type;
  if (t === 'Point' || t === 'MultiPoint') {
    const c = t === 'Point' ? geom.coordinates : geom.coordinates[0];
    if (!c) return '';
    return `📍 ${c[1].toFixed(5)}, ${c[0].toFixed(5)}`;
  }
  if (t === 'LineString' || t === 'MultiLineString') {
    const m = lineLengthMeters(geom);
    return `📏 ${(m / 1609.344).toFixed(2)} mi · ${(m / 1000).toFixed(2)} km`;
  }
  if (t === 'Polygon' || t === 'MultiPolygon') {
    const a = polygonAreaMeters(geom);
    return `▱ ${(a / 2589988.11).toFixed(2)} mi² · ${(a / 1e6).toFixed(2)} km²`;
  }
  return '';
}

export function showFeatureInfo(geom: GeoJSON.Geometry | null | undefined) {
  const el = document.getElementById('featureInfo');
  if (!el) return;
  const text = featureInfoText(geom);
  el.textContent = text;
  el.hidden = !text;
}

export function clearFeatureInfo() {
  const el = document.getElementById('featureInfo');
  if (el) { el.textContent = ''; el.hidden = true; }
}
