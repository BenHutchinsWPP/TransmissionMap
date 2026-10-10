// ─── Base-filter registry: each MapLibre layer's own inline filter ───────────
// registerBaseFilter() records the filter a builder gave a style layer, so
// filters.ts's effectiveFilter() can rebuild base ∧ applier ∧ where from it.
// Imported by: layer-plan.ts (registerBaseFilter, once per planned layer),
//              filters.ts (BASE_LAYER_FILTERS).
// Deps: none at runtime (type-only maplibre-gl import), so layer-plan.ts and
//       filters.ts can both import it without forming a cycle.

import type { FilterSpecification } from 'maplibre-gl';

export const BASE_LAYER_FILTERS: Record<string, FilterSpecification | null> = {};

// applyLayerPlan() calls this for every layer it adds, with the spec's own filter.
export function registerBaseFilter(layerId: string, filter: FilterSpecification | null) {
  BASE_LAYER_FILTERS[layerId] = filter ?? null;
}
