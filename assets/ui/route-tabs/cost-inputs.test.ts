// @vitest-environment jsdom
// ─── Method tab "Your own costs" card tests ──────────────────────────────────
// Role: the pure half turns a form into a session patch (figures ×1e6, another line type's figures kept, saved
//       method's cost inputs replaced whole) and never lets a refused patch out; the card's inputs stay off until a
//       basis is chosen, write only validated patches, keep a refused figure on screen with its reason, offer
//       Line position only where the patched method prices one, and say why all-in refuses multiplier edits.
// Deps: ./cost-inputs.ts, ./fixture.ts, route/preset-patch.ts, registry/route-presets.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { getLocale: () => 'en', t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import { applyForm, effectiveInputs, endOptions, markupNote, mountCostInputs, readForm, refusalText, type CiForm } from './cost-inputs.js';
import { FIXTURE_SESSION } from './fixture.js';
import { validatePresetPatch, USER_COST_SRC, type PresetPatch } from '../../route/preset-patch.js';
import { routePreset } from '../../../src/registry/route-presets.js';

const tm = routePreset('tm-default')!;
const pnas = routePreset('pnas-wu2023')!;
const blank = (o: Partial<CiForm> = {}): CiForm => ({ basis: 'bare', year: '2025', line: '', station: '', position: '', ends: ['auto', 'auto'], ...o });

describe('applyForm', () => {
  it('stores $ million as dollars, with the year and basis', () => {
    const r = applyForm(tm, null, null, 'ac345', blank({ line: '3.2', station: '25.5', position: '7.25' }));
    expect(r.ok && r.patch).toEqual({ cost_inputs: { basis: 'bare', year: 2025, line_types: { ac345: { usd_per_mi: 3_200_000, station_usd: 25_500_000, position_usd: 7_250_000 } } } });
    // the validated preset carries them as user-entered figures
    expect(r.ok && r.preset.line_types.ac345.base_per_mi).toEqual({ usd: 3_200_000, year: 2025, src: USER_COST_SRC });
    expect(r.ok && r.preset.user_costs).toMatchObject({ basis: 'bare', year: 2025, items: ['line', 'station', 'position'], line_types: ['ac345'] });
  });

  it('keeps another line type\'s figures and removes this one\'s when its fields are emptied', () => {
    const first = applyForm(tm, null, null, 'ac345', blank({ line: '3' }));
    if (!first.ok) throw new Error(first.reason);
    const both = applyForm(tm, null, first.patch, 'ac500', blank({ line: '4' }));
    expect(both.ok && both.patch?.cost_inputs?.line_types).toEqual({ ac345: { usd_per_mi: 3e6 }, ac500: { usd_per_mi: 4e6 } });
    if (!both.ok) throw new Error(both.reason);
    const emptied = applyForm(tm, null, both.patch, 'ac345', blank());
    expect(emptied.ok && emptied.patch?.cost_inputs?.line_types).toEqual({ ac500: { usd_per_mi: 4e6 } });
  });

  it('drops cost_inputs when nothing is entered and both ends are auto; an end choice alone keeps a figure-less object', () => {
    const none = applyForm(tm, null, null, 'ac345', blank());
    expect(none.ok && none.patch).toBeNull();
    const ends = applyForm(tm, null, null, 'ac345', blank({ ends: ['none', 'new'] }));
    expect(ends.ok && ends.patch).toEqual({ cost_inputs: { basis: 'bare', year: 2025, ends: ['none', 'new'] } });
  });

  it('a session object replaces the saved method\'s whole, and clearing it writes a plain object so the saved one does not return', () => {
    const stored: PresetPatch = { cost_inputs: { basis: 'bare', year: 2020, line_types: { ac345: { usd_per_mi: 2e6 } } } };
    expect(readForm(effectiveInputs(stored, null), 'ac345', tm)).toMatchObject({ basis: 'bare', year: '2020', line: '2' });
    const r = applyForm(tm, stored, null, 'ac345', blank({ basis: 'bare', year: '2020' }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.patch).toEqual({ cost_inputs: { basis: 'bare', year: 2020 } });
    expect(r.preset.user_costs?.items).toEqual([]);
    expect(effectiveInputs(stored, r.patch)).toEqual({ basis: 'bare', year: 2020 });
  });

  it('refuses through validatePresetPatch: a bad figure, a bad year, an unknown line type', () => {
    expect(applyForm(tm, null, null, 'ac345', blank({ line: 'abc' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/usd_per_mi must be a number/) });
    expect(applyForm(tm, null, null, 'ac345', blank({ line: '-1' })).ok).toBe(false);
    expect(applyForm(tm, null, null, 'ac345', blank({ line: '1e6' })).ok).toBe(false);          // 1e12 $/mi
    expect(applyForm(tm, null, null, 'ac345', blank({ station: '20000' })).ok).toBe(false);     // 2e10 $
    expect(applyForm(tm, null, null, 'ac345', blank({ line: '3', year: '1980' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/year/) });
    expect(applyForm(tm, null, null, 'ac345', blank({ line: '3', year: '2.5' })).ok).toBe(false);
    expect(applyForm(tm, null, null, 'nope', blank({ line: '3' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no line type/) });
  });

  it('all-in needs a $/mi and refuses next to multiplier, combine, contingency and short-line edits', () => {
    expect(applyForm(tm, null, null, 'ac345', blank({ basis: 'all-in', station: '20' })).ok).toBe(false);
    const ok = applyForm(tm, null, null, 'ac345', blank({ basis: 'all-in', line: '5' }));
    expect(ok.ok && ok.preset.markups).toEqual([]);
    for (const edit of [
      { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] },
      { contingency: 0.2 }, { combine: { terrain: 'max' } }, { length_factor: false },
    ] as PresetPatch[]) {
      const r = applyForm(tm, null, edit, 'ac345', blank({ basis: 'all-in', line: '5' }));
      expect(r.ok, JSON.stringify(edit)).toBe(false);
      if (!r.ok) expect(refusalText(r.reason)).toMatch(/^All-in takes no cost multiplier/);
    }
    // a routing-weight edit has no cost effect and stays allowed
    const w = applyForm(tm, null, { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', route_w: 3 }] }, 'ac345', blank({ basis: 'all-in', line: '5' }));
    expect(w.ok).toBe(true);
  });

  it('every accepted patch is what validatePresetPatch accepts (nothing the card writes can reach a solve refused)', () => {
    for (const f of [blank({ line: '3' }), blank({ basis: 'all-in', line: '5', station: '30', position: '8' }), blank({ ends: ['position', 'none'] })]) {
      const r = applyForm(tm, null, null, 'ac345', f);
      if (r.ok) expect(validatePresetPatch(tm, r.patch ?? undefined).ok).toBe(true);
    }
  });
});

describe('endOptions and the markup note', () => {
  const dis = (p: typeof tm, lt: string) => Object.fromEntries(endOptions(p, lt).map((o) => [o.choice, o.disabled]));
  it('Line position is offered where the patched method prices one', () => {
    expect(dis(tm, 'ac345').position).toBe(false);
    expect(dis(tm, 'dc500').position).toBe(true);
    expect(dis(pnas, 'ac500').position).toBe(true);
    const entered = applyForm(pnas, null, null, 'ac500', blank({ position: '9' }));
    expect(entered.ok && dis(entered.preset, 'ac500').position).toBe(false);
  });
  it('a study method\'s new end reads as the method prices it', () => {
    expect(endOptions(tm, 'ac345')[1].labelKey).toBe('route.ci.end.new');
    expect(endOptions(pnas, 'ac500')[1].labelKey).toBe('route.ci.end.newStudy');
  });
  it('says per method whether the terminal figures carry the markup', () => {
    for (const id of ['tm-default', 'straight-line-quick']) expect(markupNote(routePreset(id)!, 'ac345').key).toBe('route.ci.note.markupsIn');
    expect(markupNote(routePreset('bv-2014')!, Object.keys(routePreset('bv-2014')!.line_types)[0]).key).toBe('route.ci.note.markupsInStation');
    for (const id of ['pnas-wu2023', 'nrel-revx', 'westtec-es']) {
      const p = routePreset(id)!;
      expect(markupNote(p, Object.keys(p.line_types)[0]).key).toBe('route.ci.note.noMarkups');
    }
  });
  it('maps the refusals a visitor can cause to words', () => {
    const word = (r: ReturnType<typeof applyForm>) => (r.ok ? '' : refusalText(r.reason));
    expect(word(applyForm(tm, null, null, 'ac345', blank({ line: '3', year: '1980' })))).toMatch(/1990/);
    expect(word(applyForm(tm, null, null, 'ac345', blank({ line: 'abc' })))).not.toMatch(/usd_per_mi/);
    expect(word(applyForm(tm, null, null, 'ac345', blank({ basis: 'all-in', station: '20' })))).not.toMatch(/usd_per_mi/);
    expect(refusalText('something unforeseen')).toBe('something unforeseen');
  });
});

describe('the card', () => {
  beforeEach(() => { document.body.replaceChildren(); });
  function mount(presetId = 'tm-default', lineType = 'ac345', patch: PresetPatch | null = null, stored: PresetPatch | null = null) {
    const session = FIXTURE_SESSION();
    session.inputs = { ...session.inputs, presetId, lineType, patch };
    const onPatch = vi.fn();
    const card = mountCostInputs({ session, base: routePreset(presetId === 'custom' ? 'tm-default' : presetId)!, stored, onPatch });
    document.body.append(card.el);
    const q = <T extends HTMLElement>(sel: string) => card.el.querySelector<T>(sel)!;
    const fields = [...card.el.querySelectorAll<HTMLInputElement>('.rm-ci-figs input')];
    const [year, line, station, position] = fields;
    const selects = [...card.el.querySelectorAll<HTMLSelectElement>('select')];
    const type = (i: HTMLInputElement, v: string) => { i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); };
    const basis = (v: string) => { const r = card.el.querySelector<HTMLInputElement>(`input[type=radio][value="${v}"]`)!; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); };
    return { session, card, q, year, line, station, position, selects, type, basis, onPatch };
  }

  it('the figures stay off until a basis is chosen, and the hint says so', () => {
    const m = mount();
    expect([m.year, m.line, m.station, m.position].every((i) => i.disabled)).toBe(true);
    expect(m.q('.rm-ci-need').hidden).toBe(false);
    m.basis('bare');
    expect([m.year, m.line, m.station, m.position].some((i) => i.disabled)).toBe(false);
    expect(m.q('.rm-ci-need').hidden).toBe(true);
    expect(m.session.inputs.patch).toBeNull();
  });

  it('a figure becomes a validated patch on the session and goes to onPatch', () => {
    const m = mount();
    m.basis('bare');
    m.type(m.line, '3.2');
    expect(m.session.inputs.patch).toEqual({ cost_inputs: { basis: 'bare', year: 2025, line_types: { ac345: { usd_per_mi: 3_200_000 } } } });
    expect(m.onPatch).toHaveBeenLastCalledWith(m.session.inputs.patch);
    expect(m.q('.rm-ci-msg').textContent).toBe('');
  });

  it('a refused figure never reaches the patch; its text and the reason stay', () => {
    const m = mount();
    m.basis('bare');
    m.type(m.line, '-4');
    expect(m.session.inputs.patch).toBeNull();
    expect(m.onPatch).not.toHaveBeenCalled();
    expect(m.line.value).toBe('-4');
    expect(m.q('.rm-ci-msg').textContent).toMatch(/^Enter each figure as a number of \$ million/);
    m.type(m.line, '4');
    expect(m.q('.rm-ci-msg').textContent).toBe('');
    expect(m.session.inputs.patch?.cost_inputs?.line_types?.ac345?.usd_per_mi).toBe(4e6);
  });

  it('all-in with multiplier edits is refused with the reason in words, and the basis goes back', () => {
    const edit: PresetPatch = { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] };
    const m = mount('tm-default', 'ac345', edit);
    m.basis('bare');
    m.type(m.line, '3');
    const before = JSON.stringify(m.session.inputs.patch);
    m.basis('all-in');
    expect(JSON.stringify(m.session.inputs.patch)).toBe(before);
    expect(m.q('.rm-ci-msg').textContent).toMatch(/^All-in takes no cost multiplier/);
    expect(m.card.el.querySelector<HTMLInputElement>('input[value="bare"]')!.checked).toBe(true);
    expect(m.card.el.querySelector<HTMLInputElement>('input[value="all-in"]')!.checked).toBe(false);
  });

  it('all-in on a clean method is accepted; the card warns when the line type has no cost per mile', () => {
    const m = mount();
    m.basis('all-in');
    expect(m.q('.rm-ci-warn').textContent).toMatch(/needs a cost per mile/);
    m.type(m.line, '5');
    expect(m.session.inputs.patch?.cost_inputs).toMatchObject({ basis: 'all-in', line_types: { ac345: { usd_per_mi: 5e6 } } });
    expect(m.q('.rm-ci-warn').textContent).toBe('');
  });

  it('warns when a stored position end has no figure on the line type shown', () => {
    const m = mount('tm-default', 'ac345');
    m.type(m.selects[0] as unknown as HTMLInputElement, 'position');
    expect(m.session.inputs.patch?.cost_inputs?.ends?.[0]).toBe('position');
    expect(m.card.el.textContent).not.toMatch(/has no line position figure/);
    const d = mount('tm-default', 'dc500', { cost_inputs: { basis: 'bare', year: 2025, ends: ['position', 'auto'] } });
    expect(d.card.el.textContent).toMatch(/has no line position figure/);
  });

  it('the end selects write ends; Line position is disabled where the method has no figure', () => {
    const m = mount('tm-default', 'dc500');
    const pos = (s: HTMLSelectElement) => [...s.options].find((o) => o.value === 'position')!;
    expect(pos(m.selects[0]).disabled).toBe(true);
    m.selects[1].value = 'none';
    m.selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(m.session.inputs.patch).toEqual({ cost_inputs: { basis: 'bare', year: 2025, ends: ['auto', 'none'] } });
    const tmc = mount('tm-default', 'ac345');
    expect([...tmc.selects[0].options].find((o) => o.value === 'position')!.disabled).toBe(false);
  });

  it('a study method labels its new end as the method prices it and states the markup fact', () => {
    const m = mount('pnas-wu2023', 'ac500');
    expect([...m.selects[0].options].map((o) => o.textContent)).toContain('Terminal as the method prices it');
    expect(m.q('.rm-ci-note').textContent).toMatch(/adds no markup to this method's terminal figures/);
    const d = mount('tm-default', 'ac345');
    expect(d.q('.rm-ci-note').textContent).toMatch(/already include its 17\.5 % AFUDC/);
  });

  it('refresh re-reads the form from the session patch (Reset)', () => {
    const m = mount();
    m.basis('bare');
    m.type(m.line, '3');
    m.session.inputs.patch = null;
    m.card.refresh();
    expect(m.line.value).toBe('');
    expect(m.line.disabled).toBe(true);
  });

  it('text from a figure goes in as text', () => {
    const m = mount();
    m.card.say('<img src=x onerror=alert(1)>');
    expect(m.card.el.querySelector('img')).toBeNull();
  });
});
