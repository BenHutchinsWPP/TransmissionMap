// ─── Basemaps: raster + OpenFreeMap vector, labels, aerial fallback, projection ─
// Owns every basemap layer the map draws under the app's own layers: the raster
// basemaps (OSM street, USGS topo/hydro, the USGS/Esri aerial tiers), the
// OpenFreeMap light/dark vector styles grafted in at runtime, the Aerial
// roads/places/boundaries overlay cloned from the light style, the Map Labels
// toggle, the Esri → USGS aerial quota fallback, and the globe projection with
// its pitch-faded atmosphere.
// basemapVisibility() is the pure basemap × labels × fallback → layer-visibility
// matrix; switchBasemap() applies it.
// Deps: state.js, constants.js (tile URLs, OFM_STYLE_URLS, atmosphere),
//       basemap-overlay.js (aerialOverlayLayer, normalizeOfmFilter),
//       terrain.js (ensureBuildingsLayer after the OFM graft, repositionHillshade
//       from switchBasemap), diag-log.js (OFM style fetch failures),
//       state-bus.js (lang:changed → OFM label language, subscribed at import),
//       src/i18n (getLocale).
// Called from: map.ts (initBasemaps, switchBasemap, switchProjection in the
//       load handler), ui/ui.ts (basemap/projection/labels controls),
//       view-state.ts (switchBasemap, switchProjection from seedView and applyView;
//       both write state before their map guard, so the cold-boot seed only
//       writes state).
// Keeps the 'basemap-overlay-top' anchor id that terrain.ts also names.

import type * as maplibregl from 'maplibre-gl';
import { state } from './state.js';
import { BLANK_STYLE,
         OSM_TILE_URL, OFM_STYLE_URLS,
         USGS_TOPO_TILE_URL, USGS_HYDRO_TILE_URL,
         AERIAL_TILE_URL, USGS_AERIAL_TILE_URL,
         ATMOSPHERE_BLEND, ATMOSPHERE_FADE_PITCH } from './constants.js';
import { on } from './state-bus.js';
import { getLocale, type SupportedLocale } from '../src/i18n/index.js';
import { ensureBuildingsLayer, repositionHillshade } from './terrain.js';
import { recordDiagEvent } from './diag-log.js';
import { aerialOverlayLayer, normalizeOfmFilter, type OfmLayer } from './basemap-overlay.js';

// Adds every basemap source and layer, starts the OFM style fetch and the aerial
// fallback, and keeps the globe atmosphere in step with pitch. Called once from
// map.ts's load handler.
export function initBasemaps(): void {
  addBasemapSources();
  state.map?.on("pitch", syncAtmosphere);
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
export const BASEMAP_LAYER_DEFS: {
  basemap: string; id: string; source: string; minzoom?: number; maxzoom?: number;
}[] = [
  { basemap: "street",  id: "osm-bg",             source: "osm-tiles"           },
  { basemap: "topo",    id: "usgs-topo-bg",       source: "usgs-topo-tiles"     },
  { basemap: "hydro",   id: "usgs-hydro-bg",      source: "usgs-hydro-tiles"    },
  { basemap: "aerial",  id: "aerial-usgs-bg",     source: "aerial-usgs-tiles",   maxzoom: AERIAL_SEAM_ZOOM },
  ...AERIAL_GAP_REGIONS.map(r => ({
    basemap: "aerial", id: `aerial-esri-${r.id}-bg`, source: `aerial-esri-${r.id}`,
    minzoom: AERIAL_GAP_ZOOM, maxzoom: AERIAL_SEAM_ZOOM,
  })),
  { basemap: "aerial",  id: "aerial-bg",          source: "aerial-tiles",        minzoom: AERIAL_SEAM_ZOOM },
];

// Every Esri-backed layer, hidden together when the fallback latch trips.
export const ESRI_LAYER_IDS = ["aerial-bg", ...AERIAL_GAP_REGIONS.map(r => `aerial-esri-${r.id}-bg`)];

// Anchor the aerial roads/places/boundaries overlay above every raster basemap
// layer (inserted below this, by beforeId) and below every app layer (added
// after this, in insertion order) — stable regardless of whether the OFM style
// fetch in addOfmBasemaps() resolves before or after addAllLayers() runs.
const BASEMAP_OVERLAY_ANCHOR = 'basemap-overlay-top';

function addBasemapSources() {
  if (!state.map) return;
  const sources = [
    { id: "osm-tiles",             tiles: [OSM_TILE_URL],             attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",                                       maxzoom: 19 },
    { id: "usgs-topo-tiles",       tiles: [USGS_TOPO_TILE_URL],      attribution: "USGS The National Map",                                                                                                          maxzoom: 16 },
    // maxzoom 16 is the USGS cache's hard ceiling (z17 is a 404), same as topo;
    // MapLibre overzooms the z16 tile beyond that rather than going blank.
    { id: "usgs-hydro-tiles",      tiles: [USGS_HYDRO_TILE_URL],     attribution: "USGS The National Map &middot; National Hydrography Dataset",                                                                     maxzoom: 16 },
    { id: "aerial-tiles",          tiles: [AERIAL_TILE_URL],          attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                              maxzoom: 19 },
    // maxzoom 16 is a hard property of the USGS cache (z17+ is a 404), not a
    // preference. It only bites in the fallback case; normally this source is
    // never asked for anything above AERIAL_SEAM_ZOOM anyway.
    { id: "aerial-usgs-tiles",     tiles: [USGS_AERIAL_TILE_URL],    attribution: "USGS The National Map · NAIP · Esri World Imagery",                                                                               maxzoom: 16 },
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
  state.map.addLayer({ id: BASEMAP_OVERLAY_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } });
  initAerialFallback();
  void addOfmBasemaps();
}

// ─── OpenFreeMap vector basemaps (light/dark/aerial overlay) ──────────────────
// The light (Positron) and dark styles are full MapLibre style JSONs fetched at
// runtime. Their sources and layers are grafted into the app's style — hidden,
// at the very bottom of the paint order — and toggled as a group by
// switchBasemap(). Both styles share the same two sources (openmaptiles vector
// + natural-earth shaded-relief raster), added once under an `ofm-` prefix.
//
// A third group is cloned from the light style's roads/places/boundaries and
// grafted at BASEMAP_OVERLAY_ANCHOR instead — above the aerial imagery rather
// than below it — so Aerial gets a readable reference overlay.

type OfmKey = keyof typeof OFM_STYLE_URLS;  // 'light' | 'dark' — indexes OFM_STYLE_URLS for the style fetch
// Paint-order groups toggled by switchBasemap(); 'aerial' has no style URL of
// its own — it's cloned from the fetched 'light' style (see addOfmBasemaps()).
export type OfmGroup = OfmKey | 'aerial';
const ofmLayerIds: Record<OfmGroup, string[]> = { light: [], dark: [], aerial: [] };
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
function ofmStyleForBasemap(basemap: string): OfmGroup | null {
  if (basemap === "light" || basemap === "hydro") return "light";
  if (basemap === "dark") return "dark";
  if (basemap === "aerial") return "aerial";
  return null;
}

const OFM_ATTRIB = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &middot; <a href='https://openfreemap.org'>OpenFreeMap</a>";

// Minimal structural view of an OFM style layer — enough to remap id/source and
// force visibility without modeling the whole LayerSpecification union.
// OfmLayer (imported) is the same shape plus 'source-layer', which
// aerialOverlayLayer() needs to pick roads/places/boundaries out of the style.
type OfmStyleJson = {
  sources: Record<string, object>;
  layers: OfmLayer[];
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
    recordDiagEvent('basemap', err);
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
    for (const rawLayer of style.layers) {
      const layer = normalizeOfmFilter(rawLayer);
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

      // Aerial roads/places/boundaries overlay, cloned from the raw (pre-remap)
      // layer so the light-basemap softening above doesn't fight the
      // over-photography restyle aerialOverlayLayer() applies.
      if (key === 'light') {
        const aerial = aerialOverlayLayer(layer);
        if (aerial) {
          map.addLayer(aerial as maplibregl.LayerSpecification, BASEMAP_OVERLAY_ANCHOR);
          ofmLayerIds.aerial.push(aerial.id);
        }
      }
    }
  }
  // Apply visibility for whatever basemap is already selected.
  switchBasemap(state.basemap);
  // Covers the race where 3D Buildings was already enabled (e.g. restored
  // from the URL) before this fetch resolved — a no-op otherwise.
  ensureBuildingsLayer();
  setMapLabelLanguage(map, getLocale());
}

function setMapLabelLanguage(map: maplibregl.Map, locale: SupportedLocale): void {
  const expr = locale === 'en'
    ? ['coalesce', ['get', 'name:en'], ['get', 'name']]
    : ['coalesce', ['get', `name:${locale}`], ['get', 'name:en'], ['get', 'name']];

  for (const id of ofmLabelIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'text-field', expr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>);
    }
  }
}

on('lang:changed', ({ locale }) => {
  if (state.map) setMapLabelLanguage(state.map, locale);
});

// "Map Labels" checkbox. On Light/Dark/Hydro it hides the OFM text/shield
// layers; on Aerial it hides the whole cloned overlay (roads and boundaries
// included), handing back the untouched photograph. Street and Topo have
// labels baked into their tiles — out of scope.
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

export interface BasemapSelection { basemap: string; labels: boolean; esriSuppressed: boolean }
export interface BasemapLayers {
  rasterDefs: readonly { id: string; basemap: string }[];
  esriIds: readonly string[];
  ofm: Readonly<Record<OfmGroup, readonly string[]>>;
  labelIds: ReadonlySet<string>;
}

// Pure: which basemap layer is visible for a selection. Covers every raster def
// and every grafted OFM layer id, so applying it leaves none stale.
export function basemapVisibility(sel: BasemapSelection, layers: BasemapLayers): Record<string, 'visible' | 'none'> {
  const out: Record<string, 'visible' | 'none'> = {};
  for (const d of layers.rasterDefs) {
    // Esri stays hidden while the latch is tripped; otherwise re-selecting aerial
    // would re-arm a provider known to be failing.
    const suppressed = sel.esriSuppressed && layers.esriIds.includes(d.id);
    const visible = d.basemap === sel.basemap && !suppressed;
    out[d.id] = visible ? "visible" : "none";
  }
  // OFM vector groups (empty arrays until addOfmBasemaps() resolves).
  const ofmActive = ofmStyleForBasemap(sel.basemap);
  for (const key of Object.keys(layers.ofm) as OfmGroup[]) {
    const groupOn = key === ofmActive;
    for (const id of layers.ofm[key]) {
      // Aerial gates as a whole with Map Labels (roads and boundaries hide too,
      // not just text) so the checkbox can hand back the untouched photograph;
      // Light/Dark/Hydro keep their label-only behavior.
      out[id] = key === "aerial"
        ? (groupOn && sel.labels ? "visible" : "none")
        : (groupOn && (sel.labels || !layers.labelIds.has(id)) ? "visible" : "none");
    }
  }
  return out;
}

export function switchBasemap(type: string) {
  state.basemap = type;
  if (!state.mapReady || !state.map) return;
  const vis = basemapVisibility(
    { basemap: type, labels: state.basemapLabels, esriSuppressed: aerialFellBack },
    { rasterDefs: BASEMAP_LAYER_DEFS, esriIds: ESRI_LAYER_IDS, ofm: ofmLayerIds, labelIds: ofmLabelIds },
  );
  for (const [id, v] of Object.entries(vis)) state.map.setLayoutProperty(id, "visibility", v);
  repositionHillshade();
}

// The halo reads as atmosphere while the camera looks down at the planet, and
// spreads into a full-viewport wash as the camera tilts — a ray that grazes the
// limb crosses far more of the shell than one aimed at the ground. Fading it out
// by pitch keeps the effect where it works. Quantised so a pitch drag issues a
// handful of setSky calls rather than one per frame.
const ATMOSPHERE_STEP = 0.05;
let atmosphereBlend = -1;

function syncAtmosphere() {
  if (!state.map) return;
  const fade = 1 - state.map.getPitch() / ATMOSPHERE_FADE_PITCH;
  const wanted = state.projection === 'globe'
    ? Math.round(Math.max(0, fade) * ATMOSPHERE_BLEND / ATMOSPHERE_STEP) * ATMOSPHERE_STEP
    : 0;
  if (wanted === atmosphereBlend) return;
  atmosphereBlend = wanted;
  state.map.setSky({ ...BLANK_STYLE.sky, 'atmosphere-blend': wanted });
}

export function switchProjection(type: string) {
  state.projection = type;
  if (!state.map) return;
  // ponytail: only mercator | globe exist in MapLibre; no enum needed
  state.map.setProjection({ type: type as 'mercator' | 'globe' });
  state.map.getContainer().classList.toggle('projection-globe', type === 'globe');
  syncAtmosphere();
}
