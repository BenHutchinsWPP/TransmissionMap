// lineProfile with both samplers stubbed: spacing, the Terrarium fill, gaps, stats and the CSV.
import { describe, expect, it } from 'vitest';
import { lineProfile, profileCsv, profileStats, reaches3dep, reversed, sampleStep, type ProfilePoint } from './profile.js';
import { densify, pathLengthM } from './along.js';
import { setUnits } from '../../src/units.js';

describe('densify', () => {
  it('a point every step along the line, and its end', () => {
    const line = [[0, 0], [0.01, 0], [0.01, 0.01]];
    const L = pathLengthM(line);
    const pts = densify(line, 100);
    expect(pts[0].d).toBe(0);
    expect(pts.at(-1)!.d).toBeCloseTo(L, 6);
    expect(pts.at(-1)!.pos).toEqual([0.01, 0.01]);
    expect(pts.length).toBe(Math.floor(L / 100) + 2);
    for (let i = 1; i + 1 < pts.length; i++) expect(pts[i].d - pts[i - 1].d).toBeCloseTo(100, 6);
  });
});

describe('sampleStep', () => {
  it('30 m up to 150 km, then L / 4,999 (5,000 samples)', () => {
    expect(sampleStep(10_000)).toBe(30);
    expect(sampleStep(321_869)).toBeCloseTo(64.39, 2);
  });
});

describe('lineProfile', () => {
  const line = [[-120, 45], [-120, 45.01]];   // ~1.1 km → 30 m spacing
  it('3DEP first, Terrarium for the points it left empty, a gap where neither answered', async () => {
    let terrariumAsked = 0;
    let pixel = 0;
    const p = await lineProfile(line, {
      sample3dep: async (pts, o) => { pixel = o.pixelSize!; return { values: pts.map((_, i) => (i % 3 === 1 ? null : 100 + i)), requests: 1, bytes: 10, failedBatches: 0 }; },
      sampleTerrarium: async pts => { terrariumAsked = pts.length; return pts.map((_, k) => (k === 0 ? null : 50)); },
    });
    expect(pixel).toBe(10);
    expect(p.stepM).toBe(30);
    const n = p.points.length;
    expect(terrariumAsked).toBe(p.points.filter((_, i) => i % 3 === 1).length);
    expect(p.points[0]).toMatchObject({ m: 100, src: '3dep' });
    expect(p.points[1]).toMatchObject({ m: null, src: null });   // the first Terrarium point failed: a gap, not 0
    expect(p.points[4]).toMatchObject({ m: 50, src: 'terrarium' });
    expect(n).toBeGreaterThan(30);
  });
  it('asks for 30 m pixels on a long line', async () => {
    let pixel = 0;
    await lineProfile([[-120, 40], [-115, 40]], {
      sample3dep: async (pts, o) => { pixel = o.pixelSize!; expect(pts.length).toBeLessThanOrEqual(5000); return { values: pts.map(() => 1), requests: 5, bytes: 0, failedBatches: 0 }; },
      sampleTerrarium: async () => { throw new Error('not needed'); },
    });
    expect(pixel).toBe(30);
  });
});

const pts = (ms: (number | null)[]): ProfilePoint[] => ms.map((m, i) => ({ d: i * 100, pos: [0, 0], m, src: m === null ? null : i % 2 ? 'terrarium' : '3dep' }));

describe('profileStats', () => {
  it('min and max, climb and descent with a 2 m hysteresis, sources and gaps', () => {
    const s = profileStats(pts([100, 101, 100, 101, 110, null, 105, 120, 90]));
    expect(s.min!.m).toBe(90);
    expect(s.max!.m).toBe(120);
    expect(s.climbM).toBe(10 + 15);     // the 1 m wobbles are noise
    expect(s.descentM).toBe(5 + 30);
    expect(s.nGap).toBe(1);
    expect(s.n3dep + s.nTerrarium).toBe(8);
  });
});

describe('reversed', () => {
  it('walks from the other end', () => {
    const p = { points: pts([1, 2, 3]), lengthM: 200, stepM: 100, requests: 0, bytes: 0, failedBatches: 0, ms: 0 };
    const r = reversed(p);
    expect(r.points.map(q => [q.d, q.m])).toEqual([[0, 3], [100, 2], [200, 1]]);
  });
});

describe('profileCsv', () => {
  it('BOM, display units, a source per row, guarded cells and the credits', () => {
    setUnits({ distance: 'mi', elevation: 'ft' });
    const p = { points: pts([100, null]), lengthM: 100, stepM: 100, requests: 0, bytes: 0, failedBatches: 0, ms: 0 };
    const csv = profileCsv(p, { title: '=HYPERLINK("x")', lineCredit: '&copy; <a href="#">OpenStreetMap</a> contributors' });
    const lines = csv.split('\r\n');
    expect(csv.startsWith('﻿distance_mi,lon,lat,elev_ft,source')).toBe(true);
    expect(lines[1]).toBe('0,0,0,328.1,USGS 3DEP');
    expect(lines[2]).toBe('0.0621,0,0,,none');
    expect(lines[3].startsWith("\"'=HYPERLINK")).toBe(true);
    expect(csv).toContain('NAVD88');
    expect(csv).toContain('Elevation: USGS 3D Elevation Program (3DEP), public domain');
    expect(csv).toContain('ODbL');
    setUnits({ distance: 'km', elevation: 'm' });
  });
});

describe('reaches3dep', () => {
  it('true when any sample falls in 3DEP coverage, false for a line wholly outside it', () => {
    expect(reaches3dep([[-105, 40], [-104.9, 40.1]])).toBe(true);
    expect(reaches3dep([[10, 50], [10.2, 50.1]])).toBe(false);                 // Germany
    expect(reaches3dep([[-123.3, 49.3], [-123.2, 49.7]])).toBe(true);          // crosses into Canada from Washington
  });
});
