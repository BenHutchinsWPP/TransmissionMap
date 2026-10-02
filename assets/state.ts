// assets/state.ts — Mutable global runtime state singleton.
// Static constants (DATA, tile URLs, EMPTY_FC, etc.) live in ./constants.ts —
// import them from there.
import type { AppState } from '../src/types.js';

// ─── Global runtime state ────────────────────────────────────────────────────
export const state: AppState = {
  map: null,
  mapReady: false,
  basemap: "light",     // "street" | "light" | "dark" | "topo" | "aerial" | "hydro"
  basemapLabels: true,  // OFM text/symbol layers on light/dark/hydro; the whole roads/places overlay on aerial
  projection: "mercator", // "mercator" | "globe"
  terrain3d: false,     // raised ground plane (raster-dem elevation)
  buildings3d: false,   // extruded OFM building footprints (z14+)
  hillshade: false,     // shaded relief over the basemap (2D, no tilt)
  smokeOpacity: 1,      // relative opacity for smoke fill and outline layers
  popup: null,
  layerVisibility: {},  // registryId → boolean (initialised from LAYERS[].defaultOn)
  layerFilters: {},     // registryId → Set<bucketId> (non-generator layers only)
  userLayers: [],       // Array<UserLayer> — drawn + loaded file layers
  userLayerCounter: 0,  // monotonic id counter
  editMode: 'view',     // 'view' | 'edit'
  measure: { active: false, points: [], finished: false }, // linear-distance tool
  draw: null,           // MapboxDraw instance
  drawDefaultColor: '#f97316', // color applied to newly drawn features
  selectedDrawId: null,  // id of the drawn feature currently selected in edit mode
  userHighlightKey: null, // id/uid of the user feature highlighted from My Data
  legendFilters:       {},    // legendKey → Set<bucketId>  — keyed by LEGEND_FILTERS[].key; init in init()
  mwFilter: { min: 0, max: 10000 }, // global MW range filter for all generator layers
  genMode: {},          // registryId → "icons" | "heat" | "both" (heat-capable gen layers); init in init()
  ogfColorBy: "region", // OGF planned-lines color-by: "region" | "status"
  westtecColorBy: "scenario", // WestTEC 10-Yr color-by: "scenario" | "dataset"
  weatherVar: "tempwind", // Weather Forecast selected variable id — see WEATHER_VARIABLES
  nriHazard: "RISK",     // FEMA National Risk Index hazard shown — an NRI_HAZARDS id
  weatherStepSuffix: "", // scrubbed step's file suffix ("" = base step) — routes the hover LUT fetch
  yearFilter:   { enabled: false, year: 2025, min: 1900, max: 2031 }, // EIA "alive at year Y"; bounds set in init()
  yearPlayback: { active: false, interval: null, speedMs: 600 },        // year-scrub animation
  sourcesLoaded: {},    // registryId → boolean — tracks which GeoJSON sources have been fetched
  sourcesData:   {},    // registryId → Feature[] — in-memory cache of fetched GeoJSON features
  liveFcMeta:    {},    // registryId → { generated_utc?, feed_status? } — FeatureCollection-level metadata stash (fallback when features[] is empty, e.g. zero-alert NWS feeds)
  rasterLut:        {}, // raster layer id → { meta, data:Int16Array } — hover value grids (wind/solar)
  rasterLutLoading: {}, // raster layer id → boolean — guards concurrent LUT fetches
  regionScope:      'usa', // layer-list scope: 'usa' (all layers) | 'global' (worldwide layers only)
  // Map Experiences — see assets/experiences.ts. `experiencePristine` is the
  // URL param string as the experience left it; writeUrlState() compares each
  // later write against it to notice the user has taken the view somewhere else.
  experienceId:       null,
  experienceDirty:    false,
  experiencePristine: null,
};

// Re-arms the pristine snapshot so the NEXT writeUrlState() becomes the new
// reference point. Anything that changes a shared param without the reader
// asking for it — the stale-feed kill switch switching a layer off, a language
// change — calls this, or url-state.ts's diff reads it as them editing their
// way out of an active Map Experience. Lives here rather than in url-state.ts
// so callers don't pull the URL codec in behind it.
export function rebaselineExperience() {
  if (state.experienceId && !state.experienceDirty) state.experiencePristine = null;
}
