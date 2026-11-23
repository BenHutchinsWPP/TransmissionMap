// @vitest-environment jsdom
// ─── Route formatting tests ──────────────────────────────────────────────────
// Role: the moved pure logic of route-format.ts: waterfall lines (sums in both dollar years, terminals by kind,
//       short-line factor, category labels) and headline dollars. English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./route-format.ts, ./tabs/fixture.ts, registry/route-presets.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import { endsText, terminalSplit, waterfallLines, fmtMoneyHead, type WaterfallLine } from './route-format.js';
import { FIXTURE_RESULT, fixtureCost } from './tabs/fixture.js';
import { routePreset } from '../../../src/registry/route-presets.js';

const preset = routePreset('tm-default')!;
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
          const t = lines.filter((l) => l.group === 'terminals' && /^(New stations|Line positions)/.test(l.label));
          const nPos = kinds.filter((k) => k === 'position').length, nSt = kinds.filter((k) => k === 'new').length;
          const endsOf = (k: string) => kinds.flatMap((x, i) => (x === k ? ['AB'[i]] : [])).join(', ');
          expect(t.map((l) => l.label)).toEqual([...(nSt ? [`New stations (${endsOf('new')})`] : []), ...(nPos ? [`Line positions at existing stations (${endsOf('position')})`] : [])]);
          // the terminal lines sum to terminalsUsd itself (never the items' own sum, which may differ by an ulp)
          const k = dollars === 'y2025' ? cost.total2025 / cost.totalNominal : 1;
          expect(t.reduce((s, l) => s + l.value, 0)).toBeCloseTo((cost.terminalsUsd ?? 0) * k, 3);
        });
      }
    }
    it('terminalSplit takes the group totals from terminalsUsd, not from the items\' own sum', () => {
      const c = { ...fixtureCost(), terminalCount: 3, terminalsUsd: 0.6, terminalItems: [{ kind: 'new' as const, end: 'A' as const, usd: 0.1 }, { kind: 'new' as const, end: 'B' as const, usd: 0.2 }, { kind: 'mid' as const, end: null, usd: 0.3 }] };
      expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
      expect(terminalSplit(c)).toEqual({ stations: { n: 3, each: 0.1, usd: 0.6, ends: ['A', 'B'], mid: 1 }, positions: null });
      const mixed = { ...c, terminalsUsd: 5.5, terminalItems: [{ kind: 'position' as const, end: 'A' as const, usd: 2 }, ...c.terminalItems.slice(1)] };
      const sp = terminalSplit(mixed)!;
      expect(sp.positions!.usd + sp.stations!.usd).toBe(5.5);
    });
    it('a mid-line station joins the new-station line and the bars still sum to the total', () => {
      const base = fixtureCost(1, undefined, ['new', 'new']);
      const items = [...base.terminalItems!, { kind: 'mid' as const, end: null, usd: base.terminalItems![0].usd }];
      const extra = base.terminalItems![0].usd;
      const c = { ...base, terminalItems: items, terminalCount: 3, terminalsUsd: (base.terminalsUsd ?? 0) + extra, totalNominal: base.totalNominal + extra, total2025: base.total2025 + extra };
      const lines = waterfallLines(c, preset, { dollars: 'preset' });
      expect(lines.filter((l) => l.group === 'terminals' && /^New/.test(l.label)).map((l) => l.label)).toEqual(['New stations (A, B, 1 mid-line)']);
      expect(lines.find((l) => l.label.startsWith('New stations'))!.value).toBeCloseTo(c.terminalsUsd!, 3);
    });
    it('terminalsUsd null with items gives no terminal line', () => {
      const c = { ...fixtureCost(1, undefined, ['new', 'new']), terminalsUsd: null };
      expect(waterfallLines(c, preset, { dollars: 'preset' }).some((l) => /^(New stations|Terminals|Line positions)/.test(l.label))).toBe(false);
    });
    it('endsText lists ends then mid-line stations', () => {
      expect(endsText(['A', 'B'], 0)).toBe('A, B');
      expect(endsText(['A'], 2)).toBe('A, 2 mid-line');
      expect(endsText([], 1)).toBe('1 mid-line');
    });
    it('a study method\'s new-station line reads as the method prices it; positions keep their label', () => {
      const c = { ...fixtureCost(1, undefined, ['new', 'position']) };
      const study = { ...preset, study_terminals: true } as typeof preset;
      const labels = waterfallLines(c, study, { dollars: 'preset' }).filter((l) => l.group === 'terminals' && /^(Terminals|New|Line)/.test(l.label)).map((l) => l.label);
      expect(labels).toEqual(['Terminals as the method prices them (A)', 'Line positions at existing stations (B)']);
    });
    it('a result without terminalItems keeps the one Terminals line', () => {
      const old = fixtureCost();
      delete old.terminalItems;
      const lines = waterfallLines(old, preset, { dollars: 'preset' });
      expect(lines.filter((l) => /^Terminals/.test(l.label))).toHaveLength(1);
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


describe('badge, rangeBar, pills, kpis, sourceInfo', () => {
  it('fmtMoneyHead: two figures, unit chosen after rounding', () => {
    const cases: [number, string][] = [
      [0, '$0'], [999.4, '$1.0\u00a0k'], [999.6, '$1.0\u00a0k'], [450, '$450'], [12_345, '$12\u00a0k'], [9.95e6, '$10\u00a0M'], [9.5e6, '$9.5\u00a0M'],
      [33.4e6, '$33\u00a0M'], [99.6e6, '$100\u00a0M'], [720e6, '$720\u00a0M'], [999.6e6, '$1.0\u00a0B'], [3.1e9, '$3.1\u00a0B'],
      [-3.1e9, '\u2212$3.1\u00a0B'], [-450, '\u2212$450'],
    ];
    for (const [v, text] of cases) expect(fmtMoneyHead(v)).toBe(text);
  });
});
