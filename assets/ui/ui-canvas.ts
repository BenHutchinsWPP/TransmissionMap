// ─── Chat canvas card: a model's page or Vega chart in a sandboxed frame ─────
// Role: canvasCard(title, req, opts?) → {el, done}: the card ui-chat.ts puts in
//       the conversation for a canvas/vega render (DispatchOpts.render). It
//       holds a page-drawn label ("Made by the model · runs in a sandbox") and
//       border, so the frame never reads as the app's own UI — or, given
//       opts.template (a page-owned template from assets/templates/), "TransmissionMap
//       template", with the frame tagged as a template frame (runCanvas
//       {template: true}: an html one resolves on TM.drawn(), its actions
//       reach opts.onAction, and a vega one gets opts.signals). The card is
//       scrolled into view before the frame starts, since a frame outside the
//       viewport gets no animation frames. The title is model text, set as
//       textContent. Nothing is saved without a click on a page-owned "Save
//       <name>" button, except a download canvas-host.ts marks `requested` (a
//       vega PNG the card asked for, or a template frame's one file per visitor
//       gesture, canvas-host.ts frameGesture). A vega card may also offer a CSV
//       (page-built from the injected rows) and a Table toggle (text only,
//       ≤ TABLE_MAX rows). opts.partial layers get a "loaded tiles only"
//       note; × removes the card and disposes its frame. Given opts.overlay (the
//       county overlay its template painted, county-overlay.ts), the header
//       offers "Clear map colours" while that overlay is current, and × clears
//       it too (ownCountyOverlay). A frame evicted (more than MAX_LIVE) or
//       closed with the chat leaves "Canvas closed to save memory" and Re-run
//       (a template card with opts.rerun drops its payload and re-runs through
//       showTemplate with the caller's {templateId, layer, params}); a frame
//       that navigates leaves a notice. Re-run uses the card's own
//       AbortController, since the turn's signal may already be aborted. `done`
//       is the first run's outcome.
//         closeAllCanvases()   the chat closing: every live frame removed.
//         claimRestoreSlots(n) / releaseRestoreSlot()   the free frame slots a
//                    restore may redraw into (chat and Visualize share them; ≤
//                    MAX_LIVE less the live frames, so a restore never evicts).
//       Everything is built with services-dom.ts el() as text; eslint holds
//       this file to the chat's text-only rule. Strings carry data-chat-key, so
//       ui-chat.ts's lang:changed handler re-translates them.
//
// Deps: sandbox/canvas-host.ts (runCanvas, requestPng, disposeAllCanvases,
//       liveCanvases, MAX_LIVE), county-overlay.ts (clearCountyOverlay,
//       countyOverlayHeld, countyOverlayToken, onCountyOverlay, ownCountyOverlay),
//       services-dom.ts (el), user-data-export.ts (downloadFile), ui-chart.ts
//       (fileName), i18n (t).
// Loaded by: ui-chat.ts (dynamic import, chat chunk).

import { runCanvas, requestPng, disposeAllCanvases, liveCanvases, MAX_LIVE, type CanvasRequest, type CanvasOutcome,
  type CanvasDownload, type CanvasError, type CanvasHandle, type CanvasOptions, type TemplateAction, type FrameControl } from '../sandbox/canvas-host.js';
import { el } from './services-dom.js';
import { clearCountyOverlay, countyOverlayHeld, countyOverlayToken, onCountyOverlay, ownCountyOverlay } from '../county-overlay.js';
import { downloadFile } from '../user-data/user-data-export.js';
import { fileName } from './ui-chart.js';
import { t } from '../../src/i18n/index.js';

export interface CanvasCardOptions {
  signal?: AbortSignal;
  /** A vega card's CSV, built by page code from the rows it injected (never by the frame). */
  csv?: () => string;
  /** Titles of the layers in TM_INPUT read only in part: one note each under the frame. */
  partial?: string[];
  /** A page-owned template's card: its label, a template frame and (for html) its actions. */
  template?: boolean;
  /** A template frame's action (kind checked by canvas-host.ts, payload unchecked). */
  onAction?: CanvasOptions['onAction'];
  /** A vega template frame's signal bridge (canvas-host.ts sends it to template frames only). */
  signals?: CanvasOptions['signals'];
  /** A vega template's injected rows with their column headings, for the Table toggle. */
  table?: CardTable;
  /** A template card's Re-run from its {templateId, layer, params} (showTemplate; the caller
   *  swaps `card` for the new one): resolves null when shown, else the reason for the visitor.
   *  Given it, an evicted or closed frame drops the card's payload, CSV and table. */
  rerun?: (card: HTMLElement) => Promise<string | null>;
  /** The county overlay the card's template painted (county-overlay.ts token). */
  overlay?: number;
}

/** Rows as the page injected them, with [key, heading] columns in order; cells set as text. */
export interface CardTable { columns: [string, string][]; rows: readonly Record<string, unknown>[] }

export const TABLE_MAX = 1000;

const DEFAULT_HEIGHT = 320;
/** A page-owned template's frame: room for its widget row, legend and a map without scrolling. */
const TEMPLATE_HEIGHT = 420;

function keyed<K extends keyof HTMLElementTagNameMap>(tag: K, key: string, attrs: Record<string, string> = {}, params?: Record<string, string>) {
  const e = el(tag, attrs);
  e.dataset.chatKey = key;
  if (params) e.dataset.chatParams = JSON.stringify(params);
  e.textContent = t(key, params);
  return e;
}

const button = (key: string, cls: string, params?: Record<string, string>) =>
  keyed('button', key, { type: 'button', class: `td-btn ${cls}` }, params);

const save = (d: CanvasDownload) => downloadFile(d.data, d.name, d.mime);

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString(document.documentElement.lang || undefined, { maximumFractionDigits: 2 });
  return Array.isArray(v) ? v.join('; ') : String(v);
}

/** The rows as a text-only table, at most TABLE_MAX of them, with a note when cut. */
function tableOf(title: string, tb: CardTable): HTMLElement {
  const n = Math.min(tb.rows.length, TABLE_MAX);
  const head = el('tr', {}, ...tb.columns.map(([, h]) => el('th', { scope: 'col' }, h)));
  const body = el('tbody', {}, ...tb.rows.slice(0, n).map(r => el('tr', {}, ...tb.columns.map(([k]) =>
    el('td', typeof r[k] === 'number' ? { class: 'num' } : {}, cellText(r[k]))))));
  const wrap = el('div', { class: 'chat-canvas-table-wrap', tabindex: '0' },
    el('table', { class: 'chat-canvas-table', 'aria-label': title }, el('thead', {}, head), body));
  return el('div', { class: 'chat-canvas-table-box' }, wrap,
    ...(tb.rows.length > n ? [keyed('p', 'canvas.tableCapped', { class: 'chat-canvas-partial' }, { shown: n.toLocaleString(), total: tb.rows.length.toLocaleString() })] : []));
}

// ─── Restore budget ──────────────────────────────────────────────────────────
let claimed = 0;
/** Free frame slots for restored cards' automatic redraws, shared by the chat and
 *  Visualize: up to `n`, never more than MAX_LIVE less the live frames and the
 *  slots already claimed, so a restore never evicts a frame. Each granted slot is
 *  given back with releaseRestoreSlot() once its redraw settles. */
export function claimRestoreSlots(n: number): number {
  const k = Math.max(0, Math.min(n, MAX_LIVE - liveCanvases() - claimed));
  claimed += k;
  return k;
}
export function releaseRestoreSlot(): void { if (claimed > 0) claimed--; }

export function canvasCard(title: string, original: CanvasRequest, opts: CanvasCardOptions = {}): { el: HTMLElement; done: Promise<CanvasOutcome> } {
  // What the card holds to run its frame again; a template card with `rerun` lets go of it when the frame closes.
  let req: CanvasRequest | null = original;
  let csv = opts.csv ?? null;
  let table = opts.table ?? null;
  // Closures read these, never `opts`, so a released card holds no payload through it.
  const { template, signals, rerun } = opts;
  let onAction = opts.onAction;
  const box = el('div', { class: 'chat-canvas-box' });
  const errors = el('div', { class: 'chat-canvas-errors', role: 'status' });
  const actions = el('div', { class: 'chat-chart-actions chat-canvas-actions' });
  const expand = button('canvas.expand', 'chat-canvas-expand');
  expand.setAttribute('aria-expanded', 'false');
  const close = el('button', { type: 'button', class: 'td-icon chat-canvas-close', 'data-i18n-aria-label': 'canvas.close',
    'data-i18n-title': 'canvas.close', 'aria-label': t('canvas.close'), title: t('canvas.close') }, '×');
  const label = opts.template ? 'canvas.template' : 'canvas.label';
  const head = el('div', { class: 'chat-canvas-head' },
    keyed('span', label, { class: 'chat-canvas-label' }), actions, expand, close);
  const notes = (opts.partial ?? []).map(layer => keyed('p', 'canvas.partial', { class: 'chat-canvas-partial' }, { layer }));
  const tableBox = el('div', { class: 'chat-canvas-table-slot' });
  tableBox.hidden = true;
  const card = el('figure', { class: 'chat-canvas', 'data-kind': original.kind, ...(opts.template && { 'data-template': '' }) },
    head, el('figcaption', { class: 'chat-canvas-title' }, title), box, tableBox, ...notes, errors);

  let handle: CanvasHandle | null = null;
  const base = original.height ?? (opts.template ? TEMPLATE_HEIGHT : DEFAULT_HEIGHT);
  const height = () => {
    if (card.dataset.expanded === undefined) return base;
    // The drawer's height, or 70 % of the window when the drawer is shorter than that.
    const drawer = card.closest<HTMLElement>('.table-drawer')?.clientHeight ?? 0;
    const room = Math.max(drawer, Math.round(window.innerHeight * 0.7)) - head.offsetHeight - 48;
    return Math.max(base, room);
  };
  const size = () => { if (handle) handle.frame.style.height = `${height()}px`; };

  expand.addEventListener('click', () => {
    const open = card.dataset.expanded === undefined;
    if (open) card.dataset.expanded = ''; else delete card.dataset.expanded;
    expand.dataset.chatKey = open ? 'canvas.collapse' : 'canvas.expand';
    expand.textContent = t(expand.dataset.chatKey);
    expand.setAttribute('aria-expanded', String(open));
    size();
    if (open) card.scrollIntoView({ block: 'nearest' });
  });

  const showError = (e: { error: CanvasError; message?: string }) => {
    if (e.error === 'runtime' && e.message === 'navigated') return;
    errors.append(el('p', { class: 'chat-canvas-error' },
      keyed('span', `canvas.error.${e.error}`), ...(e.message ? [' ', el('span', {}, e.message)] : [])));
  };

  let png: HTMLButtonElement | null = null;
  let csvBtn: HTMLButtonElement | null = null;
  let tableBtn: HTMLButtonElement | null = null;
  // The turn's signal covers the first run; a Re-run (possibly after Stop) has its own, aborted with the card.
  const own = new AbortController();
  const start = (signal?: AbortSignal): Promise<CanvasOutcome> => {
    if (!req) return Promise.resolve({ error: 'unavailable' });
    const kind = req.kind;
    box.replaceChildren();
    errors.replaceChildren();
    // The caller appends the card after this returns; the frame posts `ready` later still.
    if (template) queueMicrotask(() => { if (card.isConnected) card.scrollIntoView?.({ block: 'nearest' }); });
    const run = runCanvas(box, req, {
      signal,
      ...(template && { template: true, onAction: (a: TemplateAction, f: FrameControl) => onAction?.(a, f), signals }),
      onError: showError,
      onDownload: d => {
        if (d.requested) { save(kind === 'vega' && d.mime === 'image/png' ? { ...d, name: fileName(title, 'png') } : d); return; }
        const b = button('canvas.save', 'chat-canvas-save', { name: d.name });
        b.addEventListener('click', () => save(d));
        actions.append(b);
        if (template) b.focus({ preventScroll: true });
      },
      onClosed: why => {
        if (png) png.disabled = true;
        if (why === 'navigated') { box.replaceChildren(keyed('p', 'canvas.navigated', { class: 'chat-canvas-closed' })); return; }
        const again = button('canvas.rerun', 'chat-canvas-rerun');
        if (rerun) {
          release();
          again.addEventListener('click', () => {
            again.disabled = true;
            errors.replaceChildren();
            void rerun(card).then(reason => {
              if (!card.isConnected) { dropOverlay(); return; }
              if (reason === null) return;
              errors.append(el('p', { class: 'chat-canvas-error' }, reason));
              again.disabled = false;
            });
          });
        } else again.addEventListener('click', () => { void start(own.signal); });
        box.replaceChildren(el('p', { class: 'chat-canvas-closed' }, keyed('span', 'canvas.closed'), ' ', again));
      },
    });
    handle = run.handle;
    handle.frame.title = t(label);
    size();
    if (png) png.disabled = false;
    void run.then(o => {
      if ('error' in o) showError(o);
      if (kind === 'vega') for (const b of [png, csvBtn, tableBtn]) if (b) b.hidden = 'error' in o;
    });
    return run;
  };

  /** A template card's frame is gone: keep only what `rerun` needs (the caller's params), no payload, CSV or rows. */
  const release = () => {
    req = null; csv = null; table = null; handle = null; onAction = undefined;
    tableBox.replaceChildren();
    tableBox.hidden = true;
    for (const b of [png, csvBtn, tableBtn]) b?.remove();
    png = csvBtn = tableBtn = null;
  };

  // The map colours this card painted: Clear while they are the current overlay; × clears them too.
  let overlayOff: (() => void) | null = null;
  const overlay = opts.overlay;
  /** The card is gone: its overlay goes (current or held) and it stops listening. */
  const dropOverlay = () => {
    if (overlay !== undefined) clearCountyOverlay(overlay);
    overlayOff?.();
    overlayOff = null;
  };
  if (overlay !== undefined) {
    ownCountyOverlay(overlay, () => card.isConnected);
    const clear = button('template.overlay.clear', 'chat-canvas-clear');
    clear.addEventListener('click', () => { clearCountyOverlay(overlay); });
    const sync = () => {
      clear.hidden = countyOverlayToken() !== overlay;
      if (!countyOverlayHeld(overlay)) { overlayOff?.(); overlayOff = null; }
    };
    overlayOff = onCountyOverlay(sync);
    sync();
    actions.append(clear);
  }

  // × removes the card and its frame (a run still starting answers 'unavailable').
  close.addEventListener('click', () => {
    own.abort(); handle?.close(); card.remove(); if (rerun) release();
    dropOverlay();
  });

  if (original.kind === 'vega') {
    png = button('chart.png', 'chat-canvas-png');
    png.addEventListener('click', () => { if (handle) requestPng(handle); });
    actions.append(png);
  }
  if (csv) {
    csvBtn = button('chart.csv', 'chat-canvas-csv');
    csvBtn.addEventListener('click', () => { if (csv) downloadFile(csv(), fileName(title, 'csv'), 'text/csv;charset=utf-8'); });
    actions.append(csvBtn);
  }
  if (table && original.kind === 'vega') {
    tableBtn = button('template.table', 'chat-canvas-table-btn');
    tableBtn.setAttribute('aria-pressed', 'false');
    tableBtn.addEventListener('click', () => {
      const on = tableBox.hidden;
      if (!table) return;
      if (on && !tableBox.firstChild) tableBox.append(tableOf(title, table));
      tableBox.hidden = !on;
      tableBtn!.setAttribute('aria-pressed', String(on));
    });
    actions.append(tableBtn);
  }
  const done = start(opts.signal);
  return { el: card, done };
}

/** The chat closing: remove every live frame (each card offers Re-run). */
export function closeAllCanvases(): void { disposeAllCanvases(); }
