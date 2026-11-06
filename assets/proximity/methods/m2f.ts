// ─── Proximity dense method: 3-D hash with full cells and cell-pair skip ───
// Role: the sparse method (m2.ts) with cells of side cs/√3, so any two points in one cell are within
//       the sure chord cs: a cell joins its points at once, no pair tests, as
//       long as its points can pair among themselves (a cell whose points all
//       share one id has no internal pair, and is left for the cross-cell
//       pass; a cell with two or more different ids is joined whole, since
//       the pairs among different ids connect it). Neighbours are the cells
//       within 2 per axis (5×5×5, half shell: 62 offsets). Between two joined
//       cells, a pair of cells whose first points already share a root is skipped
//       whole, and an unjoined pair stops at the first pair within km (sure
//       chord, or a candidate the geodesic confirms), which joins both cells;
//       other cell pairs test every point pair. The nearest pass is
//       grid3's nearestGeo over the grouped points.
//         runM2f(...)   the passes over a grid of side cs/√3 (FULL_SIDE × cs)
//       Pure: no DOM, no map.
//
// Deps: ./common.js, ./grid3.js, ./m2.js, ../geodesic.js, ../types.js. Used by ../proximity.ts.

import { Dsu, type Prep } from './common.js';
import { finishSorted, type Grid, halfShell, nearestGeo } from './grid3.js';
import { sortedIds } from './m2.js';
import { geodesicKm } from '../geodesic.js';
import type { ProximityResult } from '../types.js';

const OFFSETS = halfShell(2);

export const FULL_SIDE = (1 / Math.sqrt(3)) * (1 - 1e-12);

export function runM2f(p: Prep, g: Grid, km: number): ProximityResult {
  const nv = p.vi.length, c2 = p.c2, cs2 = p.cs2;
  const { xs, ys, zs, start, cx, cy, cz, nc, table, mask, order } = g;
  const { lon, lat } = p;
  const gid = sortedIds(p, order);
  const dsu = new Dsu(nv), parent = dsu.parent, size = dsu.size;
  const joined = new Uint8Array(nc);
  for (let a = 0; a < nc; a++) {
    const s = start[a], e = start[a + 1];
    let ok = e - s === 1;
    if (!ok) {
      ok = true;
      if (gid) {
        const g0 = gid[s];
        if (g0 >= 0) { ok = false; for (let k = s + 1; k < e; k++) if (gid[k] !== g0) { ok = true; break; } }
      }
    }
    joined[a] = ok ? 1 : 0;
    if (ok) {
      for (let k = s + 1; k < e; k++) parent[k] = s;
      size[s] = e - s;
    }
  }
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const geo = (i: number, j: number): number => {
    const oi = order[i], oj = order[j];
    return oi < oj ? geodesicKm(lon[oi], lat[oi], lon[oj], lat[oj]) : geodesicKm(lon[oj], lat[oj], lon[oi], lat[oi]);
  };
  for (let a = 0; a < nc; a++) {
    const sa = start[a], ea = start[a + 1], ax = cx[a], ay = cy[a], az = cz[a];
    for (let t = 0; t < OFFSETS.length; t += 3) {
      const ix = ax + OFFSETS[t], iy = ay + OFFSETS[t + 1], iz = az + OFFSETS[t + 2];
      // shortcut: cell lookup inlined (a shared function was 40–70 % slower on small inputs); the mix must equal grid3.ts hash()
      let h = Math.imul(ix, -1640531535) + Math.imul(iy, -2048144777) + Math.imul(iz, -1028477379);
      h ^= h >>> 15; h = Math.imul(h, 739982445); h = (h ^ (h >>> 13)) & mask;
      let b = -1;
      for (;;) {
        const e = table[h];
        if (e === 0) break;
        if (cx[e - 1] === ix && cy[e - 1] === iy && cz[e - 1] === iz) { b = e - 1; break; }
        h = (h + 1) & mask;
      }
      if (b < 0) continue;
      const sb = start[b], eb = start[b + 1];
      if (joined[a] && joined[b]) {
        const ra = find(sa), rb = find(sb);
        if (ra === rb) continue;
        search: for (let i = sa; i < ea; i++) {
          const x = xs[i], y = ys[i], z = zs[i], gi = gid ? gid[i] : -1;
          for (let j = sb; j < eb; j++) {
            const dx = xs[j] - x, dy = ys[j] - y, dz = zs[j] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d > c2) continue;
            if (gi >= 0 && gid![j] === gi) continue;
            if (d <= cs2 || geo(i, j) <= km) { dsu.link(ra, rb); break search; }
          }
        }
      } else {
        for (let i = sa; i < ea; i++) {
          const x = xs[i], y = ys[i], z = zs[i], gi = gid ? gid[i] : -1;
          for (let j = sb; j < eb; j++) {
            const dx = xs[j] - x, dy = ys[j] - y, dz = zs[j] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d > c2) continue;
            if (gi >= 0 && gid![j] === gi) continue;
            const ri = find(i), rj = find(j);
            if (ri !== rj && (d <= cs2 || geo(i, j) <= km)) dsu.link(ri, rj);
          }
        }
      }
    }
  }
  const rootPos = new Int32Array(nv);
  let ng = 0;
  for (let k = 0; k < nv; k++) { rootPos[k] = find(k); if (size[rootPos[k]] >= 2) ng++; }
  const members = new Int32Array(ng);
  ng = 0;
  for (let k = 0; k < nv; k++) if (size[rootPos[k]] >= 2) members[ng++] = k;
  const nearestKm = new Float64Array(nv).fill(Infinity);
  nearestGeo(p, order, gid, g, members, members, nearestKm);
  return finishSorted(p, order, rootPos, nearestKm, km);
}
