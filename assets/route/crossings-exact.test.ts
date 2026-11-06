import { describe, expect, it } from 'vitest';
import { DUP_M, MERGE_M, dedupePoints, exactCrossings, rawIntersections, segIntersect, type ExactFeature } from './crossings-exact.js';
import { albersForward } from './grid.js';

type XY = [number, number];
const ident = (x: number, y: number): XY => [x, y];
const run = (route: XY[], features: ExactFeature[], lengthMi = 10) =>
  exactCrossings([route], features, { toLngLat: ident, lengthsMi: [lengthMi] })[0];
const ns = (x: number, y0 = -1000, y1 = 1000): XY[][] => [[[x, y0], [x, y1]]];
let n = 0;
const feat = (family: ExactFeature['family'], lines: XY[][], o: Partial<ExactFeature> = {}): ExactFeature =>
  ({ family, src: family === 'rail' ? 'narn' : 'osm', id: `f${n++}`, lines, ...o });
const line = (kv: number, lines: XY[][], o: Partial<ExactFeature> = {}) => feat('line', lines, { kv, ...o });
const EAST: XY[] = [[0, 0], [20000, 0]];

describe('route_crossings.py ports', () => {
  it('seg_intersect', () => {
    expect(segIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toEqual([0.5, 0.5]);
    expect(segIntersect([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
    expect(segIntersect([0, 0], [1, 0], [2, -1], [2, 1])).toBeNull();
    expect(segIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBeNull();   // collinear
  });

  it('dedupe_points', () => {
    const pts = [{ along: 10, x: 0, y: 0 }, { along: 10.5, x: 30, y: 0 }, { along: 900, x: 900, y: 0 }];
    expect(dedupePoints(pts, 100)).toHaveLength(2);
    expect(dedupePoints([{ along: 0, x: 0, y: 0 }, { along: 100, x: 100, y: 0 }], 100)).toHaveLength(2);   // strict <
  });

  // two straight one-degree legs east along 40N (as test_route_crossings.py ROUTE)
  const ROUTE = [albersForward(-112, 40), albersForward(-111, 40), albersForward(-110, 40)];
  const U = Math.hypot(ROUTE[1][0] - ROUTE[0][0], ROUTE[1][1] - ROUTE[0][1]);
  const xy = (pts: XY[]): XY[][] => [pts.map(([lng, lat]) => albersForward(lng, lat))];
  const llNs = (lng: number) => xy([[lng, 39.9], [lng, 40.1]]);

  it('line_hits: a crossing at half a leg; a parallel line 600 m off is none', () => {
    const cross = rawIntersections(ROUTE, llNs(-111.5));
    expect(cross).toHaveLength(1);
    expect(Math.abs(cross[0].along - 0.5 * U)).toBeLessThan(0.01 * U);
    const [[ax, ay], [bx, by]] = ROUTE, L = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / L, ny = (bx - ax) / L;
    const beside: XY[][] = [[0.3, 0.6].map((f) => [ax + nx * 600 + (bx - ax) * f, ay + ny * 600 + (by - ay) * f] as XY)];
    expect(rawIntersections(ROUTE, beside)).toEqual([]);
  });

  it('analyse: one crossing per named group, one per kind', () => {
    const r = run(ROUTE, [
      feat('pipeline', llNs(-111.6), { src: 'hifld', name: 'Big Gas', group: 'Big Gas' }),
      feat('road', llNs(-111.5), { group: 'Main St (US 1)' }),
      feat('road', llNs(-111.5), { group: 'Main St (US 1)' }),   // same point from a second row
      feat('road', llNs(-111.4)),
      feat('river', llNs(-111.9), { group: 'Test River' }),
      feat('rail', llNs(-111.1), { group: 'UP' }),
      line(345, llNs(-111.2)),
    ]);
    expect(r.counts).toEqual({ river: 1, road: 2, rail: 1, pipeline: 1, line230: 1, line100: 0 });
  });
});

describe('merging within a group', () => {
  it('divided road, two ways 30 m apart, one group → 1', () => {
    expect(run(EAST, [feat('road', ns(5000), { group: 'I-80' }), feat('road', ns(5030), { group: 'I-80' })]).counts.road).toBe(1);
  });
  it('per-family radius: same-name road ways 250 m apart → 1, 350 m apart → 2; a river 250 m apart → 2', () => {
    expect(MERGE_M).toEqual({ road: 300, rail: 300, river: 100, pipeline: 100, line: 100 });
    const two = (family: ExactFeature['family'], d: number) =>
      run(EAST, [feat(family, ns(5000), { group: 'G' }), feat(family, ns(5000 + d), { group: 'G' })]).counts[family as 'road'];
    expect([two('road', 250), two('road', 350), two('rail', 250), two('river', 250)]).toEqual([1, 2, 1, 2]);
  });
  it('two unnamed roads 50 m apart → 2', () => {
    expect(run(EAST, [feat('road', ns(5000)), feat('road', ns(5050))]).counts.road).toBe(2);
  });
  it('river meander crossed 3× → 3', () => {
    const m: XY[][] = [[[3000, -500], [3000, 500], [3500, 500], [3500, -500], [4000, -500], [4000, 500]]];
    expect(run(EAST, [feat('river', m, { group: 'Big River' })]).counts.river).toBe(3);
  });
  it('four parallel rail ways of one owner → 1', () => {
    expect(run(EAST, [0, 20, 40, 60].map((d) => feat('rail', ns(3000 + d), { group: 'UP' }))).counts.rail).toBe(1);
  });
  it('a crossing exactly at a route vertex → 1', () => {
    const route: XY[] = [[0, 0], [5000, 0], [10000, 1000]];
    expect(rawIntersections(route, ns(5000))).toHaveLength(2);
    const r = run(route, [feat('road', ns(5000)), line(345, ns(5000))]);
    expect([r.counts.road, r.counts.line230]).toEqual([1, 1]);
  });
  it('MultiLineString: each part crosses', () => {
    const r = run(EAST, [feat('road', [...ns(4000), ...ns(9000), [[0, 50000], [100, 50000]]], { group: 'X', name: 'X Rd' })]);
    expect(r.points.map((p) => [p.kind, p.lngLat[0], p.name])).toEqual([['road', 4000, 'X Rd'], ['road', 9000, 'X Rd']]);
  });
});

describe('duplicate sources', () => {
  it('OSM 345 kV + HIFLD copy 120 m off → 1, dupDropped 1', () => {
    const r = run(EAST, [line(345, ns(8000)), line(345, ns(8120), { src: 'hifld' })]);
    expect([r.counts.line230, r.dupDropped]).toEqual([1, 1]);
  });
  it('HIFLD 220 kV copy of an OSM 230 kV line → 1 in all (family across classes)', () => {
    const r = run(EAST, [line(230, ns(8000)), line(220, ns(8100), { src: 'hifld' })]);
    expect([r.counts.line230, r.counts.line100, r.dupDropped]).toEqual([1, 0, 1]);
  });
  it('pipelines: OSM + HIFLD 80 m off → 1; a HIFLD line far from any OSM line stays', () => {
    const r = run(EAST, [feat('pipeline', ns(5000)), feat('pipeline', ns(5080), { src: 'hifld' }), line(345, ns(12000), { src: 'hifld' })]);
    expect([r.counts.pipeline, r.counts.line230, r.dupDropped]).toEqual([1, 1, 1]);
  });
  it('pipelines: a HIFLD copy 400 m from the OSM crossing is dropped, 700 m kept', () => {
    const at = (d: number) => run(EAST, [feat('pipeline', ns(5000)), feat('pipeline', ns(5000 + d), { src: 'hifld' })]);
    expect([at(400).counts.pipeline, at(400).dupDropped]).toEqual([1, 1]);
    expect([at(700).counts.pipeline, at(700).dupDropped]).toEqual([2, 0]);
  });
  it('an HIFLD copy of an OSM crossing the endpoint rule drops is dropped too', () => {
    expect(DUP_M).toEqual({ line: 300, pipeline: 500 });
    const r = run(EAST, [line(345, ns(290)), line(345, ns(310), { src: 'hifld' })]);
    expect([r.counts.line230, r.dupDropped]).toEqual([0, 1]);
  });
});

describe('lines: chaining, following, endpoints', () => {
  const ways115 = (xs: number[], o: Partial<ExactFeature> = {}) =>
    xs.slice(1).map((x, i) => line(115, [[[xs[i], 0], [x, 0]]], o));
  // perpendicular approach, a zig-zag ±60 m across y = 0, perpendicular exit
  const zig = (x0: number, x1: number, crossings: number): XY[] => {
    const pts: XY[] = [[x0, -3000]];
    for (let i = 0; i <= crossings; i++) pts.push([x0 + ((x1 - x0) * i) / crossings, i % 2 ? 60 : -60]);
    pts.push([x1, crossings % 2 ? 3000 : -3000]);
    return pts;
  };

  it('115 kV paralleled 5 km as four 1.25 km ways, route zig-zags across 6× → 0', () => {
    const r = run(zig(10200, 14400, 6), ways115([10000, 11250, 12500, 13750, 15000]));
    expect(r.counts.line100).toBe(0);
  });
  it('the same followed chain crossed 5× nets 1, the middle crossing', () => {
    const r = run(zig(10200, 14400, 5), ways115([10000, 11250, 12500, 13750, 15000]));
    expect(r.counts.line100).toBe(1);
    expect(r.points[0].lngLat[0]).toBeCloseTo(10200 + 4200 * 2.5 / 5, 0);
  });
  it('a single 5° crossing of a long line → 1 (near it ~5.7 km)', () => {
    const a = (5 * Math.PI) / 180, d = 15000;
    const r = run([[0, 0], [30000, 0]], [line(345, [[[15000 - d * Math.cos(a), -d * Math.sin(a)], [15000 + d * Math.cos(a), d * Math.sin(a)]]])]);
    expect(r.counts.line230).toBe(1);
  });
  it('HIFLD features sharing endpoints are not chained: each piece crossed once while followed counts', () => {
    const xs = [10000, 11250, 12500, 13750, 15000];
    expect(run(zig(10000, 15000, 4), ways115(xs)).counts.line100).toBe(0);
    expect(run(zig(10000, 15000, 4), ways115(xs, { src: 'hifld' })).counts.line100).toBe(4);
  });
  it('a route weaving through two parallel 345 kV lines 200 m apart nets each line mod 2', () => {
    const pair = (y: number) => line(345, [[[8000, y], [17000, y]]]);
    const weave = (n: number): XY[] => {
      const pts: XY[] = [[10000, -3000]];
      for (let i = 0; i <= n; i++) pts.push([10000 + (5000 * i) / n, i % 2 ? 300 : -100]);
      pts.push([15000, n % 2 ? 3000 : -3000]);
      return pts;
    };
    expect(run(weave(6), [pair(0), pair(200)]).counts.line230).toBe(0);
    expect(run(weave(5), [pair(0), pair(200)]).counts.line230).toBe(2);
  });
  it('three OSM ways meeting at one point are three lines: following one keeps the others\' crossings', () => {
    const J: XY = [8000, 2000];
    const r = run(EAST, [
      line(115, [[J, [8000, 100], [14000, 100]]]),   // followed 6 km, never crosses
      line(115, [[J, [9000, -2000]]]),               // crosses at 8,500
      line(115, [[J, [10000, -2000]]]),              // crosses at 9,000
    ]);
    expect(r.points.map((p) => [p.kind, Math.round(p.lngLat[0])])).toEqual([['line100', 8500], ['line100', 9000]]);
  });
  it('the same ways unchained (endpoints 5 m apart) are separate lines inside one followed stretch', () => {
    const ws = [10000, 11250, 12500, 13750].map((x) => line(115, [[[x + 5, 0], [x + 1250, 0]]]));
    expect(run(zig(10000, 15000, 4), ws).counts.line100).toBe(4);
  });
  it('a 230 kV line crossed perpendicular during that stretch → 1', () => {
    const r = run(zig(10200, 14400, 6), [...ways115([10000, 11250, 12500, 13750, 15000]), line(345, ns(12000, -2000, 2000))]);
    expect([r.counts.line230, r.counts.line100]).toEqual([1, 0]);
  });
  it('~1.5 km near a 115 kV line → its crossings count; name from the first named way', () => {
    const ws = [line(115, [[[10000, 0], [10750, 0]]]), line(115, [[[10750, 0], [11500, 0]]], { name: 'Ckt 7', detail: '115 kV' })];
    const r = run(zig(10200, 11200, 3), ws);
    expect(r.counts.line100).toBe(3);
    expect(r.points.every((p) => p.name === 'Ckt 7' && p.detail === '115 kV')).toBe(true);
  });
  it('a line crossing 150 m from the route start → 0 (a road there counts)', () => {
    const r = run([[0, 0], [10000, 0]], [line(345, ns(150)), line(115, ns(9850)), feat('road', ns(150)), line(345, ns(500))]);
    expect([r.counts.line230, r.counts.line100, r.counts.road]).toEqual([1, 0, 1]);
  });
  it('kV below 100 or unknown is not a line crossing', () => {
    expect(run(EAST, [line(69, ns(5000)), feat('line', ns(6000))]).points).toEqual([]);
  });
});

describe('result shape', () => {
  it('mi scaled to lengthsMi; lngLat = toLngLat(x, y) in x, y order', () => {
    const r = exactCrossings([[[0, 0], [16093.44, 0]], [[0, 0], [0, 10000]]],
      [feat('road', ns(8046.72)), feat('river', [[[-500, 4000], [500, 4000]]])],
      { toLngLat: (x, y) => [x + 1, y + 2], lengthsMi: [20, 5] });
    expect(r[0].points).toHaveLength(1);
    expect(r[0].points[0].mi).toBeCloseTo(10, 9);
    expect(r[0].points[0].lngLat).toEqual([8047.72, 2]);
    expect(r[1].points.map((p) => [p.kind, p.lngLat, p.mi])).toEqual([['river', [1, 4002], 2]]);
  });
  it('points sorted by mi across kinds', () => {
    const r = run(EAST, [feat('road', ns(9000)), feat('river', ns(2000)), line(345, ns(15000)), feat('rail', ns(4000)), feat('pipeline', ns(1000))]);
    expect(r.points.map((p) => p.kind)).toEqual(['pipeline', 'river', 'rail', 'road', 'line230']);
  });
  it('perf: 20k short ways vs a 1,000-vertex route in well under 2 s', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const fams: ExactFeature['family'][] = ['road', 'river', 'rail', 'pipeline', 'line'];
    const features: ExactFeature[] = [];
    for (let i = 0; i < 20000; i++) {
      let x = rnd() * 500000, y = rnd() * 500000;
      const pts: XY[] = [[x, y]];
      for (let j = 0; j < 4; j++) pts.push([x += (rnd() - 0.5) * 1000, y += (rnd() - 0.5) * 1000]);
      const family = fams[i % 5];
      features.push(feat(family, [pts], family === 'line' ? { kv: rnd() < 0.5 ? 115 : 345, src: rnd() < 0.3 ? 'hifld' : 'osm' } : {}));
    }
    const route: XY[] = [];
    let y = 250000;
    for (let i = 0; i < 1000; i++) route.push([i * 500, (y += (rnd() - 0.5) * 400)]);
    const t0 = performance.now();
    const [r] = exactCrossings([route, route.slice(100), route.slice(200), route.slice(300)], features,
      { toLngLat: ident, lengthsMi: [300, 250, 200, 150] });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.points.length).toBeGreaterThan(0);
  });
});
