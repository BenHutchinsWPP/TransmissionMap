// ─── Add layer from a service — dialog (lazy chunk) ──────────────────────────
// Role: the dialog behind File ▸ "Add layer from a service…" and My Data's
//       button. Two tabs. Library: search, category chips and cards for the
//       curated services (src/registry/service-library.json, loaded by dynamic
//       import), each a title, category · publisher and Add, with the description,
//       licence and source page (new tab) in a collapsed Details;
//       Add commits the entry with its libraryId. Paste URL: the type
//       is detected from the URL alone (parseServiceUrl), a layer can be looked
//       up on request (ArcGIS layer list, WMS capabilities), and a title,
//       colour and opacity give a valid ServiceStyle. A URL that is not on the
//       vetted list shows its host and a warning before anything is fetched
//       (List layers and Add alike); only "Add anyway" approves that URL for
//       the session and runs the action it interrupted. The commit is view-state.ts's
//       addService; its refusal (the service cap and the like) shows inline.
//       The dialog builds its own DOM (#servicesDialog) and every string from
//       a service or the library is set as text only (lint holds this file to
//       the chat's no-HTML rule).
// Deps: state.js, view-state.js (addService), services/service-spec.js,
//       services/service-trust.js
//       (approve, isAllowed), services/service-load.js (capped fetches, detectDrawKind),
//       services/service-render.js (type only), services-dom.ts (el, sourceLink),
//       ui-linked-services.js (redraw after an add), src/i18n/index.js (t),
//       ui-services.css.
// Consumed by ui-menubar.ts and ui-mydata.ts (openServices).

import { state } from '../state.js';
import { addService } from '../view-state.js';
import {
  parseServiceUrl, validateStyle, RASTER_KINDS,
  type LinkedService, type ServiceKind, type ServiceSpec, type ServiceStyle,
} from '../services/service-spec.js';
import { approve, isAllowed } from '../services/service-trust.js';
import {
  fetchJson, fetchText, detectDrawKind, envelopeError,
  META_MAX_BYTES, META_TIMEOUT_MS,
} from '../services/service-load.js';
import type { LibraryEntry } from '../services/service-render.js';
import { t } from '../../src/i18n/index.js';
import { el, sourceLink } from './services-dom.js';
import './ui-services.css';

type Entry = LibraryEntry & { style: ServiceStyle; version?: '1.1.1' | '1.3.0' };

const CATEGORIES = ['boundaries', 'energy', 'environment', 'hazards', 'imagery', 'land', 'transport', 'weather'];
const MAX_LAYER_CHOICES = 200;
// A WMS layer name the spec accepts and that names exactly one layer.
const WMS_LAYER = /^[A-Za-z0-9_:.\- ]{1,256}$/;

let library: Entry[] | null = null;
let category = '';
let query = '';
let tab: 'library' | 'paste' = 'library';
let urlInput: HTMLInputElement;
// The action the unvetted warning interrupted; the warning's confirm runs it.
let blocked: (() => Promise<void>) | null = null;

const newId = () => {
  for (;;) {
    const id = 'sv' + Math.random().toString(36).slice(2, 10);
    if (!state.services.some(s => s.id === id)) return id;
  }
};

function loadLibrary(): Promise<Entry[]> {
  return library
    ? Promise.resolve(library)
    : import('../../src/registry/service-library.json').then(m => (library = m.default as unknown as Entry[]));
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(message: string) {
  const box = $('svcError');
  box.textContent = message;
  box.hidden = !message;
}

// ─── dialog shell ────────────────────────────────────────────────────────────

function build(): HTMLDialogElement {
  const dialog = el('dialog', { class: 'credits-dialog experiences-dialog svc-dialog', id: 'servicesDialog' });
  const close = el('button', { type: 'button', id: 'closeServices', 'aria-label': t('common.close') }, '×');
  const tabs = el('div', { class: 'svc-tabs', role: 'tablist' },
    el('button', { type: 'button', role: 'tab', 'data-svc-tab': 'library' }, t('services.tab.library')),
    el('button', { type: 'button', role: 'tab', 'data-svc-tab': 'paste' }, t('services.tab.paste')));
  const search = el('input', {
    id: 'svcSearch', class: 'exp-search', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: t('services.search'),
  });
  urlInput = el('input', {
    id: 'svcUrl', class: 'exp-search', type: 'url', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'https://…/FeatureServer/0', 'aria-label': t('services.url.label'),
  });
  const drawAs = el('select', { id: 'svcDrawAs' },
    el('option', { value: 'auto' }, t('services.draw.auto')),
    el('option', { value: 'fill' }, t('services.draw.fill')),
    el('option', { value: 'line' }, t('services.draw.line')),
    el('option', { value: 'circle' }, t('services.draw.circle')));
  const field = (label: string, input: HTMLElement, id: string) =>
    el('label', { class: 'svc-field', id }, el('span', {}, label), input);
  const paste = el('div', { id: 'svcPaste', hidden: '' },
    el('label', { class: 'svc-field' }, el('span', {}, t('services.url.label')), urlInput),
    el('p', { id: 'svcDetected', class: 'svc-detected', role: 'status' }),
    field(t('services.layer.label'), el('span', { class: 'svc-layer-row' },
      el('input', { id: 'svcLayer', type: 'text', list: 'svcLayerChoices', autocomplete: 'off' }),
      el('datalist', { id: 'svcLayerChoices' }),
      el('button', { type: 'button', class: 'svc-btn', id: 'svcFindLayers' }, t('services.layer.find'))), 'svcLayerField'),
    el('p', { id: 'svcLayerNote', class: 'svc-detected' }),
    field(t('services.titleField'), el('input', { id: 'svcTitle', type: 'text', maxlength: '200' }), 'svcTitleField'),
    field(t('services.draw.label'), drawAs, 'svcDrawField'),
    field(t('services.colour'), el('input', { id: 'svcColour', type: 'color', value: '#2b6cb0' }), 'svcColourField'),
    field(t('services.opacity'), el('input', { id: 'svcOpacity', type: 'range', min: '0.1', max: '1', step: '0.05', value: '0.8' }), 'svcOpacityField'),
    el('div', { id: 'svcWarn', class: 'svc-warn', role: 'alert', hidden: '' },
      el('p', { id: 'svcWarnText' }),
      el('button', { type: 'button', class: 'svc-btn svc-btn--primary', id: 'svcAddAnyway' }, t('services.addAnyway')),
      el('button', { type: 'button', class: 'svc-btn', id: 'svcWarnCancel' }, t('services.cancel'))),
    el('button', { type: 'button', class: 'svc-btn svc-btn--primary', id: 'svcAddPasted' }, t('services.add')));
  dialog.append(el('div', { class: 'credits-content' },
    el('div', { class: 'credits-header' }, el('h2', {}, t('services.title')), close),
    tabs,
    el('p', { id: 'svcError', class: 'svc-error', role: 'alert', hidden: '' }),
    el('div', { id: 'svcLibrary' }, search,
      el('div', { id: 'svcChips', class: 'svc-chips' }), el('div', { id: 'svcCards' })),
    paste));
  document.body.append(dialog);

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  tabs.addEventListener('click', e => {
    const which = (e.target as Element).closest<HTMLElement>('[data-svc-tab]')?.dataset.svcTab;
    if (which === 'library' || which === 'paste') { tab = which; showTab(); }
  });
  search.addEventListener('input', () => { query = search.value.trim(); void renderLibrary(); });
  $('svcChips').addEventListener('click', e => {
    const chip = (e.target as Element).closest<HTMLElement>('[data-svc-cat]');
    if (chip) { category = chip.dataset.svcCat ?? ''; void renderLibrary(); }
  });
  $('svcCards').addEventListener('click', e => {
    const id = (e.target as Element).closest<HTMLElement>('[data-svc-add]')?.dataset.svcAdd;
    const entry = library?.find(x => x.id === id);
    if (entry) addEntry(entry);
  });
  urlInput.addEventListener('input', onUrlInput);
  $('svcFindLayers').addEventListener('click', () => guarded(findLayers));
  $('svcAddPasted').addEventListener('click', () => guarded(addPasted));
  $('svcAddAnyway').addEventListener('click', () => {
    const run = blocked;
    blocked = null;
    $('svcWarn').hidden = true;
    if (!spec || !run) return;
    approve(spec.url);
    void run();
  });
  $('svcWarnCancel').addEventListener('click', () => { blocked = null; $('svcWarn').hidden = true; });
  return dialog;
}

function showTab() {
  $('svcLibrary').hidden = tab !== 'library';
  $('svcPaste').hidden = tab !== 'paste';
  document.querySelectorAll<HTMLElement>('#servicesDialog [data-svc-tab]').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.svcTab === tab)));
  showError('');
}

export function openServices(which: 'library' | 'paste' = 'library'): void {
  const dialog = ($('servicesDialog') as HTMLDialogElement | null) ?? build();
  tab = which;
  showTab();
  void renderLibrary();
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
}

function closeDialog() {
  const dialog = $('servicesDialog') as HTMLDialogElement;
  if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  void import('./ui-linked-services.js').then(m => m.renderLinkedServices());
}

// ─── library ─────────────────────────────────────────────────────────────────

const catLabel = (c: string) => t('services.cat.' + c);

function matches(e: Entry): boolean {
  if (category && e.category !== category) return false;
  const hay = [e.title, e.category, catLabel(e.category), e.host, e.description].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(term => hay.includes(term));
}

function swatch(style: ServiceStyle): HTMLElement {
  const sw = el('span', { class: `svc-sw svc-sw--${style.kind}`, 'aria-hidden': 'true' });
  sw.style.setProperty('--svc-c', style.color);
  sw.style.setProperty('--svc-o', String(style.opacity));
  return sw;
}

async function renderLibrary() {
  let entries: Entry[];
  try { entries = await loadLibrary(); } catch { showError(t('services.err.library')); return; }
  const chips = document.getElementById('svcChips');
  if (!chips) return;
  chips.replaceChildren(...['', ...CATEGORIES].map(c =>
    el('button', { type: 'button', class: 'svc-chip', 'data-svc-cat': c, 'aria-pressed': String(c === category) },
      c ? catLabel(c) : t('services.cat.all'))));
  const hits = entries.filter(matches);
  const cards = $('svcCards');
  if (!hits.length) {
    cards.replaceChildren(el('p', { class: 'exp-empty' }, t('services.noMatch', { query })));
    return;
  }
  cards.replaceChildren(el('div', { class: 'exp-grid svc-grid' }, ...hits.map(card)));
}

// A card: swatch, title and Add on one line, then category · publisher (the
// credit, two lines at most); the description, licence and source page wait
// in a collapsed Details.
function card(e: Entry): HTMLElement {
  const body = el('div', { class: 'svc-details-body' },
    el('p', {}, e.description),
    el('p', {}, t('services.licence', { licence: e.licence })));
  const link = sourceLink(e.source, t('services.source'));
  if (link) body.append(el('p', {}, link));
  return el('div', { class: 'exp-card svc-card-lib' },
    el('div', { class: 'svc-card-head' }, swatch(e.style), el('span', { class: 'exp-card-title' }, e.title),
      el('button', { type: 'button', class: 'svc-btn svc-btn--primary', 'data-svc-add': e.id,
        'aria-label': `${t('services.add')}: ${e.title}` }, t('services.add'))),
    el('div', { class: 'svc-meta svc-meta--clamp', title: e.credit }, `${catLabel(e.category)} · ${e.credit}`),
    el('details', { class: 'svc-details' }, el('summary', {}, t('services.details')), body));
}

function addEntry(e: Entry) {
  const svc: LinkedService = {
    id: newId(), kind: e.kind, url: e.url, host: e.host, title: e.title, style: e.style,
    visible: true, libraryId: e.id, credit: e.credit,
  };
  if (e.layer !== undefined) svc.layer = e.layer;
  if (e.version) svc.version = e.version;
  commit(svc);
}

function commit(svc: LinkedService) {
  const err = addService(svc);
  if (err) { showError(err); return; }
  showError('');
  closeDialog();
}

// ─── paste a URL ─────────────────────────────────────────────────────────────

const LAYERED: ReadonlySet<ServiceKind> = new Set(['arcgis-feature', 'arcgis-export', 'wms']);
let spec: ServiceSpec | null = null;

function onUrlInput() {
  $('svcWarn').hidden = true;
  blocked = null;
  showError('');
  $('svcLayerNote').textContent = '';
  $('svcLayerChoices').replaceChildren();
  const v = urlInput.value.trim();
  const out = $('svcDetected');
  spec = null;
  out.classList.remove('svc-detected--bad');
  if (!v) { out.textContent = ''; updateFields(); return; }
  const r = parseServiceUrl(v);
  if (!r.ok) {
    out.textContent = r.reason;
    out.classList.add('svc-detected--bad');
    updateFields();
    return;
  }
  spec = r.result;
  out.textContent = t('services.detected', { kind: t('services.kind.' + spec.kind), host: spec.host });
  $<HTMLInputElement>('svcLayer').value = spec.layer ?? '';
  $<HTMLInputElement>('svcTitle').placeholder = spec.host;
  updateFields();
}

function updateFields() {
  const raster = !!spec && RASTER_KINDS.has(spec.kind);
  $('svcLayerField').hidden = !spec || !LAYERED.has(spec.kind);
  $('svcDrawField').hidden = !spec || raster;
  $('svcColourField').hidden = !spec || raster;
  $('svcTitleField').hidden = !spec;
  $('svcOpacityField').hidden = !spec;
  $('svcAddPasted').hidden = !spec;
}

/** The one gate before any contact with a pasted URL: an unvetted, unapproved host gets the warning first. */
function guarded(run: () => Promise<void>) {
  if (!spec) return;
  if (!isAllowed(spec)) {
    blocked = run;
    $('svcWarnText').textContent = t('services.unvetted.warn', { host: spec.host });
    $('svcWarn').hidden = false;
    return;
  }
  void run();
}

async function findLayers() {
  if (!spec) return;
  const note = $('svcLayerNote');
  const list = $('svcLayerChoices');
  list.replaceChildren();
  note.textContent = t('services.layer.finding');
  const names: { value: string; label: string }[] = [];
  if (spec.kind === 'wms') {
    const v = spec.version ? `&version=${spec.version}` : '';
    const r = await fetchText(`${spec.url}?service=WMS&request=GetCapabilities${v}`, META_MAX_BYTES, META_TIMEOUT_MS);
    if (!r.ok) { note.textContent = r.reason; return; }
    // Layer names read straight from the XML text; it is never parsed as markup.
    const body = r.result.replace(/<Style\b[\s\S]*?<\/Style>/g, '');
    for (const chunk of body.split(/<Layer\b[^>]*>/).slice(1)) {
      const name = /<Name>([^<]*)<\/Name>/.exec(chunk.split(/<Layer\b/)[0])?.[1]?.trim();
      if (name && WMS_LAYER.test(name)) names.push({ value: name, label: name });
    }
  } else {
    const r = await fetchJson(`${spec.url}?f=json`, META_MAX_BYTES, META_TIMEOUT_MS);
    if (!r.ok) { note.textContent = r.reason; return; }
    const bad = envelopeError(r.result);
    if (bad) { note.textContent = bad; return; }
    const layers = (r.result as { layers?: unknown }).layers;
    for (const l of Array.isArray(layers) ? layers : []) {
      const { id, name } = l as { id?: unknown; name?: unknown };
      if (typeof id === 'number' && Number.isInteger(id) && id >= 0) names.push({ value: String(id), label: typeof name === 'string' ? name : '' });
    }
  }
  const shown = names.slice(0, MAX_LAYER_CHOICES);
  note.textContent = shown.length ? t('services.layer.found', { count: shown.length }) : t('services.layer.none');
  for (const n of shown) list.append(el('option', { value: n.value, label: n.label }));
}

async function addPasted() {
  if (!spec) return;
  const s: ServiceSpec = { ...spec };
  const layer = $<HTMLInputElement>('svcLayer').value.trim();
  if (!$('svcLayerField').hidden && layer) s.layer = layer;
  if ((s.kind === 'wms' || s.kind === 'arcgis-feature') && !s.layer) { showError(t('services.err.needLayer')); return; }
  let kind: ServiceStyle['kind'] = 'raster';
  if (!RASTER_KINDS.has(s.kind)) {
    const pick = $<HTMLSelectElement>('svcDrawAs').value;
    const found = pick === 'auto' ? await detectDrawKind(s) : pick;
    if (found !== 'fill' && found !== 'line' && found !== 'circle') { showError(found); return; }
    kind = found;
  }
  const style: ServiceStyle = { kind, color: $<HTMLInputElement>('svcColour').value, opacity: Number($<HTMLInputElement>('svcOpacity').value) };
  if (kind === 'line') style.width = 2;
  if (kind === 'circle') style.radius = 4;
  const v = validateStyle(style);
  if (!v.ok) { showError(v.reason); return; }
  commit({
    ...s, id: newId(), title: $<HTMLInputElement>('svcTitle').value.trim() || s.host,
    style: v.result, visible: true, credit: s.host,
  });
}
