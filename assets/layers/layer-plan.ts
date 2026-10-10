// ─── Layer plans: what a builder adds, and the one step that adds it ─────────
// Every builder (layer-init.ts helpers, map-layers-*.ts plan* functions) returns
// a LayerPlan — its sources and style layers, layers in paint order — and never
// touches the map. applyLayerPlan() is the only place a plan reaches MapLibre:
//   - every source first, skipping one already on the map, with its attribution
//     from SOURCE_ATTRIB (keyed by `attrib`, else the source id) unless the spec
//     carries its own;
//   - then every layer in order, skipping one already on the map, placed before
//     `beforeId` when the map has that layer (on top otherwise);
//   - each layer's own `filter` (null without one) registered as its base
//     filter, which filters.ts's effectiveFilter() builds on.
// Imported by: add-all-layers.ts (applyLayerPlan), layer-init.ts
//              (ensureCountyBoundaries), map-layers-*.ts (LayerPlan type).
// Deps: constants.ts (SOURCE_ATTRIB), base-filters.ts (registerBaseFilter).

import type { FilterSpecification, LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl';
import { SOURCE_ATTRIB } from '../constants.js';
import { registerBaseFilter } from './base-filters.js';

export type PlanStep =
  | { source: string; spec: SourceSpecification; attrib?: string }
  | { layer: LayerSpecification; beforeId?: string };

export type LayerPlan = PlanStep[];

export function applyLayerPlan(map: MapLibreMap, plan: LayerPlan) {
  for (const s of plan) {
    if (!("source" in s) || map.getSource(s.source)) continue;
    const attribution = SOURCE_ATTRIB[s.attrib ?? s.source];
    map.addSource(s.source, attribution && !("attribution" in s.spec)
      ? { ...s.spec, attribution } as SourceSpecification : s.spec);
  }
  for (const s of plan) {
    if (!("layer" in s) || map.getLayer(s.layer.id)) continue;
    map.addLayer(s.layer, s.beforeId && map.getLayer(s.beforeId) ? s.beforeId : undefined);
    registerBaseFilter(s.layer.id, (s.layer as { filter?: FilterSpecification }).filter ?? null);
  }
}
