import { describe, it, expect } from 'vitest';
import { voltageColorExpr } from './voltage.js';
import {
  bucketColorExpr, subRadius,
  NATGAS_PIPE_TYPE_BUCKETS, RETAIL_TYPE_BUCKETS, NWS_GROUP_BUCKETS,
} from './buckets.js';
import {
  genIconSize, OSM_GEN_ICON, OSM_GEN_COLOR, EIA_GEN_ICON, OSM_FUEL_MAP, EIA_FUEL_MAP,
} from './fuel.js';
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

// The layer builders paint these three palettes with bucketColorExpr; each
// literal below is the hand-written expression the builder carried before.
describe('bucketColorExpr layer palettes', () => {
  it('natgas line colour (map-layers-hifld.ts)', () => {
    expect(bucketColorExpr("pipe_type", NATGAS_PIPE_TYPE_BUCKETS, "#f97316")).toEqual([
      "match", ["get", "pipe_type"],
      "Interstate",  "#f97316",
      "Intrastate",  "#fbbf24",
      "HGL",         "#38bdf8",
      "Gathering",   "#a78bfa",
      "#f97316"
    ]);
  });

  it('retail territory colour (map-layers-hifld.ts)', () => {
    expect(bucketColorExpr("type", RETAIL_TYPE_BUCKETS, "#94a3b8")).toEqual([
      "match", ["get", "type"],
      "INVESTOR OWNED",                                          "#3b82f6",
      "COOPERATIVE",                                             "#22c55e",
      ["MUNICIPAL", "MUNICIPAL MKTG AUTHORITY"],                 "#f97316",
      ["STATE", "FEDERAL", "POLITICAL SUBDIVISION"],             "#a855f7",
      "#94a3b8"
    ]);
  });

  it('NWS alert group colour (map-layers-conditions.ts)', () => {
    expect(bucketColorExpr("_group", NWS_GROUP_BUCKETS, "#9ca3af")).toEqual([
      "match", ["get", "_group"],
      "convective", "#a855f7",
      "flood",      "#22c55e",
      "fire",       "#ef4444",
      "heat",       "#f97316",
      "wind",       "#eab308",
      "winter",     "#38bdf8",
      "tropical",   "#14b8a6",
      /* other */   "#9ca3af",
    ]);
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

// The labels a ["match", input, label, out, ..., fallback] expression styles.
function matchLabels(expr: unknown): string[] {
  const m = expr as unknown[];
  const labels: string[] = [];
  for (let i = 2; i < m.length - 1; i += 2) labels.push(...[m[i] as string | string[]].flat());
  return labels;
}

// Every value the map draws with its own icon or colour must be one the fuel
// filter classes into a bucket — otherwise the filter files it under "Other".
describe('generator styling and the fuel filter agree', () => {
  const eiaMatch = (EIA_GEN_ICON as unknown[])[3];
  const cases: [string, unknown, Record<string, string[]>][] = [
    ['OSM_GEN_ICON', OSM_GEN_ICON, OSM_FUEL_MAP],
    ['OSM_GEN_COLOR', OSM_GEN_COLOR, OSM_FUEL_MAP],
    ['EIA_GEN_ICON', eiaMatch, EIA_FUEL_MAP],
  ];
  for (const [name, expr, valueMap] of cases) {
    it(`${name} styles exactly the values the filter classes`, () => {
      const styled = matchLabels(expr);
      expect(new Set(styled).size, `${name} repeats a label`).toBe(styled.length);
      expect([...styled].sort()).toEqual(Object.values(valueMap).flat().sort());
    });
  }

  it('OSM diesel filters as Oil while keeping its own icon', () => {
    expect(OSM_FUEL_MAP.oil).toContain('diesel');
    const m = OSM_GEN_ICON as unknown[];
    expect(m[m.indexOf('diesel') + 1]).toBe('gen-diesel');
  });
});
