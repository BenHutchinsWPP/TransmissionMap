// ─── Proximity parity harness ───────────────────────────────────────────────
// Role: holds every method in METHODS to the oracle (m0, brute-force WGS84 geodesic)
//       on seeded datasets D1–D5 at 0.1–500 km, each plain and with ids (buses
//       sharing an id never pair), plus small explicit cases (chain transitivity,
//       duplicates, antimeridian, poles, invalid rows, ids, threshold range, group
//       numbering). Results must match exactly: group, groups, size, skipped;
//       nearestKm within 1e-9 km (NaN equals NaN). proximityPairs is held to the
//       brute-force pair list (n ≤ 3,000), to its cap, and to early stopping.
//
// Deps: ./methods.js, ./oracle.js, ./geodesic.js, ./proximity.js, ./fixtures.js, ./types.js.

import { describe, expect, it } from 'vitest';
import { METHODS } from './methods.js';
import { oracle, oraclePairs } from './oracle.js';
import { geodesicKm } from './geodesic.js';
import { proximityPairs } from './proximity.js';
import { d1Uniform, d2Clustered, d3Disc, d4Chains, d5Edges, withBuses, type Points } from './fixtures.js';
import type { PairsResult, ProximityMethod, ProximityResult } from './types.js';

const N = 2000;
const D3N = 500; // a complete graph: n²/2 geodesics in the oracle
const THRESHOLDS = [0.1, 1, 5, 25, 100, 500];
const DATASETS: Record<string, (km: number) => Points> = {
  D1: () => d1Uniform(N, 11),
  D2: () => d2Clustered(N, 22),
  D3: (km) => d3Disc(D3N, 33, km),
  D4: (km) => d4Chains(N, 44, km),
  D5: (km) => d5Edges(N, 55, km),
};

const dist = geodesicKm;
const f64 = (...v: number[]) => Float64Array.from(v);

function expectSame(got: ProximityResult, want: ProximityResult, margin = 1e-9) {
  expect(got.skipped).toBe(want.skipped);
  expect(got.groups).toBe(want.groups);
  expect(Array.from(got.group)).toEqual(Array.from(want.group));
  expect(Array.from(got.size)).toEqual(Array.from(want.size));
  expect(got.nearestKm.length).toBe(want.nearestKm.length);
  for (let i = 0; i < want.nearestKm.length; i++) {
    const a = got.nearestKm[i], b = want.nearestKm[i];
    if (Number.isNaN(b)) expect(a, `nearestKm[${i}]`).toBeNaN();
    else expect(Math.abs(a - b), `nearestKm[${i}]`).toBeLessThanOrEqual(margin);
  }
}

const oracleCache = new Map<string, ProximityResult>();
function want(name: string, km: number, p: Points & { ids?: Int32Array }) {
  const key = `${name}@${km}`;
  let r = oracleCache.get(key);
  if (!r) { r = oracle(p.lon, p.lat, km, { ids: p.ids }); oracleCache.set(key, r); }
  return r;
}

const candidates = Object.entries(METHODS).filter(([id]) => id !== "m0");

describe('oracle', () => {
  it('chains 1-2-3 transitively although 1 and 3 are far apart', () => {
    // ~0.9 km apart steps along a meridian: 1-2 and 2-3 within 1 km, 1-3 at ~1.8 km
    const step = 0.9 / 111.19492664455873;
    const r = oracle(f64(0, 0, 0, 5), f64(0, step, 2 * step, 5), 1);
    expect(dist(0, 0, 0, 2 * step)).toBeGreaterThan(1);
    expect(Array.from(r.group)).toEqual([1, 1, 1, 0]);
    expect(r.groups).toBe(1);
    expect(Array.from(r.size)).toEqual([3, 3, 3, 0]);
    expect(r.nearestKm[0]).toBeCloseTo(dist(0, 0, 0, step), 9);
    expect(r.nearestKm[1]).toBeCloseTo(dist(0, 0, 0, step), 9);
    expect(r.nearestKm[3]).toBeNaN();
  });

  it('duplicates are 0 km apart and group', () => {
    const r = oracle(f64(10, 10, 20), f64(10, 10, 20), 0.01);
    expect(Array.from(r.group)).toEqual([1, 1, 0]);
    expect(r.nearestKm[0]).toBe(0);
  });

  it('is inclusive at the threshold', () => {
    const d = dist(0, 0, 0, 0.01);
    const r = oracle(f64(0, 0), f64(0, 0.01), Math.max(d, 0.01));
    expect(r.groups).toBe(1);
  });

  it('joins across the antimeridian', () => {
    const r = oracle(f64(179.999, -179.999, 0), f64(0, 0, 0), 1);
    expect(Array.from(r.group)).toEqual([1, 1, 0]);
    expect(r.nearestKm[0]).toBeCloseTo(dist(179.999, 0, -179.999, 0), 9);
  });

  it('joins points at opposite longitudes near a pole', () => {
    const r = oracle(f64(0, 180, 90), f64(89.99, 89.99, 0), 5);
    expect(Array.from(r.group)).toEqual([1, 1, 0]);
    const poles = oracle(f64(0, 77), f64(90, 90), 0.01);
    expect(poles.groups).toBe(1);
  });

  it('skips invalid rows', () => {
    const r = oracle(f64(NaN, 1, 1, 200, 1, Infinity, 1), f64(0, 95, 0, 0, 0, 0, 0), 1);
    expect(r.skipped).toBe(4);
    expect(Array.from(r.group)).toEqual([0, 0, 1, 0, 1, 0, 1]);
    expect(r.groups).toBe(1);
  });

  it('numbers groups by lowest row index', () => {
    const r = oracle(f64(50, 0, 50, 0, 100, 100, 50), f64(0, 0, 0, 0, 0, 0, 0), 1);
    expect(Array.from(r.group)).toEqual([1, 2, 1, 2, 3, 3, 1]);
    expect(r.groups).toBe(3);
    expect(Array.from(r.size)).toEqual([3, 2, 3, 2, 2, 2, 3]);
  });

  it('refuses a threshold outside 0.01–1000 km', () => {
    for (const km of [0, 0.009, 1000.01, -1, NaN, Infinity]) {
      expect(() => oracle(f64(0), f64(0), km)).toThrow(RangeError);
    }
    expect(() => oracle(f64(0), f64(0), 0.01)).not.toThrow();
    expect(() => oracle(f64(0), f64(0), 1000)).not.toThrow();
  });

  it('handles empty input', () => {
    const r = oracle(new Float64Array(0), new Float64Array(0), 1);
    expect(r.groups).toBe(0);
    expect(r.group.length).toBe(0);
  });
});

describe('fixtures', () => {
  it('are deterministic and exactly n long', () => {
    for (const make of Object.values(DATASETS)) {
      const a = make(5), b = make(5);
      expect(a.lon.length).toBe(make === DATASETS.D3 ? D3N : N);
      expect(Array.from(a.lat)).toEqual(Array.from(b.lat));
    }
  });

  it('keep every pair out of the 1e-9 km band round the threshold (structured sets)', () => {
    for (const km of THRESHOLDS) {
      for (const name of ['D3', 'D4']) {
        const p = DATASETS[name](km);
        const m = 400;
        let inBand = 0;
        for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
          if (Math.abs(dist(p.lon[i], p.lat[i], p.lon[j], p.lat[j]) - km) <= 1e-9) inBand++;
        }
        expect(inBand).toBe(0);
      }
    }
  });

  it('exercise what each set is for', () => {
    const km = 5;
    expect(want('D3', km, DATASETS.D3(km)).groups).toBe(1);
    expect(want('D3', km, DATASETS.D3(km)).size[0]).toBe(D3N);
    const d4 = want('D4', km, DATASETS.D4(km));
    expect(d4.groups).toBeGreaterThan(20);
    expect(Math.max(...d4.size)).toBeGreaterThanOrEqual(30);
    const d5 = want('D5', km, DATASETS.D5(km));
    expect(d5.skipped).toBeGreaterThanOrEqual(8);
    expect(d5.groups).toBeGreaterThan(20);
    const d2 = want('D2', 1, DATASETS.D2(1));
    expect(d2.groups).toBeGreaterThan(10);
    expect(d2.group.some((g) => g === 0)).toBe(true);
  });
});

const IDS_SEED = 77;
const withIds = (name: string, km: number) => withBuses(DATASETS[name](km), IDS_SEED, km);

describe('oracle with ids', () => {
  it('never pairs equal ids, but a group can pass through other points', () => {
    const d = 0.004; // deg of lon at the equator, ~0.44 km
    // 0:id1 1:id2 2:id1: pairs 0-1 and 1-2 only (0-2 are equal ids), one group of three
    const r = oracle(f64(0, d, 2 * d), f64(0, 0, 0), 1, { ids: Int32Array.from([1, 2, 1]) });
    expect(Array.from(r.group)).toEqual([1, 1, 1]);
    // 0:id1 1:id1 alone together: no pair
    const s = oracle(f64(0, d), f64(0, 0), 1, { ids: Int32Array.from([1, 1]) });
    expect(s.groups).toBe(0);
    expect(s.nearestKm[0]).toBeNaN();
    // ids -1 pair freely; nearest skips a closer same-id point
    const t = oracle(f64(0, d / 4, 2 * d), f64(0, 0, 0), 1, { ids: Int32Array.from([5, 5, -1]) });
    expect(t.nearestKm[0]).toBeCloseTo(dist(0, 0, 2 * d, 0), 9);
    expect(() => oracle(f64(0), f64(0), 1, { ids: new Int32Array(2) })).toThrow(RangeError);
  });
});

describe.each(candidates)('method %s matches the oracle', (id, method: ProximityMethod) => {
  for (const [name, make] of Object.entries(DATASETS)) {
    for (const km of THRESHOLDS) {
      it(`${name} at ${km} km`, () => {
        const p = make(km);
        expectSame(method(p.lon, p.lat, km), want(name, km, p));
      });
      it(`${name} with ids at ${km} km`, () => {
        const p = withIds(name, km);
        expectSame(method(p.lon, p.lat, km, { ids: p.ids }), want(`${name}+ids`, km, p));
      });
    }
  }

  it('chain, duplicates, antimeridian, poles, invalid rows and order', () => {
    const step = 0.9 / 111.19492664455873;
    const cases: [Float64Array, Float64Array, number, Int32Array?][] = [
      [f64(0, 0, 0, 5), f64(0, step, 2 * step, 5), 1],
      [f64(10, 10, 20), f64(10, 10, 20), 0.01],
      [f64(179.999, -179.999, 0), f64(0, 0, 0), 1],
      [f64(0, 180, 90, 33), f64(89.99, 89.99, 0, 90), 5],
      [f64(NaN, 1, 1, 200, 1, Infinity, 1), f64(0, 95, 0, 0, 0, 0, 0), 1],
      [f64(50, 0, 50, 0, 100, 100, 50), f64(0, 0, 0, 0, 0, 0, 0), 1],
      [new Float64Array(0), new Float64Array(0), 1],
      [f64(0, 0.004, 0.008), f64(0, 0, 0), 1, Int32Array.from([1, 2, 1])],
      [f64(0, 0.001, 0.002, 0.003), f64(0, 0, 0, 0), 1, Int32Array.from([1, 1, 1, 1])],
    ];
    for (const [lon, lat, km, ids] of cases) expectSame(method(lon, lat, km, { ids }), oracle(lon, lat, km, { ids }));
  });

  it('refuses a threshold outside 0.01–1000 km and ids of the wrong length', () => {
    for (const km of [0, 0.009, 1000.01, NaN]) expect(() => method(f64(0), f64(0), km)).toThrow(RangeError);
    expect(() => method(f64(0), f64(0), 1, { ids: new Int32Array(2) })).toThrow(RangeError);
  });
});

function expectPairs(got: PairsResult, want: PairsResult) {
  expect(got.truncated).toBe(false);
  expect(Array.from(got.a)).toEqual(Array.from(want.a));
  expect(Array.from(got.b)).toEqual(Array.from(want.b));
  expect(got.km.length).toBe(want.km.length);
  for (let i = 0; i < want.km.length; i++) expect(Math.abs(got.km[i] - want.km[i])).toBeLessThanOrEqual(1e-9);
}

describe('proximityPairs matches the brute-force pair list', () => {
  const sets: [string, number, (km: number) => Points][] = [
    ['D1', 3000, () => d1Uniform(3000, 12)],
    ['D2', 3000, () => d2Clustered(3000, 23)],
    ['D3', 300, (km) => d3Disc(300, 34, km)],
    ['D4', 2000, (km) => d4Chains(2000, 45, km)],
    ['D5', 2000, (km) => d5Edges(2000, 56, km)],
  ];
  for (const [name, , make] of sets) {
    for (const km of [1, 25, 100]) {
      it(`${name} at ${km} km`, () => {
        const p = make(km);
        expectPairs(proximityPairs(p.lon, p.lat, km), oraclePairs(p.lon, p.lat, km));
      });
      it(`${name} with ids at ${km} km`, () => {
        const q = withBuses(make(km), IDS_SEED, km);
        const got = proximityPairs(q.lon, q.lat, km, { ids: q.ids });
        expectPairs(got, oraclePairs(q.lon, q.lat, km, { ids: q.ids }));
        for (let i = 0; i < got.a.length; i++) expect(q.ids[got.a[i]] < 0 || q.ids[got.a[i]] !== q.ids[got.b[i]]).toBe(true);
      });
    }
  }

  it('rows are a < b and sorted by group, distance, a, b', () => {
    const p = d2Clustered(1500, 24), r = proximityPairs(p.lon, p.lat, 25), grp = oracle(p.lon, p.lat, 25).group;
    expect(r.a.length).toBeGreaterThan(100);
    for (let i = 0; i < r.a.length; i++) {
      expect(r.a[i]).toBeLessThan(r.b[i]);
      expect(grp[r.a[i]]).toBe(grp[r.b[i]]);
      if (i) expect([grp[r.a[i - 1]], r.km[i - 1], r.a[i - 1], r.b[i - 1]] <= [grp[r.a[i]], r.km[i], r.a[i], r.b[i]] || true).toBe(true);
    }
    for (let i = 1; i < r.a.length; i++) {
      const prev = [grp[r.a[i - 1]], r.km[i - 1], r.a[i - 1], r.b[i - 1]], cur = [grp[r.a[i]], r.km[i], r.a[i], r.b[i]];
      let c = 0;
      for (let k = 0; k < 4 && !c; k++) c = Math.sign(prev[k] - cur[k]);
      expect(c).toBeLessThanOrEqual(0);
    }
  });

  it('stops at max with truncated = true and returns real pairs', () => {
    const p = d3Disc(400, 35, 5), all = oraclePairs(p.lon, p.lat, 5);
    const key = (a: number, b: number) => a * 1e6 + b;
    const set = new Set(Array.from(all.a, (a, i) => key(a, all.b[i])));
    for (const max of [0, 1, 7, 1000]) {
      const r = proximityPairs(p.lon, p.lat, 5, { max });
      expect(r.truncated).toBe(true);
      expect(r.a.length).toBe(max);
      for (let i = 0; i < r.a.length; i++) expect(set.has(key(r.a[i], r.b[i]))).toBe(true);
    }
    const exact = proximityPairs(p.lon, p.lat, 5, { max: all.a.length });
    expect(exact.truncated).toBe(false);
    expect(exact.a.length).toBe(all.a.length);
    expect(proximityPairs(p.lon, p.lat, 5, { max: all.a.length - 1 }).truncated).toBe(true);
  });

  it('a dense 30,000-point set stops early: 10,000 pairs in under a second', () => {
    const p = d3Disc(30000, 33, 5);
    const t0 = performance.now();
    const r = proximityPairs(p.lon, p.lat, 5, { max: 10000 });
    const ms = performance.now() - t0;
    expect(r.truncated).toBe(true);
    expect(r.a.length).toBe(10000);
    expect(ms).toBeLessThan(1000);
  });
});
