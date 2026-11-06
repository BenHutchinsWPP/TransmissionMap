import { describe, it, expect } from 'vitest';
import { parseBatchCsv } from './batch-csv.js';
import { GRID_250, cellOfLngLat, lngLatOf } from './grid.js';

const H = 'key,a_lat,a_lon,b_lat,b_lon';
const ok = (t: string, o?: { savedNames?: string[] }) => {
  const r = parseBatchCsv(t, o);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe('parseBatchCsv', () => {
  it('parses a row; Reno lands inside the grid at its own cell', () => {
    const r = ok(`${H}\nreno,39.53,-119.81,39.0,-119.5\n`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ line: 2, key: 'reno', a: [-119.81, 39.53], b: [-119.5, 39] });
    const [c, rw] = cellOfLngLat(GRID_250, ...r.rows[0].a);
    expect(c).toBeGreaterThan(0); expect(c).toBeLessThan(GRID_250.cols);
    const [lo, la] = lngLatOf(GRID_250, c, rw);
    expect(Math.abs(lo + 119.81)).toBeLessThan(0.01); expect(Math.abs(la - 39.53)).toBeLessThan(0.01);
  });
  it('strips a BOM before the header and is case/space-insensitive', () => {
    const r = ok(`\uFEFF Key , A_LAT,a_lon,b_lat,B_Lon\r\nx,39.5,-119.8,39,-119.5\r\n`);
    expect(r.rows[0].key).toBe('x');
  });
  it('refuses an unknown column, a missing column, a duplicate column', () => {
    expect(parseBatchCsv(`${H},color\nx,39,-119,39,-118`)).toMatchObject({ ok: false });
    expect(parseBatchCsv('key,a_lat,a_lon,b_lat\nx,39,-119,39')).toMatchObject({ ok: false });
    expect(parseBatchCsv(`${H},key\nx,39,-119,39,-118,y`)).toMatchObject({ ok: false });
    expect(parseBatchCsv('')).toMatchObject({ ok: false });
  });
  it('accepts 200 rows, refuses 201', () => {
    const mk = (n: number) => H + '\n' + Array.from({ length: n }, (_, i) => `k${i},39.5,-119.8,39,-119.${i % 9}`).join('\n');
    expect(ok(mk(200)).rows).toHaveLength(200);
    expect(parseBatchCsv(mk(201))).toMatchObject({ ok: false });
  });
  it('gives reasons as i18n keys with parameters', () => {
    expect(parseBatchCsv(`${H},color\nx,39,-119,39,-118`)).toMatchObject({ ok: false, reason: 'route.batch.csv.unknownCol', params: { name: 'color' } });
    const r = ok(`${H}\nx,99,-119.8,39,-119.5`);
    expect(r.skipped[0]).toEqual({ line: 2, reason: 'route.batch.csv.outside', params: { name: 'a_lat', value: '99', lo: 24, hi: 50 } });
  });
  it('refuses a file over 1 MiB', () => {
    expect(parseBatchCsv(H + '\n' + 'x'.repeat(1024 * 1024))).toMatchObject({ ok: false });
  });
  it('skips a case-insensitive duplicate key and keeps going', () => {
    const r = ok(`${H}\nAbc,39.5,-119.8,39,-119.5\nabc,39.5,-119.8,39,-119.4\nz,39.5,-119.8,39,-119.3`);
    expect(r.rows.map((x) => x.key)).toEqual(['Abc', 'z']);
    expect(r.skipped).toEqual([{ line: 3, reason: 'route.batch.csv.dupKey' }]);
  });
  it('keeps a formula-looking key as text, strips control characters, bounds length', () => {
    const r = ok(`${H}\n"=HYPERLINK(""x"")",39.5,-119.8,39,-119.5\n"a\u0007b",39.5,-119.8,39,-119.4\n${'k'.repeat(61)},39.5,-119.8,39,-119.3\n"\u0001",39.5,-119.8,39,-119.2`);
    expect(r.rows.map((x) => x.key)).toEqual(['=HYPERLINK("x")', 'ab']);
    expect(r.skipped.map((s) => s.line)).toEqual([4, 5]);
  });
  it('skips swapped lat/lon and out-of-range values', () => {
    const r = ok(`${H}\nswap,-119.8,39.5,-119.5,39\nlow,20,-100,39,-100\nok,39.5,-119.8,39,-119.5`);
    expect(r.rows.map((x) => x.key)).toEqual(['ok']);
    expect(r.skipped.map((s) => s.line)).toEqual([2, 3]);
  });
  it('parses numbers strictly', () => {
    for (const bad of ['', ' ', 'NaN', '1e400', '4e1', '39.5abc', '0x27', 'Infinity', '--39']) {
      const r = ok(`${H}\nx,${bad},-119.8,39,-119.5`);
      expect(r.rows, bad).toHaveLength(0);
      expect(r.skipped, bad).toHaveLength(1);
    }
  });
  it('skips A = B and wrong cell counts', () => {
    const r = ok(`${H}\nsame,39.5,-119.8,39.5,-119.8\nshort,39.5,-119.8\nlong,39.5,-119.8,39,-119.5,9`);
    expect(r.skipped.map((s) => s.line)).toEqual([2, 3, 4]);
  });
  it('reads optional columns and validates them', () => {
    const t = `key,a_lat,a_lon,b_lat,b_lon,line_type,method,alternatives,pictures\n` +
      `1,39.5,-119.8,39,-119.5,ac345,tm-default,2,"route,Cost,cost"\n` +
      `2,39.5,-119.8,39,-119.5,,custom:abc_1,,\n` +
      `3,39.5,-119.8,39,-119.5,,My method,,\n` +
      `4,39.5,-119.8,39,-119.5,,nope,,\n` +
      `5,39.5,-119.8,39,-119.5,,,4,\n` +
      `6,39.5,-119.8,39,-119.5,,,,route|cost\n` +
      `7,39.5,-119.8,39,-119.5,ac 345,,,\n`;
    const r = ok(t, { savedNames: ['My method'] });
    expect(r.rows[0]).toMatchObject({ lineType: 'ac345', method: 'tm-default', alternatives: 2, pictures: ['route', 'cost'] });
    expect(r.rows.map((x) => x.key)).toEqual(['1', '2', '3']);
    expect(r.rows[2].method).toBe('My method');
    expect(r.skipped.map((s) => s.line)).toEqual([5, 6, 7, 8]);
  });
  it('does not accept a saved name when none are given', () => {
    expect(ok(`key,a_lat,a_lon,b_lat,b_lon,method\nx,39.5,-119.8,39,-119.5,My method`).rows).toHaveLength(0);
  });
});
