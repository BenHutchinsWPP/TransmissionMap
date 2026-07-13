// assets/state.ts — Mutable global runtime state singleton + re-exports of
// static constants from ./constants.ts (DATA, tile URLs, EMPTY_FC, etc.).
// Import both state and constants from this file; do not import constants.ts directly.
import type { AppState } from '../src/types.js';

export {
  USER_LAYER_COLORS, USER_FEATURE_THRESHOLD,
  DATA,
  OSM_TILE_URL, AERIAL_TILE_URL, USGS_AERIAL_TILE_URL,
  CARTO_LIGHT_TILE_URLS, CARTO_DARK_TILE_URLS, CARTO_VOYAGER_TILE_URLS,
  USGS_TOPO_TILE_URL, RADAR_TILE_TEMPLATE, RADAR_TILE_URL, RADAR_TMS_JSON_URL,
  GEOMET_RADAR_TILE_TEMPLATE,
  BLANK_STYLE, EMPTY_FC, SOURCE_ATTRIB,
  DEFAULT_CENTER, DEFAULT_ZOOM,
} from './constants.js';

// ─── Global runtime state ────────────────────────────────────────────────────
export const state: AppState = {
  map: null,
  mapReady: false,
  basemap: "street",    // "street" | "light" | "dark" | "voyager" | "topo" | "aerial"
  projection: "mercator", // "mercator" | "globe"
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
  ogfColorBy: "status", // OGF planned-lines color-by: "status" | "scenario" | "planauth"
  yearFilter:   { enabled: false, year: 2025, min: 1900, max: 2031 }, // EIA "alive at year Y"; bounds set in init()
  yearPlayback: { active: false, interval: null, speedMs: 600 },        // year-scrub animation
  sourcesLoaded: {},    // registryId → boolean — tracks which GeoJSON sources have been fetched
  sourcesData:   {},    // registryId → Feature[] — in-memory cache of fetched GeoJSON features
  liveFcMeta:    {},    // registryId → { generated_utc?, feed_status? } — FeatureCollection-level metadata stash (fallback when features[] is empty, e.g. zero-alert NWS feeds)
  rasterLut:        {}, // raster layer id → { meta, data:Int16Array } — hover value grids (wind/solar)
  rasterLutLoading: {}, // raster layer id → boolean — guards concurrent LUT fetches
};
