// Shared registry and view types: LayerDef and the shapes it carries (ramps,
// buckets, scopes, downloads), FuelEntry, LayerSourceDef, StyleOverride and
// BucketedField (the legend facet record), LayerData (where a layer's data lives)
// and FeatureIdDecl (which column is each feature's stable id).
// Types with a single owning module live beside it instead: AppState in
// assets/state.ts, UserLayer in assets/user-data/user-data.ts, RasterMeta in
// assets/raster-probes.ts. Imports only the DATA type from assets/constants.ts.

import type { DATA } from '../assets/constants.js';

// Per-layer look override in a view: opacity and size are multipliers on the layer's own values, color a literal.
export interface StyleOverride { opacity?: number; size?: number; color?: string }

interface Downloads {
  csv?: string | null;      // point layers — CSV-only pack
  geojson?: string | null;  // line/polygon layers — GeoJSON pack (also holds CSV)
  shp?: string | null;      // line/polygon layers — Shapefile pack (also holds CSV)
  tif?: string | null;      // raster layers — GeoTIFF pack
}

export interface RampDef {
  stops: (number | string)[][];
  min?: number;   // ramp floor — defaults to 0; set it when values go negative (temperature)
  max: number;
  unit?: string;
  minLabel?: string;
  maxLabel?: string;
  // Formats both legend end labels, so a ramp whose unit follows the user's
  // preference states that unit once. Called per render, so it picks up a
  // preference change; the top end gets "+" to mark the clamp.
  fmt?: (v: number, mark?: string) => string;
}

export interface BucketDef {
  id: string;
  label: string;
  color: string;
  urlCode: string;
  default?: boolean;
  values?: string[];
  icon?: string;
}

// A legend facet: one categorical field the user filters with checkbox chips,
// carried in a shared link under `groupCode` (one `urlCode` per bucket). Pure
// data, declared in src/colors/facets.ts; the applier that turns the active
// set into a map filter lives in assets/filters.ts.
export interface BucketedField {
  key: string;          // state.legendFilters key
  groupCode: string;    // URL param char
  // Feature property the buckets match. Absent when each registry layer names
  // its own (kv, fuel: LayerDef.filterField) or the match is an expression
  // (underground).
  field?: string;
  buckets: BucketDef[];
  // The bucket set the "all" checkbox and defaults count, when it differs from
  // the displayed `buckets` (kv: same ids, plain labels).
  syncBuckets?: BucketDef[];
  // Map layers the filter writes; `layerRef` names a registry layer whose
  // mapLayerIds to use instead. Both absent when the registry layers are picked
  // by filterType/group in the applier.
  mapLayerIds?: string[];
  layerRef?: string;
  defaultActive?: string[];   // bucket ids on in the default view (all when absent)
  title: string;              // fallback when titleKey has no translation
  titleKey: string;
  swatch: "color" | "line" | "icon" | "none";
  // DOM ids default to `${key}AllCb` and `${key}Legend`; the item list is
  // always `${legendId}Items`.
  masterId?: string;
  legendId?: string;
}

// What the region selector scopes: which layers the panel lists. Map data is
// one planet-wide tileset per layer, so this never reloads a source.
//   'usa'    — everything, US-only datasets included (the default)
//   'global' — only layers with worldwide coverage; US-only ones are hidden
export type LayerScope = 'usa' | 'global';

// Which continental download pack a button points at. Independent of LayerScope:
// packs stay per continent because a pack is a file someone opens in QGIS.
export type DownloadRegion =
  | 'north-america'
  | 'europe'
  | 'asia'
  | 'south-america'
  | 'africa'
  | 'oceania'
  | 'central-america'
  | 'antarctica';

export interface FuelEntry {
  id: string;
  urlCode: string;
  label: string;
  color: string;
  icon: string;
  osmBucket: string;
  eiaBucket: string;
  osmValues: string[];   // OSM `source` values classed as this fuel
  eiaCodes: string[];    // EIA Form 860 `energy_source` codes classed as this fuel
  // OSM values that draw with their own icon and colour while filtering as this fuel.
  osmStyle?: Record<string, { icon: string; color: string }>;
}

export type DataKey = keyof typeof DATA;

// A registry layer's data declaration; assets/layers/layer-source.ts turns it
// into the MapLibre source. Layers declaring the same `key` share one source,
// named after the first of them in LAYERS.
export interface LayerData {
  // pmtiles: vector tiles; raster: raster tiles (256 px); geojson: a file
  // ensureLayerData() fetches into an empty source on first enable.
  kind: "pmtiles" | "raster" | "geojson";
  key: DataKey;     // DATA path (assets/constants.ts)
  credit: string;   // attribution HTML, shown while the source's layers are visible
  // The stable feature id: the same value for the same real-world feature
  // across rebuilds. Mirrors the layer's `id_field` / `native_id` in
  // scripts/tile_manifest.yaml (assets/feature-id.test.ts holds them together);
  // assets/feature-id.ts's featureId() reads it.
  id?: FeatureIdDecl;
}

// `field` is the column carrying the id. Without `native`, layer-source.ts sets
// the source's `promoteId` to it (a string or number property). With `native`,
// tippecanoe consumed the integer column into the MVT feature id
// (--use-attribute-for-id), so the tile carries no such property and the source
// needs no promoteId. OSM layers use `fid` = osm_id × 10 + type digit (1 node,
// 2 way, 3 relation); assets/feature-id.ts's osmRef() decodes it.
export interface FeatureIdDecl { field: string; native?: true }

export interface LayerDef {
  id: string;
  urlCode: string;
  label: string;
  titleKey: string;
  group: string;
  sourceId: string;
  // FIELD_SCHEMA key (src/registry/field-schema.ts) naming the fields this layer's features carry.
  dataset?: string;
  // Where this layer's map source gets its data, and who it credits. Absent for
  // a layer whose builder owns its source outright (external tiles, the weather
  // image, the shared county boundaries).
  data?: LayerData;
  swatch: string;
  live?: boolean;
  defaultOn: boolean;
  // left out of the layers panel; the layer still loads from a URL or experience
  hidden?: boolean;
  mapLayerIds: string[];
  downloads: Downloads;
  regions?: LayerScope[];
  // optional feature flags
  fuelLayer?: boolean;
  voltageLayer?: boolean;
  heatLayerId?: string;
  genModeCode?: string;
  // Custom display-mode set (overrides the default Icons/Heatmap/Both):
  // each mode names the mapLayerIds visible while it is active.
  modes?: { id: string; label: string; layers: string[] }[];
  defaultMode?: string;
  filterType?: string;
  filterField?: string;
  yearFilterLayer?: boolean;
  bucketField?: string;
  filterGroupCode?: string;
  filterBuckets?: BucketDef[];
  ramp?: RampDef;
  ogfStatusLayer?: boolean;
  westtecColorLayer?: boolean;
  weatherVarLayer?: boolean;
  nriHazardLayer?: boolean;
  // Layers sharing a group are shown one at a time: switching one on switches
  // the others off (assets/visibility.ts). Used for the county choropleths.
  exclusiveGroup?: string;   // FEMA NRI: one row, hazard picked from NRI_HAZARDS (src/registry/conditions.ts)
  pipelineLayer?: boolean;
  hoverField?: string;
  lineHighlightKeys?: string[];
  // Maps each layer id to its click hit-test priority: higher numbers tested
  // first when overlapping features exist. Only clickable layers, not heat/label/casing.
  clickPriority?: Record<string, number>;
  // Minimum zoom level to fetch this layer's data; absent means fetch when visible.
  fromZoom?: number;
}

export interface LayerSourceDef {
  label: string;
  tooltip: string;
}
