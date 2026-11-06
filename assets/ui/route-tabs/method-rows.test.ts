// ─── method-rows.test.ts ─────────────────────────────────────────────────────
// Role: tests for the pure Method model (method-rows.ts) on the real tm-default preset. Expected numbers are
//       hand-written literals; every patch an edit returns must also pass validatePresetPatch.
import { describe, it, expect } from 'vitest';
import {
  columnsOf, methodRows, viewRows, setRouteW, setCostX, setExcluded, setExcept, setContingency, wasText, tableValues, asciiText,
  uploadRowsOf, upsertUpload, dropUpload,
  type Edit, type MethodRow, type ViewOpts,
} from './method-rows.js';
import { routePreset, type RoutePreset } from '../../../src/registry/route-presets.js';
import { validatePresetPatch, type PresetPatch } from '../../route/preset-patch.js';
import { setNames } from '../../route/cost.js';
import { loadRouteStrings } from '../../../src/i18n/index.js';

await loadRouteStrings();

const base = routePreset('tm-default')!;
const idx = (p: RoutePreset, note: string) => p.rows.findIndex((r) => r.note === note);
const GAP1 = idx(base, 'GAP 1'), WSA = idx(base, 'Wilderness Study Area'), PHMA = idx(base, 'sage-grouse PHMA/IHMA');
const MIL = [idx(base, 'military (PAD-US DOD)'), idx(base, 'military (OSM landuse=military)')];
const FOREST = base.rows.findIndex((r) => r.band === 'landcover' && 'codes' in r.match && r.match.codes[0] === 41);
const SLOPE = base.rows.findIndex((r) => r.band === 'slope');
const OPEN: ViewOpts = { q: '', flat: false, editedOnly: false, sort: null };

function ok(preset: RoutePreset, e: Edit): PresetPatch | null {
  expect(e.ok).toBe(true);
  if (!e.ok) throw new Error(e.reason);
  if (e.patch) expect(validatePresetPatch(preset, e.patch).ok).toBe(true);
  return e.patch;
}
function refused(e: Edit): string {
  expect(e.ok).toBe(false);
  return e.ok ? '' : e.reason;
}
const rowOf = (rs: MethodRow[], i: number) => rs.find((r) => r.key === `r:${i}`)!;

describe('row indexes used below exist', () => {
  it('finds them', () => {
    for (const i of [GAP1, WSA, PHMA, FOREST, SLOPE, ...MIL]) expect(i).toBeGreaterThanOrEqual(0);
  });
});

describe('methodRows / columnsOf', () => {
  const all = methodRows(base, null);
  it('group headers in first-appearance order, once each', () => {
    const heads = all.filter((r) => r.kind === 'group').map((r) => r.group);
    expect(heads).toEqual([...new Set(base.rows.map((r) => r.group ?? ''))]);
    expect(heads[0]).toBe('terrain');
    expect(heads).toContain('');                       // pop > 100/mi² etc. are ungrouped
    expect(all.find((r) => r.key === 'g:military')!.rule).toBe('max');
  });
  it('except rows sit under their parent (PHMA has 3)', () => {
    const k = all.findIndex((r) => r.key === `r:${PHMA}`);
    expect(all.slice(k + 1, k + 4).map((r) => r.key)).toEqual([`x:${PHMA}:0`, `x:${PHMA}:1`, `x:${PHMA}:2`]);
    expect(all.slice(k + 1, k + 4).map((r) => r.exceptOn)).toEqual([true, false, false]);
    expect(all.filter((r) => r.kind === 'except' && r.row === PHMA)).toHaveLength(3);
  });
  it('set columns follow setNames; every regional row has exactly those keys', () => {
    expect(setNames(base)).toEqual(['TEPPC', 'SCE', 'MISO', 'Southeast']);
    expect(columnsOf(base)).toEqual(['excl', 'map', 'label', 'group', 'applies', 'routeW', 'costX', 'set:TEPPC', 'set:SCE', 'set:MISO', 'set:Southeast', 'dataFrom', 'src']);
    for (const r of base.rows) if (r.cost_by_region) expect(Object.keys(r.cost_by_region).sort()).toEqual([...setNames(base)].sort());
  });
  it('a preset without regions has no set columns, never an empty-named one', () => {
    const nr = { ...structuredClone(base), regions: undefined } as RoutePreset;
    expect(columnsOf(nr)).toEqual(['excl', 'map', 'label', 'group', 'applies', 'routeW', 'costX', 'dataFrom', 'src']);
    expect(methodRows(nr, null).find((r) => r.kind === 'row')!.sets).toEqual([]);
  });
  it('applies text and excluded flags', () => {
    expect(rowOf(all, FOREST).applies).toBe('Deciduous forest; Evergreen forest; Mixed forest');
    expect(rowOf(all, FOREST).match).toBe('landcover 41, 42, 43');
    expect(rowOf(all, SLOPE).applies).toBe('1–4°');
    expect(rowOf(all, SLOPE).match).toBe('slope 2–3');
    expect(rowOf(all, GAP1).applies).toBe('GAP 1');
    expect(rowOf(all, GAP1).match).toBe('protect field 1');
    expect(rowOf(all, WSA).applies).toBe('Wilderness Study Area');
    expect(rowOf(all, WSA).match).toBe('desig bit 0');
    expect(rowOf(all, WSA).excluded).toBe(true);
    expect(rowOf(all, GAP1).excluded).toBe(false);
    expect(rowOf(all, FOREST).excludable).toBe(false);
  });
});

describe('viewRows', () => {
  const all = methodRows(base, null);
  it('"ours" matches src by whole word and keeps the except rows with a matching parent', () => {
    const edited = structuredClone(base);
    edited.rows[FOREST].src = 'NREL study; yours truly';           // "yours" is not the word "ours"
    expect(viewRows(methodRows(edited, null), { ...OPEN, q: 'ours' }).some((r) => r.key === `r:${FOREST}`)).toBe(false);
    const v = viewRows(all, { ...OPEN, q: 'OURS' });
    const parents = v.filter((r) => r.kind === 'row');
    expect(parents.length).toBeGreaterThan(0);
    for (const r of parents) expect(/\bours\b/i.test(r.src)).toBe(true);
    expect(v.some((r) => r.key === `r:${GAP1}`)).toBe(true);          // 'ours, following PNAS S7 Cat 1'
    // a parent with excepts: every one of its excepts is present
    const withX = parents.find((r) => base.rows[r.row].except);
    if (withX) expect(v.filter((r) => r.kind === 'except' && r.row === withX.row)).toHaveLength(base.rows[withX.row].except!.length);
  });
  it('a substring filter matches label/applies and keeps PHMA excepts with it', () => {
    const v = viewRows(all, { ...OPEN, q: 'PHMA' });
    expect(v.filter((r) => r.kind === 'row').map((r) => r.row)).toContain(PHMA);
    expect(v.filter((r) => r.kind === 'except' && r.row === PHMA)).toHaveLength(3);
    expect(viewRows(all, { ...OPEN, q: 'zzz-no-such-row' })).toEqual([]);
  });
  it('a search finds a row by its match in words or as the cube reads it', () => {
    const other = all.find((r) => r.kind === 'row' && r.match === 'landcover 21, 52, 71, 81')!;
    expect(other.applies).toBe('Developed, open space; Shrub/scrub; Grassland/herbaceous; Pasture/hay');
    for (const q of ['shrub/scrub', 'landcover 21, 52']) expect(viewRows(all, { ...OPEN, q }).map((r) => r.key)).toContain(other.key);
  });
  it('sorts by routeW descending inside each group, excepts stay under the parent', () => {
    const v = viewRows(all, { ...OPEN, sort: { col: 'routeW', dir: -1 } });
    const prot = v.filter((r) => r.group === 'protection' && r.kind === 'row').map((r) => r.routeW as number);
    expect(prot[0]).toBe(1000);
    expect(prot).toEqual([...prot].sort((a, b) => b - a));
    const k = v.findIndex((r) => r.key === `r:${PHMA}`);
    expect(v[k + 1].key).toBe(`x:${PHMA}:0`);
    expect(v.findIndex((r) => r.kind === 'group')).toBe(0);
  });
  it('flat sort has no headers and orders all rows', () => {
    const v = viewRows(all, { ...OPEN, flat: true, sort: { col: 'routeW', dir: 1 } });
    expect(v.some((r) => r.kind === 'group')).toBe(false);
    const w = v.filter((r) => r.kind === 'row' && r.routeW !== null).map((r) => r.routeW as number);
    expect(w).toEqual([...w].sort((a, b) => a - b));
    expect(w[w.length - 1]).toBe(1000);
  });
  it('sorts a set column by its position', () => {
    const v = viewRows(all, { ...OPEN, flat: true, sort: { col: 'set:SCE', dir: -1 } }, setNames(base));
    expect(v[0].sets[1]).toBe(3);                                      // forest SCE 3 (largest SCE set value)
  });
  it('edited only shows an edited row, its excepts and its header; nothing when no edits', () => {
    expect(viewRows(all, { ...OPEN, editedOnly: true })).toEqual([]);
    const patch = ok(base, setExcept(base, null, PHMA, 2, true));
    const v = viewRows(methodRows(base, patch), { ...OPEN, editedOnly: true });
    expect(v.map((r) => r.key)).toEqual(['g:', `r:${PHMA}`, `x:${PHMA}:0`, `x:${PHMA}:1`, `x:${PHMA}:2`]);
  });
});

describe('setRouteW / setCostX', () => {
  it('valid value gives {row, band, note, route_w}', () => {
    const p = ok(base, setRouteW(base, null, GAP1, '50'));
    expect(p).toEqual({ rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 50 }] });
    const r = rowOf(methodRows(base, p), GAP1);
    expect(r.routeW).toBe(50);
    expect(r.routeW0).toBe(100);
    expect(r.edited).toBe(true);
    expect(wasText(r, 'routeW')).toBe('was 100');
    expect(wasText(r, 'costX')).toBeNull();
  });
  it('back to the preset value gives a null patch', () => {
    const p = ok(base, setRouteW(base, null, GAP1, '50'));
    expect(ok(base, setRouteW(base, p, GAP1, '100'))).toBeNull();
  });
  it('refuses with the validator\'s own reason', () => {
    expect(refused(setRouteW(base, null, GAP1, 'abc'))).toBe(`row ${GAP1} route_w must be a number in [0.01, 10000]`);
    expect(refused(setRouteW(base, null, GAP1, '0'))).toBe(`row ${GAP1} route_w must be a number in [0.01, 10000]`);
    expect(refused(setRouteW(base, null, GAP1, '20000'))).toBe(`row ${GAP1} route_w must be a number in [0.01, 10000]`);
    expect(refused(setRouteW(base, null, GAP1, ''))).toBe(`row ${GAP1} route_w must be a number in [0.01, 10000]`);
  });
  it('a ramp row takes "a, b"', () => {
    const i = base.rows.findIndex((r) => typeof r.route_w !== 'number');
    if (i < 0) return;
    expect(refused(setRouteW(base, null, i, '3'))).toContain('[from, to]');
  });
  it('forest × 2 gives the regional sets TEPPC 4.5, SCE 6, MISO 2.4, Southeast 2.94', () => {
    const p = ok(base, setCostX(base, null, FOREST, '2'));
    expect(p).toEqual({ rows: [{ row: FOREST, band: 'landcover', note: 'forest', cost_x: 2 }] });
    const r = rowOf(methodRows(base, p), FOREST);
    expect(r.sets).toEqual([4.5, 6, 2.4, 2.94]);
    expect(r.costX).toBe(2);
    expect(wasText(r, 'costX')).toBe('was 1');
  });
  it('forest × 40 is refused: SCE would be 120', () => {
    const reason = refused(setCostX(base, null, FOREST, '40'));
    expect(reason).toBe(`row ${FOREST} cost_x scales every regional cost set: ×40 gives 48–120, outside [0.1, 100]`);
  });
  it('a row without regions shows its cost_x in every set column', () => {
    const i = base.rows.findIndex((r) => !r.cost_by_region && r.cost_x === 1.5 && r.band === 'whpclass');
    expect(rowOf(methodRows(base, null), i).sets).toEqual([1.5, 1.5, 1.5, 1.5]);
  });
  it('a missing row is refused', () => {
    expect(refused(setRouteW(base, null, 9999, '1'))).toBe('row 9999 does not exist');
  });
});

describe('setExcluded: Wild & Scenic River and NPS Preserve rows', () => {
  const WSR = idx(base, 'Wild & Scenic River corridor');
  const PRES = idx(base, 'NPS unit named Preserve (PAD-US Fee)');
  it.each([['WSR', WSR, 'desig', 'Wild & Scenic River corridor', 'was 100'], ['PRES', PRES, 'protect', 'NPS unit named Preserve (PAD-US Fee)', 'was 1']])('%s ticks to 1000 and back to a null patch', (_n, i, band, note, was) => {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(rowOf(methodRows(base, null), i).excluded).toBe(false);
    const on = ok(base, setExcluded(base, base, null, i, true));
    expect(on).toEqual({ rows: [{ row: i, band, note, route_w: 1000 }] });
    const r = rowOf(methodRows(base, on), i);
    expect(r.excluded).toBe(true);
    expect(wasText(r, 'excl')).toBe(was);
    expect(ok(base, setExcluded(base, base, on, i, false))).toBeNull();
  });
});

describe('setExcluded', () => {
  it('GAP 1 on gives route_w 1000, off gives a null patch', () => {
    const on = ok(base, setExcluded(base, base, null, GAP1, true));
    expect(on).toEqual({ rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 1000 }] });
    const r = rowOf(methodRows(base, on), GAP1);
    expect(r.excluded).toBe(true);
    expect(wasText(r, 'excl')).toBe('was 100');
    expect(ok(base, setExcluded(base, base, on, GAP1, false))).toBeNull();
  });
  it('WSA off (preset 1000) gives route_w 100 and "was 1000 · excluded"', () => {
    const off = ok(base, setExcluded(base, base, null, WSA, false));
    expect(off).toEqual({ rows: [{ row: WSA, band: 'desig', note: 'Wilderness Study Area', route_w: 100 }] });
    const r = rowOf(methodRows(base, off), WSA);
    expect(r.excluded).toBe(false);
    expect(wasText(r, 'routeW')).toBe('was 1000');
    expect(wasText(r, 'excl')).toBe('was 1000 · excluded');
    expect(ok(base, setExcluded(base, base, off, WSA, true))).toBeNull();
  });
  it('a link that is only partly excluded in the method shows no "was … · excluded"', () => {
    const saved: RoutePreset = structuredClone(base);
    saved.rows[MIL[0]].route_w = 1000;
    saved.rows[MIL[1]].route_w = 100;
    const rs = methodRows(saved, null);
    expect(rowOf(rs, MIL[0]).excluded).toBe(false);
    expect(wasText(rowOf(rs, MIL[0]), 'excl')).toBeNull();
    expect(wasText(rowOf(rs, MIL[1]), 'excl')).toBeNull();
  });
  it('the military link ticks both rows in one patch; unticking clears both', () => {
    const on = ok(base, setExcluded(base, base, null, MIL[0], true));
    expect(on!.rows!.map((r) => [r.row, r.route_w])).toEqual([[MIL[0], 1000], [MIL[1], 1000]]);
    const rs = methodRows(base, on);
    expect(MIL.map((i) => rowOf(rs, i).excluded)).toEqual([true, true]);
    expect(ok(base, setExcluded(base, base, on, MIL[1], false))).toBeNull();
  });
  it('a linked set shows ticked only when every row is at 1000', () => {
    const p = ok(base, setRouteW(base, null, MIL[0], '1000'));
    expect(rowOf(methodRows(base, p), MIL[0]).excluded).toBe(false);
  });
  it('a saved method with GAP 1 = 50: tick then untick gives a null patch (the 50 is kept)', () => {
    const stored = ok(base, setRouteW(base, null, GAP1, '50'));
    const saved = validatePresetPatch(base, stored);
    expect(saved.ok).toBe(true);
    const preset = saved.ok ? saved.result : base;
    const on = ok(preset, setExcluded(preset, base, null, GAP1, true));
    expect(on).toEqual({ rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 1000 }] });
    expect(ok(preset, setExcluded(preset, base, on, GAP1, false))).toBeNull();
    expect(rowOf(methodRows(preset, null), GAP1).routeW).toBe(50);
  });
  it('a saved method that ticked GAP 1 unticks to the base 100', () => {
    const saved = validatePresetPatch(base, { rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 1000 }] });
    const preset = saved.ok ? saved.result : base;
    const off = ok(preset, setExcluded(preset, base, null, GAP1, false));
    expect(off).toEqual({ rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 100 }] });
  });
  it('refuses a row that is not excludable, by its own guard', () => {
    expect(refused(setExcluded(base, base, null, FOREST, true))).toBe(`row ${FOREST} cannot be excluded`);
    const barrier = base.rows.findIndex((r) => r.barrier === 'hard');
    if (barrier >= 0) expect(refused(setExcluded(base, base, null, barrier, true))).toBe(`row ${barrier} cannot be excluded`);
  });
});

describe('setExcept / setContingency', () => {
  it('PHMA entry 2 on gives [true, false, true]; off again gives null', () => {
    const p = ok(base, setExcept(base, null, PHMA, 2, true));
    expect(p).toEqual({ rows: [{ row: PHMA, band: 'flags2', note: 'sage-grouse PHMA/IHMA', except: [true, false, true] }] });
    expect(rowOf(methodRows(base, p), PHMA).edited).toBe(false);
    expect(methodRows(base, p).find((r) => r.key === `x:${PHMA}:2`)!.exceptOn).toBe(true);
    expect(methodRows(base, p).find((r) => r.key === `x:${PHMA}:2`)!.edited).toBe(true);
    expect(ok(base, setExcept(base, p, PHMA, 2, false))).toBeNull();
  });
  it('an entry past the end is refused by the validator', () => {
    expect(refused(setExcept(base, null, PHMA, 3, true))).toContain('at most 3 true/false values');
  });
  it('contingency: 40 gives 0.4, the preset value gives null, 150 and "x" are refused', () => {
    expect(base.contingency!.pct).toBe(0.3);
    expect(ok(base, setContingency(base, null, '40'))).toEqual({ contingency: 0.4 });
    expect(ok(base, setContingency(base, { contingency: 0.4 }, '30'))).toBeNull();
    expect(refused(setContingency(base, null, '150'))).toBe('contingency must be a number in [0, 1]');
    expect(refused(setContingency(base, null, 'x'))).toBe('contingency must be a number in [0, 1]');
  });
  it('edits compose: a route_w and an exemption share one patch', () => {
    const a = ok(base, setRouteW(base, null, GAP1, '50'));
    const b = ok(base, setExcept(base, a, PHMA, 1, true));
    expect(b!.rows!.map((r) => r.row)).toEqual([GAP1, PHMA].sort((x, y) => x - y));
  });
});

describe('tableValues', () => {
  it('gives raw values for the shown rows, no group headers', () => {
    const p = ok(base, setCostX(base, null, FOREST, '2'));
    const rs = methodRows(base, p);
    const cols = columnsOf(base);
    const out = tableValues(rs.filter((r) => r.key === `r:${FOREST}` || r.key === `r:${WSA}` || r.key === `x:${PHMA}:0`).concat(rs.filter((r) => r.kind === 'group').slice(0, 1)),
      cols, new Set([`r:${WSA}`]), setNames(base));
    expect(out).toHaveLength(3);
    const byKey = Object.fromEntries(out.map((row) => [row[2], row]));
    expect(byKey['forest']).toEqual(['', '', 'forest', 'terrain', 'Deciduous forest; Evergreen forest; Mixed forest', 2.25, 2, 4.5, 6, 2.4, 2.94, expect.any(String), expect.any(String)]);
    expect(byKey['Wilderness Study Area'].slice(0, 2)).toEqual(['excluded', 'shown']);
    expect(byKey['Wilderness Study Area'][5]).toBe(1000);
    expect(byKey['where NLCD already marks forest or wetland'] ?? byKey['inside Section 368 corridors'].slice(0, 2)).toEqual(['on', '']);
  });
});

describe('asciiText (copies and the CSV)', () => {
  it('spells the method text\'s symbols in plain ASCII', () => {
    expect(asciiText('mountain, ≥ 4°')).toBe('mountain, >= 4 deg');
    expect(asciiText('rolling, 1–4°')).toBe('rolling, 1-4 deg');
    expect(asciiText('pop > 100/mi² → tubular steel')).toBe('pop > 100/mi^2 -> tubular steel');
    expect(asciiText('Cost × TEPPC · §404 … ≈ −1')).toBe('Cost x TEPPC , Sec. 404 ... ~ -1');
  });
  it('leaves letters of other scripts as they are', () => {
    expect(asciiText('Coût — コスト')).toBe('Coût - コスト');
  });
  it('turns every symbol the shipped methods use into ASCII', () => {
    for (const id of ['tm-default', 'pnas-wu2023']) {
      const p = routePreset(id)!;
      const all = methodRows(p, null);
      const text = tableValues(all.filter((r) => r.kind !== 'group'), columnsOf(p), new Set()).flat().filter((v) => typeof v === 'string').join('\n');
      expect(asciiText(text).match(/[^ -~\t\n]/g) ?? [], id).toEqual([]);
    }
  });
});


describe('uploaded-layer rows', () => {
  const hx = (c: string) => c.repeat(16);
  const row = (c: string, over = {}) => ({ layer: hx(c), label: `L${c}`, route_w: 3, cost_x: 1, barrier: false, ...over });
  const saved: PresetPatch = { add_rows: [{ layer: hx('a'), label: 'La', route_w: 3, cost_x: 1 }, { layer: hx('b'), label: 'Lb', route_w: 4, cost_x: 1 }] };
  const ok = (e: Edit): PresetPatch | null => { if (!e.ok) throw new Error(e.reason); return e.patch; };

  it('lists the merged rows in band order: saved first, session edit in place, new appended', () => {
    const s = ok(upsertUpload(base, saved, null, row('b', { route_w: 9 })));
    const s2 = ok(upsertUpload(base, saved, s, row('c')));
    expect(uploadRowsOf(saved, s2).map((r) => [r.layer[0], r.route_w, r.saved])).toEqual([['a', 3, true], ['b', 9, true], ['c', 3, false]]);
  });

  it('removing a saved row writes {layer, remove: true}; a session-only row just leaves; the merge has no remove', () => {
    const s = ok(upsertUpload(base, saved, null, row('c')));
    const s1 = ok(dropUpload(base, saved, s, hx('c')));
    expect(s1).toBeNull();
    const s2 = ok(dropUpload(base, saved, s1, hx('a')));
    expect(s2).toEqual({ add_rows: [{ layer: hx('a'), remove: true }] });
    expect(uploadRowsOf(saved, s2).map((r) => r.layer[0])).toEqual(['b']);
  });

  it('every patch an edit returns passes validatePresetPatch once merged', () => {
    const s = ok(upsertUpload(base, saved, null, row('a', { route_w: 5, barrier: true })));
    expect(validatePresetPatch(base, { add_rows: [...(saved.add_rows ?? [])].map((r) => (r.layer === hx('a') ? { ...r, ...s!.add_rows![0] } : r)) }).ok).toBe(true);
  });

  it('a fifth and sixth layer are accepted; a bad weight gets the validator\'s', () => {
    let s: PresetPatch | null = null;
    for (const c of 'abcdef') s = ok(upsertUpload(base, null, s, row(c)));
    expect(s?.add_rows).toHaveLength(6);
    expect(upsertUpload(base, null, s, row('a', { route_w: 1e9 }))).toMatchObject({ ok: false, reason: expect.stringContaining('route_w') });
    expect(upsertUpload(base, null, null, row('a', { label: '  ' }))).toMatchObject({ ok: false });
  });
});
