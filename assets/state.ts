// assets/state.ts — Mutable global runtime state singleton and its AppState type.
// Static constants (DATA, tile URLs, EMPTY_FC, etc.) live in ./constants.ts —
// import them from there. Type-only imports, so this module pulls in no code.
import type { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { Condition } from '../src/registry/condition-compile.js';
import type { LayerScope, StyleOverride } from '../src/types.js';
import type { UserLayer } from './user-data/user-data.js';
import type { RasterMeta } from './raster-probes.js';

// State sub-objects
interface MwFilter { min: number; max: number; }
interface YearFilter { enabled: boolean; year: number; min: number; max: number; }
interface YearPlayback { active: boolean; interval: ReturnType<typeof setInterval> | null; speedMs: number; }

export interface AppState {
  map: MaplibreMap | null;
  mapReady: boolean;
  basemap: string;
  basemapLabels: boolean;
  projection: string;
  terrain3d: boolean;
  buildings3d: boolean;
  hillshade: boolean;
  smokeOpacity: number;
  popup: Popup | null;
  layerVisibility: Record<string, boolean>;
  layerFilters: Record<string, Set<string>>;
  where: Record<string, Condition[]>;                // registry id → field conditions (a view section)
  styleOverrides: Record<string, StyleOverride>;     // registry id → look override (a view section)
  userLayers: UserLayer[];
  userLayerCounter: number;
  editMode: string;
  measure: { active: boolean; points: [number, number][]; finished: boolean };
  draw: MapboxDraw | null;
  drawDefaultColor: string;
  selectedDrawId: string | null;
  userHighlightKey: string | null;
  legendFilters: Record<string, Set<string>>; // legendKey → active bucket Set
  mwFilter: MwFilter;
  genMode: Record<string, string>;
  ogfColorBy: "region" | "status"; // OGF planned-lines color-by mode
  westtecColorBy: "scenario" | "dataset"; // WestTEC 10-Yr color-by mode
  weatherVar: string; // Weather Forecast selected variable id — see WEATHER_VARIABLES
  nriHazard: string;  // FEMA National Risk Index hazard shown — an NRI_HAZARDS id
  weatherStepSuffix: string; // scrubbed step's file suffix ("" = base step) — routes the hover LUT fetch
  yearFilter: YearFilter;
  yearPlayback: YearPlayback;
  sourcesLoaded: Record<string, boolean>;
  sourcesData: Record<string, unknown[]>;
  liveFcMeta: Record<string, { generated_utc?: string; feed_status?: Record<string, string>; feed_last_ok?: Record<string, string | null> }>;
  rasterLut: Record<string, { meta: RasterMeta; data: Int16Array }>;
  rasterLutLoading: Record<string, boolean>;
  regionScope: LayerScope;
}

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
  where: {},            // registryId → Condition[] — the view's field conditions
  styleOverrides: {},   // registryId → StyleOverride — the view's per-layer look
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
};
