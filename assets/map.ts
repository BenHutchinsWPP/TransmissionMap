// ─── MapLibre initialisation ──────────────────────────────────────────────────

import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import { state, BLANK_STYLE, DEFAULT_CENTER, DEFAULT_ZOOM,
         OSM_TILE_URL, CARTO_LIGHT_TILE_URLS, CARTO_DARK_TILE_URLS,
         CARTO_VOYAGER_TILE_URLS, USGS_TOPO_TILE_URL, AERIAL_TILE_URL } from './state.js';
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
const BASEMAP_LAYERS = {
  street:  { sourceId: "osm-tiles",          layerId: "osm-bg"           },
  light:   { sourceId: "carto-light-tiles",  layerId: "carto-light-bg"   },
  dark:    { sourceId: "carto-dark-tiles",   layerId: "carto-dark-bg"    },
  voyager: { sourceId: "carto-voyager-tiles",layerId: "carto-voyager-bg" },
  topo:    { sourceId: "usgs-topo-tiles",    layerId: "usgs-topo-bg"     },
  aerial:  { sourceId: "aerial-tiles",       layerId: "aerial-bg"        },
};

function addBasemapSources() {
  if (!state.map) return;
  const sources = [
    { id: "osm-tiles",           tiles: [OSM_TILE_URL],           attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",                                       maxzoom: 19 },
    { id: "carto-light-tiles",   tiles: CARTO_LIGHT_TILE_URLS,   attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-dark-tiles",    tiles: CARTO_DARK_TILE_URLS,    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-voyager-tiles", tiles: CARTO_VOYAGER_TILE_URLS, attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "usgs-topo-tiles",     tiles: [USGS_TOPO_TILE_URL],    attribution: "USGS The National Map",                                                                                                          maxzoom: 16 },
    { id: "aerial-tiles",        tiles: [AERIAL_TILE_URL],        attribution: "Esri World Imagery",                                                                                                             maxzoom: 19 },
  ];
  for (const s of sources) {
    state.map.addSource(s.id, { type: "raster", tiles: s.tiles, tileSize: 256, attribution: s.attribution, maxzoom: s.maxzoom });
  }
  for (const [type, { sourceId, layerId }] of Object.entries(BASEMAP_LAYERS)) {
    state.map.addLayer({ id: layerId, type: "raster", source: sourceId, layout: { visibility: type === "street" ? "visible" : "none" } });
  }
}

export function switchBasemap(type: string) {
  if (!state.mapReady || !state.map) return;
  state.basemap = type;
  for (const [t, { layerId }] of Object.entries(BASEMAP_LAYERS)) {
    state.map.setLayoutProperty(layerId, "visibility", t === type ? "visible" : "none");
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
