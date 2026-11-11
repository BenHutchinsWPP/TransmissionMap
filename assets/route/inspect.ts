// ─── Route cell inspector ─────────────────────────────────────────────────────
// Role: what one 250 m cell of the routing cube holds and why a method weighs it
//       as it does (the Route pane's Inspect tooltip):
//       - decodeCell(): every band's value as human labels (NLCD class, slope bin,
//         GAP / TNC / PoPWest / NPS-Preserve bits, land manager, wildfire, WHP class, flag bits,
//         state postal code, ISO region from grid.json, land value $/ac, homes in the cell, wetland share,
//         observed footprint coverage/share (rounded-up bounds), max existing
//         kV, existing-line adjacency (rings by voltage), aviation surface class, NFHL flood class) — encodings of
//         scripts/route_grid.py;
//       - explainCell(): the cell's routing weight and cost multiplier (cost.ts
//         cellFactors), the matching rows with the winner of each group (rowFactors),
//         the rows an active `except` exempts here, the barrier rule that blocks it,
//         and a one-line `cause`: "Blocked: …", else the routing winner with the
//         largest |ln r| (that row's label, e.g. "exceeds an obstruction standard — screening (≤ 61 m / 200 ft) · routing weight ×100"), else
//         "No routing penalty".
//       - presentFacts(): only the facts a decoded cell holds, in plain words (no "none" lines, except the
//         flood band's code 1, a FEMA map in effect and no special flood hazard area).
//       - matchText(): a preset row's match in the same words (the Method tab's Applies to);
//         inspect.test.ts holds these tables to the grid.json route_grid.py writes.
//       An uploaded layer's row (band upl_<hash>) is explained like any row, named by its
//       category `upload` and its label (the row's note); decodeCell leaves upl bands out.
//       Labels are `Text` — an i18n key with params, or a literal (a region name) —
//       so the worker builds them and the page renders them with its `t` (textOf).
//       Pure: no DOM, no i18n import, no I/O; runs in the route worker and in Node.
// Deps: cost.ts (cellFactors, rowFactors, matches, Compiled), categories.ts,
//       src/registry/route-presets.ts (types only).

import type { BandName, Combine, Match, RoutePreset } from '../../src/registry/route-presets.js';
import { cellFactors, matches, rowFactors, type Compiled } from './cost.js';
import { categoryLabelKey, routeCategory } from './categories.js';

type Values = Partial<Record<BandName, number>>;

/** An i18n key with params (params may nest), or a literal string shown as it is. */
export type Text = string | { k: string; p?: Record<string, string | number | Text> };

/** Render a Text with the page's translator. */
export function textOf(x: Text, tr: (key: string, params?: Record<string, string | number>) => string): string {
  if (typeof x === 'string') return x;
  if (!x.p) return tr(x.k);
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(x.p)) p[k] = typeof v === 'object' ? textOf(v, tr) : v;
  return tr(x.k, p);
}

/** The grid.json tables decoding needs (route.ts GridMeta has them). */
export interface DecodeMeta {
  isoreg: Map<number, string> | Record<number, string>;
  landval: { base: number; steps: number };
}

export interface DecodedBand { band: BandName; value: number; label: Text; text: Text[] }
export type DecodedCell = DecodedBand[];

export const INSPECT_BANDS: readonly BandName[] = ['landcover', 'slope', 'protect', 'agency', 'wildfire', 'whpclass', 'flags', 'state',
  'desig', 'flags2', 'isoreg', 'landval', 'bldg', 'wetland', 'built', 'nonres', 'bldgunk', 'aviation', 'nfhl', 'osm_flags', 'osm_maxkv', 'adj'];

const NLCD = new Set([11, 12, 21, 22, 23, 24, 31, 41, 42, 43, 51, 52, 71, 72, 73, 74, 81, 82, 90, 95]);
/** Slope bin edges (°), bins 1–8 (route_grid.py). */
const SLOPE_EDGES = [0, 1, 2, 4, 8, 15, 25, 45, 90];
/** pd flags / flags2 / desig / osm_flags: the bits each band carries. */
const BITS: Partial<Record<BandName, number[]>> = {
  flags: [0, 1, 2, 3, 4, 5, 6, 7], flags2: [0, 1, 2, 3, 4, 5, 6, 7], desig: [0, 1, 2, 3, 4, 5, 6, 7], osm_flags: [0, 1, 2, 3, 4, 5, 6, 7],
};
/** State FIPS → USPS code (48 states + DC). */
const STATES: Record<number, string> = {
  1: 'AL', 4: 'AZ', 5: 'AR', 6: 'CA', 8: 'CO', 9: 'CT', 10: 'DE', 11: 'DC', 12: 'FL', 13: 'GA', 16: 'ID', 17: 'IL', 18: 'IN',
  19: 'IA', 20: 'KS', 21: 'KY', 22: 'LA', 23: 'ME', 24: 'MD', 25: 'MA', 26: 'MI', 27: 'MN', 28: 'MS', 29: 'MO', 30: 'MT',
  31: 'NE', 32: 'NV', 33: 'NH', 34: 'NJ', 35: 'NM', 36: 'NY', 37: 'NC', 38: 'ND', 39: 'OH', 40: 'OK', 41: 'OR', 42: 'PA',
  44: 'RI', 45: 'SC', 46: 'SD', 47: 'TN', 48: 'TX', 49: 'UT', 50: 'VT', 51: 'VA', 53: 'WA', 54: 'WV', 55: 'WI', 56: 'WY',
};

const K = (k: string, p?: Record<string, string | number | Text>): Text => (p ? { k, p } : { k });
const NODATA = K('route.insp.nodata');

/** "2.3" / "100" / "0.8": a factor without trailing zeros. */
export function fmtX(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  return String(+x.toFixed(x >= 10 ? 1 : 2));
}

const stateText = (v: number): Text => (v === 0 ? K('route.insp.state.outside') : K('route.insp.state', { code: STATES[v] ?? '?', fips: String(v).padStart(2, '0') }));

function bandText(band: BandName, v: number, meta: DecodeMeta): Text[] {
  if (band === 'state') return [stateText(v)];
  if (band === 'built' || band === 'nonres' || band === 'bldgunk') {
    if (v === 0) return [K('route.insp.footprintOutside')];
    if (v === 1) return [K('route.insp.footprintNone')];
    return v <= 101 ? [K('route.insp.footprintUpper', { pct: v - 1 })] : [K('route.insp.code', { v })];
  }
  if (BITS[band]) {
    const on = BITS[band]!.filter((b) => (v >> b) & 1).map((b) => K(categoryLabelKey(`${band}:${b}`)));
    const other = v & ~BITS[band]!.reduce((m, b) => m | (1 << b), 0);
    for (let b = 0; b < 8; b++) if ((other >> b) & 1) on.push(K('route.insp.bit', { n: b }));
    return on.length ? on : [K('route.insp.none')];
  }
  if (band === 'adj') {
    if (!(v & 16)) return [NODATA];
    const kv = v & 8 ? [K('route.insp.adjkv.500')] : v & 4 ? [K('route.insp.adjkv.345')] : [];
    return [K(`route.insp.adj.${v & 3}`), ...kv, ...(((v >> 5) & 3) ? [K(`route.insp.adj100.${(v >> 5) & 3}`)] : [])];
  }
  // 0 is nodata (scripts/route_grid.py) except where it is a real value: no PAD-US unit, no existing line.
  if (v === 0) return [band === 'protect' ? K('route.insp.gapNone') : band === 'osm_maxkv' ? K('route.insp.none') : NODATA];
  switch (band) {
    case 'landcover': return [NLCD.has(v) ? K(`route.lbl.nlcd.${v}`) : K('route.insp.code', { v })];
    case 'slope': return v <= 8 ? [K('route.insp.slope', { lo: SLOPE_EDGES[v - 1], hi: SLOPE_EDGES[v] })] : [K('route.insp.code', { v })];
    case 'protect': {
      const gap = v & 7, tnc = (v >> 4) & 3, out: Text[] = [];
      out.push(gap ? K('route.insp.gap', { n: gap }) : K('route.insp.gapNone'));
      if (tnc) out.push(K('route.insp.tnc', { n: tnc }));
      if ((v >> 6) & 1) out.push(K('route.insp.outsidePopwest'));
      if ((v >> 7) & 1) out.push(K('route.insp.npsPreserve'));
      return out;
    }
    case 'agency': return [v >= 1 && v <= 13 ? K(`route.lbl.agency.${v}`) : K('route.insp.code', { v })];
    case 'wildfire': return [K('route.insp.wildfire', { v, pct: Math.round(((v - 1) / 254) * 100) })];
    case 'whpclass': return [v <= 7 ? K(`route.insp.whp.${v}`) : K('route.insp.code', { v })];
    case 'isoreg': {
      const iso = meta.isoreg instanceof Map ? meta.isoreg.get(v) : meta.isoreg[v];
      return [iso ?? K('route.insp.code', { v })];
    }
    case 'landval': {
      const usd = meta.landval.base * 2 ** ((v - 1) / meta.landval.steps);
      return [K('route.insp.landval', { usd: Math.round(usd).toLocaleString('en-US') })];
    }
    case 'bldg': return v === 1 ? [K('route.insp.none')] : [K('route.insp.bldg', { n: v === 255 ? '254+' : v - 1 })];
    case 'wetland': return v === 1 ? [K('route.insp.none')] : [K('route.insp.wetland', { pct: v - 1 })];
    case 'osm_maxkv': return [K('route.insp.kv', { kv: v * 5 })];
    // aviation 1 = evaluated: outside the notice extent, no surface below 61 m AGL ("none"); nfhl 1 = a FEMA map in effect and no special flood hazard area.
    case 'aviation': return [v === 1 ? K('route.insp.none') : v <= 6 ? K(`route.insp.aviation.${v}`) : K('route.insp.code', { v })];
    case 'nfhl': return [v >= 1 && v <= 3 ? K(`route.insp.nfhl.${v}`) : K('route.insp.code', { v })];
    default: return [K('route.insp.code', { v })];
  }
}

const span = (lo: number, hi: number): string => (lo === hi ? String(lo) : `${lo}–${hi}`);
/** Bands whose words need grid.json tables a preset match does not carry. */
const META_BANDS = new Set<BandName>(['isoreg', 'landval']);

/** A preset row's match in words, one Text per value or span it takes (encodings of scripts/route_grid.py):
 *  the Method tab's Applies to. A value with no words comes back as `route.insp.code` / `route.insp.bit`. */
export function matchText(band: BandName, m: Match): Text[] {
  if ('bit' in m) {
    if (BITS[band]) return [K(categoryLabelKey(`${band}:${m.bit}`))];
    if (band === 'adj' && (m.bit === 2 || m.bit === 3)) return [K(`route.insp.adjkv.${m.bit === 2 ? 345 : 500}`)];
    if (band === 'protect' && m.bit === 6) return [K('route.insp.outsidePopwest')];
    if (band === 'protect' && m.bit === 7) return [K('route.insp.npsPreserve')];
    return [K('route.insp.bit', { n: m.bit })];
  }
  if ('field' in m) {
    const f = `${band}:${m.field.shift}:${m.field.mask}`;
    return m.codes.map((c) => {
      switch (f) {
        case 'protect:0:7': return K('route.insp.gap', { n: c });
        case 'protect:4:3': return K('route.insp.tnc', { n: c });
        case 'adj:0:3': return c <= 3 ? K(`route.insp.adj.${c}`) : K('route.insp.code', { v: c });
        case 'adj:5:3': return c <= 3 ? K(`route.insp.adj100.${c}`) : K('route.insp.code', { v: c });
        default: return K('route.insp.code', { v: c });
      }
    });
  }
  if ('range' in m) {
    const [lo, hi] = m.range;
    if (lo <= 1 && hi >= 255) return [K('route.mg.anyValue')];
    if (band === 'slope' && lo >= 1 && hi <= 8) return [K('route.insp.slope', { lo: SLOPE_EDGES[lo - 1], hi: SLOPE_EDGES[hi] })];
    if (band === 'bldg' && lo >= 2) return [K('route.insp.bldg', { n: hi >= 255 ? `${lo - 1}+` : span(lo - 1, hi - 1) })];
    if (band === 'wetland' && lo >= 2 && hi <= 101) return [K('route.insp.wetland', { pct: span(lo - 1, hi - 1) })];
    if ((band === 'built' || band === 'nonres' || band === 'bldgunk') && lo === 2 && hi <= 101) return [K('route.insp.footprintUpper', { pct: hi - 1 })];
    return [K('route.insp.code', { v: span(lo, hi) })];
  }
  if (META_BANDS.has(band)) return m.codes.map((v) => K('route.insp.code', { v }));
  return m.codes.flatMap((v) => bandText(band, v, { isoreg: {}, landval: { base: 1, steps: 1 } }));
}

/** Every band of the cell, decoded; a band missing from `values` (not read) is left out. */
export function decodeCell(values: Values, meta: DecodeMeta): DecodedCell {
  return INSPECT_BANDS.filter((b) => values[b] !== undefined)
    .map((band) => ({ band, value: values[band]!, label: K(`route.insp.band.${band}`), text: bandText(band, values[band]!, meta) }));
}

export interface ExplainRow {
  row: number;
  label: Text;            // the row's category (route.cat.*)
  note?: string;          // the preset row's own note
  r: number;
  c: number;
  winsRoute: boolean;
  winsCost: boolean;
  group?: string;
  rule: Combine;
}
export interface ExplainExempt { row: number; label: Text; note?: string; exceptLabel: string }
export interface CellExplain {
  routeW: number;
  costX: number;
  barrier: Text | null;   // the rule that makes the cell impassable
  rows: ExplainRow[];
  exempted: ExplainExempt[];
  cause: Text;
  /** The card's headline: the cause with the routing factor only ("Sage-grouse priority habitat · routing ×40"). */
  head?: Text;
}

/** One fact present in the cell, in plain words. `bit` / `value` say which class it is (for a swatch). */
export interface Fact { band: BandName; bit?: number; value?: number; label: Text }

const OMITTED = new Set(['route.insp.nodata', 'route.insp.none', 'route.insp.gapNone']);
const isOmitted = (x: Text): boolean => typeof x === 'object' && OMITTED.has(x.k);

/** Only what the cell holds: no-data and "none" lines left out; a bit band gives one fact per set bit. */
export function presentFacts(cell: DecodedCell): Fact[] {
  const out: Fact[] = [];
  for (const d of cell) {
    const v = d.value;
    if (BITS[d.band]) {
      for (const b of BITS[d.band]!) if ((v >> b) & 1) out.push({ band: d.band, bit: b, label: K(categoryLabelKey(`${d.band}:${b}`)) });
    } else if (d.band === 'protect') {
      if (v & 7) out.push({ band: d.band, value: v & 7, label: K('route.insp.gap', { n: v & 7 }) });
      if ((v >> 4) & 3) out.push({ band: d.band, label: K('route.insp.tnc', { n: (v >> 4) & 3 }) });
      if ((v >> 6) & 1) out.push({ band: d.band, label: K('route.insp.outsidePopwest') });
      if ((v >> 7) & 1) out.push({ band: d.band, value: v & 128, label: K('route.insp.npsPreserve') });
    } else {
      for (const x of d.text.filter((y) => !isOmitted(y))) {
        out.push({ band: d.band, value: v, label: d.band === 'adj' ? x : K('route.insp.fact', { band: d.label, value: x }) });
      }
    }
  }
  return out;
}

const BIT_KEY = /^(flags|flags2|osm_flags|desig):\d$/;
/** A row's category label, with its note when the category alone does not say which row. */
function causeLabel(preset: RoutePreset, row: number): Text {
  const cr = preset.rows[row], key = routeCategory(cr), label = K(categoryLabelKey(key));
  return cr.note && !BIT_KEY.test(key) ? K('route.insp.labelNote', { label, note: cr.note }) : label;
}

function barrierReason(compiled: Compiled, values: Values, preset: RoutePreset): Text | null {
  const reg = preset.region, sv = values[reg.band] ?? 0;
  if (reg.barrier_codes?.includes(sv) || (reg.allowed_codes && !reg.allowed_codes.includes(sv))) {
    return sv === 0 && reg.band === 'state' ? K('route.insp.barrier.outside')
      : K('route.insp.barrier.region', { where: reg.band === 'state' ? stateText(sv) : String(sv) });
  }
  for (const [j, row] of preset.rows.entries()) {
    if (row.barrier !== 'hard' || !compiled.rows.some((x) => x.row === j)) continue;
    if (matches(row.match, values[row.band] ?? 0)) return K('route.insp.barrier.row', { label: causeLabel(preset, j) });
  }
  return null;
}

/** Why `compiled` (preset + line type) weighs this cell as it does. `preset` is the
 *  (patched) preset `compiled` was built from. */
export function explainCell(compiled: Compiled, values: Values, preset: RoutePreset, lineTypeId: string): CellExplain {
  const cf = cellFactors(compiled, values, lineTypeId);
  const rows: ExplainRow[] = rowFactors(compiled, values, lineTypeId).map((f) => {
    const cr = preset.rows[f.row];
    return {
      row: f.row, label: K(categoryLabelKey(routeCategory(cr))), ...(cr.note ? { note: cr.note } : {}),
      r: f.r, c: f.c, winsRoute: f.winsRoute, winsCost: f.winsCost,
      ...(cr.group !== undefined ? { group: cr.group } : {}), rule: (cr.group !== undefined && preset.combine[cr.group]) || 'multiply',
    };
  });
  const exempted: ExplainExempt[] = [];
  for (const x of compiled.exc) {
    const cr = preset.rows[x.row];
    if (!x.self.hit[values[x.self.band] ?? 0]) continue;
    const hit = (cr.except ?? []).find((e) => e.active !== false && matches(e.match, values[e.band] ?? 0));
    if (hit) exempted.push({ row: x.row, label: K(categoryLabelKey(routeCategory(cr))), ...(cr.note ? { note: cr.note } : {}), exceptLabel: hit.label });
  }
  const barrier = cf.barrier ? barrierReason(compiled, values, preset) ?? K('route.insp.barrier.unknown') : null;
  let cause: Text, head: Text;
  if (barrier) head = cause = K('route.insp.cause.blocked', { reason: barrier });
  else {
    const top = rows.filter((x) => x.winsRoute && x.r !== 1)
      .reduce<ExplainRow | null>((b, x) => (!b || Math.abs(Math.log(x.r)) > Math.abs(Math.log(b.r)) ? x : b), null);
    if (!top) head = cause = K('route.insp.cause.none');
    else {
      const p = { label: causeLabel(preset, top.row), r: fmtX(top.r) };
      head = K('route.insp.head.row', p);
      cause = top.c !== 1 ? K('route.insp.cause.rowCost', { ...p, c: fmtX(top.c) }) : K('route.insp.cause.row', p);
    }
  }
  return { routeW: cf.r, costX: cf.c, barrier, rows, exempted, cause, head };
}
