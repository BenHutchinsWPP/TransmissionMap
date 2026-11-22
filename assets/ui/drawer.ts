// ─── The bottom drawer's shell (lazy chunk) ──────────────────────────────────
// Panes (table, Ask, Visualize, Line, Proximity, Grid Ops, Route) share one
// drawer below the map, one in view at a time; each is filled by its own
// module. This module owns the drawer itself: its markup (built from PANES),
// tabs and their ×, which pane is in view, open/close and focus return, Esc,
// collapse, height (grip, defaults, floors) and the tab's `tm-drawer`
// snapshot (drawer-snapshot.ts) with its restore.
//   panel(id)            a pane's element (builds the drawer on first use)
//   headerSlot('route')  the route planner's slot in the header, shown only while Route is in view
//   openPane(id, onClose?, from?, { background? })  open a pane; `onClose` runs
//                        when it closes, focus then returns to `from` (default:
//                        the focused element). `background`: the pane in view
//                        stays in view. openPane('table') is the table's own
//                        open (ui-table.ts): it never counts as the visitor's act.
//   closePane(id)        the drawer stays while another pane is open, else hides
//   paneOpen(id)         whether a pane is open
//   selectPane('table')  bring the open table into view (the size prompt)
//   setPaneFloor('route', px)  a height floor (px, 0 = none) that wins over a grip drag
//   drawerPadding()      map padding that keeps a fit above the drawer and clear of the layer panel
//   drawerChanged()      a change while the page is hidden is saved at once
//   mapIdle()            resolves once the map has drawn (a vector-tile read waits for it)
//   noteVisitorAct()     the visitor changed the drawer: a waiting restore gives way,
//                        and a table kept from a failed restore is dropped
//   bindTable(h)         ui-table.ts, once at load: its hooks; `mount(root)` runs
//                        once the drawer exists (the table's controls live on the root)
//   registerSnapshotPart('table' | 'viz', get)  that part of tm-drawer
//   restoreDrawer(resume)  after a reload of this tab (drawer-open.ts): frac,
//                        Ask (resume.ask), Visualize (resume.viz), the table
//                        (resume.table.prepare, then .start), then the pane in
//                        view, collapse and height; a table whose chunk failed
//                        to load stays in tm-drawer, with its pane and collapse,
//                        until the visitor acts. No focus moves, no link write,
//                        no undo step, and no open counts as the visitor's. The Route, Line, Proximity and Grid Ops
//                        tabs are never kept.
// Height: a share of the map container (`frac`) once the grip moved it, else
// the layout's default, at least a pane's `defaultMinPx` (desktop) while that
// pane is open; a floor (setPaneFloor) wins over both.
// Fixed strings carry data-i18n* keys (ui.ts's lang:changed handler
// re-translates them); the tabs' close labels are redrawn here.
// Deps: state.ts (map), state-bus.ts (on), i18n (t), utils.ts (escapeHtml),
//       ui-layer-rows.ts (TABLE_ICON, VIZ_ICON), session-snapshot.ts (saveSnapshot,
//       readSnapshot, clearSnapshot, claimSnapshot, onHidden), drawer-snapshot.ts
//       (DRAWER_SNAPSHOT, DRAWER_SNAPSHOT_VERSION, parseDrawerSnapshot; types).
// Loaded by: the panes' lazy chunks (static import), drawer-open.ts (dynamic
// import); never by a boot module statically.

import { state } from '../state.js';
import { on } from '../state-bus.js';
import { t } from '../../src/i18n/index.js';
import { escapeHtml } from '../utils/utils.js';
import { TABLE_ICON, VIZ_ICON } from './ui-layer-rows.js';
import { saveSnapshot, readSnapshot, clearSnapshot, claimSnapshot, onHidden } from '../session-snapshot.js';
import {
  DRAWER_SNAPSHOT, DRAWER_SNAPSHOT_VERSION, parseDrawerSnapshot,
  type DrawerSnapshot, type TableSnapshot, type VizSnapshot,
} from './drawer-snapshot.js';

export type PaneId = 'table' | 'ask' | 'viz' | 'route' | 'line' | 'prox' | 'gops';
type Side = Exclude<PaneId, 'table'>;

interface PaneDef {
  id: PaneId;
  tab: string;            // the tab button's id
  panel: string;          // the tabpanel's id
  labelKey: string;       // the tab's label
  icon: string;           // the tab's icon markup
  visitor: boolean;       // an open or close is the visitor's act (the table's open is ui-table.ts's)
  height: boolean;        // an open recomputes the height (Ask keeps the layout's)
  defaultMinPx?: number;  // the default height (desktop) while open, until a grip drag
  kept?: boolean;         // kept in tm-drawer
}

/** The panes in tab order. */
const PANES: readonly PaneDef[] = [
  { id: 'ask', tab: 'td-tab-ask', panel: 'td-ask', labelKey: 'chat.tab', icon: '✦', visitor: true, height: false, kept: true },
  { id: 'table', tab: 'td-tab', panel: 'td-panel', labelKey: 'table.tab', icon: TABLE_ICON, visitor: true, height: true, kept: true },
  { id: 'viz', tab: 'td-tab-viz', panel: 'td-viz', labelKey: 'viz.tab', icon: VIZ_ICON, visitor: true, height: true, defaultMinPx: 410, kept: true },
  { id: 'line', tab: 'td-tab-line', panel: 'td-line', labelKey: 'line.tab', icon: '⌁', visitor: true, height: true, defaultMinPx: 410 },
  { id: 'prox', tab: 'td-tab-prox', panel: 'td-prox', labelKey: 'px.tab', icon: '◎', visitor: true, height: true, defaultMinPx: 410 },
  { id: 'gops', tab: 'td-tab-gops', panel: 'td-gops', labelKey: 'gridOps.tab', icon: '⇄', visitor: true, height: true, defaultMinPx: 410 },
  { id: 'route', tab: 'td-tab-route', panel: 'td-route', labelKey: 'route.tab', icon: '⤳', visitor: false, height: true, defaultMinPx: 410 },
];
const DEF = Object.fromEntries(PANES.map(p => [p.id, p])) as Record<PaneId, PaneDef>;
const PANE_OF: Record<string, PaneId> = Object.fromEntries(PANES.map(p => [p.tab, p.id]));
/** The pane that comes into view when the one in view closes: the table, then tab order. */
const FALLBACK: PaneId[] = ['table', ...PANES.map(p => p.id).filter(id => id !== 'table')];
const SIDES = PANES.filter(p => p.id !== 'table');

interface TableHooks {
  isOpen(): boolean;
  onShow(): void;
  focusTarget(): HTMLElement | null;
  close(): HTMLElement | null;
  sizePromptPending(): boolean;
  mount(root: HTMLElement): void;
}

let drawer: HTMLElement | null = null;
let table: TableHooks | null = null;
let height = 0;             // px, from `frac` and the container
let frac = 0;               // the drawer's share of the map container; 0 = the layout's default
let collapsed = false;
let routeFloor = 0;         // setPaneFloor('route', px)
let pane: PaneId = 'table'; // the pane in view
/** Each side pane's open flag, the element focus returns to and its onClose. */
const P = Object.fromEntries(SIDES.map(p => [p.id, { open: false, opener: null, onClose: null }])) as
  Record<Side, { open: boolean; opener: HTMLElement | null; onClose: (() => void) | null }>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => drawer!.querySelector<T>(sel)!;
const COMPACT = '(max-width: 640px), (max-height: 500px)';
const compact = () => typeof matchMedia === 'function' && matchMedia(COMPACT).matches;
function mapContainer() { return document.querySelector<HTMLElement>('.map-container'); }

// ─── Panes ───────────────────────────────────────────────────────────────────
export function paneOpen(id: PaneId): boolean {
  return id === 'table' ? !!table?.isOpen() : P[id].open;
}

export function panel(id: PaneId): HTMLElement {
  ensureDrawer();
  return $(`#${DEF[id].panel}`);
}

export function headerSlot(id: 'route'): HTMLElement {
  ensureDrawer();
  return $(`.td-${id}-actions`);
}

export function openPane(id: PaneId, onClose?: () => void, from?: HTMLElement | null, opts?: { background?: boolean }): void {
  if (id === 'table') openTablePane();
  else openSide(id, onClose, from, !!opts?.background);
}

export function closePane(id: PaneId): void {
  if (id === 'table') closeTablePane();
  else closeSide(id);
}

export function selectPane(id: 'table'): void { pickPane(id); }

/** While above 0, the drawer is at least `px` high (within the map); at 0 it
 *  is back at the height it had. */
export function setPaneFloor(id: 'route', px: number): void {
  if (id === 'route') routeFloor = px;
  if (drawer && !drawer.hidden) applyHeight();
}

/** The table's open: the drawer up at its layout height, the table in view
 *  unless the visitor is typing in the chat (a table the chat asked for leaves
 *  the conversation in view; Route, if open, stays in its tab). */
function openTablePane() {
  ensureDrawer();
  const c = mapContainer()!;
  const chatting = P.ask.open && $('#td-ask').contains(document.activeElement);
  if (!chatting) pane = 'table';
  foldLayersOnPhone();
  drawer!.hidden = false;
  drawer!.classList.add('td--open');
  c.classList.add('has-drawer');
  collapsed = false;
  applyHeight();
  syncPanes();
}

function closeTablePane() {
  if (!drawer) return;
  noteVisitorAct();
  const back = table?.close() ?? null;
  afterClose(back);
}

/** Open a side pane and bring it into view; `onClose` runs when it closes, and
 *  focus then returns to `from` (default: the focused element). With
 *  `background` (the map chat's route) the pane opens or stays open but the
 *  pane in view stays in view; focus and the opener are left as they are. */
function openSide(p: Side, onClose?: () => void, from?: HTMLElement | null, background = false): void {
  ensureDrawer();
  const s = P[p], o = DEF[p];
  if (!s.open && !background) {
    const a = from ?? document.activeElement as HTMLElement | null;
    s.opener = a && a !== document.body && !drawer!.contains(a) ? a : null;
  }
  if (o.visitor && resuming !== p) noteVisitorAct();
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
 *  the map). Route's close also drops its height floor. */
function closeSide(p: Side): void {
  const s = P[p], o = DEF[p];
  if (!s.open || !drawer) return;
  if (o.visitor) noteVisitorAct();
  s.open = false;
  if (p === 'route') setPaneFloor('route', 0);
  s.onClose?.();
  const back = s.opener;
  s.opener = null;
  afterClose(back, p !== 'ask');
}

/** After a pane closes: the drawer stays while another pane is open (focus
 *  to `back`, else into the pane now in view, else its tab when `toTab`),
 *  else it hides and focus goes to `back`, else the map (the popup's "Show in
 *  table" button is gone once the popup closes). */
function afterClose(back: HTMLElement | null, toTab = false) {
  if (FALLBACK.some(paneOpen)) {
    syncPanes();
    if (pane === 'table') table?.onShow();
    const into = toTab || (pane !== 'ask' && pane !== 'table') ? null
      : pane === 'ask' ? drawer!.querySelector<HTMLElement>('.chat-input') : table?.focusTarget() ?? null;
    (back?.isConnected ? back : into ?? $(`#${DEF[pane].tab}`)).focus();
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

/** Which pane shows: the one in view, the others hidden but kept. */
function syncPanes() {
  if (!drawer) return;
  if (!paneOpen(pane)) pane = FALLBACK.find(paneOpen) ?? 'table';
  const shown = Object.fromEntries(FALLBACK.map(p => [p, paneOpen(p) && pane === p])) as Record<PaneId, boolean>;
  for (const { id, tab: tabId } of PANES) {
    const tab = $(`#${tabId}`);
    tab.hidden = !paneOpen(id);
    tab.setAttribute('aria-selected', String(shown[id]));
    tab.tabIndex = pane === id ? 0 : -1;
    const x = $(`.td-tab-x[data-pane="${id}"]`);
    x.hidden = tab.hidden;
    x.setAttribute('aria-label', t('table.closeTab', { name: tab.lastElementChild?.textContent ?? '' }));
    x.title = x.getAttribute('aria-label')!;
  }
  for (const { id, panel: el } of SIDES) $(`#${el}`).hidden = !shown[id];
  $('.td-route-actions').hidden = !shown.route;
  drawer.classList.toggle('td--table-off', !shown.table);
  touched();
}

function pickPane(p: PaneId, focus = false) {
  if (!paneOpen(p)) return;
  pane = p;
  syncPanes();
  if (p === 'table') table?.onShow();
  if (focus) $(`#${DEF[p].tab}`).focus();
}

// ─── Height ──────────────────────────────────────────────────────────────────
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
  // A pane with a taller default (Route's input column, a template's 420 px frame, the locator's form) lifts it while open; a grip drag still wins.
  const minPx = Math.max(0, ...SIDES.filter(p => p.defaultMinPx && P[p.id as Side].open).map(p => p.defaultMinPx!));
  const base = frac ? frac * ch : Math.max(defaultFrac(ch) * ch, minPx && !compact() ? Math.max(minPx, ch * 0.45) : 0);
  height = Math.max(140, Math.min(Math.max(base, routeFloor), max));
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

/** Map padding (px) that keeps a fit above the drawer and clear of the
 *  layer panel. */
export function drawerPadding(): { top: number; left: number; right: number; bottom: number } {
  const c = state.map?.getContainer() ?? mapContainer();
  if (!c) return { top: 60, left: 40, right: 40, bottom: 40 };
  const lp = document.getElementById('layersPanel');
  const desktop = c.clientWidth > 640;
  const drawerH = drawer && !drawer.hidden ? drawer.offsetHeight : 0;
  const right = desktop && lp && !lp.hidden ? lp.offsetWidth + 36 : 40;
  const bottom = Math.min(drawerH + 40, Math.max(40, c.clientHeight - 140));
  return { top: 60, left: 40, right: Math.min(right, c.clientWidth - 140), bottom };
}

// ─── The drawer ──────────────────────────────────────────────────────────────
export function bindTable(h: TableHooks): void {
  table = h;
  if (drawer) h.mount(drawer);
}

const tabHtml = (p: PaneDef, e: (k: string) => string) => p.id === 'table'
  ? `<button type="button" class="td-tab" id="${p.tab}" role="tab" aria-selected="true" aria-controls="${p.panel}">${p.icon}<span class="td-tab-name"></span></button>`
  : `<button type="button" class="td-tab td-tab-${p.id}" id="${p.tab}" role="tab" aria-selected="false" aria-controls="${p.panel}" tabindex="-1" hidden><span class="td-tab-${p.id}-icon" aria-hidden="true">${p.icon}</span><span data-i18n="${p.labelKey}">${e(p.labelKey)}</span></button>`;
const panelHtml = (p: PaneDef) =>
  `<div class="td-${p.id}" id="${p.panel}" role="tabpanel" aria-labelledby="${p.tab}" hidden></div>`;

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
  // an inner <span>, never on a node that also holds an icon or a count. The
  // table's controls are here too; ui-table.ts wires them (mount).
  drawer.innerHTML = `
    <div class="td-grip" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="${e('table.resize')}" data-i18n-aria-label="table.resize" aria-valuemin="140"></div>
    <div class="td-head">
      <div class="td-tabs" role="tablist" aria-label="${e('table.tab')}" data-i18n-aria-label="table.tab">
        ${PANES.map(p => tabHtml(p, e)).join('\n        ')}
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
    ${SIDES.map(panelHtml).join('\n    ')}
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
  // Before the table's own subscriber (mount): the tabs' labels first, then the table redraws.
  on('lang:changed', () => { if (drawer) syncPanes(); });
  table?.mount(drawer);

  // Each tab's own × closes that pane; the drawer hides with the last one.
  for (const { id: p, tab } of PANES) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'td-tab-x';
    x.dataset.pane = p;
    x.tabIndex = -1;
    x.hidden = true;
    x.textContent = '×';
    x.addEventListener('click', () => { if (paneOpen(p)) closePane(p); });
    $(`#${tab}`).after(x);
  }
  $('.td-collapse').addEventListener('click', () => { noteVisitorAct(); collapsed = !collapsed; applyHeight(); });
  drawer.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    ev.preventDefault();
    // The active pane only: Route when it is in view, else the pane focus is in.
    if (pane !== 'table' && pane !== 'ask' && P[pane].open) closeSide(pane);
    else if (P.ask.open && ($('#td-ask').contains(ev.target as Node) || !paneOpen('table'))) closeSide('ask');
    else if (paneOpen('table') || !P.route.open) closeTablePane();
    else closeSide('route');
  });
  // The tabs: a click or ←→ Home End (over the open ones) picks the pane in view.
  for (const { id: p, tab } of PANES) $(`#${tab}`).addEventListener('click', () => { noteVisitorAct(); pickPane(p); });
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
    noteVisitorAct();
    pickPane(PANE_OF[tabs[to].id], true);
  });

  // Resize by the grip: drag, or ↑↓ with the grip focused.
  const grip = $('.td-grip');
  grip.addEventListener('pointerdown', (ev) => {
    grip.setPointerCapture(ev.pointerId);
    const startY = ev.clientY, startH = height;
    noteVisitorAct();
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
    noteVisitorAct();
    collapsed = false;
    setHeight(height + (ev.key === 'ArrowUp' ? 24 : -24));
  });
  window.addEventListener('resize', () => { if (drawer && !drawer.hidden) applyHeight(); });
  // The layer panel opening or closing narrows the drawer without a resize.
  new ResizeObserver(() => { if (drawer && !drawer.hidden) syncPanes(); }).observe(drawer);
}

// ─── Save and restore (this tab's sessionStorage) ────────────────────────────
// tm-drawer (drawer-snapshot.ts): the layout — Ask and the table open or not,
// the pane in view, height and collapse — and the table's and Visualize's
// parts. Saved on hidden / pagehide and again on every change while hidden (a
// table the chat opens in the background); removed when no kept pane is open.
// A restore writes no link and adds no undo step.
let restoring = false;             // a restore's own synchronous steps: nothing is saved meanwhile
let visitorActs = 0;               // the visitor's opens, closes, tab picks and resizes, counted
let resuming: Side | null = null;  // the pane a restore is opening: that open is not the visitor's
let tablePart: (() => TableSnapshot | null) | null = null;
let vizPart: (() => VizSnapshot | null) | null = null;
let pending: DrawerSnapshot | null = null;   // a restore still waiting for the chat or the map: what a save keeps meanwhile
let unloaded: DrawerSnapshot | null = null;  // a restore whose table chunk failed to load: its table, pane and collapse are kept for the next reload

/** The visitor changed the drawer: a restore still waiting gives way, and its saved table is no longer kept. */
export function noteVisitorAct(): void { visitorActs++; pending = null; unloaded = null; }

/** A getter for that part of tm-drawer; the table's is read only while the table is open. */
export function registerSnapshotPart(part: 'table', get: () => TableSnapshot | null): void;
export function registerSnapshotPart(part: 'viz', get: () => VizSnapshot | null): void;
export function registerSnapshotPart(part: 'table' | 'viz', get: () => TableSnapshot | VizSnapshot | null): void {
  if (part === 'table') tablePart = get as () => TableSnapshot | null;
  else vizPart = get as () => VizSnapshot | null;
}

function drawerSnapshot(): DrawerSnapshot | null {
  const tableSnap = paneOpen('table') ? tablePart?.() ?? null : pending?.table ?? unloaded?.table ?? null;
  const viz = P.viz.open ? vizPart?.() ?? null : pending?.viz ?? null;
  if (!tableSnap && !P.ask.open && !viz) return null;
  const has: Partial<Record<PaneId, boolean>> = { ask: P.ask.open, table: !!tableSnap, viz: !!viz };
  const kept = (k: PaneId): k is DrawerSnapshot['pane'] => !!DEF[k].kept && !!has[k];
  const p = unloaded && kept(unloaded.pane) ? unloaded.pane : kept(pane) ? pane : FALLBACK.find(kept)!;
  return {
    v: DRAWER_SNAPSHOT_VERSION, ask: P.ask.open, table: tableSnap, ...(viz && { viz }),
    pane: p, frac, collapsed: unloaded ? unloaded.collapsed : collapsed,
  };
}

function saveDrawer() {
  if (!drawer || restoring) return;
  const s = drawerSnapshot();
  if (!s) { clearSnapshot(DRAWER_SNAPSHOT); return; }
  if (!saveSnapshot(DRAWER_SNAPSHOT, s, { maxChars: 200_000 })) clearSnapshot(DRAWER_SNAPSHOT);
}

/** A change while the page is hidden is saved at once (the panes call it for their own state). */
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

/** After a reload of this tab: the drawer as tm-drawer left it. `ask` brings
 *  the chat back first when Ask was open, `viz` the Visualize pane; then the
 *  table — `prepare` (false: skip it; a vector-tile layer waits for the map
 *  there; a rejection — the table chunk failed to load — skips it too, and
 *  the saved table, pane and collapse stay in tm-drawer until the visitor
 *  changes the drawer), then `start` inside the same synchronous step as the
 *  pane in view, the height and the collapse, unless the visitor moved meanwhile. A pending
 *  size prompt keeps the table in view. No focus moves. */
export async function restoreDrawer(resume: {
  ask(): Promise<void>;
  viz?(s: VizSnapshot): Promise<void>;
  table: { prepare(s: TableSnapshot): Promise<boolean>; start(s: TableSnapshot): Promise<void> };
}): Promise<void> {
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
      resuming = 'ask';
      try { await resume.ask(); } catch { /* the chat opens from the menu as usual */ } finally { resuming = null; }
    }
    if (snap.viz && resume.viz) {
      resuming = 'viz';
      try { await resume.viz(snap.viz); } catch { /* Visualize opens from the menu as usual */ } finally { resuming = null; }
    }
    const tb = snap.table;
    let wanted = false;
    if (tb) {
      try { wanted = await resume.table.prepare(tb); } catch { if (!moved()) unloaded = snap; }
    }
    // The visitor opened or changed something while this waited: theirs stands.
    if (moved()) return;
    restoring = true;
    try {
      if (wanted) shown = resume.table.start(tb!);
      if (paneOpen(snap.pane) && !table?.sizePromptPending()) pane = snap.pane;
      if (drawer!.classList.contains('td--open')) { collapsed = snap.collapsed; applyHeight(); syncPanes(); }
    } finally {
      restoring = false;
    }
  } finally {
    pending = null;
  }
  await shown;
}
