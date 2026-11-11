// The year index the route cost engine escalates with (built by scripts/build_escalation_index.py).
import { describe, it, expect } from 'vitest';
import INDEX from './escalation-index.json';
import { escalationFactor } from '../../assets/route/cost.js';

describe('escalation index', () => {
  const years = Object.keys(INDEX.index).map(Number);
  it('covers 1990..to_year contiguously with positive values and 1 at to_year', () => {
    expect(years[0]).toBe(1990);
    expect(years.at(-1)).toBe(INDEX.to_year);
    years.forEach((y, i) => expect(y).toBe(1990 + i));
    for (const v of Object.values(INDEX.index)) expect(v).toBeGreaterThan(0);
    expect((INDEX.index as Record<string, number>)[String(INDEX.to_year)]).toBe(1);
  });
  it('2014→2025 lies between the ECI (about 1.39) and PPI (about 1.50) factors', () => {
    const f = escalationFactor(2014, 2025);
    expect(f).toBeGreaterThan(1.39);
    expect(f).toBeLessThan(1.5);
  });
  it('holds the factors the BLS replies give (an independent recompute: 2014→2025 ×1.4427, 2018→2025 ×1.3235)', () => {
    expect(escalationFactor(2014, 2025)).toBeCloseTo(1.4427, 4);
    expect(escalationFactor(2018, 2025)).toBeCloseTo(1.3235, 4);
  });
});
