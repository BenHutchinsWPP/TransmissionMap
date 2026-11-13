// columns-read.ts over the mini columns Parquet in fixtures/analysis/ (fixtures/make-fixtures.py):
// pruning on vs off, row values (ids, nulls, measures), the columns a call reads,
// planned bytes against the bytes fetched, and parity with <ds>.features.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { resetRangeIo, requestLog, Fail, openFile } from '../parquet/range-io.js';
import { toMapLibreFilter, type Condition } from '../../src/registry/condition-compile.js';
import {
  columnsEntry, columnsMeta, pruneGroups, columnsFor, hasIdExpr, readGroups, readRowsAt, readTwoPhase,
  plannedBytes, rowOf, type ColumnsEntry, type ColumnsRow,
} from './columns-read.js';

const calls = vi.hoisted(() => ({ readRows: 0 }));
vi.mock('../parquet/range-io.js', async importOriginal => {
  const m = await importOriginal<typeof import('../parquet/range-io.js')>();
  return { ...m, readRows: (...a: Parameters<typeof m.readRows>) => { calls.readRows++; return m.readRows(...a); } };
});

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const LINES = 'osm_transmission_lines', RETAIL = 'retail_territories', POINTS = 'osm_substations_points';

function serve(url: string, init?: RequestInit): Response {
  if (!url.startsWith('data/analysis/')) return new Response('', { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + 'analysis/' + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
}

beforeEach(() => {
  resetRangeIo();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => serve(url, init)));
});

async function entry(ds: string): Promise<ColumnsEntry> {
  const got = await columnsEntry(ds);
  if (!got.ok) throw new Error(got.reason);
  return got.result;
}

async function collect(it: AsyncIterable<ColumnsRow>): Promise<ColumnsRow[]> {
  const out: ColumnsRow[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const allGroups = async (e: ColumnsEntry) => (await columnsMeta(e)).row_groups.map((_, i) => i);

// The map's own compile: condition-compile's toMapLibreFilter (which validates each
// condition against the field schema) run through style-spec featureFilter.
const testOf = (ds: string, conds: Condition[]) => {
  const f = featureFilter(toMapLibreFilter(ds, conds) as never, 'layers[0].filter');
  return (r: ColumnsRow) => f.filter({ zoom: 0 }, { type: r.type, properties: r.properties, id: r.id } as never);
};

const CASES: [string, Condition[]][] = [
  [LINES, [{ field: 'nominal_kv', op: '=', value: 345 }]],
  [LINES, [{ field: 'nominal_kv', op: '=', value: 999 }]],
  [LINES, [{ field: 'nominal_kv', op: '>', value: 400 }]],
  [LINES, [{ field: 'nominal_kv', op: '>=', value: 400 }]],
  [LINES, [{ field: 'nominal_kv', op: '<', value: 69 }]],
  [LINES, [{ field: 'nominal_kv', op: '<=', value: 69 }]],
  [LINES, [{ field: 'nominal_kv', op: '<', value: -1 }]],
  [LINES, [{ field: 'nominal_kv', op: '!=', value: 345 }]],
  [LINES, [{ field: 'admin1', op: 'contains', value: 'USAA' }]],
  [LINES, [{ field: 'admin1', op: 'contains', value: 'none' }]],
  [LINES, [{ field: 'admin1', op: 'contains_any', value: ['USAB', 'none'] }]],
  [LINES, [{ field: 'countries', op: 'contains', value: 'FRA' }]],
  [LINES, [{ field: 'countries', op: 'contains_any', value: ['DEU', 'CAN'] }]],
  [LINES, [{ field: 'admin1', op: 'contains', value: 'USAB' }, { field: 'nominal_kv', op: '>', value: 300 }]],
  [RETAIL, [{ field: 'type', op: '=', value: 'COOPERATIVE' }]],           // a string field
  [RETAIL, [{ field: 'type', op: 'in', value: ['STATE', 'MUNICIPAL'] }]],
  [RETAIL, [{ field: 'type', op: '!=', value: 'COOPERATIVE' }]],          // matches the null type
  [RETAIL, [{ field: 'type', op: 'not_in', value: ['COOPERATIVE', 'STATE'] }]],
  [RETAIL, [{ field: 'customers', op: '>', value: 1000 }]],               // a number field with a null
  [RETAIL, [{ field: 'customers', op: '=', value: 52000 }]],
  [RETAIL, [{ field: 'customers', op: '<', value: 1 }]],                  // 0, not the null
  [RETAIL, [{ field: 'customers', op: '!=', value: 52000 }]],
  [RETAIL, [{ field: 'customers', op: '>=', value: 400000 }]],
  [POINTS, [{ field: 'nominal_kv', op: '>', value: 200 }]],               // String kV: never pruned
  [POINTS, [{ field: 'nominal_kv', op: '=', value: 115 }]],
];

describe('pruneGroups', () => {
  it.each(CASES.map(([ds, c], i) => [i, ds, c] as const))('case %i (%s): rows equal with pruning on and off', async (_i, ds, conds) => {
    const e = await entry(ds);
    const test = testOf(ds, conds);
    const read = async (groups: number[]) => (await collect(readGroups(e, groups, e.columns))).filter(test).map(r => r.at);
    const on = pruneGroups(await columnsMeta(e), conds);
    expect(await read(on)).toEqual(await read(await allGroups(e)));
  });

  it('skips groups: the cases prune at least one group somewhere, and an impossible value all of them', async () => {
    const e = await entry(LINES);
    const md = await columnsMeta(e);
    expect(pruneGroups(md, [{ field: 'nominal_kv', op: '>', value: 400 }]).length).toBeLessThan(3);
    expect(pruneGroups(md, [{ field: 'admin1', op: 'contains', value: 'USAB' }])).toEqual([0, 1]);
    expect(pruneGroups(md, [{ field: 'countries', op: 'contains', value: 'FRA' }])).toEqual([2]);
    // A number `in` (no schema field offers it today; pruning still honours it).
    expect(pruneGroups(md, [{ field: 'nominal_kv', op: 'in', value: [999] }])).toEqual([]);
    expect(pruneGroups(md, [{ field: 'nominal_kv', op: 'in', value: [450, 999] }])).toEqual([1]);
    expect(pruneGroups(md, [{ field: 'admin1', op: 'contains', value: 'USAB' }, { field: 'admin1', op: 'contains', value: 'none' }])).toEqual([]);
    const r = await entry(RETAIL);
    const rmd = await columnsMeta(r);
    expect(pruneGroups(rmd, [{ field: 'retail', op: 'contains', value: 'Cedar' }])).toEqual([1]);
    expect(pruneGroups(rmd, [{ field: 'customers', op: '>=', value: 400000 }])).toEqual([]);
    expect(pruneGroups(rmd, [{ field: 'customers', op: '<', value: 1 }])).toEqual([0]);   // group 1: 52000 and a null
  });

  it('never prunes a number stored as text, a text condition or a group without statistics', async () => {
    const p = await entry(POINTS);
    const md = await columnsMeta(p);
    expect(pruneGroups(md, [{ field: 'nominal_kv', op: '>', value: 1e9 }])).toEqual([0, 1]);
    const l = await columnsMeta(await entry(LINES));
    expect(pruneGroups(l, [{ field: 'name', op: '=', value: 'nope' }])).toEqual([0, 1, 2]);
    const bare = { ...l, row_groups: l.row_groups.map(rg => ({ ...rg, columns: rg.columns.map(c => ({ ...c, meta_data: c.meta_data && { ...c.meta_data, statistics: undefined } })) })) };
    expect(pruneGroups(bare, [{ field: 'nominal_kv', op: 'in', value: [999] }])).toEqual([0, 1, 2]);
    const noCodes = { ...l, key_value_metadata: l.key_value_metadata?.filter(kv => kv.key !== 'region_codes') };
    expect(pruneGroups(noCodes, [{ field: 'admin1', op: 'contains', value: 'XX' }])).toEqual([0, 1, 2]);
  });
});

describe('rows', () => {
  it('equal <ds>.features.json for all three fixture datasets', async () => {
    const TYPE: Record<string, number> = { Point: 1, LineString: 2, Polygon: 3 };
    for (const ds of [LINES, RETAIL, POINTS]) {
      const e = await entry(ds);
      const rows = await collect(readGroups(e, await allGroups(e), e.columns));
      const fc = JSON.parse(readFileSync(FIX + `${ds}.features.json`, 'utf8')) as GeoJSON.FeatureCollection;
      const key = (id: unknown) => String(id);
      const want = new Map(fc.features.map(f => [key(e.id.native ? f.id : f.properties![e.id.field]), f]));
      expect(rows.length).toBe(fc.features.length);
      for (const r of rows) {
        const f = want.get(key(r.id))!;
        expect(f, `${ds} ${String(r.id)}`).toBeDefined();
        expect(r.properties).toEqual(f.properties);
        expect(r.type).toBe(TYPE[f.geometry.type]);
        if (e.id.native) expect(r.id).toBe(f.id);
      }
    }
  });

  it('a native int64 fid above 2^32 comes back as an exact Number, not a property', async () => {
    const e = await entry(LINES);
    const rows = await collect(readGroups(e, [0, 1, 2], e.columns));
    const ids = rows.map(r => r.id);
    expect(ids.every(id => typeof id === 'number' && id > 2 ** 32 && Number.isSafeInteger(id))).toBe(true);
    expect(ids).toContain(10_000_000_012);
    expect(rows.every(r => !('fid' in r.properties))).toBe(true);
  });

  it('an unsafe integer id refuses with unsafe-id', async () => {
    const e = await entry(LINES);
    let err: unknown;
    try { rowOf(e, { fid: 2n ** 60n + 1n }, 0); } catch (x) { err = x; }
    expect(err).toBeInstanceOf(Fail);
    expect((err as Fail<string>).reason).toBe('unsafe-id');
    expect(rowOf(e, { fid: 2n ** 52n }, 0).id).toBe(2 ** 52);
  });

  it('a non-native id stays a property and is the row id', async () => {
    const e = await entry(RETAIL);
    const rows = await collect(readGroups(e, [0, 1], e.columns));
    for (const r of rows) expect(r.properties.id).toBe(r.id);
    expect(rows.map(r => r.id).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('a null value is left out, "" is kept, and measures never sit in properties', async () => {
    const e = await entry(LINES);
    const rows = await collect(readGroups(e, [0, 1, 2], e.columns));
    const nameless = rows.filter(r => !('name' in r.properties));
    expect(nameless.length).toBe(2);   // the two null names
    expect(rows.filter(r => r.properties.name === '').length).toBe(1);
    expect(rows.every(r => Object.values(r.properties).every(v => v !== null && v !== undefined))).toBe(true);
    for (const r of rows) {
      for (const m of ['length_km', 'area_km2', 'px', 'py']) expect(m in r.properties).toBe(false);
      expect(r.measures.length_km).toBeGreaterThan(0);
      expect(typeof r.measures.px).toBe('number');
    }
    const pts = await collect(readGroups(await entry(POINTS), [0, 1], ['name', 'px', 'py']));
    expect(pts.map(r => [r.measures.px, r.measures.py])).toContainEqual([-97.2, 31]);
    const poly = await collect(readGroups(await entry(RETAIL), [0, 1], ['id', 'area_km2']));
    expect(poly.every(r => r.measures.area_km2 > 0 && !('area_km2' in r.properties))).toBe(true);
  });
});

describe('columnsFor', () => {
  it('reads wanted ∪ columns named in the conditions and filters, the id only when needed', async () => {
    const e = await entry(LINES);
    const conds: Condition[] = [{ field: 'admin1', op: 'contains', value: 'USAB' }];
    const filters = [['>=', ['to-number', ['get', 'nominal_kv']], 115]];
    expect(columnsFor(e, conds, filters, ['length_km'])).toEqual(['admin1', 'nominal_kv', 'length_km']);
    expect(columnsFor(e, conds, filters, ['length_km'], { rows: true })).toEqual(['fid', 'admin1', 'nominal_kv', 'length_km']);
    expect(columnsFor(e, [], [], ['count', 'name'])).toEqual(['name']);   // a derived name is not a column
  });

  it('detects the native-id selection filter ["id"]', async () => {
    const e = await entry(LINES);
    const sel = ['in', ['id'], ['literal', [10_000_000_012]]];
    expect(hasIdExpr(sel)).toBe(true);
    expect(hasIdExpr(['get', 'id'])).toBe(false);
    expect(columnsFor(e, [], [sel], ['nominal_kv'])).toEqual(['fid', 'nominal_kv']);
    expect(columnsFor(e, [], [['get', 'id']], ['nominal_kv'])).toEqual(['nominal_kv']);   // no column named id here
    const r = await entry(RETAIL);
    expect(columnsFor(r, [], [['in', ['get', 'id'], ['literal', ['R1']]]], ['name'])).toEqual(['id', 'name']);
  });
});

describe('two-phase read', () => {
  it('phase 2 reads the remaining fields for the kept rows only', async () => {
    const e = await entry(LINES);
    const test = testOf(LINES, [{ field: 'nominal_kv', op: '>=', value: 345 }]);
    const kept = await readTwoPhase(e, [0, 1, 2], ['fid', 'nominal_kv'], ['name', 'admin1'], async rows => {
      const out: ColumnsRow[] = [];
      for await (const r of rows) if (test(r)) out.push(r);
      return out.sort((a, b) => (b.properties.nominal_kv as number) - (a.properties.nominal_kv as number)).slice(0, 3);
    });
    expect(kept.map(r => r.properties.nominal_kv)).toEqual([500, 400, 345]);
    const full = new Map((await collect(readGroups(e, [0, 1, 2], ['fid', 'nominal_kv', 'name', 'admin1']))).map(r => [r.id, r]));
    for (const r of kept) expect(r.properties).toEqual(full.get(r.id)!.properties);
  });

  it('readRowsAt returns exactly the asked rows', async () => {
    const e = await entry(LINES);
    const got = await readRowsAt(e, [11, 0, 5], ['fid']);
    expect([...got.keys()].sort((a, b) => a - b)).toEqual([0, 5, 11]);
  });
});

describe('readRowsAt by row group', () => {
  it('makes one readRows call per group touched, rows spread over every group', async () => {
    const e = await entry(LINES);
    const md = await columnsMeta(e);
    const starts: number[] = [];
    let s = 0;
    for (const rg of md.row_groups) { starts.push(s); s += Number(rg.num_rows); }
    const wanted = starts.flatMap((a, g) => [a, a + Number(md.row_groups[g].num_rows) - 1]);
    calls.readRows = 0;
    const got = await readRowsAt(e, wanted, ['fid', 'name']);
    expect(calls.readRows).toBe(md.row_groups.length);
    expect(got.size).toBe(new Set(wanted).size);
    calls.readRows = 0;
    await readRowsAt(e, [starts[1], starts[1] + 1], ['fid']);
    expect(calls.readRows).toBe(1);
  });

  it('a row past the last group is absent, and readTwoPhase rejects with stale-build', async () => {
    const e = await entry(LINES);
    const total = (await columnsMeta(e)).row_groups.reduce((n, rg) => n + Number(rg.num_rows), 0);
    const got = await readRowsAt(e, [0, total, total + 5], ['fid']);
    expect([...got.keys()]).toEqual([0]);
    let err: unknown;
    try {
      await readTwoPhase(e, [0], ['fid'], ['name'], async rows => {
        const out: ColumnsRow[] = [];
        for await (const r of rows) out.push(r);
        out[0] = { ...out[0], at: total + 1 };
        return out.slice(0, 1);
      });
    } catch (x) { err = x; }
    expect(err).toBeInstanceOf(Fail);
    expect((err as Fail<string>).reason).toBe('stale-build');
  });

  it('equals rowOf over an independent whole-group read, key order included', async () => {
    const e = await entry(LINES);
    const md = await columnsMeta(e);
    const file = openFile(e, e.file);
    const { readRows } = await import('../parquet/range-io.js');
    const columns = ['fid', 'name', 'nominal_kv', 'length_km', 'px'];
    const ref = new Map<number, ColumnsRow>();
    let a = 0;
    for (const rg of md.row_groups) {
      const b = a + Number(rg.num_rows);
      (await readRows(file, md, a, b, columns)).forEach((r, i) => ref.set(a + i, rowOf(e, r, a + i)));
      a = b;
    }
    const rows = [...ref.keys()].filter(i => i % 2 === 0);
    const got = await readRowsAt(e, rows, columns);
    expect([...got.keys()].sort((x, y) => x - y)).toEqual(rows);
    for (const r of rows) {
      expect(got.get(r)).toEqual(ref.get(r));
      expect(Object.keys(got.get(r)!.properties)).toEqual(Object.keys(ref.get(r)!.properties));
    }
  });
});

describe('plannedBytes', () => {
  it('is at most the column-chunk bytes a read fetches', async () => {
    for (const [ds, groups, cols] of [[LINES, [1, 2], ['nominal_kv', 'length_km']], [RETAIL, [0, 1], ['name']], [LINES, [0, 1, 2], null]] as const) {
      resetRangeIo();
      const e = await entry(ds);
      const columns = cols ?? e.columns;
      const planned = await plannedBytes(e, [...groups], columns);
      const before = requestLog.length;   // index.json is not a range; the footer is in
      await collect(readGroups(e, [...groups], columns));
      const fetched = requestLog.slice(before).reduce((n, r) => n + r.end - r.start, 0);
      expect(planned).toBeGreaterThan(0);
      expect(planned).toBeLessThanOrEqual(fetched);
      expect(fetched).toBeLessThan(e.file.bytes);   // and the read never pulled the whole file
    }
  });
});

describe('columnsEntry', () => {
  it('is unavailable for a dataset outside COLUMNS_DATASETS or missing from index.json', async () => {
    expect(await columnsEntry('railroads')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await columnsEntry('padus')).toEqual({ ok: false, reason: 'unavailable' });
    const e = await columnsEntry(LINES);
    expect(e.ok && e.result.geometry).toBe('line');
  });
});
