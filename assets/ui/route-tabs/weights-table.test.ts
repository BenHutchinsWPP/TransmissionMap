// @vitest-environment jsdom
// ─── Route weights table tests ───────────────────────────────────────────────
// Role: an edit builds the PresetPatch (row index + band + note) and marks the cell with
//       "was"; an out-of-range value is an error (onChange errors = 1) placed in its cell;
//       except checkboxes and contingency; setPatch fills; readOnly; text is escaped.
//       English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./weights-table.ts, registry/route-presets.ts, route/preset-patch.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import { mountWeightsTable } from './weights-table.js';
import { routePreset, type RoutePreset } from '../../../src/registry/route-presets.js';
import { validatePresetPatch, type PresetPatch } from '../../route/preset-patch.js';

const preset = routePreset('tm-default')!;

function mount(opts: Partial<{ preset: RoutePreset; patch: PresetPatch | null; readOnly: boolean }> = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  const calls: [PresetPatch | null, number][] = [];
  const wt = mountWeightsTable(el, { preset: opts.preset ?? preset, patch: opts.patch ?? null, readOnly: opts.readOnly, onChange: (p, n) => calls.push([p, n]) });
  const input = (row: number, field: string) => el.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-field="${field}"]`)!;
  const type = (i: HTMLInputElement, v: string) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
  return { el, wt, calls, input, type };
}

describe('Excl. checkbox', () => {
  const gap1 = preset.rows.findIndex((r) => r.note === 'GAP 1');
  const mil = [preset.rows.findIndex((r) => r.note === 'military (PAD-US DOD)'), preset.rows.findIndex((r) => r.note === 'military (OSM landuse=military)')];
  const box = (el: HTMLElement, row: number) => el.querySelector<HTMLInputElement>(`input[data-excl][data-row="${row}"]`)!;

  it('ticking sets the routing weight to 1000 and the patch; unticking restores 100 and drops the entry', () => {
    const { el, input, calls } = mount();
    expect(box(el, gap1).checked).toBe(false);
    box(el, gap1).click();
    expect(input(gap1, 'route_w').value).toBe('1000');
    expect(calls.at(-1)).toEqual([{ rows: [{ row: gap1, band: 'protect', note: 'GAP 1', route_w: 1000 }] }, 0]);
    expect(box(el, gap1).checked).toBe(true);
    box(el, gap1).click();
    expect(input(gap1, 'route_w').value).toBe('100');
    expect(calls.at(-1)).toEqual([null, 0]);
  });

  it.each([['Wild & Scenic River corridor', 'desig'], ['NPS unit named Preserve (PAD-US Fee)', 'protect']])('%s has an unchecked box; a click sets 1000 and the patch', (note, band) => {
    const i = preset.rows.findIndex((r) => r.note === note);
    const { el, input, calls } = mount();
    expect(box(el, i).checked).toBe(false);
    box(el, i).click();
    expect(input(i, 'route_w').value).toBe('1000');
    expect(calls.at(-1)).toEqual([{ rows: [{ row: i, band, note, route_w: 1000 }] }, 0]);
  });

  it('the two military rows tick together', () => {
    const { el, input, calls } = mount();
    box(el, mil[0]).click();
    expect(input(mil[0], 'route_w').value).toBe('1000');
    expect(input(mil[1], 'route_w').value).toBe('1000');
    expect(box(el, mil[1]).checked).toBe(true);
    expect(calls.at(-1)![0]!.rows!.map((r) => [r.row, r.route_w])).toEqual([[mil[0], 1000], [mil[1], 1000]]);
  });
});

describe('linked Excl. boxes', () => {
  const mil = [preset.rows.findIndex((r) => r.note === 'military (PAD-US DOD)'), preset.rows.findIndex((r) => r.note === 'military (OSM landuse=military)')];
  it('typing 1000 in one linked row leaves the box unticked until the other row follows', () => {
    const { el, input, type } = mount();
    const box = (row: number) => el.querySelector<HTMLInputElement>(`input[data-excl][data-row="${row}"]`)!;
    type(input(mil[0], 'route_w'), '1000');
    expect(box(mil[0]).checked).toBe(false);
    expect(box(mil[1]).checked).toBe(false);
    type(input(mil[1], 'route_w'), '1000');
    expect(box(mil[0]).checked).toBe(true);
    expect(box(mil[1]).checked).toBe(true);
  });
});

describe('mountWeightsTable', () => {
  it('renders one line per row, with category and applies-to text', () => {
    const { el } = mount();
    expect(el.querySelectorAll('tr.wt-row')).toHaveLength(preset.rows.length);
    const r9 = el.querySelector('tr.wt-row[data-row="9"]')!;
    expect(r9.textContent).toContain('Slope');
    expect(r9.textContent).toContain('mountain, ≥ 4°');
    expect(r9.querySelector('.wt-group')!.textContent).toBe('Land cover & slope · highest wins');
    expect(el.querySelector('tr.wt-row[data-row="0"] .wt-scale')!.textContent).toBe('scale ×');
    expect(el.querySelector<HTMLInputElement>('.wt-cont input')!.value).toBe('30');
  });

  it('an edit builds the patch with index + band + note and marks the cell "was"', () => {
    const { el, calls, input, type } = mount();
    type(input(9, 'cost_x'), '2');
    const [patch, errors] = calls.at(-1)!;
    expect(errors).toBe(0);
    expect(patch).toEqual({ rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] });
    expect(validatePresetPatch(preset, patch).ok).toBe(true);
    const td = input(9, 'cost_x').closest('td')!;
    expect(td.classList.contains('wt-edited')).toBe(true);
    expect(td.querySelector('.wt-was')!.textContent).toBe('was TEPPC ×1.75 · SCE ×2 · MISO ×1.21 · Southeast ×1.6');
    expect(el.querySelector('tr.wt-sets-row[data-row="9"] .wt-sets')!.textContent).toBe('= TEPPC ×3.5 · SCE ×4 · MISO ×2.42 · Southeast ×3.2');
    expect(el.querySelector('tr.wt-row[data-row="9"]')!.classList.contains('wt-row--edited')).toBe(true);
    type(input(9, 'cost_x'), '1.0');
    expect(calls.at(-1)).toEqual([null, 0]);
    expect(td.classList.contains('wt-edited')).toBe(false);
  });

  it('a regional row: "scale ×" label, live per-set values, the crossed sets in bold', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const wt = mountWeightsTable(el, { preset, patch: null, onChange: () => {}, regionM: { TEPPC: 1000, MISO: 0 } });
    const inp = el.querySelector<HTMLInputElement>('input[data-row="0"][data-field="cost_x"]')!;
    expect(inp.getAttribute('aria-label')).toBe('Land cover — forest: scale on every regional cost set');
    const sets = el.querySelector('tr.wt-sets-row[data-row="0"] .wt-sets')!;
    expect(sets.closest('td')!.colSpan).toBe(5);
    expect(sets.textContent).toBe('= TEPPC ×2.25 · SCE ×3 · MISO ×1.2 · Southeast ×1.47');
    expect([...sets.querySelectorAll('strong')].map((b) => b.textContent)).toEqual(['TEPPC ×2.25']);
    inp.value = '1.5';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sets.textContent).toBe('= TEPPC ×3.375 · SCE ×4.5 · MISO ×1.8 · Southeast ×2.205');
    wt.setRegionM({ SCE: 500 });
    expect([...sets.querySelectorAll('strong')].map((b) => b.textContent)).toEqual(['SCE ×4.5']);
    expect(el.querySelector('tr.wt-sets-row[data-row="12"]')).toBeNull();
  });

  it('a regional scale that pushes a set past 100 is refused in its cell', () => {
    const { calls, input, type } = mount();
    type(input(0, 'cost_x'), '40');
    expect(calls.at(-1)).toEqual([expect.anything(), 1]);
    expect(input(0, 'cost_x').closest('td')!.querySelector('.wt-err')!.textContent).toMatch(/^row 0 cost_x scales every regional cost set: ×40 gives 48–120/);
  });

  it('an out-of-range value is one error, shown in its cell', () => {
    const { calls, input, type } = mount();
    type(input(34, 'route_w'), '-2');
    expect(calls.at(-1)![1]).toBe(1);
    const td = input(34, 'route_w').closest('td')!;
    expect(td.classList.contains('wt-bad')).toBe(true);
    expect(td.querySelector('.wt-err')!.textContent).toBe('Must be a number from 0.01 to 10000');
    expect(input(34, 'route_w').getAttribute('aria-invalid')).toBe('true');
    type(input(0, 'route_w'), 'abc');
    expect(calls.at(-1)![1]).toBe(2);
  });

  it('except checkboxes set patch.except to the full flag list', () => {
    const { el, calls } = mount();
    const boxes = el.querySelectorAll<HTMLInputElement>('tr.wt-except[data-row="24"] input[type=checkbox]');
    expect([...boxes].map((b) => b.checked)).toEqual([true, false, false]);
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
    const [patch, errors] = calls.at(-1)!;
    expect(errors).toBe(0);
    expect(patch!.rows).toEqual([{ row: 24, band: 'flags2', note: 'sage-grouse PHMA/IHMA', except: [true, true, false] }]);
    expect(validatePresetPatch(preset, patch).ok).toBe(true);
  });

  it('contingency % edits patch.contingency as a fraction; > 100 is an error', () => {
    const { el, calls, type } = mount();
    const c = el.querySelector<HTMLInputElement>('.wt-cont input')!;
    type(c, '20');
    expect(calls.at(-1)).toEqual([{ contingency: 0.2 }, 0]);
    type(c, '120');
    expect(calls.at(-1)![1]).toBe(1);
  });

  it('setPatch fills the inputs without calling onChange; null resets', () => {
    const { wt, calls, input } = mount();
    wt.setPatch({ rows: [{ row: 15, band: 'protect', note: 'GAP 2', route_w: 25 }] });
    expect(input(15, 'route_w').value).toBe('25');
    expect(input(15, 'route_w').closest('td')!.querySelector('.wt-was')!.textContent).toBe('was 10');
    expect(calls).toHaveLength(0);
    wt.setPatch(null);
    expect(input(15, 'route_w').value).toBe('10');
    expect(input(15, 'route_w').closest('td')!.classList.contains('wt-edited')).toBe(false);
  });

  it('readOnly disables every input', () => {
    const { el } = mount({ readOnly: true });
    expect([...el.querySelectorAll('input')].every((i) => (i as HTMLInputElement).disabled)).toBe(true);
  });

  it('a ramp row edits as "from, to"', () => {
    const ramp: RoutePreset = structuredClone(preset);
    ramp.rows[8].route_w = { ramp: [1, 2] };
    const { calls, input, type } = mount({ preset: ramp });
    expect(input(8, 'route_w').value).toBe('1, 2');
    type(input(8, 'route_w'), '1, 3');
    expect(calls.at(-1)![0]!.rows![0].route_w).toEqual([1, 3]);
    type(input(8, 'route_w'), '4');
    expect(calls.at(-1)![1]).toBe(1);
  });

  it('escapes preset text', () => {
    const evil: RoutePreset = structuredClone(preset);
    evil.rows[0].note = '<img src=x onerror=alert(1)>';
    evil.rows[0].src = '<b>src</b>';
    const { el } = mount({ preset: evil });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('tr.wt-row b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
