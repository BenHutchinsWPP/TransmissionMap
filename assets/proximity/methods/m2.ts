// ─── Proximity sparse method: unit-vector 3-D hash, nearest fused ───────────
// Role: points → unit vectors; cubic cells of side c (the candidate chord) found
//       through a hash (probed inline); each cell against itself and its 13
//       half-shell neighbours, squared Euclidean distance against c² (no trig in
//       the inner loop). A pair within cs is joined at once (sure on the
//       ellipsoid); one between cs and c is joined only when the WGS84 geodesic
//       says ≤ km, and only when its points are not already joined. Equal ids
//       never pair. Union-find with path halving and union by size.
//       nearestKm is fused into the same loop (a grouped point's partner lies
//       within c, so inside the neighbour cells): each candidate pair updates both
//       points' smallest and second-smallest squared chord and the smallest's
//       partner. A point whose second is beyond RHO2 × its smallest has its
//       ellipsoid nearest in that one partner (one geodesic); the others go to
//       grid3's nearestGeo, which weighs every candidate.
//         runM2(prep, grid, km)   union and nearest passes over a grid of side c
//       Pure: no DOM, no map.
//
// Deps: ./common.js, ./grid3.js, ../geodesic.js, ../types.js. Used by m2f.ts and ../proximity.ts.

import { Dsu, RHO2, type Prep } from './common.js';
import { finishSorted, type Grid, halfShell, nearestGeo } from './grid3.js';
import { geodesicKm } from '../geodesic.js';
import type { ProximityResult } from '../types.js';

const OFFSETS = halfShell(1);

/** Group ids by sorted position, or null. */
export function sortedIds(p: Prep, order: Int32Array): Int32Array | null {
  if (!p.ids) return null;
  const gid = new Int32Array(order.length);
  for (let k = 0; k < order.length; k++) gid[k] = p.ids[order[k]];
  return gid;
}

export function runM2(p: Prep, g: Grid, km: number): ProximityResult {
  const nv = p.vi.length, c2 = p.c2, cs2 = p.cs2;
  const { xs, ys, zs, start, cx, cy, cz, nc, table, mask, order } = g;
  const { lon, lat } = p;
  const gid = sortedIds(p, order);
  const dsu = new Dsu(nv), parent = dsu.parent;
  const n1 = new Float64Array(nv).fill(Infinity), n2 = new Float64Array(nv).fill(Infinity);
  const a1 = new Int32Array(nv);
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
    // cell a against itself (j after i), then against each existing half-shell neighbour
    for (let t = -3; t < OFFSETS.length; t += 3) {
      let sb: number, eb: number, same: boolean;
      if (t < 0) { sb = sa; eb = ea; same = true; }
      else {
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
        sb = start[b]; eb = start[b + 1]; same = false;
      }
      for (let i = sa; i < ea; i++) {
        const x = xs[i], y = ys[i], z = zs[i], gi = gid ? gid[i] : -1;
        let ri = find(i), b1 = n1[i], b2 = n2[i], ba = a1[i];
        for (let j = same ? i + 1 : sb; j < eb; j++) {
          const dx = xs[j] - x, dy = ys[j] - y, dz = zs[j] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d > c2) continue;
          if (gi >= 0 && gid![j] === gi) continue;
          if (d < b1) { b2 = b1; b1 = d; ba = j; } else if (d < b2) b2 = d;
          if (d < n1[j]) { n2[j] = n1[j]; n1[j] = d; a1[j] = i; } else if (d < n2[j]) n2[j] = d;
          const rj = find(j);
          if (rj !== ri && (d <= cs2 || geo(i, j) <= km)) ri = dsu.link(ri, rj);
        }
        n1[i] = b1; n2[i] = b2; a1[i] = ba;
      }
    }
  }
  const rootPos = new Int32Array(nv);
  let ng = 0;
  for (let k = 0; k < nv; k++) { rootPos[k] = find(k); if (dsu.size[rootPos[k]] >= 2) ng++; }
  const members = new Int32Array(ng), queries = new Int32Array(ng);
  const nearestKm = new Float64Array(nv).fill(Infinity);
  let nq = 0;
  ng = 0;
  for (let k = 0; k < nv; k++) {
    if (dsu.size[rootPos[k]] < 2) continue;
    members[ng++] = k;
    if (n2[k] > RHO2 * n1[k]) {
      if (nearestKm[k] !== Infinity) continue;
      const j = a1[k], e = geo(k, j);
      nearestKm[k] = e;
      if (j > k && a1[j] === k && n2[j] > RHO2 * n1[j]) nearestKm[j] = e; // mutual nearest: one geodesic
    } else queries[nq++] = k;
  }
  nearestGeo(p, order, gid, g, members, queries.subarray(0, nq), nearestKm);
  return finishSorted(p, order, rootPos, nearestKm, km);
}
