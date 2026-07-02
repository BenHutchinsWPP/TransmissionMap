// =============================================================================
// sw.js — TransmissionMap Service Worker
//
// Caching strategy:
//   Static assets (JS/CSS/images) — Network-First (cache is offline fallback)
//                                    while updates are actively shipping.
//   GeoJSON data files             — Cache-First (full response).
//   PMTiles range requests         — Cache-First, keyed by URL + Range header
//                                    so each byte range is stored separately.
//
// Cache invalidation:
//   Bump STATIC_VERSION when you deploy new JS/CSS.
//   Bump DATA_VERSION after rebuilding tiles (make pipeline + make tiles).
//   Old cache buckets are deleted automatically on activate.
// =============================================================================

const STATIC_VERSION = 'v33';  // network-first static strategy (purges stale cache-first bundles)
const DATA_VERSION   = 'v2';   // ← bump this after running build_tiles.sh

const STATIC_CACHE = `tm-static-${STATIC_VERSION}`;
const DATA_CACHE   = `tm-data-${DATA_VERSION}`;

// Pre-cache the HTML shell only. The Vite bundle (hashed filename) and all
// other static assets are cached on first fetch by handleStatic() below.
// To pre-cache the full bundle, integrate vite-plugin-pwa which can inject
// the correct hashed filenames at build time.
const PRECACHE_URLS = ['/'];

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
  const live = new Set([STATIC_CACHE, DATA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !live.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())   // take control of already-open tabs
  );
});

// ── Fetch: route to the appropriate strategy ───────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ignore non-GET requests and cross-origin requests (CDN libs, tiles.osm.org, etc.)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  if (path.startsWith('/data/')) {
    // Data files — GeoJSON (full) or PMTiles (range chunks)
    event.respondWith(handleData(req));
  } else {
    // Static assets — HTML, JS, CSS, images
    event.respondWith(handleStatic(req));
  }
});

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
    if (cached) return cached;
    throw err;
  }
}

// ── Data: Cache-First, range-aware ────────────────────────────────────────────
// PMTiles uses HTTP Range requests (e.g. "bytes=0-511") to load individual tiles.
// The standard Cache API ignores request headers, so a naive cache.match(req)
// would return the wrong bytes for different ranges of the same file.
//
// Fix: use a synthetic cache key that encodes the range in the URL fragment,
// e.g.  /data/layers/osm_lines.pmtiles#bytes=16384-32767
// Each unique byte range gets its own entry — correct data, fast lookup.
async function handleData(req) {
  const rangeHeader = req.headers.get('range');
  const cacheKey = rangeHeader
    ? new Request(req.url + '#' + rangeHeader)   // range-specific key
    : req;                                        // full-file key (GeoJSON)

  const cache  = await caches.open(DATA_CACHE);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await fetch(req);

  // Cache both full (200 OK) and partial (206 Partial Content) responses.
  if (response.status === 200 || response.status === 206) {
    cache.put(cacheKey, response.clone());   // clone: body can only be read once
  }
  return response;
}
