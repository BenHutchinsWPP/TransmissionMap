// ─── Method grid ─────────────────────────────────────────────────────────────
// Role: the Method tab's weights editor as a Tabulator grid (renderer only): one grid row per group header,
//       preset row and exemption (`except`) entry, columns Excl. / Map / Category / Group / Applies to /
//       Routing weight / Cost × / one per regional cost set / Map data from / Weight & cost from (Applies to in
//       words, its cube match as the tooltip; Copy all and the CSV add a Cube match column). Sorting,
//       filtering, grouping and every edit belong to method-rows.ts (which runs each edit through
//       validatePresetPatch); this module draws its rows with `replaceData`, turns a cell edit, an Excl. or
//       exemption tick into a method-rows call, and hands the accepted patch to `onChange`. A refusal puts the
//       cell's old value back and shows the reason in the toolbar's alert line.
//       Tabulator rules (AGENTS.md, Table drawer): Format, FrozenColumns, Interaction, Keybindings, SelectRange,
//       Edit and ResizeColumns only (never Clipboard or Export: they write copied values through innerHTML);
//       every formatter and titleFormatter returns a Node; fields are positional (`f0`…); cells are text
//       only. Edit opens on a double click (or Enter on a one-cell range), so a drag over cells makes a range.
//       Ctrl/Cmd+C copies the range as TSV (header line, group rows skipped) through grid-copy.ts; copies
//       and the CSV carry the text as plain ASCII (method-rows.ts asciiText), the CSV behind a UTF-8 BOM.
//       The Map column calls `onHighlight` with RowPicks (next free palette slot, ≤ MAX_HIGHLIGHT).
//       With `fitIn`, the grid's height follows the room the scrolling pane leaves under its sticky header
//       (160–520 px), so its last rows and scrollbar stay reachable in a short drawer.
// Deps: tabulator-tables (this lazy chunk only), route-tabs/method-rows.ts, ui/grid-copy.ts, route/route.ts
//       (HIGHLIGHT_PALETTE, MAX_HIGHLIGHT, RowPick), route/preset-patch.ts (type), registry/route-presets.ts,
//       user-data/user-data-export.ts (toCsv, downloadFile), route-tabs/widgets.ts (sourceInfo), i18n.
// Used by: method.ts.

import {
  Tabulator, EditModule, FormatModule, FrozenColumnsModule, InteractionModule, KeybindingsModule,
  ResizeColumnsModule, SelectRangeModule,
  type CellComponent, type ColumnDefinition, type RowComponent,
} from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';
import './method-grid.css';
import { t } from '../../../src/i18n/index.js';
import { EXCLUDED_W, type RoutePreset } from '../../../src/registry/route-presets.js';
import type { PresetPatch } from '../../route/preset-patch.js';
import { setNames } from '../../route/cost.js';
import { HIGHLIGHT_PALETTE, MAX_HIGHLIGHT, type RowPick } from '../../route/route.js';
import { toCsv, downloadFile } from '../../user-data/user-data-export.js';
import { GRID_RANGE_DEFAULTS, isCopyKey, keepFromGrid, clipValue, tsvOf, copyText } from '../grid-copy.js';
import { sourceInfo } from './widgets.js';
import {
  columnsOf, methodRows, viewRows, tableValues, asciiText, setRouteW, setCostX, setExcluded, setExcept, setContingency, wasText,
  type ColId, type Edit, type MethodRow, type ViewOpts,
} from './method-rows.js';
import { h } from '../../utils/utils-dom.js';

Tabulator.registerModule([
  EditModule, FormatModule, FrozenColumnsModule, InteractionModule, KeybindingsModule,
  ResizeColumnsModule, SelectRangeModule,
]);

export interface MethodGridOpts {
  preset: RoutePreset;              // the method's
  base: RoutePreset;                // the registry preset (setExcluded's untick target)
  patch: PresetPatch | null;
  onChange(patch: PresetPatch | null, errors: number): void;     // errors always 0
  regionM?: Record<string, number>;
  highlight: RowPick[];
  onHighlight: ((picks: RowPick[]) => void) | null;             // null = Map column disabled (route.mg.mapNeedsRoute)
  /** The pane that scrolls the tab and the sticky header over it: the grid fits the room left under the header. */
  fitIn?: { scroller: HTMLElement; sticky: HTMLElement };
}
export interface MethodGrid {
  setPatch(p: PresetPatch | null): void;
  setRegionM(m: Record<string, number> | undefined): void;
  setHighlight(picks: RowPick[], enabled: boolean): void;
  destroy(): void;
}

type GridRow = Record<string, unknown> & { _k: string };

const rgba = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const pickKey = (p: { row: number; except?: number }) => (p.except === undefined ? `r:${p.row}` : `x:${p.row}:${p.except}`);
const WIDTH: Record<string, number> = { excl: 64, map: 56, label: 210, group: 96, applies: 220, routeW: 118, costX: 100, dataFrom: 230, src: 130 };

export function mountMethodGrid(el: HTMLElement, opts: MethodGridOpts): MethodGrid {
  const { preset, base } = opts;
  const names = preset.regions ? setNames(preset) : [];
  const cols = columnsOf(preset);
  const field = (c: ColId) => `f${cols.indexOf(c)}`;
  const labelOf = (c: ColId): string => c.startsWith('set:') ? t('route.mg.col.set', { set: c.slice(4) }) : t(`route.mg.col.${c}`);

  let patch = opts.patch;
  let crossed = opts.regionM;
  let picks = [...opts.highlight];
  let enabled = opts.onHighlight !== null;
  const view: ViewOpts = { q: '', flat: false, editedOnly: false, sort: null };
  let all: MethodRow[] = [];
  let shownRows: MethodRow[] = [];
  let byKey = new Map<string, MethodRow>();
  let built = false;
  let keep: { top: number; left: number } | null = null, rebuilds = 0;
  let dead = false;

  // ── toolbar and frame ──
  const wrap = h('div', 'rm-mg');
  const bar = h('div', 'rm-mg-bar');
  const q = h('input', 'rm-mg-q');
  q.type = 'search';
  q.placeholder = t('route.mg.filter');
  q.setAttribute('aria-label', t('route.mg.filterAria'));
  const chip = (label: string, on: () => void): HTMLButtonElement => {
    const b = h('button', 'rm-mg-chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); on(); });
    return b;
  };
  const flat = chip(t('route.mg.flat'), () => { view.flat = flat.getAttribute('aria-pressed') === 'true'; refresh(true); });
  const edited = chip(t('route.mg.editedOnly'), () => { view.editedOnly = edited.getAttribute('aria-pressed') === 'true'; refresh(true); });
  const copyAll = h('button', 'rm-mg-btn', t('route.mg.copyAll'));
  copyAll.type = 'button';
  const csv = h('button', 'rm-mg-btn', t('chart.csv'));
  csv.type = 'button';
  csv.dataset.act = 'csv';
  const status = h('span', 'rm-mg-status');
  status.setAttribute('role', 'status');
  bar.append(q, flat, edited, copyAll, csv, status);
  const gridEl = h('div', 'rm-grid');
  const none = h('p', 'rm-mg-none', t('route.mg.none'));
  none.hidden = true;
  const alertEl = h('p', 'rm-mg-alert');
  alertEl.setAttribute('role', 'alert');
  alertEl.hidden = true;
  wrap.append(bar, gridEl, none, alertEl);

  let cont: { input: HTMLInputElement; was: HTMLElement } | null = null;
  const pctText = (x: number) => String(+(x * 100).toFixed(6));
  if (preset.contingency) {
    const box = h('div', 'rm-mg-cont');
    const lab = h('label', 'rm-mg-cont-lab');
    const input = h('input', 'rm-mg-in');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.size = 5;
    input.dataset.field = 'contingency';
    lab.append(h('span', undefined, t('route.wt.contingency')), input);
    const was = h('span', 'rm-was');
    box.append(lab, sourceInfo(preset.contingency.src), was);
    wrap.append(box);
    cont = { input, was };
  }
  el.replaceChildren(wrap);

  const setAlert = (msg: string) => { alertEl.textContent = msg; alertEl.hidden = !msg; };
  let statusNote = '';
  function updateStatus() {
    if (statusNote) { status.textContent = statusNote; return; }
    const tops = all.filter((r) => r.kind === 'row');
    status.textContent = t('route.mg.status', { rows: tops.length, excluded: tops.filter((r) => r.excluded).length, shown: picks.length });
  }

  // ── edits ──
  /** Take an Edit: its patch goes out, or the reason is shown. Returns whether it was accepted. */
  function apply(e: Edit): boolean {
    if (!e.ok) { setAlert(e.reason); return false; }
    setAlert('');
    patch = e.patch;
    opts.onChange(patch, 0);
    refresh();
    return true;
  }

  // ── cells ──
  const editable = (r: MethodRow | undefined) => !!r && r.kind === 'row' && !r.barrier;
  const rowOf = (cell: CellComponent) => byKey.get((cell.getData() as GridRow)._k);
  const text = (s: string | number) => h('span', 'rm-txt', String(s));
  const withWas = (cell: CellComponent, body: Node, was: string | null, cls?: string): HTMLElement => {
    const box = h('span', 'rm-cell');
    box.append(body);
    if (was) box.append(h('span', 'rm-was', was));
    const td = cell.getElement();
    td.classList.toggle('rm-edit', !!was);
    if (cls) td.classList.add(cls);
    return box;
  };
  const rowLabel = (r: MethodRow) => (r.kind === 'except' ? `${r.label}` : r.label);
  const parentLabel = (r: MethodRow) => all.find((x) => x.key === `r:${r.row}`)?.label ?? '';

  function exclCell(cell: CellComponent): HTMLElement {
    const r = rowOf(cell);
    const box = h('span', 'rm-cell');
    if (!r || r.kind === 'group' || (r.kind === 'row' && !r.excludable)) return box;
    const input = h('input');
    input.type = 'checkbox';
    keepFromGrid(input);
    if (r.kind === 'except') {
      input.checked = !!r.exceptOn;
      input.setAttribute('aria-label', t('route.mg.aria.except', { label: r.label, row: parentLabel(r) }));
      input.addEventListener('change', () => { if (!apply(setExcept(preset, patch, r.row, r.except!, input.checked))) input.checked = !input.checked; });
      if (r.edited) cell.getElement().classList.add('rm-edit');
    } else {
      input.checked = r.excluded;
      input.setAttribute('aria-label', t(r.link ? 'route.mg.aria.exclLinked' : 'route.mg.aria.excl', { row: r.label }));
      input.title = t('route.mg.tip.excl', { w: EXCLUDED_W });
      const was = wasText(r, 'excl');
      if (was) input.title += ` (${was})`;
      input.addEventListener('change', () => { if (!apply(setExcluded(preset, base, patch, r.row, input.checked))) input.checked = !input.checked; });
    }
    box.append(input);
    return box;
  }

  function mapCell(cell: CellComponent): HTMLElement {
    const r = rowOf(cell);
    const box = h('span', 'rm-cell');
    if (!r || r.kind === 'group') return box;
    const pick = picks.find((p) => pickKey(p) === r.key);
    const b = h('button', 'rm-map', pick ? '◉' : '○');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!pick));
    b.setAttribute('aria-label', t('route.mg.aria.map', { row: r.kind === 'except' ? `${parentLabel(r)}: ${r.label}` : r.label }));
    b.title = enabled ? t('route.mg.tip.map') : t('route.mg.mapNeedsRoute');
    b.disabled = !enabled;
    if (pick) b.style.color = rgba(HIGHLIGHT_PALETTE[pick.slot + 1]);
    keepFromGrid(b);
    b.addEventListener('click', () => toggleMap(r));
    box.append(b);
    return box;
  }

  function toggleMap(r: MethodRow) {
    if (!enabled || !opts.onHighlight) return;
    const at = picks.findIndex((p) => pickKey(p) === r.key);
    if (at >= 0) picks = picks.filter((_, i) => i !== at);
    else {
      if (picks.length >= MAX_HIGHLIGHT) { statusNote = t('route.mg.mapFull', { n: MAX_HIGHLIGHT }); updateStatus(); return; }
      const slot = [...Array(MAX_HIGHLIGHT).keys()].find((s) => !picks.some((p) => p.slot === s))!;
      const pr = preset.rows[r.row];
      picks = [...picks, { row: r.row, band: pr.band, ...(pr.note !== undefined ? { note: pr.note } : {}), ...(r.except !== undefined ? { except: r.except } : {}), slot }];
    }
    statusNote = '';
    opts.onHighlight(picks.map((p) => ({ ...p })));
    refresh();
  }

  function labelCell(cell: CellComponent): HTMLElement {
    const r = rowOf(cell);
    if (!r) return h('span');
    if (r.kind === 'group') {
      const s = h('span', 'rm-grp', r.rule ? t('route.wt.group', { group: r.label, rule: t(`route.wt.rule.${r.rule}`) }) : r.label);
      if (r.rule) s.title = t('route.wt.groupTip', { group: r.label, rule: t(`route.wt.rule.${r.rule}`) });
      return s;
    }
    const s = h('span', r.kind === 'except' ? 'rm-ex' : 'rm-cat', rowLabel(r));
    s.title = r.kind === 'except' ? `${parentLabel(r)}: ${r.label}` : r.label;
    return s;
  }

  function numCell(which: 'routeW' | 'costX') {
    return (cell: CellComponent): HTMLElement => {
      const r = rowOf(cell);
      const td = cell.getElement();
      td.classList.remove('rm-edit', 'rm-excl', 'rm-bar');
      if (!r || r.kind !== 'row') return h('span');
      const val = which === 'routeW' ? r.routeW : r.costX;
      if (r.barrier && which === 'routeW') { td.classList.add('rm-bar'); return h('span', 'rm-cell', t('route.wt.barrier')); }
      if (editable(r)) td.setAttribute('aria-label', t(`route.mg.aria.${which}`, { row: r.label }));
      const body = h('span', 'rm-num');
      if (which === 'costX' && preset.rows[r.row].cost_by_region) {
        const sc = h('span', 'rm-scale', t('route.wt.scale'));
        sc.title = t('route.wt.regionalTip', { sets: names.join(', ') });
        body.append(sc);
      }
      body.append(text(Array.isArray(val) ? `${val[0]}, ${val[1]}` : (val ?? '')));
      const was = wasText(r, which);
      const out = withWas(cell, body, was);
      if (which === 'routeW' && r.excluded) td.classList.add('rm-excl');
      return out;
    };
  }

  const plain = (get: (r: MethodRow) => string, cls: string, tip: boolean | ((r: MethodRow) => string) = false) => (cell: CellComponent): HTMLElement => {
    const r = rowOf(cell);
    const s = h('span', cls, r && r.kind !== 'group' ? get(r) : '');
    if (tip && r && s.textContent) cell.getElement().title = tip === true ? s.textContent : tip(r);
    return s;
  };

  // ── columns ──
  const heads = new Map<ColId, HTMLButtonElement>();
  const arrow = (c: ColId) => (view.sort?.col === c ? (view.sort.dir === 1 ? ' ▲' : ' ▼') : '');
  function sortBy(c: ColId) {
    const cur = view.sort;
    view.sort = cur?.col !== c ? { col: c, dir: 1 } : cur.dir === 1 ? { col: c, dir: -1 } : null;
    for (const [id, b] of heads) b.dataset.sort = view.sort?.col === id ? String(view.sort.dir) : '';
    for (const [id, b] of heads) b.lastElementChild!.textContent = arrow(id);
    refresh(true);
  }
  function headCell(c: ColId): HTMLElement {
    const b = h('button', 'rm-head');
    b.type = 'button';
    b.append(h('span', undefined, labelOf(c)), h('span', 'rm-ar', arrow(c)));
    if (c === 'excl') b.title = t('route.mg.tip.excl', { w: EXCLUDED_W });
    else if (c === 'map') b.title = t('route.mg.tip.map');
    else if (c === 'dataFrom') b.title = t('route.mg.tip.dataFrom');
    else if (c === 'src') b.title = t('route.mg.tip.src');
    heads.set(c, b);
    return b;
  }

  const num = (c: ColId): Partial<ColumnDefinition> => ({ hozAlign: 'right', cssClass: `rm-num-col${c.startsWith('set:') ? ' rm-set' : ''}` });
  function edited_(which: 'routeW' | 'costX') {
    return (cell: CellComponent) => {
      const r = rowOf(cell);
      if (!r) return;
      const v = String(cell.getValue()).trim();
      const e = which === 'routeW' ? setRouteW(preset, patch, r.row, v) : setCostX(preset, patch, r.row, v);
      if (!e.ok) { cell.restoreOldValue(); setAlert(e.reason); return; }
      apply(e);
    };
  }

  const columns: ColumnDefinition[] = cols.map((c): ColumnDefinition => {
    const def: Record<string, unknown> = {
      title: labelOf(c), field: field(c), width: WIDTH[c] ?? 96, headerSort: false, resizable: 'header',
      titleFormatter: () => headCell(c),
      headerClick: () => sortBy(c),
    };
    switch (c) {
      case 'excl': Object.assign(def, { formatter: exclCell, frozen: true, hozAlign: 'center', headerHozAlign: 'center' }); break;
      case 'map': Object.assign(def, { formatter: mapCell, frozen: true, hozAlign: 'center', headerHozAlign: 'center' }); break;
      case 'label': Object.assign(def, { formatter: labelCell, frozen: true }); break;
      case 'group': def.formatter = plain((r) => r.group, 'rm-txt'); break;
      case 'applies': def.formatter = plain((r) => r.applies, 'rm-applies', (r) => r.match); break;
      case 'routeW': case 'costX':
        Object.assign(def, num(c), {
          formatter: numCell(c),
          editor: 'input',
          editable: (cell: CellComponent) => editable(rowOf(cell)),
          editorParams: (cell: CellComponent) => {
            const r = rowOf(cell);
            return { elementAttributes: { 'aria-label': t(`route.mg.aria.${c}`, { row: r?.label ?? '' }), inputmode: 'decimal' } };
          },
          cellEdited: edited_(c),
        });
        break;
      case 'dataFrom': def.formatter = plain((r) => r.dataFrom, 'rm-dim', true); break;
      case 'src': def.formatter = plain((r) => r.ref, 'rm-dim', (r) => r.src); break;
      default: {
        const i = names.indexOf(c.slice(4));
        Object.assign(def, num(c), {
          formatter: (cell: CellComponent) => { const r = rowOf(cell); const v = r?.sets[i]; return h('span', 'rm-txt', v === null || v === undefined || r?.kind === 'group' ? '' : String(v)); },
        });
      }
    }
    return def as unknown as ColumnDefinition;
  });

  // ── data ──
  const shownKeys = () => new Set(picks.map(pickKey));
  function dataOf(rows: MethodRow[]): GridRow[] {
    const labelAt = cols.indexOf('label');
    return rows.map((r) => {
      const d: GridRow = { _k: r.key };
      if (r.kind === 'group') cols.forEach((_, i) => { d[`f${i}`] = i === labelAt ? r.label : ''; });
      else tableValues([r], cols, shownKeys(), names)[0].forEach((v, i) => { d[`f${i}`] = v; });
      return d;
    });
  }
  function compute() {
    all = methodRows(preset, patch);
    byKey = new Map(all.map((r) => [r.key, r]));
    shownRows = viewRows(all, view, names);
  }

  compute();
  const g = new Tabulator(gridEl, {
    // Tabulator writes this onto .rm-grid itself: the grid scrolls inside, under a header that stays in view.
    height: 'min(52vh, 520px)',
    layout: 'fitData',
    index: '_k',
    ...GRID_RANGE_DEFAULTS,
    editTriggerEvent: 'dblclick',
    rowFormatter: (row: RowComponent) => {
      const r = byKey.get((row.getData() as GridRow)._k);
      const e = row.getElement();
      if (r) e.dataset.key = r.key;
      e.classList.toggle('rm-group', r?.kind === 'group');
      e.classList.toggle('rm-except', r?.kind === 'except');
      e.classList.toggle('rm-off', r?.kind === 'except' && !r.exceptOn);
    },
    columns,
    data: dataOf(shownRows),
  } as unknown as ConstructorParameters<typeof Tabulator>[1]);

  function markCrossed() {
    cols.forEach((c) => {
      if (!c.startsWith('set:')) return;
      const b = heads.get(c);
      const on = (crossed?.[c.slice(4)] ?? 0) > 0;
      b?.closest('.tabulator-col')?.classList.toggle('rm-crossed', on);
      if (b) b.title = on ? t('route.mg.tip.setCrossed') : '';
    });
  }
  g.on('tableBuilt', () => { built = true; fitHeight(); void g.replaceData(dataOf(shownRows)).then(markCrossed, () => {}); });

  let fitH = 0;
  function fitHeight() {
    const f = opts.fitIn;
    if (!f || !built || dead) return;
    const pane = getComputedStyle(f.scroller);
    const under = parseFloat(pane.paddingTop) + (parseFloat(getComputedStyle(f.sticky).top) || 0) + f.sticky.offsetHeight;
    const room = f.scroller.clientHeight - under - parseFloat(pane.paddingBottom) - 4;
    const px = Math.round(Math.max(160, Math.min(520, room)));
    if (px !== fitH) { fitH = px; g.setHeight(px); }
  }
  const fitObs = opts.fitIn ? new ResizeObserver(fitHeight) : null;
  if (opts.fitIn) { fitObs!.observe(opts.fitIn.scroller); fitObs!.observe(opts.fitIn.sticky); }

  function syncContingency(force = false) {
    if (!cont || !preset.contingency) return;
    const cur = patch?.contingency ?? preset.contingency.pct;
    if (force || document.activeElement !== cont.input) cont.input.value = pctText(cur);
    cont.was.textContent = Math.abs(cur - preset.contingency.pct) > 1e-9 ? t('route.wt.was', { v: pctText(preset.contingency.pct) }) : '';
  }
  /** Rebuilds the shown rows. The grid keeps its scroll (an edit, a Map toggle, a re-solve), or goes to the top
   *  when `top` (the filter, a sort, Flat list, Edited only). */
  function refresh(top = false) {
    if (dead) return;
    compute();
    none.hidden = shownRows.length > 0;
    syncContingency();
    statusNote = statusNote && statusNote === t('route.mg.mapFull', { n: MAX_HIGHLIGHT }) && picks.length >= MAX_HIGHLIGHT ? statusNote : '';
    updateStatus();
    if (!built) return;
    // The rows are rebuilt, so a focused Excl. / exemption / Map control is found again by its row and put back.
    const at = document.activeElement as HTMLElement | null;
    const rowKey = at && gridEl.contains(at) ? at.closest<HTMLElement>('.tabulator-row')?.dataset.key : undefined;
    const sel = at?.matches('button') ? 'button.rm-map' : 'input[type=checkbox]';
    // The scroll from before the first of overlapping rebuilds is put back after the last; focus moves without scrolling.
    const holder = gridEl.querySelector<HTMLElement>('.tabulator-tableholder');
    if (top) keep = { top: 0, left: holder?.scrollLeft ?? 0 };
    else keep ??= { top: holder?.scrollTop ?? 0, left: holder?.scrollLeft ?? 0 };
    const mine = ++rebuilds;
    void g.replaceData(dataOf(shownRows)).then(() => {
      markCrossed();
      if (mine !== rebuilds) return;
      if (holder && keep) { holder.scrollTop = keep.top; holder.scrollLeft = keep.left; }
      keep = null;
      if (rowKey === undefined) return;
      for (const r of gridEl.querySelectorAll<HTMLElement>('.tabulator-row')) {
        if (r.dataset.key === rowKey) { r.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true }); break; }
      }
    }, () => {});
  }
  refresh();

  // ── events ──
  q.addEventListener('input', () => { view.q = q.value; refresh(true); });
  if (cont) {
    const c = cont;
    c.input.addEventListener('change', () => {
      if (!apply(setContingency(preset, patch, c.input.value))) syncContingency(true);
    });
  }

  /** Copies and the CSV carry plain ASCII in place of the method text's symbols (asciiText). */
  const outValues = (vals: (string | number)[][]) => vals.map((line) => line.map((v) => (typeof v === 'string' ? asciiText(v) : v)));
  /** The range as tab-separated text: a header line, then each data row's raw values (group rows skipped). */
  function rangeTsv(): { text: string; rows: number; cols: number } | null {
    const range = g.getRanges()[0];
    if (!range) return null;
    const ids = range.getColumns().map((c) => cols[Number((c.getField() ?? '').slice(1))]).filter((c): c is ColId => !!c);
    const rows = range.getRows().map((r) => byKey.get((r.getData() as GridRow)._k)).filter((r): r is MethodRow => !!r && r.kind !== 'group');
    if (!ids.length || !rows.length) return null;
    const values = outValues(tableValues(rows, ids, shownKeys(), names)).map((line) => line.map(clipValue));
    return { text: tsvOf(ids.map((c) => asciiText(labelOf(c))), values), rows: rows.length, cols: ids.length };
  }
  const onKey = (ev: KeyboardEvent) => {
    const target = ev.target as HTMLElement;
    if (target.closest('input, select, button')) return;
    if (isCopyKey(ev)) {
      const tsv = rangeTsv();
      if (!tsv) return;
      ev.preventDefault();
      ev.stopPropagation();
      copyText(tsv.text, () => { statusNote = t('route.mg.copied', { rows: tsv.rows, cols: tsv.cols }); updateStatus(); });
      return;
    }
    if (ev.key === 'Enter') {
      // A column without an editor has nothing for SelectRange's Enter to open.
      const range = g.getRanges()[0];
      const c = range?.getColumns();
      if (!c || c.length !== 1 || !c[0].getDefinition().editor) ev.stopPropagation();
    }
  };
  gridEl.addEventListener('keydown', onKey, true);

  /** Copy all and the CSV add the cube's form of each match after Applies to. */
  const outCols = (): ColId[] => cols.flatMap((c): ColId[] => (c === 'applies' ? ['applies', 'match'] : [c]));
  copyAll.addEventListener('click', () => {
    const rows = shownRows.filter((r) => r.kind !== 'group');
    const oc = outCols();
    const body = outValues(tableValues(rows, oc, shownKeys(), names)).map((line) => line.map(clipValue));
    copyText(tsvOf(oc.map((c) => asciiText(labelOf(c))), body), () => { statusNote = t('route.mg.copiedAll', { rows: rows.length }); updateStatus(); });
  });
  csv.addEventListener('click', () => {
    const oc = outCols();
    const labels = oc.map((c) => asciiText(labelOf(c)));
    const rows = shownRows.filter((r) => r.kind !== 'group');
    const records = outValues(tableValues(rows, oc, shownKeys(), names)).map((line) => Object.fromEntries(line.map((v, i) => [labels[i], v])));
    downloadFile('\uFEFF' + toCsv(records, labels, asciiText(preset.attribution)), `${preset.id}-method.csv`, 'text/csv');  // BOM: Excel reads UTF-8
  });

  return {
    setPatch(p) { patch = p; setAlert(''); refresh(); },
    setRegionM(m) { crossed = m; markCrossed(); },
    setHighlight(next, on) {
      const same = on === enabled && next.length === picks.length && next.every((p, i) => pickKey(p) === pickKey(picks[i]) && p.slot === picks[i].slot);
      picks = next.map((p) => ({ ...p }));
      enabled = on;
      if (!same) refresh();
    },
    destroy() {
      dead = true;
      fitObs?.disconnect();
      gridEl.removeEventListener('keydown', onKey, true);
      g.destroy();
      el.replaceChildren();
    },
  };
}
