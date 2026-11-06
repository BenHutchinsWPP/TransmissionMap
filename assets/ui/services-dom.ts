// ─── Linked-services UI — DOM helper ─────────────────────────────────────────
// Role: `el()`, the one way the linked-services surfaces build DOM: createElement
//       with attributes and text children, nothing parsed as HTML (external
//       strings — a service's name, a status — reach the page only as text).
//       `sourceLink()`: a library entry's source page as a new-tab link, or null
//       for UNKNOWN (or anything that is not a credential-free https URL).
// Deps: none.
// Consumed by ui-services.ts, ui-linked-services.ts, notice-dialog.ts and ui-credits.ts (sourceLink).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** A link to a library entry's source page that opens in a new tab, or null
 *  when the source is UNKNOWN or not a credential-free https URL. */
export function sourceLink(source: string, label: string): HTMLAnchorElement | null {
  let href: URL;
  try { href = new URL(source); } catch { return null; }
  if (href.protocol !== 'https:' || href.username || href.password) return null;
  return el('a', { href: href.href, target: '_blank', rel: 'noopener noreferrer', class: 'svc-source', title: href.host },
    label + ' \u2197');
}
