// assets/services/service-load.ts — fetches a linked service's features and
// keeps each service's load status. Raster kinds fetch nothing here (MapLibre
// reads their tile template). A GeoJSON URL is fetched once (20 MB, 20 s). An
// ArcGIS feature layer is queried for the current view in EPSG:4326: its layer
// info first (5 s, 2 MB: geometry type, maxRecordCount, paging, f=geojson),
// then up to 10 pages of min(maxRecordCount, 2,000) features, simplified on
// the server to the view's scale (maxAllowableOffset, geometryPrecision) (paging also
// ends on a short page, or on a page whose first object id repeats the last
// page's — a server that ignores resultOffset), again on every
// settled move (moveend, 400 ms debounce); below the style's minzoom (default
// 8) the source is emptied instead. A response that lands after a newer
// request is dropped. Every response is checked for the ArcGIS error envelope
// (an HTTP 200 carrying `{"error":…}`); a token error is a sign-in refusal.
// Esri JSON polygons (a layer without f=geojson) convert by ring winding only: a
// counter-clockwise ring (a hole) attaches to the outer ring before it, with no
// containment test, so a hole listed after an unrelated outer ring lands in the
// wrong polygon. Good enough to draw; never used for analysis.
// Status (loading / ok / truncated / zoom-in / error / pending-approval) lives
// in a module map the UI reads through serviceStatus / onServiceStatus.
// Deps: state.ts (state.map), service-spec.ts (types), dataset-query.ts
//       (Outcome, type only), src/i18n (t).
import type { GeoJSONSource } from 'maplibre-gl';
import { state } from '../state.js';
import { t } from '../../src/i18n/index.js';
import type { Outcome } from '../dataset-query.js';
import { SERVICE_LAYER_PREFIX, type LinkedService, type ServiceSpec, type ServiceStyle } from './service-spec.js';

export const META_MAX_BYTES = 2 * 1024 * 1024;
export const META_TIMEOUT_MS = 5000;
export const DATA_MAX_BYTES = 20 * 1024 * 1024;
export const DATA_TIMEOUT_MS = 20000;
export const PAGE_SIZE_MAX = 2000;
export const MAX_PAGES = 10;
export const DEFAULT_FEATURE_MINZOOM = 8;
export const MOVE_DEBOUNCE_MS = 400;

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };
const fail = <T>(reason: string): Outcome<T> => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ─── status ──────────────────────────────────────────────────────────────────

export type ServiceStatus =
  | { state: 'loading' }
  | { state: 'ok'; count?: number }
  | { state: 'truncated'; count: number }
  | { state: 'zoom-in'; minzoom: number }
  | { state: 'error'; message: string }
  | { state: 'pending-approval' };

const statuses = new Map<string, ServiceStatus>();
const listeners = new Set<(id: string, status: ServiceStatus | undefined) => void>();

export function serviceStatus(id: string): ServiceStatus | undefined { return statuses.get(id); }

/** Called with (id, status) on every change; `undefined` = the service is gone. Returns the unsubscribe. */
export function onServiceStatus(fn: (id: string, status: ServiceStatus | undefined) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setServiceStatus(id: string, status: ServiceStatus | undefined): void {
  if (JSON.stringify(status) === JSON.stringify(statuses.get(id))) return;
  if (status) statuses.set(id, status); else statuses.delete(id);
  for (const fn of listeners) fn(id, status);
}

/** The row text for a status ('' when there is nothing to say). */
export function serviceStatusText(s: ServiceStatus | undefined): string {
  switch (s?.state) {
    case 'loading': return t('services.status.loading');
    case 'truncated': return t('services.status.truncated', { count: s.count });
    case 'zoom-in': return t('services.status.zoomIn');
    case 'pending-approval': return t('services.status.pending');
    case 'error': return s.message;
    default: return '';
  }
}

// ─── capped fetch ────────────────────────────────────────────────────────────

const ABORTED = 'aborted';

/** GET `url` as text: aborted after `timeoutMs`, refused past `maxBytes` (counted as it streams). */
export async function fetchText(url: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Outcome<string>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) return fail(t('services.err.http', { status: res.status }));
    if (Number(res.headers.get('content-length')) > maxBytes) { ctl.abort(); return fail(t('services.err.tooLarge')); }
    if (!res.body) {
      const text = await res.text();
      return text.length > maxBytes ? fail(t('services.err.tooLarge')) : { ok: true, result: text };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { void reader.cancel().catch(() => {}); ctl.abort(); return fail(t('services.err.tooLarge')); }
      text += dec.decode(value, { stream: true });
    }
    return { ok: true, result: text + dec.decode() };
  } catch {
    if (signal?.aborted) return fail(ABORTED);
    return fail(ctl.signal.aborted ? t('services.err.timeout') : t('services.err.network'));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The ArcGIS error envelope, if `json` is one: token errors (498/499) become the sign-in refusal. */
export function envelopeError(json: unknown): string | null {
  if (!isObj(json) || !isObj(json.error)) return null;
  const { code, message, details } = json.error;
  const text = [message, ...(Array.isArray(details) ? details : [])].filter(x => typeof x === 'string').join(' ');
  if (code === 498 || code === 499 || /token required|invalid token/i.test(text)) return t('services.err.signIn');
  return t('services.err.server', { message: (text || String(code ?? '')).slice(0, 200) });
}

/** fetchText + JSON.parse + the error envelope. */
export async function fetchJson(url: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Outcome<unknown>> {
  const r = await fetchText(url, maxBytes, timeoutMs, signal);
  if (!r.ok) return r;
  let json: unknown;
  try { json = JSON.parse(r.result); } catch { return fail(t('services.err.badData')); }
  const env = envelopeError(json);
  return env ? fail(env) : { ok: true, result: json };
}

// ─── ArcGIS ──────────────────────────────────────────────────────────────────

export interface ArcgisLayerInfo {
  geometryType: string;
  maxRecordCount: number;
  paginate: boolean;
  geojson: boolean;
  objectIdField: string;
}

const infoCache = new Map<string, Promise<Outcome<ArcgisLayerInfo>>>();

/** The layer's `?f=json` info, cached per layer URL for the session (failures are not cached). */
export function arcgisLayerInfo(spec: ServiceSpec, signal?: AbortSignal): Promise<Outcome<ArcgisLayerInfo>> {
  const url = `${spec.url}/${spec.layer ?? 0}`;
  let p = infoCache.get(url);
  if (!p) {
    p = fetchJson(url + '?f=json', META_MAX_BYTES, META_TIMEOUT_MS, signal).then(r => {
      if (!r.ok) return r;
      const j = r.result as Record<string, unknown>;
      if (!isObj(j) || typeof j.geometryType !== 'string') return fail<ArcgisLayerInfo>(t('services.err.notFeatureLayer'));
      const max = typeof j.maxRecordCount === 'number' && j.maxRecordCount > 0 ? j.maxRecordCount : PAGE_SIZE_MAX;
      const adv = isObj(j.advancedQueryCapabilities) ? j.advancedQueryCapabilities : {};
      return { ok: true as const, result: {
        geometryType: j.geometryType,
        maxRecordCount: max,
        paginate: adv.supportsPagination === true,
        geojson: typeof j.supportedQueryFormats === 'string' && /(^|,)\s*geojson\s*(,|$)/i.test(j.supportedQueryFormats),
        objectIdField: typeof j.objectIdField === 'string' ? j.objectIdField : 'OBJECTID',
      } };
    });
    infoCache.set(url, p);
    void p.then(r => { if (!r.ok && infoCache.get(url) === p) infoCache.delete(url); });
  }
  return p;
}

function geometryKind(type: string): ServiceStyle['kind'] | null {
  if (/point/i.test(type)) return 'circle';
  if (/line/i.test(type)) return 'line';
  if (/polygon|envelope/i.test(type)) return 'fill';
  return null;
}

/** What a feature service draws (fetches the service, so call it only for an allowed URL): the layer's geometry type or a GeoJSON file's first geometry. */
export async function detectDrawKind(s: ServiceSpec): Promise<ServiceStyle['kind'] | string> {
  if (s.kind === 'arcgis-feature') {
    const r = await arcgisLayerInfo(s);
    return r.ok ? geometryKind(r.result.geometryType) ?? t('services.err.geometry') : r.reason;
  }
  const r = await fetchJson(s.url, DATA_MAX_BYTES, DATA_TIMEOUT_MS);
  if (!r.ok) return r.reason;
  const j = r.result as { type?: string; features?: { geometry?: { type?: string } }[]; geometry?: { type?: string } };
  const type = j.features?.find(f => f?.geometry?.type)?.geometry?.type ?? j.geometry?.type ?? j.type;
  return (typeof type === 'string' && geometryKind(type)) || t('services.err.geometry');
}

type Pos = number[];
const signedArea = (ring: Pos[]) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[i][0] - ring[j][0]) * (ring[i][1] + ring[j][1]);
  return s; // > 0: clockwise (an Esri outer ring)
};

/** One Esri JSON geometry → GeoJSON (null when absent or unknown). Holes join the outer ring before them. */
export function esriGeometry(g: unknown): GeoJSON.Geometry | null {
  if (!isObj(g)) return null;
  if (typeof g.x === 'number' && typeof g.y === 'number') return { type: 'Point', coordinates: [g.x, g.y] };
  if (Array.isArray(g.points)) return { type: 'MultiPoint', coordinates: g.points as Pos[] };
  if (Array.isArray(g.paths)) {
    const paths = g.paths as Pos[][];
    return paths.length === 1 ? { type: 'LineString', coordinates: paths[0] } : { type: 'MultiLineString', coordinates: paths };
  }
  if (Array.isArray(g.rings)) {
    const polys: Pos[][][] = [];
    for (const ring of g.rings as Pos[][]) {
      if (signedArea(ring) >= 0 || !polys.length) polys.push([ring]);
      else polys[polys.length - 1].push(ring);
    }
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  return null;
}

/** An Esri JSON query response's features → GeoJSON features (attributes become properties). */
export function esriToFeatures(json: unknown): GeoJSON.Feature[] | null {
  if (!isObj(json) || !Array.isArray(json.features)) return null;
  const out: GeoJSON.Feature[] = [];
  for (const f of json.features) {
    if (!isObj(f)) continue;
    const geometry = esriGeometry(f.geometry);
    if (geometry) out.push({ type: 'Feature', properties: isObj(f.attributes) ? f.attributes : {}, geometry });
  }
  return out;
}

export type Bbox = [number, number, number, number];

/** The features of an ArcGIS layer in `bbox` (west, south, east, north in 4326), paged; `truncated` when the page cap stopped it. */
export async function loadArcgisFeatures(spec: ServiceSpec, bbox: Bbox, signal?: AbortSignal): Promise<Outcome<{ features: GeoJSON.Feature[]; truncated: boolean }>> {
  const info = await arcgisLayerInfo(spec, signal);
  if (!info.ok) return info;
  const { paginate, geojson, objectIdField } = info.result;
  const pageSize = Math.min(info.result.maxRecordCount, PAGE_SIZE_MAX);
  const features: GeoJSON.Feature[] = [];
  const firstId = (fs: GeoJSON.Feature[]) => fs[0]?.id ?? fs[0]?.properties?.[objectIdField] ?? undefined;
  let lastFirst: unknown;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      where: '1=1',
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outSR: '4326',
      outFields: '*',
      returnGeometry: 'true',
      // Simplified on the server to about half a screen pixel of a ~2,000 px
      // wide view, coordinates to 5 decimals (~1 m): the page cap then holds
      // far more of a detailed polygon layer.
      maxAllowableOffset: String((bbox[2] - bbox[0]) / 4000),
      geometryPrecision: '5',
      f: geojson ? 'geojson' : 'json',
    });
    if (paginate) { q.set('resultOffset', String(features.length)); q.set('resultRecordCount', String(pageSize)); }
    const r = await fetchJson(`${spec.url}/${spec.layer ?? 0}/query?${q}`, DATA_MAX_BYTES, DATA_TIMEOUT_MS, signal);
    if (!r.ok) return r;
    const j = r.result as Record<string, unknown>;
    const got = geojson
      ? (isObj(j) && Array.isArray(j.features) ? j.features as GeoJSON.Feature[] : null)
      : esriToFeatures(j);
    if (!got) return fail(t('services.err.badData'));
    const first = firstId(got);
    if (page > 0 && first !== undefined && first === lastFirst) break;
    lastFirst = first;
    features.push(...got);
    const exceeded = j.exceededTransferLimit === true || (isObj(j.properties) && j.properties.exceededTransferLimit === true);
    if (!exceeded || !got.length) return { ok: true, result: { features, truncated: false } };
    if (!paginate || got.length < pageSize) break;
  }
  return { ok: true, result: { features, truncated: true } };
}

/** A fetched GeoJSON document → a FeatureCollection (a lone Feature is wrapped), or null. */
function asCollection(json: unknown): FC | null {
  if (!isObj(json)) return null;
  if (json.type === 'FeatureCollection' && Array.isArray(json.features)) return json as unknown as FC;
  if (json.type === 'Feature') return { type: 'FeatureCollection', features: [json as unknown as GeoJSON.Feature] };
  return null;
}

// ─── per-service loaders ─────────────────────────────────────────────────────

interface Loader { service: LinkedService; seq: number; ctl: AbortController | null; loaded: boolean }
const loaders = new Map<string, Loader>();

function setData(id: string, fc: FC) {
  (state.map?.getSource(SERVICE_LAYER_PREFIX + id) as GeoJSONSource | undefined)?.setData(fc);
}

let hookedMap: unknown = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
function hookMoves() {
  const map = state.map;
  if (!map || hookedMap === map) return;
  hookedMap = map;
  map.on('moveend', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moveTimer = null;
      for (const l of loaders.values()) if (l.service.kind === 'arcgis-feature') void refresh(l);
    }, MOVE_DEBOUNCE_MS);
  });
}

function viewBbox(): Bbox {
  const b = state.map!.getBounds();
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)];
}

async function refresh(l: Loader): Promise<void> {
  const s = l.service;
  const id = s.id;
  if (!state.map || !s.visible || loaders.get(id) !== l) return;
  if (s.kind === 'geojson' && l.loaded) return;
  l.ctl?.abort();
  const seq = ++l.seq;
  const live = () => loaders.get(id) === l && l.seq === seq;
  if (s.kind === 'arcgis-feature') {
    const minzoom = s.style.minzoom ?? DEFAULT_FEATURE_MINZOOM;
    if (state.map.getZoom() < minzoom) {
      l.ctl = null;
      setData(id, EMPTY);
      setServiceStatus(id, { state: 'zoom-in', minzoom });
      return;
    }
  }
  const ctl = l.ctl = new AbortController();
  setServiceStatus(id, { state: 'loading' });
  if (s.kind === 'geojson') {
    const r = await fetchJson(s.url, DATA_MAX_BYTES, DATA_TIMEOUT_MS, ctl.signal);
    if (!live()) return;
    l.ctl = null;
    const fc = r.ok ? asCollection(r.result) : null;
    if (!r.ok || !fc) { setServiceStatus(id, { state: 'error', message: r.ok ? t('services.err.badData') : r.reason }); return; }
    l.loaded = true;
    setData(id, fc);
    setServiceStatus(id, { state: 'ok', count: fc.features.length });
    return;
  }
  const r = await loadArcgisFeatures(s, viewBbox(), ctl.signal);
  if (!live()) return;
  l.ctl = null;
  if (!r.ok) { setServiceStatus(id, { state: 'error', message: r.reason }); return; }
  const { features, truncated } = r.result;
  setData(id, { type: 'FeatureCollection', features });
  setServiceStatus(id, truncated ? { state: 'truncated', count: features.length } : { state: 'ok', count: features.length });
}

/**
 * Start (or keep up to date) the loading of a feature service whose source is
 * on the map. `reload` refetches from scratch (the URL or layer changed).
 * Returns the refresh in flight, for tests.
 */
export function loadService(s: LinkedService, reload = false): Promise<void> {
  if (s.kind !== 'geojson' && s.kind !== 'arcgis-feature') {
    setServiceStatus(s.id, { state: 'ok' });
    return Promise.resolve();
  }
  let l = loaders.get(s.id);
  if (!l || reload) {
    l?.ctl?.abort();
    l = { service: s, seq: 0, ctl: null, loaded: false };
    loaders.set(s.id, l);
  }
  l.service = s;
  if (s.kind === 'arcgis-feature') hookMoves();
  return refresh(l);
}

/** Hand a running loader the service's current copy (visibility, minzoom)
 *  without fetching; the next settled move reads it. False when none runs. */
export function keepService(s: LinkedService): boolean {
  const l = loaders.get(s.id);
  if (l) l.service = s;
  return !!l;
}

/** Stop loading a service: an in-flight request is aborted and its answer dropped. */
export function unloadService(id: string): void {
  const l = loaders.get(id);
  l?.ctl?.abort();
  loaders.delete(id);
}
