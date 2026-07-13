// ─── MapLibre initialisation ──────────────────────────────────────────────────

import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import { state, BLANK_STYLE, DEFAULT_CENTER, DEFAULT_ZOOM,
         OSM_TILE_URL, CARTO_LIGHT_TILE_URLS, CARTO_DARK_TILE_URLS,
         CARTO_VOYAGER_TILE_URLS, USGS_TOPO_TILE_URL, AERIAL_TILE_URL,
         USGS_AERIAL_TILE_URL } from './state.js';
import { loadGenIcons, loadPipelineIcons, loadNatgasPtIcons, loadMineIcons } from './icons.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { initPolygonHover, initLineHighlight } from './hover.js';
import { initRasterProbes } from './raster-probes.js';
import { applyAllGenModes, applyOGFColorBy } from './visibility.js';
import { initPopups } from './popup.js';
import { initMeasure } from './measure.js';
import { writeUrlState } from './url-state.js';
import { emit } from './state-bus.js';
import { loadUserData } from './user-data/user-data.js';
import { hideLoading } from './utils/utils-dom.js';

export function initMap() {
  // Register pmtiles protocol BEFORE constructing the Map
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));

  const hashView = parseLocationHash();

  // MapLibre v5 requires WebGL2. If the browser/GPU can't provide a context
  // (hardware acceleration off, driver blocklisted, webgl disabled), the Map
  // constructor throws — show a help banner instead of a silent black screen.
  try {
    state.map = new maplibregl.Map({
      container: "map",
      style: BLANK_STYLE,
      center:  hashView?.center ?? DEFAULT_CENTER,
      zoom:    hashView?.zoom   ?? DEFAULT_ZOOM,
      maxZoom: 18,
      attributionControl: false,
    });
  } catch (err) {
    console.error('[TransmissionMap] Map failed to initialise (WebGL2 unavailable):', err);
    showWebglError();
    return;
  }

  // Surface map errors — MapLibre silently swallows tile/source/style errors
  // unless something listens. Log them so a blank map is diagnosable.
  state.map.on('error', (e: maplibregl.ErrorEvent) => {
    console.error('[TransmissionMap] Map error:', e.error?.message ?? e);
  });

  // No customAttribution: every layer carries its own per-source attribution
  // (see SOURCE_ATTRIB), so credits appear/disappear with layer visibility.
  state.map.addControl(new maplibregl.AttributionControl({
    compact: true,
  }), "bottom-right");

  // Attribution credit links open in a new tab instead of navigating away from
  // the map. Delegated + capture-phase so it also covers links re-rendered when
  // layer visibility changes. Setting target before the default action suffices.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement)?.closest?.(".maplibregl-ctrl-attrib a") as HTMLAnchorElement | null;
    if (a) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }, true);

  state.map.addControl(new maplibregl.NavigationControl(), "bottom-right");

  state.map.addControl(new maplibregl.GeolocateControl({
    positionOptions:    { enableHighAccuracy: true },
    fitBoundsOptions:   { maxZoom: 12 },
    trackUserLocation:  false,
    showAccuracyCircle: true,
    showUserLocation:   true,
  }), "bottom-right");

  state.map.on("load", async () => {
    state.mapReady = true;
    addBasemapSources();
    switchBasemap(state.basemap);
    switchProjection(state.projection);
    // Icon loads must never block layer creation — a failed rasterize would
    // otherwise skip addAllLayers() and blank every layer. Degrade to no-icon.
    await Promise.all([loadGenIcons(), loadPipelineIcons(), loadNatgasPtIcons(), loadMineIcons()]
      .map(p => p.catch(err => console.warn('[TransmissionMap] icon load failed', err))));
    try { addAllLayers(); } finally {
      // Applies every registered filter (voltage/generators/pipeline/land/
      // natgas/OGF/mines/NWS/per-layer legend chips) in one shot — same path
      // as the Reset button, so initial load and reset can never drift apart.
      emit('filter:all');
      applyAllGenModes();
      applyOGFColorBy();
    }
    initPolygonHover();
    initLineHighlight();
    initRasterProbes();
    initPopups();
    initMeasure();
    loadUserData();
    hideLoading();

    state.map!.on("moveend", writeUrlState);
    writeUrlState();

    window.addEventListener("hashchange", () => {
      const loc = parseLocationHash();
      if (loc) state.map!.jumpTo({ center: loc.center, zoom: loc.zoom });
    });
  });
}

// ─── Dual basemap sources ─────────────────────────────────────────────────────
// The zoom at which the aerial basemap hands off from free USGS NAIP (below) to
// the metered Esri key (at and above). Chosen at 12 on evidence, not taste:
// below ~z12 Esri's imagery *is* NAIP, so the two are visually near-identical
// and the seam is invisible; by z14+ they diverge sharply (different capture
// dates, different colour grading), which would make a higher seam obvious.
// z12 also keeps the whole default CONUS view (z4) off the Esri meter entirely.
// Analysis: _private/docs/research/self-hosted-aerial-r2-pmtiles.md
const AERIAL_SEAM_ZOOM = 12;

// One entry per basemap layer. `aerial` owns TWO layers, split at the seam
// zoom; every other basemap owns one. A layer outside its [minzoom, maxzoom)
// range is `isHidden()` to MapLibre, which marks its source unused and fetches
// NO tiles for it — that is what makes the split actually save Esri quota
// rather than just double-loading.
const BASEMAP_LAYER_DEFS: {
  basemap: string; id: string; source: string; minzoom?: number; maxzoom?: number;
}[] = [
  { basemap: "street",  id: "osm-bg",           source: "osm-tiles"           },
  { basemap: "light",   id: "carto-light-bg",   source: "carto-light-tiles"   },
  { basemap: "dark",    id: "carto-dark-bg",    source: "carto-dark-tiles"    },
  { basemap: "voyager", id: "carto-voyager-bg", source: "carto-voyager-tiles" },
  { basemap: "topo",    id: "usgs-topo-bg",     source: "usgs-topo-tiles"     },
  { basemap: "aerial",  id: "aerial-usgs-bg",   source: "aerial-usgs-tiles", maxzoom: AERIAL_SEAM_ZOOM },
  { basemap: "aerial",  id: "aerial-bg",        source: "aerial-tiles",      minzoom: AERIAL_SEAM_ZOOM },
];

function addBasemapSources() {
  if (!state.map) return;
  const sources = [
    { id: "osm-tiles",           tiles: [OSM_TILE_URL],           attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",                                       maxzoom: 19 },
    { id: "carto-light-tiles",   tiles: CARTO_LIGHT_TILE_URLS,   attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-dark-tiles",    tiles: CARTO_DARK_TILE_URLS,    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-voyager-tiles", tiles: CARTO_VOYAGER_TILE_URLS, attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "usgs-topo-tiles",     tiles: [USGS_TOPO_TILE_URL],    attribution: "USGS The National Map",                                                                                                          maxzoom: 16 },
    { id: "aerial-tiles",        tiles: [AERIAL_TILE_URL],        attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                              maxzoom: 19 },
    // maxzoom 16 is a hard property of the USGS cache (z17+ is a 404), not a
    // preference. It only bites in the fallback case; normally this source is
    // never asked for anything above AERIAL_SEAM_ZOOM anyway.
    { id: "aerial-usgs-tiles",   tiles: [USGS_AERIAL_TILE_URL],  attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                               maxzoom: 16 },
  ];
  for (const s of sources) {
    state.map.addSource(s.id, { type: "raster", tiles: s.tiles, tileSize: 256, attribution: s.attribution, maxzoom: s.maxzoom });
  }
  for (const d of BASEMAP_LAYER_DEFS) {
    state.map.addLayer({
      id: d.id, type: "raster", source: d.source,
      ...(d.minzoom !== undefined ? { minzoom: d.minzoom } : {}),
      ...(d.maxzoom !== undefined ? { maxzoom: d.maxzoom } : {}),
      layout: { visibility: d.basemap === "street" ? "visible" : "none" },
    });
  }
  initAerialFallback();
}

// ─── Aerial fallback: Esri → USGS on quota exhaustion ─────────────────────────
// Normal operation is the seam above: USGS below z12, Esri at z12+. This handles
// the case where the Esri half dies — the key is capped (2M tiles/month, no card
// on file) and when it is spent every tile 4xxs, which would otherwise leave the
// aerial basemap black at exactly the zooms people care about.
//
// Fallback = widen USGS past the seam and hide Esri, so USGS covers all zooms.
// Its source stops at z16, so MapLibre overzooms (stretches z16) beyond that
// rather than requesting 404s: deep zoom degrades to blurry, never to blank.
//
// This is a SESSION LATCH, not a per-tile retry. Once tripped, the Esri layer is
// hidden, MapLibre marks its source unused, and no further Esri tiles are
// requested at all — there is no per-tile "try Esri, fail, fall back" tax.
//
// Recovery: after AERIAL_RETRY_MS the latch releases and the seam is restored.
// If the key is still dead the next few tiles re-trip it, so a wrong guess costs
// a handful of failed tiles per half hour, not a dead layer. The latch is
// in-memory, so a reload also resets it.
const AERIAL_FAIL_THRESHOLD = 3;            // ride out transient blips
const AERIAL_RETRY_MS       = 30 * 60_000;  // re-probe Esri after 30 min
const AERIAL_MAX_ZOOM       = 24;           // MapLibre's ceiling; "no upper bound"
let aerialFailures = 0;
let aerialFellBack = false;

// esri  → seam restored: USGS [0,12), Esri [12,∞)
// usgs  → Esri hidden:   USGS [0,∞)
function useAerial(provider: 'esri' | 'usgs') {
  if (!state.map) return;
  const esriOn = provider === 'esri';
  state.map.setLayerZoomRange('aerial-usgs-bg', 0, esriOn ? AERIAL_SEAM_ZOOM : AERIAL_MAX_ZOOM);
  // Zoom range alone can't hide Esri (a 0-width range is invalid), so drive its
  // visibility too — and respect the basemap the user is actually on.
  const aerialVisible = state.basemap === 'aerial';
  state.map.setLayoutProperty('aerial-bg', 'visibility', esriOn && aerialVisible ? 'visible' : 'none');
}

function initAerialFallback() {
  state.map?.on('error', (e) => {
    // MapLibre tags source-originated errors with the source id, and already
    // swallows 404s (they mean "no tile here"), so anything arriving for the
    // Esri source is a real failure: 401/403 (bad key), 429 (quota), 5xx.
    const sourceId = (e as unknown as { sourceId?: string }).sourceId;
    if (sourceId !== 'aerial-tiles' || aerialFellBack) return;
    if (++aerialFailures < AERIAL_FAIL_THRESHOLD) return;

    aerialFellBack = true;
    console.warn('[TransmissionMap] Esri aerial tiles failing — falling back to USGS NAIP (blurry above z16).');
    useAerial('usgs');

    window.setTimeout(() => {
      aerialFellBack = false;
      aerialFailures = 0;
      useAerial('esri');
    }, AERIAL_RETRY_MS);
  });
}

export function switchBasemap(type: string) {
  if (!state.mapReady || !state.map) return;
  state.basemap = type;
  for (const d of BASEMAP_LAYER_DEFS) {
    // While the fallback latch is tripped, aerial-bg (Esri) stays hidden even
    // when the user selects aerial — otherwise switching basemaps would silently
    // re-arm a provider we already know is failing.
    const suppressed = d.id === 'aerial-bg' && aerialFellBack;
    const visible = d.basemap === type && !suppressed;
    state.map.setLayoutProperty(d.id, "visibility", visible ? "visible" : "none");
  }
}

export function switchProjection(type: string) {
  if (!state.map) return;
  state.projection = type;
  // ponytail: only mercator | globe exist in MapLibre; no enum needed
  state.map.setProjection({ type: type as 'mercator' | 'globe' });
}

// ─── WebGL-unavailable banner ─────────────────────────────────────────────────
// Shown when the Map constructor throws (no WebGL2 context). Structure: a
// universal diagnostic (the get.webgl.org test) everyone sees, plus a
// browser-specific fix block chosen from the user agent.

// UA sniffing is normally a smell, but here it only picks help text — a wrong
// guess degrades to generic advice, it never breaks anything. Order matters:
// Edge and Chrome UAs both contain "Chrome"; Safari's contains "Safari" but so
// does Chrome's — so test the most specific token first.
function detectBrowser(ua: string): 'firefox' | 'edge' | 'chromium' | 'safari' | 'other' {
  if (/firefox|fxios/i.test(ua))                       return 'firefox';
  if (/edg/i.test(ua))                                 return 'edge';
  if (/chrome|chromium|crios/i.test(ua))               return 'chromium';
  if (/safari/i.test(ua))                              return 'safari';
  return 'other';
}

function browserHelp(kind: ReturnType<typeof detectBrowser>): string {
  // Chrome and Edge share steps; only the internal-page scheme differs.
  const chromiumHelp = (scheme: 'chrome' | 'edge') => `
    <p><strong>It looks like you're using ${scheme === 'edge' ? 'Edge' : 'Chrome'}.</strong>
    WebGL2 is usually off because hardware acceleration is disabled or your GPU is
    on the blocklist. To fix it:</p>
    <ol>
      <li><strong>Settings → System</strong> — turn on
        <strong>"Use hardware acceleration when available"</strong>, then relaunch.</li>
      <li>Open <code>${scheme}://gpu</code> and check the <strong>WebGL2</strong> line.
        If it says <em>Software only</em> or <em>Disabled</em>, the reasons are listed
        below it (usually a blocklisted GPU).</li>
      <li>To override the blocklist for a quick test, open
        <code>${scheme}://flags/#ignore-gpu-blocklist</code>, set it to
        <strong>Enabled</strong>, and relaunch. The real fix is updating your
        graphics driver.</li>
    </ol>`;

  switch (kind) {
    case 'firefox':
      return `
        <p><strong>It looks like you're using Firefox.</strong> WebGL2 is usually
        blocked by a graphics-driver blocklist or a disabled performance setting.
        To fix it:</p>
        <ol>
          <li><strong>Settings → General → Performance</strong> — uncheck
            "Use recommended performance settings," then check
            "Use hardware acceleration when available." Restart Firefox.</li>
          <li>If that doesn't help, open <code>about:config</code> and set
            <code>gfx.webrender.all</code> = <code>true</code>,
            <code>webgl.force-enabled</code> = <code>true</code>, and
            <code>layers.acceleration.disabled</code> = <code>false</code>;
            confirm <code>webgl.disabled</code> = <code>false</code>. Restart Firefox.</li>
          <li>Open <code>about:support</code> → <strong>Graphics</strong> → check
            <strong>"WebGL 2 Driver Renderer."</strong> If it's blank or says
            <em>Blocklisted</em>, update your graphics driver.</li>
        </ol>`;
    case 'edge':     return chromiumHelp('edge');
    case 'chromium': return chromiumHelp('chrome');
    case 'safari':
      return `
        <p><strong>It looks like you're using Safari.</strong> WebGL2 is on by
        default, so a blank map usually means an old macOS/GPU or a stale setting:</p>
        <ol>
          <li>Check <strong>Develop → Developer settings → WebGL</strong> is enabled.
            No Develop menu? Turn it on under
            <strong>Settings → Advanced → "Show features for web developers."</strong></li>
          <li>If WebGL is already on, update macOS and Safari to the latest version.</li>
        </ol>`;
    default:
      return `
        <p>Try enabling hardware acceleration in your browser's settings, updating
        your graphics driver, or opening the map in a recent version of Chrome,
        Edge, Firefox, or Safari.</p>`;
  }
}

function showWebglError() {
  hideLoading();

  const el = document.createElement('div');
  el.className = 'webgl-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="webgl-error-card">
      <h2>This map can't be displayed</h2>
      <p>Your browser or graphics hardware couldn't start WebGL2, which this map
      requires to render.</p>
      <p>First, confirm it's WebGL2 and not the map: open
      <a href="https://get.webgl.org/webgl2/" target="_blank" rel="noopener noreferrer">get.webgl.org/webgl2</a>.
      A spinning cube means WebGL2 works and the problem is elsewhere — otherwise
      the steps below should get it running.</p>
      ${browserHelp(detectBrowser(navigator.userAgent))}
      <div style="margin-top: 20px; text-align: right;">
        <button onclick="location.reload()" class="layers-toggle-btn" style="position: static; box-shadow: none;">Reload Page</button>
      </div>
    </div>`;
  (document.getElementById('map') ?? document.body).appendChild(el);
}

// ─── URL hash parsing ─────────────────────────────────────────────────────────
function parseLocationHash() {
  try {
    const raw   = window.location.hash.slice(1);
    const posStr = raw.includes('?') ? raw.slice(0, raw.indexOf('?')) : raw;
    const parts = posStr.split("/");
    if (parts.length !== 3) return null;
    const zoom = parseFloat(parts[0]);
    const lat  = parseFloat(parts[1]);
    const lon  = parseFloat(parts[2]);
    if ([zoom, lat, lon].some(isNaN)) return null;
    if (zoom < 0 || zoom > 22)         return null;
    if (lat < -90  || lat > 90)        return null;
    if (lon < -180 || lon > 180)       return null;
    return { zoom, center: [lon, lat] as [number, number] };
  } catch {
    console.warn("Malformed URL hash; using default map view.");
    return null;
  }
}
