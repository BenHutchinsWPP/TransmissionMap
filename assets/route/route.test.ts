// Route integration checks over the generated mini cube: reads, solves, coverage, edited methods and uploaded layers.
// Deps: route.ts, grid.ts, cost/preset validation, upload-layer.ts and fixtures/make-cube.py's cube contracts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInspectCache, createWindowCache, edgeCells, exactRouteCrossings, inspect, OSM_BANDS, PD_BANDS, provenOptimal, readBands, readGridJson, repaint, repaintRows, route, weightClass, WEIGHT_BARRIER, WEIGHT_PALETTE, type RouteIO, type RouteRequest, type RouteResult } from './route.js';
import { uploadLayer, type UploadLayer } from './upload-layer.js';
import { parseUploadBudget, uploadBand, UPLOAD_BUDGET_MSG, validatePresetPatch, type PresetPatch } from './preset-patch.js';
import { mergePatch } from '../ui/route-request.js';
import { buildSurfaces, presetBands } from './cost.js';
import { CAUSE_COLOURS } from './cause-colours.js';
import { surfaceImage } from './surface-image.js';
import { routePreset, type BandName } from '../../src/registry/route-presets.js';
import { distances, MOVE_DC, MOVE_DR, solve } from './dijkstra.js';
import { albersForward, albersInverse, gridFromJson, GRID_250, lngLatOf } from './grid.js';
import { openTiff } from './cog-read.js';
import { traverse } from './dijkstra.js';

// fixtures/make-cube.py: 90 × 60 cells, wall of state 0 down column 40 with a gap at rows 55–57.
const dir = new URL('./fixtures/cube/', import.meta.url);
const gridJson = JSON.parse(readFileSync(new URL('grid.json', dir), 'utf8'));
const grid = gridFromJson(gridJson);

/** `base` must differ per fixture directory: route.ts caches opened files by URL. */
function fakeIO(json: unknown = gridJson, from: URL = dir, base = 'mem://cube/'): RouteIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    baseUrl: base,
    calls,
    async fetchJson(url) { calls.push(url); return json; },
    async fetchRange(url, start, end) {
      calls.push(url);
      const buf = readFileSync(new URL(url.slice(base.length), from));
      return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
    },
  };
}

const at = (col: number, row: number) => lngLatOf(grid, col, row);
const req = (over: Partial<RouteRequest> = {}): RouteRequest =>
  ({ from: at(20, 20), to: at(60, 20), preset: 'tm-default', lineType: 'ac500', ...over });

/** Rows (cells) the path occupies where it is in column `col`, sampled every 0.05 cell. */
function rowsInColumn(coords: number[][], col: number): number[] {
  const pts = coords.map(([lng, lat]) => {
    const [x, y] = albersForward(lng, lat);
    return [(x - grid.x0) / grid.cell, (grid.y0 - y) / grid.cell];
  });
  const rows: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05);
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
      if (Math.floor(x) === col) rows.push(Math.floor(y));
    }
  }
  return rows;
}

describe('route', () => {
  it('loads regional footprints and changes geometry only when their neutral row is edited', async () => {
    const input = req({ from: at(20, 20), to: at(30, 20) });
    const normal = await route(input, fakeIO());
    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    expect(rowsInColumn(normal.result.path.coordinates, 25).some((r) => r >= 15 && r <= 35)).toBe(true);
    const edited = await route({ ...input, presetPatch: { rows: [{
      row: routePreset('tm-default')!.rows.findIndex((r) => r.band === 'nonres'),
      band: 'nonres', note: 'observed nonresidential footprints', route_w: 1000,
    }] } }, fakeIO());
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(rowsInColumn(edited.result.path.coordinates, 25).every((r) => r < 15 || r > 35)).toBe(true);
    const box = { c0: 0, r0: 0, w: 40, h: 45 };
    const bands = await readBands(grid, new Set<BandName>(['built', 'nonres', 'bldgunk']), new Set(['0_0']), fakeIO(), box);
    expect(bands.nonres![20 * box.w + 25]).toBe(101);
    expect(bands.bldgunk![8 * box.w + 30]).toBe(2);
    expect(bands.built![8 * box.w + 30]).toBe(2);
    expect(bands.nonres![10 * box.w + 15]).toBe(1);
    expect(bands.nonres![0]).toBe(0);
  });

  it('returns similar-cost areas and an alternative through the other gap (cube-wall)', async () => {
    // fixtures/cube-wall: the same grid, wall in column 40 open at rows 12–14 and 45–47.
    const wallDir = new URL('./fixtures/cube-wall/', import.meta.url);
    const wallJson = JSON.parse(readFileSync(new URL('grid.json', wallDir), 'utf8'));
    const out = await route(req({ from: at(20, 29), to: at(60, 29), surface: true, alternatives: 3 }), fakeIO(wallJson, wallDir, 'mem://cube-wall/'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;
    const gapOf = (coords: number[][]) => {
      const rows = rowsInColumn(coords, 40);
      expect(rows.length).toBeGreaterThan(0);
      return rows.every((y) => y >= 12 && y <= 14) ? 'north' : rows.every((y) => y >= 45 && y <= 47) ? 'south' : 'mixed';
    };
    expect(gapOf(r.path.coordinates)).toBe('north');
    expect(r.optimality).toBe('proven');

    const s = r.surface!;
    expect('image' in s).toBe(true);
    if (!('image' in s)) return;
    expect(s.cellsByBand.every((k) => k > 0)).toBe(true);
    expect(s.classes.length).toBe(s.window.cols * s.window.rows);
    expect(s.classes.reduce((m, k) => Math.max(m, k), 0)).toBe(4);
    expect(s.cellsByBand.reduce((a, b) => a + b, 0)).toBe(s.classes.reduce((m, k) => m + (k ? 1 : 0), 0));
    // the south gap (≈ 2.5 % dearer) is inside the similar-cost areas
    const cls = (col: number, row: number) => s.classes[(row - s.window.row0) * s.window.cols + col - s.window.col0];
    expect(cls(40, 46)).toBeGreaterThan(0);
    expect(cls(40, 46)).toBeLessThanOrEqual(2);
    expect(s.clipped).toBe(false);
    expect(s.image.rgba.length).toBe(s.image.width * s.image.height * 4);

    expect(r.altMethod).toBe('penalty');
    expect(r.altFound).toBe(r.alternatives!.length);
    const south = r.alternatives!.find((alt) => gapOf(alt.path.coordinates) === 'south');
    expect(south).toBeDefined();
    expect(south!.shared).toBeLessThanOrEqual(0.5);
    expect(south!.pctRoute).toBeGreaterThan(0);
    expect(south!.pctRoute).toBeLessThan(10);
    expect(south!.routeCostRaw).toBeGreaterThan(r.routeCost!.raw);
    expect(Number.isFinite(south!.pctUsd)).toBe(true);
    expect(south!.cost.total2025).toBeGreaterThan(0);
    expect(r.timingsMs.similar).toBeGreaterThan(0);
    expect(r.timingsMs.alternatives).toBeGreaterThan(0);
  });

  it('skips the similar-cost areas and alternatives past their share of the cap, keeping the route', async () => {
    // 90 × 60 bbox = 5400 cells: the route fits a cap of 5400; with 15 B/cell more it does not.
    const out = await route(req({ surface: true, alternatives: 2, cap: 5400 }), fakeIO());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.surface).toEqual({ skipped: expect.stringMatching(/^cap: the bbox has 5400 cells/) });
    expect(out.result.altSkipped).toMatch(/^cap: /);
    expect(out.result.altFound).toBe(0);
    // The RGBA image's fixed bytes come off the pool: a cap of 1e6 cells skips, 1e7 does not.
    const low = await route(req({ surface: true, cap: 1e6 }), fakeIO());
    expect(low.ok && low.result.surface).toEqual({ skipped: expect.stringMatching(/^cap: /) });
    const high = await route(req({ surface: true, cap: 1e7 }), fakeIO());
    expect(high.ok && high.result.surface).toHaveProperty('image');
    const plain = await route(req(), fakeIO());
    expect(plain.ok && plain.result.surface).toBeUndefined();
    expect(plain.ok && plain.result.alternatives).toBeUndefined();
  });

  it('returns the same path and cost with the similar-cost surface on or off', async () => {
    const wallDir = new URL('./fixtures/cube-wall/', import.meta.url);
    const wallJson = JSON.parse(readFileSync(new URL('grid.json', wallDir), 'utf8'));
    const cubes: [Parameters<typeof fakeIO>, Partial<RouteRequest>][] = [
      [[], {}], [[wallJson, wallDir, 'mem://cube-wall/'], { from: at(20, 29), to: at(60, 29) }],
    ];
    for (const [io, over] of cubes) {
      const off = await route(req(over), fakeIO(...io));
      const on = await route(req({ ...over, surface: true }), fakeIO(...io));
      expect(off.ok && on.ok).toBe(true);
      if (!off.ok || !on.ok) return;
      expect(on.result.surface).toBeDefined();
      expect(on.result.path).toEqual(off.result.path);
      expect(on.result.cost).toEqual(off.result.cost);
      expect(on.result.optimality).toBe(off.result.optimality);
    }
  });

  it('returns the routing-weight overlay over the search window only when asked, changing nothing else', async () => {
    const drop = ({ timingsMs: _t, weightImage: _w, ...rest }: RouteResult) => rest;
    const off = await route(req(), fakeIO());
    const on = await route(req({ weightImage: true }), fakeIO());
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    expect(off.result.weightImage).toBeUndefined();
    expect(drop(on.result)).toEqual(drop(off.result));
    const img = on.result.weightImage!;
    expect('rgba' in img).toBe(true);
    if (!('rgba' in img)) return;
    // the 25 km buffer covers the whole 90 × 60 fixture: the window is the grid
    const want = surfaceImage(grid, { col0: 0, row0: 0, cols: 90, rows: 60 }, new Uint8Array(5400), WEIGHT_PALETTE);
    expect([img.width, img.height, img.coordinates]).toEqual([want.width, want.height, want.coordinates]);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
    // the state-0 wall is drawn in the barrier colour (hatched: full and lighter alpha)
    const [br, bg, bb, ba] = WEIGHT_PALETTE[WEIGHT_BARRIER];
    const alphas = new Set<number>();
    for (let o = 0; o < img.rgba.length; o += 4) if (img.rgba[o] === br && img.rgba[o + 1] === bg && img.rgba[o + 2] === bb) alphas.add(img.rgba[o + 3]);
    expect([...alphas].sort((x, y) => x - y)).toEqual([90, ba]);
    expect([weightClass(1), weightClass(0.5), weightClass(1.5), weightClass(10), weightClass(100), weightClass(5000)]).toEqual([0, 0, 1, 4, 6, 7]);
    const bad = await route(req({ weightImage: 'yes' as never }), fakeIO());
    expect(bad).toEqual({ ok: false, reason: 'weightImage must be true or false' });
    const skip = await route(req({ weightImage: true, cap: 1e6 }), fakeIO());
    expect(skip.ok && skip.result.weightImage).toEqual({ skipped: expect.stringMatching(/^cap: .*routing-weight overlay/) });
  });

  it('inspect reads only the blocks holding the cell, caches them, and explains the cell', async () => {
    const io = fakeIO(gridJson, dir, 'mem://inspect/');
    const cache = createInspectCache(64);
    const wall = await inspect({ lngLat: at(40, 20), preset: 'tm-default', lineType: 'ac500' }, io, cache);
    expect(wall.ok).toBe(true);
    if (!wall.ok) return;
    expect(wall.result.cell).toEqual([40, 20]);
    expect(wall.result.values.state).toBe(0);
    expect(wall.result.explain.barrier).toEqual({ k: 'route.insp.barrier.outside' });
    expect(Object.keys(wall.result.values)).toHaveLength(22);
    // 22 band arrays of one 32² block (pd + osm) went in the cache; a cell of the same block reads nothing
    expect(cache.blocks.size).toBe(22);
    const before = io.calls.length;
    const near = await inspect({ lngLat: at(41, 21), preset: 'tm-default', lineType: 'ac500', from: at(20, 20), to: at(60, 20), bufferM: 100 }, io, cache);
    expect(io.calls.length).toBe(before);
    expect(near.ok && near.result.inMask).toBe(false);
    const inside = await inspect({ lngLat: at(30, 20), preset: 'tm-default', lineType: 'ac500', from: at(20, 20), to: at(60, 20), bufferM: 100 }, io, cache);
    expect(inside.ok && inside.result.inMask).toBe(true);
    expect(inside.ok && inside.result.explain.barrier).toBeNull();
    // an LRU of 15 keeps one block: another block evicts the first
    const small = createInspectCache(15);
    await inspect({ lngLat: at(10, 10), preset: 'tm-default', lineType: 'ac500' }, io, small);
    await inspect({ lngLat: at(70, 50), preset: 'tm-default', lineType: 'ac500' }, io, small);
    expect(small.blocks.size).toBe(15);
    expect([...small.blocks.keys()].every((k) => k.endsWith(':1_0:0_1'))).toBe(true);
    // the preset and patch go through the solve's checks
    expect(await inspect({ lngLat: at(10, 10), preset: 'nope', lineType: 'ac500' }, io, cache)).toEqual({ ok: false, reason: 'unknown preset "nope"' });
    const patched = await inspect({ lngLat: at(10, 10), preset: 'tm-default', lineType: 'ac500', presetPatch: { rows: [{ row: 9999, band: 'x' }] } as never }, io, cache);
    expect(patched.ok).toBe(false);
  });

  it('routes through the gap in the wall', async () => {
    const out = await route(req(), fakeIO());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;
    const rows = rowsInColumn(r.path.coordinates, 40);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((y) => y >= 55 && y <= 57)).toBe(true);
    expect(r.maskLimited).toBe(false);
    expect(r.optimality).toBe('proven');
    expect(r.routeCost!.pis).toBeLessThanOrEqual(r.routeCost!.raw * 1.005 + 1e-6);
    expect(r.cost.barrierM).toBe(0);
    expect(r.cells.pis).toBeLessThan(r.cells.path);
    expect(r.segments).toHaveLength(r.path.coordinates.length - 1);
    // detour via the gap: ≥ 2·hypot(20, 35) cells, well over the 40-cell straight line
    expect(r.lengthMi * 1609.344).toBeGreaterThan(2 * Math.hypot(20, 34.5) * 250 * 0.99);
    expect(r.cost.total2025).toBeGreaterThan(r.cost.totalNominal);
    expect(r.path.coordinates[0]).toEqual(at(20, 20));
  });

  it('treats a super-tile missing from grid.json as nodata (a barrier)', async () => {
    const out = await route(req(), fakeIO({ ...gridJson, super_tiles_present: ['pd_0_0'] }));
    expect(out.ok).toBe(true);
    // columns 64+ read as state 0, so the goal is refused before the solve
    const missing = await route(req({ to: at(70, 20) }), fakeIO({ ...gridJson, super_tiles_present: [[0, 0]] }));
    expect(missing).toMatchObject({ ok: false, reason: expect.stringMatching(/to endpoint is outside CONUS land \(state band 0\)/) });
    expect(await route(req({ to: at(70, 20) }), fakeIO())).toMatchObject({ ok: true });
  });

  it('retries at twice the buffer when the path touches the mask edge', async () => {
    // buffer 35 cells: the mask reaches row 55, the first gap row, so the path runs along its edge.
    const small = { bufferFactor: 0.35 };
    const retried = await route(req({ ...small, cap: 1e6 }), fakeIO());
    expect(retried).toMatchObject({ ok: true, result: { maskLimited: false, bufferM: 2 * 0.35 * 25_000 } });
    // first bbox 90 × 56 = 5040 cells, retry 90 × 60 = 5400: a 5200 cap keeps the first result.
    const limited = await route(req({ ...small, cap: 5200 }), fakeIO());
    expect(limited).toMatchObject({ ok: true, result: { maskLimited: true, optimality: 'within-mask', bufferM: 0.35 * 25_000 } });
    expect(await route(req({ ...small, cap: 5000 }), fakeIO())).toMatchObject({ ok: false, reason: expect.stringMatching(/bounding box of 5040 cells exceeds the cap of 5000/) });
  });

  it('retries at twice the buffer when the path stays inside but is not proven', async () => {
    // "other NLCD" (the fixture's landcover 71) at ×4 leaves minW at 1, so the 7.5 km mask cannot prove its path.
    const patch = { rows: [{ row: 7, band: 'landcover', note: 'other NLCD', route_w: 4 }] };
    const out = await route(req({ from: at(20, 29), to: at(60, 29), bufferFactor: 0.3, presetPatch: patch, surface: true }), fakeIO());
    expect(out).toMatchObject({ ok: true, result: { optimality: 'proven', maskLimited: false, bufferM: 2 * 0.3 * 25_000 } });
    if (!out.ok) return;
    expect(out.result.surface).toMatchObject({ bufferM: 2 * 0.3 * 25_000 });
    // the unproven first attempt is not final: alternatives run once, on the retry
    const steps: string[] = [];
    await route(req({ from: at(20, 29), to: at(60, 29), bufferFactor: 0.3, presetPatch: patch, alternatives: 1 }), { ...fakeIO(), progress: (s) => steps.push(s) });
    expect(steps.filter((s) => s === 'solve')).toHaveLength(2);
    expect(steps.filter((s) => s === 'alternatives')).toHaveLength(1);
  });

  it('works with the pnas-wu2023 preset (state 8 is inside its region)', async () => {
    expect(await route(req({ preset: 'pnas-wu2023' }), fakeIO())).toMatchObject({ ok: true });
  });

  describe.each(['nrel-revx', 'bv-2014', 'westtec-es'])('study preset %s', (id) => {
    const preset = routePreset(id)!;
    it.each(Object.keys(preset.line_types))('solves %s on the fixture with a finite positive cost', async (lineType) => {
      const out = await route(req({ preset: id, lineType }), fakeIO());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.path.coordinates.length).toBeGreaterThan(1);
      expect(Number.isFinite(out.result.cost.total2025)).toBe(true);
      expect(out.result.cost.total2025).toBeGreaterThan(0);
    });

    it('changes the route cost when an aviation row weight is patched (fixture has aviation codes 2-6 at row 9, cols 75-79)', async () => {
      const row = preset.rows.findIndex((r) => r.band === 'aviation');
      expect(row).toBeGreaterThanOrEqual(0);
      const ends = { from: at(72, 9), to: at(82, 9), preset: id, lineType: 'ac500' };
      const base = await route(req(ends), fakeIO());
      const hit = await route(req({ ...ends, presetPatch: { rows: [{ row, band: 'aviation', note: preset.rows[row].note, route_w: 1000 }] } }), fakeIO());
      expect(base).toMatchObject({ ok: true });
      expect(hit).toMatchObject({ ok: true });
      if (!base.ok || !hit.ok) return;
      expect(hit.result.routeCost!.raw).toBeGreaterThan(base.result.routeCost!.raw * 1.001);
    });
  });

  it('reports each phase to io.progress, in order', async () => {
    const steps: string[] = [];
    const out = await route(req(), { ...fakeIO(), progress: (s) => steps.push(s) });
    expect(out.ok).toBe(true);
    expect(steps).toEqual(['read', 'surfaces', 'solve', 'prove', 'reduce']);
  });

  it('costs the straight-line preset as two points, reading no data', async () => {
    const io = fakeIO();
    const out = await route(req({ preset: 'straight-line-quick' }), io);
    expect(io.calls).toEqual([]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.path.coordinates).toHaveLength(2);
    expect(out.result.optimality).toBe('not-solved');
    expect(out.result.lengthMi).toBeCloseTo((40 * 250 * 1.3) / 1609.344, 0);
  });

  it('refuses bad input with an Outcome, never a throw', async () => {
    const bad: [Partial<RouteRequest>, RegExp][] = [
      [{ from: [0, 0] }, /outside the routing grid/],
      [{ to: [-200, 40] }, /lng in/],
      [{ from: [NaN, 40] as [number, number] }, /lng in/],
      [{ preset: 'nope' }, /unknown preset/],
      [{ lineType: 'ac999' }, /no line type/],
      [{ to: at(20, 20) }, /same/],
      [{ cap: -1 }, /cap/],
      [{ bufferFactor: 0 }, /bufferFactor/],
    ];
    for (const [over, re] of bad) {
      const out = await route(req(over), fakeIO());
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(re);
    }
    const broken = await route(req(), { ...fakeIO(), fetchJson: async () => { throw new Error('offline'); } });
    expect(broken).toMatchObject({ ok: false, reason: expect.stringMatching(/offline/) });
    const wrongCrs = await route(req(), fakeIO({ ...gridJson, crs: 'EPSG:3857' }));
    expect(wrongCrs).toMatchObject({ ok: false, reason: expect.stringMatching(/EPSG:5070/) });
    const badOrigin = await route(req(), fakeIO({ ...gridJson, origin: ['0', 0] }));
    expect(badOrigin).toMatchObject({ ok: false, reason: expect.stringMatching(/origin/) });
    const swapped = await route(req(), fakeIO({ ...gridJson, pd_bands: { 1: 'slope', 2: 'landcover' } }));
    expect(swapped).toMatchObject({ ok: false, reason: expect.stringMatching(/band order/) });
  });

  it('refuses a v1 cube and a grid.json without the v8 tables', async () => {
    // The pre-v2 synthetic cube's grid.json (no version, 8 / 2 bands).
    const v1 = {
      crs: 'EPSG:5070', origin: [-1000000.0, 2000000.0], cell: 250.0, cols: 90, rows: 60, super: 64, block: 32,
      pd_bands: { 1: 'landcover', 2: 'slope', 3: 'protect', 4: 'agency', 5: 'wildfire', 6: 'whpclass', 7: 'flags', 8: 'state' },
      osm_bands: { 1: 'flags', 2: 'maxkv' },
      super_tiles_present: [[0, 0], [1, 0]],
    };
    const old = await route(req(), fakeIO(v1));
    expect(old).toMatchObject({ ok: false, reason: 'grid.json is a v1 routing cube (no "version": 8; this reader needs band spec v8): rebuild the cube (make route-cube)' });
    expect(readGridJson({ ...v1, version: 1 })).toMatch(/version is 1, this reader needs version 8: rebuild the cube/);
    // A v4 cube (13 pd bands, no wetland) is refused by version, before any band is read.
    expect(readGridJson({ ...gridJson, version: 4 })).toMatch(/version is 4, this reader needs version 8: rebuild the cube/);
    // The previous spec (v7: 17 pd bands, no aviation / nfhl), whatever its band lists say.
    const v7 = { ...gridJson, version: gridJson.version - 1 };
    expect(gridJson.version).toBe(8);
    expect(readGridJson(v7)).toBe('grid.json version is 7, this reader needs version 8: rebuild the cube (make route-cube)');
    expect(await route(req(), fakeIO(v7))).toMatchObject({ ok: false, reason: expect.stringMatching(/version is 7.*version 8/) });
    // v8 with the v7 band list (no aviation, nfhl): refused by band order.
    const pd7 = Object.fromEntries(Object.entries(gridJson.pd_bands).filter(([k]) => +k <= 17));
    expect(readGridJson({ ...gridJson, pd_bands: pd7 })).toMatch(/band order differs/);
    // v8 with the v1 band lists: still refused.
    expect(readGridJson({ ...gridJson, pd_bands: v1.pd_bands, osm_bands: v1.osm_bands })).toMatch(/band order differs/);
    const without = (k: string) => Object.fromEntries(Object.entries(gridJson).filter(([key]) => key !== k));
    expect(await route(req(), fakeIO(without('isoreg')))).toMatchObject({ ok: false, reason: expect.stringMatching(/no isoreg code table.*make route-cube/) });
    expect(readGridJson({ ...gridJson, isoreg: { codes: {} } })).toMatch(/no isoreg code table/);
    expect(readGridJson({ ...gridJson, isoreg: { codes: { 0: 'TEPPC' } } })).toMatch(/isoreg.codes has a bad entry/);
    expect(readGridJson(without('landval'))).toMatch(/no landval constants/);
    expect(readGridJson({ ...gridJson, landval: { base: 100, steps: 0, max_code: 255 } })).toMatch(/no landval constants/);
    expect(readGridJson(without('osm_bands'))).toMatch(/no pd_bands \/ osm_bands/);
    const ok = readGridJson(gridJson);
    if (typeof ok === 'string') throw new Error(ok);
    expect(ok.isoreg.get(1)).toBe('TEPPC');
    expect(ok.landval).toEqual({ base: 100, steps: 16, max_code: 255 });
  });

  it('band lists match scripts/route_grid.py (via the generated grid.json)', () => {
    expect(Object.values(gridJson.pd_bands)).toEqual(PD_BANDS);
    expect(Object.values(gridJson.osm_bands)).toEqual(OSM_BANDS.map((n) => n.replace(/^osm_/, '')));
    expect(PD_BANDS).toHaveLength(19);
    expect(PD_BANDS.slice(17)).toEqual(['aviation', 'nfhl']);
    expect(OSM_BANDS).toHaveLength(3);
  });

  it('readBands allocates and decodes only the wanted bands (+ state)', async () => {
    const box = { c0: 30, r0: 10, w: 50, h: 40 };  // spans both super-tiles
    const present = new Set(['0_0', '1_0']);
    const all = await readBands(grid, new Set<BandName>([...PD_BANDS, ...OSM_BANDS]), present, fakeIO(), box);
    expect(Object.keys(all).sort()).toEqual([...PD_BANDS, ...OSM_BANDS].sort());
    expect(all.landcover!.every((v) => v === 71)).toBe(true);
    expect(all.isoreg!.every((v) => v === 1)).toBe(true);
    expect(all.adj!.every((v) => v === 16)).toBe(true);
    expect(all.state![20 * 50 + 10]).toBe(0);   // the wall, column 40
    expect(all.state![50 * 0 + 9]).toBe(8);
    const io = fakeIO();
    const some = await readBands(grid, new Set<BandName>(['landcover']), present, io, box);
    expect(Object.keys(some).sort()).toEqual(['landcover', 'state']);
    expect(some.landcover).toEqual(all.landcover);
    expect(some.state).toEqual(all.state);
    expect(io.calls.some((u) => u.includes('osm_'))).toBe(false);  // no OSM band wanted: no OSM file read
  });

  it('reads the v3 bits the fixture sets (row 5 flags / flags2, row 7 adj), each in its own cell', async () => {
    const box = { c0: 70, r0: 0, w: 20, h: 10 };
    const out = await readBands(grid, new Set<BandName>(['flags', 'flags2', 'adj']), new Set(['0_0', '1_0']), fakeIO(), box);
    const at = (b: BandName, col: number, row: number) => out[b]![row * box.w + col - box.c0];
    expect(at('flags', 75, 5)).toBe(1 << 7);
    expect([76, 77, 78, 79, 80].map((c) => at('flags2', c, 5))).toEqual([4, 8, 16, 64, 128]);
    expect(at('flags2', 81, 5)).toBe(0);
    expect(at('adj', 75, 7)).toBe(16 + 1 + (2 << 5));
    expect(at('adj', 76, 7)).toBe(16 + (3 << 5));
    expect(at('adj', 77, 7)).toBe(16);
  });

  it('reads the wetland band (b14): 1 = none, 0 under the wall, fixture cells 1 + round(100 share)', async () => {
    const box = { c0: 30, r0: 0, w: 60, h: 10 };
    const out = await readBands(grid, new Set<BandName>(['wetland']), new Set(['0_0', '1_0']), fakeIO(), box);
    const at = (col: number, row: number) => out.wetland![row * box.w + col - box.c0];
    expect([85, 86, 87, 88, 89].map((c) => at(c, 5))).toEqual([1, 11, 41, 81, 1]);
    expect(at(40, 5)).toBe(0);
    expect(at(30, 0)).toBe(1);
  });

  it('reads the aviation (b18) and nfhl (b19) bands: 1 = evaluated none, 0 under the wall, fixture cells by name', async () => {
    const box = { c0: 30, r0: 0, w: 60, h: 10 };
    const out = await readBands(grid, new Set<BandName>(['aviation', 'nfhl']), new Set(['0_0', '1_0']), fakeIO(), box);
    const at = (b: BandName, col: number, row: number) => out[b]![row * box.w + col - box.c0];
    expect([74, 75, 76, 77, 78, 79, 80].map((c) => at('aviation', c, 9))).toEqual([1, 2, 3, 4, 5, 6, 1]);
    expect([81, 82, 83, 84].map((c) => at('nfhl', c, 9))).toEqual([1, 2, 3, 1]);
    expect([82, 83].map((c) => at('aviation', c, 9))).toEqual([1, 1]);
    expect([75, 79].map((c) => at('nfhl', c, 9))).toEqual([1, 1]);
    expect([at('aviation', 40, 9), at('nfhl', 40, 9)]).toEqual([0, 0]);
    expect([at('aviation', 30, 0), at('nfhl', 30, 0)]).toEqual([1, 1]);
  });

  it('reads the bldg band (b13): 1 = no home, 0 under the wall, fixture cells 1 + n', async () => {
    const box = { c0: 30, r0: 0, w: 60, h: 10 };
    const out = await readBands(grid, new Set<BandName>(['bldg']), new Set(['0_0', '1_0']), fakeIO(), box);
    const at = (col: number, row: number) => out.bldg![row * box.w + col - box.c0];
    expect([81, 82, 83, 84, 85].map((c) => at(c, 5))).toEqual([1, 2, 5, 12, 1]);
    expect(at(40, 5)).toBe(0);
    expect(at(30, 0)).toBe(1);
  });

  it('keeps ≤ 16 tile reads in flight across every window of both files', async () => {
    // Ten super-tiles in a row, every one served by the cube's 64 × 60 files: 20 windows, 80 tiles.
    const many = { ...gridJson, cols: 64 * 10, super_tiles_present: undefined };
    const meta = readGridJson(many);
    if (typeof meta === 'string') throw new Error(meta);
    let live = 0, peak = 0, reads = 0;
    const io: RouteIO = {
      baseUrl: 'mem://many/',
      async fetchJson() { return many; },
      async fetchRange(url, start, end) {
        reads++;
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 2));
        live--;
        const file = url.slice('mem://many/'.length).replace(/_\d+_0\.tif$/, '_0_0.tif');
        const buf = readFileSync(new URL(file, dir));
        return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
      },
    };
    const out = await readBands(meta.grid, new Set<BandName>([...PD_BANDS, ...OSM_BANDS]), meta.present, io, { c0: 0, r0: 0, w: 640, h: 60 });
    expect(meta.present.size).toBe(10);
    expect(reads).toBeGreaterThanOrEqual(20 + 80);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBe(16);  // the reads do overlap: one limiter, not one per window
    expect(out.landcover!.every((v) => v === 71)).toBe(true);
    expect(out.adj!.every((v) => v === 16)).toBe(true);
    for (let sc = 0; sc < 10; sc++) expect(out.state![0 * 640 + sc * 64 + 40]).toBe(0);
  });

  it('claims proven only when no path through the outside is cheaper (full-grid check)', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const W = 48, H = 36, n = W * H, cellM = 250;
    let proven = 0, open = 0, overclaims = 0;
    for (let trial = 0; trial < 150; trial++) {
      // Inside a capsule round A–B: weights 1–4; outside: weights from `floor` up (the true minW).
      const floor = [0.2, 1, 1.5][trial % 3], B = 4 + (trial % 5);
      const a = [6 + Math.floor(rnd() * 6), 8 + Math.floor(rnd() * 20)], b = [36 + Math.floor(rnd() * 6), 8 + Math.floor(rnd() * 20)];
      const mask = new Uint8Array(n), cost = new Float32Array(n), barrier = new Uint8Array(n);
      const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const t = Math.max(0, Math.min(1, ((c - a[0]) * dx + (r - a[1]) * dy) / dd));
        const inside = (c - a[0] - t * dx) ** 2 + (r - a[1] - t * dy) ** 2 <= B * B;
        mask[r * W + c] = inside ? 1 : 0;
        cost[r * W + c] = inside ? 1 + rnd() * 0.5 : floor + rnd() * 0.3;
        barrier[r * W + c] = rnd() < 0.05 ? 1 : 0;
      }
      const start = a[1] * W + a[0], goal = b[1] * W + b[0];
      const g = { width: W, height: H, cost, barrier, cellM };
      const sol = solve({ ...g, mask, start, goal });
      if (!sol.ok) continue;
      const C = sol.cost;
      const edge: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const r = Math.floor(i / W), c = i % W;
        if (MOVE_DR.some((dr, k) => { const rr = r + dr, cc = c + MOVE_DC[k]; return rr >= 0 && rr < H && cc >= 0 && cc < W && !mask[rr * W + cc]; })) edge.push(i);
      }
      let minW = Infinity;
      for (const v of cost) minW = Math.min(minW, v);
      const claim = provenOptimal({ ...g, mask, maxCells: n }, start, goal, C, sol.dist, sol.scratch, edge, minW);
      // A caller's dB (a backward search to 1.2·C, exact below that) gives the identical answer.
      const back = distances({ ...g, mask, maxCells: n, start: goal }, 1.2 * C, [start, goal]);
      const sol3 = solve({ ...g, mask, start, goal });
      if ('error' in back) throw new Error(back.error);
      if (!sol3.ok) throw new Error(sol3.error);
      expect(provenOptimal({ ...g, mask, maxCells: n }, start, goal, C, sol3.dist, sol3.scratch, edge, minW, back.dist)).toBe(claim);
      const full = solve({ ...g, start, goal });
      if (!full.ok) throw new Error(full.error);
      if (claim) { proven++; expect(full.cost).toBeGreaterThanOrEqual(C * (1 - 1e-12)); } else open++;
      // The same check with minW overstated 3× does claim falsely here: the test can see an unsound bound.
      const sol2 = solve({ ...g, mask, start, goal });
      if (sol2.ok && provenOptimal({ ...g, mask, maxCells: n }, start, goal, C, sol2.dist, sol2.scratch, edge, 3 * minW) && full.cost < C * (1 - 1e-9)) overclaims++;
    }
    expect(overclaims).toBeGreaterThan(0);
    // Both outcomes occur, so the check is neither always-true nor always-false here.
    expect(proven).toBeGreaterThan(5);
    expect(open).toBeGreaterThan(5);
  });

  it('edgeCells: the 16-move mask edge from row runs, for bboxes inside and against the grid sides', () => {
    let seed = 2024;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const ri = (n: number) => Math.floor(rnd() * n);
    // edgeCells tests rows ±2 over columns c ± 1 (a superset of the knight cells): `wide` is that set.
    const wide: [number, number][] = [];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      if ((dr || dc) && (Math.abs(dr) === 1 || Math.abs(dc) <= 1) && !(dr === 0 && Math.abs(dc) === 2)) wide.push([dr, dc]);
    }
    const moves = MOVE_DR.map((dr, k) => [dr, MOVE_DC[k]] as [number, number]);
    let clipped = 0, extra = 0;
    for (let trial = 0; trial < 400; trial++) {
      const grid = { cols: 30 + ri(20), rows: 30 + ri(20) };
      const w = 1 + ri(grid.cols), h = 1 + ri(grid.rows);
      const c0 = [0, grid.cols - w, ri(grid.cols - w + 1)][trial % 3], r0 = [ri(grid.rows - h + 1), 0, grid.rows - h][trial % 3];
      if (c0 === 0 || c0 + w === grid.cols || r0 === 0 || r0 + h === grid.rows) clipped++;
      const lo = new Int32Array(h).fill(w), hi = new Int32Array(h).fill(-1), mask = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) {
        if (rnd() < 0.1) continue;
        const a = ri(w), b = rnd() < 0.3 ? (rnd() < 0.5 ? 0 : w - 1) : ri(w);
        lo[r] = Math.min(a, b); hi[r] = Math.max(a, b);
        for (let c = lo[r]; c <= hi[r]; c++) mask[r * w + c] = 1;
      }
      // Brute force: in-mask cells with a neighbour inside the grid that is outside the mask or bbox.
      const brute = (nb: [number, number][]) => {
        const out: number[] = [];
        for (let i = 0; i < w * h; i++) {
          if (!mask[i]) continue;
          const r = Math.floor(i / w), c = i % w;
          if (nb.some(([dr, dc]) => {
            const gr = r0 + r + dr, gc = c0 + c + dc;
            if (gr < 0 || gr >= grid.rows || gc < 0 || gc >= grid.cols) return false;
            const rr = r + dr, cc = c + dc;
            return rr < 0 || rr >= h || cc < 0 || cc >= w || !mask[rr * w + cc];
          })) out.push(i);
        }
        return out;
      };
      const got = edgeCells(grid, { c0, r0, w, h }, lo, hi).sort((x, y) => x - y);
      const exact = new Set(brute(moves));
      for (const i of exact) expect(got).toContain(i);  // never misses a 16-move edge cell
      expect(got).toEqual(brute(wide));                 // and is exactly the documented superset
      extra += got.length - exact.size;
    }
    expect(clipped).toBeGreaterThan(200);
    expect(extra).toBeGreaterThan(0);
  });

  describe('profile', () => {
    const noTimings = ({ timingsMs: _t, ...rest }: RouteResult) => rest;
    /** fakeIO with a fresh base URL (cold openTiff cache) that logs every range read as [file, bytes]. */
    const counted = (base: string) => {
      const io = fakeIO(gridJson, dir, base), reads: [string, number][] = [];
      const fetchRange = io.fetchRange.bind(io);
      io.fetchRange = async (url, start, end) => { const b = await fetchRange(url, start, end); reads.push([url.slice(base.length), b.length]); return b; };
      return { io, reads };
    };

    it('returns runs and samples along the path, the last mi1 = lengthMi', async () => {
      const out = await route(req({ profile: true }), fakeIO());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const { profile, lengthMi } = out.result;
      expect(profile).toBeTruthy();
      if (!profile) return;
      expect(profile.runs.length).toBeGreaterThan(0);
      expect(profile.runs[profile.runs.length - 1].mi1).toBe(lengthMi);
      expect(profile.runs[0].mi0).toBe(0);
      expect(profile.samples.length).toBeGreaterThan(out.result.cells.pis);
      expect(profile.samples.every((x, i) => i === 0 || x.mi > profile.samples[i - 1].mi)).toBe(true);
      // the fixture is uniform grassland, agency 1, no flags, adj class 0
      expect(profile.runs.every((r) => r.landcover === 71 && r.agency === 1 && r.gap === null && r.follows === 0 && !r.tribal)).toBe(true);
      expect(profile.crossings.points).toEqual([]);
      expect(profile.crossings.miles.byAgency[1]).toBeCloseTo(lengthMi, 9);
    });

    it('leaves every existing output, the reads and the byte budget unchanged (tm-default loads every profile band)', async () => {
      const plain = await route(req(), fakeIO());
      const off = await route(req({ profile: false }), fakeIO());
      expect(plain.ok && off.ok).toBe(true);
      if (!plain.ok || !off.ok) return;
      expect(noTimings(off.result)).toEqual(noTimings(plain.result));
      expect('profile' in off.result).toBe(false);
      const a = counted('mem://prof-a/'), b = counted('mem://prof-b/');
      const p0 = await route(req(), a.io), p1 = await route(req({ profile: true }), b.io);
      expect(p0.ok && p1.ok).toBe(true);
      if (!p0.ok || !p1.ok) return;
      const { profile, ...rest } = noTimings(p1.result);
      expect(profile).toBeTruthy();
      expect(rest).toEqual(noTimings(p0.result));
      expect(b.reads).toEqual(a.reads);
      // the cap's share for the similar-cost areas / alternatives is the same with the profile on
      const capOff = await route(req({ surface: true, alternatives: 2, cap: 5400 }), fakeIO());
      const capOn = await route(req({ surface: true, alternatives: 2, cap: 5400, profile: true }), fakeIO());
      expect(capOn.ok && capOff.ok).toBe(true);
      if (!capOn.ok || !capOff.ok) return;
      expect(capOn.result.surface).toEqual({ skipped: expect.stringMatching(/^cap: the bbox has 5400 cells; with 39 B\/cell/) });
      expect(capOn.result.surface).toEqual(capOff.result.surface);
      expect(capOn.result.altSkipped).toBe(capOff.result.altSkipped);
    });

    it('reads the bands the preset does not load only for the blocks the path crosses (pnas-wu2023)', async () => {
      const a = counted('mem://prof-c/'), b = counted('mem://prof-d/');
      const p0 = await route(req({ preset: 'pnas-wu2023' }), a.io);
      const p1 = await route(req({ preset: 'pnas-wu2023', profile: true }), b.io);
      expect(p0.ok && p1.ok).toBe(true);
      if (!p0.ok || !p1.ok) return;
      expect(p1.result.path).toEqual(p0.result.path);
      expect(p1.result.cells).toEqual(p0.result.cells);
      const extra = b.reads.slice(a.reads.length);
      expect(b.reads.slice(0, a.reads.length)).toEqual(a.reads);   // the solve's reads come first, unchanged
      // blocks (32 cells) the PI line crosses
      const blocks = new Set<string>();
      const xy = p1.result.path.coordinates.map(([lng, lat]) => {
        const [x, y] = albersForward(lng, lat);
        return [(x - grid.x0) / grid.cell, (grid.y0 - y) / grid.cell];
      });
      for (let i = 1; i < xy.length; i++) {
        traverse(xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1], (c, r, len) => { if (len > 0) blocks.add(`${Math.floor(c / 32)}_${Math.floor(r / 32)}`); });
      }
      // pd (agency, desig, flags2) and osm (adj): one tile read per file and block crossed
      expect(extra.length).toBeGreaterThan(0);
      expect(extra.length).toBeLessThanOrEqual(2 * blocks.size);
      expect(extra.every(([f]) => f === 'pd_0_0.tif' || f === 'osm_0_0.tif')).toBe(true);   // super-tile 1_0 is not crossed
      let maxTile = 0;
      for (const f of ['pd_0_0.tif', 'osm_0_0.tif']) {
        const buf = readFileSync(new URL(f, dir));
        const ti = await openTiff(async (s, e) => new Uint8Array(buf.subarray(s, Math.min(e, buf.length))));
        maxTile = Math.max(maxTile, ...ti.tileByteCounts);
      }
      expect(extra.reduce((t, [, n]) => t + n, 0)).toBeLessThanOrEqual(extra.length * maxTile);
      const prof = p1.result.profile!;
      expect(prof.runs.every((r) => r.agency === 1 && r.follows === 0)).toBe(true);   // read sparsely, not nodata
      expect(prof.runs[prof.runs.length - 1].mi1).toBe(p1.result.lengthMi);
    });

    it('gives profile null for the straight-line preset, and alternatives their crossings and share with the route', async () => {
      const straight = await route(req({ preset: 'straight-line-quick', profile: true }), fakeIO());
      expect(straight).toMatchObject({ ok: true, result: { profile: null } });
      expect(await route(req({ profile: 1 as unknown as boolean }), fakeIO())).toMatchObject({ ok: false, reason: 'profile must be true or false' });
      const wallDir = new URL('./fixtures/cube-wall/', import.meta.url);
      const wallJson = JSON.parse(readFileSync(new URL('grid.json', wallDir), 'utf8'));
      const out = await route(req({ from: at(20, 29), to: at(60, 29), alternatives: 3 }), fakeIO(wallJson, wallDir, 'mem://cube-wall/'));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.profile).toBeUndefined();
      expect(out.result.alternatives!.length).toBeGreaterThan(0);
      for (const alt of out.result.alternatives!) {
        expect(alt.crossings).toBeDefined();
        expect(alt.crossings!.miles.byAgency[1]).toBeCloseTo(alt.lengthMi, 9);
        expect(alt.sharedWithRoute).toBeGreaterThanOrEqual(0);
        expect(alt.sharedWithRoute).toBeLessThanOrEqual(alt.shared + 1e-12);
      }
    });
  });
});

describe('uploaded layers', () => {
  // fixtures/cube-wall: wall in column 40 open at rows 12–14 (north, the cheaper gap) and 45–47.
  const wallDir = new URL('./fixtures/cube-wall/', import.meta.url);
  const wallJson = JSON.parse(readFileSync(new URL('grid.json', wallDir), 'utf8'));
  const wio = (uploads?: Map<string, UploadLayer>): RouteIO => ({ ...fakeIO(wallJson, wallDir, 'mem://cube-wall/'), ...(uploads ? { uploads } : {}) });
  /** A rectangle in cell units (u = col, v = row), as [lng, lat] MultiPolygon coordinates. */
  const rect = (u0: number, u1: number, v0: number, v1: number) => [[[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]
    .map(([u, v]) => albersInverse(grid.x0 + u * grid.cell, grid.y0 - v * grid.cell))]];
  const layerOf = async (g: unknown, on = grid) => { const r = await uploadLayer(g, on); if (!r.ok) throw new Error(r.reason); return r.result; };
  const ends = { from: at(20, 29), to: at(60, 29) };
  const block = (hash: string, o: Record<string, unknown> = {}): PresetPatch =>
    ({ add_rows: [{ layer: hash, label: 'Block north gap', route_w: 1, cost_x: 1, barrier: true, ...o }] });
  // centres of cols 38–42, rows 10–16 (the north gap) are inside; nothing else.
  const north = () => layerOf(rect(38.2, 42.8, 10.2, 16.8));

  it('an upload barrier moves the route to the other gap, at the cost of a hand-built upload band (full-grid reference)', async () => {
    const layer = await north();
    const patch = block(layer.hash);
    const out = await route(req({ ...ends, presetPatch: patch, uploads: [layer.hash] }), wio(new Map([[layer.hash, layer]])));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = rowsInColumn(out.result.path.coordinates, 40);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((y) => y >= 45 && y <= 47)).toBe(true);
    expect(out.result.optimality).toBe('proven');
    // reference: the patched preset over the whole grid through buildSurfaces + solve, upload band written by hand
    const preset = validatePresetPatch(routePreset('tm-default')!, patch);
    if (!preset.ok) throw new Error(preset.reason);
    const meta = readGridJson(wallJson);
    if (typeof meta === 'string') throw new Error(meta);
    const W = grid.cols, H = grid.rows;
    const bands = await readBands(grid, presetBands(preset.result), meta.present, wio(), { c0: 0, r0: 0, w: W, h: H });
    const upl = new Uint8Array(W * H);
    for (let r = 10; r <= 16; r++) for (let c = 38; c <= 42; c++) upl[r * W + c] = 1;
    const surf = buildSurfaces(preset.result, 'ac500', { ...bands, [uploadBand(layer.hash)]: upl }, W, H);
    const ref = solve({ width: W, height: H, cost: surf.route, barrier: surf.barrier, cellM: grid.cell, start: 29 * W + 20, goal: 29 * W + 60 });
    if (!ref.ok) throw new Error(ref.error);
    expect(out.result.routeCost!.raw).toBeCloseTo(ref.cost, 6);
    const plain = await route(req(ends), wio());
    expect(plain.ok && plain.result.routeCost!.raw).toBeLessThan(ref.cost * 0.999);
  });

  it('refuses a request naming an upload the worker does not hold, never solving without it', async () => {
    const layer = await north(), h = layer.hash;
    expect(await route(req({ ...ends, uploads: [h] }), wio())).toEqual({ ok: false, reason: `upload layer ${h} not loaded` });
    expect(await route(req({ ...ends, presetPatch: block(h) }), wio(new Map()))).toEqual({ ok: false, reason: `upload layer ${h} not loaded` });
    expect(await route(req({ ...ends, uploads: ['x'] }), wio())).toMatchObject({ ok: false, reason: /uploads must be/ });
    const other = await layerOf(rect(38.2, 42.8, 10.2, 16.8));
    expect(other.hash).toBe(h);
    const g250 = await layerOf(rect(38.2, 42.8, 10.2, 16.8), GRID_250);
    expect(await route(req({ ...ends, presetPatch: block(h), uploads: [h] }), wio(new Map([[h, g250]])))).toEqual({ ok: false, reason: `upload layer ${h} is on another grid than the cube's` });
  });

  it('the cause overlay names the upload; the inspector reads the cell from the window or the layer and names the row', async () => {
    const layer = await layerOf(rect(29.2, 33.8, 24.2, 33.8)), h = layer.hash;
    const uploads = new Map([[h, layer]]);
    const patch: PresetPatch = { add_rows: [{ layer: h, label: 'My corridor', route_w: 500, cost_x: 2 }] };
    const windows = createWindowCache();
    const out = await route(req({ ...ends, presetPatch: patch, uploads: [h], weightImage: true, weightMode: 'cause' }), wio(uploads), windows);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const img = out.result.weightImage!;
    expect('cause' in img && img.cause!.present.find((x) => x.key === 'upload')).toMatchObject({ colour: CAUSE_COLOURS.upload.colour, labelKey: 'route.cat.upload' });
    expect(rowsInColumn(out.result.path.coordinates, 31).every((y) => y < 24 || y > 33)).toBe(true);
    expect(windows.held!.bands[`upl_${h}`]).toBeDefined();
    for (const w of [undefined, windows]) {
      const cache = createInspectCache();
      const ins = await inspect({ lngLat: at(31, 29), preset: 'tm-default', lineType: 'ac500', presetPatch: patch, uploads: [h] }, wio(uploads), cache, w);
      expect(ins.ok).toBe(true);
      if (!ins.ok) return;
      expect(ins.result.values[uploadBand(h)]).toBe(1);
      const row = ins.result.explain.rows.find((x) => x.note === 'My corridor');
      expect(row).toMatchObject({ label: { k: 'route.cat.upload' }, r: 500, c: 2, winsRoute: true });
      expect(ins.result.explain.head).toEqual({ k: 'route.insp.head.row', p: { label: { k: 'route.insp.labelNote', p: { label: { k: 'route.cat.upload' }, note: 'My corridor' } }, r: '500' } });
      const outside = await inspect({ lngLat: at(20, 29), preset: 'tm-default', lineType: 'ac500', presetPatch: patch }, wio(uploads), cache, w);
      expect(outside.ok && outside.result.values[uploadBand(h)]).toBe(0);
    }
    expect(await inspect({ lngLat: at(31, 29), preset: 'tm-default', lineType: 'ac500', presetPatch: patch }, wio(), createInspectCache()))
      .toEqual({ ok: false, reason: `upload layer ${h} not loaded` });
  });

  it('repaint and repaintRows: same uploads repaint; a session-only upload change is another route; an unloaded hash refuses', async () => {
    const layer = await north(), h = layer.hash;
    const second = await layerOf(rect(50.2, 52.8, 20.2, 22.8));
    const uploads = new Map([[h, layer], [second.hash, second]]);
    const patch = block(h, { barrier: false, route_w: 50 });
    const windows = createWindowCache();
    expect((await route(req({ ...ends, presetPatch: patch, uploads: [h], weightImage: true }), wio(uploads), windows)).ok).toBe(true);
    const rq = { ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route' as const };
    expect(repaint({ ...rq, presetPatch: patch, uploads: [h] }, windows, uploads).ok).toBe(true);
    expect(repaint({ ...rq, presetPatch: block(h, { barrier: false, route_w: 9 }) }, windows, uploads).ok).toBe(true);
    expect(repaint(rq, windows, uploads)).toEqual({ ok: false, reason: 'window is for another route' });
    const two: PresetPatch = { add_rows: [...patch.add_rows!, { layer: second.hash, label: 'b', route_w: 2, cost_x: 1 }] };
    expect(repaint({ ...rq, presetPatch: two }, windows, uploads)).toEqual({ ok: false, reason: 'window is for another route' });
    expect(repaint({ ...rq, presetPatch: patch }, windows, new Map())).toEqual({ ok: false, reason: `upload layer ${h} not loaded` });
    const n = routePreset('tm-default')!.rows.length;
    const pick = { row: n, band: uploadBand(h), note: 'Block north gap', slot: 0 };
    const rows = repaintRows({ ...ends, preset: 'tm-default', lineType: 'ac500', rows: [pick], presetPatch: patch }, windows, uploads);
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.result.image.rgba.some((x, i) => i % 4 === 3 && x > 0)).toBe(true);
    expect(repaintRows({ ...ends, preset: 'tm-default', lineType: 'ac500', rows: [] }, windows, uploads)).toEqual({ ok: false, reason: 'window is for another route' });
    expect(repaintRows({ ...ends, preset: 'tm-default', lineType: 'ac500', rows: [], presetPatch: patch }, windows, new Map()))
      .toEqual({ ok: false, reason: `upload layer ${h} not loaded` });
  });

  describe('by memory, not count', () => {
    const entry = (hash: string, o: Record<string, unknown> = {}) => ({ layer: hash, label: `L ${hash.slice(0, 4)}`, route_w: 1.5, cost_x: 1, ...o });
    /** n distinct small layers on the cube's grid (each a different 1.6 × 1.6 cell block). */
    const many = async (n: number) => {
      const out: UploadLayer[] = [];
      for (let i = 0; i < n; i++) out.push(await layerOf(rect(2.2 + 4 * i, 3.8 + 4 * i, 40.2, 41.8)));
      return out;
    };
    const counting = (uploads: Map<string, UploadLayer>, uploadBudget?: number) => {
      const io = wio(uploads), calls = { n: 0 }, inner = io.fetchRange.bind(io);
      io.fetchRange = async (u, a, b) => { calls.n++; return inner(u, a, b); };
      return { io: { ...io, ...(uploadBudget === undefined ? {} : { uploadBudget }) } as RouteIO, calls };
    };

    it('a 12-layer method solves; its rows are upl_<hash> in add_rows order and presetBands lists all 12', async () => {
      const layers = [...await many(11), await north()];       // the 12th, last layer blocks the north gap
      expect(new Set(layers.map((l) => l.hash)).size).toBe(12);
      const patch: PresetPatch = { add_rows: layers.map((l, i) => entry(l.hash, i === 11 ? { barrier: true } : {})) };
      const merged = validatePresetPatch(routePreset('tm-default')!, patch);
      if (!merged.ok) throw new Error(merged.reason);
      expect(merged.result.rows.slice(-12).map((r) => r.band)).toEqual(layers.map((l) => `upl_${l.hash}`));
      const bands = presetBands(merged.result);
      for (const l of layers) expect(bands.has(`upl_${l.hash}`)).toBe(true);
      const windows = createWindowCache();
      const out = await route(req({ ...ends, presetPatch: patch, uploads: layers.map((l) => l.hash), weightImage: true }), wio(new Map(layers.map((l) => [l.hash, l]))), windows);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      for (const l of layers) expect(windows.held!.bands[`upl_${l.hash}`], l.hash).toBeDefined();
      const rows = rowsInColumn(out.result.path.coordinates, 40);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((y) => y >= 45 && y <= 47)).toBe(true);
    });

    it('over the upload budget the attempt is refused before any read, with the numbers; a retry that would not fit keeps the first result', async () => {
      const layers = await many(3), uploads = new Map(layers.map((l) => [l.hash, l]));
      const patch: PresetPatch = { add_rows: layers.map((l) => entry(l.hash)) };
      const rq = req({ ...ends, presetPatch: patch, uploads: layers.map((l) => l.hash) });
      const refused = counting(uploads, 10_000);
      const out = await route(rq, refused.io);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason.startsWith(UPLOAD_BUDGET_MSG)).toBe(true);
      expect(out.reason).toMatch(/: 3 layers × (\d+) cells = [\d.]+ MiB, at most 0\.01 MiB$/);
      expect(parseUploadBudget(out.reason)).toMatchObject({ n: '3' });
      expect(refused.calls.n).toBe(0);
      const cells = Number(/× (\d+) cells/.exec(out.reason)![1]);
      // exactly the first attempt's size: it fits, a 2× retry (a larger bbox) would not
      expect((await route(rq, counting(uploads, 3 * cells).io)).ok).toBe(true);
    });

    it('a retry that would not fit the upload budget keeps the first, unproven result and reads nothing for a second attempt', async () => {
      // cube fixture, buffer 35 cells: the first bbox is 90 × 56 = 5040 cells and its path runs along the mask edge (not proven);
      // the 2× retry is 90 × 60 = 5400 cells.
      const layers = await many(3), uploads = new Map(layers.map((l) => [l.hash, l]));
      const patch: PresetPatch = { add_rows: layers.map((l) => entry(l.hash)) };
      const rq = req({ bufferFactor: 0.35, cap: 1e6, presetPatch: patch, uploads: layers.map((l) => l.hash) });
      const io = (uploadBudget?: number) => ({ ...fakeIO(), uploads, ...(uploadBudget === undefined ? {} : { uploadBudget }) }) as RouteIO & { calls: string[] };
      const freeIO = io();
      const free = await route(rq, freeIO);
      expect(free).toMatchObject({ ok: true, result: { maskLimited: false, bufferM: 2 * 0.35 * 25_000 } });
      if (free.ok) expect(free.result.timingsMs.attempts).toHaveLength(2);
      const tight = io(3 * 5040);                    // the first attempt fits exactly; the retry (3 × 5400) does not
      const kept = await route(rq, tight);
      expect(tight.calls.length).toBeGreaterThan(0);
      expect(tight.calls.length).toBeLessThan(freeIO.calls.length);
      expect(kept).toMatchObject({ ok: true, result: { maskLimited: true, optimality: 'within-mask', bufferM: 0.35 * 25_000 } });
      if (kept.ok) expect(kept.result.timingsMs.attempts).toHaveLength(1);
    });

    it('a saved method holding hashes only solves; removing its first entry leaves the second band key unchanged; the old window is not reused', async () => {
      const [a, b] = await many(2);
      const stored = JSON.parse(`{"v":1,"items":[{"id":"u","name":"Two","base":"tm-default","patch":{"add_rows":[
        {"layer":"${a.hash}","label":"A","route_w":2,"cost_x":1},{"layer":"${b.hash}","label":"B","route_w":3,"cost_x":1,"barrier":true}]},"savedAt":"2026-11-03"}]}`);
      const saved = stored.items[0].patch as PresetPatch;
      const two = validatePresetPatch(routePreset('tm-default')!, saved);
      const one = validatePresetPatch(routePreset('tm-default')!, mergePatch(saved, { add_rows: [{ layer: a.hash, remove: true }] } as PresetPatch));
      if (!two.ok || !one.ok) throw new Error('patch refused');
      const bandsOf = (r: typeof two.result) => r.rows.slice(routePreset('tm-default')!.rows.length).map((x) => x.band);
      expect(bandsOf(two.result)).toEqual([`upl_${a.hash}`, `upl_${b.hash}`]);
      expect(bandsOf(one.result)).toEqual([`upl_${b.hash}`]);
      const uploads = new Map([[a.hash, a], [b.hash, b]]);
      const windows = createWindowCache();
      const out = await route(req({ ...ends, presetPatch: saved, uploads: [a.hash, b.hash], weightImage: true }), wio(uploads), windows);
      expect(out.ok).toBe(true);
      const rq = { ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route' as const };
      expect(repaint({ ...rq, presetPatch: saved, uploads: [a.hash, b.hash] }, windows, uploads).ok).toBe(true);
      expect(repaint({ ...rq, presetPatch: mergePatch(saved, { add_rows: [{ layer: a.hash, remove: true }] } as PresetPatch)! }, windows, uploads))
        .toEqual({ ok: false, reason: 'window is for another route' });
    });

    it('inspect over a held window finds a layer by its band key after the list changed, never by index', async () => {
      const far = await layerOf(rect(50.2, 52.8, 20.2, 22.8)), here = await layerOf(rect(29.2, 33.8, 24.2, 33.8));
      const uploads = new Map([[far.hash, far], [here.hash, here]]);
      const both: PresetPatch = { add_rows: [entry(far.hash), entry(here.hash)] };
      const windows = createWindowCache();
      expect((await route(req({ ...ends, presetPatch: both, uploads: [far.hash, here.hash], weightImage: true }), wio(uploads), windows)).ok).toBe(true);
      const only: PresetPatch = { add_rows: [entry(here.hash)] };
      const ins = await inspect({ lngLat: at(31, 29), preset: 'tm-default', lineType: 'ac500', presetPatch: only, uploads: [here.hash] }, wio(uploads), createInspectCache(), windows);
      expect(ins.ok && ins.result.values[uploadBand(here.hash)]).toBe(1);
      const away = await inspect({ lngLat: at(20, 29), preset: 'tm-default', lineType: 'ac500', presetPatch: only, uploads: [here.hash] }, wio(uploads), createInspectCache(), windows);
      expect(away.ok && away.result.values[uploadBand(here.hash)]).toBe(0);
    });
  });
});

describe('exactRouteCrossings', () => {
  // fixtures/make-report.py scene B lies inside the mini cube: a 345 kV line along row 38 (cols 0–39), a river
  // along row 38 (cols 41–89) and a motorway along row 45 (cols 0–89); the route (20,20) → (60,20) goes round the wall.
  const reportDir = new URL('./fixtures/report/', import.meta.url);
  function reportIO(missing: string[] = []): RouteIO {
    const base = fakeIO(gridJson, dir, 'mem://exact/');
    const file = (url: string) => {
      const name = url.slice('mem://report/'.length);
      if (missing.some((m) => name.startsWith(m))) throw new Error(`${name}: HTTP 404`);
      return readFileSync(new URL(name, reportDir));
    };
    return {
      ...base,
      reportUrl: 'mem://report/',
      async byteLength(url) { return file(url).length; },
      async fetchRange(url, start, end) {
        if (!url.startsWith('mem://report/')) return base.fetchRange(url, start, end);
        const buf = file(url);
        return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
      },
    };
  }
  async function solved() {
    const out = await route(req({ profile: true }), fakeIO(gridJson, dir, 'mem://exact-solve/'));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    const r = out.result;
    return { polylines: [r.path.coordinates.map(([lng, lat]) => albersForward(lng, lat))], lengthsMi: [r.lengthMi] };
  }

  it('counts scene B crossings exactly: line and river odd, road even ≥ 2; every kind exact', async () => {
    const out = await exactRouteCrossings(await solved(), reportIO());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { routes, exact, note } = out.result;
    expect(note).toBeUndefined();
    expect(new Set(exact)).toEqual(new Set(['river', 'road', 'rail', 'pipeline', 'line230', 'line100']));
    const c = routes[0].counts;
    expect(c.line230 % 2).toBe(1);
    expect(c.river % 2).toBe(1);
    expect(c.road % 2).toBe(0);
    expect(c.road).toBeGreaterThanOrEqual(2);
    expect(routes[0].points.some((p) => p.kind === 'river' && p.name === 'Cube Creek')).toBe(true);
  });

  it('a family whose files are missing is left out of exact, with a note', async () => {
    const out = await exactRouteCrossings(await solved(), reportIO(['transmission_']));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.exact).not.toContain('line230');
    expect(out.result.exact).not.toContain('line100');
    expect(out.result.exact).toContain('river');
    expect(out.result.status.line.ok).toBe(false);
    expect(out.result.note).toMatch(/^line: /);
  });

  it('refuses bad input and a missing report directory', async () => {
    const good = await solved(), io = reportIO();
    const bad: unknown[] = [
      null, { polylines: 'x', lengthsMi: [] }, { polylines: [], lengthsMi: [] },
      { polylines: good.polylines, lengthsMi: [] }, { polylines: [[[0, 0]]], lengthsMi: [1] },
      { polylines: [[[0, 0], [NaN, 1]]], lengthsMi: [1] }, { polylines: good.polylines, lengthsMi: [Infinity] },
      { polylines: Array(5).fill(good.polylines[0]), lengthsMi: Array(5).fill(1) },
      { polylines: [Array.from({ length: 20_001 }, (_, i) => [i, 0])], lengthsMi: [1] },
      { polylines: [[[0, 0], [1e100, 0]]], lengthsMi: [1] },
      { polylines: [Array.from({ length: 100 }, (_, i) => [i % 2 ? 9_000_000 : -9_000_000, 0])], lengthsMi: [1] },
    ];
    for (const b of bad) expect(await exactRouteCrossings(b as never, io)).toMatchObject({ ok: false });
    expect(await exactRouteCrossings(good, { ...io, reportUrl: undefined })).toEqual({ ok: false, reason: 'no report data' });
  });
});
