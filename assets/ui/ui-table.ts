// ─── Table drawer (lazy chunk) ───────────────────────────────────────────────
// A dataset's rows as a table in a bottom drawer. Nothing here is in the view
// or the link; the drawer lasts the tab (sessionStorage `tm-drawer`, below).
//   showTable(req)       open (or replace) the drawer's one table. A request
//                        with only a layerId shows what the map draws when the
//                        layer is on (asDrawn), else the view's `where` and
//                        Area for it; `ids` limits it to those features,
//                        `focusId` makes that row active. Before the first
//                        load of a GeoJSON file over 2 MiB the drawer states
//                        its size and asks; closing the drawer or the next
//                        showTable() answers "no".
//   zoomToSelection()    fit the map to state.sel's features.
//   restoreDrawer(resumeAsk)  after a reload of this tab (ui-menubar.ts's boot
//                        hook through table-open.ts): the drawer as its
//                        tm-drawer snapshot left it (drawer-snapshot.ts checks
//                        the shape; the fields are checked here against
//                        describe()). Ask first, then the table (a vector-tile
//                        layer after the map's `idle`, a large file through the
//                        size prompt, never answered for the visitor), then the
//                        pane in view, height and collapse. No focus moves, no
//                        link write, no undo step. The Route, Line, Proximity
//                        and Grid Ops tabs are never kept. The Visualize pane's
//                        part comes from the getter ui-templates.ts registers
//                        (registerVizSnapshot).
//   mapIdle()            resolves once the map has drawn (a vector-tile read waits for it).
// Rows come from dataset-query.ts's query() (≤ QUERY_MAX_ROWS, sorted there,
// so a sort re-queries); the left column is aggregate() over the same options.
// The grid is Tabulator (tabulator-tables, this chunk only), a renderer and
// nothing more: it never sorts, filters or groups; query()/aggregate() do, and
// a header click re-queries. Copy is not paint: a cell copies its raw value
// (full precision; a string formula-guarded like the CSV, tabs and line breaks
// flattened), never the display text. Footguns, all handled below: fields are
// positional (`f0`, `f1`, …) since a field name may hold a dot, which Tabulator
// reads as a path; a drag must make a range, not a text selection, or Ctrl+C
// copies the selection (style.css: user-select none); Tabulator resets the
// range on every data load and would take focus with it (selectableRangeAutoFocus
// off); the header's controls keep mousedown from Tabulator; a formatter's
// string is HTML to Tabulator, so cells are text nodes; and Tabulator's
// clipboard module writes each copied value into an HTML table by innerHTML, so
// the copy is this module's own (copyRange: text only, inside the keypress).
// A row click highlights the feature (highlights.ts, as its 'table' owner) and
// fits the camera to it. "Select" commits the checked rows (or every row, up to
// MAX_SELECTION_IDS) through panel-mirror.ts's commitSelection (one 'url:write').
// Column filters filter the map too: a header's ▾ applies conditions to the
// layer's `where` through map-api.ts setWhere (validated as a link is; one
// 'url:write', its own undo step), so the map, the table, the CSV, templates
// and the link agree. A vector-tile layer with a columns file (dataset-query.ts
// scope 'dataset') lists the whole dataset: the partial note follows each
// result's `complete`, the size prompt uses the file's planned bytes
// (columnsBytes), and a row (`pointOnly`) carries only a point on its feature,
// so a row's highlight and fit use the loaded tile feature with its id (else
// the camera goes to the point and the highlight is retried at the next
// `idle`; the point itself is never drawn). Any other vector-tile layer covers
// the current view only. A table that follows the view reloads when the layer's `where` changes
// elsewhere; one asked for with its own conditions keeps them until a column
// filter makes them the view's.
// Fixed strings carry data-i18n* keys (ui.ts's lang:changed handler
// re-translates them); the rest, the status line included (setStatus keeps
// its key), is redrawn by this module's own lang:changed subscriber.
// Panes (table, Ask, Visualize, Line, Proximity, Grid Ops, Route) share the
// drawer, one in view at a time; each is filled by its own module. drawerPadding()
// is the map padding that keeps a fit above the drawer and clear of the layer panel.
// Deps: tabulator-tables (+ its simple theme CSS), state.ts, state-bus.ts (on),
//       dataset-query.ts, feature-id.ts, columns/columns-read.ts (dynamic import), highlights.ts, filters.ts (drawnFilterLabels),
//       panel-mirror.ts (commitSelection, conditionLabel), map-api.ts (setWhere),
//       view-validate.ts (validateWhere), user-data-export.ts (toCsv, downloadFile),
//       grid-copy.ts (range-grid options, copy key, clipValue, tsvOf, copyText),
//       layers/layer-source.ts (layerSourceId, layerDataUrl), area-labels.ts,
//       ui-layer-rows.ts (TABLE_ICON, VIZ_ICON), registry (layerById), fuel.ts (fuelFold),
//       view-validate.ts (MAX_SELECTION_IDS), utils.ts (escapeHtml, FORMULA guard), i18n (t),
//       session-snapshot.ts (saveSnapshot, readSnapshot, clearSnapshot, onHidden),
//       drawer-snapshot.ts (parseDrawerSnapshot); user-data/copy-fit.ts (caps,
//       showCopyResult, downloadCopy); user-data/copy-rows.ts (dynamic import:
//       "Copy N checked to My Data" on a GeoJSON layer, a tiled point layer or a
//       layer with GeoParquet geometry, shown once copyAvailable answers true; its wording
//       follows copyNoun: lines, else features).
// Loaded by: table-open.ts (dynamic import).

import {
  Tabulator, FormatModule, FrozenColumnsModule, InteractionModule, KeybindingsModule,
  MoveColumnsModule, ResizeColumnsModule, SelectRangeModule,
  type CellComponent, type ColumnDefinition, type RowComponent,
} from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';
import { state } from '../state.js';
import { layerById } from '../../src/registry/index.js';
import { fuelFold } from '../../src/colors/fuel.js';
import { MAX_SELECTION_IDS, validateWhere } from '../../src/registry/view-validate.js';
import type { Condition } from '../../src/registry/condition-compile.js';
import { areaCondition, type AreaFilter } from '../../src/registry/area-filter.js';
import { featureId, type FeatureId } from '../feature-id.js';
import {
  query, aggregate, count, describe, hasColumns, QUERY_MAX_ROWS,
  type QueryOpts, type QueryRow, type FieldInfo, type Group,
  type Outcome, type AggregateResult, type CountResult,
} from '../dataset-query.js';
import { setHighlightFeatures, clearHighlights } from '../highlights.js';
import { drawnFilterLabels } from '../filters.js';
import { commitSelection, conditionLabel } from './panel-mirror.js';
import { setWhere } from '../map-api.js';
import { toCsv, downloadFile } from '../user-data/user-data-export.js';
import { layerSourceId, layerDataUrl } from '../layers/layer-source.js';
import { areaLabel, areaLabelsNow } from './area-labels.js';
import { TABLE_ICON, VIZ_ICON } from './ui-layer-rows.js';
import { escapeHtml } from '../utils/utils.js';
import { on } from '../state-bus.js';
import { t, getLocale } from '../../src/i18n/index.js';
import { saveSnapshot, readSnapshot, clearSnapshot, claimSnapshot, onHidden } from '../session-snapshot.js';
import { DRAWER_SNAPSHOT, DRAWER_SNAPSHOT_VERSION, parseDrawerSnapshot, type DrawerSnapshot, type TableSnapshot, type VizSnapshot } from './drawer-snapshot.js';
import { GRID_RANGE_DEFAULTS, isCopyKey, keepFromGrid, clipValue, tsvOf, copyText } from './grid-copy.js';
import { MAX_COPY_ITEMS, showCopyResult, downloadCopy } from '../user-data/copy-fit.js';

export interface TableRequest {
  layerId: string;
  where?: Condition[];
  area?: AreaFilter | null;
  asDrawn?: boolean;
  ids?: FeatureId[];
  focusId?: FeatureId;
}

const SIZE_WARN_BYTES = 2 * 1024 * 1024;
const MAX_BARS = 10;
const MAX_PILL_VALUES = 4;

interface Bar { id: string; label: string; color?: string; keys: (string | number)[]; count: number; sum: number }

interface Table {
  req: TableRequest;
  opts: QueryOpts;
  areaDropped: boolean;      // the Area could not reach this layer, so the rows ignore it
  fields: FieldInfo[];       // every allowed field: the query, the CSV and the Columns panel
  idField: string;
  shown: Set<string>;        // the columns on screen, in screen order (shownCols' entry for the layer)
  canFilter: boolean;        // the layer takes `where` conditions (the header's ▾)
  whereKey: string;          // the layer's `where` this table last loaded with (whereKeyOf)
  rows: QueryRow[];
  total: number;
  truncated: boolean;
  partial: boolean;
  sort: { field: string; desc: boolean } | null;
  groupBy: string;           // '' = no grouping
  sumField: string;          // '' = count
  bars: Bar[];
  groupTotal: number;
  rowCount: number;          // features matching, before a bar narrows them
  barFilter: string | null;  // Bar.id
  checked: Set<FeatureId>;
  active: number;
  init?: TableSnapshot;      // a restore's checks, active row and scroll, until the first load lands
}

let drawer: HTMLElement | null = null;
let tbl: Table | null = null;
let opener: HTMLElement | null = null;
let height = 0;             // px, from `frac` and the container
let frac = 0;               // the drawer's share of the map container; 0 = the layout's default
let collapsed = false;
let seq = 0;               // the latest load; an older one that lands later is dropped
let routeTall = false;     // setRouteTall(true): the drawer is at least ROUTE_TALL_PX
const ROUTE_TALL_PX = 540;
const ROUTE_MIN_PX = 410;  // the Route pane's default height (desktop): its input column fits
type Pane = 'ask' | 'table' | 'route' | 'viz' | 'line' | 'prox' | 'gops';
type Side = Exclude<Pane, 'table'>;
/** Each side pane's open flag, the element focus returns to and its onClose. */
const P: Record<Side, { open: boolean; opener: HTMLElement | null; onClose: (() => void) | null }> = {
  ask: { open: false, opener: null, onClose: null },
  viz: { open: false, opener: null, onClose: null },
  line: { open: false, opener: null, onClose: null },
  prox: { open: false, opener: null, onClose: null },
  gops: { open: false, opener: null, onClose: null },
  route: { open: false, opener: null, onClose: null },
};
/** What differs between the side panes: whether an open or close counts as the
 *  visitor's act() (`resuming`: a restore's open does not), whether the open
 *  recomputes the height (Ask keeps the layout's), and what a close also undoes. */
const SIDE: Record<Side, { visitor: boolean; resuming?: () => boolean; height: boolean; off?: () => void }> = {
  ask: { visitor: true, resuming: () => resumingAsk, height: false },
  viz: { visitor: true, resuming: () => resumingViz, height: true },
  line: { visitor: true, height: true },
  prox: { visitor: true, height: true },
  gops: { visitor: true, height: true },
  route: { visitor: false, height: true, off: () => setRouteTall(false) },
};
let pane: Pane = 'table';  // the pane in view

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => drawer!.querySelector<T>(sel)!;
const fmt = (n: number, digits = 1) => n.toLocaleString(getLocale(), { maximumFractionDigits: digits });
const isMw = (field: string) => /(^|_)mw$/i.test(field);
const fmtSum = (n: number, field: string) => !field ? fmt(n, 0)
  : isMw(field) ? (Math.abs(n) >= 1000 ? `${fmt(n / 1000)} GW` : `${fmt(n)} MW`) : fmt(n);

// ─── Public entry points ─────────────────────────────────────────────────────
export function showTable(req: TableRequest): Promise<void> {
  act();
  return openTable(req);
}

/** showTable, or (with `init`) a restore: the snapshot's sort, grouping, sum
 *  field, bar filter and columns where they still belong to the layer, and no
 *  focus moved. */
async function openTable(req: TableRequest, init?: TableSnapshot): Promise<void> {
  const entry = layerById(req.layerId);
  const d = describe(req.layerId);
  if (!entry || !d.ok || !d.result.queryable) return;
  ensureDrawer();
  sizeAnswer?.(false);
  if (!tbl) {
    const a = document.activeElement as HTMLElement | null;
    opener = a && a !== document.body ? a : null;
  }
  const ordered = orderFields(d.result.fields, d.result.idField);
  const groupables = ordered.filter(f => (f.values || f.valueCount) && !f.list);
  const idField = d.result.idField;
  // A designed default list leads the columns in its own order.
  const pin = TABLE_DEFAULT_COLUMNS[req.layerId] ?? [];
  const at = (f: FieldInfo) => pin.includes(f.name) ? pin.indexOf(f.name) : pin.length;
  const fields = [...ordered].sort((a, b) => at(a) - at(b));
  const names = new Set(fields.map(f => f.name));
  const restoredCols = init?.shown.filter(n => names.has(n)) ?? [];
  if (restoredCols.length) shownCols.set(req.layerId, new Set(restoredCols));
  if (!shownCols.has(req.layerId)) shownCols.set(req.layerId, new Set(defaultColumns(req.layerId, ordered, idField)));
  tbl = {
    req, opts: {}, areaDropped: false, fields, idField, shown: shownCols.get(req.layerId)!,
    canFilter: !validateWhere(req.layerId, []), whereKey: whereKeyOf(req.layerId),
    rows: [], total: 0, truncated: false,
    partial: !d.result.complete, sort: null,
    groupBy: groupables[0]?.name ?? '',
    sumField: defaultSumField(ordered),
    bars: [], groupTotal: 0, rowCount: 0, barFilter: null, checked: new Set(), active: -1,
  };
  if (init) {
    const summable = summableFields(ordered).map(f => f.name);
    if (init.groupBy !== undefined && (init.groupBy === '' || groupables.some(f => f.name === init.groupBy))) tbl.groupBy = init.groupBy;
    if (init.sumField !== undefined && (init.sumField === '' || summable.includes(init.sumField))) tbl.sumField = init.sumField;
    tbl.barFilter = init.barFilter;
    tbl.init = init;
  }
  tbl.sort = tbl.sumField ? { field: tbl.sumField, desc: true } : null;
  if (init?.sort !== undefined && (init.sort === null || names.has(init.sort.field))) tbl.sort = init.sort;
  showColPanel(false);
  syncColsButton();
  $('.td-tab-name').dataset.i18n = entry.titleKey;
  $('.td-tab-name').textContent = t(entry.titleKey);
  $<HTMLSelectElement>('.td-groupby').replaceChildren(
    ...groupables.map(f => new Option(f.name, f.name)));
  $<HTMLSelectElement>('.td-groupby').value = tbl.groupBy;
  $('.td-group-ctl').hidden = !groupables.length;
  $<HTMLSelectElement>('.td-sum').replaceChildren(
    new Option(t('table.count'), ''), ...summableFields(ordered).map(f => new Option(f.name, f.name)));
  $<HTMLSelectElement>('.td-sum').value = tbl.sumField;
  $('.td-credit').innerHTML = entry.data!.credit;   // the registry's own credit markup
  open(!!init);
  const mine = ++seq;
  const src = layerSourceId(req.layerId);
  if (entry.data!.kind === 'geojson' && !state.sourcesLoaded[src]) {
    const bytes = await contentLength(layerDataUrl(src));
    if (mine !== seq) return;
    if (bytes > SIZE_WARN_BYTES && !await confirmSize(bytes, !init)) { if (mine === seq) closeTable(); return; }
  } else if (hasColumns(req.layerId)) {
    const bytes = await columnsBytes(req);
    if (mine !== seq) return;
    if (bytes > SIZE_WARN_BYTES && !await confirmSize(bytes, !init)) { if (mine === seq) closeTable(); return; }
  }
  await load(mine, true);
}

/** Compressed bytes a dataset-scope table open plans to read from the layer's columns file (the test and id
 *  columns of the row groups its conditions leave); 0 when the file cannot be used, where the view answers. */
async function columnsBytes(req: TableRequest): Promise<number> {
  const opts = resolveOpts(req);
  const dataset = layerById(req.layerId)?.dataset;
  if (opts.ids || !dataset) return 0;
  try {
    const cols = await import('../columns/columns-read.js');
    const e = await cols.columnsEntry(dataset);
    if (!e.ok) return 0;
    const conds: Condition[] = [...(opts.where ?? [])];
    const add = (a: AreaFilter | null | undefined) => {
      const c = a && areaCondition(dataset, a);
      if (c && c !== 'all' && !('unfiltered' in c)) conds.push(c);
    };
    add(opts.area);
    if (opts.asDrawn) { conds.push(...(state.where[req.layerId] ?? [])); add(state.area); }
    const groups = cols.pruneGroups(await cols.columnsMeta(e.result), conds);
    return await cols.plannedBytes(e.result, groups, cols.columnsFor(e.result, conds, [], [], { rows: true }));
  } catch { return 0; }
}

export async function zoomToSelection(): Promise<void> {
  const sel = state.sel;
  if (!sel) return;
  const boxes: BBox[] = [];
  for (const [layerId, ids] of Object.entries(sel.ids)) {
    if (!ids.length) continue;
    const r = await query(layerId, { ids, limit: QUERY_MAX_ROWS });
    if (r.ok) for (const row of r.result.rows) { const b = bbox(row.feature.geometry); if (b) boxes.push(b); }
  }
  if (boxes.length) fitTo(boxes.reduce(union), false);
}

export function closeTable() {
  if (!drawer) return;
  act();
  seq++;
  sizeAnswer?.(false);
  showColPanel(false);
  clearHighlights('table');
  tbl = null;
  const back = opener;
  opener = null;
  afterClose(back);
}

/** After a pane closes: the drawer stays while another pane is open (focus
 *  to `back`, else into the pane now in view, else its tab when `toTab`),
 *  else it hides and focus goes to `back`, else the map (the popup's "Show in
 *  table" button is gone once the popup closes). */
function afterClose(back: HTMLElement | null, toTab = false) {
  if (FALLBACK.some(paneOpen)) {
    syncPanes();
    if (pane === 'table') showGrid();
    const into = toTab || (pane !== 'ask' && pane !== 'table') ? null
      : pane === 'ask' ? drawer!.querySelector<HTMLElement>('.chat-input') : gridFocus();
    (back?.isConnected ? back : into ?? $(TAB_OF[pane])).focus();
    return;
  }
  hideDrawer();
  (back?.isConnected ? back : state.map?.getCanvas())?.focus();
}

function hideDrawer() {
  drawer!.classList.remove('td--open');
  drawer!.hidden = true;
  mapContainer()?.classList.remove('has-drawer');
}

/** On a phone the layer panel and the drawer together leave little map: the
 *  drawer coming up folds the panel away (its own close button, so the Layers
 *  button comes back). */
function foldLayersOnPhone() {
  const c = mapContainer(), lp = document.getElementById('layersPanel');
  if (!c || !lp || lp.hidden) return;
  if (c.clientWidth <= 640 || window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches) document.getElementById('closeLayers')?.click();
}

/** Show the drawer if it is closed (at the layout's default height), or
 *  expand it if it is collapsed. */
function showDrawer() {
  if (drawer!.classList.contains('td--open') && !collapsed) return;
  foldLayersOnPhone();
  drawer!.hidden = false;
  drawer!.classList.add('td--open');
  mapContainer()!.classList.add('has-drawer');
  collapsed = false;
  applyHeight();
}

// ─── The side panes (Ask, Visualize, Line, Proximity, Grid Ops, Route) ───────
/** Open a side pane and bring it into view; `onClose` runs when it closes, and
 *  focus then returns to `from` (default: the focused element). With
 *  `background` (the map chat's route) the pane opens or stays open but the
 *  pane in view stays in view; focus and the opener are left as they are. */
function openSide(p: Side, onClose?: () => void, from?: HTMLElement | null, background = false): void {
  ensureDrawer();
  const s = P[p], o = SIDE[p];
  if (!s.open && !background) {
    const a = from ?? document.activeElement as HTMLElement | null;
    s.opener = a && a !== document.body && !drawer!.contains(a) ? a : null;
  }
  if (o.visitor && !o.resuming?.()) act();
  const keep = background && !drawer!.hidden && paneOpen(pane);
  s.open = true;
  s.onClose = onClose ?? null;
  if (!keep) pane = p;
  showDrawer();
  if (o.height) applyHeight();
  syncPanes();
}

/** Close a side pane; the drawer stays while another pane is open. Focus goes
 *  back to what opened it, else another open pane's tab (Ask: the table, else
 *  the map). */
function closeSide(p: Side): void {
  const s = P[p], o = SIDE[p];
  if (!s.open || !drawer) return;
  if (o.visitor) act();
  s.open = false;
  o.off?.();
  s.onClose?.();
  const back = s.opener;
  s.opener = null;
  afterClose(back, p !== 'ask');
}

/** The Ask tab's panel, empty until ui-chat.ts builds the chat in it. */
export function askPanel(): HTMLElement {
  ensureDrawer();
  return $('#td-ask');
}
export const openAsk = (onClose?: () => void, from?: HTMLElement | null): void => openSide('ask', onClose, from);
export const closeAsk = (): void => closeSide('ask');

/** The Visualize tab's panel, empty until ui-templates.ts builds the gallery in it. */
export function vizPanel(): HTMLElement {
  ensureDrawer();
  return $('#td-viz');
}
export const openViz = (onClose?: () => void, from?: HTMLElement | null): void => openSide('viz', onClose, from);
export const closeViz = (): void => closeSide('viz');
export const vizOpen = (): boolean => P.viz.open;

/** The Line tab's panel, empty until ui-line.ts builds the line tools in it. */
export function linePanel(): HTMLElement {
  ensureDrawer();
  return $('#td-line');
}
export const openLine = (onClose?: () => void, from?: HTMLElement | null): void => openSide('line', onClose, from);
export const closeLine = (): void => closeSide('line');
export const lineOpen = (): boolean => P.line.open;

/** The Proximity tab's panel, empty until ui-proximity.ts builds the tool in it. */
export function proxPanel(): HTMLElement {
  ensureDrawer();
  return $('#td-prox');
}
export const openProx = (onClose?: () => void, from?: HTMLElement | null): void => openSide('prox', onClose, from);
export const closeProx = (): void => closeSide('prox');
export const proxOpen = (): boolean => P.prox.open;

/** The Grid Ops tab's panel, empty until ui-grid-ops.ts builds in it. */
export function gopsPanel(): HTMLElement {
  ensureDrawer();
  return $('#td-gops');
}
export const openGops = (onClose?: () => void, from?: HTMLElement | null): void => openSide('gops', onClose, from);
export const closeGops = (): void => closeSide('gops');
export const gopsOpen = (): boolean => P.gops.open;

/** The Route tab's panel, empty until the route planner builds in it. */
export function routePanel(): HTMLElement {
  ensureDrawer();
  return $('#td-route');
}

/** The route planner's slot in the drawer header, shown only while the Route
 *  pane is. */
export function routeActions(): HTMLElement {
  ensureDrawer();
  return $('.td-route-actions');
}
export const openRoute = (onClose?: () => void, from?: HTMLElement | null, opts?: { background?: boolean }): void =>
  openSide('route', onClose, from, !!opts?.background);
export const closeRoute = (): void => closeSide('route');
export const routeOpen = (): boolean => P.route.open;

/** While on, the drawer is at least ROUTE_TALL_PX high (within the map); off,
 *  it is back at the height it had. */
export function setRouteTall(on: boolean): void {
  routeTall = on;
  if (drawer && !drawer.hidden) applyHeight();
}

const TAB_OF: Record<Pane, string> = { ask: '#td-tab-ask', table: '#td-tab', route: '#td-tab-route', viz: '#td-tab-viz', line: '#td-tab-line', prox: '#td-tab-prox', gops: '#td-tab-gops' };
const PANE_OF: Record<string, Pane> = { 'td-tab-ask': 'ask', 'td-tab': 'table', 'td-tab-viz': 'viz', 'td-tab-line': 'line', 'td-tab-prox': 'prox', 'td-tab-gops': 'gops', 'td-tab-route': 'route' };
const paneOpen = (p: Pane) => p === 'table' ? !!tbl : P[p].open;
const FALLBACK: Pane[] = ['table', 'ask', 'viz', 'line', 'prox', 'gops', 'route'];

function closePane(p: Pane) {
  if (p === 'table') closeTable(); else closeSide(p);
}

/** Which pane shows: the one in view, the others hidden but kept. */
function syncPanes() {
  if (!drawer) return;
  if (!paneOpen(pane)) pane = FALLBACK.find(paneOpen) ?? 'table';
  const shown = Object.fromEntries(FALLBACK.map(p => [p, paneOpen(p) && pane === p])) as Record<Pane, boolean>;
  for (const p of ['ask', 'table', 'viz', 'line', 'prox', 'gops', 'route'] as const) {
    const tab = $(TAB_OF[p]);
    tab.hidden = !paneOpen(p);
    tab.setAttribute('aria-selected', String(shown[p]));
    tab.tabIndex = pane === p ? 0 : -1;
    const x = $(`.td-tab-x[data-pane="${p}"]`);
    x.hidden = tab.hidden;
    x.setAttribute('aria-label', t('table.closeTab', { name: tab.lastElementChild?.textContent ?? '' }));
    x.title = x.getAttribute('aria-label')!;
  }
  $('#td-ask').hidden = !shown.ask;
  $('#td-viz').hidden = !shown.viz;
  $('#td-line').hidden = !shown.line;
  $('#td-prox').hidden = !shown.prox;
  $('#td-gops').hidden = !shown.gops;
  $('#td-route').hidden = !shown.route;
  $('.td-route-actions').hidden = !shown.route;
  drawer.classList.toggle('td--table-off', !shown.table);
  touched();
}

function selectPane(p: Pane, focus = false) {
  if (!paneOpen(p)) return;
  pane = p;
  syncPanes();
  if (p === 'table') showGrid();
  if (focus) $(TAB_OF[p]).focus();
}

// ─── Fields and options ──────────────────────────────────────────────────────
// Name-like display fields first, then the schema's fields, the region lists,
// and the id column last. The rank is also the Columns panel's group.
const rankOf = (f: FieldInfo, idField: string) => f.name === idField ? 3 : !f.ops.length ? 0 : f.list ? 2 : 1;
const RANK_KEYS = ['table.colGroupNames', 'table.colGroupFields', 'table.colGroupRegions', 'table.colGroupId'];

function orderFields(fields: FieldInfo[], idField: string): FieldInfo[] {
  return [...fields].sort((a, b) => rankOf(a, idField) - rankOf(b, idField));
}

// The columns a table starts with: a designed list for the layers whose table
// was laid out column by column, else every field but the region lists and
// the id. Shown columns are a render choice only — the query, the sort, the
// group-by and the CSV keep every allowed field.
export const TABLE_DEFAULT_COLUMNS: Record<string, string[]> = {
  'eia-generators': ['plant_name', 'technology', 'nameplate_mw', 'gen_status', 'op_year', 'state', 'ba_code', 'utility_name'],
  'osm-substations-points': ['name', 'operator', 'nominal_kv', 'sub_type', 'countries', 'admin1'],
  'osm-substations-polygons': ['name', 'operator', 'nominal_kv', 'sub_type', 'countries', 'admin1'],
};

/** Layer id → the columns shown; kept for the session, not across reloads. */
const shownCols = new Map<string, Set<string>>();

export function defaultColumns(layerId: string, fields: FieldInfo[], idField: string): string[] {
  const names = new Set(fields.map(f => f.name));
  const list = TABLE_DEFAULT_COLUMNS[layerId]?.filter(n => names.has(n));
  return list?.length ? list : fields.filter(f => !f.list && f.name !== idField).map(f => f.name);
}

/** The field the summary sums and the rows sort by at first: an MW field,
 *  else the first number field that is not a year or a level (kV); '' = count. */
const summableFields = (fields: FieldInfo[]) => fields.filter(f => f.type === 'number' && f.ops.length && f.additive !== false && !/year/i.test(f.name));

export function defaultSumField(fields: FieldInfo[]): string {
  const summable = summableFields(fields);
  return summable.find(f => isMw(f.name))?.name ?? summable[0]?.name ?? '';
}

// What a bare request means: what the map draws when the layer is on, else the
// view's own `where` and Area for the layer.
function resolveOpts(req: TableRequest): QueryOpts {
  if (req.where || req.area !== undefined || req.asDrawn !== undefined || req.ids) {
    return { where: req.where, area: req.area ?? null, asDrawn: req.asDrawn, ids: req.ids };
  }
  if (state.layerVisibility[req.layerId]) return { asDrawn: true };
  return { where: state.where[req.layerId], area: state.area };
}

// `short`: a pill on screen names at most MAX_PILL_VALUES values of a filter;
// the CSV's note row names them all.
function pillsFor(layerId: string, opts: QueryOpts, areaDropped: boolean, short = true): string[] {
  const out: string[] = [];
  const area = opts.asDrawn ? state.area : opts.area;
  if (opts.asDrawn) out.push(t('table.asDrawn'));
  if (opts.ids) out.push(t('table.onlySelected', { n: opts.ids.length }));
  // The Area comes before the legend filters, so a phone's one-line footer shows it.
  if (area) {
    const names = area.codes.map(c => areaLabel(areaLabelsNow(), area.kind, c));
    out.push(`${t('area.title')}: ${names.length > 3 ? t('area.selected', { n: names.length }) : names.join(', ')}`);
  }
  if (areaDropped) out.push(t('table.areaNotApplied'));
  if (opts.asDrawn) {
    for (const { title, values } of drawnFilterLabels(layerId)) {
      const more = short ? values.length - MAX_PILL_VALUES : 0;
      const shown = more > 0 ? [...values.slice(0, MAX_PILL_VALUES), t('table.more', { n: more })] : values;
      out.push(`${title}: ${shown.join(', ') || '—'}`);
    }
  }
  for (const c of (opts.asDrawn ? state.where[layerId] : opts.where) ?? []) out.push(conditionLabel(c));
  return out;
}

function barsOf(groups: Group[], groupBy: string, sumField: string): Bar[] {
  const fold = fuelFold(groupBy);
  const bars = new Map<string, Bar>();
  for (const g of groups) {
    const k = fold ? fold(g.key) : { id: String(g.key ?? ''), label: g.key === null ? '—' : String(g.key) };
    let b = bars.get(k.id);
    if (!b) bars.set(k.id, b = { ...k, keys: [], count: 0, sum: 0 });
    if (g.key !== null) b.keys.push(g.key);
    b.count += g.count;
    b.sum += sumField ? g.sums[sumField] ?? 0 : g.count;
  }
  return [...bars.values()].sort((a, b) => b.sum - a.sum);
}

// ─── Loading ─────────────────────────────────────────────────────────────────
async function contentLength(url: string | undefined): Promise<number> {
  if (!url) return 0;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return Number(r.headers.get('content-length')) || 0;
  } catch { return 0; }
}

// The open size prompt's answer; closing the drawer or the next showTable()
// answers it "no", so a caller awaiting showTable() (the chat) always resumes.
let sizeAnswer: ((ok: boolean) => void) | null = null;

function confirmSize(bytes: number, focus = true): Promise<boolean> {
  selectPane('table');
  return new Promise(resolve => {
    sizeAnswer = ok => { sizeAnswer = null; resolve(ok); };
    status = null;
    const line = $('.td-status');
    line.hidden = false;
    line.replaceChildren(document.createTextNode(t('table.sizeWarn', { size: `${fmt(bytes / 1048576)} MB` }) + ' '));
    const btn = (label: string, ok: boolean) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'td-btn';
      b.textContent = label;
      b.addEventListener('click', () => sizeAnswer?.(ok));
      return b;
    };
    const load = btn(t('table.load'), true);
    line.append(load, btn(t('table.cancel'), false));
    if (focus) load.focus();
  });
}

type StatusKind = 'info' | 'warn' | 'error';
// The status line's key, so lang:changed can redraw it; null = empty or the size prompt.
let status: { key: string; params?: Record<string, string | number>; kind: StatusKind } | null = null;

function setStatus(key = '', params?: Record<string, string | number>, kind: StatusKind = 'info') {
  status = key ? { key, params, kind } : null;
  const s = $('.td-status');
  s.hidden = !key;
  s.dataset.kind = kind;
  s.textContent = key ? t(key, params) : '';
}

/** Run the query and the summary for the open table. `fresh`: a new request
 *  (resolve the options, run the summary); else a sort or bar change. */
async function load(mine: number, fresh: boolean) {
  const tb = tbl!;
  setStatus('table.loading');
  if (fresh) {
    tb.opts = resolveOpts(tb.req);
    // The summary doubles as the check of the options: an Area that cannot
    // reach this layer is dropped (and says so) rather than failing the table.
    const summary = (o: QueryOpts): Promise<Outcome<AggregateResult | CountResult>> => tb.groupBy
      ? aggregate(tb.req.layerId, { ...o, groupBy: tb.groupBy, sum: tb.sumField ? [tb.sumField] : [] })
      : count(tb.req.layerId, o);
    let areaDropped = false;
    let s = await summary(tb.opts);
    if (!s.ok && tb.opts.area && !tb.opts.asDrawn && s.code === 'area-unreachable') {
      tb.opts = { ...tb.opts, area: null };
      areaDropped = true;
      s = await summary(tb.opts);
    }
    if (mine !== seq) return;
    tb.areaDropped = areaDropped;
    tb.bars = s.ok && 'groups' in s.result ? barsOf(s.result.groups, tb.groupBy, tb.sumField) : [];
    tb.groupTotal = tb.groupBy ? tb.bars.reduce((a, b) => a + b.sum, 0) : s.ok ? s.result.total : 0;
    tb.rowCount = s.ok ? s.result.total : 0;
    // A bar filter (restored, or kept across a new `where`) holds only while its bar is still there.
    if (!tb.bars.some(b => b.id === tb.barFilter && b.keys.length)) tb.barFilter = null;
  }
  const bar = tb.bars.find(b => b.id === tb.barFilter);
  const where = bar ? [...(tb.opts.where ?? []), { field: tb.groupBy, op: 'in', value: bar.keys } as Condition] : tb.opts.where;
  const fields = tb.fields.map(f => f.name);
  const r = await query(tb.req.layerId, { ...tb.opts, where, fields, limit: QUERY_MAX_ROWS,
    ...(tb.sort && { orderBy: tb.sort }) });
  if (mine !== seq) return;
  const init = tb.init;
  tb.init = undefined;
  if (!r.ok) { setStatus('table.error', { reason: r.reason }, 'error'); return; }
  tb.rows = r.result.rows;
  tb.total = r.result.total;
  tb.truncated = r.result.truncated;
  tb.partial = !r.result.complete;
  if (!bar) tb.rowCount = r.result.total;
  // A popup's feature beyond the row limit still gets its row, first.
  const focus = tb.req.focusId;
  if (fresh && focus !== undefined && !tb.rows.some(x => x.id === focus)) {
    const one = await query(tb.req.layerId, { ...tb.opts, ids: [focus], fields, limit: 1 });
    if (mine !== seq) return;
    if (one.ok && one.result.rows.length) tb.rows = [...one.result.rows, ...tb.rows];
  }
  tb.active = fresh && focus !== undefined ? tb.rows.findIndex(x => x.id === focus) : -1;
  const ids = new Set(tb.rows.map(x => x.id));
  // Checked rows and the active row come back only while they are still rows;
  // a new `where` keeps the checks still in the table.
  if (init) tb.checked = new Set(init.checked.filter(id => ids.has(id)));
  else if (fresh) tb.checked = new Set([...tb.checked].filter(id => ids.has(id)));
  if (init?.active != null) tb.active = tb.rows.findIndex(x => x.id === init.active);
  setStatus(tb.partial ? 'table.partial' : !tb.rows.length ? 'table.empty' : '', undefined, tb.partial ? 'warn' : 'info');
  render();
  await fill(tb, init ? init.scrollTop : 0);
  if (mine !== seq || tb.active < 0) return;
  if (!init) grid!.scrollToRow(tb.active, 'center', false).catch(() => {});
  showRow(tb.active, false);
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  const tb = tbl!;
  $('.td-pills').replaceChildren(...pillsFor(tb.req.layerId, tb.opts, tb.areaDropped).map(p => Object.assign(document.createElement('span'), { className: 'td-pill', textContent: p })));
  $('.td-count').textContent = tb.truncated
    ? t('table.rowsOf', { n: fmt(tb.rows.length, 0), total: fmt(tb.total, 0) })
    : t('table.rows', { n: fmt(tb.total, 0) });
  renderSummary();
  markHeader();
  syncChecks();
  syncUnfilter();
  touched();
}

function renderSummary() {
  const tb = tbl!;
  $('.td-total').textContent = fmtSum(tb.groupTotal, tb.groupBy ? tb.sumField : '');
  $('.td-total-sub').textContent = t('table.rows', { n: fmt(tb.rowCount, 0) });
  const max = Math.max(...tb.bars.map(b => b.sum), 1);
  const list = $('.td-bars');
  list.replaceChildren(...tb.bars.slice(0, MAX_BARS).map(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'td-bar';
    btn.dataset.bar = b.id;
    btn.setAttribute('aria-pressed', String(tb.barFilter === b.id));
    btn.disabled = !b.keys.length;
    btn.innerHTML = `<span class="td-bar-sw"></span><span class="td-bar-name truncate"></span>`
      + `<span class="td-bar-track"><span class="td-bar-fill"></span></span><span class="td-bar-val"></span>`;
    (btn.querySelector('.td-bar-sw') as HTMLElement).style.background = b.color ?? '#94a3b8';
    (btn.querySelector('.td-bar-fill') as HTMLElement).style.width = `${(Math.max(b.sum, 0) / max) * 100}%`;
    (btn.querySelector('.td-bar-fill') as HTMLElement).style.background = b.color ?? 'var(--accent)';
    btn.querySelector('.td-bar-name')!.textContent = b.label;
    btn.querySelector('.td-bar-val')!.textContent = fmtSum(b.sum, tb.sumField);
    btn.title = `${b.label}: ${fmtSum(b.sum, tb.sumField)} · ${t('table.rows', { n: fmt(b.count, 0) })}`;
    return btn;
  }));
  rove(list, '.td-bar', `[data-bar="${CSS.escape(tb.barFilter ?? '')}"]`, list.contains(document.activeElement));
  const more = tb.bars.length - MAX_BARS;
  $('.td-more').textContent = more > 0 ? t('table.more', { n: more }) : '';
  $('.td-note').textContent = tb.sumField === 'nameplate_mw' ? t('table.nameplateNote') : '';
  // The folded one-line summary (compact layouts, style.css): total, rows, a
  // stacked bar of the groups, the bar filter in force, the sort column (the
  // footer's "sorted by" is hidden there) and "by <field>".
  $('.td-fold-total').textContent = $('.td-total').textContent;
  $('.td-fold-rows').textContent = $('.td-total-sub').textContent;
  const whole = tb.bars.reduce((a, b) => a + Math.max(b.sum, 0), 0) || 1;
  $('.td-fold-bar').replaceChildren(...tb.bars.slice(0, MAX_BARS).map(b => {
    const seg = document.createElement('span');
    seg.style.width = `${(Math.max(b.sum, 0) / whole) * 100}%`;
    seg.style.background = b.color ?? '#94a3b8';
    return seg;
  }));
  $('.td-fold-bar').hidden = !tb.bars.length;
  const bar = tb.bars.find(b => b.id === tb.barFilter);
  $('.td-fold-filter').textContent = bar ? `${tb.groupBy}: ${bar.label}` : '';
  $('.td-fold-sort').textContent = tb.sort ? `${tb.sort.desc ? '▼' : '▲'} ${tb.sort.field}` : '';
  $('.td-fold-by').textContent = tb.groupBy
    ? `${t('table.byField', { field: tb.groupBy })} ${$('.td-fold').getAttribute('aria-expanded') === 'true' ? '▾' : '▸'}` : '';
}

// ─── The grid (Tabulator) ────────────────────────────────────────────────────
// Keybindings moves the range with the arrow keys. Enter, Space and Ctrl+C
// are this module's, taken before SelectRange (whose Enter would start an
// editor no column has). The
// copy is this module's own (copyRange): Tabulator's clipboard module writes
// every copied value into an HTML table through innerHTML, so it is left out.
Tabulator.registerModule([
  FormatModule, FrozenColumnsModule, InteractionModule, KeybindingsModule,
  MoveColumnsModule, ResizeColumnsModule, SelectRangeModule,
]);

/** A grid row: its index in tbl.rows, then each field's raw value under its
 *  position (`f0`…), never its name (a dot in a name is a path to Tabulator). */
type GridRow = Record<string, unknown> & { _i: number };

let grid: Tabulator | null = null;
let gridReady: Promise<void> = Promise.resolve();
let colsKey = '';          // the layer and shown columns the grid's columns were built for
let headKey = '';          // the header control holding the header's one tab stop (data-head)
let movedAt = 0;           // a column drag just ended: the click it ends with is no sort
const widths = new Map<string, number>();   // `layer:field` → a dragged width, for the session

const keyOf = (tb: Table, name: string) => `f${tb.fields.findIndex(f => f.name === name)}`;
const nameOf = (tb: Table, key: string) => tb.fields[Number(key.slice(1))]?.name;
const holderEl = () => drawer?.querySelector<HTMLElement>('.td-grid .tabulator-tableholder') ?? null;
const gridFocus = () => holderEl() ?? $('.td-grid');

// A number column with a long name (nameplate_mw) gets room for it, the sort arrow and the ▾.
const colWidth = (f: FieldInfo) => !f.ops.length ? 180 : f.type === 'number' ? (f.name.length > 10 ? 140 : 108) : f.list ? 120 : 130;

const shownFields = (tb: Table) => [...tb.shown].map(n => tb.fields.find(f => f.name === n)).filter((f): f is FieldInfo => !!f);

export { clipValue };

function makeGrid(el: HTMLElement): Tabulator {
  const g = new Tabulator(el, {
    height: '100%',
    layout: 'fitData',
    index: '_i',
    ...GRID_RANGE_DEFAULTS,
    movableColumns: true,
    // Ctrl/Cmd+C is copyRange's (no clipboard module); Tab leaves the grid.
    keybindings: { ...GRID_RANGE_DEFAULTS.keybindings, copyToClipboard: false },
    rowHeader: {
      field: '_i', resizable: false, frozen: true, cssClass: 'td-check',
      hozAlign: 'center', headerHozAlign: 'center', width: 34,
      titleFormatter: checkAllCell, formatter: checkCell,
    } as unknown as boolean,
    rowFormatter: paintRow,
    columns: [],
    data: [],
  });
  gridReady = new Promise(resolve => g.on('tableBuilt', () => {
    const head = el.querySelector<HTMLElement>('.tabulator-header');
    if (head) wireHeaderKeys(head);
    resolve();
  }));
  // A click makes the row active and highlights its feature (the camera stays
  // still; the row's arrow and Enter fly); a drag across cells makes a range
  // and clicks no row.
  g.on('rowClick', (ev, row) => {
    if (!tbl || (ev.target as HTMLElement).closest('.td-check')) return;
    activate((row.getData() as GridRow)._i, false);
  });
  // The shown columns take the order the drag left (kept in tm-drawer).
  g.on('columnMoved', () => {
    movedAt = Date.now();
    const tb = tbl;
    if (!tb) return;
    const order = g.getColumns().map(c => nameOf(tb, c.getField() ?? '')).filter((n): n is string => !!n && tb.shown.has(n));
    tb.shown = new Set(order);
    shownCols.set(tb.req.layerId, tb.shown);
    colsKey = colsKeyOf(tb);
    touched();
  });
  g.on('columnResized', col => {
    const name = tbl && nameOf(tbl, col.getField() ?? '');
    if (name) widths.set(`${tbl!.req.layerId}:${name}`, col.getWidth());
  });
  g.on('scrollVertical', (top: number) => { gridScroll = top; queueRange(); });
  return g;
}

function checkAllCell(): HTMLElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'td-check-all';
  box.dataset.head = '';      // first in the header's roving group
  box.tabIndex = headKey === '' ? 0 : -1;
  box.setAttribute('aria-label', t('table.checkAll'));
  keepFromGrid(box);
  box.addEventListener('change', () => {
    const tb = tbl;
    if (!tb) return;
    tb.checked = new Set(box.checked ? tb.rows.map(r => r.id).filter((x): x is FeatureId => x !== null) : []);
    repaintChecks();
  });
  return box;
}

function checkCell(cell: CellComponent): HTMLElement {
  const i = (cell.getData() as GridRow)._i;
  const id = tbl?.rows[i]?.id ?? null;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.tabIndex = -1;
  box.dataset.i = String(i);
  box.checked = id !== null && !!tbl?.checked.has(id);
  box.disabled = id === null;
  box.setAttribute('aria-label', t('table.checkRow'));
  keepFromGrid(box);
  box.addEventListener('change', () => toggleCheck([i]));
  return box;
}

function paintRow(row: RowComponent) {
  const i = (row.getData() as GridRow)._i;
  const el = row.getElement();
  const tb = tbl;
  const id = tb?.rows[i]?.id;
  el.classList.add('td-row');
  el.dataset.i = String(i);
  el.classList.toggle('td-row--active', !!tb && tb.active === i);
  el.setAttribute('aria-selected', String(id !== null && id !== undefined && !!tb?.checked.has(id)));
}

const colsKeyOf = (tb: Table) => `${tb.req.layerId}|${[...tb.shown].join(',')}`;

/** The narrow frozen column of per-row "Zoom to" arrows, after the check column. */
function zoomColumn(): ColumnDefinition {
  return {
    title: '', field: '_i', frozen: true, resizable: false, headerSort: false, movable: false,
    cssClass: 'td-zoom', hozAlign: 'center', width: 30,
    titleFormatter: () => Object.assign(document.createElement('span'), { className: 'td-zoom-head' }),
    formatter: zoomCell,
  } as ColumnDefinition;
}

function zoomCell(cell: CellComponent): HTMLElement {
  const i = (cell.getData() as GridRow)._i;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'td-zoom-btn';
  btn.tabIndex = -1;
  btn.textContent = '↗';
  btn.title = t('table.zoomTo');
  btn.setAttribute('aria-label', t('table.zoomTo'));
  keepFromGrid(btn);
  btn.addEventListener('click', () => activate(i, true));
  return btn;
}

function columnsOf(tb: Table): ColumnDefinition[] {
  return [zoomColumn(), ...shownFields(tb).map(f => ({
    title: f.name,
    field: keyOf(tb, f.name),
    width: widths.get(`${tb.req.layerId}:${f.name}`) ?? colWidth(f),
    hozAlign: f.type === 'number' ? 'right' : 'left',
    cssClass: f.type === 'number' ? 'td-num' : undefined,
    titleFormatter: () => headCell(tb, f),
    formatter: (cell: CellComponent) => document.createTextNode(cellText(f, cell.getValue())) as unknown as HTMLElement,
    headerClick: (ev: UIEvent) => {
      if ((ev.target as HTMLElement).closest('.td-filter-btn') || Date.now() - movedAt < 400) return;
      sortBy(f.name);
    },
  } as ColumnDefinition))];
}

/** A header: the sort button (its click reaches Tabulator's headerClick, so
 *  a hold-and-drag still moves the column), the arrow, and the ▾ filter of a
 *  field the schema gives operators. */
function headCell(tb: Table, f: FieldInfo): HTMLElement {
  const head = document.createElement('span');
  head.className = 'td-head-cell';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'td-sort';
  b.dataset.sort = f.name;
  b.dataset.head = f.name;
  // Born with the header's one tab stop or without it: Tabulator may build
  // a header after markHeader has run.
  b.tabIndex = headKey === f.name ? 0 : -1;
  b.textContent = f.name;
  if (f.description) b.title = f.description;
  const arrow = document.createElement('span');
  arrow.className = 'td-sort-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  head.append(b, arrow);
  if (tb.canFilter && filterKind(f)) {
    const fb = document.createElement('button');
    fb.type = 'button';
    fb.className = 'td-filter-btn';
    fb.dataset.filter = f.name;
    fb.dataset.head = `${f.name}▾`;
    fb.tabIndex = headKey === fb.dataset.head ? 0 : -1;
    fb.setAttribute('aria-haspopup', 'dialog');
    fb.textContent = '▾';
    keepFromGrid(fb);
    fb.addEventListener('click', () => toggleFilter(f.name, fb));
    head.append(fb);
  }
  return head;
}

/** Sort arrows, aria-sort and the ▾ marks, repainted in place (a rebuild
 *  would drop the button an open filter popover hangs from). */
function markHeader() {
  const tb = tbl;
  if (!tb || !grid) return;
  const where = tableWhere(tb);
  for (const col of grid.getColumns()) {
    const name = nameOf(tb, col.getField() ?? '');
    if (!name) continue;
    const el = col.getElement();
    const on = tb.sort?.field === name;
    el.setAttribute('aria-sort', on ? (tb.sort!.desc ? 'descending' : 'ascending') : 'none');
    const arrow = el.querySelector('.td-sort-arrow');
    if (arrow) arrow.textContent = on ? (tb.sort!.desc ? '▼' : '▲') : '';
    const fb = el.querySelector<HTMLElement>('.td-filter-btn');
    if (!fb) continue;
    const conds = where.filter(c => c.field === name);
    fb.classList.toggle('td-filter-btn--on', conds.length > 0);
    fb.title = conds.length ? t('table.filtered', { list: conds.map(conditionLabel).join(' · ') }) : t('table.filter', { field: name });
    fb.setAttribute('aria-label', fb.title);
    fb.setAttribute('aria-expanded', String(filterOpen === name));
  }
  const head = headerEl();
  if (head) rove(head, '[data-head]', `[data-head="${CSS.escape(headKey)}"]`, head.contains(document.activeElement));
}

const headerEl = () => drawer?.querySelector<HTMLElement>('.td-grid .tabulator-header') ?? null;

/** The header is one tab stop: ←→ Home End move over its sort and ▾ buttons,
 *  Enter / Space press one, ↓ enters the rows and Alt+↓ opens the column's
 *  filter. Kept from Tabulator, whose keys would move the cell range. */
function wireHeaderKeys(head: HTMLElement) {
  // SelectRange makes the header a tab stop of its own; its buttons are the one stop.
  head.tabIndex = -1;
  head.addEventListener('focusin', (ev) => {
    const k = (ev.target as HTMLElement).dataset.head;
    if (k !== undefined) headKey = k;
  });
  head.addEventListener('keydown', (ev) => {
    const at = (ev.target as HTMLElement).closest<HTMLElement>('[data-head]');
    if (!at || !/^(Arrow|Home$|End$)/.test(ev.key)) return;
    ev.stopPropagation();
    if (ev.key === 'ArrowDown' && ev.altKey) {
      ev.preventDefault();
      at.closest('.tabulator-col')?.querySelector<HTMLElement>('.td-filter-btn')?.click();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      gridFocus().focus();
    } else {
      roveKey(ev, head, '[data-head]', 'ArrowLeft', 'ArrowRight');
    }
  });
}

/** Put the table's rows in the grid (its columns first, when the layer or the
 *  shown columns changed), then scroll to `scrollTop` (null: stay). A grid
 *  out of view takes the offset when it shows (showGrid). */
async function fill(tb: Table, scrollTop: number | null) {
  await gridReady;
  if (tbl !== tb || !grid) return;
  if (colsKeyOf(tb) !== colsKey) setGridColumns(tb);
  const data = tb.rows.map((r, i) => {
    const o: GridRow = { _i: i };
    tb.fields.forEach((f, c) => { o[`f${c}`] = r.props[f.name]; });
    return o;
  });
  await grid.replaceData(data);
  if (tbl !== tb) return;
  markHeader();
  syncChecks();
  const holder = holderEl();
  if (scrollTop !== null && holder) {
    gridScroll = scrollTop;
    if (holder.clientHeight) { holder.scrollTop = scrollTop; wantScroll = null; } else wantScroll = scrollTop;
  }
  queueRange();
}

function setGridColumns(tb: Table) {
  closeFilter();
  grid!.setColumns(columnsOf(tb));
  colsKey = colsKeyOf(tb);
  markHeader();
}

/** The table pane came into view: lay the grid out again (it was measured
 *  hidden) and give it the offset it was waiting for. */
function showGrid() {
  if (!grid || !tbl) return;
  grid.redraw();
  const holder = holderEl();
  if (holder && wantScroll !== null && holder.clientHeight) { holder.scrollTop = wantScroll; wantScroll = null; }
  queueRange();
}

let rangeFrame = 0;
function queueRange() {
  if (rangeFrame) return;
  rangeFrame = requestAnimationFrame(() => { rangeFrame = 0; writeRange(); });
}

/** The footer's "first–last · sorted by field" over the rows in view. */
function writeRange() {
  const tb = tbl;
  if (!tb || !grid || !drawer) return;
  const at = grid.getRows('visible').map(r => (r.getData() as GridRow)._i);
  const range = at.length ? `${fmt(Math.min(...at) + 1, 0)}–${fmt(Math.max(...at) + 1, 0)}` : '0';
  $('.td-range').textContent = tb.sort ? t('table.rangeSorted', { range, field: tb.sort.field }) : range;
}

/** The range as tab-separated text: a line of field names, then each row's
 *  raw values (clipValue); null when there is no range of data cells. */
function rangeTsv(): { text: string; rows: number; cols: number } | null {
  const tb = tbl;
  const range = grid?.getRanges()[0];
  if (!tb || !range) return null;
  const keys = range.getColumns().map(c => c.getField() ?? '').filter(k => /^f\d+$/.test(k));
  const rows = range.getRows();
  if (!keys.length || !rows.length) return null;
  const text = tsvOf(keys.map(k => nameOf(tb, k)), rows.map(r => { const d = r.getData() as GridRow; return keys.map(k => clipValue(d[k])); }));
  return { text, rows: rows.length, cols: keys.length };
}

/** Ctrl/Cmd+C on the grid: the range to the clipboard as TSV (text only),
 *  then the status line says how much. Inside the keypress, so the copy
 *  command needs no permission; the async Clipboard API is the fallback. */
function copyRange(): boolean {
  const tsv = rangeTsv();
  if (!tsv) return false;
  copyText(tsv.text, () => setStatus('table.copied', { rows: fmt(tsv.rows, 0), cols: fmt(tsv.cols, 0) }));
  return true;
}

/** The rows the range spans (row indexes), top to bottom. */
function rangeRows(): number[] {
  return grid?.getRanges()[0]?.getRows().map(r => (r.getData() as GridRow)._i) ?? [];
}

// One tab stop for a group of controls (the header row, the bars): the one
// matching `current` (else the first) gets tabIndex 0, the rest -1. `focus`
// moves focus there — a rebuild after Enter-to-sort keeps it on the header.
function rove(box: HTMLElement, items: string, current: string, focus = false) {
  const all = [...box.querySelectorAll<HTMLElement>(items)];
  const on = box.querySelector<HTMLElement>(current) ?? all[0];
  for (const el of all) el.tabIndex = el === on ? 0 : -1;
  if (focus) on?.focus();
}

// ←→ (or ↑↓) Home End move focus within a roving group; returns the control
// focused, or null when the key is not a move.
function roveKey(ev: KeyboardEvent, box: HTMLElement, items: string, prev: string, next: string): HTMLElement | null {
  const all = [...box.querySelectorAll<HTMLElement>(items)].filter(el => !(el as HTMLButtonElement).disabled);
  const i = all.indexOf(document.activeElement as HTMLElement);
  const rtl = getComputedStyle(box).direction === 'rtl' && prev === 'ArrowLeft';
  const step = ev.key === (rtl ? next : prev) ? -1 : ev.key === (rtl ? prev : next) ? 1 : 0;
  const to = ev.key === 'Home' ? 0 : ev.key === 'End' ? all.length - 1 : step && i >= 0 ? i + step : -1;
  const el = all[Math.max(0, Math.min(all.length - 1, to))];
  if (to < 0 || !el) return null;
  ev.preventDefault();
  for (const x of all) x.tabIndex = x === el ? 0 : -1;
  el.focus();
  return el;
}

function cellText(f: FieldInfo, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (f.list && typeof v === 'string') return v.split('|').filter(Boolean).join(' ');
  if (f.type === 'number' && typeof v !== 'object') {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toLocaleString(getLocale(), { maximumFractionDigits: 1, useGrouping: !/year/i.test(f.name) });
  }
  return String(v);
}

// "◉ Select n"; a compact layout shows the ◉ only (style.css), so the
// button's name is the whole label.
function setSelectLabel(text: string) {
  const b = $<HTMLButtonElement>('.td-select');
  b.replaceChildren('◉', Object.assign(document.createElement('span'), { className: 'td-select-label', textContent: ` ${text}` }));
  b.setAttribute('aria-label', text);
}

function syncChecks() {
  const tb = tbl!;
  const n = tb.checked.size;
  const all = drawer!.querySelector<HTMLInputElement>('.td-check-all');
  const withId = tb.rows.filter(r => r.id !== null).length;
  if (all) { all.checked = n > 0 && n === withId; all.indeterminate = n > 0 && n < withId; }
  const count = n || (tb.truncated ? 0 : withId);
  const sel = $<HTMLButtonElement>('.td-select');
  setSelectLabel(t('table.select', { n: fmt(count, 0) }));
  sel.disabled = !count || count > MAX_SELECTION_IDS;
  sel.title = count > MAX_SELECTION_IDS || (!n && tb.truncated)
    ? t('table.selectCap', { n: MAX_SELECTION_IDS }) : t('table.selectTitle');
  const copy = $<HTMLButtonElement>('.td-copy');
  copyOffer = null;
  const mode = copyHere(tb.req.layerId);
  const lines = !!mode && mode.noun === 'line';
  copy.hidden = !mode || (!n && compact());   // a phone shows it once a row is checked
  copy.textContent = t(lines ? 'line.copyChecked' : 'table.copyChecked', { n: fmt(n, 0) });
  copy.disabled = !n || n > MAX_COPY_ITEMS;
  copy.title = n > MAX_COPY_ITEMS ? t(lines ? 'line.reason.too-many' : 'copy.reason.too-many')
    : t(lines ? 'line.copyCheckedTitle' : 'table.copyCheckedTitle');
}

// "Copy N checked to My Data": the checked rows into one new My Data layer
// (user-data/copy-rows.ts: exact GeoJSON geometry, a point layer's exact point, or a
// layer's full geometry from its GeoParquet files); the button then says how it went, or offers
// the GeoJSON download when the copy is too big (the next click downloads,
// until the checks change). Shown only once copyAvailable answers true for the
// layer, so a layer or host that cannot copy never shows it.
let copyOffer: (() => void) | null = null;
const copyModes = new Map<string, { noun: 'line' | 'feature' } | false>();

function copyHere(layerId: string): { noun: 'line' | 'feature' } | false {
  const known = copyModes.get(layerId);
  if (known !== undefined) return known;
  copyModes.set(layerId, false);
  void import('../user-data/copy-rows.js').then(async m => {
    const mode = m.copyMode(layerId);
    const ok = await m.copyAvailable(layerId);
    if (ok === null) { copyModes.delete(layerId); return; }
    copyModes.set(layerId, ok && mode !== 'none' ? { noun: m.copyNoun(layerId) } : false);
    if (ok && tbl?.req.layerId === layerId) syncChecks();
  }, () => copyModes.delete(layerId));
  return false;
}

function onCopyClick() {
  if (!copyOffer) { void copyChecked(); return; }
  const download = copyOffer;
  download();
  if (tbl) syncChecks();
}

async function copyChecked() {
  const tb = tbl!;
  const owner = layerById(tb.req.layerId);
  const rows = tb.rows.filter(r => r.id !== null && tb.checked.has(r.id));
  if (!owner || !rows.length) return;
  const btn = $<HTMLButtonElement>('.td-copy');
  btn.disabled = true;
  btn.textContent = t('line.copying');
  const known = copyModes.get(owner.id);
  const lines = !!known && known.noun === 'line';
  try {
    const m = await import('../user-data/copy-rows.js');
    const r = await m.copyRows(owner.id, rows,
      t(lines ? 'line.copyLayer' : 'table.copyLayer', { layer: t(owner.titleKey), n: fmt(rows.length, 0) }),
      state.map?.getZoom());
    showCopyResult(btn, r, false, lines ? 'line' : 'feature', owner.id);
    if (r.kind === 'download') copyOffer = () => downloadCopy(r);
  } catch {
    btn.textContent = t('line.copyFailed', { reason: t(lines ? 'line.reason.offline' : 'copy.reason.failed') });
  }
}

// ─── Column filters (the layer's `where`) ────────────────────────────────────
// A header's ▾ opens a popover over the field's schema: a closed domain's
// values (checkboxes; `in`, or `contains_any` on a region list), a range's
// bounds (≥ / ≤), codes typed as a list, or true / false. Apply replaces the
// field's conditions in the layer's `where` (map-api.ts setWhere: the link's
// validator, one url:write, one undo step) and Clear removes them; a refusal
// is shown in the popover and changes nothing. A popover is a dialog: focus
// moves into it, Esc or a press outside closes it and focus returns to its ▾.
type FilterKind = 'values' | 'codes' | 'range' | 'bool';
const MANY_VALUES = 10;     // a longer value list gets a search box

export function filterKind(f: FieldInfo): FilterKind | null {
  if (f.type === 'boolean') return f.ops.includes('=') ? 'bool' : null;
  if (f.list) return f.ops.includes('contains_any') ? (f.values ? 'values' : 'codes') : null;
  if (f.values && f.ops.includes('in')) return 'values';
  if (f.ops.includes('>=') && f.ops.includes('<=')) return 'range';
  return f.ops.includes('in') ? 'codes' : null;
}

/** The conditions the table applies: the view's for a table drawn as the map
 *  draws, else its own. */
const tableWhere = (tb: Table): Condition[] => (tb.opts.asDrawn ? state.where[tb.req.layerId] : tb.opts.where) ?? [];
const whereKeyOf = (layerId: string) => JSON.stringify(state.where[layerId] ?? []);
const followsView = (req: TableRequest) => !(req.where || req.area !== undefined || req.asDrawn !== undefined || req.ids);

let filterOpen: string | null = null;     // the field whose popover is open
let filterBtnEl: HTMLElement | null = null;
let applyingFilter = false;               // our own setWhere: its url:write reloads nothing

/** The layer's `where` changed: a table that follows the view reloads. */
function onViewWhere() {
  syncUnfilter();
  const tb = tbl;
  if (!tb || applyingFilter || !followsView(tb.req)) return;
  const key = whereKeyOf(tb.req.layerId);
  if (key === tb.whereKey) return;
  tb.whereKey = key;
  closeFilter();
  void load(++seq, true);
}

/** What narrows the table's rows now: a selection-only request, a summary bar,
 *  the layer's column conditions, or (a table drawn as the map draws) an
 *  isolating selection. */
function isolating(tb: Table): boolean {
  return !!tb.opts.asDrawn && state.sel?.mode === 'isolate' && !!state.sel.ids[tb.req.layerId]?.length;
}
const narrowed = (tb: Table) => !!(tb.req.ids || tb.barFilter || tableWhere(tb).length || isolating(tb));

function syncUnfilter() {
  if (drawer) $('.td-unfilter').hidden = !tbl || !narrowed(tbl);
}

/** Show all rows: drop the summary bar, the selection-only request and the
 *  layer's column conditions (map-api setWhere, one undo step), and let an
 *  isolating selection keep its features while the others show again. */
function showAllRows() {
  const tb = tbl;
  if (!tb) return;
  const layerId = tb.req.layerId;
  tb.barFilter = null;
  if (state.where[layerId]?.length) {
    applyingFilter = true;
    try { setWhere(layerId, []); } finally { applyingFilter = false; }
  }
  const sel = state.sel;
  if (isolating(tb) && sel) commitSelection({ ...sel, mode: 'keep' });
  if (!followsView(tb.req)) tb.req = { layerId };
  tb.whereKey = whereKeyOf(layerId);
  closeFilter();
  void load(++seq, true);
  gridFocus().focus({ preventScroll: true });
}

function closeFilter(refocus = false) {
  if (!drawer || filterOpen === null) return;
  const pop = $('.td-filterpop');
  pop.hidden = true;
  pop.replaceChildren();
  filterOpen = null;
  const back = filterBtnEl;
  filterBtnEl = null;
  back?.setAttribute('aria-expanded', 'false');
  if (refocus && back?.isConnected) back.focus();
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') =>
  Object.assign(document.createElement(tag), { className: cls, textContent: text });

function toggleFilter(name: string, btn: HTMLElement) {
  if (filterOpen === name) { closeFilter(true); return; }
  closeFilter();
  const tb = tbl;
  const f = tb?.fields.find(x => x.name === name);
  const kind = f && filterKind(f);
  if (!tb || !f || !kind) return;
  filterOpen = name;
  filterBtnEl = btn;
  btn.setAttribute('aria-expanded', 'true');
  const pop = $('.td-filterpop');
  const cur = tableWhere(tb).filter(c => c.field === name);
  const title = el('div', 'td-fp-title', name);
  title.id = 'td-fp-title';
  pop.setAttribute('aria-labelledby', 'td-fp-title');
  const body = el('div', 'td-fp-body');
  const err = el('div', 'td-fp-err');
  err.setAttribute('role', 'alert');
  let read: () => Condition[];
  const op = f.list ? 'contains_any' : 'in';
  const curValues = cur.flatMap(c => Array.isArray(c.value) ? c.value : c.op === 'has' ? [] : [c.value]).map(String);
  if (kind === 'values') {
    const picked = new Set(curValues);
    const list = el('div', 'td-fp-list');
    const boxes = f.values!.map(v => {
      const label = el('label', 'td-fp-opt');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: v, checked: picked.has(v) });
      label.append(box, el('span', '', v));
      return label;
    });
    list.append(...boxes);
    if (boxes.length > MANY_VALUES) {
      const search = Object.assign(document.createElement('input'), { type: 'search', className: 'td-fp-search', placeholder: t('table.filterSearch') });
      search.setAttribute('aria-label', t('table.filterSearch'));
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const b of boxes) b.hidden = !!q && !b.textContent!.toLowerCase().includes(q);
      });
      body.append(search);
    }
    body.append(list);
    read = () => {
      const vals = boxes.map(b => b.querySelector('input')!).filter(b => b.checked).map(b => b.value);
      return vals.length ? [{ field: name, op, value: vals }] : [];
    };
  } else if (kind === 'codes') {
    const input = Object.assign(document.createElement('input'), { type: 'text', className: 'td-fp-text', value: curValues.join(', '), placeholder: t('table.filterList') });
    input.setAttribute('aria-label', t('table.filterList'));
    body.append(input);
    read = () => {
      const vals = input.value.split(',').map(v => v.trim()).filter(Boolean);
      const typed = f.type === 'number' ? vals.map(Number) : vals;
      return typed.length ? [{ field: name, op, value: typed }] : [];
    };
  } else if (kind === 'range') {
    const bound = (key: string, ops: string[]) => {
      const c = cur.find(x => ops.includes(x.op as string));
      const input = Object.assign(document.createElement('input'), {
        type: f.type === 'number' ? 'number' : 'text', className: 'td-fp-num', value: c ? String(c.value) : '',
      });
      input.setAttribute('step', 'any');
      const label = el('label', 'td-fp-bound');
      label.append(el('span', '', t(key)), input);
      body.append(label);
      return input;
    };
    const lo = bound('table.filterMin', ['>=', '>', '=']);
    const hi = bound('table.filterMax', ['<=', '<', '=']);
    read = () => {
      const val = (s: string) => f.type === 'number' ? Number(s) : s;
      const out: Condition[] = [];
      if (lo.value.trim()) out.push({ field: name, op: '>=', value: val(lo.value.trim()) });
      if (hi.value.trim()) out.push({ field: name, op: '<=', value: val(hi.value.trim()) });
      return out;
    };
  } else {
    const sel = document.createElement('select');
    sel.className = 'td-fp-bool';
    sel.setAttribute('aria-label', name);
    const now = cur.find(c => c.op === '=')?.value;
    sel.append(new Option(t('table.filterAny'), ''), new Option('true', 'true'), new Option('false', 'false'));
    sel.value = now === undefined ? '' : String(now);
    body.append(sel);
    read = () => sel.value ? [{ field: name, op: '=', value: sel.value === 'true' }] : [];
  }
  const note = el('p', 'td-fp-note', t('table.filterNote'));
  if (tb.partial) note.append(' ', el('strong', '', t('table.filterTiles')));
  const actions = el('div', 'td-fp-actions');
  const cancel = el('button', 'td-btn td-fp-cancel', t('table.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', () => closeFilter(true));
  const clear = el('button', 'td-btn td-fp-clear', t('table.filterClear'));
  clear.type = 'button';
  clear.hidden = !cur.length;
  clear.addEventListener('click', () => applyFilter(name, [], err));
  const apply = el('button', 'td-btn td-fp-apply', t('table.filterApply'));
  apply.type = 'button';
  apply.addEventListener('click', () => applyFilter(name, read(), err));
  actions.append(cancel, clear, apply);
  pop.replaceChildren(title, body, err, note, actions);
  pop.hidden = false;
  placeFilter(btn);
  (pop.querySelector<HTMLElement>('input, select') ?? apply).focus();
}

/** Replace the field's conditions in the layer's `where` with `conds`. */
function applyFilter(name: string, conds: Condition[], err: HTMLElement) {
  const tb = tbl;
  if (!tb) return;
  const next = [...tableWhere(tb).filter(c => c.field !== name), ...conds];
  let r: ReturnType<typeof setWhere>;
  applyingFilter = true;
  try { r = setWhere(tb.req.layerId, next); } finally { applyingFilter = false; }
  if (!r.ok) { err.textContent = t('table.filterRefused', { reason: r.reason }); return; }
  closeFilter(true);
  // The table now shows the view's conditions: a selection's table keeps its
  // ids, any other follows the view from here on.
  if (!followsView(tb.req)) tb.req = tb.req.ids ? { layerId: tb.req.layerId, ids: tb.req.ids, where: next } : { layerId: tb.req.layerId };
  tb.whereKey = whereKeyOf(tb.req.layerId);
  void load(++seq, true);
}

function placeFilter(btn: HTMLElement) {
  const p = $('.td-filterpop');
  p.style.cssText = '';
  if (compact()) return;
  const d = drawer!.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const w = 260;
  p.style.top = `${Math.max(0, b.bottom - d.top + 2)}px`;
  p.style.left = `${Math.max(4, Math.min(b.right - d.left - w, d.width - w - 4))}px`;
  p.style.maxHeight = `${Math.max(160, d.bottom - b.bottom - 8)}px`;
}

function wireFilterPop() {
  const p = $('.td-filterpop');
  p.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeFilter(true); }
    else if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input[type=text], input[type=number], input[type=search]')) {
      ev.preventDefault();
      p.querySelector<HTMLButtonElement>('.td-fp-apply')?.click();
    }
  });
  document.addEventListener('pointerdown', (ev) => {
    const at = ev.target as Node;
    if (!p.hidden && !p.contains(at) && !filterBtnEl?.contains(at)) closeFilter();
  }, true);
  window.addEventListener('resize', () => { if (!p.hidden && filterBtnEl) placeFilter(filterBtnEl); });
}

// ─── Columns panel ───────────────────────────────────────────────────────────
// A disclosure (button aria-expanded → a group of fieldsets, one per rank of
// orderFields(), native checkboxes): Tab walks it, Space toggles, Esc closes it
// and returns focus to the button without closing the drawer; focus leaving
// it or a press outside closes it. Above the drawer on a desktop, over the
// drawer's body on a compact screen (CSS). A toggle redraws the header and
// rows only, unless it hides the sort column: then the rows re-sort by the
// sum field when that is shown, else load unsorted.
const COMPACT = '(max-width: 640px), (max-height: 500px)';
const compact = () => typeof matchMedia === 'function' && matchMedia(COMPACT).matches;

function syncColsButton() {
  const tb = tbl;
  const n = tb ? `${tb.shown.size}/${tb.fields.length}` : '';
  const b = $('.td-cols');
  $('.td-cols-n').textContent = n;
  b.setAttribute('aria-label', `${t('table.columns')} ${n}`.trim());
}

function renderColPanel() {
  const tb = tbl;
  if (!tb) return;
  const groups = RANK_KEYS.map((key, rank) => {
    const fs = tb.fields.filter(f => rankOf(f, tb.idField) === rank);
    if (!fs.length) return null;
    const set = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = t(key);
    set.append(legend, ...fs.map(f => {
      const label = document.createElement('label');
      label.className = 'td-col';
      if (f.description) label.title = f.description;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.col = f.name;
      const name = document.createElement('span');
      name.textContent = f.name;
      label.append(input, name);
      return label;
    }));
    return set;
  }).filter((x): x is HTMLFieldSetElement => !!x);
  $('.td-colpanel-groups').replaceChildren(...groups);
  syncColPanel();
}

function syncColPanel() {
  const tb = tbl;
  if (!tb) return;
  for (const input of drawer!.querySelectorAll<HTMLInputElement>('.td-colpanel [data-col]')) {
    input.checked = tb.shown.has(input.dataset.col!);
    // The last shown column stays.
    input.disabled = input.checked && tb.shown.size === 1;
  }
}

function setShown(next: Set<string>) {
  const tb = tbl;
  if (!tb || !next.size) return;
  tb.shown = next;
  shownCols.set(tb.req.layerId, next);
  syncColsButton();
  syncColPanel();
  touched();
  if (tb.sort && !next.has(tb.sort.field)) {
    tb.sort = tb.sumField && next.has(tb.sumField) ? { field: tb.sumField, desc: true } : null;
    tb.active = -1;
    void load(++seq, false);
  } else if (grid) {
    setGridColumns(tb);
  }
}

function placeColPanel() {
  const p = $('.td-colpanel');
  p.style.cssText = '';
  if (compact()) return;
  const d = drawer!.getBoundingClientRect();
  const b = $('.td-cols').getBoundingClientRect();
  const c = mapContainer()!.getBoundingClientRect();
  p.style.bottom = `${d.bottom - b.top + 4}px`;
  p.style.maxHeight = `${Math.max(160, b.top - c.top - 12)}px`;
  if (getComputedStyle(drawer!).direction === 'rtl') p.style.left = `${b.left - d.left}px`;
  else p.style.right = `${d.right - b.right}px`;
}

function showColPanel(open: boolean, refocus = false) {
  const p = $('.td-colpanel');
  const b = $('.td-cols');
  if (open === !p.hidden) return;
  p.hidden = !open;
  b.setAttribute('aria-expanded', String(open));
  if (open) {
    renderColPanel();
    placeColPanel();
    p.querySelector<HTMLInputElement>('[data-col]:not(:disabled)')?.focus();
  } else if (refocus) b.focus();
}

function wireColPanel() {
  const p = $('.td-colpanel');
  const b = $('.td-cols');
  b.addEventListener('click', () => showColPanel(!!p.hidden));
  p.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    if (!tbl || !input.dataset.col) return;
    const next = new Set(tbl.shown);
    if (input.checked) next.add(input.dataset.col); else next.delete(input.dataset.col);
    setShown(next);
  });
  $('.td-cols-default').addEventListener('click', () => {
    if (tbl) setShown(new Set(defaultColumns(tbl.req.layerId, tbl.fields, tbl.idField)));
  });
  $('.td-cols-all').addEventListener('click', () => { if (tbl) setShown(new Set(tbl.fields.map(f => f.name))); });
  p.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); showColPanel(false, true); }
  });
  p.addEventListener('focusout', (ev) => {
    const to = ev.relatedTarget as Node | null;
    if (to && !p.contains(to) && to !== b) showColPanel(false);
  });
  document.addEventListener('pointerdown', (ev) => {
    const at = ev.target as Node;
    if (!p.hidden && !p.contains(at) && !b.contains(at)) showColPanel(false);
  }, true);
  window.addEventListener('resize', () => { if (!p.hidden) placeColPanel(); });
}

// ─── Camera ──────────────────────────────────────────────────────────────────
type BBox = [number, number, number, number];
const union = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

function bbox(g: GeoJSON.Geometry | null | undefined): BBox | null {
  if (!g) return null;
  if (g.type === 'GeometryCollection') {
    const bs = g.geometries.map(bbox).filter((b): b is BBox => !!b);
    return bs.length ? bs.reduce(union) : null;
  }
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    } else (c as unknown[]).forEach(walk);
  };
  walk(g.coordinates);
  return Number.isFinite(b[0]) ? b : null;
}

/** Map padding (px) that keeps a fit above the drawer and clear of the
 *  layer panel. */
export function drawerPadding(): { top: number; left: number; right: number; bottom: number } {
  const c = state.map?.getContainer() ?? mapContainer();
  if (!c) return { top: 60, left: 40, right: 40, bottom: 40 };
  const panel = document.getElementById('layersPanel');
  const desktop = c.clientWidth > 640;
  const drawerH = drawer && !drawer.hidden ? drawer.offsetHeight : 0;
  const right = desktop && panel && !panel.hidden ? panel.offsetWidth + 36 : 40;
  const bottom = Math.min(drawerH + 40, Math.max(40, c.clientHeight - 140));
  return { top: 60, left: 40, right: Math.min(right, c.clientWidth - 140), bottom };
}

// Fit the camera to `b` above the drawer and clear of the layer panel. A
// point (or a lone small feature) is flown to at ≥ z9; nothing zooms past 13.
function fitTo(b: BBox, point: boolean) {
  const map = state.map;
  if (!map) return;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
    padding: drawerPadding(), maxZoom: point ? Math.max(map.getZoom(), 9) : 13, duration: 600,
  });
}

/** The loaded tile pieces of feature `id` (all tiles it is cut across). */
function tilePieces(layerId: string, id: FeatureId | null): GeoJSON.Feature[] {
  const map = state.map;
  const entry = layerById(layerId);
  if (!map || !entry || id === null) return [];
  const sources = new Map<string, string | undefined>();
  for (const m of entry.mapLayerIds) {
    const l = map.getLayer(m) as { source?: string; sourceLayer?: string } | undefined;
    if (l?.source) sources.set(l.source, l.sourceLayer);
  }
  const out: GeoJSON.Feature[] = [];
  for (const [source, sourceLayer] of sources) {
    try {
      for (const f of map.querySourceFeatures(source, sourceLayer ? { sourceLayer } : {})) {
        if (featureId(layerId, f) === id) out.push({ type: 'Feature', geometry: f.geometry, properties: { ...f.properties } });
      }
    } catch { /* source still loading */ }
  }
  return out;
}

/** Highlight row `i`'s feature, and with `fly` fit the camera to it. A columns-file row carries only a point
 *  on its feature: its loaded tile feature is used when there is one; else the highlight is cleared (the
 *  point is never drawn as the feature), the camera goes to the point and the highlight is retried once at
 *  the map's next `idle`. */
function showRow(i: number, fly: boolean, retry = true) {
  const tb = tbl;
  const row = tb?.rows[i];
  if (!tb || !row) return;
  const pieces = row.pointOnly ? tilePieces(tb.req.layerId, row.id) : [row.feature];
  if (pieces.length) setHighlightFeatures(pieces, 'table'); else clearHighlights('table');
  if (fly) {
    const boxes = (pieces.length ? pieces : [row.feature]).map(f => bbox(f.geometry)).filter((b): b is BBox => !!b);
    const g = (pieces[0] ?? row.feature).geometry?.type;
    if (boxes.length) fitTo(boxes.reduce(union), !pieces.length || g === 'Point' || g === 'MultiPoint');
  }
  if (fly && retry && row.pointOnly && !pieces.length) {
    state.map?.once('idle', () => { if (tbl === tb && tb.rows[tb.active] === row) showRow(tb.active, false, false); });
  }
}

// ─── Interaction ─────────────────────────────────────────────────────────────
/** Make row `i` the active one (outlined, its feature highlighted); `fly`
 *  also fits the camera to it. */
function activate(i: number, fly: boolean) {
  const tb = tbl;
  if (!tb || !tb.rows[i] || !grid) return;
  const was = tb.active;
  tb.active = i;
  // The rows on screen now; one drawn later reads tb.active in paintRow.
  for (const k of [was, i]) { const row = k >= 0 && grid.getRow(k); if (row) row.getElement().classList.toggle('td-row--active', k === i); }
  showRow(i, fly);
  touched();
}

function sortBy(field: string) {
  const tb = tbl;
  if (!tb) return;
  const num = tb.fields.find(f => f.name === field)?.type === 'number';
  tb.sort = tb.sort?.field === field ? { field, desc: !tb.sort.desc } : { field, desc: num };
  tb.active = -1;
  void load(++seq, false);
}

/** Check rows `is` (uncheck them when every one is checked already). */
function toggleCheck(is: number[]) {
  const tb = tbl!;
  const ids = is.map(i => tb.rows[i]?.id).filter((x): x is FeatureId => x !== null && x !== undefined);
  if (!ids.length) return;
  const on = ids.some(id => !tb.checked.has(id));
  for (const id of ids) if (on) tb.checked.add(id); else tb.checked.delete(id);
  repaintChecks();
}

/** The check boxes and row marks on screen, from tb.checked (rows drawn later
 *  read it in their formatters). */
function repaintChecks() {
  const tb = tbl;
  if (!tb || !drawer) return;
  for (const box of drawer.querySelectorAll<HTMLInputElement>('.td-grid .tabulator-row input[data-i]')) {
    const id = tb.rows[Number(box.dataset.i)]?.id;
    const on = id !== null && id !== undefined && tb.checked.has(id);
    box.checked = on;
    box.closest('.tabulator-row')?.setAttribute('aria-selected', String(on));
  }
  syncChecks();
  touched();
}

function selectRows() {
  const tb = tbl!;
  const ids = tb.checked.size ? [...tb.checked] : tb.rows.map(r => r.id).filter((x): x is FeatureId => x !== null);
  if (!ids.length) return;
  if (ids.length > MAX_SELECTION_IDS) { setStatus('table.selectCap', { n: MAX_SELECTION_IDS }, 'warn'); return; }
  const err = commitSelection({
    mode: state.sel?.mode ?? 'isolate',
    ids: { ...(state.sel?.ids ?? {}), [tb.req.layerId]: ids },
  });
  setStatus(err ? 'table.error' : '', err ? { reason: err } : undefined, err ? 'error' : 'info');
}

function exportCsv() {
  const tb = tbl!;
  const entry = layerById(tb.req.layerId)!;
  const fields = tb.fields.map(f => f.name);
  // One note row says what the rows are: the pills, the bar narrowing them,
  // and the row cap when the table holds the first QUERY_MAX_ROWS only.
  const bar = tb.bars.find(b => b.id === tb.barFilter);
  const notes = [...pillsFor(tb.req.layerId, tb.opts, tb.areaDropped, false),
    ...(bar ? [`${tb.groupBy}: ${bar.label}`] : []),
    ...(tb.truncated ? [t('table.rowsOf', { n: fmt(tb.rows.length, 0), total: fmt(tb.total, 0) })] : [])];
  // The BOM tells Excel the file is UTF-8 (names with accents, the © credit).
  downloadFile('\uFEFF' + toCsv(tb.rows.map(r => r.props), fields, entry.data!.credit,
    notes.length ? [t('table.csvFilters', { list: notes.join(' · ') })] : []), `${tb.req.layerId}.csv`, 'text/csv');
}

function mapContainer() { return document.querySelector<HTMLElement>('.map-container'); }

// The drawer's height is a share of the map container, so a rotation keeps
// the sheet's proportion: until the grip moves it, the layout's default —
// half the map on a narrow screen but at least 400 px, up to 60 % (five rows
// on a 360×740 phone), 80 % on a short one (three rows on a landscape phone),
// else 40 % up to 320 px.
function defaultFrac(ch: number): number {
  return !compact() ? Math.min(320, ch * 0.4) / ch
    : matchMedia('(max-height: 500px)').matches ? 0.8 : 0.6;
}

function applyHeight() {
  const c = mapContainer();
  if (!c || !drawer) return;
  const ch = c.clientHeight;
  const max = Math.max(160, ch - (compact() ? 48 : 100));
  // The Route, Visualize and Line panes' default is taller (Route's input column, a template's 420 px frame, the locator's form); a grip drag still wins.
  const base = frac ? frac * ch : Math.max(defaultFrac(ch) * ch, (P.route.open || P.viz.open || P.line.open || P.prox.open || P.gops.open) && !compact() ? Math.max(ROUTE_MIN_PX, ch * 0.45) : 0);
  height = Math.max(140, Math.min(Math.max(base, routeTall ? ROUTE_TALL_PX : 0), max));
  drawer.style.height = collapsed ? '' : `${height}px`;
  drawer.classList.toggle('td--min', collapsed);
  c.style.setProperty('--drawer-h', `${collapsed ? drawer.offsetHeight : height}px`);
  const grip = $('.td-grip');
  grip.setAttribute('aria-valuenow', String(Math.round(height)));
  grip.setAttribute('aria-valuemax', String(Math.round(max)));
  const btn = $('.td-collapse');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.dataset.i18nAriaLabel = collapsed ? 'table.expand' : 'table.collapse';
  btn.setAttribute('aria-label', t(btn.dataset.i18nAriaLabel));
  btn.textContent = collapsed ? '▴' : '▾';
  touched();
}

function setHeight(px: number) {
  const ch = mapContainer()?.clientHeight;
  if (ch) frac = px / ch;
  applyHeight();
}

function open(quiet = false) {
  const c = mapContainer()!;
  // A table the chat asked for leaves the conversation in view; Route, if
  // open, stays in its tab.
  const chatting = P.ask.open && $('#td-ask').contains(document.activeElement);
  if (!chatting) pane = 'table';
  foldLayersOnPhone();
  drawer!.hidden = false;
  drawer!.classList.add('td--open');
  c.classList.add('has-drawer');
  collapsed = false;
  applyHeight();
  syncPanes();
  setStatus('');
  gridScroll = 0;
  wantScroll = null;
  // Nothing of a previous table shows while this one loads.
  closeFilter();
  colsKey = '';
  void gridReady.then(() => { if (!colsKey) { grid?.setColumns([]); void grid?.clearData(); } });
  for (const sel of ['.td-bars', '.td-pills']) $(sel).replaceChildren();
  for (const sel of ['.td-count', '.td-total', '.td-total-sub', '.td-more', '.td-note', '.td-range',
    '.td-fold-total', '.td-fold-rows', '.td-fold-filter', '.td-fold-sort', '.td-fold-by']) $(sel).textContent = '';
  $('.td-fold-bar').replaceChildren();
  $('.td-unfilter').hidden = true;
  const select = $<HTMLButtonElement>('.td-select');
  setSelectLabel(t('table.select', { n: 0 }));
  select.disabled = true;
  $('.td-copy').hidden = true;
  if (!chatting && !quiet) gridFocus().focus({ preventScroll: true });
}

function ensureDrawer() {
  if (drawer) return;
  const c = mapContainer()!;
  drawer = document.createElement('section');
  drawer.className = 'table-drawer';
  drawer.hidden = true;
  drawer.setAttribute('role', 'region');
  drawer.setAttribute('aria-label', t('table.tab'));
  drawer.dataset.i18nAriaLabel = 'table.tab';
  const e = (k: string) => escapeHtml(t(k));
  // Static strings carry their key (data-i18n*), so ui.ts's lang:changed
  // handler (updateDomTranslations) re-translates them in place; a key sits on
  // an inner <span>, never on a node that also holds an icon or a count.
  drawer.innerHTML = `
    <div class="td-grip" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="${e('table.resize')}" data-i18n-aria-label="table.resize" aria-valuemin="140"></div>
    <div class="td-head">
      <div class="td-tabs" role="tablist" aria-label="${e('table.tab')}" data-i18n-aria-label="table.tab">
        <button type="button" class="td-tab td-tab-ask" id="td-tab-ask" role="tab" aria-selected="false" aria-controls="td-ask" tabindex="-1" hidden><span class="td-tab-ask-icon" aria-hidden="true">✦</span><span data-i18n="chat.tab">${e('chat.tab')}</span></button>
        <button type="button" class="td-tab" id="td-tab" role="tab" aria-selected="true" aria-controls="td-panel">${TABLE_ICON}<span class="td-tab-name"></span></button>
        <button type="button" class="td-tab td-tab-viz" id="td-tab-viz" role="tab" aria-selected="false" aria-controls="td-viz" tabindex="-1" hidden><span class="td-tab-viz-icon" aria-hidden="true">${VIZ_ICON}</span><span data-i18n="viz.tab">${e('viz.tab')}</span></button>
        <button type="button" class="td-tab td-tab-line" id="td-tab-line" role="tab" aria-selected="false" aria-controls="td-line" tabindex="-1" hidden><span class="td-tab-line-icon" aria-hidden="true">⌁</span><span data-i18n="line.tab">${e('line.tab')}</span></button>
        <button type="button" class="td-tab td-tab-prox" id="td-tab-prox" role="tab" aria-selected="false" aria-controls="td-prox" tabindex="-1" hidden><span class="td-tab-prox-icon" aria-hidden="true">◎</span><span data-i18n="px.tab">${e('px.tab')}</span></button>
        <button type="button" class="td-tab td-tab-gops" id="td-tab-gops" role="tab" aria-selected="false" aria-controls="td-gops" tabindex="-1" hidden><span class="td-tab-gops-icon" aria-hidden="true">⇄</span><span data-i18n="gridOps.tab">${e('gridOps.tab')}</span></button>
        <button type="button" class="td-tab td-tab-route" id="td-tab-route" role="tab" aria-selected="false" aria-controls="td-route" tabindex="-1" hidden><span class="td-tab-route-icon" aria-hidden="true">⤳</span><span data-i18n="route.tab">${e('route.tab')}</span></button>
      </div>
      <div class="td-pills"></div>
      <span class="td-count"></span>
      <div class="td-actions">
        <div class="td-route-actions" hidden></div>
        <button type="button" class="td-btn td-unfilter" hidden title="${e('table.showAllTitle')}" data-i18n-title="table.showAllTitle"><span data-i18n="table.showAll">${e('table.showAll')}</span></button>
        <button type="button" class="td-btn td-select"></button>
        <button type="button" class="td-btn td-copy" hidden></button>
        <button type="button" class="td-btn td-csv" title="${e('table.csvTitle')}" data-i18n-title="table.csvTitle">↓ CSV</button>
        <button type="button" class="td-btn td-cols" aria-expanded="false" aria-controls="td-colpanel" title="${e('table.colsTitle')}" data-i18n-title="table.colsTitle">☰<span class="td-cols-label"> <span data-i18n="table.columns">${e('table.columns')}</span> <span class="td-cols-n"></span></span></button>
        <button type="button" class="td-icon td-refresh" title="${e('table.refresh')}" aria-label="${e('table.refresh')}" data-i18n-title="table.refresh" data-i18n-aria-label="table.refresh">↻</button>
        <button type="button" class="td-icon td-collapse" aria-expanded="true">▾</button>
      </div>
    </div>
    <div class="td-colpanel" id="td-colpanel" role="group" aria-labelledby="td-colpanel-title" hidden>
      <div class="td-colpanel-head">
        <span class="td-colpanel-title" id="td-colpanel-title" data-i18n="table.columns">${e('table.columns')}</span>
        <button type="button" class="td-link td-cols-default" data-i18n="table.colsDefault">${e('table.colsDefault')}</button>
        <button type="button" class="td-link td-cols-all" data-i18n="table.colsAll">${e('table.colsAll')}</button>
        <button type="button" class="td-link td-cols-done" data-i18n="table.colsDone">${e('table.colsDone')}</button>
      </div>
      <div class="td-colpanel-groups"></div>
    </div>
    <div class="td-filterpop" role="dialog" hidden></div>
    <div class="td-status" role="status" hidden></div>
    <div class="td-ask" id="td-ask" role="tabpanel" aria-labelledby="td-tab-ask" hidden></div>
    <div class="td-viz" id="td-viz" role="tabpanel" aria-labelledby="td-tab-viz" hidden></div>
    <div class="td-line" id="td-line" role="tabpanel" aria-labelledby="td-tab-line" hidden></div>
    <div class="td-prox" id="td-prox" role="tabpanel" aria-labelledby="td-tab-prox" hidden></div>
    <div class="td-gops" id="td-gops" role="tabpanel" aria-labelledby="td-tab-gops" hidden></div>
    <div class="td-route" id="td-route" role="tabpanel" aria-labelledby="td-tab-route" hidden></div>
    <div class="td-body" id="td-panel" role="tabpanel" aria-labelledby="td-tab">
      <aside class="td-summary">
        <button type="button" class="td-fold" aria-expanded="false" aria-controls="td-summary-full"><span class="td-fold-total"></span><span class="td-fold-rows"></span><span class="td-fold-bar"></span><span class="td-fold-filter"></span><span class="td-fold-sort"></span><span class="td-fold-by"></span></button>
        <div class="td-summary-full" id="td-summary-full">
        <div class="td-group-ctl">
          <label><span data-i18n="table.groupBy">${e('table.groupBy')}</span> <select class="td-groupby"></select></label>
          <label><span data-i18n="table.sumOf">${e('table.sumOf')}</span> <select class="td-sum"></select></label>
        </div>
        <div class="td-total-line"><span class="td-total"></span> <span class="td-total-sub"></span></div>
        <div class="td-bars"></div>
        <div class="td-more"></div>
        <div class="td-note"></div>
        </div>
      </aside>
      <div class="td-grid" aria-label="${e('table.tab')}" data-i18n-aria-label="table.tab"></div>
    </div>
    <div class="td-foot">
      <span class="td-range"></span>
      <span class="td-hint" data-i18n="table.hint">${e('table.hint')}</span>
      <span class="td-credit"></span>
    </div>`;
  c.append(drawer);
  claimSnapshot(DRAWER_SNAPSHOT);
  onHidden(saveDrawer);

  grid = makeGrid($('.td-grid'));
  // The range follows the keys (Tabulator); a one-row range makes that row
  // active. Enter flies to it, Space checks the range's rows.
  let keyFrame = 0;
  // Capture: these keys are taken before Tabulator's own listeners.
  $('.td-grid').addEventListener('keydown', (ev) => {
    // A row's own control (check box, zoom button) keeps its Enter; SelectRange never sees it.
    if (ev.key === 'Enter' && (ev.target as HTMLElement).closest('.tabulator-tableholder')) ev.stopPropagation();
    if (!tbl || (ev.target as HTMLElement).closest('input, select, button')) return;
    if (isCopyKey(ev)) {
      if (copyRange()) { ev.preventDefault(); ev.stopPropagation(); }
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.stopPropagation();
      const at = rangeRows();
      if (!at.length) return;
      ev.preventDefault();
      if (ev.key === 'Enter') activate(at[0], true); else toggleCheck(at);
    }
  }, true);
  $('.td-grid').addEventListener('keydown', (ev) => {
    if (!tbl || (ev.target as HTMLElement).closest('input, select, button')) return;
    if (!/^(Arrow(Up|Down)|Page(Up|Down)|Home|End)$/.test(ev.key)) return;
    cancelAnimationFrame(keyFrame);
    keyFrame = requestAnimationFrame(() => {
      const at = rangeRows();
      if (at.length === 1 && at[0] !== tbl?.active) activate(at[0], false);
    });
  });
  wireFilterPop();
  $('.td-bars').addEventListener('keydown', (ev) => { roveKey(ev, $('.td-bars'), '.td-bar', 'ArrowUp', 'ArrowDown'); });
  $('.td-bars').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-bar]');
    if (!b || !tbl) return;
    tbl.barFilter = tbl.barFilter === b.dataset.bar ? null : b.dataset.bar!;
    tbl.checked.clear();
    void load(++seq, false);
  });
  $('.td-fold').addEventListener('click', () => {
    const fold = $('.td-fold');
    const open = fold.getAttribute('aria-expanded') !== 'true';
    fold.setAttribute('aria-expanded', String(open));
    $('.td-summary').classList.toggle('td-summary--open', open);
    if (tbl) renderSummary();
    showGrid();
  });
  $('.td-cols-done').addEventListener('click', () => showColPanel(false, true));
  $('.td-unfilter').addEventListener('click', showAllRows);
  const regroup = () => {
    if (!tbl) return;
    tbl.groupBy = $<HTMLSelectElement>('.td-groupby').value;
    tbl.sumField = $<HTMLSelectElement>('.td-sum').value;
    tbl.barFilter = null;
    void load(++seq, true);
  };
  $('.td-groupby').addEventListener('change', regroup);
  $('.td-sum').addEventListener('change', regroup);
  $('.td-select').addEventListener('click', selectRows);
  $('.td-copy').addEventListener('click', onCopyClick);
  wireColPanel();
  $('.td-csv').addEventListener('click', exportCsv);
  $('.td-refresh').addEventListener('click', () => { if (tbl) void load(++seq, true); });
  // Each tab's own × closes that pane; the drawer hides with the last one.
  for (const [id, p] of Object.entries(PANE_OF)) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'td-tab-x';
    x.dataset.pane = p;
    x.tabIndex = -1;
    x.hidden = true;
    x.textContent = '×';
    x.addEventListener('click', () => { if (paneOpen(p)) closePane(p); });
    $(`#${id}`).after(x);
  }
  $('.td-collapse').addEventListener('click', () => { act(); collapsed = !collapsed; applyHeight(); });
  drawer.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    ev.preventDefault();
    // The active pane only: Route when it is in view, else the pane focus is in.
    if (pane !== 'table' && pane !== 'ask' && P[pane].open) closeSide(pane);
    else if (P.ask.open && ($('#td-ask').contains(ev.target as Node) || !tbl)) closeAsk();
    else if (tbl || !P.route.open) closeTable();
    else closeRoute();
  });
  // The tabs: a click or ←→ Home End (over the open ones) picks the pane in view.
  for (const [id, p] of Object.entries(PANE_OF)) $(`#${id}`).addEventListener('click', () => { act(); selectPane(p); });
  $('.td-tabs').addEventListener('keydown', (ev) => {
    const tabs = [...drawer!.querySelectorAll<HTMLElement>('.td-tab')].filter(b => !b.hidden);
    const i = tabs.indexOf(ev.target as HTMLElement);
    const n = tabs.length;
    const back = getComputedStyle(drawer!).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const fwd = back === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    const to = ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1
      : ev.key === fwd ? (i + 1) % n : ev.key === back ? (i - 1 + n) % n : -1;
    if (i < 0 || to < 0) return;
    ev.preventDefault();
    act();
    selectPane(PANE_OF[tabs[to].id], true);
  });

  // Resize by the grip: drag, or ↑↓ with the grip focused.
  const grip = $('.td-grip');
  grip.addEventListener('pointerdown', (ev) => {
    grip.setPointerCapture(ev.pointerId);
    const startY = ev.clientY, startH = height;
    act();
    collapsed = false;
    const move = (m: PointerEvent) => { setHeight(startH + (startY - m.clientY)); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    act();
    collapsed = false;
    setHeight(height + (ev.key === 'ArrowUp' ? 24 : -24));
  });
  window.addEventListener('resize', () => { if (drawer && !drawer.hidden) applyHeight(); });
  // The layer panel opening or closing narrows the drawer without a resize.
  new ResizeObserver(() => { if (drawer && !drawer.hidden) syncPanes(); }).observe(drawer);
  // Runs after ui.ts's handler has re-translated the data-i18n* nodes; what
  // is left is built from data: pills, counts, the Select label, the header.
  // A `where` set elsewhere (the row chip's ×, Undo, a story, the chat)
  // reloads a table that follows the view.
  on('url:write', onViewWhere);
  on('view:applied', onViewWhere);
  on('lang:changed', () => {
    if (drawer) syncPanes();
    if (!drawer || !tbl) return;
    closeFilter();
    drawer.querySelector('.td-check-all')?.setAttribute('aria-label', t('table.checkAll'));
    $<HTMLSelectElement>('.td-sum').options[0].text = t('table.count');
    syncColsButton();
    if (!$('.td-colpanel').hidden) renderColPanel();
    if (status) setStatus(status.key, status.params, status.kind);
    render();
    queueRange();
  });
}

// ─── Save and restore (this tab's sessionStorage) ────────────────────────────
// tm-drawer (drawer-snapshot.ts): the layout — Ask and the table open or not,
// the pane in view, height and collapse — and the table's state. Saved on
// hidden / pagehide and again on every change while hidden (a table the chat
// opens in the background); removed when no pane is open. The Route tab is
// never kept. A restore writes no link and adds no undo step: the selection
// stays the link's (`sel`), and checked rows come back as table checks only.
let restoring = false;             // a restore's own synchronous steps: nothing is saved meanwhile
let visitorActs = 0;               // the visitor's opens, closes, tab picks and resizes, counted
let resumingAsk = false;           // the restore is opening the chat: that open is not the visitor's
let resumingViz = false;           // the restore is opening the Visualize pane: likewise
let vizState: (() => VizSnapshot | null) | null = null;   // ui-templates.ts's part of the snapshot
let pending: DrawerSnapshot | null = null;   // a restore still waiting for the chat or the map: what a save keeps meanwhile
let gridScroll = 0;                // the grid's scroll offset, kept while the grid is out of view
let wantScroll: number | null = null;   // a restored offset for a grid not yet in view

/** The visitor changed the drawer: a restore still waiting gives way, and its saved table is no longer kept. */
function act() { visitorActs++; pending = null; }

function tableSnapshot(tb: Table): TableSnapshot {
  // A restore still loading keeps what it was asked to bring back.
  if (tb.init) return tb.init;
  const req = { ...tb.req };
  delete req.focusId;
  const checked = [...tb.checked];
  return {
    req, sort: tb.sort, groupBy: tb.groupBy, sumField: tb.sumField, barFilter: tb.barFilter,
    shown: [...tb.shown],
    checked: checked.length <= MAX_SELECTION_IDS ? checked : [],
    active: tb.rows[tb.active]?.id ?? null,
    scrollTop: Math.round(wantScroll ?? gridScroll),
  };
}

/** ui-templates.ts's getter for the Visualize pane's part of tm-drawer (its layer and cards). */
export function registerVizSnapshot(get: () => VizSnapshot | null): void { vizState = get; }

function drawerSnapshot(): DrawerSnapshot | null {
  const table = tbl ? (tbl.req.ids && tbl.req.ids.length > MAX_SELECTION_IDS ? null : tableSnapshot(tbl)) : pending?.table ?? null;
  const viz = P.viz.open ? vizState?.() ?? null : pending?.viz ?? null;
  if (!table && !P.ask.open && !viz) return null;
  const has = { ask: P.ask.open, table: !!table, viz: !!viz };
  const p = pane !== 'route' && pane !== 'line' && pane !== 'prox' && pane !== 'gops' && has[pane] ? pane : (['table', 'ask', 'viz'] as const).find(k => has[k])!;
  return {
    v: DRAWER_SNAPSHOT_VERSION, ask: P.ask.open, table, ...(viz && { viz }),
    pane: p, frac, collapsed,
  };
}

function saveDrawer() {
  if (!drawer || restoring) return;
  const s = drawerSnapshot();
  if (!s) { clearSnapshot(DRAWER_SNAPSHOT); return; }
  if (!saveSnapshot(DRAWER_SNAPSHOT, s, { maxChars: 200_000 })) clearSnapshot(DRAWER_SNAPSHOT);
}

/** A change while the page is hidden is saved at once (ui-templates.ts calls it for its cards). */
export function drawerChanged(): void { touched(); }

function touched() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') saveDrawer();
}

/** Resolves once the map has drawn its tiles (vector-tile rows are the loaded tiles only). */
export function mapIdle(): Promise<void> {
  const map = state.map;
  if (!map || map.loaded()) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 20_000);
    map.once('idle', () => { clearTimeout(timer); resolve(); });
  });
}

/** After a reload of this tab (the boot hook in ui-menubar.ts, through
 *  table-open.ts): the drawer as tm-drawer left it. `resumeAsk` brings the chat
 *  back first when Ask was open, `resumeViz` the Visualize pane; then the table — a vector-tile layer once the
 *  map is idle, a large file through the size prompt as usual — then the pane in
 *  view, the height and the collapse. No focus moves. */
export async function restoreDrawer(resumeAsk: () => Promise<void>, resumeViz?: (viz: VizSnapshot) => Promise<void>): Promise<void> {
  const snap = readSnapshot(DRAWER_SNAPSHOT, parseDrawerSnapshot);
  if (!snap) { clearSnapshot(DRAWER_SNAPSHOT); return; }
  const acts = visitorActs;
  const moved = () => visitorActs !== acts;
  let shown: Promise<void> | null = null;
  pending = snap;
  try {
    restoring = true;
    try { ensureDrawer(); frac = snap.frac; } finally { restoring = false; }
    if (snap.ask) {
      resumingAsk = true;
      try { await resumeAsk(); } catch { /* the chat opens from the menu as usual */ } finally { resumingAsk = false; }
    }
    if (snap.viz && resumeViz) {
      resumingViz = true;
      try { await resumeViz(snap.viz); } catch { /* Visualize opens from the menu as usual */ } finally { resumingViz = false; }
    }
    const tb = snap.table;
    const d = tb && describe(tb.req.layerId);
    const qd = d && d.ok && d.result.queryable ? d.result : null;
    const wanted = !!tb && !!qd;
    if (qd?.kind === 'pmtiles') await mapIdle();
    // The visitor opened or changed something while this waited: theirs stands.
    if (moved()) return;
    restoring = true;
    try {
      if (wanted) shown = openTable(tb!.req, tb!);
      if (paneOpen(snap.pane) && !sizeAnswer) pane = snap.pane;
      if (drawer!.classList.contains('td--open')) { collapsed = snap.collapsed; applyHeight(); syncPanes(); }
    } finally {
      restoring = false;
    }
  } finally {
    pending = null;
  }
  await shown;
}
