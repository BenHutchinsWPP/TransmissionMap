// Declarative per-dataset field schema: for each dataset built by
// scripts/tile_manifest.yaml, the fields a filter UI or query builder can
// safely target, their type, the comparison operators that make sense for
// them, and — where the domain is closed — the exact codes/categories a
// value can take.
//
// Pure data plus its types; no runtime logic. src/registry/condition-compile.ts
// compiles a condition array against this schema into a MapLibre filter
// expression, and assets/filters.ts routes seven live legend filters through
// it (see BUCKET_FILTER_DATASETS). Dataset keys are the `id` values from
// scripts/tile_manifest.yaml; field keys are drawn from that dataset's
// `select:` list, so every entry here has a build-time guarantee the field
// reaches the tiles/GeoJSON the frontend reads.
//
// Deps: src/colors/buckets.ts, for the four closed value-sets it already
// exports (substance, NERC code, retail territory type, EIA sector) — kept
// in sync with the legend filters and their map colors by construction
// instead of a second, driftable copy.
//
// A few filters keep their own bespoke builders in assets/filters.ts instead
// of a schema entry here: the pumped-storage carve-out, the year filter's
// NA→0/9999 sentinel handling, the kV bucket ranges, the underground
// negation, and the NWS group filter's feature-state half.
//
// Also left out: fields on datasets with no `select:` allow-list in
// tile_manifest.yaml (padus `desig`, tribal_lands `area_type`, crithab
// `listing_st`, osm_pipelines_points `pipeline`, ogf_planned_transmission
// and westtec_10yr's fields) — those datasets keep every column, so there is
// no allow-list for a schema key to line up against. The `mines` layer
// (MSHA) and NWS live-alert `_group` field aren't built via
// tile_manifest.yaml at all.

import { SUBSTANCE_MAP, NERC_MAP, RETAIL_TYPE_MAP, SECTOR_MAP } from '../colors/buckets.js';

type FieldType = 'string' | 'number' | 'boolean';
export type FieldOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not_in' | 'contains' | 'has';

export interface FieldDef {
  type: FieldType;
  ops: FieldOp[];
  values?: string[];      // present only when the domain is closed
  description?: string;
}

// ─── Shared shapes ─────────────────────────────────────────────────────────
const CATEGORY_OPS: FieldOp[] = ['=', '!=', 'in', 'not_in'];
const RANGE_OPS: FieldOp[] = ['=', '!=', '<', '<=', '>', '>='];

const KV_FIELD: FieldDef = {
  type: 'number',
  ops: RANGE_OPS,
  description: 'Nominal voltage class, in kV.',
};

const OSM_SOURCE_FIELD: FieldDef = {
  type: 'string',
  ops: CATEGORY_OPS,
  values: ['wind', 'solar', 'hydro', 'nuclear', 'coal', 'gas', 'oil', 'battery', 'geothermal', 'biomass', 'biogas', 'waste'],
  description: 'OSM power-generation source tag.',
};

const OUTPUT_MW_FIELD: FieldDef = {
  type: 'number',
  ops: RANGE_OPS,
  description: 'Rated output capacity, in MW.',
};

export const FIELD_SCHEMA: Record<string, Record<string, FieldDef>> = {
  eia_generators: {
    energy_source: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: ['WND', 'SUN', 'WAT', 'NUC', 'BIT', 'SUB', 'LIG', 'PC', 'NG', 'OG', 'DFO', 'RFO', 'KER', 'MWH', 'ES', 'GEO', 'WDS', 'WDL', 'MSW', 'BLQ'],
      description: 'EIA Form 860 fuel-type code.',
    },
    gen_status: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: ['existing', 'retirement', 'retired', 'proposed'],
      description: 'Generator lifecycle status.',
    },
    sector_name: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: Object.values(SECTOR_MAP).flat(),
      description: 'EIA Form 860 ownership sector.',
    },
    nameplate_mw: OUTPUT_MW_FIELD,
    op_year: {
      type: 'number',
      ops: RANGE_OPS,
      description: 'Year the unit began commercial operation.',
    },
  },

  osm_plants_points: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
  },
  osm_plants_polygons: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
  },
  osm_generators: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
  },

  osm_substations_points:   { nominal_kv: KV_FIELD },
  osm_substations_polygons: { nominal_kv: KV_FIELD },
  osm_transmission_lines:   { nominal_kv: KV_FIELD },
  hifld_substations:        { max_kv: KV_FIELD },
  hifld_transmission_lines: { VOLTAGE: KV_FIELD },

  hifld_natgas_lines: {
    pipe_type: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: ['Interstate', 'Intrastate', 'HGL', 'Gathering'],
      description: 'HIFLD natural-gas pipeline class.',
    },
  },
  hifld_natgas_points: {
    fac_type: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: ['lng_terminal', 'underground', 'spr', 'trading_hub', 'processing', 'border_cross', 'peak_shaving', 'lng_storage', 'pol_terminal'],
      description: 'HIFLD natural-gas / petroleum facility type.',
    },
  },
  osm_pipelines_lines: {
    substance: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: Object.values(SUBSTANCE_MAP).flat(),
      description: 'OSM pipeline contents tag, grouped by generator-fuel type.',
    },
  },

  nerc_regions: {
    code: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: Object.values(NERC_MAP).flat(),
      description: 'NERC reliability region abbreviation.',
    },
  },
  retail_territories: {
    type: {
      type: 'string',
      ops: CATEGORY_OPS,
      values: Object.values(RETAIL_TYPE_MAP).flat(),
      description: 'Retail electric service territory ownership type.',
    },
  },
};
