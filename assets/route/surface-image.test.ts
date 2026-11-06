import { describe, expect, it } from 'vitest';
import { ALBERS_RHO0, albersForward, albersRho, albersTheta, cellOfLngLat, GRID_250, lngLatOf } from './grid.js';
import { surfaceImage, windowBBox } from './surface-image.js';

const PALETTE = [
  [0, 0, 0, 0],
  [10, 0, 0, 255],
  [0, 20, 0, 255],
  [0, 0, 30, 255],
  [40, 40, 0, 255],
] as const;

describe('separable Albers', () => {
  it('equals albersForward within 1e-6 m on 1000 random points', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 1000; n++) {
      const lng = -125 + rnd() * 60;
      const lat = 24 + rnd() * 26;
      const rho = albersRho(lat);
      const t = albersTheta(lng);
      const [x, y] = albersForward(lng, lat);
      expect(Math.abs(rho * Math.sin(t) - x)).toBeLessThan(1e-6);
      expect(Math.abs(ALBERS_RHO0 - rho * Math.cos(t) - y)).toBeLessThan(1e-6);
    }
  });
});

describe('surfaceImage', () => {
  const win = { col0: 9000, row0: 5000, cols: 300, rows: 200 };
  const classes = new Uint8Array(win.cols * win.rows);
  // three cells with distinct classes
  const marks: [number, number, number][] = [
    [20, 20, 1],
    [150, 100, 3],
    [280, 180, 4],
  ];
  for (const [c, r, v] of marks) classes[r * win.cols + c] = v;
  // fill a 5x5 block so the cell is a few pixels wide regardless of resampling
  const filled = new Uint8Array(classes.length);
  for (const [c, r, v] of marks)
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) filled[(r + dr) * win.cols + c + dc] = v;

  const img = surfaceImage(GRID_250, win, filled, PALETTE);
  const px = (lng: number, lat: number): [number, number] => {
    const [west, south, east, north] = windowBBox(GRID_250, win);
    const rad = Math.PI / 180;
    const my = (l: number): number => Math.log(Math.tan(Math.PI / 4 + (l * rad) / 2));
    const i = Math.floor(((lng - west) / (east - west)) * img.width);
    const j = Math.floor(((my(north) - my(lat)) / (my(north) - my(south))) * img.height);
    return [i, j];
  };

  it('puts known cells on the expected pixels', () => {
    for (const [c, r, v] of marks) {
      const [lng, lat] = lngLatOf(GRID_250, win.col0 + c, win.row0 + r);
      expect(cellOfLngLat(GRID_250, lng, lat)).toEqual([win.col0 + c, win.row0 + r]);
      const [i, j] = px(lng, lat);
      const o = (j * img.width + i) * 4;
      expect(Array.from(img.rgba.slice(o, o + 4))).toEqual([...PALETTE[v]]);
    }
  });

  it('leaves class 0 transparent', () => {
    const empty = surfaceImage(GRID_250, win, new Uint8Array(classes.length), PALETTE);
    expect(empty.rgba.every((b) => b === 0)).toBe(true);
  });

  it('keeps corners north-up and the bbox covering the window', () => {
    const [nw, ne, se, sw] = img.coordinates;
    expect(nw[1]).toBeGreaterThan(sw[1]);
    expect(ne[0]).toBeGreaterThan(nw[0]);
    expect(se).toEqual([ne[0], sw[1]]);
  });

  it('honours the size cap', () => {
    const big = { col0: 2000, row0: 1000, cols: 12000, rows: 9000 };
    const out = surfaceImage(GRID_250, big, new Uint8Array(big.cols * big.rows), PALETTE);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(4096);
    expect(out.rgba.length).toBe(out.width * out.height * 4);
    const small = surfaceImage(GRID_250, win, filled, PALETTE, 64);
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(64);
  });
});
