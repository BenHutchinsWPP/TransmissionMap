// ─── Base-filter registry: each MapLibre layer's own inline filter ───────────
// registerBaseFilter() records the filter a builder gave a style layer, so
// filters.ts's effectiveFilter() can rebuild base ∧ applier ∧ where from it.
// Imported by: map-layers-*.ts and layer-init.ts (registerBaseFilter),
//              filters.ts (BASE_LAYER_FILTERS).
// Deps: none at runtime (type-only maplibre-gl import), so builders and
//       filters.ts can both import it without forming a cycle.

import type { FilterSpecification } from 'maplibre-gl';

export const BASE_LAYER_FILTERS: Record<string, FilterSpecification | null> = {};

// Must be called once per MapLibre layer ID immediately after map.addLayer().
// Integration contract between layer renderers (map-layers-*.ts) and the
// filter/visibility system — every add*Layer() call must register here.
export function registerBaseFilter(layerId: string, filter: FilterSpecification | null) {
  BASE_LAYER_FILTERS[layerId] = filter ?? null;
}
