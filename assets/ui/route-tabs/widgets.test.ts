// @vitest-environment jsdom
// ─── Route widgets tests ─────────────────────────────────────────────────────
// Role: waterfall sums (both dollar years, folded, short-line factor), geometry, badge and
//       range-bar wording, pill plurals, escaping. English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./widgets.ts, ./fixture.ts, registry/route-presets.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import { terminalSplit, waterfall, waterfallLines, rangeBar, crossingPills, badge, sourceInfo, kpis, kpiTiles, fmtMoneyHead, type WaterfallLine } from './widgets.js';
import { FIXTURE_RESULT, fixtureCost } from './fixture.js';
import { routePreset } from '../../../src/registry/route-presets.js';

const preset = routePreset('tm-default')!;
const money = (v: number) => `$${(v / 1e6).toFixed(0)} M`;
const sumBefore = (lines: WaterfallLine[], group: 'total') => {
  const i = lines.findIndex((l) => l.group === group);
  return lines.slice(0, i).filter((l) => l.group !== 'subtotal').reduce((s, l) => s + l.value, 0);
};

describe('waterfallLines', () => {
  for (const [dollars, key] of [['preset', 'totalNominal'], ['y2025', 'total2025']] as const) {
    it(`sums to ${key} in ${dollars} dollars`, () => {
      for (const lf of [1, 1.12]) {
        const cost = fixtureCost(lf);
        const lines = waterfallLines(cost, preset, { dollars });
        const total = lines.find((l) => l.group === 'total')!.value;
        expect(total).toBeCloseTo(cost[key], 3);
        expect(sumBefore(lines, 'total')).toBeCloseTo(cost[key], 3);
        const sub = lines.find((l) => l.group === 'subtotal')!;
        expect(lines.slice(0, lines.indexOf(sub)).reduce((s, l) => s + l.value, 0)).toBeCloseTo(sub.value, 3);
      }
    });
  }
  describe('terminals by kind', () => {
    for (const [dollars, key] of [['preset', 'totalNominal'], ['y2025', 'total2025']] as const) {
      for (const kinds of [['new', 'new'], ['position', 'new'], ['position', 'position'], ['none', 'position'], ['none', 'none']] as const) {
        it(`${kinds.join('+')} sums to ${key} in ${dollars} dollars, lines per kind`, () => {
          const cost = fixtureCost(1, undefined, [kinds[0], kinds[1]]);
          const lines = waterfallLines(cost, preset, { dollars });
          expect(lines.find((l) => l.group === 'total')!.value).toBeCloseTo(cost[key], 3);
          expect(sumBefore(lines, 'total')).toBeCloseTo(cost[key], 3);
          const t = lines.filter((l) => l.group === 'terminals' && /^(Terminals|Line positions)/.test(l.label));
          const nPos = kinds.filter((k) => k === 'position').length, nSt = kinds.filter((k) => k === 'new').length;
          expect(t.map((l) => l.label)).toEqual([...(nSt ? [`Terminals (${nSt} stations)`] : []), ...(nPos ? [`Line positions (${nPos})`] : [])]);
          // the terminal lines sum to terminalsUsd itself (never the items' own sum, which may differ by an ulp)
          const k = dollars === 'y2025' ? cost.total2025 / cost.totalNominal : 1;
          expect(t.reduce((s, l) => s + l.value, 0)).toBeCloseTo((cost.terminalsUsd ?? 0) * k, 3);
        });
      }
    }
    it('terminalSplit takes the group totals from terminalsUsd, not from the items\' own sum', () => {
      const c = { ...fixtureCost(), terminalCount: 3, terminalsUsd: 0.6, terminalItems: [{ kind: 'new' as const, end: 'A' as const, usd: 0.1 }, { kind: 'new' as const, end: 'B' as const, usd: 0.2 }, { kind: 'mid' as const, end: null, usd: 0.3 }] };
      expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
      expect(terminalSplit(c)).toEqual({ stations: { n: 3, each: 0.1, usd: 0.6 }, positions: null });
      const mixed = { ...c, terminalsUsd: 5.5, terminalItems: [{ kind: 'position' as const, end: 'A' as const, usd: 2 }, ...c.terminalItems.slice(1)] };
      const sp = terminalSplit(mixed)!;
      expect(sp.positions!.usd + sp.stations!.usd).toBe(5.5);
    });
    it('a result without terminalItems keeps the one Terminals line', () => {
      const old = fixtureCost();
      delete old.terminalItems;
      const lines = waterfallLines(old, preset, { dollars: 'preset' });
      expect(lines.filter((l) => /^Terminals/.test(l.label))).toHaveLength(1);
    });
    it('a figure the visitor entered is cited as entered, with its year and basis; no line shows a registry source for it', () => {
      const cost = { ...fixtureCost(), userCosts: { basis: 'all-in' as const, year: 2024, items: ['line' as const, 'station' as const], line_types: ['ac500'] } };
      const entered = structuredClone(preset);
      entered.line_types.ac500.base_per_mi = { usd: 4e6, year: 2024, src: 'user-entered' };
      entered.line_types.ac500.terminals.src = 'user-entered';
      const lines = waterfallLines(cost, entered, { dollars: 'preset' });
      expect(lines[0].src).toBe('entered by you (2024 dollars, all-in cost per mile)');
      expect(lines.find((l) => /^Terminals/.test(l.label))!.src).toBe('entered by you (2024 dollars)');
    });
  });
  it('adds a short-line line only when the factor is not 1', () => {
    expect(waterfallLines(fixtureCost(1), preset, { dollars: 'preset' }).some((l) => l.label === 'Short-line factor')).toBe(false);
    expect(waterfallLines(fixtureCost(1.12), preset, { dollars: 'preset' }).some((l) => l.label === 'Short-line factor')).toBe(true);
  });
  it('labels categories from i18n and puts the largest first', () => {
    const lines = waterfallLines(FIXTURE_RESULT.cost, preset, { dollars: 'preset' });
    expect(lines[1].label).toBe('Slope');
    expect(lines.map((l) => l.label)).toContain('Land cover');
  });
});

describe('waterfall', () => {
  const lines = waterfallLines(FIXTURE_RESULT.cost, preset, { dollars: 'y2025' });
  it('right-aligns a signed value on every line', () => {
    const vals = [...waterfall(lines, { money }).querySelectorAll('.rp-wf-val')].map((e) => e.textContent);
    expect(vals).toHaveLength(lines.length);
    expect(vals[0]).toMatch(/^\+\$/);
    expect(vals.at(-1)).toMatch(/^\$/);
  });
  it('folds to maxLines and keeps the sum', () => {
    const el = waterfall(lines, { money, compact: true, maxLines: 4 });
    const rows = [...el.querySelectorAll('.rp-wf-row')];
    const floating = rows.filter((r) => !/subtotal|total|contingency/.test(r.className));
    expect(floating).toHaveLength(4);
    expect(el.textContent).toMatch(/Other \(\d+ items\)/);
    const other = rows.find((r) => r.className.includes('--other'))!;
    const kept = lines.filter((l) => l.group !== 'subtotal' && l.group !== 'total' && l.group !== 'contingency');
    const shownSum = floating.reduce((s, r) => s + parseFloat(r.querySelector('.rp-wf-val')!.textContent!.replace(/[^0-9.\-+−]/g, '').replace('−', '-')), 0);
    expect(shownSum).toBeCloseTo(kept.reduce((s, l) => s + l.value, 0) / 1e6, -1);
    expect(other).toBeTruthy();
  });
  it('draws a negative value to the left of where the bar started', () => {
    const ls: WaterfallLine[] = [
      { label: 'a', value: 100, group: 'base' }, { label: 'b', value: -40, group: 'multipliers' }, { label: 'T', value: 60, group: 'total' },
    ];
    const bars = [...waterfall(ls, { money }).querySelectorAll<HTMLElement>('.rp-wf-bar')];
    expect(parseFloat(bars[1].style.left)).toBeCloseTo(60, 5);
    expect(parseFloat(bars[1].style.width)).toBeCloseTo(40, 5);
    expect(parseFloat(bars[2].style.left)).toBe(0);
  });
  it('truncating label keeps a tooltip, and text is escaped', () => {
    const ls: WaterfallLine[] = [{ label: '<img src=x>', value: 5, group: 'base', src: '<b>s</b>' }, { label: 'T', value: 5, group: 'total' }];
    const el = waterfall(ls, { money });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector<HTMLElement>('.rp-wf-lab')!.title).toContain('<b>s</b>');
  });
});

describe('badge, rangeBar, pills, kpis, sourceInfo', () => {
  it('badge wording', () => {
    const texts = (['proven', 'within-mask', 'not-solved'] as const).map((o) => badge(o));
    expect(texts.map((b) => b.textContent)).toEqual(['Lowest routing score (proven)', 'Lowest routing score within the search area', 'Straight line (no route search)']);
    for (const b of texts) { expect(b.textContent).not.toMatch(/corridor|exploratory/i); expect(b.title).not.toMatch(/corridor|exploratory/i); expect(b.title.length).toBeGreaterThan(0); }
  });
  it('rangeBar shows the estimate label and three ticks', () => {
    const el = rangeBar(FIXTURE_RESULT.cost);
    expect(el.textContent).toContain('Rough early estimate');
    expect(el.textContent).not.toMatch(/exploratory/i);
    expect(el.querySelectorAll('.rp-range-ticks span')).toHaveLength(3);
    expect(el.textContent).toContain('−30 % / +50 %');
  });
  it('rangeBar rescales to preset dollars', () => {
    const c = FIXTURE_RESULT.cost;
    expect(rangeBar(c, 'preset').querySelector('.rp-range-ticks b')!.textContent).toBe(fmtMoneyHead(c.totalNominal));
  });
  it('pills are plural-aware and merge line classes', () => {
    const c = structuredClone(FIXTURE_RESULT.profile!.crossings);
    let txt = [...crossingPills(c).children].map((e) => e.textContent);
    expect(txt).toEqual(['≈6 rivers', '≈9 major roads', '≈4 rail', '≈5 pipelines', '≈11 existing lines', '21.4 mi protected (GAP 1–3)']);
    c.counts = { river: 1, road: 1, rail: 0, pipeline: 1, line230: 1, line100: 0 };
    c.miles.gap12 = 0; c.miles.gap3 = 0;
    txt = [...crossingPills(c).children].map((e) => e.textContent);
    expect(txt).toEqual(['≈1 river', '≈1 major road', '≈1 pipeline', '≈1 existing line']);
  });
  it('kpis: range, point, miles, $/mi all-in, $/mi line only', () => {
    const tiles = kpiTiles(FIXTURE_RESULT);
    const c = FIXTURE_RESULT.cost;
    expect(tiles).toHaveLength(5);
    expect(tiles[0].value).toBe(`${fmtMoneyHead(c.band.low)} \u2013 ${fmtMoneyHead(c.band.high)}`);
    expect(tiles[0].label).toContain('2025');
    expect(tiles[1].value).toBe(fmtMoneyHead(c.total2025));
    expect(tiles[2].value).toBe('250.1 mi');
    expect(tiles[2].label).toMatch(/1\.\d\d× straight line/);
    expect(tiles[3].label).toBe('all-in, with terminals');
    expect(tiles[4].label).toBe('line only, without terminals');
    const k = c.total2025 / c.totalNominal;
    const line = (c.total2025 - (c.terminalsUsd ?? 0) * k * (1 + (c.contingency?.pct ?? 0))) / FIXTURE_RESULT.lengthMi;
    expect(tiles[4].value).toBe(`${fmtMoneyHead(line)}/mi`);
    expect(kpis(FIXTURE_RESULT).querySelectorAll('.rp-kpi')).toHaveLength(5);
  });
  it('fmtMoneyHead: two figures, unit chosen after rounding', () => {
    const cases: [number, string][] = [
      [0, '$0'], [999.4, '$1.0\u00a0k'], [999.6, '$1.0\u00a0k'], [450, '$450'], [12_345, '$12\u00a0k'], [9.95e6, '$10\u00a0M'], [9.5e6, '$9.5\u00a0M'],
      [33.4e6, '$33\u00a0M'], [99.6e6, '$100\u00a0M'], [720e6, '$720\u00a0M'], [999.6e6, '$1.0\u00a0B'], [3.1e9, '$3.1\u00a0B'],
      [-3.1e9, '\u2212$3.1\u00a0B'], [-450, '\u2212$450'],
    ];
    for (const [v, text] of cases) expect(fmtMoneyHead(v)).toBe(text);
  });
  it('sourceInfo escapes', () => {
    const b = sourceInfo('<img src=x onerror=1>');
    expect(b.querySelector('img')).toBeNull();
    expect(b.title).toBe('<img src=x onerror=1>');
    expect(b.getAttribute('aria-label')).toBe('<img src=x onerror=1>');
  });
});
