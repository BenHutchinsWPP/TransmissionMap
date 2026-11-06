// sample3dep with fetch mocked (never USGS from a test): batches of ≤ 1,000 with pixelSize,
// locationId matching, missing samples → null, retry on 5xx, abort.
import { describe, expect, it, vi } from 'vitest';
import { in3depArea, sample3dep, MAX_POINTS } from './usgs-3dep.js';

type Call = { url: string; body: URLSearchParams };

/** A fake getSamples: answers each point with lng + lat (as a string), in shuffled order, minus `drop`. */
function fakeFetch(opts: { drop?: (x: number) => boolean; status?: () => number } = {}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init!.body as URLSearchParams;
    calls.push({ url: String(url), body });
    const status = opts.status?.() ?? 200;
    if (status !== 200) return new Response('Bad gateway', { status });
    const pts = (JSON.parse(body.get('geometry')!) as { points: number[][] }).points;
    const samples = pts.map((p, i) => ({ locationId: i, value: String(p[0] + p[1]) }))
      .filter((_, i) => !opts.drop?.(pts[i][0])).reverse();
    return new Response(JSON.stringify({ samples }), { status: 200 });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const line = (n: number) => Array.from({ length: n }, (_, i) => [-110 + i * 1e-4, 40]);

describe('in3depArea', () => {
  it('covers CONUS, Alaska across 180°, Hawaii and Puerto Rico, not Europe or the open ocean', () => {
    for (const p of [[-122.3, 45.6], [-150, 61], [179, 52], [-157.8, 21.3], [-66.1, 18.4]]) expect(in3depArea(p)).toBe(true);
    for (const p of [[10, 50], [-30, 40], [0, 0]]) expect(in3depArea(p)).toBe(false);
  });
});

describe('sample3dep', () => {
  it('sends batches of at most 1,000 points, always with pixelSize, and matches on locationId', async () => {
    const f = fakeFetch();
    const pts = line(2500);
    const r = await sample3dep(pts, { fetchImpl: f.impl, pixelSize: 30 });
    expect(f.calls.length).toBe(3);
    expect(f.calls.every(c => c.url.endsWith('/3DEPElevation/ImageServer/getSamples'))).toBe(true);
    const sizes = f.calls.map(c => (JSON.parse(c.body.get('geometry')!) as { points: unknown[] }).points.length).sort((a, b) => b - a);
    expect(sizes).toEqual([MAX_POINTS, MAX_POINTS, 500]);
    for (const c of f.calls) {
      expect(JSON.parse(c.body.get('pixelSize')!)).toEqual({ x: 30, y: 30, spatialReference: { wkid: 3857 } });
      expect(c.body.get('geometryType')).toBe('esriGeometryMultipoint');
      expect(c.body.get('f')).toBe('json');
    }
    expect(r.values[0]).toBeCloseTo(-70, 6);
    expect(r.values[2499]).toBeCloseTo(pts[2499][0] + 40, 4);
    expect(r.requests).toBe(3);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('a missing sample, NoData or a point outside the US is null, never 0', async () => {
    const f = fakeFetch({ drop: x => x > -109.9999 && x < -109.9998 });
    const r = await sample3dep([[-110, 40], [-109.99985, 40], [10, 50]], { fetchImpl: f.impl });
    expect(r.values[0]).toBe(-70);
    expect(r.values[1]).toBeNull();
    expect(r.values[2]).toBeNull();
    expect((JSON.parse(f.calls[0].body.get('geometry')!) as { points: unknown[] }).points.length).toBe(2);
    const nodata = vi.fn(async () => new Response(JSON.stringify({ samples: [{ locationId: 0, value: 'NoData' }, { locationId: 1, value: '-3.4e38' }] })));
    expect((await sample3dep([[-110, 40], [-110, 41]], { fetchImpl: nodata as unknown as typeof fetch })).values).toEqual([null, null]);
  });

  it('retries a 5xx once after a pause, then gives the batch up as nulls', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const once = fakeFetch({ status: () => (n++ === 0 ? 502 : 200) });
      const p1 = sample3dep(line(3), { fetchImpl: once.impl });
      await vi.advanceTimersByTimeAsync(2_000);
      const r1 = await p1;
      expect(once.calls.length).toBe(2);
      expect(r1.values.every(v => v !== null)).toBe(true);

      const always = fakeFetch({ status: () => 504 });
      const p2 = sample3dep(line(3), { fetchImpl: always.impl });
      await vi.advanceTimersByTimeAsync(2_000);
      const r2 = await p2;
      expect(always.calls.length).toBe(2);
      expect(r2.values).toEqual([null, null, null]);
      expect(r2.failedBatches).toBe(1);

      const bad = fakeFetch({ status: () => 400 });
      const r3 = await sample3dep(line(3), { fetchImpl: bad.impl });
      expect(bad.calls.length).toBe(1);
      expect(r3.values).toEqual([null, null, null]);
    } finally { vi.useRealTimers(); }
  });

  it('keeps at most 4 requests in flight', async () => {
    let live = 0, peak = 0;
    const f = fakeFetch();
    const slow = (async (u: string, i?: RequestInit) => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      live--;
      return f.impl(u, i);
    }) as unknown as typeof fetch;
    await sample3dep(line(9000), { fetchImpl: slow });
    expect(f.calls.length).toBe(9);
    expect(peak).toBe(4);
  });

  it('rejects with AbortError when aborted, before or during a request', async () => {
    const c = new AbortController();
    c.abort();
    await expect(sample3dep(line(3), { signal: c.signal, fetchImpl: fakeFetch().impl })).rejects.toMatchObject({ name: 'AbortError' });
    const c2 = new AbortController();
    const hang = ((_u: string, i?: RequestInit) => new Promise((_, reject) => {
      i!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const p = sample3dep(line(3), { signal: c2.signal, fetchImpl: hang });
    c2.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
