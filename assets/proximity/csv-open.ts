// ─── Proximity pairs CSV worker opener ───────────────────────────────────────
// Role: runPairsCsv(input, { limit?, onProgress? }) builds the pairs CSV in the CSV worker and
//       resolves with { ok: true, blob }, { ok: false, reason: 'tooBig', bytes },
//       'cancelled' or 'failed'. One call at a time: a new call cancels the one running.
//       cancelCsv() terminates the worker and resolves the pending call as 'cancelled'. A worker
//       error resolves it as 'failed' and drops the worker. No input value reaches a reason.
// Deps: csv-worker.ts (worker entry), pairs-csv.ts (types).

import type { PairsCsvInput } from './pairs-csv.js';
import type { CsvOutcome } from './csv-worker.js';

export type CsvResult = { ok: true; blob: Blob } | { ok: false; reason: 'tooBig'; bytes: number } | { ok: false; reason: 'cancelled' | 'failed' };

interface Call { id: number; worker: Worker; resolve: (o: CsvResult) => void; onProgress?: (rows: number) => void }

let worker: Worker | null = null;
let call: Call | null = null;
let nextId = 0;

function settle(o: CsvResult): void {
  const c = call;
  call = null;
  c?.resolve(o);
}

function drop(w: Worker): void {
  w.terminate();
  if (worker === w) worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./csv-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; outcome?: CsvOutcome; progress?: number }>) => {
    const { id, outcome, progress } = e.data;
    if (!call || call.id !== id) return;
    if (progress !== undefined) { call.onProgress?.(progress); return; }
    if (!outcome) return;
    if (outcome.ok) settle({ ok: true, blob: outcome.blob });
    else if ('bytes' in outcome) settle({ ok: false, reason: 'tooBig', bytes: outcome.bytes });
    else settle({ ok: false, reason: 'failed' });
  };
  const fail = () => { if (worker === w) { drop(w); settle({ ok: false, reason: 'failed' }); } };
  w.onerror = fail;
  w.onmessageerror = fail;
  return (worker = w);
}

export function cancelCsv(): void {
  if (!call) return;
  drop(call.worker);
  settle({ ok: false, reason: 'cancelled' });
}

export function runPairsCsv(input: PairsCsvInput, opts: { limit?: number; onProgress?: (rows: number) => void } = {}): Promise<CsvResult> {
  cancelCsv();
  return new Promise((resolve) => {
    const w = getWorker();
    const id = ++nextId;
    call = { id, worker: w, resolve, onProgress: opts.onProgress };
    w.postMessage({ id, input, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
  });
}
