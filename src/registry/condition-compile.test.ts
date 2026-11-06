// @vitest-environment jsdom
// Guards the condition compiler: every live legend filter routed through
// compileBucketExpr() must emit the expression buildValueFilterExpr() emits
// for the same active bucket set, and a bucket value drifting outside the
// declared FIELD_SCHEMA domain must not break the live filter path.
import { describe, it, expect } from 'vitest';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  toMapLibreFilter, validateConditions, ConditionError, MAX_LIST_VALUES,
  type Condition,
} from './condition-compile.js';
import { FIELD_SCHEMA } from './field-schema.js';
import {
  buildValueFilterExpr, compileBucketExpr,
  BUCKET_FILTER_DATASETS,
} from '../../assets/filters.js';
import { OSM_FUEL_MAP } from '../colors/fuel.js';
import {
  NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS, PIPELINE_TYPE_BUCKETS,
  SUBSTANCE_BUCKETS, NERC_BUCKETS,
  RETAIL_TYPE_BUCKETS, SECTOR_BUCKETS,
  OSM_FUEL_BUCKETS,
} from '../colors/buckets.js';
import { facet, facetValueMap } from '../colors/facets.js';

// The value map the facet's legend applier filters with.
const facetMap = (key: string) => facetValueMap(facet(key));

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

  it('rejects a literal of the wrong type for the field', () => {
    const bad: unknown[] = [
      { field: 'nameplate_mw', op: '>=', value: '345' },
      { field: 'nameplate_mw', op: '=', value: true },
      { field: 'energy_source', op: '=', value: false },
      { field: 'energy_source', op: 'in', value: ['WND', 5] },
    ];
    for (const c of bad) expect(validateConditions('eia_generators', [c])?.reason, JSON.stringify(c)).toBe('value-type');
  });

  it('rejects a non-literal shape as malformed', () => {
    const bad: unknown[] = [
      null, 'x', [], { field: 'nameplate_mw', op: '>=', value: 1, extra: 1 },
      { field: 'nameplate_mw', op: '>=', value: ['get', 'x'] },
      { field: 'nameplate_mw', op: '>=', value: Infinity },
      { field: 'energy_source', op: 'in', value: 'WND' },
      { field: 'energy_source', op: 'has', value: 'x' },
      { field: 1, op: '=' },
    ];
    for (const c of bad) expect(validateConditions('eia_generators', [c])?.reason, JSON.stringify(c)).toBe('malformed-condition');
    expect(validateConditions('eia_generators', 'x')?.reason).toBe('malformed-condition');
  });

  it('returns, never throws, for prototype keys as dataset or field', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(validateConditions(k, [])?.reason, k).toBe('unknown-dataset');
      expect(validateConditions('eia_generators', [{ field: k, op: '=', value: 1 }])?.reason, k).toBe('unknown-field');
    }
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
      ['all', ['!=', ['to-string', ['get', 'nameplate_mw']], ''], ['>', ['to-number', ['get', 'nameplate_mw']], 100]],
    ]);
  });
});

// to-number reads a missing, null or '' value as 0; a number test must not
// count those features. Evaluated with MapLibre's own filter.
describe('a text range (ISO dates)', () => {
  const matches = (cond: Condition, props: Record<string, unknown>) => {
    const f = featureFilter(toMapLibreFilter('dc_moratoriums', [cond]) as FilterSpecification, 'layers[0].filter');
    return f.filter({ zoom: 10 }, { type: 1, properties: props, geometry: [] } as never);
  };
  it('compares dates as text of the same length and never matches a feature without one', () => {
    const lt: Condition = { field: 'last_event', op: '<', value: '2025-01-01' };
    expect(matches(lt, { last_event: '2024-12-31' })).toBe(true);
    expect(matches(lt, { last_event: '2025-01-01' })).toBe(false);
    for (const props of [{}, { last_event: null }, { last_event: '' }, { last_event: '2024' }]) expect(matches(lt, props)).toBe(false);
    expect(matches({ field: 'last_event', op: '>=', value: '2024-03-01' }, { last_event: '2024-03-01' })).toBe(true);
  });
  it('takes only a YYYY-MM-DD value', () => {
    expect(validateConditions('dc_moratoriums', [{ field: 'last_event', op: '>=', value: '2024-03-01' }])).toBeNull();
    for (const value of ['2024-03', 'March 2024', 20240301, '2024-13-01']) {
      expect(validateConditions('dc_moratoriums', [{ field: 'last_event', op: '>=', value }]), String(value)).not.toBeNull();
    }
    expect(validateConditions('dc_moratoriums', [{ field: 'last_event', op: '=', value: '2024-03-01' }])).not.toBeNull();
  });
});

describe('number fields: a feature without a value', () => {
  const matches = (cond: Condition, props: Record<string, unknown>) => {
    const f = featureFilter(toMapLibreFilter('osm_plants_points', [cond]) as FilterSpecification, 'layers[0].filter');
    return f.filter({ zoom: 10 }, { type: 1, properties: props, geometry: [] } as never);
  };
  const EMPTY = [{}, { output_mw: null }, { output_mw: '' }];

  it.each([
    ['=', 0], ['<', 10], ['<=', 0], ['>', -1], ['>=', 0],
  ] as const)('%s %s excludes it and still matches a value', (op, value) => {
    const c: Condition = { field: 'output_mw', op, value };
    for (const props of EMPTY) expect(matches(c, props)).toBe(false);
    expect(matches(c, { output_mw: 0 })).toBe(true);
    expect(matches(c, { output_mw: '0' })).toBe(true);
  });

  it('!= keeps matching it', () => {
    const c: Condition = { field: 'output_mw', op: '!=', value: 5 };
    for (const props of EMPTY) expect(matches(c, props)).toBe(true);
    expect(matches(c, { output_mw: 5 })).toBe(false);
  });
});

// ─── The live bucket filters are unchanged by the rewire ─────────────────────
// Every filter routed through compileBucketExpr must emit exactly what
// buildValueFilterExpr emitted for the same active set, enumerated over bucket
// subsets rather than sampled.
const ROUTED: { field: string; buckets: { id: string }[]; valueMap: Record<string, string[]>; via: string }[] = [
  { field: 'pipe_type',   buckets: NATGAS_PIPE_TYPE_BUCKETS, valueMap: facetMap('natgasLine'), via: 'FACET_APPLIERS.natgasLine' },
  { field: 'fac_type',    buckets: NATGAS_FAC_TYPE_BUCKETS,  valueMap: facetMap('natgasPts'), via: 'FACET_APPLIERS.natgasPts' },
  { field: 'substance',   buckets: SUBSTANCE_BUCKETS,        valueMap: facetMap('substance'),     via: 'FACET_APPLIERS.substance' },
  { field: 'code',        buckets: NERC_BUCKETS,             valueMap: facetMap('nerc'),          via: 'FACET_APPLIERS.nerc' },
  { field: 'type',        buckets: RETAIL_TYPE_BUCKETS,      valueMap: facetMap('retail'),   via: 'FACET_APPLIERS.retail' },
  { field: 'sector_name', buckets: SECTOR_BUCKETS,           valueMap: facetMap('sector'), via: 'applyGeneratorFilters (sector)' },
  { field: 'source',      buckets: OSM_FUEL_BUCKETS,         valueMap: OSM_FUEL_MAP,      via: 'applyGeneratorFilters (OSM fuel)' },
];

// Fields whose filters keep the direct builder, each for a reason the compiler
// is not meant to cover.
const NOT_ROUTED = [
  { field: 'pipeline', buckets: PIPELINE_TYPE_BUCKETS, valueMap: facetMap('pipeline'), via: 'FACET_APPLIERS.pipeline' },
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

  // compileBucketExpr is the live render path (applyAllFilters() has no surrounding
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

// Region fields hold `|code|code|` lists (scripts/region_join.py). Evaluated
// with MapLibre's own filter, so the test is what the map draws.
describe('region fields: exact-code contains / contains_any', () => {
  const matches = (dataset: string, cond: Condition, props: Record<string, unknown>) => {
    const f = featureFilter(toMapLibreFilter(dataset, [cond]) as FilterSpecification, 'layers[0].filter');
    return f.filter({ zoom: 10 }, { type: 1, properties: props, geometry: [] } as never);
  };

  it('matches the exact code, never a longer one (USA1 vs USA10)', () => {
    const c: Condition = { field: 'admin1', op: 'contains', value: 'USA1' };
    expect(matches('osm_transmission_lines', c, { admin1: '|USA10|' })).toBe(false);
    expect(matches('osm_transmission_lines', c, { admin1: '|USAB|USA1|' })).toBe(true);
  });

  it('finds a code anywhere in the list and not inside a longer one', () => {
    const c: Condition = { field: 'states', op: 'contains', value: 'TX' };
    expect(matches('hifld_transmission_lines', c, { states: '|NM|TX|' })).toBe(true);
    expect(matches('hifld_transmission_lines', c, { states: '|TXX|' })).toBe(false);
    expect(matches('hifld_transmission_lines', c, {})).toBe(false);
    expect(matches('hifld_transmission_lines', c, { states: null })).toBe(false);
  });

  it('lets none match an absent key as well as |none|', () => {
    const c: Condition = { field: 'counties', op: 'contains', value: 'none' };
    expect(matches('osm_plants_points', c, {})).toBe(true);
    expect(matches('osm_plants_points', c, { counties: '|none|' })).toBe(true);
    expect(matches('osm_plants_points', c, { counties: '|48201|' })).toBe(false);
  });

  it('contains_any matches any of its codes', () => {
    const c: Condition = { field: 'states', op: 'contains_any', value: ['TX', 'NM'] };
    expect(matches('eia_generators', c, { states: '|NM|' })).toBe(true);
    expect(matches('eia_generators', c, { states: '|OK|TX|' })).toBe(true);
    expect(matches('eia_generators', c, { states: '|OK|' })).toBe(false);
  });

  it('accepts the British Columbia retail ids and a known county', () => {
    expect(validateConditions('hifld_substations', [{ field: 'retail', op: 'contains', value: 'NA2' }])).toBeNull();
    expect(validateConditions('hifld_substations', [{ field: 'counties', op: 'contains', value: '48201' }])).toBeNull();
    expect(validateConditions('osm_datacenters', [{ field: 'countries', op: 'contains_any', value: ['FRA', 'USA'] }])).toBeNull();
  });

  const rejects: [string, string, Condition, string][] = [
    ['= on a list field', 'eia_generators', { field: 'states', op: '=', value: 'TX' }, 'unsupported-op'],
    ['in on a list field', 'eia_generators', { field: 'states', op: 'in', value: ['TX'] }, 'unsupported-op'],
    ['contains on a number field', 'eia_generators', { field: 'nameplate_mw', op: 'contains', value: '5' }, 'unsupported-op'],
    ['a code with a separator', 'eia_generators', { field: 'states', op: 'contains', value: 'TX|NM' }, 'value-out-of-domain'],
    ['a code with whitespace', 'eia_generators', { field: 'states', op: 'contains', value: ' TX' }, 'value-out-of-domain'],
    ['an unknown state', 'eia_generators', { field: 'states', op: 'contains', value: 'ZZ' }, 'value-out-of-domain'],
    ['a four-digit county', 'eia_generators', { field: 'counties', op: 'contains', value: '6037' }, 'value-out-of-domain'],
    ['a retail id with a separator', 'eia_generators', { field: 'retail', op: 'contains', value: '123|4' }, 'value-out-of-domain'],
    ['an expression value', 'eia_generators', { field: 'states', op: 'contains', value: ['get', 'x'] }, 'malformed-condition'],
    ['an empty contains_any', 'eia_generators', { field: 'states', op: 'contains_any', value: [] }, 'malformed-condition'],
    ['too many values', 'eia_generators',
      { field: 'counties', op: 'contains_any', value: Array.from({ length: MAX_LIST_VALUES + 1 }, (_, i) => String(10000 + i)) },
      'malformed-condition'],
  ];
  for (const [name, dataset, cond, reason] of rejects) {
    it(`rejects ${name}`, () => {
      expect(validateConditions(dataset, [cond])?.reason).toBe(reason);
    });
  }

  it('accepts exactly MAX_LIST_VALUES codes', () => {
    const value = Array.from({ length: MAX_LIST_VALUES }, (_, i) => String(10000 + i));
    expect(validateConditions('eia_generators', [{ field: 'counties', op: 'contains_any', value }])).toBeNull();
  });
});
