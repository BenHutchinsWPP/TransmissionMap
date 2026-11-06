// Role: worker transport refreshes mutable report metadata and bounds optional range bodies.
//       Uploaded layers: a request handled right after an unawaited upload sees the layer; a rejected upload is not kept
//       and its reason rides on the later refusal.
// Deps: route-worker.ts, upload-layer.ts; route.ts mocked to capture its I/O without running the solver.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteIO } from './route.js';
import { uploadLayer } from './upload-layer.js';
const calls = vi.hoisted(() => ({ io: null as RouteIO | null }));
vi.mock('./route.js', () => ({
  createInspectCache: () => ({}), createWindowCache: () => ({}),
  exactRouteCrossings: vi.fn(async (_req, io) => { calls.io = io; return { ok: true, result: {} }; }),
  inspect: vi.fn(), repaint: vi.fn(), repaintRows: vi.fn(),
  route: vi.fn(async (req: { uploads?: string[] }, io: RouteIO) => {
    const h = (req.uploads ?? []).find((x) => !io.uploads?.has(x));
    return h ? { ok: false, reason: `upload layer ${h} not loaded` } : { ok: true, result: {} };
  }),
}));
beforeEach(() => { vi.resetModules(); calls.io = null; });
afterEach(() => { vi.unstubAllGlobals(); });
async function loadWorker() {
  const scope = { location: { href: 'https://example.test/' }, postMessage: vi.fn(), onmessage: null as null | ((e: { data: unknown }) => Promise<void>) };
  vi.stubGlobal('self', scope);
  await import('./route-worker.js');
  return scope;
}
async function workerIO() {
  const scope = await loadWorker();
  await scope.onmessage!({ data: { id: 1, baseUrl: 'https://example.test/data/route/250m/', crossings: {} } });
  return calls.io!;
}
describe('optional report HTTP transport', () => {
  it('refreshes the mutable manifest length while retaining immutable file sizes', async () => {
    let length = 30;
    const fetcher = vi.fn(async () => new Response(null, { status: 200, headers: { 'content-length': String(length) } }));
    vi.stubGlobal('fetch', fetcher);
    const io = await workerIO();
    const manifest = 'https://example.test/data/route/report/screening/manifest.json';
    expect(await io.byteLength!(manifest)).toBe(30);
    length = 60;
    expect(await io.byteLength!(manifest)).toBe(60);
    const file = 'https://example.test/data/route/report/screening/abc/buildings.parquet';
    expect(await io.byteLength!(file)).toBe(60);
    length = 90;
    expect(await io.byteLength!(file)).toBe(60);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects and cancels a full-file reply to a partial report read', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '1000000' } })
      : new Response(new ReadableStream({ cancel }), { status: 200 })));
    const io = await workerIO();
    await expect(io.fetchRange('https://example.test/report/screening/abc/buildings.parquet', 0, 4)).rejects.toThrow('requested range');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('accepts exact ranges and rejects a response body larger than the requested range', async () => {
    let oversized = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '100' } })
      : new Response(new Uint8Array(oversized ? 5 : 4), { status: 206, headers: { 'content-range': 'bytes 0-3/100' } })));
    const io = await workerIO(), url = 'https://example.test/report/screening/abc/buildings.parquet';
    expect(await io.fetchRange(url, 0, 4)).toHaveLength(4);
    oversized = true;
    await expect(io.fetchRange(url, 0, 4)).rejects.toThrow('byte budget');
  });
});

describe('uploaded layers', () => {
  const baseUrl = 'https://example.test/data/route/250m/';
  const geometry = [[[[-120, 39], [-119.9, 39], [-119.9, 39.1], [-120, 39.1], [-120, 39]]]];
  const hashOf = async () => { const l = await uploadLayer(geometry); if (!l.ok) throw new Error(l.reason); return l.result.hash; };

  it('a request right behind an unawaited upload sees the layer', async () => {
    const H = await hashOf();
    const scope = await loadWorker();
    void scope.onmessage!({ data: { upload: { hash: H, geometry }, baseUrl } });
    await scope.onmessage!({ data: { id: 2, req: { uploads: [H] }, baseUrl } });
    expect(scope.postMessage).toHaveBeenCalledWith({ id: 2, outcome: { ok: true, result: {} } }, []);
  });

  it('a layer whose hash does not match is not kept, and the refusal says why', async () => {
    const scope = await loadWorker();
    void scope.onmessage!({ data: { upload: { hash: 'deadbeefdeadbeef', geometry }, baseUrl } });
    await scope.onmessage!({ data: { id: 3, req: { uploads: ['deadbeefdeadbeef'] }, baseUrl } });
    const out = scope.postMessage.mock.calls.at(-1)![0].outcome;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('upload layer deadbeefdeadbeef not loaded: the geometry does not match its hash');
  });

  it('a refused geometry keeps its own reason', async () => {
    const scope = await loadWorker();
    void scope.onmessage!({ data: { upload: { hash: '0123456789abcdef', geometry: [] }, baseUrl } });
    await scope.onmessage!({ data: { id: 4, req: { uploads: ['0123456789abcdef'] }, baseUrl } });
    expect(scope.postMessage.mock.calls.at(-1)![0].outcome.reason).toBe('upload layer 0123456789abcdef not loaded: uploaded layer: no polygons');
  });
});
