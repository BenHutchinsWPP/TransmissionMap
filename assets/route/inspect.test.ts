// Cell inspector checks: band labels, observation coverage and explained method weights.
// Deps: inspect.ts, cost.ts, the route preset registry and the fixture grid.json (scripts/route_grid.py's tables).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import baseEn from '../../src/i18n/locales/en.js';
import routeEn from '../../src/i18n/route/en.js';
import { compile } from './cost.js';
import { decodeCell, explainCell, fmtX, matchText, presentFacts, textOf, type Text } from './inspect.js';
import { categoryLabelKey } from './categories.js';
import { ROUTE_PRESETS, routePreset } from '../../src/registry/route-presets.js';

// English: the shipped text, base dictionary plus the route strings.
const dict: Record<string, string> = { ...baseEn, ...routeEn };
const tr = (k: string, p?: Record<string, string | number>) =>
  (dict[k] ?? k).replace(/\{([^{}]+)\}/g, (m, q: string) => (p && q in p ? String(p[q]) : m));
const say = (x: Text) => textOf(x, tr);

const tm = routePreset('tm-default')!;
const k = compile(tm, 'ac500');
const meta = { isoreg: new Map([[1, 'TEPPC']]), landval: { base: 100, steps: 16 } };
/** A plain cell: Idaho, shrub, flat, private land, no flags. */
const cell = (over: Record<string, number> = {}) => ({
  landcover: 52, slope: 1, protect: 0, agency: 1, wildfire: 1, whpclass: 1, flags: 0, state: 16,
  desig: 0, flags2: 0, isoreg: 1, landval: 33, bldg: 1, osm_flags: 0, osm_maxkv: 0, adj: 16, ...over,
});

describe('decodeCell', () => {
  it('decodes the v3 bits and both adj classes', () => {
    const by = (over: Record<string, number>) => Object.fromEntries(decodeCell(cell(over), meta).map((x) => [x.band, x.text.map(say).join(', ')]));
    expect(by({ flags: 1 << 7 }).flags).toBe('Tall structure or dam');
    expect(by({ flags: 1 << 3 }).flags).toBe('Critical habitat (incl. river reaches)');
    const f2 = (b: number) => by({ flags2: 1 << b }).flags2;
    expect([2, 3, 4, 6, 7].map(f2)).toEqual(['100-year floodplain', 'School, hospital, child care or nursing home',
      'National Register historic place', 'Coastal Barrier Resources unit', 'Formerly used defense site (munitions)']);
    expect(by({ adj: 16 + 1 + (2 << 5) }).adj).toBe('on a ≥ 230 kV line, within 1 cell of a 100–229 kV line');
  });

  it('decodes protect bit 7 as the NPS unit named Preserve', () => {
    const by = (v: number) => decodeCell(cell({ protect: v }), meta).find((x) => x.band === 'protect')!.text.map(say).join(', ');
    expect(by(130)).toBe('GAP 2, NPS unit named Preserve');
    expect(by(2)).toBe('GAP 2');
    expect(presentFacts(decodeCell(cell({ protect: 130 }), meta)).map((f) => say(f.label))).toContain('NPS unit named Preserve');
    expect(presentFacts(decodeCell(cell({ protect: 2 }), meta)).map((f) => say(f.label))).not.toContain('NPS unit named Preserve');
  });

  it('the preserve fact carries value 128 so the card shows the concern colour', () => {
    const f = presentFacts(decodeCell(cell({ protect: 130 }), meta)).find((x) => say(x.label) === 'NPS unit named Preserve')!;
    expect(f.value).toBe(128);
  });

  it('labels every band', () => {
    const d = decodeCell(cell({ slope: 4, protect: 2 | (1 << 4) | (1 << 6), agency: 2, whpclass: 5, flags: 0b100100, osm_flags: 0b100, osm_maxkv: 100, adj: 17, desig: 0b1 }), meta);
    const by = Object.fromEntries(d.map((x) => [x.band, x.text.map(say).join(', ')]));
    expect(by).toMatchObject({
      landcover: 'Shrub/scrub', slope: '4–8°', protect: 'GAP 2, TNC category 1, outside the PoPWest study area', agency: 'BLM',
      whpclass: 'very high', flags: 'Public airfield ≤ 5 km, Populated area (> 100/mi²)', state: 'ID (FIPS 16)',
      desig: 'Wilderness Study Area', isoreg: 'TEPPC', landval: '$400/ac', osm_flags: 'Existing line ≥ 230 kV',
      osm_maxkv: 'max 500 kV', adj: 'on a ≥ 230 kV line', wildfire: '1/255 (≈ 0 % of the CONUS maximum)',
    });
    expect(say(d[0].label)).toBe('Land cover');
    const empty = Object.fromEntries(decodeCell({ landcover: 0, state: 0, flags: 0, adj: 0, protect: 0, osm_maxkv: 0, agency: 0 }, meta).map((x) => [x.band, x.text.map(say).join()]));
    expect(empty).toEqual({
      landcover: 'no data', state: 'outside CONUS land', flags: 'none', adj: 'no data',
      protect: 'not in PAD-US', osm_maxkv: 'none', agency: 'no data',
    });
  });
});

describe('aviation (b18) and nfhl (b19)', () => {
  const g = JSON.parse(readFileSync(new URL('./fixtures/cube/grid.json', import.meta.url), 'utf8'));
  const WORDS = {
    aviation: { 2: 'Notice zone (14 CFR 77.9), no lower Part 77 surface.',
      3: 'Lowest Part 77 surface 46–61 m above ground.',
      4: 'Lowest Part 77 surface 30–46 m above ground.',
      5: 'Lowest Part 77 surface under 30 m above ground.', 6: 'Primary surface.' },
    nfhl: { 1: 'FEMA map in effect, outside the Special Flood Hazard Area', 2: 'Special Flood Hazard Area (at least half of the cell)', 3: 'No effective FEMA flood map' },
  } as const;
  it.each(['aviation', 'nfhl'] as const)('%s: 0 no data, every class of grid.json in words', (band) => {
    const text = (v: number) => decodeCell({ [band]: v }, meta)[0].text.map(say).join();
    const words = WORDS[band] as Record<number, string>;
    expect(text(0)).toBe('no data');
    if (band === 'aviation') {
      expect(text(1)).toBe('none');
      expect(presentFacts(decodeCell({ [band]: 1 }, meta))).toEqual([]);
    }
    const classes = Object.keys(g[band]).map(Number).filter((c) => band === 'nfhl' || c > 1);
    expect(classes.sort()).toEqual(Object.keys(words).map(Number));
    for (const c of classes) {
      expect(text(c)).toBe(words[c]);
      expect(presentFacts(decodeCell({ [band]: c }, meta))).toEqual([
        { band, value: c, label: { k: 'route.insp.fact', p: { band: { k: `route.insp.band.${band}` }, value: { k: `route.insp.${band}.${c}` } } } },
      ]);
      expect(matchText(band, { codes: [c] }).map(say)).toEqual([words[c]]);
    }
    expect(text(7)).toBe('code 7');
  });
});

describe('desig bit 7 and flags bit 6', () => {
  it('are named in the decoded text and the present facts, not printed as "bit n"', () => {
    const d = decodeCell(cell({ desig: 1 << 7, flags: 1 << 6 }), meta);
    for (const [band, b] of [['desig', 7], ['flags', 6]] as const) {
      const key = categoryLabelKey(`${band}:${b}`);
      expect(key).not.toBe(categoryLabelKey('other'));
      expect(d.find((x) => x.band === band)!.text.map(say)).toEqual([tr(key)]);
      expect(presentFacts(d).filter((f) => f.band === band).map((f) => say(f.label))).toEqual([tr(key)]);
    }
  });
});

describe('wetland', () => {
  it('decodes the share of the cell, 1 = none, 101 = all', () => {
    const by = (v: number) => decodeCell(cell({ wetland: v }), meta).find((x) => x.band === 'wetland')!.text.map(say).join();
    expect([0, 1, 2, 41, 101].map(by)).toEqual(['no data', 'none', '1 % of the cell', '40 % of the cell', '100 % of the cell']);
  });
});

describe('bldg', () => {
  it('decodes homes in the cell, 1 = none, 255 = 254 or more', () => {
    const by = (v: number) => decodeCell(cell({ bldg: v }), meta).find((x) => x.band === 'bldg')!.text.map(say).join();
    expect([0, 1, 2, 4, 255].map(by)).toEqual(['no data', 'none', '1 in the cell', '3 in the cell', '254+ in the cell']);
    const f = presentFacts(decodeCell(cell({ bldg: 5 }), meta)).map((x) => say(x.label));
    expect(f).toContain('Homes: 4 in the cell');
    expect(presentFacts(decodeCell(cell(), meta)).some((x) => x.band === 'bldg')).toBe(false);
  });
  it('weights the three tm-default rows, ungrouped, routing only', () => {
    const w = (v: number) => explainCell(k, cell({ bldg: v }), tm, 'ac500');
    expect([1, 2, 3, 4, 10, 11, 255].map((v) => w(v).routeW)).toEqual([1, 1.3, 1.3, 1.6, 1.6, 2, 2]);
    expect(w(11).costX).toBe(1);
    expect(say(w(11).cause)).toMatch(/^Homes — 10\+ homes in cell \(rationale: PUCT 16 TAC §25\.101 .*\) · routing weight ×2$/);
    // multiplies with land cover: forest 2.25 × 2
    expect(w(11).routeW * 2.25).toBeCloseTo(explainCell(k, cell({ bldg: 11, landcover: 41 }), tm, 'ac500').routeW);
  });
});

describe('observed building footprints', () => {
  it.each(['built', 'nonres', 'bldgunk'] as const)('%s distinguishes unobserved, observed empty and positive upper bounds', (band) => {
    const by = (v: number) => decodeCell(cell({ [band]: v }), meta).find((x) => x.band === band)!.text.map(say).join();
    expect([0, 1, 2, 101].map(by)).toEqual([
      'outside processed footprint coverage',
      'no footprint found (not proof of vacant land)',
      'footprints cover up to 1 % of the cell',
      'footprints cover up to 100 % of the cell',
    ]);
    expect(by(102)).toBe('code 102');
  });

  it('names unknown class separately from unobserved coverage in present facts', () => {
    const facts = presentFacts(decodeCell(cell({ built: 2, nonres: 1, bldgunk: 2 }), meta));
    expect(facts.find((f) => f.band === 'bldgunk')?.label).toEqual(expect.objectContaining({
      k: 'route.insp.fact', p: expect.objectContaining({ band: { k: 'route.insp.band.bldgunk' } }),
    }));
    expect(facts.filter((f) => f.band === 'built' || f.band === 'nonres' || f.band === 'bldgunk')).toHaveLength(3);
    expect(facts.map((f) => say(f.label)).join(' ')).toContain('Unknown-class footprints');
  });
});

describe('explainCell', () => {
  it('leads with the aviation row', () => {
    const e = explainCell(k, cell({ aviation: 5 }), tm, 'ac500');
    expect(say(e.cause)).toBe('Airport surfaces (FAA Part 77) — exceeds an obstruction standard — screening (≤ 61 m / 200 ft) · routing weight ×100 · cost ×1.2');
    expect(e.routeW).toBeCloseTo(100);
    expect(e.barrier).toBeNull();
    const row = e.rows.find((r) => r.note === 'exceeds an obstruction standard — screening (≤ 61 m / 200 ft)')!;
    expect(row).toMatchObject({ r: 100, winsRoute: true, rule: 'multiply' });
  });

  it('weighs a notice zone as a filing only, and the old airfield flag no longer at all', () => {
    expect(explainCell(k, cell({ aviation: 2 }), tm, 'ac500').routeW).toBeCloseTo(1);
    expect(explainCell(k, cell({ flags: 1 << 2 }), tm, 'ac500').routeW).toBeCloseTo(1);
  });

  it('names the barrier', () => {
    const e = explainCell(k, cell({ state: 0 }), tm, 'ac500');
    expect(say(e.cause)).toBe('Blocked: outside CONUS land');
    const pnas = routePreset('pnas-wu2023')!;
    const ep = explainCell(compile(pnas, 'ac500'), cell({ state: 48 }), pnas, 'ac500');
    expect(say(ep.cause)).toBe("Blocked: outside the method's study area (TX (FIPS 48))");
  });

  it('shows an exempted PHMA row inside a Section 368 corridor, and its own discount as the cause', () => {
    const e = explainCell(k, cell({ flags2: 1, flags: 1 << 4 }), tm, 'ac500');
    expect(e.exempted).toHaveLength(1);
    expect(e.exempted[0]).toMatchObject({ note: 'sage-grouse PHMA/IHMA', exceptLabel: 'inside Section 368 corridors' });
    expect(e.rows.some((r) => r.note === 'sage-grouse PHMA/IHMA')).toBe(false);
    expect(say(e.cause)).toBe('Existing lines and Section 368 — Section 368 corridor · routing weight ×0.8');
    // outside the corridor the PHMA row applies
    expect(say(explainCell(k, cell({ flags2: 1 }), tm, 'ac500').cause)).toBe('Sage-grouse PHMA · routing weight ×20');
  });

  it('says no routing penalty when every row is ×1', () => {
    const e = explainCell(k, cell(), tm, 'ac500');
    expect(say(e.cause)).toBe('No routing penalty');
    expect(e.routeW).toBe(1);
  });

  it('marks the group winner and names grouped rows with their note', () => {
    const e = explainCell(k, cell({ protect: 1, desig: 0b1000 }), tm, 'ac500');   // GAP 1 ×100 vs ACEC ×10, max group
    const prot = e.rows.filter((r) => r.group === 'protection');
    expect(prot.map((r) => [r.note, r.winsRoute])).toEqual([['GAP 1', true], ['ACEC', false]]);
    expect(say(e.cause)).toBe('Protected areas — GAP 1 · routing weight ×100');
  });

  it('formats factors', () => {
    expect([fmtX(100), fmtX(1000), fmtX(1.75), fmtX(0.8), fmtX(12.34)]).toEqual(['100', '1,000', '1.75', '0.8', '12.3']);
  });
});

describe('presentFacts', () => {
  const facts = (over: Record<string, number>) => presentFacts(decodeCell(cell(over), meta));
  it('leaves out no-data and none; a set bit is one fact with its class', () => {
    const f = facts({ flags2: 1 | (1 << 2), osm_maxkv: 0, wildfire: 0 });
    const text = f.map((x) => say(x.label));
    expect(text).toContain('Sage-grouse PHMA');
    expect(text).toContain('100-year floodplain');
    expect(text.join('|')).not.toMatch(/: none|no data/i);
    expect(f.find((x) => x.band === 'flags2' && x.bit === 0)).toBeTruthy();
  });
  it('an empty cell still lists the always-present values (state, region), not none', () => {
    expect(facts({}).map((x) => x.band)).not.toContain('flags');
  });
});

describe('matchText: a preset match in words', () => {
  const words = (band: Parameters<typeof matchText>[0], m: Parameters<typeof matchText>[1]) => matchText(band, m).map(say);
  const raw = (x: Text) => typeof x === 'object' && (x.k === 'route.insp.code' || x.k === 'route.insp.bit');

  it('names NLCD classes, bits, fields and spans', () => {
    expect(words('landcover', { codes: [21, 52, 71, 81] })).toEqual(['Developed, open space', 'Shrub/scrub', 'Grassland/herbaceous', 'Pasture/hay']);
    expect(words('desig', { bit: 0 })).toEqual(['Wilderness Study Area']);
    expect(words('protect', { field: { shift: 0, mask: 7 }, codes: [2] })).toEqual(['GAP 2']);
    expect(words('protect', { bit: 7 })).toEqual(['NPS unit named Preserve']);
    expect(words('slope', { range: [2, 3] })).toEqual(['1–4°']);
    expect(words('bldg', { range: [4, 10] })).toEqual(['3–9 in the cell']);
    expect(words('bldg', { range: [11, 255] })).toEqual(['10+ in the cell']);
    expect(words('wetland', { range: [27, 51] })).toEqual(['26–50 % of the cell']);
    expect(words('wildfire', { range: [1, 255] })).toEqual(['any value']);
    expect(words('adj', { field: { shift: 5, mask: 3 }, codes: [1] })).toEqual(['on a 100–229 kV line']);
  });

  it('a value it cannot name stays the cube code', () => {
    expect(words('landcover', { codes: [99] })).toEqual(['code 99']);
    expect(words('isoreg', { codes: [3] })).toEqual(['code 3']);
  });

  it('every match of every preset is in words, with an English string', () => {
    for (const p of ROUTE_PRESETS) {
      for (const r of p.rows) {
        for (const [band, m] of [[r.band, r.match] as const, ...(r.except ?? []).map((e) => [e.band, e.match] as const)]) {
          const xs = matchText(band, m);
          expect(xs.some(raw), `${p.id} ${band} ${JSON.stringify(m)}`).toBe(false);
          for (const x of xs) if (typeof x === 'object') expect(dict[x.k], x.k).toBeTypeOf('string');
        }
      }
    }
  });

  // The fixture grid.json is written by scripts/route_grid.py grid_json(), so these hold inspect.ts's
  // copies of its encodings (slope edges, bit layouts, code tables) to the build.
  it('decodes the encodings scripts/route_grid.py writes', () => {
    const g = JSON.parse(readFileSync(new URL('./fixtures/cube/grid.json', import.meta.url), 'utf8'));
    for (const [code, [lo, hi]] of Object.entries(g.slope_bins as Record<string, [number, number]>)) {
      expect(words('slope', { range: [+code, +code] })).toEqual([`${lo}–${hi}°`]);
    }
    const pb = g.protect_bits;
    expect(words('protect', { field: { shift: pb.gap_shift, mask: pb.gap_mask }, codes: [1] })).toEqual(['GAP 1']);
    expect(words('protect', { field: { shift: pb.tnc_shift, mask: pb.tnc_mask }, codes: [1] })).toEqual(['TNC category 1']);
    expect(words('protect', { bit: pb.outside_popwest_bit })).toEqual(['outside the PoPWest study area']);
    expect(words('protect', { bit: pb.nps_preserve_bit })).toEqual(['NPS unit named Preserve']);
    const adj = g.adj;
    expect(adj.class_100_mask).toBe(adj.class_mask << adj.class_100_shift);
    for (const c of Object.keys(adj.classes)) {
      expect(matchText('adj', { field: { shift: 0, mask: adj.class_mask }, codes: [+c] }).some(raw)).toBe(false);
      expect(matchText('adj', { field: { shift: adj.class_100_shift, mask: adj.class_mask }, codes: [+c] }).some(raw)).toBe(false);
    }
    const tables: [Parameters<typeof matchText>[0], string][] = [['flags', 'pd_flags'], ['desig', 'desig_bits'], ['flags2', 'flags2_bits'], ['osm_flags', 'osm_flags']];
    for (const [band, key] of tables) {
      for (const bit of Object.keys(g[key])) {
        const xs = matchText(band, { bit: +bit });
        expect(xs.some(raw), `${band} bit ${bit}`).toBe(false);
        expect(dict[(xs[0] as { k: string }).k], `${band} bit ${bit}`).toBeTypeOf('string');
      }
    }
    for (const [band, key] of [['whpclass', 'whp_classes'], ['agency', 'agency']] as const) {
      for (const code of Object.keys(g[key])) expect(matchText(band, { codes: [+code] }).some(raw), `${band} ${code}`).toBe(false);
    }
  });
});
