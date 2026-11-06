// Band override through a shadow cube: the script named by BAND_OVERRIDE_HARNESS writes
// substitute copies of the super-tiles one band changes in; shadowIO maps those files' URLs to the shadow
// directory and every other URL to the real cube, so route() reads the candidate band through cog-read
// unchanged (no decoding wrapper, no route.ts change). Each IO gets its own baseUrl: route.ts caches opened
// files by URL, so a shadow and its source must never share one.
// First describe: the fixture cube (fixtures/cube), shadows built by shadow_cube.py into a temp dir.
// Second describe (BAND_OVERRIDE_SHADOW=<shadow dir>): held-out routes solved through a shadow of the real
// cube, compared with baseline-v7.json. BAND_OVERRIDE_ONLY=<id substrings, comma-separated>, BAND_OVERRIDE_LIMIT=<n>,
// BAND_OVERRIDE_OUT=<rows.json>, BAND_OVERRIDE_EXPECT=identical (every path must equal the baseline's).
// BAND_OVERRIDE_MUTATE=nomap maps no URL to the shadow (the planted-barrier check must then fail).
// Run: npx vitest run -c vitest.route.config.ts assets/route/band-override.validate.test.ts --disableConsoleIntercept
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { route, type RouteIO } from './route.js';
import { gridFromJson, lngLatOf } from './grid.js';
import type { Fetcher } from './cog-read.js';

const PY = 'venv/bin/python';
const HARNESS = process.env.BAND_OVERRIDE_HARNESS;
const BASELINE = process.env.BAND_OVERRIDE_BASELINE;
const FIXTURE = resolve('assets/route/fixtures/cube') + '/';
const REAL = resolve('data/route/250m') + '/';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ioSerial = 0;

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}

/** RouteIO over `cube`, with the files shadow.json lists read from `shadow`; `reads` = shadow files fetched, `hits` = range reads of them. */
function shadowIO(cube: string, shadow?: string): RouteIO & { reads: Set<string>; hits: number } {
  const rewritten = new Set<string>(
    shadow && process.env.BAND_OVERRIDE_MUTATE !== 'nomap'
      ? JSON.parse(readFileSync(join(shadow, 'shadow.json'), 'utf8')).tiles.map((t: { name: string }) => t.name)
      : [],
  );
  const base = `cube${++ioSerial}://`;
  const fds = new Map<string, Fetcher>();
  const reads = new Set<string>();
  const io = {
    baseUrl: base,
    reads,
    hits: 0,
    async fetchJson(url: string) { return JSON.parse(readFileSync(local(url), 'utf8')); },
    fetchRange(url: string, start: number, end: number) {
      const p = local(url);
      if (p !== cube + url.slice(base.length)) io.hits++;
      if (!fds.has(p)) fds.set(p, fileFetcher(p));
      return fds.get(p)!(start, end);
    },
  };
  const local = (url: string) => {
    const name = url.slice(base.length);
    if (rewritten.has(name)) { reads.add(name); return join(shadow!, name); }
    return cube + name;
  };
  return io;
}

const py = (...args: string[]) => execFileSync(PY, ['-I', HARNESS!, ...args], { encoding: 'utf8' });

const SET = Boolean(HARNESS && BASELINE);

describe.skipIf(!SET)('band override on the fixture cube', () => {
  const gj = JSON.parse(readFileSync(FIXTURE + 'grid.json', 'utf8'));
  const grid = gridFromJson(gj);
  const [X0, Y0] = gj.origin as [number, number];
  const C = gj.cell as number;
  /** EPSG:5070 bbox of cells [c0, c1) x [r0, r1), as CLI args. */
  const bbox = (c0: number, r0: number, c1: number, r1: number) =>
    [X0 + c0 * C, Y0 - r1 * C, X0 + c1 * C, Y0 - r0 * C].map(String);
  const ALL = bbox(0, 0, gj.cols, gj.rows);
  const req = { from: lngLatOf(grid, 20, 20), to: lngLatOf(grid, 30, 20), preset: 'tm-default', lineType: 'ac500' };
  const root = process.env.ROUTE_TMP ?? tmpdir();
  let tmp = '';

  beforeAll(() => {
    mkdirSync(root, { recursive: true });
    tmp = mkdtempSync(join(root, 'band-override-'));
    py('extract', FIXTURE, 'state', join(tmp, 'same.tif'), '--bbox', ...ALL);
    py('build', FIXTURE, join(tmp, 'same'), 'state', join(tmp, 'same.tif'), '--bbox', ...ALL);
    // A barrier (state 0) across the straight path at column 25, rows 15-25: the route must go round it.
    py('extract', FIXTURE, 'state', join(tmp, 'wall.tif'), '--bbox', ...ALL, '--plant', '0', ...bbox(25, 15, 26, 26));
    py('build', FIXTURE, join(tmp, 'wall'), 'state', join(tmp, 'wall.tif'), '--bbox', ...bbox(20, 10, 30, 30));
  }, 60_000);
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('an identical band leaves the path byte-identical, read from the shadow', async () => {
    const real = await route(req, shadowIO(FIXTURE));
    const io = shadowIO(FIXTURE, join(tmp, 'same'));
    const same = await route(req, io);
    expect(real.ok && same.ok).toBe(true);
    if (!real.ok || !same.ok) return;
    expect(JSON.stringify(same.result.path.coordinates)).toBe(JSON.stringify(real.result.path.coordinates));
    expect(same.result.cost.total2025).toBe(real.result.cost.total2025);
    if (process.env.BAND_OVERRIDE_MUTATE !== 'nomap') expect([...io.reads]).toContain('pd_0_0.tif');
  });

  it('a planted barrier changes the path', async () => {
    const real = await route(req, shadowIO(FIXTURE));
    const wall = await route(req, shadowIO(FIXTURE, join(tmp, 'wall')));
    expect(real.ok && wall.ok).toBe(true);
    if (!real.ok || !wall.ok) return;
    expect(JSON.stringify(wall.result.path.coordinates)).not.toBe(JSON.stringify(real.result.path.coordinates));
    expect(wall.result.lengthMi).toBeGreaterThan(real.result.lengthMi);
  });
});

type XY = [number, number];
const SHADOW = process.env.BAND_OVERRIDE_SHADOW;

describe.skipIf(!SET || !SHADOW)('band override: held-out routes through a shadow of the real cube', () => {
  it('solves and compares with baseline-v7', async () => {
    const shadow = resolve(SHADOW!);
    const man = JSON.parse(readFileSync(join(shadow, 'shadow.json'), 'utf8'));
    expect(resolve(man.source) + '/').toBe(REAL);
    const routes: { id: string; from: XY; to: XY; presets: string[]; lineType: string; set: string; split: string }[] =
      JSON.parse(readFileSync('assets/route/fixtures/holdout-routes.json', 'utf8')).routes;
    const baseline = new Map<string, Record<string, unknown>>(
      JSON.parse(readFileSync(BASELINE!, 'utf8'))
        .map((r: { id: string; preset: string }) => [`${r.id}|${r.preset}`, r]),
    );
    const only = (process.env.BAND_OVERRIDE_ONLY ?? '').split(',').filter(Boolean);
    const limit = Number(process.env.BAND_OVERRIDE_LIMIT || Infinity);
    const todo = routes.filter((r) => !only.length || only.some((s) => r.id.includes(s))).slice(0, limit);
    const io = shadowIO(REAL, shadow);
    const rows: Record<string, unknown>[] = [];
    for (const r of todo) for (const preset of r.presets) {
      const b = baseline.get(`${r.id}|${preset}`);
      let factor = (b?.bufferFactor as number | undefined) ?? 1;
      const before = io.hits;
      let out;
      for (;;) {
        out = await route({ from: r.from, to: r.to, preset, lineType: r.lineType, cap: 100e6, bufferFactor: factor }, io);
        if (out.ok || !/exceeds the cap/.test(out.reason) || factor < 0.1) break;
        factor = Math.round(factor * 0.75 * 100) / 100;
      }
      const shadowRead = io.hits > before;
      const row: Record<string, unknown> = { id: r.id, set: r.set, split: r.split, preset, bufferFactor: factor, baselineSha256: b?.cellsSha256 ?? null };
      if (!out.ok) { rows.push({ ...row, ok: false, error: out.reason }); console.log(`${r.id} ${preset}: FAILED ${out.reason}`); continue; }
      const x = out.result, cellsSha256 = sha(JSON.stringify(x.path.coordinates));
      rows.push({
        ...row, ok: true, path: x.path.coordinates, cellsSha256, same: cellsSha256 === b?.cellsSha256, lengthMi: x.lengthMi,
        total2025: x.cost.total2025, routingCost: x.routeCost, optimality: x.optimality, shadowRead,
      });
      console.log(`${r.id.padEnd(34)} ${preset.padEnd(10)} ${x.lengthMi.toFixed(1)} mi ${cellsSha256 === b?.cellsSha256 ? 'same' : 'CHANGED'}`);
    }
    if (process.env.BAND_OVERRIDE_OUT) writeFileSync(process.env.BAND_OVERRIDE_OUT, JSON.stringify(rows));
    expect(rows.length).toBe(todo.reduce((n, r) => n + r.presets.length, 0));
    if (process.env.BAND_OVERRIDE_EXPECT === 'identical') {
      expect(io.reads.size).toBeGreaterThan(0);
      expect(rows.filter((r) => !r.same).map((r) => `${r.id}|${r.preset}`)).toEqual([]);
    }
  }, 36_000_000);
});
