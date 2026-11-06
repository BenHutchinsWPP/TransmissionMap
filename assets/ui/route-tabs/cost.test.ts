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
import { FIXTURE_SESSION, fakeTabContext } from './fixture.js';
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

  it('the toggle sets dollars and re-renders', () => {
    const { el, ctx, s } = render();
    const group = el.querySelector('[role="radiogroup"]')!;
    expect(group.querySelector('[data-dollars="y2025"]')?.getAttribute('aria-checked')).toBe('true');
    group.querySelector<HTMLButtonElement>('[data-dollars="preset"]')!.click();
    expect(s.dollars).toBe('preset');
    expect(ctx.calls).toContain('rerender()');
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
