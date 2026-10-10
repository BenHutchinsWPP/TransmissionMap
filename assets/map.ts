// ─── MapLibre initialisation ──────────────────────────────────────────────────
// Explicitly configures MapLibre's bundled worker and surfaces map load
// failures to diag-log.ts (recordDiagEvent) for the diagnostics panel,
// alongside the existing console logging. Owns the Map constructor, its
// controls, the load handler, the camera-only hashchange handler and the
// WebGL-unavailable banner; every basemap concern (sources, OFM styles, labels,
// aerial fallback, projection) lives in basemap.ts, which the load handler
// starts with initBasemaps().
// The starting camera, and any camera-only hashchange, is read from the hash's
// camera segment via url-state-codec.ts (splitHash, parseCameraSegment).
// The load handler runs view-state.ts's repaintView() (filters, modes,
// colour-bys, styles) via url-state.ts's paintLinkedView(), once every layer
// is on the map.

import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import * as pmtiles from 'pmtiles';
import { state } from './state.js';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from './constants.js';
import { loadIcons } from './icons.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { initPolygonHover, initLineHighlight } from './hover.js';
import { initMapInput } from './map-input.js';
import { initRasterProbes } from './raster-probes.js';
import { initPopups } from './popup.js';
import { initMeasure } from './measure.js';
import { writeUrlState, paintLinkedView } from './url-state.js';
import { splitHash, parseCameraSegment } from './url-state-codec.js';
import { emit } from './state-bus.js';
import { loadUserData } from './user-data/user-data.js';
import { hideLoading } from './utils/utils-dom.js';
import { apply3dFromState } from './terrain.js';
import { recordDiagEvent } from './diag-log.js';
import { BLANK_STYLE, initBasemaps, switchBasemap, switchProjection } from './basemap.js';

maplibregl.setWorkerUrl(workerUrl);

export function initMap() {
  // Register pmtiles protocol BEFORE constructing the Map
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));

  const hashView = parseCameraSegment(splitHash(location.hash).camera);

  // MapLibre requires WebGL2. If the browser/GPU can't provide a context
  // (hardware acceleration off, driver blocklisted, webgl disabled), the Map
  // constructor throws — show a help banner instead of a silent black screen.
  try {
    state.map = new maplibregl.Map({
      container: "map",
      style: BLANK_STYLE,
      center:  hashView?.center ?? DEFAULT_CENTER,
      zoom:    hashView?.zoom   ?? DEFAULT_ZOOM,
      bearing: hashView?.bearing ?? 0,
      pitch:   hashView?.pitch   ?? 0,
      maxPitch: 75,
      maxZoom: 18,
      zoomLevelsToOverscale: undefined,
      attributionControl: false,
    });
  } catch (err) {
    console.error('[TransmissionMap] Map failed to initialise (WebGL2 unavailable):', err);
    showWebglError();
    return;
  }

  // Before anything subscribes: tap/hover delivery for both mouse and touch.
  initMapInput();

  // Surface map errors — MapLibre silently swallows tile/source/style errors
  // unless something listens. Log them so a blank map is diagnosable.
  state.map.on('error', (e: maplibregl.ErrorEvent) => {
    console.error('[TransmissionMap] Map error:', e.error ?? e);
    const sourceId = (e as unknown as { sourceId?: string }).sourceId;
    recordDiagEvent('map', sourceId ? `${sourceId}: ${e.error?.message ?? e}` : (e.error ?? e));
  });

  // No customAttribution: every source carries its own credit (a registry
  // layer's `data.credit`), so credits appear/disappear with layer visibility.
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

  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  state.map.addControl(new maplibregl.GeolocateControl({
    positionOptions:    { enableHighAccuracy: true },
    fitBoundsOptions:   { maxZoom: 12 },
    trackUserLocation:  false,
    showAccuracyCircle: true,
    showUserLocation:   true,
  }), "bottom-right");

  state.map.on("load", async () => {
    state.mapReady = true;
    initBasemaps();
    switchBasemap(state.basemap);
    switchProjection(state.projection);
    // Icon loads never block layer creation: loadIcons() settles every icon
    // and skips a failed one, so the layers build with whatever registered.
    await loadIcons();
    let built = false;
    try { addAllLayers(); built = true; } finally {
      // The same repaint as applyView() and the Reset button (repaintView):
      // applies every registered filter, gen mode, colour-by and the link's
      // style overrides in one shot. A failed layer build is recorded instead,
      // so the link is not blamed for it; the build error still propagates.
      // My Data still loads, so its saves (held back until then) reach storage.
      if (!built) {
        recordDiagEvent('map', 'layer build failed; the link view was not painted');
        loadUserData();
      } else {
        try { paintLinkedView(); } catch (err) {
          console.error('[TransmissionMap] view paint failed', err);
          recordDiagEvent('map', `view paint failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    apply3dFromState(); // restores terrain/buildings toggles (e.g. from the URL)
    initPolygonHover();
    initLineHighlight();
    initRasterProbes();
    initPopups();
    initMeasure();
    loadUserData();
    hideLoading();

    state.map!.on("moveend", writeUrlState);
    writeUrlState();

    // Everything above is in place — layers added, filters applied, 3D restored.
    // Anything that has to run against a finished map (Map Experiences restoring
    // an `exp` deep link) hangs off this rather than a second `load` handler,
    // which would fire at the first `await` above instead of after it.
    emit('map:ready');

    window.addEventListener("hashchange", () => {
      // A hash carrying state params (layers, basemap, 3D, filters) arrived from
      // outside this session — pasted into the address bar, or a back/forward
      // step. Only the full init path applies those, via readUrlState(), so
      // reload to restore them instead of jumping the camera and writing the
      // current session's state back over the link. Our own writeUrlState()
      // uses history.replaceState, which does not fire hashchange.
      if (location.hash.includes('?')) { location.reload(); return; }
      const loc = parseCameraSegment(splitHash(location.hash).camera);
      if (loc) state.map!.jumpTo({ center: loc.center, zoom: loc.zoom, bearing: loc.bearing, pitch: loc.pitch });
    });
  });
}


// ─── WebGL-unavailable banner ─────────────────────────────────────────────────
// Shown when the Map constructor throws (no WebGL2 context). Structure: a
// universal diagnostic (the get.webgl.org test) everyone sees, plus a
// browser-specific fix block chosen from the user agent.

// UA sniffing only picks help text here: a wrong guess degrades to generic
// advice, it never breaks anything. Order matters: Edge and Chrome UAs both
// contain "Chrome"; Safari's contains "Safari" but so does Chrome's — test the
// most specific token first.
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
