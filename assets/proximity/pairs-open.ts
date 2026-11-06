// ─── Proximity pairs worker opener (main-bundle safe) ───────────────────────
// Role: runPairs(lon, lat, km, opts) runs proximityPairs in the pairs worker and resolves with its
//       Outcome<PairsResult>; opts {ids?, max?, onProgress?} (onProgress gets the pairs found so far).
//       The inputs are copied before they are sent, so the caller keeps its arrays. One call at a
//       time: a new call cancels the one running. cancelPairs() terminates the worker and resolves
//       the pending call as 'cancelled'. A worker error (or a reply that cannot be read) resolves
//       the pending call as a refusal and drops the worker; the next call starts a fresh one.
//       No coordinates, ids or other input value reaches a reason or the diagnostics log.
// Deps: pairs-worker.ts (worker entry); dataset-query.ts and types.ts (types only).

import type { Outcome } from '../dataset-query.js';
import type { PairsResult } from './types.js';

const FAILED = 'The proximity worker failed.';

interface Call { id: number; worker: Worker; resolve: (o: Outcome<PairsResult>) => void; onProgress?: (found: number) => void }

let worker: Worker | null = null;
let call: Call | null = null;
let nextId = 0;

function settle(o: Outcome<PairsResult>): void {
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
  const w = new Worker(new URL('./pairs-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; outcome?: Outcome<PairsResult>; progress?: number }>) => {
    const { id, outcome, progress } = e.data;
    if (!call || call.id !== id) return;
    if (progress !== undefined) { call.onProgress?.(progress); return; }
    if (outcome) settle(outcome);
  };
  const fail = () => { if (worker === w) { drop(w); settle({ ok: false, reason: FAILED }); } };
  w.onerror = fail;
  w.onmessageerror = fail;
  return (worker = w);
}

export function cancelPairs(): void {
  if (!call) return;
  drop(call.worker);
  settle({ ok: false, reason: 'cancelled' });
}

export function runPairs(
  lon: Float64Array, lat: Float64Array, km: number,
  opts: { ids?: Int32Array; max?: number; onProgress?: (found: number) => void } = {},
): Promise<Outcome<PairsResult>> {
  cancelPairs();
  return new Promise((resolve) => {
    const w = getWorker();
    const id = ++nextId;
    call = { id, worker: w, resolve, onProgress: opts.onProgress };
    const lo = lon.slice(), la = lat.slice(), ids = opts.ids?.slice();
    const moved = [lo.buffer as ArrayBuffer, la.buffer as ArrayBuffer, ...(ids ? [ids.buffer as ArrayBuffer] : [])];
    w.postMessage({ id, lon: lo, lat: la, km, ...(ids ? { ids } : {}), ...(opts.max !== undefined ? { max: opts.max } : {}) }, moved);
  });
}
