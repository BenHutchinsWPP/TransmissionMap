// nearest.ts: the grid index gives the same distances as a brute-force
// haversine scan (random fixtures, the antimeridian, the poles, sparse and
// clustered targets), no-target and bad-point cases, and the time it takes
// over the plan's size (34k points × 55k targets).
import { describe, it, expect } from 'vitest';
import { nearest, haversineKm, type LonLat } from './nearest.js';

/** A seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const box = (r: () => number, n: number, [w, s, e, nn]: number[]): LonLat[] =>
  Array.from({ length: n }, () => [w + r() * (e - w), s + r() * (nn - s)] as LonLat);

function brute(points: readonly LonLat[], targets: readonly LonLat[]) {
  return points.map(p => targets.reduce((b, t) => Math.min(b, haversineKm(p, t)), Infinity));
}

function same(points: LonLat[], targets: LonLat[], cellDeg?: number) {
  const r = nearest(points, targets, cellDeg ? { cellDeg } : {});
  const want = brute(points, targets);
  points.forEach((_, i) => {
    expect(r.km[i]).toBeCloseTo(want[i], 9);
    expect(haversineKm(points[i], targets[r.to[i]])).toBeCloseTo(r.km[i], 9);
  });
}

describe('haversineKm', () => {
  it('measures known distances', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.195, 2);
    expect(haversineKm([-0.1278, 51.5074], [2.3522, 48.8566])).toBeCloseTo(343.5, 0);   // London–Paris
    expect(haversineKm([179.9, 0], [-179.9, 0])).toBeCloseTo(22.24, 1);
    expect(haversineKm([10, 20], [10, 20])).toBe(0);
  });
});

describe('nearest', () => {
  it('matches a brute-force scan over the continental US', () => {
    const r = rng(1);
    same(box(r, 400, [-125, 25, -66, 49]), box(r, 900, [-125, 25, -66, 49]));
  });

  it('matches it with sparse far targets, clustered targets and a forced small cell (rings past MAX_RING)', () => {
    const r = rng(2);
    same(box(r, 200, [-180, -80, 180, 80]), box(r, 7, [-180, -80, 180, 80]));
    same(box(r, 200, [-125, 25, -66, 49]), box(r, 300, [-100, 30, -99, 31]));
    same(box(r, 100, [-125, 25, -66, 49]), box(r, 50, [10, 40, 20, 50]), 0.15);
  });

  it('wraps at the antimeridian and holds near the poles', () => {
    same([[179.95, 10], [-179.95, -10], [180, 0]], [[-179.9, 10], [179.9, -10], [170, 0], [-170, 0]]);
    const r = rng(3);
    same(box(r, 100, [-180, 80, 180, 90]), box(r, 100, [-180, 75, 180, 90]));
    same(box(r, 100, [-180, -90, 180, -80]), box(r, 30, [-180, -90, 180, -70]));
  });

  it('no targets, or a point that is not a finite [lon, lat]: NaN and -1', () => {
    const none = nearest([[0, 0]], []);
    expect(Number.isNaN(none.km[0])).toBe(true);
    expect(none.to[0]).toBe(-1);
    const bad = nearest([[NaN, 0], [0, 95], [1, 1]], [[1, 1], [Infinity, 0]]);
    expect([...bad.to]).toEqual([-1, -1, 0]);
    expect(bad.km[2]).toBe(0);
  });

  it('returns the original index of the nearest target, skipping bad targets', () => {
    const r = nearest([[0, 0], [5, 5]], [[NaN, 1], [4.9, 5], [0.1, 0]]);
    expect([...r.to]).toEqual([2, 1]);
  });

  it('world points to one country\'s targets (most far away): exact and fast', () => {
    const r = rng(5);
    const pts = box(r, 5_000, [-180, -60, 180, 75]), tg = box(r, 56_000, [-125, 25, -66, 49]);
    const t0 = performance.now();
    const res = nearest(pts, tg);
    const ms = performance.now() - t0;
    console.log(`nearest 5k world × 56k US: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
    for (let i = 0; i < 5_000; i += 50) expect(res.km[i]).toBeCloseTo(brute([pts[i]], tg)[0], 9);
  });

  it('34k points × 55k targets over the US in well under a second', () => {
    const r = rng(4);
    const pts = box(r, 34_000, [-125, 25, -66, 49]), tg = box(r, 55_000, [-125, 25, -66, 49]);
    const t0 = performance.now();
    const res = nearest(pts, tg);
    const ms = performance.now() - t0;
    console.log(`nearest 34k × 55k: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
    // Spot-check 200 of them against the brute force.
    for (let i = 0; i < 34_000; i += 170) expect(res.km[i]).toBeCloseTo(brute([pts[i]], tg)[0], 9);
  });
});
