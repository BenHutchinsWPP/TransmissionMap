// columns-decode.ts against range-io `readRows` (the main-thread hyparquet path) as the
// reference: every fixture file in fixtures/analysis/columns/ and fixtures/decode/
// (multi-page chunks, a dictionary that falls back to plain pages, -0 and NaN), every
// row group, every column, value by value with Object.is. Also: two columns from one
// piece, a read outside the piece, a non-primitive value, estimateBytes, and planted
// faults the comparator must catch.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parquetMetadata, type FileMetaData } from 'hyparquet';
import { readRows, type OpenFile } from '../parquet/range-io.js';
import { decodeColumn, expand, estimateBytes, groupRange, type Col } from './columns-decode.js';

// A planted hyparquet result for the non-primitive test; off otherwise.
const plant = vi.hoisted(() => ({ rows: null as Record<string, unknown>[] | null }));
vi.mock('hyparquet', async importOriginal => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: (o: Parameters<typeof m.parquetReadObjects>[0]) => plant.rows ? Promise.resolve(plant.rows) : m.parquetReadObjects(o) };
});

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FILES = [
  ...readdirSync(FIX + 'analysis/columns').map(f => 'analysis/columns/' + f),
  ...readdirSync(FIX + 'decode').map(f => 'decode/' + f),
].filter(f => f.endsWith('.parquet')).sort();

interface Fixture { name: string; ab: ArrayBuffer; md: FileMetaData; file: OpenFile; columns: string[] }

function load(name: string): Fixture {
  const b = readFileSync(FIX + name);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const md = parquetMetadata(ab);
  const file = { buf: { byteLength: ab.byteLength, slice: async (s: number, e = ab.byteLength) => ab.slice(s, e) }, meta: Promise.resolve(md) } as OpenFile;
  return { name, ab, md, file, columns: md.row_groups[0].columns.map(c => c.meta_data!.path_in_schema.join('.')) };
}

const fixtures = FILES.map(load);
const multipage = fixtures.find(f => f.name === 'decode/multipage.parquet')!;

function groupRows(md: FileMetaData, g: number): [number, number] {
  let a = 0;
  for (let i = 0; i < g; i++) a += Number(md.row_groups[i].num_rows);
  return [a, a + Number(md.row_groups[g].num_rows)];
}

const reference = async (f: Fixture, g: number, col: string) => {
  const [a, b] = groupRows(f.md, g);
  return (await readRows(f.file, f.md, a, b, [col])).map(r => r[col]);
};

async function decoded(f: Fixture, g: number, col: string, range: readonly string[] = [col]): Promise<Col> {
  const { start, end } = groupRange(f.md, g, range);
  return decodeColumn({ schema: f.md.schema, rowGroup: f.md.row_groups[g], column: col, bytes: f.ab.slice(start, end), start });
}

/** The first row whose value differs (Object.is; a null reference value is null or undefined), or -1. */
function firstMismatch(ref: unknown[], col: Col): number {
  if (col.codes.length !== ref.length) return 0;
  for (let i = 0; i < ref.length; i++) {
    const want = ref[i] === undefined ? null : ref[i];
    if (!Object.is(want, expand(col, i))) return i;
  }
  return -1;
}

const cases = fixtures.flatMap(f => f.md.row_groups.flatMap((_, g) => f.columns.map(c => [f.name, g, c] as const)));

describe('decodeColumn equals readRows', () => {
  it.each(cases)('%s group %i %s', async (name, g, col) => {
    const f = fixtures.find(x => x.name === name)!;
    const ref = await reference(f, g, col);
    const got = await decoded(f, g, col);
    expect(firstMismatch(ref, got)).toBe(-1);
    expect(got.codes.length).toBe(Number(f.md.row_groups[g].num_rows));
  });

  it('the multi-page fixture has multi-page chunks, a plain fallback, -0, +0, NaN, nulls and bigint ids', async () => {
    const stats = (col: string) => multipage.md.row_groups[0].columns.find(c => c.meta_data!.path_in_schema[0] === col)!.meta_data!.encoding_stats!;
    const pages = (col: string, enc: string) => stats(col).filter(s => s.page_type === 'DATA_PAGE' && s.encoding === enc).reduce((n, s) => n + s.count, 0);
    expect(pages('fid', 'PLAIN')).toBeGreaterThan(3);
    expect(pages('nominal_kv', 'PLAIN')).toBeGreaterThan(3);
    expect(pages('name', 'RLE_DICTIONARY')).toBeGreaterThan(0);
    expect(pages('name', 'PLAIN')).toBeGreaterThan(0);   // dictionary overflowed into plain pages
    const kv = await decoded(multipage, 0, 'nominal_kv');
    expect(kv.dict.filter(v => Object.is(v, -0))).toHaveLength(1);
    expect(kv.dict.filter(v => Object.is(v, 0))).toHaveLength(1);
    expect(kv.dict.filter(v => Number.isNaN(v))).toHaveLength(1);
    expect([...kv.codes].includes(-1)).toBe(true);
    const fid = await decoded(multipage, 1, 'fid');
    expect(typeof fid.dict[0]).toBe('bigint');
  });
});

describe('pieces', () => {
  it('two columns decode from one groupRange piece', async () => {
    for (const f of fixtures) {
      const [c1, c2] = [f.columns[0], f.columns[f.columns.length - 1]];
      for (let g = 0; g < f.md.row_groups.length; g++) {
        for (const c of [c1, c2]) expect(firstMismatch(await reference(f, g, c), await decoded(f, g, c, [c1, c2]))).toBe(-1);
      }
    }
  });

  it('groupRange is one span from the first chunk to the end of the last, with bigint offsets read as numbers', () => {
    const md = multipage.md;
    const r = groupRange(md, 1, multipage.columns);
    const chunks = md.row_groups[1].columns.map(c => c.meta_data!);
    expect(r.start).toBe(Number(chunks[0].dictionary_page_offset || chunks[0].data_page_offset));
    const last = chunks[chunks.length - 1];
    expect(r.end).toBe(Number(last.data_page_offset) + Number(last.total_compressed_size));
    expect(() => groupRange(md, 0, ['nope'])).toThrow();
  });

  it('a read outside the piece throws', async () => {
    const f = multipage;
    const { start, end } = groupRange(f.md, 0, ['fid']);
    await expect(decodeColumn({ schema: f.md.schema, rowGroup: f.md.row_groups[0], column: 'length_km', bytes: f.ab.slice(start, end), start }))
      .rejects.toThrow(/outside piece/);
  });

  it('a non-primitive value throws', async () => {
    for (const v of [{ a: 1 }, ['x'], new Date(0)]) {
      plant.rows = [{ name: 'a' }, { name: v }];
      try { await expect(decoded(multipage, 0, 'name')).rejects.toThrow(/not a primitive/); }
      finally { plant.rows = null; }
    }
  });

  it('estimateBytes counts codes and entries', async () => {
    for (const f of fixtures) for (const c of f.columns) {
      const col = await decoded(f, 0, c);
      expect(col.bytes).toBeGreaterThan(0);
      expect(col.bytes).toBe(estimateBytes(col));
    }
    expect(estimateBytes({ dict: ['ab', 1, 2n, true], codes: new Int32Array(3) })).toBe(12 + 20 + 16 * 3);
  });
});

describe('the comparator catches planted faults', () => {
  const copy = (c: Col): Col => ({ dict: [...c.dict], codes: c.codes.slice(), bytes: c.bytes });

  it('(a) two codes swapped', async () => {
    const ref = await reference(multipage, 0, 'name');
    const c = copy(await decoded(multipage, 0, 'name'));
    const i = c.codes.findIndex(k => k >= 0);
    const j = c.codes.findIndex(k => k >= 0 && k !== c.codes[i]);
    [c.codes[i], c.codes[j]] = [c.codes[j], c.codes[i]];
    expect(firstMismatch(ref, c)).toBeGreaterThanOrEqual(0);
  });

  it('(b) a bigint entry turned into a Number', async () => {
    const ref = await reference(multipage, 0, 'fid');
    const c = copy(await decoded(multipage, 0, 'fid'));
    c.dict[c.codes[0]] = Number(c.dict[c.codes[0]]);
    expect(firstMismatch(ref, c)).toBe(0);
  });

  it('(c) a null read as ""', async () => {
    const ref = await reference(multipage, 0, 'name');
    const c = copy(await decoded(multipage, 0, 'name'));
    const i = c.codes.indexOf(-1);
    expect(i).toBeGreaterThanOrEqual(0);
    c.codes[i] = c.dict.indexOf('');
    expect(c.codes[i]).toBeGreaterThanOrEqual(0);
    expect(firstMismatch(ref, c)).toBe(i);
  });

  it('(d) -0 read as 0', async () => {
    const ref = await reference(multipage, 0, 'nominal_kv');
    const c = copy(await decoded(multipage, 0, 'nominal_kv'));
    const k = c.dict.findIndex(v => Object.is(v, -0));
    c.dict[k] = 0;
    expect(firstMismatch(ref, c)).toBe(c.codes.indexOf(k));
  });
});
