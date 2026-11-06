/**
 * Route-optimizer similar-cost surface display: a classified window of the EPSG:5070 grid
 * drawn as an RGBA image in Web Mercator, for a MapLibre `image` source.
 *
 * Role: pure arithmetic, no map or DOM, safe in a worker. Each output pixel (uniform in
 * mercator y, row 0 = north) maps to lng/lat, then to Albers through the separable form
 * x = rho(lat) sin(theta(lng)), y = RHO0 - rho(lat) cos(theta(lng)): rho is computed once per
 * row, sin/cos theta once per column. Lookup is nearest-neighbour. The lng/lat bbox comes
 * from the window boundary sampled every <= 64 cells (the north edge of a conic window can
 * peak in latitude between its corners). The long side is capped at MAX_SIDE pixels.
 * Dependencies: grid.ts.
 */

import { albersInverse, albersRho, albersTheta, ALBERS_RHO0, type Grid } from './grid.js';

export const MAX_SIDE = 4096;
const SAMPLE_STEP = 64;
const RAD = Math.PI / 180;
const R_MERC = 6378137;

/** Window of grid cells the class array covers; classes are row-major, cols x rows. */
export interface CellWindow {
  col0: number;
  row0: number;
  cols: number;
  rows: number;
}

/** RGBA per class index (0 is ignored: always transparent). */
export type Palette = ReadonlyArray<readonly [number, number, number, number]>;

export interface SurfaceImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** NW, NE, SE, SW as [lng, lat], the order MapLibre's image source takes. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/** lng/lat bbox of the window, from its boundary sampled every <= SAMPLE_STEP cells. */
export function windowBBox(grid: Grid, w: CellWindow): [number, number, number, number] {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  const take = (c: number, r: number): void => {
    const [lng, lat] = albersInverse(grid.x0 + c * grid.cell, grid.y0 - r * grid.cell);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  const nc = Math.ceil(w.cols / SAMPLE_STEP);
  const nr = Math.ceil(w.rows / SAMPLE_STEP);
  for (let i = 0; i <= nc; i++) {
    const c = w.col0 + Math.min(w.cols, i * SAMPLE_STEP);
    take(c, w.row0);
    take(c, w.row0 + w.rows);
  }
  for (let i = 0; i <= nr; i++) {
    const r = w.row0 + Math.min(w.rows, i * SAMPLE_STEP);
    take(w.col0, r);
    take(w.col0 + w.cols, r);
  }
  return [west, south, east, north];
}

export function surfaceImage(
  grid: Grid,
  win: CellWindow,
  classes: Uint8Array,
  palette: Palette,
  maxSide: number = MAX_SIDE,
): SurfaceImage {
  const [west, south, east, north] = windowBBox(grid, win);
  const xW = west * RAD * R_MERC;
  const xE = east * RAD * R_MERC;
  const yS = mercY(south) * R_MERC;
  const yN = mercY(north) * R_MERC;
  // about one pixel per cell on the ground at the window's mid latitude
  const px = grid.cell / Math.cos(((south + north) / 2) * RAD);
  const wantW = (xE - xW) / px;
  const wantH = (yN - yS) / px;
  const k = Math.min(1, maxSide / Math.max(wantW, wantH));
  const width = Math.max(1, Math.round(wantW * k));
  const height = Math.max(1, Math.round(wantH * k));

  const sinT = new Float64Array(width);
  const cosT = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    const lng = west + ((i + 0.5) / width) * (east - west);
    const t = albersTheta(lng);
    sinT[i] = Math.sin(t);
    cosT[i] = Math.cos(t);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const my = yN - ((j + 0.5) / height) * (yN - yS);
    const lat = (2 * Math.atan(Math.exp(my / R_MERC)) - Math.PI / 2) / RAD;
    const rho = albersRho(lat);
    for (let i = 0; i < width; i++) {
      const x = rho * sinT[i];
      const y = ALBERS_RHO0 - rho * cosT[i];
      const c = Math.floor((x - grid.x0) / grid.cell) - win.col0;
      const r = Math.floor((grid.y0 - y) / grid.cell) - win.row0;
      if (c < 0 || r < 0 || c >= win.cols || r >= win.rows) continue;
      const cls = classes[r * win.cols + c];
      const p = cls > 0 ? palette[cls] : undefined;
      if (!p) continue;
      rgba.set(p, (j * width + i) * 4);
    }
  }
  return {
    rgba,
    width,
    height,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}
