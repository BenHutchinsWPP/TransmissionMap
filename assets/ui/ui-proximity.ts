// ─── Proximity check: the drawer's Proximity tab (lazy chunk) ────────────────
// Role: Tools ▸ Proximity (through proximity-open.ts). The visitor picks a CSV of
//       points, names its columns (user-data-csv.ts pickCsvPoints, with an optional ID
//       column), sets a distance threshold (ft / mi / m / km, converted once to km,
//       0.01–1,000 km) and sees which points lie within it of another, grouped
//       transitively (proximity/proximity.ts). Two views over the same file:
//         Groups  only points in a group, ordered by group, nearest distance, CSV row.
//         Pairs   every pair within the threshold (proximity/pairs-open.ts worker, on
//                 demand, with a progress line and Cancel; stops at MAX_PAIRS and says so).
//       Both have a CSV download (the groups CSV: user-data-export.ts toCsv, formula-guarded; the
//       pairs CSV: built in proximity/csv-open.ts's worker as a Blob of chunks of ≤ 10,000 rows
//       with progress and Cancel, one download at a time, refused above 200 MB of UTF-8).
//       Distances show in the threshold's unit. Files over 50 MB are refused before reading, over
//       100,000 rows right after parsing (before the column dialog).
//   Try a sample: HIFLD substations (static copy) in the current map view, downloaded, unzipped
//       and cut to the view's box in proximity/sample-open.ts's worker (≤ 15,000; "zoom in" above,
//       "none in view" at 0), then the same path as a file (threshold 1 mi, name and id from the
//       substation's own fields), with the HIFLD credit under the legend. Session only, like a file.
//   Grid: its own Tabulator grid (a renderer only: cells and titles are text nodes made by
//   formatters, rows are `{_i}` and the formatters read the arrays). Each column is a ProxCol (proximity-rows.ts);
//   every header holds a sort button (▲/▼, aria-sort) above a filter box (contains, 200 ms debounce), and sort and
//   filter run here over the arrays in memory (Tabulator's Sort and Filter modules are never registered). They
//   are kept per view across a threshold or unit change and reset on a new file. Columns are rebuilt only when
//   `colsKey` changes and rows only when `rowsKey` does, so typing keeps focus. The CSVs ignore sort and filter.
//   A dragged cell range (SelectRange; the px grid forces a redraw only when it goes from 0 px to visible, since a forced
//   redraw clears the range) copies on Ctrl/Cmd+C as TSV with a header line (rangeTsvOf, grid-copy.ts copyText); Enter does not fly.
//   Privacy: the file never leaves the browser. No storage, no URL, no undo step, nothing in
//   tm-drawer, and no value from the file reaches the diagnostics log, an error text or the
//   console. Closing the tab drops every reference to the file and cancels the pairs.
//   Seam for the map half: proxState(), onProxResult(cb), onProxRow(cb) (a row click: select), onProxFly(cb) (the row's ↗
//   button: select, then zoom), focusPoint(i); the map half is proximity-map.ts (bubbles and points on the map,
//   started on first open). A row click marks the row and outlines its point; only the ↗ button moves the camera.
// Deps: ui-table.ts (openProx, proxPanel, drawerPadding; closing runs drop()), proximity-map.ts, proximity-rows.ts, proximity/proximity.ts, proximity/pairs-open.ts,
//       user-data/user-data-csv.ts (pickCsvPoints), user-data/user-data-export.ts (toCsv, downloadFile),
//       proximity/csv-open.ts, proximity/sample-open.ts (workers), state.ts (map bounds), constants.ts (DATA),
//       registry/sources.ts (HIFLD_CREDIT),
//       state-bus.ts (on: lang:changed), src/units.ts (getUnits), i18n (t, getLocale), tabulator-tables.
//       Loaded by: proximity-open.ts (dynamic import).

import { Tabulator, type CellComponent, type ColumnDefinition } from 'tabulator-tables';
import { on } from '../state-bus.js';
import { openProx, proxPanel, drawerPadding } from './ui-table.js';
import { startProximityMap } from './proximity-map.js';
import { rankOf, viewOrder, rangeTsvOf, numberFormat, type ProxCol, type Sort } from './proximity-rows.js';
import { proximityGroups, MAX_PAIRS, type ProximityResult, type PairsResult } from '../proximity/proximity.js';
import { runPairs, cancelPairs } from '../proximity/pairs-open.js';
import { runPairsCsv, cancelCsv } from '../proximity/csv-open.js';
import { CSV_CHUNK, MAX_CSV_BYTES, type PairsCsvInput } from '../proximity/pairs-csv.js';
import { runSample, cancelSample } from '../proximity/sample-open.js';
import { viewBox, SAMPLE_CAP, SAMPLE_FIELDS } from '../proximity/sample.js';
import { GRID_RANGE_DEFAULTS, isCopyKey, copyText } from './grid-copy.js';
import { state } from '../state.js';
import { DATA } from '../constants.js';
import { HIFLD_CREDIT } from '../../src/registry/sources.js';
import { pickCsvPoints } from '../user-data/user-data-csv.js';
import { toCsv, downloadFile } from '../user-data/user-data-export.js';
import { getUnits } from '../../src/units.js';
import { t, getLocale } from '../../src/i18n/index.js';
import './ui-proximity.css';

export type Unit = 'ft' | 'mi' | 'm' | 'km';
export const UNITS: readonly Unit[] = ['ft', 'mi', 'm', 'km'];
export const UNIT_KM: Record<Unit, number> = { ft: 0.0003048, mi: 1.609344, m: 0.001, km: 1 };
export const MIN_KM = 0.01;
export const MAX_KM = 1000;
export const MAX_FILE_BYTES = 50 * 1048576;
export const MAX_POINTS = 100_000;
export { CSV_CHUNK, MAX_CSV_BYTES };

/** The threshold in km, or null when it is not a number above 0 or outside 0.01–1,000 km. */
export function thresholdKm(value: number, unit: Unit): number | null {
  const km = value * UNIT_KM[unit];
  return Number.isFinite(km) && km >= MIN_KM && km <= MAX_KM ? km : null;
}

/** Trimmed non-empty ids → ints in order of first appearance; the rest -1. */
export function internIds(values: readonly string[]): Int32Array {
  const seen = new Map<string, number>();
  const out = new Int32Array(values.length);
  values.forEach((raw, i) => {
    const v = raw.trim();
    if (!v) { out[i] = -1; return; }
    let n = seen.get(v);
    if (n === undefined) { n = seen.size; seen.set(v, n); }
    out[i] = n;
  });
  return out;
}

/** Group > 0 points ordered by group, nearest distance, then CSV row. */
export function groupOrder(r: ProximityResult, rowNo: Int32Array): Int32Array {
  const idx: number[] = [];
  for (let i = 0; i < r.group.length; i++) if (r.group[i] > 0) idx.push(i);
  const near = (i: number) => Number.isNaN(r.nearestKm[i]) ? Infinity : r.nearestKm[i];
  idx.sort((a, b) => r.group[a] - r.group[b] || near(a) - near(b) || rowNo[a] - rowNo[b]);
  return Int32Array.from(idx);
}

function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map(n => {
    let u = n, k = 2;
    while (used.has(u)) u = `${n}_${k++}`;
    used.add(u);
    return u;
  });
}

interface Loaded {
  fileName: string;
  cols: { key: string; title: string }[];
  feats: GeoJSON.Feature<GeoJSON.Point>[];
  lon: Float64Array;
  lat: Float64Array;
  rowNo: Int32Array;
  names: string[];
  ids: Int32Array | null;
  idText: string[] | null;
  skipped: number;
  /** the HIFLD sample, not a file: named and credited by the tab */
  sample?: boolean;
}

/** What the map half reads: the points, the threshold and the grouping result. */
export interface ProxState {
  lon: Float64Array;
  lat: Float64Array;
  km: number;
  unit: Unit;
  result: ProximityResult;
  names: string[];
  /** per point: its 1-based CSV data row */
  rowNo: Int32Array;
}

interface Ui {
  root: HTMLElement;
  file: HTMLInputElement;
  choose: HTMLButtonElement;
  fileName: HTMLElement;
  thLabel: HTMLElement;
  th: HTMLInputElement;
  unit: HTMLSelectElement;
  vGroups: HTMLButtonElement;
  vPairs: HTMLButtonElement;
  dlGroups: HTMLButtonElement;
  dlPairs: HTMLButtonElement;
  csvNote: HTMLElement;
  clear: HTMLButtonElement;
  msg: HTMLElement;
  legend: HTMLElement;
  status: HTMLElement;
  prog: HTMLElement;
  progText: HTMLElement;
  cancel: HTMLButtonElement;
  privacy: HTMLElement;
  sample: HTMLButtonElement;
  credit: HTMLElement;
  gridEl: HTMLElement;
  grid: Tabulator;
  built: Promise<void>;
}

let ui: Ui | null = null;
let flyRow: (k: number) => void = () => {};
let focusedPair = -1;
let data: Loaded | null = null;
let res: ProximityResult | null = null;
let km: number | null = null;
let unit: Unit = 'ft';
let order: Int32Array = new Int32Array(0);
let view: 'groups' | 'pairs' = 'groups';
let pairs: PairsResult | null = null;
let pairState: 'idle' | 'running' | 'done' | 'failed' | 'cancelled' = 'idle';
let found = 0;
let pairSeq = 0;
let running: Promise<PairsResult | null> | null = null;
let msgKey: { key: string; params?: Record<string, string | number> } | null = null;
let focused = -1;
/** Sort and filters of each view; kept across a threshold or unit change, reset on a new file and on close. */
interface ViewState { sort: Sort; filters: Map<string, string> }
const fresh = (): Record<'groups' | 'pairs', ViewState> => ({ groups: { sort: null, filters: new Map() }, pairs: { sort: null, filters: new Map() } });
let vstate = fresh();
const cur = (): ViewState => vstate[view];
let cols: ProxCol[] = [];
let copyNote: { key: string; params: Record<string, number | string> } | null = null;
let shown: Int32Array = new Int32Array(0);
let viewBusy = false;
/** Filter text typed but not yet applied: one entry per column, bound to the view it was typed in. */
const pendingFilters = new Map<string, { timer: ReturnType<typeof setTimeout>; vs: ViewState; input: HTMLInputElement }>();
function dropPending() { for (const p of pendingFilters.values()) clearTimeout(p.timer); pendingFilters.clear(); }
function setFilterOn(vs: ViewState, field: string, value: string) {
  if (value.trim()) vs.filters.set(field, value); else vs.filters.delete(field);
}
/** Applies every pending box now, each to the view it was typed in. */
function flushPending() {
  if (!pendingFilters.size) return;
  for (const [field, p] of pendingFilters) { clearTimeout(p.timer); setFilterOn(p.vs, field, p.input.value); }
  pendingFilters.clear();
  if (ui) refreshView();
}
let dlBusy = false;
let csvRows = -1;
let csvTotal = 0;
let sampleBusy = false;
let sampleSeq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let subscribed = false;
let seen: ResizeObserver | null = null;
const resultCbs = new Set<(s: ProxState | null) => void>();
const rowCbs = new Set<(i: number) => void>();
const flyCbs = new Set<(i: number) => void>();

const fmt = (n: number, digits = 0) => numberFormat(getLocale(), digits).format(n);
const dist = (kmv: number) => Number.isNaN(kmv) ? '' : fmt(kmv / UNIT_KM[unit], unit === 'ft' || unit === 'm' ? 1 : 3);
const distNum = (kmv: number) => Number.isNaN(kmv) ? '' : Math.round(kmv / UNIT_KM[unit] * 1000) / 1000;

// ─── Seam for the map half ───────────────────────────────────────────────────
export function proxState(): ProxState | null {
  return data && res && km !== null
    ? { lon: data.lon, lat: data.lat, km, unit, result: res, names: data.names, rowNo: Int32Array.from(data.rowNo, v => v + 1) }
    : null;
}
export function onProxResult(cb: (s: ProxState | null) => void): () => void {
  resultCbs.add(cb);
  return () => { resultCbs.delete(cb); };
}
export function onProxRow(cb: (pointIndex: number) => void): () => void {
  rowCbs.add(cb);
  return () => { rowCbs.delete(cb); };
}
export function onProxFly(cb: (pointIndex: number) => void): () => void {
  flyCbs.add(cb);
  return () => { flyCbs.delete(cb); };
}
const notify = () => { const s = proxState(); for (const cb of [...resultCbs]) cb(s); };

/** Mark a point's row in the Groups view and bring it into view. */
export function focusPoint(i: number): void {
  const prev = focused;
  focused = i;
  if (!ui) return;
  openProx(drop);
  if (view !== 'groups') { setView('groups'); return; }
  const g = ui.grid;
  void ui.built.then(() => {
    markRows(g, prev, i);
    return g.scrollToRow(i, 'center', false);
  }).catch(() => { /* a point outside the groups has no row */ });
}

/** Re-run the row formatter of two rows (the old mark and the new): a forced redraw would clear a range. */
function markRows(g: Tabulator, ...ids: number[]): void {
  for (const id of ids) {
    if (id < 0) continue;
    try { const row = g.getRow(id); if (row) row.reformat(); } catch { /* a row not in the grid */ }
  }
}

// ─── Open / close ────────────────────────────────────────────────────────────
export function openProximity(from?: HTMLElement | null): void {
  openProx(drop, from);
  if (!subscribed) {
    subscribed = true;
    on('lang:changed', () => { if (ui) render(); });
    startProximityMap({ onResult: onProxResult, onRow: onProxRow, onFly: onProxFly, focusPoint, padding: drawerPadding });
  }
  if (!ui) {
    unit = getUnits().distance === 'km' ? 'm' : 'ft';
    ui = build();
    ui.th.value = unit === 'm' ? '1000' : '5280';
    ui.unit.value = unit;
    render();
  }
}

function drop() {
  clearTimeout(timer);
  dropPending();
  copyNote = null; vstate = fresh(); colsKey = null; rowsKey = ''; cols = []; shown = new Int32Array(0); viewBusy = false; pairBase = null; heads.clear();
  pairSeq++;
  sampleSeq++;
  cancelPairs();
  cancelCsv();
  cancelSample();
  running = null;
  data = null; res = null; km = null; pairs = null; pairState = 'idle'; msgKey = null; focused = -1; focusedPair = -1;
  dlBusy = false; csvRows = -1; sampleBusy = false;
  order = new Int32Array(0);
  view = 'groups';
  seen?.disconnect();
  seen = null;
  ui?.grid.destroy();
  proxPanel().replaceChildren();
  ui = null;
  notify();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.append(e);
  return e;
}

function button(cls: string, parent: HTMLElement, click: () => void): HTMLButtonElement {
  const b = el('button', cls, parent);
  b.type = 'button';
  b.addEventListener('click', click);
  return b;
}

function build(): Ui {
  const root = el('div', 'px');
  const privacy = el('p', 'px-privacy', root);
  const bar = el('div', 'px-bar', root);
  const file = el('input', 'px-file');
  file.type = 'file';
  file.accept = '.csv,text/csv';
  file.hidden = true;
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void load(f); });
  bar.append(file);
  const choose = button('td-btn px-choose', bar, () => file.click());
  const sample = button('td-btn px-sample', bar, () => { void trySample(); });
  const fileName = el('span', 'px-filename', bar);
  const thWrap = el('div', 'px-th', bar);
  const thLabel = el('label', 'px-th-label', thWrap);
  const th = el('input', 'px-th-input', thWrap);
  th.type = 'number';
  th.min = '0';
  th.step = 'any';
  th.id = 'px-th';
  thLabel.htmlFor = 'px-th';
  const sel = el('select', 'px-unit', thWrap);
  for (const u of UNITS) sel.append(Object.assign(document.createElement('option'), { value: u, textContent: u }));
  th.addEventListener('input', schedule);
  sel.addEventListener('change', () => {
    const was = unit, v = Number(th.value);
    unit = sel.value as Unit;
    if (th.value.trim() !== '' && Number.isFinite(v)) th.value = String(Number((v * UNIT_KM[was] / UNIT_KM[unit]).toPrecision(6)));
    schedule();
  });
  const views = el('div', 'px-views', bar);
  views.setAttribute('role', 'group');
  const vGroups = button('td-btn px-view', views, () => setView('groups'));
  const vPairs = button('td-btn px-view', views, () => setView('pairs'));
  const dlGroups = button('td-btn px-dl px-dl-groups', bar, () => { void downloadGroups(); });
  const dlPairs = button('td-btn px-dl px-dl-pairs', bar, () => { void downloadPairs(); });
  const csvNote = el('span', 'px-csv-note', bar);
  const msg = el('div', 'px-msg', root);
  msg.setAttribute('role', 'status');
  const legend = el('p', 'px-legend', root);
  const credit = el('p', 'px-credit', root);
  credit.hidden = true;
  const statusRow = el('div', 'px-status-row', root);
  const status = el('div', 'px-status', statusRow);
  const clear = button('td-btn px-clear', statusRow, () => {
    dropPending();
    cur().filters.clear();
    for (const h of heads.values()) { const i = h.b.parentElement?.querySelector<HTMLInputElement>('.px-filter'); if (i) i.value = ''; }
    refreshView();
  });
  clear.hidden = true;
  const prog = el('div', 'px-prog', root);
  const progText = el('span', 'px-prog-text', prog);
  const cancel = button('td-btn px-cancel', prog, () => {
    sampleSeq++; sampleBusy = false; cancelSample();
    cancelCsv(); csvRows = -1;
    if (pairState === 'running') { pairSeq++; cancelPairs(); running = null; pairState = 'cancelled'; view = 'groups'; }
    render();
  });
  const gridEl = el('div', 'px-grid', root);
  proxPanel().replaceChildren(root);
  const grid = new Tabulator(gridEl, {
    ...GRID_RANGE_DEFAULTS,
    height: '100%', layout: 'fitData', index: '_i',
    rowFormatter: (row) => { const k = (row.getData() as { _i: number })._i; row.getElement().classList.toggle('px-focus', k === (view === 'groups' ? focused : focusedPair)); },
    columns: [], data: [],
  });
  const pick = (k: number): number | undefined => {
    const p = view === 'groups' ? k : pairs?.a[k];
    if (p === undefined) return undefined;
    const prev = view === 'groups' ? focused : focusedPair;
    if (view === 'groups') focused = k; else { focusedPair = k; focused = p; }
    markRows(grid, prev, k);
    for (const cb of [...rowCbs]) cb(p);
    return p;
  };
  flyRow = k => { const p = pick(k); if (p !== undefined) for (const cb of [...flyCbs]) cb(p); };
  grid.on('rowClick', (_ev, row) => { pick((row.getData() as { _i: number })._i); });
  // A pane shown again (or a drawer resized) redraws the grid, which rendered against a 0-px holder while hidden.
  if (typeof ResizeObserver !== 'undefined') {
    let queued = false, wasShown = false;
    seen = new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      // Only a grid coming from 0 px is redrawn by force; a forced redraw clears the dragged range.
      requestAnimationFrame(() => {
        queued = false;
        if (ui?.grid !== grid) return;
        const h = gridEl.offsetHeight > 0;
        if (h) grid.redraw(!wasShown);
        wasShown = h;
      });
    });
    seen.observe(gridEl);
  }
  gridEl.addEventListener('keydown', onGridKey, true);
  const built = new Promise<void>(r => grid.on('tableBuilt', () => r()));
  return { root, file, choose, fileName, thLabel, th, unit: sel, vGroups, vPairs, dlGroups, dlPairs, csvNote, clear, msg, legend, status, prog, progText, cancel, privacy, sample, credit, gridEl, grid, built };
}

// ─── Loading a file ──────────────────────────────────────────────────────────
function say(key: string | null, params?: Record<string, string | number>) {
  msgKey = key ? { key, params } : null;
  if (ui) ui.msg.textContent = msgKey ? t(msgKey.key, msgKey.params) : '';
}

async function load(file: File) {
  if (file.size > MAX_FILE_BYTES) { say('px.fileTooBig'); return; }
  say(null);
  const col = (h: string, i: number) => h || `col${i}`;
  let r;
  try {
    r = await pickCsvPoints(file, {
      title: t('px.pickTitle'), submit: t('px.pickSubmit'), idLabel: t('px.pickId'), idNone: t('px.pickNone'),
      maxRows: MAX_POINTS, onTooMany: n => say('px.tooMany', { n: fmt(n) }),
    });
  } catch { say('px.readFailed'); return; }
  if (!r || !ui) return;
  if (r.features.length > MAX_POINTS) { say('px.tooMany', { n: fmt(r.features.length) }); return; }
  if (!r.features.length) { say('px.noPoints'); return; }
  const n = r.features.length;
  const lon = new Float64Array(n), lat = new Float64Array(n);
  r.features.forEach((f, i) => { [lon[i], lat[i]] = f.geometry.coordinates; });
  const cols: Loaded['cols'] = [];
  const seen = new Set<string>();
  r.headers.forEach((h, i) => {
    const key = col(h, i);
    if (i === r.latCol || i === r.lngCol || seen.has(key)) return;
    seen.add(key);
    cols.push({ key, title: h || `col${i + 1}` });
  });
  const idKey = r.idCol === null ? null : col(r.headers[r.idCol] ?? '', r.idCol);
  const idText = idKey === null ? null : r.features.map(f => String(f.properties?.[idKey] ?? '').trim());
  adopt({
    fileName: r.fileName, cols, feats: r.features, lon, lat, rowNo: r.dataRowIndex,
    names: r.features.map(f => String(f.properties?.name ?? '')),
    ids: idText ? internIds(idText) : null, idText, skipped: r.skipped,
  });
}

function adopt(d: Loaded) {
  cancelPairs();
  cancelCsv();
  pairSeq++;
  running = null; pairs = null; pairState = 'idle'; focused = -1; focusedPair = -1;
  dropPending(); vstate = fresh();
  data = d;
  compute();
}

// ─── The sample: HIFLD substations in the view ───────────────────────────────
async function trySample() {
  const map = state.map;
  if (!ui || !map || sampleBusy) return;
  const my = ++sampleSeq;
  sampleBusy = true;
  say(null);
  render();
  const b = map.getBounds();
  const o = await runSample(DATA.hifld_substations, viewBox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }), SAMPLE_CAP);
  if (my !== sampleSeq || !ui) return;
  sampleBusy = false;
  if (o.kind === 'cancelled') { render(); return; }
  if (o.kind === 'failed') say('px.sampleFailed');
  else if (o.kind === 'none') say('px.sampleNone');
  else if (o.kind === 'tooMany') say('px.sampleZoomIn', { n: fmt(o.n) });
  else {
    const n = o.lon.length;
    const keyOf = (k: string) => SAMPLE_FIELDS.indexOf(k as (typeof SAMPLE_FIELDS)[number]);
    const idText = o.props.map(p => p[keyOf('hifld_id')].trim());
    unit = 'mi';
    ui.unit.value = 'mi';
    ui.th.value = '1';
    adopt({
      fileName: '', sample: true, cols: SAMPLE_FIELDS.map(k => ({ key: k, title: k })),
      feats: o.props.map((p, i) => ({
        type: 'Feature', properties: Object.fromEntries(SAMPLE_FIELDS.map((k, j) => [k, p[j]])),
        geometry: { type: 'Point', coordinates: [o.lon[i], o.lat[i]] },
      })),
      lon: o.lon, lat: o.lat, rowNo: Int32Array.from({ length: n }, (_, i) => i),
      names: o.props.map(p => p[keyOf('name')]), ids: internIds(idText), idText, skipped: 0,
    });
    return;
  }
  render();
}

// ─── Computing ───────────────────────────────────────────────────────────────
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(compute, 250);
}

function compute() {
  clearTimeout(timer);
  if (!ui || !data) return;
  pairSeq++;
  cancelPairs();
  cancelCsv();
  running = null; pairs = null; pairState = 'idle'; focused = -1; focusedPair = -1;
  const km1 = thresholdKm(Number(ui.th.value), unit);
  if (km1 === null || ui.th.value.trim() === '') {
    km = null; res = null; order = new Int32Array(0);
    say('px.range');
    render();
    notify();
    return;
  }
  km = km1;
  say(null);
  try {
    res = proximityGroups(data.lon, data.lat, km, data.ids ? { ids: data.ids } : undefined);
  } catch { res = null; say('px.range'); }
  order = res ? groupOrder(res, data.rowNo) : new Int32Array(0);
  if (view === 'pairs' && res) void ensurePairs();
  render();
  notify();
}

function ensurePairs(): Promise<PairsResult | null> {
  if (!data || !res || km === null) return Promise.resolve(null);
  if (pairs) return Promise.resolve(pairs);
  if (running) return running;
  const my = ++pairSeq;
  pairState = 'running';
  found = 0;
  const p = runPairs(data.lon, data.lat, km, {
    ...(data.ids ? { ids: data.ids } : {}), max: MAX_PAIRS,
    onProgress: n => { if (my === pairSeq) { found = n; renderStatus(); } },
  }).then(o => {
    if (my !== pairSeq) return null;
    running = null;
    if (o.ok) { pairs = o.result; pairState = 'done'; } else pairState = o.reason === 'cancelled' ? 'cancelled' : 'failed';
    render();
    return pairs;
  });
  running = p;
  render();
  return p;
}

function setView(v: 'groups' | 'pairs') {
  flushPending();
  view = v;
  if (v === 'pairs') void ensurePairs();
  render();
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  if (!ui) return;
  const u = ui;
  u.privacy.textContent = t('px.privacy');
  u.choose.textContent = t('px.choose');
  u.fileName.textContent = data?.sample ? t('px.sampleName') : data?.fileName ?? '';
  u.sample.textContent = t('px.sample');
  u.sample.disabled = sampleBusy;
  renderCredit(u);
  u.thLabel.textContent = t('px.threshold');
  u.unit.setAttribute('aria-label', t('px.unitAria'));
  u.unit.value = unit;
  u.vGroups.textContent = t('px.viewGroups');
  u.vPairs.textContent = t('px.viewPairs');
  u.vGroups.setAttribute('aria-pressed', String(view === 'groups'));
  u.vPairs.setAttribute('aria-pressed', String(view === 'pairs'));
  u.vGroups.disabled = u.vPairs.disabled = !res;
  u.dlGroups.textContent = t('px.dlGroups');
  u.dlPairs.textContent = t('px.dlPairs');
  u.dlGroups.setAttribute('aria-label', t('px.dlGroups').replace(/^↓\s*/, ''));
  u.dlPairs.setAttribute('aria-label', t('px.dlPairs').replace(/^↓\s*/, ''));
  u.dlGroups.disabled = !res;
  u.dlPairs.disabled = !res || dlBusy;
  u.cancel.textContent = t('px.cancel');
  u.root.querySelector('.px-views')!.setAttribute('aria-label', t('px.viewAria'));
  u.legend.textContent = t('px.legend');
  u.msg.textContent = msgKey ? t(msgKey.key, msgKey.params) : '';
  renderStatus();
  renderGrid();
}

/** The sample's credit: its text and the HIFLD link, made from the registry's credit anchor as nodes (no HTML is set). */
function renderCredit(u: Ui) {
  u.credit.hidden = !data?.sample;
  if (!data?.sample) { u.credit.replaceChildren(); return; }
  const m = /href="(https:[^"]+)">([^<]+)</.exec(HIFLD_CREDIT);
  const a = m ? Object.assign(document.createElement('a'), { href: m[1], textContent: m[2], target: '_blank', rel: 'noopener noreferrer' }) : null;
  u.credit.replaceChildren(t('px.sampleCredit') + ' ', ...(a ? [a] : []), ' · DHS CISA');
}

function renderStatus() {
  if (!ui) return;
  const u = ui;
  u.status.textContent = '';
  if (data && res) {
    const near = res.group.reduce((n, g) => n + (g > 0 ? 1 : 0), 0);
    u.status.textContent = near
      ? t('px.status', { points: fmt(data.feats.length), skipped: fmt(data.skipped + res.skipped), near: fmt(near), groups: fmt(res.groups) })
      : t('px.noGroups', { points: fmt(data.feats.length) });
  }
  const csvRun = csvRows >= 0;
  const showProg = sampleBusy || csvRun || (pairState === 'running' && (view === 'pairs' || dlBusy));
  u.prog.hidden = !showProg;
  u.progText.textContent = !showProg ? ''
    : sampleBusy ? t('px.sampleLoading')
    : csvRun ? t('px.csvBuilding', { n: fmt(csvRows), total: fmt(csvTotal) })
    : t('px.pairsFinding', { n: fmt(found) });
  if (view === 'pairs' && pairState === 'failed') u.status.textContent += ` ${t('px.pairsFailed')}`;
  if (view === 'pairs' && pairs?.truncated && res) {
    const near = res.group.reduce((n, g) => n + (g > 0 ? 1 : 0), 0);
    u.status.textContent += ` ${t('px.pairsTruncated', { max: fmt(MAX_PAIRS), groups: fmt(res.groups), points: fmt(near) })}`;
  }
  const v = cur(), active = !!v.sort || v.filters.size > 0;
  if (view === 'pairs' && pairs?.truncated && active) u.status.textContent += ` ${t('px.pairsPartialView', { max: fmt(MAX_PAIRS) })}`;
  if (res && rowsKey !== '' && v.filters.size) {
    u.status.textContent += ` ${t('px.shown', { shown: fmt(shown.length), total: fmt(baseRows().length) })}`;
    if (!shown.length) u.status.textContent += ` ${t('px.noMatch')}`;
  }
  if (viewBusy) u.status.textContent += ` ${t('px.busy')}`;
  if (copyNote) u.status.textContent += ` ${t(copyNote.key, copyNote.params)}`;
  u.clear.hidden = !v.filters.size;
  u.clear.textContent = t('px.clearFilters');
  u.csvNote.textContent = res && active ? t('px.csvFull') : '';
}

const textCell = (c: ProxCol) => (cell: CellComponent) =>
  document.createTextNode(c.text((cell.getData() as { _i: number })._i)) as unknown as HTMLElement;

const KEEP_EVENTS = ['mousedown', 'pointerdown', 'click', 'dblclick'] as const;
const stop = (e: Event) => e.stopPropagation();

interface Head { b: HTMLButtonElement; ar: HTMLElement }
const heads = new Map<string, Head>();
const arrowOf = (field: string) => (cur().sort?.field === field ? (cur().sort!.dir === 1 ? ' ▲' : ' ▼') : '');

/** Ctrl/Cmd+C on the grid: the dragged range as TSV (header line, rows in view order), inside the keypress. */
function onGridKey(ev: KeyboardEvent) {
  // A row's own button (↗) keeps its Enter; SelectRange, with no editor to open, never sees it.
  if (ev.key === 'Enter' && (ev.target as HTMLElement).closest('.tabulator-tableholder')) ev.stopPropagation();
  if ((ev.target as HTMLElement).closest('input, select, button')) return;
  if (ev.key === 'Enter') { ev.stopPropagation(); return; }
  if (!isCopyKey(ev) || !ui) return;
  const range = ui.grid.getRanges()[0];
  if (!range) return;
  const cs = range.getColumns().map(c => cols.find(x => x.field === c.getField())).filter((c): c is ProxCol => !!c);
  const rows = range.getRows().map(r => (r.getData() as { _i: number })._i);
  if (!cs.length || !rows.length) return;
  ev.preventDefault();
  ev.stopPropagation();
  copyText(rangeTsvOf(cs, rows), () => { copyNote = { key: 'table.copied', params: { rows: fmt(rows.length), cols: fmt(cs.length) } }; renderStatus(); });
}

/** ▲/▼ and aria-sort on the header nodes in place: no column rebuild, so a filter box keeps its focus. */
function markSorts() {
  for (const [field, h] of heads) {
    h.ar.textContent = arrowOf(field);
    const col = h.b.closest('.tabulator-col');
    const dir = cur().sort?.field === field ? cur().sort!.dir : 0;
    if (!col) continue;
    col.setAttribute('aria-sort', dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none');
  }
}

function sortBy(field: string) {
  const v = cur(), s = v.sort;
  v.sort = s?.field !== field ? { field, dir: 1 } : s.dir === 1 ? { field, dir: -1 } : null;
  markSorts();
  refreshView();
}

/** The header: a sort button above a filter box, both made as nodes. */
function headFormatter(c: ProxCol) {
  return (_cell: CellComponent, _p: unknown, onRendered: (fn: () => void) => void): HTMLElement => {
    const wrap = el('div', 'px-head-wrap');
    const b = button('px-head', wrap, () => sortBy(c.field));
    b.title = t('px.sortBy', { col: c.title });
    b.setAttribute('aria-label', b.title);
    const ar = el('span', 'px-ar');
    b.append(el('span', 'px-head-title'), ar);
    b.firstElementChild!.textContent = c.title;
    ar.textContent = arrowOf(c.field);
    const input = el('input', 'px-filter', wrap);
    input.type = 'search';
    input.placeholder = t('px.filterHint');
    input.setAttribute('aria-label', t('px.filterCol', { col: c.title }));
    input.value = cur().filters.get(c.field) ?? '';
    input.addEventListener('input', () => {
      const old = pendingFilters.get(c.field);
      if (old) clearTimeout(old.timer);
      const vs = cur();
      const timer = setTimeout(() => {
        const p = pendingFilters.get(c.field);
        if (!p || p.timer !== timer) return;
        pendingFilters.delete(c.field);
        setFilterOn(p.vs, c.field, input.value);
        if (ui) refreshView();
      }, 200);
      pendingFilters.set(c.field, { timer, vs, input });
    });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Escape') { e.stopPropagation(); return; }
      if (!input.value) return;
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      const old = pendingFilters.get(c.field);
      if (old) { clearTimeout(old.timer); pendingFilters.delete(c.field); }
      setFilterOn(cur(), c.field, '');
      refreshView();
    });
    for (const type of KEEP_EVENTS) { b.addEventListener(type, stop); input.addEventListener(type, stop); }
    heads.set(c.field, { b, ar });
    onRendered(markSorts);
    return wrap;
  };
}

/** The first column: a button per row that flies to the point (the keyboard's way to a row; Enter or Space). */
function flyColumn(): ColumnDefinition {
  return {
    title: '', field: 'f0', frozen: true, resizable: false, hozAlign: 'center', width: 36,
    titleFormatter: () => Object.assign(document.createElement('span'), { className: 'px-fly-head' }),
    formatter: (cell: CellComponent) => {
      const k = (cell.getData() as { _i: number })._i;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'px-fly';
      b.textContent = '↗';
      b.title = t('px.flyTo');
      b.setAttribute('aria-label', t('px.flyTo'));
      for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick'] as const) b.addEventListener(type, ev => ev.stopPropagation());
      b.addEventListener('click', () => flyRow(k));
      return b;
    },
  };
}

/** Columns as the view model sees them. Fields are positional (f1…; f0 is the fly button), never names: a dot in a CSV header is a path to Tabulator. */
class Cols {
  list: ProxCol[] = [];
  widths: number[] = [];
  add(c: Omit<ProxCol, 'field'>, width: number) {
    this.list.push({ ...c, field: `f${this.list.length + 1}` });
    this.widths.push(width);
  }
  defs(): ColumnDefinition[] {
    return [flyColumn(), ...this.list.map((c, i): ColumnDefinition => ({
      title: c.title, field: c.field, titleFormatter: headFormatter(c) as ColumnDefinition['titleFormatter'],
      formatter: textCell(c), hozAlign: c.num ? 'right' : 'left', width: this.widths[i],
    }))];
  }
}

/** A text column over indices 0…n-1 that sorts by rank (collation done once, on first sort). */
function textCol(title: string, n: number, get: (i: number) => string, at: (k: number) => number = k => k): Omit<ProxCol, 'field'> {
  let rk: Int32Array | undefined;
  return { title, num: false, text: k => get(at(k)), value: k => get(at(k)), rank: k => (rk ??= rankOf(n, get, getLocale()))[at(k)] };
}

function groupColumns(d: Loaded, r: ProximityResult): Cols {
  const n = d.names.length, c = new Cols();
  c.add({ title: t('px.colGroup'), num: true, text: i => String(r.group[i]), value: i => r.group[i] }, 80);
  c.add({ title: t('px.colSize'), num: true, text: i => String(r.size[i]), value: i => r.size[i] }, 100);
  c.add({ title: t('px.colRow'), num: true, text: i => String(d.rowNo[i] + 1), value: i => d.rowNo[i] + 1 }, 80);
  c.add(textCol(t('px.colName'), n, i => d.names[i]), 160);
  if (d.idText) c.add(textCol(t('px.colId'), n, i => d.idText![i]), 100);
  c.add({ title: t('px.colLat'), num: true, text: i => d.lat[i].toFixed(5), value: i => d.lat[i] }, 100);
  c.add({ title: t('px.colLon'), num: true, text: i => d.lon[i].toFixed(5), value: i => d.lon[i] }, 100);
  c.add({ title: t('px.colNearest', { unit }), num: true, text: i => dist(r.nearestKm[i]), value: i => distNum(r.nearestKm[i]) }, 120);
  d.cols.forEach(f => c.add(textCol(f.title, n, i => String(d.feats[i].properties?.[f.key] ?? '')), 130));
  return c;
}

function pairColumns(d: Loaded, r: ProximityResult, p: PairsResult): Cols {
  const n = d.names.length, c = new Cols();
  const a = (k: number) => p.a[k], b = (k: number) => p.b[k];
  const pt = (of: (k: number) => number, text: (q: number) => string, value: (q: number) => string | number) => ({ count: n, of, text, value });
  const num = (title: string, of: (k: number) => number, val: (q: number) => number, width: number): [Omit<ProxCol, 'field'>, number] =>
    [{ title, num: true, text: k => String(val(of(k))), value: k => val(of(k)), point: pt(of, q => String(val(q)), val) }, width];
  const txt = (title: string, of: (k: number) => number, get: (q: number) => string, width: number): [Omit<ProxCol, 'field'>, number] =>
    [{ ...textCol(title, n, get, of), point: pt(of, get, get) }, width];
  c.add(...num(t('px.colGroup'), a, q => r.group[q], 80));
  c.add(...num(t('px.colRowA'), a, q => d.rowNo[q] + 1, 80));
  c.add(...num(t('px.colRowB'), b, q => d.rowNo[q] + 1, 80));
  if (d.idText) {
    c.add(...txt(t('px.colIdA'), a, q => d.idText![q], 100));
    c.add(...txt(t('px.colIdB'), b, q => d.idText![q], 100));
  }
  c.add(...txt(t('px.colNameA'), a, q => d.names[q], 160));
  c.add(...txt(t('px.colNameB'), b, q => d.names[q], 160));
  c.add({ title: t('px.colDist', { unit }), num: true, text: k => dist(p.km[k]), value: k => distNum(p.km[k]) }, 120);
  return c;
}

/** What the grid draws: columns rebuilt only when `colsKey` changes (the header boxes keep their focus), rows only when `rowsKey` does. */
let colsKey: { s: string; d: Loaded | null; r: ProximityResult | null; p: PairsResult | null } | null = null;
let colsGen = 0;
let rowsKey = '';
let gridSeq = 0;

const baseRows = (): Int32Array => view === 'pairs' ? (pairBase ??= Int32Array.from({ length: pairs?.a.length ?? 0 }, (_, k) => k)) : order;
let pairBase: Int32Array | null = null;

function refreshView() {
  renderStatus();
  renderGrid();
}

function renderGrid() {
  if (!ui) return;
  const u = ui, g = u.grid, my = ++gridSeq;
  const d = data, r = res, p = pairs;
  const showPairs = view === 'pairs';
  u.gridEl.hidden = !r || (showPairs && !p);
  void u.built.then(async () => {
    if (ui !== u || data !== d || res !== r || pairs !== p || my !== gridSeq) return;
    if (!d || !r || (showPairs && !p)) {
      if (colsKey) { heads.clear(); g.setColumns([]); }
      colsKey = null; rowsKey = ''; shown = new Int32Array(0); cols = []; viewBusy = false;
      await g.clearData();
      renderStatus();
      return;
    }
    const s = `${view}|${getLocale()}|${unit}|${d.idText ? 1 : 0}`;
    if (!colsKey || colsKey.s !== s || colsKey.d !== d || colsKey.r !== r || colsKey.p !== (showPairs ? p : null)) {
      const built = showPairs ? pairColumns(d, r, p!) : groupColumns(d, r);
      cols = built.list;
      colsKey = { s, d, r, p: showPairs ? p : null };
      colsGen++;
      pairBase = null;
      heads.clear();
      g.setColumns(built.defs());
      markSorts();
    }
    const v = cur();
    const rk = `${colsGen}|${v.sort ? `${v.sort.field}${v.sort.dir}` : ''}|${JSON.stringify([...v.filters])}`;
    if (rk === rowsKey) return;
    rowsKey = rk;
    copyNote = null;
    const base = baseRows();
    const heavy = base.length > 100_000 && (v.sort || v.filters.size);
    try {
      if (heavy) {
        viewBusy = true;
        renderStatus();
        await new Promise<void>(res2 => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(res2, 0)); else setTimeout(res2, 0); });
        // Another render with this same key leaves the work to this call; one with a different key took the slot over.
        if (rowsKey !== rk || ui !== u) return;
      }
      shown = viewOrder(base, cols, v.sort, v.filters);
      renderStatus();
      await g.replaceData(Array.from(shown, i => ({ _i: i })));
    } finally {
      if (rowsKey === rk && viewBusy) { viewBusy = false; renderStatus(); }
    }
  });
}

// ─── CSV downloads ───────────────────────────────────────────────────────────
function stem(): string {
  const base = data?.sample ? 'hifld-substations-sample' : (data?.fileName ?? 'points').replace(/\.[^.]*$/, '');
  return base.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'points';
}

/** Rows → CSV text in chunks (header once; `notes` after the last row). */
function csvParts(n: number, fields: string[], rowAt: (k: number) => Record<string, unknown>, notes: string[] = []): string[] {
  const headLen = toCsv([], fields).length;
  const parts: string[] = [];
  let start = 0;
  do {
    const end = Math.min(n, start + CSV_CHUNK);
    const rows: Record<string, unknown>[] = [];
    for (let k = start; k < end; k++) rows.push(rowAt(k));
    const text = toCsv(rows, fields, undefined, end >= n ? notes : []);
    parts.push(start === 0 ? text : text.slice(headLen));
    start = end;
  } while (start < n);
  return parts;
}

function groupsCsv(d: Loaded, r: ProximityResult): string[] {
  const fields = uniqueNames(['row', 'latitude', 'longitude', ...d.cols.map(c => c.title), 'group', 'group_size', `nearest_${unit}`]);
  const nc = d.cols.length + 3;
  return csvParts(order.length, fields, k => {
    const i = order[k];
    const rec: Record<string, unknown> = { [fields[0]]: d.rowNo[i] + 1, [fields[1]]: d.lat[i], [fields[2]]: d.lon[i] };
    d.cols.forEach((c, j) => { rec[fields[3 + j]] = d.feats[i].properties?.[c.key] ?? ''; });
    rec[fields[nc]] = r.group[i];
    rec[fields[nc + 1]] = r.size[i];
    rec[fields[nc + 2]] = distNum(r.nearestKm[i]);
    return rec;
  });
}

/** What the CSV worker builds the pairs CSV from. */
export function pairsCsvInput(d: Loaded, r: ProximityResult, p: PairsResult, u: Unit): PairsCsvInput {
  const fixed = ['group', 'a_row', 'b_row', 'a_id', 'b_id', 'a_name', 'b_name', `distance_${u}`, 'a_latitude', 'a_longitude', 'b_latitude', 'b_longitude'];
  const near = r.group.reduce((c, g) => c + (g > 0 ? 1 : 0), 0);
  return {
    fields: uniqueNames([...fixed, ...d.cols.map(c => `a_${c.title}`), ...d.cols.map(c => `b_${c.title}`)]),
    unitKm: UNIT_KM[u], a: p.a, b: p.b, km: p.km, group: r.group, rowNo: d.rowNo, lat: d.lat, lon: d.lon,
    names: d.names, idText: d.idText,
    cols: d.cols.map(c => d.feats.map(f => String(f.properties?.[c.key] ?? ''))),
    notes: p.truncated ? [t('px.csvNoteTruncated', { max: fmt(MAX_PAIRS), groups: fmt(r.groups), points: fmt(near) })] : [],
  };
}

async function downloadGroups() {
  if (!data || !res) return;
  downloadFile(new Blob(groupsCsv(data, res), { type: 'text/csv;charset=utf-8' }), `${stem()}-proximity-groups.csv`, 'text/csv');
}

/** One at a time (a second click while it runs is ignored); progress and Cancel from either view. */
async function downloadPairs() {
  if (dlBusy || !data || !res) return;
  const d = data, r = res, u = unit;
  dlBusy = true;
  render();
  try {
    const p = await ensurePairs();
    if (!p || data !== d || res !== r) return;
    csvRows = 0;
    csvTotal = p.a.length;
    renderStatus();
    const o = await runPairsCsv(pairsCsvInput(d, r, p, u), {
      limit: MAX_CSV_BYTES, onProgress: n => { if (data === d) { csvRows = n; renderStatus(); } },
    });
    if (data !== d || res !== r) return;
    if (o.ok) { say(null); downloadFile(o.blob, `${stem()}-proximity-pairs.csv`, 'text/csv'); }
    else if (o.reason === 'tooBig') say('px.csvTooBig', { mb: fmt(Math.round(o.bytes / 1048576)) });
    else if (o.reason === 'failed') say('px.pairsFailed');
  } finally {
    dlBusy = false;
    csvRows = -1;
    render();
  }
}
