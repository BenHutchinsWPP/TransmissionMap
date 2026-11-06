// ─── Walking along a line's true geometry (pure) ─────────────────────────────
// Role: the fault locator's and the elevation profile's geometry. A chain's ways (line-read.ts
//       chainGeometry: in order, `rev` = drawn backwards) become one ordered
//       position list, then a distance from either end becomes a point and an
//       uncertainty span on that list.
//   linePieces(geometry)          a LineString / MultiLineString's parts
//   orderPieces(pieces)           the parts end to end (each may be reversed),
//                                 joined where ends meet within JOIN_TOL_M; parts
//                                 that do not meet → `disconnected`, with the pieces
//   assembleWays(ways)            each way's parts ordered, flipped by `rev`, then
//                                 the ways joined in order (a way that meets
//                                 the previous one only backwards is flipped)
//   pointAt(line, m) / sliceAt(line, a, b)   the position m metres along, and the
//                                 part between a and b, by great-circle interpolation
//   densify(line, step)           a point every step metres from the start, and the end
//                                 (the elevation profile's samples)
//   faultPosition(input)          distance from end A or B (optionally scaled by
//                                 the relay's line length) → metres along from A,
//                                 with the ±% span; longer than the line → `beyond`
//   orientEnds(start, end, first, second)   whether a line's named ends (HIFLD
//                                 SUB_1 / SUB_2, by the substations of those names
//                                 nearest each end) sit the other way round
// Lengths are spherical, R = 6371.0088 km (sandbox/geo-kit.ts haversineKm, as
// the line files' length_km).
// Deps: sandbox/geo-kit.ts (haversineKm).

import { haversineKm } from '../sandbox/geo-kit.js';

export type Pos = number[];
export const JOIN_TOL_M = 5;
const RAD = Math.PI / 180;

export const distM = (a: Pos, b: Pos): number => haversineKm(a, b) * 1000;

export function pathLengthM(line: Pos[]): number {
  let m = 0;
  for (let i = 0; i + 1 < line.length; i++) m += distM(line[i], line[i + 1]);
  return m;
}

export type Assembled =
  | { ok: true; line: Pos[]; lengthM: number }
  | { ok: false; reason: 'empty' | 'disconnected'; pieces: Pos[][] };

/** A LineString's or MultiLineString's parts with at least two positions; [] for any other type. */
export function linePieces(g: GeoJSON.Geometry | null | undefined): Pos[][] {
  if (!g) return [];
  const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  return parts.filter(p => p.length >= 2).map(p => p.map(c => [c[0], c[1]]));
}

/** `b` appended to `a`, dropping b's first position when it repeats a's last. */
function join(a: Pos[], b: Pos[]): Pos[] {
  const same = a[a.length - 1][0] === b[0][0] && a[a.length - 1][1] === b[0][1];
  return a.concat(same ? b.slice(1) : b);
}

const rev = (p: Pos[]): Pos[] => [...p].reverse();

/** The pieces joined end to end, greedily growing one run from the first
 *  piece at both its ends; each piece may be reversed. */
export function orderPieces(pieces: Pos[][], tol = JOIN_TOL_M): Assembled {
  if (!pieces.length) return { ok: false, reason: 'empty', pieces };
  let run = pieces[0];
  const left = pieces.slice(1);
  while (left.length) {
    const head = run[0], tail = run[run.length - 1];
    let hit = -1;
    for (let i = 0; i < left.length && hit < 0; i++) {
      const p = left[i], s = p[0], e = p[p.length - 1];
      if (distM(tail, s) <= tol) { run = join(run, p); hit = i; }
      else if (distM(tail, e) <= tol) { run = join(run, rev(p)); hit = i; }
      else if (distM(head, e) <= tol) { run = join(p, run); hit = i; }
      else if (distM(head, s) <= tol) { run = join(rev(p), run); hit = i; }
    }
    if (hit < 0) return { ok: false, reason: 'disconnected', pieces };
    left.splice(hit, 1);
  }
  return { ok: true, line: run, lengthM: pathLengthM(run) };
}

export interface WayGeom { rev: boolean; geometry: GeoJSON.Geometry }

/** A chain's ways as one line from its start (end A) to its end (end B). */
export function assembleWays(ways: WayGeom[], tol = JOIN_TOL_M): Assembled {
  const all = ways.flatMap(w => linePieces(w.geometry));
  let run: Pos[] | null = null;
  for (const w of ways) {
    const one = orderPieces(linePieces(w.geometry), tol);
    if (!one.ok) return { ok: false, reason: one.reason, pieces: all };
    const p = w.rev ? rev(one.line) : one.line;
    if (!run) { run = p; continue; }
    const tail = run[run.length - 1];
    if (distM(tail, p[0]) <= tol) run = join(run, p);
    else if (distM(tail, p[p.length - 1]) <= tol) run = join(run, rev(p));
    else return { ok: false, reason: 'disconnected', pieces: all };
  }
  if (!run) return { ok: false, reason: 'empty', pieces: all };
  return { ok: true, line: run, lengthM: pathLengthM(run) };
}

/** The point a fraction f of the way from a to b along the great circle. */
function interp(a: Pos, b: Pos, f: number): Pos {
  if (f <= 0) return [a[0], a[1]];
  if (f >= 1) return [b[0], b[1]];
  const [l1, p1, l2, p2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const d = Math.acos(Math.min(1, Math.max(-1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2])));
  if (d < 1e-12) return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const s1 = Math.sin((1 - f) * d) / Math.sin(d), s2 = Math.sin(f * d) / Math.sin(d);
  const x = s1 * v1[0] + s2 * v2[0], y = s1 * v1[1] + s2 * v2[1], z = s1 * v1[2] + s2 * v2[2];
  return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
}

/** Where m metres along `line` falls: the segment index and the point. m is clamped to the line. */
function locate(line: Pos[], m: number): { i: number; at: Pos } {
  let acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = distM(line[i], line[i + 1]);
    if (acc + seg >= m) return { i, at: interp(line[i], line[i + 1], seg > 0 ? (m - acc) / seg : 0) };
    acc += seg;
  }
  const last = line[line.length - 1];
  return { i: line.length - 2, at: [last[0], last[1]] };
}

export function pointAt(line: Pos[], m: number): Pos {
  return locate(line, Math.max(0, m)).at;
}

/** The part of `line` from a to b metres along (a ≤ b). */
export function sliceAt(line: Pos[], a: number, b: number): Pos[] {
  const s = locate(line, Math.max(0, a)), e = locate(line, Math.max(a, b));
  return [s.at, ...line.slice(s.i + 1, e.i + 1), e.at];
}

/** Points every stepM metres along `line` from its start, and its end: [{ d metres along, pos }]. */
export function densify(line: Pos[], stepM: number): { d: number; pos: Pos }[] {
  const out: { d: number; pos: Pos }[] = [{ d: 0, pos: [line[0][0], line[0][1]] }];
  let acc = 0, next = stepM;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = distM(line[i], line[i + 1]);
    while (seg > 0 && next < acc + seg - stepM * 1e-6) {
      out.push({ d: next, pos: interp(line[i], line[i + 1], (next - acc) / seg) });
      next += stepM;
    }
    acc += seg;
  }
  if (acc > out[out.length - 1].d) { const last = line[line.length - 1]; out.push({ d: acc, pos: [last[0], last[1]] }); }
  return out;
}

export interface FaultInput {
  lengthM: number;        // the line's map length (the assembled geometry)
  distM: number;          // the relay's distance to the fault
  from: 'A' | 'B';
  relayLengthM?: number;  // the line length in the relay settings: the distance is scaled by lengthM / relayLengthM
  pct: number;            // ± uncertainty, percent of the line's length
}

export type FaultPlace =
  | { ok: true; alongM: number; lowM: number; highM: number; mapDistM: number }
  | { ok: false; reason: 'beyond' | 'invalid' };

/** The fault's position as metres along from end A, with its ±pct % span
 *  (of the line length, clipped to the line). A distance past the far end is
 *  `beyond`; the scaled distance is what is compared. */
export function faultPosition(x: FaultInput): FaultPlace {
  const ok = (v: number | undefined) => v !== undefined && Number.isFinite(v) && v >= 0;
  if (!ok(x.distM) || !(x.lengthM > 0) || !ok(x.pct) || (x.relayLengthM !== undefined && !(x.relayLengthM > 0)))
    return { ok: false, reason: 'invalid' };
  const mapDistM = x.relayLengthM ? x.distM * x.lengthM / x.relayLengthM : x.distM;
  if (mapDistM > x.lengthM * (1 + 1e-9)) return { ok: false, reason: 'beyond' };
  const alongM = x.from === 'A' ? mapDistM : x.lengthM - mapDistM;
  const u = x.lengthM * x.pct / 100;
  return { ok: true, alongM, mapDistM, lowM: Math.max(0, alongM - u), highM: Math.min(x.lengthM, alongM + u) };
}

/** Which way round a line's named ends sit: `first` and `second` are the
 *  points named as its first and second end (HIFLD SUB_1 / SUB_2), each list
 *  every substation of that name. Each name counts by its point nearest an
 *  end, only within maxM of it. `swap` when the second name sits at the start;
 *  null when no named point is within maxM of either end. */
export function orientEnds(start: Pos, end: Pos, first: Pos[], second: Pos[], maxM = 3000): { swap: boolean } | null {
  const near = (pts: Pos[], at: Pos) => {
    const d = Math.min(Infinity, ...pts.map(p => distM(p, at)));
    return d <= maxM ? d : Infinity;
  };
  const score = (terms: number[]) => {
    const f = terms.filter(Number.isFinite);
    return { n: f.length, sum: f.reduce((a, b) => a + b, 0) };
  };
  const keep = score([near(first, start), near(second, end)]);
  const flip = score([near(first, end), near(second, start)]);
  if (!keep.n && !flip.n) return null;
  return { swap: flip.n > keep.n || (flip.n === keep.n && flip.sum < keep.sum) };
}
