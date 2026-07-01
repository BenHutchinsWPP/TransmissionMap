import { describe, it, expect } from 'vitest';
import {
  buildMwFilterExpr, buildKvFilterExpr, buildValueFilterExpr, MW_SLIDER_MAX,
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
