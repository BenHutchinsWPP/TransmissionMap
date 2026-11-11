// @vitest-environment jsdom
// ─── Route report model tests ────────────────────────────────────────────────
// Role: the model of the fixture session equals hand-written figures and wording, and the printed
//       report's text equals the model's text in order (the DOM report is the reference for wording).
//       English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./route-report-model.ts, ./route-report.ts, ./route-tabs/fixture.ts, state.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import { fmtMoneyHead } from './route-tabs/widgets.js';
import { buildReportModel, costCsv, fillTpl, fmtMoney, reportText } from './route-report-model.js';
import { openRouteReport } from './route-report.js';
import { FIXTURE_RESULT, FIXTURE_SESSION, fakeTabContext, fixtureCost } from './route-tabs/fixture.js';
import { state } from '../state.js';
import { CUSTOM_PRESETS_KEY } from '../route/custom-presets.js';
import { validatePresetPatch } from '../route/preset-patch.js';
import { routePreset } from '../../src/registry/route-presets.js';
import { methodSources } from '../../src/registry/route-band-data.js';

const money = (v: number) => `$${Math.round(v)}`;

beforeEach(() => {
  document.body.innerHTML = '';
  (state as unknown as { map: unknown }).map = null;
  window.print = vi.fn();
});

describe('buildReportModel', () => {
  it('is null without a result', () => {
    const s = FIXTURE_SESSION();
    s.result = null;
    expect(buildReportModel(s, money)).toBeNull();
  });

  it('holds the fixture session\'s figures and wording (hand-written expectations)', () => {
    const s = FIXTURE_SESSION();
    const m = buildReportModel(s, money, '1/2/2026')!;
    const r = s.result!;
    expect(m.title).toBe('Route: 45.930, -119.300 → 43.290, -116.780');
    expect(m.subtitle).toContain('1/2/2026');
    expect(m.lengthMi).toBe(250.1);
    expect(m.path).toHaveLength(6);
    expect(m.cost.kpis).toHaveLength(5);
    expect(m.cost.kpis[0].value).toBe(`${fmtMoneyHead(r.cost.band.low)} \u2013 ${fmtMoneyHead(r.cost.band.high)}`);
    expect(m.cost.kpis[1].value).toBe(fmtMoneyHead(r.cost.total2025));
    expect(m.cost.kpis[2].value).toBe('250.1 mi');
    expect(m.cost.kpis[3].value).toContain(fmtMoneyHead(r.cost.total2025 / 250.1));
    expect(m.cost.kpis[4].label).toBe('line only, without terminals');
    expect(m.cost.range.low).toBe(fmtMoneyHead(r.cost.band.low));
    expect(m.cost.range.high).toBe(fmtMoneyHead(r.cost.band.high));
    expect(m.cost.range.point).toBe(fmtMoneyHead(r.cost.total2025));
    // Waterfall: base first, total last, lines sum to the total, signed text for steps.
    const w = m.waterfall.lines;
    expect(w[0].group).toBe('base');
    expect(w.at(-1)!.group).toBe('total');
    expect(w.some((l) => l.group === 'subtotal')).toBe(true);
    expect(w.at(-1)!.value).toBeCloseTo(r.cost.total2025, 0);
    const parts = w.filter((l) => l.group !== 'subtotal' && l.group !== 'total').reduce((a, l) => a + l.value, 0);
    expect(parts).toBeCloseTo(r.cost.total2025, 0);
    expect(w.at(-1)!.text).toBe(money(r.cost.total2025));
    expect(w[0].text).toBe('+' + money(w[0].value));
    // Strip: one segment per profile run, labels at 0 and the route length in miles.
    expect(m.strip!.runs).toHaveLength(r.profile!.runs.length);
    expect(m.strip!.runs[0].mi0).toBe(r.profile!.runs[0].mi0);
    expect(m.strip!.startLabel).toBe('mi 0');
    expect(m.strip!.endLabel).toBe('mi 250');
    // Crossings: 6 counted rows (≈ counts, no miles), 9 mile rows (no counts), 5 aviation rows (with miles); the aviation note is apart.
    const c = r.profile!.crossings;
    expect(m.crossings!.rows).toHaveLength(20);
    expect(m.crossings!.rows[0].count).toBe(`≈${c.counts.river}`);
    expect(m.crossings!.rows[6].miles).toBe(c.miles.follows.toFixed(1));
    expect(m.crossings!.rows[7].miles).toBe(c.miles.s368.toFixed(1));
    expect(m.observations).toBeNull();
    expect(m.tribal.shown).toBe(true);
    expect(m.tribal.heading).toContain('6.3');
    expect(m.method.editsSummary).toBeNull();
    expect(m.method.attribution).toBe(r.preset.attribution);
    expect(m.method.class5).toContain('AACE International Class 5');
  });

  it('lists the sources of the method as solved: a session edit that switches exemptions off drops their data', () => {
    const s = FIXTURE_SESSION();
    const before = buildReportModel(s, money, '1/2/2026')!.method.sources;
    const preset = routePreset(s.result!.preset.id)!;
    const rows = preset.rows.flatMap((r, row) => (r.except?.length ? [{ row, band: r.band, note: r.note, except: r.except.map(() => false) }] : []));
    expect(rows.length).toBeGreaterThan(0);
    s.resultInputs = { ...s.resultInputs!, patch: { rows } };
    const after = buildReportModel(s, money, '1/2/2026')!.method.sources;
    const solved = validatePresetPatch(preset, { rows });
    if (!solved.ok) throw new Error(solved.reason);
    expect(after).toBe(methodSources(solved.result, s.result!.cost.lineType).join('; '));
    expect(after).not.toBe(before);
  });

  it('lists each uploaded layer of the patch with its weights, label kept as typed', () => {
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, patch: { add_rows: [
      { layer: 'a'.repeat(16), label: 'Wetland ≤ 5 → "A"', route_w: 3, cost_x: 1.5 },
      { layer: 'b'.repeat(16), label: 'No-go zone', route_w: 100, cost_x: 1, barrier: true },
    ] } };
    const m = buildReportModel(s, money, '1/2/2026')!;
    expect(m.method.uploads.map((u) => fillTpl(u))).toEqual([
      'uploaded layer: Wetland ≤ 5 → "A" — routing weight 3, cost × 1.5',
      'uploaded layer: No-go zone — routing weight 100, cost × 1, barrier',
    ]);
    // the label is a visitor parameter: a glyph map leaves it exactly as typed, the wording around it is mapped
    expect(fillTpl(m.method.uploads[0], (x) => x.replace(/≤/g, '<=').replace(/→/g, '->'))).toContain('Wetland ≤ 5 → "A"');
    expect(m.method.uploads[0].visitor).toEqual(['label']);
    expect(reportText(m)).toContain('uploaded layer: No-go zone — routing weight 100, cost × 1, barrier');
  });

  it('a saved method lists its stored uploaded layers, with the session patch on top (by hash)', () => {
    const A = 'a'.repeat(16), B = 'b'.repeat(16);
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify({ v: 1, items: [{ id: 'up', name: 'Blocked', base: 'tm-default', savedAt: '2026-11-04',
      patch: { add_rows: [{ layer: A, label: 'Stored block', route_w: 1, cost_x: 1, barrier: true }, { layer: B, label: 'Gone', route_w: 2, cost_x: 1 }] } }] }));
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, presetId: 'custom:up', patch: null };
    expect(buildReportModel(s, money)!.method.uploads.map((u) => fillTpl(u))).toEqual([
      'uploaded layer: Stored block — routing weight 1, cost × 1, barrier',
      'uploaded layer: Gone — routing weight 2, cost × 1',
    ]);
    s.resultInputs = { ...s.resultInputs, patch: { add_rows: [{ layer: A, route_w: 5 }, { layer: B, remove: true }] } };
    expect(buildReportModel(s, money)!.method.uploads.map((u) => fillTpl(u))).toEqual([
      'uploaded layer: Stored block — routing weight 5, cost × 1, barrier',
    ]);
    localStorage.clear();
  });

  it('lists the aviation rows with miles and carries the one aviation note apart from the rows', () => {
    const s = FIXTURE_SESSION();
    const c = buildReportModel(s, money)!.crossings!;
    expect(c.rows.slice(15, 20).map((r) => r.label)).toEqual([
      'Aviation: notice zone (14 CFR 77.9), no lower Part 77 surface',
      'Aviation: lowest Part 77 surface 46–61 m above ground',
      'Aviation: lowest Part 77 surface 30–46 m above ground',
      'Aviation: lowest Part 77 surface under 30 m above ground',
      'Aviation: primary surface',
    ]);
    expect(c.rows).toHaveLength(20);
    expect(c.rows[15].miles).toBe('3.2');
    expect(c.aviationNote).toContain('61 m (200 ft)');
    const p = s.result!.profile!;
    s.result = { ...s.result!, profile: { ...p, crossings: { ...p.crossings, aviationHeightM: null } } };
    expect(buildReportModel(s, money)!.crossings!.aviationNote).toContain('weighs no Part 77 class');
    s.result = { ...s.result!, profile: { ...p, crossings: { ...p.crossings, miles: { ...p.crossings.miles, aviation: {} } } } };
    const none = buildReportModel(s, money)!.crossings!;
    expect(none.rows).toHaveLength(15);
    expect(none.aviationNote).toBeNull();
  });

  it('keeps miles as miles', () => {
    const s = FIXTURE_SESSION();
    const p = s.result!.profile!;
    s.result = { ...s.result!, lengthMi: 100, profile: { ...p, crossings: { ...p.crossings, miles: { ...p.crossings.miles, follows: 82 } } } };
    const m = buildReportModel(s, money)!;
    expect(m.crossings!.rows[6].miles).toBe('82.0');
    expect(m.strip!.endLabel).toBe('mi 100');
    expect(m.cost.kpis[2].value).toBe('100.0 mi');
  });

  it('no profile: no strip, crossings or observations', () => {
    const s = FIXTURE_SESSION();
    s.result = { ...s.result!, profile: null };
    const m = buildReportModel(s, money)!;
    expect([m.strip, m.crossings, m.observations]).toEqual([null, null, null]);
  });

  it('each endpoint line names its terminal kind from the result', () => {
    const s = FIXTURE_SESSION();
    const m = buildReportModel(s, money, '1/2/2026')!;
    expect(m.endpoints.a).toMatch(/\(-119\.3000, 45\.9300\), terminal: new station$/);
    expect(m.endpoints.b).toMatch(/, terminal: new station$/);
    s.result = { ...FIXTURE_RESULT, cost: fixtureCost(1, undefined, ['position', 'none']) };
    const p = buildReportModel(s, money, '1/2/2026')!;
    expect(p.endpoints.a).toMatch(/, terminal: line position at an existing station$/);
    expect(p.endpoints.b).toMatch(/, terminal: none$/);
    // a result from before kinds says nothing
    const old = fixtureCost();
    delete old.terminalItems;
    s.result = { ...FIXTURE_RESULT, cost: old };
    expect(buildReportModel(s, money, '1/2/2026')!.endpoints.a).toMatch(/\)$/);
  });

  it('a study method\'s new end reads as the method prices it', () => {
    const s = FIXTURE_SESSION();
    s.result = { ...FIXTURE_RESULT, preset: { ...FIXTURE_RESULT.preset, id: 'nrel-revx' }, cost: { ...fixtureCost(), preset: 'nrel-revx' } };
    expect(buildReportModel(s, money, '1/2/2026')!.endpoints.a).toMatch(/, terminal: terminal as the method prices it$/);
  });

  it('the method section lists the figures the visitor entered, with year and basis, and the ends set', () => {
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, patch: { cost_inputs: { basis: 'all-in', year: 2024, line_types: { ac500: { usd_per_mi: 4_500_000, station_usd: 30_000_000, position_usd: 9_000_000 }, ac345: { usd_per_mi: 1e6 } }, ends: ['none', 'position'] } } };
    const m = buildReportModel(s, fmtMoney, '1/2/2026')!;
    expect(m.method.editsSummary).toBe('6 edits for this route:');   // 4 figures (3 for ac500, 1 for ac345) + 2 ends
    expect(m.method.edits).toEqual([
      'Line cost entered: $4.5\u00a0M per mile, 2024 dollars (all-in cost per mile)',
      'New station entered: $30.0\u00a0M, 2024 dollars',
      'Line position entered: $9.0\u00a0M, 2024 dollars',
      'Terminals set: end A none, end B line position at an existing station',
    ]);
    // the report text carries them in print order, after the summary
    const text = reportText(m);
    expect(text.indexOf(m.method.edits[0])).toBeGreaterThan(text.indexOf(m.method.editsSummary!));
  });

  it('a saved method\'s figures are listed without any session edit', () => {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify({ v: 1, items: [{ id: 'own', name: 'Own', base: 'tm-default', savedAt: '2026-11-04',
      patch: { cost_inputs: { basis: 'bare', year: 2023, line_types: { ac500: { usd_per_mi: 3_300_000 } } } } }] }));
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, presetId: 'custom:own', patch: null };
    const m = buildReportModel(s, fmtMoney, '1/2/2026')!;
    expect(m.method.editsSummary).toBe('Your cost entries:');
    expect(m.method.edits).toEqual(['Line cost entered: $3.3\u00a0M per mile, 2023 dollars (base cost per mile, multipliers still apply)']);
    localStorage.clear();
  });

  it('the DOM report prints the entered-figure lines and the terminal kinds as the model has them', () => {
    const s = FIXTURE_SESSION();
    s.result = { ...FIXTURE_RESULT, cost: fixtureCost(1, undefined, ['position', 'new']) };
    s.resultInputs = { ...s.resultInputs!, patch: { cost_inputs: { basis: 'bare', year: 2025, line_types: { ac500: { usd_per_mi: 3_000_000 } } } } };
    const ctx = fakeTabContext(s);
    openRouteReport(ctx);
    const m = buildReportModel(s, (v) => ctx.money(v, v))!;
    expect(document.getElementById('route-report')!.textContent).toBe(reportText(m).join(''));
    expect(document.getElementById('route-report')!.textContent).toContain('Line cost entered');
  });

  it('cost.csv has one row per terminal kind, its sums match the total, and cites an entered figure as entered', () => {
    const cost = { ...fixtureCost(1, undefined, ['position', 'new']), userCosts: { basis: 'bare' as const, year: 2024, items: ['line' as const], line_types: ['ac500'] } };
    const r = { ...FIXTURE_RESULT, cost };
    const inputs = { ...FIXTURE_SESSION().inputs, patch: { cost_inputs: { basis: 'bare' as const, year: 2024, line_types: { ac500: { usd_per_mi: 3e6 } } } } };
    const csv = costCsv(r, 'y2025', inputs);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines.find((l) => l.startsWith('Line positions (1)'))).toBeDefined();
    expect(lines.find((l) => l.startsWith('Terminals (1 stations)'))).toBeDefined();
    expect(lines.find((l) => l.startsWith('Base'))).toContain('entered by you (2024 dollars, base cost per mile, multipliers still apply)');
    const usd = lines.slice(1).map((l) => l.split(',')).filter((c) => c[1] !== 'subtotal' && c[1] !== 'total' && /^-?\d+$/.test(c[2] ?? '')).reduce((a, c) => a + Number(c[2]), 0);
    expect(Math.abs(usd - Math.round(cost.total2025))).toBeLessThanOrEqual(12);
  });

  it('the printed report text equals the model text in order', () => {
    const s = FIXTURE_SESSION();
    const ctx = fakeTabContext(s);
    openRouteReport(ctx);
    const m = buildReportModel(s, (v) => ctx.money(v, v))!;
    expect(document.getElementById('route-report')!.textContent).toBe(reportText(m).join(''));
  });

  it('every report carries the route usage notice as its disclaimer, under the title', () => {
    const m = buildReportModel(FIXTURE_SESSION(), money)!;
    expect(m.disclaimer.heading).toBe('Disclaimer');
    expect(m.disclaimer.paras).toHaveLength(4);
    expect(m.disclaimer.paras[0]).toMatch(/^This tool is for early education and rough brainstorming\./);
    expect(m.disclaimer.paras[1]).toContain('get off their grass');
    const text = reportText(m);
    expect(text.indexOf(m.disclaimer.paras[0])).toBeLessThan(text.indexOf(m.cost.heading));
  });

  it('a model missing a waterfall line no longer equals the printed text', () => {
    const s = FIXTURE_SESSION();
    const ctx = fakeTabContext(s);
    openRouteReport(ctx);
    const m = buildReportModel(s, (v) => ctx.money(v, v))!;
    m.waterfall.lines.splice(1, 1);
    expect(document.getElementById('route-report')!.textContent).not.toBe(reportText(m).join(''));
  });
});

describe('parts (templates with visitor text)', () => {
  it('each part fills to the model text; the visitor parameters stay raw while the wording maps', () => {
    const m = buildReportModel(FIXTURE_SESSION(), money, '1/2/2026')!;
    expect(fillTpl(m.parts.title)).toBe(m.title);
    expect(fillTpl(m.parts.subtitle)).toBe(m.subtitle);
    expect(fillTpl(m.parts.endpointA)).toBe(m.endpoints.a);
    expect(fillTpl(m.parts.endpointB)).toBe(m.endpoints.b);
    expect(fillTpl(m.parts.methodPreset)).toBe(m.method.preset);
    expect(m.parts.title.visitor).toEqual(['a', 'b']);
    const t = { template: 'A \u2192 {a} {n}', params: { a: '\u2265 x', n: { template: '\u2264 {q}', params: { q: '\u2248' }, visitor: ['q'] } }, visitor: ['a'] };
    expect(fillTpl(t, (s) => s.replace(/[\u2192\u2264\u2265\u2248]/g, '#'))).toBe('A # \u2265 x # \u2248');
  });
});

describe('fmtMoney', () => {
  it('formats money like the mockups', () => {
    expect(fmtMoney(3.1e9)).toBe('$3.10\u00a0B');
    expect(fmtMoney(716e6)).toBe('$716\u00a0M');
    expect(fmtMoney(33.4e6)).toBe('$33.4\u00a0M');
  });
  it('picks the unit after rounding', () => {
    expect(fmtMoney(999.6e6)).toBe('$1.00\u00a0B');
    expect(fmtMoney(99.96e6)).toBe('$100\u00a0M');
    expect(fmtMoney(999_600)).toBe('$1.0\u00a0M');
    expect(fmtMoney(999.6)).toBe('$1\u00a0k');
    expect(fmtMoney(999.4)).toBe('$999');
    expect(fmtMoney(-999.6e6)).toBe('\u2212$1.00\u00a0B');
  });
});
