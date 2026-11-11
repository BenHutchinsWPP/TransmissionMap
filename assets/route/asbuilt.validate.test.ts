// Report-only check (excluded from `npm test`, like every *.validate.test.ts): routes as-built transmission lines with
// the production engine (route(), tm-default) and reports how closely the route follows the HIFLD line.
// The target line's own existing-line discount is neutralised by uploaded polygon layers (N1 = its adj cells, N2 = N1 on
// GAP 3), passed through io.uploads and presetPatch.add_rows, as the Method tab's uploads do (docs/roadmap/route-review.plan.md D1-D3).
// Inputs: assets/route/fixtures/asbuilt-lines.json (tracked, shas) and the geometry file it names (data/build/route/validate/,
// written by scripts/route_asbuilt_lines.py); a sha that differs from the fixture fails. Skips when the cube or an input is absent.
// Env: ASBUILT_SET=e|cal|hold (default e); ASBUILT_CONFIGS=comma list of baseline, baseline2, noneutral, c1, c2a, c2b, c3_06,
//   c3_07, c3_08, c4, c5, combined:<id>+<id>; ASBUILT_LIMIT=N lines; ASBUILT_OUT=<file.jsonl> (appended; a rerun resumes from its solved rows);
//   ASBUILT_TOUCH=<config> prints the D5 touch count without solving; ASBUILT_REFCOST=1 costs each reference geometry;
//   ASBUILT_MUTATE=noneutral sets every neutraliser weight to 1 (the strict noneutral check must then fail).
// Run (one at a time, under a memory cap): npx vitest run --config vitest.route.config.ts assets/route/asbuilt.validate.test.ts --maxWorkers=1 --disableConsoleIntercept
// Deps: route.ts, upload-layer.ts, preset-patch.ts, cost.ts, dijkstra.ts, cog-read.ts, grid.ts, src/registry/route-presets.ts.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, appendFileSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openTiff, readTile, type Fetcher, type TiffInfo } from './cog-read.js';
import { albersForward } from './grid.js';
import { route, readGridJson, readPathTiles, PD_BANDS, OSM_BANDS, type RouteIO, type GridMeta } from './route.js';
import { compile, cellFactors, costPath, presetBands, type Sampler } from './cost.js';
import { traverse } from './dijkstra.js';
import { validateUpload, insideCell, type UploadLayer } from './upload-layer.js';
import { validatePresetPatch, uploadBand, type PresetPatch, type RowPatch, type AddRow } from './preset-patch.js';
import { routePreset, type BandName, type Match, type EndKind, type RoutePreset } from '../../src/registry/route-presets.js';

type XY = [number, number];
const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const FIXTURE = 'assets/route/fixtures/asbuilt-lines.json';
const R2_FILE = 'local/reviews/route-review/R2.json';
const CAP = 100e6;
const PRESET = 'tm-default';

interface FxLine {
  id: string; set: 'E' | 'CAL' | 'HOLD'; lineType: string; targetClassBits: string; evidence: boolean; ends: [XY, XY];
  geometrySha256: string; n1Sha256: string | null; n2Sha256: string | null; lengthKm: number;
}
interface Fixture { geometryFile: string; geometrySha256: string; lines: FxLine[] }

const fx: Fixture | null = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const have = existsSync(CUBE + 'grid.json') && !!fx && existsSync(fx.geometryFile);

const setName = (process.env.ASBUILT_SET ?? 'e').toLowerCase();
const SET = ({ e: 'E', cal: 'CAL', hold: 'HOLD' } as Record<string, FxLine['set']>)[setName];
if (!SET) throw new Error(`ASBUILT_SET must be e, cal or hold (got ${setName})`);
const LIMIT = process.env.ASBUILT_LIMIT ? Number(process.env.ASBUILT_LIMIT) : null;
const CONFIGS = (process.env.ASBUILT_CONFIGS ?? 'baseline').split(',').map((s) => s.trim()).filter(Boolean);
const TOUCH = process.env.ASBUILT_TOUCH ?? '';
const REFCOST = process.env.ASBUILT_REFCOST === '1';
const OUT = process.env.ASBUILT_OUT ?? '';
const MUTATE = process.env.ASBUILT_MUTATE ?? '';
if (MUTATE && MUTATE !== 'noneutral') throw new Error('ASBUILT_MUTATE must be noneutral');

// ─── helpers ──────────────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** JSON text as Python's json.dumps(separators=(",", ":")) writes coordinates (floats keep ".0"), the form the fixture's shas hash. */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(',') + ']';
  const n = v as number;
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}

function lineIO(uploads?: ReadonlyMap<string, UploadLayer>): RouteIO {
  const fds = new Map<string, Fetcher>();
  return {
    baseUrl: CUBE,
    async fetchJson(url) { return JSON.parse(readFileSync(url, 'utf8')); },
    fetchRange(url, start, end) {
      if (!fds.has(url)) fds.set(url, fileFetcher(url));
      return fds.get(url)!(start, end);
    },
    ...(uploads ? { uploads } : {}),
  };
}

const meta: GridMeta | null = have ? (() => { const m = readGridJson(JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'))); if (typeof m === 'string') throw new Error(m); return m; })() : null;
const CONSTS = meta ? { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval } : {};

/** Sampler over the real cube (tiles decoded on demand), for costing a reference geometry. */
async function cubeSampler(): Promise<Sampler & { load(c: number, r: number): Promise<void> }> {
  const g = JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'));
  const [x0, y0] = g.origin as [number, number];
  const files = new Map<string, { f: Fetcher; info: TiffInfo } | null>();
  const tiles = new Map<string, Uint8Array>();
  const open = async (kind: string, sc: number, sr: number) => {
    const k = `${kind}_${sc}_${sr}`;
    if (!files.has(k)) {
      const p = `${CUBE}${k}.tif`;
      if (!existsSync(p)) files.set(k, null);
      else { const f = fileFetcher(p); files.set(k, { f, info: await openTiff(f) }); }
    }
    return files.get(k)!;
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
      const i = (lr - ty * g.block) * g.block + (lc - tx * g.block);
      const out: Partial<Record<BandName, number>> = {};
      for (const [kind, names] of [['pd', PD_BANDS], ['osm', OSM_BANDS]] as const) {
        const t = tiles.get(`${kind}_${sc}_${sr}_${tx}_${ty}`);
        if (!t) throw new Error(`tile ${kind} ${sc}_${sr}_${tx}_${ty} not preloaded`);
        names.forEach((n, b) => { out[n] = t.length ? t[i * names.length + b] : 0; });
      }
      return out;
    },
  };
}

async function preload(s: Sampler & { load(c: number, r: number): Promise<void> }, alb: XY[]): Promise<void> {
  for (let i = 1; i < alb.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(alb[i][0] - alb[i - 1][0], alb[i][1] - alb[i - 1][1]) / (s.cellM * 10)));
    for (let k = 0; k <= n; k++) {
      const x = alb[i - 1][0] + (alb[i][0] - alb[i - 1][0]) * k / n, y = alb[i - 1][1] + (alb[i][1] - alb[i - 1][1]) * k / n;
      const col = Math.floor((x - s.x0) / s.cellM), row = Math.floor((s.y0 - y) / s.cellM);
      for (const [dc, dr] of [[0, 0], [-2, -2], [2, -2], [-2, 2], [2, 2]]) if (col + dc >= 0 && row + dr >= 0) await s.load(col + dc, row + dr);
    }
  }
}

const lenOf = (l: XY[]) => l.reduce((a, p, i) => a + (i ? Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);
function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
  const t = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / dd)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
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
const distTo = (p: XY, l: XY[]) => { let m = Infinity; for (let i = 1; i < l.length; i++) m = Math.min(m, segDist(p, l[i - 1], l[i])); return m; };
const SAMPLE_M = 250;
/** Mean symmetric distance (m) over both lines' 250 m samples; `within` = share of a's samples within 1 and 5 km of b. */
function agreement(a: XY[], b: XY[]): { meanM: number; within1: number; within5: number } {
  const da = sampleEvery(a, SAMPLE_M).map((p) => distTo(p, b)), db = sampleEvery(b, SAMPLE_M).map((p) => distTo(p, a));
  const all = [...da, ...db];
  return { meanM: all.reduce((x, y) => x + y, 0) / all.length, within1: da.filter((d) => d <= 1000).length / da.length, within5: da.filter((d) => d <= 5000).length / da.length };
}

// ─── inputs ───────────────────────────────────────────────────────────────

interface Geo { line: XY[]; n1: unknown; n2: unknown }
const geo = new Map<string, Geo>();
const featureSha = new Map<string, string>();   // `${id}:${kind}` → sha of its coordinates, as the fixture hashes them
let fileShaOk = true;
if (have) {
  const text = readFileSync(fx!.geometryFile, 'utf8');
  fileShaOk = sha(text) === fx!.geometrySha256;
  const fc = JSON.parse(text) as { features: { properties: { id: string; kind: 'line' | 'n1' | 'n2' }; geometry: { type: string; coordinates: unknown } }[] };
  for (const f of fc.features) {
    const { id, kind } = f.properties;
    const g = geo.get(id) ?? { line: [], n1: null, n2: null };
    geo.set(id, g);
    featureSha.set(`${id}:${kind}`, sha(pyJson(f.geometry.coordinates)));
    if (kind === 'line') g.line = (f.geometry.coordinates as XY[]).map(([lng, lat]) => albersForward(lng, lat) as XY);
    else g[kind] = f.geometry;
  }
}

const chosen: FxLine[] = fx ? fx.lines.filter((l) => l.set === SET && l.evidence).slice(0, LIMIT ?? undefined) : [];
const base: RoutePreset = routePreset(PRESET)!;

// ─── configurations ───────────────────────────────────────────────────────

interface Cfg { id: string; rows: RowPatch[]; n2: boolean; neutral: boolean }
const sameMatch = (a: Match, b: Match) => JSON.stringify(a) === JSON.stringify(b);
function findRow(p: RoutePreset, band: BandName, match: Match | Match[], group?: string): number {
  const ms = Array.isArray(match) ? match : [match];
  return p.rows.findIndex((r) => r.band === band && ms.some((m) => sameMatch(r.match, m)) && (!group || r.group === group));
}
const ADJ230: Match = { field: { shift: 0, mask: 3 }, codes: [1, 2] };
const ADJ100: Match = { field: { shift: 5, mask: 3 }, codes: [1, 2] };
const GAP3: Match = { field: { shift: 0, mask: 7 }, codes: [3] };
const patchRow = (p: RoutePreset, i: number, v: Partial<RowPatch>): RowPatch => ({ row: i, band: p.rows[i].band, ...(p.rows[i].note !== undefined ? { note: p.rows[i].note } : {}), ...v });

/** One candidate's row patches, found by band + match (never by literal index). A string is the refusal. */
function atom(id: string, p: RoutePreset): { rows: RowPatch[]; n2?: boolean } | string {
  const set = (band: BandName, match: Match | Match[], w: number, group?: string): RowPatch | string => {
    const i = findRow(p, band, match, group);
    return i < 0 ? `${id}: no ${band} row matching ${JSON.stringify(match)} in ${PRESET}` : patchRow(p, i, { route_w: w, cost_x: 1 });
  };
  const all = (xs: (RowPatch | string)[]) => (xs.find((x) => typeof x === 'string') as string | undefined) ?? { rows: xs as RowPatch[] };
  const c3 = (w230: number, w100: number) => all([set('adj', ADJ230, w230), set('adj', ADJ100, w100)]);
  switch (id) {
    case 'c1': return all([set('bldg', { range: [2, 3] }, 1.5), set('bldg', { range: [4, 10] }, 3), set('bldg', { range: [11, 255] }, 8)]);
    case 'c2a': case 'c2b': {
      const i = findRow(p, 'protect', GAP3);
      const labels = (i >= 0 ? p.rows[i].except ?? [] : []).map((e) => e.label);
      const a = labels.findIndex((l) => /Section 368/i.test(l)), b = labels.findIndex((l) => /230/.test(l) && /≥|>=/.test(l));
      if (a < 0 || (id === 'c2b' && b < 0)) return `${id}: the GAP 3 row has no ${a < 0 ? '"Section 368"' : '"existing ≥ 230 kV lines"'} except entry in ${PRESET} yet (C0 adds it)`;
      return { rows: [patchRow(p, i, { except: labels.map((_, k) => k === a || (id === 'c2b' && k === b)) })], n2: id === 'c2b' };
    }
    case 'c3_06': return c3(0.6, 0.8);
    case 'c3_07': return c3(0.7, 0.85);
    case 'c3_08': return c3(0.8, 0.9);
    case 'c4': {
      const lo = findRow(p, 'slope', [{ codes: [6] }, { range: [6, 6] }]), hi = findRow(p, 'slope', [{ codes: [7, 8] }, { range: [7, 8] }]);
      if (lo < 0 || hi < 0) return `c4: the slope rows for codes [6,6] and [7,8] are not in ${PRESET} yet (C0 adds them)`;
      return { rows: [patchRow(p, lo, { route_w: 3 }), patchRow(p, hi, { route_w: 5 })] };
    }
    case 'c5': return all([set('desig', { bit: 1 }, 100, 'protection'), set('desig', { bit: 2 }, 20, 'protection'), set('desig', { bit: 3 }, 20, 'protection')]);
    default: return `unknown candidate "${id}"`;
  }
}

/** A config id → its patches, or the refusal reason. */
function resolveConfig(id: string, p: RoutePreset): Cfg | string {
  if (id === 'baseline' || id === 'baseline2') return { id, rows: [], n2: false, neutral: true };
  if (id === 'noneutral') return { id, rows: [], n2: false, neutral: false };
  const ids = id.startsWith('combined:') ? id.slice(9).split(/[+|]/).filter(Boolean) : [id];
  if (!ids.length) return `${id}: no candidates named`;
  const merged = new Map<number, RowPatch>();
  let n2 = false;
  for (const a of ids) {
    const r = atom(a, p);
    if (typeof r === 'string') return r;
    n2 ||= !!r.n2;
    for (const rp of r.rows) {
      const cur = merged.get(rp.row);
      const except = rp.except && cur?.except ? rp.except.map((v, k) => v || !!cur.except![k]) : rp.except ?? cur?.except;
      merged.set(rp.row, { ...cur, ...rp, ...(except ? { except } : {}) });
    }
  }
  return { id, rows: [...merged.values()], n2, neutral: true };
}

/** The config's patched preset (rows only), for weights and touch counts. */
function patched(cfg: Cfg, add: AddRow[] = []): RoutePreset {
  const r = validatePresetPatch(base, cfg.rows.length || add.length ? { ...(cfg.rows.length ? { rows: cfg.rows } : {}), ...(add.length ? { add_rows: add } : {}) } : undefined);
  if (!r.ok) throw new Error(`${cfg.id}: patch refused: ${r.reason}`);
  return r.result;
}
/** D2: the neutraliser's weight is 1 / the discount of the target's own class, as the config sets it. */
function discounts(cfg: Cfg): { d230: number; d100: number } {
  const p = patched(cfg);
  const w = (m: Match) => { const f = p.rows[findRow(p, 'adj', m)].route_w; return typeof f === 'number' ? f : f.ramp[0]; };
  return { d230: w(ADJ230), d100: w(ADJ100) };
}

/** The config's neutraliser rows for one line (D2: N1 at 1 / the discount of the target's class; N2 at 2 on GAP 3 for c2b on a >= 230 kV target). */
function addRows(cfg: Cfg, l: FxLine, hashes: { n1: string; n2: string | null }): AddRow[] {
  const class230 = l.targetClassBits === '0-1';
  const { d230, d100 } = discounts(cfg);
  const w = MUTATE === 'noneutral' ? 1 : 1 / (class230 ? d230 : d100);
  const add: AddRow[] = [];
  if (cfg.neutral) add.push({ layer: hashes.n1, label: 'as-built neutraliser', route_w: w, cost_x: 1 });
  if (cfg.neutral && cfg.n2 && class230 && hashes.n2) add.push({ layer: hashes.n2, label: 'as-built neutraliser (GAP 3)', route_w: MUTATE === 'noneutral' ? 1 : 2, cost_x: 1 });
  return add;
}
/** A line's N1 / N2 as validated upload layers, keyed by hash. */
async function lineLayers(l: FxLine): Promise<{ layers: Map<string, UploadLayer>; n1: string; n2: string | null }> {
  const g = geo.get(l.id)!;
  const layers = new Map<string, UploadLayer>();
  const mk = async (k: 'n1' | 'n2') => {
    const r = await validateUpload(JSON.stringify({ type: 'Feature', properties: {}, geometry: g[k] }));
    if (!r.ok) throw new Error(`${l.id} ${k}: ${r.reason}`);
    layers.set(r.result.hash, r.result);
    return r.result.hash;
  };
  const n1 = await mk('n1'), n2 = g.n2 ? await mk('n2') : null;
  return { layers, n1, n2 };
}
/** One cell's routing factors under a config, its neutraliser rows compiled in and the upload bands set per cell. */
function cellUnder(cfg: Cfg, l: FxLine, ll: { layers: Map<string, UploadLayer>; n1: string; n2: string | null }, v: Partial<Record<BandName, number>>, col: number, row: number) {
  const add = addRows(cfg, l, ll);
  const pp = patched(cfg, add);
  const vv = { ...v } as Record<string, number>;
  for (const a of add) vv[uploadBand(a.layer)] = insideCell(ll.layers.get(a.layer)!, col, row) ? 1 : 0;
  return cellFactors(compile(pp, l.lineType, CONSTS), vv as Partial<Record<BandName, number>>, l.lineType);
}

// ─── rows file ────────────────────────────────────────────────────────────

interface Row {
  id: string; set: string; config: string; mutate: string; ok: boolean; reason?: string; lineType?: string;
  pathSha?: string; pathLL?: XY[]; refKm?: number; routeKm?: number; lengthRatio?: number;
  meanDevKm?: number; within1?: number; within5?: number; total2025?: number; optimality?: string; maskLimited?: boolean; ms?: number;
  [k: string]: unknown;
}
/** A row is resumed only when the fixture file, the base preset and the config's patch (neutraliser weights included) are the ones it was solved with. */
const FX_SHA = fx ? sha(readFileSync(FIXTURE, 'utf8')).slice(0, 16) : '';
const BASE_SHA = sha(JSON.stringify(base)).slice(0, 16);
function stamp(cfg: Cfg): string {
  const { d230, d100 } = discounts(cfg);
  return `${FX_SHA}.${sha(JSON.stringify({ rows: cfg.rows, n2: cfg.n2, neutral: cfg.neutral, d230, d100, base: BASE_SHA })).slice(0, 16)}`;
}
const key = (r: { id: string; set: string; config: string; mutate: string; kv?: unknown }) => `${r.set}|${r.config}|${r.mutate}|${r.id}|${String(r.kv ?? '')}`;
const done = new Map<string, Row>();
const failedSeen = new Map<string, string>();   // key → reason of a failed row already in the file (a rerun does not append it again)
if (OUT && existsSync(OUT)) {
  for (const t of readFileSync(OUT, 'utf8').split('\n')) if (t.trim()) { const r = JSON.parse(t) as Row; if (r.ok) done.set(key(r), r); else failedSeen.set(key(r), String(r.reason)); }
}
const remember = (r: Row) => {
  done.set(key(r), r);
  if (!r.ok && failedSeen.get(key(r)) === r.reason) return;
  if (!r.ok) failedSeen.set(key(r), String(r.reason));
  if (OUT) appendFileSync(OUT, JSON.stringify(r) + '\n');
};

// ─── tests ────────────────────────────────────────────────────────────────

describe.skipIf(!have)('as-built lines: inputs', () => {
  it('geometry and neutraliser shas equal the fixture', () => {
    expect(fileShaOk, 'geometry file sha256 differs from the fixture').toBe(true);
    const bad: string[] = [];
    for (const l of fx!.lines) {
      if (featureSha.get(`${l.id}:line`) !== l.geometrySha256) bad.push(`${l.id} line`);
      if ((featureSha.get(`${l.id}:n1`) ?? null) !== l.n1Sha256) bad.push(`${l.id} n1`);
      if ((featureSha.get(`${l.id}:n2`) ?? null) !== l.n2Sha256) bad.push(`${l.id} n2`);
    }
    expect(bad, 'sha256 differs from the fixture').toEqual([]);
  });

  it('self-check: a reference against itself is 0 km (below 1 micron), offset 1 km along its normal about 1 km', () => {
    expect(chosen.length).toBeGreaterThan(0);
    const shifted: number[] = [];
    for (const l of chosen) {
      const ref = geo.get(l.id)!.line;
      expect(agreement(ref, ref).meanM, l.id).toBeLessThan(1e-6);
      const pts = sampleEvery(ref, SAMPLE_M);   // each sample moves 1 km along the local normal (central difference over its neighbours)
      const off = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return [p[0] - 1000 * (b[1] - a[1]) / d, p[1] + 1000 * (b[0] - a[0]) / d] as XY;
      });
      shifted.push(agreement(ref, off).meanM / 1000);
    }
    const m = median(shifted);
    console.log(`shifted-reference mean distance: median ${m.toFixed(3)} km, min ${Math.min(...shifted).toFixed(3)}, max ${Math.max(...shifted).toFixed(3)} (${shifted.length} lines)`);
    expect(m).toBeGreaterThanOrEqual(0.95);
    expect(m).toBeLessThanOrEqual(1.05);
  });

  it('self-check: a cell inside the target\'s own N1 (adj class 1-2) and no other line\'s discount is not counted as differing (c3_06 vs baseline)', async () => {
    const cb = resolveConfig('baseline', base) as Cfg, c3 = resolveConfig('c3_06', base);
    if (typeof c3 === 'string') { console.log(`c3_06 not resolvable (${c3}), skipped`); return; }
    for (const l of chosen) {
      const ll = await lineLayers(l), layer = ll.layers.get(ll.n1)!;
      let col = -1, row = -1;
      const ref = geo.get(l.id)!.line, mid = ref[Math.floor(ref.length / 2)];   // the line's own cells are in its N1
      const c0 = Math.floor((mid[0] - meta!.grid.x0) / meta!.grid.cell), r0 = Math.floor((meta!.grid.y0 - mid[1]) / meta!.grid.cell);
      for (let r = r0 - 6; r <= r0 + 6 && col < 0; r++) for (let c = c0 - 6; c <= c0 + 6; c++) if (insideCell(layer, c, r)) { col = c; row = r; break; }
      expect(col, `${l.id}: N1 has a cell`).toBeGreaterThanOrEqual(0);
      const bands = [...new Set([...presetBands(patched(cb)), ...presetBands(patched(c3))])].filter((b) => !String(b).startsWith('upl_'));
      const v: Partial<Record<BandName, number>> = {};
      for (const b of bands) v[b] = 0;
      v.adj = l.targetClassBits === '0-1' ? 1 : 1 << 5;   // the target's own class, class 1
      expect(cellUnder(cb, l, ll, v, col, row).r, l.id).toBeCloseTo(cellUnder(c3, l, ll, v, col, row).r, 9);
      const off = cellUnder(c3, l, ll, v, -1, -1).r, offB = cellUnder(cb, l, ll, v, -1, -1).r;   // the control: outside N1 the discount does differ
      expect(Math.abs(off - offB), `${l.id}: control cell outside N1`).toBeGreaterThan(1e-9);
    }
  }, 600_000);

  it('every neutraliser of the set passes validateUpload', async () => {
    for (const l of chosen) {
      for (const k of ['n1', 'n2'] as const) {
        const g = geo.get(l.id)![k];
        if (!g) continue;
        const r = await validateUpload(JSON.stringify({ type: 'Feature', properties: {}, geometry: g }));
        expect(r.ok, `${l.id} ${k}: ${r.ok ? '' : r.reason}`).toBe(true);
      }
    }
  }, 600_000);
});

const solveMode = !TOUCH && !REFCOST;

describe.skipIf(!have || !solveMode)('as-built lines: solving', () => {
  const cfgs: Cfg[] = [];
  const refused: string[] = [];
  for (const id of CONFIGS) { const c = resolveConfig(id, base); if (typeof c === 'string') refused.push(c); else cfgs.push(c); }
  const rows: Row[] = [];

  it('every named config resolves', () => { expect(refused, 'refused configs').toEqual([]); });

  it('routes the set under each config', async () => {
    for (const l of chosen) {
      const g = geo.get(l.id)!;
      const ll = await lineLayers(l), layers = ll.layers;
      for (const cfg of cfgs) {
        const k = { id: l.id, set: SET, config: cfg.id, mutate: MUTATE, kv: stamp(cfg) };
        const prior = done.get(key(k));
        if (prior?.ok) { rows.push(prior); continue; }
        const add = addRows(cfg, l, ll);
        const presetPatch: PresetPatch = { ...(cfg.rows.length ? { rows: cfg.rows } : {}), ...(add.length ? { add_rows: add } : {}) };
        const io = lineIO(new Map(add.map((a) => [a.layer, layers.get(a.layer)!])));
        const req = {
          from: l.ends[0], to: l.ends[1], preset: PRESET, lineType: l.lineType,
          ...(add.length || cfg.rows.length ? { presetPatch } : {}), ...(add.length ? { uploads: add.map((a) => a.layer) } : {}),
        };
        const t0 = performance.now();
        let factor = 1, out = await route({ ...req, cap: CAP, bufferFactor: factor }, io);
        while (!out.ok && /exceeds the cap/.test(out.reason) && factor >= 0.1) { factor = Math.round(factor * 0.75 * 100) / 100; out = await route({ ...req, cap: CAP, bufferFactor: factor }, io); }
        const row: Row = { ...k, ok: out.ok, lineType: l.lineType, ms: Math.round(performance.now() - t0), bufferFactor: factor, uploads: add.length };
        if (!out.ok) row.reason = out.reason;
        else {
          const r = out.result, alb = r.path.coordinates.map(([lng, lat]) => albersForward(lng, lat) as XY);
          const ag = agreement(alb, g.line);
          Object.assign(row, {
            pathSha: sha(JSON.stringify(r.path.coordinates)), pathLL: r.path.coordinates, refKm: lenOf(g.line) / 1000, routeKm: lenOf(alb) / 1000,
            lengthRatio: lenOf(alb) / lenOf(g.line), meanDevKm: ag.meanM / 1000, within1: ag.within1, within5: ag.within5,
            total2025: r.cost.total2025, optimality: r.optimality, maskLimited: r.maskLimited,
          });
        }
        remember(row);
        rows.push(row);
        console.log(`${l.id.padEnd(26)} ${cfg.id.padEnd(10)} ${row.ok ? `dev ${row.meanDevKm!.toFixed(2)} km  <1km ${(row.within1! * 100).toFixed(0)} %  <5km ${(row.within5! * 100).toFixed(0)} %  len ${row.lengthRatio!.toFixed(3)}  ${row.optimality}` : 'FAILED ' + row.reason}  ${(row.ms! / 1000).toFixed(0)} s`);
      }
    }
    expect(rows.length).toBe(chosen.length * cfgs.length);
  }, 14_400_000);

  it('summary per config', () => {
    for (const cfg of cfgs) {
      const r = rows.filter((x) => x.config === cfg.id), ok = r.filter((x) => x.ok);
      console.log(`${cfg.id.padEnd(12)} solved ${ok.length}/${r.length}  median dev ${median(ok.map((x) => x.meanDevKm!)).toFixed(2)} km  within 1 km ${(median(ok.map((x) => x.within1!)) * 100).toFixed(0)} %  within 5 km ${(median(ok.map((x) => x.within5!)) * 100).toFixed(0)} %  length ratio ${median(ok.map((x) => x.lengthRatio!)).toFixed(3)}`);
    }
  });

  it('self-check: baseline and baseline2 have equal path shas', () => {
    const a = rows.filter((x) => x.config === 'baseline'), b = rows.filter((x) => x.config === 'baseline2');
    if (!a.length || !b.length) { console.log('baseline vs baseline2: not both run, skipped'); return; }
    expect(a.some((x) => x.ok), 'no baseline line solved').toBe(true);
    for (const x of a) {
      const y = b.find((z) => z.id === x.id)!;
      expect(y.ok, `${x.id}: baseline2 ok`).toBe(x.ok);
      expect(y.pathSha, `${x.id}: path sha`).toBe(x.pathSha);
    }
  });

  it('self-check (full set): noneutral median share within 1 km exceeds baseline\'s', () => {
    const a = rows.filter((x) => x.config === 'baseline' && x.ok), b = rows.filter((x) => x.config === 'noneutral' && x.ok);
    if (LIMIT !== null || !a.length || !b.length) { console.log('noneutral check: needs a full set with baseline and noneutral, skipped'); return; }
    const ids = a.filter((x) => b.some((y) => y.id === x.id)).map((x) => x.id);
    const m = (rs: Row[]) => median(rs.filter((x) => ids.includes(x.id)).map((x) => x.within1!));
    console.log(`median within-1 km share over ${ids.length} lines: noneutral ${m(b).toFixed(3)}, baseline ${m(a).toFixed(3)}`);
    expect(m(b)).toBeGreaterThan(m(a));
  });
});

describe.skipIf(!have || !TOUCH)('as-built lines: touch count', () => {
  it('lines whose baseline route or reference crosses a cell the candidate weighs differently (D5)', async () => {
    const cand = resolveConfig(TOUCH, base);
    if (typeof cand === 'string') throw new Error(`refused: ${cand}`);
    const cb = resolveConfig('baseline', base) as Cfg;
    const grid = meta!.grid;
    const wanted = [...new Set([...presetBands(patched(cb)), ...presetBands(patched(cand))])].filter((b) => !String(b).startsWith('upl_'));
    const io = lineIO();
    let touched = 0, noBaseline = 0;
    const out: string[] = [];
    for (const l of chosen) {
      const ref = geo.get(l.id)!.line;
      const saved = done.get(key({ id: l.id, set: SET, config: 'baseline', mutate: '', kv: stamp(cb) }));
      const path = saved?.ok && saved.pathLL ? saved.pathLL.map(([lng, lat]) => albersForward(lng, lat) as XY) : null;
      if (!path) noBaseline++;
      const polys = path ? [ref, path] : [ref];
      const pt = await readPathTiles(grid, meta!.present, io, wanted, polys);
      const ll = await lineLayers(l);
      const seen = new Set<number>();
      let hit = 0;
      const fxp = (x: number) => (x - grid.x0) / grid.cell, fyp = (y: number) => (grid.y0 - y) / grid.cell;
      for (const poly of polys) {
        for (let s = 1; s < poly.length; s++) {
          traverse(fxp(poly[s - 1][0]), fyp(poly[s - 1][1]), fxp(poly[s][0]), fyp(poly[s][1]), (col, row, len) => {
            if (len <= 0 || seen.has(row * grid.cols + col)) return;
            seen.add(row * grid.cols + col);
            const v: Partial<Record<BandName, number>> = {};
            for (const b of wanted) v[b] = pt.value(b, col, row) ?? 0;
            const a = cellUnder(cb, l, ll, v, col, row), c = cellUnder(cand, l, ll, v, col, row);
            if (Math.abs(a.r - c.r) > 1e-9 || a.barrier !== c.barrier) hit++;
          });
        }
      }
      if (hit) touched++;
      out.push(`${l.id.padEnd(26)} cells ${String(seen.size).padStart(5)}  differing ${String(hit).padStart(5)}${path ? '' : '  (no saved baseline row: reference only)'}`);
    }
    console.log(out.join('\n'));
    console.log(`TOUCH ${TOUCH} set ${SET}: ${touched} of ${chosen.length} lines touched${noBaseline ? ` (${noBaseline} without a saved baseline route)` : ''}; ${touched < 10 ? 'NOT TESTABLE (< 10 lines)' : 'testable'}`);
    expect(chosen.length).toBeGreaterThan(0);
  }, 3_600_000);
});

describe.skipIf(!have || !REFCOST)('as-built lines: reference costing', () => {
  it('costs each reference geometry on its own line type with the end kinds of R2 (report only)', async () => {
    const r2 = existsSync(R2_FILE) ? (JSON.parse(readFileSync(R2_FILE, 'utf8')).lines as { id: string; circuits?: string; end_kinds?: { a?: string; b?: string } }[]) : [];
    const kind = (s?: string): EndKind => (s && /^(position|existing)/i.test(s) ? 'position' : 'new');
    const s = await cubeSampler();
    for (const l of chosen) {
      const ref = geo.get(l.id)!.line, r = r2.find((x) => x.id === l.id);
      const single = !!r?.circuits && /single/i.test(r.circuits) && !/double|two circuit/i.test(r.circuits);
      const lt = single && base.line_types[l.lineType + 's'] ? l.lineType + 's' : l.lineType;
      let kinds: [EndKind, EndKind] = [kind(r?.end_kinds?.a), kind(r?.end_kinds?.b)];
      await preload(s, ref);
      let c;
      try { c = costPath(ref, base, lt, s, CONSTS, kinds); }
      catch { kinds = ['new', 'new']; c = costPath(ref, base, lt, s, CONSTS, kinds); }
      const row: Row = {
        id: l.id, set: SET, config: 'refcost', mutate: MUTATE, ok: true, lineType: lt, kinds: kinds.join('/'), r2: !!r,
        refKm: lenOf(ref) / 1000, total2025: c.total2025, totalNominal: c.totalNominal, lineUsdNominal: c.lineUsdNominal,
        terminalsUsd: c.terminalsUsd ?? null, dollarYear: c.dollarYear,
      };
      remember(row);
      console.log(`${l.id.padEnd(26)} ${lt.padEnd(6)} ${kinds.join('/').padEnd(14)} ${row.refKm!.toFixed(1)} km  2025$ ${(c.total2025 / 1e6).toFixed(0)} M`);
      // The saved baseline route (same ASBUILT_OUT), priced on the same line type and end kinds, so routing and pricing stay apart.
      const saved = done.get(key({ id: l.id, set: SET, config: 'baseline', mutate: '', kv: stamp(resolveConfig('baseline', base) as Cfg) }));
      if (saved?.ok && saved.pathLL) {
        const path = saved.pathLL.map(([lng, lat]) => albersForward(lng, lat) as XY);
        await preload(s, path);
        const rc = costPath(path, base, lt, s, CONSTS, kinds);
        remember({
          id: l.id, set: SET, config: 'routecost', mutate: MUTATE, ok: true, lineType: lt, kinds: kinds.join('/'), pathSha: saved.pathSha,
          routeKm: lenOf(path) / 1000, total2025: rc.total2025, totalNominal: rc.totalNominal, lineUsdNominal: rc.lineUsdNominal,
          terminalsUsd: rc.terminalsUsd ?? null, dollarYear: rc.dollarYear,
        });
      }
    }
    expect(chosen.length).toBeGreaterThan(0);
  }, 3_600_000);
});
