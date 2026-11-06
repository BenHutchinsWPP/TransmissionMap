import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: { id: number; lon: Float64Array }[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  postMessage(m: { id: number; lon: Float64Array }) { this.posted.push(m); }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

const lon = Float64Array.from([1, 2, 3]), lat = Float64Array.from([4, 5, 6]);
const result = { a: new Int32Array(0), b: new Int32Array(0), km: new Float64Array(0), truncated: false };

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.resetModules();
});

const load = () => import('./pairs-open.js');

describe('runPairs / cancelPairs', () => {
  it('routes progress and the outcome to the call, and keeps the caller arrays', async () => {
    const { runPairs } = await load();
    const seen: number[] = [];
    const p = runPairs(lon, lat, 5, { onProgress: (n) => seen.push(n) });
    const w = FakeWorker.all[0];
    const id = w.posted[0].id;
    expect(w.posted[0].lon).not.toBe(lon);
    w.emit({ id: id + 99, progress: 1 });
    w.emit({ id, progress: 50_000 });
    expect(seen).toEqual([50_000]);
    w.emit({ id, outcome: { ok: true, result } });
    expect(await p).toEqual({ ok: true, result });
    expect(lon.buffer.byteLength).toBe(24);
    expect(Array.from(lon)).toEqual([1, 2, 3]);
  });

  it('cancel resolves cancelled and terminates; the next call makes a new worker', async () => {
    const { runPairs, cancelPairs } = await load();
    const p = runPairs(lon, lat, 5);
    cancelPairs();
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
    void runPairs(lon, lat, 5);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('a new call cancels the running one', async () => {
    const { runPairs } = await load();
    const p1 = runPairs(lon, lat, 5);
    void runPairs(lon, lat, 6);
    expect(await p1).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('a worker error refuses the call, drops the worker and the next call starts a new one', async () => {
    const { runPairs } = await load();
    const p = runPairs(lon, lat, 5);
    FakeWorker.all[0].onerror?.();
    const o = await p;
    expect(o.ok).toBe(false);
    expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
    void runPairs(lon, lat, 5);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('cancel with nothing running does nothing', async () => {
    const { cancelPairs, runPairs } = await load();
    cancelPairs();
    const p = runPairs(lon, lat, 5);
    const w = FakeWorker.all[0];
    w.emit({ id: w.posted[0].id, outcome: { ok: false, reason: 'x' } });
    await p;
    cancelPairs();
    expect(w.terminate).not.toHaveBeenCalled();
  });
});
