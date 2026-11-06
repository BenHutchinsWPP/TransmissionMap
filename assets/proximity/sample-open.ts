// ─── Proximity sample worker opener ──────────────────────────────────────────
// Role: runSample(url, box, cap) fetches and cuts the sample layer in the sample worker and
//       resolves with a SampleOutcome, or { kind: 'cancelled' }. One call at a time: a new call
//       cancels the one running. cancelSample() terminates the worker. A worker error resolves
//       { kind: 'failed' } and drops the worker. The url is made absolute against the page first,
//       since a worker resolves a relative url against its own script.
// Deps: sample-worker.ts (worker entry), sample.ts (types).

import type { Box } from './sample.js';
import type { SampleOutcome } from './sample-worker.js';

export type SampleResult = SampleOutcome | { kind: 'cancelled' };
interface Call { id: number; worker: Worker; resolve: (o: SampleResult) => void }

let worker: Worker | null = null;
let call: Call | null = null;
let nextId = 0;

function settle(o: SampleResult): void {
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
  const w = new Worker(new URL('./sample-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; outcome?: SampleOutcome }>) => {
    if (call && call.id === e.data.id && e.data.outcome) settle(e.data.outcome);
  };
  const fail = () => { if (worker === w) { drop(w); settle({ kind: 'failed' }); } };
  w.onerror = fail;
  w.onmessageerror = fail;
  return (worker = w);
}

export function cancelSample(): void {
  if (!call) return;
  drop(call.worker);
  settle({ kind: 'cancelled' });
}

export function runSample(url: string, box: Box, cap: number): Promise<SampleResult> {
  cancelSample();
  return new Promise((resolve) => {
    const w = getWorker();
    const id = ++nextId;
    call = { id, worker: w, resolve };
    w.postMessage({ id, url: new URL(url, location.href).href, box, cap });
  });
}
