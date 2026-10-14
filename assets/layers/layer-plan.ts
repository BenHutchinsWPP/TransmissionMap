// ─── Layer plans: what a builder adds, and the one step that adds it ─────────
// Every builder (layer-init.ts helpers, map-layers-*.ts plan* functions) returns
// a LayerPlan — its sources and style layers, layers in paint order — and never
// touches the map. applyLayerPlan() is the only place a plan reaches MapLibre:
//   - every source first, skipping one already on the map (a registry layer's
//     source comes credited from layer-source.ts's layerSource());
//   - then every layer in order, skipping one already on the map, placed before
//     `beforeId` when the map has that layer (on top otherwise);
//   - a layer that pins no `layout.visibility` starts as its registry layer is
//     in state: the one listing it in mapLayerIds, else the one sharing its id
//     (off when neither exists). Builders pin "none" only on display-mode
//     siblings (heat layers, data-centre point twins) that applyGenMode shows;
//   - each layer's own `filter` (null without one) registered as its base
//     filter, which filters.ts's effectiveFilter() builds on;
//   - a tiled source (vector/raster with a `url`) none of the plan's layers
//     starts drawing is added without its url, so its archive is not read
//     until a layer on it is first shown. setMapLayerVisibility() is the one
//     way to show a map layer: on a held source it sets the url, and the
//     source's layers wait hidden until its metadata lands (the last
//     visibility asked of each wins).
// Imported by: add-all-layers.ts (applyLayerPlan), layer-init.ts
//              (ensureCountyBoundaries), layer-source.ts (PlanStep type),
//              map-layers-*.ts (LayerPlan type), ../visibility.ts,
//              ../nws-zone-join.ts and ../user-data/user-data-draw.ts
//              (setMapLayerVisibility).
// Deps: state.ts (layerVisibility), src/registry/index.ts (LAYERS),
//       base-filters.ts (registerBaseFilter).

import type { FilterSpecification, LayerSpecification, Map as MapLibreMap, RasterTileSource, SourceSpecification, VectorTileSource } from 'maplibre-gl';
import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import { registerBaseFilter } from './base-filters.js';

export type PlanStep =
  | { source: string; spec: SourceSpecification }
  | { layer: LayerSpecification; beforeId?: string };

export type LayerPlan = PlanStep[];

// Style-layer id → the registry layer whose switch it follows.
const OWNER = new Map(LAYERS.flatMap(l => l.mapLayerIds.map(id => [id, l.id] as const)));

function withVisibility(layer: LayerSpecification): LayerSpecification {
  const layout = (layer as { layout?: Record<string, unknown> }).layout;
  if (layout?.visibility !== undefined) return layer;
  const on = state.layerVisibility[OWNER.get(layer.id) ?? layer.id];
  return { ...layer, layout: { visibility: on ? "visible" : "none", ...layout } } as LayerSpecification;
}

type Visibility = "visible" | "none";

// Tiled sources no layer has been shown on yet: source id → its url.
const heldUrls = new Map<string, string>();
// Sources loading their metadata → the visibility last asked of each of their layers.
const revealing = new Map<string, Map<string, Visibility>>();

const visibilityOf = (layer: LayerSpecification) =>
  (layer as { layout?: { visibility?: Visibility } }).layout?.visibility;
const sourceOf = (layer: unknown) => (layer as { source?: string } | undefined)?.source;

export function applyLayerPlan(map: MapLibreMap, plan: LayerPlan) {
  const layers = plan.flatMap(s => "layer" in s ? [{ layer: withVisibility(s.layer), beforeId: s.beforeId }] : []);
  const drawn = new Set(layers.filter(s => visibilityOf(s.layer) === "visible").map(s => sourceOf(s.layer)));
  for (const s of plan) {
    if (!("source" in s) || map.getSource(s.source)) continue;
    const { url, ...held } = s.spec as SourceSpecification & { url?: string };
    if ((held.type === "vector" || held.type === "raster") && url && !drawn.has(s.source)) {
      heldUrls.set(s.source, url);
      map.addSource(s.source, held);
    } else {
      map.addSource(s.source, s.spec);
    }
  }
  for (const { layer, beforeId } of layers) {
    if (map.getLayer(layer.id)) continue;
    const source = sourceOf(layer);
    const wait = visibilityOf(layer) === "visible" && !!source && (heldUrls.has(source) || revealing.has(source));
    const hidden = { ...layer, layout: { ...(layer as { layout?: object }).layout, visibility: "none" } } as LayerSpecification;
    map.addLayer(wait ? hidden : layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    registerBaseFilter(layer.id, (layer as { filter?: FilterSpecification }).filter ?? null);
    if (wait) setMapLayerVisibility(map, layer.id, "visible");
  }
}

/** Show or hide map layer `id`. Showing the first layer on a held source sets
 *  its url; that source's layers then wait hidden until its metadata lands
 *  (and stay hidden, the source held for the next try, if it fails to load). */
export function setMapLayerVisibility(map: MapLibreMap, id: string, v: Visibility) {
  const source = sourceOf(map.getLayer(id));
  const waiting = source ? revealing.get(source) : undefined;
  if (waiting) { waiting.set(id, v); return; }
  const url = source && v === "visible" ? heldUrls.get(source) : undefined;
  if (!source || !url) { map.setLayoutProperty(id, "visibility", v); return; }
  heldUrls.delete(source);
  revealing.set(source, new Map([[id, v]]));
  const done = (e: { type: string; sourceId?: string; sourceDataType?: string }) => {
    if (e.sourceId !== source || (e.type === "sourcedata" && e.sourceDataType !== "metadata")) return;
    map.off("sourcedata", done);
    map.off("error", done);
    const wanted = revealing.get(source)!;
    revealing.delete(source);
    if (e.type === "error") { heldUrls.set(source, url); return; }
    for (const [layerId, vis] of wanted) if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis);
  };
  map.on("sourcedata", done);
  map.on("error", done);
  (map.getSource(source) as VectorTileSource | RasterTileSource).setUrl(url);
}
