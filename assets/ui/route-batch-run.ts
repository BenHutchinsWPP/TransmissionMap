// ─── Route batch runner ──────────────────────────────────────────────────────
// Role: runs a parsed batch CSV (route/batch-csv.ts rows) one row at a time and fills a ZIP.
//       Per row: method (built-in id, `custom:<id>` or a saved method's exact name; the pane's session
//       patch applies to rows on the pane's method), line type, ends snapped as a map click (`snapAt`;
//       null = "Use the exact points"); solve 1 = the panel's Find request with `weightImage` in the mode
//       of the first overlay picture, the other overlay pictures repainted from the held window (a
//       NO_WINDOW_REASONS refusal leaves the picture without an overlay, which the capture marks); JPEGs;
//       solve 2 = findAlternatives, only when alternatives > 0 or `similar` is wanted; then exact crossings
//       and observations (a failed read is the ok row's reason `observations: …`); report model → PDF;
//       cost.csv and crossings.csv as the pane downloads them, with a BOM. Each row's RGBA images are
//       dropped after its JPEGs and `drop()` releases the worker's window; the worker is recycled every
//       RECYCLE_EVERY rows. The ZIP's projected size over 1 GiB stops the batch. A row whose uploaded layer
//       is not registered fails with 'upload not loaded' before its first solve. A bad row is reported and
//       the next one runs; cancel keeps the finished rows. Captures wait while the tab is hidden.
//       summary.csv (every row, CSV-skipped ones too), routes.geojson and batch.json are written at the end;
//       the capture is closed and the lock released however the batch ends. Reasons are codes and engine text;
//       the view (route-batch.ts) words them (`reasonText`, `noteText`: locale keys; engine text rides inside {why}).
//       summary.csv carries the worded reason plus `reason_code`; each PDF picture has its `route.batch.pic.<id>`
//       caption (an Alternatives picture without alternatives says why in it) and each overlay picture its colour
//       legend (causeLegend / classLegend / similarLegend); a snap to a substation without a name
//       says so; an overlay that failed for a reason other than the area size gets its own note. No DOM of its own.
//       The solver, capture, PDF renderer and ZIP sink are injected (route-batch-types.ts); `workerSolver()` is the route
//       worker under the solver lock (owner 'batch').
// Deps: i18n (t), route/route-open.ts (lock and calls), route/route.ts (NO_WINDOW_REASONS; types), route/snap.ts (snapAt), route/grid.ts (albersForward),
//       route/batch-csv.ts, route/custom-presets.ts, route/preset-patch.ts, dataset-query.ts (types only),
//       registry/route-presets.ts, ./route-request.ts, ./route-report-model.ts (buildReportModel, costCsv, fmtMoney), ./route-batch-pdf.ts (causeLegend, classLegend, similarLegend), ./route-batch-zip.ts (rowSlug, csvFile, BOM),
//       ./route-tabs/crossings.ts (crossingsCsv, pathKey, shownExact), ./route-batch-types.ts
//       and ./route-tabs/types.ts (types only).

import type { Outcome } from '../dataset-query.js';
import { getLocale, t } from '../../src/i18n/index.js';
import { NO_WINDOW_REASONS, type ExactCrossingsRequest, type ExactCrossingsResult, type RepaintRequest, type RepaintResult, type RouteRequest, type RouteResult, type WeightImage, type WeightMode } from '../route/route.js';
import { acquireRoute, cancelRoute, dropWindow, exactCrossings, hasUpload, recycleWorker, releaseRoute, repaintWeight, routeLine } from '../route/route-open.js';
import { albersForward } from '../route/grid.js';
import { snapAt, type SubstationIndex } from '../route/snap.js';
import type { BatchRow, BatchSkip } from '../route/batch-csv.js';
import type { CustomPreset } from '../route/custom-presets.js';
import { localBudget, parseUploadBudget, type PresetPatch } from '../route/preset-patch.js';
import { routePreset, type RoutePreset } from '../../src/registry/route-presets.js';
import { makeRequestBuilder } from './route-request.js';
import { buildReportModel, costCsv, fmtMoney } from './route-report-model.js';
import { causeLegend, classLegend, similarLegend } from './route-batch-pdf.js';
import { BOM, csvFile, rowSlug } from './route-batch-zip.js';
import { crossingsCsv, pathKey, shownExact } from './route-tabs/crossings.js';
import type { Capture, CaptureView, PdfPicture, PictureId, RenderPdf, ZipSink } from './route-batch-types.js';
import type { DollarYear, RouteEnd, RouteInputs, RouteSession } from './route-tabs/types.js';

export const BATCH_OWNER = 'batch';
export const DEFAULT_PICTURES: readonly PictureId[] = ['route', 'cause', 'cost', 'similar', 'alternatives'];
export const RECYCLE_EVERY = 25;
export const ZIP_CAP_BYTES = 2 ** 30;
/** Reason codes of the batch itself. */
export const ZIP_CAP = 'zip-over-1gib';
export const CANCELLED = 'cancelled';
export const UPLOAD_NOT_LOADED = 'upload not loaded';

/** The engine calls the runner makes. */
export interface BatchSolver {
  acquire(): boolean;
  release(): void;
  route(req: RouteRequest): Promise<Outcome<RouteResult>>;
  repaint(req: RepaintRequest): Promise<Outcome<RepaintResult>>;
  /** Release the held band window. */
  drop(): void;
  /** Start a fresh worker for the next call (uploads are re-posted by route-open.ts). */
  recycle(): void;
  cancel(): void;
  /** Whether an uploaded layer is registered (absent: not checked). */
  loaded?(hash: string): boolean;
  /** Exact crossings and building/aviation observations of the row's route, as the panel reads them (absent: not read). */
  crossings?(req: ExactCrossingsRequest): Promise<Outcome<ExactCrossingsResult>>;
}

/** The route worker under the solver lock. */
export function workerSolver(owner = BATCH_OWNER): BatchSolver {
  return {
    acquire: () => acquireRoute(owner),
    release: () => releaseRoute(owner),
    route: (req) => routeLine(req, undefined, owner),
    repaint: (req) => repaintWeight(req, owner),
    drop: () => dropWindow(owner),
    recycle: () => { recycleWorker(owner); },
    cancel: () => { cancelRoute(owner); },
    loaded: hasUpload,
    crossings: (req) => exactCrossings(req, owner),
  };
}

export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface BatchOptions {
  rows: readonly BatchRow[];
  /** Rows batch-csv.ts skipped, listed in summary.csv. */
  skipped?: readonly BatchSkip[];
  /** The pane's method, line type and session patch: a row without `method` takes them. */
  presetId: string;
  patch: PresetPatch | null;
  lineType: string;
  /** The snap radius (route prefs); null = use the exact points. */
  snapKm: number | null;
  index: SubstationIndex | null;
  /** Alternatives for a row without its own (default 0) and the stretch they are searched within. */
  alternatives?: number;
  altStretch?: number;
  pictures?: readonly PictureId[];
  dollars?: DollarYear;
  saved: () => CustomPreset[];
  cube?: { version: number; sha256: string } | null;
  commit?: string;
  date?: string;
}

export interface BatchDeps {
  solver: BatchSolver;
  capture: Capture & { close(): void };
  renderPdf: RenderPdf;
  zip: ZipSink;
  /** Default: the page's document. */
  doc?: VisibilityDoc | null;
  onRow?: (row: RowReport, done: number, total: number) => void;
}

export type RowStatus = 'ok' | 'failed' | 'skipped' | 'cancelled';
export interface RowReport {
  line: number; key: string; status: RowStatus; reason?: string; folder?: string;
  /** Parameters of a batch-csv.ts reason key (`route.batch.csv.*`). */
  params?: Record<string, string | number>;
  method?: string; lineType?: string; a?: RouteEnd; b?: RouteEnd;
  lengthMi?: number; total2025?: number; optimality?: RouteResult['optimality'];
  /** One entry per picture: the capture's note, or null for a JPEG; `code` when the engine gave none. */
  pictures?: { picture: PictureId; note: string | null; code?: string }[];
}
export interface BatchOutcome { status: 'done' | 'cancelled' | 'stopped' | 'busy'; reason?: string; rows: RowReport[] }

/** A reason code (or a code plus engine text) in the visitor's language; unknown text passes through. */
export function reasonText(code: string, params?: Record<string, string | number>): string {
  if (code.startsWith('route.batch.csv.')) return t(code, params);
  const exact: Record<string, string> = {
    'busy': 'busy', 'no-window': 'noWindow', 'no image': 'noImage', 'none found': 'none', 'no alternatives asked for': 'noAlts',
    [ZIP_CAP]: 'zip', [CANCELLED]: 'cancelled', 'unknown method': 'unknownMethod', 'method not available': 'methodNA',
    'unknown line type': 'unknownLine', [UPLOAD_NOT_LOADED]: 'upload', 'no report': 'noReport',
  };
  if (exact[code]) return t(`route.batch.why.${exact[code]}`);
  const budget = parseUploadBudget(code);
  if (budget) return t('route.err.uploadBudget', localBudget(budget, getLocale()));
  const withWhy: [string, string][] = [['skipped: ', 'skipped'], ['repaint failed: ', 'repaint'], ['solve 2 failed: ', 'solve2'], ['none: ', 'noneWhy'], ['observations: ', 'obs']];
  for (const [prefix, key] of withWhy) if (code.startsWith(prefix)) {
    const inner = code.slice(prefix.length), b = parseUploadBudget(inner);
    return t(`route.batch.why.${key}`, { why: b ? t('route.err.uploadBudget', localBudget(b, getLocale())) : inner });
  }
  return code;
}

const NOTES: Record<string, string> = {
  'basemap incomplete': 'incomplete', 'not available (area too large)': 'area', 'picture not available': 'pic',
};
/** The capture's English note literals as locale keys; other text passes through. */
export function noteText(note: string): string {
  return NOTES[note] ? t(`route.batch.note.${NOTES[note]}`) : note;
}

/** An overlay that is missing for a reason other than the area size (the capture would say "area too large"). */
const madeNote = (code: string | undefined, img: unknown): { jpeg?: Uint8Array; note?: string } | null =>
  !img && code && code !== 'no-window' && !code.startsWith('skipped:') ? { note: t('route.batch.note.made') } : null;

const OVERLAY: readonly [PictureId, WeightMode][] = [['cause', 'cause'], ['weight', 'route'], ['cost', 'cost']];
const modeOf = (p: PictureId): WeightMode | undefined => OVERLAY.find(([q]) => q === p)?.[1];

/** The row's pictures: `route` first (always), then the rest in the given order. */
export function picturesOf(list: readonly PictureId[] | undefined): PictureId[] {
  return ['route', ...new Set((list ?? DEFAULT_PICTURES).filter((p) => p !== 'route'))];
}

/** Solve 1's overlay mode: the first of cause, weight, cost the row asks for. */
export function firstOverlayMode(pics: readonly PictureId[]): WeightMode | null {
  return OVERLAY.find(([p]) => pics.includes(p))?.[1] ?? null;
}

/** lng/lat W,S,E,N of the lines + 10 % of the span on every side. */
export function boundsOf(lines: readonly (readonly [number, number][])[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const l of lines) for (const [x, y] of l) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const dx = Math.max((e - w) * 0.1, 0.005), dy = Math.max((n - s) * 0.1, 0.005);
  return [w - dx, s - dy, e + dx, n + dy];
}

class Cancelled extends Error {}

/** The cost.csv the pane downloads, with a BOM. */
function costFile(r: RouteResult, dollars: DollarYear): string {
  return BOM + costCsv(r, dollars);
}

const SUMMARY_FIELDS = ['line', 'key', 'status', 'reason', 'reason_code', 'folder', 'method', 'line_type', 'a_lon', 'a_lat', 'a_substation',
  'b_lon', 'b_lat', 'b_substation', 'length_mi', 'total_usd_2025', 'optimality', 'pictures'];

/** A snapped end's substation name; a snap to a substation without one says so. */
const subName = (e: RouteEnd | undefined): string => (e?.hit ? e.hit.name || t('route.report.endUnnamedSub') : '');

function summaryRow(r: RowReport): Record<string, unknown> {
  return {
    line: r.line, key: r.key, status: r.status, reason: r.reason ? reasonText(r.reason, r.params) : '', reason_code: r.reason ?? '', folder: r.folder ?? '', method: r.method ?? '',
    line_type: r.lineType ?? '', a_lon: r.a?.lngLat[0] ?? '', a_lat: r.a?.lngLat[1] ?? '', a_substation: subName(r.a),
    b_lon: r.b?.lngLat[0] ?? '', b_lat: r.b?.lngLat[1] ?? '', b_substation: subName(r.b),
    length_mi: r.lengthMi === undefined ? '' : +r.lengthMi.toFixed(2), total_usd_2025: r.total2025 === undefined ? '' : Math.round(r.total2025),
    optimality: r.optimality ?? '',
    pictures: (r.pictures ?? []).map((p) => `${p.picture}: ${p.note ?? 'ok'}${p.code ? ` (${reasonText(p.code)})` : ''}`).join('; '),
  };
}

export function runBatch(opts: BatchOptions, deps: BatchDeps): { cancel(): void; done: Promise<BatchOutcome> } {
  const { solver, capture, renderPdf, zip } = deps;
  const doc = deps.doc !== undefined ? deps.doc : (typeof document === 'undefined' ? null : document);
  const { methodFor, requestFor } = makeRequestBuilder(opts.saved);
  const dollars: DollarYear = opts.dollars ?? 'y2025';
  const altStretch = opts.altStretch ?? 0.2;
  let cancelled = false;
  let wake: (() => void) | null = null;
  let onCancel: (() => void) | null = null;

  const check = (): void => { if (cancelled) throw new Cancelled(); };
  /** A side call that answers 'cancelled' at once on a cancel (cancelRoute stops solves only; the read's late reply is dropped). */
  const orCancel = <T>(p: Promise<Outcome<T>>): Promise<Outcome<T>> => cancelled ? Promise.resolve({ ok: false, reason: CANCELLED })
    : Promise.race([p, new Promise<Outcome<T>>((res) => { onCancel = () => res({ ok: false, reason: CANCELLED }); })]).finally(() => { onCancel = null; });

  /** Resolves at once while the tab is shown (or after a cancel); else on the visibilitychange that shows it. */
  function visible(): Promise<void> {
    if (!doc?.hidden || cancelled) return Promise.resolve();
    return new Promise((res) => {
      const on = (): void => {
        if (doc.hidden && !cancelled) return;
        doc.removeEventListener('visibilitychange', on);
        wake = null;
        res();
      };
      wake = on;
      doc.addEventListener('visibilitychange', on);
    });
  }

  /** The method id a row names, or null when no built-in, custom id or saved name matches. */
  function methodId(m: string | undefined): string | null {
    if (!m) return opts.presetId;
    if (routePreset(m) || m.startsWith('custom:')) return m;
    const c = opts.saved().find((x) => x.name === m);
    return c ? `custom:${c.id}` : null;
  }
  function presetOf(id: string): RoutePreset | undefined {
    if (!id.startsWith('custom:')) return routePreset(id);
    const c = opts.saved().find((x) => `custom:${x.id}` === id);
    return c?.status === 'ok' ? c.preset : undefined;
  }
  const patchFor = (id: string): PresetPatch | null => (id === opts.presetId ? opts.patch : null);
  const features: GeoJSON.Feature[] = [];
  const used = new Map<string, { base: string; patch?: PresetPatch; name?: string }>();

  function end(lngLat: [number, number], kv: number): RouteEnd {
    if (opts.snapKm === null || !opts.index) return { lngLat, hit: null };
    const hit = snapAt(opts.index, lngLat, kv, opts.snapKm).best;
    return hit ? { lngLat: hit.lngLat, hit } : { lngLat, hit: null };
  }

  async function shoot(picture: PictureId, view: CaptureView): Promise<{ jpeg?: Uint8Array; note?: string }> {
    await visible();
    check();
    const c = await capture(picture, view);
    check();
    return 'jpeg' in c ? { jpeg: c.jpeg } : { note: noteText(c.note) };
  }

  async function runRow(row: BatchRow, index: number): Promise<RowReport> {
    const rep: RowReport = { line: row.line, key: row.key, status: 'failed' };
    const id = methodId(row.method);
    if (!id) return { ...rep, reason: 'unknown method' };
    rep.method = id;
    const preset = presetOf(id);
    if (!preset) return { ...rep, reason: 'method not available' };
    const lineType = row.lineType ?? (opts.lineType in preset.line_types ? opts.lineType : Object.keys(preset.line_types)[0]);
    rep.lineType = lineType;
    if (!(lineType in preset.line_types)) return { ...rep, reason: 'unknown line type' };
    const kv = preset.line_types[lineType]?.kv.value ?? 500;
    const patch = patchFor(id);
    const inputs: RouteInputs = { a: end(row.a, kv), b: end(row.b, kv), lineType, presetId: id, patch };
    rep.a = inputs.a!;
    rep.b = inputs.b!;
    const pics = picturesOf(row.pictures ?? opts.pictures);
    const first = firstOverlayMode(pics);
    const req = requestFor(inputs, { patch, profile: true, alternatives: 0, surface: false }, first);
    if (typeof req === 'string') return { ...rep, reason: req };
    if (solver.loaded && req.uploads?.some((h) => !solver.loaded!(h))) return { ...rep, reason: UPLOAD_NOT_LOADED };
    const m = methodFor(id, patch);
    if (typeof m !== 'string' && !used.has(id)) {
      const c = opts.saved().find((x) => `custom:${x.id}` === id);
      used.set(id, { base: m.preset, ...(m.patch ? { patch: m.patch } : {}), ...(c ? { name: c.name } : {}) });
    }

    check();
    const out = await solver.route(req);
    check();
    if (!out.ok) return out.reason === CANCELLED ? { ...rep, status: 'cancelled', reason: CANCELLED } : { ...rep, reason: out.reason };
    let result: RouteResult = out.result;   // `out` is not read again: the RGBA dropped below is not kept alive
    const path = result.path.coordinates as [number, number][];
    const view: CaptureView = { bounds: boundsOf([path]), path };
    const shots = new Map<PictureId, PdfPicture & { code?: string }>();

    const route = await shoot('route', view);
    shots.set('route', { picture: 'route', caption: t('route.batch.pic.route'), ...route });
    for (const p of pics) {
      const mode = modeOf(p);
      if (!mode) continue;
      let img: WeightImage | undefined;
      let code: string | undefined;
      if (mode === first) {
        const w = result.weightImage;
        if (w && !('skipped' in w)) img = w;
        else code = w ? `skipped: ${w.skipped}` : 'no image';
      } else {
        const r = await solver.repaint({
          from: req.from, to: req.to, preset: req.preset, lineType: req.lineType, mode,
          ...(req.presetPatch ? { presetPatch: req.presetPatch } : {}), ...(req.uploads ? { uploads: req.uploads } : {}),
        });
        check();
        if (r.ok) img = r.result.image;
        else code = NO_WINDOW_REASONS.some((x) => r.reason.startsWith(x)) ? 'no-window' : `repaint failed: ${r.reason}`;
      }
      const shot = madeNote(code, img) ?? await shoot(p, img ? { ...view, overlay: img } : view);
      shots.set(p, { picture: p, caption: t(`route.batch.pic.${p}`), ...shot, ...(code ? { code } : {}), ...(img && shot.jpeg ? { legend: p === 'cause' ? causeLegend(img) : classLegend(mode === 'cost' ? 'cost' : 'route') } : {}) });
      img = undefined;
    }
    result.weightImage = undefined;   // the RGBA goes once its JPEGs are taken

    const alts = row.alternatives ?? opts.alternatives ?? 0;
    const wantSimilar = pics.includes('similar'), wantAlts = pics.includes('alternatives');
    let code2: string | undefined;
    if (alts > 0 || wantSimilar) {
      const req2 = requestFor(inputs, { patch, profile: false, alternatives: alts, surface: true });
      if (typeof req2 === 'string') code2 = req2;
      else {
        req2.altStretch = altStretch;
        const out2 = await solver.route(req2);
        check();
        if (out2.ok) {
          const { alternatives, surface, altFound, altSkipped } = out2.result;
          result = { ...result, alternatives, surface, altFound, altSkipped };
        } else if (out2.reason === CANCELLED) throw new Cancelled();
        else code2 = `solve 2 failed: ${out2.reason}`;
      }
    }
    if (wantSimilar) {
      const s = result.surface;
      const img = s && !('skipped' in s) ? s.image : undefined;
      const code = code2 ?? (s && 'skipped' in s ? `skipped: ${s.skipped}` : img ? undefined : 'no image');
      const shot = madeNote(code, img) ?? await shoot('similar', img ? { ...view, overlay: img } : view);
      shots.set('similar', { picture: 'similar', caption: t('route.batch.pic.similar'), ...shot, ...(code ? { code } : {}), ...(s && !('skipped' in s) && shot.jpeg ? { legend: similarLegend(s.bands) } : {}) });
    }
    if (wantAlts) {
      const lines = (result.alternatives ?? []).map((a) => a.path.coordinates as [number, number][]);
      const v: CaptureView = lines.length ? { bounds: boundsOf([path, ...lines]), path, alternatives: lines } : view;
      const code = alts === 0 ? 'no alternatives asked for' : code2 ?? (lines.length ? undefined : result.altSkipped ? `none: ${result.altSkipped}` : 'none found');
      const caption = code ? t('route.batch.pic.alternativesWhy', { why: reasonText(code) }) : t('route.batch.pic.alternatives');
      shots.set('alternatives', { picture: 'alternatives', caption, ...(await shoot('alternatives', v)), ...(code ? { code } : {}) });
    }
    result.surface = undefined;

    // Building/aviation observations and exact crossings, read once as the panel's "List crossings by name" does
    // (one 256 MiB budget per route in the worker); the band window is released first.
    let exact: RouteSession['exact'] = null, obsCode: string | undefined;
    if (solver.crossings) {
      solver.drop();
      const ex = await orCancel(solver.crossings({ polylines: [path.map(([lng, lat]) => albersForward(lng, lat))], lengthsMi: [result.lengthMi] }));
      check();
      if (ex.ok) exact = { ...ex.result, forPath: pathKey(result.path, result.lengthMi) };
      else obsCode = `observations: ${ex.reason}`;
    }

    const session: RouteSession = {
      inputs, status: { kind: 'result' }, result, resultInputs: inputs, previous: null, altsSolving: false, altsError: null,
      tab: 'summary', colour: 'cost', threshold: 0.1, showSurface: false, dollars, liveTuning: false, crossingKinds: [],
      altStretch, ...(opts.snapKm !== null ? { snapKm: opts.snapKm } : {}), highlight: [], exact,
    };
    const model = buildReportModel(session, fmtMoney, opts.date);
    if (!model) return { ...rep, reason: 'no report' };
    const ordered = pics.map((p) => shots.get(p)!).filter(Boolean);
    const pdf = await renderPdf(model, ordered.map(({ code: _code, ...pic }) => pic));
    check();
    const folder = `rows/${rowSlug(index + 1, row.key)}`;
    const files: [string, Uint8Array | string][] = [[`${folder}/report.pdf`, pdf], [`${folder}/cost.csv`, costFile(result, dollars)]];
    if (result.profile) files.push([`${folder}/crossings.csv`, BOM + crossingsCsv(result.profile.crossings, shownExact(session))]);
    for (const [p, d] of files) zip.add(p, d);
    features.push({
      type: 'Feature', geometry: { type: 'LineString', coordinates: path },
      properties: { line: row.line, key: row.key, folder, method: id, line_type: lineType, length_mi: result.lengthMi, total_usd_2025: Math.round(result.cost.total2025), optimality: result.optimality },
    });
    return {
      ...rep, status: 'ok', ...(obsCode ? { reason: obsCode } : {}), folder, lengthMi: result.lengthMi, total2025: result.cost.total2025, optimality: result.optimality,
      pictures: ordered.map((s) => ({ picture: s.picture, note: s.note ?? null, ...(s.code ? { code: s.code } : {}) })),
    };
  }

  async function run(): Promise<BatchOutcome> {
    if (!solver.acquire()) { capture.close(); return { status: 'busy', reason: 'busy', rows: [] }; }
    const reports: RowReport[] = [];
    let status: BatchOutcome['status'] = 'done', reason: string | undefined;
    let gated = false, largest = 0;
    try {
      const total = opts.rows.length;
      for (let i = 0; i < total; i++) {
        const row = opts.rows[i];
        let rep: RowReport;
        if (cancelled) rep = { line: row.line, key: row.key, status: 'cancelled', reason: CANCELLED };
        else if (status === 'stopped') rep = { line: row.line, key: row.key, status: 'skipped', reason: reason! };
        else if (gated && zip.bytes() + largest > ZIP_CAP_BYTES) { status = 'stopped'; reason = ZIP_CAP; rep = { line: row.line, key: row.key, status: 'skipped', reason }; }
        else {
          const before = zip.bytes();
          try { rep = await runRow(row, i); } catch (err) {
            rep = err instanceof Cancelled ? { line: row.line, key: row.key, status: 'cancelled', reason: CANCELLED }
              : { line: row.line, key: row.key, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
          }
          solver.drop();
          if (rep.status === 'ok') largest = Math.max(largest, zip.bytes() - before);
          if (!gated && rep.status === 'ok') {
            gated = true;
            if (zip.bytes() * total > ZIP_CAP_BYTES) { status = 'stopped'; reason = ZIP_CAP; }
          }
          if ((i + 1) % RECYCLE_EVERY === 0 && i + 1 < total && !cancelled) solver.recycle();
        }
        reports.push(rep);
        deps.onRow?.(rep, i + 1, total);
      }
      if (cancelled) { status = 'cancelled'; reason = CANCELLED; }
      const all = [...(opts.skipped ?? []).map((s): RowReport => ({ line: s.line, key: '', status: 'skipped', reason: s.reason, ...(s.params ? { params: s.params } : {}) })), ...reports]
        .sort((a, b) => a.line - b.line);
      zip.add('summary.csv', csvFile(all.map(summaryRow), SUMMARY_FIELDS));
      zip.add('routes.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
      zip.add('batch.json', JSON.stringify({
        options: {
          presetId: opts.presetId, lineType: opts.lineType, patch: opts.patch, snapKm: opts.snapKm, exactPoints: opts.snapKm === null,
          alternatives: opts.alternatives ?? 0, altStretch, pictures: picturesOf(opts.pictures), dollars,
        },
        snapKm: opts.snapKm,
        methods: Object.fromEntries(used),
        cube: opts.cube ?? 'unknown',
        commit: opts.commit ?? 'unknown',
        status, ...(reason ? { reason } : {}),
      }, null, 2));
      return { status, ...(reason ? { reason } : {}), rows: reports };
    } finally {
      try { capture.close(); } finally {
        try { solver.drop(); } finally { solver.release(); }
      }
    }
  }

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      solver.cancel();
      wake?.();
      onCancel?.();
    },
    done: run(),
  };
}
