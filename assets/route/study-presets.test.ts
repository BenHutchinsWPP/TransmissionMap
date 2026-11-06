// Independent hand calculation for the three study presets (nrel-revx, bv-2014, westtec-es).
// Every expected value below is typed from the published sources (NREL reVX config, Lopez 2025, B&V 2014, the WestTEC cost estimator;
// see docs/routing.md), never read off the preset objects. A cell is one value per band; the compiled factors of that cell are
// compared to the published number.
import { describe, it, expect } from 'vitest';
import { routePreset, type BandName, type RoutePreset } from '../../src/registry/route-presets.js';
import { cellFactors, compile, costPath, gridSampler, lengthFactor, METRES_PER_MILE, terminalCount, type GridConsts } from './cost.js';

const P = (id: string): RoutePreset => routePreset(id)!;
// grid.json isoreg table as route_grid.py ISO_CODES writes it.
const CONSTS: GridConsts = {
  isoreg: { codes: { 1: 'TEPPC', 2: 'CAISO', 3: 'MISO', 4: 'SPP', 5: 'ERCOT', 6: 'PJM', 7: 'NYISO', 8: 'ISONE', 9: 'Southeast' } },
  landval: { base: 100, steps: 16 },
};
type Vals = Partial<Record<BandName, number>>;
const fac = (p: RoutePreset, lt: string, v: Vals) => {
  const f = cellFactors(compile(p, lt, CONSTS), { state: 6, ...v }, lt);
  return { r: f.r, c: f.c };
};
const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);
// a polyline is costed in sub-metre steps along the cells: dollars agree to 1e-4
// the regional base ratio is stored rounded; the cell factor agrees with the exact quotient to 1e-4
const RATIO_TOL = 1e-4;
const closeUsd = (a: number, b: number) => close(a, b, 1e-4);

/** Cost of a straight `miles` line over uniform cells carrying `fill`. */
function line(p: RoutePreset, lt: string, fill: Vals, miles: number) {
  const n = 400;
  const bands: Partial<Record<BandName, Uint8Array>> = {};
  for (const [b, v] of Object.entries({ state: 6, ...fill })) bands[b as BandName] = new Uint8Array(n).fill(v as number);
  return costPath([[10, -125], [10 + miles * METRES_PER_MILE, -125]], p, lt, gridSampler(bands, n, 1, 250), CONSTS);
}

// protect GAP code = low 3 bits; slope codes: hill 2-3 (1 deg to 4 deg), mountain 4-8
const HILL = 2, MTN = 4;

describe('nrel-revx (reVX config @ efb1977, Lopez 2025)', () => {
  const p = P('nrel-revx');
  // iso_multipliers.json
  const MULT = {
    TEPPC: { crop: 1, forest: 2.25, sub: 1.3, urban: 1.59, wet: 1.2, hill: 1.4, mtn: 1.75 },
    SCE: { crop: 1, forest: 3, sub: 2, urban: 3, wet: 2, hill: 1.5, mtn: 2 },
    MISO: { crop: 1.03, forest: 1.2, sub: 1.08, urban: 1.2, wet: 1.8, hill: 1.1, mtn: 1.21 },
    Southeast: { crop: 1, forest: 1.47, sub: 1.75, urban: 1.12, wet: 1.33, hill: 1.2, mtn: 1.6 },
  } as const;
  // base_line_costs.json, by MW key
  const BASE: Record<keyof typeof MULT, Record<number, number>> = {
    MISO: { 102: 1254921, 1500: 2787303, 205: 1446469, 3000: 2306137, 400: 1694747 },
    SCE: { 102: 1524000, 1500: 4777000, 205: 2084122, 3000: 3952357, 400: 3034000 },
    Southeast: { 102: 818852, 1500: 4056410, 205: 984325, 3000: 3356161, 400: 1567655 },
    TEPPC: { 102: 983701, 1500: 3052857, 205: 1180083, 3000: 2525849, 400: 1579572 },
  };
  // upgrade_substation_costs.json TEPPC, by kV
  const UPGRADE_TEPPC: Record<number, number> = { 69: 1352000, 138: 2198000, 230: 5500000, 500: 10236000 };
  // Capacity key per line type; power_to_voltage.json: 102 MW = 69 kV, 205 = 138, 400 = 230, 1500 and 3000 = 500
  const LT: [string, number, number][] = [['ac500', 1500, 500], ['ac230', 400, 230], ['ac138', 205, 138], ['ac69', 102, 69]];
  // Lopez p.33-34: TEPPC; SCE (CAISO, NYISO, ISONE, PJM); MISO (SPP); Southeast (ERCOT). isoreg codes per ISO_CODES.
  const ISO: [number, keyof typeof MULT][] = [[1, 'TEPPC'], [2, 'SCE'], [6, 'SCE'], [7, 'SCE'], [8, 'SCE'], [3, 'MISO'], [4, 'MISO'], [9, 'Southeast'], [5, 'Southeast']];
  const ratio = (set: keyof typeof MULT, mw: number) => BASE[set][mw] / BASE.TEPPC[mw];

  it('line types are the reVX AC capacities only (no 115/161/345 kV, no HVDC)', () => {
    expect(Object.keys(p.line_types).sort()).toEqual(['ac138', 'ac230', 'ac500', 'ac69']);
  });
  it('is priced in 2019 dollars with no markups, contingency or ROW land', () => {
    expect(p.dollar_year).toBe(2019);
    expect(p.markups).toEqual([]);
    expect(p.contingency).toBeUndefined();
    expect(p.row_land).toBeUndefined();
  });

  it.each([[81, 'crop'], [41, 'forest'], [42, 'forest'], [43, 'forest'], [21, 'sub'], [22, 'sub'], [23, 'sub'], [24, 'urban'], [90, 'wet'], [95, 'wet']] as const)(
    'TEPPC cell NLCD %i = %s: cost and routing = TEPPC value', (nlcd, k) => {
      const f = fac(p, 'ac500', { isoreg: 1, landcover: nlcd });
      close(f.c, MULT.TEPPC[k]); close(f.r, MULT.TEPPC[k]);
    });
  it('NLCD 80 is not a class: grassland 71 and 52 shrub are neutral', () => {
    for (const lc of [71, 52, 82, 31]) expect(fac(p, 'ac500', { isoreg: 1, landcover: lc })).toEqual({ r: 1, c: 1 });
  });

  describe.each(ISO)('isoreg %i -> %s set', (code, set) => {
    it('forest, every land use, hill and mountain: cost = set multiplier x set base ratio; routing stays TEPPC', () => {
      const rt = ratio(set, 1500);
      for (const [lc, k] of [[81, 'crop'], [41, 'forest'], [21, 'sub'], [24, 'urban'], [90, 'wet']] as const) {
        const f = fac(p, 'ac500', { isoreg: code, landcover: lc });
        close(f.c, MULT[set][k] * rt, RATIO_TOL);
        close(f.r, MULT.TEPPC[k]);
      }
      close(fac(p, 'ac500', { isoreg: code, landcover: 71, slope: HILL }).c, MULT[set].hill * rt, RATIO_TOL);
      close(fac(p, 'ac500', { isoreg: code, landcover: 71, slope: MTN }).c, MULT[set].mtn * rt, RATIO_TOL);
      close(fac(p, 'ac500', { isoreg: code, landcover: 41, slope: HILL }).c, MULT[set].forest * MULT[set].hill * rt, RATIO_TOL);
    });
    it.each(LT)('%s neutral cell: cost = %i MW regional base / TEPPC base', (lt, mw) => {
      close(fac(p, lt, { isoreg: code, landcover: 71 }).c, ratio(set, mw), RATIO_TOL);
      expect(fac(p, lt, { isoreg: code, landcover: 71 }).r).toBe(1);
    });
  });

  it('forest on a hill slope = land use x hill (TEPPC 2.25 x 1.4); on a mountain slope 2.25 x 1.75', () => {
    close(fac(p, 'ac500', { isoreg: 1, landcover: 41, slope: HILL }).c, 2.25 * 1.4);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 41, slope: 3 }).r, 2.25 * 1.4);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 41, slope: MTN }).c, 2.25 * 1.75);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 41, slope: 8 }).c, 2.25 * 1.75);
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 41, slope: 1 }).c).toBe(2.25);
  });
  it('slope alone: hill 1.4 at codes 2-3, mountain 1.75 at 4-8 (TEPPC)', () => {
    close(fac(p, 'ac500', { isoreg: 1, landcover: 71, slope: 2 }).c, 1.4);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 71, slope: 3 }).c, 1.4);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 71, slope: 4 }).c, 1.75);
    close(fac(p, 'ac500', { isoreg: 1, landcover: 71, slope: 8 }).c, 1.75);
  });
  it('water (NLCD 11) = 10 exactly, also on a mountain slope, and over a hill', () => {
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 11 }).c).toBe(10);
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 11, slope: MTN }).c).toBe(10);
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 11, slope: MTN }).r).toBe(10);
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 11, slope: HILL }).c).toBe(10);
  });
  it('PAD-US GAP 1 (low 3 bits of protect) weighs 1000; GAP 2, 3, 4 and none weigh 1', () => {
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 71, protect: 1 }).r).toBe(1000);
    expect(fac(p, 'ac500', { isoreg: 1, landcover: 71, protect: (3 << 4) | 1 }).r).toBe(1000);
    for (const g of [2, 3, 4, 0]) expect(fac(p, 'ac500', { isoreg: 1, landcover: 71, protect: g }).r, `GAP ${g}`).toBe(1);
  });
  it('aviation and nfhl cells weigh 1', () => {
    for (const lt of Object.keys(p.line_types)) {
      expect(fac(p, lt, { isoreg: 1, landcover: 71, aviation: 6, nfhl: 3 }).r).toBe(1);
      expect(fac(p, lt, { isoreg: 1, landcover: 71, aviation: 6, nfhl: 3 }).c).toBe(fac(p, lt, { isoreg: 1, landcover: 71 }).c);
    }
  });

  it.each(ISO)('a 50 mi line over isoreg %i (%s) costs the %s base for 1500 MW per mile (2019 $)', (code, set) => {
    const r = line(p, 'ac500', { isoreg: code, landcover: 71 }, 50);
    closeUsd(r.lineUsdNominal / 50, BASE[set][1500]);
    expect(r.lengthFactor).toBe(1);
    expect(r.markupsUsd).toBe(0);
  });
  it('SCE 1500 MW is 4,777,000 per mile', () => {
    closeUsd(line(p, 'ac500', { isoreg: 2, landcover: 71 }, 50).lineUsdNominal, 4_777_000 * 50);
  });
  it.each(LT)('%s: 50 mi in a TEPPC cell = TEPPC base for its MW key; SCE and Southeast cells their own', (lt, mw) => {
    for (const [code, set] of [[1, 'TEPPC'], [2, 'SCE'], [3, 'MISO'], [9, 'Southeast']] as const)
      closeUsd(line(p, lt, { isoreg: code, landcover: 71 }, 50).lineUsdNominal / 50, BASE[set][mw]);
  });
  it('forest at SCE: 3 x SCE base', () => {
    closeUsd(line(p, 'ac500', { isoreg: 2, landcover: 41 }, 20).lineUsdNominal / 20, 3 * 4_777_000);
  });

  it('length factor: 2 mi 1.5, 5 mi 1.2, 20 mi 1', () => {
    expect(lengthFactor(p, 2)).toBe(1.5);
    expect(lengthFactor(p, 5)).toBe(1.2);
    expect(lengthFactor(p, 20)).toBe(1);
    expect(line(p, 'ac500', { isoreg: 1, landcover: 71 }, 2).lengthFactor).toBe(1.5);
  });
  it.each(LT)('%s terminals: two stations, each the TEPPC upgrade cost for its kV', (lt, _mw, kv) => {
    const r = line(p, lt, { isoreg: 1, landcover: 71 }, 50);
    expect(terminalCount(p.line_types[lt].terminals, 50)).toBe(2);
    expect(r.terminalCount).toBe(2);
    closeUsd(r.terminalsUsd!, 2 * UPGRADE_TEPPC[kv]);
  });
});

describe('bv-2014 (Black & Veatch 2014, WECC TEPPC)', () => {
  const p = P('bv-2014');
  // Table 2-5, WECC column
  it.each([
    ['desert', [31], 1.05], ['scrub', [52, 71], 1], ['farmland', [81, 82], 1], ['forest', [41, 42, 43], 2.25],
    ['wetland', [90, 95], 1.2], ['open water', [11], 1.2], ['suburban', [22, 23], 1.27], ['urban', [24], 1.59],
  ] as [string, number[], number][])('%s: routing = cost = Table 2-5 WECC value', (_n, codes, x) => {
    for (const lc of codes) {
      const f = fac(p, 'ac230', { landcover: lc });
      close(f.c, x); close(f.r, x);
    }
  });
  it('rolling hill (slope 2-8 %) 1.40 and mountain (> 8 %) 1.75 on neutral land', () => {
    for (const s of [2, 3]) { const f = fac(p, 'ac230', { landcover: 71, slope: s }); close(f.c, 1.4); close(f.r, 1.4); }
    for (const s of [4, 8]) { const f = fac(p, 'ac230', { landcover: 71, slope: s }); close(f.c, 1.75); close(f.r, 1.75); }
  });
  it('one terrain type per cell: forest on a mountain = 2.25 (max), forest on rolling = 2.25, wetland on mountain = 1.75', () => {
    close(fac(p, 'ac230', { landcover: 41, slope: MTN }).c, 2.25);
    close(fac(p, 'ac230', { landcover: 41, slope: MTN }).r, 2.25);
    close(fac(p, 'ac230', { landcover: 41, slope: HILL }).c, 2.25);
    close(fac(p, 'ac230', { landcover: 90, slope: MTN }).c, 1.75);
    close(fac(p, 'ac230', { landcover: 24, slope: HILL }).c, 1.59);
  });
  it('aviation and nfhl cells weigh 1', () => {
    for (const lt of Object.keys(p.line_types)) expect(fac(p, lt, { landcover: 71, aviation: 6, nfhl: 3 })).toEqual({ r: 1, c: 1 });
  });
  it('230 kV double circuit: $1,536,400 per mile (2014 $), structure and conductor x 1, length > 10 mi x 1', () => {
    expect(p.dollar_year).toBe(2014);
    const r = line(p, 'ac230', { landcover: 71 }, 50);
    closeUsd(r.lineUsdNominal / 50, 1_536_400);
    expect(r.lengthFactor).toBe(1);
  });
  it('AFUDC 7.5 % + overhead 10 % = markup 1.175 on the line; no contingency, no ROW land', () => {
    const r = line(p, 'ac230', { landcover: 71 }, 50);
    closeUsd(r.markupsUsd, r.lineUsdNominal * 0.175);
    expect(r.contingency).toBeNull();
    expect(r.rowLand).toBeNull();
  });
  it('length factors (Table 2-4): < 3 mi 1.5, 3-10 mi 1.2, > 10 mi 1', () => {
    expect(lengthFactor(p, 2)).toBe(1.5);
    expect(lengthFactor(p, 5)).toBe(1.2);
    expect(lengthFactor(p, 12)).toBe(1);
    expect(lengthFactor(p, 50)).toBe(1);
  });
  it('230 kV terminal = (1,706,250 + 6 x 1.5 x 1,492,903) x 1.175, rounded; two stations', () => {
    const each = Math.round((1_706_250 + 6 * 1.5 * 1_492_903) * 1.175);
    expect(each).toBe(17_792_293);
    const r = line(p, 'ac230', { landcover: 71 }, 50);
    expect(r.terminalCount).toBe(2);
    expect(r.terminalsUsd).toBeCloseTo(2 * each, 3);
    expect(p.line_types.ac230.terminals.usd_each).toBe(each);
  });
  // Table 2-1 p.2-3 double circuit / HVDC bi-pole; Tables 3-1, 3-2, 4-6 and 3-5; x 1.175 (§4.4)
  it.each([
    ['ac230', 1_536_400, (1_706_250 + 6 * 1.5 * 1_492_903) * 1.175, false],
    ['ac345', 2_150_300, (2_132_700 + 6 * 1.5 * 2_239_354) * 1.175, false],
    ['ac500', 3_071_750, (2_559_250 + 6 * 1.5 * 2_985_805) * 1.175, false],
    ['dc500', 1_536_400, 460_708_500 * 1.175, true],
  ] as const)('%s: base $/mi (2014) and terminal each from B&V tables', (lt, base, term, reportOnly) => {
    expect(Object.keys(p.line_types).sort()).toEqual(['ac230', 'ac345', 'ac500', 'dc500']);
    closeUsd(line(p, lt, { landcover: 71 }, 50).lineUsdNominal / 50, base);
    expect(p.line_types[lt].base_per_mi.year).toBe(2014);
    expect(p.line_types[lt].terminals.usd_each).toBe(Math.round(term));
    expect(!!p.line_types[lt].terminals.report_only).toBe(reportOnly);
  });
});

describe('westtec-es (Energy Strategies, Line modifiers dialog)', () => {
  const p = P('westtec-es');
  it('other line types and every terminal are the default method\'s; ac500 keeps the default terminals', () => {
    const tm = P('tm-default');
    expect(Object.keys(p.line_types).sort()).toEqual(Object.keys(tm.line_types).sort());
    for (const lt of Object.keys(tm.line_types)) {
      expect(p.line_types[lt].terminals, lt).toEqual(tm.line_types[lt].terminals);
      if (lt !== 'ac500') expect(p.line_types[lt].base_per_mi, lt).toEqual(tm.line_types[lt].base_per_mi);
    }
  });
  it('ac500 base $4,180,000 per mile in 2025 dollars, no markups', () => {
    expect(p.dollar_year).toBe(2025);
    const r = line(p, 'ac500', { landcover: 71 }, 50);
    closeUsd(r.lineUsdNominal / 50, 4_180_000);
    expect(r.markupsUsd).toBe(0);
    expect(p.markups).toEqual([]);
    expect(p.contingency).toBeUndefined();
  });
  // in cost and routing
  it.each([
    ['mountain', { landcover: 71, slope: MTN }, 1.75], ['mountain 8', { landcover: 71, slope: 8 }, 1.75],
    ['rolling', { landcover: 71, slope: HILL }, 1.4], ['rolling 3', { landcover: 71, slope: 3 }, 1.4],
    ['forest 41', { landcover: 41 }, 2.25], ['forest 43', { landcover: 43 }, 2.25],
    ['developed 22', { landcover: 22 }, 1.59], ['developed 23', { landcover: 23 }, 1.59], ['developed 24', { landcover: 24 }, 1.59],
    ['wetland 90', { landcover: 90 }, 1.2], ['wetland 95', { landcover: 95 }, 1.2],
    ['barren 31', { landcover: 31 }, 1.2],
    ['cultivated crops 82', { landcover: 82 }, 1], ['pasture 81', { landcover: 81 }, 1], ['shrub 52', { landcover: 52 }, 1], ['grass 71', { landcover: 71 }, 1],
    ['river', { landcover: 71, osm_flags: 1 << 1 }, 1.3],
    ['lake', { landcover: 71, osm_flags: 1 << 0 }, 5],
    ['airfield', { landcover: 71, flags: 1 << 2 }, 5],
  ] as [string, Vals, number][])('%s: cost = routing = %s', (_n, v, x) => {
    const f = fac(p, 'ac500', v);
    close(f.c, x); close(f.r, x);
  });
  it('modifiers multiply: forest on a mountain = 2.25 x 1.75; forest on rolling = 2.25 x 1.4', () => {
    const a = fac(p, 'ac500', { landcover: 41, slope: MTN });
    close(a.c, 2.25 * 1.75); close(a.r, 2.25 * 1.75);
    close(fac(p, 'ac500', { landcover: 41, slope: HILL }).c, 2.25 * 1.4);
    close(fac(p, 'ac500', { landcover: 71, osm_flags: 3 }).r, 1.3 * 5);
  });
  // routing only, excluded from cost
  it('tribal lands: routing 5, cost 1', () => {
    expect(fac(p, 'ac500', { landcover: 71, flags: 1 << 0 })).toEqual({ r: 5, c: 1 });
  });
  it('wildfire (WHP class 4 or 5): routing 1.2, cost 1; class 3 and 6 neutral', () => {
    for (const w of [4, 5]) expect(fac(p, 'ac500', { landcover: 71, whpclass: w })).toEqual({ r: 1.2, c: 1 });
    for (const w of [1, 3, 6, 7]) expect(fac(p, 'ac500', { landcover: 71, whpclass: w }), `WHP ${w}`).toEqual({ r: 1, c: 1 });
  });
  it('PAD-US designation: bits 7 (Wilderness/NP), 0 (WSA), 1 (NM/NCA) route 4; bits 2-6 route 1.2; max of the bits; cost 1', () => {
    for (const b of [7, 0, 1]) expect(fac(p, 'ac500', { landcover: 71, desig: 1 << b }), `bit ${b}`).toEqual({ r: 4, c: 1 });
    for (const b of [2, 3, 4, 5, 6]) expect(fac(p, 'ac500', { landcover: 71, desig: 1 << b }), `bit ${b}`).toEqual({ r: 1.2, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, desig: (1 << 7) | (1 << 2) })).toEqual({ r: 4, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, desig: (1 << 2) | (1 << 3) })).toEqual({ r: 1.2, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, desig: (1 << 0) | (1 << 7) })).toEqual({ r: 4, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, desig: 0 })).toEqual({ r: 1, c: 1 });
  });
  it('military (PD flags bit 1 or OSM flags bit 7): routing 1000, cost 1', () => {
    expect(fac(p, 'ac500', { landcover: 71, flags: 1 << 1 })).toEqual({ r: 1000, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, osm_flags: 1 << 7 })).toEqual({ r: 1000, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, flags: 1 << 1, osm_flags: 1 << 7 })).toEqual({ r: 1000, c: 1 });
  });
  it('follow existing: x 2 more than 1 cell off a >= 230 kV line (adj classes 0, 3), x 1 on or next to it (classes 1, 2) and with no adj; cost 1', () => {
    const adj = (cls: number) => 16 | cls;
    for (const c of [0, 3]) expect(fac(p, 'ac500', { landcover: 71, adj: adj(c) }), `class ${c}`).toEqual({ r: 2, c: 1 });
    for (const c of [1, 2]) expect(fac(p, 'ac500', { landcover: 71, adj: adj(c) }), `class ${c}`).toEqual({ r: 1, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, adj: 0 })).toEqual({ r: 1, c: 1 });
    // class of a 100-229 kV line (bits 5-6) does not change the >= 230 kV class
    expect(fac(p, 'ac500', { landcover: 71, adj: adj(1) | (3 << 5) })).toEqual({ r: 1, c: 1 });
    expect(fac(p, 'ac500', { landcover: 71, adj: adj(0) | (1 << 5) })).toEqual({ r: 2, c: 1 });
  });
  it('aviation and nfhl cells weigh 1', () => {
    for (const lt of Object.keys(p.line_types)) expect(fac(p, lt, { landcover: 71, aviation: 6, nfhl: 3 })).toEqual({ r: 1, c: 1 });
  });
});
