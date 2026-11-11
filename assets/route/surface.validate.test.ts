// Measurements (excluded from `npm test`, like every *.validate.test.ts): route() with
// { surface: true, alternatives: 3 } on the real cube (data/route/250m/), tm-default ac500, default cap,
// on Front Range, Boise -> SLC and WY wind -> Las Vegas. Prints ms per phase, cells per class band, image
// size, clipped flag, the surface's skipped reason, alternatives (stretch / share / $ / pctUsd), altFound,
// altMethod and optimality.
// Memory: needs `NODE_OPTIONS=--expose-gc`. process.memoryUsage() is sampled before and
// after gc() (pre-gc is garbage-inclusive and not gated). The solves are synchronous, so nothing outside
// route() can sample inside a phase: route() is sampled before/after the whole call (result held), and the
// phases' building blocks (read, surfaces, solve A with extend, solve B, classify, image, penalty
// alternatives) are run again directly on the same final bbox, sampled after each, buffers kept alive.
// Gate (post-gc arrayBuffers): B/cell x bbox cells + RGBA bytes + 50 MB (read transient) + 20 MB, with
// B/cell = route.ts's budget: wanted bands (+ state) + 20 + SURFACE_BYTES 11 + PENALTY_BYTES_PER_CELL 4.
// Thresholds are fixed; they change only for a sourced input difference.
// Run: NODE_OPTIONS=--expose-gc npx vitest run --config vitest.route.config.ts assets/route/surface.validate.test.ts --reporter=verbose --disableConsoleIntercept
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, openSync, readSync } from 'node:fs';
import type { Fetcher } from './cog-read.js';
import { albersForward } from './grid.js';
import { route, readBands, readGridJson, PD_BANDS, OSM_BANDS, type RouteIO, type RouteResult, type RouteSurface } from './route.js';
import { buildSurfaces, presetBands } from './cost.js';
import { solve, distances } from './dijkstra.js';
import { classify, DEFAULT_BANDS, PENALTY_BYTES_PER_CELL, penaltyAlternatives } from './similar-cost.js';
import { surfaceImage } from './surface-image.js';
import { searchLimitFactor } from './preset-patch.js';
import { routePreset } from '../../src/registry/route-presets.js';

const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const have = existsSync(CUBE + 'grid.json');
const SURFACE_BYTES = 11;   // route.ts's SURFACE_BYTES
const MB = 1024 * 1024;
const PALETTE = [[0, 0, 0, 0], [8, 81, 156, 220], [49, 130, 189, 190], [107, 174, 214, 160], [189, 215, 231, 130]] as const;
type XY = [number, number];
const ROUTES: { name: string; from: XY; to: XY }[] = [
  { name: 'Front Range (Denver -> Colorado Springs)', from: [-104.99, 39.74], to: [-104.82, 38.83] },
  { name: 'Boise -> SLC', from: [-116.20, 43.62], to: [-111.89, 40.76] },
  { name: 'WY wind -> Las Vegas', from: [-106.3, 41.8], to: [-115.15, 36.17] },
];

const fds = new Map<string, Fetcher>();
const io: RouteIO = {
  baseUrl: CUBE,
  async fetchJson(url) { return JSON.parse(readFileSync(url, 'utf8')); },
  fetchRange(url, start, end) {
    if (!fds.has(url)) {
      const fd = openSync(url, 'r');
      fds.set(url, async (s, e) => { const buf = Buffer.alloc(e - s); const n = readSync(fd, buf, 0, buf.length, s); return new Uint8Array(buf.buffer, buf.byteOffset, n); });
    }
    return fds.get(url)!(start, end);
  },
};

interface Mem { rss: number; heap: number; ab: number }
const mu = (): Mem => { const m = process.memoryUsage(); return { rss: m.rss, heap: m.heapUsed, ab: m.arrayBuffers }; };
/** Samples before and after gc(). */
function sample(label: string): { label: string; pre: Mem; post: Mem } {
  const pre = mu();
  (globalThis as unknown as { gc: () => void }).gc();
  return { label, pre, post: mu() };
}
const mb = (x: number) => (x / MB).toFixed(0);
const memRow = (s: { label: string; pre: Mem; post: Mem }, bound?: number) =>
  `${s.label.padEnd(22)} rss ${mb(s.pre.rss).padStart(6)} -> ${mb(s.post.rss).padStart(6)}  heap ${mb(s.pre.heap).padStart(5)} -> ${mb(s.post.heap).padStart(5)}  arrayBuffers ${mb(s.pre.ab).padStart(6)} -> ${mb(s.post.ab).padStart(6)} MB` +
  (bound === undefined ? '' : `  bound ${mb(bound).padStart(6)}  ${s.post.ab <= bound ? 'ok' : 'OVER'}`);

describe.skipIf(!have)('similar-cost areas and alternatives (tm-default ac500, default cap)', () => {
  const meta = have ? readGridJson(JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'))) : null;
  if (typeof meta === 'string') throw new Error(meta);
  const preset = routePreset('tm-default')!;
  const wanted = presetBands(preset);
  const bandCount = [...PD_BANDS, ...OSM_BANDS].filter((n) => wanted.has(n) || n === 'state').length;
  const perCell = bandCount + 20 + SURFACE_BYTES + PENALTY_BYTES_PER_CELL;

  it('has --expose-gc', () => { expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function'); });

  for (const rt of ROUTES) {
    it(rt.name, async () => {
      const out: string[] = ['', `${rt.name}   (budget ${bandCount} bands + 20 + ${SURFACE_BYTES} + ${PENALTY_BYTES_PER_CELL} = ${perCell} B/cell)`];
      const base = sample('baseline');
      const t0 = performance.now();
      const res = await route({ from: rt.from, to: rt.to, preset: 'tm-default', lineType: 'ac500', surface: true, alternatives: 3 }, io);
      const wall = performance.now() - t0;
      expect(res.ok, res.ok ? '' : res.reason).toBe(true);
      const r = (res as { ok: true; result: RouteResult }).result;
      const n = r.cells.bbox;
      const surf = r.surface as RouteSurface | { skipped: string } | undefined;
      const rgbaBytes = surf && 'image' in surf ? surf.image.rgba.length : 0;
      const bound = perCell * n + rgbaBytes + 50 * MB + 20 * MB;
      const after = sample('after route()');
      const t = r.timingsMs;
      out.push(`route ${r.lengthMi.toFixed(0)} mi  optimality ${r.optimality}  maskLimited ${r.maskLimited}  buffer ${(r.bufferM / 1000).toFixed(1)} km  bbox ${n} cells  mask ${r.cells.mask}  visited ${r.cells.visited}  wall ${(wall / 1000).toFixed(1)} s`);
      out.push(`ms per phase: read ${t.read.toFixed(0)}  surfaces ${t.surfaces.toFixed(0)}  solve ${t.solve.toFixed(0)}  prove ${t.prove.toFixed(0)}  reduce ${t.reduce.toFixed(0)}  similar ${t.similar.toFixed(0)}  alternatives ${t.alternatives.toFixed(0)}  total ${t.total.toFixed(0)}`);
      if (surf && 'skipped' in surf) out.push(`surface skipped: ${surf.skipped}`);
      else if (surf) {
        out.push(`surface: cells by class 1..4 (<= ${DEFAULT_BANDS.map((b) => b * 100 + ' %').join(', ')}): ${surf.cellsByBand.join(' / ')}  clipped ${surf.clipped} (${surf.edgeCellsInBands} edge cells)  window ${surf.window.cols}x${surf.window.rows} cells  image ${surf.image.width}x${surf.image.height} (${(rgbaBytes / MB).toFixed(1)} MB RGBA)`);
      }
      out.push(`altFound ${r.altFound}  altMethod ${r.altMethod}${r.altSkipped ? `  altSkipped: ${r.altSkipped}` : ''}`);
      out.push(`${'alt'.padEnd(5)}${'stretch %'.padStart(10)}${'share'.padStart(8)}${'miles'.padStart(8)}${'2025 $M'.padStart(10)}${'pctUsd %'.padStart(10)}${'ms'.padStart(8)}`);
      out.push(`${'opt'.padEnd(5)}${'0'.padStart(10)}${'-'.padStart(8)}${r.lengthMi.toFixed(0).padStart(8)}${(r.cost.total2025 / 1e6).toFixed(1).padStart(10)}${'0'.padStart(10)}${'-'.padStart(8)}`);
      (r.alternatives ?? []).forEach((a, i) => out.push(`${String(i + 1).padEnd(5)}${a.pctRoute.toFixed(2).padStart(10)}${a.shared.toFixed(3).padStart(8)}${a.lengthMi.toFixed(0).padStart(8)}${(a.cost.total2025 / 1e6).toFixed(1).padStart(10)}${a.pctUsd.toFixed(2).padStart(10)}${a.ms.toFixed(0).padStart(8)}`));
      out.push('memory (MB; pre-gc -> post-gc):', memRow(base), memRow(after, bound));
      const gated: { label: string; post: Mem }[] = [after];

      // The phases' building blocks on the same final bbox (route() cannot be sampled from outside).
      if (surf && !('skipped' in surf)) {
        const { grid, present } = meta!;
        const frac = (p: XY): [number, number] => { const [x, y] = albersForward(p[0], p[1]); return [(x - grid.x0) / grid.cell, (grid.y0 - y) / grid.cell]; };
        const a = frac(rt.from), b = frac(rt.to), B = r.bufferM / grid.cell;
        const c0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - B)), c1 = Math.min(grid.cols, Math.ceil(Math.max(a[0], b[0]) + B));
        const r0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - B)), r1 = Math.min(grid.rows, Math.ceil(Math.max(a[1], b[1]) + B));
        const w = c1 - c0, h = r1 - r0, nb = w * h;
        expect(nb).toBe(n);
        const phases: { label: string; post: Mem; pre: Mem }[] = [];
        const mark = (label: string) => { const s = sample(label); phases.push(s); gated.push(s); };
        const bands = await readBands(grid, wanted, present, io, { c0, r0, w, h }); mark('read');
        const surfs = buildSurfaces(preset, 'ac500', bands, w, h, { cost: false }); mark('surfaces');
        const mask = new Uint8Array(nb), B2 = B * B, dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
        for (let rr = 0; rr < h; rr++) for (let c = 0; c < w; c++) {
          const px = c0 + c + 0.5, py = r0 + rr + 0.5;
          const tt = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / dd));
          const ex = px - a[0] - tt * dx, ey = py - a[1] - tt * dy;
          if (ex * ex + ey * ey <= B2) mask[rr * w + c] = 1;
        }
        const local = (p: number[]) => (Math.floor(p[1]) - r0) * w + (Math.floor(p[0]) - c0);
        const start = local(a), goal = local(b);
        const g = { width: w, height: h, cost: surfs.route, barrier: surfs.barrier, mask, cellM: grid.cell, maxCells: 30e6 };
        const parent = new Int32Array(nb);
        const limitF = searchLimitFactor(0.2);
        const tA = performance.now();
        const sol = solve({ ...g, start, goal }, { extend: limitF - 1, parent });
        const msA = performance.now() - tA;
        expect(sol.ok).toBe(true);
        if (!sol.ok) return;
        mark('solve A (extend)');
        const tB = performance.now();
        const back = distances({ ...g, start: goal }, limitF * sol.cost, [start, goal], { dist: new Float64Array(nb), state: new Uint8Array(nb) });
        const msB = performance.now() - tB;
        expect('error' in back).toBe(false);
        if ('error' in back) return;
        mark('solve B (distances)');
        const tC = performance.now();
        const classes = classify(sol.dist, back.dist, sol.cost, DEFAULT_BANDS);
        const msC = performance.now() - tC;
        mark('classify');
        let cMin = w, cMax = -1, rMin = h, rMax = -1;
        for (let rr = 0; rr < h; rr++) for (let c = 0, i = rr * w; c < w; c++, i++) if (classes[i]) { if (c < cMin) cMin = c; if (c > cMax) cMax = c; if (rr < rMin) rMin = rr; rMax = rr; }
        const cw = cMax - cMin + 1, ch = rMax - rMin + 1, crop = new Uint8Array(cw * ch);
        for (let rr = 0; rr < ch; rr++) crop.set(classes.subarray((rMin + rr) * w + cMin, (rMin + rr) * w + cMin + cw), rr * cw);
        const tI = performance.now();
        const img = surfaceImage(grid, { col0: c0 + cMin, row0: r0 + rMin, cols: cw, rows: ch }, crop, PALETTE);
        const msI = performance.now() - tI;
        mark('image');
        const tP = performance.now();
        const pen = penaltyAlternatives({ input: { ...g, start, goal }, optimum: { path: sol.path, cost: sol.cost }, k: 3, scratch: sol.scratch, parent, stretchMax: 0.2 });
        const msP = performance.now() - tP;
        mark('alternatives');
        out.push(`building blocks (direct): solve A ${msA.toFixed(0)} ms (visited ${sol.visited})  solve B ${msB.toFixed(0)} ms (visited ${back.visited})  classify ${msC.toFixed(0)} ms  image ${msI.toFixed(0)} ms (${img.width}x${img.height})  penalty ${msP.toFixed(0)} ms (${pen.alts.length} alts, ${pen.attempts} re-solves, ${pen.bytes} B weight copy)`);
        out.push('memory per phase (MB; buffers of earlier phases kept alive; bound as above):');
        for (const s of phases) out.push(memRow(s, bound));
        // keep every phase's buffers reachable until the last sample
        expect(bands.state!.length + surfs.route.length + mask.length + parent.length + back.dist.length + classes.length + crop.length + img.rgba.length).toBeGreaterThan(0);
      }
      console.log(out.join('\n'));

      // expectations (validation table)
      if (rt.name.startsWith('Boise')) {
        expect(surf && 'clipped' in surf && surf.clipped).toBe(true);
        expect(r.altFound ?? 0).toBeGreaterThanOrEqual(1);
      }
      if (rt.name.startsWith('WY')) expect(surf && 'skipped' in surf).toBe(true);
      for (const s of gated) expect(s.post.ab, s.label).toBeLessThanOrEqual(bound);
    }, 1_800_000);
  }
});
