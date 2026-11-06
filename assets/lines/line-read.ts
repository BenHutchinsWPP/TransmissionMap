// ─── Transmission line GeoParquet reader (lazy chunk) ─────────────────────────
// Role: full geometry and exact lengths of the OSM world and HIFLD transmission
//       lines, read by HTTP range from the GeoParquet files
//       scripts/build_line_parquet.py writes under data/analysis/ (layout:
//       docs/pipeline.md § Line geometry). A registry layer names its dataset
//       in `data.analysis` (src/types.ts). Every call returns a LineOutcome;
//       nothing throws into the map.
//   lookup(layerId, fid)            IDX: fid → {row, length_km, chain, circuits};
//                                   one IDX request (the row group whose fid
//                                   statistics hold it), cached for the session
//   lineGeometry(layerId, fid)      IDX → the GEO part holding the row → one row
//                                   through the offset index
//   chainGeometry(layerId, fid)     the way's chain in order (CHAINS, by chain
//                                   statistics), each way's geometry and `rev`
//   selectionGeometry(layerId, fids, bbox)  ≤ 1,000 ids: ≤ 20 one by one, more
//                                   by the GEO bbox column index (pages whose
//                                   bbox meets `bbox`), filtered on fid
//   lineDataset(layerId)            the dataset's manifest entry (credit, licence)
// Requests: plain `Range: bytes=N-M` GETs, same-origin credentials only (a
//   signed-in dev tunnel needs its cookie; the data host gets none), never a HEAD
//   or a suffix range — byteLength and the footer length come from index.json.
//   Fetched ranges are cached for the session; a range inside a cached one is
//   served from it. Row runs closer than RUN_GAP rows are read as one. Each
//   request is aborted after TIMEOUT_MS, so a stalled one leaves no entry behind.
// Failures (LineFailure): `unavailable` (no index.json: the files are not
//   published here; remembered for the session), `offline`, `not-found` (the id is not in IDX: index.json
//   is fetched again once per session, in case the build moved on), `stale-build`
//   (a file's build_id differs from index.json's, the host answers its name with
//   a 404 or another document, or a row pointer lands on another fid; each call
//   that meets it reads index.json again and retries once, so a tab open across
//   a rebuild recovers), `too-many`, `timeout` (TIMEOUT_MS per call).
// Deps: hyparquet + fzstd (only in this chunk), constants.ts (DATA.line_index),
//   src/registry (layerById). Imported only from lazy code: popup.ts and
//   ui/ui-table.ts (dynamic: the length row, whether the files are here),
//   lines/line-copy.ts, ui/ui-line.ts.

import { parquetMetadataAsync, parquetReadObjects, readColumnIndex, readOffsetIndex,
  type AsyncBuffer, type FileMetaData, type ColumnChunk, type Compressors } from 'hyparquet';
import { decompress } from 'fzstd';
import { DATA } from '../constants.js';
import { layerById } from '../../src/registry/index.js';

export type LineFailure = 'unavailable' | 'offline' | 'not-found' | 'stale-build' | 'too-many' | 'timeout';
export type LineOutcome<T> = { ok: true; result: T } | { ok: false; reason: LineFailure };

export interface IdxRow { row: number; length_km: number; chain: number; circuits: number }
export interface ChainWay { fid: string | number; rev: boolean; length_km: number; geometry: GeoJSON.Geometry }
export interface Chain { chain: number; ways: ChainWay[]; startSub: number | null; endSub: number | null }
export interface Selection { geometries: Map<string, GeoJSON.Geometry>; missing: (string | number)[] }
export type Bbox = [number, number, number, number];

interface FileEntry { name: string; bytes: number; footer_len: number; rows: number; row_offset?: number }
export interface DatasetEntry {
  path: string; dataset: string; build_id: string; attribution: string; label: string;
  source: string; url: string; licence: string; snapshot: string | null; fid_type: 'int64' | 'string';
  idx: FileEntry; geo: FileEntry[]; chains: FileEntry | null;
}
interface Index { version: number; datasets: Record<string, DatasetEntry> }

export const MAX_SELECTION = 1000;
const BY_ID_MAX = 20;
const RUN_GAP = 64;
const TIMEOUT_MS = 10_000;
const COMPRESSORS: Compressors = { ZSTD: (input: Uint8Array) => decompress(input) };

class Fail extends Error { constructor(readonly reason: LineFailure) { super(reason); } }

// ─── Index ───────────────────────────────────────────────────────────────────
const BASE = DATA.line_index.slice(0, DATA.line_index.lastIndexOf('/') + 1);
let indexLoad: Promise<Index> | null = null;
let refreshedOnce = false;

/** fetch, aborted after TIMEOUT_MS (body included), so a stalled request leaves no pending cache entry. */
async function fetchTimed<T>(url: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await read(await fetch(url, { ...init, signal: ctrl.signal })); }
  catch (e) { throw e instanceof Fail ? e : new Fail(ctrl.signal.aborted ? 'timeout' : 'offline'); }
  finally { clearTimeout(timer); }
}

function loadIndex(): Promise<Index> {
  return indexLoad ??= fetchTimed(DATA.line_index, { credentials: 'same-origin', cache: 'no-cache' }, async res => {
    if (!res.ok) throw new Fail('unavailable');
    const idx = await res.json().catch(() => null) as Index | null;
    if (!idx || typeof idx !== 'object' || !idx.datasets) throw new Fail('unavailable');
    return idx;
  }).catch(e => { if (!(e instanceof Fail && e.reason === 'unavailable')) indexLoad = null; throw e; });
}

async function datasetOf(layerId: string): Promise<DatasetEntry> {
  const ds = layerById(layerId)?.data?.analysis;
  if (!ds) throw new Fail('unavailable');
  const entry = (await loadIndex()).datasets[ds];
  if (!entry) throw new Fail('unavailable');
  return entry;
}

// ─── Range-read files ────────────────────────────────────────────────────────
interface Cached { start: number; end: number; data: Promise<ArrayBuffer> }
interface OpenFile { buf: AsyncBuffer; meta: Promise<FileMetaData> }
const files = new Map<string, OpenFile>();

/** The last 500 range requests since the last reset — for tests and diagnostics. */
export const requestLog: { url: string; start: number; end: number }[] = [];

function fetchRange(url: string, start: number, end: number, size: number): Promise<ArrayBuffer> {
  if (requestLog.push({ url, start, end }) > 500) requestLog.shift();
  return fetchTimed(url, { credentials: 'same-origin', headers: { Range: `bytes=${start}-${end - 1}` } }, async res => {
    if (res.status === 404) throw new Fail('stale-build');   // a content-hashed name the host no longer has
    if (!res.ok) throw new Fail('offline');
    const body = await res.arrayBuffer();
    if (res.status === 206 && body.byteLength === end - start) return body;
    if (res.status === 200 && body.byteLength === size) return body.slice(start, end);   // a host that ignores Range
    if (res.status === 200) throw new Fail('stale-build');   // another document under that name (a dev server's page for a missing file)
    throw new Fail('offline');
  });
}

function openFile(ds: DatasetEntry, entry: FileEntry): OpenFile {
  const url = BASE + ds.path + entry.name;
  const hit = files.get(url);
  if (hit) return hit;
  const cache: Cached[] = [];
  const buf: AsyncBuffer = {
    byteLength: entry.bytes,
    slice(start: number, end = entry.bytes) {
      const c = cache.find(r => r.start <= start && end <= r.end);
      if (c) return c.data.then(b => b.slice(start - c.start, end - c.start));
      const data = fetchRange(url, start, end, entry.bytes);
      const rec = { start, end, data };
      cache.push(rec);
      data.catch(() => cache.splice(cache.indexOf(rec), 1));
      return data;
    },
  };
  const meta = parquetMetadataAsync(buf, { initialFetchSize: entry.footer_len + 8 }).then(md => {
    const build = md.key_value_metadata?.find(kv => kv.key === 'build_id')?.value;
    if (build !== ds.build_id) throw new Fail('stale-build');
    return md;
  });
  const file = { buf, meta };
  files.set(url, file);
  meta.catch(() => files.delete(url));
  return file;
}

function readRows(file: OpenFile, md: FileMetaData, rowStart: number, rowEnd: number, columns?: string[], offsetIndex = false) {
  return parquetReadObjects({ file: file.buf, metadata: md, rowStart, rowEnd, columns,
    compressors: COMPRESSORS, useOffsetIndex: offsetIndex, rowFormat: 'object' }) as Promise<Record<string, unknown>[]>;
}

// ─── Row groups by statistics ────────────────────────────────────────────────
type Key = bigint | string;
const keyOf = (ds: DatasetEntry, fid: string | number): Key | null => {
  if (ds.fid_type === 'string') return String(fid);
  try { return BigInt(fid); } catch { return null; }
};
const sameKey = (a: unknown, b: Key) => (typeof b === 'bigint' ? a === b : String(a) === b);

/** The row groups whose `column` statistics may hold `key`, as [first row, end row). Pure. */
export function groupsHolding(md: Pick<FileMetaData, 'row_groups'>, column: string, key: Key): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (const rg of md.row_groups) {
    const n = Number(rg.num_rows);
    const st = rg.columns.find((c: ColumnChunk) => c.meta_data?.path_in_schema.join('.') === column)?.meta_data?.statistics;
    const lo = st?.min_value ?? st?.min, hi = st?.max_value ?? st?.max;
    if (lo == null || hi == null || (lo as Key) <= key && key <= (hi as Key)) out.push([start, start + n]);
    start += n;
  }
  return out;
}

/** Sorted row numbers → [start, end) runs, joining gaps of at most `gap` rows. Pure. */
export function rowRuns(rows: number[], gap = RUN_GAP): [number, number][] {
  const runs: [number, number][] = [];
  for (const r of [...new Set(rows)].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && r - last[1] <= gap) last[1] = r + 1; else runs.push([r, r + 1]);
  }
  return runs;
}

// ─── Calls ───────────────────────────────────────────────────────────────────
const lookups = new Map<string, Promise<IdxRow | null>>();

async function guard<T>(fn: () => Promise<T>): Promise<LineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Fail('timeout')), TIMEOUT_MS); });
  // A rebuild renames the files under an open tab: read index.json again and try once more.
  const run = () => fn().catch((e: unknown) => {
    if (!(e instanceof Fail && e.reason === 'stale-build')) throw e;
    indexLoad = null;
    return fn();
  });
  try { return { ok: true, result: await Promise.race([run(), timeout]) }; }
  catch (e) { return { ok: false, reason: e instanceof Fail ? e.reason : 'offline' }; }
  finally { clearTimeout(timer); }
}

async function idxRow(ds: DatasetEntry, fid: string | number): Promise<IdxRow | null> {
  const key = keyOf(ds, fid);
  if (key === null) return null;
  const file = openFile(ds, ds.idx);
  const md = await file.meta;
  for (const [a, b] of groupsHolding(md, 'fid', key)) {
    const hit = (await readRows(file, md, a, b)).find(r => sameKey(r.fid, key));
    if (hit) return {
      row: Number(hit.row), length_km: Number(hit.length_km),
      chain: hit.chain == null ? -1 : Number(hit.chain),
      circuits: hit.circuits == null ? -1 : Number(hit.circuits),
    };
  }
  return null;
}

async function find(layerId: string, fid: string | number): Promise<{ ds: DatasetEntry; hit: IdxRow }> {
  const ds = await datasetOf(layerId);
  const k = `${ds.build_id}|${layerId}|${fid}`;
  let p = lookups.get(k);
  if (!p) { p = idxRow(ds, fid); lookups.set(k, p); p.catch(() => lookups.delete(k)); }
  const hit = await p;
  if (hit) return { ds, hit };
  if (!refreshedOnce) {
    refreshedOnce = true;
    indexLoad = null;
    const fresh = await datasetOf(layerId);
    if (fresh.build_id !== ds.build_id) return find(layerId, fid);
  }
  throw new Fail('not-found');
}

export function lookup(layerId: string, fid: string | number): Promise<LineOutcome<IdxRow>> {
  return guard(async () => (await find(layerId, fid)).hit);
}

/** The GEO part holding global row `row`. */
function partOf(ds: DatasetEntry, row: number): FileEntry {
  let part = ds.geo[0];
  for (const g of ds.geo) if ((g.row_offset ?? 0) <= row) part = g;
  return part;
}

/** Global rows → geometry, keyed by row; each row's fid is checked when `want` names it. */
async function geometryByRows(ds: DatasetEntry, rows: number[]): Promise<Map<number, { fid: unknown; geometry: GeoJSON.Geometry }>> {
  const byPart = new Map<FileEntry, number[]>();
  for (const r of rows) {
    const p = partOf(ds, r);
    byPart.set(p, [...(byPart.get(p) ?? []), r - (p.row_offset ?? 0)]);
  }
  const out = new Map<number, { fid: unknown; geometry: GeoJSON.Geometry }>();
  await Promise.all([...byPart].map(async ([part, local]) => {
    const file = openFile(ds, part);
    const md = await file.meta;
    await Promise.all(rowRuns(local).map(async ([a, b]) => {
      const got = await readRows(file, md, a, b, ['fid', 'geometry'], true);
      got.forEach((r, i) => out.set((part.row_offset ?? 0) + a + i, { fid: r.fid, geometry: r.geometry as GeoJSON.Geometry }));
    }));
  }));
  return out;
}

export function lineGeometry(layerId: string, fid: string | number): Promise<LineOutcome<GeoJSON.Geometry>> {
  return guard(async () => {
    const { ds, hit } = await find(layerId, fid);
    const got = (await geometryByRows(ds, [hit.row])).get(hit.row);
    const key = keyOf(ds, fid)!;
    if (!got || !sameKey(got.fid, key)) throw new Fail('stale-build');
    return got.geometry;
  });
}

export function chainGeometry(layerId: string, fid: string | number): Promise<LineOutcome<Chain>> {
  return guard(async () => {
    const { ds, hit } = await find(layerId, fid);
    let members: { fid: unknown; row: number; rev: boolean; length_km: number }[] =
      [{ fid, row: hit.row, rev: false, length_km: hit.length_km }];
    let startSub: number | null = null, endSub: number | null = null;
    if (hit.chain >= 0 && ds.chains) {
      const file = openFile(ds, ds.chains);
      const md = await file.meta;
      const rows: Record<string, unknown>[] = [];
      for (const [a, b] of groupsHolding(md, 'chain', BigInt(hit.chain)))
        rows.push(...(await readRows(file, md, a, b)).filter(r => Number(r.chain) === hit.chain));
      rows.sort((x, y) => Number(x.seq) - Number(y.seq));
      if (rows.length) {
        members = rows.map(r => ({ fid: r.fid, row: Number(r.row), rev: !!r.rev, length_km: Number(r.length_km) }));
        const sub = (v: unknown) => (v == null ? null : Number(v));
        startSub = sub(rows[0].start_sub);
        endSub = sub(rows[rows.length - 1].end_sub);
      }
    }
    const geoms = await geometryByRows(ds, members.map(m => m.row));
    const ways = members.map(m => {
      const g = geoms.get(m.row);
      if (!g || String(g.fid) !== String(m.fid)) throw new Fail('stale-build');
      return { fid: typeof m.fid === 'bigint' ? Number(m.fid) : m.fid as string | number, rev: m.rev, length_km: m.length_km, geometry: g.geometry };
    });
    return { chain: hit.chain, ways, startSub, endSub };
  });
}

// ─── Selections by bbox ──────────────────────────────────────────────────────
const BBOX_COLS = ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'] as const;

function chunkOf(rg: FileMetaData['row_groups'][number], path: string) {
  return rg.columns.find(c => c.meta_data?.path_in_schema.join('.') === path);
}

/** Row ranges (local to the file) whose pages' bbox meets `bb`, from the bbox column index. */
async function bboxRanges(file: OpenFile, md: FileMetaData, bb: Bbox): Promise<[number, number][]> {
  const [qx0, qy0, qx1, qy1] = bb;
  const out: [number, number][] = [];
  let start = 0;
  const schema = md.schema;
  for (const rg of md.row_groups) {
    const n = Number(rg.num_rows);
    const chunks = BBOX_COLS.map(p => chunkOf(rg, p));
    const st = chunks.map(c => c?.meta_data?.statistics);
    const lo = (i: number) => Number(st[i]?.min_value ?? -Infinity), hi = (i: number) => Number(st[i]?.max_value ?? Infinity);
    const meets = lo(0) <= qx1 && hi(2) >= qx0 && lo(1) <= qy1 && hi(3) >= qy0;
    if (meets) out.push(...await pagesMeeting(file, chunks, schema, n, bb).then(r => r.map(([a, b]) => [start + a, start + b] as [number, number])));
    start += n;
  }
  return out;
}

async function pagesMeeting(file: OpenFile, chunks: (ColumnChunk | undefined)[], schema: FileMetaData['schema'],
  groupRows: number, [qx0, qy0, qx1, qy1]: Bbox): Promise<[number, number][]> {
  const whole: [number, number][] = [[0, groupRows]];
  if (chunks.some(c => !c?.column_index_offset || !c.column_index_length) || !chunks[0]?.offset_index_offset) return whole;
  const ranges = [...chunks.map(c => [Number(c!.column_index_offset), Number(c!.column_index_offset) + c!.column_index_length!]),
    [Number(chunks[0].offset_index_offset), Number(chunks[0].offset_index_offset) + chunks[0].offset_index_length!]];
  const lo = Math.min(...ranges.map(r => r[0])), hi = Math.max(...ranges.map(r => r[1]));
  const bytes = await file.buf.slice(lo, hi);
  const view = (a: number) => ({ view: new DataView(bytes, a - lo), offset: 0 });
  const el = (c: ColumnChunk) => schema.find(s => s.name === c.meta_data!.path_in_schema.at(-1))!;
  const idx = chunks.map((c, i) => readColumnIndex(view(ranges[i][0]), el(c!)));
  const pages = readOffsetIndex(view(ranges[4][0])).page_locations;
  if (idx.some(ci => ci.min_values.length !== pages.length)) return whole;
  const out: [number, number][] = [];
  pages.forEach((p, i) => {
    const v = (k: number, m: 'min_values' | 'max_values') => Number(idx[k][m][i]);
    if (v(0, 'min_values') <= qx1 && v(2, 'max_values') >= qx0 && v(1, 'min_values') <= qy1 && v(3, 'max_values') >= qy0) {
      const a = Number(p.first_row_index), b = i + 1 < pages.length ? Number(pages[i + 1].first_row_index) : groupRows;
      const last = out[out.length - 1];
      if (last && a - last[1] <= RUN_GAP) last[1] = b; else out.push([a, b]);
    }
  });
  return out;
}

export function selectionGeometry(layerId: string, fids: (string | number)[], bbox: Bbox): Promise<LineOutcome<Selection>> {
  return guard(async () => {
    if (fids.length > MAX_SELECTION) throw new Fail('too-many');
    const geometries = new Map<string, GeoJSON.Geometry>();
    const missing: (string | number)[] = [];
    if (fids.length <= BY_ID_MAX) {
      await Promise.all(fids.map(async fid => {
        const got = await lineGeometry(layerId, fid);
        if (got.ok) geometries.set(String(fid), got.result);
        else if (got.reason === 'not-found') missing.push(fid);
        else throw new Fail(got.reason);
      }));
      return { geometries, missing };
    }
    const ds = await datasetOf(layerId);
    const want = new Set(fids.map(String));
    await Promise.all(ds.geo.map(async part => {
      const file = openFile(ds, part);
      const md = await file.meta;
      const runs = await bboxRanges(file, md, bbox);
      await Promise.all(runs.map(async ([a, b]) => {
        for (const r of await readRows(file, md, a, b, ['fid', 'geometry'], true))
          if (want.has(String(r.fid))) geometries.set(String(r.fid), r.geometry as GeoJSON.Geometry);
      }));
    }));
    for (const fid of fids) if (!geometries.has(String(fid))) missing.push(fid);
    return { geometries, missing };
  });
}

export function lineDataset(layerId: string): Promise<LineOutcome<DatasetEntry>> {
  return guard(() => datasetOf(layerId));
}

/** Test support: forget the index, the files and the lookups. */
export function resetLineRead() {
  indexLoad = null; refreshedOnce = false;
  files.clear(); lookups.clear(); requestLog.length = 0;
}
