import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as filters from './filters.js';
import {
  buildMwFilterExpr, buildKvFilterExpr, buildValueFilterExpr, MW_SLIDER_MAX, FACET_APPLIERS,
  drawnFilterLabels,
} from './filters.js';
import { state } from './state.js';
import { FUEL_LEGEND } from '../src/colors/fuel.js';
import { facet } from '../src/colors/facets.js';
import { KV_BUCKETS, kvBucketOf } from '../src/colors/buckets.js';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification } from 'maplibre-gl';

describe('buildMwFilterExpr', () => {
  it('returns null when neither bound is active', () => {
    expect(buildMwFilterExpr('mw', 0, MW_SLIDER_MAX)).toBeNull();
  });

  it('returns a <= expr when only an upper bound is set', () => {
    const e = buildMwFilterExpr('mw', 0, 500) as unknown[];
    expect(e[0]).toBe('<=');
    expect(e[2]).toBe(500);
  });

  it('returns a >= expr when only a lower bound is set', () => {
    const e = buildMwFilterExpr('mw', 100, MW_SLIDER_MAX) as unknown[];
    expect(e[0]).toBe('>=');
    expect(e[2]).toBe(100);
  });

  it('returns an "all" of both bounds when both are set', () => {
    const e = buildMwFilterExpr('mw', 100, 500) as unknown[];
    expect(e[0]).toBe('all');
    expect((e[1] as unknown[])[0]).toBe('>=');
    expect((e[2] as unknown[])[0]).toBe('<=');
  });
});

describe('buildValueFilterExpr', () => {
  const valueMap = { fossil: ['coal', 'gas'], renewable: ['wind', 'solar'] };
  const allBuckets = [{ id: 'fossil' }, { id: 'renewable' }, { id: 'other' }];

  it('returns null for a null active set', () => {
    expect(buildValueFilterExpr('fuel', null, allBuckets, valueMap)).toBeNull();
  });

  it('returns null when every bucket is active', () => {
    const all = new Set(['fossil', 'renewable', 'other']);
    expect(buildValueFilterExpr('fuel', all, allBuckets, valueMap)).toBeNull();
  });

  it('includes only the allowed values for a subset', () => {
    const e = buildValueFilterExpr('fuel', new Set(['fossil']), allBuckets, valueMap);
    const flat = JSON.stringify(e);
    expect(flat).toContain('coal');
    expect(flat).toContain('gas');
    expect(flat).not.toContain('wind');
  });

  it('adds a negation branch when "other" is active', () => {
    const e = buildValueFilterExpr('fuel', new Set(['other']), allBuckets, valueMap);
    const flat = JSON.stringify(e);
    expect(flat).toContain('!');
  });
});

describe('buildKvFilterExpr', () => {
  const buckets = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns null for a null active set', () => {
    expect(buildKvFilterExpr('kv', null, buckets)).toBeNull();
  });

  it('returns null when every bucket is active', () => {
    expect(buildKvFilterExpr('kv', new Set(['a', 'b', 'c']), buckets)).toBeNull();
  });

  // The ranges live in src/colors/buckets.ts (KV_BUCKET_RANGES); the filter
  // the legend writes is pinned here as it was built inside filters.ts.
  it('builds the same expression from the shared range table', () => {
    const kv = ['to-number', ['get', 'max_kv'], -1];
    expect(buildKvFilterExpr('max_kv', new Set(['550+', '200-299', '<100', 'unknown']), KV_BUCKETS)).toEqual(['any',
      ['>=', kv, 550],
      ['all', ['>=', kv, 200], ['<', kv, 300]],
      ['all', ['>', kv, 0], ['<', kv, 100]],
      ['<=', kv, 0],
    ]);
    expect(buildKvFilterExpr('max_kv', new Set(), KV_BUCKETS)).toEqual(['==', ['literal', 1], ['literal', 0]]);
  });

  it('agrees with kvBucketOf, the templates\' binning, on every value form', () => {
    const values: unknown[] = [765, 550, 549.9, 500, 345, '345', 300, 230, 200, 138, 100, 99, 69, 1, 0.5, 0, -5,
      null, undefined, '', 'abc', '345;230', ' 115 ', true, false];
    for (const b of KV_BUCKETS) {
      const test = featureFilter(buildKvFilterExpr('v', new Set([b.id]), KV_BUCKETS) as FilterSpecification, 'layers[0].filter');
      for (const v of values) {
        const f = { type: 1, properties: v === undefined ? {} : { v } } as never;
        expect(test.filter({ zoom: 8 }, f), `${JSON.stringify(v)} in ${b.id}`).toBe(kvBucketOf(v) === b.id);
      }
    }
  });
});

// ─── Drift guard: applyAllFilters() runs every exported applier ───────────────
// Map load, Reset and every view apply re-filter through applyAllFilters()
// (view-state.ts's repaintView()), which runs each FACET_APPLIERS function and
// then the calls in its own body. An exported apply*Filter(s) that is in
// neither place is never re-applied on those paths. The body is read as source
// text; FACET_APPLIERS membership is checked on the live object.
describe('applyAllFilters drift guard', () => {
  const src = readFileSync(fileURLToPath(new URL('./filters.ts', import.meta.url)), 'utf8');

  const exportedApplyFns = [...src.matchAll(/^export function (apply\w*Filters?)\b/gm)]
    .map(m => m[1])
    .filter(fn => fn !== 'applyAllFilters');

  const bodyMatch = src.match(/^export function applyAllFilters\(\) \{([\s\S]*?)\n\}/m);
  if (!bodyMatch) throw new Error('could not locate the applyAllFilters() body in filters.ts');
  const body = bodyMatch[1];
  const facetAppliers = new Set(Object.values(FACET_APPLIERS));
  const exports = filters as unknown as Record<string, unknown>;

  it('found at least one exported apply*Filter/Filters function to check', () => {
    expect(exportedApplyFns.length).toBeGreaterThan(0);
  });

  it('applyAllFilters() runs every FACET_APPLIERS function', () => {
    expect(body).toMatch(/\bObject\.values\(FACET_APPLIERS\)/);
  });

  for (const fn of exportedApplyFns) {
    it(`applyAllFilters() runs ${fn}`, () => {
      const viaFacet = facetAppliers.has(exports[fn] as () => void);
      const viaBody = new RegExp(`\\b${fn}\\(`).test(body);
      expect(viaFacet || viaBody, `${fn} is neither in FACET_APPLIERS nor called by applyAllFilters()`).toBe(true);
    });
  }
});

describe('drawnFilterLabels', () => {
  const EIA = 'eia-generators';
  const fresh = () => {
    state.layerFilters = { [EIA]: new Set(['existing', 'retirement']) };
    state.legendFilters = {
      fuel: new Set(FUEL_LEGEND.map(f => f.id)),
      sector: new Set(facet('sector').buckets.map(b => b.id)),
    };
    state.mwFilter = { min: 0, max: MW_SLIDER_MAX };
    state.yearFilter = { ...state.yearFilter, enabled: false };
  };

  it('the default EIA view names its statuses only', () => {
    fresh();
    expect(drawnFilterLabels(EIA)).toEqual([{ title: 'Status', values: ['Existing', 'Planned Retirement'] }]);
  });

  it('Proposed on → three statuses; every status on → no pill', () => {
    fresh();
    state.layerFilters[EIA].add('proposed');
    expect(drawnFilterLabels(EIA)[0].values).toEqual(['Existing', 'Planned Retirement', 'Proposed']);
    state.layerFilters[EIA].add('retired');
    expect(drawnFilterLabels(EIA)).toEqual([]);
  });

  it('a narrowed fuel facet adds a Fuel pill', () => {
    fresh();
    state.legendFilters.fuel = new Set(['gas']);
    const fuel = drawnFilterLabels(EIA).find(l => l.title === 'Fuel Type');
    expect(fuel?.values).toEqual([FUEL_LEGEND.find(f => f.id === 'gas')!.label]);
  });

  it('a moved MW range adds a Capacity pill, and the year filter a Year pill', () => {
    fresh();
    state.mwFilter = { min: 100, max: MW_SLIDER_MAX };
    state.yearFilter = { ...state.yearFilter, enabled: true, year: 2010 };
    const labels = drawnFilterLabels(EIA);
    expect(labels.find(l => l.title === 'Capacity')?.values).toEqual(['≥ 100 MW']);
    expect(labels.find(l => l.title === 'Year')?.values).toEqual(['2010']);
  });

  it('a layer no filter reaches gets none', () => {
    fresh();
    expect(drawnFilterLabels('railroads')).toEqual([]);
  });
});
