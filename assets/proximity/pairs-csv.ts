// ─── Proximity pairs CSV (pure) ──────────────────────────────────────────────
// Role: buildPairsCsv(input, limit, onProgress?) turns a pairs list into CSV text parts of ≤ CSV_CHUNK
//       rows (header in the first, `notes` after the last row), RFC 4180 with CRLF lines and the
//       spreadsheet-formula guard of utils/utils.ts's csvCell (the same one toCsv uses; pairs-csv.test.ts holds the two
//       equal). The size is estimated from the first rows in UTF-8 bytes (not characters); above
//       `limit` it returns { ok: false, bytes } and builds nothing more. Pure, so the CSV worker
//       (csv-worker.ts) runs it off the main thread and a test runs it without one.
//       The point arrays are read by index: a pair k is points a[k] and b[k].
// Deps: utils/utils.ts (csvCell; no imports of its own). Used by csv-worker.ts and ui-proximity.ts (types, constants).

import { csvCell } from '../utils/utils.js';

export const CSV_CHUNK = 10_000;
export const MAX_CSV_BYTES = 200 * 1048576;

export interface PairsCsvInput {
  fields: string[];
  /** km per display unit (the distance column is km / unitKm, rounded to 3 decimals) */
  unitKm: number;
  a: Int32Array;
  b: Int32Array;
  km: Float64Array;
  group: Int32Array;
  /** per point: its 0-based CSV data row */
  rowNo: Int32Array;
  lat: Float64Array;
  lon: Float64Array;
  names: string[];
  idText: string[] | null;
  /** per CSV column, its value for every point */
  cols: string[][];
  notes: string[];
}

export type PairsCsvOutcome = { ok: true; parts: string[] } | { ok: false; bytes: number };

function rowText(d: PairsCsvInput, k: number): string {
  const a = d.a[k], b = d.b[k];
  const v: unknown[] = [
    d.group[a], d.rowNo[a] + 1, d.rowNo[b] + 1, d.idText?.[a] ?? '', d.idText?.[b] ?? '', d.names[a], d.names[b],
    Math.round(d.km[k] / d.unitKm * 1000) / 1000, d.lat[a], d.lon[a], d.lat[b], d.lon[b],
  ];
  for (const c of d.cols) v.push(c[a] ?? '');
  for (const c of d.cols) v.push(c[b] ?? '');
  return v.map(csvCell).join(',');
}

function chunkText(d: PairsCsvInput, from: number, to: number, first: boolean, last: boolean): string {
  const lines: string[] = first ? [d.fields.map(csvCell).join(',')] : [];
  for (let k = from; k < to; k++) lines.push(rowText(d, k));
  if (last) for (const n of d.notes) lines.push(csvCell(n));
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

export function buildPairsCsv(d: PairsCsvInput, limit = MAX_CSV_BYTES, onProgress?: (rows: number) => void): PairsCsvOutcome {
  const n = d.a.length;
  if (n) {
    const sample = Math.min(n, 200);
    const est = Math.round(utf8(chunkText(d, 0, sample, false, false)) / sample * n);
    if (est > limit) return { ok: false, bytes: est };
  }
  const parts: string[] = [];
  let start = 0;
  do {
    const end = Math.min(n, start + CSV_CHUNK);
    parts.push(chunkText(d, start, end, start === 0, end >= n));
    start = end;
    onProgress?.(end);
  } while (start < n);
  return { ok: true, parts };
}
