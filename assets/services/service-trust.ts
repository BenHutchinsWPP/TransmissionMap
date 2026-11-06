// assets/services/service-trust.ts — the session's approved set of service URLs:
// which unvetted services the visitor has explicitly chosen to load (Add anyway
// in the dialog, Load on a pending card, a confirmed chat call). This module
// owns the set; service-render.ts asks isAllowed() before fetching anything, so
// a link, a view file, an undo or a story naming an unvetted URL never fetches
// it until the visitor approves it.
// The set is normalised URLs (normaliseServiceUrl's url), held in memory and
// mirrored to sessionStorage `tm-svc-approved`, so a reload in the same tab
// keeps the approvals and a new tab starts empty. Storage is read lazily and
// re-validated (an array of at most MAX_APPROVED strings, each normalising);
// every read and write is wrapped, so blocked storage means memory only.
// Deps: service-spec.ts (normaliseServiceUrl, ServiceKind), service-hosts.ts (isVetted).
import { normaliseServiceUrl, type ServiceKind } from './service-spec.js';
import { isVetted } from './service-hosts.js';

const KEY = 'tm-svc-approved';
export const MAX_APPROVED = 50;

let approved: Set<string> | null = null;

// The stored form of a URL, or null. The url part of normaliseServiceUrl does
// not depend on the kind, so a URL whose kind the path cannot tell is retried
// with the hint that accepts any path.
function normalised(url: string): string | null {
  const n = normaliseServiceUrl(url);
  if (n.ok) return n.result.url;
  const g = normaliseServiceUrl(url, 'geojson');
  return g.ok ? g.result.url : null;
}

function load(): Set<string> {
  const set = new Set<string>();
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(raw) && raw.length <= MAX_APPROVED) {
      for (const u of raw) {
        const n = typeof u === 'string' ? normalised(u) : null;
        if (n) set.add(n);
      }
    }
  } catch { /* unreadable or blocked storage: start empty */ }
  return set;
}

const set = () => (approved ??= load());

/** Re-read the set from sessionStorage, as a new page load in this tab would. */
export function reloadApproved(): void {
  approved = null;
}

export function isApproved(url: string): boolean {
  const n = typeof url === 'string' ? normalised(url) : null;
  return n !== null && set().has(n);
}

/** Add a URL to the session's approved set; the oldest falls out past MAX_APPROVED. */
export function approve(url: string): void {
  const n = normalised(url);
  if (!n) return;
  const s = set();
  s.delete(n);
  s.add(n);
  while (s.size > MAX_APPROVED) s.delete(s.values().next().value!);
  try { sessionStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* memory only */ }
}

/** May this service be fetched: a vetted source, or one the visitor approved this session. */
export function isAllowed(service: { url: string; kind?: ServiceKind }): boolean {
  return isVetted(service.url, service.kind) || isApproved(service.url);
}
