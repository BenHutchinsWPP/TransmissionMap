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

import { waterfall, waterfallLines, rangeBar, crossingPills, tribalNote, badge, sourceInfo, kpis, type WaterfallLine } from './widgets.js';
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

describe('badge, rangeBar, pills, kpis, tribal, sourceInfo', () => {
  it('badge wording', () => {
    const texts = (['proven', 'within-mask', 'not-solved'] as const).map((o) => badge(o));
    expect(texts.map((b) => b.textContent)).toEqual(['Optimal (proven)', 'Optimal within search area', 'Straight line (no route search)']);
    for (const b of texts) { expect(b.textContent).not.toMatch(/corridor|exploratory/i); expect(b.title).not.toMatch(/corridor|exploratory/i); expect(b.title.length).toBeGreaterThan(0); }
  });
  it('rangeBar shows the estimate label and three ticks', () => {
    const el = rangeBar(FIXTURE_RESULT.cost, money);
    expect(el.textContent).toContain('Rough early estimate');
    expect(el.textContent).not.toMatch(/exploratory/i);
    expect(el.querySelectorAll('.rp-range-ticks span')).toHaveLength(3);
    expect(el.textContent).toContain('−30 % / +50 %');
  });
  it('rangeBar rescales to preset dollars', () => {
    const c = FIXTURE_RESULT.cost;
    expect(rangeBar(c, money, 'preset').querySelector('.rp-range-ticks b')!.textContent).toBe(money(c.totalNominal));
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
  it('kpis show total, miles with straight-line ratio, and $/mi', () => {
    const txt = kpis(FIXTURE_RESULT, money).textContent!;
    expect(txt).toContain(money(FIXTURE_RESULT.cost.total2025));
    expect(txt).toContain('250.1 mi');
    expect(txt).toMatch(/1\.\d\d× straight line/);
    expect(txt).toContain('/mi');
  });
  it('tribalNote heading and default note; hidden at 0 mi', () => {
    const el = tribalNote(FIXTURE_RESULT);
    expect(el.textContent).toContain('6.3 mi of tribal land');
    expect(el.textContent).toContain('tribal consent');
    expect(tribalNote({ ...FIXTURE_RESULT, tribalMiles: 0, tribalNote: 'x' }).hidden).toBe(true);
    expect(tribalNote({ ...FIXTURE_RESULT, tribalNote: 'Custom <i>note</i>' }).querySelector('i')).toBeNull();
  });
  it('sourceInfo escapes', () => {
    const b = sourceInfo('<img src=x onerror=1>');
    expect(b.querySelector('img')).toBeNull();
    expect(b.title).toBe('<img src=x onerror=1>');
    expect(b.getAttribute('aria-label')).toBe('<img src=x onerror=1>');
  });
});
