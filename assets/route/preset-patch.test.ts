// Tests for preset-patch.ts: refusals at the editor / request boundary and
// copy-not-mutate.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTE_PRESETS, routePreset } from '../../src/registry/route-presets.js';
import { route, type RouteIO } from './route.js';
import { uploadHashes, USER_COST_SRC, validatePresetPatch, validateRouteOptions, validateTerminals } from './preset-patch.js';

const P = routePreset('tm-default')!;
const constRow = P.rows.findIndex((r) => typeof r.route_w === 'number');
const Q = ROUTE_PRESETS.find((p) => p.rows.some((r) => typeof r.route_w !== 'number'));
const rampRow = Q ? Q.rows.findIndex((r) => typeof r.route_w !== 'number') : -1;
const group = Object.keys(P.combine)[0];
/** The address of row i: index + its band and note. */
const at = (i: number, preset = P) => ({ row: i, band: preset.rows[i].band, note: preset.rows[i].note });

const refused = (patch: unknown, preset = P) => {
  const r = validatePresetPatch(preset, patch);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('validatePresetPatch refusals', () => {
  it.each([[NaN], [Infinity], [-Infinity], [JSON.parse('1e400')], ['abc'], ['2'], [null], [0], [0.009], [10001]])('route_w %s', (v) => {
    refused({ rows: [{ ...at(constRow), route_w: v }] });
  });
  it.each([[NaN], [Infinity], ['abc'], [0.05], [101]])('cost_x %s', (v) => {
    refused({ rows: [{ ...at(constRow), cost_x: v }] });
  });
  it('a regional row\'s cost_x scale must keep every regional set in range', () => {
    const i = P.rows.findIndex((r) => r.note === 'forest');   // TEPPC 2.25, SCE 3, MISO 1.2, Southeast 1.47
    expect(refused({ rows: [{ ...at(i), cost_x: 40 }] })).toBe('row 0 cost_x scales every regional cost set: ×40 gives 48–120, outside [0.1, 100]'.replace('row 0', `row ${i}`));
    expect(validatePresetPatch(P, { rows: [{ ...at(i), cost_x: 33 }] }).ok).toBe(true);   // 3 × 33 = 99
    const low = structuredClone(P);
    low.rows[i].cost_by_region = { TEPPC: 0.5, SCE: 3 };
    expect(refused({ rows: [{ ...at(i, low), cost_x: 0.15 }] }, low)).toMatch(/×0\.15 gives 0\.075–0\.45, outside \[0\.1, 100\]/);
    expect(validatePresetPatch(low, { rows: [{ ...at(i, low), cost_x: 0.2 }] }).ok).toBe(true);
  });
  it('contingency', () => {
    for (const v of [NaN, Infinity, JSON.parse('1e400'), 'abc', -0.1, 1.1]) refused({ contingency: v });
  });
  it('ramp rows take a [from, to] pair, constant rows a number', () => {
    expect(Q).toBeDefined();
    refused({ rows: [{ ...at(rampRow, Q), route_w: 2 }] }, Q);
    refused({ rows: [{ ...at(rampRow, Q), route_w: [1, NaN] }] }, Q);
    refused({ rows: [{ ...at(constRow), route_w: [1, 2] }] });
  });
  it('unknown row, group, field, rule', () => {
    for (const row of [-1, P.rows.length, 1.5, '0', undefined]) refused({ rows: [{ row, band: P.rows[0].band, note: P.rows[0].note, route_w: 1 }] });
    refused({ combine: { nope: 'max' } });
    refused({ combine: { [group]: 'sum' } });
    refused({ rows: [{ ...at(0), match: { codes: [1] } }] });
    refused({ bogus: 1 });
    refused('abc');
    refused([]);
    refused({ rows: {} });
  });
  it('a row whose band or note differs from the row at that index', () => {
    const other = P.rows.findIndex((r, i) => i !== constRow && r.note !== P.rows[constRow].note);
    expect(refused({ rows: [{ ...at(constRow), band: 'adj', route_w: 2 }] })).toContain(`row ${constRow} is`);
    refused({ rows: [{ ...at(constRow), note: P.rows[other].note, route_w: 2 }] });
    refused({ rows: [{ row: constRow, route_w: 2 }] });
    refused({ rows: [{ ...at(other), row: constRow, route_w: 2 }] });
  });
  it('length_factor: a boolean, on a preset that has short-line factors', () => {
    for (const v of ['false', 0, null, 1]) refused({ length_factor: v });
    const none = ROUTE_PRESETS.find((p) => !p.length_factor)!;
    refused({ length_factor: false }, none);
    refused({ length_factor: true }, none);
  });
  it('contingency on a preset without one', () => {
    const none = ROUTE_PRESETS.find((p) => !p.contingency);
    if (none) expect(validatePresetPatch(none, { contingency: 0.1 }).ok).toBe(false);
  });
});

describe('validatePresetPatch applies', () => {
  it('a ramp row takes a [from, to] pair', () => {
    const before = JSON.stringify(Q);
    const r = validatePresetPatch(Q!, { rows: [{ ...at(rampRow, Q), route_w: [1, 3] }] });
    expect(r.ok && r.result.rows[rampRow].route_w).toEqual({ ramp: [1, 3] });
    expect(JSON.stringify(Q)).toBe(before);
  });
  it('changes only its target and leaves the registry preset untouched', () => {
    const before = JSON.stringify(P);
    const r = validatePresetPatch(P, {
      rows: [{ ...at(constRow), route_w: 7, cost_x: 1.5 }],
      contingency: 0.1, combine: { [group]: 'multiply' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.result;
    expect(JSON.stringify(P)).toBe(before);
    expect(out).not.toBe(P);
    expect(out.rows[constRow].route_w).toBe(7);
    expect(out.rows[constRow].cost_x).toBe(1.5);
    expect(out.contingency!.pct).toBe(0.1);
    expect(out.combine[group]).toBe('multiply');
    // everything else equal
    const same = structuredClone(out);
    same.rows[constRow] = P.rows[constRow];
    same.contingency = P.contingency; same.combine = P.combine;
    expect(JSON.stringify(same)).toBe(before);
  });
  it('length_factor false drops the short-line factors, true keeps them', () => {
    expect(P.length_factor).toBeDefined();
    const off = validatePresetPatch(P, { length_factor: false });
    expect(off.ok && off.result.length_factor).toBeUndefined();
    expect(P.length_factor).toBeDefined();
    const on = validatePresetPatch(P, { length_factor: true });
    expect(on.ok && on.result.length_factor).toEqual(P.length_factor);
  });
  it('no patch returns the preset itself; an empty patch a copy equal to it', () => {
    expect(validatePresetPatch(P, undefined)).toEqual({ ok: true, result: P });
    const r = validatePresetPatch(P, {});
    expect(r.ok && JSON.stringify(r.result)).toBe(JSON.stringify(P));
  });
});

describe('validatePresetPatch except toggles', () => {
  const ex = P.rows.findIndex((r) => (r.except?.length ?? 0) > 0);
  const n = ex >= 0 ? P.rows[ex].except!.length : 0;
  const plain = P.rows.findIndex((r) => !r.except);
  it('tm-default has a row with labelled exemptions', () => {
    expect(ex).toBeGreaterThanOrEqual(0);
    for (const e of P.rows[ex].except!) expect(e.label.trim().length).toBeGreaterThan(0);
  });
  it('refuses a list longer than the row has entries, a non-boolean or a non-array', () => {
    for (const v of [Array(n + 1).fill(true), Array(n).fill(1), Array(n).fill('true'), true, null, { 0: true }])
      refused({ rows: [{ ...at(ex), except: v }] });
    refused({ rows: [{ ...at(plain), except: [true] }] });
    expect(validatePresetPatch(P, { rows: [{ ...at(plain), except: [] }] }).ok).toBe(true);
  });
  it('a shorter list (saved before an entry was appended) sets the first entries and leaves the rest at their default', () => {
    const def = P.rows[ex].except!.map((e) => e.active !== false);
    const r = validatePresetPatch(P, { rows: [{ ...at(ex), except: [!def[0]] }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.rows[ex].except!.map((e) => e.active !== false)).toEqual([!def[0], ...def.slice(1)]);
  });
  it('sets each entry on or off on a copy; bands and matches never change', () => {
    const before = JSON.stringify(P);
    const flags = P.rows[ex].except!.map((e) => e.active === false);   // invert every entry
    const r = validatePresetPatch(P, { rows: [{ ...at(ex), except: flags }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(P)).toBe(before);
    r.result.rows[ex].except!.forEach((e, j) => {
      expect(e.active).toBe(flags[j]);
      expect(e.band).toBe(P.rows[ex].except![j].band);
      expect(e.match).toEqual(P.rows[ex].except![j].match);
    });
  });
});

describe('validateRouteOptions', () => {
  it('defaults', () => {
    expect(validateRouteOptions({})).toEqual({ ok: true, result: { alternatives: 0, altStretch: 0.2, surface: false, profile: false } });
  });
  it('accepts the bounds', () => {
    expect(validateRouteOptions({ alternatives: 3, altStretch: 0.5, surface: true }).ok).toBe(true);
    expect(validateRouteOptions({ alternatives: 0, altStretch: 0.01 }).ok).toBe(true);
  });
  it.each([[{ altStretch: 0 }], [{ altStretch: 0.6 }], [{ altStretch: NaN }], [{ altStretch: '0.2' }], [{ alternatives: 4 }],
    [{ alternatives: -1 }], [{ alternatives: 1.5 }], [{ alternatives: '1' }], [{ surface: 1 }], [{ surface: 'true' }], [{ profile: 1 }], [{ profile: 'true' }]])('refuses %j', (o) => {
    expect(validateRouteOptions(o).ok).toBe(false);
  });
});

describe('route() request entry', () => {
  const dir = new URL('./fixtures/cube/', import.meta.url);
  const gj = JSON.parse(readFileSync(new URL('grid.json', dir), 'utf8'));
  const io: RouteIO = {
    baseUrl: 'mem://cube/',
    async fetchJson() { return gj; },
    async fetchRange(url, start, end) {
      const buf = readFileSync(new URL(url.slice('mem://cube/'.length), dir));
      return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
    },
  };
  const base = { from: [-100, 40] as [number, number], to: [-99, 40] as [number, number], preset: 'tm-default', lineType: 'ac500' };

  it('refuses a bad patch and bad options before reading the cube', async () => {
    for (const extra of [{ presetPatch: { contingency: 'abc' } }, { alternatives: 4 }, { altStretch: 0 }, { altStretch: 0.6 }, { surface: 'yes' }]) {
      const r = await route({ ...base, ...extra } as never, io);
      expect(r.ok).toBe(false);
    }
  });

  it('refuses a preset whose regions.sets names an ISO absent from grid.json', async () => {
    const withRegions = ROUTE_PRESETS.find((p) => p.regions && p.length === 'routed');
    if (!withRegions) return;
    const bad = structuredClone(withRegions);
    bad.id = 'bogus-iso';
    bad.regions!.sets = { ...bad.regions!.sets, 'No Such ISO': 'x' };
    ROUTE_PRESETS.push(bad);
    try {
      const r = await route({ ...base, preset: 'bogus-iso' }, io);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain('No Such ISO');
    } finally {
      ROUTE_PRESETS.splice(ROUTE_PRESETS.indexOf(bad), 1);
    }
  });
});

describe('validatePresetPatch add_rows (uploaded layers)', () => {
  const H = ['0123456789abcdef', 'fedcba9876543210', '00000000000000aa', '00000000000000bb', '00000000000000cc'];
  const row = (i: number, o: Record<string, unknown> = {}) => ({ layer: H[i], label: `layer ${i}`, route_w: 5, cost_x: 1.5, ...o });

  it('appends one row per entry on upl_<hash>, after the preset rows; labels stripped; rows patch untouched', () => {
    const r = validatePresetPatch(P, { add_rows: [row(0, { label: ' a\u0007b\n ' }), row(1, { barrier: true, route_w: 1, cost_x: 1 })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.rows).toHaveLength(P.rows.length + 2);
    expect(r.result.rows.slice(P.rows.length)).toEqual([
      { band: `upl_${H[0]}`, match: { codes: [1] }, route_w: 5, cost_x: 1.5, note: 'ab', src: `uploaded layer ${H[0]}` },
      { band: `upl_${H[1]}`, match: { codes: [1] }, route_w: 1, cost_x: 1, barrier: 'hard', note: 'layer 1', src: `uploaded layer ${H[1]}` },
    ]);
    expect(P.rows.some((x) => x.band.startsWith('upl'))).toBe(false);
    expect(uploadHashes({ add_rows: [row(1), row(0)] })).toEqual([H[1], H[0]]);
    expect(uploadHashes(undefined)).toEqual([]);
  });

  it('a 60-character label (code points) is taken, 61 is not', () => {
    expect(validatePresetPatch(P, { add_rows: [row(0, { label: '東'.repeat(60) })] }).ok).toBe(true);
    expect(refused({ add_rows: [row(0, { label: 'x'.repeat(61) })] })).toMatch(/label must be 1–60/);
    expect(refused({ add_rows: [row(0, { label: '\u0000\u001f ' })] })).toMatch(/label must be 1–60/);
    expect(refused({ add_rows: [row(0, { label: 7 })] })).toMatch(/label/);
  });

  it.each([
    ['unknown field', { add_rows: [row(0, { geometry: [[0, 0]] })] }, /unknown field "geometry"/],
    ['a band', { add_rows: [row(0, { band: 'protect' })] }, /unknown field "band"/],
    ['a remove key', { add_rows: [{ layer: H[0], remove: true }] }, /"remove"/],
    ['remove: false', { add_rows: [row(0, { remove: false })] }, /"remove"/],
    ['bad hash', { add_rows: [row(0, { layer: '0123456789ABCDEF' })] }, /16-hex/],
    ['short hash', { add_rows: [row(0, { layer: 'abc' })] }, /16-hex/],
    ['repeated hash', { add_rows: [row(0), row(0)] }, /repeats/],
    ['route_w low', { add_rows: [row(0, { route_w: 0.001 })] }, /route_w/],
    ['route_w high', { add_rows: [row(0, { route_w: 10001 })] }, /route_w/],
    ['route_w ramp', { add_rows: [row(0, { route_w: [1, 2] })] }, /route_w/],
    ['route_w missing', { add_rows: [row(0, { route_w: undefined })] }, /route_w/],
    ['cost_x low', { add_rows: [row(0, { cost_x: 0.05 })] }, /cost_x/],
    ['cost_x high', { add_rows: [row(0, { cost_x: 101 })] }, /cost_x/],
    ['cost_x NaN', { add_rows: [row(0, { cost_x: NaN })] }, /cost_x/],
    ['barrier string', { add_rows: [row(0, { barrier: 'hard' })] }, /barrier/],
    ['not an array', { add_rows: row(0) }, /must be an array/],
    ['not an object', { add_rows: [null] }, /must be an object/],
  ])('refuses %s', (_name, patch, re) => {
    expect(refused(patch)).toMatch(re);
  });

  it('a rows patch cannot address an uploaded row (it does not exist yet)', () => {
    expect(refused({ rows: [{ row: P.rows.length, band: 'upl0', note: 'layer 0', route_w: 2 }], add_rows: [row(0)] })).toMatch(/row must be an integer/);
  });
});

describe('cost_inputs', () => {
  const ok = { basis: 'bare', year: 2020, line_types: { ac230: { usd_per_mi: 2e6, station_usd: 1e7, position_usd: 3e6 } } };
  const allIn = { basis: 'all-in', year: 2020, line_types: { ac230: { usd_per_mi: 5e6 } } };
  const give = (cost_inputs: unknown, extra: object = {}, preset = P) => refused({ cost_inputs, ...extra }, preset);

  it('refuses a bad shape, basis and year', () => {
    for (const v of [null, 'x', [], 5]) give(v);
    give({ year: 2020 });
    give({ basis: 'bare' });
    for (const b of ['Bare', 'allin', '', 1, null]) give({ basis: b, year: 2020 });
    for (const y of [NaN, Infinity, JSON.parse('1e400'), '2020', 2020.5, 1989, 2026, null]) give({ basis: 'bare', year: y });
    expect(validatePresetPatch(P, { cost_inputs: { basis: 'bare', year: 1990 } }).ok).toBe(true);
    expect(validatePresetPatch(P, { cost_inputs: { basis: 'bare', year: 2025 } }).ok).toBe(true);
  });
  it('refuses unknown keys at every level', () => {
    expect(give({ ...ok, extra: 1 })).toContain('"extra"');
    expect(give({ ...ok, line_types: { ac230: { usd_per_mi: 1, bogus: 2 } } })).toContain('"bogus"');
    give({ ...ok, line_types: { ac999: { usd_per_mi: 1 } } });
    give({ ...ok, line_types: { __proto__x: { usd_per_mi: 1 } } });
    give({ ...ok, line_types: [] });
    give({ ...ok, line_types: { ac230: 5 } });
  });
  it('every entry needs a figure; each figure is a finite number in range', () => {
    give({ ...ok, line_types: { ac230: {} } });
    for (const v of [0, -1, NaN, Infinity, JSON.parse('1e400'), '1', null, 1e9 + 1]) give({ ...ok, line_types: { ac230: { usd_per_mi: v } } });
    for (const f of ['station_usd', 'position_usd'])
      for (const v of [-1, NaN, Infinity, JSON.parse('1e400'), '1', null, 1e10 + 1]) give({ ...ok, line_types: { ac230: { [f]: v } } });
    for (const v of [1e9]) expect(validatePresetPatch(P, { cost_inputs: { ...ok, line_types: { ac230: { usd_per_mi: v } } } }).ok).toBe(true);
    for (const f of ['station_usd', 'position_usd'])
      for (const v of [0, 1e10]) expect(validatePresetPatch(P, { cost_inputs: { ...ok, line_types: { ac230: { [f]: v } } } }).ok).toBe(true);
  });
  it('ends: exactly two of auto, new, position, none', () => {
    for (const e of [[], ['auto'], ['auto', 'auto', 'auto'], ['auto', 'x'], ['auto', 1], 'auto', { 0: 'auto', 1: 'auto' }]) give({ ...ok, ends: e });
    expect(validatePresetPatch(P, { cost_inputs: { ...ok, ends: ['auto', 'none'] } }).ok).toBe(true);
    expect(validatePresetPatch(P, { cost_inputs: { basis: 'bare', year: 2020, ends: ['position', 'new'] } }).ok).toBe(true);
  });
  it('all-in needs a $/mi for every entry and refuses the settings it makes meaningless', () => {
    give({ basis: 'all-in', year: 2020 });
    give({ basis: 'all-in', year: 2020, line_types: {} });
    give({ basis: 'all-in', year: 2020, line_types: { ac230: { station_usd: 1e6 } } });
    give({ basis: 'all-in', year: 2020, line_types: { ac230: { usd_per_mi: 1e6 }, ac345: { station_usd: 1e6 } } });
    give(allIn, { contingency: 0.2 });
    give(allIn, { combine: { [group]: 'multiply' } });
    give(allIn, { length_factor: true });
    give(allIn, { length_factor: false });
    give(allIn, { rows: [{ ...at(constRow), cost_x: 1 }] });
    give(allIn, { add_rows: [{ layer: '0123456789abcdef', label: 'x', route_w: 1, cost_x: 2 }] });
    expect(validatePresetPatch(P, { cost_inputs: allIn, rows: [{ ...at(constRow), route_w: 3 }] }).ok).toBe(true);
    expect(validatePresetPatch(P, { cost_inputs: allIn, add_rows: [{ layer: '0123456789abcdef', label: 'x', route_w: 1, cost_x: 1 }] }).ok).toBe(true);
  });
  it('bare applies the figures with their year and source, records user_costs, leaves the registry alone', () => {
    const before = JSON.stringify(P);
    const r = validatePresetPatch(P, { cost_inputs: ok });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const l = r.result.line_types.ac230;
    expect(l.base_per_mi).toEqual({ usd: 2e6, year: 2020, src: USER_COST_SRC });
    expect(l.terminals).toMatchObject({ usd_each: 1e7, year: 2020, src: USER_COST_SRC, position: { usd_each: 3e6, year: 2020, arithmetic: '', src: USER_COST_SRC } });
    expect(r.result.user_costs).toEqual({ basis: 'bare', year: 2020, items: ['line', 'station', 'position'], line_types: ['ac230'] });
    expect(r.result.markups).toEqual(P.markups);
    expect(r.result.contingency).toEqual(P.contingency);
    expect(r.result.line_types.ac345).toEqual(P.line_types.ac345);
    expect(JSON.stringify(P)).toBe(before);
    expect('user_costs' in P).toBe(false);
  });
  it('all-in drops markups, contingency, mitigation, ROW land and the short-line factor, and neutralises every cost multiplier', () => {
    const r = validatePresetPatch(P, { cost_inputs: allIn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.result;
    expect(o.markups).toEqual([]);
    for (const k of ['contingency', 'mitigation', 'row_land', 'length_factor'] as const) expect(o[k]).toBeUndefined();
    expect(o.rows.every((x) => x.cost_x === 1 && x.cost_by_region === undefined)).toBe(true);
    expect(o.rows.map((x) => x.route_w)).toEqual(P.rows.map((x) => x.route_w));
    expect(o.rows.map((x) => x.barrier)).toEqual(P.rows.map((x) => x.barrier));
    expect(o.user_costs).toEqual({ basis: 'all-in', year: 2020, items: ['line'], line_types: ['ac230'] });
  });
  it('works on a study preset (position figure entered on a preset that has none)', () => {
    const w = routePreset('westtec-es')!;
    const r = validatePresetPatch(w, { cost_inputs: { basis: 'bare', year: 2024, line_types: { ac500: { position_usd: 5e6 } } } });
    expect(r.ok && r.result.line_types.ac500.terminals.position?.usd_each).toBe(5e6);
    expect(w.line_types.ac500.terminals.position).toBeUndefined();
  });
  it('registry presets carry no user_costs; a patch from before (no cost_inputs) still validates', () => {
    for (const p of ROUTE_PRESETS) expect(p.user_costs, p.id).toBeUndefined();
    const r = validatePresetPatch(P, { rows: [{ ...at(constRow), route_w: 3 }], contingency: 0.2, length_factor: false });
    expect(r.ok && r.result.user_costs).toBeUndefined();
  });
});

describe('validateTerminals', () => {
  const lt = 'ac230';
  const fine = (k: unknown, p = P, l = lt) => validateTerminals(k, p, l);
  it('accepts two kinds, each of new, position, none', () => {
    for (const a of ['new', 'position', 'none'])
      for (const b of ['new', 'position', 'none']) expect(fine([a, b])).toEqual({ ok: true, result: [a, b] });
  });
  it('refuses the wrong shape and an unknown kind', () => {
    for (const k of [undefined, null, 'new', ['new'], ['new', 'new', 'new'], ['new', 'auto'], ['new', 1], ['position', null], { 0: 'new', 1: 'new' }, [['new'], 'new']])
      expect(fine(k).ok, JSON.stringify(k)).toBe(false);
  });
  it('refuses position where the line type has no position figure, naming the line type', () => {
    const r = validateTerminals(['position', 'new'], P, 'dc500');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('dc500');
    expect(validateTerminals(['new', 'none'], P, 'dc500').ok).toBe(true);
    expect(validateTerminals(['position', 'new'], routePreset('bv-2014')!, 'ac230').ok).toBe(false);
    expect(validateTerminals(['new', 'new'], P, 'ac999').ok).toBe(false);
  });
  it('accepts position on a study preset once the visitor entered a position figure', () => {
    const w = routePreset('bv-2014')!;
    const p = validatePresetPatch(w, { cost_inputs: { basis: 'bare', year: 2020, line_types: { ac230: { position_usd: 4e6 } } } });
    expect(p.ok && validateTerminals(['position', 'position'], p.result, 'ac230').ok).toBe(true);
    expect(p.ok && validateTerminals(['position', 'position'], p.result, 'ac345').ok).toBe(false);
  });
  it('under all-in a line type without an entered $/mi is refused', () => {
    const p = validatePresetPatch(P, { cost_inputs: { basis: 'all-in', year: 2020, line_types: { ac230: { usd_per_mi: 5e6 } } } });
    if (!p.ok) throw new Error(p.reason);
    expect(validateTerminals(['new', 'new'], p.result, 'ac230').ok).toBe(true);
    const bad = validateTerminals(['new', 'new'], p.result, 'ac345');
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.reason).toContain('ac345');
  });
});
