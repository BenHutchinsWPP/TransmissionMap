// Shared registry and view types: LayerDef and the shapes it carries (ramps,
// buckets, scopes, downloads), FuelEntry, LayerSourceDef and StyleOverride.
// Types with a single owning module live beside it instead: AppState in
// assets/state.ts, UserLayer in assets/user-data/user-data.ts, RasterMeta in
// assets/raster-probes.ts. Imports nothing.

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
}

export interface LayerDef {
  id: string;
  urlCode: string;
  label: string;
  titleKey: string;
  group: string;
  sourceId: string;
  // FIELD_SCHEMA key (src/registry/field-schema.ts) naming the fields this layer's features carry.
  dataset?: string;
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
