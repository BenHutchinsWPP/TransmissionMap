// ─── Route worker opener (main-bundle safe) ───────────────────────────────────
// Role: routeLine(req, onProgress?) runs one route in the route worker and resolves with its
//       Outcome. The worker starts on the first call and is reused; replies are
//       matched to calls by id. A worker that fails (error, a reply that cannot
//       be deserialised, or a call unanswered after its timeout: ROUTE_TIMEOUT_MS, plus
//       SURFACE_TIMEOUT_MS with the similar-cost areas and ALT_TIMEOUT_MS per possible
//       alternative re-solve, 2 per alternative asked for) is
//       recorded and terminated, its pending calls resolve as refusals, and the
//       next call starts a fresh one.
//       Progress messages {id, progress} go to the call's onProgress and neither
//       resolve it nor clear its timeout. cancelRoute() terminates the worker and
//       resolves every pending call as 'cancelled' (not a fault: nothing recorded);
//       with nothing pending it leaves the worker, and its caches, alone.
//       inspectCell(req) asks the same worker for one cell (route.ts inspect()); it is
//       not a solve: cancelRoute counts and cancels it only alongside one, and a reply
//       later than INSPECT_TIMEOUT_MS resolves as a refusal without failing the worker.
//       repaintWeight(req) asks it to repaint the cell-weight overlay from the last solve's held
//       band window (route.ts repaint()), handled like inspectCell (REPAINT_TIMEOUT_MS);
//       repaintRows(req) asks it for the Method grid's highlighted rows over the same window (route.ts repaintRows()),
//       handled alike (REPAINT_TIMEOUT_MS);
//       exactCrossings(req) asks it for the exact crossings of up to 4 polylines (the panel sends the shown route)
//       (route.ts exactRouteCrossings(), on demand), handled like inspectCell (CROSSINGS_TIMEOUT_MS,
//       above the worker's own 30 s read budget).
//       dropWindow() tells a running worker to release that window (starts none).
//       Uploaded layers: the pane owns the geometry; registerUpload(hash, geometry) keeps a reference
//       here and posts {upload: {hash, geometry}} to a running worker, unregisterUpload(hash) forgets it
//       and posts {unupload: hash}. getWorker() posts every registered upload, in registration order, to
//       each new worker before any other message (a worker handles messages in order), so a Cancel, a
//       failed worker or a recycle never loses one. Requests name uploads by hash only.
//       The solver lock: every call takes an owner token (default 'panel'). acquireRoute(owner) takes the
//       worker for that owner (refused while anyone holds it, the same token too, or a solve is pending); while it is held, a call
//       from any other owner resolves {ok: false, reason: 'busy'} (dropWindow: no-op; cancelRoute: false), and
//       with no holder only 'panel' calls pass. releaseRoute(owner) frees it, then applies the unregisterUpload calls made meanwhile (deferred
//       while a non-panel owner holds the lock; a register of the same hash cancels one); hasUpload(hash) says whether a layer is held. recycleWorker(owner) terminates an
//       idle worker so the next call starts a fresh one (the batch's recycle; registered uploads re-posted).
//       Data: DATA.route_cube (relative to the page's base URL in dev, the data host's versioned prefix in a build).
// Deps: diag-log.ts; constants.ts (DATA.route_cube); route-worker.ts (worker entry); route.ts, upload-layer.ts and
//       dataset-query.ts (types only).

import type { Outcome } from '../dataset-query.js';
import type { ExactCrossingsRequest, ExactCrossingsResult, InspectRequest, InspectResult, RepaintRequest, RepaintResult, RepaintRowsRequest, RowsImage, RouteRequest, RouteResult, RouteStep } from './route.js';
import type { UploadGeometry } from './upload-layer.js';
import { recordDiagEvent } from '../diag-log.js';
import { DATA } from '../constants.js';

const ROUTE_DATA = DATA.route_cube;
/** Who may use the worker while no lock is held. */
export const PANEL_OWNER = 'panel';
export const BUSY = 'busy';
const ROUTE_TIMEOUT_MS = 180_000;
const SURFACE_TIMEOUT_MS = 60_000;
const ALT_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 10_000;
const REPAINT_TIMEOUT_MS = 10_000;
const CROSSINGS_TIMEOUT_MS = 40_000;

type Reply = (o: Outcome<RouteResult>) => void;
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { reply: Reply; timer: ReturnType<typeof setTimeout>; onProgress?: (s: RouteStep) => void }>();
/** Uploaded layers to post to every worker, in registration order (the pane owns them). */
const uploads = new Map<string, UploadGeometry>();
/** The owner holding the solver lock, or null. */
let holder: string | null = null;
/** Unregisters asked for while a non-panel owner held the lock; applied on release. */
const deferred = new Set<string>();
const allowed = (owner: string): boolean => (holder === null ? owner === PANEL_OWNER : holder === owner);
const busy = <T>(): Promise<Outcome<T>> => Promise.resolve({ ok: false, reason: BUSY });

/** Takes the worker for `owner`: false while anyone (the same token too) holds it or a solve is pending. */
export function acquireRoute(owner: string): boolean {
  if (holder !== null || pending.size > 0) return false;
  holder = owner;
  return true;
}

/** Frees the lock if `owner` holds it. */
export function releaseRoute(owner: string): void {
  if (holder !== owner) return;
  holder = null;
  for (const hash of deferred) if (uploads.delete(hash)) worker?.postMessage({ unupload: hash });
  deferred.clear();
}

/** Calls that are not solves (inspect, repaint), by id. */
const inspects = new Map<number, { reply: (o: Outcome<never>) => void; timer: ReturnType<typeof setTimeout> }>();

/** Resolves every pending inspect / repaint call with `reason`. */
function refuseInspects(reason: string): void {
  for (const { reply, timer } of inspects.values()) { clearTimeout(timer); reply({ ok: false, reason }); }
  inspects.clear();
}

/** Records the failure, refuses every pending call and drops the worker. */
function failWorker(w: Worker, reason: string): void {
  recordDiagEvent('layer', reason);
  for (const { reply, timer } of pending.values()) { clearTimeout(timer); reply({ ok: false, reason }); }
  pending.clear();
  refuseInspects(reason);
  w.terminate();
  if (worker === w) worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; outcome?: Outcome<RouteResult>; progress?: RouteStep }>) => {
    const { id, outcome, progress } = e.data;
    const q = inspects.get(id);
    if (q && outcome) {
      clearTimeout(q.timer);
      inspects.delete(id);
      q.reply(outcome as Outcome<never>);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    if (progress !== undefined) { p.onProgress?.(progress); return; }
    if (!outcome) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reply(outcome);
  };
  w.onerror = (e) => failWorker(w, `route worker failed: ${e.message || 'could not start'}`);
  w.onmessageerror = () => failWorker(w, 'route worker failed: a reply could not be read');
  for (const [hash, geometry] of uploads) w.postMessage({ upload: { hash, geometry } });
  return (worker = w);
}

/** Keeps an uploaded layer for every route worker (posted now to a running one, and to each new one first). */
export function registerUpload(hash: string, geometry: UploadGeometry): void {
  deferred.delete(hash);
  if (uploads.has(hash)) return;
  uploads.set(hash, geometry);
  worker?.postMessage({ upload: { hash, geometry } });
}

/** Whether an uploaded layer is registered. */
export const hasUpload = (hash: string): boolean => uploads.has(hash);

/** Forgets an uploaded layer: no new worker gets it, and a running one drops it. While a non-panel owner
 *  holds the lock the removal waits for its release. */
export function unregisterUpload(hash: string): void {
  if (holder !== null && holder !== PANEL_OWNER) { if (uploads.has(hash)) deferred.add(hash); return; }
  if (uploads.delete(hash)) worker?.postMessage({ unupload: hash });
}

export function routeLine(req: RouteRequest, onProgress?: (s: RouteStep) => void, owner = PANEL_OWNER): Promise<Outcome<RouteResult>> {
  if (!allowed(owner)) return busy();
  return new Promise((resolve) => {
    const id = ++nextId;
    const w = getWorker();
    const alts = typeof req.alternatives === 'number' && req.alternatives > 0 ? Math.min(req.alternatives, 3) : 0;
    const ms = ROUTE_TIMEOUT_MS + (req.surface === true ? SURFACE_TIMEOUT_MS : 0) + 2 * alts * ALT_TIMEOUT_MS;
    const timer = setTimeout(() => failWorker(w, `route worker failed: no answer in ${ms / 1000} s`), ms);
    pending.set(id, { reply: resolve, timer, onProgress });
    w.postMessage({ id, req, baseUrl: new URL(ROUTE_DATA, document.baseURI).href });
  });
}

/** One side call (not a solve): resolves with the worker's outcome, or a refusal after `ms` (the worker is kept). */
function side<T>(msg: Record<string, unknown>, ms: number, owner: string): Promise<Outcome<T>> {
  if (!allowed(owner)) return busy();
  return new Promise((resolve) => {
    const id = ++nextId;
    const w = getWorker();
    const timer = setTimeout(() => {
      inspects.delete(id);
      resolve({ ok: false, reason: `no answer in ${ms / 1000} s` });
    }, ms);
    inspects.set(id, { reply: resolve as (o: Outcome<never>) => void, timer });
    w.postMessage({ id, ...msg, baseUrl: new URL(ROUTE_DATA, document.baseURI).href });
  });
}

/** One cell's bands and weight explanation, from the route worker (started if needed). */
export function inspectCell(req: InspectRequest, owner = PANEL_OWNER): Promise<Outcome<InspectResult>> {
  return side({ inspect: req }, INSPECT_TIMEOUT_MS, owner);
}

/** The cell-weight overlay repainted from the last solve's held window; 'no cached window' without one. */
export function repaintWeight(req: RepaintRequest, owner = PANEL_OWNER): Promise<Outcome<RepaintResult>> {
  return side({ repaint: req }, REPAINT_TIMEOUT_MS, owner);
}

/** The highlighted Method rows painted over the last solve's held window; refusals as route.ts NO_WINDOW_REASONS. */
export function repaintRows(req: RepaintRowsRequest, owner = PANEL_OWNER): Promise<Outcome<{ image: RowsImage }>> {
  return side({ repaintRows: req }, REPAINT_TIMEOUT_MS, owner);
}

/** Exact crossings of the given EPSG:5070 polylines, from the route worker (started if needed). */
export function exactCrossings(req: ExactCrossingsRequest, owner = PANEL_OWNER): Promise<Outcome<ExactCrossingsResult>> {
  return side({ crossings: req }, CROSSINGS_TIMEOUT_MS, owner);
}

/** Releases the worker's held band window (no-op without a worker). */
export function dropWindow(owner = PANEL_OWNER): void {
  if (!allowed(owner)) return;
  worker?.postMessage({ id: ++nextId, drop: true });
}

/** Stops the running solve: true if a call was pending (its worker is terminated). */
export function cancelRoute(owner = PANEL_OWNER): boolean {
  if (!allowed(owner) || pending.size === 0) return false;
  for (const { reply, timer } of pending.values()) { clearTimeout(timer); reply({ ok: false, reason: 'cancelled' }); }
  pending.clear();
  refuseInspects('cancelled');
  worker?.terminate();
  worker = null;
  return true;
}

/** Terminates an idle worker so the next call starts a fresh one (which gets every registered upload first);
 *  false for a non-owner or while a call is pending. */
export function recycleWorker(owner = PANEL_OWNER): boolean {
  if (!allowed(owner) || pending.size > 0 || inspects.size > 0) return false;
  worker?.terminate();
  worker = null;
  return true;
}
