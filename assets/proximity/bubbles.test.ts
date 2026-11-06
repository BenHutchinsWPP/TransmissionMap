import { describe, it, expect } from 'vitest';
import { bubblePx, bubbleRadiusExpr, bubbleMaxZoom, mercScale, proxFeatures, PALETTE_SIZE, MAX_BUBBLE_PX } from './bubbles.js';
import { haversineKm } from '../templates/nearest.js';

// Two points x km apart along a parallel, projected to Web Mercator pixels at zoom z.
function mercatorGapPx(lat: number, km: number, z: number): number {
  let lo = 0, hi = 10;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (haversineKm([0, lat], [m, lat]) < km) lo = m; else hi = m; }
  return lo / 360 * 512 * 2 ** z;
}

describe('bubblePx', () => {
  it('two bubbles of half the threshold touch where two points a threshold apart are drawn', () => {
    for (const lat of [0, 40, 65]) for (const km of [0.5, 1.609, 25]) {
      const gap = mercatorGapPx(lat, km, 10);
      expect(Math.abs(2 * bubblePx(km, mercScale(lat), 10) - gap) / gap).toBeLessThan(0.005);
    }
  });
  it('the radius expression doubles per zoom and reads s', () => {
    const e = bubbleRadiusExpr(10) as [string, unknown, unknown, number, [string, number, unknown], number, [string, number, unknown]];
    expect(e[3]).toBe(0); expect(e[5]).toBe(24);
    expect(e[4][1]).toBeCloseTo(bubblePx(10, 1, 0), 12);
    expect(e[6][1] / e[4][1]).toBe(2 ** 24);
    expect(e[4][2]).toEqual(['get', 's']);
  });
  it('bubbles stop at the zoom where the largest reaches the buffer', () => {
    const z = bubbleMaxZoom(1.609, mercScale(60));
    expect(bubblePx(1.609, mercScale(60), z)).toBeCloseTo(MAX_BUBBLE_PX, 6);
    expect(bubbleMaxZoom(1e-9, 1)).toBe(24);
    expect(bubbleMaxZoom(1e9, 1)).toBe(0);
  });
});

describe('proxFeatures', () => {
  it('emits only grouped points with their scale', () => {
    const f = proxFeatures([0, 1, 2, 3], [0, 0, 60, 0], [0, 1, 11, 0]);
    expect(f.points.features.map(x => x.properties!.i)).toEqual([1, 2]);
    expect(f.points.features[1].properties).toMatchObject({ i: 2, g: 11, c: 10 % PALETTE_SIZE });
    expect(f.points.features[1].properties!.s).toBeCloseTo(2, 12);
    expect(f.sMax).toBeCloseTo(2, 12);
  });
  it('clamps the scale at the poles', () => {
    expect(Number.isFinite(proxFeatures([0], [90], [1]).sMax)).toBe(true);
  });
});
