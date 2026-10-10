import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as filters from './filters.js';
import {
  buildMwFilterExpr, buildKvFilterExpr, buildValueFilterExpr, MW_SLIDER_MAX, FACET_APPLIERS,
} from './filters.js';

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
