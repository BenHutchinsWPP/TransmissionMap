// @vitest-environment jsdom
// Tests for the Summary sub-tab: the fixture result renders its KPIs, range bar, pills,
// tribal note and a compact waterfall (≤ 8 lines before the subtotal), and the
// colour-by radiogroup calls ctx.setColourMode.
// Deps: summary.js, fixture.js, i18n (t).
import { describe, it, expect, beforeAll } from 'vitest';
import tab from './summary.js';
import { FIXTURE_SESSION, fakeTabContext } from './fixture.js';
import { loadRouteStrings } from '../../../src/i18n/index.js';

beforeAll(() => loadRouteStrings());

function render(mut?: (s: ReturnType<typeof FIXTURE_SESSION>) => void) {
  const s = FIXTURE_SESSION();
  mut?.(s);
  const ctx = fakeTabContext(s);
  const el = document.createElement('div');
  document.body.append(el);
  tab.render(el, ctx);
  return { el, ctx };
}

describe('Summary tab', () => {
  it('is never disabled', () => {
    expect(tab.id).toBe('summary');
    expect(tab.disabled(FIXTURE_SESSION())).toBeNull();
  });

  it('renders the headline, range, pills and money heading, with no Tribal callout', () => {
    const { el } = render();
    expect(el.querySelector('.rp-kpis')?.textContent).toContain('$2.');
    expect(el.querySelector('.rp-kpis')?.textContent).toContain('250.1');
    expect(el.querySelector('.rp-range')).not.toBeNull();
    expect(el.querySelectorAll('.rp-pill').length).toBeGreaterThan(3);
    expect(el.querySelector('.rp-tribal')).toBeNull();
    expect(el.textContent).toContain('Where the money goes');
  });

  it('shows a compact waterfall of at most 8 lines before the subtotal', () => {
    const { el } = render();
    const rows = [...el.querySelectorAll('.rp-wf-row')];
    const sub = rows.findIndex((r) => r.classList.contains('rp-wf-row--subtotal'));
    expect(sub).toBeGreaterThan(0);
    expect(sub).toBeLessThanOrEqual(8);
    expect(rows.at(-1)!.classList.contains('rp-wf-row--total')).toBe(true);
  });

  it('colour-by radiogroup calls setColourMode and marks the choice', () => {
    const { el, ctx } = render();
    const group = el.querySelector('[role=radiogroup]')!;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role=radio]')];
    expect(radios.map((r) => r.textContent)).toEqual(['Cost ×', 'Driver', 'Plain']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    ctx.setColourMode = (m) => { ctx.calls.push(`setColourMode("${m}")`); ctx.session.colour = m; };
    radios[1].click();
    expect(ctx.calls).toContain('setColourMode("driver")');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    radios[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(ctx.calls).toContain('setColourMode("plain")');
  });

  it('renders without a profile (no pills) and in preset dollars', () => {
    const { el } = render((s) => { s.result = { ...s.result!, profile: null }; s.dollars = 'preset'; });
    expect(el.querySelector('.rp-pills')).toBeNull();
    expect(el.querySelector('.rp-kpis')?.textContent).toContain('2014$');
  });
});
