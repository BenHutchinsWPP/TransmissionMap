// ─── Proximity oracle (m0) ──────────────────────────────────────────────────
// Role: the exact reference every proximity method is held to: brute force
//       O(n²) over all pairs, WGS84 geodesic distance (geodesic.ts), union-find.
//       A pair is skipped without a geodesic when its straight-line (ECEF) chord
//       exceeds km, which is rigorous (a geodesic is never shorter than the chord)
//       and independent of the sphere bounds the fast methods use. Test and
//       benchmark support; never shipped to the page. Also the shared pieces:
//         MIN_KM, MAX_KM, checkKm(km)       threshold range (0.01–1000 km), RangeError outside
//         checkIds(ids, n)                  ids must match the point count
//         isValidPoint(lon, lat)            finite, |lat| ≤ 90, |lon| ≤ 180
//         distKm(lon1, lat1, lon2, lat2)    haversine on a sphere of EARTH_KM (the fast filter's
//                                           reference; the ellipsoid is geodesicKm)
//         finishGroups(root, nearest, km, skipped)
//                    per-point component label (-1 = invalid) and raw nearest
//                    distance (Infinity = none) → ProximityResult: components of
//                    size ≥ 2 numbered 1..G by lowest row index, sizes, and
//                    nearestKm with NaN beyond km
//         oraclePairs(lon, lat, km, opts)   every pair within km, sorted as PairsResult
//       Pure: no DOM, no map.
//
// Deps: ../templates/nearest.js (EARTH_KM), ./geodesic.js, ./types.js. Used by methods.ts, proximity.ts, proximity.test.ts.

import { EARTH_KM } from '../templates/nearest.js';
import { geodesicKm } from './geodesic.js';
import type { PairsOptions, PairsResult, ProximityOptions, ProximityResult } from './types.js';

export const MIN_KM = 0.01;
export const MAX_KM = 1000;
const RAD = Math.PI / 180;

/** Throws RangeError unless km is a number in [MIN_KM, MAX_KM]. */
export function checkKm(km: number): void {
  if (!(km >= MIN_KM && km <= MAX_KM)) throw new RangeError(`threshold must be ${MIN_KM}–${MAX_KM} km`);
}

export function checkIds(ids: Int32Array | undefined, n: number): void {
  if (ids && ids.length !== n) throw new RangeError('ids and lon differ in length');
}

export function isValidPoint(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Great-circle km between two lon/lat points in degrees (haversine). */
export function distKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Numbering, sizes and nearestKm from per-point component labels. */
export function finishGroups(root: Int32Array, nearest: Float64Array, km: number, skipped: number): ProximityResult {
  const n = root.length;
  const count = new Int32Array(n);
  for (let i = 0; i < n; i++) if (root[i] >= 0) count[root[i]]++;
  const label = new Int32Array(n);
  const group = new Int32Array(n), size = new Int32Array(n);
  const nearestKm = new Float64Array(n).fill(NaN);
  let groups = 0;
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (r < 0 || count[r] < 2) continue;
    if (!label[r]) label[r] = ++groups;
    group[i] = label[r];
    size[i] = count[r];
    if (nearest[i] <= km) nearestKm[i] = nearest[i];
  }
  return { group, groups, size, nearestKm, skipped };
}

const WGS_A = 6378.137, WGS_E2 = 0.0066943799901413165;

/** Pairs and their geodesic km, brute force; the shared walk of oracle and oraclePairs. */
function walk(lon: Float64Array, lat: Float64Array, km: number, ids: Int32Array | undefined, onPair: (i: number, j: number, d: number) => void): number {
  checkKm(km);
  const n = lon.length;
  if (lat.length !== n) throw new RangeError('lon and lat differ in length');
  checkIds(ids, n);
  const ok = new Uint8Array(n), x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    if (!isValidPoint(lon[i], lat[i])) { skipped++; continue; }
    ok[i] = 1;
    const p = lat[i] * RAD, l = lon[i] * RAD, s = Math.sin(p), c = Math.cos(p);
    const nu = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
    x[i] = nu * c * Math.cos(l); y[i] = nu * c * Math.sin(l); z[i] = nu * (1 - WGS_E2) * s;
  }
  const lim = (km * (1 + 1e-9)) ** 2;
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!ok[j]) continue;
      if (ids && ids[i] >= 0 && ids[i] === ids[j]) continue;
      const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
      if (dx * dx + dy * dy + dz * dz > lim) continue;
      const d = geodesicKm(lon[i], lat[i], lon[j], lat[j]);
      if (d <= km) onPair(i, j, d);
    }
  }
  return skipped;
}

/** m0: every pair, union-find with path halving. Exact. */
export function oracle(lon: Float64Array, lat: Float64Array, km: number, opts?: ProximityOptions): ProximityResult {
  const n = lon.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const nearest = new Float64Array(n).fill(Infinity);
  const skipped = walk(lon, lat, km, opts?.ids, (i, j, d) => {
    if (d < nearest[i]) nearest[i] = d;
    if (d < nearest[j]) nearest[j] = d;
    const a = find(i), b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  });
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = isValidPoint(lon[i], lat[i]) ? find(i) : -1;
  return finishGroups(root, nearest, km, skipped);
}

/** Every pair within km, sorted by (group of a, km, a, b). No cap (small inputs only). */
export function oraclePairs(lon: Float64Array, lat: Float64Array, km: number, opts?: PairsOptions): PairsResult {
  const rows: [number, number, number][] = [];
  walk(lon, lat, km, opts?.ids, (i, j, d) => { rows.push([i, j, d]); });
  const group = oracle(lon, lat, km, opts).group;
  rows.sort((p, q) => group[p[0]] - group[q[0]] || p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  return {
    a: Int32Array.from(rows, (r) => r[0]),
    b: Int32Array.from(rows, (r) => r[1]),
    km: Float64Array.from(rows, (r) => r[2]),
    truncated: false,
  };
}
