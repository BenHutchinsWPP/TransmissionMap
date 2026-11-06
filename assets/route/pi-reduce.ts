// ─── PI reduction (whole-route budget) ─────────────────
// Role: thins a solve() cell path to its points of intersection (PIs): few path
//       cells whose straight segments (a) touch no blocked
//       cell and (b) cost, summed over the whole line, at most (1 + delta) × the
//       raw path's cost.
//       The tolerance is one budget for the route, not a per-segment ratio: a
//       segment may cost more than the raw cells it replaces when others cost
//       less. The routing weight changes every few path cells,
//       so a per-segment ratio would end a segment every few cells; one budget
//       lets the line run straight across that texture.
//       Method: candidate segments i → j (j a later path cell) that are not
//       blocked and cost no more than δ × (whole raw cost) above the raw cells
//       i..j. Work per i is bounded: j runs i + 2 … i + DENSE one by one, then in
//       strides of (j − i) / STRIDE_DIV, never past i + MAX_SPAN (512 cells,
//       128 km at 250 m), and stops PATIENCE path cells past the last candidate
//       found; a segment's traversal stops as soon as it is blocked or over its
//       allowance. Work is O(n · MAX_SPAN).
//       Candidates sit in flat typed arrays, grouped by i. The line is then a
//       shortest path over the candidates with a price λ per segment (Lagrangian
//       relaxation of "fewest segments within budget"); λ is bisected to the
//       largest value whose line stays within the budget. λ = 0 is the cheapest
//       candidate line, never above raw (every adjacent raw step is a candidate),
//       so a line within budget always exists. First and last cells are always
//       kept.
//       Blocked = dijkstra's definition: barrier = 1, mask = 0, or cost not
//       finite and > 0; the start/goal cells and their 16 move neighbours
//       (dijkstra's MOVE_DR/MOVE_DC, the solver's own guard) ignore `barrier`,
//       so a path starting inside a barrier region still reduces.
//       Raw step costs follow dijkstra's r.cost convention (orthogonal and
//       diagonal: mean of the two end cells; knight: mean of end + straddled
//       cells). A segment's cost is the exact line integral of the per-metre
//       cost: dijkstra's traverse() gives every cell the segment passes through
//       with its intersected length, and each is charged cost × metres. The
//       same cells give the blocked test; at an exact corner pass the two cells
//       the line squeezes between are tested too (length 0, no cost), so a
//       1-cell-thick diagonal wall is never crossed. An adjacent raw step is
//       charged its raw cost, which is also its straight line's exact integral
//       (for the 16 moves the r.cost averages are that integral).
//       Pure: no DOM, runs in a worker and in Node.
// Deps: dijkstra.ts (rowCol, traverse, MOVE_DR/MOVE_DC).

import { MOVE_DC, MOVE_DR, rowCol, traverse } from './dijkstra.js';

export interface ReduceInput {
  width: number;
  height: number;
  cost: Float32Array;
  barrier?: Uint8Array;
  mask?: Uint8Array;
  cellM: number;
  path: number[];   // cell indices from solve()
  delta?: number;   // default 0.005
}

export interface ReduceResult {
  pis: number[];    // subset of path, first and last kept
  cost: number;     // total cost of the PI polyline
  rawCost: number;
}

const PATIENCE = 64;
const DENSE = 32;
const STRIDE_DIV = 8;
const MAX_SPAN = 512;
const BISECTIONS = 40;

export function reducePath(input: ReduceInput): ReduceResult {
  const { width: W, height: H, cost, barrier, mask, cellM, path } = input;
  const delta = input.delta ?? 0.005;
  const n = path.length;
  if (n === 0) return { pis: [], cost: 0, rawCost: 0 };

  const blocked = new Uint8Array(W * H);
  const passable = (i: number): boolean => cost[i] > 0 && cost[i] < Infinity && (!mask || mask[i] === 1);
  for (let i = 0; i < blocked.length; i++) blocked[i] = !passable(i) || (barrier && barrier[i] === 1) ? 1 : 0;
  if (barrier) {
    for (const e of [path[0], path[n - 1]]) {
      const [r, c] = rowCol(e, W);
      if (passable(e)) blocked[e] = 0;
      for (let k = 0; k < 16; k++) {
        const rr = r + MOVE_DR[k], cc = c + MOVE_DC[k];
        if (rr >= 0 && rr < H && cc >= 0 && cc < W && passable(rr * W + cc)) blocked[rr * W + cc] = 0;
      }
    }
  }

  // Raw step cost, dijkstra's convention.
  const step = (u: number, v: number): number => {
    const [ur, uc] = rowCol(u, W), [vr, vc] = rowCol(v, W);
    const dr = vr - ur, dc = vc - uc, ar = Math.abs(dr), ac = Math.abs(dc);
    if (ar + ac === 1) return (cost[u] + cost[v]) / 2 * cellM;
    if (ar === 1 && ac === 1) return (cost[u] + cost[v]) / 2 * cellM * Math.SQRT2;
    const a = ar === 2 ? u + (dr >> 1) * W : u + (dc >> 1);
    const b = ar === 2 ? a + dc : a + dr * W;
    return (cost[u] + cost[a] + cost[b] + cost[v]) / 4 * cellM * Math.sqrt(5);
  };
  const prefix = new Float64Array(n);
  for (let k = 1; k < n; k++) prefix[k] = prefix[k - 1] + step(path[k - 1], path[k]);

  // Straight segment cost (centre to centre); Infinity when it touches a blocked
  // cell or (early out) once the running total passes `max`.
  const segment = (u: number, v: number, max: number): number => {
    const [r0, c0] = rowCol(u, W), [r1, c1] = rowCol(v, W);
    let total = 0;
    traverse(c0 + 0.5, r0 + 0.5, c1 + 0.5, r1 + 0.5, (c, r, len) => {
      const cell = r * W + c;
      if (blocked[cell]) { total = Infinity; return false; }
      total += cost[cell] * len * cellM;
      if (total > max) { total = Infinity; return false; }
    });
    return total;
  };

  // Candidate segments out of each path index i, flat: to[k], segCost[k] for k in
  // [off[i], off[i + 1]). j runs i + 2 … i + DENSE one by one, then in strides of
  // (j − i) / STRIDE_DIV up to MAX_SPAN cells, and stops PATIENCE cells past the
  // last candidate.
  const rawCost = prefix[n - 1], slack = delta * rawCost, budget = (1 + delta) * rawCost;
  const off = new Int32Array(n + 1);
  let to = new Int32Array(n * 16), segCost = new Float64Array(n * 16), m = 0;
  const add = (j: number, c: number): void => {
    if (m === to.length) {
      const t2 = new Int32Array(m * 2); t2.set(to); to = t2;
      const s2 = new Float64Array(m * 2); s2.set(segCost); segCost = s2;
    }
    to[m] = j; segCost[m++] = c;
  };
  for (let i = 0; i < n - 1; i++) {
    off[i] = m;
    add(i + 1, prefix[i + 1] - prefix[i]);
    const end = Math.min(n - 1, i + MAX_SPAN);
    for (let j = i + 2, last = i + 1; j <= end && j - last <= PATIENCE; j += j - i < DENSE ? 1 : Math.ceil((j - i) / STRIDE_DIV)) {
      const raw = prefix[j] - prefix[i], sc = segment(path[i], path[j], raw + slack);
      if (sc < Infinity) { add(j, sc); last = j; }
    }
  }
  off[n - 1] = off[n] = m;

  // Shortest path over the candidates (all point forward, so one pass in index
  // order), each segment priced λ extra.
  const d = new Float64Array(n), cst = new Float64Array(n), par = new Int32Array(n);
  const line = (lambda: number): { pis: number[]; cost: number } => {
    d.fill(Infinity); d[0] = 0; cst[0] = 0; par[0] = -1;
    for (let i = 0; i < n - 1; i++) {
      const di = d[i], ci = cst[i];
      for (let k = off[i], e = off[i + 1]; k < e; k++) {
        const j = to[k], v = di + segCost[k] + lambda;
        if (v < d[j]) { d[j] = v; cst[j] = ci + segCost[k]; par[j] = i; }
      }
    }
    const pis: number[] = [];
    for (let j = n - 1; j !== -1; j = par[j]) pis.push(path[j]);
    return { pis: pis.reverse(), cost: cst[n - 1] };
  };
  let best = line(0), lo = 0, hi = rawCost;
  for (let it = 0; it < BISECTIONS && n > 2; it++) {
    const mid = (lo + hi) / 2, r = line(mid);
    if (r.cost <= budget) { lo = mid; if (r.pis.length <= best.pis.length) best = r; } else hi = mid;
  }
  return { pis: best.pis, cost: best.cost, rawCost };
}
