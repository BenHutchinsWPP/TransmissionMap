import { describe, it, expect } from 'vitest';
import { subRadius } from './layer-init.js';

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
