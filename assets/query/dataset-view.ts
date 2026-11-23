// ─── Dataset view: what the map shows of a layer ─────────────────────────────
// Role: the map-bound reads of dataset-query.ts, kept apart from the pure core:
//         drawnFilters / drawnView   the filters of the map layers drawn now,
//                                    and what the coverage rules need of them
//         featuresOf                 a GeoJSON layer's whole file, or the loaded
//                                    tiles of every source the layer draws from
//         baseFilters, hiddenTiers   a layer's own filters; the voltage tiers
//                                    the zoom does not draw
// Deps: state.ts, registry (layerById), filters.ts (effectiveFilter),
//       visibility.ts (wantedLayout, modeOf), feature-id.ts (featureId),
//       layers/layer-data.ts (loadSource), layers/layer-source.ts (layerSourceId),
//       layers/base-filters.ts (BASE_LAYER_FILTERS), transmission.ts
//       (OSM_TL_TIERS), dataset-core.ts (withPolygonParts, DrawnView).
// Consumed by: dataset-query.ts (drawnFilters is also read by dataset-query.test.ts).

import type { FilterSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { layerById } from '../../src/registry/index.js';
import { effectiveFilter } from '../filters.js';
import { wantedLayout, modeOf } from '../visibility.js';
import { featureId, type FeatureId } from '../feature-id.js';
import { loadSource } from '../layers/layer-data.js';
import { layerSourceId } from '../layers/layer-source.js';
import { BASE_LAYER_FILTERS } from '../layers/base-filters.js';
import { OSM_TL_TIERS } from '../../src/registry/transmission.js';
import { withPolygonParts, type DrawnView } from './dataset-core.js';

/** The current filters of `layerId`'s map layers that the map shows now
 *  (wantedLayout: a mode-hidden heat or icon layer does not count, nor one
 *  outside its minzoom/maxzoom at the current zoom); [] when the layer is off. */
export function drawnFilters(layerId: string, atZoom = true): (FilterSpecification | null)[] {
  const second = layerById(layerId)?.drawnOnly ?? [];
  return shownMapLayers(layerId).filter(id => !second.includes(id) && (atZoom ? inZoom(id) : drawsFeatures(layerId, id)))
    .map(id => effectiveFilter(id));
}

export function shownMapLayers(layerId: string): string[] {
  const entry = layerById(layerId);
  if (!entry) return [];
  const layout = wantedLayout(entry, !!state.layerVisibility[layerId], modeOf(entry));
  return entry.mapLayerIds.filter(id => layout[id] === 'visible' && state.map?.getLayer(id));
}

export function inZoom(mlId: string): boolean {
  const l = state.map!.getLayer(mlId) as { minzoom?: number; maxzoom?: number };
  const z = state.map!.getZoom();
  return (l.minzoom ?? 0) <= z && z < (l.maxzoom ?? 24);
}

// The features a query reads: the whole GeoJSON file, or the loaded tiles of
// every source the layer draws from, one copy per stable id.
export async function featuresOf(layerId: string, fragments = false): Promise<GeoJSON.Feature[] | string> {
  const entry = layerById(layerId)!;
  if (entry.data!.kind === 'geojson') {
    await loadSource(layerId);
    const src = layerSourceId(layerId);
    return state.sourcesLoaded[src] ? (state.sourcesData[src] ?? []) as GeoJSON.Feature[] : `"${layerId}" could not be loaded`;
  }
  if (!state.map || !state.mapReady) return 'the map is not ready';
  const seen = new Map<FeatureId, number>();
  const out: GeoJSON.Feature[] = [];
  for (const feats of tileFeatures(entry.mapLayerIds)) {
    for (const f of feats) {
      const id = featureId(layerId, f);
      if (id === undefined) continue;
      const at = seen.get(id);
      if (at === undefined) {
        seen.set(id, out.length);
        out.push(f);
      } else if (fragments) out[at] = withPolygonParts(out[at], f);
    }
  }
  return out;
}

/** The loaded-tile features of each source the map layers `mlIds` draw from, one list per source. */
export function* tileFeatures(mlIds: readonly string[]): Generator<GeoJSON.Feature[]> {
  const map = state.map!;
  const sources = new Map<string, string | undefined>();
  for (const id of mlIds) {
    const l = map.getLayer(id) as { source?: string; sourceLayer?: string } | undefined;
    if (l?.source) sources.set(l.source, l.sourceLayer);
  }
  for (const [source, sourceLayer] of sources) {
    let feats: GeoJSON.Feature[] = [];
    try { feats = map.querySourceFeatures(source, sourceLayer ? { sourceLayer } : {}); } catch { /* header still loading */ }
    yield feats;
  }
}

const TIER_IDS = new Set(OSM_TL_TIERS.map(t => t.id));

/** Whether map layer `mlId` draws the layer's own features: any non-symbol
 *  layer, or a symbol layer the registry makes clickable (`clickPriority`:
 *  an icon layer such as osm-gen-circles); a label companion is not, nor a
 *  layer the registry lists in `drawnOnly` (WECC corridors). */
export function drawsFeatures(layerId: string, mlId: string): boolean {
  const def = layerById(layerId);
  if (def?.drawnOnly?.includes(mlId)) return false;
  const type = (state.map?.getLayer(mlId) as { type?: string } | undefined)?.type;
  return type !== 'symbol' || Object.hasOwn(def?.clickPriority ?? {}, mlId);
}

/** The base filters (each map layer's own inline filter, null — pass-all — where
 *  none is registered) of the layer's feature-drawing map layers; undefined when it has none. */
export function baseFilters(layerId: string): (FilterSpecification | null)[] | undefined {
  const ids = (layerById(layerId)?.mapLayerIds ?? []).filter(id => drawsFeatures(layerId, id));
  return ids.length ? ids.map(id => BASE_LAYER_FILTERS[id] ?? null) : undefined;
}

const tierOf = (mlId: string) => { const s = mlId.slice(mlId.lastIndexOf('-') + 1); return TIER_IDS.has(s) ? s : null; };

/** The voltage tiers among `shown` map layers that none of `drawn` (those the zoom reaches) draws; undefined for a layer with no tiers. */
export function hiddenTiers(shown: string[], drawn: string[]): string[] | undefined {
  if (!shown.some(tierOf)) return undefined;
  const on = new Set(drawn.map(tierOf));
  return OSM_TL_TIERS.map(t => t.id).filter(t => !on.has(t) && shown.some(id => tierOf(id) === t));
}

/** What the map shows of `layerId` for the asDrawn coverage notes; undefined unless the call is asDrawn. */
export function drawnView(layerId: string, opts: { asDrawn?: boolean }): DrawnView | undefined {
  if (!opts.asDrawn) return undefined;
  const visible = !!state.layerVisibility[layerId];
  return { visible, drawn: visible ? drawnFilters(layerId).length : 0, shown: visible ? shownMapLayers(layerId).length : 0,
    zoom: state.map?.getZoom() ?? 0 };
}
