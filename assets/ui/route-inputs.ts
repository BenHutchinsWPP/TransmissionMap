// ─── Route panel: the input column ───────────────────────────────────────────
// Role: the left column of the route pane. Edits `session.inputs` (A and B
//       endpoints, line type, method preset) and calls `cb.onChange()` after
//       every change; the Find button calls `cb.onFind()`. Owns endpoint pick
//       mode (toast, snap-preview callout, crosshair, map taps through
//       map-input.ts, a document-level Esc), the draggable A/B pins, and the
//       folded one-line "A → B · Edit" strip (slot `.ri-strip-extra` is the
//       shell's). The fields scroll in `.ri-fields` above Find. A `lang:changed` redraws the
//       endpoint rows, the method list and the strip. Substations load lazily on first focus or pick. The method <select>
//       is rebuilt on focus and on a `route:presets` event on document. Session only.
//       For the map chat (ui-route.ts routeForChat): substationIndex() (a load failure is a
//       refusal and is not cached, so the next call retries), setEndHit() (places exactly that
//       substation, no re-snap) and refresh() (redraws line type, method, fields, pins, strip).
// Deps: route/snap.ts (snapAt, searchSubstations), route/custom-presets.ts, dataset-query.ts (Outcome, type only),
//       src/registry/route-presets.ts, map-input.ts (onMapTap, onMapHover),
//       tool-mode.ts (toolHooks), state.ts, substation-index.ts (ensureSubstationIndex), i18n (t), state-bus.ts (lang:changed), units.ts (fmtDistanceMi),
//       route-tabs/types.ts (types), maplibre-gl (Marker), route-panel.css.

import { Marker } from 'maplibre-gl';
import type { MapMouseEvent } from 'maplibre-gl';
import { snapAt, searchSubstations, type SnapHit, type SubstationIndex } from '../route/snap.js';
import { createCustomPresetStore, presetLabel, type CustomPreset } from '../route/custom-presets.js';
import { ROUTE_PRESETS, type RoutePreset } from '../../src/registry/route-presets.js';
import { onMapTap, onMapHover, type MapPointerEvent, type Unsubscribe } from '../map-input.js';
import { toolHooks } from '../tool-mode.js';
import { state } from '../state.js';
import { ensureSubstationIndex } from './substation-index.js';
import { t } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';
import { fmtDistanceMi } from '../../src/units.js';
import type { RouteEnd, RouteSession, RouteStatus } from './route-tabs/types.js';
import type { Outcome } from '../dataset-query.js';
import './route-panel.css';
import { h, ht } from '../utils/utils-dom.js';

export type End = 'A' | 'B';
export interface InputsCallbacks { onFind(): void; onChange(): void; onEditMethod(): void }
export interface InputsHandle {
  destroy(): void;
  setBusy(b: boolean): void;
  setErrors(n: number): void;
  setFolded(f: boolean): void;
  /** Re-read the session's method, line type and ends (saved defaults arrived, or the chat set them). */
  refresh(): void;
  startPick(end: End): void;
  setEnd(end: End, lngLat: [number, number]): Promise<void>;
  /** The HIFLD substation index; a load failure is a refusal and is not kept (the next call retries). */
  substationIndex(): Promise<Outcome<SubstationIndex>>;
  /** Place exactly this substation at `end` (no re-snap). */
  setEndHit(end: End, hit: SnapHit): Promise<void>;
}

const NUDGE_M = 100;
const COMPACT = '(max-width: 640px), (max-height: 500px)';
const FOLD_W = 900;
const KM_PER_MI = 1.609344;
let uid = 0;

const presetStore = createCustomPresetStore({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
});

const coords = ([lng, lat]: [number, number]) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;
const subName = (s: SnapHit) => s.name ?? t('route.in.unnamed');
const kvText = (s: SnapHit) => (s.kvUnknown || s.maxKv === null ? t('route.in.kvUnknown') : t('route.in.kv', { kv: Math.round(s.maxKv) }));
const kvClass = (s: SnapHit) =>
  'ri-kv' + (s.maxKv === null ? ' ri-kv--unknown' : s.maxKv >= 345 ? '' : s.maxKv >= 161 ? ' ri-kv--mid' : ' ri-kv--low');
const place = (s: SnapHit) => [s.states.join('/'), s.ba.join('/')].filter(Boolean).join(' · ');
const miles = (km: number) => fmtDistanceMi(km / KM_PER_MI);

function kvBadge(s: SnapHit): HTMLElement { return h('span', kvClass(s), kvText(s)); }

/** "500 AC" / "500 DC" from a line type's nominal kV and its id or label. */
function lineTypeLabel(id: string, lt: RoutePreset['line_types'][string]): string {
  return `${lt.kv.value} ${/dc/i.test(id) || /\b(hv)?dc\b/i.test(lt.label) ? 'DC' : 'AC'}`;
}

export function mountInputs(el: HTMLElement, session: RouteSession, cb: InputsCallbacks): InputsHandle {
  const id = `ri${++uid}`;
  const inputs = session.inputs;
  let index: SubstationIndex | null = null;
  let busy = false;
  let destroyed = false;
  let errors = 0;
  let forcedFold: boolean | null = null;
  let picking: End | null = null;
  let statusBeforePick: RouteStatus | null = null;
  let pickSubs: Unsubscribe[] = [];
  let toast: HTMLElement | null = null;
  let callout: HTMLElement | null = null;
  const clickAt: Record<End, [number, number] | null> = { A: null, B: null };
  const markers: Record<End, Marker | null> = { A: null, B: null };
  const nudgeTimers: Record<End, ReturnType<typeof setTimeout> | undefined> = { A: undefined, B: undefined };

  // ── presets ────────────────────────────────────────────────────────────────
  function customs(): CustomPreset[] { return presetStore.list(); }
  function presetFor(pid: string): RoutePreset | undefined {
    if (pid.startsWith('custom:')) {
      const c = customs().find((x) => `custom:${x.id}` === pid);
      return c?.status === 'ok' ? c.preset : undefined;
    }
    return ROUTE_PRESETS.find((p) => p.id === pid);
  }
  function preset(): RoutePreset { return presetFor(inputs.presetId) ?? ROUTE_PRESETS[0]; }
  function fitLineType(): void {
    const lts = preset().line_types;
    if (!(inputs.lineType in lts)) inputs.lineType = Object.keys(lts)[0];
  }
  const kv = () => preset().line_types[inputs.lineType]?.kv.value ?? 500;
  if (!presetFor(inputs.presetId)) inputs.presetId = ROUTE_PRESETS[0].id;
  fitLineType();

  // ── substations ────────────────────────────────────────────────────────────
  /** Load the index once; a failed or empty load is reported and forgotten, so the next call tries again. */
  function loadIndex(): Promise<Outcome<SubstationIndex>> {
    return ensureSubstationIndex().then((o) => {
      if (o.ok && index !== o.result) {
        index = o.result;
        for (const end of ['A', 'B'] as const) if (fields[end].list.dataset.open) runSearch(end);
      }
      return o;
    });
  }
  /** The visitor's flow: an empty index while the load fails (ends stay raw points; the next focus retries). */
  function ensureIndex(): Promise<SubstationIndex> {
    return loadIndex().then((o) => {
      if (o.ok) return o.result;
      if (!index) {
        index = { subs: [], grid: new Map() };
        for (const end of ['A', 'B'] as const) if (fields[end].list.dataset.open) runSearch(end);
      }
      return index;
    });
  }

  // ── skeleton ───────────────────────────────────────────────────────────────
  el.classList.add('ri');
  const strip = h('div', 'ri-strip');
  const stripA = h('span', 'ri-strip-end');
  const stripB = h('span', 'ri-strip-end');
  const stripExtra = h('span', 'ri-strip-extra');
  const stripEdit = ht('button', 'ri-link ri-strip-edit', 'route.in.edit');
  stripEdit.type = 'button';
  stripEdit.addEventListener('click', () => { forcedFold = false; applyFold(); });
  strip.append(stripA, h('span', 'ri-strip-arrow', '→'), stripB, stripExtra, stripEdit);

  const body = h('div', 'ri-body');
  const heading = ht('h3', 'ri-h', 'route.in.endpoints');
  const ltLabel = ht('span', 'ri-label', 'route.in.lineType');
  ltLabel.id = `${id}-lt`;
  const seg = h('div', 'ri-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', ltLabel.id);
  const methodLabel = ht('label', 'ri-label', 'route.in.method');
  const select = h('select', 'ri-select');
  select.id = `${id}-method`;
  methodLabel.htmlFor = select.id;
  const editLink = ht('button', 'ri-link', 'route.in.editMethod');
  editLink.type = 'button';
  editLink.addEventListener('click', () => cb.onEditMethod());
  const note = ht('span', 'ri-note', 'route.in.gridNote');
  const methodRow = h('div', 'ri-method-row');
  methodRow.append(editLink, note);
  const find = h('button', 'ri-primary');
  find.type = 'button';
  find.addEventListener('click', () => { if (!find.disabled) cb.onFind(); });
  const errLine = h('p', 'ri-errors');
  errLine.setAttribute('aria-live', 'polite');
  errLine.hidden = true;

  // ── endpoint fields ────────────────────────────────────────────────────────
  interface Field { wrap: HTMLElement; box: HTMLElement; list: HTMLUListElement; input: HTMLInputElement | null; hits: SnapHit[]; active: number; timer?: ReturnType<typeof setTimeout> }
  const fields = {} as Record<End, Field>;
  for (const end of ['A', 'B'] as const) {
    const wrap = h('div', 'ri-ep-wrap');
    const box = h('div', 'ri-ep');
    const list = h('ul', 'ri-list');
    list.id = `${id}-${end}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.append(box, list);
    fields[end] = { wrap, box, list, input: null, hits: [], active: -1 };
  }
  const endOf = (end: End): RouteEnd | null => (end === 'A' ? inputs.a : inputs.b);

  function renderField(end: End): void {
    const f = fields[end];
    const re = endOf(end);
    f.box.replaceChildren(h('span', 'ri-ep-pin', end));
    f.box.classList.toggle('ri-ep--active', picking === end);
    f.input = null;
    closeList(end);
    if (re) {
      const txt = h('span', 'ri-ep-txt');
      if (re.hit) {
        txt.append(h('b', '', subName(re.hit)), ' ', kvBadge(re.hit));
        const sub = Number.isFinite(re.hit.distanceKm)
          ? t('route.in.snapped', { d: miles(re.hit.distanceKm) })
          : place(re.hit);
        txt.append(h('small', '', sub));
      } else {
        txt.append(h('b', '', t('route.in.rawPoint')), h('small', '', coords(re.lngLat)));
      }
      const x = h('button', 'ri-ep-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', t('route.in.clear', { end }));
      x.addEventListener('click', () => {
        setInput(end, null, clickAt[end]);
        fields[end].input?.focus();
      });
      f.box.append(txt, x);
      return;
    }
    const input = h('input', 'ri-ep-in');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = t('route.in.placeholder');
    input.setAttribute('data-i18n-placeholder', 'route.in.placeholder');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', f.list.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', t('route.in.endLabel', { end }));
    input.addEventListener('focus', () => { void ensureIndex(); if (clickAt[end] || input.value.trim().length >= 2) runSearch(end); });
    input.addEventListener('input', () => {
      clearTimeout(f.timer);
      f.timer = setTimeout(() => runSearch(end), 120);
    });
    input.addEventListener('keydown', (e) => onComboKey(end, e));
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) closeList(end); }, 0));
    const pick = h('button', 'ri-ep-pick');
    pick.type = 'button';
    pick.setAttribute('aria-label', t('route.in.pickOnMap', { end }));
    pick.title = t('route.in.pickOnMap', { end });
    pick.textContent = '⌖';
    pick.addEventListener('click', () => startPick(end));
    f.input = input;
    f.box.append(input, pick);
  }

  function closeList(end: End): void {
    const f = fields[end];
    f.list.hidden = true;
    delete f.list.dataset.open;
    f.list.replaceChildren();
    f.hits = [];
    f.active = -1;
    f.input?.setAttribute('aria-expanded', 'false');
    f.input?.removeAttribute('aria-activedescendant');
  }

  function runSearch(end: End): void {
    const f = fields[end];
    if (!f.input) return;
    const q = f.input.value.trim();
    f.list.replaceChildren();
    f.list.dataset.open = '1';
    f.list.setAttribute('aria-label', t('route.in.listLabel', { q }));
    if (!index) {
      void ensureIndex();
      const li = h('li', 'ri-list-status', t('route.in.loading'));
      li.setAttribute('aria-disabled', 'true');
      f.list.append(li);
      f.hits = [];
    } else {
      f.hits = searchSubstations(index, q, kv());
      f.hits.forEach((s, i) => {
        const li = h('li', 'ri-opt');
        li.append(h('b', '', subName(s)), ' ', kvBadge(s));
        const where = place(s);
        if (where) li.append(h('small', '', where));
        addOption(end, li, i);
      });
      if (q.length >= 2 && !f.hits.length) {
        const li = h('li', 'ri-list-status', t('route.in.noMatch'));
        li.setAttribute('aria-disabled', 'true');
        f.list.append(li);
      }
    }
    const raw = clickAt[end];
    if (raw && index) {
      const li = h('li', 'ri-opt ri-opt-raw', t('route.in.useRaw'));
      li.append(h('small', '', t('route.in.rawCoords', { at: coords(raw) })));
      addOption(end, li, f.hits.length);
    }
    const open = f.list.children.length > 0 && (q.length >= 2 || !!raw || !index);
    f.list.hidden = !open;
    f.input.setAttribute('aria-expanded', String(open));
    f.active = f.list.querySelector('.ri-opt') ? 0 : -1;
    markActive(end);
  }

  function addOption(end: End, li: HTMLLIElement, i: number): void {
    li.id = `${id}-${end}-opt-${i}`;
    li.setAttribute('role', 'option');
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => choose(end, i));
    fields[end].list.append(li);
  }

  const options = (end: End) => [...fields[end].list.querySelectorAll<HTMLElement>('.ri-opt')];
  function markActive(end: End): void {
    const f = fields[end];
    options(end).forEach((o, i) => {
      o.setAttribute('aria-selected', String(i === f.active));
      o.classList.toggle('on', i === f.active);
    });
    const cur = options(end)[f.active];
    if (cur) f.input?.setAttribute('aria-activedescendant', cur.id);
    else f.input?.removeAttribute('aria-activedescendant');
    cur?.scrollIntoView?.({ block: 'nearest' });
  }

  function choose(end: End, i: number): void {
    const f = fields[end];
    const s = f.hits[i];
    if (s) setInput(end, { lngLat: s.lngLat, hit: s }, null);
    else if (i === f.hits.length && clickAt[end]) setInput(end, { lngLat: clickAt[end]!, hit: null }, clickAt[end]);
    else return;
    f.box.querySelector<HTMLElement>('.ri-ep-x')?.focus();
  }

  function onComboKey(end: End, e: KeyboardEvent): void {
    const f = fields[end];
    const n = options(end).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (f.list.hidden) { runSearch(end); e.preventDefault(); return; }
      if (!n) return;
      f.active = (f.active + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n;
      markActive(end);
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (!f.list.hidden && f.active >= 0) { choose(end, f.active); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      if (!f.list.hidden) { closeList(end); e.preventDefault(); e.stopPropagation(); }
    }
  }

  // ── set an endpoint ────────────────────────────────────────────────────────
  function setInput(end: End, re: RouteEnd | null, click: [number, number] | null): void {
    if (picking === end && re) stopPick();
    if (end === 'A') inputs.a = re; else inputs.b = re;
    clickAt[end] = click;
    renderField(end);
    placePin(end);
    renderStrip();
    updateFind();
    cb.onChange();
  }

  /** Snap `lngLat` for the current line type (or keep it raw) and fill `end`. */
  async function fill(end: End, lngLat: [number, number], raw: boolean): Promise<void> {
    const idx = await ensureIndex();
    if (destroyed) return;
    const hit = raw ? null : snapAt(idx, lngLat, kv(), session.snapKm ?? 3).best;
    setInput(end, hit ? { lngLat: hit.lngLat, hit } : { lngLat, hit: null }, lngLat);
  }

  // ── pins ───────────────────────────────────────────────────────────────────
  function placePin(end: End): void {
    const re = endOf(end);
    const map = state.map;
    if (!re || !map) { markers[end]?.remove(); markers[end] = null; return; }
    if (markers[end]) { markers[end]!.setLngLat(re.lngLat); return; }
    const pinEl = h('div');
    const m = new Marker({ element: pinEl, draggable: true, anchor: 'bottom' }).setLngLat(re.lngLat).addTo(map);
    const pe = m.getElement();
    pe.classList.add('ri-pin');
    const head = h('span', 'ri-pin-head');
    head.append(h('span', '', end));
    pe.replaceChildren(head);
    pe.tabIndex = 0;
    pe.setAttribute('role', 'button');
    pe.setAttribute('aria-label', t('route.in.pinLabel', { end }));
    m.on('dragend', () => { const ll = m.getLngLat(); void fill(end, [ll.lng, ll.lat], false); });
    pe.addEventListener('keydown', (e) => {
      const d = ({ ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const ll = m.getLngLat();
      const dLat = NUDGE_M / 111_320;
      const dLng = dLat / Math.max(0.01, Math.cos((ll.lat * Math.PI) / 180));
      m.setLngLat([ll.lng + d[0] * dLng, ll.lat + d[1] * dLat]);
    });
    pe.addEventListener('keyup', (e) => {
      if (!e.key.startsWith('Arrow')) return;
      clearTimeout(nudgeTimers[end]);
      const raw = e.altKey;
      nudgeTimers[end] = setTimeout(() => {
        const ll = m.getLngLat();
        void fill(end, [ll.lng, ll.lat], raw).then(() => markers[end]?.getElement().focus());
      }, 300);
    });
    markers[end] = m;
  }

  // ── pick mode ──────────────────────────────────────────────────────────────
  function startPick(end: End): void {
    const map = state.map;
    if (!map) return;
    stopPick();
    void ensureIndex();
    toolHooks.deactivateMeasure();
    toolHooks.exitEdit();
    picking = end;
    state.routePick = true;
    toolHooks.deactivateRoutePick = stopPick;
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = 'crosshair';
    toast = h('div', 'ri-toast', t('route.in.toast', { end }));
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    map.getContainer().append(toast);
    pickSubs = [onMapTap(onPickTap), onMapHover(onPickHover)];
    document.addEventListener('keydown', onPickKey, { capture: true });
    statusBeforePick = session.status;
    session.status = { kind: 'picking', end };
    renderField('A');
    renderField('B');
    if (!(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) fields[end].input?.focus();
    cb.onChange();
  }

  function stopPick(): void {
    if (!picking) return;
    picking = null;
    for (const off of pickSubs) off();
    pickSubs = [];
    document.removeEventListener('keydown', onPickKey, { capture: true });
    state.routePick = false;
    toolHooks.deactivateRoutePick = () => {};
    const map = state.map;
    if (map) {
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
    }
    toast?.remove();
    toast = null;
    callout?.remove();
    callout = null;
    if (session.status.kind === 'picking') session.status = statusBeforePick ?? { kind: 'idle' };
    statusBeforePick = null;
    renderField('A');
    renderField('B');
    cb.onChange();
  }

  function onPickKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stopPick();
  }

  const altOf = (e: MapPointerEvent) => !!(e.originalEvent as MouseEvent | undefined)?.altKey;

  function onPickHover(e: MapMouseEvent): void {
    const map = state.map;
    if (!map || !picking) return;
    if (!callout) {
      callout = h('div', 'ri-callout');
      callout.setAttribute('aria-hidden', 'true');
      map.getContainer().append(callout);
    }
    const hit = !index || altOf(e) ? null : snapAt(index, [e.lngLat.lng, e.lngLat.lat], kv(), session.snapKm ?? 3).best;
    if (!index) callout.replaceChildren(t('route.in.loading'));
    else if (altOf(e)) callout.replaceChildren(t('route.in.clickRaw'));
    else if (!hit) callout.replaceChildren(t('route.in.noSnap'));
    else callout.replaceChildren(h('b', '', subName(hit)), ' ', kvBadge(hit), h('small', '', t('route.in.clickToSnap', { d: miles(hit.distanceKm) })));
    // Follow the pointer, but keep the callout inside the map's edges.
    const box = map.getContainer();
    const maxL = box.clientWidth - callout.offsetWidth - 4, maxT = box.clientHeight - callout.offsetHeight - 4;
    const left = e.point.x + 14, top = e.point.y + 14;
    callout.style.left = `${box.clientWidth > 0 ? Math.max(4, Math.min(left, maxL)) : left}px`;
    callout.style.top = `${box.clientHeight > 0 ? Math.max(4, Math.min(top, maxT)) : top}px`;
  }

  function onPickTap(e: MapPointerEvent): void {
    const end = picking;
    if (!end) return;
    const raw = altOf(e);
    stopPick();
    void fill(end, [e.lngLat.lng, e.lngLat.lat], raw);
  }

  // ── line type + method ─────────────────────────────────────────────────────
  function renderSeg(): void {
    const lts = preset().line_types;
    seg.replaceChildren();
    for (const [ltId, lt] of Object.entries(lts)) {
      const b = h('button', 'ri-seg-btn', lineTypeLabel(ltId, lt));
      b.type = 'button';
      b.dataset.id = ltId;
      b.title = lt.label;
      b.setAttribute('role', 'radio');
      const on = ltId === inputs.lineType;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
      b.tabIndex = on ? 0 : -1;
      b.addEventListener('click', () => setLineType(ltId));
      seg.append(b);
    }
  }
  function setLineType(ltId: string): void {
    if (ltId === inputs.lineType) return;
    inputs.lineType = ltId;
    renderSeg();
    seg.querySelector<HTMLElement>(`[aria-checked="true"]`)?.focus();
    cb.onChange();
  }
  seg.addEventListener('keydown', (e) => {
    const ids = Object.keys(preset().line_types);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = ids.indexOf(inputs.lineType);
    setLineType(ids[(i + step + ids.length) % ids.length]);
  });

  function renderSelect(): void {
    select.replaceChildren();
    for (const p of ROUTE_PRESETS) {
      const o = h('option', '', presetLabel(p));
      o.value = p.id;
      select.append(o);
    }
    for (const c of customs()) {
      const o = h('option', '', c.status === 'ok' ? c.name : t('route.in.needsReview', { name: c.name }));
      o.value = `custom:${c.id}`;
      o.disabled = c.status !== 'ok';
      select.append(o);
    }
    select.value = inputs.presetId;
  }
  select.addEventListener('focus', renderSelect);
  // The Method tab saved, renamed or deleted a method: list it now and
  // show the session's method (a save switches it to custom:<id>); a deleted one falls back.
  const onPresets = () => {
    if (!presetFor(inputs.presetId)) {
      inputs.presetId = ROUTE_PRESETS[0].id;
      inputs.patch = null;
      fitLineType();
      renderSeg();
      renderSelect();
      cb.onChange();
      return;
    }
    renderSelect();
  };
  document.addEventListener('route:presets', onPresets);
  select.addEventListener('change', () => {
    if (!presetFor(select.value)) { select.value = inputs.presetId; return; }
    inputs.presetId = select.value;
    inputs.patch = null;
    fitLineType();
    renderSeg();
    cb.onChange();
  });

  // ── Find + fold ────────────────────────────────────────────────────────────
  function updateFind(): void {
    const findKey = session.result ? 'route.in.resolve' : 'route.in.find';
    find.textContent = t(findKey);
    find.dataset.i18n = findKey;
    find.disabled = !inputs.a || !inputs.b || busy || errors > 0;
    find.setAttribute('aria-busy', String(busy));
    errLine.hidden = errors <= 0;
    errLine.textContent = errors > 0 ? t(errors === 1 ? 'route.in.fixError' : 'route.in.fixErrors', { n: errors }) : '';
  }

  function stripEnd(span: HTMLElement, end: End): void {
    const re = endOf(end);
    span.replaceChildren(h('b', 'ri-strip-pin', end), ' ');
    if (!re) span.append('—');
    else if (re.hit) span.append(subName(re.hit), ' ', re.hit.kvUnknown ? '' : kvText(re.hit));
    else span.append(t('route.in.rawPoint'));
  }
  function renderStrip(): void { stripEnd(stripA, 'A'); stripEnd(stripB, 'B'); }

  const foldTarget = (): HTMLElement => el.closest<HTMLElement>('.table-drawer') ?? el.parentElement ?? el;
  function autoFold(): boolean {
    const w = foldTarget().clientWidth;
    return (typeof matchMedia === 'function' && matchMedia(COMPACT).matches) || (w > 0 && w < FOLD_W);
  }
  function applyFold(): void {
    const folded = forcedFold ?? autoFold();
    el.classList.toggle('ri--folded', folded);
    strip.hidden = !folded;
    body.hidden = folded;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyFold()) : null;
  ro?.observe(foldTarget());

  // ── assemble ───────────────────────────────────────────────────────────────
  const ltField = h('div', 'ri-field');
  ltField.append(ltLabel, seg);
  const methodField = h('div', 'ri-field');
  methodField.append(methodLabel, select, methodRow);
  // The fields scroll on their own; Find sits below them, so it never covers one.
  const scroller = h('div', 'ri-fields');
  scroller.append(heading, fields.A.wrap, fields.B.wrap, ltField, methodField);
  body.append(scroller, find, errLine);
  el.replaceChildren(strip, body);
  renderField('A');
  renderField('B');
  placePin('A');
  placePin('B');
  renderSeg();
  renderSelect();
  renderStrip();
  updateFind();
  applyFold();
  // The endpoint rows and the strip carry parameterised text (data-i18n cannot): redraw them in the new language.
  // The bus has no unsubscribe, so a destroyed column ignores the event.
  on('lang:changed', () => {
    if (destroyed) return;
    for (const end of ['A', 'B'] as const) if (endOf(end)) renderField(end);
    renderSeg();
    renderSelect();
    renderStrip();
    updateFind();
  });

  return {
    destroy() {
      destroyed = true;
      document.removeEventListener('route:presets', onPresets);
      stopPick();
      ro?.disconnect();
      for (const end of ['A', 'B'] as const) {
        clearTimeout(nudgeTimers[end]);
        clearTimeout(fields[end].timer);
        markers[end]?.remove();
        markers[end] = null;
      }
      el.replaceChildren();
      el.classList.remove('ri', 'ri--folded');
    },
    setBusy(b) { busy = b; updateFind(); },
    setErrors(n) { errors = Math.max(0, n); updateFind(); },
    setFolded(f) { forcedFold = f; applyFold(); },
    refresh() {
      if (!presetFor(inputs.presetId)) inputs.presetId = ROUTE_PRESETS[0].id;
      fitLineType();
      renderSeg();
      renderSelect();
      for (const end of ['A', 'B'] as const) { renderField(end); placePin(end); }
      renderStrip();
      updateFind();
    },
    startPick,
    setEnd(end, lngLat) { return fill(end, lngLat, false); },
    substationIndex: loadIndex,
    async setEndHit(end, hit) {
      if (destroyed) return;
      setInput(end, { lngLat: hit.lngLat, hit }, null);
    },
  };
}
