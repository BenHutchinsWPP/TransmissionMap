// ─── String utilities ─────────────────────────────────────────────────────────

export function escapeHtml(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] ?? c));
}

// True when `url` is a string holding an absolute http(s) URL. Browsers strip ASCII control
// chars/whitespace when parsing a scheme ("java\tscript:" navigates as
// javascript:), so the same range is stripped before the check.
export function isHttpUrl(url: unknown) {
  if (typeof url !== 'string') return false;
  // eslint-disable-next-line no-control-regex -- control chars are the point: strip what browsers strip
  return /^https?:\/\//i.test(url.replace(/[\u0000- ]/g, ''));
}

// A CSV cell (RFC 4180): null/undefined → empty, objects as JSON. A string that a spreadsheet would
// read as a formula gets a leading ' (OSM names are user-edited); a cell with a quote, comma or line
// break is quoted with its quotes doubled.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && FORMULA_START.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
