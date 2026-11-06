// ─── Visualize: the template gallery in the bottom drawer (lazy chunk) ───────
// Role: the drawer's Visualize tab (ui-table.ts vizPanel / openViz), which
//       shows a page-owned template (assets/templates/) with no key and no
//       model, through the same showTemplate() the chat's tool calls.
//         openVisualize(layerId?, from?)  open the pane (File ▸ Visualize…, or a
//                    layer row's ⋯ menu ▸ Visualize with that layer picked).
//         resumeVisualize(viz)  after a reload of this tab (restoreDrawer's
//                    resumeViz): the pane with its layer and cards. Each card's
//                    params pass validateTemplateArgs again or the card is
//                    dropped; the newest Vega cards are drawn again into the
//                    free frame slots only (ui-canvas.ts claimRestoreSlots,
//                    shared with the chat, which claims first: ≤ MAX_LIVE live
//                    frames, no eviction), one at a time (a tiled layer after
//                    the map's idle), and the stack then scrolls back to its
//                    newest card; every other card comes back as a Re-run
//                    placeholder. No focus moves, no link write, no undo step;
//                    the redraw reads our own data host, and its Vega frame
//                    loads the pinned chart libraries from jsDelivr
//                    (src/registry/template-libs.json), as any Vega card does.
//       The pane: a layer picker, a gallery of the templates that fit it, and a
//       form built from formChoices(). GeoJSON reads the whole layer within the
//       Area; a tiled one reads the view (switched-off layers offer Switch on);
//       cards beyond MAX_VIZ_CARDS collapse to Re-run; not in links, no undo.
//       A card renders through ui-canvas.ts canvasCard({template: true, rerun});
//       canvas-host.ts keeps at most MAX_LIVE frames live (an evicted card
//       offers Re-run through showTemplate with its params); × removes a card
//       (and the county overlay it painted).
//       Everything is built with services-dom.ts el() as text (eslint holds
//       this file to the chat's text-only rule); strings carry data-chat-key
//       or are rebuilt on lang:changed.
//
// Deps: ui-table.ts (vizPanel, openViz, vizOpen, registerVizSnapshot, mapIdle,
//       drawerChanged), ui-canvas.ts (canvasCard, claimRestoreSlots,
//       releaseRestoreSlot), services-dom.ts (el),
//       templates/show-template.ts (showTemplate, validateTemplateArgs,
//       formChoices, coverageArea, fieldLabel, measureLabel, TOP_*, WITHIN_*), templates/catalogue.ts
//       (templatesFor, templateById), registry (LAYERS, layerById),
//       area-filter.ts (areaCondition), area-labels.ts, state.ts, state-bus.ts
//       (on), visibility.ts (setLayerVisibility), field-schema.ts / field-roles.ts
//       (where2's fields), units.ts (within's unit), drawer-snapshot.ts (types,
//       MAX_VIZ_CARDS), i18n (t); types from agent/tools.ts and canvas-host.ts.
// Loaded by: templates-open.ts (dynamic import).

import { vizPanel, openViz, vizOpen, registerVizSnapshot, mapIdle, drawerChanged } from './ui-table.js';
import { canvasCard, claimRestoreSlots, releaseRestoreSlot } from './ui-canvas.js';
import { el } from './services-dom.js';
import {
  showTemplate, validateTemplateArgs, formChoices, coverageArea, fieldLabel, measureLabel,
  TOP_MIN, TOP_MAX, TOP_DEFAULT, WITHIN_MIN, WITHIN_MAX, WITHIN_DEFAULT, type FormChoices,
} from '../templates/show-template.js';
import { FIELD_SCHEMA, type FieldOp } from '../../src/registry/field-schema.js';
import { rolesOf } from '../../src/registry/field-roles.js';
import { getUnits, unitLabel } from '../../src/units.js';
import { templatesFor, templateById, type TemplateDef } from '../templates/catalogue.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import { areaCondition } from '../../src/registry/area-filter.js';
import { areaLabel, areaLabelsNow, loadAreaLabels } from './area-labels.js';
import { state } from '../state.js';
import { on } from '../state-bus.js';
import { setLayerVisibility } from '../visibility.js';
import { t } from '../../src/i18n/index.js';
import { MAX_VIZ_CARDS, type VizCard, type VizSnapshot } from './drawer-snapshot.js';
import type { CanvasKind, CanvasOutcome } from '../sandbox/canvas-host.js';
import type { RenderExtra } from '../agent/tools.js';

/** The form's choices for the picked template, kept across a redraw. */
interface FormState {
  by: string; split: string; time: string; measure: string; top: number; buckets: number; mode: 'additions' | 'net'; inArea: boolean;
  /** nearest: the second layer, one optional condition on it ('' field: none), the threshold in km. */
  layer2: string; cond: { field: string; op: FieldOp; value: string }; within: number;
}

/** The comparisons the one where2 condition offers (a list op needs a list, which the chat writes). */
const COND_OPS: readonly FieldOp[] = ['=', '!=', '>=', '>', '<=', '<'];
const COND_OP_TEXT: Record<string, string> = { '=': '=', '!=': '≠', '>=': '≥', '>': '>', '<=': '≤', '<': '<' };
const MI_KM = 1.609344;

let root: HTMLElement | null = null;
let layer: string | null = null;
let tplId: string | null = null;
let form: FormState | null = null;
let busy = false;
const entries = new WeakMap<Element, VizCard>();

const q = <T extends HTMLElement = HTMLElement>(sel: string) => root!.querySelector<T>(sel)!;

/** An element showing t(key, params), redrawn on lang:changed (data-chat-key, as ui-canvas.ts's). */
function tx<K extends keyof HTMLElementTagNameMap>(tag: K, key: string, params?: Record<string, string>, attrs: Record<string, string> = {}) {
  const e = el(tag, attrs);
  e.dataset.chatKey = key;
  if (params) e.dataset.chatParams = JSON.stringify(params);
  e.textContent = t(key, params);
  return e;
}

// ─── Layers and templates ────────────────────────────────────────────────────
const isTiled = (id: string) => layerById(id)?.data?.kind !== 'geojson';
const isOn = (id: string) => !!state.layerVisibility[id];

/** The layers a ready template fits, the switched-on ones first. */
export function vizLayers(): string[] {
  const ids = LAYERS.filter(l => !l.hidden && templatesFor(l.id).length).map(l => l.id);
  return [...ids.filter(isOn), ...ids.filter(id => !isOn(id))];
}

/** The view's Area for `id` when it reaches that GeoJSON layer, else null. */
function areaFor(id: string) {
  const entry = layerById(id);
  if (!state.area || !entry?.dataset || isTiled(id)) return null;
  const cond = areaCondition(entry.dataset, state.area);
  return cond === 'all' || !('unfiltered' in cond) ? state.area : null;
}

/** nearest beside a US-only layer2, with no view Area reaching `id`: the US Area it reads by default. */
function coverageFor(id: string, f: FormState) {
  return tplId && templateById(tplId)?.params.layer2 && f.layer2 && !isTiled(id) && !areaFor(id) ? coverageArea(id, f.layer2) : null;
}

function areaNames(area: NonNullable<typeof state.area>): string {
  const names = area.codes.map(c => areaLabel(areaLabelsNow(), area.kind, c));
  return names.length > 3 ? t('area.selected', { n: names.length }) : names.join(', ');
}

function pickLayer(id: string | null) {
  const list = vizLayers();
  layer = id && list.includes(id) ? id : layer && list.includes(layer) ? layer : list[0] ?? null;
  const fits = layer ? templatesFor(layer) : [];
  if (!fits.some(d => d.id === tplId)) tplId = fits[0]?.id ?? null;
  form = null;
}

/** The form's starting values: each list's first entry, as validateTemplateArgs defaults them. */
function defaults(def: TemplateDef, c: FormChoices, id: string): FormState {
  const v = validateTemplateArgs({ template: def.id, layer: id });
  const r = v.ok ? v.result : null;
  return {
    by: r?.by ?? '', split: r?.split ?? '', time: r?.time ?? '', measure: r?.measure ?? c.measure[0]?.name ?? 'count',
    top: r?.top ?? TOP_DEFAULT, buckets: r?.buckets ?? 0, mode: 'additions', inArea: true,
    layer2: r?.layer2 ?? c.layer2[0] ?? '', cond: { field: '', op: '>=', value: '' }, within: r?.within ?? WITHIN_DEFAULT,
  };
}

/** The showTemplate arguments the form stands for. */
export function formArgs(): Record<string, unknown> | null {
  if (!layer || !tplId || !form) return null;
  const def = templateById(tplId)!;
  const args: Record<string, unknown> = { template: def.id, layer };
  if (def.params.measure) args.measure = form.measure;
  if (def.params.by) { if (form.by) args.by = form.by; }
  if (def.params.split && form.split && form.split !== form.by) args.split = form.split;
  if (def.params.time && form.time) args.time = form.time;
  if (def.params.layer2 && form.layer2) {
    args.layer2 = form.layer2;
    const where2 = condOf(form.layer2, form.cond);
    if (where2) args.where2 = where2;
  }
  if (def.params.within) args.within = form.within;
  if (def.params.by && def.params.top) args.top = form.top;
  if (def.params.measure?.binned && form.buckets) args.buckets = form.buckets;
  if (def.params.mode && netOpen()) args.mode = form.mode;
  if (!isTiled(layer) && (areaFor(layer) || coverageFor(layer, form)) && !form.inArea) args.area = null;
  return args;
}

/** The fields of `layerId` one where2 condition may test: those taking a comparison, never a region list. */
function condFields(layerId: string): [string, { type: string; ops: FieldOp[]; values?: readonly string[] }][] {
  const ds = layerById(layerId)?.dataset;
  const schema = ds && Object.hasOwn(FIELD_SCHEMA, ds) ? FIELD_SCHEMA[ds] : {};
  return Object.entries(schema).filter(([, d]) => !d.list && d.ops.some(o => COND_OPS.includes(o)));
}

/** The form's one condition as a where2 array, or null when it names no field or value. */
function condOf(layerId: string, c: FormState['cond']): unknown[] | null {
  const d = condFields(layerId).find(([n]) => n === c.field)?.[1];
  if (!d || !c.value.trim() || !d.ops.includes(c.op)) return null;
  const value = d.type === 'number' ? Number(c.value) : c.value.trim();
  return [{ field: c.field, op: c.op, value }];
}

/** Whether `net` holds with the form's year field. */
function netOpen(): boolean {
  if (!layer || !tplId || !form) return false;
  return validateTemplateArgs({ template: tplId, layer, ...(form.time && { time: form.time }), mode: 'net' }).ok;
}

// ─── Building the pane ───────────────────────────────────────────────────────
function build(): HTMLElement {
  if (root) return root;
  const panel = vizPanel();
  root = el('div', { class: 'tv' },
    el('div', { class: 'tv-side' },
      el('label', { class: 'tv-field tv-layer-field' }, tx('span', 'viz.layer'), el('select', { class: 'tv-layer' })),
      el('div', { class: 'tv-gallery', role: 'group' }),
      el('div', { class: 'tv-form' })),
    el('div', { class: 'tv-cards' }));
  panel.replaceChildren(root);
  q('.tv-layer').addEventListener('change', () => {
    pickLayer(q<HTMLSelectElement>('.tv-layer').value);
    renderGallery();
    renderForm();
  });
  registerVizSnapshot(snapshot);
  on('lang:changed', () => {
    if (!root) return;
    for (const e of root.querySelectorAll<HTMLElement>('[data-chat-key]')) {
      e.textContent = t(e.dataset.chatKey!, e.dataset.chatParams ? JSON.parse(e.dataset.chatParams) as Record<string, string> : undefined);
    }
    renderPicker();
    renderGallery();
    renderForm();
  });
  on('layer:visibility', () => { if (root && vizOpen()) { renderPicker(); renderScope(); } });
  on('view:applied', () => { if (root && vizOpen()) renderScope(); });
  on('url:write', () => { if (root && vizOpen()) renderScope(); });
  return root;
}

function renderPicker() {
  const sel = q<HTMLSelectElement>('.tv-layer');
  const ids = vizLayers();
  const group = (key: string, list: string[]) => {
    const g = el('optgroup', { label: t(key) });
    g.append(...list.map(id => new Option(t(layerById(id)!.titleKey), id)));
    return g;
  };
  const onIds = ids.filter(isOn), offIds = ids.filter(id => !isOn(id));
  sel.replaceChildren(...[onIds.length ? group('viz.layersOn', onIds) : null, offIds.length ? group('viz.layersOff', offIds) : null]
    .filter((g): g is HTMLOptGroupElement => !!g));
  if (layer) sel.value = layer;
}

/** A small picture of the template, drawn with CSS (no image is fetched). */
function thumb(id: string): HTMLElement {
  const n = id === 'density' ? 7 : 5;
  const box = el('span', { class: 'tv-thumb', 'data-t': id, 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) box.append(el('i'));
  return box;
}

function renderGallery() {
  const box = q('.tv-gallery');
  box.setAttribute('aria-label', t('viz.gallery'));
  const fits = layer ? templatesFor(layer) : [];
  box.replaceChildren(...fits.map(d => {
    const b = el('button', { type: 'button', class: 'tv-card', 'data-template': d.id, 'aria-pressed': String(d.id === tplId) },
      thumb(d.id),
      el('span', { class: 'tv-card-text' },
        el('span', { class: 'tv-card-name' }, t(d.nameKey)),
        el('span', { class: 'tv-card-desc' }, t(`viz.desc.${d.id}`))));
    b.addEventListener('click', () => {
      if (tplId === d.id) return;
      tplId = d.id;
      form = null;
      for (const c of box.querySelectorAll('.tv-card')) c.setAttribute('aria-pressed', String(c === b));
      renderForm();
    });
    return b;
  }));
  if (!fits.length) box.append(tx('p', 'viz.noTemplates', undefined, { class: 'tv-note' }));
}

function select(key: string, cls: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const s = el('select', { class: cls });
  s.append(...options.map(([v, label]) => new Option(label, v)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return el('label', { class: 'tv-field' }, el('span', {}, t(key)), s);
}

function renderForm() {
  const box = q('.tv-form');
  box.replaceChildren();
  if (!layer || !tplId) return;
  const def = templateById(tplId)!;
  const c = formChoices(def, layer);
  if (!c) return;
  const id = layer;
  form ??= defaults(def, c, id);
  const f = form;
  const fields: HTMLElement[] = [];
  const none: [string, string] = ['', t('template.none')];
  if (def.params.by && c.by.length) {
    const opts = c.by.map(x => [x.name, fieldLabel(x)] as [string, string]);
    fields.push(select(def.id === 'timeline' ? 'viz.stackBy' : 'viz.by', 'tv-by', def.params.by.required ? opts : [none, ...opts], f.by, v => { f.by = v; }));
  }
  let split: HTMLElement | null = null;
  const splitOpts = () => c.split.filter(x => x.name !== f.by).map(x => [x.name, fieldLabel(x)] as [string, string]);
  if (def.params.split && splitOpts().length) {
    if (!splitOpts().some(([n]) => n === f.split)) f.split = splitOpts()[0][0];
    split = select(def.id === 'flow' ? 'viz.flowInto' : def.id === 'pies-per-region' ? 'viz.pieRegion' : 'viz.split', 'tv-split', splitOpts(), f.split, v => { f.split = v; });
    fields.push(split);
  }
  // split never holds by's field: a by change rebuilds split's options.
  const syncSplit = () => {
    const s = split?.querySelector('select');
    if (!s) return;
    const opts = splitOpts();
    if (!opts.some(([n]) => n === f.split)) f.split = opts[0]?.[0] ?? '';
    s.replaceChildren(...opts.map(([v, label]) => new Option(label, v)));
    s.value = f.split;
  };
  fields.find(x => x.querySelector('.tv-by'))?.querySelector('select')?.addEventListener('change', syncSplit);
  if (def.params.layer2 && c.layer2.length) fields.push(...nearestFields(c.layer2, f));
  if (def.params.time && c.time.length) {
    const opts = c.time.map(x => [x.name, fieldLabel(x)] as [string, string]);
    fields.push(select(def.params.time.required ? 'viz.time' : 'viz.race', 'tv-time', def.params.time.required ? opts : [none, ...opts], f.time, v => {
      f.time = v;
      syncMode();
    }));
  }
  if (c.measure.length > 1) {
    fields.push(select('viz.measure', 'tv-measure', c.measure.map(m => [m.name, measureLabel(m.name, m.unit)]), f.measure, v => { f.measure = v; }));
  }
  if (def.params.by && def.params.top) {
    const n = el('input', { type: 'number', class: 'tv-top', min: String(TOP_MIN), max: String(TOP_MAX), step: '1', inputmode: 'numeric' });
    n.value = String(f.top);
    n.addEventListener('change', () => {
      const v = Math.round(Number(n.value));
      f.top = Number.isFinite(v) ? Math.min(TOP_MAX, Math.max(TOP_MIN, v)) : TOP_DEFAULT;
      n.value = String(f.top);
    });
    fields.push(el('label', { class: 'tv-field' }, el('span', {}, t('viz.top')), n));
  }
  if (def.params.measure?.binned) {
    const opts: [string, string][] = [['0', t('viz.bucketsAuto')], ...[5, 10, 20, 40].map(n => [String(n), String(n)] as [string, string])];
    fields.push(select('viz.buckets', 'tv-buckets', opts, String(f.buckets), v => { f.buckets = Number(v); }));
  }
  let mode: HTMLElement | null = null;
  if (def.params.mode && c.net) {
    mode = select('viz.mode', 'tv-mode', [['additions', t('viz.modeAdditions')], ['net', t('viz.modeNet')]], f.mode, v => { f.mode = v as FormState['mode']; });
    mode.classList.add('tv-field--wide');
    fields.push(mode);
  }
  const syncMode = () => { if (mode) mode.hidden = !netOpen(); };
  syncMode();
  const show = el('button', { type: 'button', class: 'td-btn tv-show' }, t('viz.show'));
  show.addEventListener('click', () => { void showFromForm(); });
  box.append(
    el('div', { class: 'tv-fields' }, ...fields),
    el('div', { class: 'tv-scope' }),
    el('div', { class: 'tv-actions' }, show),
    el('p', { class: 'tv-status', role: 'status' }));
  renderScope();
}

/** nearest's form: the second layer, one condition on it, the threshold in the visitor's distance unit. */
function nearestFields(layers: string[], f: FormState): HTMLElement[] {
  const condBox = el('div', { class: 'tv-field tv-field--wide tv-cond' });
  const renderCond = () => {
    const fs = condFields(f.layer2);
    if (!fs.some(([n]) => n === f.cond.field)) f.cond = { field: '', op: '>=', value: '' };
    const d = fs.find(([n]) => n === f.cond.field)?.[1];
    const field = el('select', { class: 'tv-cond-field', 'aria-label': t('viz.where2') });
    field.append(new Option(t('template.none'), ''), ...fs.map(([n]) => new Option(fieldLabel(rolesOf(f.layer2)?.fields.find(x => x.name === n) ?? { name: n }), n)));
    field.value = f.cond.field;
    field.addEventListener('change', () => { f.cond = { field: field.value, op: f.cond.op, value: '' }; renderCond(); });
    const parts: HTMLElement[] = [el('span', {}, t('viz.where2')), field];
    if (d) {
      const ops = COND_OPS.filter(o => d.ops.includes(o));
      if (!ops.includes(f.cond.op)) f.cond.op = ops[0];
      const op = el('select', { class: 'tv-cond-op', 'aria-label': t('viz.condOp') });
      op.append(...ops.map(o => new Option(COND_OP_TEXT[o], o)));
      op.value = f.cond.op;
      op.addEventListener('change', () => { f.cond.op = op.value as FieldOp; });
      let value: HTMLInputElement | HTMLSelectElement;
      if (d.values?.length) {
        value = el('select', { class: 'tv-cond-value', 'aria-label': t('viz.condValue') });
        value.append(...d.values.map(v => new Option(v, v)));
        if (!d.values.includes(f.cond.value)) f.cond.value = d.values[0];
        value.value = f.cond.value;
      } else {
        value = el('input', { class: 'tv-cond-value', 'aria-label': t('viz.condValue'), ...(d.type === 'number' && { type: 'number', inputmode: 'decimal' }) });
        value.value = f.cond.value;
      }
      value.addEventListener('change', () => { f.cond.value = value.value; });
      parts.push(op, value);
    }
    condBox.replaceChildren(...parts);
  };
  const layer2 = select('viz.layer2', 'tv-layer2', layers.map(id => [id, t(layerById(id)!.titleKey)]), f.layer2, v => { f.layer2 = v; renderCond(); renderScope(); });
  renderCond();
  const mi = getUnits().distance === 'mi';
  const within = el('input', { type: 'number', class: 'tv-within', step: 'any', inputmode: 'decimal',
    min: String(mi ? WITHIN_MIN / MI_KM : WITHIN_MIN), max: String(mi ? WITHIN_MAX / MI_KM : WITHIN_MAX) });
  const shownValue = (km: number) => String(Math.round((mi ? km / MI_KM : km) * 10) / 10);
  within.value = shownValue(f.within);
  within.addEventListener('change', () => {
    const v = Number(within.value) * (mi ? MI_KM : 1);
    f.within = Number.isFinite(v) && within.value.trim() ? Math.min(WITHIN_MAX, Math.max(WITHIN_MIN, v)) : WITHIN_DEFAULT;
    within.value = shownValue(f.within);
  });
  return [layer2, condBox, el('label', { class: 'tv-field' }, el('span', {}, t('viz.within', { unit: unitLabel('distance') })), within)];
}

/** What the template will read: the current view (tiled), the Area, or the whole layer. */
function renderScope() {
  const box = root?.querySelector<HTMLElement>('.tv-scope');
  const show = root?.querySelector<HTMLButtonElement>('.tv-show');
  if (!box || !show || !layer || !form) return;
  const id = layer, f = form;
  const name = t(layerById(id)!.titleKey);
  box.replaceChildren();
  let ready = true;
  if (isTiled(id)) {
    if (isOn(id)) box.append(tx('p', 'viz.scopeView', undefined, { class: 'tv-note' }));
    else {
      ready = false;
      const on = el('button', { type: 'button', class: 'td-btn tv-switch-on' }, t('viz.switchOnBtn'));
      on.addEventListener('click', () => {
        setLayerVisibility(id, true);
        root?.querySelector<HTMLButtonElement>('.tv-show')?.focus();
      });
      box.append(el('p', { class: 'tv-note tv-off' }, t('viz.switchOn', { layer: name }), ' ', on));
    }
  } else {
    const area = areaFor(id);
    if (area) {
      const cb = el('input', { type: 'checkbox', class: 'tv-in-area' });
      cb.checked = f.inArea;
      cb.addEventListener('change', () => { f.inArea = cb.checked; });
      const label = el('span', {}, t('viz.inArea', { area: areaNames(area) }));
      box.append(el('label', { class: 'tv-note tv-area' }, cb, ' ', label));
      if (!areaLabelsNow()) void loadAreaLabels().then(() => { if (label.isConnected) label.textContent = t('viz.inArea', { area: areaNames(area) }); });
    } else if (coverageFor(id, f)) {
      const cb = el('input', { type: 'checkbox', class: 'tv-in-area' });
      cb.checked = f.inArea;
      cb.addEventListener('change', () => { f.inArea = cb.checked; });
      box.append(el('label', { class: 'tv-note tv-area' }, cb, ' ', el('span', {}, t('template.near.usOnly', { layer: t(layerById(f.layer2)!.titleKey) }))));
    } else box.append(tx('p', 'viz.scopeAll', undefined, { class: 'tv-note' }));
  }
  if (state.where[id]?.length) box.append(tx('p', 'viz.whereNote', undefined, { class: 'tv-note' }));
  show.disabled = !ready || busy;
}

function setStatus(text: string, kind: 'info' | 'error' = 'info') {
  const s = root?.querySelector<HTMLElement>('.tv-status');
  if (!s) return;
  s.textContent = text;
  s.dataset.kind = kind;
}

/** A refusal or a frame category as words for the visitor. */
function reasonText(reason: string): string {
  const key = `canvas.error.${reason}`;
  return t('viz.failed', { reason: t(key) !== key ? t(key) : reason });
}

// ─── Showing ─────────────────────────────────────────────────────────────────
/** The gallery's render host: a template card, placed by `place`. */
function host(place: (card: HTMLElement) => boolean) {
  return {
    render: (kind: CanvasKind, title: string, payload: unknown, inputs?: unknown, extra?: RenderExtra): Promise<CanvasOutcome> => {
      const tpl = extra?.template;
      const entry: VizCard | null = tpl ? { templateId: tpl.templateId, layer: tpl.layer, params: tpl.params, title } : null;
      const card = canvasCard(title, { kind, payload, inputs }, {
        csv: extra?.csv, partial: extra?.partial, table: extra?.table, template: true, onAction: extra?.onAction, signals: extra?.signals, overlay: extra?.overlay,
        ...(entry && { rerun: (el: HTMLElement) => rerunCard(entry, el) }),
      });
      if (entry) entries.set(card.el, entry);
      if (!place(card.el)) return Promise.resolve({ error: 'unavailable' as const });
      trimCards();
      drawerChanged();
      return card.done;
    },
  };
}

/** At most MAX_VIZ_CARDS live cards: each older one is collapsed to a Re-run
 *  placeholder holding only its {templateId, layer, params, title}. */
function trimCards() {
  const box = q('.tv-cards');
  for (const old of [...box.children].slice(MAX_VIZ_CARDS)) {
    if (old.classList.contains('chat-canvas-restored')) continue;
    const c = entries.get(old);
    if (c) old.before(placeholder(c, old.getAttribute('data-kind') === 'html' ? 'html' : 'vega').card);
    old.querySelector<HTMLButtonElement>('.chat-canvas-close')?.click();
    old.remove();
  }
}

/** Show a card again through showTemplate with its params, in place of `card`; null when shown, else the reason. */
async function rerunCard(c: VizCard, card: HTMLElement): Promise<string | null> {
  if (!card.isConnected) return null;
  if (isTiled(c.layer)) await mapIdle();
  const r = await showTemplate({ ...c.params, template: c.templateId, layer: c.layer },
    host(live => { if (!card.isConnected) return false; card.replaceWith(live); return true; }));
  return r.ok ? null : reasonText(r.reason);
}

async function showFromForm(): Promise<void> {
  const args = formArgs();
  if (!args || busy) return;
  busy = true;
  renderScope();
  setStatus(t('viz.drawing'));
  try {
    if (isTiled(args.layer as string)) await mapIdle();
    const r = await showTemplate(args, host(card => { q('.tv-cards').prepend(card); return true; }));
    setStatus(r.ok ? '' : reasonText(r.reason), r.ok ? 'info' : 'error');
  } finally {
    busy = false;
    renderScope();
  }
}

/** A restored card and its Re-run, which shows it again through showTemplate with its params. */
function placeholder(c: VizCard, kind: CanvasKind): { card: HTMLElement; run: () => Promise<void> } {
  const again = tx('button', 'canvas.rerun', undefined, { type: 'button', class: 'td-btn chat-canvas-rerun' });
  const close = el('button', { type: 'button', class: 'td-icon chat-canvas-close', 'aria-label': t('canvas.close'), title: t('canvas.close') }, '×');
  const why = el('p', { class: 'chat-canvas-error', role: 'status' });
  const card = el('figure', { class: 'chat-canvas chat-canvas-restored', 'data-kind': kind, 'data-template': '' },
    el('div', { class: 'chat-canvas-head' }, tx('span', 'canvas.template', undefined, { class: 'chat-canvas-label' }), close),
    el('figcaption', { class: 'chat-canvas-title' }, c.title),
    el('p', { class: 'chat-canvas-closed' }, tx('span', 'viz.restored'), ' ', again), why);
  entries.set(card, c);
  close.addEventListener('click', () => { card.remove(); drawerChanged(); });
  const run = async () => {
    if (!card.isConnected) return;
    again.disabled = true;
    why.replaceChildren();
    const reason = await rerunCard(c, card);
    if (reason !== null && card.isConnected) { why.textContent = reason; again.disabled = false; }
  };
  again.addEventListener('click', () => { void run(); });
  return { card, run };
}

function snapshot(): VizSnapshot | null {
  if (!root) return null;
  const cards = [...q('.tv-cards').children].flatMap(c => { const e = entries.get(c); return e ? [e] : []; });
  return { layer, cards: cards.slice(0, MAX_VIZ_CARDS) };
}

function renderAll() {
  renderPicker();
  renderGallery();
  renderForm();
}

// ─── Entry points ────────────────────────────────────────────────────────────
export function openVisualize(layerId?: string, from?: HTMLElement | null): void {
  build();
  const first = !vizOpen();
  if (layerId || first || !layer) pickLayer(layerId ?? (layer ?? vizLayers()[0] ?? null));
  openViz(undefined, from);
  renderAll();
  // Focus into the pane: the gallery's picked card when a row asked for a layer, else the picker.
  ((layerId && root!.querySelector<HTMLElement>('.tv-card[aria-pressed="true"]')) || q('.tv-layer')).focus({ preventScroll: true });
}

export async function resumeVisualize(viz: VizSnapshot): Promise<void> {
  build();
  pickLayer(viz.layer);
  openViz(undefined, null);
  renderAll();
  const box = q('.tv-cards');
  const vega: (() => Promise<void>)[] = [];
  for (const c of viz.cards) {
    const v = validateTemplateArgs({ ...c.params, template: c.templateId, layer: c.layer });
    if (!v.ok) continue;
    const p = placeholder(c, v.result.def.kind);
    box.append(p.card);
    if (v.result.def.kind === 'vega') vega.push(p.run);
  }
  // Only into free frame slots (claimRestoreSlots, shared with the chat, which
  // claims first: never an eviction): the newest Vega cards, drawn one at a time
  // oldest first (each scrolls itself into view to draw), and then the stack is
  // back at its top, the newest card. The rest stay Re-run.
  const k = claimRestoreSlots(vega.length);
  const chosen = vega.slice(0, k).reverse();
  void (async () => {
    for (const run of chosen) { try { await run(); } finally { releaseRestoreSlot(); } }
    box.scrollTop = 0;
  })();
}
