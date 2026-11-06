// ─── Uploaded layer: a visitor's polygon file as a route-method row's band ───
// Role: the trust boundary and the rasteriser for an uploaded layer.
//       `validateUpload` takes a GeoJSON file (≤ 10 MiB; Polygon / MultiPolygon only,
//       as a geometry, a Feature or a FeatureCollection) and `uploadLayer` its normalised
//       geometry (MultiPolygon coordinates, [lng, lat] — what the pane posts to the worker):
//       ≤ 5,000 parts, ≤ 250,000 positions, every ring closed with ≥ 4 finite positions in
//       range, the bbox meeting the grid. Refusals are Outcomes, never throws. `hash` is the
//       16-hex sha256 prefix of the normalised geometry's JSON (the `add_rows` key).
//       Cells follow the cube's rule (rasterio all_touched=False, as build_route_bands.py):
//       a cell is in when its centre is inside, even-odd per polygon part (holes and
//       self-intersections fall out of it), union across parts and features; vertices go
//       through albersForward (no densification). Exact ties follow GDAL's scanline: each
//       ring turned clockwise on the map (OGR's isClockwise), y half-open [top, bottom),
//       x (left, right], a horizontal edge on a centre line burned when it runs leftward in
//       pixel space. `rasterize` fills a cell window; `insideCell` answers one cell (layer
//       bbox, part bbox, then a per-part row-bucket edge index) and agrees with `rasterize`
//       on every cell. Checked against rasterio by upload-layer.test.ts with
//       fixtures/upload-ref.json (fixtures/make-upload-ref.py). Pure: no DOM, no I/O.
// Deps: grid.ts (albersForward, GRID_250), dataset-query.ts (Outcome, type only),
//       surface-image.ts (CellWindow, type only); WebCrypto `crypto.subtle` for the hash.

import type { Outcome } from '../dataset-query.js';
import { albersForward, GRID_250, type Grid } from './grid.js';
import type { CellWindow } from './surface-image.js';

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_PARTS = 5000;
export const UPLOAD_MAX_VERTICES = 250_000;

/** MultiPolygon coordinates, [lng, lat]. */
export type UploadGeometry = number[][][][];

/** One polygon part in pixel space (u = (x - x0) / cell, v = (y0 - y) / cell). */
interface Part {
  bbox: [number, number, number, number];
  /** Non-horizontal edges, (x1, y1) the end with the smaller v. */
  x1: Float64Array; y1: Float64Array; x2: Float64Array; y2: Float64Array;
  /** First and last row whose centre line each edge crosses (y1 ≤ r + 0.5 < y2). */
  lo: Int32Array; hi: Int32Array;
  /** Row buckets: rows r0 + b * span … r0 + (b + 1) * span - 1 → edges starts[b] … starts[b + 1] - 1 of items. */
  r0: number; span: number; starts: Int32Array; items: Int32Array;
  /** Row → [left, right, …] of the leftward horizontal edges lying on that row's centre line. */
  flat: Map<number, number[]>;
}

export interface UploadLayer {
  hash: string;
  geometry: UploadGeometry;
  grid: Grid;
  parts: Part[];
  /** Pixel-space [umin, vmin, umax, vmax] over every part. */
  bbox: [number, number, number, number];
}

type Result<T> = Outcome<T>;
const err = (reason: string): Outcome<never> => ({ ok: false, reason: `uploaded layer: ${reason}` });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- trust boundary ----

/** A GeoJSON file's bytes (or text) → its uploaded layer. */
export async function validateUpload(file: Uint8Array | string, grid: Grid = GRID_250): Promise<Result<UploadLayer>> {
  let text: string;
  if (typeof file === 'string') {
    if (file.length > UPLOAD_MAX_BYTES || new TextEncoder().encode(file).length > UPLOAD_MAX_BYTES) return err('the file is over 10 MiB');
    text = file;
  } else {
    if (file.byteLength > UPLOAD_MAX_BYTES) return err('the file is over 10 MiB');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file); } catch { return err('the file is not UTF-8 text'); }
  }
  let json: unknown;
  try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return err('the file is not GeoJSON (JSON did not parse)'); }
  const polys = polygonsOf(json);
  if (!polys.ok) return polys;
  return uploadLayer(polys.result, grid);
}

function polygonsOf(json: unknown): Result<unknown[]> {
  const out: unknown[] = [];
  const geom = (g: unknown): string | null => {
    if (!isObj(g)) return 'a feature has no geometry';
    if (g.type === 'Polygon') { out.push(g.coordinates); return null; }
    if (g.type === 'MultiPolygon') {
      if (!Array.isArray(g.coordinates)) return 'a MultiPolygon has no coordinates';
      if (out.length + g.coordinates.length > UPLOAD_MAX_PARTS) return `more than ${UPLOAD_MAX_PARTS} polygon parts`;
      out.push(...g.coordinates);
      return null;
    }
    return `only Polygon and MultiPolygon geometries are taken (found ${typeof g.type === 'string' ? g.type.slice(0, 40) : 'none'})`;
  };
  if (!isObj(json)) return err('the file is not a GeoJSON object');
  let bad: string | null;
  if (json.type === 'FeatureCollection') {
    if (!Array.isArray(json.features)) return err('the FeatureCollection has no features');
    bad = null;
    for (const f of json.features) {
      if (out.length >= UPLOAD_MAX_PARTS && f) { bad = `more than ${UPLOAD_MAX_PARTS} polygon parts`; break; }
      bad = isObj(f) && f.type === 'Feature' ? geom(f.geometry) : 'a FeatureCollection member is not a Feature';
      if (bad) break;
    }
  } else if (json.type === 'Feature') bad = geom(json.geometry);
  else bad = geom(json);
  if (bad) return err(bad);
  if (!out.length) return err('the file has no polygons');
  return { ok: true, result: out };
}

/** Normalised geometry (MultiPolygon coordinates, [lng, lat]) → its uploaded layer. */
export async function uploadLayer(geometry: unknown, grid: Grid = GRID_250): Promise<Result<UploadLayer>> {
  if (!Array.isArray(geometry) || !geometry.length) return err('no polygons');
  if (geometry.length > UPLOAD_MAX_PARTS) return err(`more than ${UPLOAD_MAX_PARTS} polygon parts`);
  const norm: UploadGeometry = [];
  let vertices = 0;
  for (const poly of geometry) {
    if (!Array.isArray(poly) || !poly.length) return err('a polygon has no rings');
    const rings: number[][][] = [];
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return err('a ring has fewer than 4 positions');
      vertices += ring.length;
      if (vertices > UPLOAD_MAX_VERTICES) return err(`more than ${UPLOAD_MAX_VERTICES} positions`);
      const r: number[][] = [];
      for (const p of ring) {
        if (!Array.isArray(p) || p.length < 2) return err('a position is not [lng, lat]');
        const [lng, lat] = p as unknown[];
        if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return err('a position is not two finite numbers');
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return err('a position is outside lng −180…180, lat −90…90');
        r.push([lng, lat]);
      }
      const a = r[0], z = r[r.length - 1];
      if (a[0] !== z[0] || a[1] !== z[1]) return err('a ring is not closed (first and last positions differ)');
      rings.push(r);
    }
    norm.push(rings);
  }
  const xy = norm.map(poly => poly.map(ring => ring.map(([lng, lat]) => albersForward(lng, lat))));
  const layer = layerFromProjected(xy, grid);
  const [u0, v0, u1, v1] = layer.bbox;
  if (!(u1 > 0 && u0 < grid.cols && v1 > 0 && v0 < grid.rows)) return err('the polygons lie outside the routing grid');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(norm)));
  layer.hash = [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  layer.geometry = norm;
  return { ok: true, result: layer };
}

// ---- index ----

/** OGR's isClockwise (lowest-rightmost pivot, area when the pivot repeats or is collinear); ring closed, y up. */
function isClockwise(r: number[][]): boolean {
  const n = r.length;
  let v = 0, fallback = false;
  for (let i = 1; i < n - 1; i++) {
    if (r[i][1] < r[v][1] || (r[i][1] === r[v][1] && r[i][0] > r[v][0])) { v = i; fallback = false; }
    else if (r[i][1] === r[v][1] && r[i][0] === r[v][0]) fallback = true;
  }
  if (!fallback) {
    const same = (i: number) => r[i][0] === r[v][0] && r[i][1] === r[v][1];
    let next = v + 1 >= n - 1 ? 0 : v + 1, prev = v === 0 ? n - 2 : v - 1;
    while (same(next) && next !== v) next = next + 1 >= n - 1 ? 0 : next + 1;
    while (same(prev) && prev !== v) prev = prev - 1 < 0 ? n - 2 : prev - 1;
    const dx0 = r[prev][0] - r[v][0], dy0 = r[prev][1] - r[v][1];
    const dx1 = r[next][0] - r[v][0], dy1 = r[next][1] - r[v][1];
    const cross = dx1 * dy0 - dx0 * dy1;
    if (cross > 0) return false;
    if (cross < 0) return true;
  }
  let area = 0;
  for (let i = 0; i < n - 1; i++) area += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return area < 0;
}

/** First integer k with k + 0.5 > a. */
function firstAbove(a: number): number {
  let k = Math.floor(a + 0.5);
  while (k + 0.5 <= a) k++;
  while (k - 0.5 > a) k--;
  return k;
}
/** Last integer k with k + 0.5 ≤ b. */
function lastAtMost(b: number): number {
  let k = Math.floor(b - 0.5);
  while (k + 1.5 <= b) k++;
  while (k + 0.5 > b) k--;
  return k;
}

function buildPart(rings: number[][][], grid: Grid): Part {
  const X1: number[] = [], Y1: number[] = [], X2: number[] = [], Y2: number[] = [];
  const flat = new Map<number, number[]>();
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring0 of rings) {
    const ring = isClockwise(ring0) ? ring0 : [...ring0].reverse();
    const u = ring.map(p => (p[0] - grid.x0) / grid.cell), v = ring.map(p => (grid.y0 - p[1]) / grid.cell);
    for (let i = 0; i < u.length; i++) {
      bbox[0] = Math.min(bbox[0], u[i]); bbox[1] = Math.min(bbox[1], v[i]);
      bbox[2] = Math.max(bbox[2], u[i]); bbox[3] = Math.max(bbox[3], v[i]);
      if (i === 0) continue;
      const pu = u[i - 1], pv = v[i - 1], cu = u[i], cv = v[i];
      if (pv === cv) {
        const row = Math.round(cv - 0.5);
        if (pu > cu && row + 0.5 === cv) {
          const spans = flat.get(row);
          if (spans) spans.push(cu, pu); else flat.set(row, [cu, pu]);
        }
      } else if (pv < cv) { X1.push(pu); Y1.push(pv); X2.push(cu); Y2.push(cv); }
      else { X1.push(cu); Y1.push(cv); X2.push(pu); Y2.push(pv); }
    }
  }
  const n = X1.length;
  const lo = new Int32Array(n), hi = new Int32Array(n);
  let rMin = Infinity, rMax = -Infinity;
  for (let e = 0; e < n; e++) {
    let l = Math.ceil(Y1[e] - 0.5); // smallest r with r + 0.5 ≥ y1
    while (l + 0.5 < Y1[e]) l++;
    while (l - 0.5 >= Y1[e]) l--;
    lo[e] = l;
    let h = Math.ceil(Y2[e] - 0.5) - 1; // largest r with r + 0.5 < y2
    while (h + 1.5 < Y2[e]) h++;
    while (h + 0.5 >= Y2[e]) h--;
    hi[e] = h;
    if (h >= lo[e]) { rMin = Math.min(rMin, lo[e]); rMax = Math.max(rMax, h); }
  }
  const part: Part = {
    bbox, x1: Float64Array.from(X1), y1: Float64Array.from(Y1), x2: Float64Array.from(X2), y2: Float64Array.from(Y2),
    lo, hi, r0: 0, span: 1, starts: new Int32Array(1), items: new Int32Array(0), flat,
  };
  if (rMax < rMin) return part;
  // Buckets: as fine as one row each, coarsened until the entries stay within 8 per edge.
  const rows = rMax - rMin + 1;
  let k = Math.min(rows, n), span: number, nb: number, total: number;
  for (;;) {
    span = Math.ceil(rows / k); nb = Math.ceil(rows / span); total = 0;
    for (let e = 0; e < n; e++) if (hi[e] >= lo[e]) total += Math.floor((hi[e] - rMin) / span) - Math.floor((lo[e] - rMin) / span) + 1;
    if (total <= 8 * n || k === 1) break;
    k = Math.ceil(k / 2);
  }
  const starts = new Int32Array(nb + 1), items = new Int32Array(total);
  for (let e = 0; e < n; e++) if (hi[e] >= lo[e]) for (let b = Math.floor((lo[e] - rMin) / span); b <= Math.floor((hi[e] - rMin) / span); b++) starts[b + 1]++;
  for (let b = 0; b < nb; b++) starts[b + 1] += starts[b];
  const fill = starts.slice(0, nb);
  for (let e = 0; e < n; e++) if (hi[e] >= lo[e]) for (let b = Math.floor((lo[e] - rMin) / span); b <= Math.floor((hi[e] - rMin) / span); b++) items[fill[b]++] = e;
  return Object.assign(part, { r0: rMin, span, starts, items });
}

/** The same layer from EPSG:5070 metres (no checks; `hash` and `geometry` left empty). */
export function layerFromProjected(xy: number[][][][], grid: Grid): UploadLayer {
  const parts = xy.map(rings => buildPart(rings, grid));
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    bbox[0] = Math.min(bbox[0], p.bbox[0]); bbox[1] = Math.min(bbox[1], p.bbox[1]);
    bbox[2] = Math.max(bbox[2], p.bbox[2]); bbox[3] = Math.max(bbox[3], p.bbox[3]);
  }
  return { hash: '', geometry: [], grid, parts, bbox };
}

// ---- cells ----

/** Crossings of row r's centre line by the part's non-horizontal edges, appended to out. */
function rowCrossings(p: Part, r: number, out: number[]): void {
  const b = Math.floor((r - p.r0) / p.span);
  if (b < 0 || b >= p.starts.length - 1) return;
  const dy = r + 0.5;
  for (let i = p.starts[b]; i < p.starts[b + 1]; i++) {
    const e = p.items[i];
    if (p.lo[e] <= r && r <= p.hi[e]) out.push((dy - p.y1[e]) * (p.x2[e] - p.x1[e]) / (p.y2[e] - p.y1[e]) + p.x1[e]);
  }
}

const centreIn = (bb: readonly number[], c: number, r: number) => c >= bb[0] && c <= bb[2] && r + 0.5 >= bb[1] && r + 0.5 <= bb[3];

/** Whether cell (col, row) of the layer's grid is in the layer. */
export function insideCell(layer: UploadLayer, col: number, row: number): boolean {
  const c = col + 0.5;
  if (!centreIn(layer.bbox, c, row)) return false;
  const xs: number[] = [];
  for (const p of layer.parts) {
    if (!centreIn(p.bbox, c, row)) continue;
    const spans = p.flat.get(row);
    if (spans) for (let i = 0; i < spans.length; i += 2) if (spans[i] < c && c <= spans[i + 1]) return true;
    xs.length = 0;
    rowCrossings(p, row, xs);
    let n = 0;
    for (const x of xs) if (x < c) n++;
    if (n % 2) return true;
  }
  return false;
}

/** The layer over a window of its grid: 1 in, 0 out, row-major cols x rows. */
export function rasterize(layer: UploadLayer, box: CellWindow): Uint8Array {
  const out = new Uint8Array(box.cols * box.rows);
  const xs: number[] = [];
  const span = (row: number, a: number, b: number) => {
    const c0 = Math.max(firstAbove(a), box.col0), c1 = Math.min(lastAtMost(b), box.col0 + box.cols - 1);
    if (c1 >= c0) out.fill(1, (row - box.row0) * box.cols + c0 - box.col0, (row - box.row0) * box.cols + c1 - box.col0 + 1);
  };
  for (const p of layer.parts) {
    const [u0, v0, u1, v1] = p.bbox;
    if (u1 < box.col0 + 0.5 || u0 > box.col0 + box.cols - 0.5) continue;
    const r0 = Math.max(box.row0, firstAbove(v0) - 1), r1 = Math.min(box.row0 + box.rows - 1, lastAtMost(v1) + 1);
    for (let row = r0; row <= r1; row++) {
      const spans = p.flat.get(row);
      if (spans) for (let i = 0; i < spans.length; i += 2) span(row, spans[i], spans[i + 1]);
      xs.length = 0;
      rowCrossings(p, row, xs);
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) span(row, xs[i], xs[i + 1]);
    }
  }
  return out;
}
