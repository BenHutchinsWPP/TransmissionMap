// The deterministic joins over fixture rows (dataset-query mocked): counts per
// polygon with holes, bbox-centre points, completeness and precision text,
// crossings, and the line validator.
import { describe as suite, it, expect, vi, beforeEach } from 'vitest';
import type { Outcome, QueryResult } from './dataset-query.js';

const m = vi.hoisted(() => ({
  kinds: {} as Record<string, 'geojson' | 'pmtiles'>,
  rows: {} as Record<string, unknown[]>,
  truncated: {} as Record<string, boolean>,
  opts: [] as [string, { fragments?: boolean; scope?: string }][],
}));
vi.mock('./dataset-query.js', () => ({
  QUERY_MAX_ROWS: 5000,
  describe: (id: string) => id in m.kinds
    ? { ok: true, result: { layerId: id, queryable: true, kind: m.kinds[id] } }
    : id === 'nexrad-radar' ? { ok: true, result: { layerId: id, queryable: false, reason: 'no schema' } }
      : { ok: false, reason: `"${id}" is not a layer id` },
  query: async (id: string, o: { fragments?: boolean; scope?: string } = {}): Promise<Outcome<QueryResult>> => (m.opts.push([id, o]), { ok: true, result: {
    layerId: id, complete: m.kinds[id] === 'geojson', ...(m.kinds[id] === 'pmtiles' && { reason: 'vector tiles: loaded only' }),
    fields: [], rows: m.rows[id] as never, total: m.rows[id].length, truncated: !!m.truncated[id],
  } }),
}));

import { joinPoints, crossings, checkLine } from './spatial-join.js';

const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const pt = (id: number, x: number, y: number) => ({ id, props: {}, feature: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, y] } } });
const poly = (id: number, name: string, rings: number[][][]) =>
  ({ id, props: { name }, feature: { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: rings } } });

beforeEach(() => {
  m.kinds = { pts: 'geojson', polys: 'geojson', tiles: 'pmtiles' };
  m.truncated = {};
  m.opts = [];
  m.rows = {
    pts: [pt(1, 1, 1), pt(2, 2, 2), pt(3, 15, 15), pt(4, 5, 5)],
    polys: [poly(10, 'A', [sq(0, 0, 10, 10), sq(4, 4, 6, 6)]), poly(11, 'B', [sq(12, 12, 20, 20)]), poly(12, 'Empty', [sq(50, 50, 60, 60)])],
    tiles: [poly(20, 'T', [sq(0, 0, 3, 3)])],
  };
});

// A tile-cut polygon as the merged MultiPolygon the row source returns for `fragments: true`.
const twoPieces = () => ({ id: 30, props: { name: 'Split' }, feature: { type: 'Feature', properties: {}, geometry: {
  type: 'MultiPolygon', coordinates: [[sq(0, 0, 5, 10)], [sq(5, 0, 10, 10)]] } } });

suite('tile-split polygons', () => {
  it('every query asks for the view, never the dataset', async () => {
    await joinPoints({ points: 'pts', polygons: 'tiles' });
    await crossings({ geometry: { type: 'LineString', coordinates: [[12, 5], [8, 5]] }, polygons: ['tiles'] });
    expect(m.opts.length).toBeGreaterThan(2);
    for (const [, o] of m.opts) expect(o.scope).toBe('view');
  });

  it('joinPoints counts points in every piece and asks for fragments on the polygon side only', async () => {
    m.rows.tiles = [twoPieces()];
    m.rows.pts = [pt(1, 2, 5), pt(2, 8, 5), pt(3, 9, 1)];
    const r = await joinPoints({ points: 'pts', polygons: 'tiles' });
    expect(r).toMatchObject({ ok: true, result: { rows: [{ polygonId: 30, count: 3 }] } });
    expect(m.opts).toEqual([['pts', expect.objectContaining({ fragments: false })], ['tiles', expect.objectContaining({ fragments: true })]]);
  });
  it('crossings finds a line that meets only the second piece, with a null count', async () => {
    m.rows.tiles = [twoPieces()];
    const r = await crossings({ geometry: { type: 'LineString', coordinates: [[12, 5], [8, 5]] }, polygons: ['tiles'] });
    expect(r).toMatchObject({ ok: true, result: { rows: [{ layer: 'tiles', id: 30, crossings: null }], countReason: expect.stringMatching(/tile pieces: count not reliable/) } });
  });
  it('crossings keeps the count for a GeoJSON layer and sets no countReason', async () => {
    const r = await crossings({ geometry: { type: 'LineString', coordinates: [[-1, 5], [11, 5]] }, polygons: ['polys'] });
    expect(r).toMatchObject({ ok: true, result: { rows: [{ crossings: 4 }] } });
    expect((r as { result: object }).result).not.toHaveProperty('countReason');
  });
});

suite('joinPoints', () => {
  it('counts points per polygon, honouring holes, omitting empty polygons', async () => {
    const r = await joinPoints({ points: 'pts', polygons: 'polys' });
    expect(r).toMatchObject({ ok: true, result: { complete: true, precision: 'full geometry', pointCount: 4, polygonCount: 3,
      rows: [{ polygonId: 10, polygonLabel: 'A', count: 2 }, { polygonId: 11, polygonLabel: 'B', count: 1 }] } });
  });
  it('uses the bbox centre of a non-point geometry', async () => {
    m.rows.pts = [{ id: 1, props: {}, feature: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[13, 13], [15, 15]] } } }];
    const r = await joinPoints({ points: 'pts', polygons: 'polys' });
    expect(r).toMatchObject({ ok: true, result: { rows: [{ polygonId: 11, count: 1 }] } });
  });
  it('is incomplete for vector tiles, with the precision stated', async () => {
    const r = await joinPoints({ points: 'pts', polygons: 'tiles' });
    expect(r).toMatchObject({ ok: true, result: { complete: false, precision: expect.stringMatching(/^tile geometry at zoom/), reason: expect.stringMatching(/loaded/) } });
  });
  it('is incomplete when a side was capped', async () => {
    m.truncated.pts = true;
    const r = await joinPoints({ points: 'pts', polygons: 'polys' });
    expect(r).toMatchObject({ ok: true, result: { complete: false, reason: expect.stringMatching(/only the first 5000/) } });
  });
  it('refuses a layer that is not queryable or unknown', async () => {
    expect(await joinPoints({ points: 'nexrad-radar', polygons: 'polys' })).toEqual({ ok: false, reason: 'no schema' });
    expect((await joinPoints({ points: 'pts', polygons: 'nope' })).ok).toBe(false);
    expect((await joinPoints({ points: 1, polygons: 'polys' } as never)).ok).toBe(false);
  });
});

suite('crossings', () => {
  const line = (...c: number[][]) => ({ type: 'LineString' as const, coordinates: c });
  it('lists polygons the line crosses or starts in', async () => {
    const r = await crossings({ geometry: line([-1, 5], [11, 5]), polygons: ['polys'] });
    expect(r).toMatchObject({ ok: true, result: { complete: true, rows: [{ layer: 'polys', id: 10, label: 'A', crossings: 4 }] } });
    const inside = await crossings({ geometry: line([1, 1], [2, 2]), polygons: ['polys'] });
    expect(inside).toMatchObject({ ok: true, result: { rows: [{ id: 10, crossings: 0 }] } });
  });
  it('spans layers and reports tile incompleteness', async () => {
    const r = await crossings({ geometry: line([-1, 1], [30, 1]), polygons: ['polys', 'tiles'] });
    expect(r).toMatchObject({ ok: true, result: { complete: false } });
    expect((r as { result: { rows: { layer: string }[] } }).result.rows.map(x => x.layer)).toEqual(['polys', 'tiles']);
  });
  it('validates the geometry and layers', async () => {
    expect((await crossings({ geometry: { type: 'Point' } as never, polygons: ['polys'] })).ok).toBe(false);
    expect((await crossings({ geometry: line([0, 0], [1, 1]), polygons: [] })).ok).toBe(false);
    expect((await crossings({ geometry: line([0, 0], [1, 1]), polygons: ['nexrad-radar'] })).ok).toBe(false);
  });
});

suite('checkLine', () => {
  it('bounds vertices and coordinates', () => {
    expect(checkLine({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBeNull();
    expect(checkLine({ type: 'LineString', coordinates: [[0, 0]] })).toMatch(/at least 2/);
    expect(checkLine({ type: 'LineString', coordinates: [[0, 0], [181, 0]] })).toMatch(/longitude/);
    expect(checkLine({ type: 'LineString', coordinates: [[0, 0], [0, NaN]] })).toMatch(/longitude/);
    expect(checkLine({ type: 'LineString', coordinates: Array.from({ length: 5001 }, () => [0, 0]) })).toMatch(/at most 5000/);
    expect(checkLine(null)).toMatch(/LineString/);
  });
});
