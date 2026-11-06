// ─── Route profile and crossings ──────────────────────────────────────────────
// Role: what a routed polyline passes through, for the route panel (profile chart,
//       crossings table, "colour route by" cost × / driver). Pure: no DOM, no I/O; runs in
//       the worker (route.ts) and in Node.
//       The polyline (EPSG:5070 metres, the reduced PI line) is walked cell by cell with
//       traverse() exactly as cost.ts costPolyline() walks it; consecutive visits of one cell
//       (a segment joint) are one cell, and a corner touch (length 0) is no cell.
//       Per cell (band decodes: scripts/route_grid.py):
//         landcover (0 → null) · agency (0 = nodata → null; 1 = private / not in PAD-US is a code) · gap = protect bits 0–2
//         (GAP 1–4, 0 → null) · park = flags bit 6 · wetland = wetland code ≥ 27 (share ≥ 26 %) · tribal = flags bit 0 · critHab = flags bit 3 · s368 = flags
//         bit 4 · phma = flags2 bit 0 · homes = bldg code 2–3 → 1 (1–2 homes), 4–10 → 2 (3–9), 11+ → 3
//         (10+), 1 → 0 (none), 0 → null (the tm-default steps) · follows = the route runs along a ≥ 230 kV line: adj class
//         (`v & 16 ? v & 3 : 0`) 1–2 (on the line / within 1 cell) held for ≥ FOLLOW_MIN_CELLS
//         consecutive cells (≈ 2 km) with at least one class-1 cell = that class, else 0; the adj
//         band's ±1-cell ring makes a perpendicular crossing at most 6 cells of class 1–2, so it
//         never qualifies, and a route flickering between 1 and 2 along a line does · costX / routeW
//         = cost.ts cellFactors() (the solver's routing weight and costPolyline's cost
//         multiplier) · driver = routeCategory() of the row that wins by routing weight with
//         the largest |ln r| (null when every r = 1); an uploaded layer's row (band upl_<hash>,
//         read like any band the sampler gives) is driver `upload`.
//       Runs merge consecutive cells whose displayed values match (costX / routeW at 2
//       decimals). Miles are cumulative along the walk, scaled so the last mi1 === lengthMi.
//       aviation = miles per code 2–6 (the 77.9(b) notice zone with no lower surface, three Part 77 surface classes by the
//       lowest surface's height above ground, primary surface; codes 0–1 are skipped); aviationHeightM = the structure
//       height the preset screens at for the line type (the lowest class 3/4/5 that an `aviation` row with route_w
//       or cost_x other than 1 covers → 61/46/30 m; null when none), set by buildProfile only. A row's `except` entries need a
//       cell to judge, so the height ignores them.
//       Samples: one per cell, at the point of the polyline at the cell's mid-distance.
//       Crossings (osm_flags bits 1 river, 4 road, 5 rail, 6 pipeline, 2 line ≥ 230 kV,
//       3 line 100–229 kV; lakes are not a kind): an entry counts only after ≥ 4 consecutive
//       cells (≈ 1 km) without the bit (gaps of 1–3 cells merge, so a road, rail or pipeline
//       running alongside is one crossing; the walk's first cell with it counts); a
//       ≥ 230 kV entry that is the first bit-2 cell of a following stretch is not a crossing (the
//       route joins the line from the side; the stretch's miles are `follows`). Later entries
//       inside a stretch count: the route weaving across the line, or crossing another line, as the
//       vector crossing report counts them (cells carry no line identity, so a line crossed with
//       no gap in its bit-2 cells while the route runs along another is missed). Counts
//       are approximate. A band not in `present`, or a value the sampler does not give
//       (a super-tile with no data), is unknown: a nullable field is null, a boolean false,
//       no miles are counted for it, and a cell with unknown osm_flags neither enters nor
//       breaks a crossing.
// Deps: dijkstra.ts (traverse), cost.ts (cellFactors, rowFactors, Sampler, Compiled),
//       categories.ts (routeCategory), src/registry/route-presets.ts (types only).

import type { BandName, RoutePreset } from '../../src/registry/route-presets.js';
import { traverse } from './dijkstra.js';
import { cellFactors, rowFactors, matches, METRES_PER_MILE, type Compiled, type Sampler } from './cost.js';
import { routeCategory } from './categories.js';

export interface ProfileRun {            // consecutive cells with identical displayed values
  mi0: number; mi1: number;              // mile range along the route (last mi1 === lengthMi)
  landcover: number | null; agency: number | null; gap: number | null;  // gap 1..4 or null
  tribal: boolean; critHab: boolean; phma: boolean; s368: boolean;
  homes: 0 | 1 | 2 | 3 | null;           // homes in the cell: 0 none, 1 = 1–2, 2 = 3–9, 3 = 10+; null outside CONUS land or unknown
  follows: 0 | 1 | 2;                    // 0 not following, 1 on a ≥ 230 kV line, 2 within 1 cell, inside a class 1–2 run of ≥ 8 cells with a class-1 cell
  costX: number; routeW: number; driver: string | null;   // driver = category key
}
export interface ProfileSample { mi: number; lngLat: [number, number] }   // one per cell centre (elevation, marker)
export interface CrossingPoint {
  kind: 'river' | 'road' | 'rail' | 'pipeline' | 'line230' | 'line100'; mi: number; lngLat: [number, number];
  name?: string; detail?: string;        // exact crossings only (crossings-exact.ts): the feature's display text
}
export interface RouteCrossings {
  points: CrossingPoint[];                              
  counts: Record<CrossingPoint['kind'], number>;
  miles: { follows: number; s368: number; gap12: number; gap3: number; critHab: number; phma: number; tribal: number; park: number; wetland: number;
           byAgency: Record<number, number>;               // agency code → mi; 0 is nodata (skipped); 1 = private / not in PAD-US
           desig: Record<number, number>;                  // desig bit → mi
           aviation: Record<number, number> };             // aviation code 2–6 → mi
  aviationHeightM: number | null;                          // assumed structure height (m) the method screens at; null = none (buildCrossings never sets it)
}
export interface RouteProfile { runs: ProfileRun[]; samples: ProfileSample[]; crossings: RouteCrossings }

/** The bands the profile and crossings read. */
export const PROFILE_BANDS: readonly BandName[] = ['landcover', 'agency', 'protect', 'flags', 'flags2', 'desig', 'osm_flags', 'adj', 'bldg', 'wetland', 'aviation'];

export interface CrossingsOptions {
  toLngLat: (x: number, y: number) => [number, number];
  lengthMi: number;
  /** Bands the sampler supplies; any other band is unknown. */
  present: Set<string>;
}
export interface ProfileOptions extends CrossingsOptions { compiled: Compiled; preset: RoutePreset; lineTypeId: string }

const FOLLOW_MIN_CELLS = 8;   // consecutive class 1–2 cells (≈ 2 km) that make a route follow a line
const ENTRY_GAP_CELLS = 4;
const KIND_BITS: [CrossingPoint['kind'], number][] = [['river', 1], ['road', 4], ['rail', 5], ['pipeline', 6], ['line230', 2], ['line100', 3]];
const DESIG_BITS = 8;

type Values = NonNullable<ReturnType<Sampler['at']>>;
interface Cell { col: number; row: number; m: number; d0: number; vals: Values }

/** The cells the polyline passes through, in order, with metres in each and distance at entry. */
function walk(coords: [number, number][], sampler: Sampler): { cells: Cell[]; total: number } {
  const { cellM, x0: gx, y0: gy } = sampler;
  const cells: Cell[] = [];
  let d = 0;
  for (let s = 1; s < coords.length; s++) {
    const [ax, ay] = coords[s - 1], [bx, by] = coords[s];
    traverse((ax - gx) / cellM, (gy - ay) / cellM, (bx - gx) / cellM, (gy - by) / cellM, (col, row, len) => {
      if (len <= 0) return;
      const m = len * cellM, last = cells[cells.length - 1];
      if (last && last.col === col && last.row === row) last.m += m;
      else cells.push({ col, row, m, d0: d, vals: sampler.at(col, row) ?? {} });
      d += m;
    });
  }
  return { cells, total: d };
}

/** Point at distance `d` along the polyline; calls must come in non-decreasing `d`. */
function pointer(coords: [number, number][]): (d: number) => [number, number] {
  let s = 1, start = 0;
  return (d) => {
    for (;;) {
      const [ax, ay] = coords[s - 1], [bx, by] = coords[s];
      const len = Math.hypot(bx - ax, by - ay);
      if (d <= start + len || s === coords.length - 1) {
        const t = len > 0 ? Math.min(1, Math.max(0, (d - start) / len)) : 0;
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      }
      start += len; s++;
    }
  };
}

interface Walked {
  cells: Cell[];
  mi: (d: number) => number;                // metres along the walk → scaled miles
  cellMi: (c: Cell) => number;
  pointer: () => (d: number) => [number, number];   // a fresh lng/lat-at-distance reader (non-decreasing d)
  get: (c: Cell, band: BandName) => number | undefined;
  follows: (0 | 1 | 2)[];
}

function prepare(coords: [number, number][], sampler: Sampler, o: CrossingsOptions): Walked {
  const { cells, total } = walk(coords, sampler);
  const k = total > 0 ? o.lengthMi / (total / METRES_PER_MILE) : 0;
  const mi = (d: number) => (d / METRES_PER_MILE) * k;
  const get = (c: Cell, band: BandName) => (o.present.has(band) ? c.vals[band] : undefined);
  // Following = a run of adj class 1–2 held for ≥ FOLLOW_MIN_CELLS consecutive cells that contains a class-1 cell.
  const cls = cells.map((c) => { const v = get(c, 'adj'); return v !== undefined && v & 16 ? v & 3 : 0; });
  const follows = cells.map(() => 0 as 0 | 1 | 2);
  for (let i = 0; i < cells.length;) {
    let j = i;
    while (j < cells.length && (cls[j] === 1 || cls[j] === 2)) j++;
    if (j - i >= FOLLOW_MIN_CELLS && cls.slice(i, j).includes(1)) for (let q = i; q < j; q++) follows[q] = cls[q] as 1 | 2;
    i = Math.max(j, i + 1);
  }
  return { cells, mi, cellMi: (c) => mi(c.m), pointer: () => { const p = pointer(coords); return (d) => o.toLngLat(...p(d)); }, get, follows };
}

const bit = (v: number | undefined, b: number) => v !== undefined && ((v >> b) & 1) === 1;

function crossings(w: Walked): RouteCrossings {
  const { cells, get, follows, cellMi } = w;
  const counts = Object.fromEntries(KIND_BITS.map(([kind]) => [kind, 0])) as RouteCrossings['counts'];
  const miles: RouteCrossings['miles'] = { follows: 0, s368: 0, gap12: 0, gap3: 0, critHab: 0, phma: 0, tribal: 0, park: 0, wetland: 0, byAgency: {}, desig: {}, aviation: {} };
  const points: CrossingPoint[] = [];
  const at = w.pointer();
  const gapOf = new Map(KIND_BITS.map(([kind]) => [kind, Infinity]));
  let stretchFrom = 0, lastOn230 = -1;   // first cell of the current following stretch; last cell seen with the ≥ 230 kV bit
  cells.forEach((c, i) => {
    const m = cellMi(c);
    if (follows[i] && !(i && follows[i - 1])) stretchFrom = i;
    const osm = get(c, 'osm_flags');
    if (osm !== undefined) {
      for (const [kind, b] of KIND_BITS) {
        if (!bit(osm, b)) { gapOf.set(kind, gapOf.get(kind)! + 1); continue; }
        if (gapOf.get(kind)! >= ENTRY_GAP_CELLS && !(kind === 'line230' && follows[i] && lastOn230 < stretchFrom)) {
          const d = c.d0 + c.m / 2;
          points.push({ kind, mi: w.mi(d), lngLat: at(d) });
          counts[kind]++;
        }
        gapOf.set(kind, 0);
        if (kind === 'line230') lastOn230 = i;
      }
    }
    if (follows[i]) miles.follows += m;
    const flags = get(c, 'flags');
    if (bit(flags, 0)) miles.tribal += m;
    if (bit(flags, 3)) miles.critHab += m;
    if (bit(flags, 4)) miles.s368 += m;
    if (bit(flags, 6)) miles.park += m;
    const wet = get(c, 'wetland');
    if (wet !== undefined && wet >= 27) miles.wetland += m;
    if (bit(get(c, 'flags2'), 0)) miles.phma += m;
    const protect = get(c, 'protect');
    const gap = protect !== undefined ? protect & 7 : 0;
    if (gap === 1 || gap === 2) miles.gap12 += m;
    else if (gap === 3) miles.gap3 += m;
    const agency = get(c, 'agency');
    if (agency) miles.byAgency[agency] = (miles.byAgency[agency] ?? 0) + m;
    const av = get(c, 'aviation');
    if (av !== undefined && av >= 2 && av <= 6) miles.aviation[av] = (miles.aviation[av] ?? 0) + m;
    const desig = get(c, 'desig');
    for (let b = 0; b < DESIG_BITS; b++) if (bit(desig, b)) miles.desig[b] = (miles.desig[b] ?? 0) + m;
  });
  return { points, counts, miles, aviationHeightM: null };
}

/** Crossings and miles only (alternatives). */
export function buildCrossings(coordsAlbers: [number, number][], sampler: Sampler, opts: CrossingsOptions): RouteCrossings {
  return crossings(prepare(coordsAlbers, sampler, opts));
}

const AVIATION_M: [number, number][] = [[3, 61], [4, 46], [5, 30]];   // the bin edges of codes 3 / 4 / 5 (route_aviation.py)
const weighs = (f: number | { ramp: number[] }): boolean => (typeof f === 'number' ? f !== 1 : f.ramp.some((v) => v !== 1));

/** The structure height (m) the preset screens at: the lowest class 3–5 that an `aviation` row with route_w or cost_x other than 1 covers for this line type. */
export function aviationHeightM(preset: RoutePreset, lineTypeId: string): number | null {
  for (const [code, m] of AVIATION_M) {
    if (preset.rows.some((r) => r.band === 'aviation' && (!r.line_types || r.line_types.includes(lineTypeId))
      && matches(r.match, code) && (weighs(r.route_w) || weighs(r.cost_x)))) return m;
  }
  return null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const homesClass = (v: number | undefined): ProfileRun['homes'] =>
  !v ? null : v >= 11 ? 3 : v >= 4 ? 2 : v >= 2 ? 1 : 0;
const RUN_KEYS = ['landcover', 'agency', 'gap', 'tribal', 'critHab', 'phma', 's368', 'homes', 'follows', 'costX', 'routeW', 'driver'] as const;

/** Runs, per-cell samples and crossings of a routed polyline (EPSG:5070 metres). */
export function buildProfile(coordsAlbers: [number, number][], sampler: Sampler, opts: ProfileOptions): RouteProfile {
  const w = prepare(coordsAlbers, sampler, opts);
  const { compiled, preset, lineTypeId } = opts;
  const runs: ProfileRun[] = [];
  const samples: ProfileSample[] = [];
  const at = w.pointer();
  w.cells.forEach((c, i) => {
    const mid = c.d0 + c.m / 2;
    samples.push({ mi: w.mi(mid), lngLat: at(mid) });
    const f = cellFactors(compiled, c.vals, lineTypeId);
    let driver: string | null = null, best = 0;
    for (const x of rowFactors(compiled, c.vals, lineTypeId)) {
      const s = Math.abs(Math.log(Math.max(x.r, 1e-300)));
      if (x.winsRoute && x.r !== 1 && s > best) { best = s; driver = routeCategory(preset.rows[x.row]); }
    }
    const lc = w.get(c, 'landcover'), protect = w.get(c, 'protect'), flags = w.get(c, 'flags');
    const run: ProfileRun = {
      mi0: w.mi(c.d0), mi1: w.mi(c.d0 + c.m),
      landcover: lc ? lc : null,
      agency: w.get(c, 'agency') || null,
      gap: protect !== undefined && protect & 7 ? protect & 7 : null,
      tribal: bit(flags, 0), critHab: bit(flags, 3), phma: bit(w.get(c, 'flags2'), 0), s368: bit(flags, 4),
      homes: homesClass(w.get(c, 'bldg')),
      follows: w.follows[i],
      costX: round2(f.c), routeW: round2(f.r), driver,
    };
    const prev = runs[runs.length - 1];
    if (prev && RUN_KEYS.every((key) => prev[key] === run[key])) prev.mi1 = run.mi1;
    else runs.push(run);
  });
  if (runs.length) runs[runs.length - 1].mi1 = opts.lengthMi;
  return { runs, samples, crossings: { ...crossings(w), aviationHeightM: aviationHeightM(preset, lineTypeId) } };
}
