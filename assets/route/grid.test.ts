// Fixtures from pyproj (EPSG:4326 -> EPSG:5070) and scripts/route_grid.py cell_of / xy_of.
import { describe, it, expect } from 'vitest';
import {
  GRID_250,
  albersForward,
  albersInverse,
  cellOf,
  cellOfLngLat,
  gridFromJson,
  lngLatOf,
  xyOf,
} from './grid.js';

// name, lng, lat, x, y, col, row, cell-centre x, cell-centre y
const FIX: [string, number, number, number, number, number, number, number, number][] = [
  ['Key West', -81.78, 24.55, 1454967.8383431723, 277969.176510874, 15792, 12128, 1455080, 277880],
  ['Caribou ME', -68.0, 46.86, 2113089.655047175, 2965760.453763131, 18424, 1376, 2113080, 2965880],
  ['Seattle', -122.33, 47.6, -1968025.540274451, 3008409.076115718, 2100, 1206, -1967920, 3008380],
  ['San Diego', -117.16, 32.72, -1955810.8528680485, 1290695.7049621998, 2148, 8077, -1955920, 1290630],
  ['Rockies', -105.5, 39.5, -808168.3873295131, 1871376.2764574345, 6739, 5754, -808170, 1871380],
  ['lon0', -96, 37, 0, 1550756.1682043842, 9972, 7036, 80, 1550880],
  ['lat0 lon0', -96, 23, 0, 0, 9972, 13240, 80, -120],
  ['Houston', -95.37, 29.76, 60897.20413377439, 742950.6392229958, 10215, 10268, 60830, 742880],
];

describe('EPSG:5070 projection', () => {
  for (const [name, lng, lat, x, y] of FIX) {
    it(`forward ${name}`, () => {
      const [fx, fy] = albersForward(lng, lat);
      expect(Math.abs(fx - x)).toBeLessThan(0.01);
      expect(Math.abs(fy - y)).toBeLessThan(0.01);
    });
    it(`inverse and round trip ${name}`, () => {
      const [lo, la] = albersInverse(x, y);
      expect(Math.abs(lo - lng)).toBeLessThan(1e-8);
      expect(Math.abs(la - lat)).toBeLessThan(1e-8);
      const [rx, ry] = albersForward(lo, la);
      expect(Math.abs(rx - x)).toBeLessThan(0.01);
      expect(Math.abs(ry - y)).toBeLessThan(0.01);
    });
  }

  it('grid origin corner', () => {
    const [lo, la] = albersInverse(GRID_250.x0, GRID_250.y0);
    expect(Math.abs(lo - -130.2328280158085)).toBeLessThan(1e-8);
    expect(Math.abs(la - 48.70739591346951)).toBeLessThan(1e-8);
  });
});

describe('grid cell conventions', () => {
  for (const [name, lng, lat, x, y, col, row, cx, cy] of FIX) {
    it(`cell ${name}`, () => {
      expect(cellOf(GRID_250, x, y)).toEqual([col, row]);
      expect(cellOfLngLat(GRID_250, lng, lat)).toEqual([col, row]);
      expect(xyOf(GRID_250, col, row)).toEqual([cx, cy]);
    });
  }

  it('origin and far corner', () => {
    expect(cellOf(GRID_250, GRID_250.x0, GRID_250.y0)).toEqual([0, 0]);
    expect(xyOf(GRID_250, 0, 0)).toEqual([-2492920, 3309880]);
    const g = GRID_250;
    const x = g.x0 + g.cell * g.cols - 1;
    const y = g.y0 - g.cell * g.rows + 1;
    expect(cellOf(g, x, y)).toEqual([19342, 12530]);
  });

  it('lngLatOf is the centre inverse', () => {
    const [lo, la] = lngLatOf(GRID_250, 2100, 1206);
    const [x, y] = albersForward(lo, la);
    expect(x).toBeCloseTo(-1967920, 2);
    expect(y).toBeCloseTo(3008380, 2);
  });

  it('gridFromJson reads the assembler keys', () => {
    expect(
      gridFromJson({
        crs: 'EPSG:5070',
        origin: [-2493045, 3310005],
        cell: 250,
        cols: 19343,
        rows: 12531,
        super: 4096,
        block: 512,
      }),
    ).toEqual(GRID_250);
  });
});
