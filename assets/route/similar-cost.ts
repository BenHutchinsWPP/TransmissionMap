// ─── Similar-cost areas and Alternatives ──────────────────────────────────────
// Role: pure post-processing of a route solve, no I/O, runs in a worker and in Node.
//       classify(): the similar-cost areas. c(x) = dA(x) + dB(x) is the least cost of a
//         route A → B forced through x (the r.cost move costs are symmetric and charge
//         each cell inside its edges, so the sum counts nothing twice). Class k (1..4)
//         when (c − C − 1e-9·C)/C ≤ bands[k−1] (the tolerance absorbs float summation-
//         order noise, so every optimal-path cell is class 1), else 0; unreachable and
//         blocked cells are 0, and every cell is 0 when C is not a finite number > 0.
//         dA must be exact up to (1 + max band)·C — solve(input, {extend: max band})
//         — and dB likewise — distances(…, limit ≥ (1 + max band)·C); read dA before a
//         later distances() call reuses the solve's scratch, which overwrites it.
//       penaltyAlternatives(): Alternatives by penalty re-weighting. A copy of the
//         route weights (+4 B/cell, PENALTY_BYTES_PER_CELL) is multiplied by (1 + p) within
//         radiusCells (Chebyshev) of the optimum and of every path found since, and
//         re-solved through `solveFn`. Each path is re-costed on the original weights
//         with the solver's exact edge formula (pathCost) and accepted when its stretch
//         c/C − 1 ≤ stretchMax, its share with the optimum and with every accepted
//         alternative ≤ shareMax (shareWithin at shareRadiusCells), it revisits no
//         cell, and it does not come back within 2 cells of its own earlier part outside
//         a ±8-step window (selfTouches: spurs, U-turns). Stops at k accepted, after
//         maxAttempts re-solves (default 2k), or when a re-solve fails. The original
//         weights are never written. Every re-solve runs in one dist/state/parent set
//         (SOLVE_BYTES_PER_CELL): the caller's `scratch` + `parent` when given — e.g. a
//         finished distances() call's buffers, whose contents are then overwritten — else
//         one set allocated on the first attempt. Aliasing: each re-solve overwrites the
//         previous one's dist and tree; only `path` survives, which is all that is kept.
//         There is no candidate list; `bytes` = the weight copy + any buffers allocated here.
//       shareWithin(): fraction of a path's length whose steps have both ends within
//         radius cells of a reference path.
// Deps: dijkstra.ts (solve, MOVE_DR/MOVE_DC, GridInput/Scratch/SolveResult types).

import { MOVE_DC, MOVE_DR, solve, type GridInput, type Scratch, type SolveResult } from './dijkstra.js';

export const DEFAULT_BANDS: readonly number[] = [0.02, 0.05, 0.10, 0.20];
/** Extra bytes per grid cell while penaltyAlternatives runs (the Float32 weight copy). */
export const PENALTY_BYTES_PER_CELL = 4;
/** Bytes per grid cell of one re-solve buffer set (Float64 dist + Uint8 state + Int32 parent). */
export const SOLVE_BYTES_PER_CELL = 13;

/** The buffers a re-solve runs in; a solveFn may ignore them. */
export interface SolveBuffers { scratch: Scratch; parent: Int32Array }

/** Class 0..4 per cell: k when (dA + dB − C − 1e-9·C)/C ≤ bands[k−1]; 0 when beyond, unreachable, or C ≤ 0. */
export function classify(dA: Float64Array, dB: Float64Array, C: number, bands: readonly number[] = DEFAULT_BANDS): Uint8Array {
  if (dA.length !== dB.length) throw new Error('dA and dB differ in length');
  const out = new Uint8Array(dA.length);
  if (!(C > 0 && C < Infinity)) return out;
  const tol = 1e-9 * C;
  for (let i = 0; i < out.length; i++) {
    const c = dA[i] + dB[i];
    if (!(c < Infinity)) continue;
    const r = (c - C - tol) / C;
    for (let k = 0; k < bands.length; k++) {
      if (r <= bands[k]) { out[i] = k + 1; break; }
    }
  }
  return out;
}

/** Cells within `radius` (Chebyshev) of any cell of `path` on a grid `cols` wide. */
function nearSet(path: readonly number[], radius: number, cols: number): Set<number> {
  const s = new Set<number>();
  for (const x of path) {
    const r = Math.floor(x / cols), c = x - r * cols;
    for (let dr = -radius; dr <= radius; dr++) {
      if (r + dr < 0) continue;
      for (let dc = -radius; dc <= radius; dc++) {
        const cc = c + dc;
        if (cc >= 0 && cc < cols) s.add((r + dr) * cols + cc);
      }
    }
  }
  return s;
}

function stepLen(u: number, v: number, cols: number): number {
  const ru = Math.floor(u / cols), rv = Math.floor(v / cols);
  return Math.hypot(rv - ru, (v - rv * cols) - (u - ru * cols));
}

function shareIn(path: readonly number[], near: Set<number>, cols: number): number {
  let s = 0, tot = 0;
  for (let i = 1; i < path.length; i++) {
    const l = stepLen(path[i - 1], path[i], cols);
    tot += l;
    if (near.has(path[i - 1]) && near.has(path[i])) s += l;
  }
  return tot > 0 ? s / tot : 1;
}

/** Fraction of `path`'s length (steps with both ends within `radiusCells` of `ref`). */
export function shareWithin(path: readonly number[], ref: readonly number[], radiusCells: number, cols: number): number {
  return shareIn(path, nearSet(ref, radiusCells, cols), cols);
}

/** True when the path revisits a cell, or a cell comes within `radius` cells of a cell
 *  more than `window` steps earlier. */
export function selfTouches(path: readonly number[], cols: number, radius = 2, window = 8): boolean {
  const first = new Map<number, number>();
  for (let i = 0; i < path.length; i++) {
    const x = path[i];
    if (first.has(x)) return true;
    const r = Math.floor(x / cols), c = x - r * cols;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= cols) continue;
        const j = first.get((r + dr) * cols + cc);
        if (j !== undefined && j < i - window) return true;
      }
    }
    first.set(x, i);
  }
  return false;
}

/** Cost of a cell path on `cost`, with dijkstra.ts's move formula and summation order
 *  (so the optimum re-costs to its solve's cost exactly). NaN if a step is not one of
 *  the 16 moves. */
export function pathCost(path: readonly number[], cost: Float32Array, width: number, cellM: number): number {
  const fac = [0.5, Math.SQRT2 / 2, Math.sqrt(5) / 4].map((f) => f * cellM);
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const u = path[i - 1], v = path[i];
    const ur = Math.floor(u / width), vr = Math.floor(v / width);
    const dr = vr - ur, dc = (v - vr * width) - (u - ur * width);
    let k = -1;
    for (let m = 0; m < 16; m++) if (MOVE_DR[m] === dr && MOVE_DC[m] === dc) { k = m; break; }
    if (k < 0) return NaN;
    if (k < 8) {
      d += (cost[u] + cost[v]) * fac[k < 4 ? 0 : 1];
    } else {
      let a: number, b: number;
      if (dr === 2 || dr === -2) { a = u + (dr >> 1) * width; b = a + dc; } else { a = u + (dc >> 1); b = a + dr * width; }
      d += (cost[u] + cost[a] + cost[b] + cost[v]) * fac[2];
    }
  }
  return d;
}

export interface Alternative {
  path: number[];
  cost: number;      // routing cost on the original weights
  stretch: number;   // cost / C − 1
  share: number;     // largest share with the optimum or an earlier accepted alternative
  attempt: number;   // 1-based re-solve that found it
  ms: number;        // time of that re-solve
}

export interface AlternativesResult {
  alts: Alternative[];
  attempts: number;
  rejected: { stretch: number; share: number; selfTouch: number };
  stopped: 'found' | 'attempts' | string;   // otherwise the failed re-solve's error
  bytes: number;     // weight copy, PENALTY_BYTES_PER_CELL × cells
  ms: number;
}

export interface PenaltyOptions {
  input: GridInput;                 // input.cost = the original route weights, never written
  optimum: { path: number[]; cost: number };
  k: number;
  solveFn?: (input: GridInput, bufs: SolveBuffers) => SolveResult;
  scratch?: Scratch;                // W×H re-solve buffers to reuse (overwritten); else allocated once
  parent?: Int32Array;
  p?: number;
  radiusCells?: number;
  stretchMax?: number;
  shareMax?: number;
  shareRadiusCells?: number;
  maxAttempts?: number;             // default 2k
}

export function penaltyAlternatives(o: PenaltyOptions): AlternativesResult {
  const t0 = performance.now();
  const { input, optimum, k } = o;
  const solveFn = o.solveFn ?? ((g: GridInput, b: SolveBuffers) => solve(g, b));
  const p = o.p ?? 0.5, radius = o.radiusCells ?? 8, stretchMax = o.stretchMax ?? 0.2;
  const shareMax = o.shareMax ?? 0.5, shareR = o.shareRadiusCells ?? 2, maxAttempts = o.maxAttempts ?? 2 * k;
  const W = input.width, C = optimum.cost;
  const wts = input.cost.slice(), n = wts.length;
  let bufs: SolveBuffers | null = null, allocated = 0;
  const buffers = (): SolveBuffers => {
    if (bufs) return bufs;
    const sc = o.scratch && o.scratch.dist.length === n && o.scratch.state.length === n ? o.scratch : null;
    const pa = o.parent && o.parent.length === n ? o.parent : null;
    if (!sc) allocated += 9 * n;
    if (!pa) allocated += 4 * n;
    return (bufs = { scratch: sc ?? { dist: new Float64Array(n), state: new Uint8Array(n) }, parent: pa ?? new Int32Array(n) });
  };
  const penalise = (path: number[]): void => { for (const j of nearSet(path, radius, W)) wts[j] *= 1 + p; };
  const refs = [nearSet(optimum.path, shareR, W)];
  const alts: Alternative[] = [];
  const rejected = { stretch: 0, share: 0, selfTouch: 0 };
  let attempts = 0, stopped = 'attempts';
  penalise(optimum.path);
  while (alts.length < k && attempts < maxAttempts) {
    attempts++;
    const t1 = performance.now();
    const res = solveFn({ ...input, cost: wts }, buffers());
    const ms = performance.now() - t1;
    if (!res.ok) { stopped = res.error; break; }
    const path = res.path;
    penalise(path);
    const cost = pathCost(path, input.cost, W, input.cellM), stretch = cost / C - 1;
    if (!(stretch <= stretchMax)) { rejected.stretch++; continue; }
    const share = Math.max(...refs.map((m) => shareIn(path, m, W)));
    if (share > shareMax) { rejected.share++; continue; }
    if (selfTouches(path, W)) { rejected.selfTouch++; continue; }
    alts.push({ path, cost, stretch, share, attempt: attempts, ms });
    refs.push(nearSet(path, shareR, W));
  }
  if (alts.length >= k) stopped = 'found';
  return { alts, attempts, rejected, stopped, bytes: PENALTY_BYTES_PER_CELL * n + allocated, ms: performance.now() - t0 };
}
