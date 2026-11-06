// Spur validation (baseline only, no gate; excluded from `npm test` like every *.validate.test.ts): routes each of the
// ~200 sampled PNAS (Wu et al. 2023) 230 kV spur lines (data/build/route/validate/pnas_spurs_sample.geojson, written by
// scripts/route_validation_inputs.py; CPA end -> substation end) end to end with route() under pnas-wu2023 and compares
// length, deviation, detour, solve time and optimality with PNAS's own line. The preset has only ac500/dc500 line
// types (SI Table S8 spurs are 230 kV single circuit); ac500 is the closest, so only the pop > 100/mi2 row (ac500-only)
// differs from a 230 kV line, and routing cost (not line type) decides the path. The pop row is 1.5 vs S7's 1.1 at 230 kV.
// Length rule: spurs >= 10 km are compared after the same 1 km Douglas-Peucker on both lines, shorter ones raw.
// Deviation: mean symmetric distance, samples every 1 km (250 m when either line is < 10 km).
// SPURS_OUT=<file.json> also writes the rows. Skips when the cube or the sample is absent.
// Run: npx vitest run --config vitest.route.config.ts assets/route/spurs.validate.test.ts --reporter=verbose --disableConsoleIntercept
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, openSync, readSync } from 'node:fs';
import { openTiff, readTile, type Fetcher, type TiffInfo } from './cog-read.js';
import { albersForward } from './grid.js';
import { route, PD_BANDS, OSM_BANDS, readGridJson, type RouteIO } from './route.js';
import { costPath, greatCircleM, METRES_PER_MILE, type Sampler } from './cost.js';
import { routePreset, type BandName } from '../../src/registry/route-presets.js';

const CUBE = 'data/route/250m/';
const INPUT = 'data/build/route/validate/pnas_spurs_sample.geojson';
const have = existsSync(CUBE + 'grid.json') && existsSync(INPUT);
const CAP = 100e6;
const LONG_M = 10_000;

const PD = PD_BANDS, OSM = OSM_BANDS;
const meta = have ? readGridJson(JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'))) : null;
if (typeof meta === 'string') throw new Error(meta);
const CONSTS = meta ? { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval } : {};
type XY = [number, number];

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}

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

async function cubeSampler(): Promise<Sampler & { load(c: number, r: number): Promise<void> }> {
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
  return {
    cellM: g.cell as number, x0, y0, load,
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
  } as Sampler & { load(c: number, r: number): Promise<void> };
}

async function preload(s: { cellM: number; x0: number; y0: number; load(c: number, r: number): Promise<void> }, alb: XY[]): Promise<void> {
  for (let i = 1; i < alb.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(alb[i][0] - alb[i - 1][0], alb[i][1] - alb[i - 1][1]) / (s.cellM * 10)));
    for (let k = 0; k <= n; k++) {
      const x = alb[i - 1][0] + (alb[i][0] - alb[i - 1][0]) * k / n, y = alb[i - 1][1] + (alb[i][1] - alb[i - 1][1]) * k / n;
      const col = Math.floor((x - s.x0) / s.cellM), row = Math.floor((s.y0 - y) / s.cellM);
      for (const [dc, dr] of [[0, 0], [-2, -2], [2, -2], [-2, 2], [2, 2]]) if (col + dc >= 0 && row + dr >= 0) await s.load(col + dc, row + dr);
    }
  }
}

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pad = (s: string | number, n: number) => String(s).padStart(n);
const lenOf = (l: XY[]) => l.reduce((a, p, i) => a + (i ? Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
  const t = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / dd)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function simplify(l: XY[], tol: number): XY[] {
  const keep = new Uint8Array(l.length);
  keep[0] = keep[l.length - 1] = 1;
  const stack: [number, number][] = [[0, l.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let dmax = 0, imax = -1;
    for (let i = a + 1; i < b; i++) { const d = segDist(l[i], l[a], l[b]); if (d > dmax) { dmax = d; imax = i; } }
    if (imax >= 0 && dmax > tol) { keep[imax] = 1; stack.push([a, imax], [imax, b]); }
  }
  return l.filter((_, i) => keep[i]);
}

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

const distTo = (p: XY, l: XY[]) => { let m = Infinity; for (let i = 1; i < l.length; i++) m = Math.min(m, segDist(p, l[i - 1], l[i])); return l.length < 2 ? Math.hypot(p[0] - l[0][0], p[1] - l[0][1]) : m; };

function deviation(a: XY[], b: XY[], step: number): { mean: number; max: number } {
  const all = [...sampleEvery(a, step).map((p) => distTo(p, b)), ...sampleEvery(b, step).map((p) => distTo(p, a))];
  return { mean: mean(all), max: Math.max(...all) };
}

const bandRow = (r: { perBand: { band: BandName; meanCostX: number; affectedM: number }[]; lengthM: number }) =>
  Object.fromEntries(r.perBand.map((b) => [b.band, { x: +b.meanCostX.toFixed(3), aff: +(b.affectedM / r.lengthM).toFixed(3) }]));

interface Row {
  id: string; tech: string; decile: number; pnasMi: number; chordMi: number;
  ok: boolean; error?: string; ourMi?: number; cmpOurMi?: number; cmpPnasMi?: number; lengthRatio?: number;
  detourOurs?: number; detourPnas?: number; devMeanM?: number; devMaxM?: number; ms?: number;
  optimality?: string; maskLimited?: boolean; mOurs?: number; mPnasGeom?: number;
  bandsOurs?: ReturnType<typeof bandRow>; bandsPnas?: ReturnType<typeof bandRow>;
}

describe.skipIf(!have)('Spurs: routing the PNAS spur sample (baseline, no gate)', () => {
  const rows: Row[] = [];

  it('routes every sampled spur', async () => {
    const fc = JSON.parse(readFileSync(INPUT, 'utf8'));
    const io = lineIO();
    const s = await cubeSampler();
    const preset = routePreset('pnas-wu2023')!;
    for (const f of fc.features) {
      const p = f.properties;
      const row: Row = { id: p.id, tech: p.tech, decile: p.length_decile, pnasMi: p.length_mi, chordMi: p.chord_mi, ok: false };
      rows.push(row);
      const t0 = performance.now();
      const out = await route({ from: p.cpa_lnglat, to: p.sub_lnglat, preset: 'pnas-wu2023', lineType: 'ac500', cap: CAP }, io);
      row.ms = performance.now() - t0;
      if (!out.ok) { row.error = out.reason; console.log(`${row.id}: FAILED ${out.reason}`); continue; }
      const r = out.result;
      const ours = r.path.coordinates.map(([lng, lat]) => albersForward(lng, lat)) as XY[];
      const pnas = (f.geometry.coordinates as XY[]).map(([lng, lat]) => albersForward(lng, lat)) as XY[];
      const long = Math.min(lenOf(ours), lenOf(pnas)) >= LONG_M;
      const co = long ? simplify(ours, 1000) : ours, cp = long ? simplify(pnas, 1000) : pnas;
      const chordM = greatCircleM(p.cpa_lnglat, p.sub_lnglat);
      row.ok = true;
      row.ourMi = r.lengthMi;
      row.cmpOurMi = lenOf(co) / METRES_PER_MILE; row.cmpPnasMi = lenOf(cp) / METRES_PER_MILE;
      row.lengthRatio = row.cmpOurMi / row.cmpPnasMi;
      row.detourOurs = r.lengthMi * METRES_PER_MILE / chordM;
      row.detourPnas = p.detour_ratio;
      const dv = deviation(ours, pnas, long ? 1000 : 250);
      row.devMeanM = dv.mean; row.devMaxM = dv.max;
      row.optimality = r.optimality; row.maskLimited = r.maskLimited;
      row.mOurs = r.cost.meanCostX; row.bandsOurs = bandRow(r.cost);
      await preload(s, pnas);
      const pc = costPath(pnas, preset, 'ac500', s, CONSTS);
      row.mPnasGeom = pc.meanCostX; row.bandsPnas = bandRow(pc);
      console.log(`${row.id.padEnd(16)} d${row.decile} ${row.ourMi!.toFixed(1)} mi (PNAS ${row.pnasMi.toFixed(1)}) len ${row.lengthRatio!.toFixed(3)} dev ${row.devMeanM!.toFixed(0)} m detour ${row.detourOurs!.toFixed(2)}/${row.detourPnas!.toFixed(2)} ${row.ms!.toFixed(0)} ms ${row.optimality}${row.maskLimited ? ' maskLimited' : ''}`);
    }
    expect(rows.length).toBe(fc.features.length);
  }, 1_800_000);

  it('prints the summary', () => {
    const ok = rows.filter((r) => r.ok);
    const out: string[] = ['', `Spurs: ${ok.length}/${rows.length} routed (ac500 stand-in for 230 kV single circuit)`];
    for (const r of rows.filter((x) => !x.ok)) out.push(`  failed ${r.id}: ${r.error}`);
    out.push(`${'decile'.padEnd(8)}${pad('n', 4)}${pad('PNAS mi', 9)}${pad('len ratio', 10)}${pad('dev m', 8)}${pad('dev/len %', 10)}${pad('detour o', 9)}${pad('detour p', 9)}${pad('ms', 7)}${pad('proven', 8)}`);
    const line = (name: string, g: Row[]) => {
      if (!g.length) return;
      out.push(`${name.padEnd(8)}${pad(g.length, 4)}${pad(median(g.map((r) => r.pnasMi)).toFixed(1), 9)}${pad(median(g.map((r) => r.lengthRatio!)).toFixed(3), 10)}${pad(median(g.map((r) => r.devMeanM!)).toFixed(0), 8)}${pad((median(g.map((r) => r.devMeanM! / (r.pnasMi * METRES_PER_MILE))) * 100).toFixed(1), 10)}${pad(median(g.map((r) => r.detourOurs!)).toFixed(2), 9)}${pad(median(g.map((r) => r.detourPnas!)).toFixed(2), 9)}${pad(median(g.map((r) => r.ms!)).toFixed(0), 7)}${pad(g.filter((r) => r.optimality === 'proven').length + '/' + g.length, 8)}`);
    };
    for (let d = 1; d <= 10; d++) line(String(d), ok.filter((r) => r.decile === d));
    line('all', ok);
    for (const t of ['wind', 'solar']) line(t, ok.filter((r) => r.tech === t));
    out.push('', 'worst 8 by mean deviation (m): band x = mean cost multiplier ours/PNAS geometry, aff = share of length affected');
    for (const r of [...ok].sort((a, b) => b.devMeanM! - a.devMeanM!).slice(0, 8)) {
      const diffs = Object.keys(r.bandsOurs!).map((b) => `${b} x ${r.bandsOurs![b as BandName].x}/${r.bandsPnas![b as BandName]?.x} aff ${r.bandsOurs![b as BandName].aff}/${r.bandsPnas![b as BandName]?.aff}`);
      out.push(`${r.id} ${r.pnasMi.toFixed(1)} mi dev ${r.devMeanM!.toFixed(0)} m max ${r.devMaxM!.toFixed(0)} len ${r.lengthRatio!.toFixed(2)} M ${r.mOurs!.toFixed(2)}/${r.mPnasGeom!.toFixed(2)} ${r.optimality}`, '    ' + diffs.join('; '));
    }
    console.log(out.join('\n'));
    if (process.env.SPURS_OUT) writeFileSync(process.env.SPURS_OUT, JSON.stringify(rows));
  });
});
