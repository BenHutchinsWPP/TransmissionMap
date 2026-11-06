// per-region.ts: the outline snap (grid, repeats and straight-run midpoints
// dropped, tiny rings gone) and the class helpers on an empty result.
import { describe, it, expect } from 'vitest';
import { snapRing, rampColours, classBreaks, classLabels, regionCentre } from './per-region.js';

describe('snapRing', () => {
  it('snaps to the grid and drops repeats and the middle of straight runs', () => {
    const ring = [[0, 0], [0.004, 0.001], [1, 0], [2, 0.003], [3, 0], [3, 1], [3, 2], [0, 2], [0, 1], [0, 0]];
    expect(snapRing(ring, 0.01)).toEqual([[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]);
  });

  it('keeps a staircase corner, closes an open ring and drops a ring under 4 points', () => {
    expect(snapRing([[0, 0], [0.1, 0], [0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0, 0.2]], 0.05)).toEqual(
      [[0, 0], [0.1, 0], [0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0, 0.2], [0, 0]]);
    expect(snapRing([[0, 0], [0.01, 0.01], [0.02, 0], [0, 0]], 0.05)).toBeNull();
  });

  it('a back-track along a line does not leave a repeated point', () => {
    const out = snapRing([[0, 0], [2, 0], [1, 0], [1, 1], [0, 1], [0, 0]], 1)!;
    for (let i = 1; i < out.length; i++) expect(out[i]).not.toEqual(out[i - 1]);
  });
});

describe('classes on no values', () => {
  it('no breaks, no colours, no labels (no "undefined" legend row)', () => {
    const breaks = classBreaks([]);
    expect(breaks).toEqual([]);
    expect(rampColours(breaks.length)).toEqual([]);
    expect(classLabels(breaks, 0, true)).toEqual([]);
    expect(rampColours(1)).toHaveLength(1);
  });
});

describe('regionCentre', () => {
  const sq = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  it('is the centroid of a polygon, from either winding', () => {
    expect(regionCentre({ type: 'Polygon', coordinates: [sq(0, 0, 4, 2)] })).toEqual([2, 1]);
    expect(regionCentre({ type: 'Polygon', coordinates: [sq(0, 0, 4, 2).reverse()] })).toEqual([2, 1]);
  });
  it('sits in the largest polygon of a multipolygon, not between the parts', () => {
    expect(regionCentre({ type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(100, 10, 6, 4)]] })).toEqual([103, 12]);
  });
  it('is the middle of the box for a ring with no area, and null for no polygon', () => {
    expect(regionCentre({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [2, 0], [0, 0]]] })).toEqual([2, 0]);
    expect(regionCentre({ type: 'Point', coordinates: [1, 1] })).toBeNull();
    expect(regionCentre(null)).toBeNull();
  });
});
