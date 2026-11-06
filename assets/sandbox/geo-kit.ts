// ─── Geo kit: plain geometry for GeoJSON coordinates ────────────────────────
// Role: the small pure geometry set the deterministic joins (spatial-join.ts)
//       and, inlined by scripts/build_sandbox.mjs, the analysis sandbox share.
//       Coordinates are [longitude, latitude] in degrees; a polygon is an array
//       of rings (the first the outer ring, the rest holes); a line is an array
//       of positions. Planar tests (bbox, point-in-polygon, intersections) treat
//       lon/lat as x/y; length and area are spherical (R = 6371.0088 km).
//       No antimeridian handling: a geometry that crosses ±180 must be split
//       first, or its planar tests and bbox are wrong.
//       Written as plain JS with simple annotations (no enums, namespaces,
//       decorators or imports) so a script can strip the types and inline it.
//
// Deps: none.

/* eslint-disable @typescript-eslint/no-explicit-any */

const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** [west, south, east, north] of every position in a geometry, or null if it has none. */
export function bbox(geometry: { type: string; coordinates: any }): number[] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: any): void => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else {
      for (let i = 0; i < c.length; i++) walk(c[i]);
    }
  };
  if (geometry && geometry.coordinates) walk(geometry.coordinates);
  return w === Infinity ? null : [w, s, e, n];
}

/** Whether point [x, y] lies in the ring (even-odd ray casting; the boundary may go either way). */
export function pointInRing(point: number[], ring: number[][]): boolean {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the point is inside the polygon (rings: outer first, then holes). */
export function pointInPolygon(point: number[], rings: number[][][]): boolean {
  if (rings.length === 0 || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(point, rings[i])) return false;
  return true;
}

/** Whether the point is inside a Polygon or MultiPolygon geometry. */
export function pointInGeometry(point: number[], geometry: { type: string; coordinates: any }): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    for (let i = 0; i < geometry.coordinates.length; i++) {
      if (pointInPolygon(point, geometry.coordinates[i])) return true;
    }
  }
  return false;
}

/** The point where segments a-b and c-d meet, or null (parallel, collinear or apart). Endpoints count. */
export function segmentIntersection(a: number[], b: number[], c: number[], d: number[]): number[] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** Every point where the line crosses a ring's edges, in line order. */
export function lineRingCrossings(line: number[][], ring: number[][]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    for (let j = 0; j + 1 < ring.length; j++) {
      const p = segmentIntersection(line[i], line[i + 1], ring[j], ring[j + 1]);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Every point where the line crosses a polygon's boundary (outer ring and holes). */
export function linePolygonCrossings(line: number[][], rings: number[][][]): number[][] {
  let out: number[][] = [];
  for (let i = 0; i < rings.length; i++) out = out.concat(lineRingCrossings(line, rings[i]));
  return out;
}

/** The polygons of a Polygon or MultiPolygon geometry, each as an array of rings. */
export function polygonsOf(geometry: { type: string; coordinates: any }): number[][][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** Whether the line touches the geometry: it crosses its boundary or starts inside it. */
export function lineIntersectsGeometry(line: number[][], geometry: { type: string; coordinates: any }): boolean {
  const polys = polygonsOf(geometry);
  for (let i = 0; i < polys.length; i++) {
    if (line.length > 0 && pointInPolygon(line[0], polys[i])) return true;
    if (linePolygonCrossings(line, polys[i]).length > 0) return true;
  }
  return false;
}

/** How many times the line crosses a Polygon or MultiPolygon boundary. */
export function lineCrossingCount(line: number[][], geometry: { type: string; coordinates: any }): number {
  const polys = polygonsOf(geometry);
  let n = 0;
  for (let i = 0; i < polys.length; i++) n += linePolygonCrossings(line, polys[i]).length;
  return n;
}

/** Haversine distance between two positions, km. */
export function haversineKm(a: readonly number[], b: readonly number[]): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a position list, km. */
export function pathLengthKm(line: number[][]): number {
  let km = 0;
  for (let i = 0; i + 1 < line.length; i++) km += haversineKm(line[i], line[i + 1]);
  return km;
}

/** Length of a LineString or MultiLineString geometry, km (0 for any other type). */
export function lengthKm(geometry: { type: string; coordinates: any }): number {
  if (!geometry) return 0;
  if (geometry.type === 'LineString') return pathLengthKm(geometry.coordinates);
  if (geometry.type === 'MultiLineString') {
    let km = 0;
    for (let i = 0; i < geometry.coordinates.length; i++) km += pathLengthKm(geometry.coordinates[i]);
    return km;
  }
  return 0;
}

/** Absolute area of one ring on the sphere, km² (Chamberlain–Duquette equal-area sum). */
export function ringAreaKm2(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    sum += (q[0] - p[0]) * RAD * (2 + Math.sin(p[1] * RAD) + Math.sin(q[1] * RAD));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Area of a Polygon or MultiPolygon geometry, km², holes subtracted (0 for any other type). */
export function areaKm2(geometry: { type: string; coordinates: any }): number {
  const polys = polygonsOf(geometry);
  let km2 = 0;
  for (let i = 0; i < polys.length; i++) {
    for (let r = 0; r < polys[i].length; r++) {
      const a = ringAreaKm2(polys[i][r]);
      km2 += r === 0 ? a : -a;
    }
  }
  return km2;
}
