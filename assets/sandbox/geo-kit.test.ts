import { describe, it, expect } from 'vitest';
import {
  bbox, pointInRing, pointInPolygon, pointInGeometry, segmentIntersection, linePolygonCrossings,
  lineIntersectsGeometry, lineCrossingCount, haversineKm, lengthKm, ringAreaKm2, areaKm2, polygonsOf,
} from './geo-kit.js';

const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const donut = [sq(0, 0, 10, 10), sq(4, 4, 6, 6)];

describe('bbox', () => {
  it('covers every nesting', () => {
    expect(bbox({ type: 'Point', coordinates: [1, 2] })).toEqual([1, 2, 1, 2]);
    expect(bbox({ type: 'LineString', coordinates: [[0, 5], [-3, 2], [4, 9]] })).toEqual([-3, 2, 4, 9]);
    expect(bbox({ type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(5, 5, 6, 8)]] })).toEqual([0, 0, 6, 8]);
  });
  it('is null for empty or missing geometry', () => {
    expect(bbox({ type: 'LineString', coordinates: [] })).toBeNull();
    expect(bbox(null as never)).toBeNull();
  });
});

describe('point in polygon', () => {
  it('inside, outside', () => {
    expect(pointInRing([5, 5], sq(0, 0, 10, 10))).toBe(true);
    expect(pointInRing([11, 5], sq(0, 0, 10, 10))).toBe(false);
  });
  it('holes exclude', () => {
    expect(pointInPolygon([5, 5], donut)).toBe(false);
    expect(pointInPolygon([2, 2], donut)).toBe(true);
  });
  it('MultiPolygon: any member', () => {
    const g = { type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(5, 5, 6, 6)]] };
    expect(pointInGeometry([5.5, 5.5], g)).toBe(true);
    expect(pointInGeometry([3, 3], g)).toBe(false);
  });
  it('concave ring', () => {
    const c = [[0, 0], [10, 0], [10, 10], [5, 2], [0, 10], [0, 0]];
    expect(pointInRing([5, 8], c)).toBe(false);
    expect(pointInRing([2, 2], c)).toBe(true);
  });
  it('degenerate inputs are outside', () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(pointInRing([0, 0], [])).toBe(false);
    expect(pointInGeometry([0, 0], { type: 'Point', coordinates: [0, 0] })).toBe(false);
    expect(pointInGeometry([0, 0], null as never)).toBe(false);
  });
});

describe('segments and lines', () => {
  it('intersects at the crossing point', () => {
    expect(segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0])).toEqual([1, 1]);
  });
  it('misses parallel, collinear and apart', () => {
    expect(segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
    expect(segmentIntersection([0, 0], [1, 0], [2, 0], [3, 0])).toBeNull();
    expect(segmentIntersection([0, 0], [1, 1], [3, 0], [4, 0])).toBeNull();
  });
  it('touching at an endpoint counts', () => {
    expect(segmentIntersection([0, 0], [1, 1], [1, 1], [2, 0])).toEqual([1, 1]);
  });
  it('line across a donut crosses both rings', () => {
    const pts = linePolygonCrossings([[-1, 5], [11, 5]], donut);
    expect(pts.map(p => p[0]).sort((a, b) => a - b)).toEqual([0, 4, 6, 10]);
  });
  it('intersects: crossing, starting inside, apart', () => {
    const g = { type: 'Polygon', coordinates: [sq(0, 0, 10, 10)] };
    expect(lineIntersectsGeometry([[-5, 5], [5, 5]], g)).toBe(true);
    expect(lineIntersectsGeometry([[2, 2], [3, 3]], g)).toBe(true);
    expect(lineIntersectsGeometry([[20, 20], [30, 30]], g)).toBe(false);
    expect(lineIntersectsGeometry([], g)).toBe(false);
    expect(lineIntersectsGeometry([[0, 0], [1, 1]], { type: 'Point', coordinates: [0, 0] })).toBe(false);
  });
  it('counts boundary crossings across a MultiPolygon', () => {
    const g = { type: 'MultiPolygon', coordinates: [[sq(0, 0, 2, 2)], [sq(4, 0, 6, 2)]] };
    expect(lineCrossingCount([[-1, 1], [7, 1]], g)).toBe(4);
  });
  it('polygonsOf ignores other types', () => {
    expect(polygonsOf({ type: 'LineString', coordinates: [] })).toEqual([]);
  });
});

describe('length and area', () => {
  it('haversine: one degree of latitude ~ 111.2 km', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.195, 1);
    expect(haversineKm([10, 10], [10, 10])).toBe(0);
  });
  it('line and multiline lengths add up; other types are 0', () => {
    const one = lengthKm({ type: 'LineString', coordinates: [[0, 0], [0, 1], [0, 2]] });
    expect(one).toBeCloseTo(222.39, 1);
    expect(lengthKm({ type: 'MultiLineString', coordinates: [[[0, 0], [0, 1]], [[0, 0], [0, 1]]] })).toBeCloseTo(222.39, 1);
    expect(lengthKm({ type: 'LineString', coordinates: [[0, 0]] })).toBe(0);
    expect(lengthKm({ type: 'Point', coordinates: [0, 0] })).toBe(0);
  });
  it('area of a 1 degree square on the equator ~ 12,364 km²', () => {
    expect(ringAreaKm2(sq(0, 0, 1, 1))).toBeCloseTo(12364, -1);
  });
  it('area is orientation-free and subtracts holes', () => {
    const cw = sq(0, 0, 10, 10);
    const ccw = [...cw].reverse();
    expect(ringAreaKm2(ccw)).toBeCloseTo(ringAreaKm2(cw), 6);
    expect(areaKm2({ type: 'Polygon', coordinates: donut })).toBeCloseTo(ringAreaKm2(donut[0]) - ringAreaKm2(donut[1]), 6);
  });
  it('MultiPolygon area sums; non-polygons and empty rings are 0', () => {
    const one = areaKm2({ type: 'Polygon', coordinates: [sq(0, 0, 1, 1)] });
    expect(areaKm2({ type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(0, 0, 1, 1)]] })).toBeCloseTo(2 * one, 6);
    expect(areaKm2({ type: 'LineString', coordinates: [] })).toBe(0);
    expect(ringAreaKm2([])).toBe(0);
  });
});
