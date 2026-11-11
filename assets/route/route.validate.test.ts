// Input check (excluded from `npm test`, like every *.validate.test.ts): costs the 27 PNAS (Wu et al.
// 2023) corridor geometries on our bands with the pnas-wu2023 preset (costPolyline) and compares each
// with PNAS's own published cost (data/build/route/validate/pnas_corridors.geojson, written by
// scripts/route_validation_inputs.py). Gate (docs/internal/routing-notes.md § Checks): median ours/theirs within ±15 %.
// Prints a per-corridor table and a per-band contribution table. Skips when the cube or inputs are absent.
// Routed check (second describe): ROUTES each corridor end to end with route() (pnas-wu2023, HVAC, endpoints = the
// PNAS line ends) and computes the gates (length median, line-only $/mi, perf) plus report-only
// rows (HVDC $/mi, detour, optimality, PI count, WestTEC under tm-default). ROUTE_VALIDATION_OUT=<file.json>
// also writes the rows as JSON. Thresholds are fixed; they change only for a sourced input difference.
// Run: npx vitest run --config vitest.route.config.ts assets/route/route.validate.test.ts --reporter=verbose --disableConsoleIntercept
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, openSync, readSync } from 'node:fs';
import { openTiff, readTile, type Fetcher, type TiffInfo } from './cog-read.js';
import { albersForward } from './grid.js';
import { route, PD_BANDS, OSM_BANDS, readGridJson, type RouteIO, type RouteResult } from './route.js';
import { costPath, greatCircleM, METRES_PER_MILE, type Sampler } from './cost.js';
import { routePreset, type BandName } from '../../src/registry/route-presets.js';

const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const INPUT = 'data/build/route/validate/pnas_corridors.geojson';
const have = existsSync(CUBE + 'grid.json') && existsSync(INPUT);

const PD = PD_BANDS, OSM = OSM_BANDS;
const meta = have ? readGridJson(JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'))) : null;
if (typeof meta === 'string') throw new Error(meta);
const CONSTS = meta ? { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval } : {};
const TOL = 0.15;

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}

/** Sampler over the real cube: tiles decoded on demand, cached; a super-tile that is absent is all nodata. */
async function cubeSampler(): Promise<Sampler> {
  const g = JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'));
  const [x0, y0] = g.origin as [number, number];
  const files = new Map<string, { f: Fetcher; info: TiffInfo } | null>();
  const tiles = new Map<string, Uint8Array>();
  const open = async (kind: string, sc: number, sr: number) => {
    const key = `${kind}_${sc}_${sr}`;
    if (!files.has(key)) {
      const p = `${CUBE}${key}.tif`;
      if (!existsSync(p)) files.set(key, null);
      else { const f = fileFetcher(p); files.set(key, { f, info: await openTiff(f) }); }
    }
    return files.get(key)!;
  };
  // The cache is filled up front by `load()`; at() is synchronous.
  const load = async (col: number, row: number) => {
    const sc = Math.floor(col / g.super), sr = Math.floor(row / g.super);
    const tx = Math.floor((col - sc * g.super) / g.block), ty = Math.floor((row - sr * g.super) / g.block);
    for (const kind of ['pd', 'osm']) {
      const k = `${kind}_${sc}_${sr}_${tx}_${ty}`;
      if (tiles.has(k)) continue;
      const file = await open(kind, sc, sr);
      tiles.set(k, file ? await readTile(file.info, file.f, tx, ty) : new Uint8Array(0));
    }
  };
  const sampler = {
    cellM: g.cell as number, x0, y0,
    load,
    at(col: number, row: number) {
      if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;
      const sc = Math.floor(col / g.super), sr = Math.floor(row / g.super);
      const lc = col - sc * g.super, lr = row - sr * g.super;
      const tx = Math.floor(lc / g.block), ty = Math.floor(lr / g.block);
      const i = ((lr - ty * g.block) * g.block + (lc - tx * g.block));
      const out: Partial<Record<BandName, number>> = {};
      for (const [kind, names] of [['pd', PD], ['osm', OSM]] as const) {
        const t = tiles.get(`${kind}_${sc}_${sr}_${tx}_${ty}`);
        if (!t) throw new Error(`tile ${kind} ${sc}_${sr}_${tx}_${ty} not preloaded`);
        names.forEach((n, b) => { out[n] = t.length ? t[i * names.length + b] : 0; });
      }
      return out;
    },
  };
  return sampler as Sampler & { load: typeof load };
}

/** Preloads every tile along a polyline (Albers metres), stepping at most 10 cells at a time (a longer step can clip a tile's corner unseen). */
async function preload(s: Sampler & { load(c: number, r: number): Promise<void> }, alb: [number, number][]): Promise<void> {
  for (let i = 1; i < alb.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(alb[i][0] - alb[i - 1][0], alb[i][1] - alb[i - 1][1]) / (s.cellM * 10)));
    for (let k = 0; k <= n; k++) {
      const x = alb[i - 1][0] + (alb[i][0] - alb[i - 1][0]) * k / n, y = alb[i - 1][1] + (alb[i][1] - alb[i - 1][1]) * k / n;
      const col = Math.floor((x - s.x0) / s.cellM), row = Math.floor((s.y0 - y) / s.cellM);
      for (const [dc, dr] of [[0, 0], [-2, -2], [2, -2], [-2, 2], [2, 2]]) if (col + dc >= 0 && row + dr >= 0) await s.load(col + dc, row + dr);
    }
  }
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pad = (s: string | number, n: number) => String(s).padStart(n);

describe.skipIf(!have)('PNAS corridor geometries costed on our bands', () => {
  const preset = routePreset('pnas-wu2023')!;
  const rows: { id: string; km: number; ours: number; theirs: number; ratio: number; lineRatio: number; M: number; Mpnas: number; barrierKm: number; tribalKm: number; perBand: Map<BandName, [number, number]> }[] = [];

  it('costs all 27 corridors', async () => {
    const fc = JSON.parse(readFileSync(INPUT, 'utf8'));
    const s = (await cubeSampler()) as Sampler & { load(c: number, r: number): Promise<void> };
    expect(fc.features.length).toBe(27);
    for (const f of fc.features) {
      const p = f.properties;
      const xy = (f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat()) as [number, number][];
      const alb = xy.map(([lng, lat]) => albersForward(lng, lat));
      await preload(s, alb);
      const r = costPath(alb, preset, 'ac500', s, CONSTS);
      const lengthMi = r.lengthM / METRES_PER_MILE;
      const theirs = p.usd_mile_ac * p.length_mi;
      const lineOurs = r.lineUsdNominal * 1.175;
      rows.push({
        id: p.corridor, km: r.lengthM / 1000, ours: r.totalNominal, theirs, ratio: r.totalNominal / theirs,
        lineRatio: lineOurs / (p.line_only_usd_mile_ac * p.length_mi), M: r.meanCostX, Mpnas: p.M_backsolved,
        barrierKm: r.barrierM / 1000, tribalKm: r.tribalMiles * METRES_PER_MILE / 1000,
        perBand: new Map(r.perBand.map((b) => [b.band, [b.meanCostX, b.affectedM / r.lengthM] as [number, number]])),
      });
      expect(lengthMi).toBeGreaterThan(0.9 * p.length_mi);
    }
  }, 600_000);

  it('prints the tables and the gate verdict', () => {
    const out: string[] = ['', 'per corridor (2018$, ours = line x 1.175 + terminals, no ROW land; theirs = PNAS usd_mile_ac x length)'];
    out.push(`${'corridor'.padEnd(26)}${pad('km', 7)}${pad('ours $M', 10)}${pad('PNAS $M', 10)}${pad('ratio', 7)}${pad('line-only', 10)}${pad('M ours', 8)}${pad('M PNAS', 8)}${pad('barrier km', 11)}${pad('tribal km', 10)}`);
    for (const r of rows) out.push(`${r.id.padEnd(26)}${pad(r.km.toFixed(0), 7)}${pad((r.ours / 1e6).toFixed(0), 10)}${pad((r.theirs / 1e6).toFixed(0), 10)}${pad(r.ratio.toFixed(3), 7)}${pad(r.lineRatio.toFixed(3), 10)}${pad(r.M.toFixed(3), 8)}${pad(r.Mpnas.toFixed(3), 8)}${pad(r.barrierKm.toFixed(1), 11)}${pad(r.tribalKm.toFixed(1), 10)}`);
    const km = rows.map((r) => r.km);
    const totKm = km.reduce((a, b) => a + b, 0);
    out.push('', 'per band (length-weighted over the 27 corridors; own = product of the band\'s rows only)');
    out.push(`${'band'.padEnd(12)}${pad('mean x', 9)}${pad('affected %', 12)}${pad('share of ln M', 15)}`);
    const bands = [...rows[0].perBand.keys()];
    const lnTot = bands.reduce((a, b) => a + Math.log(rows.reduce((s, r, i) => s + r.perBand.get(b)![0] * km[i], 0) / totKm), 0);
    for (const b of bands) {
      const mx = rows.reduce((s, r, i) => s + r.perBand.get(b)![0] * km[i], 0) / totKm;
      const aff = rows.reduce((s, r, i) => s + r.perBand.get(b)![1] * km[i], 0) / totKm;
      out.push(`${b.padEnd(12)}${pad(mx.toFixed(3), 9)}${pad((aff * 100).toFixed(1), 12)}${pad(((Math.log(mx) / lnTot) * 100).toFixed(0) + ' %', 15)}`);
    }
    const ratios = rows.map((r) => r.ratio), lineR = rows.map((r) => r.lineRatio);
    out.push('', `total   ratio ours/theirs: median ${median(ratios).toFixed(3)}  mean ${mean(ratios).toFixed(3)}  min ${Math.min(...ratios).toFixed(3)}  max ${Math.max(...ratios).toFixed(3)}`);
    out.push(`line-only ratio:           median ${median(lineR).toFixed(3)}  mean ${mean(lineR).toFixed(3)}`);
    out.push(`mean multiplier M:         ours median ${median(rows.map((r) => r.M)).toFixed(3)} (mean ${mean(rows.map((r) => r.M)).toFixed(3)});  PNAS back-solved median ${median(rows.map((r) => r.Mpnas)).toFixed(3)} (includes ROW/base 0.1-3.2 %)`);
    const pass = Math.abs(median(ratios) - 1) <= TOL;
    out.push(`GATE (median total ratio within +/-${TOL * 100} %): ${pass ? 'PASS' : 'FAIL'}`, '');
    console.log(out.join('\n'));
    expect(rows.length).toBe(27);
  });

  it('gate: median ratio within tolerance', () => {
    expect(Math.abs(median(rows.map((r) => r.ratio)) - 1)).toBeLessThanOrEqual(TOL);
  });
});


// ─── routing validation ───────────────────────────────────────────────────

type XY = [number, number];
const WESTTEC = 'data/build/route/validate/westtec_newbuild.geojson';
const CAP = 100e6;

const lineIO = (): RouteIO => {
  const fds = new Map<string, Fetcher>();
  return {
    baseUrl: CUBE,
    async fetchJson(url) { return JSON.parse(readFileSync(url, 'utf8')); },
    fetchRange(url, start, end) {
      if (!fds.has(url)) fds.set(url, fileFetcher(url));
      return fds.get(url)!(start, end);
    },
  };
};

const lenOf = (l: XY[]) => l.reduce((a, p, i) => a + (i ? Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
  const t = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / dd)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas-Peucker (iterative), tolerance in the line's units. */
function simplify(l: XY[], tol: number): XY[] {
  const keep = new Uint8Array(l.length);
  keep[0] = keep[l.length - 1] = 1;
  const stack: [number, number][] = [[0, l.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let dmax = 0, imax = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(l[i], l[a], l[b]);
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (imax >= 0 && dmax > tol) { keep[imax] = 1; stack.push([a, imax], [imax, b]); }
  }
  return l.filter((_, i) => keep[i]);
}

/** Points every `step` metres along the line, ends included. */
function sampleEvery(l: XY[], step: number): XY[] {
  const out: XY[] = [l[0]];
  let carry = step;
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i], d = Math.hypot(bx - ax, by - ay);
    let at = carry;
    while (at <= d) { out.push([ax + (bx - ax) * at / d, ay + (by - ay) * at / d]); at += step; }
    carry = at - d;
  }
  out.push(l[l.length - 1]);
  return out;
}

const distTo = (p: XY, l: XY[]) => { let m = Infinity; for (let i = 1; i < l.length; i++) m = Math.min(m, segDist(p, l[i - 1], l[i])); return m; };

/** Mean symmetric distance (m): mean over both lines' 1 km samples of the distance to the other line; also the max. */
function deviation(a: XY[], b: XY[]): { mean: number; max: number } {
  const all = [...sampleEvery(a, 1000).map((p) => distTo(p, b)), ...sampleEvery(b, 1000).map((p) => distTo(p, a))];
  return { mean: mean(all), max: Math.max(...all) };
}

/** Share of 250 m samples along the line where a band test holds. */
function crossings(l: XY[], s: Sampler): Record<string, number> {
  const pts = sampleEvery(l, 250);
  const tests: Record<string, (v: Partial<Record<BandName, number>>) => boolean> = {
    existingRow230: (v) => ((v.osm_flags ?? 0) & 4) !== 0,
    gap12: (v) => { const g = (v.protect ?? 0) & 7; return g === 1 || g === 2; },
    tribal: (v) => ((v.flags ?? 0) & 1) !== 0,
    popOver100: (v) => ((v.flags ?? 0) & 32) !== 0,
    airfield: (v) => ((v.flags ?? 0) & 4) !== 0,
    forest: (v) => [41, 42, 43].includes(v.landcover ?? 0),
    slopeGe4deg: (v) => (v.slope ?? 0) >= 4,
    wildfireGt1: (v) => (v.wildfire ?? 0) > 1,
  };
  const n: Record<string, number> = Object.fromEntries(Object.keys(tests).map((k) => [k, 0]));
  let tot = 0;
  for (const [x, y] of pts) {
    const v = s.at(Math.floor((x - s.x0) / s.cellM), Math.floor((s.y0 - y) / s.cellM));
    if (!v) continue;
    tot++;
    for (const k in tests) if (tests[k](v)) n[k]++;
  }
  return Object.fromEntries(Object.entries(n).map(([k, c]) => [k, c / Math.max(1, tot)]));
}

const bandRow = (r: { perBand: { band: BandName; meanCostX: number; affectedM: number }[]; lengthM: number }) =>
  Object.fromEntries(r.perBand.map((b) => [b.band, { x: b.meanCostX, aff: b.affectedM / r.lengthM }]));

interface V1Row {
  id: string; pnasMi: number; chordMi: number;
  ok: boolean; error?: string;
  ourMi?: number; simpOurMi?: number; simpPnasMi?: number; lengthRatio?: number; detour?: number;
  devMeanKm?: number; devMaxKm?: number;
  optimality?: string; maskLimited?: boolean; pis?: number; rawCells?: number; bufferM?: number; bufferFactor?: number; retried?: boolean;
  bbox?: number; mask?: number; ms?: number;
  lineUsdMiOurs?: number; lineUsdMiPnas?: number; lineRatio?: number;
  totalUsdMiOurs?: number; totalUsdMiPnas?: number; totalRatio?: number;
  hvdcUsdMiOurs?: number; hvdcUsdMiPnas?: number; hvdcRatio?: number;
  mRoute?: number; mPnasGeom?: number; bandsRoute?: ReturnType<typeof bandRow>; bandsPnas?: ReturnType<typeof bandRow>;
  xRoute?: Record<string, number>; xPnas?: Record<string, number>;
  tribalMi?: number; barrierKm?: number;
}

/** Routes with the largest buffer factor (1, then x0.75 steps) whose bbox fits CAP (route() refuses a bbox over the cap). */
async function routeFitting(req: { from: XY; to: XY; preset: string; lineType: string }, io: RouteIO) {
  let factor = 1;
  for (;;) {
    const out = await route({ ...req, cap: CAP, bufferFactor: factor }, io);
    const tooBig = !out.ok && /exceeds the cap/.test(out.reason);
    if (!tooBig || factor < 0.1) return { out, factor };
    factor = Math.round(factor * 0.75 * 100) / 100;
  }
}

describe.skipIf(!have)('routing the 27 PNAS corridors', () => {
  const rows: V1Row[] = [];
  const west: Record<string, unknown>[] = [];
  let perf: Record<string, unknown> = {};

  it('routes all 27 corridors', async () => {
    const fc = JSON.parse(readFileSync(INPUT, 'utf8'));
    const s = (await cubeSampler()) as Sampler & { load(c: number, r: number): Promise<void> };
    const io = lineIO();
    const preset = routePreset('pnas-wu2023')!;
    for (const f of fc.features) {
      const p = f.properties;
      const pnasLL = (f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat()) as XY[];
      const pnas = pnasLL.map(([lng, lat]) => albersForward(lng, lat)) as XY[];
      const row: V1Row = { id: p.corridor, pnasMi: p.length_mi, chordMi: p.chord_mi, ok: false };
      rows.push(row);
      const t0 = performance.now();
      const { out, factor } = await routeFitting({ from: p.start_lnglat, to: p.end_lnglat, preset: 'pnas-wu2023', lineType: 'ac500' }, io);
      row.ms = performance.now() - t0;
      if (!out.ok) { row.error = out.reason; console.log(`${row.id}: FAILED ${out.reason}`); continue; }
      const r: RouteResult = out.result;
      const ours = r.path.coordinates.map(([lng, lat]) => albersForward(lng, lat)) as XY[];
      const sp = simplify(pnas, 1000), so = simplify(ours, 1000);
      const chordM = greatCircleM(p.start_lnglat, p.end_lnglat);
      row.ok = true;
      row.ourMi = r.lengthMi;
      row.simpPnasMi = lenOf(sp) / METRES_PER_MILE; row.simpOurMi = lenOf(so) / METRES_PER_MILE;
      row.lengthRatio = row.simpOurMi / row.simpPnasMi;
      row.detour = r.lengthMi * METRES_PER_MILE / chordM;
      const dv = deviation(ours, pnas);
      row.devMeanKm = dv.mean / 1000; row.devMaxKm = dv.max / 1000;
      row.optimality = r.optimality; row.maskLimited = r.maskLimited;
      row.pis = r.cells.pis; row.rawCells = r.cells.path; row.bufferM = r.bufferM; row.bufferFactor = factor;
      row.retried = r.bufferM > 1.5 * Math.max(0.35 * chordM, 25_000) * factor;
      row.bbox = r.cells.bbox; row.mask = r.cells.mask;
      row.lineUsdMiOurs = r.cost.lineUsdNominal * 1.175 / r.lengthMi;
      row.lineUsdMiPnas = p.line_only_usd_mile_ac;
      row.lineRatio = row.lineUsdMiOurs / p.line_only_usd_mile_ac;
      row.totalUsdMiOurs = r.cost.totalNominal / r.lengthMi;
      row.totalUsdMiPnas = p.usd_mile_ac;
      row.totalRatio = row.totalUsdMiOurs / p.usd_mile_ac;
      row.mRoute = r.cost.meanCostX;
      row.bandsRoute = bandRow(r.cost);
      row.tribalMi = r.tribalMiles; row.barrierKm = r.cost.barrierM / 1000;
      // HVDC: the HVAC route's geometry costed as dc500 (report only); PNAS's HVDC $/mi is over its own length.
      await preload(s, ours);
      const dc = costPath(ours, preset, 'dc500', s, CONSTS);
      row.hvdcUsdMiOurs = dc.totalNominal / r.lengthMi; row.hvdcUsdMiPnas = p.usd_mile_dc; row.hvdcRatio = row.hvdcUsdMiOurs / p.usd_mile_dc;
      // PNAS's own geometry on our bands, for the divergence analysis.
      await preload(s, pnas);
      const pc = costPath(pnas, preset, 'ac500', s, CONSTS);
      row.mPnasGeom = pc.meanCostX; row.bandsPnas = bandRow(pc);
      row.xRoute = crossings(ours, s); row.xPnas = crossings(pnas, s);
      console.log(`${row.id.padEnd(26)} ${row.ourMi!.toFixed(0)} mi (PNAS ${row.pnasMi.toFixed(0)}) len ${row.lengthRatio!.toFixed(3)} dev ${row.devMeanKm!.toFixed(1)} km line$ ${row.lineRatio!.toFixed(3)} ${row.optimality}${row.maskLimited ? ' maskLimited' : ''} pis ${row.pis} bufx ${factor} ${(row.ms / 1000).toFixed(0)} s`);
    }
    expect(rows.length).toBe(27);
    expect(rows.filter((r) => r.ok).length).toBeGreaterThan(0);
  }, 10_800_000);

  it('perf: a 300 mile route, warm, single attempt', async () => {
    const fc = JSON.parse(readFileSync(INPUT, 'utf8'));
    const near = rows.filter((r) => r.ok).sort((a, b) => Math.abs(a.ourMi! - 300) - Math.abs(b.ourMi! - 300))[0];  // the routed length nearest 300 mi
    const p = fc.features.find((f: { properties: { corridor: string } }) => f.properties.corridor === near.id).properties, io = lineIO();
    const req = { from: p.start_lnglat, to: p.end_lnglat, preset: 'pnas-wu2023', lineType: 'ac500', cap: CAP };
    await route(req, io);  // warm: page cache, JIT
    const t0 = performance.now();
    const out = await route(req, io);
    const wall = performance.now() - t0;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;
    const chordM = greatCircleM(p.start_lnglat, p.end_lnglat);
    const single = r.bufferM <= Math.max(0.35 * chordM, 25_000) * 1.001;
    // The gate times the first attempt; a route that is not proven retries at 2× (wallMs holds both).
    perf = { corridor: p.corridor, chordMi: p.chord_mi, routeMi: r.lengthMi, wallMs: wall, firstAttemptMs: r.timingsMs.attempts[0], timingsMs: r.timingsMs, bufferM: r.bufferM, singleAttempt: single, cells: r.cells, optimality: r.optimality };
    console.log('perf', JSON.stringify(perf));
  }, 1_800_000);

  it('WestTEC new-build lines routed with tm-default (report only)', async () => {
    if (!existsSync(WESTTEC)) return;
    const fc = JSON.parse(readFileSync(WESTTEC, 'utf8'));
    const io = lineIO();
    for (const f of fc.features) {
      const p = f.properties;
      const lineType = p.kv >= 500 ? 'ac500' : p.kv >= 345 ? 'ac345' : 'ac230';
      const t0 = performance.now();
      const { out, factor } = await routeFitting({ from: p.start_lnglat, to: p.end_lnglat, preset: 'tm-default', lineType }, io);
      const row: Record<string, unknown> = { name: p.name, kv: p.kv, lineType, reportMi: p.report_mi, geomMi: p.geom_mi, reportUsdM: p.report_usd_m, excluded: p.exclude_from_usd_compare, lengthFlag: p.length_ratio_flag, chordMi: p.chord_mi, bufferFactor: factor, ms: performance.now() - t0 };
      if (!out.ok) row.error = out.reason;
      else {
        const r = out.result;
        Object.assign(row, { ourMi: r.lengthMi, ours2025M: r.cost.total2025 / 1e6, oursNominalM: r.cost.totalNominal / 1e6, dollarYear: r.cost.dollarYear, bandLowM: r.cost.band.low / 1e6, bandHighM: r.cost.band.high / 1e6, optimality: r.optimality, maskLimited: r.maskLimited, pis: r.cells.pis, tribalMi: r.tribalMiles, mitigationMidM: r.cost.mitigationUsd.mid / 1e6, terminalsM: (r.cost.terminalsUsd ?? 0) / 1e6 });
      }
      west.push(row);
      console.log('westtec', JSON.stringify(row));
    }
  }, 3_600_000);

  it('prints the gates', () => {
    const ok = rows.filter((r) => r.ok);
    const within = (a: number[], lim: number) => a.filter((x) => Math.abs(x - 1) <= lim).length / a.length;
    const g = {
      length: { median: median(ok.map((r) => r.lengthRatio!)), within15: within(ok.map((r) => r.lengthRatio!), 0.15) },
      deviation: { medianKm: median(ok.map((r) => r.devMeanKm!)), share25: ok.filter((r) => r.devMeanKm! <= 25).length / ok.length },
      line: { median: median(ok.map((r) => r.lineRatio!)), within25: within(ok.map((r) => r.lineRatio!), 0.25) },
    };
    console.log('gates', JSON.stringify(g), 'routed', ok.length, '/', rows.length);
    if (process.env.ROUTE_VALIDATION_OUT) writeFileSync(process.env.ROUTE_VALIDATION_OUT, JSON.stringify({ rows, west, perf, gates: g }, null, 1));
  });

  // The share within 15 % and the distance from Wu's lines are report only (printed in 'gates' above): the routes
  // avoid TNC habitat cells that Wu's lines cross (docs/routing.md § How it was checked).
  it('gate length: every corridor solves, median within 5 %', () => {
    const l = rows.filter((r) => r.ok).map((r) => r.lengthRatio!);
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(Math.abs(median(l) - 1)).toBeLessThanOrEqual(0.05);
  });
  it('gate $/mi line-only: median within 10 %, 80 % within 25 %', () => {
    const l = rows.filter((r) => r.ok).map((r) => r.lineRatio!);
    expect(Math.abs(median(l) - 1)).toBeLessThanOrEqual(0.10);
    expect(l.filter((x) => Math.abs(x - 1) <= 0.25).length / rows.length).toBeGreaterThanOrEqual(0.8);
  });
  it('gate perf: 300 mi route, first attempt < 5 s', () => {
    expect((perf.firstAttemptMs as number) ?? Infinity).toBeLessThan(5000);
  });
});
