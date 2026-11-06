/**
 * Route-optimizer grid: the 250 m EPSG:5070 (NAD83 / Conus Albers) grid and the
 * lng/lat <-> metres projection that places points on it.
 *
 * Role: pure arithmetic, no map or DOM. Mirrors scripts/route_grid.py, the source of truth
 * for GRID_250 and the cell/xy conventions (cell (0,0) is the top-left cell; xyOf is the cell
 * centre). Projection: Snyder's ellipsoidal Albers equal-area conic (USGS PP 1395, eqs.
 * 14-1..14-21) on GRS80. NAD83 is treated as WGS84 (no datum shift; the two differ by
 * about a metre, far below the cell size).
 * Dependencies: none.
 */

export interface Grid {
  crs: string;
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  super: number;
  block: number;
}

export const GRID_250: Grid = {
  crs: 'EPSG:5070',
  x0: -2493045,
  y0: 3310005,
  cell: 250,
  cols: 19343,
  rows: 12531,
  super: 4096,
  block: 512,
};

/** Reads the keys of route_grid.grid_json() (the assembler's grid.json). */
export function gridFromJson(json: {
  crs: string;
  origin: [number, number];
  cell: number;
  cols: number;
  rows: number;
  super: number;
  block: number;
}): Grid {
  return {
    crs: json.crs,
    x0: json.origin[0],
    y0: json.origin[1],
    cell: json.cell,
    cols: json.cols,
    rows: json.rows,
    super: json.super,
    block: json.block,
  };
}

/** (col, row) of the cell containing (x, y); may lie outside the grid. */
export function cellOf(grid: Grid, x: number, y: number): [number, number] {
  return [Math.floor((x - grid.x0) / grid.cell), Math.floor((grid.y0 - y) / grid.cell)];
}

/** (x, y) of a cell's centre. */
export function xyOf(grid: Grid, col: number, row: number): [number, number] {
  return [grid.x0 + (col + 0.5) * grid.cell, grid.y0 - (row + 0.5) * grid.cell];
}

export function cellOfLngLat(grid: Grid, lng: number, lat: number): [number, number] {
  const [x, y] = albersForward(lng, lat);
  return cellOf(grid, x, y);
}

export function lngLatOf(grid: Grid, col: number, row: number): [number, number] {
  const [x, y] = xyOf(grid, col, row);
  return albersInverse(x, y);
}

// ---- EPSG:5070 ----

const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const LAT0 = 23;
const LON0 = -96;
const PHI1 = 29.5;
const PHI2 = 45.5;
const RAD = Math.PI / 180;

const mOf = (phi: number): number => {
  const s = Math.sin(phi);
  return Math.cos(phi) / Math.sqrt(1 - E2 * s * s);
};
const qOf = (phi: number): number => {
  const s = Math.sin(phi);
  return (
    (1 - E2) * (s / (1 - E2 * s * s) - Math.log((1 - E * s) / (1 + E * s)) / (2 * E))
  );
};

const M1 = mOf(PHI1 * RAD);
const M2 = mOf(PHI2 * RAD);
const Q1 = qOf(PHI1 * RAD);
const Q2 = qOf(PHI2 * RAD);
const N = (M1 * M1 - M2 * M2) / (Q2 - Q1);
const C = M1 * M1 + N * Q1;
const RHO0 = (A * Math.sqrt(C - N * qOf(LAT0 * RAD))) / N;

/** Albers radius from the cone apex; depends on latitude only. */
export function albersRho(lat: number): number {
  return (A * Math.sqrt(C - N * qOf(lat * RAD))) / N;
}

/** Albers cone angle; depends on longitude only. x = rho sin(theta), y = ALBERS_RHO0 - rho cos(theta). */
export function albersTheta(lng: number): number {
  return N * (lng - LON0) * RAD;
}

export const ALBERS_RHO0 = RHO0;

export function albersForward(lng: number, lat: number): [number, number] {
  const rho = albersRho(lat);
  const theta = albersTheta(lng);
  return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)];
}

export function albersInverse(x: number, y: number): [number, number] {
  const dy = RHO0 - y;
  const rho = Math.hypot(x, dy);
  const q = (C - ((rho * N) / A) ** 2) / N;
  const lng = LON0 + Math.atan2(x, dy) / N / RAD;
  let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(phi);
    const w = 1 - E2 * s * s;
    const d =
      ((w * w) / (2 * Math.cos(phi))) *
      (q / (1 - E2) - s / w + Math.log((1 - E * s) / (1 + E * s)) / (2 * E));
    phi += d;
    if (Math.abs(d) < 1e-14) break;
  }
  return [lng, phi / RAD];
}
