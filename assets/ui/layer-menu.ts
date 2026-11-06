// ─── Layer row ⋯ menu ─────────────────────────────────────────────────────────
// Wires the one action menu on each layers-panel row (ui-layer-rows.ts renders
// the button `.layer-menu-btn` and its hidden role=menu `.layer-menu`). The menu
// opens on click, Enter/Space or ArrowDown/ArrowUp and focuses its first item;
// the arrow keys, Home and End move between the items that show (a closed
// continental download group hides its links); Esc closes it and returns focus
// to the button; Tab, an outside click, a map tap, a scroll or a resize closes
// it. A pick closes it too — the item's own action runs in its existing
// delegated handler (ui-filters.ts: the filter and year sub-panels; ui.ts:
// table, Visualize, About), except a download-group summary, which expands in
// place. The menu is fixed-positioned by positionColorMenu so it stays on
// screen however narrow the panel. It carries no view state: the only state it
// shows is whether a sub-panel is open (aria-checked, set by ui-filters.ts),
// which renderPanel resets with the rows.
// Deps: ui-menubar.ts (positionColorMenu), map-input.ts (onMapTap).
// Consumed by ui.ts (init).

import { positionColorMenu } from './ui-menubar.js';
import { onMapTap } from '../map-input.js';

let openBtn: HTMLElement | null = null;

const menuOf = (btn: HTMLElement) => document.getElementById(btn.getAttribute('aria-controls') ?? '');

/** The items a keyboard can reach now: links inside a closed download group are not. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('.layer-menu-item')].filter(el => {
    const group = el.closest('details');
    return !group || el.tagName === 'SUMMARY' || group.open;
  });
}

export function closeLayerMenu(refocus = false) {
  const btn = openBtn;
  if (!btn) return;
  openBtn = null;
  const menu = menuOf(btn);
  if (menu) menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

function openLayerMenu(btn: HTMLElement, focus: 'first' | 'last' = 'first') {
  closeLayerMenu();
  const menu = menuOf(btn);
  if (!menu) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  openBtn = btn;
  positionColorMenu(menu, btn);
  const items = menuItems(menu);
  items[focus === 'first' ? 0 : items.length - 1]?.focus();
}

export function wireLayerMenus() {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest<HTMLElement>('.layer-menu-btn');
    if (btn) {
      if (openBtn === btn) closeLayerMenu(); else openLayerMenu(btn);
      return;
    }
    const menu = openBtn && menuOf(openBtn);
    if (!menu) return;
    if (!menu.contains(target)) { closeLayerMenu(); return; }
    const item = target?.closest<HTMLElement>('.layer-menu-item');
    if (item && item.tagName !== 'SUMMARY') closeLayerMenu(true);
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest<HTMLElement>('.layer-menu-btn');
    if (btn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openLayerMenu(btn, e.key === 'ArrowDown' ? 'first' : 'last');
      return;
    }
    const menu = openBtn && menuOf(openBtn);
    if (!menu || !menu.contains(target)) return;
    const items = menuItems(menu);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
      items[(i + step) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLayerMenu(true);
    } else if (e.key === 'Tab') {
      closeLayerMenu();
    }
  });

  // Fixed-positioned: a scroll of the panel would leave it behind its row.
  document.addEventListener('scroll', (e) => {
    const menu = openBtn && menuOf(openBtn);
    if (menu && !menu.contains(e.target as Node)) closeLayerMenu();
  }, true);
  window.addEventListener('resize', () => closeLayerMenu());
  onMapTap(() => closeLayerMenu());
}
