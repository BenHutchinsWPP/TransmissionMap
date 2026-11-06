// ─── Proximity: the production entry ────────────────────────────────────────
// Role: the one module the UI imports.
//         proximityGroups(lon, lat, km, opts?)  m5: the connected components of "within km"
//                                               (WGS84 geodesic) with sizes and nearestKm; see types.ts
//         proximityPairs(lon, lat, km, opts?)   every pair within km as rows a < b with the geodesic
//                                               km, sorted by (group of a, km, a, b); groups are m5's
//                                               numbering. Equal ids (opts.ids) never pair. Enumeration
//                                               walks the cell grid of side c (the candidate chord) with
//                                               the half-shell of 13 neighbour cells and stops the moment
//                                               it has found more than opts.max (default MAX_PAIRS) pairs:
//                                               time and memory stay O(n + max), never O(all pairs).
//                                               Then truncated is true and the list is the pairs found
//                                               first in cell order, sorted: not the global top-N and not
//                                               the nearest pairs. opts.onProgress(found) is called about
//                                               every 50,000 pairs found.
//         makeM5(dense), DENSE                  the grouping method and its switch (tests and benchmarks)
//       m5 builds the cell grid of side c, measures how crowded a point's own cell is (Σ count² / n);
//       at or below `dense` it runs the sparse method (methods/m2.ts: fused nearest, 14 lookups per
//       cell) on that grid, above it rebuilds with cells of side cs/√3 and runs the dense method
//       (methods/m2f.ts: full cells, cell-pair skip, own nearest pass). Both are exact (sure chord cs,
//       candidate chord c, geodesic in between), so the switch changes speed only.
//       proximityPairs prepares the input and the side-c grid once and groups on them (groupsOn).
//       Pure: no DOM, no map. Run off the main thread by pairs-worker.ts.
//
// Deps: ./geodesic.js, ./methods/*, ./types.js. Used by ui/ui-proximity.ts, pairs-worker.ts, methods.ts, the tests and benchmarks.

import { geodesicKm } from './geodesic.js';
import { prepare, type Prep } from './methods/common.js';
import { buildGrid, halfShell, type Grid } from './methods/grid3.js';
import { runM2 } from './methods/m2.js';
import { FULL_SIDE, runM2f } from './methods/m2f.js';
import type { PairsOptions, PairsResult, ProximityMethod, ProximityResult } from './types.js';

export type { PairsOptions, PairsResult, ProximityMethod, ProximityOptions, ProximityResult } from './types.js';

export const DENSE = 16;

/** dense = the switch: Infinity always takes the sparse method, -1 the dense one (an empty set has no cells and takes the sparse one). */
export function makeM5(dense = DENSE): ProximityMethod {
  return (lon, lat, km, opts) => {
    const p = prepare(lon, lat, km, opts?.ids);
    return groupsOn(p, buildGrid(p, p.c), km, dense);
  };
}

function groupsOn(p: Prep, g: Grid, km: number, dense: number): ProximityResult {
  let sq = 0; for (let a = 0; a < g.nc; a++) { const k = g.start[a + 1] - g.start[a]; sq += k * k; }
  if (!(sq > dense * p.vi.length)) return runM2(p, g, km);
  return runM2f(p, buildGrid(p, p.cs * FULL_SIDE), km);
}

export const m5 = makeM5();

export const proximityGroups: ProximityMethod = m5;

const OFFSETS = halfShell(1);
export const MAX_PAIRS = 1_000_000;
const PROGRESS_EVERY = 50_000;

export function proximityPairs(lon: Float64Array, lat: Float64Array, km: number, opts?: PairsOptions): PairsResult {
  const max = opts?.max ?? MAX_PAIRS, onProgress = opts?.onProgress;
  let nextReport = PROGRESS_EVERY;
  if (!(max >= 0) || !Number.isInteger(max)) throw new RangeError('max must be a non-negative integer');
  const p = prepare(lon, lat, km, opts?.ids);
  const g = buildGrid(p, p.c);
  const group = groupsOn(p, g, km, DENSE).group;
  const { xs, ys, zs, start, cx, cy, cz, nc, table, mask, order } = g;
  const ids = p.ids, c2 = p.c2;
  let cap = Math.min(max, 1024), n = 0, truncated = false;
  let pa = new Int32Array(cap), pb = new Int32Array(cap), pk = new Float64Array(cap);
  scan: for (let a = 0; a < nc; a++) {
    const sa = start[a], ea = start[a + 1], ax = cx[a], ay = cy[a], az = cz[a];
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
        const x = xs[i], y = ys[i], z = zs[i], oi = order[i], gi = ids ? ids[oi] : -1;
        for (let j = same ? i + 1 : sb; j < eb; j++) {
          const dx = xs[j] - x, dy = ys[j] - y, dz = zs[j] - z;
          if (dx * dx + dy * dy + dz * dz > c2) continue;
          const oj = order[j];
          if (gi >= 0 && ids![oj] === gi) continue;
          const lo = oi < oj ? oi : oj, hi = oi < oj ? oj : oi;
          const d = geodesicKm(lon[lo], lat[lo], lon[hi], lat[hi]);
          if (!(d <= km)) continue;
          if (n === max) { truncated = true; break scan; }
          if (n === cap) {
            cap = Math.min(max, cap * 2);
            const na = new Int32Array(cap), nb = new Int32Array(cap), nk = new Float64Array(cap);
            na.set(pa); nb.set(pb); nk.set(pk);
            pa = na; pb = nb; pk = nk;
          }
          pa[n] = lo; pb[n] = hi; pk[n] = d; n++;
          if (n >= nextReport) { nextReport = n + PROGRESS_EVERY; onProgress?.(n); }
        }
      }
    }
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((u, v) => group[pa[u]] - group[pa[v]] || pk[u] - pk[v] || pa[u] - pa[v] || pb[u] - pb[v]);
  const a = new Int32Array(n), b = new Int32Array(n), kmOut = new Float64Array(n);
  for (let i = 0; i < n; i++) { const r = idx[i]; a[i] = pa[r]; b[i] = pb[r]; kmOut[i] = pk[r]; }
  return { a, b, km: kmOut, truncated };
}
