// @vitest-environment jsdom
// ─── Route Alternatives tab tests ───────────────────────────────────────────────
// Role: find button, list and compare from the fixture, the differ filter, threshold radios,
//       make-result, skip reasons, and the wording rule (no "corridor"/"exploratory").
//       English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./alternatives.ts, ./fixture.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import tab from './alternatives.js';
import { FIXTURE_RESULT, FIXTURE_SESSION, fakeTabContext } from './fixture.js';

function mount(mut?: (s: ReturnType<typeof FIXTURE_SESSION>) => void) {
  const s = FIXTURE_SESSION();
  mut?.(s);
  const ctx = fakeTabContext(s);
  const root = document.createElement('div');
  tab.render(root, ctx);
  return { root, ctx, s };
}

describe('alternatives tab', () => {
  it('asks to find alternatives when none were requested', () => {
    const { root, ctx } = mount((s) => { s.result = { ...FIXTURE_RESULT, alternatives: undefined, altFound: undefined }; });
    root.querySelector<HTMLButtonElement>('.ra-btn--primary')!.click();
    expect(ctx.calls).toContain('findAlternatives()');
  });
  it('shows progress while solving and retry on error', () => {
    expect(mount((s) => { s.altsSolving = true; }).root.querySelector('.ra-spin')).toBeTruthy();
    const { root, ctx } = mount((s) => { s.altsError = 'boom'; });
    expect(root.textContent).toContain('boom');
    root.querySelector<HTMLButtonElement>('.ra-btn')!.click();
    expect(ctx.calls).toContain('findAlternatives()');
  });
  it('lists the optimal route and both alternatives with a compare table', () => {
    const { root } = mount();
    const rows = [...root.querySelectorAll('.ra-row')].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Lowest routing score · 250\.1 mi/);
    expect(rows[1]).toMatch(/Alt 1 · \+3\.4 % · 258\.4 mi/);
    expect(rows[1]).not.toMatch(/tribal/i);
    expect(root.querySelectorAll('thead th')).toHaveLength(4);
    expect(root.querySelector('[data-row="length"]')).toBeTruthy();
    expect(root.textContent).toContain('Alt 2 is');
  });
  it('selecting a row fits the map to it', () => {
    const { root, ctx } = mount();
    root.querySelectorAll<HTMLButtonElement>('.ra-row')[1].click();
    expect(ctx.calls.some((c) => c.startsWith('fitPoints('))).toBe(true);
  });
  it('hides rows that do not differ unless unchecked', () => {
    const { root, s } = mount((x) => { x.result = { ...FIXTURE_RESULT, alternatives: FIXTURE_RESULT.alternatives!.map((a) => ({ ...a, path: FIXTURE_RESULT.path, crossings: FIXTURE_RESULT.profile!.crossings })) }; });
    expect(root.querySelector('[data-row="crossings"]')).toBeNull();
    expect(root.querySelector('[data-row="length"]')).toBeTruthy();
    const cb = root.querySelector<HTMLInputElement>('.ra-right .ra-check input')!;
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-row="crossings"]')).toBeTruthy();
    expect(s).toBeTruthy();
  });
  it('threshold radio calls setThreshold', () => {
    const { root, ctx } = mount();
    root.querySelector<HTMLButtonElement>('[data-thr="0.05"]')!.click();
    expect(ctx.calls).toContain('setThreshold(0.05)');
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(4);
  });
  it('with Alt 2 shown, lists it first, then "Lowest routing score" (make → -1) and Alt 1 by its own number', () => {
    const alts = FIXTURE_RESULT.alternatives!;
    const { root, ctx } = mount((s) => {
      s.optimal = FIXTURE_RESULT;
      s.fromAlt = 2;
      s.result = { ...FIXTURE_RESULT, path: alts[1].path, lengthMi: alts[1].lengthMi, cost: alts[1].cost };
    });
    const rows = [...root.querySelectorAll('.ra-row')].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Alt 2 · \+7\.8 % · 266\.9 mi/);
    expect(rows[1]).toMatch(/^Lowest routing score · 250\.1 mi/);
    expect(rows[2]).toMatch(/^Alt 1 · \+3\.4 %/);
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['', 'Alt 2', 'Lowest routing score', 'Alt 1']);
    const make = root.querySelector<HTMLButtonElement>('[data-make="-1"]')!;
    expect(make.getAttribute('aria-label')).toBe('Make the lowest-score route the result');
    make.click();
    expect(ctx.calls).toContain('makeAltResult(-1)');
    root.querySelector<HTMLButtonElement>('[data-make="0"]')!.click();
    expect(ctx.calls).toContain('makeAltResult(0)');
  });
  it('make-result calls makeAltResult with the alternative index', () => {
    const { root, ctx } = mount();
    root.querySelector<HTMLButtonElement>('[data-make="1"]')!.click();
    expect(ctx.calls).toContain('makeAltResult(1)');
  });
  it('shows the surface skip reason and the engine text when none found', () => {
    const { root } = mount();
    expect(root.textContent).toContain('Similar-cost areas were not requested');
    const none = mount((s) => { s.result = { ...FIXTURE_RESULT, alternatives: [], altFound: 0, altSkipped: 'found 0 of 3 in 5 re-solves' }; });
    expect(none.root.textContent).toContain('found 0 of 3 in 5 re-solves');
    const dflt = mount((s) => { s.result = { ...FIXTURE_RESULT, alternatives: [], altFound: 0 }; });
    expect(dflt.root.textContent).toContain('No distinct alternative within 20 %');
  });
  it('never says corridor or exploratory', () => {
    for (const m of [mount(), mount((s) => { s.altsSolving = true; }), mount((s) => { s.result = { ...FIXTURE_RESULT, alternatives: undefined, altFound: undefined }; })]) {
      expect(m.root.textContent).not.toMatch(/corridor|exploratory/i);
    }
  });

  it('the none-found text names the stretch the search used', () => {
    const m = mount((s) => { s.altStretch = 0.3; s.result = { ...FIXTURE_RESULT, alternatives: [], altFound: 0 }; });
    expect(m.root.textContent).toContain('No distinct alternative within 30 %');
  });
  it('selection and the differ box are per session and reset for a new route', () => {
    const { root, s, ctx } = mount();
    root.querySelectorAll<HTMLButtonElement>('.ra-row')[2].click();
    const cb = root.querySelector<HTMLInputElement>('.ra-right .ra-check input')!;
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const pressed = (r: HTMLElement) => [...r.querySelectorAll('.ra-row')].map((b) => b.getAttribute('aria-pressed'));
    expect(pressed(root)).toEqual(['false', 'false', 'true']);
    // the same session re-rendered (and after Find alternatives merged a copy) keeps both
    s.result = { ...s.result! };
    tab.render(root, ctx);
    expect(pressed(root)).toEqual(['false', 'false', 'true']);
    expect(root.querySelector<HTMLInputElement>('.ra-right .ra-check input')!.checked).toBe(false);
    // another pane's session starts clean
    const other = mount();
    expect(pressed(other.root)).toEqual(['true', 'false', 'false']);
    expect(other.root.querySelector<HTMLInputElement>('.ra-right .ra-check input')!.checked).toBe(true);
    // a new route (new A/B) in this session resets it
    s.result = { ...s.result!, path: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
    tab.render(root, ctx);
    expect(pressed(root)).toEqual(['true', 'false', 'false']);
    expect(root.querySelector<HTMLInputElement>('.ra-right .ra-check input')!.checked).toBe(true);
  });
});
