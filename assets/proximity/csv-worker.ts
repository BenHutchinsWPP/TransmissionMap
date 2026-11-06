// ─── Proximity pairs CSV worker ──────────────────────────────────────────────
// Role: module Worker that builds the pairs CSV off the main thread (a million pairs of a wide
//       file is seconds of work). Message in {id, input: PairsCsvInput, limit?}; messages out
//       {id, progress: rows done} per chunk of ≤ 10,000 rows, then {id, outcome}: { ok: true, blob }
//       (a text/csv Blob of the parts) or { ok: false, bytes } (the estimate passed the limit), or
//       { ok: false, failed: true } on any error (no input value in it).
//       handleCsv is the pure part (unit-tested without a Worker). Started only by csv-open.ts.
// Deps: pairs-csv.ts.

import { buildPairsCsv, type PairsCsvInput } from './pairs-csv.js';

export interface CsvRequest { id: number; input: PairsCsvInput; limit?: number }
export type CsvOutcome = { ok: true; blob: Blob } | { ok: false; bytes: number } | { ok: false; failed: true };

export function handleCsv(msg: CsvRequest, post: (m: unknown) => void): void {
  const { id } = msg;
  let outcome: CsvOutcome;
  try {
    const o = buildPairsCsv(msg.input, msg.limit, rows => post({ id, progress: rows }));
    outcome = o.ok ? { ok: true, blob: new Blob(o.parts, { type: 'text/csv;charset=utf-8' }) } : o;
  } catch {
    outcome = { ok: false, failed: true };
  }
  post({ id, outcome });
}

if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<CsvRequest>) => void) | null;
    postMessage(msg: unknown): void;
  };
  scope.onmessage = (e) => handleCsv(e.data, m => scope.postMessage(m));
}
