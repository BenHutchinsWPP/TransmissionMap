import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cellBytes, COST_BARRIER, HIGHLIGHT_PALETTE, NO_WINDOW_REASONS, readGridJson, repaintRows, rowClasses, type BandWindow, type GridMeta, type RepaintRowsRequest, type RowPick, COST_PALETTE, costClass, createWindowCache, repaint, route, solveEstimateBytes, WEIGHT_BARRIER, WEIGHT_PALETTE, type RouteIO, type RouteRequest } from './route.js';
import { surfaceImage, type SurfaceImage } from './surface-image.js';
import { presetBands } from './cost.js';
import { ROUTE_PRESETS, routePreset } from '../../src/registry/route-presets.js';
import { CONSTRAINT_PALETTE } from '../../src/colors/route-constraints.js';
import { CAUSE_COLOURS } from './cause-colours.js';
import { gridFromJson, lngLatOf } from './grid.js';

// fixtures/make-cube.py: 90 × 60 cells of grassland (tm-default row 7, ×1), state-0 wall down column 40.
const dir = new URL('./fixtures/cube/', import.meta.url);
const gridJson = JSON.parse(readFileSync(new URL('grid.json', dir), 'utf8'));
const grid = gridFromJson(gridJson);
const at = (col: number, row: number) => lngLatOf(grid, col, row);

function fakeIO(onRead?: () => void, base = 'mem://repaint/'): RouteIO {
  return {
    baseUrl: base,
    async fetchJson() { return gridJson; },
    async fetchRange(url, start, end) {
      onRead?.();
      const buf = readFileSync(new URL(url.slice(base.length), dir));
      return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
    },
  };
}
const req = (over: Partial<RouteRequest> = {}): RouteRequest =>
  ({ from: at(20, 20), to: at(60, 20), preset: 'tm-default', lineType: 'ac500', weightImage: true, ...over });
const ends = { from: at(20, 20), to: at(60, 20) };
const grass = (over: { route_w?: number; cost_x?: number }) => ({ rows: [{ row: 7, band: 'landcover', note: 'other NLCD', ...over }] });
const img = (o: { ok: boolean; result?: { image: SurfaceImage } }) => (o.ok ? o.result!.image : null)!;
const px = (m: SurfaceImage, o: number) => [...m.rgba.subarray(o, o + 4)];
const isColour = (p: number[], c: readonly number[]) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2];

describe('repaint', () => {
  it('repaints the solve\'s overlay from the held window, and a patched row only where it matches', async () => {
    const windows = createWindowCache();
    const out = await route(req(), fakeIO(), windows);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(windows.held).not.toBeNull();
    const same = repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route' }, windows);
    expect(same.ok).toBe(true);
    const solved = out.result.weightImage as SurfaceImage, base = img(same);
    expect(base.rgba).toEqual(solved.rgba);

    const raised = img(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route', presetPatch: grass({ route_w: 4 }) }, windows));
    expect([raised.width, raised.height, raised.coordinates]).toEqual([base.width, base.height, base.coordinates]);
    let changed = 0, weighted = 0;
    for (let o = 0; o < base.rgba.length; o += 4) {
      const b = px(base, o), r = px(raised, o);
      if (isColour(b, WEIGHT_PALETTE[WEIGHT_BARRIER]) || (b[3] === 0 && r[3] === 0)) { expect(r).toEqual(b); continue; }
      // the few fixture cells another row already weights (one per site/structure bit, plus the two NWI wetland cells of share ≥ 27 %)
      if (b[3] !== 0) { weighted++; continue; }
      // a grassland cell: ×1 (transparent) before, class 2 (×2–×5) after
      expect(b[3]).toBe(0);
      expect(r).toEqual([...WEIGHT_PALETTE[2]]);
      changed++;
    }
    expect(changed).toBeGreaterThan(1000);
    // 10 older cells, plus the four aviation 3–6 cells (×100 for ac500) and the nfhl 2 cell (×1.5); the floodplain cell is
    // exempt under nfhl 1 (a FEMA map in effect), so it no longer weighs
    expect(weighted).toBe(15);
  });

  it("mode 'cost' draws the cost multiplier, apart from the routing weight", async () => {
    const windows = createWindowCache();
    expect((await route(req({ weightMode: 'cost' }), fakeIO(), windows)).ok).toBe(true);
    const route2 = img(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route', presetPatch: grass({ route_w: 4 }) }, windows));
    const cost = repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'cost', presetPatch: grass({ route_w: 4 }) }, windows);
    expect(cost.ok && cost.result.mode).toBe('cost');
    expect(img(cost).rgba).not.toEqual(route2.rgba);
    // route_w leaves the cost × alone: the wall, and the four aviation 3–6 cells (cost ×1.2 for ac500)
    const colours = new Set<string>();
    for (let o = 0; o < img(cost).rgba.length; o += 4) if (img(cost).rgba[o + 3]) colours.add(px(img(cost), o).slice(0, 3).join());
    expect([...colours].sort()).toEqual([COST_PALETTE[COST_BARRIER].slice(0, 3).join(), COST_PALETTE[costClass(1.2)].slice(0, 3).join()].sort());
    const dear = img(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'cost', presetPatch: grass({ cost_x: 2 }) }, windows));
    expect(dear.rgba.some((_, o) => o % 4 === 0 && isColour(px(dear, o), COST_PALETTE[costClass(2)]))).toBe(true);
    expect([costClass(1), costClass(1.2), costClass(1.5), costClass(2), costClass(3), costClass(50)]).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("mode 'cause' colours cells by their winning row's category, with the palette and present list; barriers hatched", async () => {
    const windows = createWindowCache();
    expect((await route(req({ weightMode: 'cause' }), fakeIO(), windows)).ok).toBe(true);
    // the grassland row (tm-default row 7) wins the only weight: PHMA is a flags2 bit row
    const phma = { rows: [{ row: 7, band: 'landcover', note: 'other NLCD', route_w: 1 }] };
    const out = repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'cause', presetPatch: phma }, windows);
    expect(out.ok && out.result.mode).toBe('cause');
    const image = (out as { result: { image: import('./route.js').WeightImage } }).result.image;
    expect(image.mode).toBe('cause');
    expect(image.cause!.barrier).toBe(true);
    const present = image.cause!.present;
    expect(present.length).toBeGreaterThan(0);
    for (const x of present) expect(x).toMatchObject({ colour: CAUSE_COLOURS[x.key].colour, labelKey: CAUSE_COLOURS[x.key].labelKey });
    expect(present.map((x) => x.share)).toEqual([...present.map((x) => x.share)].sort((a, b) => b - a));
    // every drawn pixel is a present colour or the barrier colour; barrier pixels carry both opaque and hatched alpha
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join();
    const allowed = new Set([...present.map((x) => rgb(x.colour)), WEIGHT_PALETTE[WEIGHT_BARRIER].slice(0, 3).join()]);
    const alphas = new Set<number>();
    for (let o = 0; o < image.rgba.length; o += 4) if (image.rgba[o + 3]) {
      expect(allowed.has(px(image, o).slice(0, 3).join())).toBe(true);
      if (px(image, o).slice(0, 3).join() === WEIGHT_PALETTE[WEIGHT_BARRIER].slice(0, 3).join()) alphas.add(image.rgba[o + 3]);
    }
    expect(alphas.size).toBe(2);
  });

  it("'cause' gives a cell the colour of the category whose row wins it", async () => {
    const windows = createWindowCache();
    await route(req({ weightMode: 'cause' }), fakeIO(), windows);
    // grassland ×50 outweighs the sparse flag cells; with it at ×1 the floodplain / site cells win theirs
    const heavy = (w: number) => repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'cause', presetPatch: grass({ route_w: w }) }, windows);
    const keys = (o: ReturnType<typeof heavy>) => (o as { result: { image: import('./route.js').WeightImage } }).result.image.cause!.present;
    const heavyKeys = keys(heavy(50));
    expect(heavyKeys[0]).toMatchObject({ key: 'terrain:landcover', colour: CAUSE_COLOURS['terrain:landcover'].colour });
    const light = keys(heavy(1));
    // the EPA floodplain cell is exempt where a FEMA map is in effect; FEMA's own SFHA cell takes the floodplain colour
    expect(light.some((x) => x.key === 'flags2:2')).toBe(false);
    expect(light.find((x) => x.key === 'nfhl')).toMatchObject({ colour: CONSTRAINT_PALETTE.find((c) => c.id === 'floodplain')!.colour });
    expect(light.find((x) => x.key === 'aviation')).toMatchObject({ colour: CAUSE_COLOURS.aviation.colour });
    expect(light.some((x) => x.key === 'terrain:landcover')).toBe(false);
  });

  it('refuses without a held window, a bad mode and a bad patch', async () => {
    const empty = createWindowCache();
    expect(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route' }, empty)).toEqual({ ok: false, reason: 'no cached window' });
    const windows = createWindowCache();
    await route(req(), fakeIO(), windows);
    expect(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'x' as never }, windows).ok).toBe(false);
    expect(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route', presetPatch: grass({ route_w: -1 }) }, windows).ok).toBe(false);
    expect(repaint({ ...ends, preset: 'tm-default', lineType: 'nope', mode: 'route' }, windows).ok).toBe(false);
  });

  it('a solve for other ends drops the held window before it reads', async () => {
    const windows = createWindowCache();
    await route(req(), fakeIO(), windows);
    const first = windows.held!;
    const heldAtRead: unknown[] = [];
    // same ends: kept while the solve reads, then replaced
    await route(req(), fakeIO(() => heldAtRead.push(windows.held)), windows);
    expect(heldAtRead[0]).toBe(first);
    expect(windows.held).not.toBe(first);
    heldAtRead.length = 0;
    await route(req({ from: at(20, 30) }), fakeIO(() => heldAtRead.push(windows.held)), windows);
    expect(heldAtRead[0]).toBeNull();
    expect(windows.held?.key).toContain(JSON.stringify(at(20, 30)));
  });

  it('refuses a held window of another route (ends or line type)', async () => {
    const windows = createWindowCache();
    await route(req(), fakeIO(), windows);
    const other = { ok: false, reason: 'window is for another route' };
    expect(repaint({ ...ends, from: at(20, 30), preset: 'tm-default', lineType: 'ac500', mode: 'route' }, windows)).toEqual(other);
    expect(repaint({ ...ends, to: at(60, 30), preset: 'tm-default', lineType: 'ac500', mode: 'route' }, windows)).toEqual(other);
    const lt = Object.keys((await import('../../src/registry/route-presets.js')).ROUTE_PRESETS.find((p) => p.id === 'tm-default')!.line_types)
      .find((x) => x !== 'ac500')!;
    expect(repaint({ ...ends, preset: 'tm-default', lineType: lt, mode: 'route' }, windows)).toEqual(other);
    expect(repaint({ ...ends, preset: 'tm-default', lineType: 'ac500', mode: 'route' }, windows).ok).toBe(true);
  });

  it('keeps a window only after an overlay solve; another solve of the same route leaves the held one', async () => {
    const windows = createWindowCache();
    expect((await route(req({ weightImage: false }), fakeIO(), windows)).ok).toBe(true);
    expect(windows.held).toBeNull();
    await route(req(), fakeIO(), windows);
    const held = windows.held;
    expect(held).not.toBeNull();
    await route(req({ weightImage: false, alternatives: 1, surface: true }), fakeIO(), windows);
    expect(windows.held).toBe(held);
  });

  it('the pre-solve estimate counts the same bytes per cell as an attempt, plus the image allowances', () => {
    const wanted = new Set(['landcover', 'slope'] as const);
    const plain = cellBytes(wanted as never, { surface: false, alternatives: 0, weightImage: false });
    expect(plain).toEqual({ base: 3 + 20, extra: 0, images: 0 });   // landcover, slope + state
    const all = { surface: true, alternatives: 2, weightImage: true };
    const b = cellBytes(wanted as never, all);
    expect(b.extra).toBeGreaterThan(11 + 1);
    expect(b.images).toBeGreaterThan(0);
    expect(solveEstimateBytes(1000, wanted as never, all)).toBe(1000 * (b.base + b.extra) + b.images);
    expect(solveEstimateBytes(1000, wanted as never, { surface: false, alternatives: 0, weightImage: false })).toBe(1000 * 23);
  });

  it('keeps no window over its byte cap', async () => {
    const windows = createWindowCache(1000);
    expect((await route(req(), fakeIO(), windows)).ok).toBe(true);
    expect(windows.held).toBeNull();
    const roomy = createWindowCache();
    await route(req(), fakeIO(), roomy);
    // measured from the arrays held: every band read (state included) + the mask, 5400 cells each
    expect(roomy.held!.bytes).toBe((Object.keys(roomy.held!.bands).length + 1) * 5400);
  });
});

// ─── repaintRows: the Method grid's highlighted rows ─────────────────────────

const meta = readGridJson(gridJson) as GridMeta;
const preset = routePreset('tm-default')!;
const rkey = { from: at(20, 20), to: at(60, 20), lineType: 'ac500' };
// 4 × 3 cells, row-major; cell 5 is outside the mask. Row 17 = desig bit 0, 24 = PHMA (flags2 bit 0, except 0 = flags bit 4).
const win = (over: Partial<BandWindow> = {}): BandWindow => ({
  key: JSON.stringify([rkey.from, rkey.to, rkey.lineType]), meta, box: { c0: 10, r0: 10, w: 4, h: 3, cells: 12 },
  mask: Uint8Array.of(1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1),
  bands: {
    desig: Uint8Array.of(1, 0, 3, 1, 0, 1, 1, 0, 2, 0, 1, 1),
    flags: Uint8Array.of(16, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16, 0),
    flags2: Uint8Array.of(1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0),
    adj: new Uint8Array(12),
    landcover: Uint8Array.of(21, 41, 52, 0, 71, 81, 90, 11, 21, 21, 22, 0),
  },
  bytes: 0, ...over,
});
const pick = (row: number, slot: number, except?: number): RowPick =>
  ({ row, band: preset.rows[row].band, note: preset.rows[row].note, slot, ...(except === undefined ? {} : { except }) });
const cls = (...v: number[]) => Uint8Array.from(v);

describe('rowClasses', () => {
  it('a desig bit-0 pick marks its cells in its slot + 1; the masked cell stays 0', () => {
    expect(rowClasses(win(), [pick(17, 0)], preset)).toEqual(cls(1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1));
  });

  it('a PHMA (flags2 bit 0) pick', () => {
    expect(rowClasses(win(), [pick(24, 2)], preset)).toEqual(cls(3, 3, 0, 0, 0, 0, 0, 3, 0, 3, 3, 0));
  });

  it('a PHMA except-0 pick is the parent row AND the flags bit-4 entry', () => {
    // cell 2 has flags bit 4 but not PHMA, cell 9 has PHMA but not flags: neither is marked
    expect(rowClasses(win(), [pick(24, 3, 0)], preset)).toEqual(cls(4, 0, 0, 0, 0, 0, 0, 4, 0, 0, 4, 0));
  });

  it('where picks overlap the later pick wins', () => {
    expect(rowClasses(win(), [pick(17, 0), pick(24, 2)], preset)).toEqual(cls(3, 3, 1, 1, 0, 0, 1, 3, 0, 3, 3, 1));
    expect(rowClasses(win(), [pick(24, 2), pick(17, 0)], preset)).toEqual(cls(1, 3, 1, 1, 0, 0, 1, 3, 0, 3, 1, 1));
  });

  it('no picks gives all zeros', () => {
    expect(rowClasses(win(), [], preset)).toEqual(new Uint8Array(12));
  });
});

describe('repaintRows', () => {
  const rr = (rows: RowPick[], over: Partial<RepaintRowsRequest> = {}): RepaintRowsRequest => ({ ...rkey, preset: 'tm-default', rows, ...over });
  const held = (over: Partial<BandWindow> = {}) => { const w = createWindowCache(); w.held = win(over); return w; };
  const reason = (o: { ok: boolean; reason?: string }) => (o.ok ? '' : o.reason!);

  it('paints surfaceImage(window, rowClasses, HIGHLIGHT_PALETTE) with mode rows', () => {
    const rows = [pick(17, 0), pick(24, 2, 0)];
    const out = repaintRows(rr(rows), held());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const b = win().box;
    const want = surfaceImage(meta.grid, { col0: b.c0, row0: b.r0, cols: b.w, rows: b.h }, rowClasses(win(), rows, preset), HIGHLIGHT_PALETTE);
    expect(out.result.image.mode).toBe('rows');
    expect(out.result.image.rgba).toEqual(want.rgba);
    expect(out.result.image.coordinates).toEqual(want.coordinates);
  });

  it('empty rows give an all-transparent image', () => {
    const out = repaintRows(rr([]), held());
    expect(out.ok && out.result.image.rgba.every((v) => v === 0)).toBe(true);
  });

  it('refuses without a window, for another route, and with a bad pick', () => {
    expect(reason(repaintRows(rr([]), createWindowCache()))).toBe('no cached window');
    expect(reason(repaintRows(rr([], { lineType: 'ac230' }), held()))).toBe('window is for another route');
    expect(reason(repaintRows(rr([{ ...pick(17, 0), row: 999 }]), held()))).toMatch(/row is out of range/);
    expect(reason(repaintRows(rr([{ ...pick(17, 0), band: 'flags' }]), held()))).toMatch(/names band "flags"/);
    expect(reason(repaintRows(rr([{ ...pick(17, 0), note: 'x' }]), held()))).toMatch(/note "x"/);
    expect(reason(repaintRows(rr([pick(24, 0, 5)]), held()))).toMatch(/except is out of range/);
    expect(reason(repaintRows(rr([pick(17, 0, 0)]), held()))).toMatch(/except is out of range/);
    expect(reason(repaintRows(rr([pick(17, 8)]), held()))).toMatch(/slot/);
    expect(reason(repaintRows(rr([pick(17, -1)]), held()))).toMatch(/slot/);
    expect(reason(repaintRows(rr([pick(17, 0), pick(17, 1)]), held()))).toMatch(/repeats/);
    expect(reason(repaintRows(rr([pick(24, 0, 0), pick(24, 1, 0)]), held()))).toMatch(/repeats/);
    expect(reason(repaintRows(rr(Array.from({ length: 9 }, (_, k) => pick(17 + (k % 7), k % 8))), held()))).toMatch(/at most 8/);
    expect(reason(repaintRows(rr([pick(17, 0)], { preset: 'nope' }), held()))).toMatch(/unknown preset/);
  });

  it('refuses a band the window lacks, with a reason the shell reads as no window', () => {
    const w = win();
    delete w.bands.flags;
    const cache = createWindowCache();
    cache.held = w;
    expect(reason(repaintRows(rr([pick(24, 0, 0)]), cache))).toBe('the cached window has no flags band: re-solve to show this row');
    expect(repaintRows(rr([pick(24, 0)]), cache).ok).toBe(true);
    for (const r of ['no cached window', 'window is for another route', 'the cached window has no flags band: re-solve to show this row'])
      expect(NO_WINDOW_REASONS.some((p) => r.startsWith(p))).toBe(true);
    expect(NO_WINDOW_REASONS.some((p) => 'unknown preset "x"'.startsWith(p))).toBe(false);
  });

  it('a band read only by an exemption that is off is refused as not a window problem', () => {
    const exempt = structuredClone(preset);
    exempt.id = 'tm-test-off-exemption';
    exempt.rows[24].except = [{ band: 'adj', match: { field: { shift: 0, mask: 0b11 }, codes: [1, 2] }, label: 'off', active: false, src: 'test' }];
    for (const [k, r] of exempt.rows.entries()) if (k !== 24 && r.band === 'adj') r.band = 'landcover';
    expect(presetBands(exempt).has('adj')).toBe(false);
    ROUTE_PRESETS.push(exempt);
    try {
      const w = win();
      delete w.bands.adj;
      const cache = createWindowCache();
      cache.held = w;
      const r = reason(repaintRows(rr([pick(24, 0, 0)], { preset: exempt.id }), cache));
      expect(r).toMatch(/adj band is read only by an exemption that is off: turn the exemption on/);
      expect(NO_WINDOW_REASONS.some((p) => r.startsWith(p))).toBe(false);
    } finally { ROUTE_PRESETS.pop(); }
  });

  it('end to end: tm-default row 7 (grassland) marks exactly the in-mask cells whose landcover is 21, 52, 71 or 81', async () => {
    const windows = createWindowCache();
    expect((await route(req(), fakeIO(), windows)).ok).toBe(true);
    const h = windows.held!;
    const rows = [pick(7, 0)];
    const out = repaintRows(rr(rows), windows);
    expect(out.ok).toBe(true);
    const classes = rowClasses(h, rows, routePreset('tm-default')!);
    let want = 0;
    for (let i = 0; i < h.mask.length; i++) {
      const hit = h.mask[i] !== 0 && [21, 52, 71, 81].includes(h.bands.landcover![i]);
      expect(classes[i]).toBe(hit ? 1 : 0);
      if (hit) want++;
    }
    expect(want).toBeGreaterThan(1000);
  });
});
