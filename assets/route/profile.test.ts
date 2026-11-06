import { describe, it, expect } from 'vitest';
import { routePreset, type BandName, type CostRow, type RoutePreset } from '../../src/registry/route-presets.js';
import { compile, type Sampler } from './cost.js';
import { buildCrossings, buildProfile, aviationHeightM, PROFILE_BANDS } from './profile.js';

const tm = routePreset('tm-default')!;
/** Two ungrouped rows: landcover 11 → route × 2, cost × 1.5; slope 5 → route × 0.25. */
const preset: RoutePreset = {
  ...tm, id: 'profile-test',
  rows: [
    { band: 'landcover', match: { codes: [11] }, route_w: 2, cost_x: 1.5, src: 't' },
    { band: 'slope', match: { codes: [5] }, route_w: 0.25, cost_x: 1, src: 't' },
  ],
};
const compiled = compile(preset, 'ac500');

/** One row of `n` 1 m cells; band → per-column values. The line runs along row 0's centre. */
function line(cols: Partial<Record<BandName, number[]>>, n: number) {
  const sampler: Sampler = {
    cellM: 1, x0: 0, y0: 0,
    at(col, row) {
      if (row !== 0 || col < 0 || col >= n) return null;
      const out: Partial<Record<BandName, number>> = {};
      for (const [b, v] of Object.entries(cols)) out[b as BandName] = v![col];
      return out;
    },
  };
  const coords: [number, number][] = [[0, -0.5], [n / 2, -0.5], [n, -0.5]];   // joint at n/2: mid-cell when n is odd (still one cell)
  return { sampler, coords };
}
const toLngLat = (x: number, y: number): [number, number] => [x, y];
const all = new Set<string>([...PROFILE_BANDS, 'slope', 'state']);
const opts = (lengthMi: number, present = all) => ({ compiled, preset, lineTypeId: 'ac500', toLngLat, lengthMi, present });
const ROAD = 1 << 4, L230 = 1 << 2;

describe('buildCrossings', () => {
  it('merges a 3-cell gap into one entry and counts a 4-cell gap twice', () => {
    const { sampler, coords } = line({ osm_flags: [ROAD, 0, 0, 0, ROAD, 0, 0, 0, 0, ROAD] }, 10);
    const c = buildCrossings(coords, sampler, { toLngLat, lengthMi: 1, present: all });
    expect(c.counts.road).toBe(2);
    expect(c.points.map((p) => p.kind)).toEqual(['road', 'road']);
    expect(c.points[0].lngLat).toEqual([0.5, -0.5]);
    expect(c.points[1].lngLat).toEqual([9.5, -0.5]);
    expect(c.points[1].mi).toBeCloseTo(9.5 / 10, 12);
  });

  const adj = (k: number) => 16 + k;
  const cross = (osm_flags: number[], adjs: number[]) => {
    const { sampler, coords } = line({ osm_flags, adj: adjs }, osm_flags.length);
    return buildCrossings(coords, sampler, { toLngLat, lengthMi: osm_flags.length, present: all });
  };

  it('a perpendicular crossing of a ≥ 230 kV line (adj 2,1,1,2) is one crossing, not following', () => {
    const c = cross([0, 0, 0, 0, 0, L230, L230, 0, 0, 0, 0, 0],
      [adj(0), adj(0), adj(0), adj(0), adj(2), adj(1), adj(1), adj(2), adj(0), adj(0), adj(0), adj(0)]);
    expect(c.counts.line230).toBe(1);
    expect(c.miles.follows).toBe(0);
    const d = cross([0, 0, 0, 0, L230, 0, 0, 0], [adj(0), adj(0), adj(0), adj(2), adj(1), adj(2), adj(0), adj(0)]);
    expect(d.counts.line230).toBe(1);
    expect(d.miles.follows).toBe(0);
  });

  it('running 10 cells along a ≥ 230 kV line is miles, not crossings (class-2 shoulders join)', () => {
    const on = Array<number>(10).fill(L230);
    const c = cross([0, ...on, 0], [adj(2), ...Array<number>(10).fill(adj(1)), adj(2)]);
    expect(c.counts.line230).toBe(0);
    expect(c.miles.follows).toBeCloseTo(12, 12);
    const d = cross(on, Array<number>(10).fill(adj(1)));
    expect(d.miles.follows).toBeCloseTo(10, 12);
  });

  it('the 100–229 kV class in adj bits 5–6 does not change following of a ≥ 230 kV line', () => {
    const v = 16 + 1 + (2 << 5);
    const on = Array<number>(10).fill(L230);
    expect(cross(on, Array<number>(10).fill(v)).miles.follows).toBeCloseTo(10, 12);
  });

  it('a route flickering between adj 1 and 2 along a line is following', () => {
    const k = [1, 2, 1, 2, 2, 1, 1, 2, 1, 2];
    const c = cross(k.map((v) => (v === 1 ? L230 : 0)), k.map(adj));
    expect(c.counts.line230).toBe(0);
    expect(c.miles.follows).toBeCloseTo(10, 12);
  });

  it('joining a line suppresses the entry that starts the stretch; a later entry inside it, and one after it, count', () => {
    // cells 0–2 off the line, 3–12 along it, 13–16 off it, 17–18 back on it inside the stretch (flickering class 1/2), 19 off
    const f = [0, 0, 0, ...Array<number>(10).fill(L230), 0, 0, 0, 0, L230, 0, 0, 0];
    const a = [0, 0, 0, ...Array<number>(10).fill(adj(1)), adj(2), adj(2), adj(2), adj(2), adj(1), adj(2), adj(2), adj(2)].map((v) => (v ? v : adj(0)));
    const c = cross(f, a);
    expect(c.counts.line230).toBe(1);   // the join at cell 3 is suppressed; the stretch is cells 3–20, the re-entry at 17 counts
    expect(c.points[0].mi).toBeCloseTo(17.5, 12);
    expect(c.miles.follows).toBeCloseTo(18, 12);
  });

  it('a crossing after a following stretch counts', () => {
    const f = [...Array<number>(10).fill(L230), 0, 0, 0, 0, 0, L230, 0, 0];
    const a = [...Array<number>(10).fill(adj(1)), adj(0), adj(0), adj(0), adj(0), adj(0), adj(1), adj(0), adj(0)];
    const c = cross(f, a);
    expect(c.counts.line230).toBe(1);
    expect(c.points[0].mi).toBeCloseTo(15.5, 12);
    expect(c.miles.follows).toBeCloseTo(10, 12);
  });

  it('a band absent from `present` counts nothing (never read as 0)', () => {
    const { sampler, coords } = line({ agency: [0, 0, 2, 2], flags: [1, 1, 1, 1] }, 4);
    const without = new Set([...all].filter((b) => b !== 'agency' && b !== 'flags'));
    const c = buildCrossings(coords, sampler, { toLngLat, lengthMi: 4, present: without });
    expect(c.miles.byAgency).toEqual({});
    expect(c.miles.tribal).toBe(0);
    const w = buildCrossings(coords, sampler, { toLngLat, lengthMi: 4, present: all });
    expect(w.miles.byAgency).toEqual({ 2: 2 });   // agency 0 is nodata: skipped
    expect(w.miles.tribal).toBeCloseTo(4, 12);
  });
});

describe('park and wetland miles', () => {
  it('park = flags bit 6; wetland = code >= 27 (share >= 26 %); each counts its cells only', () => {
    const { sampler, coords } = line({ flags: [0, 1 << 6, 1 << 6, 0], wetland: [1, 26, 27, 101] }, 4);
    const c = buildCrossings(coords, sampler, { toLngLat, lengthMi: 4, present: all });
    expect(c.miles.park).toBeCloseTo(2, 12);
    expect(c.miles.wetland).toBeCloseTo(2, 12);
    const w = buildCrossings(coords, sampler, { toLngLat, lengthMi: 4, present: new Set([...all].filter((b) => b !== 'wetland' && b !== 'flags')) });
    expect(w.miles.park).toBe(0);
    expect(w.miles.wetland).toBe(0);
  });
});

describe('buildProfile', () => {
  it('homes: bldg codes fold to the tm-default steps; runs split only where the step changes', () => {
    const { sampler, coords } = line({ bldg: [0, 1, 2, 3, 4, 10, 11, 255] }, 8);
    const p = buildProfile(coords, sampler, opts(8));
    expect(p.runs.map((r) => r.homes)).toEqual([null, 0, 1, 2, 3]);
    expect(p.runs.map((r) => r.mi1 - r.mi0)).toEqual([1, 1, 2, 2, 2]);
    const q = buildProfile(coords, sampler, opts(8, new Set(['landcover'])));
    expect(q.runs.map((r) => r.homes)).toEqual([null]);
  });

  it('nulls fields whose band is absent or not given, and agency 0 (nodata)', () => {
    const { sampler, coords } = line({ landcover: [71, 71], agency: [0, 0], protect: [0, 2] }, 2);
    const p = buildProfile(coords, sampler, opts(1, new Set([...all].filter((b) => b !== 'landcover'))));
    expect(p.runs.map((r) => [r.landcover, r.agency, r.gap])).toEqual([[null, null, null], [null, null, 2]]);
    // agency not given by the sampler at all → null, not 0
    const q = buildProfile(line({ landcover: [71, 71] }, 2).coords, line({ landcover: [71, 71] }, 2).sampler, opts(1));
    expect(q.runs).toHaveLength(1);
    expect(q.runs[0]).toMatchObject({ landcover: 71, agency: null, gap: null, tribal: false, follows: 0 });
  });

  it('merges equal cells into runs, scales the last mi1 to lengthMi, one sample per cell', () => {
    const lengthMi = 0.123456789;
    const { sampler, coords } = line({ landcover: [71, 71, 11, 11, 11, 71], flags: [0, 0, 0, 1, 1, 0] }, 6);
    const p = buildProfile(coords, sampler, opts(lengthMi));
    expect(p.runs.map((r) => [r.landcover, r.tribal, r.costX, r.routeW])).toEqual([
      [71, false, 1, 1], [11, false, 1.5, 2], [11, true, 1.5, 2], [71, false, 1, 1],
    ]);
    expect(p.runs[p.runs.length - 1].mi1).toBe(lengthMi);
    for (let i = 1; i < p.runs.length; i++) expect(p.runs[i].mi0).toBeCloseTo(p.runs[i - 1].mi1, 12);
    expect(p.runs[1].mi0).toBeCloseTo(2 / 6 * lengthMi, 12);
    expect(p.samples).toHaveLength(6);
    expect(p.samples.map((s) => s.lngLat[0])).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
    expect(p.samples[3].mi).toBeCloseTo(3.5 / 6 * lengthMi, 12);
    expect(p.crossings.miles.tribal).toBeCloseTo(2 / 6 * lengthMi, 12);
  });

  it('driver: the routing winner with the largest |ln r|; null when every r = 1', () => {
    // col 0: none; col 1: landcover only (×2); col 2: both (slope ×0.25 wins |ln|).
    const { sampler, coords } = line({ landcover: [71, 11, 11], slope: [1, 1, 5] }, 3);
    const p = buildProfile(coords, sampler, opts(3));
    expect(p.runs.map((r) => r.driver)).toEqual([null, 'landcover', 'slope']);
    expect(p.samples).toHaveLength(3);   // the joint at x = 1.5 splits no cell
    expect(p.runs[2].routeW).toBe(0.5);
    expect(p.runs[2].costX).toBe(1.5);
  });
});

describe('aviation miles and the assumed height', () => {
  it('miles per code 2–6 equal the cells\' metres; 0/1 are skipped; an absent band counts nothing', () => {
    const { sampler, coords } = line({ aviation: [0, 1, 2, 3, 4, 5, 5, 6] }, 8);
    const c = buildCrossings(coords, sampler, { toLngLat, lengthMi: 8, present: all });
    expect(c.miles.aviation).toEqual({ 2: 1, 3: 1, 4: 1, 5: 2, 6: 1 });
    expect(c.miles.aviation[5]).toBeGreaterThan(0);
    expect(c.aviationHeightM).toBeNull();
    const w = buildCrossings(coords, sampler, { toLngLat, lengthMi: 8, present: new Set([...all].filter((b) => b !== 'aviation')) });
    expect(w.miles.aviation).toEqual({});
  });

  const heightOf = (p: RoutePreset, lt: string) => {
    const { sampler, coords } = line({ aviation: [1, 1] }, 2);
    return buildProfile(coords, sampler, { compiled: compile(p, lt), preset: p, lineTypeId: lt, toLngLat, lengthMi: 2, present: all }).crossings.aviationHeightM;
  };
  it('tm-default screens at 61 / 46 / 30 m by line type; pnas-wu2023 has none', () => {
    expect(heightOf(tm, 'ac500')).toBe(61);
    expect(heightOf(tm, 'ac345')).toBe(46);
    expect(heightOf(tm, 'ac115')).toBe(30);
    expect(heightOf(routePreset('pnas-wu2023')!, 'ac500')).toBeNull();
  });

  it('follows a patched row, not the line type', () => {
    const patched: RoutePreset = {
      ...tm, rows: tm.rows.map((r) => r.band === 'aviation' && r.line_types?.includes('ac500') ? { ...r, match: { codes: [4, 5, 6] } } : r),
    };
    expect(heightOf(patched, 'ac500')).toBe(46);
    expect(aviationHeightM(patched, 'ac500')).toBe(46);
  });

  it('a row counts when only its cost_x is above 1, and not when both are 1', () => {
    const only = (r: Partial<CostRow>): RoutePreset => ({
      ...tm, rows: tm.rows.map((x) => x.band === 'aviation' && x.line_types?.includes('ac500') ? { ...x, ...r } : x),
    });
    expect(aviationHeightM(only({ route_w: 1, cost_x: 1.2 }), 'ac500')).toBe(61);
    expect(aviationHeightM(only({ route_w: 1, cost_x: 1 }), 'ac500')).toBeNull();
    expect(aviationHeightM(only({ route_w: 0.5, cost_x: 1 }), 'ac500')).toBe(61);   // a pull toward the surfaces is weighing them too
    expect(aviationHeightM(only({ route_w: 1, cost_x: { ramp: [1, 2] } }), 'ac500')).toBe(61);
  });
});
