// ─── Line elevation profile (data) ───────────────────────────────────────────
// Role: the elevation along a line's true geometry (docs/line-tools.md), for the
//       Line tab's Profile section (ui/line-profile.ts).
//   sampleStep(lengthM)        s = max(30 m, L / 4,999): at most 5,000 samples (≤ 5 USGS requests)
//   lineProfile(line, opts)    densify at s (along.ts), sample USGS 3DEP (elevation/usgs-3dep.ts;
//                              pixelSize 10 m, or 30 m when s ≥ 60 m), then fill every point 3DEP
//                              left empty from Terrarium (elevation/terrarium.ts); each point says
//                              which source answered, and a point neither answered stays a gap
//                              (null), never 0. Also reports requests, bytes and time.
//   reaches3dep(line)          whether any sample falls in 3DEP's coverage (so goes to USGS)
//   reversed(profile)          the same profile walked from the other end
//   profileStats(points)       min / max (with where), total climb and descent with a 2 m
//                              hysteresis, and the count per source and of gaps
//   profileCsv(profile, meta)  distance_<unit>,lon,lat,elev_<unit>,source; a BOM, formula-guarded
//                              cells (user-data-export.ts toCsv), notes on the datum and the
//                              elevation credits, and the line's credit as the last row
// Deps: lines/along.ts (densify, pathLengthM), elevation/usgs-3dep.ts, elevation/terrarium.ts,
//       user-data/user-data-export.ts (toCsv), src/units.ts.

import { densify, pathLengthM, type Pos } from './along.js';
import { sample3dep, in3depArea, USGS_3DEP_CREDIT, type Sample3depOpts } from '../elevation/usgs-3dep.js';
import { sampleElevation, TERRAIN_CREDIT } from '../elevation/terrarium.js';
import { toCsv } from '../user-data/user-data-export.js';
import { convElevation, getUnits, unitLabel } from '../../src/units.js';

export type ElevSource = '3dep' | 'terrarium';
export interface ProfilePoint { d: number; pos: Pos; m: number | null; src: ElevSource | null }
export interface LineProfile {
  points: ProfilePoint[];
  lengthM: number;
  stepM: number;
  requests: number;        // USGS POSTs
  bytes: number;           // USGS response characters
  failedBatches: number;
  ms: number;
}
export type ProfileProgress = { phase: '3dep'; done: number; total: number } | { phase: 'terrarium' };

export const MAX_SAMPLES = 5000;
export const MIN_STEP_M = 30;
export const HYSTERESIS_M = 2;

export const sampleStep = (lengthM: number): number => Math.max(MIN_STEP_M, lengthM / (MAX_SAMPLES - 1));

export interface ProfileOpts {
  signal?: AbortSignal;
  onProgress?: (p: ProfileProgress) => void;
  sample3dep?: (pts: number[][], o: Sample3depOpts) => ReturnType<typeof sample3dep>;
  sampleTerrarium?: (pts: [number, number][], o: { signal?: AbortSignal }) => Promise<(number | null)[]>;
}

/** Whether lineProfile would send any of the line's samples to USGS (the same densify and coverage test). */
export const reaches3dep = (line: Pos[]): boolean =>
  densify(line, sampleStep(pathLengthM(line))).some(p => in3depArea(p.pos));

export async function lineProfile(line: Pos[], opts: ProfileOpts = {}): Promise<LineProfile> {
  const t0 = performance.now();
  const { signal, onProgress, sample3dep: usgs = sample3dep, sampleTerrarium = sampleElevation } = opts;
  const along = densify(line, sampleStep(pathLengthM(line)));
  const lengthM = along[along.length - 1].d;
  const stepM = sampleStep(lengthM);
  const r = await usgs(along.map(p => p.pos), {
    signal, pixelSize: stepM >= 60 ? 30 : 10,
    onBatch: (done, total) => onProgress?.({ phase: '3dep', done, total }),
  });
  const points: ProfilePoint[] = along.map((p, i) => ({ ...p, m: r.values[i], src: r.values[i] === null ? null : '3dep' }));
  const missing = points.filter(p => p.m === null);
  if (missing.length) {
    onProgress?.({ phase: 'terrarium' });
    const fill = await sampleTerrarium(missing.map(p => [p.pos[0], p.pos[1]]), { signal });
    missing.forEach((p, k) => { const v = fill[k]; if (v !== null && Number.isFinite(v)) { p.m = v; p.src = 'terrarium'; } });
  }
  return { points, lengthM, stepM, requests: r.requests, bytes: r.bytes, failedBatches: r.failedBatches, ms: performance.now() - t0 };
}

export function reversed(p: LineProfile): LineProfile {
  return { ...p, points: p.points.map(q => ({ ...q, d: p.lengthM - q.d })).reverse() };
}

export interface ProfileStats {
  min: ProfilePoint | null;
  max: ProfilePoint | null;
  climbM: number;
  descentM: number;
  n3dep: number;
  nTerrarium: number;
  nGap: number;
}

export function profileStats(points: ProfilePoint[], hysteresisM = HYSTERESIS_M): ProfileStats {
  const s: ProfileStats = { min: null, max: null, climbM: 0, descentM: 0, n3dep: 0, nTerrarium: 0, nGap: 0 };
  let ref: number | null = null;
  for (const p of points) {
    if (p.m === null) { s.nGap++; continue; }
    if (p.src === '3dep') s.n3dep++; else s.nTerrarium++;
    if (!s.min || p.m < s.min.m!) s.min = p;
    if (!s.max || p.m > s.max.m!) s.max = p;
    if (ref === null) ref = p.m;
    else if (p.m - ref >= hysteresisM) { s.climbM += p.m - ref; ref = p.m; }
    else if (ref - p.m >= hysteresisM) { s.descentM += ref - p.m; ref = p.m; }
  }
  return s;
}

/** The credits for the sources a profile used. */
export function profileCredits(st: Pick<ProfileStats, 'n3dep' | 'nTerrarium'>): string[] {
  return [st.n3dep ? USGS_3DEP_CREDIT : '', st.nTerrarium ? TERRAIN_CREDIT : ''].filter(Boolean);
}

export const SOURCE_NAME: Record<ElevSource, string> = { '3dep': 'USGS 3DEP', terrarium: 'Terrain Tiles' };

export function profileCsv(p: LineProfile, meta: { title: string; lineCredit?: string }): string {
  const du = getUnits().distance, dm = du === 'mi' ? 1609.344 : 1000, eu = unitLabel('elevation');
  const fd = `distance_${du}`, fe = `elev_${eu}`;
  const rows = p.points.map(q => ({
    [fd]: +(q.d / dm).toFixed(4),
    lon: +q.pos[0].toFixed(6),
    lat: +q.pos[1].toFixed(6),
    [fe]: q.m === null ? '' : +convElevation(q.m).toFixed(1),
    source: q.src ? SOURCE_NAME[q.src] : 'none',
  }));
  const st = profileStats(p.points);
  const notes = [
    `${meta.title}: elevation profile from end A, a sample every ${Math.round(p.stepM)} m`,
    'Vertical datum: USGS 3DEP is NAVD88 in CONUS and Alaska (local datums in Hawaii and the territories); Terrain Tiles mix sources and datums',
    ...profileCredits(st).map(c => `Elevation: ${c}`),
  ];
  return '﻿' + toCsv(rows, [fd, 'lon', 'lat', fe, 'source'], meta.lineCredit, notes);
}
