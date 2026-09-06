// ─── Menubar + color-picker wiring ────────────────────────────────────────────
// File/Add/Save menu dropdowns, view/edit mode buttons, draw color-picker menus,
// and the file-open input. onMenubarClick is a single delegated document click
// handler dispatching to the right action.
// Deps: state.js, user-data-colors.js (static — lightweight, needed at wire time).
// draw-chunk.js (lazy — MapboxDraw/toGeoJSON/jszip loaded on first interaction).
// ui-diagnostics.js (lazy — Diagnostics dialog + probe catalogue, loaded on
// first File > Diagnostics… click). ui-settings.js (lazy — Settings dialog,
// loaded on first File > Settings… click). ui-experiences.js (lazy — Map
// Experiences gallery + story card, loaded on first File > Experiences… click).
// src/i18n/index.js (t), state-bus.js (on).
// Consumed by ui.ts (wireUI).

import { state } from '../state.js';
import { colorPickerInner } from '../user-data/user-data-colors.js';
import { t } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';

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
  const menuBtn = target?.closest<HTMLElement>('.menu-btn[aria-haspopup="true"]');
  if (menuBtn) {
    e.stopPropagation();
    const dropdown = menuBtn.nextElementSibling as HTMLElement | null;
    if (dropdown) {
      document.querySelectorAll<HTMLElement>('.menu-dropdown:not([hidden])').forEach(m => {
        if (m !== dropdown) { m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); }
      });
      const open = !dropdown.hidden;
      dropdown.hidden = open;
      menuBtn.setAttribute('aria-expanded', String(!open));
    }
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
    return;
  }

  const menuItem = target?.closest<HTMLElement>('.menu-item[data-action]');
  if (menuItem) {
    menuItem.closest('.menu-dropdown')?.setAttribute('hidden', '');
    menuItem.closest('.menu-dropdown')?.previousElementSibling?.setAttribute('aria-expanded', 'false');
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
    // Same reasoning again: Settings is its own lazy chunk (ui-settings.js)
    // and must not drag in the draw chunk either.
    if (menuItem.dataset.action === 'open-settings') {
      const m = await import('./ui-settings.js');
      m.openSettings();
      return;
    }
    const d = await draw();
    switch (menuItem.dataset.action) {
      case 'file-open':    document.getElementById('fileOpenInput')?.click(); break;
      case 'save-geojson': d.saveGeoJSON(); break;
      case 'save-kml':     d.saveKML(); break;
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

  document.querySelectorAll<HTMLElement>('.menu-dropdown:not([hidden])').forEach(m => {
    m.hidden = true;
    m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
}

export function wireMenubar() {
  const fileInput = document.getElementById('fileOpenInput') as HTMLInputElement | null;
  if (fileInput) fileInput.addEventListener('change', async e => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.[0]) (await draw()).handleFileOpen(files[0]);
    fileInput.value = '';
  });

  document.addEventListener('click', onMenubarClick);

  window.addEventListener('scroll', () => {
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
  }, { passive: true });

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
}

on('lang:changed', () => {
  const menuItem = document.querySelector<HTMLElement>('.menu-item[data-action="toggle-legends"]');
  if (menuItem) {
    const lc = document.getElementById('legendContainer');
    const off = lc?.classList.contains('legends-off') ?? false;
    menuItem.textContent = off ? t('menu.showLegends') : t('menu.hideLegends');
    menuItem.setAttribute('data-i18n', off ? 'menu.showLegends' : 'menu.hideLegends');
  }
});
