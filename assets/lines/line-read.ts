// ─── Transmission line GeoParquet reader (lazy chunk) ─────────────────────────
// Role: full geometry (and, for lines, exact lengths) of the OSM world and HIFLD
//       transmission lines and gas pipelines and of polygon datasets (OSM substation and
//       power-plant polygons, utility territories, EIA balancing authorities, HIFLD control areas, NERC regions, critical habitat, PAD-US, US states, countries, admin-1, tribal lands, counties, ZIP code areas, BIA tribal lands, BOEM wind leases) and of rail lines,
//       read by HTTP range from the GeoParquet files
//       scripts/build_line_parquet.py writes under data/analysis/ (layout:
//       docs/pipeline.md § Line geometry). A registry layer names its dataset
//       in `data.analysis` (src/types.ts); an index entry's `geometry` is 'line'
//       (read as 'line' when absent) or 'polygon' (IDX + GEO only: no CHAINS, no
//       length: length_km is NaN). Every call returns a LineOutcome; nothing
//       throws into the map.
//   lookup(layerId, fid)            IDX: fid → {row, length_km, chain, circuits, geometry};
//                                   one IDX request (the row group whose fid
//                                   statistics hold it), cached for the session
//   lineGeometry(layerId, fid)      IDX → the GEO part holding the row → one row
//                                   through the offset index
//   chainGeometry(layerId, fid)     the way's chain in order (CHAINS, by chain
//                                   statistics), each way's geometry and `rev`
//   selectionGeometry(layerId, fids, bbox)  ≤ 1,000 ids: ≤ 20 one by one, more by
//                                   the cheaper of two plans (`selectionPlan`, planned
//                                   bytes from the footers and the bbox page index):
//                                   the GEO pages whose bbox meets `bbox`, filtered
//                                   on fid, or the ids' IDX groups, then their rows
//   lineDataset(layerId)            the dataset's manifest entry (credit, licence)
// Requests: through parquet/range-io.ts (bounded range GETs, a 10 s timeout per
//   request, ≤ 6 in flight, a 32 MiB LRU byte cache, the index.json load). Row
//   runs closer than RUN_GAP rows are read as one. Each call is also cut at
//   TIMEOUT_MS as a whole (`guard`), which then stops its queued and running requests.
// Failures (LineFailure): `unavailable` (no index.json: the files are not
//   published here; remembered for the session), `offline`, `not-found` (the id is not in IDX: index.json
//   is fetched again once per session, in case the build moved on), `stale-build`
//   (a file's build_id differs from index.json's, the host answers its name with
//   a 404 or another document, or a row pointer lands on another fid; each call
//   that meets it reads index.json again and retries once, so a tab open across
//   a rebuild recovers), `too-many`, `timeout` (TIMEOUT_MS per call).
// Deps: parquet/range-io.ts (requestLog, groupsHolding and rowRuns re-exported),
//   hyparquet (column and offset index readers; only in lazy chunks),
//   src/registry (layerById). Imported only from lazy code: popup.ts (dynamic: the
//   length row, the edit-mode probe), ui/ui-table.ts and user-data/copy-rows.ts
//   (dynamic: whether the files are here), lines/line-copy.ts, ui/ui-line.ts.

import { readColumnIndex, readOffsetIndex, type FileMetaData, type ColumnChunk } from 'hyparquet';
import { Fail as IoFail, loadIndex, forgetIndex, openFile, readRows, groupsHolding, rowRuns, RUN_GAP, withSignal,
  resetRangeIo, type FileEntry, type Key, type OpenFile } from '../parquet/range-io.js';
import { layerById } from '../../src/registry/index.js';

export { requestLog, groupsHolding, rowRuns } from '../parquet/range-io.js';

export type LineFailure = 'unavailable' | 'offline' | 'not-found' | 'stale-build' | 'too-many' | 'timeout';
export type LineOutcome<T> = { ok: true; result: T } | { ok: false; reason: LineFailure };

export interface IdxRow { row: number; length_km: number; chain: number; circuits: number; geometry?: 'line' | 'polygon' }
export interface ChainWay { fid: string | number; rev: boolean; length_km: number; geometry: GeoJSON.Geometry }
export interface Chain { chain: number; ways: ChainWay[]; startSub: number | null; endSub: number | null }
export interface Selection { geometries: Map<string, GeoJSON.Geometry>; missing: (string | number)[] }
export type Bbox = [number, number, number, number];

export interface DatasetEntry {
  path: string; dataset: string; build_id: string; attribution: string; label: string;
  source: string; url: string; licence: string; snapshot: string | null; fid_type: 'int64' | 'string';
  geometry?: 'line' | 'polygon';
  idx: FileEntry; geo: FileEntry[]; chains: FileEntry | null;
}

export const MAX_SELECTION = 1000;
const BY_ID_MAX = 20;
const TIMEOUT_MS = 10_000;

const Fail = IoFail<LineFailure>;

// ─── Index ───────────────────────────────────────────────────────────────────
let refreshedOnce = false;

async function datasetOf(layerId: string): Promise<DatasetEntry> {
  const ds = layerById(layerId)?.data?.analysis;
  if (!ds) throw new Fail('unavailable');
  const entry = (await loadIndex()).datasets?.[ds] as DatasetEntry | undefined;
  if (!entry) throw new Fail('unavailable');
  return entry;
}

// ─── Row keys ────────────────────────────────────────────────────────────────
const keyOf = (ds: DatasetEntry, fid: string | number): Key | null => {
  if (ds.fid_type === 'string') return String(fid);
  try { return BigInt(fid); } catch { return null; }
};
const sameKey = (a: unknown, b: Key) => (typeof b === 'bigint' ? a === b : String(a) === b);

// ─── Calls ───────────────────────────────────────────────────────────────────
const lookups = new Map<string, Promise<IdxRow | null>>();

async function guard<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<LineOutcome<T>> {
  const stop = new AbortController();   // a timed-out or failed call stops its queued and running requests
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Fail('timeout')), TIMEOUT_MS); });
  // A rebuild renames the files under an open tab: read index.json again and try once more.
  const run = () => fn(stop.signal).catch((e: unknown) => {
    if (!(e instanceof IoFail && e.reason === 'stale-build')) throw e;
    forgetIndex();
    return fn(stop.signal);
  });
  try { return { ok: true, result: await Promise.race([run(), timeout]) }; }
  catch (e) { return { ok: false, reason: e instanceof IoFail ? e.reason as LineFailure : 'offline' }; }
  finally { clearTimeout(timer); stop.abort(); }
}

async function idxRow(ds: DatasetEntry, fid: string | number): Promise<IdxRow | null> {
  const key = keyOf(ds, fid);
  if (key === null) return null;
  const file = openFile(ds, ds.idx);
  const md = await file.meta;
  for (const [a, b] of groupsHolding(md, 'fid', key)) {
    const hit = (await readRows(file, md, a, b)).find(r => sameKey(r.fid, key));
    if (hit) return {
      row: Number(hit.row), length_km: hit.length_km == null ? NaN : Number(hit.length_km),
      geometry: ds.geometry ?? 'line',
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
    forgetIndex();
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
async function geometryByRows(ds: DatasetEntry, rows: number[], signal?: AbortSignal): Promise<Map<number, { fid: unknown; geometry: GeoJSON.Geometry }>> {
  const byPart = new Map<FileEntry, number[]>();
  for (const r of rows) {
    const p = partOf(ds, r);
    byPart.set(p, [...(byPart.get(p) ?? []), r - (p.row_offset ?? 0)]);
  }
  const out = new Map<number, { fid: unknown; geometry: GeoJSON.Geometry }>();
  await Promise.all([...byPart].map(async ([part, local]) => {
    const file = signal ? withSignal(openFile(ds, part), signal) : openFile(ds, part);
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

const groupBytes = (rg: FileMetaData['row_groups'][number]) =>
  rg.columns.reduce((n, c) => n + Number(c.meta_data?.total_compressed_size ?? 0), 0);

/** What each way of reading a selection would fetch, from the footers and the bbox page index. */
export interface SelectionPlan { bbox: number; byId: number; runs: Map<FileEntry, [number, number][]>; choice: 'bbox' | 'id' }

/** More than BY_ID_MAX ids: the GEO bytes the bbox runs cover, against the IDX groups holding the ids plus the
 *  pages those ids' rows may fall in (a page per id at most); the smaller is chosen. Reads indexes, no geometry. */
export async function selectionPlan(layerId: string, fids: (string | number)[], bbox: Bbox, signal?: AbortSignal): Promise<SelectionPlan> {
  const ds = await datasetOf(layerId);
  const sig = (f: OpenFile) => (signal ? withSignal(f, signal) : f);
  let rows = 0, geoBytes = 0, bboxBytes = 0;
  const runs = new Map<FileEntry, [number, number][]>();
  await Promise.all(ds.geo.map(async part => {
    const file = sig(openFile(ds, part));
    const md = await file.meta;
    let pr = 0, pb = 0;
    for (const rg of md.row_groups) { pr += Number(rg.num_rows); pb += Number(chunkOf(rg, 'geometry')?.meta_data?.total_compressed_size ?? 0); }
    const r = await bboxRanges(file, md, bbox);
    runs.set(part, r);
    rows += pr; geoBytes += pb;
    bboxBytes += r.reduce((n, [a, b]) => n + (b - a), 0) * (pr ? pb / pr : 0);
  }));
  // A page holds the rows of at most ~1 MiB; an older file's 256-row pages are the same bound in rows.
  const rowBytes = rows ? geoBytes / rows : 0;
  const pageBytes = Math.max(rowBytes, Math.min(256 * rowBytes, 2 ** 20));
  const file = sig(openFile(ds, ds.idx));
  const md = await file.meta;
  const groups = new Set<number>();
  for (const fid of fids) {
    const key = keyOf(ds, fid);
    if (key === null) continue;
    for (const [a] of groupsHolding(md, 'fid', key)) groups.add(a);
  }
  let idxBytes = 0, start = 0;
  for (const rg of md.row_groups) { if (groups.has(start)) idxBytes += groupBytes(rg); start += Number(rg.num_rows); }
  const byId = idxBytes + Math.min(fids.length * pageBytes, geoBytes);
  return { bbox: bboxBytes, byId, runs, choice: byId < bboxBytes ? 'id' : 'bbox' };
}

export function selectionGeometry(layerId: string, fids: (string | number)[], bbox: Bbox, plan?: 'bbox' | 'id'): Promise<LineOutcome<Selection>> {
  return guard(async signal => {
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
    const sp = await selectionPlan(layerId, fids, bbox, signal);
    if ((plan ?? sp.choice) === 'id') {
      const file = withSignal(openFile(ds, ds.idx), signal);
      const md = await file.meta;
      const rowOf = new Map<string, number>();
      const groups = new Set<string>();
      const want = new Map<string, Key>();
      for (const fid of fids) { const k = keyOf(ds, fid); if (k !== null) want.set(String(fid), k); }
      for (const k of want.values()) for (const [a, b] of groupsHolding(md, 'fid', k)) groups.add(`${a}:${b}`);
      await Promise.all([...groups].map(async g => {
        const [a, b] = g.split(':').map(Number);
        for (const r of await readRows(file, md, a, b)) if (want.has(String(r.fid))) rowOf.set(String(r.fid), Number(r.row));
      }));
      const geoms = await geometryByRows(ds, [...rowOf.values()], signal);
      for (const [fid, row] of rowOf) {
        const got = geoms.get(row);
        if (!got) continue;
        if (String(got.fid) !== fid) throw new Fail('stale-build');
        geometries.set(fid, got.geometry);
      }
    } else {
      const wantIds = new Set(fids.map(String));
      await Promise.all(ds.geo.map(async part => {
        const file = withSignal(openFile(ds, part), signal);
        const md = await file.meta;
        await Promise.all((sp.runs.get(part) ?? []).map(async ([a, b]) => {
          for (const r of await readRows(file, md, a, b, ['fid', 'geometry'], true))
            if (wantIds.has(String(r.fid))) geometries.set(String(r.fid), r.geometry as GeoJSON.Geometry);
        }));
      }));
    }
    for (const fid of fids) if (!geometries.has(String(fid))) missing.push(fid);
    return { geometries, missing };
  });
}

export function lineDataset(layerId: string): Promise<LineOutcome<DatasetEntry>> {
  return guard(() => datasetOf(layerId));
}

/** Test support: forget the index, the files, the cached bytes and the lookups. */
export function resetLineRead() {
  resetRangeIo(); refreshedOnce = false; lookups.clear();
}
