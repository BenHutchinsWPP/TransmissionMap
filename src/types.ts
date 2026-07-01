// Central shared type definitions for src/ modules.
import type { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';

export interface Downloads {
  zip?: string | null;   // ZIP download (relative path)
  url?: string | null;   // external source link (opens in new tab)
}

export interface RampDef {
  stops: (number | string)[][];
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
  filterType?: string;
  filterField?: string;
  yearFilterLayer?: boolean;
  bucketField?: string;
  filterGroupCode?: string;
  filterBuckets?: BucketDef[];
  rasterLayer?: boolean;
  ramp?: RampDef;
  ogfStatusLayer?: boolean;
  natgasLineLayer?: boolean;
  natgasPtsLayer?: boolean;
  pipelineLayer?: boolean;
  nercLayer?: boolean;
  retailLayer?: boolean;
  hoverField?: string;
  lineHighlightKeys?: string[];
}

export interface LayerSourceDef {
  label: string;
  tooltip: string;
  creditId: string;
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
  yearFilter: YearFilter;
  yearPlayback: YearPlayback;
  sourcesLoaded: Record<string, boolean>;
  sourcesData: Record<string, unknown[]>;
  rasterLut: Record<string, { meta: RasterMeta; data: Int16Array }>;
  rasterLutLoading: Record<string, boolean>;
}
