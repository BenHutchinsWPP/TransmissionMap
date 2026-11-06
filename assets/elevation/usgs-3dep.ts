// ─── USGS 3DEP elevation client ───────────────────────────────────────────────
// Role: elevation at points from the USGS 3DEP ImageServer's getSamples (public domain), for the
//   line profile (lines/profile.ts). One form POST (a simple request: no preflight) per batch of at
//   most 1,000 points (the server answers no more), always with pixelSize (without it the service
//   reads the 1 m lidar and times out with a 504), at most 4 requests in flight, 30 s per request,
//   and one retry after 2 s on a 5xx, a timeout or a network error. Samples are matched on
//   locationId. Points outside the US boxes 3DEP covers are not sent; a point the service leaves
//   out, a non-numeric value, or a batch that fails comes back null (the caller fills it from
//   Terrarium), never 0. An aborted signal rejects with an AbortError.
//   sample3dep(points, opts)   → { values, requests, bytes, failedBatches }
//   in3depArea(pos)            whether a point lies in one of the boxes
// Deps: constants.ts (ELEVATION_3DEP_URL).

import { ELEVATION_3DEP_URL } from '../constants.js';

export const USGS_3DEP_CREDIT = 'USGS 3D Elevation Program (3DEP), public domain. Map services and data available from U.S. Geological Survey, National Geospatial Program';
export const MAX_POINTS = 1000;
export const MAX_IN_FLIGHT = 4;
export const TIMEOUT_MS = 30_000;
export const RETRY_MS = 2_000;

// [west, south, east, north]: CONUS, Alaska (both sides of 180°), Hawaii, Puerto Rico and the
// USVI, Guam and the CNMI, American Samoa.
const US_BOXES: [number, number, number, number][] = [
  [-125, 24, -66.5, 49.5], [-180, 51, -129.5, 71.6], [172, 51, 180, 53.5], [-160.8, 18.5, -154.5, 22.5],
  [-68, 17.5, -64.5, 18.6], [144.5, 13.2, 146.1, 20.6], [-171.2, -14.6, -168.1, -11],
];

export function in3depArea(p: number[]): boolean {
  return US_BOXES.some(([w, s, e, n]) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n);
}

export interface Sample3depResult {
  values: (number | null)[];
  requests: number;      // POSTs sent, retries included
  bytes: number;         // response characters read
  failedBatches: number; // batches that gave no answer after the retry
}

export interface Sample3depOpts {
  pixelSize?: number;    // metres, Web Mercator (10 reads the 1/3″ product)
  signal?: AbortSignal;
  onBatch?: (done: number, total: number) => void;
  fetchImpl?: typeof fetch;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(id); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

type Reply = { ok: true; byId: Map<number, number | null> } | { ok: false; retry: boolean };

/** A sample's value: metres, or null for NoData and the large negative fill. */
function value(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > -1000 && n < 9000 ? n : null;
}

/** Elevation in metres at each [lng, lat], in order; null where 3DEP gave no value. */
export async function sample3dep(points: number[][], opts: Sample3depOpts = {}): Promise<Sample3depResult> {
  const { pixelSize = 10, signal, onBatch, fetchImpl = fetch } = opts;
  if (signal?.aborted) throw abortError();
  const values: (number | null)[] = new Array(points.length).fill(null);
  const send: number[] = [];
  points.forEach((p, i) => { if (in3depArea(p)) send.push(i); });
  const batches: number[][] = [];
  for (let i = 0; i < send.length; i += MAX_POINTS) batches.push(send.slice(i, i + MAX_POINTS));
  const out: Sample3depResult = { values, requests: 0, bytes: 0, failedBatches: 0 };
  const pixel = JSON.stringify({ x: pixelSize, y: pixelSize, spatialReference: { wkid: 3857 } });

  const post = async (idx: number[]): Promise<Reply> => {
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: idx.map(i => [+points[i][0].toFixed(7), +points[i][1].toFixed(7)]), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      interpolation: 'RSP_BilinearInterpolation',
      pixelSize: pixel,
      f: 'json',
    });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    out.requests++;
    try {
      const res = await fetchImpl(`${ELEVATION_3DEP_URL}/getSamples`, { method: 'POST', body, signal: ctrl.signal, credentials: 'omit' });
      const text = await res.text();
      out.bytes += text.length;
      if (!res.ok) return { ok: false, retry: res.status >= 500 };
      const json = JSON.parse(text) as { samples?: { locationId?: unknown; value?: unknown }[]; error?: { code?: unknown } };
      if (json.error) return { ok: false, retry: Number(json.error.code) >= 500 };
      const byId = new Map<number, number | null>();
      for (const s of json.samples ?? []) {
        if (typeof s?.locationId === 'number' && Number.isInteger(s.locationId)) byId.set(s.locationId, value(s.value));
      }
      return { ok: true, byId };
    } catch {
      if (signal?.aborted) throw abortError();
      return { ok: false, retry: true };   // a timeout, a network error or an unreadable reply
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  let next = 0, done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const idx = batches[next++];
      let r = await post(idx);
      if (!r.ok && r.retry) {
        await wait(RETRY_MS, signal);
        r = await post(idx);
      }
      if (signal?.aborted) throw abortError();
      if (r.ok) { const byId = r.byId; idx.forEach((pi, k) => { values[pi] = byId.get(k) ?? null; }); }
      else out.failedBatches++;
      onBatch?.(++done, batches.length);
    }
  };
  onBatch?.(0, batches.length);
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, batches.length) }, worker));
  return out;
}
