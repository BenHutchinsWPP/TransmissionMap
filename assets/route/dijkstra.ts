// ─── Least-cost grid solver ───────────────────────────────────────────────────
// Role: plain Dijkstra (no A*) over a W×H per-metre cost grid with 16 moves,
//       costed by the GRASS r.cost convention (raster/r.cost/main.c):
//         orthogonal (c_u + c_v)/2 × d
//         diagonal   (c_u + c_v)/2 × d√2
//         knight     (c_u + c_a + c_b + c_v)/4 × d√5
//       where a, b are the two cells the knight move straddles — for a move of
//       (dr, dc) with |dr| = 2: (r + dr/2, c) and (r + dr/2, c + dc); with
//       |dc| = 2: (r, c + dc/2) and (r + dr, c + dc/2). (r.cost's NNW move
//       sums N + NW + NNW + self; WNW sums W + NW + WNW + self.)
//       A cell is blocked when its cost is not finite and > 0, mask = 0, or
//       barrier = 1; a blocked cell is never pushed, and no arithmetic touches
//       an infinite cost. A diagonal move is skipped when either orthogonally
//       adjacent cell it passes is blocked, a knight move when either straddled
//       cell is; so a 1-cell-thick barrier line never leaks.
//       Endpoint guard: the start and goal cells and their 16 neighbours ignore
//       `barrier` (cost and mask still apply), so an endpoint sitting just
//       inside a barrier region still solves.
//       Lazy-deletion binary heap on typed arrays; stops when the goal pops.
//       The ok result carries `dist` (exact for every settled cell, i.e. every
//       cell with dist < cost) for route.ts's optimality bound.
//       solve(input, {extend: ε}) with ε > 0 keeps settling after the goal pops
//       until the next key exceeds (1+ε)·cost, so `dist` is exact for every cell
//       ≤ (1+ε)·cost (the similar-cost surface's forward distances); the path
//       and cost are unchanged (a settled cell's parent never changes). ε = 0 (default)
//       omitted stops at the goal exactly as before; never read `dist` past
//       (1+ε)·cost.
//       Buffer reuse: solve(input, {scratch, parent}) searches in a caller's
//       dist/state (a Scratch of W×H) and parent (Int32Array of W×H) instead of
//       allocating 13 B/cell. Aliasing: the result's `dist` IS scratch.dist, so a
//       later solve or distances() given the same scratch overwrites every earlier
//       result's `dist` (and the same parent array its tree); copy what must
//       survive. The path is traced before returning, so `path` is never aliased.
//       Results are identical with or without reuse.
//       distances(): the same search from `start` with no goal, stopping once the
//       next cell to settle costs more than `limit` (dist ≤ limit is exact); it can
//       reuse a finished solve's dist/state buffers so a second search allocates
//       nothing per cell (the solve's `dist` is then overwritten). Given
//       {parent} (an Int32Array of W×H) it also fills the shortest-path tree with
//       the same moves, straddle rule and guard: parent[start] = -1, and
//       trace(parent, i) for any cell with dist ≤ limit is a least-cost path
//       start → i (unsettled cells hold -1 or a provisional parent). The move
//       costs are symmetric (a knight move straddles the same two cells either
//       way), so distances from the goal are distances to it.
//       Also exports the grid geometry pi-reduce.ts and cost.ts share: the 16
//       move offsets (MOVE_DR/MOVE_DC — the endpoint guard both modules apply),
//       rowCol, trace, and traverse() (the exact cells a straight segment
//       crosses, with the length inside each).
//       Pure: no DOM, runs in a worker and in Node.
// Deps: none.

export interface GridInput {
  width: number;
  height: number;
  cost: Float32Array;     // per-cell cost per metre; <= 0, NaN or Infinity is blocked
  barrier?: Uint8Array;   // 1 = impassable
  mask?: Uint8Array;      // 1 = allowed
  cellM: number;          // cell size, metres
  start: number;          // cell index (row * width + col)
  goal: number;
  maxCells?: number;      // default 10e6
}

/** Buffers of a finished solve, for distances() to reuse (contents are overwritten). */
export interface Scratch { dist: Float64Array; state: Uint8Array }

/** `dist` is `scratch.dist`: a distances() call given this scratch overwrites it. */
export type SolveResult =
  | { ok: true; cost: number; path: number[]; visited: number; dist: Float64Array; scratch: Scratch }
  | { ok: false; error: string };

const DEFAULT_MAX_CELLS = 10e6;

// 16 moves as (dr, dc): 4 orthogonal, 4 diagonal, 8 knight.
export const MOVE_DR: readonly number[] = [0, 0, -1, 1, -1, -1, 1, 1, -2, -2, 2, 2, -1, -1, 1, 1];
export const MOVE_DC: readonly number[] = [-1, 1, 0, 0, -1, 1, 1, -1, -1, 1, 1, -1, -2, 2, 2, -2];
const DR = MOVE_DR, DC = MOVE_DC;

/**
 * Exact grid traversal (Amanatides–Woo) of the segment (x0, y0) → (x1, y1), in cell
 * units: x = column, y = row, cell (c, r) spans [c, c+1) × [r, r+1). Calls
 * visit(col, row, len) for each cell in order, len = the segment's length inside it
 * (cell units; the lens sum to the segment length). An exact corner pass (the
 * segment crosses a row and a column line at one point, to within 1e-9) also
 * reports the two cells it squeezes between, with len 0: they touch the line at a
 * point only, so they add no cost, but a blocked test sees them — the same
 * straddle rule solve() applies to a diagonal move. visit returning false stops.
 */
export function traverse(
  x0: number, y0: number, x1: number, y1: number,
  visit: (col: number, row: number, len: number) => boolean | void,
): void {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const next = (p0: number, d: number, cell: number): number =>
    d > 0 ? (cell + 1 - p0) / d : d < 0 ? (cell - p0) / d : Infinity;
  let c = Math.floor(x0), r = Math.floor(y0), t = 0;
  for (;;) {
    const tx = next(x0, dx, c), ty = next(y0, dy, r), tn = Math.min(tx, ty, 1);
    if ((tn > t || t === 0) && visit(c, r, (tn - t) * L) === false) return;
    if (tn >= 1) return;
    t = Math.max(t, tn);
    if (Math.abs(tx - ty) <= 1e-9) {
      if (visit(c + sx, r, 0) === false || visit(c, r + sy, 0) === false) return;
      c += sx; r += sy;
    } else if (tx < ty) c += sx;
    else r += sy;
  }
}

export function rowCol(index: number, width: number): [row: number, col: number] {
  return [Math.floor(index / width), index % width];
}

/** Cell path start → goal from a parent array (parent[start] = -1). */
export function trace(parent: Int32Array, goal: number): number[] {
  const path: number[] = [];
  for (let i = goal; i !== -1; i = parent[i]) path.push(i);
  return path.reverse();
}

export function solve(input: GridInput, opts: { extend?: number; scratch?: Scratch; parent?: Int32Array } = {}): SolveResult {
  const bad = check(input);
  if (bad) return { ok: false, error: bad };
  const extend = opts.extend ?? 0;
  if (!(extend >= 0 && extend < Infinity)) return { ok: false, error: 'extend must be a finite number ≥ 0' };
  const { goal } = input;
  const W = input.width, H = input.height, n = W * H;
  const { scratch } = opts;
  if (scratch && (scratch.dist.length !== n || scratch.state.length !== n)) return { ok: false, error: 'scratch does not match width × height' };
  if (opts.parent && opts.parent.length !== n) return { ok: false, error: 'parent array does not match width × height' };
  const st = scratch ? scratch.state : new Uint8Array(n);
  if (!blockAll(input, st, [input.start, goal])) return { ok: false, error: st[input.start] === 1 ? 'start cell is not passable' : 'goal cell is not passable' };
  const dist = scratch ? scratch.dist : new Float64Array(n);
  const parent = opts.parent ? opts.parent.fill(-1) : new Int32Array(n).fill(-1);
  const visited = search(input, st, dist, parent, goal, Infinity, extend);
  if (st[goal] !== 2) return { ok: false, error: 'goal is unreachable' };
  return { ok: true, cost: dist[goal], path: trace(parent, goal), visited, dist, scratch: scratch ?? { dist, state: st } };
}

/**
 * Least costs from `start` (no goal): settles cells in cost order until the next one
 * costs more than `limit`. dist[i] ≤ limit is exact; anything else is ≥ limit. `guard`
 * lists the cells whose 16-neighbourhoods ignore `barrier` (pass the solve's start
 * and goal so both searches see the same graph). Reuses `scratch` when given.
 * `opts.parent` (length W×H) receives the shortest-path tree: trace(parent, i) is a
 * least-cost path start → i for every cell with dist[i] ≤ limit.
 */
export function distances(input: Omit<GridInput, 'goal'>, limit: number, guard: number[], scratch?: Scratch, opts: { parent?: Int32Array } = {}): { dist: Float64Array; visited: number } | { error: string } {
  const bad = check({ ...input, goal: input.start });
  if (bad) return { error: bad };
  const n = input.width * input.height;
  const st = scratch && scratch.state.length === n ? scratch.state : new Uint8Array(n);
  const dist = scratch && scratch.dist.length === n ? scratch.dist : new Float64Array(n);
  const parent = opts.parent ?? null;
  if (parent && parent.length !== n) return { error: 'parent array does not match width × height' };
  if (!blockAll(input, st, guard)) return { error: 'start cell is not passable' };
  parent?.fill(-1);
  return { dist, visited: search(input, st, dist, parent, -1, limit) };
}

function check(input: GridInput): string | null {
  const { width: W, height: H, cost, barrier, mask, cellM, start, goal } = input;
  const maxCells = input.maxCells ?? DEFAULT_MAX_CELLS;
  const n = W * H;
  if (n > maxCells) return `grid has ${n} cells, over the ${maxCells}-cell cap`;
  if (!(W > 0 && H > 0) || cost.length !== n || (barrier && barrier.length !== n) || (mask && mask.length !== n))
    return 'grid arrays do not match width × height';
  if (!(cellM > 0)) return 'cellM must be > 0';
  if (!(start >= 0 && start < n && goal >= 0 && goal < n && Number.isInteger(start) && Number.isInteger(goal)))
    return 'start or goal is outside the grid';
  return null;
}

/** state 1 for every blocked cell, 0 otherwise, with the endpoint guard around `guard`;
 *  false when input.start or any guard cell is still blocked. */
function blockAll(input: Omit<GridInput, 'goal'>, state: Uint8Array, guard: number[]): boolean {
  const { width: W, height: H, cost, barrier, mask } = input;
  const passable = (i: number): boolean => {
    const c = cost[i];
    return c > 0 && c < Infinity && (!mask || mask[i] === 1);
  };
  for (let i = 0; i < state.length; i++) state[i] = !passable(i) || (barrier && barrier[i] === 1) ? 1 : 0;
  if (barrier) {
    for (const e of guard) {
      const [r, c] = rowCol(e, W);
      if (passable(e)) state[e] = 0;
      for (let k = 0; k < 16; k++) {
        const rr = r + DR[k], cc = c + DC[k];
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const v = rr * W + cc;
        if (passable(v)) state[v] = 0;
      }
    }
  }
  return state[input.start] !== 1 && guard.every((e) => state[e] !== 1);
}

// state: 0 open, 1 blocked, 2 settled. Stops when the next key > limit, or when `goal`
// pops — unless extend > 0, which then lowers limit to (1+extend)·dist[goal] and goes on.
function search(input: Omit<GridInput, 'goal'>, state: Uint8Array, dist: Float64Array, parent: Int32Array | null, goal: number, limit: number, extend = 0): number {
  const { width: W, height: H, cost, cellM, start } = input;
  const fac = [0.5, 0.5, 0.5, 0.5, Math.SQRT2 / 2, Math.SQRT2 / 2, Math.SQRT2 / 2, Math.SQRT2 / 2,
    ...Array<number>(8).fill(Math.sqrt(5) / 4)].map((f) => f * cellM);
  dist.fill(Infinity);

  let cap = 1 << 16, size = 0;
  let hk = new Float64Array(cap), hv = new Int32Array(cap);
  const push = (key: number, v: number): void => {
    if (size === cap) {
      cap *= 2;
      const k2 = new Float64Array(cap); k2.set(hk); hk = k2;
      const v2 = new Int32Array(cap); v2.set(hv); hv = v2;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = key; hv[i] = v;
  };
  const pop = (): number => {
    const top = hv[0];
    const key = hk[--size], val = hv[size];
    let i = 0;
    for (;;) {
      let ch = 2 * i + 1;
      if (ch >= size) break;
      if (ch + 1 < size && hk[ch + 1] < hk[ch]) ch++;
      if (hk[ch] >= key) break;
      hk[i] = hk[ch]; hv[i] = hv[ch]; i = ch;
    }
    hk[i] = key; hv[i] = val;
    return top;
  };

  dist[start] = 0;
  push(0, start);
  let visited = 0;
  while (size > 0) {
    if (hk[0] > limit) break;
    const u = pop();
    if (state[u] === 2) continue;
    state[u] = 2;
    visited++;
    if (u === goal) {
      if (!(extend > 0)) break;
      limit = Math.min(limit, (1 + extend) * dist[u]);
    }
    const ur = Math.floor(u / W), uc = u - ur * W, du = dist[u], cu = cost[u];
    for (let k = 0; k < 16; k++) {
      const dr = DR[k], dc = DC[k];
      const r = ur + dr, c = uc + dc;
      if (r < 0 || r >= H || c < 0 || c >= W) continue;
      const v = r * W + c;
      if (state[v] !== 0) continue;
      let sum: number;
      if (k < 4) {
        sum = cu + cost[v];
      } else if (k < 8) {
        const a = v - dc, b = u + dc;  // (r, uc) and (ur, c)
        if (state[a] === 1 || state[b] === 1) continue;
        sum = cu + cost[v];
      } else {
        let a: number, b: number;
        if (dr === 2 || dr === -2) { a = u + (dr >> 1) * W; b = a + dc; }
        else { a = u + (dc >> 1); b = a + dr * W; }
        if (state[a] === 1 || state[b] === 1) continue;
        sum = cu + cost[a] + cost[b] + cost[v];
      }
      const nd = du + sum * fac[k];
      if (nd < dist[v]) { dist[v] = nd; if (parent) parent[v] = u; push(nd, v); }
    }
  }
  return visited;
}
