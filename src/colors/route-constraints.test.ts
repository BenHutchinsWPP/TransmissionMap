import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CONCERNS, CONSTRAINT_PALETTE, LAND_MANAGER_PALETTE, DEFAULT_CONCERN, CONCERN_GROUPS, OSM_RULE_BANDS,
  concernById, concernColour, concernReadsOsm, concernKeys, isConcernId, constraintsExport, constraintsSets,
  ruleMatches, type ConstraintRule,
} from './route-constraints.js';
import { ROUTE_PRESETS } from '../registry/route-presets.js';
import { matches } from '../../assets/route/cost.js';

const grid = JSON.parse(readFileSync(new URL('../../assets/route/fixtures/cube/grid.json', import.meta.url), 'utf8'));
const JSON_PATH = new URL('../../scripts/route_constraints.json', import.meta.url);
const SETS_PATH = new URL('../../scripts/route_constraints_sets.json', import.meta.url);
const bandNo = (name: string) => Object.entries(grid.pd_bands).find(([, v]) => v === name)?.[0];
const osmBandNo = (name: string) => Object.entries(grid.osm_bands).find(([, v]) => name === (v === 'adj' ? 'adj' : `osm_${v}`))?.[0];
const bitTable: Record<string, Record<string, string>> = {
  flags: grid.pd_flags, desig: grid.desig_bits, flags2: grid.flags2_bits, osm_flags: grid.osm_flags,
};

function checkRule(r: ConstraintRule) {
  if (OSM_RULE_BANDS.includes(r.band)) expect(osmBandNo(r.band), `osm band ${r.band}`).toBeDefined();
  else expect(bandNo(r.band), `pd band ${r.band}`).toBeDefined();
  if ('bit' in r) {
    expect(bitTable[r.band]?.[String(r.bit)], `${r.band} bit ${r.bit}`).toBeDefined();
  } else if (r.band === 'adj') {
    const allowed = grid.adj.class_mask | grid.adj.class_100_mask;
    const mask = r.mask ?? 0xff;
    expect(mask & ~allowed, `adj mask ${mask}`).toBe(0);
    for (const v of r.values) {
      expect(v & ~mask, `adj value ${v} within mask`).toBe(0);
      expect(v & mask, `adj value ${v} names a line class`).not.toBe(0);
    }
  } else {
    expect(r.values.length).toBeGreaterThan(0);
    for (const v of r.values) expect(Number.isInteger(v) && v >= 1 && v <= 255).toBe(true);
    if (r.band === 'agency') for (const v of r.values) expect(grid.agency[String(v)]).toBeDefined();
    if (r.band === 'whpclass') for (const v of r.values) expect(grid.whp_classes[String(v)]).toBeDefined();
    if (r.band === 'slope') for (const v of r.values) expect(grid.slope_bins[String(v)]).toBeDefined();
  }
}

describe('route concerns', () => {
  it('ids are unique and URL-safe', () => {
    const ids = CONCERNS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('has the default, a valid group per entry, and a validator', () => {
    expect(isConcernId(DEFAULT_CONCERN)).toBe(true);
    expect(isConcernId('nope')).toBe(false);
    expect(isConcernId(5)).toBe(false);
    expect(concernById('floodplain')?.kind).toBe('mask');
    for (const c of CONCERNS) expect(CONCERN_GROUPS).toContain(c.group);
  });
  it('every rule names an existing pd band and bit/value', () => {
    for (const c of CONCERNS) { if (c.rule) checkRule(c.rule); c.classes?.forEach(k => k.rules.forEach(checkRule)); }
    for (const c of CONSTRAINT_PALETTE) c.rules.forEach(checkRule);
    for (const c of CONCERNS) expect(c.kind === 'mask').toBe(Boolean(c.rule && c.colour));
  });
  it('the overview and land-manager rules read no OSM band', () => {
    for (const c of [...CONSTRAINT_PALETTE, ...LAND_MANAGER_PALETTE])
      for (const r of c.rules) expect(OSM_RULE_BANDS, `${c.id} ${r.band}`).not.toContain(r.band);
  });
  it('concernReadsOsm is true exactly for the OSM concerns', () => {
    expect(CONCERNS.filter(concernReadsOsm).map(c => c.id).sort()).toEqual(
      ['existing-line-230', 'osm-lake', 'osm-military', 'parallel-100', 'parallel-230']);
  });
  it('CONCERNS stays contiguous and in CONCERN_GROUPS order', () => {
    const order = CONCERNS.map(c => CONCERN_GROUPS.indexOf(c.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('concernKeys names every label and class key', () => {
    const keys = concernKeys();
    for (const c of CONCERNS) { expect(keys).toContain(c.labelKey); for (const k of c.classes ?? []) expect(keys).toContain(k.labelKey); }
  });
  it('land manager rules are valid; agency codes are real, unique, and not private/none', () => {
    LAND_MANAGER_PALETTE.forEach(c => c.rules.forEach(checkRule));
    const codes = LAND_MANAGER_PALETTE.flatMap(c => c.rules.flatMap(r => ('band' in r && r.band === 'agency' && 'values' in r) ? r.values : []));
    expect(new Set(codes).size).toBe(codes.length);
    for (const k of codes) expect(grid.agency[String(k)]).toBeDefined();
    expect(codes).not.toContain(1);
  });
});

describe('land manager draw order', () => {
  const rules = (id: string) => LAND_MANAGER_PALETTE.find(c => c.id === id)!.rules;
  const matches = (r: ConstraintRule, cell: Record<string, number>) =>
    'bit' in r ? ((cell[r.band] >> r.bit) & 1) === 1 : r.values.includes(cell[r.band] & (r.mask ?? 0xff));
  // highest code among the classes whose rules match the cell
  const winner = (cell: Record<string, number>) =>
    LAND_MANAGER_PALETTE.filter(c => c.rules.some(r => matches(r, cell))).sort((a, b) => b.code - a.code)[0]?.id;
  it('codes descend in draw order: tribal, then DOD, then the agency managers', () => {
    expect(LAND_MANAGER_PALETTE.map(c => c.code)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(LAND_MANAGER_PALETTE.slice(0, 2).map(c => c.id)).toEqual(['tribal', 'dod']);
  });
  it('flags bit 0 beats any agency; flags bit 1 beats any agency but tribal', () => {
    expect(winner({ flags: 1, agency: 9 })).toBe('tribal');
    expect(winner({ flags: 2, agency: 10 })).toBe('dod');
    expect(winner({ flags: 3, agency: 10 })).toBe('tribal');
    expect(winner({ flags: 0, agency: 2 })).toBe('blm');
    expect(winner({ flags: 0, agency: 1 })).toBeUndefined();
  });
  it('tribal and DOD keep their agency codes as well as the flags bits', () => {
    expect(rules('tribal')).toContainEqual({ band: 'agency', values: [12] });
    expect(rules('dod')).toContainEqual({ band: 'agency', values: [6] });
  });
  it('is exported with codes and rules', () => {
    const lm = constraintsExport().landManager;
    expect(lm[0]).toMatchObject({ id: 'tribal', code: 10 });
    expect(lm.every(c => c.rules.length > 0)).toBe(true);
  });
});

describe('nps-preserve concern', () => {
  it('tests protect bit 7, the cube\'s nps_preserve_bit', () => {
    expect(concernById('nps-preserve')?.rule).toEqual({ band: 'protect', values: [128], mask: 128 });
    expect(1 << grid.protect_bits.nps_preserve_bit).toBe(128);
  });
});

describe('observed building concerns', () => {
  it('shows positive observations separately from the shared processed coverage', () => {
    const expected: Record<string, [string, number]> = {
      buildings: ['built', 2], nonresidential: ['nonres', 2], 'building-unknown': ['bldgunk', 2], 'building-coverage': ['built', 1],
    };
    for (const [id, [band, lo]] of Object.entries(expected)) {
      const c = concernById(id)!;
      expect(c.group).toBe('population');
      expect(c.kind).toBe('mask');
      expect(c.rule?.band).toBe(band);
      expect(Array.from({ length: 256 }, (_, v) => v).filter((v) => ruleMatches(c.rule!, v)))
        .toEqual(Array.from({ length: 102 - lo }, (_, i) => lo + i));
      expect(c.noteKey).toBeTruthy();
    }
  });

  it('keeps observed footprint data out of the constraint overview', () => {
    for (const cls of CONSTRAINT_PALETTE)
      for (const rule of cls.rules) expect(['built', 'nonres', 'bldgunk']).not.toContain(rule.band);
    expect(new Set(['buildings', 'nonresidential', 'building-unknown', 'building-coverage'].map(concernColour)).size).toBe(4);
  });
});

describe('overview palette', () => {
  it('codes strictly descend in draw order (drawn on top = highest code)', () => {
    const codes = CONSTRAINT_PALETTE.map(c => c.code);
    expect(codes).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });
  it('uses exactly the decided hybrid-H hexes', () => {
    expect(CONSTRAINT_PALETTE.map(c => [c.id, c.colour])).toEqual([
      ['tribal', '#7c3aed'], ['military', '#dc2626'], ['wsa', '#2b4595'], ['gap-1-2', '#5bbe71'],
      ['critical-habitat', '#f38038'], ['phma', '#f362dd'], ['sites', '#7f2502'],
      ['floodplain', '#a6cee3'], ['other-federal', '#758595'],
    ]);
  });
  it('land manager colours are the PAD-US ones', () => {
    expect(Object.fromEntries(LAND_MANAGER_PALETTE.map(c => [c.id, c.colour]))).toEqual({
      blm: '#ca8a04', usfs: '#15803d', nps: '#b45309', fws: '#0891b2', dod: '#dc2626',
      state: '#ea580c', local: '#eab308', tribal: '#7c3aed', 'other-federal': '#64748b', ngo: '#84cc16',
    });
  });
});

describe('scripts/route_constraints.json', () => {
  const text = JSON.stringify(constraintsExport(), null, 2) + '\n';
  const setsText = JSON.stringify(constraintsSets()) + '\n';
  it('equals the generated export (UPDATE_ROUTE_CONSTRAINTS=1 rewrites it)', () => {
    if (process.env.UPDATE_ROUTE_CONSTRAINTS) writeFileSync(JSON_PATH, text);
    expect(readFileSync(JSON_PATH, 'utf8')).toBe(text);
  });
  it('scripts/route_constraints_sets.json equals the generated sets', () => {
    if (process.env.UPDATE_ROUTE_CONSTRAINTS) writeFileSync(SETS_PATH, setsText);
    expect(readFileSync(SETS_PATH, 'utf8')).toBe(setsText);
  });
});

const valuesOf = (rules: ConstraintRule[]) => Array.from({ length: 256 }, (_, v) => v).filter(v => rules.some(r => ruleMatches(r, v)));

describe('classes concerns', () => {
  const classed = CONCERNS.filter(c => c.kind === 'classes');
  it('are the expected ones, with no rule or colour of their own', () => {
    expect(classed.map(c => c.id).sort()).toEqual(
      ['aviation', 'fema-flood', 'gap-1-2', 'homes', 'isoreg', 'landcover', 'landval', 'slope', 'tnc', 'wetland', 'wildfire-high', 'wildfire-potential']);
    for (const c of classed) { expect(c.rule).toBeUndefined(); expect(c.colour).toBeUndefined(); }
  });
  it('have distinct codes in 1..255 and a valid resampling (nominal classes mode, ordinal max)', () => {
    for (const c of classed) {
      const codes = c.classes!.map(k => k.code);
      expect(new Set(codes).size, c.id).toBe(codes.length);
      for (const k of codes) expect(k >= 1 && k <= 255).toBe(true);
      expect(c.resampling, c.id).toBe(['landcover', 'isoreg', 'fema-flood'].includes(c.id) ? 'mode' : 'max');
    }
  });
  it('3b: the class value sets of one concern are pairwise disjoint', () => {
    for (const c of classed) {
      const seen = new Map<number, string>();
      for (const k of c.classes!) for (const v of valuesOf(k.rules)) {
        expect(seen.get(v), `${c.id}: value ${v} in ${k.id} and ${seen.get(v)}`).toBeUndefined();
        seen.set(v, k.id);
      }
    }
  });
  it('a converted id keeps the cells of its old rule', () => {
    const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    const old: Record<string, ConstraintRule> = {
      'gap-1-2': { band: 'protect', values: [1, 2], mask: 0b111 },
      'wildfire-high': { band: 'whpclass', values: [4, 5] },
      wetland: { band: 'wetland', values: range(27, 101) },
      homes: { band: 'bldg', values: range(2, 255) },
    };
    for (const [id, rule] of Object.entries(old))
      expect(valuesOf(concernById(id)!.classes!.flatMap(k => k.rules)), id).toEqual(valuesOf([rule]));
  });
  it('concernColour: a mask\'s colour, else the highest-code class', () => {
    expect(concernColour('homes')).toBe('#b45309');
    expect(concernColour('floodplain')).toBe(concernById('floodplain')!.colour);
    expect(concernColour('section-368')).toBe('#0f766e');
  });
});

describe('every method row has a picker entry', () => {
  const ramp = (f: unknown, lo: number, hi: number, v: number): number =>
    typeof f === 'number' ? f : (() => { const [a, b] = (f as { ramp: [number, number] }).ramp; return a + (b - a) * (v - lo) / (hi - lo); })();
  const covers = (bandName: string, s: number[]): boolean => CONCERNS.some(c => {
    const groups = c.rule ? [[c.rule]] : (c.classes ?? []).map(k => k.rules);
    if (groups.length === 0 || groups.some(g => g.some(r => r.band !== bandName))) return false;
    const hit = groups.map(g => valuesOf(g)).filter(vs => vs.some(v => s.includes(v)));
    const union = [...new Set(hit.flat())].sort((a, b) => a - b);
    return union.length === s.length && union.every((v, i) => v === s[i]) && hit.every(vs => vs.every(v => s.includes(v)));
  });
  for (const id of ['tm-default', 'pnas-wu2023']) {
    it(`${id}: each row and exemption is drawn by one entry`, () => {
      const p = ROUTE_PRESETS.find(x => x.id === id)!;
      p.rows.forEach((row, i) => {
        let s = Array.from({ length: 255 }, (_, k) => k + 1).filter(v => matches(row.match, v));
        if ('range' in row.match && (typeof row.route_w !== 'number' || typeof row.cost_x !== 'number')) {
          const [lo, hi] = row.match.range;
          s = s.filter(v => ramp(row.route_w, lo, hi, v) !== 1 || ramp(row.cost_x, lo, hi, v) !== 1);
        }
        expect(s.length, `${id} row ${i} (${row.note}) matches nothing`).toBeGreaterThan(0);
        expect(covers(row.band, s), `${id} row ${i} (${row.note}) on ${row.band}`).toBe(true);
        (row.except ?? []).forEach((e, j) => {
          const se = Array.from({ length: 255 }, (_, k) => k + 1).filter(v => matches(e.match, v));
          expect(se.length, `${id} row ${i} except ${j} matches nothing`).toBeGreaterThan(0);
          expect(covers(e.band, se), `${id} row ${i} (${row.note}) except ${j} (${e.label}) on ${e.band}`).toBe(true);
        });
      });
    });
  }
});
