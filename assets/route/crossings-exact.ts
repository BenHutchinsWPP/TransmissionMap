// ─── Exact route crossings ────────────────────────────────────────────────────
// Role: road / river / rail / pipeline / line crossings of a routed polyline by true vector
//       intersection, for the route panel. Pure: no DOM, no I/O; runs in the worker and in Node.
//       Everything is EPSG:5070 metres: the reader (report-read.ts) projects each feature.
//       Raw intersections port scripts/route_crossings.py: seg_intersect (parallel or
//       collinear → none; t, u ∈ [0, 1] inclusive, so a feature through a route vertex hits
//       both adjoining segments) over a CELL_M grid of the route's segments (Route._grid /
//       _candidates, a segment tested once per feature segment). Then, per polyline:
//         merge  points of one group within MERGE_M[family] straight-line of an earlier kept point
//                (sorted by along; roads and rail 300 m for wide medians and yards, the rest 100 m)
//                are one (dedupe_points). Group = family + src + `group`
//                (`id` when absent); for lines the chained line.
//         dups   an hifld crossing within DUP_M[family] of a merged osm crossing of the same family
//                (all lines together; pipelines 500 m, lines 300 m), taken before the follow and ends rules, is dropped
//                and counted in `dupDropped`.
//         chain  OSM line ways (line230 = kv ≥ 230, line100 = 100 ≤ kv < 230; others skipped) are
//                one line (union-find) where a part endpoint (1 m key) is touched by exactly two
//                OSM line way-ends, both of one kV class; a key with ≥ 3 ends (substation, tap,
//                junction) joins nothing. Each HIFLD feature is its own line.
//         follow a followed interval of a kV class is a merged along-route interval where the route
//                lies within FOLLOW_M of any line of that class (sampled every STEP_M) that is itself
//                ≥ FOLLOW_MIN_M long — a corridor, like the grid's follows, so a route weaving through
//                parallel lines stays inside one; each line's crossings inside it ± FOLLOW_M count
//                mod 2: odd keeps the middle one by along, even keeps none.
//         ends   line crossings within ENDPOINT_M of the polyline's first or last vertex do not count.
//       A point carries its feature's name/detail (a chain's: its first named way's).
//       Miles are along-route metres scaled so the polyline's length is lengthsMi[i].
// Deps: profile.ts (CrossingPoint, RouteCrossings types only).

import type { CrossingPoint, RouteCrossings } from './profile.js';

export type Family = 'road' | 'river' | 'rail' | 'pipeline' | 'line';
export interface ExactFeature {
  family: Family; src: 'osm' | 'hifld' | 'narn';
  id: string;                      // unique per feature within its file
  group?: string;                  // merge key for road/river/rail/pipeline; ignored for lines (chaining decides)
  name?: string; detail?: string;  // display text, already cleaned
  kv?: number;                     // lines only
  lines: [number, number][][];     // EPSG:5070 metres, one array per LineString part
}
export interface ExactResult { points: CrossingPoint[]; counts: RouteCrossings['counts']; dupDropped: number }
export interface ExactOptions { toLngLat: (x: number, y: number) => [number, number]; lengthsMi: number[] }

export const MERGE_M: Record<Family, number> = { road: 300, rail: 300, river: 100, pipeline: 100, line: 100 };
export const FOLLOW_M = 250, FOLLOW_MIN_M = 2000, ENDPOINT_M = 300;
export const DUP_M: Partial<Record<Family, number>> = { line: 300, pipeline: 500 };
const CELL_M = 5000;       // route-segment grid cell (route_crossings.py CELL_M)
const NEAR_CELL_M = 500;   // line-segment grid cell for the follow test
const STEP_M = 25;         // route sampling step for the follow test

type Kind = CrossingPoint['kind'];
const KINDS: Kind[] = ['river', 'road', 'rail', 'pipeline', 'line230', 'line100'];
const cellKey = (cx: number, cy: number) => cx * 2097152 + cy;

interface Track {
  xs: Float64Array; ys: Float64Array; cum: Float64Array; n: number;
  bx0: number; by0: number; bx1: number; by1: number;
  grid: Map<number, number[]>; mark: Int32Array; tick: number;
}

function track(poly: [number, number][]): Track {
  const n = poly.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xs[i] = poly[i][0], y = ys[i] = poly[i][1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]);
    bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
  }
  const grid = new Map<number, number[]>();
  for (let i = 0; i + 1 < n; i++) {
    const cx1 = Math.floor(Math.max(xs[i], xs[i + 1]) / CELL_M), cy1 = Math.floor(Math.max(ys[i], ys[i + 1]) / CELL_M);
    for (let cx = Math.floor(Math.min(xs[i], xs[i + 1]) / CELL_M); cx <= cx1; cx++) {
      for (let cy = Math.floor(Math.min(ys[i], ys[i + 1]) / CELL_M); cy <= cy1; cy++) {
        const k = cellKey(cx, cy), list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
  }
  return { xs, ys, cum, n, bx0, by0, bx1, by1, grid, mark: new Int32Array(Math.max(n - 1, 0)), tick: 0 };
}

/** Every intersection of `lines` with the route: along-route metres and the point. */
function eachHit(t: Track, lines: [number, number][][], hit: (along: number, x: number, y: number) => void): void {
  const { xs, ys, cum, grid, mark } = t;
  for (const line of lines) {
    if (line.length < 2) continue;
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    for (const [x, y] of line) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y; }
    if (lx1 < t.bx0 || lx0 > t.bx1 || ly1 < t.by0 || ly0 > t.by1) continue;
    for (let j = 1; j < line.length; j++) {
      const [cx, cy] = line[j - 1], [dx, dy] = line[j];
      const tick = ++t.tick;
      const gx1 = Math.floor(Math.max(cx, dx) / CELL_M), gy1 = Math.floor(Math.max(cy, dy) / CELL_M);
      for (let gx = Math.floor(Math.min(cx, dx) / CELL_M); gx <= gx1; gx++) {
        for (let gy = Math.floor(Math.min(cy, dy) / CELL_M); gy <= gy1; gy++) {
          const segs = grid.get(cellKey(gx, gy));
          if (!segs) continue;
          for (const i of segs) {
            if (mark[i] === tick) continue;
            mark[i] = tick;
            const ax = xs[i], ay = ys[i], rx = xs[i + 1] - ax, ry = ys[i + 1] - ay, sx = dx - cx, sy = dy - cy;
            const den = rx * sy - ry * sx;
            if (den === 0) continue;
            const qx = cx - ax, qy = cy - ay;
            const tt = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
            if (tt < 0 || tt > 1 || u < 0 || u > 1) continue;
            hit(cum[i] + tt * (cum[i + 1] - cum[i]), ax + tt * rx, ay + tt * ry);
          }
        }
      }
    }
  }
}

/** (t, u) along a→b and c→d where the segments meet, else null; parallel/collinear → null. */
export function segIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

export interface RawHit { along: number; x: number; y: number }

/** Every intersection of `lines` with the polyline, sorted by along (no merging): route_crossings.py line_hits. */
export function rawIntersections(polyline: [number, number][], lines: [number, number][][]): RawHit[] {
  const out: RawHit[] = [];
  eachHit(track(polyline), lines, (along, x, y) => out.push({ along, x, y }));
  return out.sort(byAlong);
}

const byAlong = (p: RawHit, q: RawHit) => p.along - q.along || p.x - q.x || p.y - q.y;

/** Keep one of any points within `tol` of an earlier kept point (sorted by along): dedupe_points. */
export function dedupePoints<P extends RawHit>(pts: P[], tol: number): P[] {
  const kept: P[] = [];
  for (const p of [...pts].sort(byAlong)) if (!kept.some((k) => Math.hypot(p.x - k.x, p.y - k.y) < tol)) kept.push(p);
  return kept;
}

function kindOf(f: ExactFeature): Kind | null {
  if (f.family !== 'line') return f.family;
  const kv = f.kv ?? 0;
  return kv >= 230 ? 'line230' : kv >= 100 ? 'line100' : null;
}

/** Chained-line root per feature (union-find over OSM part endpoints touched by exactly two way-ends of one kV class); -1 for non-lines. */
function chainLines(features: ExactFeature[], kinds: (Kind | null)[]): Int32Array {
  const parent = new Int32Array(features.length).fill(-1);
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const ends = new Map<string, number[]>();
  features.forEach((f, i) => {
    if (f.family !== 'line' || !kinds[i]) return;
    parent[i] = i;
    if (f.src !== 'osm') return;
    for (const part of f.lines) {
      if (!part.length) continue;
      for (const [x, y] of [part[0], part[part.length - 1]]) {
        const key = `${Math.round(x)},${Math.round(y)}`, list = ends.get(key);
        if (list) list.push(i); else ends.set(key, [i]);
      }
    }
  });
  for (const list of ends.values()) {
    if (list.length !== 2 || kinds[list[0]] !== kinds[list[1]]) continue;
    const a = find(list[0]), b = find(list[1]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  for (let i = 0; i < parent.length; i++) if (parent[i] >= 0) parent[i] = find(i);
  return parent;
}

function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
  const t = dd ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / dd)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Per line kind, the along-route intervals over which the route follows lines of it (≥ FOLLOW_MIN_M within FOLLOW_M of any). */
function followed(t: Track, want: Set<Kind>, features: ExactFeature[], kinds: (Kind | null)[]): Map<Kind, [number, number][]> {
  const out = new Map<Kind, [number, number][]>();
  const rootIdx = new Map<Kind, number>();
  for (const r of want) rootIdx.set(r, rootIdx.size);
  const seg: number[] = [], segRoot: number[] = [];
  const grid = new Map<number, number[]>();
  features.forEach((f, fi) => {
    const kind = kinds[fi], r = kind ? rootIdx.get(kind) : undefined;
    if (f.family !== 'line' || r === undefined) return;
    for (const part of f.lines) {
      for (let j = 1; j < part.length; j++) {
        const [ax, ay] = part[j - 1], [bx, by] = part[j], s = segRoot.length;
        seg.push(ax, ay, bx, by); segRoot.push(r);
        const gx1 = Math.floor((Math.max(ax, bx) + FOLLOW_M) / NEAR_CELL_M), gy1 = Math.floor((Math.max(ay, by) + FOLLOW_M) / NEAR_CELL_M);
        for (let gx = Math.floor((Math.min(ax, bx) - FOLLOW_M) / NEAR_CELL_M); gx <= gx1; gx++) {
          for (let gy = Math.floor((Math.min(ay, by) - FOLLOW_M) / NEAR_CELL_M); gy <= gy1; gy++) {
            const k = cellKey(gx, gy), list = grid.get(k);
            if (list) list.push(s); else grid.set(k, [s]);
          }
        }
      }
    }
  });
  if (!segRoot.length || t.n < 2) return out;
  const ivs: [number, number][][] = [...want].map(() => []);
  const stamp = new Int32Array(want.size);
  const { xs, ys, cum, n } = t, total = cum[n - 1], h = STEP_M / 2;
  let i = 0;
  for (let k = 0, s = 0; s <= total; s = ++k * STEP_M) {
    while (i < n - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i], f = len > 0 ? (s - cum[i]) / len : 0;
    const px = xs[i] + f * (xs[i + 1] - xs[i]), py = ys[i] + f * (ys[i + 1] - ys[i]);
    const cands = grid.get(cellKey(Math.floor(px / NEAR_CELL_M), Math.floor(py / NEAR_CELL_M)));
    if (!cands) continue;
    for (const c of cands) {
      const r = segRoot[c];
      if (stamp[r] === k + 1) continue;
      if (ptSegDist(px, py, seg[4 * c], seg[4 * c + 1], seg[4 * c + 2], seg[4 * c + 3]) > FOLLOW_M) continue;
      stamp[r] = k + 1;
      const list = ivs[r], last = list[list.length - 1];
      if (last && s - h <= last[1]) last[1] = s + h; else list.push([s - h, s + h]);
    }
  }
  for (const [root, r] of rootIdx) {
    const long = ivs[r].filter(([a, b]) => b - a >= FOLLOW_MIN_M);
    if (long.length) out.set(root, long);
  }
  return out;
}

interface Hit extends RawHit { f: number; kind: Kind }

function one(poly: [number, number][], features: ExactFeature[], kinds: (Kind | null)[], chain: Int32Array,
  chainName: Map<number, number>, toLngLat: ExactOptions['toLngLat'], lengthMi: number): ExactResult {
  const t = track(poly);
  const groups = new Map<string, Hit[]>();
  features.forEach((f, fi) => {
    const kind = kinds[fi];
    if (!kind) return;
    const key = f.family === 'line' ? `L${chain[fi]}` : `${f.family}|${f.src}|${f.group !== undefined ? 'g:' + f.group : 'i:' + f.id}`;
    eachHit(t, f.lines, (along, x, y) => {
      const list = groups.get(key), h = { along, x, y, f: fi, kind };
      if (list) list.push(h); else groups.set(key, [h]);
    });
  });
  let kept: Hit[] = [];
  for (const list of groups.values()) kept.push(...dedupePoints(list, MERGE_M[features[list[0].f].family]));

  const isLine = (h: Hit) => h.kind === 'line230' || h.kind === 'line100';
  const family = (h: Hit): Family => (isLine(h) ? 'line' : h.kind as Family);
  const primary = kept.filter((h) => features[h.f].src === 'osm');
  let dupDropped = 0;
  kept = kept.filter((h) => {
    const fam = family(h), tol = DUP_M[fam];
    if (features[h.f].src !== 'hifld' || tol === undefined) return true;
    const dup = primary.some((p) => family(p) === fam && Math.hypot(p.x - h.x, p.y - h.y) <= tol);
    if (dup) dupDropped++;
    return !dup;
  });

  const lineKinds = new Set(kept.filter(isLine).map((h) => h.kind));
  if (lineKinds.size) {
    const fol = followed(t, lineKinds, features, kinds);
    const drop = new Set<Hit>(), inside = new Map<string, Hit[]>();
    for (const h of kept) {
      const ivs = isLine(h) ? fol.get(h.kind) : undefined;
      const j = ivs ? ivs.findIndex(([a, b]) => h.along >= a - FOLLOW_M && h.along <= b + FOLLOW_M) : -1;
      if (j < 0) continue;
      drop.add(h);
      const key = `${chain[h.f]}|${j}`, list = inside.get(key);
      if (list) list.push(h); else inside.set(key, [h]);
    }
    for (const list of inside.values()) if (list.length % 2) drop.delete(list.sort(byAlong)[list.length >> 1]);
    const n = t.n, ex0 = t.xs[0], ey0 = t.ys[0], ex1 = t.xs[n - 1], ey1 = t.ys[n - 1];
    kept = kept.filter((h) => !drop.has(h) && !(isLine(h) &&
      (Math.hypot(h.x - ex0, h.y - ey0) <= ENDPOINT_M || Math.hypot(h.x - ex1, h.y - ey1) <= ENDPOINT_M)));
  }

  const total = t.n ? t.cum[t.n - 1] : 0, k = total > 0 ? lengthMi / total : 0;
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as RouteCrossings['counts'];
  const points = kept.sort(byAlong).map((h): CrossingPoint => {
    counts[h.kind]++;
    const src = features[isLine(h) ? chainName.get(chain[h.f]) ?? h.f : h.f];
    const p: CrossingPoint = { kind: h.kind, mi: h.along * k, lngLat: toLngLat(h.x, h.y) };
    if (src.name !== undefined) p.name = src.name;
    if (src.detail !== undefined) p.detail = src.detail;
    return p;
  });
  return { points, counts, dupDropped };
}

/** Exact crossings of each polyline (EPSG:5070 metres) with the features. */
export function exactCrossings(polylines: [number, number][][], features: ExactFeature[], opts: ExactOptions): ExactResult[] {
  const kinds = features.map(kindOf);
  const chain = chainLines(features, kinds);
  const chainName = new Map<number, number>();
  features.forEach((f, fi) => { if (chain[fi] >= 0 && f.name && !chainName.has(chain[fi])) chainName.set(chain[fi], fi); });
  return polylines.map((poly, i) => one(poly, features, kinds, chain, chainName, opts.toLngLat, opts.lengthsMi[i] ?? 0));
}
