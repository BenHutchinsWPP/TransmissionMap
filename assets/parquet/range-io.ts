// ─── Parquet range reads over data/analysis/ (lazy chunk) ─────────────────────
// Role: the HTTP range machinery the analysis readers share: index.json, the
//       open files (footer read, build_id checked), the range requests, a byte
//       cache, and the pure row-group helpers.
//   loadIndex()          index.json, with a `datasets` and/or a `columns` section;
//                        none of them (or no file) is `unavailable`, remembered for
//                        the session; any other failure is tried again next call
//   forgetIndex()        read index.json again on the next loadIndex
//   openFile(dir, entry) a file under `dir.path`: an AsyncBuffer and its footer,
//                        held for the session; a footer whose build_id is not
//                        `dir.build_id` is `stale-build`
//   readRange(url, …)    one `Range: bytes=N-M` GET through the cache
//   readRows             hyparquet rows with the ZSTD codec
//   withSignal(file, s)  the file with its requests tied to an AbortSignal
//   groupsHolding, rowRuns   pure row-group / row-run helpers
// Requests: plain bounded-range GETs, same-origin credentials only, never a HEAD
//   or a suffix range — byteLength and the footer length come from index.json.
//   Each request is aborted after REQUEST_TIMEOUT_MS (its own clock, from when it
//   starts), and at most MAX_IN_FLIGHT run at once; the rest wait for a slot.
//   Fetched ranges sit in one least-recently-used cache of CACHE_BYTES across all
//   files; a range inside a cached one is served from it; a failed range leaves
//   no entry. A file whose footer fails is closed and its ranges dropped.
// Failures (Fail.reason): `unavailable`, `offline`, `stale-build` (a 404 for a
//   content-hashed name, another document under that name, a build_id mismatch),
//   `timeout`. Callers may throw their own reasons with the same class.
// Deps: hyparquet + fzstd, constants.ts (DATA.line_index). Imported only from
//   lazy chunks (lines/line-read.ts), so hyparquet stays out of the boot bundle.

import { parquetMetadataAsync, parquetReadObjects,
  type AsyncBuffer, type FileMetaData, type ColumnChunk, type Compressors } from 'hyparquet';
import { decompress } from 'fzstd';
import { DATA } from '../constants.js';

export type IoFailure = 'unavailable' | 'offline' | 'stale-build' | 'timeout';
export class Fail<R extends string = IoFailure> extends Error { constructor(readonly reason: R) { super(reason); } }

export interface FileEntry { name: string; bytes: number; footer_len: number; rows: number; row_offset?: number }
export interface FileDir { path: string; build_id: string }
export interface AnalysisIndex { version: number; datasets?: Record<string, unknown>; columns?: Record<string, unknown> }
type SignalSlice = (start: number, end?: number, signal?: AbortSignal) => Promise<ArrayBuffer>;
export interface OpenFile { buf: AsyncBuffer & { slice: SignalSlice }; meta: Promise<FileMetaData> }

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_IN_FLIGHT = 6;
export const CACHE_BYTES = 32 * 1024 * 1024;
export const RUN_GAP = 64;
const COMPRESSORS: Compressors = { ZSTD: (input: Uint8Array) => decompress(input) };

// ─── Requests ────────────────────────────────────────────────────────────────
let active = 0;
const waiting: (() => void)[] = [];

/** Runs `fn` once fewer than MAX_IN_FLIGHT are running; a finished run hands its slot on. */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_IN_FLIGHT) active++;
  else await new Promise<void>(r => waiting.push(r));
  try { return await fn(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}

/** fetch + read, aborted after REQUEST_TIMEOUT_MS (body included), so a stalled request frees its slot and leaves no cache entry. */
function fetchTimed<T>(url: string, init: RequestInit, read: (res: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return slot(async () => {
    if (signal?.aborted) throw new Fail('timeout');   // a caller that gave up: a queued request never starts
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new Fail('timeout')); }, REQUEST_TIMEOUT_MS);
    });
    try { return await Promise.race([fetch(url, { ...init, signal: ctrl.signal }).then(read), timedOut]); }
    catch (e) { throw e instanceof Fail ? e : new Fail(ctrl.signal.aborted ? 'timeout' : 'offline'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  });
}

/** The last 500 range requests since the last reset — for tests and diagnostics. */
export const requestLog: { url: string; start: number; end: number }[] = [];

function fetchRange(url: string, start: number, end: number, size: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (requestLog.push({ url, start, end }) > 500) requestLog.shift();
  return fetchTimed(url, { credentials: 'same-origin', headers: { Range: `bytes=${start}-${end - 1}` } }, async res => {
    if (res.status === 404) throw new Fail('stale-build');   // a content-hashed name the host no longer has
    if (!res.ok) throw new Fail('offline');
    const body = await res.arrayBuffer();
    if (res.status === 206 && body.byteLength === end - start) return body;
    if (res.status === 200 && body.byteLength === size) return body.slice(start, end);   // a host that ignores Range
    if (res.status === 200) throw new Fail('stale-build');   // another document under that name (a dev server's page for a missing file)
    throw new Fail('offline');
  }, signal);
}

// ─── Byte cache (LRU) ────────────────────────────────────────────────────────
interface Cached { url: string; start: number; end: number; data: Promise<ArrayBuffer> }
const cache = new Set<Cached>();   // insertion order = least recently used first
let cachedBytes = 0;

function drop(rec: Cached) {
  if (cache.delete(rec)) cachedBytes -= rec.end - rec.start;
}

/** Bytes [start, end) of `url` (a file of `size` bytes), from the cache when a cached range holds them. */
export function readRange(url: string, start: number, end: number, size: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  for (const c of cache) {
    if (c.url !== url || start < c.start || c.end < end) continue;
    cache.delete(c); cache.add(c);   // most recently used
    return c.data.then(b => b.slice(start - c.start, end - c.start));
  }
  const data = fetchRange(url, start, end, size, signal);
  const rec = { url, start, end, data };
  cache.add(rec);
  cachedBytes += end - start;
  for (const old of cache) { if (cachedBytes <= CACHE_BYTES) break; drop(old); }
  data.catch(() => drop(rec));
  return data;
}

// ─── Index ───────────────────────────────────────────────────────────────────
const BASE = DATA.line_index.slice(0, DATA.line_index.lastIndexOf('/') + 1);
let indexLoad: Promise<AnalysisIndex> | null = null;

const isSection = (v: unknown) => v != null && typeof v === 'object';

export function loadIndex(): Promise<AnalysisIndex> {
  return indexLoad ??= fetchTimed(DATA.line_index, { credentials: 'same-origin', cache: 'no-cache' }, async res => {
    if (!res.ok) throw new Fail('unavailable');
    const idx = await res.json().catch(() => null) as AnalysisIndex | null;
    if (!idx || typeof idx !== 'object' || !(isSection(idx.datasets) || isSection(idx.columns))) throw new Fail('unavailable');
    return idx;
  }).catch(e => { if (!(e instanceof Fail && e.reason === 'unavailable')) indexLoad = null; throw e; });
}

export function forgetIndex() { indexLoad = null; }

// ─── Files ───────────────────────────────────────────────────────────────────
const files = new Map<string, OpenFile>();

export function openFile(dir: FileDir, entry: FileEntry): OpenFile {
  const url = BASE + dir.path + entry.name;
  const hit = files.get(url);
  if (hit) return hit;
  const buf: OpenFile['buf'] = {
    byteLength: entry.bytes,
    slice: (start: number, end = entry.bytes, signal?: AbortSignal) => readRange(url, start, end, entry.bytes, signal),
  };
  const meta = parquetMetadataAsync(buf, { initialFetchSize: entry.footer_len + 8 }).then(md => {
    const build = md.key_value_metadata?.find(kv => kv.key === 'build_id')?.value;
    if (build !== dir.build_id) throw new Fail('stale-build');
    return md;
  });
  const file = { buf, meta };
  files.set(url, file);
  meta.catch(() => {
    files.delete(url);
    for (const c of [...cache]) if (c.url === url) drop(c);
  });
  return file;
}

/** The same file whose range requests stop (queued ones never start, started ones abort) when `signal` aborts. */
export function withSignal(file: OpenFile, signal: AbortSignal): OpenFile {
  return { meta: file.meta, buf: { byteLength: file.buf.byteLength, slice: (start, end) => file.buf.slice(start, end, signal) } };
}

export function readRows(file: OpenFile, md: FileMetaData, rowStart: number, rowEnd: number, columns?: string[], offsetIndex = false) {
  return parquetReadObjects({ file: file.buf, metadata: md, rowStart, rowEnd, columns,
    compressors: COMPRESSORS, useOffsetIndex: offsetIndex, rowFormat: 'object' }) as Promise<Record<string, unknown>[]>;
}

// ─── Row groups by statistics ────────────────────────────────────────────────
export type Key = bigint | string;

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

/** Test support: forget the index, the files, the cached bytes and the request log (in-flight slots are kept). */
export function resetRangeIo() {
  indexLoad = null;
  files.clear(); cache.clear(); cachedBytes = 0; requestLog.length = 0;
}
