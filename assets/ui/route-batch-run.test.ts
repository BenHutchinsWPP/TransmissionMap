// @vitest-environment jsdom
// ─── Route batch runner tests ────────────────────────────────────────────────
// Role: the batch runner over the mini cube (fixtures/cube-wall) with the real engine (`route()`, `repaint()`)
//       as the solver: each row's requests equal hand-written RouteRequest literals and its route equals
//       `route()` on them (built-in + session patch, saved method by name, uploaded-layer row); solve 1's
//       weightMode; the implicit route picture; a failed row then a solved one; cancel keeps finished rows;
//       a NO_WINDOW repaint marks the picture; the size gate on measured ZIP bytes; no RGBA alive after 30 rows
//       and the 25-row recycle; captures wait while the tab is hidden. Capture, PDF and ZIP are fakes.
// Deps: ./route-batch-run.ts, route/route.ts, route/upload-layer.ts, route/grid.ts, route/snap.ts,
//       route/custom-presets.ts, ./route-batch-types.ts (types).

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Blob as NodeBlob } from 'node:buffer';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createWindowCache, repaint, route, type RouteIO, type RouteRequest, type RouteResult } from '../route/route.js';
import { uploadLayer, type UploadLayer } from '../route/upload-layer.js';
import { albersInverse, gridFromJson, lngLatOf } from '../route/grid.js';
import { buildSubstationIndex } from '../route/snap.js';
import { createCustomPresetStore, CUSTOM_PRESETS_KEY } from '../route/custom-presets.js';
import type { BatchRow } from '../route/batch-csv.js';
import type { PresetPatch } from '../route/preset-patch.js';
import type { CaptureView, PdfPicture, PictureId } from './route-batch-types.js';
import { fillTpl, type RouteReportModel } from './route-report-model.js';
import { classLegend } from './route-batch-pdf.js';
import { observationFixture } from './route-observations.fixture.js';
import type { ExactCrossingsRequest, ExactCrossingsResult } from '../route/route.js';
import type { Outcome } from '../dataset-query.js';
import { UPLOAD_BUDGET_MSG, localBudget, parseUploadBudget } from '../route/preset-patch.js';
import { noteText, reasonText, runBatch, UPLOAD_NOT_LOADED, ZIP_CAP, ZIP_CAP_BYTES, type BatchOptions, type BatchSolver, type VisibilityDoc } from './route-batch-run.js';
import { loadRouteStrings } from '../../src/i18n/index.js';

beforeAll(() => loadRouteStrings());

const dir = pathToFileURL(resolve(process.cwd(), 'assets/route/fixtures/cube-wall') + '/');   // jsdom's import.meta.url is not file:
const gridJson = JSON.parse(readFileSync(new URL('grid.json', dir), 'utf8'));
const grid = gridFromJson(gridJson);
const BASE = 'mem://batch-cube-wall/';
const io = (uploads?: ReadonlyMap<string, UploadLayer>): RouteIO => ({
  baseUrl: BASE,
  async fetchJson() { return gridJson; },
  async fetchRange(url, start, end) {
    const buf = readFileSync(new URL(url.slice(BASE.length), dir));
    return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
  },
  ...(uploads ? { uploads } : {}),
});
const at = (c: number, r: number) => lngLatOf(grid, c, r);

// wall in column 40 open at rows 12–14 (north) and 45–47; the upload blocks the north gap.
const rect = (u0: number, u1: number, v0: number, v1: number) => [[[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]
  .map(([u, v]) => albersInverse(grid.x0 + u * grid.cell, grid.y0 - v * grid.cell))]];

const A = at(20, 29), B = at(60, 29);
const SUB = at(36, 29);            // 16 cells (4 km) east of A: snapped at 5 km, not at 3 km
const index = buildSubstationIndex({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: SUB }, properties: { hifld_id: 'S1', name: 'East Sub', max_kv: 500, states: '|NV|' } }],
});
const SESSION: PresetPatch = { rows: [{ row: 1, band: 'landcover', note: 'developed low/medium', route_w: 3 }] };
const SAVED: PresetPatch = { rows: [{ row: 0, band: 'landcover', note: 'forest', route_w: 4 }] };

let layer: UploadLayer;
let uploads: Map<string, UploadLayer>;
let UPL: PresetPatch;
const store = () => createCustomPresetStore(localStorage);

// jsdom (the report model's method tab needs a DOM); the cube reader needs Node's Blob.stream.
vi.stubGlobal('Blob', NodeBlob);

beforeEach(async () => {
  const r = await uploadLayer(rect(38.2, 42.8, 10.2, 16.8), grid);
  if (!r.ok) throw new Error(r.reason);
  layer = r.result;
  uploads = new Map([[layer.hash, layer]]);
  UPL = { add_rows: [{ layer: layer.hash, label: 'Block north gap', route_w: 1, cost_x: 1, barrier: true }] };
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify({ v: 1, items: [
    { id: 'abc', name: 'My method', base: 'tm-default', patch: SAVED, savedAt: '2026-11-03' },
    { id: 'upl', name: 'Blocked', base: 'tm-default', patch: UPL, savedAt: '2026-11-03' },
  ] }));
});

/** The real engine over the mini cube, recording each call. */
function cubeSolver(over: Partial<BatchSolver> = {}) {
  const windows = createWindowCache();
  const calls: { kind: 'route' | 'repaint'; req: unknown }[] = [];
  const s = {
    calls,
    acquire: vi.fn(() => true), release: vi.fn(), recycle: vi.fn(), cancel: vi.fn(),
    route: async (req: RouteRequest) => { calls.push({ kind: 'route', req: structuredClone(req) }); return route(req, io(uploads), windows); },
    repaint: async (req: Parameters<BatchSolver['repaint']>[0]) => { calls.push({ kind: 'repaint', req: structuredClone(req) }); return repaint(req, windows, uploads); },
    drop: vi.fn(() => { windows.held = null; }),
    ...over,
  };
  return s;
}

function fakeZip() {
  const files = new Map<string, Uint8Array | string>();
  let n = 0;
  return {
    files,
    add(p: string, d: Uint8Array | string) { files.set(p, d); n += typeof d === 'string' ? new TextEncoder().encode(d).length : d.length; },
    bytes: () => n,
  };
}

/** Mimics the Capture contract: an overlay picture without an overlay is a note. */
function fakeCapture(jpegBytes = 10) {
  const calls: { picture: PictureId; overlay: boolean; alts: number }[] = [];
  const cap = Object.assign(async (picture: PictureId, view: CaptureView) => {
    calls.push({ picture, overlay: !!view.overlay, alts: view.alternatives?.length ?? 0 });
    if (picture !== 'route' && picture !== 'alternatives' && !view.overlay) return { note: 'not available (area too large)' };
    return { jpeg: new Uint8Array(jpegBytes) };
  }, { close: vi.fn() });
  return { cap, calls };
}

function fakePdf(bytes = 100) {
  const calls: { title: string; pictures: PdfPicture[]; model: RouteReportModel }[] = [];
  return { calls, render: async (m: RouteReportModel, pictures: PdfPicture[]) => { calls.push({ title: m.title, pictures, model: m }); return new Uint8Array(bytes); } };
}

const row = (line: number, key: string, o: Partial<BatchRow> = {}): BatchRow => ({ line, key, a: A, b: B, ...o });
const opts = (rows: BatchRow[], o: Partial<BatchOptions> = {}): BatchOptions => ({
  rows, presetId: 'tm-default', patch: SESSION, lineType: 'ac500', snapKm: 5, index, saved: () => store().list(), date: '2026-11-03', ...o,
});

function setup(o: { solver?: ReturnType<typeof cubeSolver>; pdf?: number; jpeg?: number; doc?: VisibilityDoc | null } = {}) {
  const solver = o.solver ?? cubeSolver();
  const zip = fakeZip(), cap = fakeCapture(o.jpeg), pdf = fakePdf(o.pdf);
  return { solver, zip, cap, pdf, deps: { solver, capture: cap.cap, renderPdf: pdf.render as never, zip, doc: o.doc ?? null } };
}

const summaryLines = (zip: ReturnType<typeof fakeZip>) => String(zip.files.get('summary.csv')).replace(/^\uFEFF/, '').trim().split('\r\n');
const routes = (zip: ReturnType<typeof fakeZip>) => JSON.parse(String(zip.files.get('routes.geojson'))).features as GeoJSON.Feature<GeoJSON.LineString>[];

describe('runBatch over the mini cube', () => {
  it('three rows (built-in + session patch, saved method by name, uploaded-layer row) equal route() on hand-written requests', async () => {
    const t = setup();
    const out = await runBatch(opts([row(2, 'Plain'), row(3, 'Saved', { method: 'My method' }), row(4, 'Upload', { method: 'custom:upl' })]), t.deps).done;
    expect(out.status).toBe('done');
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    const one = { from: SUB, to: B, preset: 'tm-default', lineType: 'ac500', profile: true, surface: false, alternatives: 0, weightImage: true, weightMode: 'cause' };
    const two = { from: SUB, to: B, preset: 'tm-default', lineType: 'ac500', profile: false, surface: true, alternatives: 0, altStretch: 0.2 };
    const lit: RouteRequest[][] = [
      [{ ...one, presetPatch: SESSION }, { ...two, presetPatch: SESSION }] as RouteRequest[],
      [{ ...one, presetPatch: SAVED }, { ...two, presetPatch: SAVED }] as RouteRequest[],
      [{ ...one, presetPatch: UPL, uploads: [layer.hash] }, { ...two, presetPatch: UPL, uploads: [layer.hash] }] as RouteRequest[],
    ];
    const solves = t.solver.calls.filter((c) => c.kind === 'route').map((c) => c.req);
    expect(solves).toEqual(lit.flat());
    // the cost picture is repainted from the held window with the row's method
    const repaints = t.solver.calls.filter((c) => c.kind === 'repaint').map((c) => c.req);
    expect(repaints).toEqual([
      { from: SUB, to: B, preset: 'tm-default', lineType: 'ac500', mode: 'cost', presetPatch: SESSION },
      { from: SUB, to: B, preset: 'tm-default', lineType: 'ac500', mode: 'cost', presetPatch: SAVED },
      { from: SUB, to: B, preset: 'tm-default', lineType: 'ac500', mode: 'cost', presetPatch: UPL, uploads: [layer.hash] },
    ]);
    const feats = routes(t.zip);
    for (let i = 0; i < 3; i++) {
      const ref = await route(lit[i][0], io(uploads));
      if (!ref.ok) throw new Error(ref.reason);
      expect(feats[i].geometry.coordinates).toEqual(ref.result.path.coordinates);
      expect(feats[i].properties!.total_usd_2025).toBe(Math.round(ref.result.cost.total2025));
      expect(out.rows[i].total2025).toBe(ref.result.cost.total2025);
    }
    const plain = await route({ ...one, presetPatch: SESSION } as RouteRequest, io());
    expect(plain.ok && plain.result.path.coordinates).not.toEqual(feats[2].geometry.coordinates);   // the upload moved row 3
    expect(out.rows[0].a?.hit?.name).toBe('East Sub');
    for (const f of ['rows/001-plain/report.pdf', 'rows/001-plain/cost.csv', 'rows/002-saved/crossings.csv', 'rows/003-upload/report.pdf', 'batch.json'])
      expect(t.zip.files.has(f), f).toBe(true);
    expect(String(t.zip.files.get('rows/001-plain/cost.csv')).startsWith('\uFEFF')).toBe(true);
    expect(String(t.zip.files.get('rows/001-plain/crossings.csv')).startsWith('\uFEFF')).toBe(true);
    const meta = JSON.parse(String(t.zip.files.get('batch.json')));
    expect(meta.snapKm).toBe(5);
    expect(meta.methods['custom:upl']).toEqual({ base: 'tm-default', patch: UPL, name: 'Blocked' });
    expect(meta.cube).toBe('unknown');
    expect(t.cap.cap.close).toHaveBeenCalledOnce();
    expect(t.solver.release).toHaveBeenCalledOnce();
    // the cause picture carries its colour key; no caption
    const pics = t.pdf.calls[0].pictures;
    expect(pics.map((p) => p.picture)).toEqual(['route', 'cause', 'cost', 'similar', 'alternatives']);
    expect(pics[1].legend?.length).toBeGreaterThan(0);
    expect(pics[2].legend).toEqual(classLegend('cost'));
    expect(pics[3].legend?.map((l) => l.label)).toEqual(['\u2264 2 %', '\u2264 5 %', '\u2264 10 %', '\u2264 20 %']);
    expect(pics.map((p) => p.caption)).toEqual(pics.map((p) => ({ route: 'Route', cause: 'What constrains the route (the method as solved)', cost: 'Cost per cell', similar: 'Similar-cost areas', alternatives: 'Alternatives: alternatives were not asked for', weight: 'Routing weight' })[p.picture]));
    // a saved method's stored uploaded layer is listed in the report's method section
    expect(t.pdf.calls.map((c) => c.model.method.uploads.map((u) => fillTpl(u)))).toEqual([[], [], ['uploaded layer: Block north gap — routing weight 1, cost × 1, barrier']]);
  });

  it('solve 1 asks for the first overlay picture\'s mode; `route` is always the first picture', async () => {
    const t = setup();
    await runBatch(opts([row(2, 'A'), row(3, 'B', { pictures: ['cost'] }), row(4, 'C', { pictures: ['cost', 'cause'] })], { pictures: undefined }), t.deps).done;
    const firsts = t.solver.calls.filter((c) => c.kind === 'route' && (c.req as RouteRequest).profile).map((c) => (c.req as RouteRequest).weightMode);
    expect(firsts).toEqual(['cause', 'cost', 'cause']);   // order cause → weight → cost, whatever the row's order
    expect(t.pdf.calls[1].pictures.map((p) => p.picture)).toEqual(['route', 'cost']);
    expect(t.pdf.calls[2].pictures.map((p) => p.picture)).toEqual(['route', 'cost', 'cause']);
    expect(t.solver.calls.filter((c) => c.kind === 'route')).toHaveLength(4);   // rows 3 and 4 ask for neither similar nor alternatives
    expect(t.solver.calls.filter((c) => c.kind === 'repaint').map((c) => (c.req as { mode: string }).mode)).toEqual(['cost', 'cost']);
    const noOverlay = setup();
    await runBatch(opts([row(2, 'R', { pictures: ['route'] })]), noOverlay.deps).done;
    expect((noOverlay.solver.calls[0].req as RouteRequest).weightImage).toBeUndefined();
  });

  it('exact points: no snap, and a row whose A is off the cube is reported while the next row solves', async () => {
    const t = setup();
    const out = await runBatch(opts([row(2, 'Sea', { a: at(-400, 29) }), row(3, 'Land')], { snapKm: null }), t.deps).done;
    expect(out.rows[0].status).toBe('failed');
    expect(out.rows[0].reason).toBeTruthy();
    expect(out.rows[1].status).toBe('ok');
    expect((t.solver.calls.at(-2)!.req as RouteRequest).from).toEqual(A);
    expect(summaryLines(t.zip)).toHaveLength(3);
    expect(summaryLines(t.zip)[1]).toMatch(/^2,Sea,failed,/);
  });

  it('cancel during row 2 keeps row 1 and lists the rest as cancelled', async () => {
    let handle: ReturnType<typeof runBatch> | null = null;
    const base = cubeSolver();
    let n = 0;
    const solver = cubeSolver({
      route: async (req: RouteRequest) => {
        if (++n === 3) { handle!.cancel(); return { ok: false, reason: 'cancelled' }; }
        return base.route(req);
      },
      repaint: base.repaint, drop: base.drop,
    });
    const t = setup({ solver });
    handle = runBatch(opts([row(2, 'One'), row(3, 'Two'), row(4, 'Three')]), t.deps);
    const out = await handle.done;
    expect(out.status).toBe('cancelled');
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'cancelled', 'cancelled']);
    expect(solver.cancel).toHaveBeenCalledOnce();
    expect([...t.zip.files.keys()].filter((k) => k.startsWith('rows/'))).toEqual(['rows/001-one/report.pdf', 'rows/001-one/cost.csv', 'rows/001-one/crossings.csv']);
    expect(summaryLines(t.zip).slice(1).map((l) => l.split(',')[2])).toEqual(['ok', 'cancelled', 'cancelled']);
    expect(routes(t.zip)).toHaveLength(1);
    expect(t.cap.cap.close).toHaveBeenCalledOnce();
    expect(solver.release).toHaveBeenCalledOnce();
  });

  it('a NO_WINDOW_REASONS repaint marks the picture in the PDF and summary.csv', async () => {
    const solver = cubeSolver({ repaint: async () => ({ ok: false, reason: 'no cached window' }) });
    const t = setup({ solver });
    const out = await runBatch(opts([row(2, 'Big', { pictures: ['route', 'cause', 'cost'] })]), t.deps).done;
    expect(t.cap.calls.find((c) => c.picture === 'cost')).toEqual({ picture: 'cost', overlay: false, alts: 0 });
    expect(t.pdf.calls[0].pictures.find((p) => p.picture === 'cost')).toEqual({ picture: 'cost', caption: 'Cost per cell', note: 'not available (area too large)' });
    expect(out.rows[0].pictures!.find((p) => p.picture === 'cost')).toEqual({ picture: 'cost', note: 'not available (area too large)', code: 'no-window' });
    expect(summaryLines(t.zip)[1]).toContain('cost: not available (area too large) (area too large for this picture)');
  });

  it('a repaint that fails for another reason gets its own note, not "area too large"; reasons are worded with the code kept', async () => {
    const solver = cubeSolver({ repaint: async () => ({ ok: false, reason: 'boom' }) });
    const t = setup({ solver });
    const out = await runBatch(opts([row(2, 'Odd', { pictures: ['route', 'cause', 'cost'] }), row(3, 'NoMethod', { method: 'custom:nope' })]), t.deps).done;
    const cost = t.pdf.calls[0].pictures.find((p) => p.picture === 'cost');
    expect(cost?.note).toBe('not available (the picture could not be made)');
    expect(t.cap.calls.find((c) => c.picture === 'cost')).toBeUndefined();
    expect(out.rows[0].pictures!.find((p) => p.picture === 'cost')?.code).toBe('repaint failed: boom');
    expect(summaryLines(t.zip)[1]).toContain('cost: not available (the picture could not be made) (picture could not be repainted: boom)');
    expect(out.rows[1].reason).toBe('method not available');
    expect(summaryLines(t.zip)[2]).toContain('method not available (deleted or needs review),method not available');
  });

  it('the budget reason is worded with its numbers; a two-layer saved method holding hashes only solves in a batch and batch.json keeps hashes only', async () => {
    const budget = `${UPLOAD_BUDGET_MSG}: 12 layers × 3000000 cells = 34332 MiB, at most 512 MiB`;
    expect(reasonText(budget)).toBe('Uploaded layers exceed the memory budget: 12 layers over this route\'s search area need 34,332 MiB, at most 512 MiB. Remove a layer or shorten the line.');
    expect(parseUploadBudget(budget)).toEqual({ n: '12', mib: '34332', max: '512' });
    expect(localBudget({ n: '1', mib: '0.5', max: '512' }, 'de')).toEqual({ n: '1', mib: '0,5', max: '512' });
    expect(localBudget({ n: '12', mib: '34332', max: '512' }, 'en').mib).toBe('34,332');
    const r2 = await uploadLayer(rect(50.2, 52.8, 20.2, 22.8), grid);
    if (!r2.ok) throw new Error(r2.reason);
    uploads.set(r2.result.hash, r2.result);
    // two add_rows, hashes and weights only
    const literal = `{"v":1,"items":[{"id":"old","name":"Old two","base":"tm-default","patch":{"add_rows":[
      {"layer":"${layer.hash}","label":"Block north gap","route_w":1,"cost_x":1,"barrier":true},
      {"layer":"${r2.result.hash}","label":"Far block","route_w":2,"cost_x":1}]},"savedAt":"2026-10-30"}]}`;
    localStorage.setItem(CUSTOM_PRESETS_KEY, literal);
    const t = setup();
    const out = await runBatch(opts([row(2, 'Old', { method: 'Old two', pictures: ['route'] })]), t.deps).done;
    expect(out.rows.map((x) => x.status)).toEqual(['ok']);
    const meta = JSON.parse(String(t.zip.files.get('batch.json')));
    expect(meta.methods['custom:old'].patch).toEqual(JSON.parse(literal).items[0].patch);
    expect(JSON.stringify(meta)).not.toMatch(/upl_|coordinates/);
  });

  it('reasonText words every code the runner emits and noteText the capture literals', () => {
    for (const c of ['busy', 'no-window', 'no image', 'none found', 'no alternatives asked for', ZIP_CAP, 'method not available', 'unknown line type', UPLOAD_NOT_LOADED, 'no report', 'skipped: x', 'repaint failed: x', 'solve 2 failed: x', 'none: x'])
      expect(reasonText(c), c).not.toBe(c);
    expect(reasonText('solve 2 failed: boom')).toBe('second search failed: boom');
    expect(reasonText('some engine text')).toBe('some engine text');
    expect(reasonText('cancelled')).toBe('cancelled');
    expect(reasonText('unknown method')).toBe('unknown method');
    expect(noteText('basemap incomplete')).toBe('basemap incomplete');
    expect(noteText('other')).toBe('other');
  });

  it('the size gate: measured row-1 ZIP bytes × rows over 1 GiB stop the batch after row 1; just under does not', async () => {
    const probe = setup({ pdf: 0 });
    await runBatch(opts([row(2, 'Gate', { pictures: ['route'] })]), probe.deps).done;
    const rowFiles = [...probe.zip.files].filter(([k]) => k.startsWith('rows/'));
    const csvBytes = rowFiles.reduce((s, [, d]) => s + (typeof d === 'string' ? new TextEncoder().encode(d).length : d.length), 0);
    const N = 200;
    const under = Math.floor(ZIP_CAP_BYTES / N) - csvBytes;
    const rows = Array.from({ length: N }, (_, i) => row(i + 2, 'Gate', { pictures: ['route'] }));
    const go = async (pdf: number) => {
      let handle: ReturnType<typeof runBatch> | null = null, n = 0;
      const base = cubeSolver();
      const solver = cubeSolver({ route: async (req: RouteRequest) => { if (++n === 2) { handle!.cancel(); return { ok: false, reason: 'cancelled' }; } return base.route(req); }, repaint: base.repaint, drop: base.drop });
      const t = setup({ solver, pdf });
      handle = runBatch(opts(rows), t.deps);
      return { out: await handle.done, n: () => n };
    };
    const over = await go(under + 1);
    expect(over.out.status).toBe('stopped');
    expect(over.out.reason).toBe(ZIP_CAP);
    expect(over.out.rows[1]).toMatchObject({ status: 'skipped', reason: ZIP_CAP });
    expect(over.n()).toBe(1);                       // row 2 never solved
    const ok = await go(under);
    expect(ok.n()).toBe(2);                         // row 2 started (then cancelled by the test)
    expect(ok.out.status).toBe('cancelled');
  });

  it('30 rows: no RGBA image alive afterwards, and the worker is recycled once (after row 25)', { timeout: 60_000 }, async () => {
    const refs: WeakRef<object>[] = [];
    const base = cubeSolver();
    const track = (img: unknown) => { if (img && typeof img === 'object' && 'rgba' in img) refs.push(new WeakRef((img as { rgba: object }).rgba)); };
    const solver = cubeSolver({
      route: async (req: RouteRequest) => {
        const o = await base.route(req);
        if (o.ok) { track(o.result.weightImage); track((o.result as RouteResult).surface && 'image' in o.result.surface! ? o.result.surface.image : null); }
        return o;
      },
      repaint: async (req) => { const o = await base.repaint(req); if (o.ok) track(o.result.image); return o; },
      drop: base.drop,
    });
    const t = setup({ solver });
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 2, `R${i}`, { pictures: ['route', 'cause', 'cost', 'similar'] }));
    const out = await runBatch(opts(rows), t.deps).done;
    expect(out.rows.every((r) => r.status === 'ok')).toBe(true);
    expect(solver.recycle).toHaveBeenCalledOnce();
    expect(refs.length).toBe(90);
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); gc(); }
    expect(refs.filter((r) => r.deref() !== undefined).length).toBe(0);
    void out;
  });

  it('waits while the tab is hidden and captures once it is shown again', async () => {
    const listeners = new Set<() => void>();
    const doc = { hidden: true, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
    const t = setup({ doc });
    let done = false;
    const p = runBatch(opts([row(2, 'Hidden', { pictures: ['route'] })]), t.deps).done.then((o) => { done = true; return o; });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.cap.calls).toHaveLength(0);
    expect(done).toBe(false);
    doc.hidden = false;
    for (const f of [...listeners]) f();
    const out = await p;
    expect(out.rows[0].status).toBe('ok');
    expect(t.cap.calls.map((c) => c.picture)).toEqual(['route']);
    expect(listeners.size).toBe(0);
  });

  it('a second runBatch while one runs is refused at start; the first is unaffected', async () => {
    const lock = { held: false };
    const solver = cubeSolver({ acquire: vi.fn(() => (lock.held ? false : (lock.held = true))), release: vi.fn(() => { lock.held = false; }) });
    const t1 = setup({ solver }), t2 = setup({ solver });
    const first = runBatch(opts([row(2, 'One', { pictures: ['route'] })]), t1.deps);
    const second = await runBatch(opts([row(2, 'Two', { pictures: ['route'] })]), t2.deps).done;
    expect(second).toEqual({ status: 'busy', reason: 'busy', rows: [] });
    const out = await first.done;
    expect(out.status).toBe('done');
    expect(out.rows[0].status).toBe('ok');
    expect(lock.held).toBe(false);
  });

  it('the running size check: a small row 1 then large rows stops before the cap, keeping finished rows', async () => {
    const rows = [row(2, 'Small', { pictures: ['route'] }), row(3, 'Big', { pictures: ['route'] }), row(4, 'Big2', { pictures: ['route'] }), row(5, 'Big3', { pictures: ['route'] })];
    let extra = 0, pdfs = 0;
    const big = ZIP_CAP_BYTES / 2.5;
    const t = setup();
    const zip = { add: (p: string, d: Uint8Array | string) => { t.zip.add(p, d); if (p.endsWith('report.pdf') && ++pdfs > 1) extra += big; }, bytes: () => t.zip.bytes() + extra };
    const out = await runBatch(opts(rows), { ...t.deps, zip }).done;
    expect(out.status).toBe('stopped');
    expect(out.reason).toBe(ZIP_CAP);
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'skipped']);
    expect(out.rows[3].reason).toBe(ZIP_CAP);
  });

  it('a row whose uploaded layer is not loaded fails with the code before any solve', async () => {
    const solver = cubeSolver({ loaded: () => false });
    const t = setup({ solver });
    const out = await runBatch(opts([row(2, 'Blocked', { method: 'Blocked', pictures: ['route'] })]), t.deps).done;
    expect(out.rows[0]).toMatchObject({ status: 'failed', reason: UPLOAD_NOT_LOADED });
    expect(solver.calls).toHaveLength(0);
  });

  it('a capture whose close throws still releases the lock', async () => {
    const t = setup();
    t.cap.cap.close.mockImplementation(() => { throw new Error('webgl lost'); });
    const h = runBatch(opts([row(2, 'X', { pictures: ['route'] })]), t.deps);
    await expect(h.done).rejects.toThrow('webgl lost');
    expect(t.solver.release).toHaveBeenCalledOnce();
  });

  it('refuses to start while another owner holds the solver', async () => {
    const solver = cubeSolver({ acquire: vi.fn(() => false) });
    const t = setup({ solver });
    const out = await runBatch(opts([row(2, 'X')]), t.deps).done;
    expect(out).toEqual({ status: 'busy', reason: 'busy', rows: [] });
    expect(solver.calls).toHaveLength(0);
    expect(t.cap.cap.close).toHaveBeenCalledOnce();
  });
});

describe('runBatch: observations, unnamed ends, captions', () => {
  const exactOk = (req: ExactCrossingsRequest): Outcome<ExactCrossingsResult> => ({ ok: true, result: {
    routes: req.polylines.map(() => ({ points: [], counts: {} as never, dupDropped: 0 })), screening: req.polylines.map(() => observationFixture()),
    status: {} as never, exact: [] } });

  it('reads each row\'s observations once, after releasing the window, into the PDF model and crossings.csv', async () => {
    const order: string[] = [];
    const base = cubeSolver();
    const crossings = vi.fn(async (req: ExactCrossingsRequest) => { order.push('crossings'); return exactOk(req); });
    const solver = cubeSolver({ crossings, drop: vi.fn(() => { order.push('drop'); base.drop(); }) });
    const t = setup({ solver });
    const out = await runBatch(opts([row(2, 'One', { pictures: ['route'] }), row(3, 'Two', { pictures: ['route'] })]), t.deps).done;
    expect(out.rows.map((r) => [r.status, r.reason])).toEqual([['ok', undefined], ['ok', undefined]]);
    expect(crossings).toHaveBeenCalledTimes(2);
    expect(order.slice(0, 2)).toEqual(['drop', 'crossings']);
    const feat = routes(t.zip)[0];
    const req = crossings.mock.calls[0][0];
    expect(req.polylines[0]).toHaveLength(feat.geometry.coordinates.length);
    expect(req.lengthsMi).toEqual([out.rows[0].lengthMi]);
    expect(t.pdf.calls[0].model.observations?.screening).toEqual(observationFixture());
    expect(String(t.zip.files.get('rows/001-one/crossings.csv'))).toContain('Building and aviation observations');
  });

  it('a failed read keeps the row ok with the reason worded; a cancel during the read ends the batch at once', async () => {
    const t = setup({ solver: cubeSolver({ crossings: async () => ({ ok: false, reason: 'boom' }) }) });
    const out = await runBatch(opts([row(2, 'One', { pictures: ['route'] })]), t.deps).done;
    expect(out.rows[0]).toMatchObject({ status: 'ok', reason: 'observations: boom' });
    expect(t.pdf.calls[0].model.observations).toBeNull();
    expect(summaryLines(t.zip)[1]).toContain('building and aviation observations not read: boom');

    let handle: ReturnType<typeof runBatch> | null = null;
    const hang = cubeSolver({ crossings: () => { setTimeout(() => handle!.cancel(), 0); return new Promise<never>(() => {}); } });
    const t2 = setup({ solver: hang });
    handle = runBatch(opts([row(2, 'One', { pictures: ['route'] }), row(3, 'Two')]), t2.deps);
    const out2 = await handle.done;
    expect(out2.status).toBe('cancelled');
    expect(out2.rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect(hang.release).toHaveBeenCalledOnce();
  });

  it('a snap to a substation without a name says so; CSV-skipped rows are worded with their parameters', async () => {
    const unnamed = buildSubstationIndex({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: SUB }, properties: { hifld_id: 'S2', name: '', max_kv: 500, states: '|NV|' } }] });
    const t = setup();
    await runBatch(opts([row(2, 'One', { pictures: ['route'] })], { index: unnamed, skipped: [{ line: 3, reason: 'route.batch.csv.outside', params: { name: 'a_lat', value: '99', lo: 24, hi: 50 } }] }), t.deps).done;
    const [head, one, skip] = summaryLines(t.zip);
    expect(one.split(',')[head.split(',').indexOf('a_substation')]).toBe('Substation (unnamed)');
    expect(t.pdf.calls[0].model.endpoints.a).toMatch(/^A: Substation \(unnamed\), 500 kV/);
    expect(skip).toContain('a_lat 99 outside 24 to 50,route.batch.csv.outside');
  });

  it('an Alternatives picture says in its caption when none were found or none were asked for', async () => {
    const base = cubeSolver();
    const none = cubeSolver({ route: async (req: RouteRequest) => {
      const r = await base.route(req);
      if (r.ok && req.alternatives) r.result = { ...r.result, alternatives: [], altSkipped: undefined };
      return r;
    } });
    const t = setup({ solver: none });
    const out = await runBatch(opts([row(2, 'One', { pictures: ['route', 'alternatives'], alternatives: 1 }), row(3, 'Two', { pictures: ['route', 'similar', 'alternatives'] })]), t.deps).done;
    expect(out.rows[0].pictures!.find((p) => p.picture === 'alternatives')!.code).toBe('none found');
    expect(t.pdf.calls[0].pictures.find((p) => p.picture === 'alternatives')!.caption).toBe('Alternatives: no alternatives found');
    expect(t.pdf.calls[1].pictures.find((p) => p.picture === 'alternatives')!.caption).toBe('Alternatives: alternatives were not asked for');
  });
});
