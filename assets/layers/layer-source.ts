// ─── Layer sources: a registry layer's data declaration → its MapLibre source ─
// A LayerDef's `data` ({ kind, key, credit }, src/types.ts) says where the
// layer's data lives and who it credits; this module turns that into the source
// a builder plans (layerSource), the GeoJSON URL the lazy loader fetches
// (layerDataUrl) and the source a registry id draws from (layerSourceId:
// layers declaring the same DATA key share the first one's source).
// Imported by: layer-init.ts (layerSource, pmtilesUrl), map-layers-*.ts (layerSource),
//              layer-data.ts (layerDataUrl, layerSourceId),
//              ../nws-zone-join.ts (pmtilesUrl).
// Deps: constants.ts (DATA, EMPTY_FC), layer-plan.ts (PlanStep type),
//       src/registry/index.ts (LAYERS, layerById), src/types.ts (LayerData, DataKey).

import type { SourceSpecification } from 'maplibre-gl';
import { DATA, EMPTY_FC } from '../constants.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import type { DataKey, LayerData } from '../../src/types.js';
import type { PlanStep } from './layer-plan.js';

/** The pmtiles:// URL of a DATA archive. Registry layers get it through
 *  layerSource(); this is for the shared join sources no registry layer owns. */
export function pmtilesUrl(key: DataKey): string {
  return "pmtiles://" + new URL(DATA[key], location.href).href;
}

function sourceSpec(kind: LayerData["kind"], key: DataKey): SourceSpecification {
  if (kind === "geojson") return { type: "geojson", data: EMPTY_FC };
  const url = pmtilesUrl(key);
  return kind === "raster" ? { type: "raster", url, tileSize: 256 } : { type: "vector", url };
}

/** The plan step adding registry layer `registryId`'s source, credited.
 *  `id` and `key` override the source id and file for a layer spread over
 *  several sources (the OSM voltage bands, the WECC highlight lines); `spec`
 *  adds builder-specific source options (clustering). */
export function layerSource(registryId: string,
                            { id = registryId, key, spec }: { id?: string; key?: DataKey; spec?: object } = {}): PlanStep {
  const data = layerById(registryId)?.data;
  if (!data) throw new Error(`layerSource: ${registryId} declares no data`);
  return { source: id, spec: { ...sourceSpec(data.kind, key ?? data.key), ...spec, attribution: data.credit } as SourceSpecification };
}

// Registry ids drawing from a source that is not their own and not found by a
// shared DATA key. Layers that declare the same data are found by layerSourceId().
const LAYER_SOURCE_ALIAS: Record<string, string> = {
  // weather-live's own source is an image; enabling it lazily loads the
  // white admin-border lines drawn above the wash instead.
  "weather-live":       "weather-admin-lines",
  // petroleum facilities share the HIFLD points source (split by fac_type base
  // filter); the registry entry is commented out in src/registry/pipelines.ts.
  "hifld-petroleum-facilities": "hifld-natgas-points",
};

/** The source a registry id's data loads into: an alias row, else the first
 *  layer in LAYERS declaring the same DATA key, else the id itself. */
export function layerSourceId(registryId: string): string {
  const key = layerById(registryId)?.data?.key;
  return LAYER_SOURCE_ALIAS[registryId] ?? (key && LAYERS.find(l => l.data?.key === key)?.id) ?? registryId;
}

// GeoJSON sources the loader fills that are not registry layers.
export const SOURCE_DATA_URLS: Record<string, string> = {
  "wecc-path-lines":     DATA.wecc_path_lines,  // fetched by map-layers-wecc.ts for the click highlight
  "weather-admin-lines": DATA.admin_lines,      // loaded via the weather-live alias above
};

/** The GeoJSON URL ensureLayerData() fetches into source `sourceId`, if any:
 *  its registry entry's geojson `data`, else a SOURCE_DATA_URLS row. */
export function layerDataUrl(sourceId: string): string | undefined {
  const data = layerById(sourceId)?.data;
  return data ? (data.kind === "geojson" ? DATA[data.key] : undefined) : SOURCE_DATA_URLS[sourceId];
}
