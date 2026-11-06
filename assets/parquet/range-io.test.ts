// range-io.ts: the request limiter, the per-request timeout, the LRU byte cache
// and the index load (datasets and/or columns). Fetch is mocked throughout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRange, loadIndex, resetRangeIo, requestLog, Fail,
  MAX_IN_FLIGHT, REQUEST_TIMEOUT_MS, CACHE_BYTES } from './range-io.js';

const MiB = 1024 * 1024;
const FILE = 'data/analysis/x.parquet';

/** A 206 of the requested length. */
function rangeReply(init?: RequestInit): Response {
  const m = new Headers(init?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
  return new Response(new Uint8Array(Number(m[2]) - Number(m[1]) + 1), { status: 206 });
}

beforeEach(() => {
  resetRangeIo();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => rangeReply(init)));
});
afterEach(() => { vi.useRealTimers(); });

const flush = () => new Promise(r => setTimeout(r, 0));

describe('limiter', () => {
  it('runs at most 6 requests at once; the 7th waits until one settles', async () => {
    const held: (() => void)[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>(res => held.push(() => res(rangeReply(init))))));
    const reads = Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) => readRange(FILE, i * 10, i * 10 + 10, 1000));
    await flush();
    expect(MAX_IN_FLIGHT).toBe(6);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
    held[0]();
    await reads[0];
    await flush();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(7);
    held.slice(1).forEach(h => h());
    await Promise.all(reads);
  });

  it('an aborted caller: a queued request never starts and a running one is aborted', async () => {
    const held: (() => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(res => held.push(() => res(rangeReply(init))));
    }));
    const stop = new AbortController();
    const reads = Array.from({ length: MAX_IN_FLIGHT + 2 }, (_, i) =>
      readRange(FILE, i * 10, i * 10 + 10, 1000, stop.signal).catch(e => e));
    await flush();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    stop.abort();
    await flush();
    expect(signals.every(s => s?.aborted)).toBe(true);
    held.forEach(h => h());
    await Promise.all(reads);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(MAX_IN_FLIGHT);   // the two queued never started
  });

  it('a failed request frees its slot', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (n++ < MAX_IN_FLIGHT) throw new TypeError('Failed to fetch');
      return rangeReply(init);
    }));
    const failed = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => readRange(FILE, i, i + 1, 1000).catch(e => e));
    expect((await Promise.all(failed)).every(e => e instanceof Fail && e.reason === 'offline')).toBe(true);
    expect((await readRange(FILE, 100, 110, 1000)).byteLength).toBe(10);
  });
});

describe('per-request timeout', () => {
  it('aborts a stalled request after 10 s with timeout', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise(() => {});   // never settles, even on abort
    }));
    const p = readRange(FILE, 0, 10, 1000).catch(e => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const err = await p;
    expect(err).toBeInstanceOf(Fail);
    expect(err.reason).toBe('timeout');
    expect(signals[0].aborted).toBe(true);
  });

  it('times each request on its own clock, not the whole sequence', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>(res => setTimeout(() => res(rangeReply(init)), 6_000))));
    const p = (async () => { await readRange(FILE, 0, 10, 1000); return readRange(FILE, 20, 30, 1000); })();
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await p).byteLength).toBe(10);
  });

  it('a timed-out request leaves no cache entry', async () => {
    vi.useFakeTimers();
    let stall = true;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      stall ? new Promise(() => {}) : Promise.resolve(rangeReply(init))));
    const p = readRange(FILE, 0, 10, 1000).catch(e => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await p;
    stall = false;
    expect((await readRange(FILE, 0, 10, 1000)).byteLength).toBe(10);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe('byte cache', () => {
  const big = 12 * MiB;
  const at = (i: number) => [i * big, (i + 1) * big] as const;
  const read = (i: number) => readRange(FILE, ...at(i), 10 * big);

  it('serves a range inside a cached one without a request', async () => {
    await readRange(FILE, 0, 100, 1000);
    const got = await readRange(FILE, 10, 20, 1000);
    expect(got.byteLength).toBe(10);
    expect(requestLog).toHaveLength(1);
  });

  it(`holds at most ${CACHE_BYTES / MiB} MiB, dropping the least recently used`, async () => {
    expect(CACHE_BYTES).toBe(32 * MiB);
    await read(0); await read(1);
    await read(0);                        // touch 0: 1 is now the oldest
    expect(requestLog).toHaveLength(2);
    await read(2);                        // 36 MiB: 1 goes
    await read(0); await read(2);
    expect(requestLog).toHaveLength(3);
    await read(1);
    expect(requestLog).toHaveLength(4);
  });
});

describe('index', () => {
  const serveIndex = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('accepts datasets', async () => {
    serveIndex({ version: 1, datasets: { a: {} } });
    expect((await loadIndex()).datasets).toEqual({ a: {} });
  });

  it('accepts a columns section alone', async () => {
    serveIndex({ version: 2, columns: { b: {} } });
    const idx = await loadIndex();
    expect(idx.columns).toEqual({ b: {} });
    expect(idx.datasets).toBeUndefined();
  });

  it('neither section is unavailable, remembered for the session', async () => {
    serveIndex({ version: 1 });
    await expect(loadIndex()).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(loadIndex()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('a network error is tried again on the next call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadIndex()).rejects.toMatchObject({ reason: 'offline' });
    serveIndex({ version: 1, datasets: {} });
    expect((await loadIndex()).datasets).toEqual({});
  });
});
