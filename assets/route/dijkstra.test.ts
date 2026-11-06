import { describe, it, expect } from 'vitest';
import { distances, solve, rowCol, trace, traverse, MOVE_DR, MOVE_DC, type GridInput } from './dijkstra.js';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

function grid(W: number, H: number, c = 1): Pick<GridInput, 'width' | 'height' | 'cost' | 'cellM'> {
  return { width: W, height: H, cost: new Float32Array(W * H).fill(c), cellM: 1 };
}
const at = (W: number, r: number, c: number) => r * W + c;

function ok(res: ReturnType<typeof solve>) {
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe('dijkstra', () => {
  it('uniform cost: any angle within 3% of the straight-line length', () => {
    const W = 201, H = 201;
    const g = { ...grid(W, H, 2), cellM: 250 };
    for (const [r, c] of [[200, 200], [200, 100], [200, 47], [200, 0], [37, 200], [200, 180], [150, 61]]) {
      const res = ok(solve({ ...g, start: 0, goal: at(W, r, c) }));
      const straight = Math.hypot(r, c) * 250 * 2;
      expect(res.cost).toBeGreaterThanOrEqual(straight - 1e-6);
      expect(res.cost / straight).toBeLessThan(1.03);
      expect(res.path[0]).toBe(0);
      expect(res.path[res.path.length - 1]).toBe(at(W, r, c));
    }
  });

  it('a wall with one gap: the path goes through the gap', () => {
    const W = 41, H = 41;
    const barrier = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) if (r !== 5) barrier[at(W, r, 20)] = 1;
    const res = ok(solve({ ...grid(W, H), barrier, start: at(W, 35, 2), goal: at(W, 35, 38) }));
    expect(res.path).toContain(at(W, 5, 20));
    for (const i of res.path) expect(barrier[i]).toBe(0);
  });

  it('a mask = 0 cell acts like a barrier', () => {
    const W = 41, H = 41;
    const mask = new Uint8Array(W * H).fill(1);
    for (let r = 0; r < H; r++) if (r !== 5) mask[at(W, r, 20)] = 0;
    const res = ok(solve({ ...grid(W, H), mask, start: at(W, 35, 2), goal: at(W, 35, 38) }));
    expect(res.path).toContain(at(W, 5, 20));
  });

  it('a 1-cell-thick diagonal or knight-slope barrier line does not leak', () => {
    const W = 60, H = 60;
    const diag = new Uint8Array(W * H);
    for (let i = 0; i < W; i++) diag[at(W, i, i)] = 1;
    expect(solve({ ...grid(W, H), barrier: diag, start: at(W, 50, 5), goal: at(W, 5, 50) }).ok).toBe(false);
    expect(solve({ ...grid(W, H), barrier: diag, start: at(W, 50, 5), goal: at(W, 55, 10) }).ok).toBe(true);

    // 8-connected staircase of slope 2 (and its transpose): knight-move direction
    const steep = new Uint8Array(W * H), flat = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) { steep[at(W, r, r >> 1)] = 1; flat[at(W, r >> 1, r)] = 1; }
    expect(solve({ ...grid(W, H), barrier: steep, start: at(W, 50, 2), goal: at(W, 5, 50) }).ok).toBe(false);
    expect(solve({ ...grid(W, H), barrier: flat, start: at(W, 2, 50), goal: at(W, 50, 5) }).ok).toBe(false);
  });

  it('an endpoint inside a barrier region still solves', () => {
    const W = 30, H = 30;
    const barrier = new Uint8Array(W * H);
    for (let r = 8; r <= 12; r++) for (let c = 8; c <= 12; c++) barrier[at(W, r, c)] = 1;
    const res = ok(solve({ ...grid(W, H), barrier, start: at(W, 10, 10), goal: at(W, 25, 25) }));
    expect(res.path[0]).toBe(at(W, 10, 10));
    // and the goal too
    ok(solve({ ...grid(W, H), barrier, start: at(W, 25, 25), goal: at(W, 10, 10) }));
  });

  it('distances(): the solve\'s costs from either end, exact up to the limit, in the reused buffers', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 50, H = 40, cost = new Float32Array(W * H), barrier = new Uint8Array(W * H);
    for (let i = 0; i < cost.length; i++) { cost[i] = 1 + rnd() * 3; barrier[i] = rnd() < 0.08 ? 1 : 0; }
    const start = at(W, 5, 5), goal = at(W, 33, 44);
    barrier[at(W, 5, 6)] = barrier[at(W, 34, 44)] = 1;  // inside the endpoint guard
    const g = { width: W, height: H, cost, barrier, cellM: 30 };
    const s = ok(solve({ ...g, start, goal }));
    const fwd = distances({ ...g, start }, Infinity, [start, goal]);
    const back = distances({ ...g, start: goal }, Infinity, [start, goal]);
    if ('error' in fwd || 'error' in back) throw new Error('distances failed');
    expect(back.dist[start]).toBeCloseTo(s.cost, 6);  // moves cost the same both ways
    for (let i = 0; i < W * H; i++) if (s.dist[i] < s.cost) expect(fwd.dist[i]).toBeCloseTo(s.dist[i], 9);
    const limit = s.cost / 2;
    const part = distances({ ...g, start }, limit, [start, goal], s.scratch);
    if ('error' in part) throw new Error(part.error);
    expect(part.dist).toBe(s.scratch.dist);
    expect(part.visited).toBeLessThan(fwd.visited);
    for (let i = 0; i < W * H; i++) {
      if (fwd.dist[i] <= limit) expect(part.dist[i]).toBeCloseTo(fwd.dist[i], 9);
      else expect(part.dist[i]).toBeGreaterThan(limit);
    }
  });

  // Seeded grid: costs 1–10, 10 % barrier, endpoints guarded.
  function rgrid(seed: number, W: number, H: number) {
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const cost = new Float32Array(W * H), barrier = new Uint8Array(W * H);
    for (let i = 0; i < cost.length; i++) { cost[i] = 1 + rnd() * 9; barrier[i] = rnd() < 0.1 ? 1 : 0; }
    return { width: W, height: H, cost, barrier, cellM: 250 };
  }
  const fnv = (bytes: Uint8Array): string => {
    let h = 0x811c9dc5;
    for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };

  it('extend 0 (or omitted) is byte-identical to the solve before extend existed', () => {
    // fnv of the dist and path bytes, captured from the pre-extend solver (HEAD c607a31).
    const before: Record<number, [string, string, number]> = {
      1: ['4dfd2468', '7d956ed4', 2746], 2: ['b4cb89e0', '477e68be', 2753], 3: ['9b170ad3', '4de91977', 2777],
    };
    const W = 64, H = 48;
    for (const seed of [1, 2, 3]) {
      const g = { ...rgrid(seed, W, H), start: W + 1, goal: W * H - W - 2 };
      for (const r of [ok(solve(g)), ok(solve(g, { extend: 0 }))]) {
        expect([fnv(new Uint8Array(r.dist.buffer)), fnv(new Uint8Array(new Int32Array(r.path).buffer)), r.visited]).toEqual(before[seed]);
      }
    }
  });

  it('a reused scratch + parent (dirty from another solve) gives byte-identical results; dist aliases scratch.dist', () => {
    const before: Record<number, [string, string, number]> = {
      1: ['4dfd2468', '7d956ed4', 2746], 2: ['b4cb89e0', '477e68be', 2753], 3: ['9b170ad3', '4de91977', 2777],
    };
    const W = 64, H = 48;
    const first = ok(solve({ ...rgrid(99, W, H), start: 5 * W + 5, goal: 40 * W + 50 }, { extend: 0.3 }));
    const scratch = first.scratch, parent = new Int32Array(W * H).fill(7);
    for (const seed of [1, 2, 3]) {
      const g = { ...rgrid(seed, W, H), start: W + 1, goal: W * H - W - 2 };
      const r = ok(solve(g, { scratch, parent }));
      expect(r.dist).toBe(scratch.dist);
      expect(r.scratch).toBe(scratch);
      expect([fnv(new Uint8Array(r.dist.buffer)), fnv(new Uint8Array(new Int32Array(r.path).buffer)), r.visited]).toEqual(before[seed]);
      expect(trace(parent, g.goal)).toEqual(r.path);
    }
    expect(first.dist).toBe(scratch.dist); // the first result's dist was overwritten in place
    const bad = solve({ ...rgrid(1, W, H), start: W + 1, goal: 2 * W + 2 }, { parent: new Int32Array(3) });
    expect(bad.ok).toBe(false);
  });

  it('extend ε: dist equals the unbounded distances() for every cell ≤ (1+ε)·C; path and cost unchanged', () => {
    const W = 70, H = 60;
    for (const seed of [11, 12, 13, 14, 15]) {
      const g = rgrid(seed, W, H), start = at(W, 30, 8), goal = at(W, 28, 50);
      const full = distances({ ...g, start }, Infinity, [start, goal]);
      if ('error' in full) throw new Error(full.error);
      const base = ok(solve({ ...g, start, goal }));
      for (const eps of [0.02, 0.2, 0.5]) {
        const ext = ok(solve({ ...g, start, goal }, { extend: eps }));
        expect(ext.cost).toBe(base.cost);
        expect(ext.path).toEqual(base.path);
        expect(ext.visited).toBeGreaterThan(base.visited);
        const L = (1 + eps) * ext.cost;
        let inside = 0;
        for (let i = 0; i < W * H; i++) {
          if (full.dist[i] <= L) { expect(ext.dist[i]).toBe(full.dist[i]); inside++; }
          else expect(ext.dist[i]).toBeGreaterThan(L);
        }
        expect(inside).toBe(ext.visited);
      }
    }
    const g = { ...grid(5, 5), start: 0, goal: 24 };
    for (const bad of [-0.1, NaN, Infinity]) expect(solve(g, { extend: bad }).ok).toBe(false);
  });

  it('distances({parent}): every settled cell traces back to start along legal moves summing to its dist', () => {
    const W = 60, H = 50;
    for (const seed of [21, 22, 23]) {
      const g = rgrid(seed, W, H), start = at(W, 25, 4), goal = at(W, 22, 55);
      g.barrier[at(W, 25, 5)] = g.barrier[at(W, 23, 55)] = 1;  // inside the endpoint guard
      const s = ok(solve({ ...g, start, goal }));
      const limit = 1.3 * s.cost, parent = new Int32Array(W * H).fill(7);
      const d = distances({ ...g, start }, limit, [start, goal], undefined, { parent });
      if ('error' in d) throw new Error(d.error);
      expect(parent[start]).toBe(-1);
      expect(trace(parent, goal)).toEqual(s.path);
      // blocked = what the solver blocks, with the endpoint guard around start and goal
      const guarded = new Set<number>();
      for (const e of [start, goal]) {
        guarded.add(e);
        const [r, c] = rowCol(e, W);
        for (let k = 0; k < 16; k++) {
          const rr = r + MOVE_DR[k], cc = c + MOVE_DC[k];
          if (rr >= 0 && rr < H && cc >= 0 && cc < W) guarded.add(rr * W + cc);
        }
      }
      const blocked = (i: number) => g.barrier[i] === 1 && !guarded.has(i);
      const edge = (u: number, v: number): number => {
        const [ur, uc] = rowCol(u, W), [vr, vc] = rowCol(v, W), dr = vr - ur, dc = vc - uc;
        const k = MOVE_DR.findIndex((r, j) => r === dr && MOVE_DC[j] === dc);
        if (k < 0 || blocked(u) || blocked(v)) return NaN;
        const C = g.cost;
        if (k < 4) return (C[u] + C[v]) / 2 * g.cellM;
        if (k < 8) {
          if (blocked(ur * W + vc) || blocked(vr * W + uc)) return NaN;
          return (C[u] + C[v]) / 2 * Math.SQRT2 * g.cellM;
        }
        const [a, b] = Math.abs(dr) === 2
          ? [(ur + dr / 2) * W + uc, (ur + dr / 2) * W + vc]
          : [ur * W + uc + dc / 2, vr * W + uc + dc / 2];
        if (blocked(a) || blocked(b)) return NaN;
        return (C[u] + C[a] + C[b] + C[v]) / 4 * Math.sqrt(5) * g.cellM;
      };
      let settled = 0;
      const wrong: number[] = [];  // cells whose trace misses start, takes an illegal move or misprices
      for (let i = 0; i < W * H; i++) {
        if (!(d.dist[i] <= limit)) continue;
        settled++;
        const p = trace(parent, i);
        let sum = 0;
        for (let j = 1; j < p.length; j++) sum += edge(p[j - 1], p[j]);
        if (p[0] !== start || p[p.length - 1] !== i || !(Math.abs(sum - d.dist[i]) <= 1e-9 * Math.max(1, d.dist[i]))) wrong.push(i);
      }
      expect(wrong).toEqual([]);
      expect(settled).toBe(d.visited);
      expect(settled).toBeGreaterThan(500);
    }
    const bad = distances({ ...grid(4, 4), start: 0 }, Infinity, [0], undefined, { parent: new Int32Array(3) });
    expect(bad).toEqual({ error: expect.stringContaining('parent') });
  });

  it('refuses a grid over maxCells without solving', () => {
    const res = solve({ width: 5000, height: 5000, cost: new Float32Array(0), cellM: 1, start: 0, goal: 1 });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('10000000') });
    const small = solve({ ...grid(10, 10), start: 0, goal: 99, maxCells: 50 });
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.error).toContain('50');
  });

  it('an unreachable goal is ok:false', () => {
    const W = 30, H = 30;
    const g = grid(W, H);
    for (let r = 0; r < H; r++) g.cost[at(W, r, 15)] = NaN;
    for (let r = 0; r < H; r++) g.cost[at(W, r, 16)] = 0;
    const res = solve({ ...g, start: at(W, 3, 3), goal: at(W, 3, 27) });
    expect(res.ok).toBe(false);
  });

  it('knight move cost uses the two straddled cells (r.cost convention)', () => {
    // 2 wide × 3 tall:  [2 9]
    //                   [4 6]
    //                   [9 8]
    // (0,0) → (2,1) by knight straddles (1,0)=4 and (1,1)=6: (2+4+6+8)/4 × √5 × 10
    // beats (0,0)→(1,0)→(2,1) = 3·10 + (4+8)/2·√2·10 = 114.85.
    const cost = new Float32Array([2, 9, 4, 6, 9, 8]);
    const res = ok(solve({ width: 2, height: 3, cost, cellM: 10, start: 0, goal: 5 }));
    expect(res.cost).toBeCloseTo(5 * Math.sqrt(5) * 10, 9);
    expect(res.path).toEqual([0, 5]);

    // Transposed (3 wide × 2 tall), the horizontal knight move.
    const t = new Float32Array([2, 4, 9, 9, 6, 8]);
    const rt = ok(solve({ width: 3, height: 2, cost: t, cellM: 10, start: 0, goal: 5 }));
    expect(rt.cost).toBeCloseTo(5 * Math.sqrt(5) * 10, 9);
    expect(rt.path).toEqual([0, 5]);

    // Orthogonal and diagonal moves: two-cell mean × length.
    const o = ok(solve({ width: 2, height: 1, cost: new Float32Array([2, 4]), cellM: 10, start: 0, goal: 1 }));
    expect(o.cost).toBeCloseTo(30, 9);
    const d = ok(solve({ width: 2, height: 2, cost: new Float32Array([2, 50, 50, 4]), cellM: 10, start: 0, goal: 3 }));
    expect(d.cost).toBeCloseTo(3 * Math.SQRT2 * 10, 9);
  });

  it('rowCol', () => {
    expect(rowCol(at(7, 3, 5), 7)).toEqual([3, 5]);
  });

  it.skipIf(env.ROUTE_SKIP_PERF === '1')('perf: 1600×1600 random grid corner to corner < 3 s', () => {
    const W = 1600, H = 1600, n = W * H;
    const cost = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; cost[i] = 1 + (s / 4294967296) * 19; }
    const t0 = performance.now();
    const res = ok(solve({ width: W, height: H, cost, cellM: 250, start: 0, goal: n - 1 }));
    const ms = performance.now() - t0;
    console.log(`dijkstra perf: ${W}×${H}, visited ${res.visited}, ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
  }, 20_000);
});

describe('traverse', () => {
  const cells = (x0: number, y0: number, x1: number, y1: number) => {
    const out: [number, number, number][] = [];
    traverse(x0, y0, x1, y1, (c, r, len) => { out.push([c, r, len]); });
    return out;
  };

  it('gives every crossed cell its exact length, summing to the segment length', () => {
    // knight move centre → centre: four cells of √5/4 each (the r.cost knight average)
    const k = cells(0.5, 0.5, 1.5, 2.5);
    expect(k.map(([c, r]) => [c, r])).toEqual([[0, 0], [0, 1], [1, 1], [1, 2]]);
    k.forEach(([, , len]) => expect(len).toBeCloseTo(Math.sqrt(5) / 4, 12));
    const g = cells(0.3, 7.9, 9.7, 0.2);
    expect(g.reduce((s, [, , len]) => s + len, 0)).toBeCloseTo(Math.hypot(9.4, 7.7), 12);
  });

  it('an exact corner pass reports the two squeezed cells with length 0', () => {
    expect(cells(0.5, 1.5, 1.5, 0.5)).toEqual([[0, 1, Math.SQRT2 / 2], [1, 1, 0], [0, 0, 0], [1, 0, Math.SQRT2 / 2]]);
  });

  it('stops when visit returns false', () => {
    let n = 0;
    traverse(0.5, 0.5, 9.5, 0.5, () => ++n < 3);
    expect(n).toBe(3);
  });
});
