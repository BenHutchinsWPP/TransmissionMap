// ─── Grid Ops tab (lazy chunk) ───────────────────────────────────────────────
// Role: the bottom drawer's Grid Ops tab for the Grid Operations layer
//       (EIA-930): one node — a BA or a group of them — with its name, the
//       hour, Load / Generation / Net export or import, and its ties as bars
//       (exporter → importer, by |MW|); the metered-flow note; and a plain
//       table of every node on the map (Name, Load, Generation, Net, Top fuel),
//       by load, largest first. A row's name button selects that node and
//       eases the map to it above the drawer. "Inside the area" (a group of
//       ≥ 2 BAs) switches the grouping to BAs (one `url:write` through
//       setGridGroup), fits the members and, on the next paint without the
//       group, selects the member with the largest load.
//       It renders from grid-ops.ts's gridShown() and again on every paint
//       (playback included), keeping focus on the element with the same
//       data-id; it follows lang:changed and closes when the layer is switched
//       off. Never kept in tm-drawer, never in the link: the node is session
//       only. DOM is built as text (createElement + textContent; lint-enforced).
// Opened only through grid-ops-open.ts (a bubble tap).
// Deps: ui-table.ts (gopsPanel, openGops, closeGops, drawerPadding),
//       grid-ops/grid-ops.ts (gridShown, onGridPaint, setGridGroup, GRID_LAYER),
//       grid-ops/ba-graph.ts (BAS, Tie), panel-mirror.ts (syncPanel), state.ts,
//       state-bus.ts (on: lang:changed, layer:visibility), src/colors/fuel.ts
//       (FUEL_LEGEND), i18n (t, getLocale), undo.ts (asOwnStep: Inside the area
//       is its own undo step), ui-grid-ops.css.

import { state } from '../state.js';
import { on } from '../state-bus.js';
import { t, getLocale } from '../../src/i18n/index.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import { BAS, type Tie } from '../grid-ops/ba-graph.js';
import { gridShown, onGridPaint, setGridGroup, GRID_LAYER, type GridShown, type PaintedNode } from '../grid-ops/grid-ops.js';
import { gopsPanel, openGops, closeGops, drawerPadding } from './ui-table.js';
import { syncPanel } from './panel-mirror.js';
import { asOwnStep } from '../undo.js';
import './ui-grid-ops.css';

const FUEL_LABEL = new Map(FUEL_LEGEND.map(f => [f.id, f.label]));
const BA_AT = new Map(BAS.map(b => [b.code, [b.lon, b.lat] as [number, number]]));

let selected: string | null = null;
let pendingArea: string | null = null;      // "Inside the area": the group left behind…
let pendingMembers: string[] | null = null; // …and its BA codes, until a paint without it
let unsub: (() => void) | null = null;
let subscribed = false;

/** Open the tab on `nodeId` (null keeps the node it shows). */
export function openGridOps(nodeId: string | null, from?: HTMLElement | null): void {
  openGops(drop, from);
  if (nodeId) { selected = nodeId; pendingArea = null; pendingMembers = null; }
  if (!subscribed) {
    subscribed = true;
    on('lang:changed', () => { if (unsub) render(); });
    on('layer:visibility', ({ id }) => { if (id === GRID_LAYER && unsub && !layerOn()) closeGridOps(); });
  }
  unsub ??= onGridPaint(onPaint);
  render();
}

export function closeGridOps(): void { closeGops(); }

const layerOn = () => !!state.layerVisibility[GRID_LAYER];

function onPaint(s: GridShown | null) {
  if (!s && !layerOn()) { closeGridOps(); return; }
  if (s && pendingMembers && !s.nodes.some(n => n.properties.id === pendingArea)) {
    const members = new Set(pendingMembers);
    let best: PaintedNode | null = null;
    for (const n of s.nodes) {
      if (!members.has(n.properties.id)) continue;
      if (!best || (n.properties.load ?? -Infinity) > (best.properties.load ?? -Infinity)) best = n;
    }
    if (best) selected = best.properties.id;
    pendingArea = null; pendingMembers = null;
  }
  render();
}

function drop() {
  unsub?.();
  unsub = null;
  selected = null; pendingArea = null; pendingMembers = null;
  gopsPanel().replaceChildren();
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  parent?.append(e);
  return e;
}

const num = (v: number) => Math.round(v).toLocaleString(getLocale());
const mwText = (v: number | null) => v == null ? '–' : `${num(v)} MW`;
const signed = (v: number | null) => v == null ? '–' : Math.round(v).toLocaleString(getLocale(), { signDisplay: 'exceptZero' });
function parseList<T>(s: string): T[] {
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v as T[] : []; } catch { return []; }
}
const hourText = (at: number) => t('gridOps.hourEnding', { time: new Intl.DateTimeFormat(getLocale(), {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(at)) });

/** The largest positive fuel's legend label, or "–". */
export function topFuel(fuels: string): string {
  let best: [string, number] | null = null;
  for (const r of parseList<unknown>(fuels)) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'number' || r[1] <= 0) continue;
    if (!best || r[1] > best[1]) best = [r[0], r[1]];
  }
  return best ? FUEL_LABEL.get(best[0]) ?? best[0] : '–';
}

function render() {
  const panel = gopsPanel();
  const active = document.activeElement as HTMLElement | null;
  const focusId = active && panel.contains(active) ? active.dataset.id ?? null : null;
  const root = el('div', 'gops');
  const s = gridShown();
  if (!s) {
    el('p', 'gops-msg', root, t('gridOps.noData'));
    actions(root, null);
  } else {
    const node = s.nodes.find(n => n.properties.id === selected) ?? null;
    if (node) nodeView(root, node, s);
    else el('p', 'gops-msg', root, t('gridOps.pickNode'));
    actions(root, node);
    table(root, s);
  }
  panel.replaceChildren(root);
  if (focusId) {
    const back = [...panel.querySelectorAll<HTMLElement>('[data-id]')].find(e => e.dataset.id === focusId);
    back?.focus({ preventScroll: true });
  }
}

function nodeView(root: HTMLElement, node: PaintedNode, s: GridShown) {
  const p = node.properties;
  const head = el('div', 'gops-head', root);
  el('h3', 'gops-name', head, p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id);
  el('p', 'gops-hour', head, hourText(s.at));

  const figs = el('div', 'gops-figs', root);
  const fig = (label: string, value: string) => {
    const f = el('div', 'gops-fig', figs);
    el('span', 'gops-fig-k', f, label);
    el('span', 'gops-fig-v', f, value);
  };
  fig(t('gridOps.load'), mwText(p.load));
  fig(t('gridOps.gen'), mwText(p.gen));
  fig(t(p.net != null && p.net < 0 ? 'gridOps.netImport' : 'gridOps.netExport'), mwText(p.net == null ? null : Math.abs(p.net)));

  el('h4', 'gops-sub', root, t('gridOps.ties'));
  const ties = parseList<Tie>(p.ties).filter(x => x && typeof x.with === 'string' && typeof x.mw === 'number' && Math.round(x.mw) !== 0);
  if (!ties.length) el('p', 'gops-msg', root, t('gridOps.noTies'));
  else {
    const shortOf = new Map(s.nodes.map(n => [n.properties.id, n.properties.short || n.properties.id]));
    const me = p.short || p.id;
    const max = Math.max(...ties.map(x => Math.abs(x.mw)));
    const list = el('ul', 'gops-ties', root);
    for (const x of ties) {
      const other = shortOf.get(x.with) ?? x.with;
      const [from, to] = x.mw > 0 ? [me, other] : [other, me];
      const li = el('li', 'gops-tie', list);
      const bar = el('span', 'gops-tie-bar', li);
      bar.classList.add(x.mw > 0 ? 'gops-tie-out' : 'gops-tie-in');
      bar.style.width = `${Math.max(2, Math.abs(x.mw) / max * 100)}%`;
      el('span', 'gops-tie-text', li, t('gridOps.tieRow', { from, to, mw: mwText(Math.abs(x.mw)) }));
    }
  }
  el('p', 'gops-note', root, t('gridOps.meteredNote'));
}

function actions(root: HTMLElement, node: PaintedNode | null) {
  const bar = el('div', 'gops-actions', root);
  const members = node ? parseList<unknown>(node.properties.members).filter((c): c is string => typeof c === 'string') : [];
  if (node && members.length >= 2) {
    const b = el('button', 'td-btn gops-inside', bar, t('gridOps.inside'));
    b.type = 'button';
    b.title = t('gridOps.insideTitle');
    b.dataset.id = 'inside';
    b.addEventListener('click', () => insideArea(node.properties.id, members));
  }
  const c = el('button', 'td-btn gops-close', bar, t('gridOps.close'));
  c.type = 'button';
  c.dataset.id = 'close';
  c.addEventListener('click', closeGridOps);
}

function table(root: HTMLElement, s: GridShown) {
  el('h4', 'gops-sub', root, t('gridOps.tableTitle'));
  const tbl = el('table', 'td-gops-table', root);
  const hr = el('tr', '', el('thead', '', tbl));
  for (const k of ['gridOps.colName', 'gridOps.colLoad', 'gridOps.colGen', 'gridOps.colNet', 'gridOps.colFuel']) {
    el('th', '', hr, t(k)).scope = 'col';
  }
  const body = el('tbody', '', tbl);
  const rows = [...s.nodes].sort((a, b) => {
    const x = a.properties.load, y = b.properties.load;
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    return y - x;
  });
  for (const n of rows) {
    const p = n.properties;
    const tr = el('tr', p.id === selected ? 'gops-row gops-row--on' : 'gops-row', body);
    const name = el('button', 'gops-pick', el('th', '', tr), p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id);
    name.type = 'button';
    name.dataset.id = `row:${p.id}`;
    name.title = t('gridOps.flyTo', { name: p.name || p.id });
    name.setAttribute('aria-pressed', String(p.id === selected));
    name.addEventListener('click', () => pick(n));
    el('td', 'gops-num', tr, p.load == null ? '–' : num(p.load));
    el('td', 'gops-num', tr, p.gen == null ? '–' : num(p.gen));
    el('td', 'gops-num', tr, signed(p.net));
    el('td', '', tr, topFuel(p.fuels));
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────
function pick(n: PaintedNode) {
  selected = n.properties.id;
  pendingArea = null; pendingMembers = null;
  render();
  // An offset, not padding: easeTo keeps a padding on the map after it ends.
  const pad = drawerPadding();
  state.map?.easeTo({ center: n.geometry.coordinates as [number, number], offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2], duration: 600 });
}

function insideArea(areaId: string, members: string[]) {
  pendingArea = areaId;
  pendingMembers = members;
  asOwnStep(() => setGridGroup('ba'));
  syncPanel(GRID_LAYER);
  const pts = members.map(c => BA_AT.get(c)).filter((x): x is [number, number] => !!x);
  if (!pts.length || !state.map) return;
  const lons = pts.map(x => x[0]), lats = pts.map(x => x[1]);
  const pad = drawerPadding();
  state.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
    padding: { top: pad.top + 40, left: pad.left + 40, right: pad.right + 40, bottom: pad.bottom + 40 },
    maxZoom: 7, duration: 600,
  });
}
