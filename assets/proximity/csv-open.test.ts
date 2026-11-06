// The CSV worker opener over a fake Worker: progress and the outcome routed to the call, the size
// refusal and a worker error as fixed reasons, cancel terminates, the next call starts a new worker.
// Deps: csv-open.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PairsCsvInput } from './pairs-csv.js';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: { id: number }[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  postMessage(m: { id: number }) { this.posted.push(m); }
  emit(data: unknown) { this.onmessage?.({ data }); }
}
const input = {} as PairsCsvInput;

beforeEach(() => { FakeWorker.all = []; vi.stubGlobal('Worker', FakeWorker); vi.resetModules(); });
const load = () => import('./csv-open.js');

describe('runPairsCsv / cancelCsv', () => {
  it('routes progress and the blob to the call', async () => {
    const { runPairsCsv } = await load();
    const seen: number[] = [];
    const p = runPairsCsv(input, { onProgress: n => seen.push(n) });
    const w = FakeWorker.all[0];
    const id = w.posted[0].id;
    w.emit({ id: id + 9, progress: 1 });
    w.emit({ id, progress: 10_000 });
    const blob = new Blob(['x']);
    w.emit({ id, outcome: { ok: true, blob } });
    expect(seen).toEqual([10_000]);
    expect(await p).toEqual({ ok: true, blob });
  });
  it('maps the size refusal and an error to fixed reasons', async () => {
    const { runPairsCsv } = await load();
    const p = runPairsCsv(input);
    FakeWorker.all[0].emit({ id: FakeWorker.all[0].posted[0].id, outcome: { ok: false, bytes: 5 } });
    expect(await p).toEqual({ ok: false, reason: 'tooBig', bytes: 5 });
    const q = runPairsCsv(input);
    FakeWorker.all[0].onerror?.();
    expect(await q).toEqual({ ok: false, reason: 'failed' });
  });
  it('cancel terminates and resolves cancelled; the next call makes a new worker', async () => {
    const { runPairsCsv, cancelCsv } = await load();
    const p = runPairsCsv(input);
    cancelCsv();
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
    void runPairsCsv(input);
    expect(FakeWorker.all).toHaveLength(2);
  });
});
