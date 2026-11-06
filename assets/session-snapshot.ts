// ─── Session snapshots: per-tab state that survives a reload of this tab ─────
// Role: the one place that reads and writes a snapshot in sessionStorage, for
//       chunks that rebuild after a reload, a tab discard or a renderer kill
//       (Chrome for Android reloads such a tab when the visitor comes back).
//         saveSnapshot(key, data, {shrink?, maxChars?})  write {v, hash, at, data}
//                              (hash = location.hash now); over maxChars or on a
//                              quota error, shrink(data) is tried until it fits or
//                              returns null, and then nothing is written and the
//                              key is removed (an older snapshot must not outlive
//                              a failed save and restore stale). false when
//                              nothing was written; never throws.
//         readSnapshot(key, validate)  the validated data, or null. Only when
//                              this page load is a reload, a back/forward or a
//                              discard reload (never a fresh navigation in the
//                              tab, such as a pasted link) and the stored hash
//                              equals the hash this page loaded with. Snapshots
//                              are untrusted input: validate decides the shape.
//         hasSnapshot(key)     the same gate without the validation (cheap: the
//                              boot hook's check before a dynamic import).
//                              Decided once per key per page load, so a later
//                              restampSnapshot does not change the answer.
//         restampSnapshot(key) give a snapshot that passed the gate the current
//                              hash, so it still restores after the view changed
//                              while its owner was never loaded.
//         claimSnapshot(key)   the key's owning chunk is loaded and saves it itself:
//                              restampSnapshot no longer touches it.
//         clearSnapshot(key)   remove it.
//         endSnapshots()       the page is leaving its view for another in this
//                              tab (map.ts reloads for a pasted link or a
//                              back/forward step): every snapshot this page
//                              touched is removed and none is saved after, so
//                              the reload's pagehide cannot stamp the old
//                              drawer and chat with the new hash.
//         onHidden(fn)         fn on visibilitychange → hidden and on pagehide
//                              (Android fires only the first when backgrounding).
//       The page-lifecycle line for File ▸ Diagnostics… lives here too, since it
//       must be recorded at boot: initPageLifecycle() (src/main.ts, first) reads
//       and clears sessionStorage `tm-lifecycle` — {pagehide?, hidden?, at},
//       written on pagehide and on hidden — and pageLifecycle() returns the
//       navigation type, document.wasDiscarded, the dev flag and what the
//       previous page in this tab did: 'pagehide' (closed normally), 'no-pagehide'
//       (went hidden, then stopped without pagehide: killed or discarded) or 'none'.
//       Every storage call is wrapped: blocked storage means no snapshot.
// Deps: none (boot bundle).

export const SNAPSHOT_VERSION = 1;
export interface Envelope<T = unknown> { v: number; hash: string; at: number; data: T }

/** The hash this page load started with, before any app code rewrote it. */
const bootHash = typeof location === 'undefined' ? '' : location.hash;

let navTypeMemo: string | null = null;
/** The navigation entry's type: 'navigate', 'reload', 'back_forward', 'prerender' or ''. */
export function navigationType(): string {
  if (navTypeMemo !== null) return navTypeMemo;
  try {
    const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    navTypeMemo = typeof e?.type === 'string' ? e.type : '';
  } catch { navTypeMemo = ''; }
  return navTypeMemo;
}

const wasDiscarded = () => typeof document !== 'undefined' && (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;

/** Whether this page load may restore a snapshot at all. */
const restorableLoad = () => ['reload', 'back_forward'].includes(navigationType()) || wasDiscarded();

function getRaw(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function envelope(raw: string | null): Envelope | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Envelope;
    return e && typeof e === 'object' && e.v === SNAPSHOT_VERSION && typeof e.hash === 'string'
      && typeof e.at === 'number' && 'data' in e ? e : null;
  } catch { return null; }
}

const gate = new Map<string, boolean>();
/** Every key this page has read, saved or checked; endSnapshots() removes them. */
const known = new Set<string>();
let ended = false;

export function hasSnapshot(key: string): boolean {
  known.add(key);
  let ok = gate.get(key);
  if (ok === undefined) {
    ok = restorableLoad() && envelope(getRaw(key))?.hash === bootHash;
    gate.set(key, ok);
  }
  return ok;
}

export function readSnapshot<T>(key: string, validate: (data: unknown) => T | null): T | null {
  if (!hasSnapshot(key)) return null;
  const e = envelope(getRaw(key));
  if (!e) return null;
  try { return validate(e.data); } catch { return null; }
}

export interface SaveOptions<T> {
  /** A smaller version of data (drop the oldest optional parts), or null to give up. */
  shrink?: (data: T) => T | null;
  /** The most characters of JSON to write. */
  maxChars?: number;
}

const isQuota = (e: unknown) => (e as { name?: string })?.name === 'QuotaExceededError'
  || (e as { code?: number })?.code === 22;

export function saveSnapshot<T>(key: string, data: T, opts: SaveOptions<T> = {}): boolean {
  known.add(key);
  if (ended) return false;
  if (write(key, data, opts)) return true;
  clearSnapshot(key);
  return false;
}

function write<T>(key: string, data: T, opts: SaveOptions<T>): boolean {
  let d: T | null = data;
  for (let tries = 0; d !== null && tries < 1000; tries++) {
    let json: string;
    try { json = JSON.stringify({ v: SNAPSHOT_VERSION, hash: location.hash, at: Date.now(), data: d }); } catch { return false; }
    if (opts.maxChars === undefined || json.length <= opts.maxChars) {
      try { sessionStorage.setItem(key, json); return true; } catch (e) { if (!isQuota(e)) return false; }
    }
    if (!opts.shrink) return false;
    try { d = opts.shrink(d); } catch { return false; }
  }
  return false;
}

const claimed = new Set<string>();
export function claimSnapshot(key: string): void { claimed.add(key); }

export function restampSnapshot(key: string): void {
  if (ended || claimed.has(key) || !hasSnapshot(key)) return;
  const e = envelope(getRaw(key));
  if (!e || e.hash === location.hash) return;
  try { sessionStorage.setItem(key, JSON.stringify({ ...e, hash: location.hash })); } catch { /* quota or blocked: keep the old one */ }
}

export function clearSnapshot(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* blocked storage */ }
}

export function endSnapshots(): void {
  ended = true;
  for (const key of known) clearSnapshot(key);
}

export function onHidden(fn: () => void): void {
  const run = () => { try { fn(); } catch { /* a lifecycle handler never throws */ } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') run(); });
  window.addEventListener('pagehide', run);
}

// ─── The page-lifecycle diagnostics line ─────────────────────────────────────
const LIFECYCLE_KEY = 'tm-lifecycle';
export type PreviousPage = 'pagehide' | 'no-pagehide' | 'none';
export interface PageLifecycle { navigation: string; wasDiscarded: boolean; dev: boolean; previous: PreviousPage }

let lifecycle: PageLifecycle | null = null;

function mark(part: { pagehide?: true; hidden?: true }) {
  try {
    let prev: unknown = null;
    try { prev = JSON.parse(sessionStorage.getItem(LIFECYCLE_KEY) ?? 'null'); } catch { /* replaced below */ }
    const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ ...base, ...part, at: Date.now() }));
  } catch { /* blocked storage */ }
}

/** Read and clear what the previous page in this tab left, then start marking this one. Once. */
export function initPageLifecycle(): PageLifecycle {
  if (lifecycle) return lifecycle;
  let previous: PreviousPage = 'none';
  try {
    if (typeof sessionStorage === 'undefined') throw new Error('no storage');
    const m = JSON.parse(sessionStorage.getItem(LIFECYCLE_KEY) ?? 'null') as { pagehide?: unknown; hidden?: unknown } | null;
    if (m && typeof m === 'object') previous = m.pagehide === true ? 'pagehide' : m.hidden === true ? 'no-pagehide' : 'none';
    sessionStorage.removeItem(LIFECYCLE_KEY);
  } catch { /* blocked storage or junk: none */ }
  lifecycle = { navigation: navigationType() || 'unknown', wasDiscarded: wasDiscarded(), dev: !!import.meta.env?.DEV, previous };
  if (typeof window === 'undefined') return lifecycle;
  window.addEventListener('pagehide', () => mark({ pagehide: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') mark({ hidden: true }); });
  return lifecycle;
}

/** The line File ▸ Diagnostics… reports (recorded at boot by initPageLifecycle). */
export function pageLifecycle(): PageLifecycle {
  return lifecycle ?? initPageLifecycle();
}
