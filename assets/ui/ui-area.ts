// ─── Area picker: the AREA row's typeahead and the row notes (lazy chunk) ─────
// One search field over all seven area kinds (state, county, BA, NERC, utility,
// country, province). Results float from <body> (the 220 px panel clips
// anything wider), with kind pills to narrow them and a kind tag on each row;
// ↑↓ move, Enter picks, Alt+←→ changes the kind, Esc closes. A pick becomes a
// chip; another of the same kind adds to it, one of another kind replaces it
// and says so. Each chip added or removed and each Clear is one setArea() and
// one 'url:write' (one undo step), then syncPanel() repaints the chips, the
// row flags and the summary — this module never paints a value itself.
// Also owns the row-flag note (a button that shows why a layer is not
// filtered, on tap as well as by keyboard) and "Show", which opens the
// sections of the flagged rows and scrolls to the first.
// Labels come from area-labels.ts; until they load, or if they cannot, the
// field still takes codes (TX, 48201) checked by validateArea().
//   wireAreaPicker()   attach the field's handlers (once, on first use).
//   areaAction(el)     a click on a chip ×, Clear, Show or a row flag.
//   buildAreaIndex() / searchAreas() / codeHits()   the pure search.
// Loaded by ui.ts on the field's first focus or the row's first click, so the
// boot bundle carries only the static row markup (index.html).
// Deps: state.ts, state-bus.ts ('view:applied' clears the note), panel-mirror.ts
//       (commitArea, flagTitle), area-labels.ts, map-input.ts (onMapTap),
//       src/registry/area-filter.ts, src/registry/view-validate.ts (validateArea),
//       src/registry/condition-compile.ts (MAX_LIST_VALUES), src/i18n (t),
//       utils/utils.ts (escapeHtml).

import { state } from '../state.js';
import { commitArea, flagTitle } from './panel-mirror.js';
import { loadAreaLabels, areaLabel, type AreaLabels } from './area-labels.js';
import { onMapTap } from '../map-input.js';
import { on } from '../state-bus.js';
import { AREA_KINDS, type AreaFilter, type AreaKind } from '../../src/registry/area-filter.js';
import { validateArea } from '../../src/registry/view-validate.js';
import { MAX_LIST_VALUES } from '../../src/registry/condition-compile.js';
import type { LayerScope } from '../../src/types.js';
import { t } from '../../src/i18n/index.js';
import { escapeHtml } from '../utils/utils.js';

// ─── Search (pure) ───────────────────────────────────────────────────────────
export interface AreaHit {
  kind: AreaKind;
  code: string;
  label: string;
  dup: boolean;      // another code of this kind has the same label: show the code
}
interface Entry extends AreaHit { folded: string; codeFolded: string }

/** Case- and accent-insensitive form for matching ("Zürich" ↔ "zurich"). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The kinds in the order the pills and ties list them: US kinds first on the
 *  USA scope, world kinds first on Global. */
export const kindOrder = (scope: LayerScope): AreaKind[] =>
  scope === 'global' ? ['countries', 'admin1', ...AREA_KINDS.filter(k => k !== 'countries' && k !== 'admin1')] : [...AREA_KINDS];

export function buildAreaIndex(table: AreaLabels): Entry[] {
  const out: Entry[] = [];
  for (const kind of AREA_KINDS) {
    const rows = Object.keys(table[kind]).map(code => ({ code, label: areaLabel(table, kind, code) }));
    const count = new Map<string, number>();
    for (const r of rows) count.set(r.label, (count.get(r.label) ?? 0) + 1);
    for (const r of rows) {
      out.push({ kind, ...r, dup: count.get(r.label)! > 1, folded: fold(r.label), codeFolded: r.code.toLowerCase() });
    }
  }
  return out;
}

const RESULT_LIMIT = 40;

const hit = ({ kind, code, label, dup }: Entry): AreaHit => ({ kind, code, label, dup });

/** Entries matching `query`: an exact code or name first, then names that
 *  start with it, then a word that does, then any match; a county or utility
 *  in a state of `near` (the current area) ahead of the rest of its band; ties
 *  by kind order. An empty query with a kind chosen lists that kind by name. */
export function searchAreas(
  index: readonly Entry[], query: string, kind: AreaKind | null, order: AreaKind[], near: AreaFilter | null = null,
): AreaHit[] {
  const nearStates = near?.kind === 'states' ? near.codes : [];
  const isNear = (e: Entry) => nearStates.some(st => e.label.endsWith(`, ${st}`) || e.label.endsWith(`(${st})`));
  const q = fold(query.trim());
  if (!q) {
    return kind ? index.filter(e => e.kind === kind).sort((a, b) => a.label.localeCompare(b.label)).slice(0, RESULT_LIMIT).map(hit) : [];
  }
  const tokens = q.split(/\s+/);
  const scored: [number, number, Entry][] = [];
  for (const e of index) {
    if (kind && e.kind !== kind) continue;
    let rank: number;
    if (e.codeFolded === q || e.folded === q) rank = 0;
    else if (!tokens.every(tok => e.folded.includes(tok))) continue;
    else if (e.folded.startsWith(q)) rank = 1;
    else if (e.folded.split(/[^\p{L}\p{N}]+/u).some(w => w.startsWith(tokens[0]))) rank = 2;
    else rank = 3;
    scored.push([rank - (isNear(e) ? 0.5 : 0), order.indexOf(e.kind), e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].label.length - b[2].label.length || a[2].label.localeCompare(b[2].label));
  return scored.slice(0, RESULT_LIMIT).map(([, , e]) => hit(e));
}

/** Without labels: the query read as a code of each kind that accepts it. */
export function codeHits(query: string, kind: AreaKind | null, order: AreaKind[]): AreaHit[] {
  const code = query.trim().toUpperCase();
  if (!code || code === 'NONE') return [];
  return order
    .filter(k => (!kind || k === kind) && validateArea({ kind: k, codes: [code] }) === null)
    .map(k => ({ kind: k, code, label: code, dup: false }));
}

// ─── The field ───────────────────────────────────────────────────────────────
let index: Entry[] | null = null;
let labelStatus: 'loading' | 'ready' | 'offline' = 'loading';
let hits: AreaHit[] = [];
let active = 0;
let kindFilter: AreaKind | null = null;
let popup: HTMLElement | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const input = () => $<HTMLInputElement>('areaInput');

function requestLabels() {
  if (labelStatus === 'ready') return;
  labelStatus = 'loading';
  void loadAreaLabels().then(table => {
    index = table ? buildAreaIndex(table) : null;
    labelStatus = table ? 'ready' : 'offline';
    if (isOpen()) refresh();
  });
}

const isOpen = () => !!popup && !popup.hidden;

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement('div');
  popup.id = 'areaPopup';
  popup.className = 'dropdown area-popup';
  popup.hidden = true;
  // Keep focus in the field while a pill or an option is pressed.
  popup.addEventListener('mousedown', e => e.preventDefault());
  popup.addEventListener('click', e => {
    const el = e.target as Element;
    const pill = el.closest<HTMLElement>('[data-area-kind]');
    if (pill) { setKind((pill.dataset.areaKind || null) as AreaKind | null); return; }
    const opt = el.closest<HTMLElement>('[data-area-index]');
    if (opt) pick(hits[Number(opt.dataset.areaIndex)], false);
  });
  document.body.append(popup);
  return popup;
}

function place() {
  const box = $('areaBox');
  if (!popup || !box) return;
  const r = box.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 24);
  Object.assign(popup.style, {
    position: 'fixed',
    top: `${r.bottom + 4}px`,
    left: `${Math.max(12, Math.min(r.right, window.innerWidth - 12) - width)}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(160, window.innerHeight - r.bottom - 16)}px`,
  });
}

function setKind(kind: AreaKind | null) {
  kindFilter = kind;
  active = 0;
  refresh(true);
}

/** Recompute the hits for the field's text and redraw the list; opens it when
 *  there is text or a kind pill is on, closes it otherwise. */
function refresh(forceOpen = false) {
  const el = input();
  if (!el) return;
  const q = el.value;
  if (!q.trim() && !forceOpen && !kindFilter) { close(); return; }
  const order = kindOrder(state.regionScope);
  hits = index ? searchAreas(index, q, kindFilter, order, state.area) : codeHits(q, kindFilter, order);
  if (active >= hits.length) active = 0;
  render(order);
}

function render(order: AreaKind[]) {
  const p = ensurePopup();
  const el = input()!;
  const q = el.value.trim();
  const mark = (label: string) => {
    const i = q ? fold(label).indexOf(fold(q)) : -1;
    // fold() keeps the length of Latin text; elsewhere fall back to no mark.
    if (i < 0 || fold(label).length !== label.length) return escapeHtml(label);
    return `${escapeHtml(label.slice(0, i))}<mark>${escapeHtml(label.slice(i, i + q.length))}</mark>${escapeHtml(label.slice(i + q.length))}`;
  };
  const pills = [null, ...order].map(k =>
    `<button type="button" class="area-pill" data-area-kind="${k ?? ''}" aria-pressed="${kindFilter === k}" tabindex="-1">${escapeHtml(t(k ? `area.kind.${k}` : 'area.all'))}</button>`).join('');
  const options = hits.map((h, i) =>
    `<div class="area-option" role="option" id="areaOpt${i}" data-area-index="${i}" aria-selected="${i === active}">
      <span class="area-option-label">${mark(h.label)}${h.dup ? ` <span class="area-option-code">${escapeHtml(h.code)}</span>` : ''}</span>
      <span class="area-kind-tag">${escapeHtml(t(`area.kind.${h.kind}`))}</span>
    </div>`).join('');
  const status = labelStatus === 'loading' ? t('area.loading') : labelStatus === 'offline' ? t('area.offline') : '';
  const empty = !hits.length && q ? `<div class="area-empty">${escapeHtml(t('area.noResults'))}</div>` : '';
  const cur = state.area;
  const replaces = cur && hits[active] && hits[active].kind !== cur.kind
    ? `<div class="area-replaces">${escapeHtml(t('area.replaces', { current: areaSummary(cur) }))}</div>` : '';
  p.innerHTML = `
    <div class="area-pills" role="group" aria-label="${escapeHtml(t('area.kindsAria'))}">${pills}</div>
    ${replaces}
    <div class="area-options" id="areaResults" role="listbox" aria-label="${escapeHtml(t('area.title'))}">${options}</div>
    ${empty}
    ${status ? `<div class="area-status${labelStatus === 'offline' ? ' area-status--error' : ''}">${escapeHtml(status)}</div>` : ''}
    <div class="area-hint">${escapeHtml(t('area.hint'))}</div>`;
  p.hidden = false;
  el.setAttribute('aria-expanded', 'true');
  el.setAttribute('aria-controls', 'areaResults');
  if (hits.length) {
    el.setAttribute('aria-activedescendant', `areaOpt${active}`);
    p.querySelector(`#areaOpt${active}`)?.scrollIntoView({ block: 'nearest' });
  } else el.removeAttribute('aria-activedescendant');
  place();
}

function close() {
  if (popup) popup.hidden = true;
  kindFilter = null;
  const el = input();
  el?.setAttribute('aria-expanded', 'false');
  el?.removeAttribute('aria-activedescendant');
}

function note(text: string) {
  const el = $('areaNote');
  if (!el) return;
  clearTimeout(noteTimer);
  el.textContent = text;
  el.hidden = !text;
  if (text) noteTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

/** "Texas", or "3 selected" for several codes. */
function areaSummary(a: AreaFilter): string {
  if (a.codes.length !== 1) return t('area.selected', { n: a.codes.length });
  const hit = index?.find(e => e.kind === a.kind && e.code === a.codes[0]);
  return hit?.label ?? a.codes[0];
}

/** One committed change (panel-mirror.ts commitArea: one undo step). */
function commit(next: AreaFilter | null): boolean {
  const err = commitArea(next);
  if (err) note(next && next.codes.length > MAX_LIST_VALUES ? t('area.limit') : err);
  return !err;
}

function pick(hit: AreaHit | undefined, fromKeyboard: boolean) {
  if (!hit) return;
  const el = input()!;
  const cur = state.area;
  let next: AreaFilter;
  let replaced: string | null = null;
  if (cur && cur.kind === hit.kind) {
    if (cur.codes.includes(hit.code)) { el.value = ''; close(); return; }
    if (cur.codes.length >= MAX_LIST_VALUES) { note(t('area.limit')); return; }
    next = { kind: hit.kind, codes: [...cur.codes, hit.code] };
  } else {
    if (cur) replaced = areaSummary(cur);
    next = { kind: hit.kind, codes: [hit.code] };
  }
  if (!commit(next)) return;
  el.value = '';
  close();
  note(replaced ? t('area.replaced', { current: replaced }) : '');
  if (fromKeyboard) el.focus(); else el.blur();
}

function removeCode(code: string) {
  const cur = state.area;
  if (!cur) return;
  const codes = cur.codes.filter(c => c !== code);
  commit(codes.length ? { kind: cur.kind, codes } : null);
}

function onKeyDown(e: KeyboardEvent) {
  const el = e.target as HTMLInputElement;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const kinds: (AreaKind | null)[] = [null, ...kindOrder(state.regionScope)];
    const step = e.key === 'ArrowRight' ? 1 : -1;
    setKind(kinds[(kinds.indexOf(kindFilter) + step + kinds.length) % kinds.length]);
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      if (!isOpen()) { refresh(true); return; }
      if (!hits.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      render(kindOrder(state.regionScope));
      return;
    }
    case 'Enter':
      if (isOpen() && hits.length) { e.preventDefault(); pick(hits[active], true); }
      return;
    case 'Escape':
      if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (el.value) el.value = '';
      return;
    case 'Tab':
      close();
      return;
    case 'Backspace': {
      const cur = state.area;
      if (!el.value && cur) { e.preventDefault(); removeCode(cur.codes[cur.codes.length - 1]); }
      return;
    }
  }
}

// ─── Row flags and "Show" ────────────────────────────────────────────────────
let tip: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;

function closeTip() {
  if (!tip || tip.hidden) return;
  tip.hidden = true;
  tipFor?.removeAttribute('aria-describedby');
  tipFor?.setAttribute('aria-expanded', 'false');
  tipFor = null;
}

function toggleFlagTip(btn: HTMLElement) {
  if (tipFor === btn) { closeTip(); return; }
  closeTip();
  const flag = btn.dataset.flag;
  if (!flag) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'areaFlagTip';
    tip.className = 'area-flag-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  tip.innerHTML = `<b>${escapeHtml(t(flagTitle(flag)))}</b><br>${escapeHtml(t(flag))}`;
  tip.hidden = false;
  tipFor = btn;
  btn.setAttribute('aria-describedby', 'areaFlagTip');
  btn.setAttribute('aria-expanded', 'true');
  // Below the tapped row (above it when the viewport has no room), so the
  // row's checkbox and name stay readable; left-aligned to the flag.
  const r = (btn.closest<HTMLElement>('.layer-row') ?? btn).getBoundingClientRect();
  const fr = btn.getBoundingClientRect();
  const width = Math.min(240, window.innerWidth - 24);
  const left = Math.max(12, Math.min(fr.right, window.innerWidth - 12) - width);
  const below = r.bottom + 6;
  const fits = below + tip.offsetHeight <= window.innerHeight - 8;
  const top = fits ? below : r.top - tip.offsetHeight - 6;
  Object.assign(tip.style, { position: 'fixed', left: `${left}px`, top: `${Math.max(8, top)}px`, width: `${width}px` });
}

/** Open the sections holding the flagged rows and scroll to the first. */
function showFlagged() {
  const flags = [...document.querySelectorAll<HTMLElement>('[data-area-flag]:not([hidden])')];
  for (const f of flags) {
    for (let sec = f.closest<HTMLElement>('[data-collapsible].collapsed'); sec; sec = f.closest<HTMLElement>('[data-collapsible].collapsed')) {
      const btn = sec.querySelector<HTMLElement>('.collapse-btn');
      if (!btn) break;
      btn.click();
      if (sec.classList.contains('collapsed')) break;
    }
    f.classList.add('layer-area-flag--pulse');
    setTimeout(() => f.classList.remove('layer-area-flag--pulse'), 1600);
  }
  flags[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flags[0]?.focus({ preventScroll: true });
}

/** A click on a chip ×, Clear, Show or a row flag (delegated from ui.ts). */
export function areaAction(el: HTMLElement) {
  if (el.matches('.layer-area-flag')) { toggleFlagTip(el); return; }
  switch (el.dataset.areaAction) {
    case 'remove':
      if (el.dataset.areaCode) removeCode(el.dataset.areaCode);
      note('');
      input()?.focus();
      break;
    case 'clear':
      commit(null);
      note('');
      input()?.focus();
      break;
    case 'show':
      showFlagged();
      break;
  }
}

let wired = false;

export function wireAreaPicker() {
  const el = input();
  if (!el || wired) return;
  wired = true;
  requestLabels();
  el.addEventListener('focus', () => { if (labelStatus === 'offline') requestLabels(); });
  el.addEventListener('input', () => { active = 0; refresh(); });
  el.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', e => {
    const target = e.target as Node;
    if (isOpen() && !$('areaRow')?.contains(target) && !popup!.contains(target)) close();
    if (tip && !tip.hidden && !tip.contains(target) && !tipFor?.contains(target)) closeTip();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTip(); });
  document.querySelector('.layers-body')?.addEventListener('scroll', closeTip, { passive: true });
  window.addEventListener('resize', () => { place(); closeTip(); });
  onMapTap(() => { close(); closeTip(); });
  // A view applied in code (Undo, Reset, a story, a link) outdates the note.
  on('view:applied', () => { note(''); close(); closeTip(); });
  // Text typed while this chunk was loading.
  if (document.activeElement === el && el.value.trim()) refresh();
}
