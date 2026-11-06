// ─── Map API: the view, as calls a console or a model can make ───────────────
// Role: one function per thing the map chat may do (and the dev console's
//       window.tm, which re-exports these). Every call returns an Outcome —
//       {ok: true, result} | {ok: false, reason} — and never throws on bad input.
//       A call that changes the view commits the way a control does (docs/url-state.md):
//       one 'url:write', so the link updates and Undo takes it back — and each
//       call is its own undo step (undo.ts asOwnStep), so three quick calls are
//       three undos. A refused call changes nothing.
//         listLayers                         registry layers, on/off, queryable
//         setLayerVisible / setBasemap       layers and basemap
//         setWhere / setArea / setSelection  field conditions, the Area filter, the selection
//         setStyle / clearStyle              a layer's opacity / size / colour
//         undo / redo / reset                the view's history; Reset = applyView({}), which
//                                            also clears a template's county overlay (county-overlay.ts)
//         describe / query / count / aggregate   dataset-query.ts, read only
//         joinPoints / crossings             spatial-join.ts: points per polygon, polygons a line crosses; read only
//         runAnalysis                        model-written code over registry layers' rows, in the sandbox; read only
//         layerRows                          registry layers' rows as FeatureCollections of allowed fields (runAnalysis, the chat's canvas)
//         showTable                          opens the table drawer (session only)
//         copyToMyData                       a non-view write, apart from the committing calls: a new My Data layer
//                                            from a layer's features; no url:write, no undo step (undo.ts, chat trust model);
//                                            asks `confirm` on the rows it then copies; lazy copy-rows.js only
//         setCamera / fitTo                  the camera: never on the undo stack (undo.ts)
//         shareLink                          the link to this view
//         addService / removeService / listServices   linked GIS services: a library id adds with no
//                                            approval (vetted); a URL is approved for the session only
//                                            when the caller says the visitor confirmed it
//       fitTo({place}) sends the place name to the Esri geocoder; the map chat
//       asks the visitor before it calls it (agent/tools.ts `offPage`). Its
//       refusals are fixed text — "place search is off in this build", "place
//       search is unavailable", "no place found" — never the service's own.
//       Imports nothing from assets/agent/: this module can sit in the main
//       bundle while the tool schemas load with the chat chunk.
//
// Deps: state.js, state-bus.js (emit), registry (LAYERS, layerById), i18n (t),
//       visibility.js (setLayerVisibility),
//       style-overrides.js (setStyle, clearStyle), basemap.js (switchBasemap),
//       url-state-codec.js (BASEMAPS), url-state.js (currentHash),
//       view-state.js (applyView), county-overlay.js (clearCountyOverlay), undo.js (undo, redo, asOwnStep),
//       ui/panel-mirror.js (commitArea, commitSelection, commitWhere, syncPanel),
//       ui/table-open.js (openTable), ui/ui-geocoder.js (findPlaces, placeSearchOn),
//       dataset-query.js (describe, query, count, aggregate, allowedFields, Outcome), spatial-join.js (joinPoints, crossings),
//       sandbox/sandbox-host.js (runInSandbox; dynamic import), user-data/copy-fit.js (MAX_COPY_ITEMS, types),
//       user-data/copy-rows.js (copyMode, copyNoun, copyAvailable, copyRows; dynamic import only),
//       view-validate.js (selectionSize), services/service-spec.js (parseServiceUrl, validateServiceSpec,
//       validateStyle), services/service-hosts.js (isVetted), services/service-trust.js (isAllowed),
//       services/service-load.js (detectDrawKind),
//       src/registry/service-library.json (dynamic import).

import { state } from './state.js';
import { emit } from './state-bus.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { t } from '../src/i18n/index.js';
import { setLayerVisibility } from './visibility.js';
import { setStyle as setStyleRaw, clearStyle as clearStyleRaw } from './style-overrides.js';
import { switchBasemap } from './basemap.js';
import { BASEMAPS } from './url-state-codec.js';
import { currentHash } from './url-state.js';
import { applyView, addService as addServiceRaw, setServices, skipService } from './view-state.js';
import { clearCountyOverlay } from './county-overlay.js';
import { clearProximityMap } from './proximity/clear.js';
import {
  parseServiceUrl, validateServiceSpec, validateStyle, validateLinkedService, RASTER_KINDS, SERVICE_KINDS,
  type LinkedService, type ServiceKind, type ServiceStyle,
} from './services/service-spec.js';
import { isVetted } from './services/service-hosts.js';
import { isAllowed } from './services/service-trust.js';
import { detectDrawKind } from './services/service-load.js';
import { undo as undoRaw, redo as redoRaw, asOwnStep } from './undo.js';
import { commitArea, commitSelection, commitWhere, syncPanel } from './ui/panel-mirror.js';
import { openTable } from './ui/table-open.js';
import { findPlaces, placeSearchOn } from './ui/ui-geocoder.js';
import { describe, query, allowedFields, QUERY_MAX_ROWS, type Outcome } from './dataset-query.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { selectionSize, selectionIdsError, MAX_SELECTION_IDS } from '../src/registry/view-validate.js';
import { MAX_COPY_ITEMS, type CopyDownload } from './user-data/copy-fit.js';
import type { AreaFilter } from '../src/registry/area-filter.js';
import type { Selection, StyleOverride } from '../src/types.js';
import type { TableRequest } from './ui/ui-table.js';

export type { Outcome };

const ok = <T>(result: T): Outcome<T> => ({ ok: true, result });
const fail = <T = never>(reason: string): Outcome<T> => ({ ok: false, reason });
const NOT_READY = 'the map is still loading';

/** A setter's `string | null` (reason or success) as a committed Outcome. */
function committed<T>(err: string | null, result: T): Outcome<T> {
  return err ? fail(err) : ok(result);
}

/** Commit through a setter that does not emit 'url:write' itself. */
function commitWith(apply: () => string | null): string | null {
  return asOwnStep(() => {
    const err = apply();
    if (!err) emit('url:write');
    return err;
  });
}

export { BASEMAPS };

// ─── Layers and basemap ───────────────────────────────────────────────────────

export interface LayerInfo { id: string; title: string; group: string; on: boolean; queryable: boolean }

export function listLayers(): Outcome<LayerInfo[]> {
  return ok(LAYERS.map(l => ({
    id: l.id, title: t(l.titleKey), group: l.group,
    on: !!state.layerVisibility[l.id], queryable: !!l.dataset,
  })));
}

export function setLayerVisible(layerId: string, on: boolean): Outcome<{ id: string; on: boolean }> {
  if (!layerById(layerId)) return fail(`unknown layer "${layerId}"`);
  if (typeof on !== 'boolean') return fail('on must be true or false');
  if (!state.mapReady) return fail(NOT_READY);
  asOwnStep(() => setLayerVisibility(layerId, on));
  return ok({ id: layerId, on: !!state.layerVisibility[layerId] });
}

export function setBasemap(basemap: string): Outcome<{ basemap: string }> {
  if (!BASEMAPS.includes(basemap)) return fail(`unknown basemap "${basemap}"; one of ${BASEMAPS.join(', ')}`);
  if (!state.mapReady) return fail(NOT_READY);
  commitWith(() => { switchBasemap(basemap); return null; });
  syncPanel();
  return ok({ basemap });
}

// ─── Filters, area, selection, style ──────────────────────────────────────────

export function setWhere(layerId: string, conditions: Condition[]): Outcome<{ id: string; conditions: number }> {
  if (!state.mapReady) return fail(NOT_READY);
  const err = asOwnStep(() => commitWhere(layerId, conditions));
  return committed(err, { id: layerId, conditions: Array.isArray(conditions) ? conditions.length : 0 });
}

export function setArea(area: AreaFilter | null): Outcome<{ area: AreaFilter | null }> {
  if (!state.mapReady) return fail(NOT_READY);
  const err = asOwnStep(() => commitArea(area));
  return committed(err, { area: state.area });
}

export function setSelection(sel: Selection | null): Outcome<{ selected: number }> {
  if (!state.mapReady) return fail(NOT_READY);
  const err = asOwnStep(() => commitSelection(sel));
  return committed(err, { selected: selectionSize(state.sel?.ids) });
}

export function setStyle(layerId: string, override: StyleOverride): Outcome<{ id: string; style: StyleOverride }> {
  if (!state.mapReady) return fail(NOT_READY);
  const err = commitWith(() => setStyleRaw(layerId, override));
  return committed(err, { id: layerId, style: state.styleOverrides[layerId] ?? {} });
}

/** One layer's overrides, or every layer's when `layerId` is left out. */
export function clearStyle(layerId?: string): Outcome<{ cleared: string }> {
  if (layerId !== undefined && !layerById(layerId)) return fail(`unknown layer "${layerId}"`);
  if (!state.mapReady) return fail(NOT_READY);
  commitWith(() => { clearStyleRaw(layerId); return null; });
  return ok({ cleared: layerId ?? 'all' });
}

// ─── History ──────────────────────────────────────────────────────────────────

export function undo(): Outcome<{ done: boolean }> { return ok({ done: undoRaw() }); }
export function redo(): Outcome<{ done: boolean }> { return ok({ done: redoRaw() }); }

export function reset(): Outcome<{ done: true }> {
  if (!state.mapReady) return fail(NOT_READY);
  asOwnStep(() => applyView({}));
  clearCountyOverlay();
  clearProximityMap();
  return ok({ done: true });
}

// ─── Reading data ─────────────────────────────────────────────────────────────

export { describe, query, count, aggregate } from './dataset-query.js';
export { joinPoints, crossings } from './spatial-join.js';

// ─── Analysis: model-written code over registry layers ───────────────────────

const MAX_ANALYSIS_CODE = 20_000;
const MAX_ANALYSIS_INPUTS = 3;
export interface LayerInput { layer: string; where?: Condition[]; fields?: string[]; limit?: number }
export type AnalysisInput = LayerInput;
export interface LayerRows {
  /** layer id → its rows as a FeatureCollection of the layer's allowed fields. */
  fc: Record<string, GeoJSON.FeatureCollection>;
  inputs: { layer: string; rows: number; total: number }[];
  /** Layers read only in part: vector tiles (the loaded tiles) or capped at `limit`. */
  partial: string[];
  /** Why, per partial layer; absent when every layer was read whole. */
  reason?: string;
}
export interface AnalysisResult {
  value: unknown; ms: number;
  /** False when any input was capped or is a vector-tile layer (only the loaded tiles). */
  complete: boolean; reason?: string;
  inputs: { layer: string; rows: number; total: number }[];
}

/** Rows of up to `max` registry dataset layers as FeatureCollections carrying
 *  only each layer's allowed fields — what runAnalysis and the chat's canvas
 *  get. Services and My Data are not layers, so they are refused. */
export async function layerRows(inputs: LayerInput[], max: number): Promise<Outcome<LayerRows>> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > max) return fail(`give 1–${max} inputs`);
  const ids = new Set<string>();
  for (const i of inputs) {
    if (typeof i?.layer !== 'string') return fail('each input needs a layer id');
    if (ids.has(i.layer)) return fail(`"${i.layer}" is listed twice`);
    ids.add(i.layer);
    const d = describe(i.layer);
    if (!d.ok) return d;
    if (!d.result.queryable) return fail(d.result.reason);
    const bad = i.fields?.find(f => !allowedFields(i.layer).includes(f));
    if (bad !== undefined) return fail(`"${bad}" is not a field of "${i.layer}"`);
  }
  const fc: LayerRows['fc'] = {};
  const summary: LayerRows['inputs'] = [];
  const partial = new Set<string>();
  const reasons: string[] = [];
  for (const i of inputs) {
    const r = await query(i.layer, {
      limit: i.limit ?? QUERY_MAX_ROWS, fragments: true, ...(i.where?.length && { where: i.where }), ...(i.fields && { fields: i.fields }),
    });
    if (!r.ok) return r;
    const keep = new Set(i.fields ?? allowedFields(i.layer));
    fc[i.layer] = { type: 'FeatureCollection', features: r.result.rows.map(row => ({
      type: 'Feature', ...(row.id !== null && { id: row.id }), geometry: row.feature.geometry,
      properties: Object.fromEntries(Object.entries(row.props).filter(([k]) => keep.has(k))),
    })) };
    summary.push({ layer: i.layer, rows: r.result.rows.length, total: r.result.total });
    if (!r.result.complete) { partial.add(i.layer); if (r.result.reason) reasons.push(r.result.reason); }
    if (r.result.truncated) {
      partial.add(i.layer);
      reasons.push(`"${i.layer}" has ${r.result.total} matches; only the first ${r.result.rows.length} were read`);
    }
  }
  return ok({ fc, inputs: summary, partial: [...partial], ...(reasons.length && { reason: [...new Set(reasons)].join('; ') }) });
}

/** Run `code` in the analysis sandbox over rows of registry dataset layers
 *  (`input[layer]` is a FeatureCollection carrying only the layer's allowed
 *  fields; layerRows). */
export async function runAnalysis(code: string, inputs: AnalysisInput[], opts: { signal?: AbortSignal } = {}): Promise<Outcome<AnalysisResult>> {
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_ANALYSIS_CODE) return fail(`code must be 1–${MAX_ANALYSIS_CODE} characters`);
  const rows = await layerRows(inputs, MAX_ANALYSIS_INPUTS);
  if (!rows.ok) return rows;
  const { runInSandbox } = await import('./sandbox/sandbox-host.js');
  const run = await runInSandbox(code, rows.result.fc, opts);   // the runner stops the code at 10 s
  if (!run.ok) return run;
  const { reason } = rows.result;
  return ok({
    value: run.result.value, ms: run.result.ms, complete: !reason,
    ...(reason && { reason }), inputs: rows.result.inputs,
  });
}

export async function showTable(req: TableRequest): Promise<Outcome<{ layerId: string }>> {
  if (typeof req?.layerId !== 'string') return fail('layerId is required');
  const d = describe(req.layerId);
  if (!d.ok) return d;
  if (!d.result.queryable) return fail(d.result.reason);
  await openTable(req);
  return ok({ layerId: req.layerId });
}

// ─── Copy to My Data (a non-view write: no url:write, no undo step) ──────────

export interface CopyArgs { layerId: string; ids?: (string | number)[]; where?: Condition[]; area?: AreaFilter | null }
export interface CopyOpts {
  /** Above this many rows the copy asks `confirm` first; no confirm then means refused. Omitted: never asks. */
  confirmAbove?: number;
  confirm?: (n: number, layerName: string) => Promise<boolean>;
}
export interface CopyOutcome {
  outcome: 'copied' | 'download-offered'; n: number; total: number; simplified?: number; missing?: number; unread?: number; complete: boolean;
  reason?: 'too-large' | 'storage-full'; layerName: string; download?: CopyDownload;
}

const COPY_REFUSALS: Record<string, string> = {
  unavailable: 'full geometry for this layer is not available here', offline: 'the geometry files could not be reached',
  'not-found': 'a feature was not found in the geometry files', 'stale-build': 'the geometry files changed; try again',
  'too-many': `at most ${MAX_COPY_ITEMS} features at a time`, timeout: 'the geometry files timed out',
  'not-copyable': 'this layer has no copyable geometry', empty: 'nothing to copy',
  'too-large': "too large to copy (over 64 MB); the layer's download has the full data",
};

export async function copyToMyData(a: CopyArgs, opts: CopyOpts = {}): Promise<Outcome<CopyOutcome>> {
  if (typeof a?.layerId !== 'string') return fail('layerId is required');
  const d = describe(a.layerId);
  if (!d.ok) return d;
  if (!d.result.queryable) return fail(d.result.reason);
  const rowsMod = await import('./user-data/copy-rows.js');
  const mode = rowsMod.copyMode(a.layerId);
  if (mode === 'none') return fail('this layer has no copyable geometry');
  if (a.ids !== undefined) {
    if (Array.isArray(a.ids) && a.ids.length > MAX_SELECTION_IDS) return fail(`ids takes at most ${MAX_SELECTION_IDS}`);
    const err = selectionIdsError(a.layerId, a.ids);
    if (err) return fail(err);
  }
  if ((mode === 'full' || mode === 'point') && !state.layerVisibility[a.layerId]) return fail('turn the layer on first');
  if (!(await rowsMod.copyAvailable(a.layerId))) return fail('full geometry for this layer is not available here');
  // A bare request means what the map draws when the layer is on (as showTable does).
  const bare = !a.where && a.area === undefined && !a.ids;
  const drawn = bare && !!state.layerVisibility[a.layerId];
  const q = await query(a.layerId, {
    ids: a.ids, where: bare && !drawn ? state.where[a.layerId] : a.where,
    area: bare && !drawn ? state.area : a.area, asDrawn: drawn || undefined, limit: MAX_COPY_ITEMS + 1, scope: 'view',
  });
  if (!q.ok) return q;
  const { rows, total } = q.result;
  if (total > MAX_COPY_ITEMS) return fail(`${total} features match; at most ${MAX_COPY_ITEMS} can be copied at a time`);
  if (!rows.length) return fail('nothing matches');
  const layer = layerById(a.layerId)!;
  const layerName = t(rowsMod.copyNoun(a.layerId) === 'line' ? 'line.copyLayer' : 'table.copyLayer', { layer: t(layer.titleKey), n: rows.length.toLocaleString() });
  if (opts.confirmAbove !== undefined && rows.length > opts.confirmAbove) {
    if (!opts.confirm) return fail("needs the visitor's confirm");
    if (!(await opts.confirm(rows.length, layerName))) return fail('the visitor declined');
  }
  const r = await rowsMod.copyRows(a.layerId, rows, layerName, state.map?.getZoom());
  if (r.kind === 'refused') {
    const noPack = r.reason === 'too-large' && !Object.values(layer.downloads).some(Boolean);
    return fail(noPack ? 'too large to copy (over 64 MB); ask for fewer features' : COPY_REFUSALS[r.reason] ?? 'the copy was refused');
  }
  if (r.kind === 'download') {
    return ok({
      outcome: 'download-offered', n: r.n, total, complete: q.result.complete,
      reason: r.storageFull ? 'storage-full' : 'too-large', layerName, download: r,
      ...(r.simplified && { simplified: r.simplified }),
      ...(r.missing && { missing: r.missing }),
      ...(r.unread && { unread: r.unread }),
    });
  }
  return ok({
    outcome: 'copied', n: r.n, total, complete: q.result.complete, layerName,
    ...(r.simplified > 0 && { simplified: r.simplified }),
    ...(r.missing && { missing: r.missing }),
    ...(r.unread && { unread: r.unread }),
  });
}

// ─── Camera (session only: map.ts writes it to the link on moveend) ──────────

export interface CameraArgs { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function lngLatError(lng: unknown, lat: unknown): string | null {
  return num(lng, -180, 180) && num(lat, -85, 85) ? null : 'longitude must be -180..180 and latitude -85..85';
}

export function setCamera(cam: CameraArgs): Outcome<CameraArgs> {
  if (!cam || typeof cam !== 'object') return fail('camera must be an object');
  const { center, zoom, bearing, pitch } = cam;
  if (center !== undefined) {
    if (!Array.isArray(center) || center.length !== 2) return fail('center must be [longitude, latitude]');
    const err = lngLatError(center[0], center[1]);
    if (err) return fail(err);
  }
  if (zoom !== undefined && !num(zoom, 0, 22)) return fail('zoom must be 0..22');
  if (bearing !== undefined && !num(bearing, -360, 360)) return fail('bearing must be -360..360');
  if (pitch !== undefined && !num(pitch, 0, 85)) return fail('pitch must be 0..85');
  if (!state.mapReady || !state.map) return fail(NOT_READY);
  const view = Object.fromEntries(Object.entries({ center, zoom, bearing, pitch }).filter(([, v]) => v !== undefined));
  state.map.flyTo({ ...view, essential: true });
  return ok(view as CameraArgs);
}

export type Bbox = [number, number, number, number];   // west, south, east, north

/** Fit the camera to a bounding box, or to a place found by the geocoder. */
export async function fitTo(target: { bbox?: Bbox; place?: string }): Promise<Outcome<{ bbox?: Bbox; place?: string }>> {
  const { bbox, place } = target ?? {};
  if ((bbox === undefined) === (place === undefined)) return fail('give either bbox or place');
  if (bbox !== undefined) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return fail('bbox must be [west, south, east, north]');
    const err = lngLatError(bbox[0], bbox[1]) ?? lngLatError(bbox[2], bbox[3]);
    if (err) return fail(err);
    if (bbox[1] > bbox[3]) return fail('bbox south must not be north of its north');
    if (!state.mapReady || !state.map) return fail(NOT_READY);
    state.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, essential: true });
    return ok({ bbox });
  }
  const q = typeof place === 'string' ? place.trim() : '';
  if (q.length < 2 || q.length > 120) return fail('place must be 2 to 120 characters');
  if (!state.mapReady || !state.map) return fail(NOT_READY);
  if (!placeSearchOn()) return fail('place search is off in this build');
  let found;
  try { found = (await findPlaces(q, 1))[0]; } catch { return fail('place search is unavailable right now'); }
  if (!found) return fail(`no place found for "${q}"`);
  const e = found.extent;
  if (e) state.map.fitBounds([[e.xmin, e.ymin], [e.xmax, e.ymax]], { padding: 40, maxZoom: 16, essential: true });
  else state.map.flyTo({ center: [found.location.x, found.location.y], zoom: 10, essential: true });
  return ok({ place: found.address, ...(e && { bbox: [e.xmin, e.ymin, e.xmax, e.ymax] as Bbox }) });
}

// ─── Sharing ──────────────────────────────────────────────────────────────────

export function shareLink(): Outcome<{ url: string }> {
  const hash = currentHash();
  if (hash === null) return fail(NOT_READY);
  return ok({ url: `${location.origin}${location.pathname}#${hash}` });
}

// ─── Linked services ──────────────────────────────────────────────────────────

export interface AddServiceArgs {
  libraryId?: string; url?: string; kind?: ServiceKind; layer?: string; title?: string;
  color?: string; opacity?: number; draw?: 'fill' | 'line' | 'circle';
}
export interface ServiceInfo {
  id: string; title: string; host: string; kind: ServiceKind; visible: boolean; vetted: boolean; pending: boolean;
}

const serviceInfo = (s: LinkedService): ServiceInfo => ({
  id: s.id, title: s.title, host: s.host, kind: s.kind, visible: s.visible,
  vetted: isVetted(s.url, s.kind), pending: !isAllowed(s),
});

const newServiceId = () => {
  for (;;) {
    const id = 'sv' + Math.random().toString(36).slice(2, 10);
    if (!state.services.some(s => s.id === id)) return id;
  }
};

/** Add a linked service from the library (`libraryId`, vetted, no approval) or by URL.
 *  A URL is approved for the session only when `confirmed` says the visitor agreed to
 *  it (the tool path after its off-page confirm); otherwise it is added still pending
 *  unless its host is vetted. Every input goes through the link's validators. */
export async function addService(a: AddServiceArgs, opts: { confirmed?: boolean } = {}): Promise<Outcome<ServiceInfo>> {
  if (!a || typeof a !== 'object') return fail('arguments must be an object');
  if ((a.libraryId === undefined) === (a.url === undefined)) return fail('give either libraryId or url');
  if (!state.mapReady) return fail(NOT_READY);
  if (a.title !== undefined && (typeof a.title !== 'string' || a.title.length > 200)) return fail('title must be text of up to 200 characters');
  let svc: LinkedService;
  if (a.libraryId !== undefined) {
    const lib = (await import('../src/registry/service-library.json')).default as unknown as
      (Omit<LinkedService, 'id' | 'visible' | 'libraryId'> & { id: string })[];
    const e = typeof a.libraryId === 'string' ? lib.find(x => x.id === a.libraryId!.toLowerCase()) : undefined;
    if (!e) return fail(`unknown library id "${String(a.libraryId).slice(0, 64)}"`);
    const style = validateStyle({ ...e.style, ...(a.color !== undefined && { color: a.color }), ...(a.opacity !== undefined && { opacity: a.opacity }) });
    if (!style.ok) return fail(style.reason);
    svc = {
      id: newServiceId(), kind: e.kind, url: e.url, host: e.host, title: a.title ?? e.title, style: style.result,
      visible: true, libraryId: e.id, credit: e.credit,
      ...(e.layer !== undefined && { layer: e.layer }), ...(e.version && { version: e.version }),
    };
  } else {
    if (a.kind !== undefined && !SERVICE_KINDS.includes(a.kind)) return fail('unknown service kind');
    const p = parseServiceUrl(a.url as string, a.kind);
    if (!p.ok) return fail(p.reason);
    const spec = validateServiceSpec({ ...p.result, ...(a.layer !== undefined && { layer: a.layer }) });
    if (!spec.ok) return fail(spec.reason);
    const raster = RASTER_KINDS.has(spec.result.kind);
    let kind: ServiceStyle['kind'] = raster ? 'raster' : (a.draw ?? 'line');
    // Without `draw`, a vector service is drawn as its own geometry; the probe fetches, so only an allowed or confirmed URL.
    if (!raster && a.draw === undefined && (opts.confirmed || isAllowed(spec.result))) {
      const found = await detectDrawKind(spec.result);
      if (found === 'fill' || found === 'line' || found === 'circle') kind = found;
    }
    const style = validateStyle({
      kind, color: a.color ?? '#2b6cb0', opacity: a.opacity ?? 0.8,
      ...(kind === 'line' && { width: 2 }), ...(kind === 'circle' && { radius: 4 }),
    });
    if (!style.ok) return fail(style.reason);
    svc = { id: newServiceId(), ...spec.result, title: a.title ?? spec.result.host, style: style.result, visible: true, credit: spec.result.host };
  }
  const v = validateLinkedService(svc);
  if (!v.ok) return fail(v.reason);
  const err = asOwnStep(() => opts.confirmed && a.url !== undefined
    ? addServiceRaw(v.result)
    : setServices([...state.services, v.result]));
  return committed(err, serviceInfo(v.result));
}

export function removeService(id: string): Outcome<{ id: string }> {
  if (typeof id !== 'string') return fail('id must be text');
  if (!state.services.some(s => s.id === id)) return fail(`no linked service "${id.slice(0, 40)}"`);
  asOwnStep(() => skipService(id));
  return ok({ id });
}

export function listServices(): Outcome<ServiceInfo[]> {
  return ok(state.services.map(serviceInfo));
}
