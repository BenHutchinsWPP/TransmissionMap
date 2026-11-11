import { describe, expect, it } from 'vitest';
import { aviationObservation, readRouteScreening } from './screening.js';
import { albersForward } from './grid.js';
type XY = [number, number];
const provenance = { source: 'https://source.example.test/', sha256: 'a'.repeat(64), fetchedAt: '2026-10-31', credit: 'Source', license: 'CC BY 4.0' };
const desc = { ...provenance, file: 'aviation.json', bounds5070: [-100, -100, 100, 100] as [number, number, number, number] };
function ok<T extends { status: string }>(v: T): Extract<T, { status: 'ok' }> { expect(v.status).toBe('ok'); return v as Extract<T, { status: 'ok' }>; }

const facilities = [{ id: 'RNO', name: 'Airport', type: 'A', use: 'PU', status: 'O', point: [0, 0] as XY },
  { id: 'H', name: 'Heliport', type: 'H', use: 'PR', status: 'O', point: [25, 5] as XY }];
const runways = [{ airport: 'RNO', runway: '01/19', ends: [[-10, 0], [10, 0]] as [XY, XY], elevationsFt: [100, 101] as [number, number], surveyDates: ['2014', null] as [string | null, string | null] }];
const adesc = { ...desc, cycle: '2026/10/01', scope: 'Regional sample; runways RNO/RTS only' };
describe('finite runway and inventory distances', () => {
  it('reports crossing centreline, finite ends and airport point separately, keeping omitted runway coverage', () => {
    const r = ok(aviationObservation([[5, -10], [5, 10]], { version: 2, facilities, runways }, adesc));
    expect(r.runways[0]).toMatchObject({ centrelineM: 0, endM: 5, airportPointM: 5, surveyDates: ['2014', null] });
    expect(r.facilities.find(f => f.id === 'H')?.runwayCoverage).toBe('not-queried');
  });
  it('uses finite endpoints for an extended-line near miss and a known parallel offset', () => {
    expect(ok(aviationObservation([[20, -5], [20, 5]], { version: 2, facilities, runways }, adesc)).runways[0].centrelineM).toBe(10);
    expect(ok(aviationObservation([[-5, 3], [5, 3]], { version: 2, facilities, runways }, adesc)).runways[0].centrelineM).toBe(3);
    expect(aviationObservation([[200, 0], [210, 0]], { version: 2, facilities, runways }, adesc).status).toBe('unavailable');
  });
});

describe('optional source read boundaries', () => {
  let n = 0;
  const point = albersForward(-119.8, 39.5);
  const path: XY[][] = [[[point[0] - 100, point[1]], [point[0] + 100, point[1]]]];
  const sha = (c: string) => c.repeat(64);
  const manifest = (generation: string) => ({ version: 2, complete: true, generation,
    aviation: { ...adesc, bounds5070: [point[0] - 1e6, point[1] - 1e6, point[0] + 1e6, point[1] + 1e6], sha256: sha('e'), file: 'aviation.json' } });
  const air = (extra: { id: string; at: XY }[] = []) => ({ version: 2, cycle: '2026/10/01',
    facilities: [...facilities, ...extra.map(e => ({ ...facilities[1], id: e.id, point: e.at }))].map(f => ({ ...f, point: [point[0] + f.point[0], point[1] + f.point[1]] })),
    runways: runways.map(r => ({ ...r, ends: r.ends.map(p => [point[0] + p[0], point[1] + p[1]]) })) });
  function setup(m: (g: string) => unknown = manifest, a: unknown = air(), gen?: string) {
    const generation = gen ?? `${(n++).toString(16).padStart(2, '0')}${'b'.repeat(30)}`;
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const map = new Map([['report/screening/manifest.json', enc(m(generation))], [`report/screening/${generation}/aviation.json`, enc(a)]]);
    const log: string[] = [];
    return { generation, log, io: { reportUrl: 'report/', async byteLength(url: string) { if (!map.has(url)) throw new Error('missing source'); return map.get(url)!.length; },
      async fetchRange(url: string, start: number, end: number) { log.push(url); return map.get(url)!.subarray(start, end); } } };
  }
  it('reads aviation from a manifest and builds the immutable generation path', async () => {
    const s = setup();
    const [r] = await readRouteScreening(path, s.io, Date.now() + 1000);
    expect(ok(r.aviation).facilities.map(f => f.id).sort()).toEqual(['H', 'RNO']);
    expect(r).not.toHaveProperty('buildings');
    expect(s.log).toContain(`report/screening/${s.generation}/aviation.json`);
  });
  it('ignores the buildings and id_kind keys of an older local pointer and requests no other file', async () => {
    const s = setup(g => ({ ...manifest(g), id_kind: 'piece', buildings: { files: [{ name: 'NV.parquet' }] } }));
    const [r] = await readRouteScreening(path, s.io, Date.now() + 1000);
    expect(r.aviation.status).toBe('ok'); expect(r).not.toHaveProperty('buildings');
    expect(s.log.every(u => u.endsWith('manifest.json') || u.endsWith('aviation.json'))).toBe(true);
  });
  it('rejects a v1 manifest with a clear reason, path injection, oversized manifests, expired reads, malformed and invalid aviation', async () => {
    const v1 = (await readRouteScreening(path, setup(g => ({ ...manifest(g), version: 1 })).io, Date.now() + 1000))[0];
    expect(v1.aviation).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('retired') });
    expect((await readRouteScreening(path, setup(g => ({ ...manifest(g), generation: '../bad' })).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup(g => ({ ...manifest(g), complete: false })).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    const oversized = { ...setup().io, async byteLength() { return 1_000_000; } };
    expect((await readRouteScreening(path, oversized, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup().io, Date.now() - 1))[0].aviation.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup(manifest, { error: 'no inventory' }).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    const broken = air(); broken.runways[0].airport = 'missing';
    expect((await readRouteScreening(path, setup(manifest, broken).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
  });
  it('returns unavailable for a stalled manifest without waiting on its network promise', async () => {
    const stalled = { ...setup().io, byteLength: () => new Promise<number>(() => {}) };
    const [r] = await readRouteScreening(path, stalled, Date.now() + 10);
    expect(r.aviation).toMatchObject({ status: 'unavailable', reason: 'observation read deadline passed' });
  });
  it('fetches the national aviation file once per generation, takes up to 8 MiB, and refetches for a new generation', async () => {
    const a = setup(manifest, air(), 'a1' + 'a'.repeat(30));
    await readRouteScreening(path, a.io, Date.now() + 1000);
    expect(ok((await readRouteScreening(path, a.io, Date.now() + 1000))[0].aviation).facilities.map(f => f.id).sort()).toEqual(['H', 'RNO']);
    expect(a.log.filter(u => u.endsWith('aviation.json'))).toHaveLength(1);
    const b = setup(manifest, air([{ id: 'NEW', at: [10, 0] }]), 'a2' + 'a'.repeat(30));
    expect(ok((await readRouteScreening(path, b.io, Date.now() + 1000))[0].aviation).facilities.map(f => f.id)).toContain('NEW');
    expect(b.log.filter(u => u.endsWith('aviation.json'))).toHaveLength(1);
    const size = (bytes: number) => { const s = setup(manifest, air(), `a${bytes}`.padEnd(32, '0')); return { ...s.io, async byteLength(u: string) { return u.endsWith('aviation.json') ? bytes : s.io.byteLength(u); } }; };
    expect((await readRouteScreening(path, size(9 * 2 ** 20), Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    const [ok8] = await readRouteScreening(path, { ...size(7 * 2 ** 20), async fetchRange(u: string, s: number, e: number) { return u.endsWith('aviation.json') ? new TextEncoder().encode(JSON.stringify(air())).subarray(0, 0) : size(1).fetchRange(u, s, e); } }, Date.now() + 1000);
    expect(ok8.aviation.status).toBe('unavailable');   // 7 MiB passes the size cap, the (empty) body then fails the read
    expect(ok8.aviation).not.toMatchObject({ reason: 'observation JSON byte budget passed' });
  });
  it('accepts a runway with no surveyed elevation and a facility beyond the CONUS projection range', async () => {
    const a = air([{ id: 'GUM', at: [-1.3e7, 0] }]); (a.runways[0] as { elevationsFt: (number | null)[] }).elevationsFt = [null, null];
    const [r] = await readRouteScreening(path, setup(manifest, a).io, Date.now() + 1000);
    expect(ok(r.aviation).runways[0].elevationsFt).toEqual([null, null]);
  });
  it('filters facilities to the route box + buffer and refuses more than 500 near the route', async () => {
    const far = { id: 'FAR', at: [500_000, 0] as XY };
    const [r] = await readRouteScreening(path, setup(manifest, air([far])).io, Date.now() + 1000);
    expect(ok(r.aviation).facilities.map(f => f.id).sort()).toEqual(['H', 'RNO']);
    const crowd = Array.from({ length: 501 }, (_, i) => ({ id: `C${i}`, at: [i, 0] as XY }));
    const [c] = await readRouteScreening(path, setup(manifest, air(crowd)).io, Date.now() + 1000);
    expect(c.aviation).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('500 aviation facilities') });
  });
});
