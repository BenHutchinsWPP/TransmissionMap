import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationObservation, buildingObservation, readRouteScreening, type BuildingFeature } from './screening.js';
import { BYTE_BUDGET_MSG, readSpatialRows } from './report-read.js';
import { albersForward } from './grid.js';
vi.mock('./report-read.js', async importOriginal => ({ ...await importOriginal<typeof import('./report-read.js')>(), readSpatialRows: vi.fn() }));
type XY = [number, number];
const provenance = { source: 'https://source.example.test/', sha256: 'a'.repeat(64), fetchedAt: '2026-10-31', credit: 'Source', license: 'CC BY 4.0' };
const desc = { ...provenance, file: 'buildings.parquet', bounds5070: [-100, -100, 100, 100] as [number, number, number, number], imageryYears: [2022] };
const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const roof = (id: string, x0: number, x1: number, cls: string | null = 'Commercial'): BuildingFeature => ({ id, class: cls, polygons: [[rect(x0, -5, x1, 5)]] });
function ok<T extends { status: string }>(v: T): Extract<T, { status: 'ok' }> { expect(v.status).toBe('ok'); return v as Extract<T, { status: 'ok' }>; }

describe('drawn-route building observations', () => {
  it('unions overlapping roofs by class and all, counts unique roofs and preserves repeated traversals', () => {
    const r = ok(buildingObservation([[-20, 0], [20, 0], [-20, 0]], [roof('a', -10, 5), roof('b', 0, 10), roof('c', 0, 5, 'Residential')], desc));
    expect(r.totalM).toBe(80); expect(r.observedM).toBe(80);
    expect(r.counts).toEqual({ all: 3, residential: 1, nonresidential: 2, unknown: 0 });
    expect(r.metres).toEqual({ all: 40, residential: 10, nonresidential: 40, unknown: 0 });
  });
  it('counts the national cache classes: Nonresidential is nonresidential, Unknown and null are unknown', () => {
    const r = ok(buildingObservation([[-20, 0], [20, 0]], [roof('n', -10, -5, 'Nonresidential'), roof('r', -3, 0, 'Residential'), roof('u', 1, 3, 'Unknown'), roof('z', 5, 7, null)], desc));
    expect(r.counts).toEqual({ all: 4, residential: 1, nonresidential: 1, unknown: 2 });
    expect(r.metres).toEqual({ all: 12, residential: 3, nonresidential: 5, unknown: 4 });
  });
  it('subtracts holes, merges multipart intervals and excludes tangencies and boundary-only traversal', () => {
    const f: BuildingFeature = { id: 'hole', class: null, polygons: [[rect(-10, -5, 10, 5), rect(-2, -2, 2, 2)], [rect(12, -5, 15, 5)]] };
    const r = ok(buildingObservation([[-20, 0], [20, 0]], [f], desc));
    expect(r.metres.all).toBeCloseTo(19); expect(r.counts.unknown).toBe(1);
    const edge = ok(buildingObservation([[-20, 5], [20, 5]], [roof('edge', -10, 10)], desc));
    expect(edge.metres.all).toBe(0); expect(edge.counts.all).toBe(0);
    const tangent = ok(buildingObservation([[-20, 15], [0, -5]], [roof('touch', 0, 10)], desc));
    expect(tangent.counts.all).toBe(0);
  });
  it('handles a route wholly inside a roof, duplicate polygon vertices and zero-length route segments', () => {
    const f = roof('a', -10, 10); f.polygons[0][0].splice(1, 0, [-10, -5]);
    const r = ok(buildingObservation([[-2, 0], [-2, 0], [2, 0]], [f], desc));
    expect(r.metres.all).toBe(4); expect(r.counts.all).toBe(1);
  });
  it('clips count/length to queried coverage and never reports an outside or degenerate route clear', () => {
    const d = { ...desc, bounds5070: [0, -10, 10, 10] as [number, number, number, number] };
    const r = ok(buildingObservation([[-20, 0], [20, 0]], [roof('partial', -5, 5), roof('outside', -15, -10)], d));
    expect(r.totalM).toBe(40); expect(r.observedM).toBe(10); expect(r.metres.all).toBe(5); expect(r.counts.all).toBe(1);
    expect(buildingObservation([[-20, 0], [-15, 0]], [], d).status).toBe('unavailable');
    expect(buildingObservation([[0, 0], [0, 0]], [], d).status).toBe('unavailable');
    expect(buildingObservation([[0, 0], [1, 0]], [], d, Date.now() - 1).status).toBe('unavailable');
  });
});
const facilities = [{ id: 'RNO', name: 'Airport', type: 'A', use: 'PU', status: 'O', point: [0, 0] as XY },
  { id: 'H', name: 'Heliport', type: 'H', use: 'PR', status: 'O', point: [25, 5] as XY }];
const runways = [{ airport: 'RNO', runway: '01/19', ends: [[-10, 0], [10, 0]] as [XY, XY], elevationsFt: [100, 101] as [number, number], surveyDates: ['2014', null] as [string | null, string | null] }];
const adesc = { ...desc, file: 'aviation.json', cycle: '2026/10/01', scope: 'Regional sample; runways RNO/RTS only' };
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
  const around = (dx: number, w = 1000): [number, number, number, number] => [point[0] + dx - w, point[1] - w, point[0] + dx + w, point[1] + w];
  const sha = (c: string) => c.repeat(64);
  const state = (name: string, dx: number, years = [2022]) => ({ name: `${name}.parquet`, state: name, bounds5070: around(dx), rows: 1, imageryYears: years, sha256: sha(name === 'NV' ? 'c' : 'd') });
  const manifest = (generation: string, files = [state('NV', 0)]) => ({ version: 2, id_kind: 'piece', complete: true, generation,
    buildings: { files, source: 'https://source.example.test/', credit: 'Source', license: 'CC BY 4.0' },
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
  beforeEach(() => { vi.mocked(readSpatialRows).mockReset(); });
  it('preserves the other family when buildings fail, and constructs immutable generation paths', async () => {
    vi.mocked(readSpatialRows).mockRejectedValue(new Error('buildings unavailable'));
    const s = setup();
    const [r] = await readRouteScreening(path, s.io, Date.now() + 1000);
    expect(r.buildings.status).toBe('unavailable'); expect(r.aviation.status).toBe('ok');
    expect(vi.mocked(readSpatialRows).mock.calls[0][1]).toBe(`report/screening/${s.generation}/NV.parquet`);
  });
  it('keeps a successful queried zero distinct from malformed polygon data or malformed aviation', async () => {
    vi.mocked(readSpatialRows).mockResolvedValue([]);
    const [r] = await readRouteScreening(path, setup(manifest, { error: 'no inventory' }).io, Date.now() + 1000);
    expect(ok(r.buildings).counts.all).toBe(0); expect(r.aviation.status).toBe('unavailable');
    expect(ok(r.buildings).imageryYears).toEqual([2022]);
    vi.mocked(readSpatialRows).mockImplementation((async (_i: unknown, _u: unknown, _c: unknown, _co: unknown, _t: unknown, _d: unknown, sink: (rows: unknown[]) => void) =>
      sink([{ index: 0, row: { id: 'x', class: null, geometry: { type: 'Polygon', coordinates: [] } } }])) as never);
    expect((await readRouteScreening(path, setup().io, Date.now() + 1000))[0].buildings.status).toBe('unavailable');
  });
  it('rejects a v1 manifest with a clear reason, path injection, oversized manifests, expired reads and invalid aviation joins', async () => {
    const v1 = (await readRouteScreening(path, setup(g => ({ ...manifest(g), version: 1 })).io, Date.now() + 1000))[0];
    expect(v1.buildings).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('retired') }); expect(v1.aviation.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup(g => ({ ...manifest(g), generation: '../bad' })).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup(g => ({ ...manifest(g), complete: false })).io, Date.now() + 1000))[0].buildings.status).toBe('unavailable');
    const oversized = { ...setup().io, async byteLength() { return 1_000_000; } };
    expect((await readRouteScreening(path, oversized, Date.now() + 1000))[0].buildings.status).toBe('unavailable');
    expect((await readRouteScreening(path, setup().io, Date.now() - 1))[0].buildings.status).toBe('unavailable');
    vi.mocked(readSpatialRows).mockResolvedValue([]);
    const broken = air(); broken.runways[0].airport = 'missing';
    expect((await readRouteScreening(path, setup(manifest, broken).io, Date.now() + 1000))[0].aviation.status).toBe('unavailable');
  });
  it('returns unavailable for a stalled manifest without waiting on its network promise', async () => {
    const stalled = { ...setup().io, byteLength: () => new Promise<number>(() => {}) };
    const [r] = await readRouteScreening(path, stalled, Date.now() + 10);
    expect(r.buildings).toMatchObject({ status: 'unavailable', reason: 'observation read deadline passed' });
    expect(r.aviation.status).toBe('unavailable');
  });
  it('keeps completed aviation when the optional building request stalls', async () => {
    vi.mocked(readSpatialRows).mockImplementation(() => new Promise(() => {}));
    const [r] = await readRouteScreening(path, setup().io, Date.now() + 30);
    expect(r.buildings.status).toBe('unavailable');
    expect(r.aviation.status).toBe('ok');
  });

  it('a two-file manifest reads only the file whose bounds meet the route, and reports that file\'s imagery years', async () => {
    vi.mocked(readSpatialRows).mockResolvedValue([]);
    const s = setup(g => manifest(g, [state('NV', 0, [2018, 2022]), state('CA', 500_000, [1999])]));
    const [r] = await readRouteScreening(path, s.io, Date.now() + 1000);
    expect(vi.mocked(readSpatialRows).mock.calls.map(c => c[1])).toEqual([`report/screening/${s.generation}/NV.parquet`]);
    expect(ok(r.buildings).imageryYears).toEqual([2018, 2022]);
    // a route over both reads both, under one budget object, and reports the union of their years
    vi.mocked(readSpatialRows).mockClear();
    const both: XY[][] = [[[point[0] - 100, point[1]], [point[0] + 500_000, point[1]]]];
    const s2 = setup(g => manifest(g, [state('NV', 0, [2018, 2022]), state('CA', 500_000, [1999])]));
    const [r2] = await readRouteScreening(both, s2.io, Date.now() + 1000);
    const calls = vi.mocked(readSpatialRows).mock.calls;
    expect(calls.map(c => c[1].split('/').pop()).sort()).toEqual(['CA.parquet', 'NV.parquet']);
    expect(calls[0][4]).toBe(calls[1][4]);
    expect(calls[0][4]).toMatchObject({ maxBytes: 256 * 2 ** 20, maxUncompressed: 2 ** 30 }); expect((calls[0][4] as { maxRows?: number }).maxRows).toBeUndefined();
    expect(ok(r2.buildings).imageryYears).toEqual([1999, 2018, 2022]);
    // a route over neither is never a clear zero
    const far: XY[][] = [[[point[0] + 9e6, point[1]], [point[0] + 9e6 + 100, point[1]]]];
    expect((await readRouteScreening(far, setup().io, Date.now() + 1000))[0].buildings.status).toBe('unavailable');
  });
  it('streams rows into the tally per chunk; a duplicate piece id across files throws', async () => {
    const roofRow = (id: string) => ({ index: 0, row: { id, class: 'Nonresidential', geometry: { type: 'Polygon', coordinates: [[[-119.8, 39.4999], [-119.7999, 39.4999], [-119.7999, 39.5001], [-119.8, 39.5001], [-119.8, 39.4999]]] } } });
    vi.mocked(readSpatialRows).mockImplementation((async (_i: unknown, _u: unknown, _c: unknown, _co: unknown, _t: unknown, _d: unknown, sink: (rows: unknown[]) => void) => { sink([roofRow('NV:1:0')]); sink([roofRow('NV:1:1')]); return []; }) as never);
    const r = ok((await readRouteScreening(path, setup().io, Date.now() + 1000))[0].buildings);
    expect(r.counts.nonresidential).toBe(2);
    vi.mocked(readSpatialRows).mockImplementation((async (_i: unknown, _u: unknown, _c: unknown, _co: unknown, _t: unknown, _d: unknown, sink: (rows: unknown[]) => void) => { sink([roofRow('NV:1:0')]); sink([roofRow('NV:1:0')]); return []; }) as never);
    expect((await readRouteScreening(path, setup().io, Date.now() + 1000))[0].buildings).toMatchObject({ status: 'unavailable', reason: 'duplicate structure identity' });
  });
  it('over the 256 MiB byte budget the buildings family is unavailable with the reason and its i18n key, never a zero; aviation is kept', async () => {
    vi.mocked(readSpatialRows).mockRejectedValue(new Error(BYTE_BUDGET_MSG));
    const [r] = await readRouteScreening(path, setup().io, Date.now() + 1000);
    expect(r.buildings).toEqual({ status: 'unavailable', reason: 'structure data along this route exceeds 256 MiB', reasonKey: 'route.obs.overBudget' });
    expect(r.aviation.status).toBe('ok');
  });
  it('fetches the national aviation file once per generation, takes up to 8 MiB, and refetches for a new generation', async () => {
    vi.mocked(readSpatialRows).mockResolvedValue([]);
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
    vi.mocked(readSpatialRows).mockResolvedValue([]);
    const a = air([{ id: 'GUM', at: [-1.3e7, 0] }]); (a.runways[0] as { elevationsFt: (number | null)[] }).elevationsFt = [null, null];
    const [r] = await readRouteScreening(path, setup(manifest, a).io, Date.now() + 1000);
    expect(ok(r.aviation).runways[0].elevationsFt).toEqual([null, null]);
  });
  it('filters facilities to the route box + buffer and refuses more than 500 near the route', async () => {
    vi.mocked(readSpatialRows).mockResolvedValue([]);
    const far = { id: 'FAR', at: [500_000, 0] as XY };
    const [r] = await readRouteScreening(path, setup(manifest, air([far])).io, Date.now() + 1000);
    expect(ok(r.aviation).facilities.map(f => f.id).sort()).toEqual(['H', 'RNO']);
    const crowd = Array.from({ length: 501 }, (_, i) => ({ id: `C${i}`, at: [i, 0] as XY }));
    const [c] = await readRouteScreening(path, setup(manifest, air(crowd)).io, Date.now() + 1000);
    expect(c.aviation).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('500 aviation facilities') });
  });
});
