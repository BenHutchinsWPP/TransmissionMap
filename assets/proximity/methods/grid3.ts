// ─── Proximity methods: 3-D cell hash and nearest passes ────────────────────
// Role: the structure under the sparse and dense methods and the exact nearest-partner pass.
//         buildGrid(prep, side)        integer cubic cells of `side` over the unit
//                                      vectors, found through an open-addressing
//                                      hash; points reordered by cell (counting
//                                      sort) into xs/ys/zs, `order` maps a sorted
//                                      position to its original row
//         halfShell(range)             the lexicographically positive cell offsets
//                                      within `range` cells per axis (visit each
//                                      cell pair once)
//         nearestGeo(...)              WGS84 nearest partner (geodesic km) of the given
//                                      query positions among the member positions: a grid
//                                      over the members' own extent (about 2 per cell), ring
//                                      search until every point within RHO2 × the best
//                                      squared chord has been seen, then the geodesic of
//                                      those candidates (the sphere's nearest need not be
//                                      the ellipsoid's); same-id points are not partners
//         finishSorted(...)            sorted-position results → ProximityResult
//       Pure: no DOM, no map.
//
// Deps: ./common.js, ../oracle.js, ../geodesic.js, ../types.js. Used by m2.ts, m2f.ts, ../proximity.ts.

import { RHO2, type Prep } from './common.js';
import { geodesicKm } from '../geodesic.js';
import { finishGroups } from '../oracle.js';
import type { ProximityResult } from '../types.js';

export interface Grid {
  nc: number;
  cx: Int32Array; cy: Int32Array; cz: Int32Array;
  start: Int32Array;
  table: Int32Array;
  mask: number;
  inv: number;
  order: Int32Array;
  xs: Float64Array; ys: Float64Array; zs: Float64Array;
}

const hash = (ix: number, iy: number, iz: number): number => {
  let h = Math.imul(ix, -1640531535) + Math.imul(iy, -2048144777) + Math.imul(iz, -1028477379);
  h ^= h >>> 15;
  h = Math.imul(h, 739982445);
  return h ^ (h >>> 13);
};

export function buildGrid(p: Prep, side: number): Grid {
  const nv = p.vi.length, inv = 1 / side;
  let size = 16;
  while (size < 4 * nv) size <<= 1;
  const mask = size - 1, table = new Int32Array(size);
  const cx = new Int32Array(nv), cy = new Int32Array(nv), cz = new Int32Array(nv);
  const cellOf = new Int32Array(nv), count = new Int32Array(nv + 1);
  let nc = 0;
  for (let k = 0; k < nv; k++) {
    const i = p.vi[k];
    const ix = Math.floor((p.x[i] + 1) * inv), iy = Math.floor((p.y[i] + 1) * inv), iz = Math.floor((p.z[i] + 1) * inv);
    let h = hash(ix, iy, iz) & mask, c: number;
    for (;;) {
      const t = table[h];
      if (t === 0) { c = nc++; cx[c] = ix; cy[c] = iy; cz[c] = iz; table[h] = nc; break; }
      if (cx[t - 1] === ix && cy[t - 1] === iy && cz[t - 1] === iz) { c = t - 1; break; }
      h = (h + 1) & mask;
    }
    cellOf[k] = c; count[c]++;
  }
  const start = new Int32Array(nc + 1);
  for (let c = 0; c < nc; c++) start[c + 1] = start[c] + count[c];
  const fill = start.slice(0, nc);
  const order = new Int32Array(nv);
  for (let k = 0; k < nv; k++) order[fill[cellOf[k]]++] = p.vi[k];
  const xs = new Float64Array(nv), ys = new Float64Array(nv), zs = new Float64Array(nv);
  for (let k = 0; k < nv; k++) { const i = order[k]; xs[k] = p.x[i]; ys[k] = p.y[i]; zs[k] = p.z[i]; }
  return { nc, cx, cy, cz, start, table, mask, inv, order, xs, ys, zs };
}

export function halfShell(range: number): Int32Array {
  const out: number[] = [];
  for (let dx = -range; dx <= range; dx++) for (let dy = -range; dy <= range; dy++) for (let dz = -range; dz <= range; dz++) {
    if (dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz > 0)))) out.push(dx, dy, dz);
  }
  return Int32Array.from(out);
}

/**
 * Ellipsoid nearest partner (km) of each position in `queries`, among `members` (sorted positions),
 * into out[position]. Infinity when a query has no partner.
 */
export function nearestGeo(p: Prep, ord: Int32Array, gid: Int32Array | null, g: Grid, members: Int32Array, queries: Int32Array, out: Float64Array): void {
  const { xs, ys, zs } = g;
  const m = members.length;
  if (m === 0 || queries.length === 0) return;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let q = 0; q < m; q++) {
    const k = members[q], a = xs[k], b = ys[k], c = zs[k];
    if (a < x0) x0 = a; if (a > x1) x1 = a;
    if (b < y0) y0 = b; if (b > y1) y1 = b;
    if (c < z0) z0 = c; if (c > z1) z1 = c;
  }
  const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
  const big = Math.max(ex, ey, ez), small = Math.min(ex, ey, ez), mid = ex + ey + ez - big - small;
  let s = Math.max(Math.sqrt((2 * big * mid) / m), (2 * big) / m);
  if (!(s > 0)) s = 1;
  const cap = 16 * m + 4096;
  let nx: number, ny: number, nz: number;
  for (;;) {
    nx = Math.floor(ex / s) + 1; ny = Math.floor(ey / s) + 1; nz = Math.floor(ez / s) + 1;
    if (nx * ny * nz <= cap) break;
    s *= 1.25;
  }
  const inv = 1 / s;
  const cellOf = (px: number, py: number, pz: number): number =>
    (Math.min(nx - 1, Math.floor((px - x0) * inv)) * ny + Math.min(ny - 1, Math.floor((py - y0) * inv))) * nz + Math.min(nz - 1, Math.floor((pz - z0) * inv));
  const cellIdx = new Int32Array(m);
  const start = new Int32Array(nx * ny * nz + 1);
  for (let q = 0; q < m; q++) {
    const k = members[q], c = cellOf(xs[k], ys[k], zs[k]);
    cellIdx[q] = c; start[c + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny * nz);
  const gx = new Float64Array(m), gy = new Float64Array(m), gz = new Float64Array(m), who = new Int32Array(m);
  for (let q = 0; q < m; q++) {
    const t = fill[cellIdx[q]]++, k = members[q];
    gx[t] = xs[k]; gy[t] = ys[k]; gz[t] = zs[k]; who[t] = k;
  }
  const maxK = Math.max(nx, ny, nz);
  const bufD: number[] = [], bufW: number[] = [];
  const { lon, lat } = p;
  for (let qi = 0; qi < queries.length; qi++) {
    const k0 = queries[qi], px = xs[k0], py = ys[k0], pz = zs[k0], gk = gid ? gid[k0] : -1;
    const ix = Math.min(nx - 1, Math.floor((px - x0) * inv)), iy = Math.min(ny - 1, Math.floor((py - y0) * inv)), iz = Math.min(nz - 1, Math.floor((pz - z0) * inv));
    let best = Infinity;
    bufD.length = 0; bufW.length = 0;
    for (let k = 0; k <= maxK; k++) {
      const lx = Math.max(0, ix - k), hx = Math.min(nx - 1, ix + k);
      const ly = Math.max(0, iy - k), hy = Math.min(ny - 1, iy + k);
      const lz = Math.max(0, iz - k), hz = Math.min(nz - 1, iz + k);
      for (let jx = lx; jx <= hx; jx++) {
        const xEdge = jx === ix - k || jx === ix + k;
        for (let jy = ly; jy <= hy; jy++) {
          const full = xEdge || jy === iy - k || jy === iy + k;
          const base = (jx * ny + jy) * nz;
          for (let jz = lz; jz <= hz; jz++) {
            if (!full && jz !== iz - k && jz !== iz + k) { jz = iz + k - 1; continue; }
            const c = base + jz;
            for (let t = start[c]; t < start[c + 1]; t++) {
              const w = who[t];
              if (w === k0) continue;
              const dx = gx[t] - px, dy = gy[t] - py, dz = gz[t] - pz;
              const d = dx * dx + dy * dy + dz * dz;
              if (d > RHO2 * best) continue;
              if (gk >= 0 && gid![w] === gk) continue;
              if (d < best) best = d;
              bufD.push(d); bufW.push(w);
            }
          }
        }
      }
      const reach = k * s;
      if (RHO2 * best <= reach * reach) break;
    }
    let e = Infinity;
    const lim = RHO2 * best, oi = ord[k0];
    for (let r = 0; r < bufD.length; r++) {
      if (bufD[r] > lim) continue;
      const oj = ord[bufW[r]];
      const d = oi < oj ? geodesicKm(lon[oi], lat[oi], lon[oj], lat[oj]) : geodesicKm(lon[oj], lat[oj], lon[oi], lat[oi]);
      if (d < e) e = d;
    }
    out[k0] = e;
  }
}

/** Sorted-position roots and ellipsoid nearest km (Infinity: none) → result in original row order. */
export function finishSorted(p: Prep, order: Int32Array, rootPos: Int32Array, nearestKm: Float64Array, km: number): ProximityResult {
  const root = new Int32Array(p.n).fill(-1);
  const nearest = new Float64Array(p.n).fill(Infinity);
  for (let k = 0; k < order.length; k++) {
    root[order[k]] = rootPos[k];
    nearest[order[k]] = nearestKm[k];
  }
  return finishGroups(root, nearest, km, p.skipped);
}
