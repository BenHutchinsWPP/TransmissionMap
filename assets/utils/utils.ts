// ─── String utilities ─────────────────────────────────────────────────────────

export function escapeHtml(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] ?? c));
}
