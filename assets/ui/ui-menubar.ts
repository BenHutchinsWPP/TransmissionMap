// ─── Menubar + color-picker wiring ────────────────────────────────────────────
// File/Tools/Add menu dropdowns (File holds the Open ▸ / Save ▸ submenus, which
// open on hover, click and →, close on ← and Esc, and flip left at the screen
// edge), the Undo / Redo icon buttons, view/edit mode buttons, draw color-picker
// menus, and the file-open input. On a phone the Undo / Redo buttons give way to
// File menu items of the same actions. onMenubarClick is a single delegated document
// click handler dispatching to the right action. The Undo / Redo buttons and
// their keys (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y — onUndoKey) step the view history.
// Deps: state.js, map-input.js (close menus on a map tap),
// undo.js (undo/redo, canUndo/canRedo for the items' disabled state),
// user-data-colors.js (static — lightweight, needed at wire time).
// draw-chunk.js (lazy — MapboxDraw/toGeoJSON/jszip loaded on first interaction).
// ui-diagnostics.js (lazy — Diagnostics dialog + probe catalogue, loaded on
// first Tools > Diagnostics… click). ui-settings.js (lazy — Settings dialog,
// loaded on first File > Settings… click). ui-experiences.js (lazy — Map
// Experiences gallery + story card, loaded on first File > Experiences… click).
// ui-chat.js (lazy — the map chat, the table drawer's Ask tab, loaded on first
// Tools > Ask the map… click, or by wireSessionRestore after a reload of this
// tab when the drawer was saved with Ask open). table-open.js (restoreDrawer:
// the table chunk, imported by wireSessionRestore only for a restorable
// `tm-drawer` snapshot — session-snapshot.ts; with none nothing is imported,
// and a closed chat's `tm-chat` restores when the visitor next opens it).
// templates-open.js (openVisualize — Tools > Visualize…, the ui-templates.js lazy
// chunk; resumeVisualize — the boot hook's resumeViz for a drawer saved with
// Visualize open). proximity-open.js (openProximity — Tools > Proximity, the
// ui-proximity.js lazy chunk). ui-services.js (lazy — the Add layer from a
// service dialog, loaded on first File > Open > GIS server… click).
// src/i18n/index.js (t), state-bus.js (on 'lang:changed', 'undo:changed').
// Consumed by ui.ts (wireUI).

import { state } from '../state.js';
import { colorPickerInner } from '../user-data/user-data-colors.js';
import { t } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';
import { onMapTap } from '../map-input.js';
import { undo, redo, canUndo, canRedo } from '../undo.js';
import { hasSnapshot, clearSnapshot, restampSnapshot, onHidden } from '../session-snapshot.js';
import { restoreDrawer } from './table-open.js';
import { openVisualize, resumeVisualize } from './templates-open.js';
import { openProximity } from './proximity-open.js';

const DATA_ACCEPT = '.geojson,.json,.kml,.kmz,.csv';
const VIEW_ACCEPT = '.json';

// ─── Lazy draw chunk ──────────────────────────────────────────────────────────
type DrawChunk = typeof import('../user-data/draw-chunk.js');
let _chunk: DrawChunk | null = null;

async function draw(): Promise<DrawChunk> {
  if (!_chunk) {
    _chunk = await import('../user-data/draw-chunk.js');
    _chunk.initDraw();
  }
  return _chunk;
}

export function positionColorMenu(menu: HTMLElement, swatch: HTMLElement) {
  const rect = swatch.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.zIndex = '1000';

  const menuWidth = menu.offsetWidth || 103;
  const menuHeight = menu.offsetHeight || 92;

  const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

  let left = rect.left;
  if (left + menuWidth > winWidth - 8) {
    left = Math.max(8, winWidth - menuWidth - 8);
  }
  if (left < 8) left = 8;
  menu.style.left = `${left}px`;
  menu.style.right = 'auto';

  let top = rect.bottom + 5;
  if (top + menuHeight > winHeight - 8 && rect.top - 5 - menuHeight >= 0) {
    top = rect.top - 5 - menuHeight;
  }
  menu.style.top = `${top}px`;
  menu.style.bottom = 'auto';
}

// ─── Event handlers ───────────────────────────────────────────────────────────
async function onMenubarClick(e: MouseEvent) {
  const target = e.target as Element;
  // Only File/Add open dropdowns (aria-haspopup). The Measure button also
  // carries .menu-btn for styling but toggles a tool, not a menu — matching it
  // here would hide its nextElementSibling (the Add menu-wrap) by mistake.
  const stepBtn = target?.closest<HTMLElement>('.tb-btn[data-action]');
  if (stepBtn) {
    closeMenus();
    if (stepBtn.dataset.action === 'undo') undo(); else redo();
    return;
  }

  const subBtn = target?.closest<HTMLElement>('.menu-sub-btn');
  if (subBtn) {
    e.stopPropagation();
    const sub = subBtn.parentElement!;
    // A mouse has already opened it by hovering, so its click keeps it open.
    const mouse = (e as PointerEvent).pointerType === 'mouse';
    if (!mouse && subBtn.getAttribute('aria-expanded') === 'true') closeSub(sub); else openSub(sub);
    return;
  }

  const menuBtn = target?.closest<HTMLElement>('.menu-btn[aria-haspopup="true"]');
  if (menuBtn) {
    e.stopPropagation();
    const dropdown = menuBtn.nextElementSibling as HTMLElement | null;
    if (dropdown) {
      document.querySelectorAll<HTMLElement>('.menu-dropdown:not([hidden])').forEach(m => {
        if (m !== dropdown) { m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); }
      });
      const open = !dropdown.hidden;
      if (open) closeMenus(); else { dropdown.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); }
    }
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
    return;
  }

  const menuItem = target?.closest<HTMLElement>('.menu-item[data-action]');
  if (menuItem) {
    const wrapBtn = menuItem.closest('.menu-wrap')?.querySelector<HTMLElement>('.menu-btn');
    closeMenus();
    // Handled before draw(): a display toggle must not pull in the draw chunk.
    // The class hides the container independently of the `hidden` attribute the
    // legend renderer manages, so re-renders can't undo the user's choice.
    if (menuItem.dataset.action === 'toggle-legends') {
      const lc = document.getElementById('legendContainer');
      const off = lc?.classList.toggle('legends-off') ?? false;
      menuItem.textContent = off ? t('menu.showLegends') : t('menu.hideLegends');
      menuItem.setAttribute('data-i18n', off ? 'menu.showLegends' : 'menu.hideLegends');
      return;
    }
    // Same reasoning as toggle-legends above: Diagnostics is its own lazy
    // chunk (ui-diagnostics.js) and must not drag in the draw chunk either.
    if (menuItem.dataset.action === 'open-diagnostics') {
      const m = await import('./ui-diagnostics.js');
      m.openDiagnostics();
      return;
    }
    // Same reasoning again: Map Experiences is its own lazy chunk
    // (ui-experiences.js — the catalogue and the story controller) and must not
    // drag in the draw chunk either.
    if (menuItem.dataset.action === 'open-experiences') {
      const m = await import('./ui-experiences.js');
      m.openExperiences();
      return;
    }
    // Same reasoning again: the service dialog is its own lazy chunk
    // (ui-services.js) and must not drag in the draw chunk either.
    if (menuItem.dataset.action === 'open-services') {
      const m = await import('./ui-services.js');
      m.openServices();
      return;
    }
    // Same reasoning again: Settings is its own lazy chunk (ui-settings.js)
    // and must not drag in the draw chunk either.
    if (menuItem.dataset.action === 'open-settings') {
      const m = await import('./ui-settings.js');
      m.openSettings();
      return;
    }
    // The map chat is its own lazy chunk (ui-chat.js, with the agent and the
    // table drawer it docks in).
    if (menuItem.dataset.action === 'open-chat') {
      const m = await import('./ui-chat.js');
      // The item hides with its menu, so focus returns to the Tools button.
      m.openChat(wrapBtn);
      return;
    }
    // The Visualize pane is its own lazy chunk (ui-templates.js, through templates-open.js).
    if (menuItem.dataset.action === 'open-visualize') {
      void openVisualize(undefined, wrapBtn);
      return;
    }
    // The Proximity pane is its own lazy chunk (ui-proximity.js, through proximity-open.js).
    if (menuItem.dataset.action === 'open-proximity') {
      void openProximity(wrapBtn);
      return;
    }
    // The picker opens straight from the click (before any chunk loads); the
    // view file and the data file share one input, told apart by its filter.
    if (menuItem.dataset.action === 'open-view-file' || menuItem.dataset.action === 'file-open') {
      const input = document.getElementById('fileOpenInput') as HTMLInputElement | null;
      if (input) {
        input.accept = menuItem.dataset.action === 'file-open' ? DATA_ACCEPT : VIEW_ACCEPT;
        input.click();
      }
      return;
    }
    if (menuItem.dataset.action === 'undo') { undo(); return; }
    if (menuItem.dataset.action === 'redo') { redo(); return; }
    const d = await draw();
    switch (menuItem.dataset.action) {
      case 'save-geojson': d.saveGeoJSON(); break;
      case 'save-kml':     d.saveKML(); break;
      case 'save-view':    d.saveView(); break;
      case 'add-point':    d.startDraw('draw_point'); break;
      case 'add-line':     d.startDraw('draw_line_string'); break;
      case 'add-polygon':  d.startDraw('draw_polygon'); break;
    }
    return;
  }

  const modeBtn = target?.closest<HTMLElement>('.mode-btn[data-mode]');
  if (modeBtn) { (await draw()).setMode(modeBtn.dataset.mode!); return; }

  const swatch = target?.closest<HTMLElement>('.color-swatch-btn');
  if (swatch) {
    e.stopPropagation();
    const menu = swatch.nextElementSibling as HTMLElement | null;
    if (menu) {
      const wasOpen = !menu.hidden;
      document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
      menu.hidden = wasOpen;
      if (!wasOpen) {
        positionColorMenu(menu, swatch);
      }
    }
    return;
  }

  const colorOpt = target?.closest<HTMLElement>('.color-opt[data-color]');
  if (colorOpt) {
    (await draw()).applyColorPick(colorOpt.closest<HTMLElement>('.color-picker')!, colorOpt.dataset.color!);
    const colorMenu = colorOpt.closest<HTMLElement>('.color-menu');
    if (colorMenu) colorMenu.hidden = true;
    return;
  }

  if (target?.closest('.color-menu')) return;

  closeMenus();
}

// Dismissing an open menu by going back to the map is a map tap, not a document
// click — the two paths below feed this the same way.
function closeMenus() {
  document.querySelectorAll<HTMLElement>('.menu-dropdown:not([hidden])').forEach(m => {
    m.hidden = true;
    m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll<HTMLElement>('.menu-sub').forEach(closeSub);
  document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
}

// ─── Submenus (Open ▸, Save ▸) ─────────────────────────────────────────────────
const subBtnOf = (sub: Element) => sub.querySelector<HTMLElement>(':scope > .menu-sub-btn');
const subMenuOf = (sub: Element) => sub.querySelector<HTMLElement>(':scope > .menu-submenu');

function closeSub(sub: Element) {
  sub.querySelectorAll<HTMLElement>('.menu-submenu').forEach(m => { m.hidden = true; m.classList.remove('menu-submenu--left'); });
  sub.querySelectorAll('.menu-sub-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function openSub(sub: Element, focusFirst = false) {
  // One submenu per level.
  sub.parentElement?.querySelectorAll(':scope > .menu-sub').forEach(o => { if (o !== sub) closeSub(o); });
  const menu = subMenuOf(sub);
  if (!menu) return;
  menu.hidden = false;
  subBtnOf(sub)?.setAttribute('aria-expanded', 'true');
  // Flip to the left of its parent when it would leave the screen.
  menu.classList.remove('menu-submenu--left');
  if (menu.getBoundingClientRect().right > window.innerWidth - 8) menu.classList.add('menu-submenu--left');
  if (focusFirst) menuItems(menu)[0]?.focus();
}

// The focusable entries of one menu level: its own items and its submenu buttons.
function menuItems(menu: Element): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(':scope > .menu-item, :scope > .menu-sub > .menu-sub-btn')]
    .filter(el => !(el as HTMLButtonElement).disabled);
}

function onMenuKey(e: KeyboardEvent) {
  const t0 = e.target instanceof Element ? e.target : null;
  const topBtn = t0?.closest<HTMLElement>('.menu-wrap > .menu-btn[aria-haspopup="true"]');
  const level = t0?.closest<HTMLElement>('.menu-submenu, .menu-dropdown');
  if (e.key === 'Escape') {
    const open = document.querySelector('.menu-dropdown:not([hidden])');
    if (!open) return;
    const btn = open.previousElementSibling as HTMLElement | null;
    const inside = open.contains(document.activeElement);
    closeMenus();
    if (inside || document.activeElement === btn) btn?.focus();
    return;
  }
  if (topBtn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const dd = topBtn.nextElementSibling as HTMLElement | null;
    if (!dd) return;
    e.preventDefault();
    if (dd.hidden) { closeMenus(); dd.hidden = false; topBtn.setAttribute('aria-expanded', 'true'); }
    const items = menuItems(dd);
    (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
    return;
  }
  if (!t0 || !level) return;
  const cur = t0.closest<HTMLElement>('.menu-item');
  if (!cur) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = menuItems(level);
    const i = items.indexOf(cur);
    const n = items.length;
    items[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
  } else if (e.key === 'ArrowRight' && cur.classList.contains('menu-sub-btn')) {
    e.preventDefault();
    openSub(cur.parentElement!, true);
  } else if (e.key === 'ArrowLeft' && level.classList.contains('menu-submenu')) {
    e.preventDefault();
    const sub = level.parentElement!;
    closeSub(sub);
    subBtnOf(sub)?.focus();
  }
}

function syncUndoItems() {
  const set = (action: string, enabled: boolean, label: string, keys: string) => {
    document.querySelectorAll<HTMLButtonElement>(`.tb-btn[data-action="${action}"]`).forEach(btn => {
      btn.setAttribute('aria-label', label);
      btn.title = `${label} (${keys})`;
    });
    document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`).forEach(btn => { btn.disabled = !enabled; });
  };
  set('undo', canUndo(), t('menu.undo'), 'Ctrl+Z');
  set('redo', canRedo(), t('menu.redo'), 'Ctrl+Shift+Z');
}

// Left to the browser while typing, in a dialog, drawing or measuring — there
// the keys belong to the field or the tool, not to the view history.
// Inputs that keep their own Ctrl+Z; a focused checkbox, radio, range or
// select does not, so the key steps the view.
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  if (el.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

function onUndoKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // A non-Latin layout reports its own character in e.key; e.code is the physical key.
  const key = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase()
    : e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : '';
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.shiftKey);
  if (!isUndo && !isRedo) return;
  if (isTextEntry(e.target)) return;
  if (document.querySelector('dialog[open]')) return;
  if (state.editMode !== 'view' || state.measure.active) return;
  e.preventDefault();
  if (isUndo) undo(); else redo();
}

export function wireMenubar() {
  const fileInput = document.getElementById('fileOpenInput') as HTMLInputElement | null;
  if (fileInput) fileInput.addEventListener('change', async e => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.[0]) (await draw()).handleFileOpen(files[0]);
    fileInput.value = '';
  });

  document.addEventListener('click', onMenubarClick);
  onMapTap(closeMenus);

  window.addEventListener('scroll', () => {
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
  }, { passive: true });

  document.addEventListener('keydown', onUndoKey);
  syncUndoItems();

  document.addEventListener('keydown', onMenuKey);
  // Submenus also open on hover (mouse only; touch and keys use click and →).
  document.querySelectorAll<HTMLElement>('.menu-sub').forEach(sub => {
    sub.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') openSub(sub); });
    sub.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') closeSub(sub); });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
    }
  });

  document.addEventListener('input', async e => {
    const inp = (e.target as Element)?.closest<HTMLInputElement>('.color-custom[type=color]');
    if (!inp) return;
    (await draw()).applyColorPick(inp.closest<HTMLElement>('.color-picker')!, inp.value);
  });

  const drawColor = document.getElementById('drawColorPicker');
  if (drawColor) drawColor.innerHTML = colorPickerInner(state.drawDefaultColor);
  wireSessionRestore();
}

// The tab's snapshots: tm-drawer (the layout and the table, owned by
// ui-table.ts) and tm-chat (the conversation, owned by ui-chat.ts). One that may
// not restore here (a fresh link in the tab, another view) is removed; one that
// may is kept current with the link while its chunk is unloaded. A restorable
// drawer is rebuilt once the map is ready (the table needs the layers): the chat
// first when Ask was open, then Visualize when it was, then the table and the
// pane in view.
const SNAPSHOTS = ['tm-chat', 'tm-drawer'];
function wireSessionRestore() {
  for (const key of SNAPSHOTS) {
    if (!hasSnapshot(key)) clearSnapshot(key);
    else onHidden(() => restampSnapshot(key));
  }
  if (!hasSnapshot('tm-drawer')) return;
  let done = false;
  on('map:ready', () => {
    if (done) return;
    done = true;
    void restoreDrawer(() => import('./ui-chat.js').then(m => m.resumeChat()), resumeVisualize)
      .catch(() => { /* the drawer opens from its buttons as usual */ });
  });
}

on('undo:changed', syncUndoItems);

on('lang:changed', () => {
  syncUndoItems();
  const menuItem = document.querySelector<HTMLElement>('.menu-item[data-action="toggle-legends"]');
  if (menuItem) {
    const lc = document.getElementById('legendContainer');
    const off = lc?.classList.contains('legends-off') ?? false;
    menuItem.textContent = off ? t('menu.showLegends') : t('menu.hideLegends');
    menuItem.setAttribute('data-i18n', off ? 'menu.showLegends' : 'menu.hideLegends');
  }
});
