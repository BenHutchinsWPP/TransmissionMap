// ─── Columns-only Parquet reader (lazy chunk) ─────────────────────────────────
// Role: a tiled dataset's attributes for the whole dataset, read by HTTP range
//       from data/analysis/columns/<ds>.<sha8>.parquet (built by
//       scripts/build_columns_parquet.py; index.json `columns` section).
//   columnsEntry(ds)      the dataset's index.json entry, or why there is none
//   pruneGroups(md, conds)  the row groups that may hold a row passing every
//                         condition (pure, conservative): number = < <= > >= in
//                         against min/max statistics of a numeric column; region
//                         contains/contains_any against the footer's
//                         region_codes; any other condition, or a group without
//                         statistics or codes, keeps the group
//   columnsFor(entry, conds, filters, wanted, opts)  the columns a call reads:
//                         wanted ∪ every column named as a string in the
//                         conditions/filters, plus the id column for row queries
//                         or a filter holding the native-id expression ["id"]
//   readGroups(entry, groups, columns)  rows of those groups, one group at a time, no read-ahead (a
//                         caller may stop early); the page is yielded to every ROW_YIELD rows
//   readRowsAt(entry, rows, columns)    rows by absolute row number: each row group holding one is read once,
//                         whole; the next group's columns are fetched while this one's rows are built
//   readColumns(entry, md, g, columns)  the Cols of one row group: the chunks of the columns not yet
//                         decoded are fetched as one range request per run of chunks, runs being joined
//                         when the gap between them is at most RANGE_GAP (64 KiB), so the bytes fetched stay
//                         close to plannedBytes (range-io: timeout, in-flight limit, byte cache,
//                         requestLog, build_id); then one decode per column (columns-decode.ts), in a worker
//                         when there is one
//   Yielding: `yieldToPage` waits one MessageChannel message (not throttled in a hidden tab, unlike
//                         setTimeout), setTimeout(0) where there is no MessageChannel
//   resetDecoded()        test support: forget the decoded cache and the worker state
//   readTwoPhase(entry, groups, first, rest, pick)  phase 1 reads `first` for
//                         every row, `pick` keeps some; phase 2 reads `rest` for
//                         the kept rows only
//   plannedBytes(entry, groups, columns)  compressed column-chunk bytes
// Decoded cache: each (file, build_id, row group, column) is decoded once, as a Col (dictionary +
//   codes), held in one LRU across files: key `${path}${file.name}|${build_id}|${g}|${column}`, a Promise
//   shared while in flight, dropped when it fails. Settled entries are evicted oldest-first (a hit
//   re-inserts) to stay within DECODED_CACHE_BYTES by `estimateBytes`; a Col larger than the cap is
//   returned but not kept. A running call holds its own reference, so eviction never changes a result.
// Decode: each column is its own message {id, schema, rowGroup, column, bytes, start} to the module worker
//   columns-worker.ts, `bytes` being that column's chunk (copied by postMessage, never transferred: the
//   range-io buffer is its cache's); the reply {id, ok, col} carries `codes` transferred. `ok: false`
//   rejects with a plain Error('columns decode') (outcome `error`). No Worker global, a constructor that
//   throws, onerror or onmessageerror: the worker is dropped, decoding runs inline for the session and
//   every pending request is re-run inline, as it is when a reply takes longer than REPLY_TIMEOUT_MS (30 s).
//   The worker is created on first use, never at load.
// Rows: {type (1 point, 2 line, 3 polygon), id, properties, measures, at}. A native
//   id (int64 `fid`) is the row id only, a Number after Number.isSafeInteger
//   (else `unsafe-id`); any other id stays a property too. A null value is left
//   out of `properties`, "" is kept. length_km, area_km2, px, py go in `measures`; px/py are stored as int32 micro-degrees and read as degrees.
// Failures (Fail.reason): range-io's (`unavailable`, `offline`, `stale-build`,
//   `timeout`) and `unsafe-id`.
// Deps: parquet/range-io.ts (hyparquet + fzstd), columns-decode.ts, columns-worker.ts (worker entry), src/registry/columns.ts,
//   src/registry/condition-compile.ts (types). Imported only by dynamic import()
//   (dataset-query.ts), so hyparquet stays out of the boot bundle.

import type { FileMetaData, ColumnChunk } from 'hyparquet';
import { Fail, loadIndex, openFile, type FileDir, type FileEntry } from '../parquet/range-io.js';
import { decodeColumn, estimateBytes, expand, groupRange, type Col, type DecodeInput } from './columns-decode.js';
import { COLUMNS_DATASETS } from '../../src/registry/columns.js';
import type { Condition } from '../../src/registry/condition-compile.js';

export type ColumnsFailure = 'unavailable' | 'offline' | 'stale-build' | 'timeout' | 'unsafe-id';
export type ColumnsOutcome<T> = { ok: true; result: T } | { ok: false; reason: ColumnsFailure };

export interface ColumnsEntry extends FileDir {
  dataset: string;
  file: FileEntry;
  geometry: 'point' | 'line' | 'polygon';
  id: { field: string; native: boolean };
  columns: string[];
}

export interface ColumnsRow {
  type: number;
  id: string | number | undefined;
  properties: Record<string, unknown>;
  measures: Record<string, number>;
  at: number;   // absolute row number in the file
}

const MICRODEG = 1e6;
export const MEASURES: ReadonlySet<string> = new Set(['length_km', 'area_km2', 'px', 'py']);
const GEOMETRY_CODE = { point: 1, line: 2, polygon: 3 } as const;
const NUMERIC = new Set(['INT32', 'INT64', 'FLOAT', 'DOUBLE']);

// ─── Index entry ─────────────────────────────────────────────────────────────
export async function columnsEntry(dataset: string): Promise<ColumnsOutcome<ColumnsEntry>> {
  if (!(COLUMNS_DATASETS as readonly string[]).includes(dataset)) return { ok: false, reason: 'unavailable' };
  try {
    const e = (await loadIndex()).columns?.[dataset] as Partial<ColumnsEntry> | undefined;
    const ok = e && typeof e.path === 'string' && typeof e.build_id === 'string'
      && e.file && typeof e.file.name === 'string' && Number.isFinite(e.file.bytes) && Number.isFinite(e.file.footer_len)
      && e.geometry && e.geometry in GEOMETRY_CODE
      && e.id && typeof e.id.field === 'string' && Array.isArray(e.columns);
    if (!ok) return { ok: false, reason: 'unavailable' };
    return { ok: true, result: { ...e, dataset } as ColumnsEntry };
  } catch (err) {
    return { ok: false, reason: err instanceof Fail ? err.reason as ColumnsFailure : 'offline' };
  }
}

/** The file's footer; a footer naming another dataset is `stale-build`. */
export async function columnsMeta(entry: ColumnsEntry): Promise<FileMetaData> {
  const md = await openFile(entry, entry.file).meta;
  const ds = md.key_value_metadata?.find(kv => kv.key === 'dataset')?.value;
  if (ds !== undefined && ds !== entry.dataset) throw new Fail('stale-build');
  return md;
}

// ─── Pruning ─────────────────────────────────────────────────────────────────
type Meta = Pick<FileMetaData, 'row_groups' | 'key_value_metadata' | 'schema'>;

/** region_codes from the footer: one {field: codes} per row group, or null when absent or malformed. */
function regionCodes(md: Meta): Record<string, string[]>[] | null {
  const raw = md.key_value_metadata?.find(kv => kv.key === 'region_codes')?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length === md.row_groups.length ? v as Record<string, string[]>[] : null;
  } catch { return null; }
}

/** A statistic as a number, or null when it cannot be compared exactly. */
function statNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') { const n = Number(v); return Number.isSafeInteger(n) ? n : null; }
  return null;
}

/** Whether row group `rg` may hold a row passing `c` (true unless the statistics or codes rule it out). */
function mayHold(md: Meta, rg: number, c: Condition, codes: Record<string, string[]>[] | null): boolean {
  if (c.op === 'contains' || c.op === 'contains_any') {
    const have = codes?.[rg]?.[c.field];
    if (!Array.isArray(have)) return true;
    const want = c.op === 'contains' ? [c.value] : c.value;
    return !Array.isArray(want) || want.some(v => have.includes(v as string));
  }
  if (!['=', '<', '<=', '>', '>=', 'in'].includes(c.op)) return true;
  const vals = c.op === 'in' ? c.value : [c.value];
  if (!Array.isArray(vals) || !vals.every(v => typeof v === 'number' && Number.isFinite(v))) return true;
  const el = md.schema.find(s => s.name === c.field && !s.num_children);
  if (!el?.type || !NUMERIC.has(el.type)) return true;   // a number stored as text: to-number semantics, no pruning
  const chunk = md.row_groups[rg].columns.find((cc: ColumnChunk) => cc.meta_data?.path_in_schema.join('.') === c.field);
  const st = chunk?.meta_data?.statistics;
  const lo = statNumber(st?.min_value ?? st?.min), hi = statNumber(st?.max_value ?? st?.max);
  if (lo === null || hi === null) return true;
  const v = vals as number[];
  switch (c.op) {
    case '=': case 'in': return v.some(x => lo <= x && x <= hi);
    case '<':  return lo < v[0];
    case '<=': return lo <= v[0];
    case '>':  return hi > v[0];
    default:   return hi >= v[0];   // '>='
  }
}

/** Indices of the row groups that may hold a row passing every condition. Pure. */
export function pruneGroups(md: Meta, conds: readonly Condition[]): number[] {
  const codes = regionCodes(md);
  const out: number[] = [];
  for (let g = 0; g < md.row_groups.length; g++)
    if (conds.every(c => mayHold(md, g, c, codes))) out.push(g);
  return out;
}

// ─── Columns ─────────────────────────────────────────────────────────────────
/** Whether a filter expression holds the native-id expression ["id"] anywhere. */
export function hasIdExpr(x: unknown): boolean {
  if (!Array.isArray(x)) return false;
  if (x.length === 1 && x[0] === 'id') return true;
  return x.some(hasIdExpr);
}

function strings(x: unknown, out: Set<string>) {
  if (typeof x === 'string') out.add(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
}

/** The id column: `fid` for a native id, else the id field. */
export const idColumn = (entry: ColumnsEntry) => (entry.id.native ? 'fid' : entry.id.field);

/** The columns a call reads, in file order. `rows`: the call returns rows (needs the id). */
export function columnsFor(
  entry: ColumnsEntry, conds: readonly Condition[], filters: readonly unknown[], wanted: readonly string[],
  opts: { rows?: boolean } = {},
): string[] {
  const names = new Set<string>(wanted);
  strings(conds, names);
  strings(filters, names);
  if (opts.rows || filters.some(hasIdExpr)) names.add(idColumn(entry));
  return entry.columns.filter(c => names.has(c));
}

// ─── Rows ────────────────────────────────────────────────────────────────────
function safe(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Fail<ColumnsFailure>('unsafe-id');
  return n;
}

/** One file row → a ColumnsRow. */
export function rowOf(entry: ColumnsEntry, raw: Record<string, unknown>, at: number): ColumnsRow {
  const row: ColumnsRow = { type: GEOMETRY_CODE[entry.geometry], id: undefined, properties: {}, measures: {}, at };
  merge(entry, row, raw);
  return row;
}

function merge(entry: ColumnsEntry, row: ColumnsRow, raw: Record<string, unknown>) {
  const idCol = idColumn(entry);
  for (const [k, v0] of Object.entries(raw)) {
    if (v0 === null || v0 === undefined) continue;
    const v = typeof v0 === 'bigint' ? safe(v0) : v0;
    if (k === idCol) row.id = v as string | number;
    if (MEASURES.has(k)) row.measures[k] = k === 'px' || k === 'py' ? (v as number) / MICRODEG : (v as number);
    else if (!(entry.id.native && k === idCol)) row.properties[k] = v;
  }
}

const groupStarts = (md: FileMetaData) => {
  const starts: number[] = [];
  let s = 0;
  for (const rg of md.row_groups) { starts.push(s); s += Number(rg.num_rows); }
  return starts;
};

const yieldToPage = () => new Promise<void>(r => {
  if (typeof MessageChannel !== 'function') { setTimeout(r, 0); return; }
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); r(); };
  port2.postMessage(0);
});
export const ROW_YIELD = 8192;
export const RANGE_GAP = 64 * 1024;
export const REPLY_TIMEOUT_MS = 30_000;
export const DECODED_CACHE_BYTES = 48 * 1024 * 1024;

// ─── Decode (worker, else inline) ────────────────────────────────────────────
interface Pending { input: DecodeInput; resolve: (c: Col) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
let worker: Worker | null = null;
let inline = typeof Worker !== 'function';
let nextId = 0;
const pending = new Map<number, Pending>();

const decodeError = () => new Error('columns decode');

function runInline(p: Pending) {
  decodeColumn(p.input).then(p.resolve, () => p.reject(decodeError()));
}

function dropWorker(w: Worker) {
  w.terminate();
  if (worker === w) worker = null;
  inline = true;
  const rerun = [...pending.values()];
  pending.clear();
  for (const p of rerun) { clearTimeout(p.timer); runInline(p); }
}

function getWorker(): Worker | null {
  if (inline) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./columns-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; col?: Col }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok && e.data.col) p.resolve(e.data.col); else p.reject(decodeError());
    };
    w.onerror = () => dropWorker(w);
    w.onmessageerror = () => dropWorker(w);
    return (worker = w);
  } catch {
    inline = true;
    return null;
  }
}

function decode(input: DecodeInput): Promise<Col> {
  return new Promise<Col>((resolve, reject) => {
    const p: Pending = { input, resolve, reject };
    const w = getWorker();
    if (!w) { runInline(p); return; }
    const id = ++nextId;
    pending.set(id, p);
    p.timer = setTimeout(() => { if (pending.has(id)) dropWorker(w); }, REPLY_TIMEOUT_MS);
    try { w.postMessage({ id, ...input }); }   // copied, never transferred
    catch { dropWorker(w); }
  });
}

// ─── Decoded cache ───────────────────────────────────────────────────────────
interface Held { col: Promise<Col>; bytes: number | null }
const decoded = new Map<string, Held>();   // insertion order = least recently used first
let decodedCap = DECODED_CACHE_BYTES;
let decodedBytes = 0;

function settle(key: string, h: Held, c: Col) {
  if (decoded.get(key) !== h) return;
  h.bytes = estimateBytes(c);
  if (h.bytes > decodedCap) { decoded.delete(key); return; }
  decodedBytes += h.bytes;
  for (const [k, e] of decoded) {
    if (decodedBytes <= decodedCap) break;
    if (e.bytes === null) continue;
    decoded.delete(k);
    decodedBytes -= e.bytes;
  }
}

/** Test support: forget the decoded cache and the worker state. */
export function resetDecoded() {
  decoded.clear(); decodedBytes = 0; decodedCap = DECODED_CACHE_BYTES;
  worker?.terminate();
  worker = null; for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear(); inline = typeof Worker !== 'function';
}

/** Test support: the cache cap (resetDecoded restores it). */
export function setDecodedCap(n: number) { decodedCap = n; }

export interface Run { start: number; end: number; piece?: Promise<ArrayBuffer> }

/** The byte runs holding the chunks of `columns` in row group `g`: chunks whose gap is at most `gap` share a run. Pure. */
export function rangeRuns(md: Pick<FileMetaData, 'row_groups'>, g: number, columns: readonly string[], gap = RANGE_GAP) {
  const want = columns.map(c => ({ c, ...groupRange(md, g, [c]) })).sort((x, y) => x.start - y.start);
  const runs: Run[] = [];
  const runOf = new Map<string, Run>();
  for (const w of want) {
    let run = runs[runs.length - 1];
    if (run && w.start - run.end <= gap) run.end = Math.max(run.end, w.end);
    else runs.push(run = { start: w.start, end: w.end });
    runOf.set(w.c, run);
  }
  return { runs, runOf, want };
}

/** Cols of `columns` in row group `g`, in the order given: one range request for those not decoded yet. */
export function readColumns(entry: ColumnsEntry, md: FileMetaData, g: number, columns: readonly string[]): Promise<Col[]> {
  const base = `${entry.path}${entry.file.name}|${entry.build_id}|${g}|`;
  const missing = columns.filter(c => {
    const h = decoded.get(base + c);
    if (h) { decoded.delete(base + c); decoded.set(base + c, h); }   // most recently used
    return !h;
  });
  if (missing.length) {
    const { runs, runOf, want } = rangeRuns(md, g, missing);
    for (const r of runs) {
      try { r.piece = Promise.resolve(openFile(entry, entry.file).buf.slice(r.start, r.end)); }
      catch (e) { r.piece = Promise.reject(e); }
    }
    for (const w of want) {
      const key = base + w.c, run = runOf.get(w.c)!;
      const col = run.piece!.then(buf => decode({
        schema: md.schema, rowGroup: md.row_groups[g], column: w.c,
        bytes: buf.slice(w.start - run.start, w.end - run.start), start: w.start,
      }));
      const h: Held = { col, bytes: null };
      decoded.set(key, h);
      col.then(x => settle(key, h, x), () => { if (decoded.get(key) === h) decoded.delete(key); });
    }
  }
  return Promise.all(columns.map(c => decoded.get(base + c)?.col ?? Promise.reject(new Fail('stale-build'))));
}

/** The columns in file schema order (the order hyparquet's object rows take), each once. */
function inSchemaOrder(md: FileMetaData, columns: readonly string[]): string[] {
  const at = new Map(md.schema.map((s, i) => [s.name, i]));
  return [...new Set(columns)].sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
}

/** Raw row i of a group: the columns' values, nulls as null, keys in `names` order. */
function rawOf(names: readonly string[], cols: readonly Col[], i: number): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (let j = 0; j < names.length; j++) raw[names[j]] = expand(cols[j], i);
  return raw;
}

/** Rows of the given row groups, reading `columns` only, one group at a time. */
export async function* readGroups(entry: ColumnsEntry, groups: readonly number[], columns: readonly string[]): AsyncGenerator<ColumnsRow> {
  const md = await columnsMeta(entry);
  const starts = groupStarts(md);
  const names = inSchemaOrder(md, columns);
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    const a = starts[g], n = Number(md.row_groups[g].num_rows);
    const cols = names.length ? await readColumns(entry, md, g, names) : [];
    for (let i = 0; i < n; i++) {
      yield rowOf(entry, rawOf(names, cols, i), a + i);
      if ((i + 1) % ROW_YIELD === 0) await yieldToPage();
    }
    await yieldToPage();
  }
}

/** Rows by absolute row number, reading `columns` only; each row group holding one is read once, whole. Keyed by row number. */
export async function readRowsAt(entry: ColumnsEntry, rows: readonly number[], columns: readonly string[]): Promise<Map<number, ColumnsRow>> {
  const md = await columnsMeta(entry);
  const starts = groupStarts(md);
  const names = inSchemaOrder(md, columns);
  const want = new Set(rows);
  const out = new Map<number, ColumnsRow>();
  const todo: number[] = [];
  for (let g = 0; g < starts.length; g++) {
    const a = starts[g], b = a + Number(md.row_groups[g].num_rows);
    for (const r of want) if (r >= a && r < b) { todo.push(g); break; }
  }
  const fetch = (k: number) => {
    if (k >= todo.length || !names.length) return null;
    const p = readColumns(entry, md, todo[k], names);
    p.catch(() => {});   // an error is thrown where it is awaited
    return p;
  };
  let next = fetch(0);
  for (let k = 0; k < todo.length; k++) {
    const g = todo[k], a = starts[g], b = a + Number(md.row_groups[g].num_rows);
    if (k) await yieldToPage();
    const cols = next ? await next : [];
    next = fetch(k + 1);
    let done = 0;
    for (let i = 0; i < b - a; i++) {
      if (!want.has(a + i)) continue;
      out.set(a + i, rowOf(entry, rawOf(names, cols, i), a + i));
      if (++done % ROW_YIELD === 0) await yieldToPage();
    }
  }
  return out;
}

/** Phase 1 reads `first` over `groups`; `pick` keeps rows (it may stop early);
 *  phase 2 reads `rest` for the kept rows only and merges them in, in pick's order. */
export async function readTwoPhase(
  entry: ColumnsEntry, groups: readonly number[], first: readonly string[], rest: readonly string[],
  pick: (rows: AsyncIterable<ColumnsRow>) => Promise<ColumnsRow[]>,
): Promise<ColumnsRow[]> {
  const kept = await pick(readGroups(entry, groups, first));
  const more = rest.filter(c => !first.includes(c));
  if (!kept.length || !more.length) return kept;
  const extra = await readRowsAt(entry, kept.map(r => r.at), more);
  for (const r of kept) {
    const x = extra.get(r.at);
    if (!x) throw new Fail('stale-build');
    if (x.id !== undefined) r.id = x.id;
    Object.assign(r.properties, x.properties);
    Object.assign(r.measures, x.measures);
  }
  return kept;
}

// ─── Budget ──────────────────────────────────────────────────────────────────
/** Compressed bytes of `columns` in `groups`, from the footer's column-chunk sizes. */
export async function plannedBytes(entry: ColumnsEntry, groups: readonly number[], columns: readonly string[]): Promise<number> {
  const md = await columnsMeta(entry);
  const want = new Set(columns);
  let n = 0;
  for (const g of groups)
    for (const c of md.row_groups[g].columns)
      if (c.meta_data && want.has(c.meta_data.path_in_schema.join('.'))) n += Number(c.meta_data.total_compressed_size);
  return n;
}
