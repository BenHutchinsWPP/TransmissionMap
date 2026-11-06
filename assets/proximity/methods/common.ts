// ─── Proximity methods: shared pieces ───────────────────────────────────────
// Role: what the unit-vector methods (m2.ts, m2f.ts, proximity.ts) share:
//         prepare(lon, lat, km, ids)  validity, unit vectors on the sphere (EARTH_KM), and the
//                                     two chord thresholds that bracket the ellipsoid:
//                                     cs = chord(km / SPHERE_RATIO_MAX): a pair within cs is
//                                     sure to be within km on the ellipsoid; c = chord(km /
//                                     SPHERE_RATIO_MIN): a pair beyond c is sure to be out;
//                                     in between the geodesic decides. c2 / cs2 are squares
//                                     (squared Euclidean distance replaces trig in the loops)
//         RHO2                        (SPHERE_RATIO_MAX / MIN)² with a rounding margin: a point's
//                                     ellipsoid nearest lies among the candidates within
//                                     RHO2 × its nearest squared chord
//         Dsu                         union-find over Int32Array: path halving, union by size
//       Pure: no DOM, no map.
//
// Deps: ../oracle.js, ../geodesic.js, ../../templates/nearest.js (EARTH_KM). Used by the other files in methods/ and ../proximity.ts.

import { EARTH_KM } from '../../templates/nearest.js';
import { SPHERE_RATIO_MAX, SPHERE_RATIO_MIN } from '../geodesic.js';
import { checkIds, checkKm, isValidPoint } from '../oracle.js';

const RAD = Math.PI / 180;

export interface Prep {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  /** per original row, or null */
  ids: Int32Array | null;
  /** original rows that are valid, ascending */
  vi: Int32Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  skipped: number;
  c: number;
  c2: number;
  cs: number;
  cs2: number;
}

export const RHO2 = (SPHERE_RATIO_MAX / SPHERE_RATIO_MIN) ** 2 * (1 + 1e-9);

const chord = (km: number): number => 2 * Math.sin(km / (2 * EARTH_KM));

export function prepare(lon: Float64Array, lat: Float64Array, km: number, ids?: Int32Array): Prep {
  checkKm(km);
  const n = lon.length;
  if (lat.length !== n) throw new RangeError('lon and lat differ in length');
  checkIds(ids, n);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const vi = new Int32Array(n);
  let nv = 0;
  for (let i = 0; i < n; i++) {
    if (!isValidPoint(lon[i], lat[i])) continue;
    const p = lat[i] * RAD, l = lon[i] * RAD, cp = Math.cos(p);
    x[i] = cp * Math.cos(l); y[i] = cp * Math.sin(l); z[i] = Math.sin(p);
    vi[nv++] = i;
  }
  const c = chord(km / SPHERE_RATIO_MIN), cs = chord(km / SPHERE_RATIO_MAX);
  return { n, lon, lat, ids: ids ?? null, vi: vi.subarray(0, nv), x, y, z, skipped: n - nv, c, c2: c * c, cs, cs2: cs * cs };
}

/** Union-find: path halving, union by size. */
export class Dsu {
  parent: Int32Array;
  size: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  /** Joins the sets of roots a and b (a !== b); returns the new root. */
  link(a: number, b: number): number {
    if (this.size[a] < this.size[b]) { const t = a; a = b; b = t; }
    this.parent[b] = a;
    this.size[a] += this.size[b];
    return a;
  }
}
