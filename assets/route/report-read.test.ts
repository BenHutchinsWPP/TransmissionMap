import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parquetMetadata, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { BYTE_BUDGET_MSG, buildCorridor, readReport, readSpatialRows } from './report-read.js';
import { exactCrossings, type ExactFeature } from './crossings-exact.js';
import { albersForward, albersInverse } from './grid.js';

vi.mock('hyparquet', async original => {
  const actual = await original<typeof import('hyparquet')>();
  return { ...actual, parquetMetadataAsync: vi.fn(actual.parquetMetadataAsync), parquetReadObjects: vi.fn(actual.parquetReadObjects) };
});

type XY = [number, number];
const DIR = fileURLToPath(new URL('./fixtures/report/', import.meta.url));
// make-report.py scene A: R_A runs due east 20 km from (-100, 40)
const START: XY = [-338390.5876, 1894100.1400];
const R_A: XY[] = [START, [START[0] + 20000, START[1]]];
const FAMILIES = ['road', 'river', 'rail', 'pipeline', 'line'] as const;

function fsIO(dir: string, html?: string) {
  const log: { file: string; start: number; end: number }[] = [];
  const file = (url: string) => url.slice('report/'.length);
  return {
    log, reportUrl: 'report/',
    async byteLength(url: string) { return file(url) === html ? 1000 : statSync(join(dir, file(url))).size; },
    async fetchRange(url: string, start: number, end: number) {
      log.push({ file: file(url), start, end });
      if (file(url) === html) return new TextEncoder().encode('<!doctype html>'.padEnd(1000, ' ')).subarray(start, end);
      return new Uint8Array(readFileSync(join(dir, file(url))).subarray(start, end));
    },
  };
}

describe('buildCorridor', () => {
  it('densifies: a 340 km E–W segment at 45° still hits a tiny box on its straight Albers midpoint', () => {
    const a = albersForward(-98.2, 45), b: XY = [-a[0], a[1]];   // 340 km, symmetric about the -96 meridian
    expect(b[0] - a[0]).toBeGreaterThan(330_000);
    const mid = albersInverse(0, a[1]);
    expect(Math.abs(mid[1] - 45) * 111000).toBeGreaterThan(500);   // the bow the densify covers
    const c = buildCorridor([[a, b]]), e = 1e-5;
    expect(c.hits(mid[0] - e, mid[1] - e, mid[0] + e, mid[1] + e)).toBe(true);
    expect(c.hits(mid[0] - e, mid[1] + 0.05, mid[0] + e, mid[1] + 0.05 + e)).toBe(false);
  });

  it('boxes per polyline: nothing between two polylines', () => {
    const o = albersForward(-100, 40);
    const p1: XY[] = [o, [o[0] + 10_000, o[1]]], p2: XY[] = [[o[0] + 50_000, o[1]], [o[0] + 60_000, o[1]]];
    const c = buildCorridor([p1, p2]), e = 1e-5;
    const at = (dx: number) => { const [lng, lat] = albersInverse(o[0] + dx, o[1]); return c.hits(lng - e, lat - e, lng + e, lat + e); };
    expect(at(5_000)).toBe(true);
    expect(at(55_000)).toBe(true);
    expect(at(30_000)).toBe(false);
  });
});

describe('readReport over scene A', () => {
  it('reads every family, never the far row group, and applies the grid filters', async () => {
    const io = fsIO(DIR);
    const { features, status } = await readReport(io, [R_A], Date.now() + 30_000);
    for (const f of FAMILIES) expect(status[f], f).toMatchObject({ ok: true });

    // the far group (the last row group of every file) is never fetched: neither bbox nor geometry
    for (const name of ['roads_motorway_trunk', 'rivers', 'railroads', 'pipelines_osm', 'transmission_osm_us', 'transmission_hifld']) {
      const md = parquetMetadata(new Uint8Array(readFileSync(join(DIR, `${name}.parquet`))).buffer);
      const far = md.row_groups[md.row_groups.length - 1];
      for (const col of far.columns) {
        const m = col.meta_data!, s = Number(m.dictionary_page_offset ?? m.data_page_offset), e = s + Number(m.total_compressed_size);
        const hit = io.log.filter((r) => r.file === `${name}.parquet` && r.start < e && r.end > s);
        expect(hit, `${name} ${m.path_in_schema.join('.')}`).toEqual([]);
      }
    }
    expect(features.some((f) => f.name === 'Far River' || f.name === 'Far Gas')).toBe(false);

    const ids = features.map((f) => `${f.family}:${f.src}:${f.name ?? ''}:${f.kv ?? ''}`);
    expect(features.find((f) => f.name === 'City Water')).toBeUndefined();
    expect(features.filter((f) => f.src === 'hifld' && f.family === 'line').map((f) => f.kv).sort()).toEqual([220, 345]);  // INACTIVE dropped
    expect(features.some((f) => f.kv === 1000)).toBe(false);
    // busbar + busbarq dropped: of the OSM 230 kV ways only the ones at 9,000, 150 and 16,000 remain
    expect(features.filter((f) => f.src === 'osm' && f.kv === 230)).toHaveLength(3);
    expect(features.find((f) => f.kv === 138)?.id).toBe('1380');
    expect(features.find((f) => f.src === 'hifld' && f.kv === 220)?.detail).toBe('220 kV');
    expect(features.find((f) => f.name === 'I-99 (I 99)')?.detail).toBe('motorway');
    expect(ids).toContain('rail:narn:BNSF:');
    expect(features.some((f) => f.family === 'rail' && f.name === 'UP')).toBe(false);   // NET A / R dropped
    expect(status.line.rowsDecoded).toBeLessThan(20);
  });

  it('end to end with exactCrossings gives the scene A counts', async () => {
    const { features } = await readReport(fsIO(DIR), [R_A], Date.now() + 30_000);
    const [r] = exactCrossings([R_A], features, { toLngLat: albersInverse, lengthsMi: [20000 / 1609.344] });
    // road 3: I-99's two ways 30 m apart merge (1) + two unnamed primaries, each its own group (2)
    // river 3: Mud River crosses at 3,000 / 3,400 / 3,800
    // rail 1: four BNSF ways within 30 m merge; the abandoned (A) and removed (R) UP rows are filtered
    // pipeline 1: Gulf Gas; its HIFLD copy 80 m off dropped; the water pipe filtered
    // line230 3: 345 kV at 5,000 (HIFLD copy 120 m off dropped), 230 kV at 9,000 (crosses inside the
    //   115 kV follow stretch, but is not that line), 230 kV at 16,000 (HIFLD 220-287 copy 100 m off
    //   dropped across classes); 230 kV at 150 is within 300 m of the route start; busbars, 1,000 kV and
    //   INACTIVE filtered
    // line100 1: the null-fid 138 kV at 17,000; the weaving 115 kV chain is followed for 5 km → its 6 crossings drop
    expect(r.counts).toEqual({ road: 3, river: 3, rail: 1, pipeline: 1, line230: 3, line100: 1 });
    expect(r.dupDropped).toBe(3);
    const mi = (m: number) => m / 1609.344;
    const river = r.points.filter((p) => p.kind === 'river').map((p) => p.mi);
    [3000, 3400, 3800].forEach((m, i) => expect(river[i]).toBeCloseTo(mi(m), 2));
  });
});

describe('readReport failures', () => {
  it('a missing directory: every family not ok, no throw', async () => {
    const io = fsIO(mkdtempSync(join(tmpdir(), 'report-')));
    const { features, status } = await readReport(io, [R_A], Date.now() + 30_000);
    expect(features).toEqual([]);
    for (const f of FAMILIES) expect(status[f].ok).toBe(false);
  });

  it('an HTML body for one file fails that family only', async () => {
    const { features, status } = await readReport(fsIO(DIR, 'rivers.parquet'), [R_A], Date.now() + 30_000);
    expect(status.river).toMatchObject({ ok: false });
    expect(status.river.note).toMatch(/not a Parquet file/);
    for (const f of FAMILIES.filter((f) => f !== 'river')) expect(status[f].ok).toBe(true);
    expect(features.some((f) => f.family === 'river')).toBe(false);
  });

  it('one bad file drops its family-mate too', async () => {
    const { features, status } = await readReport(fsIO(DIR, 'transmission_hifld.parquet'), [R_A], Date.now() + 30_000);
    expect(status.line.ok).toBe(false);
    expect(status.line.rowsKept).toBe(0);
    expect(features.some((f: ExactFeature) => f.family === 'line')).toBe(false);
  });

  it('a deadline already past: every family not ok', async () => {
    const io = fsIO(DIR);
    const { status } = await readReport(io, [R_A], Date.now() - 1);
    for (const f of FAMILIES) expect(status[f].ok).toBe(false);
    expect(io.log).toEqual([]);
  });
});


describe('bounded spatial row extraction', () => {
  it('rejects a row budget before decoding the nearby group', async () => {
    await expect(readSpatialRows(fsIO(DIR), 'report/rivers.parquet', ['name'], buildCorridor([R_A]),
      { failed: null, bytes: 0, groups: 0, rowsDecoded: 0, maxRows: 0 }, Date.now() + 1000)).rejects.toThrow('row budget');
  });

  it('rejects an oversized footer before fetching or decoding it', async () => {
    let reads = 0;
    const io = { async byteLength() { return 10_000_000; }, async fetchRange(_url: string, start: number) {
      reads++;
      if (start === 0) return new TextEncoder().encode('PAR1');
      const tail = new Uint8Array(8); new DataView(tail.buffer).setUint32(0, 2 * 2 ** 20 + 1, true);
      tail.set(new TextEncoder().encode('PAR1'), 4); return tail;
    } };
    await expect(readSpatialRows(io, 'rivers.parquet', [], buildCorridor([R_A]),
      { failed: null, bytes: 0, groups: 0, rowsDecoded: 0 }, Date.now() + 1000)).rejects.toThrow('oversized Parquet footer');
    expect(reads).toBe(2);
  });

  it('rejects oversized uncompressed groups before bbox or geometry decoding', async () => {
    const md = parquetMetadata(new Uint8Array(readFileSync(join(DIR, 'rivers.parquet'))).buffer);
    md.row_groups[0].total_byte_size = BigInt(32 * 2 ** 20);
    vi.mocked(parquetMetadataAsync).mockResolvedValueOnce(md);
    try {
      await expect(readSpatialRows(fsIO(DIR), 'report/rivers.parquet', ['name'], buildCorridor([R_A]),
        { failed: null, bytes: 0, groups: 0, rowsDecoded: 0 }, Date.now() + 1000)).rejects.toThrow('decode budget');
    } finally { vi.mocked(parquetMetadataAsync).mockClear(); }
  });

  describe('streaming sink and the shared budget', () => {
    // 50,000 rows in three row groups, every row inside the corridor; hyparquet's decode is stubbed, the rest of the reader is real.
    async function stubbed() {
      const md = parquetMetadata(new Uint8Array(readFileSync(join(DIR, 'rivers.parquet'))).buffer);
      const rg = (n: number) => ({ ...md.row_groups[0], num_rows: BigInt(n), total_byte_size: BigInt(1000) });
      vi.mocked(parquetMetadataAsync).mockResolvedValue({ ...md, row_groups: [rg(16_384), rg(16_384), rg(17_232)] });
      const [lng, lat] = albersInverse(START[0] + 100, START[1]);
      vi.mocked(parquetReadObjects).mockImplementation((async (o: { rowStart: number; rowEnd: number; columns: string[] }) =>
        Array.from({ length: o.rowEnd - o.rowStart }, (_, i) => o.columns.includes('bbox')
          ? { bbox: { xmin: lng, ymin: lat, xmax: lng + 1e-5, ymax: lat + 1e-5 } } : { name: String(o.rowStart + i), geometry: null })) as never);
    }
    const sizeIO = () => ({ async byteLength() { return 1_000_000; }, async fetchRange(_u: string, a: number, e: number) {
      const b = new Uint8Array(e - a); if (a === 0) b.set(new TextEncoder().encode('PAR1')); else if (e === 1_000_000) { new DataView(b.buffer).setUint32(b.length - 8, 1000, true); b.set(new TextEncoder().encode('PAR1'), b.length - 4); } return b; } });
    const budget = () => ({ failed: null as string | null, bytes: 0, groups: 0, rowsDecoded: 0 });
    const restore = () => { vi.mocked(parquetMetadataAsync).mockReset(); vi.mocked(parquetReadObjects).mockReset(); };

    it('hands 50,000 rows to the sink in chunks and retains none, with no row cap', async () => {
      await stubbed();
      try {
        const sizes: number[] = [], t = budget();
        const out = await readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), t, Date.now() + 5000, rows => { sizes.push(rows.length); });
        expect(out).toEqual([]);
        expect(sizes.length).toBeGreaterThanOrEqual(2);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(50_000);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(16_384);
        expect(t.rowsDecoded).toBe(50_000);
        // without a sink the crossings families keep their 100,000-row cap and still return the rows
        const t2 = budget();
        expect((await readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), t2, Date.now() + 5000)).length).toBe(50_000);
        await expect(readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), { ...budget(), maxRows: 20_000 }, Date.now() + 5000, () => {})).rejects.toThrow('row budget');
      } finally { restore(); }
    });

    it('one budget object counts the bytes of every file it is passed to', async () => {
      await stubbed();
      try {
        const t = budget(); let one = 0;
        await readSpatialRows(sizeIO(), 'a', ['name'], buildCorridor([R_A]), t, Date.now() + 5000, () => {}); one = t.bytes;
        await readSpatialRows(sizeIO(), 'b', ['name'], buildCorridor([R_A]), t, Date.now() + 5000, () => {});
        expect(one).toBeGreaterThan(0); expect(t.bytes).toBe(2 * one);
      } finally { restore(); }
    });

    it('a 97 MiB tally fails against maxBytes 96 MiB, and 96 MiB or less does not', async () => {
      await stubbed();
      try {
        const over = { ...budget(), bytes: 97 * 2 ** 20, maxBytes: 96 * 2 ** 20 };
        await expect(readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), over, Date.now() + 5000, () => {})).rejects.toThrow(BYTE_BUDGET_MSG);
        const under = { ...budget(), bytes: 90 * 2 ** 20, maxBytes: 96 * 2 ** 20 };
        await expect(readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), under, Date.now() + 5000, () => {})).resolves.toEqual([]);
        // the crossings default (48 MiB per file) is unchanged
        await expect(readSpatialRows(sizeIO(), 'x', ['name'], buildCorridor([R_A]), { ...budget(), bytes: 49 * 2 ** 20 }, Date.now() + 5000)).rejects.toThrow(BYTE_BUDGET_MSG);
      } finally { restore(); }
    });
  });
});
