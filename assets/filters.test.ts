import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// ─── Drift guard: 'filter:all' must reapply every apply*Filter/Filters export ──
// map-load and the Reset button both go through 'filter:all' (see map.ts and
// ui.ts). If a new applyXFilter() is added here without adding it to the
// 'filter:all' handler, Reset (and the initial load) silently stop covering
// it — exactly the bug this test guards against. Source-text comparison is
// deliberately simple/permanent: it survives refactors of the functions'
// internals as long as the handler still calls each export by name.
describe('filter:all drift guard', () => {
  const src = readFileSync(fileURLToPath(new URL('./filters.ts', import.meta.url)), 'utf8');

  const exportedApplyFns = [...src.matchAll(/^export function (apply\w+)/gm)].map(m => m[1]);

  const handlerMatch = src.match(/on\('filter:all',\s*\(\) => \{([\s\S]*?)\n\}\);/);
  if (!handlerMatch) throw new Error("could not locate the 'filter:all' handler body in filters.ts");
  const handlerBody = handlerMatch[1];

  it('found at least one exported apply*Filter/Filters function to check', () => {
    expect(exportedApplyFns.length).toBeGreaterThan(0);
  });

  for (const fn of exportedApplyFns) {
    it(`'filter:all' handler invokes ${fn}`, () => {
      expect(handlerBody).toContain(fn);
    });
  }
});
