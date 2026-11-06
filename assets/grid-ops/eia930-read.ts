// ─── Grid Operations: EIA-930 hours from PUDL (lazy chunk) ───────────────────
// Role: read one hour of EIA-930 for every balancing authority straight from
//       PUDL's published Parquet (PUDL_BASE_URL) by HTTP range request:
//         core_eia930__hourly_operations    demand, net generation, total interchange (EIA-adjusted)
//         core_eia930__hourly_interchange   each BA's reported flow to each neighbour
//         core_eia930__hourly_net_generation_by_energy_source  net generation by fuel (EIA-adjusted)
//       The files are cut into row groups by time (operations and interchange
//       by about six months, fuels by about three days), all BAs inside each,
//       so an hour reads the needed columns of the row groups whose time
//       statistics hold it: ~5 MB the first time, then nothing for any other
//       hour inside those row groups (playback through a half-year costs only
//       the fuel groups, ~0.2 MB per three days). Decoded row groups are kept,
//       a few per table, newest used last out.
// Values: MW at the end of the hour (`datetime_utc` is hour-ending); the PUDL
//       `_mwh` suffix is a relabel, not a conversion. Nulls stay null.
// Failures come back as a ReadFailure, never thrown: `offline` (a fetch failed
//       or timed out), `no-data` (no row group holds the hour, or none of its
//       rows do).
// Deps: hyparquet + fzstd (this chunk and lines/ only), constants.ts
//       (PUDL_BASE_URL), ba-graph.ts (the HourData shape). Imported only by
//       grid-ops.ts, dynamically.

import { parquetMetadataAsync, parquetRead, type AsyncBuffer, type FileMetaData, type Compressors } from 'hyparquet';
import { decompress } from 'fzstd';
import { PUDL_BASE_URL } from '../constants.js';
import type { HourData, BaHour, PairReport } from './ba-graph.js';

export type ReadFailure = 'offline' | 'no-data';
export type ReadOutcome = { ok: true; hour: HourData } | { ok: false; reason: ReadFailure };

const TIMEOUT_MS = 60_000;
const COMPRESSORS: Compressors = { ZSTD: (input: Uint8Array) => decompress(input) };
// Hour-ending timestamps as epoch ms, not Date objects (a million of them per
// interchange row group).
const PARSERS = { timestampFromMicroseconds: (us: bigint) => Number(us / 1000n) };

interface Table { name: string; columns: string[]; keep: number }
const OPS: Table = { name: 'core_eia930__hourly_operations', keep: 4, columns:
  ['datetime_utc', 'balancing_authority_code_eia', 'demand_adjusted_mwh', 'net_generation_adjusted_mwh', 'interchange_adjusted_mwh'] };
const PAIRS: Table = { name: 'core_eia930__hourly_interchange', keep: 3, columns:
  ['datetime_utc', 'balancing_authority_code_eia', 'balancing_authority_code_adjacent_eia', 'interchange_reported_mwh'] };
const FUELS: Table = { name: 'core_eia930__hourly_net_generation_by_energy_source', keep: 12, columns:
  ['datetime_utc', 'balancing_authority_code_eia', 'generation_energy_source', 'net_generation_adjusted_mwh'] };

class Fail extends Error { constructor(readonly reason: ReadFailure) { super(reason); } }

// ─── Range reads ─────────────────────────────────────────────────────────────
async function fetchTimed(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Fail('offline');
    return res;
  } catch (e) { throw e instanceof Fail ? e : new Fail('offline'); }
  finally { clearTimeout(timer); }
}

/** The file as an AsyncBuffer: its length from a HEAD, then ranged GETs. */
async function remoteBuffer(url: string): Promise<AsyncBuffer> {
  const head = await fetchTimed(url, { method: 'HEAD' });
  const byteLength = Number(head.headers.get('content-length'));
  if (!(byteLength > 0)) throw new Fail('offline');
  return {
    byteLength,
    async slice(start: number, end?: number) {
      const last = (end ?? byteLength) - 1;
      const res = await fetchTimed(url, { headers: { Range: `bytes=${start}-${last}` } });
      const body = await res.arrayBuffer();
      if (res.status === 206 && body.byteLength === last - start + 1) return body;
      if (res.status === 200 && body.byteLength === byteLength) return body.slice(start, last + 1);
      throw new Fail('offline');
    },
  };
}

interface RowGroup { start: number; rows: number; lo: number; hi: number }
interface OpenTable { file: AsyncBuffer; meta: FileMetaData; groups: RowGroup[] }
const opened = new Map<string, Promise<OpenTable>>();

function open(t: Table): Promise<OpenTable> {
  let p = opened.get(t.name);
  if (!p) {
    p = (async () => {
      const file = await remoteBuffer(`${PUDL_BASE_URL}${t.name}.parquet`);
      const meta = await parquetMetadataAsync(file);
      let start = 0;
      const groups = meta.row_groups.map(rg => {
        const rows = Number(rg.num_rows);
        const st = rg.columns.find(c => c.meta_data?.path_in_schema[0] === 'datetime_utc')?.meta_data?.statistics;
        const ms = (v: unknown) => v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v / 1000n) : NaN;
        const g = { start, rows, lo: ms(st?.min_value ?? st?.min), hi: ms(st?.max_value ?? st?.max) };
        start += rows;
        return g;
      });
      return { file, meta, groups };
    })();
    p.catch(() => opened.delete(t.name));
    opened.set(t.name, p);
  }
  return p;
}

// ─── Decoded row groups ──────────────────────────────────────────────────────
interface Decoded { cols: Record<string, unknown[]>; byHour: Map<number, number[]> }
const decoded = new Map<string, Promise<Decoded>>();   // insertion order = least recently used first

async function decode(t: Table, tbl: OpenTable, g: RowGroup): Promise<Decoded> {
  const cols: Record<string, unknown[]> = {};
  for (const c of t.columns) cols[c] = new Array(g.rows);
  await parquetRead({
    file: tbl.file, metadata: tbl.meta, columns: t.columns, rowStart: g.start, rowEnd: g.start + g.rows,
    compressors: COMPRESSORS, parsers: PARSERS,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const out = cols[columnName];
      for (let i = 0; i < columnData.length; i++) {
        const r = rowStart + i - g.start;
        if (r >= 0 && r < g.rows) out[r] = columnData[i];
      }
    },
  });
  const byHour = new Map<number, number[]>();
  const at = cols.datetime_utc as number[];
  for (let r = 0; r < g.rows; r++) {
    const list = byHour.get(at[r]);
    if (list) list.push(r); else byHour.set(at[r], [r]);
  }
  return { cols, byHour };
}

function rowGroup(t: Table, tbl: OpenTable, i: number): Promise<Decoded> {
  const key = `${t.name}#${i}`;
  let p = decoded.get(key);
  if (p) { decoded.delete(key); decoded.set(key, p); return p; }
  p = decode(t, tbl, tbl.groups[i]).catch(e => { decoded.delete(key); throw e instanceof Fail ? e : new Fail('offline'); });
  decoded.set(key, p);
  const mine = [...decoded.keys()].filter(k => k.startsWith(t.name + '#'));
  for (const k of mine.slice(0, Math.max(0, mine.length - t.keep))) decoded.delete(k);
  return p;
}

/** Each row of `t` at hour `at`, as column → value. */
async function rowsAt(t: Table, at: number): Promise<Record<string, unknown>[]> {
  const tbl = await open(t);
  const out: Record<string, unknown>[] = [];
  const hits = tbl.groups.flatMap((g, i) => at >= g.lo && at <= g.hi ? [i] : []);
  for (const d of await Promise.all(hits.map(i => rowGroup(t, tbl, i)))) {
    for (const r of d.byHour.get(at) ?? []) {
      const row: Record<string, unknown> = {};
      for (const c of t.columns) row[c] = d.cols[c][r];
      out.push(row);
    }
  }
  return out;
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

// ─── Public ──────────────────────────────────────────────────────────────────
/** The hours every table covers: [first, last] hour-ending, epoch ms. */
export async function hourRange(): Promise<{ ok: true; first: number; last: number } | { ok: false; reason: ReadFailure }> {
  try {
    const tables = await Promise.all([open(OPS), open(PAIRS), open(FUELS)]);
    const span = (tbl: OpenTable) => [Math.min(...tbl.groups.map(g => g.lo)), Math.max(...tbl.groups.map(g => g.hi))];
    const [ops, pairs] = tables.map(span);
    return { ok: true, first: ops[0], last: Math.min(ops[1], pairs[1]) };
  } catch (e) {
    return { ok: false, reason: e instanceof Fail ? e.reason : 'offline' };
  }
}

/** Every BA's load, generation, net interchange and fuel mix at hour-ending
 *  `at` (epoch ms, on the hour), and every reported neighbour flow. */
export async function readHour(at: number): Promise<ReadOutcome> {
  try {
    const [ops, pairRows, fuelRows] = await Promise.all([rowsAt(OPS, at), rowsAt(PAIRS, at), rowsAt(FUELS, at)]);
    if (!ops.length && !pairRows.length) return { ok: false, reason: 'no-data' };
    const bas = new Map<string, BaHour>();
    const baOf = (code: string) => {
      let b = bas.get(code);
      if (!b) { b = { load: null, gen: null, net: null, fuels: {} }; bas.set(code, b); }
      return b;
    };
    for (const r of ops) {
      const b = baOf(String(r.balancing_authority_code_eia));
      b.load = num(r.demand_adjusted_mwh); b.gen = num(r.net_generation_adjusted_mwh); b.net = num(r.interchange_adjusted_mwh);
    }
    for (const r of fuelRows) {
      const mw = num(r.net_generation_adjusted_mwh);
      if (mw == null) continue;
      baOf(String(r.balancing_authority_code_eia)).fuels[String(r.generation_energy_source)] = mw;
    }
    const pairs: PairReport[] = [];
    for (const r of pairRows) {
      const mw = num(r.interchange_reported_mwh);
      if (mw != null) pairs.push({ ba: String(r.balancing_authority_code_eia), adj: String(r.balancing_authority_code_adjacent_eia), mw });
    }
    return { ok: true, hour: { at, bas, pairs } };
  } catch (e) {
    return { ok: false, reason: e instanceof Fail ? e.reason : 'offline' };
  }
}
