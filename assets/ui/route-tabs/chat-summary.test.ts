// Tests for the chat summary: size cap, name cleaning, drivers equal the Cost tab's category lines,
// alternatives capped to two, notes include the estimate-range line and the skipped-alternatives reason,
// crossing point names and details never reach it.
// Deps: chat-summary.js, widgets.js, fixture.js, registry/route-presets.ts.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', () => ({ t: (k: string) => k }));

import { chatSummary, cleanName } from './chat-summary.js';
import { waterfallLines } from './widgets.js';
import { FIXTURE_RESULT, fixtureCost } from './fixture.js';
import { routePreset } from '../../../src/registry/route-presets.js';
import type { RouteResult } from '../../route/route.js';

const preset = routePreset('tm-default')!;
const A = { name: 'McNary', kv: 500, lngLat: [-119.3, 45.93] as [number, number] };
const B = { name: 'Hemingway', kv: 500, lngLat: [-116.78, 43.29] as [number, number] };

function result(): RouteResult {
  const cost = fixtureCost();
  cost.perRow = [...cost.perRow, { row: 5, usd: -400e6, affectedM: 10e3 }];
  const alt = FIXTURE_RESULT.alternatives![0];
  return { ...FIXTURE_RESULT, cost, alternatives: [alt, alt, alt], altSkipped: 'memory cap reached' };
}

describe('chatSummary', () => {
  it('stays small and caps alternatives at two', () => {
    const s = chatSummary(result(), preset, 'Default', A, B);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(1500);
    expect(s.alternatives).toHaveLength(2);
    expect(Object.keys(s.crossings).length).toBeGreaterThan(0);
  });

  it('drivers equal the Cost tab category lines, signed, largest first', () => {
    const r = result();
    const s = chatSummary(r, preset, 'Default', A, B);
    const lines = waterfallLines(r.cost, preset, { dollars: 'y2025' }).filter((l) => l.group === 'multipliers');
    expect(s.drivers.length).toBeGreaterThan(0);
    expect(s.drivers.length).toBeLessThanOrEqual(5);
    for (const d of s.drivers) {
      const l = lines.find((x) => x.label === d.label)!;
      expect(d.usd2025).toBeCloseTo(l.value, -Math.floor(Math.log10(Math.abs(l.value))) + 2);
    }
    expect(s.drivers.some((d) => d.usd2025 < 0)).toBe(true);
    const abs = s.drivers.map((d) => Math.abs(d.usd2025));
    expect(abs).toEqual([...abs].sort((x, y) => y - x));
  });

  it('reports 2025$ to 3 significant figures and the notes', () => {
    const r = result();
    const s = chatSummary(r, preset, 'Default', A, B);
    expect(s.cost2025.total).toBe(Number(r.cost.total2025.toPrecision(3)));
    expect(s.cost2025.low).toBe(Number(r.cost.band.low.toPrecision(3)));
    expect(s.notes.length).toBeLessThanOrEqual(3);
    expect(s.notes).toContain('cost is a rough early estimate range (−30 % / +50 %)');
    expect(s.notes.some((n) => n.includes('memory cap reached'))).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/corridor|exploratory/i);
  });

  it('carries no crossing point name or detail, at any depth', () => {
    const r = result();
    const c = r.profile!.crossings;
    const named = { ...r, profile: { ...r.profile!, crossings: { ...c, points: c.points.map((p, i) => ({ ...p, name: `Road ${i}`, detail: 'motorway' })) } } };
    expect(named.profile.crossings.points.length).toBeGreaterThan(0);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    const { a, b, ...rest } = chatSummary(named, preset, 'Default', A, B);   // the ends' substation names are allowed
    walk(rest);
    expect(keys).not.toContain('name');
    expect(keys).not.toContain('detail');
    expect(JSON.stringify({ a, b, ...rest })).not.toMatch(/Road \d|motorway/);
  });

  it('caps and strips names', () => {
    const s = chatSummary(result(), preset, 'M\u0000x', { ...A, name: 'A\nB' + 'x'.repeat(100) }, B);
    expect(s.a.name!.length).toBe(60);
    // eslint-disable-next-line no-control-regex
    expect(s.a.name).not.toMatch(/[\u0000-\u001f]/);
    expect(s.method).toBe('Mx');
  });
});

describe('cleanName', () => {
  it('handles null and control characters', () => {
    expect(cleanName(null)).toBeNull();
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName('a\u007fb\u0001c')).toBe('abc');
    expect(cleanName('y'.repeat(80))!.length).toBe(60);
  });
});
