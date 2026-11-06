// Tests for proximity-rows.ts: filter, stable sort, rank, range TSV, and 1M-pair limits.
import { describe, it, expect } from 'vitest';
import { viewOrder, rankOf, rangeTsvOf, numberFormat, type ProxCol } from './proximity-rows.js';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const names = ['Bravo', 'alpha', 'S10', 'S9', '', 'Alpha'];
const nums: number[] = [3, 1, NaN, 2, 1, 5];
const ids = [1, 2, 3, 4, 5, 6];
const loc = 'en';
const rk = rankOf(names.length, i => names[i], loc);
const cols: ProxCol[] = [
  { field: 'name', title: 'Name', num: false, text: k => names[k], value: k => names[k], rank: k => rk[k] },
  { field: 'n', title: 'N', num: true, text: k => (Number.isNaN(nums[k]) ? '' : numberFormat(loc, 0).format(nums[k] * 1000)), value: k => nums[k] },
  { field: 'id', title: 'ID', num: true, text: k => String(ids[k]), value: k => ids[k] },
];
const base = Int32Array.from([0, 1, 2, 3, 4, 5]);
const f = (o: Record<string, string>) => new Map(Object.entries(o));
const view = (sort: { field: string; dir: 1 | -1 } | null, fl: Record<string, string> = {}) => Array.from(viewOrder(base, cols, sort, f(fl)));

describe('filter', () => {
  it('contains, case-insensitive, on the text', () => expect(view(null, { name: 'ALPHA' })).toEqual([1, 5]));
  it('matches the raw value too', () => {
    const c: ProxCol[] = [{ field: 'w', title: 'W', num: true, text: () => 'shown', value: k => ids[k] * 10 }];
    expect(Array.from(viewOrder(base, c, null, f({ w: '30' })))).toEqual([2]);
  });
  it('matches the displayed text', () => expect(view(null, { n: '3,000' })).toEqual([0]));
  it('ANDs columns', () => expect(view(null, { name: 'alpha', id: '6' })).toEqual([5]));
  it('ignores an empty filter and an unknown field', () => expect(view(null, { name: ' ', zz: 'x' })).toEqual([0, 1, 2, 3, 4, 5]));
  it('does not mutate the base', () => { view({ field: 'n', dir: -1 }, { name: 'a' }); expect(Array.from(base)).toEqual([0, 1, 2, 3, 4, 5]); });
});

describe('sort', () => {
  it('ties keep base order', () => expect(view({ field: 'n', dir: 1 }).slice(0, 2)).toEqual([1, 4]));
  it('ties keep base order descending', () => expect(view({ field: 'n', dir: -1 }).slice(1, 4)).toEqual([0, 3, 1]));
  it('numbers asc and desc, NaN last both ways', () => {
    expect(view({ field: 'n', dir: 1 })).toEqual([1, 4, 3, 0, 5, 2]);
    expect(view({ field: 'n', dir: -1 })).toEqual([5, 0, 3, 1, 4, 2]);
  });
  it('text by rank: numeric collation, empty last both ways', () => {
    expect(view({ field: 'name', dir: 1 })).toEqual([1, 5, 0, 3, 2, 4]);
    expect(view({ field: 'name', dir: -1 })).toEqual([2, 3, 0, 1, 5, 4]);
  });
  it('text without rank uses the collator', () => {
    const c2: ProxCol[] = [{ field: 'name', title: 'Name', num: false, text: k => names[k], value: k => names[k] }];
    expect(Array.from(viewOrder(base, c2, { field: 'name', dir: 1 }, new Map()))).toEqual([1, 5, 0, 3, 2, 4]);
  });
  it('sorts the filtered rows', () => expect(view({ field: 'id', dir: -1 }, { name: 's' })).toEqual([3, 2]));
});

describe('rankOf', () => {
  it('numeric collation and shared ranks', () => {
    const r = rankOf(4, i => ['S10', 'S9', 'a', 'A'][i], 'en');
    expect(r[1]).toBeLessThan(r[0]);
    expect(r[2]).toBe(r[3]);
  });
});

describe('rangeTsvOf', () => {
  it('header, formula guard, full precision', () => {
    const c: ProxCol[] = [
      { field: 'a', title: '=Title', num: false, text: () => '', value: k => (k ? '=1+1' : 'x\ty') },
      { field: 'b', title: 'Lat', num: true, text: () => '', value: () => 40.123456789012 },
    ];
    expect(rangeTsvOf(c, [0, 1])).toBe("'=Title\tLat\nx y\t40.123456789012\n'=1+1\t40.123456789012");
  });
});

describe('numberFormat', () => {
  it('is cached', () => expect(numberFormat('en', 3)).toBe(numberFormat('en', 3)));
});

describe.skipIf(env.PX_SKIP_PERF === '1')('1,000,000 pairs', () => {
  const P = 2000, N = 1_000_000;
  const pa = new Int32Array(N), dist = new Float64Array(N);
  for (let k = 0; k < N; k++) { pa[k] = (k * 7919) % P; dist[k] = ((k * 2654435761) % 100000) / 7; }
  const pname = (p: number) => `Site ${p % 997}-${p}`;
  const rank = rankOf(P, pname, 'en');
  const big: ProxCol[] = [
    { field: 'a', title: 'A', num: false, text: k => pname(pa[k]), value: k => pname(pa[k]), rank: k => rank[pa[k]],
      point: { count: P, of: k => pa[k], text: pname, value: pname } },
    { field: 'd', title: 'D', num: true, text: k => numberFormat('en', 3).format(dist[k]), value: k => dist[k] },
  ];
  const all = new Int32Array(N); for (let i = 0; i < N; i++) all[i] = i;
  const time = (fn: () => Int32Array) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r] as const; };
  it('sorts by a number under 1.5 s', () => {
    const [ms, r] = time(() => viewOrder(all, big, { field: 'd', dir: 1 }, new Map()));
    console.info('px sort num ms', Math.round(ms));
    expect(r.length).toBe(N); expect(dist[r[0]]).toBeLessThanOrEqual(dist[r[1]]); expect(ms).toBeLessThan(1500);
  });
  it('sorts by ranked text under 1.5 s', () => {
    const [ms, r] = time(() => viewOrder(all, big, { field: 'a', dir: -1 }, new Map()));
    console.info('px sort text ms', Math.round(ms));
    expect(rank[pa[r[0]]]).toBeGreaterThanOrEqual(rank[pa[r[N - 1]]]); expect(ms).toBeLessThan(1500);
  });
  it('filters one column under 1 s', () => {
    const [ms, r] = time(() => viewOrder(all, big, null, f({ a: 'site 12-' })));
    console.info('px filter ms', Math.round(ms));
    expect(r.length).toBeGreaterThan(0); expect(r.length).toBeLessThan(N); expect(ms).toBeLessThan(1000);
  });
});
