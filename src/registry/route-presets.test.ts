// Every route preset value carries a source; band names and codes stay inside the spec.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ROUTE_PRESETS, ROW_REFS, routePreset, EXCLUDED_W, type BandName, type CostRow, type RoutePreset } from './route-presets.js';
import { compile, presetBands } from '../../assets/route/cost.js';
import OLD_ROWS from '../../assets/route/fixtures/route-presets-eda14023.json';
import { validatePresetPatch, ROUTE_W_RANGE, type PresetPatch } from '../../assets/route/preset-patch.js';

const ids = ROUTE_PRESETS.map((p) => p.id);

describe('route presets', () => {
  it('ships exactly these presets, default first', () => {
    expect(ids).toEqual(['tm-default', 'pnas-wu2023', 'straight-line-quick', 'nrel-revx', 'bv-2014', 'westtec-es']);
  });

  it.each(ROUTE_PRESETS.map((p) => [p.id, p] as const))('%s: every row and exemption names one short reference (the Method grid column)', (_id, p) => {
    for (const row of p.rows) {
      expect(ROW_REFS, `${row.band} ${row.note}`).toContain(row.ref);
      for (const x of row.except ?? []) expect(ROW_REFS, x.label).toContain(x.ref);
    }
  });

  it.each(ROUTE_PRESETS.map((p) => [p.id, p] as const))('%s: every number has a src', (_id, p) => {
    const has = (s: string) => s.trim().length > 0;
    for (const row of p.rows) expect(has(row.src), `${row.band} ${row.note}`).toBe(true);
    for (const [id, lt] of Object.entries(p.line_types)) {
      expect(has(lt.base_per_mi.src), id).toBe(true);
      expect(has(lt.terminals.src), id).toBe(true);
    }
    for (const m of p.markups) expect(has(m.src)).toBe(true);
    for (const s of [p.escalation.src, p.uncertainty.src, p.region.src, p.tribal.src]) expect(has(s)).toBe(true);
    if (p.mitigation) {
      expect(has(p.mitigation.src)).toBe(true);
      for (const c of p.mitigation.classes) expect(has(c.src)).toBe(true);
    }
    if (typeof p.length === 'object') expect(has(p.length.src)).toBe(true);
    if (p.regions) expect(has(p.regions.src)).toBe(true);
    if (p.contingency) expect(has(p.contingency.src)).toBe(true);
    if (p.length_factor) expect(has(p.length_factor.src)).toBe(true);
    if (p.row_land) for (const s of [p.row_land.src, p.row_land.width_src, p.row_land.developed_src]) expect(has(s)).toBe(true);
  });

  it.each(ROUTE_PRESETS.map((p) => [p.id, p] as const))('%s: no src anywhere is empty', (_id, p) => {
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'src' || k.endsWith('_src')) expect(typeof x === 'string' && x.trim().length > 0, `${path}.${k}`).toBe(true);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(p, p.id);
  });

  it('every ISO name in tm-default maps to an existing reVX set or the default', () => {
    const p = ROUTE_PRESETS.find((x) => x.id === 'tm-default')!;
    const isoNames = ['TEPPC', 'CAISO', 'MISO', 'SPP', 'ERCOT', 'PJM', 'NYISO', 'ISONE', 'Southeast']; // scripts/route_grid.py ISO_CODES
    const sets = new Set(p.rows.flatMap((r) => Object.keys(r.cost_by_region ?? {})));
    expect(sets).toEqual(new Set(['TEPPC', 'SCE', 'MISO', 'Southeast'])); // reVX iso_multipliers.json set names @ efb1977
    expect(sets.has(p.regions!.default)).toBe(true);
    for (const iso of isoNames) expect(sets.has(p.regions!.sets[iso] ?? p.regions!.default), iso).toBe(true);
    for (const iso of Object.keys(p.regions!.sets)) expect(isoNames, iso).toContain(iso);
    for (const r of p.rows) if (r.cost_by_region) expect(new Set(Object.keys(r.cost_by_region)), r.note).toEqual(sets);
  });

  it('labels use the rough early estimate wording', () => {
    for (const p of ROUTE_PRESETS) {
      expect(p.uncertainty.label).toBe('Rough early estimate (−30 % / +50 %)');
      expect(p.label).not.toMatch(/exploratory/i);
    }
    expect(ROUTE_PRESETS.find((x) => x.id === 'straight-line-quick')!.label).toBe('Straight line × 1.30 (rough early estimate)');
  });

  it('row line_types and combine groups refer to things that exist', () => {
    for (const p of ROUTE_PRESETS) {
      for (const row of p.rows) {
        for (const lt of row.line_types ?? []) expect(p.line_types[lt], `${p.id} ${lt}`).toBeDefined();
        if (typeof row.cost_x !== 'number' || typeof row.route_w !== 'number') expect('range' in row.match).toBe(true);
      }
      for (const g of Object.keys(p.combine)) expect(p.rows.some((r) => r.group === g), `${p.id} ${g}`).toBe(true);
    }
  });

  it('pnas-wu2023 has exactly one tribal row (route_w 15) and carries its attribution and caveat', () => {
    const p = ROUTE_PRESETS.find((x) => x.id === 'pnas-wu2023')!;
    const tribal = p.rows.filter((r) => r.band === 'flags' && 'bit' in r.match && r.match.bit === 0);
    expect(tribal).toHaveLength(1);
    expect(tribal[0].route_w).toBe(15);
    expect(p.rows).toHaveLength(13 + 1 + 2); // the v1 rows + the V11-1 tribal row + the aviation and nfhl 1/1 rows
    expect(p.attribution).toContain('CC BY 4.0');
    expect(p.caveat).toContain('not vetted by any planning authority');
  });

  // Cube v1.2 rows are appended: saved methods address rows by index + band + note.
  it('tm-default reads flags2 and adj', () => {
    const b = presetBands(routePreset('tm-default')!);
    expect(b.has('flags2')).toBe(true);
    expect(b.has('adj')).toBe(true);
  });

  it('adds neutral editable building observations without changing Homes or PNAS', () => {
    const tm = routePreset('tm-default')!;
    const rows = tm.rows.filter((r) => r.band === 'nonres' || r.band === 'bldgunk');
    expect(rows.map((r) => [r.band, r.route_w, r.cost_x, r.group])).toEqual([
      ['nonres', 1, 1, undefined], ['bldgunk', 1, 1, undefined],
    ]);
    expect(tm.rows.slice(-6, -4)).toEqual(rows);   // the aviation and nfhl rows follow
    expect(tm.rows.filter((r) => r.band === 'bldg').map((r) => [r.route_w, r.group])).toEqual([
      [1.3, undefined], [1.6, undefined], [2, undefined],
    ]);
    expect(presetBands(tm).has('nonres')).toBe(true);
    expect(presetBands(tm).has('bldgunk')).toBe(true);
    const pnas = presetBands(routePreset('pnas-wu2023')!);
    expect(['built', 'nonres', 'bldgunk'].some((b) => pnas.has(b as BandName))).toBe(false);
  });

  it('a patch written against the v1.1 tm-default rows still validates', () => {
    const patch: PresetPatch = {
      rows: [
        { row: 0, band: 'landcover', note: 'forest', route_w: 1.2 },
        { row: 14, band: 'protect', note: 'GAP 1', route_w: 50 },
        { row: 24, band: 'flags2', note: 'sage-grouse PHMA/IHMA', except: [true, true] },
        { row: 29, band: 'adj', note: 'on or beside an existing ≥ 230 kV line (adj line class 1–2)', route_w: 0.6 },
        { row: 34, band: 'osm_flags', note: 'lake (OSM)', route_w: 10 },
      ],
    };
    const r = validatePresetPatch(routePreset('tm-default')!, patch);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it('a PHMA exemption list saved before the 100–229 kV entry was appended still validates, and the new entry stays off', () => {
    const tm = routePreset('tm-default')!;
    const row = tm.rows.findIndex((r) => r.note === 'sage-grouse PHMA/IHMA');
    const r = validatePresetPatch(tm, { rows: [{ row, band: 'flags2', note: 'sage-grouse PHMA/IHMA', except: [true, true] }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.result.rows[row].except!.map((e) => e.active !== false)).toEqual([true, true, false]);
  });

  it('adds the 100–229 kV parallel row to the existing parallel group', () => {
    const rows = routePreset('tm-default')!.rows;
    const r = rows.find((x) => x.note === 'on/beside existing 100–229 kV line')!;
    expect(r.group).toBe('parallel');
    expect(rows.indexOf(r)).toBeGreaterThan(34);
  });

  it('puts the occupied-facility and NRHP rows in one max group, sites', () => {
    const p = routePreset('tm-default')!;
    const g = ['occupied facility (school, day care and similar)', 'NRHP historic property'].map((n) => p.rows.find((x) => x.note === n)!);
    expect(g.map((r) => r.group)).toEqual(['sites', 'sites']);
    expect(g.every((r) => r.band === 'flags2')).toBe(true);
    expect(p.combine.sites).toBe('max');
  });

  it('excludable rows: non-barrier, numeric route_w, off_w/off_src iff route_w ≥ EXCLUDED_W, links name ≥ 2 rows', () => {
    for (const p of ROUTE_PRESETS) {
      const links = new Map<string, number>();
      for (const [i, r] of p.rows.entries()) {
        const x = r.excludable;
        if (!x) continue;
        const where = `${p.id} row ${i} ${r.note ?? r.band}`;
        expect(r.barrier, where).toBeUndefined();
        expect(typeof r.route_w, where).toBe('number');
        const w = r.route_w as number;
        if (w >= EXCLUDED_W) {
          expect(x.off_src?.trim().length, where).toBeGreaterThan(0);
          expect(x.off_w, where).toBeGreaterThanOrEqual(ROUTE_W_RANGE[0]);
          expect(x.off_w, where).toBeLessThanOrEqual(ROUTE_W_RANGE[1]);
          expect(x.off_w, where).toBeLessThan(EXCLUDED_W);
        } else {
          expect(x.off_w, where).toBeUndefined();
          expect(x.off_src, where).toBeUndefined();
        }
        if (x.link) links.set(x.link, (links.get(x.link) ?? 0) + 1);
      }
      for (const [l, n] of links) expect(n, `${p.id} link ${l}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('tm-default has exactly the 8 excludable rows; the military rows share link mil; no other preset has any but nrel-revx (GAP 1 only)', () => {
    const p = routePreset('tm-default')!;
    const got = p.rows.filter((r) => r.excludable).map((r) => `${r.band}:${JSON.stringify(r.match)}`);
    expect(got).toEqual([
      'protect:{"field":{"shift":0,"mask":7},"codes":[1]}',
      'desig:{"bit":0}',
      'desig:{"bit":4}',
      'flags:{"bit":0}',
      'flags:{"bit":1}',
      'osm_flags:{"bit":7}',
      'desig:{"bit":7}',
      'protect:{"bit":7}',
    ]);
    const mil = p.rows.filter((r) => r.band === 'osm_flags' && 'bit' in r.match && r.match.bit === 7 || r.band === 'flags' && 'bit' in r.match && r.match.bit === 1);
    expect(mil.map((r) => r.excludable?.link)).toEqual(['mil', 'mil']);
    expect(p.rows.filter((r) => r.excludable?.link).length).toBe(2);
    for (const q of ROUTE_PRESETS) if (q.id !== 'tm-default' && q.id !== 'nrel-revx' && q.id !== 'westtec-es') expect(q.rows.some((r) => r.excludable), q.id).toBe(false);
    expect(routePreset('westtec-es')!.rows.filter((r) => r.excludable).map((r) => `${r.band}:${JSON.stringify(r.match)}:${r.excludable!.link}`)).toEqual(['flags:{"bit":1}:mil', 'osm_flags:{"bit":7}:mil']);
    expect(routePreset('nrel-revx')!.rows.filter((r) => r.excludable).map((r) => `${r.band}:${JSON.stringify(r.match)}`)).toEqual(['protect:{"field":{"shift":0,"mask":7},"codes":[1]}']);
  });

  // `ref` is the Method grid's display label, so it stays out of the pin.
  // The v8 `aviation` / `nfhl` rows (all 1/1 in pnas-wu2023) are checked apart, so the pin still proves every PNAS weight is unchanged.
  const V8 = ['aviation', 'nfhl'];
  const sha = (id: string) => createHash('sha256').update(JSON.stringify(routePreset(id), (k, v) => (k === 'ref' || k === 'markup_in' || k === 'study_terminals' ? undefined : k === 'rows' ? (v as { band: string }[]).filter((r) => !V8.includes(r.band)) : v))).digest('hex');
  it('pnas-wu2023 carries only neutral 1/1 aviation and nfhl rows', () => {
    const v8 = routePreset('pnas-wu2023')!.rows.filter((r) => V8.includes(r.band));
    expect(v8.map((r) => [r.band, r.route_w, r.cost_x])).toEqual([['aviation', 1, 1], ['nfhl', 1, 1]]);
  });
  it('study presets are unchanged (change detector; assets/route/study-presets.test.ts holds the hand calculation)', () => {
    const full = (id: string) => createHash('sha256').update(JSON.stringify(routePreset(id), (k, v) => (k === 'ref' || k === 'markup_in' || k === 'study_terminals' ? undefined : v))).digest('hex');
    expect(full('nrel-revx')).toBe('9ecf5af254669854d4ca9a0a6a953e318ffbe7dc563a4b1080fc56e93f868890');
    expect(full('bv-2014')).toBe('9f55f9075d288ce25b05fb9e43939e382da9d9635ddfd7d45a1b18bb446df03f');
    expect(full('westtec-es')).toBe('2ceac757db91057673e4dd85480a72f271d33f493ab83debc6b366a4016db7b4');
  });
  it('pnas-wu2023 is unchanged; straight-line-quick carries the shared line types', () => {
    expect(sha('pnas-wu2023')).toBe('2141f898db900ca31b622c483365a3428bc4037d6180486e400972742cba0353');
    expect(sha('straight-line-quick')).toBe('9cfb144fefa4ce0454560a99bb64fcea233eb24b81037e806ffb5dd42e8d9294');
  });
});

// Saved methods address a row by index (preset-patch.ts), so the rows of an earlier release keep their places.
// OLD_ROWS is the frozen [band, note] list per preset at eda14023; the replaced airfield row (tm-default 33) is the one exception.
const OLD = OLD_ROWS as unknown as Record<string, [string, string][]>;
const REPLACED: Record<string, number[]> = { 'tm-default': [33] };

describe('row indices of earlier releases', () => {
  it.each(Object.keys(OLD))('%s: every earlier row keeps its index (band + note)', (id) => {
    const rows = routePreset(id)!.rows;
    expect(rows.length).toBeGreaterThanOrEqual(OLD[id].length);
    OLD[id].forEach(([band, note], i) => {
      if (REPLACED[id]?.includes(i)) return;
      expect([rows[i].band, rows[i].note], `${id} row ${i}`).toEqual([band, note]);
    });
  });
  it('the replaced airfield row now holds the aviation notice row', () => {
    expect(OLD['tm-default'][33]).toEqual(['flags', 'public airfield ≤ 5 km']);
    expect(routePreset('tm-default')!.rows[33]).toMatchObject({ band: 'aviation', match: { codes: [2] } });
  });
});

/** The rows in the order they had before the v8 rows moved to the end (each after its former neighbour). */
function headOrder(p: RoutePreset): RoutePreset {
  const moved = (r: CostRow) => (r.band === 'aviation' && !!r.line_types) || r.band === 'nfhl' || (p.id === 'pnas-wu2023' && r.band === 'aviation');
  const rest = p.rows.filter((r) => !moved(r));
  const mv = p.rows.filter(moved);
  const at = (pred: (r: CostRow) => boolean) => { const i = rest.findIndex(pred); if (i < 0) throw new Error('anchor'); return i + 1; };
  if (p.id === 'tm-default') {
    const av = mv.filter((r) => r.band === 'aviation'), nf = mv.filter((r) => r.band === 'nfhl');
    rest.splice(at((r) => r.band === 'flags2' && r.note === 'floodplain'), 0, ...nf);
    rest.splice(at((r) => r.band === 'aviation' && 'codes' in r.match && r.match.codes.join() === '2'), 0, ...av);
  } else {
    rest.splice(at((r) => r.band === 'flags' && r.note === 'airport within 5 km'), 0, ...mv);
  }
  return { ...p, rows: rest };
}

describe('moving the v8 rows to the end changes no route', () => {
  const DIFF = ['tm-default', 'pnas-wu2023'].flatMap((id) => Object.keys(routePreset(id)!.line_types).map((lt) => [id, lt] as const));
  const strip = (k: ReturnType<typeof compile>, p: RoutePreset) => ({
    mul: k.mul, groups: k.groups, own: k.own, barrier: k.barrier, mit: k.mit, setOf: k.setOf, unmapped: k.unmapped,
    rowLandPerM: k.rowLandPerM, notes: k.notes, line: k.line,
    exc: k.exc.map((x) => ({ note: p.rows[x.row].note ?? '', self: x.self, any: x.any })).sort((a, b) => a.note.localeCompare(b.note)),
    rows: k.rows.map((x) => JSON.stringify({ n: p.rows[x.row].note, b: x.band, g: x.group, r: x.rule, h: [...x.hit], rr: [...x.r], c: x.c.map((a) => [...a]) })).sort(),
  });
  it('the reordering is a permutation of the same rows', () => {
    for (const id of ['tm-default', 'pnas-wu2023']) {
      const p = routePreset(id)!, h = headOrder(p);
      expect(h.rows.length).toBe(p.rows.length);
      expect(h.rows.map((r) => JSON.stringify(r)).sort()).toEqual(p.rows.map((r) => JSON.stringify(r)).sort());
      expect(h.rows.map((r) => JSON.stringify(r))).not.toEqual(p.rows.map((r) => JSON.stringify(r)));
    }
  });
  it.each(DIFF)('%s %s: compiled LUTs and factors are equal for the HEAD order', (id, lt) => {
    const p = routePreset(id)!;
    expect(strip(compile(p, lt), p)).toEqual(strip(compile(headOrder(p), lt), headOrder(p)));
  });
});

describe('tm-default line positions (B&V 2014 T4-6 per position × 1.5 breaker-and-a-half, double circuit = 2 positions, single circuit = 1; × 1.175 AFUDC + overhead)', () => {
  // Typed from the sources and the plan, never read back from the preset.
  const MISO_POS = 4_478_709;
  it.each([
    ['ac500', 10_524_963], ['ac345', 7_893_723], ['ac230', 5_262_483],
    ['ac500s', 5_262_482], ['ac345s', 3_946_861], ['ac230s', 2_631_242],
    ['ac161', 4_646_773], ['ac138', 4_325_761], ['ac115', 4_010_012], ['ac69', 3_667_951],
  ] as const)('%s position $%d (2014$)', (lt, usd) => {
    const pos = routePreset('tm-default')!.line_types[lt].terminals.position!;
    expect(pos.usd_each).toBe(usd);
    expect(pos.year).toBe(2014);
    expect(pos.arithmetic).toMatch(/× 1\.175/);
    expect(pos.src).toBeTruthy();
  });
  it('the unmarked figures: double circuit 3 × T4-6 per position; single circuit 1.5 × it, rounded; 69-161 kV the 230 kV figure × the MISO ratio of its station; each × 1.175', () => {
    expect([3 * 1_492_903, 3 * 2_239_354, 3 * 2_985_805]).toEqual([4_478_709, 6_718_062, 8_957_415]);
    expect([1.5 * 1_492_903, 1.5 * 2_239_354, 1.5 * 2_985_805].map(Math.round)).toEqual([2_239_355, 3_359_031, 4_478_708]);
    expect([0.883, 0.822, 0.762, 0.697].map((x) => Math.round(MISO_POS * x))).toEqual([3_954_700, 3_681_499, 3_412_776, 3_121_660]);
    expect([8_957_415, 6_718_062, 4_478_709, 4_478_708, 3_359_031, 2_239_355, 3_954_700, 3_681_499, 3_412_776, 3_121_660].map((x) => Math.round(x * 1.175)))
      .toEqual([10_524_963, 7_893_723, 5_262_483, 5_262_482, 3_946_861, 2_631_242, 4_646_773, 4_325_761, 4_010_012, 3_667_951]);
  });
  it('HVDC has no position figure; the study presets keep their own terminals', () => {
    expect(routePreset('tm-default')!.line_types.dc500.terminals.position).toBeUndefined();
    for (const id of ['pnas-wu2023', 'nrel-revx', 'bv-2014', 'westtec-es'])
      for (const l of Object.values(routePreset(id)!.line_types)) expect(l.terminals.position, id).toBeUndefined();
  });
  it('tm-default and straight-line-quick: the 500 kV station is the B&V T4-6 figure × 1.175, 2014$', () => {
    for (const id of ['tm-default', 'straight-line-quick']) {
      const t = routePreset(id)!.line_types.ac500.terminals;
      expect([t.usd_each, t.year, t.min, t.every_mi, t.after_mi]).toEqual([Math.round((2_559_250 + 6 * 1.5 * 2_985_805) * 1.175), 2014, 2, 400, 400]);
      expect(t.usd_each).toBe(34_582_007);
    }
  });
  it('every B&V station figure of tm-default is marked × 1.175 (230/345/500 kV, 69-161 kV, HVDC); westtec-es keeps its unmarked ones', () => {
    const lts = routePreset('tm-default')!.line_types;
    const unmarked = { ac500: 29_431_495, ac345: 22_286_886, ac230: 15_142_377, ac161: 13_376_000, ac138: 12_447_000, ac115: 11_541_000, ac69: 10_551_000, dc500: 460_708_500 };
    for (const [lt, usd] of Object.entries(unmarked)) {
      expect(lts[lt].terminals.usd_each, lt).toBe(Math.round(usd * 1.175));
      expect(lts[lt].terminals.arithmetic, lt).toMatch(/× 1\.175/);
    }
    expect(routePreset('westtec-es')!.line_types.ac345.terminals.usd_each).toBe(22_286_886);
  });
});

describe('tm-default single-circuit line types (B&V 2014 Tables 2-1, 2-3, 2-6, 4-6)', () => {
  const tm = routePreset('tm-default')!;
  const twins = { ac500s: 'ac500', ac345s: 'ac345', ac230s: 'ac230' } as const;
  it('follow their double-circuit twin, ac500 stays the first key', () => {
    expect(Object.keys(tm.line_types)[0]).toBe('ac500');
    const keys = Object.keys(tm.line_types);
    for (const [s, d] of Object.entries(twins)) expect(keys.indexOf(s), s).toBe(keys.indexOf(d) + 1);
  });
  it('base $/mi from Table 2-1 single circuit (2014$), the station of the twin, ROW widths from Table 2-6', () => {
    expect([tm.line_types.ac500s, tm.line_types.ac345s, tm.line_types.ac230s].map((l) => [l.base_per_mi.usd, l.base_per_mi.year]))
      .toEqual([[1_919_450, 2014], [1_343_800, 2014], [959_700, 2014]]);
    for (const [s, d] of Object.entries(twins)) {
      const a = tm.line_types[s].terminals, b = tm.line_types[d].terminals;
      expect([a.usd_each, a.year, a.min, a.every_mi, a.after_mi]).toEqual([b.usd_each, b.year, b.min, b.every_mi, b.after_mi]);
      expect(tm.line_types[s].kv.value).toBe(tm.line_types[d].kv.value);
    }
    const w = tm.row_land!.width_ft;
    expect([w.ac500s, w.ac345s, w.ac230s]).toEqual([200, 175, 125]);
  });
  it('every line type of tm-default sits in the same line_types filters as its twin', () => {
    for (const [s, d] of Object.entries(twins)) {
      const key = (r: { line_types?: string[] }, lt: string) => (!r.line_types ? 'all' : r.line_types.includes(lt) ? 'in' : 'out');
      tm.rows.forEach((r, i) => expect(key(r, s), `${s} row ${i} ${r.note}`).toBe(key(r, d)));
    }
  });
  it('the 230 kV populated-cell row costs 1.00 (B&V Table 2-3 tubular steel against the Table 2-1 base)', () => {
    const row = tm.rows.find((r) => r.band === 'flags' && r.note === 'pop > 100/mi² → tubular steel' && r.line_types?.includes('ac230'))!;
    expect(row.cost_x).toBe(1);
    expect(row.line_types).toEqual(['ac230', 'ac230s', 'ac161', 'ac138', 'ac115', 'ac69']);
    expect(row.src).toContain('Table 2-3');
    expect(row.src).toContain('Table 2-1');
  });
});
