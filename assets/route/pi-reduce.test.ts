import { describe, expect, it } from 'vitest';
import { solve, traverse } from './dijkstra.js';
import { reducePath } from './pi-reduce.js';

const grid = (W: number, H: number, v = 1) => new Float32Array(W * H).fill(v);
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

// A barrier cell in an endpoint's 16-move neighbourhood is passable (the solver's guard).
function guarded(q: number, W: number, ends: number[]): boolean {
  return ends.some((e) => {
    const dr = Math.abs(Math.floor(q / W) - Math.floor(e / W)), dc = Math.abs((q % W) - (e % W));
    return Math.max(dr, dc) <= 1 || (dr === 1 && dc === 2) || (dr === 2 && dc === 1);
  });
}

function crossesBarrier(pis: number[], W: number, barrier: Uint8Array): boolean {
  const ends = [pis[0], pis[pis.length - 1]];
  for (let k = 1; k < pis.length; k++) {
    const r0 = Math.floor(pis[k - 1] / W), c0 = pis[k - 1] % W, r1 = Math.floor(pis[k] / W), c1 = pis[k] % W;
    if (Math.hypot(r1 - r0, c1 - c0) < 2.3) continue;
    const m = Math.ceil(Math.hypot(r1 - r0, c1 - c0) * 10);
    for (let s = 0; s <= m; s++) {
      const t = s / m;
      const q = Math.round(r0 + (r1 - r0) * t) * W + Math.round(c0 + (c1 - c0) * t);
      if (barrier[q] === 1 && !guarded(q, W, ends)) return true;
    }
  }
  return false;
}

describe('reducePath', () => {
  it('collapses a staircase on a uniform grid', () => {
    const W = 40, path: number[] = [];
    for (let k = 0; k < 20; k++) { path.push(k * W + k); path.push(k * W + k + 1); }
    path.push(20 * W + 20);
    const r = reducePath({ width: W, height: W, cost: grid(W, W), cellM: 30, path });
    expect(r.pis.length).toBeLessThanOrEqual(3);
    expect(r.pis[0]).toBe(path[0]);
    expect(r.pis.at(-1)).toBe(path.at(-1));
    expect(r.cost).toBeLessThanOrEqual(r.rawCost * 1.005);
  });

  it('keeps a PI at the corner of an L around a barrier block', () => {
    const W = 30, barrier = new Uint8Array(W * W);
    for (let r = 0; r < 20; r++) for (let c = 5; c < 25; c++) barrier[r * W + c] = 1;
    const path: number[] = [];
    for (let r = 0; r <= 25; r++) path.push(r * W + 2);
    for (let c = 3; c <= 27; c++) path.push(25 * W + c);
    for (let r = 24; r >= 0; r--) path.push(r * W + 27);
    const r = reducePath({ width: W, height: W, cost: grid(W, W), barrier, cellM: 30, path });
    // The block's corner is (19, 5): a PI at row 19 on column 2 clears it.
    expect(r.pis.some((p) => Math.floor(p / W) >= 19 && p % W <= 5)).toBe(true);
    expect(r.pis.length).toBeGreaterThan(2);
    expect(crossesBarrier(r.pis, W, barrier)).toBe(false);
  });

  it('keeps PIs at a narrow gap', () => {
    const W = 31, barrier = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) if (r !== 20) for (let c = 14; c <= 16; c++) barrier[r * W + c] = 1;
    const s = solve({ width: W, height: W, cost: grid(W, W), barrier, cellM: 30, start: 2 * W + 2, goal: 2 * W + 28 });
    if (!s.ok) throw new Error(s.error);
    const r = reducePath({ width: W, height: W, cost: grid(W, W), barrier, cellM: 30, path: s.path });
    expect(crossesBarrier(r.pis, W, barrier)).toBe(false);
    expect(r.pis.some((p) => Math.floor(p / W) === 20 && p % W >= 13 && p % W <= 17)).toBe(true);
    expect(r.cost).toBeLessThanOrEqual(r.rawCost * 1.005);
  });

  it('reduces a path that starts inside a barrier (endpoint guard)', () => {
    const W = 20, barrier = new Uint8Array(W * W);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) barrier[r * W + c] = 1;
    const cost = grid(W, W);
    const s = solve({ width: W, height: W, cost, barrier, cellM: 30, start: 0, goal: 19 * W + 19 });
    if (!s.ok) throw new Error(s.error);
    const r = reducePath({ width: W, height: W, cost, barrier, cellM: 30, path: s.path });
    expect(r.pis.length).toBeLessThan(s.path.length);
  });

  it('on real solve() output over a random grid: bounded cost, no crossings, endpoints kept', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 120, cost = new Float32Array(W * W), barrier = new Uint8Array(W * W);
    for (let i = 0; i < cost.length; i++) { cost[i] = 1 + rnd() * 4; barrier[i] = rnd() < 0.08 ? 1 : 0; }
    const start = 5 * W + 5, goal = 110 * W + 112;
    for (const e of [start, goal]) barrier[e] = 0;
    const s = solve({ width: W, height: W, cost, barrier, cellM: 30, start, goal });
    if (!s.ok) throw new Error(s.error);
    const r = reducePath({ width: W, height: W, cost, barrier, cellM: 30, path: s.path });
    expect(r.pis[0]).toBe(start);
    expect(r.pis.at(-1)).toBe(goal);
    expect(r.pis.length).toBeLessThan(s.path.length);
    expect(r.cost).toBeLessThanOrEqual(r.rawCost * 1.005 + 1e-6);
    expect(r.rawCost).toBeCloseTo(s.cost, 3);
    expect(crossesBarrier(r.pis, W, barrier)).toBe(false);
  });

  it('the drawn PI line, sampled 1000×/cell, costs ≤ (1 + δ) × raw on grids with 4 % 1000× cells', () => {
    const W = 60, cellM = 250, delta = 0.005;
    let worst = 0;
    for (let seed0 = 1; seed0 <= 24; seed0++) {
      let seed = seed0 * 7919;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const cost = new Float32Array(W * W);
      for (let i = 0; i < cost.length; i++) cost[i] = rnd() < 0.04 ? 1000 : 1 + rnd();
      const start = 2 * W + 2, goal = 57 * W + 50;
      cost[start] = cost[goal] = 1;
      const s = solve({ width: W, height: W, cost, cellM, start, goal });
      if (!s.ok) throw new Error(s.error);
      const r = reducePath({ width: W, height: W, cost, cellM, path: s.path, delta });
      // Point-sample the polyline through cell centres; the offset keeps samples off exact corners.
      let sampled = 0;
      for (let k = 1; k < r.pis.length; k++) {
        const y0 = Math.floor(r.pis[k - 1] / W) + 0.5, x0 = (r.pis[k - 1] % W) + 0.5;
        const y1 = Math.floor(r.pis[k] / W) + 0.5, x1 = (r.pis[k] % W) + 0.5;
        const len = Math.hypot(x1 - x0, y1 - y0), m = Math.ceil(len * 1000);
        for (let q = 0; q < m; q++) {
          const t = (q + 0.5 + 1e-3 / Math.PI) / m;
          sampled += cost[Math.floor(y0 + (y1 - y0) * t) * W + Math.floor(x0 + (x1 - x0) * t)] * (len / m) * cellM;
        }
      }
      expect(r.cost).toBeLessThanOrEqual((1 + delta) * r.rawCost + 1e-6);
      expect(Math.abs(sampled - r.cost)).toBeLessThanOrEqual(r.rawCost * 1e-3);
      expect(sampled).toBeLessThanOrEqual((1 + delta) * r.rawCost * (1 + 1e-3));
      worst = Math.max(worst, sampled / r.rawCost);
    }
    expect(worst).toBeLessThanOrEqual(1 + delta + 1e-3);
  });

  it('spends one budget over the whole line: fewer PIs than a per-segment ratio, total within (1 + δ) × raw', () => {
    // Cell-to-cell texture (weights 1 or 2.25, like forest cells).
    let seed = 4242;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 160, cellM = 250, delta = 0.005, cost = new Float32Array(W * W);
    for (let k = 0; k < cost.length; k++) cost[k] = rnd() < 0.35 ? 2.25 : 1;
    const start = 4 * W + 4, goal = 150 * W + 120;
    cost[start] = cost[goal] = 1;
    const s = solve({ width: W, height: W, cost, cellM, start, goal });
    if (!s.ok) throw new Error(s.error);
    const r = reducePath({ width: W, height: W, cost, cellM, path: s.path, delta });
    expect(r.cost).toBeLessThanOrEqual((1 + delta) * r.rawCost + 1e-6);
    expect(r.pis[0]).toBe(start);
    expect(r.pis.at(-1)).toBe(goal);

    // Reference: greedy farthest-reach with each segment held to (1 + δ) × its own raw cells.
    const line = (u: number, v: number) => {
      let t = 0;
      traverse(u % W + 0.5, Math.floor(u / W) + 0.5, v % W + 0.5, Math.floor(v / W) + 0.5, (c, rr, len) => { t += cost[rr * W + c] * len * cellM; });
      return t;
    };
    const prefix = [0];
    for (let k = 1; k < s.path.length; k++) prefix.push(prefix[k - 1] + line(s.path[k - 1], s.path[k]));
    let i = 0, perSegment = 1;
    while (i < s.path.length - 1) {
      let best = i + 1;
      for (let j = i + 2, fails = 0; j < s.path.length && fails < 64; j++) {
        if (line(s.path[i], s.path[j]) <= (1 + delta) * (prefix[j] - prefix[i])) { best = j; fails = 0; } else fails++;
      }
      i = best; perSegment++;
    }
    expect(r.pis.length).toBeLessThan(perSegment * 0.85);  // 41 vs 52 here
  });

  it('a ~3000-cell path past MAX_SPAN with uniform and textured stretches stays within (1 + δ) × raw', () => {
    let seed = 31337;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 3100, H = 60, cellM = 250, delta = 0.005, cost = new Float32Array(W * H), barrier = new Uint8Array(W * H);
    for (let k = 0; k < cost.length; k++) {
      const c = k % W;
      cost[k] = c > 1000 && c < 1800 && rnd() < 0.35 ? 2.25 : 1;
      barrier[k] = c > 2200 && c < 2600 && rnd() < 0.05 ? 1 : 0;
    }
    const start = 30 * W + 5, goal = 20 * W + W - 5;
    barrier[start] = barrier[goal] = 0;
    const s = solve({ width: W, height: H, cost, barrier, cellM, start, goal });
    if (!s.ok) throw new Error(s.error);
    const r = reducePath({ width: W, height: H, cost, barrier, cellM, path: s.path, delta });
    expect(s.path.length).toBeGreaterThan(2900);
    expect(r.pis[0]).toBe(start);
    expect(r.pis.at(-1)).toBe(goal);
    expect(r.cost).toBeLessThanOrEqual((1 + delta) * r.rawCost + 1e-6);
    expect(crossesBarrier(r.pis, W, barrier)).toBe(false);
    for (let k = 1; k < r.pis.length; k++) expect(s.path.indexOf(r.pis[k]) - s.path.indexOf(r.pis[k - 1])).toBeLessThanOrEqual(512);
  });

  it.skipIf(env.ROUTE_SKIP_PERF === '1')('perf: a uniform ~3000-cell path reduces in < 1 s', () => {
    const W = 3200, H = 400, cost = grid(W, H);
    const s = solve({ width: W, height: H, cost, cellM: 250, start: 200 * W + 5, goal: 200 * W + W - 5, maxCells: W * H });
    if (!s.ok) throw new Error(s.error);
    expect(s.path.length).toBeGreaterThan(3000);
    const t = performance.now();
    const r = reducePath({ width: W, height: H, cost, cellM: 250, path: s.path });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.pis.length).toBeLessThanOrEqual(10);  // ≥ 8: one segment spans ≤ 512 cells
    expect(r.cost).toBeLessThanOrEqual(1.005 * r.rawCost + 1e-6);
  });
});
