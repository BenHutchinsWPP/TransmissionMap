// ─── Nearest: each point's great-circle distance to the nearest target ──────
// Role: the page half of the `nearest` template (show-template.ts): for every
//       point of the card's layer, the nearest feature of its second layer and
//       the haversine distance to it, exact (the same answer as a brute-force
//       scan, which the tests hold it to), over a grid index of the targets.
//         haversineKm(a, b)        great-circle km between two [lon, lat]
//         nearest(points, targets) → {km, to}: per point its distance (NaN
//                    when there is no target or the point is not a finite
//                    [lon, lat]) and its target's index (-1 then). Targets
//                    are bucketed into square cells of `cellDeg` degrees
//                    (sized from their density, ≥ 0.15° so the dense cell
//                    table stays ≤ 3 M cells); each point searches rings of
//                    cells outward and stops once no unsearched cell can hold
//                    a nearer target (a lower bound from the ring's latitude
//                    and longitude gap, the longitude one shrunk by the
//                    cosine of the highest latitude the ring reaches), with
//                    longitude wrapping at ±180°. A point whose rings would
//                    wrap the globe or pass MAX_RING (far from every
//                    target: a world layer measured to one country's)
//                    scans 5° coarse cells instead, nearest bound first,
//                    until a cell's bound passes its best.
//       Pure: no DOM, no map.
//
// Deps: sandbox/geo-kit.ts (haversineKm). Used by show-template.ts (nearest payload), proximity/methods/common.ts (EARTH_KM), nearest.test.ts.

import { haversineKm } from '../sandbox/geo-kit.js';

export type LonLat = readonly [number, number];
export const EARTH_KM = 6371.0088;
/** Beyond this many rings a point scans the coarse cells instead (still exact). */
export const MAX_RING = 24;
/** The coarse cells' side, in degrees. */
const COARSE_DEG = 5;
const RAD = Math.PI / 180;

export { haversineKm };

/** haversineKm for four loose numbers (no array per call). */
function distKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const sa = Math.sin(dLat / 2), sb = Math.sin(dLon / 2);
  const h = sa * sa + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * sb * sb;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const finite = (p: LonLat | undefined): p is LonLat =>
  !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 540;
const wrapLon = (x: number) => ((x + 180) % 360 + 360) % 360 - 180;

export interface NearestResult { km: Float64Array; to: Int32Array }

interface Coarse { order: Int32Array; cells: { lo: number; hi: number; b: [number, number, number, number] }[] }

/** The targets bucketed into COARSE_DEG cells, each with its own targets' bbox [w, s, e, n]. */
function coarseCells(tx: Float64Array, ty: Float64Array): Coarse {
  const by = new Map<number, number[]>();
  for (let k = 0; k < tx.length; k++) {
    const key = Math.floor((ty[k] + 90) / COARSE_DEG) * 1000 + Math.floor((tx[k] + 180) / COARSE_DEG);
    const ks = by.get(key);
    if (ks) ks.push(k); else by.set(key, [k]);
  }
  const order = new Int32Array(tx.length), cells: Coarse['cells'] = [];
  let at = 0;
  for (const ks of by.values()) {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const lo = at;
    for (const k of ks) { order[at++] = k; b[0] = Math.min(b[0], tx[k]); b[1] = Math.min(b[1], ty[k]); b[2] = Math.max(b[2], tx[k]); b[3] = Math.max(b[3], ty[k]); }
    cells.push({ lo, hi: at, b });
  }
  return { order, cells };
}

/** The km from `p` to the nearest point of the box [w, s, e, n] (which does not cross ±180°), exact: along
 *  a meridian when `p` is within its longitudes, else to the nearer meridian edge — the point of that
 *  meridian nearest `p` (tan φ = tan φp / cos Δλ), clamped to the edge's latitudes. */
function boxBound(p: LonLat, b: readonly [number, number, number, number]): number {
  if (p[0] >= b[0] && p[0] <= b[2]) return EARTH_KM * Math.max(0, b[1] - p[1], p[1] - b[3]) * RAD;
  const toW = ((b[0] - p[0]) % 360 + 360) % 360, toE = ((p[0] - b[2]) % 360 + 360) % 360;
  const lon = toW <= toE ? b[0] : b[2], dl = Math.min(toW, toE) * RAD, fp = p[1] * RAD;
  const lat = Math.atan2(Math.sin(fp), Math.cos(fp) * Math.cos(dl)) / RAD;
  return haversineKm(p, [lon, Math.min(b[3], Math.max(b[1], lat))]);
}

/** Each point's nearest target and its distance in km (exact). */
export function nearest(points: readonly LonLat[], targets: readonly LonLat[], opts: { cellDeg?: number } = {}): NearestResult {
  const km = new Float64Array(points.length).fill(NaN);
  const to = new Int32Array(points.length).fill(-1);
  const tIdx: number[] = [];
  for (let i = 0; i < targets.length; i++) if (finite(targets[i])) tIdx.push(i);
  if (!tIdx.length) return { km, to };
  const tx = new Float64Array(tIdx.length), ty = new Float64Array(tIdx.length);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  tIdx.forEach((i, k) => {
    tx[k] = wrapLon(targets[i][0]); ty[k] = targets[i][1];
    x0 = Math.min(x0, tx[k]); x1 = Math.max(x1, tx[k]); y0 = Math.min(y0, ty[k]); y1 = Math.max(y1, ty[k]);
  });
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const cell = opts.cellDeg ?? Math.min(10, Math.max(0.15, Math.sqrt(area / tIdx.length) * 1.5));
  const cols = Math.ceil(360 / cell), rows = Math.ceil(180 / cell);
  const colOf = (x: number) => Math.min(cols - 1, Math.floor((x + 180) / cell));
  const rowOf = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y + 90) / cell)));

  // Targets sorted by cell (a counting sort): cell c holds order[start[c] .. start[c + 1]).
  const start = new Int32Array(cols * rows + 1);
  const cellOf = new Int32Array(tIdx.length);
  for (let k = 0; k < tIdx.length; k++) { cellOf[k] = rowOf(ty[k]) * cols + colOf(tx[k]); start[cellOf[k] + 1]++; }
  for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
  const order = new Int32Array(tIdx.length), fill = start.slice(0, cols * rows);
  for (let k = 0; k < tIdx.length; k++) order[fill[cellOf[k]]++] = k;

  const cellRad = cell * RAD;
  let coarse: Coarse | null = null;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!finite(pt)) continue;
    const p: LonLat = [wrapLon(pt[0]), pt[1]];
    const pc = colOf(p[0]), pr = rowOf(p[1]);
    let best = Infinity, bk = -1;
    const visit = (c: number) => {
      for (let j = start[c]; j < start[c + 1]; j++) {
        const k = order[j];
        const d = distKm(p[0], p[1], tx[k], ty[k]);
        if (d < best) { best = d; bk = k; }
      }
    };
    let exact = false;
    for (let r = 0; r <= MAX_RING && 2 * r + 1 < cols; r++) {
      for (let row = pr - r; row <= pr + r; row++) {
        if (row < 0 || row >= rows) continue;
        const edge = row === pr - r || row === pr + r;
        for (let dc = -r; dc <= r; dc += edge ? 1 : 2 * r || 1) visit(row * cols + ((pc + dc) % cols + cols) % cols);
      }
      // Every unsearched cell is ≥ r + 1 cells away: a gap of ≥ r cells in latitude or (wrapped) longitude.
      const gap = r * cellRad;
      const top = Math.min(90, Math.abs(p[1]) + (r + 1) * cell) * RAD;
      const bound = Math.min(EARTH_KM * gap, 2 * EARTH_KM * Math.asin(Math.min(1, Math.cos(top) * Math.sin(Math.min(Math.PI, gap) / 2))));
      if (best <= bound) { exact = true; break; }
    }
    if (!exact) {
      // Far from every target: the coarse cells, nearest bound first, until a bound passes the best.
      coarse ??= coarseCells(tx, ty);
      const cand = coarse.cells.map(c => ({ c, lb: boxBound(p, c.b) })).sort((a, b) => a.lb - b.lb);
      for (const { c, lb } of cand) {
        if (lb >= best) break;
        for (let j = c.lo; j < c.hi; j++) { const k = coarse.order[j]; const d = distKm(p[0], p[1], tx[k], ty[k]); if (d < best) { best = d; bk = k; } }
      }
    }
    if (bk >= 0) { km[i] = best; to[i] = tIdx[bk]; }
  }
  return { km, to };
}
