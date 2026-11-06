// Role: the range grids' shared half, free of Tabulator at runtime and of the DOM model — the Tabulator
// options all three range grids share, a cell's clipboard value, a range as tab-separated text, the
// Ctrl/Cmd+C test, the keypress-bound clipboard write, and the guard that keeps a control's presses from the grid.
// Deps: none. Used by: ui-table.ts (re-exports clipValue),
// ui-proximity.ts, route-tabs/method-grid.ts, proximity-rows.ts.

/** The Tabulator options the table drawer, the Proximity grid and the Method grid share: virtual rows, a
 *  one-range cell selection of whole rows, no focus grab on data load, Tab leaves the grid, resize from the header. */
export const GRID_RANGE_DEFAULTS = {
  renderVertical: 'virtual',
  selectableRange: 1,
  selectableRangeColumns: false,
  selectableRangeRows: true,
  // The typings lag this option.
  selectableRangeAutoFocus: false,
  keybindings: { navNext: false, navPrev: false },
  // Resize from the header only: a cell's edge stays part of a range drag.
  columnDefaults: { resizable: 'header' },
} as const;

/** Ctrl/Cmd+C, with no Alt or Shift. */
export function isCopyKey(ev: KeyboardEvent): boolean {
  return (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'c';
}

/** Keep a control's presses from Tabulator: no range starts, no column moves, no row click, no editor. */
export function keepFromGrid(el: HTMLElement): void {
  for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick'] as const) el.addEventListener(type, ev => ev.stopPropagation());
}

/** A cell's clipboard value: the raw value, never the display text. A number
 *  copies at full precision; text is formula-guarded as the CSV is, with tabs
 *  and line breaks flattened so a cell stays one TSV cell. */
export function clipValue(v: unknown): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  const text = (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\t\r\n]+/g, ' ');
  return typeof v === 'string' && /^[=+\-@]/.test(text) ? "'" + text : text;
}

/** A header line, then one line per row, tab-separated, joined by newlines. */
export function tsvOf(header: string[], rows: (string | number)[][]): string {
  return [header.join('\t'), ...rows.map(r => r.join('\t'))].join('\n');
}

/** Inside a keypress: execCommand('copy') with a capturing copy listener, else navigator.clipboard.writeText.
 *  `onDone` runs once the text is on the clipboard. */
export function copyText(text: string, onDone: () => void): void {
  const put = (ev: ClipboardEvent) => { ev.preventDefault(); ev.clipboardData?.setData('text/plain', text); };
  document.addEventListener('copy', put, true);
  let done = false;
  try { done = document.execCommand?.('copy') ?? false; } catch { /* the fallback below */ } finally { document.removeEventListener('copy', put, true); }
  if (done) onDone();
  else void navigator.clipboard?.writeText(text).then(onDone, () => {});
}
