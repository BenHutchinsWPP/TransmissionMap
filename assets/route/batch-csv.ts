/**
 * Batch route CSV: parse and validate `key,a_lat,a_lon,b_lat,b_lon[,line_type][,method][,alternatives][,pictures]`
 * One route per row.
 *
 * Role: pure trust boundary for the Route pane's Batch view; every cell is untrusted text, never
 * evaluated. A bad row is reported with its record number and reason and skipped; a bad file
 * (too big, too many rows, no/unknown/duplicate/missing column) is refused whole. Keys stay text:
 * formula guarding happens at CSV output, not here. `line` is the record number (header = 1); it
 * equals the physical line unless the file has blank lines or quoted line breaks.
 * Whether a line type exists for a method, and whether a saved method still exists, is the caller's
 * (route-batch-run.ts); this module checks a method's shape and, against `savedNames`, a saved method's exact name.
 * Dependencies: ../user-data/csv-parse.js (parseCSV), ./grid.js (cell check), ../../src/registry/route-presets.js (built-in ids).
 */
import { parseCSV } from '../user-data/csv-parse.js';
import { GRID_250, cellOfLngLat } from './grid.js';
import { routePreset } from '../../src/registry/route-presets.js';

export const MAX_BATCH_ROWS = 200;
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_KEY_CHARS = 60;
export const BATCH_PICTURES = ['route', 'cause', 'weight', 'cost', 'similar', 'alternatives'] as const;
export type BatchPicture = typeof BATCH_PICTURES[number];

export interface BatchRow {
  line: number;
  key: string;
  a: [lng: number, lat: number];
  b: [lng: number, lat: number];
  lineType?: string;
  method?: string;
  alternatives?: number;
  pictures?: BatchPicture[];
}
/** A reason as an i18n key (`route.batch.csv.*`) and its parameters; the view words it with `t(reason, params)`. */
export interface BatchReasonParams { params?: Record<string, string | number> }
export interface BatchSkip extends BatchReasonParams { line: number; reason: string }
export type BatchParse =
  | { ok: true; rows: BatchRow[]; skipped: BatchSkip[] }
  | ({ ok: false; reason: string } & BatchReasonParams);

const REQUIRED = ['key', 'a_lat', 'a_lon', 'b_lat', 'b_lon'] as const;
const OPTIONAL = ['line_type', 'method', 'alternatives', 'pictures'] as const;
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const LAT: [number, number] = [24, 50];
const LON: [number, number] = [-125, -66];

const K = 'route.batch.csv.';
type Why = { reason: string; params?: Record<string, string | number> };
const why = (k: string, params?: Record<string, string | number>): Why => ({ reason: K + k, ...(params ? { params } : {}) });

function num(cell: string, name: string, [lo, hi]: [number, number]): number | Why {
  const s = cell.trim();
  if (!NUM.test(s)) return why('notNumber', { name });
  const v = Number(s);
  if (!Number.isFinite(v)) return why('notFinite', { name });
  if (v < lo || v > hi) return why('outside', { name, value: s, lo, hi });
  return v;
}

export function parseBatchCsv(text: string, opts: { savedNames?: readonly string[] } = {}): BatchParse {
  if (new TextEncoder().encode(text).length > MAX_BATCH_BYTES) return { ok: false, ...why('tooBig') };
  const recs = parseCSV(text.replace(/^\uFEFF/, ''));
  if (!recs.length) return { ok: false, ...why('empty') };
  const head = recs[0].map((h) => h.replace(/^\uFEFF/, '').trim().toLowerCase());
  const known: readonly string[] = [...REQUIRED, ...OPTIONAL];
  for (const h of head) if (!known.includes(h)) return { ok: false, ...why('unknownCol', { name: h.slice(0, 40).replace(/\p{Cc}/gu, '') }) };
  if (new Set(head).size !== head.length) return { ok: false, ...why('dupCol') };
  for (const r of REQUIRED) if (!head.includes(r)) return { ok: false, ...why('missingCol', { name: r }) };
  if (recs.length - 1 > MAX_BATCH_ROWS) return { ok: false, ...why('tooMany', { max: MAX_BATCH_ROWS }) };
  const col = (r: string[], n: string): string => { const i = head.indexOf(n); return i < 0 ? '' : r[i]; };

  const rows: BatchRow[] = [];
  const skipped: BatchSkip[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < recs.length; i++) {
    const r = recs[i];
    const line = i + 1;
    const bad = (w: Why): void => { skipped.push({ line, ...w }); };
    if (r.length !== head.length) { bad(why('cells', { n: r.length, h: head.length })); continue; }

    const key = col(r, 'key').replace(/\p{Cc}/gu, '').trim();
    const n = [...key].length;
    if (n < 1 || n > MAX_KEY_CHARS) { bad(why('keyLen', { max: MAX_KEY_CHARS })); continue; }
    const kl = key.toLowerCase();
    if (seen.has(kl)) { bad(why('dupKey')); continue; }

    const vals = [
      num(col(r, 'a_lat'), 'a_lat', LAT), num(col(r, 'a_lon'), 'a_lon', LON),
      num(col(r, 'b_lat'), 'b_lat', LAT), num(col(r, 'b_lon'), 'b_lon', LON),
    ];
    const err = vals.find((v) => typeof v === 'object');
    if (err !== undefined) { bad(err as Why); continue; }
    const [aLat, aLon, bLat, bLon] = vals as number[];
    if (aLat === bLat && aLon === bLon) { bad(why('samePoint')); continue; }
    const a: [number, number] = [aLon, aLat];
    const b: [number, number] = [bLon, bLat];
    const off = [a, b].some(([lo, la]) => {
      const [c, rw] = cellOfLngLat(GRID_250, lo, la);
      return c < 0 || rw < 0 || c >= GRID_250.cols || rw >= GRID_250.rows;
    });
    if (off) { bad(why('offGrid')); continue; }

    const row: BatchRow = { line, key, a, b };
    const lt = col(r, 'line_type').trim();
    if (lt) {
      if (!/^[a-z0-9_-]{1,32}$/i.test(lt)) { bad(why('lineTypeChars')); continue; }
      row.lineType = lt;
    }
    const m = col(r, 'method').trim();
    if (m) {
      const ok = routePreset(m) !== undefined
        || (/^custom:[A-Za-z0-9_-]{1,64}$/.test(m))
        || (opts.savedNames?.includes(m) ?? false);
      if (!ok) { bad(why('method')); continue; }
      row.method = m;
    }
    const alt = col(r, 'alternatives').trim();
    if (alt) {
      if (!/^[0-3]$/.test(alt)) { bad(why('alts')); continue; }
      row.alternatives = Number(alt);
    }
    const pic = col(r, 'pictures').trim();
    if (pic) {
      const list = pic.split(',').map((p) => p.trim().toLowerCase());
      const badPic = list.find((p) => !(BATCH_PICTURES as readonly string[]).includes(p));
      if (badPic !== undefined) { bad(why('unknownPic', { name: badPic.slice(0, 20).replace(/\p{Cc}/gu, '') })); continue; }
      row.pictures = [...new Set(list)] as BatchPicture[];
    }
    seen.add(kl);
    rows.push(row);
  }
  return { ok: true, rows, skipped };
}
