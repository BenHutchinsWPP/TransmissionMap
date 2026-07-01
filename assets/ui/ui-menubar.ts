// ─── Menubar + color-picker wiring ────────────────────────────────────────────
// File/Add/Save menu dropdowns, view/edit mode buttons, draw color-picker menus,
// and the file-open input. onMenubarClick is a single delegated document click
// handler dispatching to the right action.
// Deps: state.js, user-data-colors.js (static — lightweight, needed at wire time).
// draw-chunk.js (lazy — MapboxDraw/toGeoJSON/jszip loaded on first interaction).
// Consumed by ui.ts (wireUI).

import { state } from '../state.js';
import { colorPickerInner } from '../user-data/user-data-colors.js';

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

// ─── Event handlers ───────────────────────────────────────────────────────────
async function onMenubarClick(e: MouseEvent) {
  const t = e.target as Element;
  const menuBtn = t?.closest<HTMLElement>('.menu-btn');
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

  const menuItem = t?.closest<HTMLElement>('.menu-item[data-action]');
  if (menuItem) {
    menuItem.closest('.menu-dropdown')?.setAttribute('hidden', '');
    menuItem.closest('.menu-dropdown')?.previousElementSibling?.setAttribute('aria-expanded', 'false');
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

  const modeBtn = t?.closest<HTMLElement>('.mode-btn[data-mode]');
  if (modeBtn) { (await draw()).setMode(modeBtn.dataset.mode!); return; }

  const swatch = t?.closest<HTMLElement>('.color-swatch-btn');
  if (swatch) {
    e.stopPropagation();
    const menu = swatch.nextElementSibling as HTMLElement | null;
    if (menu) {
      const wasOpen = !menu.hidden;
      document.querySelectorAll<HTMLElement>('.color-menu:not([hidden])').forEach(m => { m.hidden = true; });
      menu.hidden = wasOpen;
    }
    return;
  }

  const colorOpt = t?.closest<HTMLElement>('.color-opt[data-color]');
  if (colorOpt) {
    (await draw()).applyColorPick(colorOpt.closest<HTMLElement>('.color-picker')!, colorOpt.dataset.color!);
    const colorMenu = colorOpt.closest<HTMLElement>('.color-menu');
    if (colorMenu) colorMenu.hidden = true;
    return;
  }

  if (t?.closest('.color-custom')) return;

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

  document.addEventListener('input', async e => {
    const inp = (e.target as Element)?.closest<HTMLInputElement>('.color-custom[type=color]');
    if (!inp) return;
    (await draw()).applyColorPick(inp.closest<HTMLElement>('.color-picker')!, inp.value);
  });

  const drawColor = document.getElementById('drawColorPicker');
  if (drawColor) drawColor.innerHTML = colorPickerInner(state.drawDefaultColor);
}
