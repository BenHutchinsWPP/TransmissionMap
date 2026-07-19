// ─── MapLibre initialisation ──────────────────────────────────────────────────

import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import { state, BLANK_STYLE, DEFAULT_CENTER, DEFAULT_ZOOM,
         OSM_TILE_URL, OFM_STYLE_URLS,
         USGS_TOPO_TILE_URL, USGS_HYDRO_TILE_URL,
         AERIAL_TILE_URL, USGS_AERIAL_TILE_URL } from './state.js';
import { loadGenIcons, loadPipelineIcons, loadNatgasPtIcons, loadMineIcons } from './icons.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { initPolygonHover, initLineHighlight } from './hover.js';
import { initRasterProbes } from './raster-probes.js';
import { applyAllGenModes, applyOGFColorBy, applyWestTECColorBy } from './visibility.js';
import { initPopups } from './popup.js';
import { initMeasure } from './measure.js';
import { writeUrlState } from './url-state.js';
import { emit } from './state-bus.js';
import { loadUserData } from './user-data/user-data.js';
import { hideLoading } from './utils/utils-dom.js';
import { apply3dFromState, ensureBuildingsLayer } from './terrain.js';

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
      applyWestTECColorBy();
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

    window.addEventListener("hashchange", () => {
      const loc = parseLocationHash();
      if (loc) state.map!.jumpTo({ center: loc.center, zoom: loc.zoom });
    });
  });
}

// ─── Dual basemap sources ─────────────────────────────────────────────────────
// Aerial hands off from free USGS NAIP (below) to the metered Esri key (at and
// above), so Esri only bills for close-in zooms.
//
// THESE CONSTANTS ARE IN MAP ZOOM, THE TILE LIMITS THEY ENCODE ARE IN TILE ZOOM,
// AND THE TWO ARE NOT THE SAME NUMBER. A 256px raster source against MapLibre's
// 512px reference tile resolves as
//     tileZoom = round(mapZoom + 1)        (transform.ts coveringZoomLevel)
// so at map zoom 7.5 MapLibre is already fetching TILE z9. Set a layer bound to
// the raw tile limit and you get a band where the old provider is serving tiles
// beyond its coverage and the new one has not switched on yet.
//
// USGS serves real imagery across the whole lower 48 through TILE z16 and 404s
// uniformly at z17 (verified at ten points, Seattle to Miami). tileZoom <= 16
// holds while mapZoom < 15.5 — hence the .5. This is the hard ceiling, not a
// preference: it leaves Esri only the last ~2.5 zoom levels.
//
// Below ~z12 the two are the same imagery (Esri sources NAIP there); higher up
// they differ in capture date and grading, so the seam is visible on close
// inspection. Accepted, to keep the Esri meter as idle as possible.
const AERIAL_SEAM_ZOOM = 15.5;

// USGS serves global Landsat/Blue Marble through TILE z8, but its NAIP coverage
// is CONUS-only: from TILE z9 up, tiles outside the lower 48 come back HTTP 200
// with a BLANK image (~2.4 KB) rather than a 404, so MapLibre treats them as real
// data and cannot overzoom the parent — the map just goes empty. Verified across
// BC/AB (Vancouver, Calgary, Edmonton, Prince George, Kamloops…), Toronto,
// Montreal, Mexico City and Alaska: all real at z8, all 2,419 bytes at z9.
//
// Per the tileZoom = round(mapZoom + 1) note above, TILE z9 is first requested at
// MAP zoom 7.5 — so that, not 9, is where Esri has to take over outside CONUS.
const AERIAL_GAP_ZOOM = 7.5;

// A raster source's `bounds` gates which tiles are REQUESTED (TileBounds.contains
// → hasTile), so a bounded Esri source costs zero quota inside CONUS. That is what
// lets the seam stay at z15 over the lower 48 while a chosen region still gets
// imagery from z9.
//
// Esri fills exactly one region outside the lower 48: BC/Alberta, which are
// interconnected members. Everywhere else outside CONUS (Alaska, Mexico, eastern
// Canada) stays USGS-only and therefore has no imagery above z9 — accepted, since
// nothing there is on the grid this map covers.
//
// The box hugs the 49th parallel, which IS the BC/AB–US border, so it leaks no
// tiles into the lower 48. Its south edge cuts off Vancouver Island below 49N
// (Victoria); extending it would put a strip of northern WA/ID/MT on the meter.
const AERIAL_GAP_REGIONS: { id: string; bounds: [number, number, number, number] }[] = [
  { id: "bc-ab", bounds: [-139, 49, -110, 60] },   // BC + Alberta
];

// One entry per RASTER basemap layer. The `light` and `dark` basemaps are
// OpenFreeMap vector styles merged in asynchronously by addOfmBasemaps(), so
// they are absent here; switchBasemap() toggles them via ofmLayerIds. `hydro`
// stacks the transparent USGS NHD water overlay on the OFM light layers.
//
// `aerial` owns three tiers: USGS below the seam,
// bounded Esri patches over the non-CONUS gap from z9, and global Esri above the
// seam. A layer outside its [minzoom, maxzoom) is isHidden() to MapLibre, which
// marks its source unused and fetches no tiles for it — that, plus source bounds,
// is what makes the split save quota instead of double-loading.
// Order matters: the gap patches are listed after aerial-usgs-bg so they paint
// OVER USGS's blank non-CONUS tiles.
const BASEMAP_LAYER_DEFS: {
  basemap: string; id: string; source: string; minzoom?: number; maxzoom?: number;
}[] = [
  { basemap: "street",  id: "osm-bg",           source: "osm-tiles"           },
  { basemap: "topo",    id: "usgs-topo-bg",     source: "usgs-topo-tiles"     },
  { basemap: "hydro",   id: "usgs-hydro-bg",    source: "usgs-hydro-tiles"    },
  { basemap: "aerial",  id: "aerial-usgs-bg",   source: "aerial-usgs-tiles", maxzoom: AERIAL_SEAM_ZOOM },
  ...AERIAL_GAP_REGIONS.map(r => ({
    basemap: "aerial", id: `aerial-esri-${r.id}-bg`, source: `aerial-esri-${r.id}`,
    minzoom: AERIAL_GAP_ZOOM, maxzoom: AERIAL_SEAM_ZOOM,
  })),
  { basemap: "aerial",  id: "aerial-bg",        source: "aerial-tiles",      minzoom: AERIAL_SEAM_ZOOM },
];

// Every Esri-backed layer, hidden together when the fallback latch trips.
const ESRI_LAYER_IDS = ["aerial-bg", ...AERIAL_GAP_REGIONS.map(r => `aerial-esri-${r.id}-bg`)];

function addBasemapSources() {
  if (!state.map) return;
  const sources = [
    { id: "osm-tiles",           tiles: [OSM_TILE_URL],           attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",                                       maxzoom: 19 },
    { id: "usgs-topo-tiles",     tiles: [USGS_TOPO_TILE_URL],    attribution: "USGS The National Map",                                                                                                          maxzoom: 16 },
    // maxzoom 16 is the USGS cache's hard ceiling (z17 is a 404), same as topo;
    // MapLibre overzooms the z16 tile beyond that rather than going blank.
    { id: "usgs-hydro-tiles",    tiles: [USGS_HYDRO_TILE_URL],   attribution: "USGS The National Map &middot; National Hydrography Dataset",                                                                     maxzoom: 16 },
    { id: "aerial-tiles",        tiles: [AERIAL_TILE_URL],        attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                              maxzoom: 19 },
    // maxzoom 16 is a hard property of the USGS cache (z17+ is a 404), not a
    // preference. It only bites in the fallback case; normally this source is
    // never asked for anything above AERIAL_SEAM_ZOOM anyway.
    { id: "aerial-usgs-tiles",   tiles: [USGS_AERIAL_TILE_URL],  attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                               maxzoom: 16 },
  ];
  for (const s of sources) {
    state.map.addSource(s.id, { type: "raster", tiles: s.tiles, tileSize: 256, attribution: s.attribution, maxzoom: s.maxzoom });
  }
  // Bounded Esri sources, one per gap region. Same tile URL as aerial-tiles, but
  // `bounds` stops MapLibre requesting anything outside the box.
  for (const r of AERIAL_GAP_REGIONS) {
    state.map.addSource(`aerial-esri-${r.id}`, {
      type: "raster", tiles: [AERIAL_TILE_URL], tileSize: 256, maxzoom: 19,
      bounds: r.bounds,
      attribution: "USGS The National Map · NAIP · Esri World Imagery",
    });
  }
  for (const d of BASEMAP_LAYER_DEFS) {
    state.map.addLayer({
      id: d.id, type: "raster", source: d.source,
      ...(d.minzoom !== undefined ? { minzoom: d.minzoom } : {}),
      ...(d.maxzoom !== undefined ? { maxzoom: d.maxzoom } : {}),
      // All raster basemaps start hidden; the default ("light") is an OFM
      // vector style whose layers arrive async via addOfmBasemaps() below.
      layout: { visibility: "none" },
    });
  }
  initAerialFallback();
  void addOfmBasemaps();
}

// ─── OpenFreeMap vector basemaps (light/dark) ─────────────────────────────────
// The light (Positron) and dark styles are full MapLibre style JSONs fetched at
// runtime. Their sources and layers are grafted into the app's style — hidden,
// at the very bottom of the paint order — and toggled as a group by
// switchBasemap(). Both styles share the same two sources (openmaptiles vector
// + natural-earth shaded-relief raster), added once under an `ofm-` prefix.

type OfmKey = keyof typeof OFM_STYLE_URLS;  // 'light' | 'dark'
const ofmLayerIds: Record<OfmKey, string[]> = { light: [], dark: [] };
// Symbol (text/shield) layers across both styles — the "Map Labels" toggle set.
const ofmLabelIds = new Set<string>();

// OFM's Positron ships pure-black place labels; the old CARTO raster tiles
// rendered them as soft grays that stayed behind the app's own features. Remap
// the harsh colors at graft time (light style only; dark is untouched so far).
const OFM_LIGHT_TEXT_REMAP: Record<string, string> = {
  "#000": "#7d8792",  // city/town/village/country labels
  "#333": "#8a929c",  // state + minor place labels
  "#666": "#9aa0a6",  // road names + airport codes
};

// Positron ships state/country boundaries at hsl(0,0%,70%) — barely visible
// against the pale background even before the app's own overlays sit on top.
// Darken them (light style only), reusing the same slate-gray palette as the
// label remap above so the basemap reads as one coherent set of grays.
// boundary_3 (state/province) also ships with minzoom:8 — invisible at this
// app's DEFAULT_ZOOM (4, a national view), so drop the floor to 0 as well.
const OFM_LIGHT_BOUNDARY_REMAP: Record<string, { color: string; minzoom?: number }> = {
  boundary_2: { color: "#8a929c" },              // country
  boundary_3: { color: "#9aa0a6", minzoom: 0 },  // state/province
};

// `hydro` borrows the light style as the ground under its water overlay.
function ofmStyleForBasemap(basemap: string): OfmKey | null {
  if (basemap === "light" || basemap === "hydro") return "light";
  if (basemap === "dark") return "dark";
  return null;
}

const OFM_ATTRIB = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &middot; <a href='https://openfreemap.org'>OpenFreeMap</a>";

// Minimal structural view of an OFM style layer — enough to remap id/source and
// force visibility without modeling the whole LayerSpecification union.
type OfmStyleJson = {
  sources: Record<string, object>;
  layers: { id: string; type: string; source?: string; minzoom?: number;
            layout?: Record<string, unknown>; paint?: Record<string, unknown> }[];
  sprite?: string;
};

async function addOfmBasemaps() {
  if (!state.map) return;
  const map = state.map;
  let entries: [OfmKey, OfmStyleJson][];
  try {
    entries = await Promise.all(
      (Object.entries(OFM_STYLE_URLS) as [OfmKey, string][]).map(
        async ([key, url]): Promise<[OfmKey, OfmStyleJson]> => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
          return [key, await res.json() as OfmStyleJson];
        }),
    );
  } catch (err) {
    console.error("[TransmissionMap] OpenFreeMap styles failed to load — light/dark basemaps unavailable:", err);
    return;
  }

  for (const [, style] of entries) {
    for (const [srcId, src] of Object.entries(style.sources)) {
      const id = `ofm-${srcId}`;
      if (map.getSource(id)) continue;
      map.addSource(id, { ...src, attribution: OFM_ATTRIB } as maplibregl.SourceSpecification);
    }
  }
  // Sprite (road shields, place dots) is style-global. Both OFM styles reference
  // the same sheet, and the app's own icons are runtime addImage() calls under
  // different names, so adopting it globally collides with nothing.
  const sprite = entries[0][1].sprite;
  if (sprite) void map.setSprite(sprite);

  // Insert every layer before the bottom-most raster basemap layer so the
  // vector basemap stays under all overlays no matter when this fetch resolves.
  // A constant anchor preserves each style's internal layer order.
  const anchor = "osm-bg";
  for (const [key, style] of entries) {
    for (const layer of style.layers) {
      const spec = { ...layer, id: `ofm-${key}-${layer.id}` };
      if (spec.source) spec.source = `ofm-${spec.source}`;
      spec.layout = { ...spec.layout, visibility: "none" };
      if (spec.type === "symbol") {
        ofmLabelIds.add(spec.id);
        const color = spec.paint?.["text-color"];
        if (key === "light" && typeof color === "string" && OFM_LIGHT_TEXT_REMAP[color]) {
          spec.paint = { ...spec.paint, "text-color": OFM_LIGHT_TEXT_REMAP[color] };
        }
      } else if (key === "light" && OFM_LIGHT_BOUNDARY_REMAP[layer.id]) {
        const { color, minzoom } = OFM_LIGHT_BOUNDARY_REMAP[layer.id];
        spec.paint = { ...spec.paint, "line-color": color };
        if (minzoom !== undefined) spec.minzoom = minzoom;
      }
      map.addLayer(spec as maplibregl.LayerSpecification, anchor);
      ofmLayerIds[key].push(spec.id);
    }
  }
  // Apply visibility for whatever basemap is already selected.
  switchBasemap(state.basemap);
  // Covers the race where 3D Buildings was already enabled (e.g. restored
  // from the URL) before this fetch resolved — a no-op otherwise.
  ensureBuildingsLayer();
}

// "Map Labels" checkbox: hides the OFM text/shield layers. Raster basemaps
// (Street/Topo/Aerial) have labels baked into their tiles — out of scope.
export function setBasemapLabels(on: boolean) {
  state.basemapLabels = on;
  switchBasemap(state.basemap);
}

// ─── Aerial fallback: Esri → USGS on quota exhaustion ─────────────────────────
// When the Esri key is spent (2M tiles/month) every tile 4xxs, blanking aerial
// above the seam. Fallback widens USGS to all zooms and hides Esri; USGS stops
// at z16, so MapLibre overzooms beyond that — blurry, never blank.
//
// Session latch, not a per-tile retry: once tripped the Esri layer is hidden, its
// source goes unused, and no further Esri tiles are requested. Releases after
// AERIAL_RETRY_MS; a still-dead key re-trips it. In-memory, so reload resets it.
const AERIAL_FAIL_THRESHOLD = 3;            // ride out transient blips
const AERIAL_RETRY_MS       = 30 * 60_000;  // re-probe Esri after 30 min
const AERIAL_MAX_ZOOM       = 24;           // MapLibre's ceiling; "no upper bound"
let aerialFailures = 0;
let aerialFellBack = false;

// esri → normal: USGS [0,SEAM), Esri gap patches [GAP,SEAM), global Esri [SEAM,∞).
// usgs → every Esri layer hidden, USGS widened to [0,∞). Non-CONUS has no imagery
//        at all in this state (USGS is blank there above z9), which beats a dead
//        aerial layer over the lower 48 — the whole point of the fallback.
function useAerial(provider: 'esri' | 'usgs') {
  if (!state.map) return;
  const esriOn = provider === 'esri';
  state.map.setLayerZoomRange('aerial-usgs-bg', 0, esriOn ? AERIAL_SEAM_ZOOM : AERIAL_MAX_ZOOM);
  // A zero-width zoom range is invalid, so Esri is hidden via visibility instead.
  const visible = esriOn && state.basemap === 'aerial' ? 'visible' : 'none';
  for (const id of ESRI_LAYER_IDS) state.map.setLayoutProperty(id, 'visibility', visible);
}

function initAerialFallback() {
  state.map?.on('error', (e) => {
    // MapLibre tags source errors with the source id and already swallows 404s,
    // so anything arriving here is real: 401/403 (bad key), 429 (quota), 5xx.
    const sourceId = (e as unknown as { sourceId?: string }).sourceId ?? '';
    const isEsri = sourceId === 'aerial-tiles' || sourceId.startsWith('aerial-esri-');
    if (!isEsri || aerialFellBack) return;
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
    // Esri stays hidden while the latch is tripped; otherwise re-selecting aerial
    // would re-arm a provider known to be failing.
    const suppressed = aerialFellBack && ESRI_LAYER_IDS.includes(d.id);
    const visible = d.basemap === type && !suppressed;
    state.map.setLayoutProperty(d.id, "visibility", visible ? "visible" : "none");
  }
  // OFM vector groups (empty arrays until addOfmBasemaps() resolves).
  const ofmActive = ofmStyleForBasemap(type);
  for (const key of Object.keys(ofmLayerIds) as OfmKey[]) {
    const groupOn = key === ofmActive;
    for (const id of ofmLayerIds[key]) {
      const vis = groupOn && (state.basemapLabels || !ofmLabelIds.has(id)) ? "visible" : "none";
      state.map.setLayoutProperty(id, "visibility", vis);
    }
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
