// Tests for cost.ts: PNAS hand calculation, tm-default terrain max, nodata and region
// barriers, terminal rule, escalation, the straight-line preset and LUT speed; and the
// max/min groups with a band in two groups (brute force), minRouteWeight as
// a true lower bound (random grids + the optimality proof), contingency, ROW land,
// short-line factor, regional cost sets, clamps and presetBands; row exemptions
// (`except`) in all of these; per-row $ attribution (baseUsd + perRow + otherUsd = line $, rowFactors).
import { describe, it, expect } from 'vitest';
import { ROUTE_PRESETS, routePreset, type BandName, type UploadBand, type CostRow, type RoutePreset } from '../../src/registry/route-presets.js';
import {
  buildSurfaces, cellsToCoords, compile, costPath, costPolyline, escalationFactor, greatCircleM, gridSampler, lengthFactor,
  matches, minRouteWeight, presetBands, rowFactors, straightLine, terminalCount, COST_X_MAX, METRES_PER_MILE, ROUTE_W_MAX,
  type GridConsts,
} from './cost.js';
import { MOVE_DC, MOVE_DR, solve } from './dijkstra.js';
import { provenOptimal } from './route.js';
import { validatePresetPatch } from './preset-patch.js';

const P = (id: string): RoutePreset => routePreset(id)!;
const u8 = (...v: number[]) => Uint8Array.from(v);
type BandMap = Partial<Record<BandName, Uint8Array>>;

// grid.json tables as scripts/route_grid.py writes them (ISO_CODES, LANDVAL_*).
const CONSTS: GridConsts = {
  isoreg: { codes: { 1: 'TEPPC', 2: 'CAISO', 3: 'MISO', 4: 'SPP', 5: 'ERCOT', 6: 'PJM', 7: 'NYISO', 8: 'ISONE', 9: 'Southeast' } },
  landval: { base: 100, steps: 16 },
};
const ALL_BANDS: Exclude<BandName, UploadBand>[] = ['landcover', 'slope', 'protect', 'agency', 'wildfire', 'whpclass', 'flags', 'state',
  'desig', 'flags2', 'isoreg', 'landval', 'bldg', 'wetland', 'built', 'nonres', 'bldgunk', 'aviation', 'nfhl', 'osm_flags', 'osm_maxkv', 'adj'];

/** $/m-scale factor of one cell: cost of a 230 m segment inside cell `i` of a 1-row grid ÷ base. */
function cellCostX(p: RoutePreset, lt: string, bands: BandMap, n: number, i: number, consts: GridConsts = {}): number {
  const r = costPath([[i * 250 + 10, -125], [i * 250 + 240, -125]], p, lt, gridSampler(bands, n, 1, 250), consts);
  return r.meanCostX;
}

/** Independent per-cell factors straight from the rows (no LUTs). */
function brute(p: RoutePreset, lt: string, vals: Partial<Record<BandName, number>>, consts: GridConsts = {}): { r: number; c: number } {
  let set = p.regions?.default ?? '';
  if (p.regions) {
    const iso = consts.isoreg?.codes[String(vals[p.regions.band] ?? 0)];
    if (iso !== undefined && p.regions.sets[iso] !== undefined) set = p.regions.sets[iso];
  }
  const fval = (f: CostRow['route_w'], row: CostRow, v: number) => {
    if (typeof f === 'number') return f;
    const [lo, hi] = (row.match as { range: [number, number] }).range;
    return f.ramp[0] + (f.ramp[1] - f.ramp[0]) * (v - lo) / (hi - lo);
  };
  let r = 1, c = 1;
  const groups = new Map<string, { rule: 'max' | 'min'; r: number[]; c: number[] }>();
  for (const row of p.rows) {
    if (row.line_types && !row.line_types.includes(lt)) continue;
    const v = vals[row.band] ?? 0;
    if (!matches(row.match, v)) continue;
    if (row.except?.some((e) => e.active !== false && matches(e.match, vals[e.band] ?? 0))) continue;
    const fr = fval(row.route_w, row, v);
    const fc = fval(row.cost_x, row, v) * (row.cost_by_region ? row.cost_by_region[set] : 1);
    const rule = row.group !== undefined ? p.combine[row.group] : undefined;
    if (rule === 'max' || rule === 'min') {
      const g = groups.get(row.group!) ?? { rule, r: [], c: [] };
      groups.set(row.group!, g);
      g.r.push(fr); g.c.push(fc);
    } else { r *= fr; c *= fc; }
  }
  for (const g of groups.values()) {
    r *= g.rule === 'max' ? Math.max(...g.r) : Math.min(...g.r);
    c *= g.rule === 'max' ? Math.max(...g.c) : Math.min(...g.c);
  }
  return { r: Math.min(r, ROUTE_W_MAX), c: Math.min(c, COST_X_MAX) };
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Random band values that hit the presets' rows often: a pool of interesting codes per band. */
function randomBands(rnd: () => number, n: number): BandMap {
  const pick = (pool: number[]) => pool[Math.floor(rnd() * pool.length)];
  const bits = (k: number) => { let v = 0; for (let b = 0; b < k; b++) if (rnd() < 0.3) v |= 1 << b; return v; };
  const pools: Record<Exclude<BandName, UploadBand>, () => number> = {
    landcover: () => pick([0, 11, 12, 21, 22, 23, 24, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95]),
    slope: () => pick([0, 1, 2, 3, 4, 5, 8]),
    protect: () => pick([0, 1, 2, 3, 4]) | (pick([0, 1, 2, 3]) << 4),
    agency: () => pick([0, 1, 2, 3, 9, 10, 12]),
    wildfire: () => Math.floor(rnd() * 256),
    whpclass: () => pick([0, 1, 3, 4, 5, 6]),
    flags: () => bits(6),
    state: () => pick([0, 6, 6, 32, 48, 49, 17]),
    desig: () => bits(7),
    flags2: () => bits(6),
    isoreg: () => pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    landval: () => pick([0, 1, 50, 120, 200, 255]),
    bldg: () => pick([0, 1, 1, 2, 3, 4, 10, 11, 255]),
    wetland: () => pick([0, 1, 1, 2, 27, 52, 101]),
    built: () => pick([0, 1, 2, 10, 101]),
    nonres: () => pick([0, 1, 2, 10, 101]),
    bldgunk: () => pick([0, 1, 2, 10, 101]),
    aviation: () => pick([0, 1, 1, 2, 3, 4, 5, 6]),
    nfhl: () => pick([0, 1, 1, 2, 3]),
    osm_flags: () => bits(8),
    osm_maxkv: () => Math.floor(rnd() * 256),
    adj: () => pick([0, 16, 17, 18, 19]),
  };
  const out: BandMap = {};
  for (const b of ALL_BANDS) out[b] = Uint8Array.from({ length: n }, pools[b]);
  return out;
}
const valsAt = (bands: BandMap, i: number) =>
  Object.fromEntries(Object.entries(bands).map(([b, a]) => [b, a![i]])) as Partial<Record<BandName, number>>;

describe('pnas-wu2023 hand calculation', () => {
  // 3 cells in a row, 250 m; path centre → centre = 125 + 250 + 125 m.
  // cell 0: forest 2.25 × mountain 1.75 × TNC Cat 1 1.2           = 4.725   (CA)
  // cell 1: crops 1 × rolling 1.4 × TNC Cat 2 1.1 × airport 1.2   = 1.848   (NV)
  // cell 2: wetland 1.2 × wildfire b5=255 → 5 × tubular 1.5        = 9.0     (UT)
  const bands = {
    landcover: u8(41, 82, 90),
    slope: u8(5, 2, 1),
    protect: u8(1 << 4, 2 << 4, 0),
    wildfire: u8(0, 0, 255),
    flags: u8(0, 1 << 2, 1 << 5),
    state: u8(6, 32, 49),
  };
  const r = costPath(cellsToCoords([0, 1, 2], 3, 250), P('pnas-wu2023'), 'ac500', gridSampler(bands, 3, 1, 250));

  it('reproduces line $, markups and terminals to the dollar (2018$)', () => {
    // 3,278,535 / 1609.344 $/m × (125·4.725 + 250·1.848 + 125·9.0) = 4,436,229.78
    expect(r.lengthM).toBeCloseTo(500, 9);
    expect(r.lengthFactor).toBe(1);
    expect(r.lineUsdNominal).toBeCloseTo(4_436_229.78, 1);
    expect(r.lineUsdNominal + r.markupsUsd).toBeCloseTo(5_212_569.99, 1);   // × 1.175
    expect(r.terminalCount).toBe(2);
    expect(r.terminalsUsd).toBe(175.8e6);
    expect(r.contingency).toBeNull();
    expect(r.rowLand).toBeNull();
    expect(r.totalNominal).toBeCloseTo(181_012_569.99, 1);
    expect(r.total2025).toBeCloseTo(181_012_569.99 * 1.04 ** 7, 1);
    expect(r.dollarYear).toBe(2018);
    expect(r.mitigationUsd.mid).toBe(0);
    expect(r.barrierM).toBe(0);
  });

  it('reports per-band mean multipliers', () => {
    const lc = r.perBand.find((b) => b.band === 'landcover')!;
    expect(lc.meanCostX).toBeCloseTo((125 * 2.25 + 250 * 1 + 125 * 1.2) / 500, 6);
    expect(lc.affectedM).toBeCloseTo(250, 6);
    expect(r.perBand.find((b) => b.band === 'wildfire')!.meanCostX).toBeCloseTo((375 + 125 * 5) / 500, 6);
  });

  it('per-cell cost multipliers and the routing surface, multiplicative everywhere', () => {
    [4.725, 1.848, 9].forEach((x, i) => expect(cellCostX(P('pnas-wu2023'), 'ac500', bands, 3, i)).toBeCloseTo(x, 9));
    const s = buildSurfaces(P('pnas-wu2023'), 'ac500', bands, 3, 1);
    expect(s.route[0]).toBeCloseTo(2.25 * 1.75 * 100, 3);
    expect(Array.from(s.barrier)).toEqual([0, 0, 0]);
  });

  it('wildfire ramp is 1 + 4·(b5 − 1)/254', () => {
    const b = { wildfire: u8(0, 1, 128, 255), state: u8(6, 6, 6, 6) };
    expect(Array.from(buildSurfaces(P('pnas-wu2023'), 'ac500', b, 4, 1).route)).toEqual([1, 1, 1 + 4 * 127 / 254, 5].map(Math.fround));
    [1, 1, 1 + 4 * 127 / 254, 5].forEach((x, i) => expect(cellCostX(P('pnas-wu2023'), 'ac500', b, 4, i)).toBeCloseTo(x, 12));
  });

  it('V11-1: tribal land routes at 15 and costs nothing extra', () => {
    const b = { flags: u8(1, 0), state: u8(6, 6) };
    expect(Array.from(buildSurfaces(P('pnas-wu2023'), 'ac500', b, 2, 1).route)).toEqual([15, 1]);
    expect(cellCostX(P('pnas-wu2023'), 'ac500', b, 2, 0)).toBeCloseTo(1, 12);
  });
});

describe('tm-default', () => {
  it('terrain = max(landcover, slope): forest + mountain → 2.25, not 3.94', () => {
    const b = { landcover: u8(41, 82, 31), slope: u8(5, 5, 1), state: u8(6, 6, 6) };
    [2.25, 1.75, 1.05].forEach((x, i) => expect(cellCostX(P('tm-default'), 'ac500', b, 3, i)).toBeCloseTo(x, 12));
    expect(Array.from(buildSurfaces(P('tm-default'), 'ac500', b, 3, 1).route)).toEqual([2.25, 1.75, 1.05].map(Math.fround));
  });

  it('military from PAD-US and OSM counts once (max group)', () => {
    const s = buildSurfaces(P('tm-default'), 'ac500', { flags: u8(1 << 1), osm_flags: u8(1 << 7), state: u8(6) }, 1, 1);
    expect(s.route[0]).toBe(100);
  });

  it('parallel is a min group: §368 ∩ existing line → 0.5, not 0.4; neither → 1', () => {
    const b = { flags: u8(1 << 4, 1 << 4, 0, 0), adj: u8(17, 16, 18, 19), state: u8(6, 6, 6, 6) };
    expect(Array.from(buildSurfaces(P('tm-default'), 'ac500', b, 4, 1).route)).toEqual([0.5, 0.8, 0.5, 1].map(Math.fround));
    expect(minRouteWeight(P('tm-default'), 'ac500')).toBe(0.5);
  });

  it('protection is a max group: WSA on GAP 2 → 1000, not 10000; GAP 1 → 100', () => {
    const b = { protect: u8(2, 1, 0), desig: u8(1, 0, 1 << 2), state: u8(6, 6, 6) };
    expect(Array.from(buildSurfaces(P('tm-default'), 'ac500', b, 3, 1).route)).toEqual([1000, 100, 10]);   // WSA 1000 × GAP 2 10 would be 10000 if the group multiplied
  });

  it('NPS Preserve bit 7 weighs 1 in the protection max group; its Excl. tick gives 1000', () => {
    const b = { protect: u8(130, 131, 132, 2), state: u8(6, 6, 6, 6) };
    const tm = P('tm-default');
    const route = (p: typeof tm) => Array.from(buildSurfaces(p, 'ac500', b, 4, 1).route);
    expect(route(tm)).toEqual([10, 2, 1, 10]);
    const PRES = tm.rows.findIndex((r) => r.band === 'protect' && 'bit' in r.match && r.match.bit === 7);
    const v = validatePresetPatch(tm, { rows: [{ row: PRES, band: 'protect', note: tm.rows[PRES].note, route_w: 1000 }] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(route(v.result)).toEqual([1000, 1000, 1000, 10]);
    expect(minRouteWeight(tm, 'ac500')).toBe(0.5);
  });

  it('a wetland counts once: NWI rows skip cells NLCD already weights as forest or wetland', () => {
    const lc = u8(90, 41, 71, 71, 71, 95), wet = u8(60, 60, 60, 30, 1, 101), state = u8(6, 6, 6, 6, 6, 6);
    const route = (b: BandMap) => Array.from(buildSurfaces(P('tm-default'), 'ac500', b, 6, 1).route);
    const landOnly = route({ landcover: lc, state });
    expect(route({ landcover: lc, wetland: wet, state })).toEqual([landOnly[0], landOnly[1], 2.5, 1.5, landOnly[4], landOnly[5]].map(Math.fround));
    expect(landOnly[4]).toBe(Math.fround(1));
  });

  it('structure multiplier follows the line type', () => {
    const b = { flags: u8(1 << 5), state: u8(6) };
    expect(cellCostX(P('tm-default'), 'ac500', b, 1, 0)).toBeCloseTo(1.5, 12);
    expect(cellCostX(P('tm-default'), 'ac345', b, 1, 0)).toBeCloseTo(1.3, 12);
    expect(cellCostX(P('tm-default'), 'ac230', b, 1, 0)).toBeCloseTo(1.1, 12);
  });

  it('nodata (0) is factor 1 in every band; state 0 is a barrier', () => {
    const b: BandMap = Object.fromEntries(ALL_BANDS.map((n) => [n, new Uint8Array(2)]));
    b.state = u8(6, 0);
    const s = buildSurfaces(P('tm-default'), 'ac500', b, 2, 1);
    expect(Array.from(s.route)).toEqual([1, 1]);
    expect(Array.from(s.barrier)).toEqual([0, 1]);
    expect(cellCostX(P('tm-default'), 'ac500', b, 2, 0, CONSTS)).toBeCloseTo(1, 12);
  });

  it('mitigation: GAP 1 in CA is class 3 → 5.5 % of line $; tribal miles reported', () => {
    const bands = { protect: u8(1, 1), flags: u8(0, 1), state: u8(6, 6) };
    const r = costPath(cellsToCoords([0, 1], 2, 250), P('tm-default'), 'ac500', gridSampler(bands, 2, 1, 250));
    expect(r.mitigationUsd.mid).toBeCloseTo(r.lineUsdNominal * 0.055, 6);
    expect(r.mitigationUsd.low).toBeCloseTo(r.mitigationUsd.mid * 0.7, 6);
    expect(r.tribalMiles).toBeCloseTo(125 / METRES_PER_MILE, 9);
    expect(r.notes.some((n) => n.includes('consent'))).toBe(true);
  });

  it('345 kV terminals: 2 × B&V 2014 T4-6 station ($22,286,886)', () => {
    const r = costPath([[0, -125], [250, -125]], P('tm-default'), 'ac345', gridSampler({ state: u8(6, 6) }, 2, 1, 250));
    expect(r.terminalsUsd).toBe(2 * 22_286_886);
  });

  it('every number carries a src', () => {
    const p = P('tm-default');
    const has = (s?: string) => !!s && s.trim().length > 0;
    for (const row of p.rows) expect(has(row.src), row.note).toBe(true);
    for (const s of [p.regions?.src, p.contingency?.src, p.row_land?.src, p.row_land?.width_src, p.row_land?.developed_src, p.length_factor?.src]) {
      expect(has(s)).toBe(true);
    }
  });
});

describe('band in two groups: LUTs equal a row-by-row brute force', () => {
  // flags sits in `military` (max), `parallel` (min) and has ungrouped rows; its ungrouped LUT is folded once.
  const two: RoutePreset = {
    ...P('tm-default'),
    id: 'two-groups',
    combine: { m: 'max', p: 'min', x: 'multiply' },
    rows: [
      { band: 'flags', match: { bit: 1 }, route_w: 1000, cost_x: 1.1, group: 'm', src: 't' },
      { band: 'osm_flags', match: { bit: 7 }, route_w: 700, cost_x: 1.3, group: 'm', src: 't' },
      { band: 'flags', match: { bit: 4 }, route_w: 0.8, cost_x: 0.9, group: 'p', src: 't' },
      { band: 'adj', match: { field: { shift: 0, mask: 3 }, codes: [1, 2] }, route_w: 0.5, cost_x: 0.95, group: 'p', src: 't',
        except: [{ band: 'landcover', match: { codes: [41] }, label: 't', src: 't' }] },
      { band: 'flags', match: { bit: 3 }, route_w: 5, cost_x: 1.05, src: 't',
        except: [{ band: 'desig', match: { bit: 0 }, label: 't', src: 't' }, { band: 'osm_flags', match: { bit: 7 }, label: 't', src: 't', active: false }] },
      { band: 'flags2', match: { bit: 0 }, route_w: 20, cost_x: 1.4, src: 't',
        except: [{ band: 'flags', match: { bit: 4 }, label: 't', src: 't' }, { band: 'adj', match: { field: { shift: 0, mask: 3 }, codes: [1] }, label: 't', src: 't' }] },
      { band: 'flags', match: { bit: 2 }, route_w: 3, cost_x: 1.2, group: 'x', src: 't' },
      { band: 'landcover', match: { codes: [41, 42] }, route_w: 2, cost_x: 2, src: 't' },
    ],
  };
  it.each([two, ...ROUTE_PRESETS].map((p) => [p.id, p] as const))('%s: every cell, route surface and cost', (_id, p) => {
    const rnd = rng(7), n = 600;
    const bands = randomBands(rnd, n);
    for (const lt of Object.keys(p.line_types)) {
      const s = buildSurfaces(p, lt, bands, n, 1);
      for (let i = 0; i < n; i++) {
        const want = brute(p, lt, valsAt(bands, i), CONSTS);
        // float32 products: equal to the float64 brute force within float32 rounding of each term
        expect(Math.abs(s.route[i] - want.r), `${lt} cell ${i}`).toBeLessThanOrEqual(want.r * 1e-6);
        if (i < 120) expect(cellCostX(p, lt, bands, n, i, CONSTS), `${lt} cell ${i} cost`).toBeCloseTo(want.c, 10);
      }
    }
  });
});

describe('minRouteWeight is a true lower bound', () => {
  // Groups whose factors are all > 1: a cell matching none of a group's rows gets 1,
  // so "smallest factor" alone (2 × 1000 here) would overstate the bound.
  const high: RoutePreset = {
    ...P('tm-default'),
    id: 'high-groups',
    combine: { prot: 'min', mil: 'max' },
    rows: [
      { band: 'protect', match: { codes: [1] }, route_w: 2, cost_x: 1, group: 'prot', src: 't' },
      { band: 'protect', match: { codes: [2] }, route_w: 3, cost_x: 1, group: 'prot', src: 't' },
      { band: 'desig', match: { bit: 0 }, route_w: 4, cost_x: 1, group: 'prot', src: 't' },
      { band: 'flags', match: { bit: 1 }, route_w: 1000, cost_x: 1, group: 'mil', src: 't',
        except: [{ band: 'adj', match: { field: { shift: 0, mask: 3 }, codes: [1] }, label: 't', src: 't' }] },
      { band: 'osm_flags', match: { bit: 7 }, route_w: 1000, cost_x: 1, group: 'mil', src: 't' },
      { band: 'landcover', match: { codes: [41] }, route_w: 1.5, cost_x: 1, src: 't',
        except: [{ band: 'flags', match: { bit: 4 }, label: 't', src: 't' }] },
    ],
  };
  // Discounts in a min group and ungrouped: the bound is below 1.
  const low: RoutePreset = {
    ...high,
    id: 'low-groups',
    combine: { par: 'min', mil: 'max' },
    rows: [
      { band: 'flags', match: { bit: 4 }, route_w: 0.8, cost_x: 1, group: 'par', src: 't' },
      { band: 'adj', match: { field: { shift: 0, mask: 3 }, codes: [1, 2] }, route_w: 0.5, cost_x: 1, group: 'par', src: 't',
        except: [{ band: 'landcover', match: { codes: [41] }, label: 't', src: 't' }] },
      { band: 'flags', match: { bit: 1 }, route_w: 3, cost_x: 1, group: 'mil', src: 't' },
      { band: 'landcover', match: { codes: [41] }, route_w: 1.5, cost_x: 1, src: 't' },
      { band: 'landcover', match: { codes: [11] }, route_w: 0.7, cost_x: 1, src: 't' },
    ],
  };
  const naive = (p: RoutePreset) => {  // the unsound rule: each group's smallest factor
    const g = new Map<string, number>();
    let m = 1;
    for (const r of p.rows) {
      const f = r.route_w as number;
      if (r.group) g.set(r.group, Math.min(g.get(r.group) ?? Infinity, f)); else m *= Math.min(1, f);
    }
    for (const v of g.values()) m *= v;
    return m;
  };

  it('bounds per preset', () => {
    expect(minRouteWeight(high, 'ac500')).toBe(1);
    expect(minRouteWeight(low, 'ac500')).toBeCloseTo(0.35, 12);
    expect(naive(high)).toBe(2000);
    expect(minRouteWeight(P('pnas-wu2023'), 'ac500')).toBe(1);
    expect(minRouteWeight(P('straight-line-quick'), 'ac500')).toBe(1);
  });

  it('every cell ≥ minRouteWeight, and the proof claims only true optima', () => {
    const rnd = rng(4242);
    const W = 44, H = 32, n = W * H, cellM = 250;
    let proven = 0, open = 0, naiveOverclaims = 0;
    for (let trial = 0; trial < 120; trial++) {
      const p = Math.floor(trial / 3) % 2 ? high : low, cheapOutside = [0, 0.2, 0.9][trial % 3];
      // Inside a capsule round A–B most cells match no high row; outside, a varying share (0 / 20 / 90 %).
      const a = [5 + Math.floor(rnd() * 6), 8 + Math.floor(rnd() * 16)], b = [33 + Math.floor(rnd() * 6), 8 + Math.floor(rnd() * 16)];
      const B = 3 + (trial % 5);
      const bands = randomBands(rnd, n);
      const mask = new Uint8Array(n);
      const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const t = Math.max(0, Math.min(1, ((c - a[0]) * dx + (r - a[1]) * dy) / dd));
        const i = r * W + c;
        mask[i] = (c - a[0] - t * dx) ** 2 + (r - a[1] - t * dy) ** 2 <= B * B ? 1 : 0;
        bands.state![i] = 6;
        // A cleared cell matches no high row: weight 1 (or 1.5 forest, or a discount), near minW.
        if (mask[i] ? rnd() < 0.85 : rnd() < cheapOutside) { bands.protect![i] = 0; bands.desig![i] = 0; bands.flags![i] &= ~2; bands.osm_flags![i] = 0; }
      }
      const s = buildSurfaces(p, 'ac500', bands, W, H);
      const minW = minRouteWeight(p, 'ac500');
      for (let i = 0; i < n; i++) expect(s.route[i]).toBeGreaterThanOrEqual(Math.fround(minW) * (1 - 1e-7));
      const start = a[1] * W + a[0], goal = b[1] * W + b[0];
      const g = { width: W, height: H, cost: s.route, barrier: s.barrier, cellM };
      const sol = solve({ ...g, mask, start, goal });
      if (!sol.ok) continue;
      const C = sol.cost;
      const edge: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const r = Math.floor(i / W), c = i % W;
        if (MOVE_DR.some((dr, k) => { const rr = r + dr, cc = c + MOVE_DC[k]; return rr >= 0 && rr < H && cc >= 0 && cc < W && !mask[rr * W + cc]; })) edge.push(i);
      }
      const full = solve({ ...g, start, goal });
      if (!full.ok) throw new Error(full.error);
      if (provenOptimal({ ...g, mask, maxCells: n }, start, goal, C, sol.dist, sol.scratch, edge, minW)) {
        proven++;
        expect(full.cost).toBeGreaterThanOrEqual(C * (1 - 1e-12));
      } else open++;
      const sol2 = solve({ ...g, mask, start, goal });
      if (sol2.ok && provenOptimal({ ...g, mask, maxCells: n }, start, goal, C, sol2.dist, sol2.scratch, edge, naive(p))
        && full.cost < C * (1 - 1e-9)) naiveOverclaims++;
    }
    // The unsound "smallest factor" bound does claim falsely here, so the test can see one.
    expect(naiveOverclaims).toBeGreaterThan(0);
    expect(proven).toBeGreaterThan(5);
    expect(open).toBeGreaterThan(5);
  }, 20_000);
});

describe('contingency', () => {
  it('tm-default: total = (line + markups + mitigation + terminals + ROW land) × 1.30', () => {
    const bands = { protect: u8(1, 0, 3), landcover: u8(41, 23, 82), landval: u8(120, 140, 100), agency: u8(2, 1, 1), state: u8(6, 6, 32), isoreg: u8(2, 2, 1) };
    const r = costPath(cellsToCoords([0, 1, 2], 3, 250), P('tm-default'), 'ac500', gridSampler(bands, 3, 1, 250), CONSTS);
    const sub = r.lineUsdNominal + r.markupsUsd + r.mitigationUsd.mid + r.terminalsUsd! + r.rowLand!.usd;
    expect(r.mitigationUsd.mid).toBeGreaterThan(0);
    expect(r.rowLand!.usd).toBeGreaterThan(0);
    expect(r.contingency).toMatchObject({ pct: 0.3, label: 'contingency (rough early estimate)' });
    expect(r.contingency!.usd).toBeCloseTo(0.3 * sub, 4);
    expect(r.totalNominal).toBeCloseTo(sub * 1.3, 4);
    expect(r.total2025).toBeCloseTo(sub * 1.3 * escalationFactor(2014, 2025), 3);
    expect(r.band.high).toBeCloseTo(r.total2025 * 1.5, 3);
  });
  it('pnas-wu2023 and straight-line have none', () => {
    expect(P('pnas-wu2023').contingency).toBeUndefined();
    expect(straightLine([-112, 40.7], [-116.2, 43.6], P('straight-line-quick'), 'ac500').contingency).toBeNull();
  });
});

describe('ROW land', () => {
  // 4 cells, ac345 (200 ft ROW), straight segment through each cell's middle for 250 m:
  // 0 private farmland, code 100; 1 developed (NLCD 23), code 100 → × 5;
  // 2 tribal, code 100 → $0; 3 BLM (agency 2), code 100 → same as private.
  const bands = {
    landcover: u8(82, 23, 82, 82), landval: u8(100, 100, 100, 100), flags: u8(0, 0, 1, 0),
    agency: u8(1, 1, 12, 2), state: u8(49, 49, 49, 49), isoreg: u8(1, 1, 1, 1),
  };
  const r = costPath([[0, -125], [1000, -125]], P('tm-default'), 'ac345', gridSampler(bands, 4, 1, 250), CONSTS);
  const perAc = 100 * 2 ** (99 / 16);                          // decode(100) $/ac, 2022$
  const acPerM = 200 * 0.3048 / 4046.8564224;                   // acres per metre of 200 ft ROW
  const cell = 250 * acPerM * perAc * escalationFactor(2022, 2014);

  it('hand calculation: private 1, developed 5, tribal 0, BLM = private', () => {
    expect(r.rowLand!.usd).toBeCloseTo(cell * (1 + 5 + 0 + 1), 4);
    expect(r.rowLand!.note).toContain('Federal ROW priced at county private land value');
    expect(r.tribalMiles).toBeCloseTo(250 / METRES_PER_MILE, 9);
  });

  it('a BLM cell costs the same as a private cell', () => {
    const one = (i: number) => costPath([[i * 250, -125], [i * 250 + 250, -125]], P('tm-default'), 'ac345', gridSampler(bands, 4, 1, 250), CONSTS).rowLand!.usd;
    expect(one(3)).toBeCloseTo(one(0), 9);
    expect(one(2)).toBe(0);
    expect(one(1)).toBeCloseTo(5 * one(0), 6);
  });

  it('markups apply to line $ + ROW land', () => {
    expect(r.markupsUsd).toBeCloseTo((r.lineUsdNominal + r.rowLand!.usd) * 0.175, 4);
  });

  it('without grid.json constants ROW land is not costed, and the notes say so', () => {
    const r2 = costPath([[0, -125], [1000, -125]], P('tm-default'), 'ac345', gridSampler(bands, 4, 1, 250));
    expect(r2.rowLand).toBeNull();
    expect(r2.notes.some((n) => n.includes('ROW land not costed'))).toBe(true);
    expect(r2.notes.some((n) => n.includes('Regional cost sets not applied'))).toBe(true);
  });

  it('cells without a land value are charged $0 and reported', () => {
    const r3 = costPath([[0, -125], [250, -125]], P('tm-default'), 'ac345', gridSampler({ state: u8(6) }, 1, 1, 250), CONSTS);
    expect(r3.rowLand!.usd).toBe(0);
    expect(r3.rowLand!.missingMi).toBeCloseTo(250 / METRES_PER_MILE, 12);
    expect(r3.notes.some((n) => n.includes('without a county land value'))).toBe(true);
    expect(r.rowLand!.missingMi).toBe(0);
  });
});

describe('short-line factor', () => {
  it.each([[2.99, 1.5], [3, 1.2], [10, 1.2], [10.01, 1], [0.1, 1.5], [400, 1]])('%d mi → ×%d', (mi, x) => {
    expect(lengthFactor(P('tm-default'), mi)).toBe(x);
  });
  it('applies to line $ (and its mitigation) only; pnas has none', () => {
    expect(lengthFactor(P('pnas-wu2023'), 1)).toBe(1);
    const bands = { protect: u8(1, 1), state: u8(6, 6) };
    const p = P('tm-default'), q = { ...p, length_factor: undefined };
    const s = gridSampler(bands, 2, 1, 250), c = cellsToCoords([0, 1], 2, 250);
    const a = costPath(c, p, 'ac500', s), b = costPath(c, q, 'ac500', s);
    expect(a.lengthFactor).toBe(1.5);
    expect(a.lineUsdNominal).toBeCloseTo(b.lineUsdNominal * 1.5, 6);
    expect(a.mitigationUsd.mid).toBeCloseTo(b.mitigationUsd.mid * 1.5, 6);
    expect(a.terminalsUsd).toBe(b.terminalsUsd);
  });
});

describe('regional cost sets', () => {
  // forest in every isoreg code: TEPPC 2.25, SCE 3 (CAISO, PJM, NYISO, ISONE), MISO 1.2 (MISO, SPP), Southeast 1.47 (ERCOT, Southeast); 0 → TEPPC.
  const iso = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const want = [2.25, 2.25, 3, 1.2, 1.2, 1.47, 3, 3, 3, 1.47];
  const bands = { landcover: Uint8Array.from(iso, () => 41), isoreg: Uint8Array.from(iso), state: Uint8Array.from(iso, () => 6) };

  it('each cell takes its set; routing is not regional', () => {
    iso.forEach((_, i) => expect(cellCostX(P('tm-default'), 'ac500', bands, 10, i, CONSTS), `isoreg ${i}`).toBeCloseTo(want[i], 12));
    expect(new Set(buildSurfaces(P('tm-default'), 'ac500', bands, 10, 1).route)).toEqual(new Set([2.25].map(Math.fround)));
  });

  it("a cost_x edit on a cost_by_region row is one scalar onto every set's value", () => {
    const p = P('tm-default');
    const edited = { ...p, rows: p.rows.map((r) => (r.note === 'forest' ? { ...r, cost_x: 2 } : r)) };
    iso.forEach((_, i) => expect(cellCostX(edited, 'ac500', bands, 10, i, CONSTS)).toBeCloseTo(2 * want[i], 12));
  });

  it('regionM: metres costed with each regional set along the line', () => {
    const four = { landcover: u8(41, 41, 41, 41), isoreg: u8(1, 2, 2, 3), state: u8(6, 6, 6, 6) };
    const r = costPath([[0, -125], [1000, -125]], P('tm-default'), 'ac500', gridSampler(four, 4, 1, 250), CONSTS);
    expect(r.regionM).toEqual({ TEPPC: 250, SCE: 500, MISO: 250 });
    expect(costPath([[0, -125], [250, -125]], P('pnas-wu2023'), 'ac500', gridSampler(four, 4, 1, 250)).regionM).toBeUndefined();
  });

  it('an ISO name with no set takes the default', () => {
    const c = { ...CONSTS, isoreg: { codes: { 1: 'TEPPC', 2: 'Elsewhere' } } };
    expect(cellCostX(P('tm-default'), 'ac500', bands, 10, 2, c)).toBeCloseTo(2.25, 12);
  });

  it('miles on cells whose ISO code no set names are counted in a note (code 0 = no BA is not)', () => {
    const c = { ...CONSTS, isoreg: { codes: { 1: 'TEPPC', 2: 'Elsewhere' } } };
    const two = { landcover: u8(41, 41, 41, 41), isoreg: u8(0, 1, 2, 3), state: u8(6, 6, 6, 6) };
    const r = costPath([[0, -125], [1000, -125]], P('tm-default'), 'ac500', gridSampler(two, 4, 1, 250), c);
    const note = r.notes.find((n) => n.includes('no regional cost set names'));
    expect(note).toBe(`${(500 / METRES_PER_MILE).toFixed(1)} mi on cells whose ISO code no regional cost set names, costed with the TEPPC set.`);
    const ok = costPath([[0, -125], [1000, -125]], P('tm-default'), 'ac500', gridSampler({ ...two, isoreg: u8(0, 1, 1, 1) }, 4, 1, 250), c);
    expect(ok.notes.some((n) => n.includes('no regional cost set names'))).toBe(false);
  });
});

describe('clamps', () => {
  const big: RoutePreset = {
    ...P('pnas-wu2023'), id: 'big', combine: {},
    rows: (['landcover', 'slope', 'protect', 'whpclass'] as BandName[]).map((band) => ({ band, match: { codes: [1] }, route_w: 1e4, cost_x: 1e3, src: 't' })),
  };
  it('cell routing weight ≤ 1e6 and cost multiplier ≤ 1e4, never ∞', () => {
    const b = { landcover: u8(1, 1, 0), slope: u8(1, 1, 0), protect: u8(1, 0, 0), whpclass: u8(1, 0, 0), state: u8(6, 6, 6) };
    const s = buildSurfaces(big, 'ac500', b, 3, 1);
    expect(Array.from(s.route)).toEqual([1e6, 1e6, 1]);
    expect(cellCostX(big, 'ac500', b, 3, 0)).toBe(1e4);
    expect(cellCostX(big, 'ac500', b, 3, 1)).toBe(1e4);
    const huge = { ...big, rows: big.rows.map((r) => ({ ...r, route_w: 1e30 })) };
    expect(buildSurfaces(huge, 'ac500', b, 3, 1).route[0]).toBe(1e6);
  });
});

describe('row exemptions (except)', () => {
  const tm = P('tm-default');
  const phma = tm.rows.findIndex((r) => r.band === 'flags2' && 'bit' in r.match && r.match.bit === 0);
  const withAdj = (on: boolean): RoutePreset => ({
    ...tm, rows: tm.rows.map((r, i) => (i !== phma ? r : { ...r, except: r.except!.map((e) => (e.band === 'adj' ? { ...e, active: on } : e)) })),
  });
  // cells: PHMA; PHMA ∩ §368; PHMA ∩ on-line (adj class 1); PHMA ∩ adj class 3; no PHMA
  const b: BandMap = { flags2: u8(1, 1, 1, 1, 0), flags: u8(0, 16, 0, 0, 0), adj: u8(16, 16, 17, 19, 16), state: u8(6, 6, 6, 6, 6) };
  const routeW = (p: RoutePreset) => Array.from(buildSurfaces(p, 'ac500', b, 5, 1).route);

  it('tm-default PHMA row: §368 active, both existing-line adjacencies shipped off', () => {
    expect(tm.rows[phma].route_w).toBe(20);
    expect(tm.rows[phma].except!.map((e) => [e.band, e.active !== false])).toEqual([['flags', true], ['adj', false], ['adj', false]]);
  });
  it('the 100–229 kV entry exempts PHMA on/beside a 100–229 kV line only, and only when switched on', () => {
    const lo = tm.rows[phma].except!.findIndex((e) => e.label.startsWith('on/beside existing 100–229'));
    const on: RoutePreset = { ...tm, rows: tm.rows.map((r, i) => (i !== phma ? r : { ...r, except: r.except!.map((e, j) => (j === lo ? { ...e, active: true } : e)) })) };
    // cells: PHMA on a 100–229 kV line (adj 16 + 32); PHMA on a ≥ 230 kV line (adj 17)
    const c: BandMap = { flags2: u8(1, 1), flags: u8(0, 0), adj: u8(48, 17), state: u8(6, 6) };
    const w = (p: RoutePreset) => Array.from(buildSurfaces(p, 'ac500', c, 2, 1).route).map((x) => +x.toFixed(6));
    expect(w(tm)).toEqual([20 * 0.7, 20 * 0.5]);
    expect(w(on)).toEqual([0.7, 20 * 0.5]);
  });
  it('a §368 cell drops the PHMA factor (the parallel discount still applies); adjacency only when switched on', () => {
    expect(routeW(tm).map((x) => +x.toFixed(6))).toEqual([20, 0.8, 20 * 0.5, 20, 1]);
    expect(routeW(withAdj(true)).map((x) => +x.toFixed(6))).toEqual([20, 0.8, 0.5, 20, 1]);
    for (const p of [tm, withAdj(true)]) for (let i = 0; i < 5; i++) expect(routeW(p)[i]).toBeCloseTo(brute(p, 'ac500', valsAt(b, i)).r, 5);
  });
  it('costPath charges the exempted cell factor 1 and its per-band table shows it', () => {
    const cx: RoutePreset = { ...tm, rows: tm.rows.map((r, i) => (i === phma ? { ...r, cost_x: 3 } : r)) };
    expect(cellCostX(cx, 'ac500', b, 5, 0)).toBeCloseTo(3 * brute(cx, 'ac500', valsAt(b, 0)).c / 3, 10);
    expect(cellCostX(cx, 'ac500', b, 5, 1)).toBeCloseTo(brute(cx, 'ac500', valsAt(b, 1)).c, 10);
    expect(cellCostX(cx, 'ac500', b, 5, 0) / cellCostX(cx, 'ac500', b, 5, 1)).toBeCloseTo(3, 10);
    const r = costPath([[1 * 250 + 10, -125], [1 * 250 + 240, -125]], cx, 'ac500', gridSampler(b, 5, 1, 250));
    const f2 = r.perBand.find((x) => x.band === 'flags2')!;
    expect(f2.meanCostX).toBeCloseTo(1, 12);
    expect(f2.affectedM).toBe(0);
  });
  it('minRouteWeight is unchanged by except', () => {
    const strip = (p: RoutePreset): RoutePreset => ({ ...p, rows: p.rows.map(({ except: _e, ...r }) => r) });
    for (const p of [tm, withAdj(true)]) expect(minRouteWeight(p, 'ac500')).toBe(minRouteWeight(strip(p), 'ac500'));
  });
});

describe('presetBands', () => {
  it('pnas-wu2023 reads exactly 9 bands', () => {
    expect([...presetBands(P('pnas-wu2023'))].sort()).toEqual(['aviation', 'flags', 'landcover', 'nfhl', 'osm_flags', 'protect', 'slope', 'state', 'wildfire']);
  });

  it('tm-default reads the bldg band (its rows would read nodata otherwise)', () => {
    expect(presetBands(P('tm-default')).has('bldg')).toBe(true);
    expect(presetBands(P('pnas-wu2023')).has('bldg')).toBe(false);
  });

  it('includes the bands of active except entries only', () => {
    const base = P('pnas-wu2023');
    const row = (active: boolean): CostRow => ({ band: 'landcover', match: { codes: [41] }, route_w: 3, cost_x: 2, src: 't',
      except: [{ band: 'desig', match: { bit: 0 }, label: 't', src: 't', active }] });
    expect(presetBands({ ...base, rows: [...base.rows, row(true)] }).has('desig')).toBe(true);
    expect(presetBands({ ...base, rows: [...base.rows, row(false)] }).has('desig')).toBe(false);
  });

  it('prints the bands per preset', () => {
    for (const p of ROUTE_PRESETS) console.log(`presetBands ${p.id} (${presetBands(p).size}): ${[...presetBands(p)].sort().join(', ')}`);
  });

  it.each(ROUTE_PRESETS.map((p) => [p.id, p] as const))('%s: costPath with all bands = costPath with presetBands only', (_id, p) => {
    const rnd = rng(11), W = 30, H = 20;
    const all = randomBands(rnd, W * H);
    all.state = Uint8Array.from({ length: W * H }, () => [6, 32, 49, 17][Math.floor(rnd() * 4)]);
    const keep = presetBands(p);
    const some = Object.fromEntries(Object.entries(all).filter(([b]) => keep.has(b as BandName))) as BandMap;
    const coords: [number, number][] = Array.from({ length: 12 }, () => [rnd() * W * 250, -rnd() * H * 250]);
    for (const lt of Object.keys(p.line_types)) {
      const a = costPath(coords, p, lt, gridSampler(all, W, H, 250), CONSTS);
      const b = costPath(coords, p, lt, gridSampler(some, W, H, 250), CONSTS);
      expect(b).toEqual(a);
      expect(Array.from(buildSurfaces(p, lt, some, W, H).route)).toEqual(Array.from(buildSurfaces(p, lt, all, W, H).route));
    }
  });
});

describe('exact traversal', () => {
  it('charges a cell the line only clips at a corner, for its true length', () => {
    // 2 × 2 cells of 250 m; (125, −375) → (400, −50) clips cell (row 0, col 0) — forest
    // and tribal — between y = −250 (t = 125/325) and x = 250 (t = 125/275).
    const bands = { landcover: u8(41, 82, 82, 82), flags: u8(1, 0, 0, 0), state: u8(6, 6, 6, 6) };
    const L = Math.hypot(275, 325), clip = (125 / 275 - 125 / 325) * L;
    const r = costPath([[125, -375], [400, -50]], P('tm-default'), 'ac500', gridSampler(bands, 2, 2, 250));
    expect(clip).toBeGreaterThan(29);
    expect(r.tribalMiles * METRES_PER_MILE).toBeCloseTo(clip, 6);
    expect(r.meanCostX).toBeCloseTo((L + 1.25 * clip) / L, 9);
    expect(r.perBand.find((b) => b.band === 'flags')!.affectedM).toBeCloseTo(clip, 6);
  });

  it('a line through a cell corner charges nothing to the two cells it squeezes between', () => {
    const bands = { landcover: u8(82, 41, 41, 82), flags: u8(0, 1, 1, 0), state: u8(6, 6, 6, 6) };
    const r = costPath(cellsToCoords([0, 3], 2, 250), P('tm-default'), 'ac500', gridSampler(bands, 2, 2, 250));
    expect(r.tribalMiles).toBe(0);
    expect(r.meanCostX).toBeCloseTo(1, 9);
  });
});

describe('region rules', () => {
  it('pnas-wu2023: states outside the 11 western FIPS are barriers', () => {
    const s = buildSurfaces(P('pnas-wu2023'), 'ac500', { state: u8(6, 48, 0, 56, 17) }, 5, 1);
    expect(Array.from(s.barrier)).toEqual([0, 1, 1, 0, 1]);
  });
  it('a missing state band is all barrier', () => {
    expect(Array.from(buildSurfaces(P('tm-default'), 'ac500', {}, 2, 1).barrier)).toEqual([1, 1]);
  });
});

describe('terminal count', () => {
  const rule = P('pnas-wu2023').line_types.ac500.terminals;
  it.each([[399, 2], [400, 2], [799, 2], [801, 3], [1201, 4]])('%d mi → %d', (mi, n) => {
    expect(terminalCount(rule, mi)).toBe(n);
  });
});

describe('lower-voltage line types (69-161 kV)', () => {
  const lts = P('tm-default').line_types;
  const ids = ['ac161', 'ac138', 'ac115', 'ac69'];
  it('are listed in voltage order, before the HVDC type, and shared with straight-line-quick', () => {
    expect(Object.keys(lts)).toEqual(['ac500', 'ac345', 'ac230', ...ids, 'dc500']);
    expect(Object.keys(P('straight-line-quick').line_types)).toEqual(Object.keys(lts));
    expect(Object.keys(P('pnas-wu2023').line_types)).not.toContain('ac138');
  });
  it('step down from 230 kV in cost, terminals and ROW width, and say they are derived', () => {
    const kv = [230, 161, 138, 115, 69];
    const ac = ['ac230', ...ids];
    for (let i = 1; i < ac.length; i++) {
      expect(lts[ac[i]].kv.value).toBe(kv[i]);
      expect(lts[ac[i]].base_per_mi.usd).toBeLessThan(lts[ac[i - 1]].base_per_mi.usd);
      expect(lts[ac[i]].terminals.usd_each!).toBeLessThan(lts[ac[i - 1]].terminals.usd_each!);
      expect(lts[ac[i]].base_per_mi.src).toContain('our derivation');
      expect(lts[ac[i]].terminals.src).toContain('our derivation');
    }
    expect(lts.ac138.base_per_mi.usd).toBeCloseTo(1_536_400 * 0.844, -3);
    expect(lts.ac138.terminals.usd_each).toBeCloseTo(15_142_377 * 0.822, -4);
    const w = P('tm-default').row_land!.width_ft;
    expect(ids.map((i) => w[i])).toEqual([100, 95, 90, 80]);
  });
  it('take the 230 kV structure multiplier (1.1) and cost a 1 mi segment', () => {
    const b = { flags: u8(1 << 5), state: u8(6) };
    for (const id of ids) expect(cellCostX(P('tm-default'), id, b, 1, 0)).toBeCloseTo(1.1, 12);
    const run = (id: string) => costPath([[0, -125], [1609.344, -125]], P('tm-default'), id, gridSampler({ state: u8(6, 6, 6, 6, 6, 6, 6) }, 7, 1, 250)).totalNominal!;
    expect(run('ac138')).toBeLessThan(run('ac230'));
    expect(run('ac69')).toBeLessThan(run('ac138'));
  });
});

describe('escalation', () => {
  it('2018→2025 ×1.316, 2014→2025 ×1.539', () => {
    expect(escalationFactor(2018, 2025)).toBeCloseTo(1.316, 3);
    expect(escalationFactor(2014, 2025)).toBeCloseTo(1.539, 3);
    expect(escalationFactor(2025, 2018) * escalationFactor(2018, 2025)).toBeCloseTo(1, 12);
  });
});

describe('straight-line-quick', () => {
  it('length = great circle × 1.3; line $ = length × B&V base', () => {
    const a: [number, number] = [-112.0, 40.7], b: [number, number] = [-116.2, 43.6];
    const p = P('straight-line-quick');
    const r = straightLine(a, b, p, 'ac500');
    const gc = greatCircleM(a, b);
    expect(r.lengthM).toBeCloseTo(gc * 1.3, 6);
    expect(r.lineUsdNominal).toBeCloseTo(gc * 1.3 / METRES_PER_MILE * 3_071_750, 2);
    const terminals = 2 * 87.9e6 / 1.04 ** 4;  // 2018$ → preset's 2014$
    expect(r.totalNominal).toBeCloseTo(r.lineUsdNominal * 1.175 + terminals, 2);
    expect(r.band.low).toBeCloseTo(r.total2025 * 0.7, 2);
    expect(r.band.high).toBeCloseTo(r.total2025 * 1.5, 2);
  });
  it('great circle: 1° of latitude ≈ 111.2 km', () => {
    expect(greatCircleM([0, 0], [0, 1]) / 1000).toBeCloseTo(111.195, 2);
  });
});

describe('LUT speed', () => {
  // The tm-default surface fixture: ≈ 400 ms of CPU alone, up to ~450 ms under the full suite, so the
  // best of 5 runs is taken against a bound of about twice that, which an algorithmic regression trips.
  it.skipIf((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ROUTE_SKIP_PERF === '1')('builds a 10 M-cell tm-default routing surface in < 800 ms of CPU', () => {
    const n = 10_000_000;
    const fill = (seed: number, max: number) => {
      const a = new Uint8Array(n);
      let x = seed;
      for (let i = 0; i < 65536; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = (x >>> 16) % max; }
      for (let i = 65536; i < n; i *= 2) a.copyWithin(i, 0, Math.min(i, n - i));
      return a;
    };
    const bands = {
      landcover: fill(1, 96), slope: fill(2, 9), protect: fill(3, 128), agency: fill(4, 14), wildfire: fill(5, 256),
      whpclass: fill(6, 8), flags: fill(7, 64), state: fill(8, 57), osm_flags: fill(9, 256), osm_maxkv: fill(10, 256),
      desig: fill(11, 128), flags2: fill(12, 64), isoreg: fill(13, 10), landval: fill(14, 256), adj: fill(15, 20),
      bldg: fill(16, 256), wetland: fill(17, 102), nonres: fill(18, 102), bldgunk: fill(19, 102),
      aviation: fill(20, 7), nfhl: fill(21, 4),
    };
    expect([...presetBands(P('tm-default'))].filter((b) => !(b in bands))).toEqual([]);
    // CPU time of this process, so other test workers sharing the machine don't count.
    const cpu = (globalThis as { process: { cpuUsage(prev?: { user: number; system: number }): { user: number; system: number } } }).process;
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t = cpu.cpuUsage();
      buildSurfaces(P('tm-default'), 'ac500', bands, 5000, 2000);
      const d = cpu.cpuUsage(t);
      best = Math.min(best, (d.user + d.system) / 1000);
    }
    expect(best).toBeLessThan(800);
  });
});

describe('per-row $ attribution', () => {
  const tm = P('tm-default');
  const idx = (pred: (r: CostRow) => boolean) => tm.rows.findIndex(pred);
  const bit = (band: BandName, b: number) => idx((r) => r.band === band && 'bit' in r.match && r.match.bit === b && (!r.line_types || r.line_types.includes('ac500')));
  const whp5 = idx((r) => r.band === 'whpclass' && 'codes' in r.match && r.match.codes[0] === 5);
  const tubular = bit('flags', 5), airfield = idx((r) => r.band === 'aviation' && r.line_types?.includes('ac500') === true), phma = bit('flags2', 0), sec368 = bit('flags', 4);
  const forest = idx((r) => r.note === 'forest'), mountain = idx((r) => r.note === 'mountain, ≥ 4°');
  const withCost = (p: RoutePreset, x: Record<number, number>): RoutePreset =>
    ({ ...p, rows: p.rows.map((r, i) => (i in x ? { ...r, cost_x: x[i] } : r)) });
  const run = (p: RoutePreset, bands: BandMap, n: number) => {
    const lc = costPolyline([[0, -125], [n * 250, -125]], p, 'ac500', gridSampler(bands, n, 1, 250));
    const sum = lc.baseUsd + lc.perRow.reduce((t, x) => t + x.usd, 0) + lc.otherUsd;
    expect(Math.abs(sum - lc.lineUsd) / lc.lineUsd).toBeLessThan(1e-9);
    expect(Math.abs(lc.otherUsd) / lc.lineUsd).toBeLessThan(1e-9);
    for (const x of lc.perRow) expect(Number.isFinite(x.usd) && Number.isFinite(x.affectedM)).toBe(true);
    return lc;
  };
  const usdOf = (lc: { perRow: { row: number; usd: number }[] }, row: number) => lc.perRow.find((x) => x.row === row)?.usd ?? 0;
  const cell = 250 * 3_071_750 / METRES_PER_MILE;   // tm-default ac500 base $ of one cell (2014$)

  it('all cells factor 1: no row $, base = line $', () => {
    const lc = run(tm, { state: u8(6, 6, 6) }, 3);
    expect(lc.perRow.every((x) => x.usd === 0)).toBe(true);
    expect(lc.baseUsd).toBeCloseTo(lc.lineUsd, 6);
    expect(lc.baseUsd).toBeCloseTo(3 * cell, 6);
  });

  it('one ungrouped row takes the whole increment', () => {
    const lc = run(tm, { whpclass: u8(5, 0), state: u8(6, 6) }, 2);
    expect(lc.perRow).toEqual([{ row: whp5, usd: expect.closeTo(0.5 * cell, 6), affectedM: expect.closeTo(250, 9) }]);
  });

  it('a max group: the winner takes it, the loser gets 0', () => {
    const lc = run(tm, { landcover: u8(41, 82), slope: u8(5, 1), whpclass: u8(4, 0), state: u8(6, 6) }, 2);
    expect(usdOf(lc, mountain)).toBe(0);
    expect(lc.perRow.some((x) => x.row === mountain)).toBe(false);
    // cell 0: c = 2.25 · 1.03; forest share ln 2.25 / (ln 2.25 + ln 1.03) of base · (c − 1)
    const inc = cell * (2.25 * 1.03 - 1), w = Math.log(2.25) / (Math.log(2.25) + Math.log(1.03));
    expect(usdOf(lc, forest)).toBeCloseTo(inc * w, 6);
    expect(usdOf(lc, idx((r) => r.band === 'whpclass' && 'codes' in r.match && r.match.codes[0] === 4))).toBeCloseTo(inc * (1 - w), 6);
    const rf = rowFactors(compile(tm, 'ac500'), { landcover: 41, slope: 5, state: 6 }, 'ac500');
    expect(rf.map((x) => [x.row, x.c, x.winsCost, x.winsRoute])).toEqual([[forest, 2.25, true, true], [mountain, 1.75, false, false]]);
  });

  it('a cost_x < 1 edit gives a signed (negative) share', () => {
    const p = withCost(tm, { [whp5]: 0.5 });
    const lc = run(p, { whpclass: u8(5), flags: u8(1 << 5), state: u8(6) }, 1);
    const inc = cell * (0.5 * 1.5 - 1), lnSum = Math.log(0.5) + Math.log(1.5);
    expect(usdOf(lc, whp5)).toBeLessThan(0);
    expect(usdOf(lc, whp5)).toBeCloseTo(Math.log(0.5) * inc / lnSum, 6);
    expect(usdOf(lc, tubular)).toBeCloseTo(Math.log(1.5) * inc / lnSum, 6);
  });

  it('two rows cancelling (2 × 0.5) stay finite: each ≈ base · ln c', () => {
    const p = withCost(tm, { [whp5]: 2, [tubular]: 0.5 });
    const lc = run(p, { whpclass: u8(5), flags: u8(1 << 5), state: u8(6) }, 1);
    expect(usdOf(lc, whp5)).toBeCloseTo(cell * Math.LN2, 6);
    expect(usdOf(lc, tubular)).toBeCloseTo(-cell * Math.LN2, 6);
    expect(lc.lineUsd).toBeCloseTo(cell, 6);
  });

  it('an exempted cell reports original row indices (variant rows mapped back)', () => {
    const p = withCost(tm, { [phma]: 3 });
    // cell 0: PHMA + airfield (PHMA counts); cell 1: PHMA ∩ §368 + airfield (PHMA exempt)
    const lc = run(p, { flags2: u8(1, 1), flags: u8(0, 1 << 4), aviation: u8(6, 6), state: u8(6, 6) }, 2);
    const inc0 = cell * (3 * 1.2 - 1), w = Math.log(3) / (Math.log(3) + Math.log(1.2));
    expect(usdOf(lc, phma)).toBeCloseTo(inc0 * w, 6);
    expect(usdOf(lc, airfield)).toBeCloseTo(inc0 * (1 - w) + cell * 0.2, 6);
    expect(lc.perRow.find((x) => x.row === phma)!.affectedM).toBeCloseTo(250, 9);
    expect(lc.perRow.find((x) => x.row === sec368)).toEqual({ row: sec368, usd: 0, affectedM: expect.closeTo(250, 9) });
    const rf = rowFactors(compile(p, 'ac500'), { flags2: 1, flags: 1 << 4, aviation: 6, state: 6 }, 'ac500');
    expect(rf.map((x) => x.row)).toEqual([sec368, airfield].sort((a, b) => a - b));
  });

  it('costPath passes baseUsd, perRow, otherUsd and lengthFactor through', () => {
    const bands = { whpclass: u8(5, 5), state: u8(6, 6) };
    const r = costPath(cellsToCoords([0, 1], 2, 250), tm, 'ac500', gridSampler(bands, 2, 1, 250));
    expect(r.lengthFactor).toBe(1.5);
    const sum = r.baseUsd + r.perRow.reduce((t, x) => t + x.usd, 0) + r.otherUsd;
    expect(sum * r.lengthFactor).toBeCloseTo(r.lineUsdNominal, 6);
  });
});

describe('uploaded-layer rows (add_rows → upl_<hash>)', () => {
  const H = '0123456789abcdef', H2 = 'fedcba9876543210';
  const patched = (add: unknown[]) => {
    const r = validatePresetPatch(P('tm-default'), { add_rows: add });
    if (!r.ok) throw new Error(r.reason);
    return r.result;
  };

  it('presetBands lists upl_<hash> for each add_rows entry, so a solve rasterises them', () => {
    const p = patched([{ layer: H, label: 'a', route_w: 3, cost_x: 2 }, { layer: H2, label: 'b', route_w: 1, cost_x: 1, barrier: true }]);
    const b = presetBands(p);
    expect(b.has(`upl_${H}`) && b.has(`upl_${H2}`)).toBe(true);
    expect(b.has('upl_0000000000000000')).toBe(false);
    expect(presetBands(P('tm-default')).has(`upl_${H}`)).toBe(false);
  });

  it('weights and blocks only the cells inside (1); a missing band adds nothing', () => {
    const p = patched([{ layer: H, label: 'a', route_w: 3, cost_x: 2 }, { layer: H2, label: 'b', route_w: 1, cost_x: 1, barrier: true }]);
    const state = u8(6, 6, 6, 6), landcover = u8(71, 71, 71, 71);
    const plain = buildSurfaces(P('tm-default'), 'ac500', { state, landcover }, 4, 1);
    const s = buildSurfaces(p, 'ac500', { state, landcover, [`upl_${H}`]: u8(1, 1, 0, 0), [`upl_${H2}`]: u8(0, 1, 0, 1) }, 4, 1);
    expect(Array.from(s.route)).toEqual([plain.route[0] * 3, plain.route[1] * 3, plain.route[2], plain.route[3]]);
    expect(Array.from(s.barrier)).toEqual([0, 1, 0, 1]);
    const k = compile(p, 'ac500', CONSTS);
    const f = rowFactors(k, { state: 6, landcover: 71, [`upl_${H}`]: 1, [`upl_${H2}`]: 0 }, 'ac500').find((x) => p.rows[x.row].band === `upl_${H}`);
    expect(f).toMatchObject({ r: 3, c: 2 });
    const missing = buildSurfaces(p, 'ac500', { state, landcover }, 4, 1);
    expect(Array.from(missing.route)).toEqual(Array.from(plain.route));
  });
});

describe('v8 bands: aviation and nfhl rows', () => {
  const tm = P('tm-default'), pnas = P('pnas-wu2023');
  /** Routing weight of a 1-cell-per-value strip: one cell for each entry of `vals`, other bands neutral land. */
  const wOf = (p: RoutePreset, lt: string, over: Partial<Record<BandName, number[]>>, n: number): number[] => {
    const bands: BandMap = { state: new Uint8Array(n).fill(6) };
    for (const [b, a] of Object.entries(over)) bands[b as BandName] = Uint8Array.from(a!);
    return Array.from(buildSurfaces(p, lt, bands, n, 1).route);
  };
  // penetration codes per line type: ac500/dc500 3-6, ac230/ac345 4-6, ac69-ac161 5-6; code 2 is the notice zone
  const from: Record<string, number> = { ac500: 3, dc500: 3, ac345: 4, ac230: 4, ac161: 5, ac138: 5, ac115: 5, ac69: 5 };

  it('tm-default: every line type is covered by a single penetration row, disjoint', () => {
    expect(Object.keys(tm.line_types).sort()).toEqual(Object.keys(from).sort());
    for (const lt of Object.keys(from)) {
      expect(tm.rows.filter((r) => r.band === 'aviation' && r.route_w === 100 && (!r.line_types || r.line_types.includes(lt))), lt).toHaveLength(1);
    }
  });
  it.each(Object.entries(from))('tm-default %s: aviation codes below %i weigh 1, from there 100 (code 2 notice = 1)', (lt, lo) => {
    const codes = [0, 1, 2, 3, 4, 5, 6].map((c) => c);
    const w = wOf(tm, lt, { aviation: codes }, codes.length);
    for (const c of codes) expect(w[c], `${lt} code ${c}`).toBe(c >= lo ? 100 : 1);
    expect(Array.from(new Set(w.slice(0, lo)))).toEqual([1]);
  });
  it('tm-default: just inside vs just outside each set is 100 vs 1', () => {
    for (const [lt, lo] of Object.entries(from)) {
      const w = wOf(tm, lt, { aviation: [lo - 1, lo] }, 2);
      expect(w, lt).toEqual([1, 100]);
    }
  });
  it('tm-default aviation penetration costs ×1.2; the notice zone costs ×1', () => {
    for (const lt of Object.keys(from)) {
      const b: BandMap = { aviation: u8(2, 6), state: u8(6, 6) };
      expect(cellCostX(tm, lt, b, 2, 0), lt).toBeCloseTo(1, 9);
      expect(cellCostX(tm, lt, b, 2, 1) / cellCostX(tm, lt, { state: u8(6, 6) }, 2, 1), lt).toBeCloseTo(1.2, 9);
    }
  });
  it('pnas-wu2023: every aviation code weighs 1', () => {
    for (const lt of Object.keys(pnas.line_types)) {
      expect(new Set(wOf(pnas, lt, { aviation: [0, 1, 2, 3, 4, 5, 6] }, 7)), lt).toEqual(new Set([1]));
      expect(new Set(wOf(pnas, lt, { nfhl: [0, 1, 2, 3] }, 4)), lt).toEqual(new Set([1]));
    }
  });

  it('flood counts once: nfhl 2 + EPA bit → 1.5, nfhl 3 + EPA bit → 1.5, nfhl 1 + EPA bit → 1, nfhl 2 alone → 1.5', () => {
    const epa = 1 << 2;
    expect(wOf(tm, 'ac500', { flags2: [epa, epa, epa, 0], nfhl: [2, 3, 1, 2] }, 4)).toEqual([1.5, 1.5, 1, 1.5]);
  });
  it('flood once, mutation: without the EPA except a cell with both counts 2.25', () => {
    const i = tm.rows.findIndex((r) => r.band === 'flags2' && 'bit' in r.match && r.match.bit === 2);
    expect(tm.rows[i].except?.map((e) => [e.band, JSON.stringify(e.match)])).toEqual([['nfhl', '{"codes":[1,2]}']]);
    const mut: RoutePreset = { ...tm, rows: tm.rows.map((r, j) => (j === i ? { ...r, except: undefined } : r)) };
    expect(wOf(mut, 'ac500', { flags2: [1 << 2], nfhl: [2] }, 1)).toEqual([2.25]);
  });

  describe('presetBands list nfhl and aviation', () => {
    const keepOnly = (all: BandMap, keep: Set<BandName>) => Object.fromEntries(Object.entries(all).filter(([b]) => keep.has(b as BandName))) as BandMap;
    const W2 = 40;
    const all: BandMap = {};
    for (const b of ALL_BANDS) all[b] = Uint8Array.from({ length: W2 }, (_, i) => (b === 'state' ? 6 : b === 'aviation' ? 2 + (i % 5) : b === 'nfhl' ? 1 + (i % 3) : b === 'flags2' ? (1 << 2) : 0));
    const coords: [number, number][] = [[10, -125], [W2 * 250 - 10, -125]];
    const run = (p: RoutePreset, bands: BandMap, lt: string) => costPath(coords, p, lt, gridSampler(bands, W2, 1, 250), CONSTS);
    it.each(ROUTE_PRESETS.filter((p) => p.rows.length).map((p) => [p.id, p] as const))('%s: costing from presetBands only equals the full band set, for every line type', (_id, p) => {
      for (const lt of Object.keys(p.line_types)) expect(run(p, keepOnly(all, presetBands(p)), lt), lt).toEqual(run(p, all, lt));
      expect(presetBands(p).has('nfhl')).toBe(true);
      expect(presetBands(p).has('aviation')).toBe(true);
    });
    it('mutation: dropping nfhl or aviation from presetBands changes tm-default costing', () => {
      for (const drop of ['nfhl', 'aviation'] as BandName[]) {
        const keep = new Set(presetBands(tm)); keep.delete(drop);
        expect(Array.from(buildSurfaces(tm, 'ac500', keepOnly(all, keep), W2, 1).route), drop).not.toEqual(Array.from(buildSurfaces(tm, 'ac500', all, W2, 1).route));
      }
    });
  });
});
