// Tests for categories.ts: category keys per row (terrain split by band), label keys and
// their fallback, and that every row of every preset lands on a known category.
import { describe, it, expect } from 'vitest';
import { ROUTE_PRESETS, type CostRow } from '../../src/registry/route-presets.js';
import { CATEGORY_LABEL_KEYS, categoryLabelKey, routeCategory } from './categories.js';

const row = (band: CostRow['band'], group?: string): CostRow => ({ band, match: { codes: [1] }, route_w: 1, cost_x: 1, group, src: 't' });

describe('routeCategory', () => {
  it('group, else band; terrain splits by band', () => {
    expect(routeCategory(row('whpclass'))).toBe('whpclass');
    expect(routeCategory(row('desig', 'protection'))).toBe('protection');
    expect(routeCategory(row('landcover', 'terrain'))).toBe('terrain:landcover');
    expect(routeCategory(row('slope', 'terrain'))).toBe('terrain:slope');
  });

  it('splits ungrouped bit-flag rows by bit; other matches keep the band', () => {
    const bit = (band: CostRow['band'], b: number): CostRow => ({ ...row(band), match: { bit: b } });
    expect(routeCategory(bit('flags', 3))).toBe('flags:3');
    expect(routeCategory(bit('osm_flags', 2))).toBe('osm_flags:2');
    expect(routeCategory(bit('flags2', 5))).toBe('flags2:5');
    expect(routeCategory({ ...bit('flags', 4), group: 'parallel' })).toBe('parallel');
    expect(routeCategory(row('flags'))).toBe('flags');
  });

  it('every preset row has a known category', () => {
    for (const p of ROUTE_PRESETS) for (const r of p.rows) expect(CATEGORY_LABEL_KEYS[routeCategory(r)], `${p.id} ${r.note}`).toBeDefined();
  });
});

describe('categoryLabelKey', () => {
  it('maps known keys, ":" → "_", and falls back to other', () => {
    expect(categoryLabelKey('terrain:slope')).toBe('route.cat.terrain_slope');
    expect(categoryLabelKey('osm_flags')).toBe('route.cat.osm_flags');
    expect(categoryLabelKey('osm_flags:2')).toBe('route.cat.osm_flags_2');
    expect(categoryLabelKey('nope')).toBe('route.cat.other');
  });
});
