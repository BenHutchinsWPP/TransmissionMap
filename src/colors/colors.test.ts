import { describe, it, expect } from 'vitest';
import { voltageColorExpr } from './voltage.js';
import { bucketColorExpr, subRadius } from './buckets.js';
import { genIconSize } from './fuel.js';
import type { BucketDef } from '../types.js';

describe('voltageColorExpr', () => {
  it('returns an array', () => {
    const result = voltageColorExpr('voltage_kv', '#c4b5fd');
    expect(Array.isArray(result)).toBe(true);
  });

  it('starts with "case"', () => {
    const result = voltageColorExpr('voltage_kv', '#c4b5fd');
    expect(result[0]).toBe('case');
  });

  it('includes HV orange for ≥550 kV', () => {
    const result = voltageColorExpr('voltage_kv', '#c4b5fd');
    expect(result).toContain('#f97316');
  });

  it('includes 500 kV red', () => {
    expect(voltageColorExpr('voltage_kv', '#fff')).toContain('#ef4444');
  });

  it('uses supplied nullColor as fallback', () => {
    const result = voltageColorExpr('field', '#aabbcc');
    expect(result[result.length - 1]).toBe('#aabbcc');
  });
});

describe('bucketColorExpr', () => {
  const buckets: BucketDef[] = [
    { id: 'a', label: 'A', color: '#111111', urlCode: 'A', values: ['alpha'] },
    { id: 'b', label: 'B', color: '#222222', urlCode: 'B', values: ['beta', 'gamma'] },
    { id: 'empty', label: 'Empty', color: '#333333', urlCode: 'E' },
  ];

  it('returns an array starting with "match"', () => {
    const result = bucketColorExpr('field', buckets, '#ffffff') as unknown[];
    expect(result[0]).toBe('match');
  });

  it('includes single-value buckets as plain string', () => {
    const result = bucketColorExpr('field', buckets, '#ffffff') as unknown[];
    expect(result).toContain('alpha');
  });

  it('includes multi-value buckets as array', () => {
    const result = bucketColorExpr('field', buckets, '#ffffff') as unknown[];
    const idx = result.indexOf('#222222');
    expect(Array.isArray(result[idx - 1])).toBe(true);
  });

  it('skips buckets with no values', () => {
    const result = bucketColorExpr('field', buckets, '#ffffff') as unknown[];
    expect(result).not.toContain('#333333');
  });

  it('ends with the default color', () => {
    const result = bucketColorExpr('field', buckets, '#ffffff') as unknown[];
    expect(result[result.length - 1]).toBe('#ffffff');
  });
});

describe('subRadius', () => {
  it('returns an interpolate expression', () => {
    const result = subRadius('nominal_kv') as unknown[];
    expect(result[0]).toBe('interpolate');
  });

  it('has numeric zoom stops', () => {
    const result = subRadius('nominal_kv') as unknown[];
    // structure: ["interpolate", ["linear"], ["zoom"], stop, value, ...]
    expect(typeof result[3]).toBe('number');
  });
});

describe('genIconSize', () => {
  it('returns an interpolate expression', () => {
    const result = genIconSize('nameplate_mw') as unknown[];
    expect(result[0]).toBe('interpolate');
  });

  it('has three zoom levels', () => {
    const result = genIconSize('nameplate_mw') as unknown[];
    // ["interpolate", ["linear"], ["zoom"], z1, v1, z2, v2, z3, v3]
    const zooms = [result[3], result[5], result[7]];
    expect(zooms).toHaveLength(3);
    expect(zooms.every(z => typeof z === 'number')).toBe(true);
  });
});
