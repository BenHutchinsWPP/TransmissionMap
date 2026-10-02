// =============================================================================
// sw.js — TransmissionMap Service Worker
//
// Caching strategy:
//   Same-origin app shell (HTML/JS/CSS/images) — Network-First; the cache is
//   the offline fallback.
//
// Map data is not cached here. In production every layer comes from
// raw.githubusercontent.com (DATA_ORIGIN / LIVE_ORIGIN in assets/constants.ts),
// which is cross-origin, so those requests pass straight through to the
// browser's HTTP cache (raw serves `max-age=300`). The SW is registered in
// production only (src/main.ts).
//
// Cache invalidation:
//   Bump STATIC_VERSION when you deploy new JS/CSS.
//   Old cache buckets are deleted automatically on activate.
// =============================================================================

const STATIC_VERSION = 'v35';  // network-first static strategy (purges stale cache-first bundles)

const STATIC_CACHE = `tm-static-${STATIC_VERSION}`;

// Pre-cache the HTML shell only. The Vite bundle (hashed filename) and all
// other static assets are cached on first fetch by handleStatic() below.
// To pre-cache the full bundle, integrate vite-plugin-pwa which can inject
// the correct hashed filenames at build time.
// './' resolves against the SW scope, so it works wherever the site is served
// from — the domain root in dev and production, or a subpath if the base ever
// moves (addAll rejects the whole install on any 404).
const PRECACHE_URLS = ['./'];

// ── Install: pre-cache static shell ───────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())   // activate immediately without waiting
  );
});

// ── Activate: purge stale cache versions ──────────────────────────────────────
self.addEventListener('activate', event => {
  const live = new Set([STATIC_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !live.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())   // take control of already-open tabs
  );
});

// ── Fetch: same-origin GETs only ───────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ignore non-GET requests and cross-origin requests (CDN libs, tiles.osm.org, etc.)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(handleStatic(req));
});

// Tag cache-served responses so the page's data-usage counter can skip them
// (cache hits cost zero network bytes). Headers are immutable on a cached
// Response, so rewrap it.
function markCacheHit(res) {
  const headers = new Headers(res.headers);
  headers.set('x-sw-cache', 'hit');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ── Static: Network-First ─────────────────────────────────────────────────────
// ponytail: network-first while updates ship frequently — nobody can be stale
// while online. Flip back to cache-first (or SWR) once the site stabilizes.
async function handleStatic(req) {
  try {
    const response = await fetch(req);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(req);   // offline → serve last good copy
    if (cached) return markCacheHit(cached);
    throw err;
  }
}
