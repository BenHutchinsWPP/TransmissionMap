// ─── Route worker ─────────────────────────────────────────────────────────────
// Role: module Worker that runs route.ts off the main thread. Message in
//       {id, req, baseUrl}; messages out {id, progress: step} as each
//       phase starts, then the final {id, outcome}. Message {id, inspect, baseUrl}
//       (the cell inspector, route.ts inspect()) answers {id, outcome} only; it reads
//       just the blocks holding that cell, through one per-worker cache of ≤ 64
//       band blocks (≈ 16 MB at 512² cells), and allocates nothing a solve holds.
//       Message {id, crossings, baseUrl} (route.ts exactRouteCrossings(): the report GeoParquet
//       in ../report/ beside the cube directory, sizes from the same HEAD cache) answers {id, outcome}.
//       The mutable screening manifest bypasses that cache. Optional screening reads require
//       genuine, bounded HTTP ranges and have a transport timeout as well as the report deadline.
//       I/O is fetch: JSON for
//       grid.json, HTTP Range requests for the band files. The reader only asks
//       for ranges it learnt from the IFD, but its first head read is a fixed
//       64 KiB, so each file's size comes from one HEAD request (cached) and every
//       range is clamped to it — a dev server does not clamp past EOF.
//       The similar-cost areas' RGBA image and class array, and the routing-weight
//       overlay's RGBA, go back as transferred buffers (moved, not copied: up to ~67 MB each).
//       Live repaint: one WindowCache per worker keeps the last solve's band window
//       (route.ts, ≤ WINDOW_CACHE_BYTES); {id, repaint, baseUrl} answers {id, outcome} from it
//       (route.ts repaint(): no read, no solve), the image's RGBA transferred; {id, repaintRows, baseUrl} answers likewise
//       (route.ts repaintRows(): the Method grid's highlighted rows); {drop: true}
//       releases the window and answers nothing. A terminated worker (cancelRoute) loses it.
//       Uploaded layers: {upload: {hash, geometry}} (no id, no reply) builds the layer again
//       through upload-layer.ts's `uploadLayer` (the same checks and hash as the pane's) and keeps it
//       when the hash agrees; {unupload: hash} drops it. Every other message waits for the uploads
//       posted before it, then passes the map as RouteIO.uploads (and to repaint / repaintRows), so a
//       request naming a hash this worker lacks is refused by route.ts, never solved without it; when the upload
//       was refused here (bad geometry, a hash that does not match), that reason is appended to the refusal.
//       route-open.ts posts every registered upload to a new worker before anything else.
//       Started only by route-open.ts (`new Worker(new URL(...), {type: 'module'})`).
// Deps: route.ts, upload-layer.ts.

import {
  createInspectCache, createWindowCache, exactRouteCrossings, inspect, repaint, repaintRows, route,
  type ExactCrossingsRequest, type InspectRequest, type RepaintRequest, type RepaintRowsRequest, type RouteIO, type RouteRequest,
} from './route.js';
import { uploadLayer, type UploadLayer } from './upload-layer.js';

// tsconfig has no WebWorker lib: the two members of the worker scope used here.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; req?: RouteRequest; inspect?: InspectRequest; repaint?: RepaintRequest; repaintRows?: RepaintRowsRequest; crossings?: ExactCrossingsRequest; drop?: true; upload?: { hash: string; geometry: unknown }; unupload?: string; baseUrl: string }>) => void) | null;
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
};

const sizes = new Map<string, Promise<number>>();
const screeningUrl = (url: string): boolean => url.includes('/screening/');
const mutableManifest = (url: string): boolean => url.endsWith('/screening/manifest.json');
const sizeOf = (url: string): Promise<number> => {
  const mutable = mutableManifest(url);
  let s = mutable ? undefined : sizes.get(url);
  if (!s) {
    s = fetch(url, { method: 'HEAD', ...(mutable ? { cache: 'no-store' as const } : {}), ...(screeningUrl(url) ? { signal: AbortSignal.timeout(30_000) } : {}) }).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const n = Number(r.headers.get('content-length'));
      return Number.isFinite(n) && n > 0 ? n : Infinity;
    });
    if (!mutable) sizes.set(url, s);
    s.catch(() => sizes.delete(url));
  }
  return s;
};

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('observation range has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('observation range exceeds byte budget');
      chunks.push(value);
    }
  } catch (e) { void reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

const uploads = new Map<string, UploadLayer>();
/** Settles once every upload posted so far is built (messages are handled in order behind it). */
let uploaded: Promise<void> = Promise.resolve();
/** Why an upload was not kept, by the hash it was posted under. */
const rejected = new Map<string, string>();
const NOT_LOADED = /^upload layer (\S+) not loaded/;
/** A refusal for an upload this worker rejected also says why. */
const explain = <T extends { ok: boolean }>(outcome: T): T => {
  const o = outcome as unknown as { ok: boolean; reason?: string };
  const why = !o.ok && typeof o.reason === 'string' ? rejected.get(NOT_LOADED.exec(o.reason)?.[1] ?? '') : undefined;
  return why ? { ...outcome, reason: `${o.reason}: ${why}` } : outcome;
};

const io = (baseUrl: string, id: number): RouteIO => ({
  baseUrl,
  uploads,
  progress: (progress) => scope.postMessage({ id, progress }),
  async fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    try {
      return await r.json();
    } catch {
      throw new Error(`${url} is not JSON (is the routing cube built?)`);
    }
  },
  async fetchRange(url, start, end) {
    const stop = Math.min(end, await sizeOf(url));
    if (stop <= start) return new Uint8Array(0);
    const screening = screeningUrl(url);
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${stop - 1}` }, ...(screening ? { signal: AbortSignal.timeout(30_000) } : {}), ...(mutableManifest(url) ? { cache: 'no-store' as const } : {}) });
    if (screening) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
      if (r.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== stop - 1) {
        void r.body?.cancel().catch(() => {});
        throw new Error('observation server did not return the requested range');
      }
      return boundedBytes(r, stop - start);
    }
    if (r.status === 206) return new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) return new Uint8Array(await r.arrayBuffer()).slice(start, stop);
    throw new Error(`${url}: HTTP ${r.status} for bytes ${start}-${stop - 1}`);
  },
});

/** The report directory beside the cube directory; null when baseUrl does not resolve. */
const reportUrlOf = (baseUrl: string): string | null => {
  try { return new URL('../report/', new URL(baseUrl, self.location.href)).href; } catch { return null; }
};

const cells = createInspectCache(64);
const windows = createWindowCache();

scope.onmessage = async (e) => {
  const { id, req, baseUrl } = e.data;
  const up = e.data.upload;
  if (up) {
    uploaded = uploaded.then(async () => {
      if (typeof up.hash !== 'string') return;
      const l = await uploadLayer(up.geometry);
      if (l.ok && l.result.hash === up.hash) { uploads.set(up.hash, l.result); rejected.delete(up.hash); }
      else rejected.set(up.hash, l.ok ? 'the geometry does not match its hash' : l.reason);
    }).catch(() => { if (typeof up.hash === 'string') rejected.set(up.hash, 'the upload failed'); });
    return;
  }
  const un = e.data.unupload;
  if (un !== undefined) { uploaded = uploaded.then(() => { uploads.delete(un); rejected.delete(un); }); return; }
  await uploaded;
  if (e.data.drop) { windows.held = null; return; }
  if (e.data.repaint) {
    const outcome = explain(repaint(e.data.repaint, windows, uploads));
    scope.postMessage({ id, outcome }, outcome.ok ? [outcome.result.image.rgba.buffer as ArrayBuffer] : []);
    return;
  }
  if (e.data.repaintRows) {
    const outcome = explain(repaintRows(e.data.repaintRows, windows, uploads));
    scope.postMessage({ id, outcome }, outcome.ok ? [outcome.result.image.rgba.buffer as ArrayBuffer] : []);
    return;
  }
  if (e.data.inspect) {
    scope.postMessage({ id, outcome: explain(await inspect(e.data.inspect, { ...io(baseUrl, id), progress: undefined }, cells, windows)) });
    return;
  }
  if (e.data.crossings) {
    const reportUrl = reportUrlOf(baseUrl);
    const outcome = await exactRouteCrossings(e.data.crossings, {
      ...io(baseUrl, id), progress: undefined, byteLength: sizeOf, ...(reportUrl ? { reportUrl } : {}),
    });
    scope.postMessage({ id, outcome });
    return;
  }
  const outcome = explain(await route(req!, io(baseUrl, id), windows));
  const s = outcome.ok ? outcome.result.surface : undefined;
  const w = outcome.ok ? outcome.result.weightImage : undefined;
  const moved = [
    ...(s && 'image' in s ? [s.image.rgba.buffer as ArrayBuffer, s.classes.buffer as ArrayBuffer] : []),
    ...(w && 'rgba' in w ? [w.rgba.buffer as ArrayBuffer] : []),
  ];
  scope.postMessage({ id, outcome }, moved);
};
