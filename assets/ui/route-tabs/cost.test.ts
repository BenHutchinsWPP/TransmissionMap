// @vitest-environment jsdom
// Tests for the Cost sub-tab: renders from the fixture, line items sum to the nominal and 2025$
// totals, the dollar-year toggle sets the session and re-renders, sources are text not HTML.
// English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: cost.js, fixture.js, registry/route-presets.ts.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import tab from './cost.js';
import { FIXTURE_RESULT, FIXTURE_SESSION, fakeTabContext, fixtureCost } from './fixture.js';
import { routePreset } from '../../../src/registry/route-presets.js';

function render(mut?: (s: ReturnType<typeof FIXTURE_SESSION>) => void) {
  const s = FIXTURE_SESSION();
  mut?.(s);
  const ctx = fakeTabContext(s);
  const el = document.createElement('div');
  document.body.append(el);
  tab.render(el, ctx);
  return { el, ctx, s };
}

describe('Cost tab', () => {
  it('is never disabled and renders waterfall, KPIs, range and table', () => {
    const { el } = render();
    expect(tab.disabled(FIXTURE_SESSION())).toBeNull();
    expect(el.querySelector('.rp-wf:not(.rp-wf--compact)')).not.toBeNull();
    expect(el.querySelectorAll('.rp-wf-legend').length).toBe(1);
    expect(el.querySelector('.rp-kpis')).not.toBeNull();
    expect(el.querySelector('.rp-range')).not.toBeNull();
    expect(el.querySelector('tr[data-item="base"]')?.textContent).toContain('250.1 mi');
    expect([...el.querySelectorAll('h4, th, .rc-head, tr > td:not(:last-child)')].map((n) => n.textContent).join(' ')).not.toMatch(/exploratory|corridor/i);
  });

  it('line items sum to both totals', () => {
    const { el, s } = render();
    const rows = [...el.querySelectorAll<HTMLElement>('tr[data-item]')];
    const items = rows.filter((r) => r.dataset.item !== 'total');
    const c = s.result!.cost;
    const nom = items.reduce((a, r) => a + Number(r.dataset.nominal), 0);
    const y25 = items.reduce((a, r) => a + Number(r.dataset.usd2025), 0);
    expect(Math.abs(nom - c.totalNominal)).toBeLessThan(0.05e6);
    expect(Math.abs(y25 - c.total2025)).toBeLessThan(0.05e6);
    const total = rows.find((r) => r.dataset.item === 'total')!;
    expect(total.children[2].textContent).toBe((c.totalNominal / 1e6).toFixed(1));
    expect(total.children[3].textContent).toBe((c.total2025 / 1e6).toFixed(1));
  });

  it('terminals are one row per kind with count × each, and the rows still sum to both totals', () => {
    const { el, s } = render((x) => { x.result = { ...FIXTURE_RESULT, cost: fixtureCost(1, undefined, ['position', 'new']) }; });
    expect(el.querySelector('tr[data-item="terminals"]')!.children[1].textContent).toBe('1 × $34.6 M');
    expect(el.querySelector('tr[data-item="positions"]')!.children[1].textContent).toBe('1 × $10.5 M');
    expect(el.querySelector('tr[data-item="positions"]')!.children[0].textContent).toBe('Line positions');
    const items = [...el.querySelectorAll<HTMLElement>('tr[data-item]')].filter((r) => r.dataset.item !== 'total');
    const c = s.result!.cost;
    expect(Math.abs(items.reduce((a, r) => a + Number(r.dataset.nominal), 0) - c.totalNominal)).toBeLessThan(0.05e6);
    expect(Math.abs(items.reduce((a, r) => a + Number(r.dataset.usd2025), 0) - c.total2025)).toBeLessThan(0.05e6);
  });

  it('two line positions show no station row; no terminal at all shows neither', () => {
    const two = render((x) => { x.result = { ...FIXTURE_RESULT, cost: fixtureCost(1, undefined, ['position', 'position']) }; }).el;
    expect(two.querySelector('tr[data-item="terminals"]')).toBeNull();
    expect(two.querySelector('tr[data-item="positions"]')!.children[1].textContent).toBe('2 × $10.5 M');
    const none = render((x) => { x.result = { ...FIXTURE_RESULT, cost: fixtureCost(1, undefined, ['none', 'none']) }; }).el;
    expect(none.querySelector('tr[data-item="terminals"], tr[data-item="positions"]')).toBeNull();
  });

  it('an all-in estimate shows no markup rows and cites an entered figure as entered', () => {
    const cost = { ...fixtureCost(), markupsUsd: 0, userCosts: { basis: 'all-in' as const, year: 2024, items: ['line' as const], line_types: ['ac500'] } };
    const s = FIXTURE_SESSION();
    s.result = { ...FIXTURE_RESULT, cost };
    s.resultInputs = { ...s.inputs, patch: { cost_inputs: { basis: 'all-in', year: 2024, line_types: { ac500: { usd_per_mi: 3e6 } } } } };
    const el = document.createElement('div');
    tab.render(el, fakeTabContext(s));
    expect(el.querySelector('tr[data-item^="markup"]')).toBeNull();
    expect(el.querySelector('tr[data-item="base"]')!.lastElementChild!.textContent).toContain('entered by you (2024 dollars, all-in cost per mile)');
  });

  it('the toggle sets dollars and re-renders', () => {
    const { el, ctx, s } = render();
    const group = el.querySelector('[role="radiogroup"]')!;
    expect(group.querySelector('[data-dollars="y2025"]')?.getAttribute('aria-checked')).toBe('true');
    group.querySelector<HTMLButtonElement>('[data-dollars="preset"]')!.click();
    expect(s.dollars).toBe('preset');
    expect(ctx.calls).toContain('rerender()');
  });

  it('method-year dollars stay hidden until the checkbox is ticked', () => {
    const { el, ctx } = render();
    const box = el.querySelector<HTMLInputElement>('.rc-method input')!;
    expect(box.checked).toBe(false);
    expect(el.querySelector('.rc-method')!.textContent).toBe('Show method-year dollars and the mitigation range');
    const total = () => el.querySelector<HTMLElement>('tr[data-item="total"]')!.children[2] as HTMLElement;
    expect(total().hidden).toBe(true);
    expect(el.querySelector<HTMLElement>('tr[data-item="base"]')!.dataset.nominal).toBeDefined();
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(ctx.calls).toContain('rerender()');
    tab.render(el, ctx);
    expect(el.querySelector<HTMLInputElement>('.rc-method input')!.checked).toBe(true);
    expect(total().hidden).toBe(false);
  });

  it('renders sources as text, never markup', () => {
    const p = routePreset('tm-default')!;
    const old = p.mitigation!.src;
    p.mitigation!.src = 'x <b>bold</b>';
    try {
      const { el } = render();
      expect(el.querySelector('b.x, td b')).toBeNull();
      expect(el.querySelector('tr[data-item="mitigation"]')?.textContent).toContain('<b>bold</b>');
    } finally { p.mitigation!.src = old; }
  });
});
