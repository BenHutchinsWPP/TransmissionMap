// ─── Route panel: Method tab's "Your own costs" card ─────────────────────────
// Role: the visitor's own cost figures for the line type shown (`cost_inputs` of the session patch): what the line
//       figure means (base cost per mile, or all-in; required, the figures stay inert until one is chosen), the
//       dollar year, line $M/mi, new station $M, line position $M (stored in dollars), and what each end is
//       (auto, new station, line position at an existing station, none). A figure of another line type is kept.
//       The pure half (`readForm`, `applyForm`, `endOptions`, `markupNote`, `refusalText`) turns the form into a session patch and
//       checks the merged result with validatePresetPatch before anything reaches the session; a refusal is shown
//       and the patch stays as it was. The DOM half (`mountCostInputs`) hands every accepted patch to `onPatch`.
//       The saved method's `cost_inputs` is the starting point; a session object replaces it whole. Text through
//       textContent only.
// Deps: route/preset-patch.ts (validatePresetPatch, CostInputs, EndChoice), ../route-request.ts (mergePatch),
//       registry/route-presets.ts (types), route-tabs/types.ts (types), utils/utils-dom.ts (h, ht), i18n (t).

import { getLocale, t } from '../../../src/i18n/index.js';
import type { RoutePreset } from '../../../src/registry/route-presets.js';
import { validatePresetPatch, type CostInputs, type EndChoice, type PresetPatch } from '../../route/preset-patch.js';
import { mergePatch } from '../route-request.js';
import { h, ht } from '../../utils/utils-dom.js';
import type { RouteSession } from './types.js';

export type Basis = 'bare' | 'all-in';

/** The note for `lineType` of `base`: whether the method's own terminal figures include a markup (`markup_in`, as a
 *  percentage in `params.pct`), and whether the line type has a line position figure to name. */
export function markupNote(base: RoutePreset, lineType: string): { key: string; params: { pct: string } } {
  const tm = base.line_types[lineType]?.terminals;
  const pct = (+(((tm?.markup_in ?? 1) - 1) * 100).toPrecision(12)).toLocaleString(getLocale());
  if (!tm?.markup_in) return { key: 'route.ci.note.noMarkups', params: { pct } };
  return { key: tm.position ? 'route.ci.note.markupsIn' : 'route.ci.note.markupsInStation', params: { pct } };
}

export interface CiForm {
  /** null until the visitor chooses; the figures are inert then. */
  basis: Basis | null;
  year: string;
  /** $ million per mile / per station / per position, as typed (empty = none). */
  line: string;
  station: string;
  position: string;
  ends: [EndChoice, EndChoice];
}

/** The cost inputs in play: the session's, else the saved method's. */
export const effectiveInputs = (stored: PresetPatch | null, session: PresetPatch | null): CostInputs | undefined =>
  session?.cost_inputs ?? stored?.cost_inputs;

const M = 1e6;
const inMillions = (usd: number | undefined): string => (usd === undefined ? '' : String(+(usd / M).toPrecision(12)));

/** The form for `lineType` from the cost inputs in play. */
export function readForm(ci: CostInputs | undefined, lineType: string, base: RoutePreset): CiForm {
  const e = ci?.line_types?.[lineType];
  const any = !!ci?.line_types && Object.keys(ci.line_types).length > 0;
  return {
    basis: any ? ci!.basis : null,
    year: String(ci?.year ?? base.escalation.to_year),
    line: inMillions(e?.usd_per_mi), station: inMillions(e?.station_usd), position: inMillions(e?.position_usd),
    ends: ci?.ends ?? ['auto', 'auto'],
  };
}

const money = (s: string): number | undefined => (s.trim() === '' ? undefined : Number((Number(s) * M).toPrecision(12)));

export type CiEdit = { ok: true; patch: PresetPatch | null; preset: RoutePreset } | { ok: false; reason: string };

/** The session patch after `form` for `lineType`, validated against the method's base over its saved patch.
 *  Another line type's figures stay. The patch drops `cost_inputs` when nothing is entered and both ends are auto,
 *  unless the saved method has some (then a plain object replaces them). */
export function applyForm(base: RoutePreset, stored: PresetPatch | null, session: PresetPatch | null, lineType: string, form: CiForm): CiEdit {
  const prev = effectiveInputs(stored, session);
  const lts: NonNullable<CostInputs['line_types']> = { ...(prev?.line_types ?? {}) };
  const entry: { usd_per_mi?: number; station_usd?: number; position_usd?: number } = {};
  const line = money(form.line), station = money(form.station), position = money(form.position);
  if (line !== undefined) entry.usd_per_mi = line;
  if (station !== undefined) entry.station_usd = station;
  if (position !== undefined) entry.position_usd = position;
  if (Object.keys(entry).length) lts[lineType] = entry; else delete lts[lineType];
  const figures = Object.keys(lts).length > 0;
  const year = Number(form.year);
  const bothAuto = form.ends[0] === 'auto' && form.ends[1] === 'auto';
  let ci: CostInputs | undefined;
  if (figures) ci = { basis: form.basis ?? prev?.basis ?? 'bare', year, line_types: lts, ...(bothAuto ? {} : { ends: form.ends }) };
  else if (!bothAuto || stored?.cost_inputs) ci = { basis: 'bare', year: Number.isInteger(year) ? year : base.escalation.to_year, ...(bothAuto ? {} : { ends: form.ends }) };
  const next: PresetPatch = { ...(session ?? {}) };
  if (ci) next.cost_inputs = ci; else delete next.cost_inputs;
  const patch = Object.keys(next).length ? next : null;
  const v = validatePresetPatch(base, mergePatch(stored, patch) ?? undefined);
  return v.ok ? { ok: true, patch, preset: v.result } : { ok: false, reason: v.reason };
}

/** The kinds the end selects offer for `lineType` on `effective` (the method with the patch applied). */
export function endOptions(effective: RoutePreset, lineType: string): { choice: EndChoice; labelKey: string; disabled: boolean }[] {
  const study = !!effective.study_terminals;
  const hasPosition = !!effective.line_types[lineType]?.terminals.position;
  return [
    { choice: 'auto', labelKey: 'route.ci.end.auto', disabled: false },
    { choice: 'new', labelKey: study ? 'route.ci.end.newStudy' : 'route.ci.end.new', disabled: false },
    { choice: 'position', labelKey: 'route.ci.end.position', disabled: !hasPosition },
    { choice: 'none', labelKey: 'route.ci.end.none', disabled: false },
  ];
}

/** True for the refusal of an all-in basis next to edits it has no use for. */
const isClash = (reason: string): boolean => /^all-in cost_inputs has no use for/.test(reason);
/** The refusal as the card shows it: the ones a visitor can cause in words, anything unforeseen as the validator gave it. */
export function refusalText(reason: string): string {
  if (isClash(reason)) return t('route.ci.clash');
  const year = /cost_inputs\.year must be an integer in \[(\d+), (\d+)\]/.exec(reason);
  if (year) return t('route.ci.err.year', { lo: year[1], hi: year[2] });
  if (/^all-in cost_inputs needs at least one line type/.test(reason)) return t('route.ci.allin.missing');
  const need = /^all-in cost_inputs\.line_types\.(.+) needs usd_per_mi/.exec(reason);
  if (need) return t('route.ci.err.allinLine', { name: need[1] });
  if (/\.(usd_per_mi|station_usd|position_usd) must be a number/.test(reason)) return t('route.ci.err.number');
  return reason;
}

export interface CostInputsOpts {
  session: RouteSession;
  /** The method's registry preset and its saved patch. */
  base: RoutePreset;
  stored: PresetPatch | null;
  /** Called with each accepted session patch (already set on `session.inputs.patch`). */
  onPatch(patch: PresetPatch | null): void;
}

export interface CostInputsCard {
  el: HTMLElement;
  /** Re-read the form from the session patch (after Reset). */
  refresh(): void;
  /** A refusal that came from outside the card (a table edit under all-in), shown in the card. */
  say(reason: string): void;
}

const radio = (name: string, value: string, labelKey: string, hintKey: string): { el: HTMLElement; input: HTMLInputElement } => {
  const lab = h('label', 'rm-ci-radio');
  const input = h('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  const text = h('span');
  text.append(ht('b', '', labelKey), document.createTextNode(' '), ht('span', 'rm-ci-hint', hintKey));
  lab.append(input, text);
  return { el: lab, input };
};

function field(labelKey: string): { el: HTMLLabelElement; input: HTMLInputElement } {
  const el = h('label', 'rm-ci-field');
  const input = h('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  el.append(ht('span', '', labelKey), input);
  return { el, input };
}

let seq = 0;

/** The card: build once, `refresh()` after an outside change. */
export function mountCostInputs(opts: CostInputsOpts): CostInputsCard {
  const { session: s, base, stored } = opts;
  const id = `rm-ci-${++seq}`;
  const root = h('section', 'rm-ci');
  root.append(ht('h4', 'rm-ci-h', 'route.ci.h'), ht('p', 'rm-ci-intro', 'route.ci.intro'));
  const bare = radio(`${id}-basis`, 'bare', 'route.ci.basis.bare', 'route.ci.basis.bare.hint');
  const allin = radio(`${id}-basis`, 'all-in', 'route.ci.basis.allin', 'route.ci.basis.allin.hint');
  const basisBox = h('div', 'rm-ci-basis');
  basisBox.setAttribute('role', 'radiogroup');
  basisBox.append(ht('p', 'rm-ci-need', 'route.ci.needBasis'), bare.el, allin.el);
  const year = field('route.ci.year'), line = field('route.ci.line'), station = field('route.ci.station'), position = field('route.ci.position');
  const figs = h('div', 'rm-ci-figs');
  figs.append(year.el, line.el, station.el, position.el);
  const lineName = h('p', 'rm-ci-line');
  const ends = h('div', 'rm-ci-ends');
  const selects: HTMLSelectElement[] = [];
  for (const k of ['route.ci.endA', 'route.ci.endB']) {
    const lab = h('label', 'rm-ci-field');
    const sel = h('select');
    selects.push(sel);
    lab.append(ht('span', '', k), sel);
    ends.append(lab);
  }
  const note = h('p', 'rm-ci-note');
  const missing = h('p', 'rm-ci-warn');
  const noPos = h('p', 'rm-ci-warn');
  const msg = h('p', 'rm-ci-msg');
  msg.setAttribute('role', 'alert');
  root.append(lineName, basisBox, figs, ht('h5', 'rm-ci-sub', 'route.ci.ends.h'), ends, note, missing, noPos, msg);

  let basis: Basis | null = null;
  let committed: Basis | null = null;   // the basis the session patch has
  const lineType = () => s.inputs.lineType;
  const effective = (): RoutePreset => {
    const v = validatePresetPatch(base, mergePatch(stored, s.inputs.patch) ?? undefined);
    return v.ok ? v.result : base;
  };

  const readDom = (): CiForm => ({
    basis, year: year.input.value, line: line.input.value, station: station.input.value, position: position.input.value,
    ends: [selects[0].value as EndChoice, selects[1].value as EndChoice],
  });

  function paint(form: CiForm): void {
    basis = committed = form.basis;
    bare.input.checked = basis === 'bare';
    allin.input.checked = basis === 'all-in';
    year.input.value = form.year;
    line.input.value = form.line;
    station.input.value = form.station;
    position.input.value = form.position;
    const on = basis !== null;
    for (const f of [year, line, station, position]) f.input.disabled = !on;
    basisBox.querySelector<HTMLElement>('.rm-ci-need')!.hidden = on;
    const eff = effective(), lt = lineType();
    lineName.textContent = t('route.ci.lineType', { name: eff.line_types[lt]?.label ?? lt });
    const opts = endOptions(eff, lt);
    selects.forEach((sel, i) => {
      sel.replaceChildren(...opts.map((o) => {
        const opt = h('option', '', t(o.labelKey));
        opt.value = o.choice;
        opt.disabled = o.disabled;
        if (o.disabled) opt.title = t('route.ci.position.na');
        return opt;
      }));
      sel.value = form.ends[i];
    });
    const mn = markupNote(base, lt);
    note.textContent = t(mn.key, mn.params);
    noPos.textContent = form.ends.includes('position') && !eff.line_types[lt]?.terminals.position ? t('route.ci.end.position.warn') : '';
    const ci = effectiveInputs(stored, s.inputs.patch);
    missing.textContent = basis === 'all-in' && !ci?.line_types?.[lt]?.usd_per_mi && !form.line.trim() ? t('route.ci.allin.missing') : '';
  }

  function commit(): void {
    const form = readDom();
    const r = applyForm(base, stored, s.inputs.patch, lineType(), form);
    if (!r.ok) {
      msg.textContent = refusalText(r.reason);
      basis = committed;
      bare.input.checked = basis === 'bare';
      allin.input.checked = basis === 'all-in';
      return;
    }
    msg.textContent = '';
    if (JSON.stringify(r.patch) !== JSON.stringify(s.inputs.patch)) {
      s.inputs.patch = r.patch;
      opts.onPatch(r.patch);
    }
    paint(form);
  }
  for (const r of [bare, allin]) r.input.addEventListener('change', () => { if (r.input.checked) { basis = r.input.value as Basis; commit(); } });
  for (const f of [year, line, station, position]) f.input.addEventListener('change', commit);
  for (const sel of selects) sel.addEventListener('change', commit);

  const refresh = (): void => { msg.textContent = ''; paint(readForm(effectiveInputs(stored, s.inputs.patch), lineType(), base)); };
  refresh();
  return { el: root, refresh, say: (reason) => { msg.textContent = refusalText(reason); } };
}
