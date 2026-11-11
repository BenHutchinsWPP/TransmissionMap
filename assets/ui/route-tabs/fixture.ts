// ─── Route panel test fixture ────────────────────────────────────────────────
// Role: one plausible RouteResult (≈ 250 mi 500 kV AC, McNary → Hemingway, tm-default, total
//       ≈ $3.1 B 2025$; `fixtureCost` takes the end kinds) with profile, crossings and two alternatives, a RouteSession around it and a
//       recording RouteTabContext, so every tab and widget test starts from the same data.
//       Test support only: nothing in the app imports this.
// Deps: route/route.ts, route/cost.ts, route/profile.ts (types), registry/route-presets.ts, ./types.ts.

import type { RouteResult, RouteAlternative } from '../../route/route.js';
import type { CostResult } from '../../route/cost.js';
import { escalationFactor } from '../../route/cost.js';
import type { RouteCrossings, CrossingPoint, ProfileRun, ProfileSample } from '../../route/profile.js';
import { routePreset, type EndKind } from '../../../src/registry/route-presets.js';
import type { RouteSession, RouteTabContext } from './types.js';

const PRESET = routePreset('tm-default')!;
const LEN_MI = 250.1;
const A: [number, number] = [-119.3, 45.93];
const B: [number, number] = [-116.78, 43.29];
const PATH: [number, number][] = [A, [-118.7, 45.2], [-118.1, 44.7], [-117.6, 44.2], [-117.0, 43.7], B];

/** tm-default row indices the fixture's per-row $ refer to. */
const ROW = { forest: 0, suburban: 1, rolling: 8, mountain: 9, tubular: 10, whpHigh: 11 };

/** A consistent CostResult: base + Σ perRow + other = line$ / lengthFactor; totals follow. */
export function fixtureCost(lengthFactor = 1, lengthMi = LEN_MI, kinds: [EndKind, EndKind] = ['new', 'new']): CostResult {
  const M = 1e6;
  const baseUsd = 3_071_750 * lengthMi;
  const perRow = [
    { row: ROW.forest, usd: 38.0 * M, affectedM: 41e3 },
    { row: ROW.suburban, usd: 21.4 * M, affectedM: 19e3 },
    { row: ROW.rolling, usd: 118.9 * M, affectedM: 160e3 },
    { row: ROW.mountain, usd: 231.5 * M, affectedM: 120e3 },
    { row: ROW.tubular, usd: 8.6 * M, affectedM: 22e3 },
    { row: ROW.whpHigh, usd: 3.7 * M, affectedM: 30e3 },
  ];
  const otherUsd = 0.6 * M;
  const rawLine = baseUsd + perRow.reduce((s, r) => s + r.usd, 0) + otherUsd;
  const lineUsdNominal = rawLine * lengthFactor;
  const mid = 0.7 * M * lengthFactor, rowLand = 12.0 * M;
  const markupsUsd = (lineUsdNominal + rowLand) * 0.175;
  const station = 34_582_007, position = 10_524_963;   // tm-default ac500 station and line position, 2014$ (B&V T4-6 × 1.175)
  const items = ([['A', kinds[0]], ['B', kinds[1]]] as const).filter(([, k]) => k !== 'none')
    .map(([end, kind]) => ({ kind, end, usd: kind === 'position' ? position : station }));
  const nPos = items.filter((i) => i.kind === 'position').length;
  const terminalsUsd = (items.length - nPos) * station + nPos * position;
  const subtotal = lineUsdNominal + markupsUsd + mid + terminalsUsd + rowLand;
  const cont = { usd: subtotal * 0.3, pct: 0.3, label: PRESET.contingency?.label ?? 'Contingency' };
  const totalNominal = subtotal + cont.usd;
  const total2025 = totalNominal * escalationFactor(2014, 2025);
  return {
    preset: 'tm-default', lineType: 'ac500', dollarYear: 2014, lengthM: lengthMi * 1609.344, lengthFactor, baseUsd, perRow, otherUsd,
    lineUsdNominal, markupsUsd, mitigationUsd: { low: mid * 0.7, mid, high: mid * 1.8 },
    rowLand: { usd: rowLand, note: 'County land values × 150 ft width', missingMi: 0 },
    terminalCount: items.length, terminalsUsd, terminalItems: items, contingency: cont, totalNominal, total2025,
    band: { low: total2025 * 0.7, high: total2025 * 1.5, label: 'Rough early estimate (−30 % / +50 %)' },
    meanCostX: rawLine / baseUsd, perBand: [], segments: [{ lengthM: lengthMi * 1609.344, usd: lineUsdNominal, meanCostX: rawLine / baseUsd }],
    tribalMiles: 6.3, barrierM: 0, notes: [PRESET.caveat],
  };
}

function along(mi: number): [number, number] {
  const f = Math.min(1, Math.max(0, mi / LEN_MI)) * (PATH.length - 1);
  const i = Math.min(PATH.length - 2, Math.floor(f)), u = f - i;
  return [PATH[i][0] + (PATH[i + 1][0] - PATH[i][0]) * u, PATH[i][1] + (PATH[i + 1][1] - PATH[i][1]) * u];
}

const RUN_BASE: Omit<ProfileRun, 'mi0' | 'mi1'> = {
  landcover: 52, agency: 1, gap: null, tribal: false, critHab: false, phma: false, s368: false, homes: 0, follows: 0, costX: 1, routeW: 1, driver: null,
};
const RUN_SPECS: Partial<ProfileRun>[] = [
  { landcover: 82, agency: 1, homes: 1 },
  { landcover: 22, agency: 1, homes: 3, costX: 1.27, routeW: 1.27, driver: 'terrain:landcover' },
  { landcover: 52, agency: 3, gap: 3, costX: 1.4, routeW: 2.8, driver: 'protection' },
  { landcover: 52, agency: 3, s368: true, follows: 1, costX: 1.4, routeW: 0.8, driver: 'parallel' },
  { landcover: 42, agency: 6, costX: 2.25, routeW: 2.25, driver: 'terrain:landcover', critHab: true },
  { landcover: 52, agency: 1, tribal: true, costX: 1.3, routeW: 100, driver: 'flags:0' },
  { landcover: 71, agency: 2, phma: true, costX: 1.75, routeW: 20, driver: 'flags2:0' },
  { landcover: 71, agency: 2, phma: true, s368: true, follows: 2, costX: 1.75, routeW: 1.75, driver: 'terrain:slope' },
  { landcover: 71, agency: 3, gap: 2, costX: 1.4, routeW: 10, driver: 'protection' },
  { landcover: 31, agency: 3, follows: 1, costX: 1.05, routeW: 0.5, driver: 'parallel' },
  { landcover: 82, agency: 1, homes: 2, costX: 1.5, routeW: 1.5, driver: 'flags:5' },
  { landcover: 21, agency: 1, follows: 0 },
];
const RUNS: ProfileRun[] = RUN_SPECS.map((s, i) => ({
  ...RUN_BASE, ...s, mi0: (LEN_MI * i) / RUN_SPECS.length, mi1: i === RUN_SPECS.length - 1 ? LEN_MI : (LEN_MI * (i + 1)) / RUN_SPECS.length,
}));
const SAMPLES: ProfileSample[] = Array.from({ length: 40 }, (_, i) => {
  const mi = (LEN_MI * i) / 39;
  return { mi, lngLat: along(mi) };
});

function crossingsFor(scale: number): RouteCrossings {
  const counts = { river: 6, road: 9, rail: 4, pipeline: 5, line230: 7, line100: 4 };
  const points: CrossingPoint[] = [];
  let n = 0;
  for (const kind of Object.keys(counts) as CrossingPoint['kind'][]) {
    for (let i = 0; i < counts[kind]; i++, n++) {
      const mi = (((n * 37) % 97) / 97) * LEN_MI * 0.98 + 1;
      points.push({ kind, mi, lngLat: along(mi) });
    }
  }
  points.sort((a, b) => a.mi - b.mi);
  return {
    points, counts,
    miles: {
      follows: 38.2 * scale, s368: 61.0 * scale, gap12: 8.4 * scale, gap3: 13.0 * scale, critHab: 3.1 * scale, phma: 17.6 * scale, tribal: 6.3, park: 2.2 * scale, wetland: 5.4 * scale,
      byAgency: { 1: 120.4, 2: 41.3, 3: 70.9, 6: 17.5 }, desig: { 2: 4.4, 4: 2.1 }, aviation: { 2: 3.2, 3: 1.1, 4: 0.8, 5: 0.4, 6: 0.2 },
    },
    aviationHeightM: 61,
  };
}

function alt(i: number, lengthFactor: number, pctUsd: number, shared: number, lengthMi: number): RouteAlternative {
  const cost = fixtureCost(lengthFactor, lengthMi);
  const bend = i === 0 ? 0.35 : -0.4;
  return {
    path: { type: 'LineString', coordinates: PATH.map((p, k) => (k === 0 || k === PATH.length - 1 ? p : [p[0] + bend * Math.sin((k / PATH.length) * Math.PI), p[1]])) },
    lengthMi, cost, routeCostRaw: 1e9 * (1 + pctUsd / 100), pctRoute: pctUsd * 0.8, pctUsd, shared: shared, sharedWithRoute: shared - 0.05,
    crossings: crossingsFor(0.9 + i * 0.2), ms: 900 + i * 150,
  };
}

export const FIXTURE_RESULT: RouteResult = {
  path: { type: 'LineString', coordinates: PATH },
  lengthMi: LEN_MI,
  cost: fixtureCost(),
  segments: PATH.slice(1).map((p, i) => ({ from: PATH[i], to: p, lengthMi: LEN_MI / (PATH.length - 1), usd: fixtureCost().lineUsdNominal / (PATH.length - 1), meanCostX: 1.55 })),
  tribalMiles: 6.3,
  tribalNote: null,
  optimality: 'within-mask',
  maskLimited: false,
  bufferM: 30_000,
  cells: { bbox: 4_000_000, mask: 1_200_000, visited: 900_000, path: 1_100, pis: 48 },
  timingsMs: { read: 800, surfaces: 300, solve: 1_400, prove: 0, reduce: 20, similar: 0, alternatives: 0, total: 2_600, attempts: [2_600] },
  routeCost: { raw: 1.6e9, pis: 1.605e9 },
  preset: { id: PRESET.id, label: PRESET.label, attribution: PRESET.attribution, caveat: PRESET.caveat },
  surface: { skipped: 'Similar-cost areas were not requested for this fixture.' },
  alternatives: [alt(0, 1, 4.2, 0.62, 258.4), alt(1, 1, 9.8, 0.35, 266.9)],
  altFound: 2,
  altMethod: 'penalty',
  profile: { runs: RUNS, samples: SAMPLES, crossings: crossingsFor(1) },
};

export function FIXTURE_SESSION(): RouteSession {
  const inputs = { a: { lngLat: A, hit: null }, b: { lngLat: B, hit: null }, lineType: 'ac500', presetId: 'tm-default', patch: null };
  return {
    inputs, status: { kind: 'result' }, result: FIXTURE_RESULT, resultInputs: { ...inputs }, previous: null,
    altsSolving: false, altsError: null, tab: 'summary', colour: 'cost', threshold: 0.05, showSurface: false, dollars: 'y2025', liveTuning: false,
    crossingKinds: ['river', 'road', 'rail'], altStretch: 0.2, highlight: [],
  };
}

const fmtMoney = (v: number) => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)} B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(Math.abs(v) >= 1e8 ? 0 : 1)} M` : `$${Math.round(v / 1e3)} k`);

/** A RouteTabContext whose every call is recorded in `calls` as `name(json args)`. */
export function fakeTabContext(session: RouteSession): RouteTabContext & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string, ...args: unknown[]) => { calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`); };
  return {
    session, calls,
    money: (usd2025, usdPreset) => fmtMoney(session.dollars === 'y2025' ? usd2025 : usdPreset),
    setColourMode: (m) => rec('setColourMode', m),
    setProfileMarker: (mi) => rec('setProfileMarker', mi),
    showCrossings: (kinds, on) => {
      rec('showCrossings', kinds, on);
      session.crossingKinds = on ? [...new Set([...session.crossingKinds, ...kinds])] : session.crossingKinds.filter((k) => !kinds.includes(k));
    },
    fitMiles: (a, b) => rec('fitMiles', a, b),
    fitPoints: (p) => rec('fitPoints', p),
    listExactCrossings: () => rec('listExactCrossings'),
    setThreshold: (x) => rec('setThreshold', x),
    showSurface: (on) => rec('showSurface', on),
    findAlternatives: () => rec('findAlternatives'),
    makeAltResult: (i) => rec('makeAltResult', i),
    resolve: (patch) => { rec('resolve', patch); return Promise.resolve(); },
    runSolves: (specs, onEach) => {
      rec('runSolves', specs);
      specs.forEach((_, i) => onEach(i, null, 'fixture'));
      return { cancel: () => rec('cancel'), done: Promise.resolve() };
    },
    setGhost: (p) => rec('setGhost', p),
    setTall: (on) => rec('setTall', on),
    setMethodErrors: (n) => rec('setMethodErrors', n),
    rerender: () => rec('rerender'),
  };
}
