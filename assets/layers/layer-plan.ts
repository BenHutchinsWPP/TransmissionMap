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
//     filter, which filters.ts's effectiveFilter() builds on.
// Imported by: add-all-layers.ts (applyLayerPlan), layer-init.ts
//              (ensureCountyBoundaries), layer-source.ts (PlanStep type),
//              map-layers-*.ts (LayerPlan type).
// Deps: state.ts (layerVisibility), src/registry/index.ts (LAYERS),
//       base-filters.ts (registerBaseFilter).

import type { FilterSpecification, LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl';
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

export function applyLayerPlan(map: MapLibreMap, plan: LayerPlan) {
  for (const s of plan) {
    if ("source" in s && !map.getSource(s.source)) map.addSource(s.source, s.spec);
  }
  for (const s of plan) {
    if (!("layer" in s) || map.getLayer(s.layer.id)) continue;
    map.addLayer(withVisibility(s.layer), s.beforeId && map.getLayer(s.beforeId) ? s.beforeId : undefined);
    registerBaseFilter(s.layer.id, (s.layer as { filter?: FilterSpecification }).filter ?? null);
  }
}
