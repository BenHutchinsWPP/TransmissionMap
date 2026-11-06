// ─── Selection row: the chip's menu ──────────────────────────────────────────
// The Selection row under the Area field (index.html #selRow, painted by
// panel-mirror.ts from state.sel) stays in the boot bundle so a link, Undo,
// Reset or a story shows and clears a selection with no table open.
// wireSelectionRow() wires its Clear links and the mode button's menu,
// portalled to <body> (the 220 px panel clips overflow) as a fixed-position
// role=menu: Isolate, Keep (radio items), Show in table, Zoom to selection,
// Clear selection. Every change is one commitSelection() (one 'url:write',
// then syncPanel()). The menu opens on click or ArrowDown, moves with the
// arrow keys, and Esc, Tab, an outside click or a pick closes it, returning
// focus to the button.
// Deps: state.ts, panel-mirror.ts (commitSelection), table-open.ts (openTable,
//       zoomToSelection — the lazy table chunk), src/i18n (t).
// Imported by: ui.ts (init).

import { state } from '../state.js';
import { commitSelection } from './panel-mirror.js';
import { openTable, zoomToSelection } from './table-open.js';
import { t } from '../../src/i18n/index.js';
import type { SelectionMode } from '../../src/types.js';

let menu: HTMLElement | null = null;

function close(focusButton = false) {
  menu?.remove();
  menu = null;
  const btn = document.getElementById("selModeBtn");
  btn?.setAttribute("aria-expanded", "false");
  if (focusButton) btn?.focus();
}

function setMode(mode: SelectionMode) {
  if (state.sel && state.sel.mode !== mode) commitSelection({ ...state.sel, mode });
}

function item(label: string, hint: string | null, run: () => void, checked?: boolean) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sel-menu-item";
  b.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
  if (checked !== undefined) b.setAttribute("aria-checked", String(checked));
  const name = document.createElement("span");
  name.className = "sel-menu-name";
  name.textContent = label;
  b.append(name);
  if (hint) {
    const h = document.createElement("span");
    h.className = "sel-menu-hint";
    h.textContent = hint;
    b.append(h);
  }
  b.addEventListener("click", () => { close(true); run(); });
  return b;
}

function open(btn: HTMLElement) {
  const sel = state.sel;
  if (!sel) return;
  close();
  const firstLayer = Object.keys(sel.ids).find(id => sel.ids[id].length);
  const sep = () => Object.assign(document.createElement("div"), { className: "sel-menu-sep" });
  menu = document.createElement("div");
  menu.className = "dropdown sel-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("sel.title"));
  menu.append(
    item(t("sel.isolate"), t("sel.isolateHint"), () => setMode("isolate"), sel.mode === "isolate"),
    item(t("sel.keep"), t("sel.keepHint"), () => setMode("keep"), sel.mode === "keep"),
    sep(),
    item(t("sel.showInTable"), null, () => {
      if (firstLayer) void openTable({ layerId: firstLayer, ids: sel.ids[firstLayer] });
    }),
    item(t("sel.zoom"), null, () => void zoomToSelection()),
    item(t("sel.clearSelection"), null, () => commitSelection(null)),
  );
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  menu.addEventListener("keydown", (e) => {
    const items = [...menu!.querySelectorAll<HTMLElement>(".sel-menu-item")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  });
}

export function wireSelectionRow() {
  const btn = document.getElementById("selModeBtn");
  if (!btn) return;
  btn.addEventListener("click", () => (menu ? close() : open(btn)));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && !menu) { e.preventDefault(); open(btn); }
  });
  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest("[data-sel-action=clear]")) commitSelection(null);
    if (menu && !menu.contains(target) && !btn.contains(target)) close();
  });
}
