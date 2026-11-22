// ─── Linked-services UI — DOM helper ─────────────────────────────────────────
// Role: `el()` (utils-dom's `hx`), the one way the linked-services surfaces build DOM: createElement
//       with attributes and text children, nothing parsed as HTML (external
//       strings — a service's name, a status — reach the page only as text).
//       `sourceLink()`: a library entry's source page as a new-tab link, or null
//       for UNKNOWN (or anything that is not a credential-free https URL).
// Deps: utils/utils-dom.ts (hx).
// Consumed by ui-services.ts, ui-linked-services.ts, notice-dialog.ts, ui-canvas.ts, ui-templates.ts and
//       ui-credits.ts (sourceLink).

import { hx as el } from '../utils/utils-dom.js';
export { el };

/** A link to a library entry's source page that opens in a new tab, or null
 *  when the source is UNKNOWN or not a credential-free https URL. */
export function sourceLink(source: string, label: string): HTMLAnchorElement | null {
  let href: URL;
  try { href = new URL(source); } catch { return null; }
  if (href.protocol !== 'https:' || href.username || href.password) return null;
  return el('a', { href: href.href, target: '_blank', rel: 'noopener noreferrer', class: 'svc-source', title: href.host },
    label + ' \u2197');
}
