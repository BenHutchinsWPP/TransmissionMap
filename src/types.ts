// Central shared type definitions for src/ modules.
import type { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';

export interface Downloads {
  csv?: string | null;      // point layers — CSV-only pack
  geojson?: string | null;  // line/polygon layers — GeoJSON pack (also holds CSV)
  shp?: string | null;      // line/polygon layers — Shapefile pack (also holds CSV)
  tif?: string | null;      // raster layers — GeoTIFF pack
  url?: string | null;      // external source link (opens in new tab)
}

export interface RampDef {
  stops: (number | string)[][];
  min?: number;   // ramp floor — defaults to 0; set it when values go negative (temperature)
  max: number;
  unit?: string;
  minLabel?: string;
  maxLabel?: string;
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
  group: string;
  sourceId: string;
  swatch: string;
  live?: boolean;
  defaultOn: boolean;
  mapLayerIds: string[];
  downloads: Downloads;
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
  pipelineLayer?: boolean;
  hoverField?: string;
  lineHighlightKeys?: string[];
}

export interface LayerSourceDef {
  label: string;
  tooltip: string;
}

// State sub-objects
export interface MwFilter { min: number; max: number; }
export interface YearFilter { enabled: boolean; year: number; min: number; max: number; }
export interface YearPlayback { active: boolean; interval: ReturnType<typeof setInterval> | null; speedMs: number; }


export interface UserLayer {
  id: string;
  filename: string;
  geojson: GeoJSON.FeatureCollection;
  visible: boolean;
  color: string;
  expanded?: boolean;
}

export interface RasterMeta {
  west: number;
  north: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
  nodata: number;
  scale: number;
}

export interface AppState {
  map: MaplibreMap | null;
  mapReady: boolean;
  basemap: string;
  basemapLabels: boolean;
  projection: string;
  popup: Popup | null;
  layerVisibility: Record<string, boolean>;
  layerFilters: Record<string, Set<string>>;
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
  ogfColorBy: "status" | "scenario" | "planauth"; // OGF planned-lines color-by mode
  westtecColorBy: "scenario" | "dataset"; // WestTEC 10-Yr color-by mode
  weatherVar: string; // Weather Forecast selected variable id — see WEATHER_VARIABLES
  weatherStepSuffix: string; // scrubbed step's file suffix ("" = base step) — routes the hover LUT fetch
  yearFilter: YearFilter;
  yearPlayback: YearPlayback;
  sourcesLoaded: Record<string, boolean>;
  sourcesData: Record<string, unknown[]>;
  liveFcMeta: Record<string, { generated_utc?: string; feed_status?: Record<string, string>; feed_last_ok?: Record<string, string | null> }>;
  rasterLut: Record<string, { meta: RasterMeta; data: Int16Array }>;
  rasterLutLoading: Record<string, boolean>;
}
