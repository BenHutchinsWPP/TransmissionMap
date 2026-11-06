// ─── Which copy a layer offers (boot-bundle safe) ────────────────────────────
// Role: `copyMode(layerId)` — 'full' (a layer with `data.analysis`: full geometry
//       from its GeoParquet files), 'point' (a tiled point layer with a columns
//       file), 'exact' (a GeoJSON layer without `data.analysis`) or 'none' — and `copyNoun`: 'line' for
//       line geometry from the geometry files, else 'feature'. Pure registry
//       lookups, so popup.ts (boot bundle) and the lazy copy-rows.ts agree on
//       what a layer's Copy is. A GeoJSON layer with `data.analysis` (NERC regions,
//       EIA and HIFLD balancing authorities, US states, countries, admin-1, tribal
//       lands, BIA tribal lands, BOEM wind leases) is 'full': its table and chat copy
//       are hidden until index.json answers; only the edit-mode click falls back to
//       the source data. Counties, ZIP code areas, utility territories and railroads
//       are 'full' tiled layers.
// Deps: src/registry (layerById, FIELD_SCHEMA, COLUMNS_DATASETS, field-roles rolesOf).
//       Imported by: popup.ts, user-data/copy-rows.ts.

import { layerById } from '../../src/registry/index.js';
import { FIELD_SCHEMA } from '../../src/registry/field-schema.js';
import { COLUMNS_DATASETS } from '../../src/registry/columns.js';
import { rolesOf } from '../../src/registry/field-roles.js';

export type CopyMode = 'full' | 'point' | 'exact' | 'none';

export function copyMode(layerId: string): CopyMode {
  const l = layerById(layerId);
  if (!l?.dataset || !Object.hasOwn(FIELD_SCHEMA, l.dataset) || !l.data?.id) return 'none';
  if (l.data.analysis) return 'full';
  if (l.data.kind === 'geojson') return 'exact';
  const columns = (COLUMNS_DATASETS as readonly string[]).includes(l.dataset);
  return l.data.kind === 'pmtiles' && columns && rolesOf(layerId)?.geometry === 'point' ? 'point' : 'none';
}

/** The wording of a layer's copy: 'line' for line geometry from the geometry files, else 'feature'. */
export function copyNoun(layerId: string): 'line' | 'feature' {
  return copyMode(layerId) === 'full' && rolesOf(layerId)?.geometry === 'line' ? 'line' : 'feature';
}
