import { describe, expect, it } from 'vitest';
import { distances, solve, MOVE_DC, MOVE_DR, type GridInput, type SolveResult } from './dijkstra.js';
import { classify, pathCost, penaltyAlternatives, selfTouches, shareWithin, PENALTY_BYTES_PER_CELL, SOLVE_BYTES_PER_CELL, type SolveBuffers } from './similar-cost.js';

const at = (W: number, r: number, c: number): number => r * W + c;
function ok(res: SolveResult): Extract<SolveResult, { ok: true }> {
  if (!res.ok) throw new Error(res.error);
  return res;
}

/** dA (extended solve) and dB (distances from the goal) to (1 + 0.2)·C. */
function surfaces(g: GridInput): { C: number; path: number[]; dA: Float64Array; dB: Float64Array } {
  const s = ok(solve(g, { extend: 0.2 }));
  const dA = s.dist.slice();
  const r = distances({ ...g, start: g.goal }, 1.2 * s.cost, [g.start, g.goal]);
  if ('error' in r) throw new Error(r.error);
  return { C: s.cost, path: s.path, dA, dB: r.dist };
}

/** Bellman–Ford over the explicit 16-move graph with the r.cost formula and the
 *  straddle rule (no barrier), written independently of dijkstra.ts. */
function bruteDist(g: Omit<GridInput, 'goal'>): Float64Array {
  const { width: W, height: H, cost, cellM } = g, n = W * H;
  const open = (i: number): boolean => cost[i] > 0 && cost[i] < Infinity;
  const edges: [number, number, number][] = [];
  for (let u = 0; u < n; u++) {
    if (!open(u)) continue;
    const ur = Math.floor(u / W), uc = u % W;
    for (let k = 0; k < 16; k++) {
      const r = ur + MOVE_DR[k], c = uc + MOVE_DC[k];
      if (r < 0 || r >= H || c < 0 || c >= W || !open(r * W + c)) continue;
      const v = r * W + c, dr = MOVE_DR[k], dc = MOVE_DC[k];
      let w: number;
      if (Math.abs(dr) + Math.abs(dc) === 1) w = (cost[u] + cost[v]) / 2 * cellM;
      else if (Math.abs(dr) === 1 && Math.abs(dc) === 1) {
        if (!open(ur * W + c) || !open(r * W + uc)) continue;
        w = (cost[u] + cost[v]) / 2 * cellM * Math.SQRT2;
      } else {
        const [a, b] = Math.abs(dr) === 2
          ? [(ur + dr / 2) * W + uc, (ur + dr / 2) * W + c]
          : [ur * W + uc + dc / 2, r * W + uc + dc / 2];
        if (!open(a) || !open(b)) continue;
        w = (cost[u] + cost[a] + cost[b] + cost[v]) / 4 * cellM * Math.sqrt(5);
      }
      edges.push([u, v, w]);
    }
  }
  const d = new Float64Array(n).fill(Infinity);
  d[g.start] = 0;
  for (let it = 0; it < n; it++) {
    let changed = false;
    for (const [u, v, w] of edges) if (d[u] + w < d[v]) { d[v] = d[u] + w; changed = true; }
    if (!changed) break;
  }
  return d;
}

function lcg(seed: number): () => number {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

describe('classify', () => {
  it('a 1e-9·C tolerance absorbs float noise; C ≤ 0 or non-finite gives all zero', () => {
    const dA = Float64Array.from([50, 50, 50, Infinity]), dB = Float64Array.from([50, 50 + 5e-8, 50 + 2e-7, 1]);
    expect([...classify(dA, dB, 100, [0])]).toEqual([1, 1, 0, 0]);
    for (const C of [0, -1, NaN, Infinity]) expect([...classify(dA, dB, C)]).toEqual([0, 0, 0, 0]);
  });

  it('every raw optimal-path cell is class 1', () => {
    const rnd = lcg(11);
    const W = 60, H = 40;
    const cost = new Float32Array(W * H).map(() => 0.5 + rnd() * 3);
    const g: GridInput = { width: W, height: H, cost, cellM: 250, start: at(W, 3, 2), goal: at(W, 35, 57) };
    const { C, path, dA, dB } = surfaces(g);
    const cls = classify(dA, dB, C);
    for (const x of path) expect(cls[x]).toBe(1);
  });

  it('c(x) = dA + dB equals brute force on 50 random small grids (1e-9 rel), classes agree', () => {
    const rnd = lcg(3);
    let solved = 0;
    for (let t = 0; solved < 50; t++) {
      const W = 5 + Math.floor(rnd() * 5), H = 5 + Math.floor(rnd() * 5), n = W * H;
      const cost = new Float32Array(n).map(() => (rnd() < 0.12 ? (rnd() < 0.5 ? Infinity : 0) : 0.2 + rnd() * 5));
      const start = 0, goal = n - 1;
      cost[start] = 1; cost[goal] = 1;
      const g: GridInput = { width: W, height: H, cost, cellM: 1 + rnd() * 300, start, goal };
      const s = solve(g);
      if (!s.ok) continue;
      solved++;
      const { C, dA, dB } = surfaces(g);
      const bA = bruteDist(g), bB = bruteDist({ ...g, start: goal });
      expect(Math.abs(C - bA[goal]) / C).toBeLessThan(1e-9);
      for (let i = 0; i < n; i++) {
        const cb = bA[i] + bB[i];
        if (cb <= 1.2 * C) expect(Math.abs(dA[i] + dB[i] - cb) / cb).toBeLessThan(1e-9);
      }
      expect(Array.from(classify(dA, dB, C))).toEqual(Array.from(classify(bA, bB, C)));
    }
  });

  it('unreachable and blocked cells are class 0; bands are inclusive upper bounds', () => {
    const dA = new Float64Array([0, 1, Infinity, 52, 53, 55, 60, 70, 71, 49]);
    const dB = new Float64Array([100, 99, 1, 50, 50, 50, 50, 50, 50, Infinity]);
    expect(Array.from(classify(dA, dB, 100))).toEqual([1, 1, 0, 1, 2, 2, 3, 4, 0, 0]);
  });
});

describe('shareWithin and selfTouches', () => {
  const W = 50;
  const row = (r: number, c0: number, c1: number): number[] => Array.from({ length: c1 - c0 + 1 }, (_, i) => at(W, r, c0 + i));

  it('symmetric cases: identical 1, 1-cell offset 1, 3-cell offset 0, half overlap 0.5 both ways', () => {
    const a = row(10, 0, 40);
    expect(shareWithin(a, a, 2, W)).toBe(1);
    expect(shareWithin(a, row(11, 0, 40), 2, W)).toBe(1);
    expect(shareWithin(row(11, 0, 40), a, 2, W)).toBe(1);
    expect(shareWithin(a, row(13, 0, 40), 2, W)).toBe(0);
    expect(shareWithin(row(13, 0, 40), a, 2, W)).toBe(0);
    // mirror images: a shared straight half, then diagonals down / up
    const half = row(20, 0, 20);
    const down = [...half, ...Array.from({ length: 20 }, (_, j) => at(W, 21 + j, 21 + j))];
    const up = [...half, ...Array.from({ length: 20 }, (_, j) => at(W, 19 - j, 21 + j))];
    const expected = (20 + 2 * Math.SQRT2) / (20 + 20 * Math.SQRT2);
    expect(shareWithin(down, up, 2, W)).toBeCloseTo(expected, 12);
    expect(shareWithin(up, down, 2, W)).toBeCloseTo(expected, 12);
  });

  it('rejects a U-turn that comes back within 2 cells outside the ±8-step window; a straight path passes', () => {
    const straight = row(5, 0, 30);
    expect(selfTouches(straight, W)).toBe(false);
    const uturn = [...row(5, 0, 20), at(W, 6, 20), at(W, 7, 20), ...row(7, 0, 19).reverse()];
    expect(selfTouches(uturn, W)).toBe(true);
    const revisit = [at(W, 5, 0), at(W, 5, 1), at(W, 5, 0)];
    expect(selfTouches(revisit, W)).toBe(true);
  });
});

describe('pathCost', () => {
  it('re-costs the solve optimum exactly (same edge formula and order)', () => {
    const rnd = lcg(5);
    const W = 40, H = 30;
    const cost = new Float32Array(W * H).map(() => 0.3 + rnd() * 4);
    const s = ok(solve({ width: W, height: H, cost, cellM: 250, start: 0, goal: W * H - 1 }));
    expect(pathCost(s.path, cost, W, 250)).toBe(s.cost);
    expect(pathCost([0, 3], cost, W, 250)).toBeNaN();
  });
});

describe('penaltyAlternatives', () => {
  // two cheap valleys (cost 1) in an expensive field (20): A along row 5, B along row 26
  function twoValleys(): GridInput {
    const W = 60, H = 31, cost = new Float32Array(W * H).fill(20);
    for (let c = 2; c <= 57; c++) { cost[at(W, 5, c)] = 1; cost[at(W, 26, c)] = 1; }
    for (let r = 5; r <= 26; r++) { cost[at(W, r, 2)] = 1; cost[at(W, r, 57)] = 1; }
    return { width: W, height: H, cost, cellM: 250, start: at(W, 15, 2), goal: at(W, 15, 57) };
  }

  it('two-valley grid: the second valley is returned with its exact stretch; weights byte-equal after', () => {
    const g = twoValleys(), W = g.width;
    const before = new Uint8Array(g.cost.buffer.slice(0));
    const opt = ok(solve(g));
    for (const x of opt.path) expect(Math.floor(x / W)).toBeLessThanOrEqual(15);
    const res = penaltyAlternatives({ input: g, optimum: opt, k: 1 });
    expect(new Uint8Array(g.cost.buffer)).toEqual(before);
    expect(res.alts).toHaveLength(1);
    expect(res.stopped).toBe('found');
    expect(res.bytes).toBe((PENALTY_BYTES_PER_CELL + SOLVE_BYTES_PER_CELL) * W * g.height); // weight copy + one buffer set
    const alt = res.alts[0];
    expect(alt.path.some((x) => Math.floor(x / W) === 26)).toBe(true);
    // valley B's own optimum: valley A made expensive
    const noA = g.cost.slice();
    for (let c = 3; c <= 56; c++) noA[at(W, 5, c)] = 20;
    const bOpt = ok(solve({ ...g, cost: noA }));
    expect(alt.cost).toBeCloseTo(bOpt.cost, 9);
    expect(alt.cost).toBe(pathCost(alt.path, g.cost, W, g.cellM));
    expect(alt.stretch).toBe(alt.cost / opt.cost - 1);
    expect(alt.stretch).toBeGreaterThan(0);
    expect(alt.share).toBeLessThanOrEqual(0.5);
  });

  it('re-solves share one buffer set (the caller\'s when given) and match fresh-buffer solves exactly', () => {
    const W = 80, H = 61, cost = new Float32Array(W * H).fill(1);
    for (let i = 0; i < cost.length; i++) cost[i] = 1 + ((i * 2654435761) >>> 0) / 2 ** 32;
    const g: GridInput = { width: W, height: H, cost, cellM: 250, start: at(W, 30, 5), goal: at(W, 30, 74) };
    const opt = ok(solve(g));
    const fresh = penaltyAlternatives({ input: g, optimum: opt, k: 3, solveFn: (x) => solve(x) });
    const seen = new Set<SolveBuffers>();
    const spy = (x: GridInput, b: SolveBuffers): SolveResult => { seen.add(b); return solve(x, b); };
    const own = penaltyAlternatives({ input: g, optimum: opt, k: 3, solveFn: spy });
    expect(fresh.alts.length).toBeGreaterThan(0);
    expect(seen.size).toBe(1);
    expect(own.alts.map((a) => a.path)).toEqual(fresh.alts.map((a) => a.path));
    const scratch = { dist: new Float64Array(W * H), state: new Uint8Array(W * H) }, parent = new Int32Array(W * H);
    seen.clear();
    const given = penaltyAlternatives({ input: g, optimum: opt, k: 3, solveFn: spy, scratch, parent });
    expect([...seen].map((b) => [b.scratch, b.parent])).toEqual([[scratch, parent]]);
    expect([...seen][0].scratch).toBe(scratch);
    expect(given.alts.map((a) => a.path)).toEqual(fresh.alts.map((a) => a.path));
    expect(given.bytes).toBe(PENALTY_BYTES_PER_CELL * W * H);
  });

  it('a 1-cell-offset twin is rejected by share', () => {
    // two cheap rows 1 apart; radius 0 penalises only the optimum's own cells, so the
    // re-solve takes the twin row
    const W = 60, H = 21, cost = new Float32Array(W * H).fill(20);
    for (let c = 0; c < W; c++) { cost[at(W, 10, c)] = 1; cost[at(W, 11, c)] = 1.01; }
    const g: GridInput = { width: W, height: H, cost, cellM: 1, start: at(W, 10, 0), goal: at(W, 10, 59) };
    const opt = ok(solve(g));
    const res = penaltyAlternatives({ input: g, optimum: opt, k: 1, radiusCells: 0, maxAttempts: 1 });
    expect(res.alts).toHaveLength(0);
    expect(res.rejected.share).toBe(1);
    expect(res.stopped).toBe('attempts');
  });

  it('uniform weights (float ties) still yield a distinct alternative', () => {
    const W = 80, H = 61, cost = new Float32Array(W * H).fill(1);
    const g: GridInput = { width: W, height: H, cost, cellM: 250, start: at(W, 30, 5), goal: at(W, 30, 74) };
    const before = cost.slice();
    const opt = ok(solve(g));
    const res = penaltyAlternatives({ input: g, optimum: opt, k: 1 });
    expect(res.alts.length).toBe(1);
    const alt = res.alts[0];
    expect(alt.stretch).toBeLessThanOrEqual(0.2);
    expect(shareWithin(alt.path, opt.path, 2, W)).toBeLessThanOrEqual(0.5);
    expect(alt.path).not.toEqual(opt.path);
    expect(Buffer.from(cost.buffer).equals(Buffer.from(before.buffer))).toBe(true);
  });

  it('a self-touching path from the solver is rejected', () => {
    const W = 50, H = 30, cost = new Float32Array(W * H).fill(1);
    const g: GridInput = { width: W, height: H, cost, cellM: 1, start: at(W, 5, 0), goal: at(W, 7, 0) };
    const opt = { path: [at(W, 5, 0), at(W, 6, 0), at(W, 7, 0)], cost: 2 };
    const out = [at(W, 5, 0), at(W, 5, 1), ...Array.from({ length: 20 }, (_, i) => at(W, 5, 2 + i))];
    const back = Array.from({ length: 20 }, (_, i) => at(W, 7, 21 - i));
    const uturn = [...out, at(W, 6, 21), ...back, at(W, 7, 1), at(W, 7, 0)];
    const fake = (): SolveResult => ({ ok: true, cost: 0, path: uturn, visited: 0, dist: new Float64Array(0), scratch: { dist: new Float64Array(0), state: new Uint8Array(0) } });
    const res = penaltyAlternatives({ input: g, optimum: { ...opt, cost: 40 }, k: 1, solveFn: fake, shareMax: 1, maxAttempts: 1 });
    expect(res.alts).toHaveLength(0);
    expect(res.rejected.selfTouch).toBe(1);
  });

  it('a failed re-solve stops the loop with its error', () => {
    const g = twoValleys();
    const opt = ok(solve(g));
    const res = penaltyAlternatives({ input: g, optimum: opt, k: 2, solveFn: () => ({ ok: false, error: 'goal is unreachable' }) });
    expect(res).toMatchObject({ alts: [], attempts: 1, stopped: 'goal is unreachable' });
  });
});
