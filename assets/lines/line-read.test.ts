// line-read.ts over the mini GeoParquet in fixtures/analysis/ (fixtures/make-fixtures.py):
// request counts, geometry exactness, chain order and the failure reasons.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup, lineGeometry, chainGeometry, selectionGeometry, lineDataset, resetLineRead,
  requestLog, groupsHolding, rowRuns, MAX_SELECTION } from './line-read.js';

const FIX = fileURLToPath(new URL('./fixtures/analysis/', import.meta.url));
const OSM = 'osm-transmission-lines', HIFLD = 'hifld-transmission-lines';

let index: string;
let mode: 'ok' | 'offline' | 'missing' = 'ok';
const calls: { url: string; range: string | null }[] = [];

function serve(url: string, init?: RequestInit): Response {
  const range = new Headers(init?.headers).get('range');
  calls.push({ url, range });
  if (mode === 'offline') throw new TypeError('Failed to fetch');
  if (!url.startsWith('data/analysis/')) return new Response('', { status: 404 });
  if (url === 'data/analysis/index.json') {
    return mode === 'missing' ? new Response('', { status: 404 }) : new Response(index, { status: 200 });
  }
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
}

beforeEach(() => {
  resetLineRead();
  mode = 'ok';
  calls.length = 0;
  index = readFileSync(FIX + 'index.json', 'utf8');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => serve(url, init)));
});

const rangeCalls = () => calls.filter(c => c.range);

describe('requests', () => {
  it('reads only simple bounded ranges, never a HEAD or a suffix range', async () => {
    await lineGeometry(OSM, 11);
    for (const c of rangeCalls()) expect(c.range).toMatch(/^bytes=\d+-\d+$/);
    const f = vi.mocked(fetch);
    for (const [, init] of f.mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.credentials).toBe('same-origin');
    }
  });

  it('a lookup is one IDX request once the footer is in', async () => {
    expect((await lookup(OSM, 11)).ok).toBe(true);   // index + footer + group
    const before = requestLog.length;
    const got = await lookup(OSM, 41);
    expect(got.ok).toBe(true);
    expect(requestLog.length - before).toBeLessThanOrEqual(1);
    expect(requestLog.slice(before).every(r => r.url.includes('.idx.'))).toBe(true);
  });

  it('one line geometry is at most 4 GEO requests once the footer is in, and a repeat is free', async () => {
    await lineGeometry(OSM, 1599);   // a line in another page: reads the GEO footer
    await lookup(OSM, 21);
    const before = requestLog.length;
    expect((await lineGeometry(OSM, 21)).ok).toBe(true);
    expect(requestLog.length - before).toBeLessThanOrEqual(4);
    const again = requestLog.length;
    await lineGeometry(OSM, 21);
    expect(requestLog.length).toBe(again);
  });
});

describe('lookup', () => {
  it('returns the length, chain and circuits of an OSM way', async () => {
    const got = await lookup(OSM, 11);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.result.length_km).toBeCloseTo(1.1126, 3);   // 0.01° of the equator on R = 6371.0088 km
    expect(got.result.circuits).toBe(2);
    expect(got.result.chain).toBeGreaterThanOrEqual(0);
  });

  it('reads a HIFLD string id; HIFLD has no chain or circuits', async () => {
    const got = await lookup(HIFLD, '160421');
    expect(got.ok && got.result).toMatchObject({ chain: -1, circuits: -1 });
  });

  it('an id that is not in IDX is not-found, after one fresh index', async () => {
    expect(await lookup(HIFLD, '210905')).toEqual({ ok: false, reason: 'not-found' });
    const indexReads = () => calls.filter(c => c.url.endsWith('index.json')).length;
    expect(indexReads()).toBe(2);
    expect(await lookup(HIFLD, '173158')).toEqual({ ok: false, reason: 'not-found' });
    expect(indexReads()).toBe(2);
  });

  it('a layer with no line dataset is unavailable', async () => {
    expect(await lookup('osm-substations-points', 1)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('geometry', () => {
  it('is the input coordinates exactly', async () => {
    const got = await lineGeometry(OSM, 11);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const coords = got.result.type === 'MultiLineString' ? got.result.coordinates[0]
      : (got.result as GeoJSON.LineString).coordinates;
    expect(coords).toEqual([[0.000001, -0.000001], [0.005, 0.000002], [0.010003, 0.0]]);
  });

  it('keeps a HIFLD MultiLineString in its parts', async () => {
    const got = await lineGeometry(HIFLD, '160421');
    expect(got.ok && got.result).toMatchObject({ type: 'MultiLineString', coordinates: [[[-157.1, 21.9], [-157.2, 22]], [[-157.3, 22.1], [-157.31, 22.11]]] });
  });
});

describe('chainGeometry', () => {
  it('returns the ways in chain order with the reversed one flagged', async () => {
    const got = await chainGeometry(OSM, 21);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const order = got.result.ways.map(w => [w.fid, w.rev]);
    expect([[[11, false], [21, true], [31, false]], [[31, true], [21, false], [11, true]]]).toContainEqual(order);
    const ends = [got.result.startSub, got.result.endSub];
    expect(ends).toContain(9002);   // the substation polygon around A
  });

  it('a way outside any chain is a chain of one', async () => {
    const got = await chainGeometry(OSM, 1005);
    expect(got.ok && got.result.ways.map(w => w.fid)).toEqual([1005]);
  });
});

describe('selectionGeometry', () => {
  // Grid line fid 1000 + i starts at (20 + (i % 30) × 0.1, 10 + ⌊i / 30⌋ × 0.1).
  const grid = (cols: number[], rows: number[]) => rows.flatMap(r => cols.map(c => 1000 + r * 30 + c));

  it('reads more than 20 ids by bbox, only the pages that meet it', async () => {
    const fids = grid([0, 1, 2, 3, 4, 5], [0, 1, 2, 3]);   // 24 lines in the SW corner
    const got = await selectionGeometry(OSM, fids, [19.99, 9.99, 20.6, 10.4]);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.result.missing).toEqual([]);
    expect(got.result.geometries.size).toBe(24);
    const bytes = () => requestLog.filter(r => r.url.includes('.geo.')).reduce((n, r) => n + r.end - r.start, 0);
    const corner = bytes();
    resetLineRead();
    const all = await selectionGeometry(OSM, grid([...Array(30).keys()], [...Array(20).keys()]).slice(0, 600), [19, 9, 24, 13]);
    expect(all.ok && all.result.geometries.size).toBe(600);
    expect(corner).toBeLessThan(bytes());
  });

  it('reads up to 20 ids one by one and lists the ones it cannot find', async () => {
    const got = await selectionGeometry(OSM, [11, 41, 999999], [0, 0, 0, 0]);
    expect(got.ok && got.result.missing).toEqual([999999]);
    expect(got.ok && got.result.geometries.size).toBe(2);
  });

  it('refuses more than the cap', async () => {
    const fids = Array.from({ length: MAX_SELECTION + 1 }, (_, i) => i);
    expect(await selectionGeometry(OSM, fids, [-180, -90, 180, 90])).toEqual({ ok: false, reason: 'too-many' });
  });
});

describe('failures', () => {
  it('no index is unavailable', async () => {
    mode = 'missing';
    expect(await lookup(OSM, 11)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a network error is offline, and the next call tries again', async () => {
    mode = 'offline';
    expect(await lookup(OSM, 11)).toEqual({ ok: false, reason: 'offline' });
    mode = 'ok';
    expect((await lookup(OSM, 11)).ok).toBe(true);
  });

  it('a file from another build is stale-build', async () => {
    const idx = JSON.parse(index);
    idx.datasets.osm_transmission_lines.build_id = 'other';
    index = JSON.stringify(idx);
    expect(await lookup(OSM, 11)).toEqual({ ok: false, reason: 'stale-build' });
  });

  it('a file the host no longer has is stale-build', async () => {
    const idx = JSON.parse(index);
    idx.datasets.osm_transmission_lines.geo[0].name = 'osm_transmission_lines.geo.p0.gone.parquet';
    index = JSON.stringify(idx);
    expect(await lineGeometry(OSM, 11)).toEqual({ ok: false, reason: 'stale-build' });
  });

  it('a tab whose index.json predates a rebuild reads it again and answers', async () => {
    const fresh = index;
    const idx = JSON.parse(index);
    idx.datasets.osm_transmission_lines.idx.name = 'osm_transmission_lines.idx.previous.parquet';
    idx.datasets.osm_transmission_lines.build_id = 'previous';
    index = JSON.stringify(idx);
    expect((await lineDataset(OSM)).ok).toBe(true);   // the tab holds the old index
    index = fresh;                                      // the rebuild lands
    expect((await lookup(OSM, 11)).ok).toBe(true);
    expect(calls.filter(c => c.url.endsWith('index.json'))).toHaveLength(2);
  });

  it('a 200 that is not the file (a dev server\'s page for a missing name) is stale-build, not offline', async () => {
    const idx = JSON.parse(index);
    idx.datasets.osm_transmission_lines.idx.name = 'osm_transmission_lines.idx.previous.parquet';
    index = JSON.stringify(idx);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
      url.includes('.previous.') ? new Response('<!doctype html><title>app</title>', { status: 200 }) : serve(url, init)));
    expect(await lookup(OSM, 11)).toEqual({ ok: false, reason: 'stale-build' });
  });

  it('a call that takes too long is a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const p = lookup(OSM, 11);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    vi.useRealTimers();
  });

  it('no index is remembered for the session: no second request', async () => {
    mode = 'missing';
    await lookup(OSM, 11);
    const n = calls.length;
    expect(await lookup(OSM, 12)).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls.length).toBe(n);
  });

  it('a stalled range request is aborted, so the next call reads again', async () => {
    vi.useFakeTimers();
    let stall = true;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!stall || !new Headers(init?.headers).get('range')) return Promise.resolve(serve(url, init));
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }));
    const p = lookup(OSM, 11);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    vi.useRealTimers();
    stall = false;
    expect((await lookup(OSM, 11)).ok).toBe(true);
  });

  it('the manifest carries the credit and licence', async () => {
    const got = await lineDataset(OSM);
    expect(got.ok && got.result.licence).toMatch(/ODbL/);
    expect(got.ok && got.result.attribution).toMatch(/OpenStreetMap/);
  });
});

describe('pure helpers', () => {
  const md = { row_groups: [
    { num_rows: 10n, columns: [{ meta_data: { path_in_schema: ['fid'], statistics: { min_value: 1n, max_value: 9n } } }] },
    { num_rows: 5n, columns: [{ meta_data: { path_in_schema: ['fid'], statistics: { min_value: 10n, max_value: 20n } } }] },
  ] } as never;

  it('groupsHolding picks the group whose statistics hold the key', () => {
    expect(groupsHolding(md, 'fid', 12n)).toEqual([[10, 15]]);
    expect(groupsHolding(md, 'fid', 99n)).toEqual([]);
  });

  it('rowRuns joins rows within the gap', () => {
    expect(rowRuns([5, 1, 2, 200, 70], 64)).toEqual([[1, 71], [200, 201]]);
  });
});
