// @vitest-environment jsdom
// Guards the condition compiler: every live legend filter routed through
// compileBucketExpr() must emit the expression buildValueFilterExpr() emits
// for the same active bucket set, and a bucket value drifting outside the
// declared FIELD_SCHEMA domain must not break the live filter path.
import { describe, it, expect } from 'vitest';
import {
  toMapLibreFilter, validateConditions, ConditionError,
  type Condition,
} from './condition-compile.js';
import { FIELD_SCHEMA } from './field-schema.js';
// ui-legends.ts sits in an import cycle with url-state-codec.ts, and the codec
// reads LEGEND_FILTERS at module scope. Pulling the codec in first lets
// ui-legends finish evaluating before that loop runs.
import '../../assets/url-state-codec.js';
import {
  buildValueFilterExpr, compileBucketExpr,
  LAYER_FILTER_VALUE_MAPS, BUCKET_FILTER_DATASETS, OSM_FUEL_MAP,
} from '../../assets/filters.js';
import {
  NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS, PIPELINE_TYPE_BUCKETS,
  SUBSTANCE_BUCKETS, SUBSTANCE_MAP, NERC_BUCKETS, NERC_MAP,
  RETAIL_TYPE_BUCKETS, RETAIL_TYPE_MAP, SECTOR_BUCKETS, SECTOR_MAP,
  OSM_FUEL_BUCKETS,
} from '../colors/buckets.js';

describe('validateConditions', () => {
  it('accepts a condition drawn from the schema', () => {
    expect(validateConditions('eia_generators', [{ field: 'energy_source', op: 'in', value: ['WND', 'SUN'] }])).toBeNull();
  });

  it('names an unknown dataset', () => {
    const err = validateConditions('not_a_dataset', []);
    expect(err).toBeInstanceOf(ConditionError);
    expect(err?.reason).toBe('unknown-dataset');
  });

  it('names an unknown field', () => {
    const err = validateConditions('eia_generators', [{ field: 'nope', op: '=', value: 'x' }]);
    expect(err?.reason).toBe('unknown-field');
    expect(err?.condition?.field).toBe('nope');
  });

  it('names an operator the field does not allow', () => {
    const err = validateConditions('eia_generators', [{ field: 'energy_source', op: '<', value: 'WND' }]);
    expect(err?.reason).toBe('unsupported-op');
    expect(err?.condition?.op).toBe('<');
  });

  it('names a value outside a closed domain', () => {
    const err = validateConditions('eia_generators', [{ field: 'energy_source', op: 'in', value: ['WND', 'UNOBTANIUM'] }]);
    expect(err?.reason).toBe('value-out-of-domain');
  });

  it('leaves an open-domain numeric field alone', () => {
    expect(validateConditions('eia_generators', [{ field: 'nameplate_mw', op: '>=', value: 250 }])).toBeNull();
  });

  it('is thrown, not returned, by toMapLibreFilter', () => {
    const bad: Condition[] = [{ field: 'nope', op: '=', value: 'x' }];
    expect(() => toMapLibreFilter('eia_generators', bad)).toThrow(ConditionError);
  });
});

describe('toMapLibreFilter shape', () => {
  it('returns a lone condition unwrapped', () => {
    expect(toMapLibreFilter('eia_generators', [{ field: 'gen_status', op: '=', value: 'existing' }]))
      .toEqual(['==', ['get', 'gen_status'], 'existing']);
  });

  it('conjoins several conditions under "all"', () => {
    expect(toMapLibreFilter('eia_generators', [
      { field: 'gen_status', op: '=', value: 'existing' },
      { field: 'nameplate_mw', op: '>', value: 100 },
    ])).toEqual(['all',
      ['==', ['get', 'gen_status'], 'existing'],
      ['>', ['get', 'nameplate_mw'], 100],
    ]);
  });
});

// ─── The live bucket filters are unchanged by the rewire ─────────────────────
// Every filter routed through compileBucketExpr must emit exactly what
// buildValueFilterExpr emitted for the same active set, enumerated over bucket
// subsets rather than sampled.
const ROUTED: { field: string; buckets: { id: string }[]; valueMap: Record<string, string[]>; via: string }[] = [
  { field: 'pipe_type',   buckets: NATGAS_PIPE_TYPE_BUCKETS, valueMap: LAYER_FILTER_VALUE_MAPS.natgas_pipe_type, via: 'applyNatgasLineFilter' },
  { field: 'fac_type',    buckets: NATGAS_FAC_TYPE_BUCKETS,  valueMap: LAYER_FILTER_VALUE_MAPS.natgas_fac_type,  via: 'applyNatgasPtsFilter' },
  { field: 'substance',   buckets: SUBSTANCE_BUCKETS,        valueMap: SUBSTANCE_MAP,     via: 'applySubstanceFilter' },
  { field: 'code',        buckets: NERC_BUCKETS,             valueMap: NERC_MAP,          via: 'applyNercFilter' },
  { field: 'type',        buckets: RETAIL_TYPE_BUCKETS,      valueMap: RETAIL_TYPE_MAP,   via: 'applyRetailTypeFilter' },
  { field: 'sector_name', buckets: SECTOR_BUCKETS,           valueMap: SECTOR_MAP,        via: 'applyGeneratorFilters (sector)' },
  { field: 'source',      buckets: OSM_FUEL_BUCKETS,         valueMap: OSM_FUEL_MAP,      via: 'applyGeneratorFilters (OSM fuel)' },
];

// Fields whose filters keep the direct builder, each for a reason the compiler
// is not meant to cover.
const NOT_ROUTED = [
  { field: 'pipeline', buckets: PIPELINE_TYPE_BUCKETS, valueMap: LAYER_FILTER_VALUE_MAPS.pipeline_type, via: 'applyPipelineTypeFilter' },
];

// Subsets of the leading ids (the full 2^n is 512 for the 9-bucket set and
// 4096 for the 12-bucket one), plus the complete set and the empty set, which
// are the two boundaries compileBucketExpr special-cases.
function subsetsOf(ids: string[]) {
  const head = ids.slice(0, 6);
  const out: Set<string>[] = [];
  for (let mask = 0; mask < (1 << head.length); mask++) {
    out.push(new Set(head.filter((_, i) => mask & (1 << i))));
  }
  out.push(new Set(ids));
  out.push(new Set(ids.slice(1)));
  out.push(new Set());
  return out;
}

describe('compileBucketExpr matches buildValueFilterExpr', () => {
  for (const { field, buckets, valueMap, via } of [...ROUTED, ...NOT_ROUTED]) {
    it(`${via}: ${field} over every bucket subset`, () => {
      for (const active of subsetsOf(buckets.map(b => b.id))) {
        expect(
          compileBucketExpr(field, active, buckets, valueMap),
          `${field} active=[${[...active]}]`,
        ).toEqual(buildValueFilterExpr(field, active, buckets, valueMap));
      }
      expect(compileBucketExpr(field, null, buckets, valueMap)).toBeNull();
    });
  }
});

describe('BUCKET_FILTER_DATASETS', () => {
  it('names exactly the fields the live filters compile', () => {
    expect(Object.keys(BUCKET_FILTER_DATASETS).sort()).toEqual(ROUTED.map(r => r.field).sort());
    for (const { field } of NOT_ROUTED) expect(BUCKET_FILTER_DATASETS[field]).toBeUndefined();
  });

  it('every routed field is declared by its dataset, with a domain covering the whole legend', () => {
    for (const { field, valueMap } of ROUTED) {
      const dataset = BUCKET_FILTER_DATASETS[field];
      expect(FIELD_SCHEMA[dataset]?.[field], `${dataset}.${field}`).toBeDefined();
      const values = Object.values(valueMap).flat();
      expect(
        validateConditions(dataset, [{ field, op: 'in', value: values }]),
        `${dataset}.${field} domain`,
      ).toBeNull();
    }
  });

  it('the three OSM generator datasets share one "source" definition', () => {
    const defs = ['osm_plants_points', 'osm_plants_polygons', 'osm_generators']
      .map(d => FIELD_SCHEMA[d].source);
    for (const def of defs) expect(def).toBe(defs[0]);
  });

  it('runs the schema check on the live path: toMapLibreFilter throws on a drifted value', () => {
    for (const { field, valueMap } of ROUTED) {
      const dataset = BUCKET_FILTER_DATASETS[field];
      const firstId = Object.keys(valueMap)[0];
      const doctored = [...valueMap[firstId], 'UNOBTANIUM'];
      expect(
        () => toMapLibreFilter(dataset, [{ field, op: 'in', value: doctored }]),
        `${dataset}.${field} reached the compiler`,
      ).toThrow(ConditionError);
    }
  });

  // compileBucketExpr is the live render path (filter:all has no surrounding
  // try/catch), so a drifted bucket value must never throw there — it falls
  // back to the pre-schema builder instead, which stays infallible.
  it('falls back to buildValueFilterExpr, without throwing, when a bucket value drifts out of the schema domain', () => {
    for (const { field, buckets, valueMap } of ROUTED) {
      const firstId = Object.keys(valueMap)[0];
      const doctored = { ...valueMap, [firstId]: [...valueMap[firstId], 'UNOBTANIUM'] };
      const active = new Set([firstId]);
      let result;
      expect(
        () => { result = compileBucketExpr(field, active, buckets, doctored); },
        `${field} threw instead of falling back`,
      ).not.toThrow();
      expect(result).toEqual(buildValueFilterExpr(field, active, buckets, doctored));
    }
  });
});
