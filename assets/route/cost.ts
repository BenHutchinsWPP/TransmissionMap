// ─── Route cost surfaces and costing ──────────────────────────────────────────
// Role: turns a RoutePreset (src/registry/route-presets.ts) into numbers, with no
//       per-preset branch:
//       - compile(): per band, 256-entry LUTs of routing weight and cost multiplier
//         (one cost LUT per regional cost set when the preset has `regions`).
//         Ungrouped rows and `multiply` groups multiply; a `max` / `min` group (at most
//         two bands) takes the largest / smallest factor its rows give, 1 when none
//         matches (LUT sentinels: max 0, min +∞). A band may sit in several groups.
//         Also a barrier LUT (hard rows + the region rule), a mitigation-class LUT and
//         the ROW land $/m per land-value code. A row's active `except` entries (another
//         band's match) exempt cells from that row: such a cell is costed by a variant
//         compile of the preset without the rows that exempt it (cached per set of rows),
//         i.e. as if those rows did not match it — factor 1 for an ungrouped row. The
//         barrier and mitigation class always come from the full preset.
//       - buildSurfaces(): the LUTs applied over whole band arrays → `route` (per-metre
//         routing weight, unitless: base $ cancels in the solve; clamped to ≤ 1e6) and
//         `barrier` (1 = impassable), the inputs dijkstra.ts and pi-reduce.ts take.
//         Cost multipliers are not a surface: costPath() reads them per cell.
//       - minRouteWeight(): a lower bound on every cell's routing weight, for the
//         optimality proof (route.ts provenOptimal): per max/min group min(1, smallest
//         factor), per ungrouped row min(1, factor), multiplied. `except` cannot break
//         it: dropping a row from a cell replaces its factor with 1 (ungrouped) or with
//         the other rows' combine or 1 (grouped), never below the term's bound.
//       - presetBands(): every band a preset reads (rows, active except entries,
//         mitigation incl. `ca`, region, regions, tribal, ROW land, state always) — the
//         bands a solve must load. An uploaded layer's row (preset-patch.ts add_rows) is a row
//         like any other on band upl_<hash>, so it is listed too; route.ts rasterises those
//         bands rather than reading them.
//       - costPolyline() / costPath(): $ along a polyline over a `Sampler` (a grid's
//         band values per cell), with a per-band table. Each segment is walked
//         cell by cell (dijkstra.ts traverse()), so every cell the line passes
//         through is charged for its exact intersected length — $, per-band
//         contributions, ROW land, tribal and barrier metres alike. A cell the line only
//         touches at a corner has length 0 and adds nothing. Line $ above base is
//         also split per preset row (perRow, signed, + otherUsd = rounding remainder):
//         in each cell the increment base·(c − 1) goes to the rows the cell's factor came
//         from (ungrouped rows, each max/min group's winner by cost) in proportion to
//         ln c_row. regionM: metres costed with each regional cost set (presets with
//         `regions`). rowFactors() exposes one cell's matching rows and group winners;
//         cellFactors() one cell's combined routing weight and cost multiplier (profile.ts).
//       - straightLine(): the no-solve length rule (great circle × factor).
//       Nodata (0) is neutral (factor 1) in every band except the region band, whose
//       rule decides (state 0 = barrier). Barrier cells keep finite
//       factors; only the barrier array marks them.
//       Grid constants (isoreg code → ISO name, landval decode) come from grid.json as
//       `GridConsts`; without them every cell takes the default regional set and ROW
//       land is not costed (both said in the notes). A cell whose isoreg code no set
//       names (code 0 = no BA excepted) also takes the default set, and its miles are
//       counted in a note; miles without a land value are in rowLand.missingMi and a note.
//       Money: each $ input carries its year; the result is in the preset's
//       dollar_year (nominal) and escalated to escalation.to_year. Line $ is
//       base × Π cost_x (cell product clamped to ≤ 1e4) × the short-line factor;
//       mitigation is a % of line $ by risk class; markups apply to line $ + ROW land;
//       terminals are added unmarked (PNAS §C formula); contingency is its own
//       line item on line + markups + mitigation + terminals + ROW land.
//       Pure: no DOM, runs in a worker and in Node.
// Deps: dijkstra.ts (traverse); sandbox/geo-kit.ts (haversineKm); src/registry/route-presets.ts (types only).

import type {
  BandName, Combine, Factor, LineType, Match, RoutePreset, TerminalRule,
} from '../../src/registry/route-presets.js';
import { traverse } from './dijkstra.js';
import { haversineKm } from '../sandbox/geo-kit.js';

export const METRES_PER_MILE = 1609.344;
const M2_PER_ACRE = 4046.8564224;
const FT_M = 0.3048;
export const ROUTE_W_MAX = 1e6;     // cell routing-weight clamp (an edited preset can overflow float32)
export const COST_X_MAX = 1e4;      // cell cost-multiplier clamp

type Bands = Partial<Record<BandName, Uint8Array>>;
type Values = Partial<Record<BandName, number>>;
/** A grid of band values: cell size and top-left corner (EPSG:5070 metres, y up), and
 *  the values of cell (col, row) — null outside the data (treated as all nodata). */
export interface Sampler { cellM: number; x0: number; y0: number; at(col: number, row: number): Values | null }

/** The grid.json tables costing reads (route_grid.py owns them). */
export interface GridConsts {
  isoreg?: { codes: Record<string, string> };
  landval?: { base: number; steps: number };
}

interface Lut { r: Float64Array; c: Float64Array[] }   // c[regional set index]
type GroupRule = Exclude<Combine, 'multiply'>;
interface Group { rule: GroupRule; bands: Map<BandName, Lut> }
/** A row with active `except` entries: its index in preset.rows, its own match LUT and one per entry. */
interface BandHit { band: BandName; hit: Uint8Array }
interface Excepted { row: number; self: BandHit; any: BandHit[] }
/** One row's own factors by band value (per regional set), for per-row attribution. `row` is
 *  the index into the ORIGINAL preset's rows (a variant compile maps its own back). */
interface RowLut { row: number; band: BandName; group: string | undefined; rule: Combine; hit: Uint8Array; r: Float64Array; c: Float64Array[] }
export interface Compiled {
  preset: RoutePreset;
  consts: GridConsts;
  exc: Excepted[];                               // rows with active except entries (bit j of a cell mask = exc[j])
  variants: Map<number, Compiled>;               // cell mask → compile without those rows
  line: LineType;
  setOf: Uint8Array | null;                      // regions band value → set index (null: one set)
  unmapped: Uint8Array | null;                   // regions band value 1–255 → 1 when no set names its ISO (takes the default)
  mul: Map<BandName, Lut>;                       // ungrouped / multiply rows, product (1 = neutral)
  groups: Map<string, Group>;                    // max / min groups (LUT sentinel = no row matched)
  own: Map<BandName, Lut>;                       // all of a band's rows, product (per-band table)
  rows: RowLut[];                                // each row of this line type, in preset order
  barrier: Map<BandName, Uint8Array>;
  mit: Map<BandName, Uint8Array>;                // highest mitigation class 1–3, 0 = none
  rowLandPerM: Float64Array | null;              // landval code → $/m of line, preset dollar_year
  notes: string[];
}

const SENTINEL: Record<GroupRule, number> = { max: 0, min: Infinity };
const comb = (rule: GroupRule, a: number, b: number) => (rule === 'max' ? Math.max(a, b) : Math.min(a, b));
const fold = (rule: GroupRule, x: number) => (x === SENTINEL[rule] ? 1 : x);

export function matches(m: Match, v: number): boolean {
  if (v === 0) return false;
  if ('range' in m) return v >= m.range[0] && v <= m.range[1];
  if ('bit' in m) return ((v >> m.bit) & 1) === 1;
  if ('field' in m) return m.codes.includes((v >> m.field.shift) & m.field.mask);
  return m.codes.includes(v);
}

function factorAt(f: Factor, m: Match, v: number): number {
  if (typeof f === 'number') return f;
  if (!('range' in m)) throw new Error('a ramp factor needs a range match');
  const [lo, hi] = m.range, [a, b] = f.ramp;
  return a + (b - a) * (v - lo) / (hi - lo);
}

const lut = (fill: number, sets: number): Lut => ({
  r: new Float64Array(256).fill(fill), c: Array.from({ length: sets }, () => new Float64Array(256).fill(fill)),
});

/** Regional set names, the default first. */
export function setNames(preset: RoutePreset): string[] {
  const g = preset.regions;
  return g ? [...new Set([g.default, ...Object.values(g.sets)])] : [''];
}

/** Every band the preset reads, state always. */
export function presetBands(preset: RoutePreset): Set<BandName> {
  const out = new Set<BandName>(['state', preset.region.band, preset.tribal.band]);
  for (const row of preset.rows) {
    out.add(row.band);
    for (const e of row.except ?? []) if (e.active !== false) out.add(e.band);
  }
  for (const mc of preset.mitigation?.classes ?? []) for (const { band } of mc.any) out.add(band);
  if (preset.mitigation) out.add(preset.mitigation.ca.band);
  if (preset.regions) out.add(preset.regions.band);
  if (preset.row_land) { out.add(preset.row_land.band); out.add(preset.row_land.developed.band); }
  return out;
}

const ruleOf = (preset: RoutePreset, group: string | undefined): Combine =>
  (group !== undefined && preset.combine[group]) || 'multiply';

/** Lower bound on any cell's routing weight: per max/min group min(1, smallest factor),
 *  per other row min(1, factor), multiplied. The cell clamp only lowers
 *  weights above ROUTE_W_MAX, so the bound stays sound. A row's `except` only removes
 *  the row from a cell: an ungrouped term becomes 1 ≥ min(1, factor); a group term
 *  becomes the other rows' combine or 1, each ≥ min(1, smallest factor). */
export function minRouteWeight(preset: RoutePreset, lineTypeId: string): number {
  const low = (f: Factor) => Math.min(1, ...(typeof f === 'number' ? [f] : f.ramp));
  const groups = new Map<string, number>();
  let m = 1;
  for (const row of preset.rows) {
    if (row.line_types && !row.line_types.includes(lineTypeId)) continue;
    if (ruleOf(preset, row.group) === 'multiply') m *= low(row.route_w);
    else groups.set(row.group!, Math.min(groups.get(row.group!) ?? 1, low(row.route_w)));
  }
  for (const g of groups.values()) m *= g;
  return Math.min(m, ROUTE_W_MAX);
}

export function compile(preset: RoutePreset, lineTypeId: string, consts: GridConsts = {}): Compiled {
  const line = preset.line_types[lineTypeId];
  if (!line) throw new Error(`preset ${preset.id} has no line type ${lineTypeId}`);
  const names = setNames(preset), S = names.length;
  const out: Compiled = {
    preset, consts, exc: [], variants: new Map(), line, setOf: null, unmapped: null, mul: new Map(), groups: new Map(), own: new Map(), rows: [], barrier: new Map(), mit: new Map(),
    rowLandPerM: null, notes: [],
  };
  if (preset.regions) {
    const g = preset.regions, codes = consts.isoreg?.codes;
    out.setOf = new Uint8Array(256);
    if (!codes) out.notes.push(`Regional cost sets not applied (grid.json isoreg table not supplied): every cell uses the ${g.default} set.`);
    else {
      out.unmapped = new Uint8Array(256).fill(1);
      out.unmapped[0] = 0;
      for (const [code, iso] of Object.entries(codes)) {
        const v = Number(code), set = g.sets[iso];
        if (v > 0 && v < 256 && set !== undefined) { out.setOf[v] = names.indexOf(set); out.unmapped[v] = 0; }
      }
    }
  }
  for (const [j, row] of preset.rows.entries()) {
    if (row.line_types && !row.line_types.includes(lineTypeId)) continue;
    const ex = (row.except ?? []).filter((e) => e.active !== false);
    if (ex.length) {
      const hit = ({ band, match }: { band: BandName; match: Match }): BandHit => ({ band, hit: Uint8Array.from({ length: 256 }, (_, v) => +matches(match, v)) });
      out.exc.push({ row: j, self: hit(row), any: ex.map(hit) });
      if (out.exc.length > 30) throw new Error(`preset ${preset.id}: more than 30 rows carry an except`);
    }
    const rule = ruleOf(preset, row.group);
    const byRegion = row.cost_by_region;
    if (byRegion) {
      if (!preset.regions) throw new Error(`preset ${preset.id}: a cost_by_region row needs \`regions\``);
      if (typeof row.cost_x !== 'number') throw new Error(`preset ${preset.id}: a cost_by_region row needs a scalar cost_x`);
      for (const n of names) if (!(n in byRegion)) throw new Error(`preset ${preset.id}: ${row.note ?? row.band} has no cost for set ${n}`);
    }
    let target: Lut;
    if (rule === 'multiply') {
      target = out.mul.get(row.band) ?? lut(1, S);
      out.mul.set(row.band, target);
    } else {
      const g = out.groups.get(row.group!) ?? { rule, bands: new Map<BandName, Lut>() };
      out.groups.set(row.group!, g);
      if (!g.bands.has(row.band) && g.bands.size === 2) throw new Error(`${rule} group ${row.group} spans more than two bands`);
      target = g.bands.get(row.band) ?? lut(SENTINEL[rule], S);
      g.bands.set(row.band, target);
    }
    const own = out.own.get(row.band) ?? lut(1, S);
    out.own.set(row.band, own);
    const mine: RowLut = { row: j, band: row.band, group: row.group, rule, hit: new Uint8Array(256), ...lut(1, S) };
    out.rows.push(mine);
    const bar = row.barrier === 'hard' ? out.barrier.get(row.band) ?? new Uint8Array(256) : null;
    if (bar) out.barrier.set(row.band, bar);
    for (let v = 1; v < 256; v++) {
      if (!matches(row.match, v)) continue;
      const r = factorAt(row.route_w, row.match, v), c0 = factorAt(row.cost_x, row.match, v);
      target.r[v] = rule === 'multiply' ? target.r[v] * r : comb(rule, target.r[v], r);
      own.r[v] *= r;
      mine.hit[v] = 1; mine.r[v] = r;
      for (let s = 0; s < S; s++) {
        const c = byRegion ? c0 * byRegion[names[s]] : c0;
        target.c[s][v] = rule === 'multiply' ? target.c[s][v] * c : comb(rule, target.c[s][v], c);
        own.c[s][v] *= c;
        mine.c[s][v] = c;
      }
      if (bar) bar[v] = 1;
    }
  }
  const reg = preset.region;
  const rb = out.barrier.get(reg.band) ?? new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    if (reg.barrier_codes?.includes(v) || (reg.allowed_codes && !reg.allowed_codes.includes(v))) rb[v] = 1;
  }
  out.barrier.set(reg.band, rb);
  for (const mc of preset.mitigation?.classes ?? []) {
    for (const { band, match } of mc.any) {
      const t = out.mit.get(band) ?? new Uint8Array(256);
      out.mit.set(band, t);
      for (let v = 1; v < 256; v++) if (matches(match, v)) t[v] = Math.max(t[v], mc.class);
    }
  }
  const rl = preset.row_land;
  if (rl) {
    const widthFt = rl.width_ft[lineTypeId];
    if (!(widthFt > 0)) throw new Error(`preset ${preset.id}: row_land has no ROW width for ${lineTypeId}`);
    const lv = consts.landval;
    if (!lv) out.notes.push('ROW land not costed (grid.json landval constants not supplied).');
    else {
      const k = widthFt * FT_M / M2_PER_ACRE * escalationFactor(rl.year, preset.dollar_year, preset.escalation.rate);
      out.rowLandPerM = new Float64Array(256);
      for (let v = 1; v < 256; v++) out.rowLandPerM[v] = lv.base * 2 ** ((v - 1) / lv.steps) * k;
    }
  }
  return out;
}

export interface Surfaces { route: Float32Array; barrier: Uint8Array }

/** Routing and barrier surfaces over whole band arrays. A missing band is all nodata.
 *  (`_opts` is accepted for callers that still pass `{ cost: false }`; there is no cost surface.) */
export function buildSurfaces(
  preset: RoutePreset, lineTypeId: string, bands: Bands, width: number, height: number, _opts: { cost?: boolean } = {},
): Surfaces {
  const k = compile(preset, lineTypeId);
  const n = width * height;
  for (const [name, a] of Object.entries(bands)) {
    if (a && a.length !== n) throw new Error(`band ${name} has ${a.length} cells, expected ${n}`);
  }
  const route = new Float32Array(n), barrier = new Uint8Array(n);
  // Exemptions. An ungrouped (multiply) excepted row leaves the LUTs (`base` is the compile
  // without it) and is applied per chunk instead: × its factor, or × 1 where an active except
  // entry matches. A grouped excepted row's exempted cells are recomputed afterwards from the
  // compile without the rows exempting them, one pass per distinct set of rows; that path
  // alone holds two whole-grid Int32 buffers.
  let mulBits = 0;
  const mulExc: { a: Uint8Array; any: { e: Uint8Array; hit: Uint8Array }[]; l: Float32Array }[] = [];
  for (const [j, x] of k.exc.entries()) {
    const row = preset.rows[x.row];
    if (ruleOf(preset, row.group) !== 'multiply') continue;
    mulBits |= 1 << j;
    const a = bands[x.self.band];
    if (!a) continue;                                  // nodata never matches: the row adds nothing
    const l = new Float32Array(512).fill(1);           // [0, 256): no except matched; [256, 512): exempt
    for (let v = 1; v < 256; v++) if (x.self.hit[v]) l[v] = factorAt(row.route_w, row.match, v);
    mulExc.push({ a, l, any: x.any.filter(({ band }) => bands[band]).map(({ band, hit }) => ({ e: bands[band]!, hit })) });
  }
  const base = mulBits ? variant(k, mulBits, lineTypeId) : k;
  const { t2, t1 } = routeTables(base, bands);
  route.fill(1);
  const C = 4096, any8 = new Uint8Array(C);
  for (let s = 0; s < n; s += C) {
    const e = Math.min(n, s + C);
    for (const { a, b, l } of t2) for (let i = s; i < e; i++) route[i] *= l[(a[i] << 8) | b[i]];
    for (const { a, l } of t1) for (let i = s; i < e; i++) route[i] *= l[a[i]];
    for (const { a, any, l } of mulExc) {
      any8.fill(0);
      for (const { e: x, hit } of any) for (let i = s; i < e; i++) any8[i - s] |= hit[x[i]];
      for (let i = s; i < e; i++) route[i] *= l[(any8[i - s] << 8) | a[i]];
    }
    for (let i = s; i < e; i++) if (!(route[i] <= ROUTE_W_MAX)) route[i] = ROUTE_W_MAX;
  }
  const tests = k.exc.flatMap((x, j) => (bands[x.self.band] ? [{ x, bit: 1 << j }] : []));
  if (tests.some(({ bit }) => !(bit & mulBits))) {
    const mask = new Int32Array(n), idx = new Int32Array(n), whole = new Uint8Array(n);
    for (const { x: { self, any }, bit } of tests) {
      const a = bands[self.band]!, sh = self.hit;
      whole.fill(0);
      for (const { band, hit } of any) { const e = bands[band]; if (e) for (let i = 0; i < n; i++) whole[i] |= hit[e[i]]; }
      for (let i = 0; i < n; i++) if (sh[a[i]] & whole[i]) mask[i] |= bit;
    }
    let hits = 0;
    for (let i = 0; i < n; i++) if (mask[i] & ~mulBits) idx[hits++] = i;   // only-multiply masks are already right
    const seen = new Set<number>();
    for (let h = 0; h < hits; h++) seen.add(mask[idx[h]]);
    for (const m of seen) {
      const v = routeTables(variant(k, m, lineTypeId), bands);
      const sub = idx.subarray(0, hits).filter((i) => mask[i] === m);
      const w = new Float32Array(sub.length).fill(1);
      for (const { a, b, l } of v.t2) for (let h = 0; h < sub.length; h++) { const i = sub[h]; w[h] *= l[(a[i] << 8) | b[i]]; }
      for (const { a, l } of v.t1) for (let h = 0; h < sub.length; h++) w[h] *= l[a[sub[h]]];
      for (let h = 0; h < sub.length; h++) route[sub[h]] = w[h] <= ROUTE_W_MAX ? w[h] : ROUTE_W_MAX;
    }
  }
  for (const [band, l] of k.barrier) {
    const a = bands[band];
    if (!a) { if (l[0]) barrier.fill(1); continue; }
    for (let i = 0; i < n; i++) barrier[i] |= l[a[i]];
  }
  return { route, barrier };
}

/** The routing-weight lookups of a compile over band arrays: per band, one LUT by value
 *  (ungrouped rows, and one-band groups); per two-band group, one LUT by value pair with
 *  the combine taken here, once. Each band's one-band LUT is folded into the first pair
 *  holding that band (a band in two groups is folded once); the rest pair up (half the
 *  lookups), an odd one stays 1-D. A missing band is all nodata. */
function routeTables(k: Compiled, bands: Bands) {
  const one = new Map<BandName, Float64Array>();
  const times = (band: BandName, f: (v: number) => number) => {
    const t = one.get(band) ?? new Float64Array(256).fill(1);
    one.set(band, t);
    for (let v = 0; v < 256; v++) t[v] *= f(v);
  };
  for (const [band, L] of k.mul) if (bands[band]) times(band, (v) => L.r[v]);
  const pairs: { ba: BandName; bb: BandName; f: (u: number, v: number) => number }[] = [];
  for (const { rule, bands: members } of k.groups.values()) {
    const present = [...members].filter(([band]) => bands[band]);
    if (present.length === 2) {
      const [[ba, A], [bb, B]] = present;
      pairs.push({ ba, bb, f: (u, v) => fold(rule, comb(rule, A.r[u], B.r[v])) });
    } else if (present.length === 1) {
      const [[band, X]] = present, Y = [...members].find(([b]) => b !== band)?.[1];
      times(band, (v) => fold(rule, comb(rule, X.r[v], Y ? Y.r[0] : SENTINEL[rule])));
    }
  }
  const t2: { a: Uint8Array; b: Uint8Array; l: Float32Array }[] = [];
  const pairLut = (f: (u: number, v: number) => number) => {
    const l = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) l[i] = f(i >> 8, i & 255);
    return l;
  };
  for (const { ba, bb, f } of pairs) {
    const fa = one.get(ba), fb = one.get(bb);
    one.delete(ba); one.delete(bb);
    t2.push({ a: bands[ba]!, b: bands[bb]!, l: pairLut((u, v) => f(u, v) * (fa ? fa[u] : 1) * (fb ? fb[v] : 1)) });
  }
  const rest = [...one];
  for (; rest.length >= 2; rest.splice(0, 2)) {
    const [[ba, A], [bb, B]] = rest;
    t2.push({ a: bands[ba]!, b: bands[bb]!, l: pairLut((u, v) => A[u] * B[v]) });
  }
  const t1 = rest.map(([band, L]) => ({ a: bands[band]!, l: Float32Array.from(L) }));
  return { t2, t1 };
}

export interface CellFactors { r: number; c: number; set: number; barrier: boolean; mitClass: number; k: Compiled }

/** The preset without the rows in `mask` (bits index k.exc), compiled once per mask. */
function variant(k: Compiled, mask: number, lineTypeId: string): Compiled {
  let v = k.variants.get(mask);
  if (!v) {
    const drop = new Set(k.exc.filter((_, j) => (mask >> j) & 1).map((x) => x.row));
    const kept = k.preset.rows.flatMap((_, j) => (drop.has(j) ? [] : [j]));
    const rows = kept.map((j) => k.preset.rows[j]).map(({ except: _e, ...row }) => row);
    v = compile({ ...k.preset, rows }, lineTypeId, k.consts);
    for (const x of v.rows) x.row = kept[x.row];        // variant row index → original row index
    k.variants.set(mask, v);
  }
  return v;
}

/** Routing weight and cost multiplier of a cell from k's LUTs alone (no except). */
function baseFactors(k: Compiled, vals: Values): { r: number; c: number; set: number } {
  const set = k.setOf ? k.setOf[vals[k.preset.regions!.band] ?? 0] : 0;
  let r = 1, c = 1;
  for (const [band, l] of k.mul) { const v = vals[band] ?? 0; r *= l.r[v]; c *= l.c[set][v]; }
  for (const { rule, bands } of k.groups.values()) {
    let gr = SENTINEL[rule], gc = SENTINEL[rule];
    for (const [band, l] of bands) { const v = vals[band] ?? 0; gr = comb(rule, gr, l.r[v]); gc = comb(rule, gc, l.c[set][v]); }
    r *= fold(rule, gr); c *= fold(rule, gc);
  }
  return { r: Math.min(r, ROUTE_W_MAX), c: Math.min(c, COST_X_MAX), set };
}

/** The compile that costs a cell: k, or k without the rows that exempt the cell. */
function cellCompile(k: Compiled, vals: Values, lineTypeId: string): Compiled {
  let mask = 0;
  for (const [j, x] of k.exc.entries()) {
    if (x.self.hit[vals[x.self.band] ?? 0] && x.any.some(({ band, hit }) => hit[vals[band] ?? 0])) mask |= 1 << j;
  }
  return mask ? variant(k, mask, lineTypeId) : k;
}

/** A cell's factors with the rows that exempt it dropped; `k` = the compile that costed it.
 *  `r` is the routing weight buildSurfaces() gives the cell, `c` the cost multiplier costPolyline() charges. */
export function cellFactors(k: Compiled, vals: Values, lineTypeId: string): CellFactors {
  const kk = cellCompile(k, vals, lineTypeId);
  let barrier = false, mitClass = 0;
  for (const [band, b] of k.barrier) if (b[vals[band] ?? 0]) barrier = true;
  for (const [band, t] of k.mit) mitClass = Math.max(mitClass, t[vals[band] ?? 0]);
  return { ...baseFactors(kk, vals), barrier, mitClass, k: kk };
}

/** One matching row in a cell: its own routing weight `r` and cost multiplier `c` (regional
 *  set applied), and whether it is the factor its group's rule keeps — by cost (`winsCost`)
 *  and by routing weight (`winsRoute`). Ungrouped and `multiply`-group rows always win; in a
 *  max / min group the first row holding the largest / smallest factor wins (one per group). */
export interface RowFactor { row: number; r: number; c: number; winsCost: boolean; winsRoute: boolean }

function evalRows(k: Compiled, vals: Values, set: number): RowFactor[] {
  const out: RowFactor[] = [];
  const best = new Map<string, { rule: GroupRule; c: RowFactor; r: RowFactor }>();
  for (const x of k.rows) {
    const v = vals[x.band] ?? 0;
    if (!x.hit[v]) continue;
    const f: RowFactor = { row: x.row, r: x.r[v], c: x.c[set][v], winsCost: true, winsRoute: true };
    out.push(f);
    if (x.rule === 'multiply') continue;
    f.winsCost = f.winsRoute = false;
    const rule = x.rule, b = best.get(x.group!);
    const beats = (a: number, w: number) => (rule === 'max' ? a > w : a < w);
    if (!b) best.set(x.group!, { rule, c: f, r: f });
    else { if (beats(f.c, b.c.c)) b.c = f; if (beats(f.r, b.r.r)) b.r = f; }
  }
  for (const b of best.values()) { b.c.winsCost = true; b.r.winsRoute = true; }
  return out;
}

/** The rows matching a cell (exemptions applied, original row indices), with their factors
 *  and which ones their group keeps by cost and by routing weight. */
export function rowFactors(compiled: Compiled, vals: Values, lineTypeId: string): RowFactor[] {
  const kk = cellCompile(compiled, vals, lineTypeId);
  return evalRows(kk, vals, kk.setOf ? kk.setOf[vals[kk.preset.regions!.band] ?? 0] : 0);
}

// ─── money ────────────────────────────────────────────────────────────────────

/** Compound escalation factor from one dollar year to another. */
export const escalationFactor = (fromYear: number, toYear: number, rate = 0.04): number => (1 + rate) ** (toYear - fromYear);

/** Stations for a line of `lengthMi`: min + floor(max(0, L − after) / every). */
export function terminalCount(rule: TerminalRule, lengthMi: number): number {
  if (!rule.every_mi) return rule.min;
  return rule.min + Math.floor(Math.max(0, lengthMi - (rule.after_mi ?? 0)) / rule.every_mi);
}

const basePerM = (p: RoutePreset, line: LineType): number =>
  line.base_per_mi.usd * escalationFactor(line.base_per_mi.year, p.dollar_year, p.escalation.rate) / METRES_PER_MILE;

/** Short-line factor on line $ for a routed length (the first tier that holds), else 1. */
export function lengthFactor(preset: RoutePreset, lengthMi: number): number {
  for (const t of preset.length_factor?.tiers ?? []) {
    if ('lt_mi' in t ? lengthMi < t.lt_mi : lengthMi <= t.le_mi) return t.x;
  }
  return 1;
}

// ─── costing ──────────────────────────────────────────────────────────────────

export interface BandContribution { band: BandName; meanRouteW: number; meanCostX: number; affectedM: number }
export interface SegmentCost { lengthM: number; usd: number; meanCostX: number }
/** One preset row's signed share of line $ above base (preset dollar_year, before the
 *  short-line factor, like lineUsd); `row` indexes the original preset.rows. affectedM: length
 *  on cells where the row wins its group (by cost or by routing weight) with a factor ≠ 1. */
export interface RowCost { row: number; usd: number; affectedM: number }

export interface LineCost {
  lengthM: number;
  lineUsd: number;              // base × Π cost_x, preset dollar_year, before markups and the short-line factor
  meanCostX: number;
  mitigationMid: number;
  rowLandUsd: number | null;    // null: the preset has no ROW land, or grid.json's landval constants were not supplied
  rowLandMissingM: number;      // length on cells without a land value (charged $0)
  regionUnmappedM: number;      // length on cells whose ISO code no regional set names (costed with the default set)
  regionM?: Record<string, number>; // metres costed with each regional cost set (presets with `regions` only)
  perBand: BandContribution[];
  baseUsd: number;              // base $/m × length, preset dollar_year, before the short-line factor
  perRow: RowCost[];            // rows that won a cell, in preset order: baseUsd + Σ usd + otherUsd = lineUsd
  otherUsd: number;             // rounding remainder of that sum
  segments: SegmentCost[];
  tribalM: number;
  barrierM: number;             // length sampled on barrier cells (e.g. someone else's geometry)
  notes: string[];
}

/** Line $ along a polyline (EPSG:5070 metres), each segment charged cell by cell for its exact length in each. */
export function costPolyline(
  coords: [number, number][], preset: RoutePreset, lineTypeId: string, sampler: Sampler, consts: GridConsts = {},
): LineCost {
  const k = compile(preset, lineTypeId, consts);
  const perM = basePerM(preset, k.line);
  const mit = preset.mitigation;
  const tribal = preset.tribal;
  const rl = preset.row_land, landM = k.rowLandPerM;
  const bandSums = [...k.own.keys()].map((band) => ({ band, r: 0, c: 0, affected: 0 }));
  const segments: SegmentCost[] = [];
  const rowSums = new Map<number, RowCost>();
  let baseUsd = 0;
  const names = setNames(preset);
  const regionM: Record<string, number> | undefined = preset.regions ? {} : undefined;
  let lengthM = 0, lineUsd = 0, mitigationMid = 0, tribalM = 0, barrierM = 0, rowLandUsd = 0, rowLandMissingM = 0, regionUnmappedM = 0;
  for (let s = 1; s < coords.length; s++) {
    const [x0, y0] = coords[s - 1], [x1, y1] = coords[s];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const { cellM, x0: gx, y0: gy } = sampler;
    let segUsd = 0;
    traverse((x0 - gx) / cellM, (gy - y0) / cellM, (x1 - gx) / cellM, (gy - y1) / cellM, (col, row, cells) => {
      if (cells <= 0) return;
      const pl = cells * cellM;
      const vals = sampler.at(col, row) ?? {};
      const f = cellFactors(k, vals, lineTypeId);
      const baseCell = pl * perM, usd = baseCell * f.c;
      segUsd += usd;
      baseUsd += baseCell;
      attribute(rowSums, evalRows(f.k, vals, f.set), baseCell, f.c, pl);
      if (f.barrier) barrierM += pl;
      if (k.unmapped && k.unmapped[vals[preset.regions!.band] ?? 0]) regionUnmappedM += pl;
      if (regionM) regionM[names[f.set]] = (regionM[names[f.set]] ?? 0) + pl;
      const isTribal = matches(tribal.match, vals[tribal.band] ?? 0);
      if (isTribal) tribalM += pl;
      if (mit && f.mitClass) {
        const ca = mit.ca.codes.includes(vals[mit.ca.band] ?? 0);
        mitigationMid += usd * (ca ? mit.pct.ca : mit.pct.other)[f.mitClass - 1];
      }
      if (rl && landM && !isTribal) {
        const code = vals[rl.band] ?? 0;
        if (!code) rowLandMissingM += pl;
        else rowLandUsd += pl * landM[code] * (matches(rl.developed.match, vals[rl.developed.band] ?? 0) ? rl.developed_x : 1);
      }
      for (const b of bandSums) {
        const v = vals[b.band] ?? 0, own = f.k.own.get(b.band);
        const r = own ? own.r[v] : 1, c = own ? own.c[f.set][v] : 1;
        b.r += pl * r; b.c += pl * c;
        if (r !== 1 || c !== 1) b.affected += pl;
      }
    });
    segments.push({ lengthM: len, usd: segUsd, meanCostX: len > 0 ? segUsd / (len * perM) : 1 });
    lengthM += len; lineUsd += segUsd;
  }
  const perBand = bandSums.map((b) => ({
    band: b.band, meanRouteW: lengthM ? b.r / lengthM : 1, meanCostX: lengthM ? b.c / lengthM : 1, affectedM: b.affected,
  }));
  return {
    lengthM, lineUsd, meanCostX: lengthM ? lineUsd / (lengthM * perM) : 1, mitigationMid,
    rowLandUsd: rl && landM ? rowLandUsd : null, rowLandMissingM, regionUnmappedM, ...(regionM ? { regionM } : {}), perBand, segments, tribalM, barrierM, notes: k.notes,
    ...rowTotals(rowSums, lineUsd, baseUsd),
  };
}

/** Splits one cell's $ above base over the rows its factor came from: each cost winner r
 *  gets baseCell · ln c_r · g, g = (c − 1) / Σ ln c_r — signed, summing to baseCell · (c − 1)
 *  (a clamped c included). Where Σ ln c_r ≈ 0 (rows cancelling), g = 1: each row keeps
 *  baseCell · ln c_r. */
const ln = (x: number) => Math.log(Math.max(x, 1e-300));   // a 0 factor stays finite

function attribute(sums: Map<number, RowCost>, rows: RowFactor[], baseCell: number, c: number, pl: number): void {
  let lnSum = 0;
  for (const x of rows) if (x.winsCost) lnSum += ln(x.c);
  const g = Math.abs(lnSum) > 1e-12 ? (c - 1) / lnSum : 1;
  for (const x of rows) {
    const usd = x.winsCost ? baseCell * ln(x.c) * g : 0;
    const hit = (x.winsCost && x.c !== 1) || (x.winsRoute && x.r !== 1);
    if (!usd && !hit) continue;
    const t = sums.get(x.row) ?? { row: x.row, usd: 0, affectedM: 0 };
    sums.set(x.row, t);
    t.usd += usd;
    if (hit) t.affectedM += pl;
  }
}

function rowTotals(sums: Map<number, RowCost>, lineUsd: number, baseUsd: number) {
  const perRow = [...sums.values()].sort((a, b) => a.row - b.row);
  return { baseUsd, perRow, otherUsd: lineUsd - baseUsd - perRow.reduce((t, x) => t + x.usd, 0) };
}

export interface CostResult {
  preset: string;
  lineType: string;
  dollarYear: number;
  lengthM: number;
  lengthFactor: number;                          // short-line factor applied to line $ (and its mitigation)
  baseUsd: number;                               // base $ of the line (preset dollar_year, before lengthFactor)
  perRow: RowCost[];                             // per-row signed $ above base (before lengthFactor)
  otherUsd: number;                              // baseUsd + Σ perRow.usd + otherUsd = lineUsdNominal / lengthFactor
  lineUsdNominal: number;
  markupsUsd: number;
  mitigationUsd: { low: number; mid: number; high: number };
  rowLand: { usd: number; note: string; missingMi: number } | null; // missingMi: miles on cells without a land value ($0)
  terminalCount: number;
  terminalsUsd: number | null;
  contingency: { usd: number; pct: number; label: string } | null;
  totalNominal: number;
  total2025: number;
  band: { low: number; high: number; label: string };
  meanCostX: number;
  perBand: BandContribution[];
  segments: SegmentCost[];
  tribalMiles: number;
  barrierM: number;
  regionM?: Record<string, number>;              // metres costed with each regional cost set (presets with `regions`)
  notes: string[];
}

function finish(preset: RoutePreset, lineTypeId: string, lc: LineCost): CostResult {
  const line = preset.line_types[lineTypeId];
  const { rate, to_year } = preset.escalation;
  const u = preset.uncertainty;
  const lf = lengthFactor(preset, lc.lengthM / METRES_PER_MILE);
  const lineUsd = lc.lineUsd * lf, mid = lc.mitigationMid * lf;
  const rowLandUsd = lc.rowLandUsd ?? 0;
  const markupX = preset.markups.reduce((x, m) => x * m.x, 1);
  const markupsUsd = (lineUsd + rowLandUsd) * (markupX - 1);
  const t = line.terminals;
  const terminalCountN = terminalCount(t, lc.lengthM / METRES_PER_MILE);
  const terminalsUsd = t.usd_each === null ? null : terminalCountN * t.usd_each * escalationFactor(t.year, preset.dollar_year, rate);
  const subtotal = lineUsd + markupsUsd + mid + (terminalsUsd ?? 0) + rowLandUsd;
  const ct = preset.contingency;
  const contingency = ct ? { usd: subtotal * ct.pct, pct: ct.pct, label: ct.label } : null;
  const totalNominal = subtotal + (contingency?.usd ?? 0);
  const total2025 = totalNominal * escalationFactor(preset.dollar_year, to_year, rate);
  const notes = [preset.caveat, ...preset.notes, ...lc.notes];
  if (terminalsUsd === null) notes.push(`Terminals not costed: ${t.arithmetic ?? t.src}`);
  if (t.report_only) notes.push(`Terminal count rule is unsourced (report only): ${t.src}`);
  if (lc.tribalM > 0) notes.push(preset.tribal.note);
  if (lc.rowLandMissingM > 0) notes.push(`ROW land: ${(lc.rowLandMissingM / METRES_PER_MILE).toFixed(1)} mi on cells without a county land value, charged $0.`);
  if (lc.regionUnmappedM > 0 && preset.regions)
    notes.push(`${(lc.regionUnmappedM / METRES_PER_MILE).toFixed(1)} mi on cells whose ISO code no regional cost set names, costed with the ${preset.regions.default} set.`);
  return {
    preset: preset.id, lineType: lineTypeId, dollarYear: preset.dollar_year,
    lengthM: lc.lengthM, lengthFactor: lf, baseUsd: lc.baseUsd, perRow: lc.perRow, otherUsd: lc.otherUsd,
    lineUsdNominal: lineUsd, markupsUsd,
    mitigationUsd: { low: mid * (1 + u.low), mid, high: mid * (1 + u.high) },
    rowLand: preset.row_land && lc.rowLandUsd !== null
      ? { usd: lc.rowLandUsd, note: preset.row_land.note, missingMi: lc.rowLandMissingM / METRES_PER_MILE } : null,
    terminalCount: terminalCountN, terminalsUsd, contingency, totalNominal, total2025,
    band: { low: total2025 * (1 + u.low), high: total2025 * (1 + u.high), label: u.label },
    meanCostX: lc.meanCostX, perBand: lc.perBand, segments: lc.segments,
    tribalMiles: lc.tribalM / METRES_PER_MILE, barrierM: lc.barrierM, ...(lc.regionM ? { regionM: lc.regionM } : {}), notes,
  };
}

/** Full estimate for a solved path (cell centres or PI polyline, EPSG:5070 metres).
 *  `consts` = grid.json's isoreg table and landval constants (regional sets, ROW land). */
export function costPath(
  coords: [number, number][], preset: RoutePreset, lineTypeId: string, sampler: Sampler, consts: GridConsts = {},
): CostResult {
  return finish(preset, lineTypeId, costPolyline(coords, preset, lineTypeId, sampler, consts));
}

/** Great-circle metres between two [lng, lat] points. */
export function greatCircleM(a: [number, number], b: [number, number]): number {
  return haversineKm(a, b) * 1000;
}

/** No-solve estimate: great circle × the preset's straight-line factor × base, terminals, markups, band. */
export function straightLine(from: [number, number], to: [number, number], preset: RoutePreset, lineTypeId: string): CostResult {
  const line = preset.line_types[lineTypeId];
  if (!line) throw new Error(`preset ${preset.id} has no line type ${lineTypeId}`);
  const factor = typeof preset.length === 'object' ? preset.length.straight_line_factor : 1;
  const lengthM = greatCircleM(from, to) * factor;
  const lineUsd = lengthM * basePerM(preset, line);
  return finish(preset, lineTypeId, {
    lengthM, lineUsd, meanCostX: 1, mitigationMid: 0, rowLandUsd: null, rowLandMissingM: 0, regionUnmappedM: 0, perBand: [],
    baseUsd: lineUsd, perRow: [], otherUsd: 0, segments: [{ lengthM, usd: lineUsd, meanCostX: 1 }], tribalM: 0, barrierM: 0,
    notes: preset.row_land ? ['ROW land not costed (no route is solved).'] : [],
  });
}

// ─── grid helpers ─────────────────────────────────────────────────────────────

/** Sampler over in-memory band arrays; (x0, y0) is the grid's top-left corner, y up. */
export function gridSampler(bands: Bands, width: number, height: number, cellM: number, x0 = 0, y0 = 0): Sampler {
  const names = Object.keys(bands) as BandName[];
  return {
    cellM, x0, y0,
    at(col, row) {
      if (col < 0 || col >= width || row < 0 || row >= height) return null;
      const i = row * width + col, out: Values = {};
      for (const b of names) out[b] = bands[b]![i];
      return out;
    },
  };
}

/** Cell centres of a solve() path, EPSG:5070 metres (same corner convention as gridSampler). */
export function cellsToCoords(path: number[], width: number, cellM: number, x0 = 0, y0 = 0): [number, number][] {
  return path.map((i) => [x0 + ((i % width) + 0.5) * cellM, y0 - (Math.floor(i / width) + 0.5) * cellM]);
}
