import { describe, expect, it } from 'vitest';
import { assembleWays, distM, faultPosition, linePieces, orderPieces, orientEnds, pathLengthM, pointAt, sliceAt, type Pos } from './along.js';

// On the equator a degree of longitude is R·π/180 metres exactly, so distances are known in closed form.
const DEG_M = 6371.0088e3 * Math.PI / 180;
const ls = (c: Pos[]): GeoJSON.LineString => ({ type: 'LineString', coordinates: c });
const near = (a: number, b: number, rel = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel + 1e-9);

describe('lengths and walking', () => {
  const line: Pos[] = [[0, 0], [1, 0], [3, 0]];
  it('the length of a known polyline', () => near(pathLengthM(line), 3 * DEG_M));
  it('a point along it, to 1e-6 relative', () => {
    const p = pointAt(line, 2 * DEG_M);
    near(p[0], 2); expect(Math.abs(p[1])).toBeLessThan(1e-9);
    near(distM([0, 0], pointAt(line, 0.25 * DEG_M)), 0.25 * DEG_M);
  });
  it('a point on a meridian segment lies on the great circle', () => {
    const p = pointAt([[10, 40], [10, 50]], 5 * DEG_M);
    near(p[0], 10); near(p[1], 45);
  });
  it('clamps to the ends', () => {
    expect(pointAt(line, -5)).toEqual([0, 0]);
    expect(pointAt(line, 10 * DEG_M)).toEqual([3, 0]);
  });
  it('slices between two distances, keeping the vertices inside', () => {
    const s = sliceAt(line, 0.5 * DEG_M, 2 * DEG_M);
    expect(s.length).toBe(3);
    near(s[0][0], 0.5); expect(s[1]).toEqual([1, 0]); near(s[2][0], 2);
    near(pathLengthM(s), 1.5 * DEG_M);
  });
});

describe('ordering pieces', () => {
  it('joins MultiLineString parts in any order and direction within 5 m', () => {
    const g: GeoJSON.MultiLineString = { type: 'MultiLineString', coordinates: [[[1, 0], [2, 0]], [[3, 0], [2, 0]], [[0, 0], [1, 0]]] };
    const r = orderPieces(linePieces(g));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line.map(p => p[0])).toEqual([0, 1, 2, 3]);
    near(r.lengthM, 3 * DEG_M);
    expect(r.line.length).toBe(4);   // shared vertices not repeated
  });
  it('accepts a gap of 4 m, refuses one of 6 m and returns the pieces', () => {
    const m4 = 4 / DEG_M, m6 = 6 / DEG_M;
    expect(orderPieces([[[0, 0], [1, 0]], [[1 + m4, 0], [2, 0]]]).ok).toBe(true);
    const bad = orderPieces([[[0, 0], [1, 0]], [[1 + m6, 0], [2, 0]]]);
    expect(bad).toMatchObject({ ok: false, reason: 'disconnected' });
    if (!bad.ok) expect(bad.pieces.length).toBe(2);
  });
  it('an empty geometry is refused', () => {
    expect(orderPieces(linePieces({ type: 'Point', coordinates: [0, 0] }))).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('assembling a chain', () => {
  it('follows `rev` so the chain runs from end A to end B', () => {
    const r = assembleWays([
      { rev: false, geometry: ls([[0, 0], [1, 0]]) },
      { rev: true, geometry: ls([[2, 0], [1, 0]]) },
      { rev: true, geometry: ls([[3, 0], [2, 0]]) },
    ]);
    expect(r.ok && r.line.map(p => p[0])).toEqual([0, 1, 2, 3]);
  });
  it('flips a way that meets the previous one only backwards', () => {
    const r = assembleWays([{ rev: false, geometry: ls([[0, 0], [1, 0]]) }, { rev: false, geometry: ls([[2, 0], [1, 0]]) }]);
    expect(r.ok && r.line.map(p => p[0])).toEqual([0, 1, 2]);
  });
  it('refuses ways that do not meet, with every piece', () => {
    const r = assembleWays([{ rev: false, geometry: ls([[0, 0], [1, 0]]) }, { rev: false, geometry: ls([[1.5, 0], [2, 0]]) }]);
    expect(r).toMatchObject({ ok: false, reason: 'disconnected' });
    if (!r.ok) expect(r.pieces.length).toBe(2);
  });
  it('a way that is itself in disconnected parts refuses the chain', () => {
    const multi: GeoJSON.MultiLineString = { type: 'MultiLineString', coordinates: [[[1, 0], [2, 0]], [[2.5, 0], [3, 0]]] };
    expect(assembleWays([{ rev: false, geometry: ls([[0, 0], [1, 0]]) }, { rev: false, geometry: multi }]))
      .toMatchObject({ ok: false, reason: 'disconnected' });
  });
});

describe('fault position', () => {
  const L = 100_000;
  it('from A and from B sum to the line length', () => {
    const a = faultPosition({ lengthM: L, distM: 16_093.44, from: 'A', pct: 2 });
    const b = faultPosition({ lengthM: L, distM: 16_093.44, from: 'B', pct: 2 });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { near(a.alongM, 16_093.44); near(a.alongM + (L - b.alongM), 2 * 16_093.44); near(b.alongM, L - 16_093.44); }
  });
  it('the ±% span is of the line length, clipped at the ends', () => {
    const r = faultPosition({ lengthM: L, distM: 1000, from: 'A', pct: 2 });
    expect(r).toMatchObject({ ok: true, lowM: 0, highM: 3000 });
    const m = faultPosition({ lengthM: L, distM: 50_000, from: 'B', pct: 2 });
    expect(m).toMatchObject({ ok: true, lowM: 48_000, highM: 52_000 });
  });
  it('scales by the relay line length', () => {
    const r = faultPosition({ lengthM: L, distM: 40_000, from: 'A', relayLengthM: 80_000, pct: 2 });
    expect(r).toMatchObject({ ok: true, alongM: 50_000, mapDistM: 50_000 });
  });
  it('a distance past the far end is refused, the line length itself is not', () => {
    expect(faultPosition({ lengthM: L, distM: L + 1, from: 'A', pct: 2 })).toEqual({ ok: false, reason: 'beyond' });
    expect(faultPosition({ lengthM: L, distM: L, from: 'B', pct: 2 })).toMatchObject({ ok: true, alongM: 0 });
    expect(faultPosition({ lengthM: L, distM: 90_000, from: 'A', relayLengthM: 80_000, pct: 2 })).toEqual({ ok: false, reason: 'beyond' });
  });
  it('bad numbers are invalid', () => {
    expect(faultPosition({ lengthM: L, distM: -1, from: 'A', pct: 2 })).toEqual({ ok: false, reason: 'invalid' });
    expect(faultPosition({ lengthM: L, distM: NaN, from: 'A', pct: 2 })).toEqual({ ok: false, reason: 'invalid' });
    expect(faultPosition({ lengthM: L, distM: 1, from: 'A', relayLengthM: 0, pct: 2 })).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('orienting named ends', () => {
  const s0: Pos = [0, 0], e0: Pos = [1, 0], m = 1 / DEG_M;
  it('keeps the order when the first name sits at the start', () => {
    expect(orientEnds(s0, e0, [[0, 500 * m]], [[1, 0]])).toEqual({ swap: false });
  });
  it('swaps when the names sit the other way round', () => {
    expect(orientEnds(s0, e0, [[1, 100 * m]], [[0, 0]])).toEqual({ swap: true });
  });
  it('one name is enough; the nearest of several same-named points counts', () => {
    expect(orientEnds(s0, e0, [[5, 5], [1, 200 * m]], [])).toEqual({ swap: true });
  });
  it('nothing within reach of either end is unknown', () => {
    expect(orientEnds(s0, e0, [[0.5, 0]], [[3, 3]])).toBeNull();
    expect(orientEnds(s0, e0, [], [])).toBeNull();
  });
});
