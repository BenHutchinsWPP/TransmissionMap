// columns-read.ts's worker opener with a FakeWorker (as pairs-open.test.ts): replies routed by id,
// {ok: false} rejecting as a plain Error, onerror with requests pending re-running them inline and
// leaving the session inline (no second Worker), and the bytes copied, never transferred.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDecode, type DecodeRequest } from './columns-worker.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));

class FakeWorker {
  static all: FakeWorker[] = [];
  static auto: 'real' | 'fail' | 'hold' = 'real';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: { msg: DecodeRequest; transfer?: Transferable[] }[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  postMessage(msg: DecodeRequest, transfer?: Transferable[]) {
    this.posted.push({ msg, transfer });
    const emit = (data: unknown, t?: Transferable[]) => this.onmessage?.({ data: structuredClone(data, { transfer: t }) });
    if (FakeWorker.auto === 'real') void handleDecode(structuredClone(msg, { transfer }), (m, t) => emit(m, t));
    else if (FakeWorker.auto === 'fail') queueMicrotask(() => emit({ id: msg.id, ok: false }));
  }
}

function serve(url: string, init?: RequestInit): Response {
  if (!url.startsWith('data/analysis/')) return new Response('', { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + 'analysis/' + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
}

type Read = typeof import('./columns-read.js');
const COLS = ['fid', 'name', 'nominal_kv'];

async function rows(m: Read, groups?: number[]) {
  const got = await m.columnsEntry('osm_transmission_lines');
  if (!got.ok) throw new Error(got.reason);
  const e = got.result;
  const g = groups ?? (await m.columnsMeta(e)).row_groups.map((_, i) => i);
  const out: unknown[] = [];
  for await (const r of m.readGroups(e, g, COLS)) out.push(r);
  return out;
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.auto = 'real';
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => serve(url, init)));
  vi.resetModules();
});

const load = (): Promise<Read> => import('./columns-read.js');

describe('columns decode worker', () => {
  it('routes replies by id; rows equal the inline ones; bytes are copied, never transferred', async () => {
    const inlineRows = await rows(await load());   // node has no Worker: inline
    expect(FakeWorker.all).toHaveLength(0);
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    const viaWorker = await rows(await load());
    expect(viaWorker).toEqual(inlineRows);
    expect(FakeWorker.all).toHaveLength(1);
    const w = FakeWorker.all[0];
    expect(w.posted.length).toBeGreaterThan(0);
    expect(new Set(w.posted.map(p => p.msg.id)).size).toBe(w.posted.length);
    for (const { msg, transfer } of w.posted) {
      expect(transfer ?? []).not.toContain(msg.bytes);
      expect(msg.bytes.byteLength).toBeGreaterThan(0);   // the sender's buffer is not detached
      expect(Object.keys(msg).sort()).toEqual(['bytes', 'column', 'id', 'rowGroup', 'schema', 'start']);
      expect(msg.schema.length).toBeGreaterThan(0);
    }
  });

  it('{ok: false} rejects as a plain Error, not a Fail', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.auto = 'fail';
    const m = await load();
    const { Fail } = await import('../parquet/range-io.js');
    const err = await rows(m).then(() => null, e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(Fail);
    expect((err as Error).message).toBe('columns decode');
  });

  it('onerror with two pending re-runs both inline, and no new Worker is made after', async () => {
    const want = await rows(await load());
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.auto = 'hold';
    const m = await load();
    const p = rows(m, [0]);
    await vi.waitFor(() => expect(FakeWorker.all[0]?.posted.length).toBeGreaterThanOrEqual(2));
    const w = FakeWorker.all[0];
    expect(w.posted.length).toBe(COLS.length);   // all pending at once
    w.onerror?.();
    expect(w.terminate).toHaveBeenCalledOnce();
    const got = await p;
    expect(got).toEqual(want.slice(0, got.length));
    expect(got.length).toBeGreaterThan(0);
    const more = await rows(m, [1, 2]);
    expect(more).toEqual(want.slice(got.length));
    expect(FakeWorker.all).toHaveLength(1);
    expect(w.posted.length).toBe(COLS.length);
  });

  it('a reply that never comes falls back to inline after REPLY_TIMEOUT_MS', async () => {
    const want = await rows(await load());
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.auto = 'hold';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const m = await load();
      const p = rows(m);
      await vi.waitFor(() => expect(FakeWorker.all[0]?.posted.length).toBeGreaterThanOrEqual(COLS.length));
      expect(FakeWorker.all[0].terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(m.REPLY_TIMEOUT_MS);
      expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
      expect(await p).toEqual(want);
      expect(FakeWorker.all).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('onmessageerror and a throwing constructor also fall back to inline', async () => {
    const want = await rows(await load());
    vi.resetModules();
    class Throws { constructor() { throw new Error('no worker'); } }
    vi.stubGlobal('Worker', Throws);
    expect(await rows(await load())).toEqual(want);
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.auto = 'hold';
    const m = await load();
    const p = rows(m);
    await vi.waitFor(() => expect(FakeWorker.all[0]?.posted.length).toBeGreaterThan(0));
    FakeWorker.all[0].onmessageerror?.();
    expect(await p).toEqual(want);
  });
});
