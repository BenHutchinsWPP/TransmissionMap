// @vitest-environment jsdom
// ─── Route Method tab tests ──────────────────────────────────────────────────
// Role: an edit lands in session.inputs.patch; an invalid one shows an error and never
//       solves; Reset clears patch and ghost; Save as custom writes storage, fires
//       `route:presets` and switches the session; live tuning debounces a burst into one
//       ghost + resolve; sensitivity picks 7 rows → 14 valid specs, runs them through
//       ctx.runSolves in order, ranks, and Cancel stops; text is escaped.
// Deps: ./method.ts, ./fixture.ts, route/preset-patch.ts, route/custom-presets.ts, registry/route-presets.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { getLocale: () => 'en', t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

vi.mock('../../route/route-open.js', () => ({ registerUpload: vi.fn(), unregisterUpload: vi.fn() }));

import { registerUpload, unregisterUpload } from '../../route/route-open.js';
import { GRID_250, lngLatOf } from '../../route/grid.js';
import { validateUpload, type UploadLayer } from '../../route/upload-layer.js';
import tab, { _resetMethodTab, uploadReason, uploads, dropUploads, sensitivityRows, sensitivitySpecs, LIVE_DEBOUNCE_MS } from './method.js';
import { FIXTURE_RESULT, FIXTURE_SESSION, fakeTabContext } from './fixture.js';
import { UPLOAD_TOTAL_VERTICES, validatePresetPatch } from '../../route/preset-patch.js';
import { CUSTOM_PRESETS_KEY, createCustomPresetStore } from '../../route/custom-presets.js';
import { installDrawerEnv, resetDrawerEnv } from '../test-drawer-env.js';
import { routePreset } from '../../../src/registry/route-presets.js';
import type { RouteResult } from '../../route/route.js';
import type { RouteTabContext } from './types.js';

const preset = routePreset('tm-default')!;

/** The fixture result plus three routing-only rows (usd 0, real affectedM) so the sensitivity card has > 7 candidates. */
const RESULT: RouteResult = {
  ...FIXTURE_RESULT,
  cost: {
    ...FIXTURE_RESULT.cost,
    perRow: [...FIXTURE_RESULT.cost.perRow, { row: 14, usd: 0, affectedM: 9e3 }, { row: 28, usd: 0, affectedM: 98e3 }, { row: 30, usd: 0, affectedM: 10e3 }],
  },
};

function setup(over: (ctx: ReturnType<typeof fakeTabContext>) => void = () => {}) {
  const session = FIXTURE_SESSION();
  session.result = RESULT;
  session.tab = 'method';
  const ctx = fakeTabContext(session);
  over(ctx);
  const el = document.createElement('div');
  document.body.append(el);
  tab.render(el, ctx);
  const input = (row: number, field: string) => el.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-field="${field}"]`)!;
  const type = (i: HTMLInputElement, v: string) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
  const click = (sel: string) => el.querySelector<HTMLButtonElement>(sel)!.click();
  return { session, ctx, el, input, type, click };
}

beforeEach(() => { localStorage.clear(); _resetMethodTab(); document.body.replaceChildren(); });
afterEach(() => { tab.dispose?.(); vi.useRealTimers(); });

describe('method tab', () => {
  it('asks for a tall drawer while mounted', () => {
    const { ctx, el } = setup();
    expect(ctx.calls).toContain('setTall(true)');
    expect(el.querySelector('.rm-based')!.textContent).toBe(`Based on: ${preset.label}`);
    tab.dispose!();
    expect(ctx.calls.at(-1)).toBe('setTall(false)');
  });

  it('an edit is stored in session.inputs.patch and counted', () => {
    const { session, el, input, type } = setup();
    type(input(9, 'cost_x'), '2');
    expect(session.inputs.patch).toEqual({ rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] });
    expect(el.querySelector('.rm-chip')!.textContent).toBe('1 edit');
    expect(input(9, 'cost_x').closest('td')!.querySelector('.wt-was')!.textContent).toBe('was TEPPC ×1.75 · SCE ×2 · MISO ×1.21 · Southeast ×1.6');
    expect(el.querySelector<HTMLButtonElement>('.rm-resolve')!.disabled).toBe(false);
  });

  it('each valid edit goes to ctx.previewPatch (the live cell-weight repaint); an invalid one does not', () => {
    const { ctx, input, type } = setup((c) => { c.previewPatch = (patch) => { c.calls.push(`previewPatch(${JSON.stringify(patch)})`); }; });
    type(input(9, 'route_w'), '10');
    expect(ctx.calls.filter((c) => c.startsWith('previewPatch('))).toEqual([
      `previewPatch(${JSON.stringify({ rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', route_w: 10 }] })})`,
    ]);
    type(input(34, 'route_w'), '-2');
    expect(ctx.calls.filter((c) => c.startsWith('previewPatch('))).toHaveLength(1);
  });

  it('an invalid value shows an error, keeps the last valid patch and never solves', async () => {
    vi.useFakeTimers();
    const { session, ctx, el, input, type } = setup();
    session.liveTuning = true;
    type(input(34, 'route_w'), '-2');
    expect(session.inputs.patch).toBeNull();
    expect(el.querySelector('.rm-chip')!.textContent).toBe('1 edit · 1 error');
    expect(input(34, 'route_w').closest('td')!.querySelector('.wt-err')!.textContent).toMatch(/^Must be a number/);
    expect(el.querySelector<HTMLButtonElement>('.rm-resolve')!.disabled).toBe(true);
    el.querySelector<HTMLButtonElement>('.rm-resolve')!.click();
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS * 3);
    expect(ctx.calls.some((c) => c.startsWith('resolve('))).toBe(false);
  });

  it('Reset to preset clears the patch, the inputs and the ghost', () => {
    const { session, ctx, input, type, click } = setup();
    type(input(15, 'route_w'), '25');
    expect(session.inputs.patch).not.toBeNull();
    click('.rm-reset');
    expect(session.inputs.patch).toBeNull();
    expect(input(15, 'route_w').value).toBe('10');
    expect(ctx.calls).toContain('setGhost(null)');
  });

  it('Reset to preset with Live on re-solves the preset after the debounce', async () => {
    vi.useFakeTimers();
    const { session, ctx, input, click } = setup((c) => {
      const s = c.session;
      s.resultInputs = { ...s.inputs, patch: { rows: [{ row: 15, band: 'protect', note: 'GAP 2', route_w: 25 }] } };
      s.inputs.patch = s.resultInputs.patch;
      s.liveTuning = true;
    });
    expect(input(15, 'route_w').value).toBe('25');
    click('.rm-reset');
    expect(session.inputs.patch).toBeNull();
    expect(ctx.calls.some((c) => c.startsWith('resolve('))).toBe(false);
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS);
    expect(ctx.calls.filter((c) => c.startsWith('resolve('))).toEqual(['resolve(null)']);
  });

  it('Save as custom writes storage, fires route:presets and switches the method', () => {
    const { session, ctx, el, input, type, click } = setup();
    type(input(9, 'cost_x'), '2');
    const heard = vi.fn();
    document.addEventListener('route:presets', heard);
    click('.rm-save');
    const form = el.querySelector<HTMLFormElement>('.rm-saveform')!;
    expect(form.hidden).toBe(false);
    form.querySelector<HTMLInputElement>('.rm-name')!.value = '<b>Steeper</b> mountains';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    document.removeEventListener('route:presets', heard);
    const stored = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY)!);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toMatchObject({ name: '<b>Steeper</b> mountains', base: 'tm-default', patch: { rows: [{ row: 9, cost_x: 2 }] } });
    expect(heard).toHaveBeenCalledOnce();
    expect(session.inputs.presetId).toBe(`custom:${stored.items[0].id}`);
    expect(session.inputs.patch).toBeNull();
    expect(ctx.calls).toContain('rerender()');
    // Re-rendered on the custom: its name as text, its stored value as the baseline.
    const el2 = document.createElement('div');
    tab.render(el2, ctx);
    expect(el2.querySelector('.rm-based b')).toBeNull();
    expect(el2.querySelector('.rm-based')!.textContent).toBe('Based on: <b>Steeper</b> mountains');
    const c = el2.querySelector<HTMLInputElement>('input[data-row="9"][data-field="cost_x"]')!;
    expect(c.value).toBe('2');
    expect(c.closest('td')!.classList.contains('wt-edited')).toBe(false);
  });

  it('a saved method can be renamed and deleted (second click confirms) from its header', () => {
    const { ctx, el, input, type, click } = setup();
    expect(el.querySelector<HTMLElement>('.rm-rename')!.hidden).toBe(true);
    type(input(9, 'cost_x'), '2');
    click('.rm-save');
    const f = el.querySelector<HTMLFormElement>('.rm-saveform')!;
    f.querySelector<HTMLInputElement>('.rm-name')!.value = 'Mine';
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    const el2 = document.createElement('div');
    tab.render(el2, ctx);
    const items = () => JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY)!).items;
    el2.querySelector<HTMLButtonElement>('.rm-rename')!.click();
    const rf = el2.querySelectorAll<HTMLFormElement>('.rm-saveform')[1];
    expect(rf.hidden).toBe(false);
    rf.querySelector<HTMLInputElement>('.rm-name')!.value = 'Renamed';
    rf.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(items()[0].name).toBe('Renamed');
    const heard = vi.fn();
    document.addEventListener('route:presets', heard);
    const del = el2.querySelector<HTMLButtonElement>('.rm-delete')!;
    del.click();
    expect(items()).toHaveLength(1);
    del.click();
    document.removeEventListener('route:presets', heard);
    expect(items()).toHaveLength(0);
    expect(heard).toHaveBeenCalledOnce();
  });

  it('saving on top of a custom merges its stored patch', () => {
    const r = createCustomPresetStore(localStorage).save('base', 'tm-default', { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] });
    expect(r.ok).toBe(true);
    const { session, el, input, type, click } = setup((ctx) => { ctx.session.inputs.presetId = `custom:${r.ok ? r.result.id : ''}`; });
    type(input(15, 'route_w'), '25');
    click('.rm-save');
    el.querySelector<HTMLInputElement>('.rm-name')!.value = 'two';
    el.querySelector('.rm-saveform')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const items = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY)!).items;
    expect(items).toHaveLength(2);
    expect(items[1].patch.rows.map((x: { row: number }) => x.row)).toEqual([9, 15]);
    expect(session.inputs.presetId).toBe(`custom:${items[1].id}`);
  });

  it('live tuning: a burst of edits → one ghost of the shown path, then one resolve', async () => {
    vi.useFakeTimers();
    const { session, ctx, input, type } = setup();
    session.liveTuning = true;
    type(input(9, 'cost_x'), '2');
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS - 100);
    type(input(9, 'cost_x'), '2.5');
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS - 100);
    type(input(15, 'route_w'), '25');
    expect(ctx.calls.some((c) => c.startsWith('resolve('))).toBe(false);
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS);
    const solves = ctx.calls.filter((c) => c.startsWith('resolve('));
    expect(solves).toHaveLength(1);
    const ghost = ctx.calls.findIndex((c) => c.startsWith('setGhost('));
    expect(ctx.calls[ghost]).toBe(`setGhost(${JSON.stringify(RESULT.path)})`);
    expect(ghost).toBeLessThan(ctx.calls.indexOf(solves[0]));
    expect(JSON.parse(solves[0].slice('resolve('.length, -1))).toEqual(session.inputs.patch);
    expect(session.inputs.patch!.rows!.map((r) => r.row)).toEqual([9, 15]);
  });

  it('live off: no solve until Re-solve', async () => {
    vi.useFakeTimers();
    const { ctx, input, type, click } = setup();
    type(input(9, 'cost_x'), '2');
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS * 2);
    expect(ctx.calls.some((c) => c.startsWith('resolve('))).toBe(false);
    click('.rm-resolve');
    expect(ctx.calls.filter((c) => c.startsWith('resolve('))).toHaveLength(1);
  });

  it('shows the delta chip vs the previous result', () => {
    const { el } = setup((ctx) => {
      ctx.session.previous = { ...RESULT, lengthMi: RESULT.lengthMi - 4.2, cost: { ...RESULT.cost, total2025: RESULT.cost.total2025 + 38e6, totalNominal: RESULT.cost.totalNominal + 30e6 } };
    });
    expect(el.querySelector('.rm-delta')!.textContent).toBe('vs before: +4.2 mi · −$38.0 M');
  });
});

describe('method tab: input column errors and per-session state', () => {
  it('reports the invalid-cell count to the input column, and 0 on reset and dispose', () => {
    const { ctx, input, type, click } = setup();
    expect(ctx.calls).toContain('setMethodErrors(0)');
    ctx.calls.length = 0;
    type(input(34, 'route_w'), '-2');
    type(input(9, 'cost_x'), '-1');
    expect(ctx.calls.filter((c) => c.startsWith('setMethodErrors('))).toEqual(['setMethodErrors(1)', 'setMethodErrors(2)']);
    ctx.calls.length = 0;
    click('.rm-reset');
    expect(ctx.calls).toEqual(['setGhost(null)', 'setMethodErrors(0)']);
    type(input(9, 'cost_x'), '-1');
    ctx.calls.length = 0;
    tab.dispose!();
    expect(ctx.calls).toContain('setMethodErrors(0)');
  });

  it('update() after a re-solve keeps the table and the focused input, and refreshes the delta chip', () => {
    const { session, ctx, el, input, type } = setup();
    const cell = input(9, 'cost_x');
    cell.focus();
    type(cell, '2');
    session.previous = session.result;
    session.result = { ...RESULT, lengthMi: RESULT.lengthMi + 1 };
    session.resultInputs = { ...session.inputs };
    tab.update!(el, ctx);
    expect(input(9, 'cost_x')).toBe(cell);
    expect(document.activeElement).toBe(cell);
    expect(el.querySelector('.rm-delta')!.textContent).toMatch(/^vs before: \+1\.0 mi/);
  });

  it('the sensitivity run survives re-renders of the same session, not a new session or new ends', () => {
    let push: ((i: number) => void) | null = null;
    const slow = (ctx: RouteTabContext) => {
      ctx.runSolves = (_specs, onEach) => {
        push = (i) => onEach(i, { ...RESULT, cost: { ...RESULT.cost, total2025: RESULT.cost.total2025 + 1e6 } });
        return { cancel() {}, done: new Promise(() => {}) };
      };
    };
    const { session, ctx, el, click } = setup(slow);
    click('.rm-sens-run');
    push!(0); push!(1);
    tab.render(el, ctx);
    expect(el.querySelector('.rm-sens-count')!.textContent).toBe('2 / 14');
    // a reopened pane is a new session: nothing carried over
    tab.dispose!();
    const s2 = FIXTURE_SESSION();
    s2.result = RESULT;
    const el2 = document.createElement('div');
    tab.render(el2, fakeTabContext(s2));
    expect(el2.querySelector('.rm-sens-count')).toBeNull();
    expect(el2.querySelector('.rm-sens-run')).not.toBeNull();
    tab.dispose!();
    // new A/B in the first session drops its run
    session.resultInputs = { ...session.inputs, a: { lngLat: [-120, 46], hit: null } };
    tab.render(el, ctx);
    expect(el.querySelector('.rm-sens-count')).toBeNull();
    expect(el.querySelector('.rm-sens-note')).toBeNull();
  });
});

describe('sensitivity', () => {
  it('picks 7 non-barrier rows (routing-only rows included) and builds 14 valid specs', () => {
    const rows = sensitivityRows(preset, null, RESULT);
    expect(rows).toHaveLength(7);
    expect(rows).toContain(9);      // largest $
    expect(rows).toContain(28);     // routing-only, long
    const { specs, meta } = sensitivitySpecs(preset, null, rows);
    expect(specs).toHaveLength(14);
    for (const s of specs) {
      expect(validatePresetPatch(preset, s.patch).ok).toBe(true);
      expect(s).toMatchObject({ profile: false, alternatives: 0, surface: false });
    }
    // a regional cost row: the routing premium is scaled (1.75 → 1 + 0.75·k), its cost scale stays untouched
    for (const [k, w] of [[0.5, 1.375], [1.5, 2.125]] as const) {
      const p = specs[meta.findIndex((m) => m.row === 9 && m.k === k)].patch!;
      const e = p.rows!.find((r) => r.row === 9)!;
      expect(e.route_w).toBe(w);
      expect(e.cost_x).toBeUndefined();
      const v = validatePresetPatch(preset, p);
      expect(v.ok && v.result.rows[9].cost_x).toBe(1);
    }
    // GAP 1: route_w 100 → 1 + 99 × 1.5; its cost_x of 1 stays 1 at both k
    for (const [j, w] of [[0, 50.5], [1, 149.5]] as const) {
      const p = sensitivitySpecs(preset, null, [14]).specs[j].patch!;
      expect(p.rows![0].route_w).toBe(w);
      expect(p.rows![0].cost_x).toBeUndefined();
      const v = validatePresetPatch(preset, p);
      expect(v.ok && v.result.rows[14].cost_x).toBe(1);
    }
  });

  it('never invents a discount: a premium below 1 shrinks toward 1, factors of exactly 1 are untouched', () => {
    const adj = preset.rows.findIndex((r) => r.band === 'adj');   // route_w 0.5, cost_x 1
    const { specs, meta } = sensitivitySpecs(preset, null, [adj]);
    expect(meta.map((m) => m.k)).toEqual([0.5, 1.5]);
    expect(specs.map((x) => x.patch!.rows![0].route_w)).toEqual([0.75, 0.25]);
    expect(specs.every((x) => x.patch!.rows![0].cost_x === undefined)).toBe(true);
  });

  it('a regional cost row with routing weight 1 is skipped (its cost side is never varied)', () => {
    const crops = preset.rows.findIndex((r) => r.note === 'cultivated crops');   // route_w 1, cost_by_region
    expect(preset.rows[crops].cost_by_region).toBeDefined();
    expect(sensitivitySpecs(preset, null, [crops]).specs).toHaveLength(0);
  });

  it('skips a row with nothing to test (route_w and cost_x both 1)', () => {
    const neutral = preset.rows.findIndex((r) => r.note === 'other NLCD');
    expect(sensitivitySpecs(preset, null, [neutral]).specs).toHaveLength(0);
    const res: RouteResult = { ...RESULT, cost: { ...RESULT.cost, perRow: [{ row: neutral, usd: 5e6, affectedM: 9e4 }, ...RESULT.cost.perRow] } };
    expect(sensitivityRows(preset, null, res)).not.toContain(neutral);
  });

  it('keeps the current patch under each spec and clamps to the ranges', () => {
    const patch = { rows: [{ row: 31, band: 'flags' as const, note: 'military (PAD-US DOD)', route_w: 9000 }, { row: 3, band: 'landcover' as const, note: 'barren', cost_x: 1.1 }] };
    const { specs } = sensitivitySpecs(preset, patch, [31]);
    expect(specs[1].patch!.rows!.find((r) => r.row === 31)!.route_w).toBe(10000);
    expect(specs[1].patch!.rows!.find((r) => r.row === 3)!.cost_x).toBe(1.1);
  });

  it('runs the 14 solves in order, shows progress, and ranks rows by max |Δ$|', async () => {
    let seen: number[] = [];
    let specsSeen = 0;
    const big = new Map<number, number>();
    const { el, click } = setup((ctx: RouteTabContext) => {
      ctx.runSolves = (specs, onEach) => {
        specsSeen = specs.length;
        const done = (async () => {
          for (let i = 0; i < specs.length; i++) {
            await Promise.resolve();
            seen.push(i);
            const d = big.get(i) ?? (i + 1) * 1e6;
            onEach(i, { ...RESULT, lengthMi: RESULT.lengthMi + 0.5, cost: { ...RESULT.cost, total2025: RESULT.cost.total2025 + d, totalNominal: RESULT.cost.totalNominal + d / 1.5 } });
          }
        })();
        return { cancel() {}, done };
      };
    });
    const rows = sensitivityRows(preset, null, RESULT);
    big.set(rows.indexOf(28) * 2, -500e6);   // row 28 at ×0.5 swings the most
    seen = [];
    click('.rm-sens-run');
    expect(el.querySelector('.rm-sens-count')!.textContent).toBe('0 / 14');
    await new Promise((r) => setTimeout(r, 0));
    expect(specsSeen).toBe(14);
    expect(seen).toEqual([...Array(14).keys()]);
    const items = [...el.querySelectorAll<HTMLElement>('.rm-tor-row')];
    expect(items).toHaveLength(7);
    expect(items[0].dataset.row).toBe('28');
    expect(items[0].textContent).toContain('premium ×0.5: −$500 M');
    const r9 = items.find((li) => li.dataset.row === '9')!;
    expect(r9.textContent).toContain('routing premium ×0.5:');
    expect(el.querySelector('.rm-sens-regional')!.textContent).toBe('Regional cost rows are tested on routing only.');
    const impacts = items.slice(1).map((li) => Number(li.dataset.row));
    expect(impacts.length).toBe(6);
    expect(el.querySelector('.rm-sens-run')!.textContent).toBe('Run again');
  });

  it('a run cut short by another solve shows as stopped, not complete', async () => {
    let each: ((i: number, r: RouteResult | null, reason?: string) => void) | null = null;
    let finish: () => void = () => {};
    const { el, click } = setup((ctx: RouteTabContext) => {
      ctx.runSolves = (_specs, onEach) => {
        each = onEach;
        return { cancel() {}, done: new Promise<void>((r) => { finish = r; }) };
      };
    });
    click('.rm-sens-run');
    each!(0, { ...RESULT, cost: { ...RESULT.cost, total2025: RESULT.cost.total2025 + 1e6 } });
    each!(1, null, 'cancelled');
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.rm-sens-note')!.textContent).toBe('Stopped — another solve started (1 of 14 solves done)');
    expect(el.querySelector('.rm-sens-run')!.textContent).toBe('Run again');
    expect(el.querySelector('.rm-sens-cancel')).toBeNull();
  });

  it('Cancel stops the run and ignores late answers', async () => {
    let cancelled = 0;
    let push: ((i: number) => void) | null = null;
    const { el, click } = setup((ctx: RouteTabContext) => {
      ctx.runSolves = (_specs, onEach) => {
        push = (i) => onEach(i, { ...RESULT, cost: { ...RESULT.cost, total2025: RESULT.cost.total2025 + 1e6 } });
        return { cancel() { cancelled++; }, done: new Promise(() => {}) };
      };
    });
    click('.rm-sens-run');
    push!(0); push!(1); push!(2);
    expect(el.querySelector('.rm-sens-count')!.textContent).toBe('3 / 14');
    click('.rm-sens-cancel');
    expect(cancelled).toBe(1);
    push!(3);
    expect(el.querySelector('.rm-sens-note')!.textContent).toBe('Cancelled after 3 of 14 solves');
    expect(el.querySelectorAll('.rm-tor-row').length).toBeGreaterThan(0);
  });
});

describe('grid or stacked table', () => {
  afterEach(() => { tab.dispose?.(); resetDrawerEnv(); });
  const gap1 = preset.rows.findIndex((r) => r.note === 'GAP 1');

  it('a phone width gets the stacked weights table, no grid', () => {
    installDrawerEnv({ compact: true });
    const { el } = setup();
    expect(el.querySelector('.wt-table')).not.toBeNull();
    expect(el.querySelector('.rm-grid')).toBeNull();
  });

  it('a wide screen gets the grid, and a grid Excl. tick lands in session.inputs.patch', async () => {
    installDrawerEnv();
    const { el, session } = setup();
    expect(el.querySelector('.wt-table')).toBeNull();
    const q = el.querySelector<HTMLInputElement>('.rm-mg-q')!;
    q.value = 'GAP 1';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(el.querySelector(`.tabulator-row[data-key="r:${gap1}"]`)).not.toBeNull());
    el.querySelector<HTMLInputElement>(`.tabulator-row[data-key="r:${gap1}"] .tabulator-cell[tabulator-field="f0"] input`)!.click();
    expect(session.inputs.patch).toEqual({ rows: [{ row: gap1, band: 'protect', note: 'GAP 1', route_w: 1000 }] });
  });

  it('crossing 520 px re-renders the other editor', () => {
    installDrawerEnv();
    let fire: (() => void) | null = null;
    let matches = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return matches; }, media: query,
      addEventListener: (_: string, f: () => void) => { fire = f; }, removeEventListener() {},
    }));
    const { el } = setup();
    expect(el.querySelector('.rm-grid')).not.toBeNull();
    matches = true;
    fire!();
    expect(el.querySelector('.rm-grid')).toBeNull();
    expect(el.querySelector('.wt-table')).not.toBeNull();
    matches = false;
    fire!();
    expect(el.querySelector('.rm-grid')).not.toBeNull();
    expect(el.querySelector('.wt-table')).toBeNull();
  });

  it('update() after a re-solve keeps the same grid', () => {
    installDrawerEnv();
    const { el, ctx } = setup();
    const grid = el.querySelector('.rm-grid');
    tab.update!(el, ctx);
    expect(el.querySelector('.rm-grid')).toBe(grid);
  });
});

// ─── uploaded layers ───────────────────────────────────────────────────

describe('Uploaded layers section', () => {
  const [lng, lat] = lngLatOf(GRID_250, 9000, 6000);
  const geojson = (d: number) => JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] } });
  const fileOf = (text: string, name = 'My corridor.geojson') => {
    const bytes = new TextEncoder().encode(text);
    return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer } as unknown as File;
  };
  const hashOf = async (d: number) => { const r = await validateUpload(geojson(d)); if (!r.ok) throw new Error(r.reason); return r.result.hash; };

  function mount(saved?: unknown) {
    let presetId = 'tm-default';
    if (saved) {
      const r = createCustomPresetStore(localStorage).save('Saved', 'tm-default', saved);
      if (!r.ok) throw new Error(r.reason);
      presetId = `custom:${r.result.id}`;
    }
    const session = FIXTURE_SESSION();
    session.result = RESULT;
    session.tab = 'method';
    session.inputs.presetId = presetId;
    const ctx = fakeTabContext(session);
    const el = document.createElement('div');
    document.body.append(el);
    tab.render(el, ctx);
    return { session, ctx, el };
  }
  /** Choose `file` in the file input the section just opened. */
  async function choose(file: File) {
    const input = document.body.querySelector<HTMLInputElement>('input.rm-upl-file')!;
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
  }
  const rowEl = (el: HTMLElement) => el.querySelector<HTMLElement>('.rm-upl-row')!;
  const setNum = (el: HTMLElement, label: number, v: string) => {
    const i = el.querySelectorAll<HTMLInputElement>('.rm-upl-field input[type=number]')[label];
    i.value = v;
    i.dispatchEvent(new Event('change'));
  };
  const saveAs = (el: HTMLElement, name: string) => {
    el.querySelector<HTMLButtonElement>('.rm-save')!.click();
    const form = el.querySelector<HTMLFormElement>('.rm-saveform')!;
    form.querySelector<HTMLInputElement>('.rm-name')!.value = name;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  };
  const storedItems = () => JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY)!).items as { name: string; patch: { add_rows?: { layer: string; route_w: number }[] } }[];

  beforeEach(() => { dropUploads(); vi.mocked(registerUpload).mockClear(); vi.mocked(unregisterUpload).mockClear(); });

  it('Add a layer row… validates the file, registers it and writes a whole add_rows entry (no geometry)', async () => {
    const { session, el } = mount();
    const h = await hashOf(0.05);
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    expect(vi.mocked(registerUpload)).toHaveBeenCalledWith(h, expect.any(Array));
    expect(uploads.has(h)).toBe(true);
    expect(session.inputs.patch).toEqual({ add_rows: [{ layer: h, label: 'My corridor', route_w: 2, cost_x: 1, barrier: false }] });
    expect(JSON.stringify(session.inputs.patch)).not.toMatch(/coordinates|geometry/);
    expect(rowEl(el).dataset.layer).toBe(h);
    expect(el.querySelector('.rm-upl-needs')).toBeNull();
    expect(el.querySelector('.rm-chip')!.textContent).toBe('1 edit');
  });

  it('a fifth and sixth layer are accepted (no count cap); one past the position total is refused with the locale text; the old cap key is gone from every locale', async () => {
    const { session, el } = mount();
    for (let i = 1; i <= 6; i++) {
      el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
      await choose(fileOf(geojson(0.01 * i), `Layer ${i}.geojson`));
    }
    expect(session.inputs.patch?.add_rows).toHaveLength(6);
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe('');
    const big = { hash: 'f'.repeat(16), geometry: [[new Array(UPLOAD_TOTAL_VERTICES).fill([0, 0])]] } as unknown as UploadLayer;
    uploads.set(big.hash, big);
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.5), 'Seventh.geojson'));
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe(`Uploaded layers in this tab are limited to ${UPLOAD_TOTAL_VERTICES.toLocaleString('en')} positions in all; remove one first.`);
    expect(session.inputs.patch?.add_rows).toHaveLength(6);
    uploads.delete(big.hash);
    const dir = 'src/i18n/route/';
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(dir + f, 'utf8');
      expect(text, f).not.toContain('route.meth.upl.max');
      expect(text, f).toMatch(/["']route\.meth\.upl\.total["']/);
    }
  });

  it('a bad file says why and registers nothing; the same file twice is refused', async () => {
    const { session, el } = mount();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf('{"type":"Point","coordinates":[0,0]}'));
    expect(el.querySelector('.rm-upl-msg')!.textContent).toMatch(/Polygon/);
    expect(vi.mocked(registerUpload)).not.toHaveBeenCalled();
    expect(session.inputs.patch).toBeNull();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe('That layer is already a row of this method.');
    expect(session.inputs.patch!.add_rows).toHaveLength(1);
  });

  it('row controls edit weight, cost ×, barrier and label; an out-of-range value shows the validator reason and is not applied', async () => {
    const { session, el } = mount();
    const h = await hashOf(0.05);
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    setNum(el, 0, '8');
    const box = rowEl(el).querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(session.inputs.patch!.add_rows).toEqual([{ layer: h, label: 'My corridor', route_w: 8, cost_x: 1, barrier: true }]);
    setNum(el, 1, '1e9');
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe('Cost × must be a number from 0.1 to 100.');
    expect(session.inputs.patch!.add_rows![0].cost_x).toBe(1);
  });

  it('removing a session row unregisters it and drops add_rows', async () => {
    const { session, el } = mount();
    const h = await hashOf(0.05);
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    el.querySelector<HTMLButtonElement>('.rm-upl-remove')!.click();
    expect(vi.mocked(unregisterUpload)).toHaveBeenCalledWith(h);
    expect(uploads.size).toBe(0);
    expect(session.inputs.patch).toBeNull();
    expect(el.querySelector('.rm-upl-row')).toBeNull();
  });

  it('saving after adding stores hash, label and weights only', async () => {
    const { el } = mount();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    saveAs(el, 'With layer');
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY)!;
    expect(storedItems()[0].patch.add_rows).toHaveLength(1);
    expect(raw).not.toMatch(/geometry|coordinates/);
    expect(raw).not.toMatch(/\[\s*-?\d+(\.\d+)?\s*,\s*-?\d/);
  });

  it('a saved method whose layer is not loaded says needs its file; Open the file… takes only the same layer', async () => {
    const h = await hashOf(0.05);
    const { session, el } = mount({ add_rows: [{ layer: h, label: 'Saved layer', route_w: 3, cost_x: 1 }] });
    expect(el.querySelector('.rm-upl-needs')).not.toBeNull();
    expect(uploads.has(h)).toBe(false);
    el.querySelector<HTMLButtonElement>('.rm-upl-open')!.click();
    await choose(fileOf(geojson(0.07)));                       // another layer
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe('That file is not the layer this method was saved with.');
    expect(vi.mocked(registerUpload)).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.rm-upl-open')!.click();
    await choose(fileOf(geojson(0.05)));
    expect(vi.mocked(registerUpload)).toHaveBeenCalledWith(h, expect.any(Array));
    expect(el.querySelector('.rm-upl-needs')).toBeNull();
    expect(session.inputs.patch).toBeNull();                   // opening the file is not an edit
  });

  it('a waiting file past the position total is refused on both load paths (Open the file…, Add a layer row…)', async () => {
    const h = await hashOf(0.05);
    const { el } = mount({ add_rows: [{ layer: h, label: 'Saved layer', route_w: 3, cost_x: 1 }] });
    const big = { hash: 'f'.repeat(16), geometry: [[new Array(UPLOAD_TOTAL_VERTICES).fill([0, 0])]] } as unknown as UploadLayer;
    uploads.set(big.hash, big);
    for (const btn of ['.rm-upl-open', '.rm-upl-add']) {
      el.querySelector<HTMLButtonElement>(btn)!.click();
      await choose(fileOf(geojson(0.05)));
      expect(el.querySelector('.rm-upl-msg')!.textContent, btn).toBe(`Uploaded layers in this tab are limited to ${UPLOAD_TOTAL_VERTICES.toLocaleString('en')} positions in all; remove one first.`);
      expect(uploads.has(h), btn).toBe(false);
      expect(vi.mocked(registerUpload), btn).not.toHaveBeenCalled();
      expect(el.querySelector('.rm-upl-needs'), btn).not.toBeNull();
    }
  });

  it('Add a layer row… with the file a saved row is waiting for loads it for that row, not "already a row"', async () => {
    const h = await hashOf(0.05);
    const { session, el } = mount({ add_rows: [{ layer: h, label: 'Saved layer', route_w: 3, cost_x: 1 }] });
    expect(el.querySelector('.rm-upl-needs')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    expect(vi.mocked(registerUpload)).toHaveBeenCalledWith(h, expect.any(Array));
    expect(uploads.has(h)).toBe(true);
    expect(el.querySelector('.rm-upl-needs')).toBeNull();
    expect(el.querySelector('.rm-upl-msg')!.textContent).toBe('');
    expect(session.inputs.patch).toBeNull();
  });

  it('open a saved method with an upload row, change its route_w, save: the stored add_rows has the new route_w', async () => {
    const h = await hashOf(0.05);
    const { session, el } = mount({ add_rows: [{ layer: h, label: 'Saved layer', route_w: 3, cost_x: 1 }] });
    setNum(el, 0, '6');
    expect(session.inputs.patch).toEqual({ add_rows: [{ layer: h, label: 'Saved layer', route_w: 6, cost_x: 1, barrier: false }] });
    saveAs(el, 'Edited');
    const items = storedItems();
    expect(items.find((i) => i.name === 'Edited')!.patch.add_rows).toEqual([{ layer: h, label: 'Saved layer', route_w: 6, cost_x: 1, barrier: false }]);
    expect(items.find((i) => i.name === 'Saved')!.patch.add_rows![0].route_w).toBe(3);   // the saved one is untouched
  });

  it('remove a saved method\'s upload row (a remove entry), save: the stored add_rows lacks that hash', async () => {
    const h = await hashOf(0.05), h2 = await hashOf(0.07);
    const { session, el } = mount({ add_rows: [{ layer: h, label: 'One', route_w: 3, cost_x: 1 }, { layer: h2, label: 'Two', route_w: 4, cost_x: 1 }] });
    el.querySelector<HTMLButtonElement>('.rm-upl-remove')!.click();
    expect(session.inputs.patch).toEqual({ add_rows: [{ layer: h, remove: true }] });
    expect(el.querySelectorAll('.rm-upl-row')).toHaveLength(1);
    saveAs(el, 'Without one');
    const rows = storedItems().find((i) => i.name === 'Without one')!.patch.add_rows!;
    expect(rows.map((r) => r.layer)).toEqual([h2]);
    expect(JSON.stringify(rows)).not.toContain('remove');
  });

  it('the Add button stays on at four layers; Reset drops the session entries and their layers', async () => {
    const hs = ['a', 'b', 'c', 'd'].map((c) => c.repeat(16));
    const { session, el } = mount({ add_rows: hs.map((layer, i) => ({ layer, label: `L${i}`, route_w: 3, cost_x: 1 })) });
    expect(el.querySelector<HTMLButtonElement>('.rm-upl-add')!.disabled).toBe(false);
    el.querySelector<HTMLButtonElement>('.rm-upl-remove')!.click();
    expect(el.querySelector<HTMLButtonElement>('.rm-upl-add')!.disabled).toBe(false);
    el.querySelector<HTMLButtonElement>('.rm-reset')!.click();
    expect(session.inputs.patch).toBeNull();
    expect(el.querySelectorAll('.rm-upl-row')).toHaveLength(4);
  });

  it('a grid edit keeps the session\'s add_rows; sensitivity ignores upload rows and a remove entry', async () => {
    const h = await hashOf(0.05);
    const { session, el } = mount();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    const i = el.querySelector<HTMLInputElement>('input[data-row="9"][data-field="cost_x"]')!;
    i.value = '2';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    expect(session.inputs.patch!.add_rows![0].layer).toBe(h);
    expect(session.inputs.patch!.rows).toHaveLength(1);
    const withUpload = { ...RESULT, cost: { ...RESULT.cost, perRow: [...RESULT.cost.perRow, { row: preset.rows.length, usd: 9e9, affectedM: 1e6 }] } };
    expect(sensitivityRows(preset, session.inputs.patch, withUpload)).not.toContain(preset.rows.length);
    const gone = { add_rows: [{ layer: h, remove: true as const }] };
    expect(sensitivitySpecs(preset, gone, [9]).specs.length).toBe(2);
  });

  it('dropUploads (the pane closing) unregisters every layer', async () => {
    const { el } = mount();
    el.querySelector<HTMLButtonElement>('.rm-upl-add')!.click();
    await choose(fileOf(geojson(0.05)));
    dropUploads();
    expect(vi.mocked(unregisterUpload)).toHaveBeenCalledWith(await hashOf(0.05));
    expect(uploads.size).toBe(0);
  });
});

describe('upload and patch validator reasons are worded', () => {
  const cases: [string, string][] = [
    ['uploaded layer: the file is not UTF-8 text', 'The file is not UTF-8 text.'],
    ['uploaded layer: the file is not GeoJSON (JSON did not parse)', 'The file is not GeoJSON (it did not parse).'],
    ['uploaded layer: the file is not a GeoJSON object', 'The file is not a GeoJSON object.'],
    ['uploaded layer: the FeatureCollection has no features', 'The FeatureCollection has no features.'],
    ['uploaded layer: a FeatureCollection member is not a Feature', 'A FeatureCollection member is not a Feature.'],
    ['uploaded layer: the file has no polygons', 'The file has no polygons.'],
    ['uploaded layer: more than 1000 polygon parts', 'More than 1000 polygon parts.'],
    ['uploaded layer: a polygon has no rings', 'A polygon has no rings.'],
    ['uploaded layer: a ring has fewer than 4 positions', 'A ring has fewer than 4 positions.'],
    ['uploaded layer: more than 500000 positions', 'More than 500000 positions.'],
    ['uploaded layer: a position is not [lng, lat]', 'A position is not [lng, lat].'],
    ['uploaded layer: a position is not two finite numbers', 'A position is not two finite numbers.'],
    ['uploaded layer: a position is outside lng −180…180, lat −90…90', 'A position is outside longitude −180…180, latitude −90…90.'],
    ['uploaded layer: a ring is not closed (first and last positions differ)', 'A ring is not closed (first and last positions differ).'],
    ['uploaded layer: the polygons lie outside the routing grid', 'The polygons lie outside the routing grid.'],
    ['uploaded layer: the file is over 10 MiB', 'The file is over 10 MiB.'],
    ['presetPatch.add_rows[0].label must be 1–60 characters', 'The layer name must be 1–60 characters.'],
    ['presetPatch.add_rows[0].route_w must be a number in [0.1, 1000]', 'Routing weight must be a number from 0.1 to 1000.'],
    ['presetPatch.add_rows[0].cost_x must be a number in [0.5, 5]', 'Cost × must be a number from 0.5 to 5.'],
  ];
  it.each(cases)('%s', (reason, key) => { expect(uploadReason(reason)).toBe(key); });
  it('text that matches none passes through', () => { expect(uploadReason('something else')).toBe('something else'); });
});
