// ─── Diagnostics ("things aren't loading") — logic only ───────────────────────
// Role: the check catalogue behind the Diagnostics panel. Probes every host the
//       app depends on, reports the browser capabilities the layers need, and
//       reads live-feed freshness, then formats a plain-text report for a
//       support email. Pure logic: no DOM, no rendering — a separate module
//       owns the modal and consumes DIAG_CHECKS / runDiagnostics /
//       buildDiagReport / DIAG_ENV.
// A browser cannot tell a blocked request from a host being down from a CORS
//       rejection — all three surface as `TypeError: Failed to fetch`. Every
//       detail string here is worded to say what was observed, never to name a
//       cause. `timeout` and `unexpected body` are hints, not proof.
// The required/optional host probes below cover the same hosts enumerated in
//       docs/network-allowlist.md — update both together.
// Deps: state (DATA, tile URLs, live feed caches), constants (GLYPHS_URL,
//       ESRI_TOKEN — not re-exported by state.ts), diag-log.ts (getDiagLog),
//       live-staleness.ts (fmtAge, feedIssue, liveAgeMs), wildfire-staleness.ts +
//       nws-staleness.ts (the same max-age cutoffs the kill-switches use, so
//       this panel can never disagree with them), odin-outages.ts +
//       weather-live.ts (odinFreshness/weatherFreshness — those two feeds keep
//       their own snapshot and cutoff rather than using state.sourcesData).

import {
  state, DATA,
  OSM_TILE_URL, AERIAL_TILE_URL, USGS_AERIAL_TILE_URL, OFM_STYLE_URLS,
  RADAR_TILE_URL, GEOMET_RADAR_TILE_TEMPLATE, TERRAIN_TILE_URL,
} from './state.js';
import { GLYPHS_URL, ESRI_TOKEN } from './constants.js';
import { getDiagLog } from './diag-log.js';
import { fmtAge, feedIssue, liveAgeMs } from './live-staleness.js';
import { WILDFIRE_MAX_AGE_MS } from './wildfire-staleness.js';
import { NWS_MAX_AGE_MS } from './nws-staleness.js';
import { odinFreshness } from './odin-outages.js';
import { weatherFreshness } from './weather-live.js';

export type DiagStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type DiagGroup = 'capability' | 'required' | 'optional' | 'live';

// What a check body returns. runDiagnostics stamps id/label/group onto it to
// make a DiagResult, so no check has to carry its own identity around.
export interface DiagOutcome {
  status: DiagStatus;
  detail: string;
}

export interface DiagCheck {
  id: string;
  label: string;
  group: DiagGroup;
  run: () => Promise<DiagOutcome>;
}

export type DiagResult = Omit<DiagCheck, 'run'> & DiagOutcome;

// In dev DATA_ORIGIN is "" (constants.ts), so the layer-host probes hit
// localhost rather than the layer host and legitimately differ from production.
export const DIAG_ENV: string = import.meta.env.PROD ? 'production' : 'dev';

export const PROBE_TIMEOUT_MS = 5_000;

// ─── Probe primitives ─────────────────────────────────────────────────────────

export interface FetchProbeResult {
  // The Response, when one arrived at all. Body is left unread so callers can
  // stream it (or discard it) themselves.
  response: Response | null;
  status: number;                          // 0 when no response arrived
  detail: string;
}

const NETWORK_DETAIL =
  "could not connect — could be a network block, the host being down, or CORS; a browser can't tell these apart";
const TIMEOUT_DETAIL =
  `timed out after ${PROBE_TIMEOUT_MS / 1000}s — slow link or a proxy holding the connection`;

export async function fetchProbe(url: string, opts: RequestInit = {}): Promise<FetchProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...opts, signal: ctrl.signal });
    return {
      response,
      status: response.status,
      detail: response.ok
        ? `reachable (HTTP ${response.status})`
        : `the host answered with HTTP ${response.status}`,
    };
  } catch (err) {
    const aborted = (err as Error | undefined)?.name === 'AbortError';
    return {
      response: null,
      status: 0,
      detail: aborted ? TIMEOUT_DETAIL : NETWORK_DETAIL,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ImgProbeResult {
  ok: boolean;
  detail: string;
}

// Tile hosts commonly serve images without CORS headers, so a fetch() probe
// reports a TypeError even when the host is perfectly reachable. <img> is also
// the code path MapLibre uses for raster tiles.
export function imgProbe(url: string): Promise<ImgProbeResult> {
  return new Promise<ImgProbeResult>(resolve => {
    const img = new Image();
    let settled = false;
    const done = (r: ImgProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, detail: TIMEOUT_DETAIL }), PROBE_TIMEOUT_MS);
    img.onload = () => done({ ok: true, detail: 'a tile image loaded' });
    img.onerror = () => done({ ok: false, detail: NETWORK_DETAIL });
    img.src = url;
  });
}

// ─── Check plumbing ───────────────────────────────────────────────────────────

function mk(status: DiagStatus, detail: string): DiagOutcome {
  return { status, detail };
}

function check(id: string, label: string, group: DiagGroup, run: () => Promise<DiagOutcome>): DiagCheck {
  return { id, label, group, run };
}

// Release a response we are not going to read. Errors here are irrelevant to
// the check's outcome.
function discardBody(r: Response | null): void {
  void r?.body?.cancel().catch(() => { /* stream already closed */ });
}

// Reachability-only probe: any HTTP response means the host answered.
async function hostCheck(url: string, failStatus: DiagStatus, opts?: RequestInit): Promise<DiagOutcome> {
  const p = await fetchProbe(url, opts);
  discardBody(p.response);
  const status: DiagStatus = p.response?.ok ? 'ok' : failStatus;
  return mk(status, `${url} — ${p.detail}`);
}

// A low-zoom tile over the continental US, for the {z}/{x}/{y} basemap
// templates. z4/x3/y6 covers the central US.
const TILE_Z = 4, TILE_X = 3, TILE_Y = 6;

function tileUrl(template: string): string {
  return template
    .replace('{z}', String(TILE_Z))
    .replace('{x}', String(TILE_X))
    .replace('{y}', String(TILE_Y));
}

// Web Mercator bounds of that same tile, for the GeoMet WMS template.
const GEOMET_PROBE_URL = GEOMET_RADAR_TILE_TEMPLATE
  .replace('{layer}', 'RADAR_1KM_RRAI')
  .replace('{bbox-epsg-3857}', '-12523442.71,2504688.54,-10018754.17,5009377.09')
  .replace('{bust}', 'diag');

// 1×1 WebP.
const WEBP_DATA_URI =
  'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

const CLOCK_SKEW_WARN_MS = 2 * 60_000;

// ─── Live-feed freshness ──────────────────────────────────────────────────────

// Same precedence as the legend age chips (ui/ui-legends.ts): per-subfeed
// status rides on the first feature's properties, with the
// FeatureCollection-level stash as the fallback. Reading only the stash would
// let this panel report a healthy feed the legend is already flagging.
function subfeedIssues(sourceKey: string): string {
  const meta = state.liveFcMeta[sourceKey];
  const first = state.sourcesData[sourceKey]?.[0] as GeoJSON.Feature | undefined;
  const status = (first?.properties?.feed_status as Record<string, string> | undefined)
    ?? meta?.feed_status;
  return Object.entries(status ?? {})
    .map(([feed, s]) => feedIssue(feed, s, meta?.feed_last_ok?.[feed]))
    .filter((s): s is string => !!s)
    .join(', ');
}

function liveCheck(sourceKey: string, maxAgeMs: number): DiagOutcome {
  if (!state.sourcesLoaded[sourceKey]) {
    return mk('skip', 'not turned on this session — enable the layer to check its freshness');
  }
  const age = liveAgeMs(sourceKey);
  if (age === null) {
    return mk('warn', 'loaded, but the feed carries no generated_utc timestamp so its age is unknown');
  }
  const issues = subfeedIssues(sourceKey);
  const suffix = issues ? ` — subfeeds: ${issues}` : '';
  if (age > maxAgeMs) {
    return mk('fail',
      `data is ${fmtAge(age)} old, past the ${fmtAge(maxAgeMs)} cutoff — the layers stay hidden until a fresher pull lands${suffix}`);
  }
  return mk(issues ? 'warn' : 'ok',
    `data is ${fmtAge(age)} old, within the ${fmtAge(maxAgeMs)} cutoff${suffix}`);
}

// Freshness for the feeds that hold their own snapshot instead of populating
// state.sourcesData. The cutoff comes from the owning module, so this can
// never disagree with the guard that unpaints the layer.
function snapshotCheck(f: { ageMs: number | null; maxAgeMs: number }): DiagOutcome {
  if (f.ageMs === null) {
    return mk('skip', 'not loaded this session — turn the layer on to check its freshness');
  }
  return f.ageMs > f.maxAgeMs
    ? mk('fail', `data is ${fmtAge(f.ageMs)} old, past the ${fmtAge(f.maxAgeMs)} cutoff — the layer stays hidden until a fresher pull lands`)
    : mk('ok', `data is ${fmtAge(f.ageMs)} old, within the ${fmtAge(f.maxAgeMs)} cutoff`);
}

// ─── The catalogue ────────────────────────────────────────────────────────────

export const DIAG_CHECKS: DiagCheck[] = [
  // ── Browser capabilities ──
  check('webgl2', 'WebGL2 rendering', 'capability', async () => {
    let gl: unknown;
    try { gl = document.createElement('canvas').getContext('webgl2'); } catch { gl = null; }
    return gl
      ? mk('ok', 'available — the map can render')
      : mk('fail', 'unavailable — the map cannot render without it; hardware acceleration or a GPU driver policy may be involved');
  }),

  check('decompression-stream', 'Gzip decoding (DecompressionStream)', 'capability', async () =>
    'DecompressionStream' in window
      ? mk('ok', 'available — .geojson.gz layers can be decoded')
      : mk('fail', 'unavailable — every .geojson.gz layer needs it to decode')),

  check('webp', 'WebP image decoding', 'capability', async () => {
    const r = await imgProbe(WEBP_DATA_URI);
    return r.ok
      ? mk('ok', 'available — the weather raster can be drawn')
      : mk('fail', 'a 1×1 WebP did not decode — the weather raster needs WebP');
  }),

  check('local-storage', 'Local storage', 'capability', async () => {
    try {
      const k = '__tm_diag__';
      localStorage.setItem(k, '1');
      const back = localStorage.getItem(k);
      localStorage.removeItem(k);
      return back === '1'
        ? mk('ok', 'readable and writable — drawings and settings persist between visits')
        : mk('warn', 'a value written back differently than it was stored — drawings and settings may not persist');
    } catch (err) {
      return mk('warn', `unavailable (${String(err)}) — drawings and settings last only for this session`);
    }
  }),

  check('storage-quota', 'Storage quota', 'capability', async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est || est.quota == null) return mk('skip', 'this browser does not report a storage estimate');
      const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
      return mk('ok', `${mb(est.usage ?? 0)} used of about ${mb(est.quota)} available for cached tiles and saved data`);
    } catch (err) {
      return mk('skip', `storage estimate unavailable (${String(err)})`);
    }
  }),

  check('service-worker', 'Service worker', 'capability', async () =>
    navigator.serviceWorker?.controller
      ? mk('ok', 'controlling this page — tiles are served from the local cache')
      : mk('skip', 'not controlling this page — tiles are fetched fresh on every load')),

  check('clock-skew', 'System clock', 'capability', async () => {
    // Same-origin only: `Date` is not a CORS-safelisted response header, so a
    // cross-origin probe reads back null unless the server opts in.
    const p = await fetchProbe(location.pathname, { method: 'HEAD', cache: 'no-store' });
    discardBody(p.response);
    if (!p.response) return mk('skip', `clock could not be compared — ${p.detail}`);
    const header = p.response.headers.get('Date');
    const server = header ? Date.parse(header) : NaN;
    if (Number.isNaN(server)) return mk('skip', 'the page host sent no readable Date header, so clock skew could not be measured');
    const skew = Date.now() - server;
    const mag = Math.abs(skew);
    if (mag <= CLOCK_SKEW_WARN_MS) {
      return mk('ok', `within ${Math.round(mag / 1000)}s of the page host`);
    }
    return mk('warn',
      `${fmtAge(mag)} ${skew > 0 ? 'ahead of' : 'behind'} the page host — live-feed freshness is measured against this clock, so live layers can hide themselves while the data is actually current`);
  }),

  // ── Required hosts (the app already fetches all of these cross-origin) ──
  check('data-static-host', 'Layer data host (data-static branch)', 'required', () =>
    hostCheck(DATA.usgs_seismic_pga_lut_meta, 'fail')),

  check('data-live-host', 'Live feed host (data branch)', 'required', () =>
    // A separate branch from the built layers: force-pushed hourly, so it can
    // be unreachable while the layer branch is fine.
    hostCheck(DATA.odin_outages, 'fail')),

  check('ofm-style', 'Basemap style (OpenFreeMap)', 'required', () =>
    hostCheck(OFM_STYLE_URLS.light, 'fail')),

  check('ofm-glyphs', 'Map label fonts (OpenFreeMap glyphs)', 'required', () =>
    hostCheck(GLYPHS_URL.replace('{fontstack}', encodeURIComponent('Noto Sans Regular')).replace('{range}', '0-255'), 'fail')),

  check('geocoder', 'Place search (ArcGIS geocoder)', 'required', async () => {
    if (!ESRI_TOKEN) return mk('skip', 'place search is turned off in this build, so there is nothing to probe');
    const params = new URLSearchParams({ f: 'json', singleLine: 'Denver', maxLocations: '1', token: ESRI_TOKEN });
    const url = `https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params}`;
    const p = await fetchProbe(url);
    if (!p.response) { discardBody(p.response); return mk('fail', p.detail); }
    // Any parsed JSON means the service answered — including an error object.
    try {
      const data = await p.response.json() as { error?: { code?: number; message?: string } };
      // An error object still proves the host answered, but place search will
      // not work until the key is valid again — so this is a warn, not an ok.
      return data?.error
        ? mk('warn', `reachable, but the service rejected the request: error ${data.error.code ?? ''} (${data.error.message ?? 'no message'}) — place search returns nothing until the key is accepted`)
        : mk('ok', `reachable (HTTP ${p.status}) and returned candidates`);
    } catch {
      return mk('warn', `answered with HTTP ${p.status} but the body was not JSON — a sign-in page or proxy notice can look like this`);
    }
  }),

  check('pmtiles-range', 'Byte-range requests (PMTiles)', 'required', async () => {
    // Range is a CORS-safelisted request header, so no preflight. Only the
    // status matters — reading Content-Range would need the host to expose it.
    // Any PMTiles archive proves the host.
    const url = DATA.osm_transmission_lines_kv300;
    const p = await fetchProbe(url, { headers: { Range: 'bytes=0-127' } });
    discardBody(p.response);
    if (!p.response) return mk('fail', `${url} — ${p.detail}`);
    if (p.status === 206) return mk('ok', 'a 128-byte range came back as HTTP 206 — PMTiles layers can load');
    if (p.status === 200) {
      return mk('fail',
        'the whole file came back (HTTP 200) instead of the requested byte range — a Range header dropped somewhere between the browser and the host would look like this, and leaves every PMTiles layer blank while plain GeoJSON layers keep working');
    }
    return mk('fail', `a byte-range request answered with HTTP ${p.status} instead of 206`);
  }),

  check('gzip-integrity', 'Gzip file integrity', 'required', async () => {
    const url = DATA.nrel_hydrothermal_points;
    const p = await fetchProbe(url);
    if (!p.response) return mk('fail', `${url} — ${p.detail}`);
    if (!p.response.ok) { discardBody(p.response); return mk('fail', `${url} — ${p.detail}`); }
    const body = p.response.body;
    if (!body) return mk('skip', 'the response body could not be streamed, so the file signature was not read');
    // Read only the leading bytes and cancel — a stripped Range header would
    // otherwise pull the entire multi-megabyte file.
    const reader = body.getReader();
    try {
      const head: number[] = [];
      while (head.length < 2) {
        const { value, done } = await reader.read();
        if (value) head.push(...value.slice(0, 2));
        if (done) break;
      }
      if (head[0] === 0x1f && head[1] === 0x8b) {
        return mk('ok', 'the file still starts with the gzip signature — .geojson.gz layers decode as built');
      }
      const seen = head.length
        ? head.slice(0, 2).map(b => b.toString(16).padStart(2, '0')).join(' ')
        : 'nothing';
      return mk('fail',
        `the file starts with ${seen} instead of the gzip signature 1f 8b — a decompressing or rewriting proxy between the browser and the host would look like this, and stops every .geojson.gz layer from decoding`);
    } catch (err) {
      return mk('fail', `the file could not be read (${String(err)})`);
    } finally {
      void reader.cancel().catch(() => { /* stream already closed */ });
    }
  }),

  // ── Optional hosts: basemaps and weather imagery. The map works without
  //    them, so a failure here is a warn.
  check('osm-tiles', 'OpenStreetMap tiles (optional basemap)', 'optional', async () => {
    const r = await imgProbe(tileUrl(OSM_TILE_URL));
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  check('esri-aerial', 'Esri aerial imagery (optional basemap)', 'optional', async () => {
    const r = await imgProbe(tileUrl(AERIAL_TILE_URL));
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  check('usgs-basemap', 'USGS imagery basemap (optional)', 'optional', async () => {
    const r = await imgProbe(tileUrl(USGS_AERIAL_TILE_URL));
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  check('nexrad-radar', 'NEXRAD radar tiles (optional overlay)', 'optional', async () => {
    const r = await imgProbe(tileUrl(RADAR_TILE_URL));
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  check('geomet-radar', 'Canadian GeoMet radar (optional overlay)', 'optional', async () => {
    const r = await imgProbe(GEOMET_PROBE_URL);
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  check('terrain-tiles', '3D terrain and hillshade tiles (optional)', 'optional', async () => {
    const r = await imgProbe(tileUrl(TERRAIN_TILE_URL));
    return mk(r.ok ? 'ok' : 'warn', r.detail);
  }),

  // ── Live feed freshness: read from state, no refetch ──
  check('wildfire-live', 'Live wildfire feed', 'live', async () =>
    liveCheck('wildfire-live', WILDFIRE_MAX_AGE_MS)),

  check('nws-alerts', 'Live NWS alert feed', 'live', async () =>
    liveCheck('nws-alerts', NWS_MAX_AGE_MS)),

  // ODIN and weather keep their own snapshots rather than state.sourcesData,
  // so each reports its own age against its own cutoff.
  check('odin-outages', 'Live outage feed (ODIN)', 'live', async () =>
    snapshotCheck(odinFreshness())),

  check('weather-live', 'Live weather bake (GFS)', 'live', async () =>
    snapshotCheck(weatherFreshness())),
];

// ─── Runner ───────────────────────────────────────────────────────────────────

// Every check runs concurrently; onResult fires as each settles so rows can
// stream into the panel. A check that throws becomes a `fail` row — one bad
// check never takes down the run.
export function runDiagnostics(onResult: (r: DiagResult) => void): Promise<DiagResult[]> {
  return Promise.all(DIAG_CHECKS.map(async ({ id, label, group, run }) => {
    let outcome: DiagOutcome;
    try {
      outcome = await run();
    } catch (err) {
      outcome = mk('fail', `the check did not complete (${String(err)})`);
    }
    const r: DiagResult = { id, label, group, ...outcome };
    onResult(r);
    return r;
  }));
}

// ─── Report ───────────────────────────────────────────────────────────────────

// Shared with ui/ui-diagnostics.ts so the panel and the report can never list
// a different set of groups, or list them in a different order.
export const GROUP_TITLES: Record<DiagGroup, string> = {
  capability: 'Browser capabilities',
  required: 'Required hosts',
  optional: 'Optional hosts (the map works without these)',
  live: 'Live feed freshness',
};

export const GROUP_ORDER: DiagGroup[] = ['capability', 'required', 'optional', 'live'];

// Strips the value of any token= query parameter. Applied to the whole report,
// so it covers probe URLs, recorded errors, and the page URL alike — including
// a `token=undefined` produced by a keyless build.
function redactTokens(text: string): string {
  return text.replace(/([?&]token=)[^&\s]*/gi, '$1REDACTED');
}

const STATUS_TAG: Record<DiagStatus, string> = {
  ok: '[OK]  ',
  warn: '[WARN]',
  fail: '[FAIL]',
  skip: '[SKIP]',
};

export function buildDiagReport(results: DiagResult[]): string {
  const lines: string[] = [
    'TransmissionMap diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `Build: ${DIAG_ENV}`,
    `Page: ${location.href}`,
    `User agent: ${navigator.userAgent}`,
    '',
    `Summary: ${(['fail', 'warn', 'ok', 'skip'] as DiagStatus[])
      .map(s => `${results.filter(r => r.status === s).length} ${s}`)
      .join(', ')}`,
  ];

  for (const group of GROUP_ORDER) {
    const rows = results.filter(r => r.group === group);
    if (!rows.length) continue;
    lines.push('', `── ${GROUP_TITLES[group]} ──`);
    for (const r of rows) lines.push(`${STATUS_TAG[r.status]} ${r.label}: ${r.detail}`);
  }

  const log = getDiagLog();
  lines.push('', `── Recorded runtime errors (${log.length}) ──`);
  if (!log.length) lines.push('none recorded this session');
  for (const e of log) lines.push(`${new Date(e.ts).toISOString()} [${e.source}] ${e.detail}`);

  return redactTokens(lines.join('\n'));
}
