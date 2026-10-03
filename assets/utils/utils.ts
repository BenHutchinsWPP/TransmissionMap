// ─── String utilities ─────────────────────────────────────────────────────────

export function escapeHtml(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] ?? c));
}

// True when `url` is an absolute http(s) URL. Browsers strip ASCII control
// chars/whitespace when parsing a scheme ("java\tscript:" navigates as
// javascript:), so the same range is stripped before the check.
export function isHttpUrl(url: string) {
  // eslint-disable-next-line no-control-regex -- control chars are the point: strip what browsers strip
  return /^https?:\/\//i.test(url.replace(/[\u0000- ]/g, ''));
}
