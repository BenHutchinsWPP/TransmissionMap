// assets/services/service-spec.ts — the contract for a linked GIS service:
// what a service is (ServiceSpec, LinkedService), how it looks (ServiceStyle),
// how a pasted URL becomes one (parseServiceUrl, which sniffs the kind from
// the path alone — no network; normaliseServiceUrl is its url + layer), the trust-boundary checks
// a link, a view file or a model's arguments pass through (validateServiceSpec,
// validateStyle, validateLinkedService(s)), and the one compiler from a
// validated service to MapLibre source + layer specs (styleToLayers).
//
// Kinds: geojson · arcgis-feature (FeatureServer / MapServer layer, queried as
// GeoJSON by the renderer) · arcgis-export (MapServer export as raster tiles) ·
// arcgis-image (ImageServer exportImage) · wms (GetMap in EPSG:3857) · xyz
// ({z}/{x}/{y} templates; WMTS-REST GoogleMapsCompatible rewritten to one) ·
// pmtiles-raster.
//
// Stored URLs are normalised: https only, origin + path, query and fragment
// dropped; an ArcGIS `/{n}`, `/query`, `/export`, `/exportImage` tail folds into
// the service root and the `layer` field (`/<instance>/rest/services` is
// lower-cased; org ids and service names keep their case); a WMS `LAYERS` param moves to `layer`.
// Refused: a URL carrying a sign-in or key param (`token`, `access_token`,
// `api_key`, `apikey`, `key`), a MapServer export whose `layers` is not
// `show:N`, and any URL whose kind cannot be told or whose ArcGIS tail is
// malformed, so a normalised URL always validates.
//
// validateLinkedServices checks a whole list and fails it on one bad entry; its
// 3,000-character cap measures the LinkedService JSON, not the link's `sv`
// form. Link decode validates each entry with validateLinkedService (dropping a
// bad one, not the section) and applies the `sv` cap to the link form itself.
// A style never carries a raw MapLibre expression: styleToLayers builds every
// expression from validated scalars.
//
// Deps: type-only imports of maplibre-gl and dataset-query.ts (Outcome); pure.
import type { LayerSpecification, SourceSpecification, ExpressionSpecification } from 'maplibre-gl';
import type { Outcome } from '../dataset-query.js';

export const SERVICE_KINDS = [
  'geojson', 'arcgis-feature', 'arcgis-export', 'arcgis-image', 'wms', 'xyz', 'pmtiles-raster',
] as const;
export type ServiceKind = typeof SERVICE_KINDS[number];

/** Kinds drawn as raster tiles (style.kind must be 'raster'); the rest are features. */
export const RASTER_KINDS: ReadonlySet<ServiceKind> = new Set(['arcgis-export', 'arcgis-image', 'wms', 'xyz', 'pmtiles-raster']);

/** Map-layer and source ids of a service start with this. */
export const SERVICE_LAYER_PREFIX = 'svc-';

export const MAX_SERVICES = 5;
export const MAX_SERVICE_URL = 1024;
export const MAX_SERVICES_JSON = 3000;
export const MAX_STYLE_CATEGORIES = 24;

export interface ServiceSpec {
  kind: ServiceKind;
  url: string;             // normalised (see header)
  host: string;            // lower-case hostname of url
  layer?: string;          // ArcGIS layer index, or WMS layer name(s)
  version?: '1.1.1' | '1.3.0'; // WMS only; absent = 1.3.0
}

type Color = string;
export interface ServiceStyle {
  kind: 'fill' | 'line' | 'circle' | 'raster';
  color: Color;
  opacity: number;
  width?: number;
  radius?: number;
  by?: { field: string; stops?: [number, Color][]; categories?: [string | number, Color][] };
  minzoom?: number;
}

export interface LinkedService extends ServiceSpec {
  id: string;
  title: string;
  style: ServiceStyle;
  visible: boolean;
  libraryId?: string;
  credit: string;
}

const fail = <T>(reason: string): Outcome<T> => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ─── URL normalisation + sniffing ────────────────────────────────────────────

const ARCGIS_PATH = /^(.*?)(\/[^/]+\/rest\/services)(\/.+?)\/(featureserver|mapserver|imageserver)(?:\/(\d{1,6}))?(?:\/(query|export|exportimage))?$/i;
const SERVER_WORD: Record<string, 'FeatureServer' | 'MapServer' | 'ImageServer'> =
  { featureserver: 'FeatureServer', mapserver: 'MapServer', imageserver: 'ImageServer' };

interface Split {
  url: string;
  layer?: string;
  server?: 'FeatureServer' | 'MapServer' | 'ImageServer';
  op?: string;
  params: URLSearchParams;
}

function param(params: URLSearchParams, name: string): string | undefined {
  for (const [k, v] of params) if (k.toLowerCase() === name) return v;
  return undefined;
}

const KEY_PARAMS = new Set(['token', 'access_token', 'api_key', 'apikey', 'key']);

function split(raw: string): Outcome<Split> {
  if (typeof raw !== 'string') return fail('The service URL must be text.');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return fail('That is not a valid URL.'); }
  if (u.protocol !== 'https:') return fail('Only https:// service URLs are supported.');
  if (u.username || u.password) return fail('A URL carrying a user name or password is not supported.');
  for (const k of u.searchParams.keys())
    if (KEY_PARAMS.has(k.toLowerCase())) return fail('This service needs a sign-in or key, which isn\'t supported.');
  // Keep template placeholders readable: URL percent-encodes { and }.
  let path = u.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/\/+$/, '');
  const params = u.searchParams;
  let layer: string | undefined;
  let server: Split['server'];
  let op: string | undefined;
  const m = path.includes('{') ? null : ARCGIS_PATH.exec(path);
  if (m) {
    server = SERVER_WORD[m[4].toLowerCase()];
    op = m[6]?.toLowerCase();
    // Only `/<instance>/rest/services` is case-folded: org ids and service names keep their case.
    path = m[1] + m[2].toLowerCase() + m[3] + '/' + server;
    layer = m[5];
    const layers = param(params, 'layers');
    if (op === 'export' && layers) {
      const show = /^show:(\d{1,6})$/i.exec(layers);
      if (!show) return fail('Only a MapServer export showing one layer (layers=show:N) is supported.');
      if (!layer) layer = show[1];
    }
  }
  const url = u.origin + path;
  if (url.length > MAX_SERVICE_URL) return fail(`The service URL is longer than ${MAX_SERVICE_URL} characters.`);
  return { ok: true, result: { url, layer, server, op, params } };
}

/** The stored form of a service URL: parseServiceUrl's url and layer. Fails wherever it does. */
export function normaliseServiceUrl(url: string, kind?: ServiceKind): Outcome<{ url: string; layer?: string }> {
  const p = parseServiceUrl(url, kind);
  if (!p.ok) return p;
  const { url: n, layer } = p.result;
  return { ok: true, result: layer === undefined ? { url: n } : { url: n, layer } };
}

const WMTS_PLACEHOLDERS: Record<string, string> = { '{TileMatrix}': '{z}', '{TileRow}': '{y}', '{TileCol}': '{x}' };

/** WMS by path (a `wms` / `WMSServer` / `ows` segment, a `.wms` file) or by a `service=WMS` param. */
const looksWms = (path: string, params: URLSearchParams): boolean =>
  /(^|\/)(wms|wmsserver)(\/|$)/i.test(path) || /\.wms$/i.test(path) || /(^|\/)ows$/i.test(path)
  || /^wms$/i.test(param(params, 'service') ?? '');

function sniff(s: Split): Outcome<ServiceKind | null> {
  const { url, server, op, params } = s;
  if (url.includes('{')) {
    const found = url.match(/\{[^}]*\}/g) ?? [];
    const set = new Set(found);
    if (!['{z}', '{x}', '{y}'].every(p => set.has(p)) || found.some(p => !['{z}', '{x}', '{y}'].includes(p)))
      return fail('A tile URL needs exactly the {z}, {x} and {y} placeholders.');
    return { ok: true, result: 'xyz' };
  }
  const path = new URL(url).pathname;
  if (/\.pmtiles$/i.test(path)) return { ok: true, result: 'pmtiles-raster' };
  if (server === 'FeatureServer') return { ok: true, result: 'arcgis-feature' };
  if (server === 'ImageServer') return { ok: true, result: 'arcgis-image' };
  if (server === 'MapServer') return { ok: true, result: s.layer !== undefined && op !== 'export' ? 'arcgis-feature' : 'arcgis-export' };
  if (/\/(featureserver|mapserver|imageserver)(\/|$)/i.test(path) && /\/rest\/services\//i.test(path))
    return fail('That ArcGIS URL is not a service or one of its layers.');
  if (/\.(geo)?json$/i.test(path)) return { ok: true, result: 'geojson' };
  if (looksWms(path, params)) return { ok: true, result: 'wms' };
  return { ok: true, result: null };
}

/** May a caller who knows the kind (a library entry, a capabilities probe) override the sniff? */
function hintFits(sniffed: ServiceKind | null, hint: ServiceKind, s: Split): boolean {
  if (sniffed === hint) return true;
  if (sniffed === null) return hint === 'wms' || hint === 'geojson';
  return s.server === 'MapServer' && (hint === 'arcgis-export' || hint === 'arcgis-feature');
}

/** URL → ServiceSpec, the kind sniffed from the path (no network). `kind` is a caller's hint. */
export function parseServiceUrl(url: string, kind?: ServiceKind): Outcome<ServiceSpec> {
  if (kind !== undefined && !SERVICE_KINDS.includes(kind)) return fail('Unknown service kind.');
  // WMTS-REST templates become {z}/{y}/{x} only for a GoogleMapsCompatible matrix set.
  if (typeof url === 'string') {
    const dec = url.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    if (/\{(TileMatrix|TileRow|TileCol|TileMatrixSet)\}/i.test(dec)) {
      let path: string;
      try { path = new URL(dec.trim()).pathname; } catch { return fail('That is not a valid URL.'); }
      if (!/GoogleMapsCompatible/i.test(path) || /\{TileMatrixSet\}/i.test(dec))
        return fail('Only WMTS tiles in the GoogleMapsCompatible matrix set are supported.');
      if ((dec.match(/\{(TileMatrix|TileRow|TileCol)\}/gi) ?? []).some(t => !(t in WMTS_PLACEHOLDERS)))
        return fail('WMTS placeholders must be written {TileMatrix}, {TileRow} and {TileCol}.');
      url = dec.replace(/\{(TileMatrix|TileRow|TileCol)\}/g, t => WMTS_PLACEHOLDERS[t]);
    }
  }
  const s = split(url);
  if (!s.ok) return s;
  const sn = sniff(s.result);
  if (!sn.ok) return sn;
  const sniffed = sn.result;
  if (kind !== undefined && !hintFits(sniffed, kind, s.result))
    return fail(sniffed ? `That URL looks like ${sniffed}, not ${kind}.` : `That URL does not look like ${kind}.`);
  const k = kind ?? sniffed;
  if (!k) return fail('Cannot tell what kind of service this URL is.');
  const spec: ServiceSpec = { kind: k, url: s.result.url, host: new URL(s.result.url).hostname };
  const layer = k === 'wms' ? param(s.result.params, 'layers') || undefined : s.result.layer;
  if (layer !== undefined && (k === 'wms' || k.startsWith('arcgis-'))) spec.layer = layer;
  if (k === 'wms') {
    const v = param(s.result.params, 'version');
    if (v === '1.1.1' || v === '1.1.0') spec.version = '1.1.1';
  }
  return validateServiceSpec(spec);
}

const ARCGIS_LAYER = /^\d{1,6}$/;
const WMS_LAYER = /^[A-Za-z0-9_:.,\- ]{1,256}$/;

/** Trust-boundary check of a ServiceSpec; returns the canonical copy (url re-normalised, host recomputed). */
export function validateServiceSpec(spec: unknown): Outcome<ServiceSpec> {
  if (!isObj(spec)) return fail('A service must be an object.');
  const { kind, url, layer, version } = spec;
  if (typeof kind !== 'string' || !SERVICE_KINDS.includes(kind as ServiceKind)) return fail('Unknown service kind.');
  const k = kind as ServiceKind;
  if (typeof url !== 'string') return fail('A service needs a URL.');
  const s = split(url);
  if (!s.ok) return s;
  const sn = sniff(s.result);
  if (!sn.ok) return sn;
  if (!hintFits(sn.result, k, s.result)) return fail(`That URL does not look like ${k}.`);
  let lyr = s.result.layer;
  if (layer !== undefined) {
    if (typeof layer !== 'string') return fail('A service layer must be text.');
    if (lyr !== undefined && lyr !== layer) return fail('The URL and the layer name different layers.');
    lyr = layer;
  }
  const out: ServiceSpec = { kind: k, url: s.result.url, host: new URL(s.result.url).hostname };
  if (k.startsWith('arcgis-')) {
    if (lyr !== undefined && !ARCGIS_LAYER.test(lyr)) return fail('An ArcGIS layer is a number.');
    if (k === 'arcgis-image' && lyr !== undefined) return fail('An ImageServer has no layers.');
  } else if (k === 'wms') {
    if (lyr !== undefined && !WMS_LAYER.test(lyr)) return fail('That WMS layer name is not supported.');
  } else if (lyr !== undefined) {
    return fail(`A ${k} service has no layer.`);
  }
  if (lyr !== undefined) out.layer = lyr;
  if (version !== undefined) {
    if (k !== 'wms' || (version !== '1.1.1' && version !== '1.3.0')) return fail('Unsupported service version.');
    if (version === '1.1.1') out.version = version;
  }
  return { ok: true, result: out };
}

// ─── style ───────────────────────────────────────────────────────────────────

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FIELD = /^[A-Za-z0-9_]{1,64}$/;
const STYLE_KEYS = new Set(['kind', 'color', 'opacity', 'width', 'radius', 'by', 'minzoom']);
const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Trust-boundary check of a ServiceStyle: scalars only, never an expression. Returns a clean copy. */
export function validateStyle(style: unknown): Outcome<ServiceStyle> {
  if (!isObj(style)) return fail('A style must be an object.');
  for (const key of Object.keys(style)) if (!STYLE_KEYS.has(key)) return fail(`Unknown style setting "${key}".`);
  const { kind, color, opacity, width, radius, by, minzoom } = style;
  if (kind !== 'fill' && kind !== 'line' && kind !== 'circle' && kind !== 'raster') return fail('Style kind must be fill, line, circle or raster.');
  if (typeof color !== 'string' || !COLOR.test(color)) return fail('Colour must be #rgb or #rrggbb.');
  if (!inRange(opacity, 0, 1)) return fail('Opacity must be a number from 0 to 1.');
  const out: ServiceStyle = { kind, color, opacity };
  if (width !== undefined) { if (!inRange(width, 0, 20)) return fail('Width must be a number from 0 to 20.'); out.width = width; }
  if (radius !== undefined) { if (!inRange(radius, 0, 30)) return fail('Radius must be a number from 0 to 30.'); out.radius = radius; }
  if (minzoom !== undefined) { if (!inRange(minzoom, 0, 22)) return fail('Minimum zoom must be a number from 0 to 22.'); out.minzoom = minzoom; }
  if (by !== undefined) {
    if (kind === 'raster') return fail('A raster style cannot colour by a field.');
    if (!isObj(by)) return fail('Colour-by must be an object.');
    for (const key of Object.keys(by)) if (!['field', 'stops', 'categories'].includes(key)) return fail(`Unknown colour-by setting "${key}".`);
    const { field, stops, categories } = by;
    if (typeof field !== 'string' || !FIELD.test(field)) return fail('Colour-by field must be 1–64 letters, digits or underscores.');
    if ((stops === undefined) === (categories === undefined)) return fail('Colour-by needs either stops or categories.');
    const list = (stops ?? categories) as unknown;
    if (!Array.isArray(list) || list.length < (stops ? 2 : 1)) return fail(stops ? 'Colour-by needs at least two stops.' : 'Colour-by needs at least one category.');
    if (list.length > MAX_STYLE_CATEGORIES) return fail(`Colour-by takes at most ${MAX_STYLE_CATEGORIES} entries.`);
    const pairs: [string | number, string][] = [];
    for (const p of list) {
      if (!Array.isArray(p) || p.length !== 2) return fail('Each colour-by entry is a [value, colour] pair.');
      const [v, c] = p as unknown[];
      if (typeof c !== 'string' || !COLOR.test(c)) return fail('Colour must be #rgb or #rrggbb.');
      if (stops) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail('A stop value must be a number.');
        if (pairs.length && v <= (pairs[pairs.length - 1][0] as number)) return fail('Stop values must increase.');
      } else {
        if (!((typeof v === 'string' && v.length <= 64) || (typeof v === 'number' && Number.isFinite(v)))) return fail('A category value must be text (up to 64 characters) or a number.');
        if (pairs.length && typeof v !== typeof pairs[0][0]) return fail('Category values must all be text or all numbers.');
        if (pairs.some(q => q[0] === v)) return fail('Category values must be distinct.');
      }
      pairs.push([v as string | number, c]);
    }
    out.by = stops ? { field, stops: pairs as [number, string][] } : { field, categories: pairs };
  }
  return { ok: true, result: out };
}

// ─── linked services ─────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const LIB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LINKED_KEYS = new Set(['id', 'kind', 'url', 'title', 'host', 'layer', 'version', 'style', 'visible', 'libraryId', 'credit']);

/** One linked service, checked whole: spec, style fit for the kind, text fields bounded. */
export function validateLinkedService(entry: unknown): Outcome<LinkedService> {
  if (!isObj(entry)) return fail('A linked service must be an object.');
  for (const key of Object.keys(entry)) if (!LINKED_KEYS.has(key)) return fail(`Unknown service setting "${key}".`);
  const { id, title, style, visible, libraryId, credit } = entry;
  if (typeof id !== 'string' || !ID.test(id)) return fail('A service id is 1–32 letters, digits, - or _.');
  if (typeof title !== 'string' || title.length > 200) return fail('A service title is text of up to 200 characters.');
  if (typeof credit !== 'string' || credit.length > 300) return fail('A service credit is text of up to 300 characters.');
  if (typeof visible !== 'boolean') return fail('A service is visible or not.');
  if (libraryId !== undefined && (typeof libraryId !== 'string' || !LIB_ID.test(libraryId))) return fail('Unknown library id.');
  const spec = validateServiceSpec(entry);
  if (!spec.ok) return spec;
  const st = validateStyle(style);
  if (!st.ok) return st;
  const raster = RASTER_KINDS.has(spec.result.kind);
  if (raster !== (st.result.kind === 'raster')) return fail(raster ? 'A tiled service takes a raster style.' : 'A feature service takes a fill, line or circle style.');
  if ((spec.result.kind === 'wms' || spec.result.kind === 'arcgis-feature') && spec.result.layer === undefined)
    return fail('Pick one of the service\'s layers.');
  const out: LinkedService = { id, ...spec.result, title, style: st.result, visible, credit };
  if (libraryId !== undefined) out.libraryId = libraryId;
  return { ok: true, result: out };
}

/** The whole list: ≤ 5 entries, distinct ids, each valid, JSON ≤ 3,000 characters. */
export function validateLinkedServices(list: unknown): Outcome<LinkedService[]> {
  if (!Array.isArray(list)) return fail('Linked services must be a list.');
  if (list.length > MAX_SERVICES) return fail(`A view links at most ${MAX_SERVICES} services.`);
  const out: LinkedService[] = [];
  for (const e of list) {
    const v = validateLinkedService(e);
    if (!v.ok) return v;
    if (out.some(o => o.id === v.result.id)) return fail('Linked service ids must be distinct.');
    out.push(v.result);
  }
  if (JSON.stringify(out).length > MAX_SERVICES_JSON) return fail(`The linked services take more than ${MAX_SERVICES_JSON} characters.`);
  return { ok: true, result: out };
}

// ─── MapLibre specs ──────────────────────────────────────────────────────────

const TILE_BBOX = 'bbox={bbox-epsg-3857}';

/** The raster tile URL template a raster kind draws from. */
export function tileTemplate(s: ServiceSpec): string {
  switch (s.kind) {
    case 'arcgis-export':
      return `${s.url}/export?${TILE_BBOX}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`
        + (s.layer !== undefined ? `&layers=show:${s.layer}` : '');
    case 'arcgis-image':
      return `${s.url}/exportImage?${TILE_BBOX}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image`;
    case 'wms': {
      const v = s.version ?? '1.3.0';
      return `${s.url}?SERVICE=WMS&REQUEST=GetMap&VERSION=${v}&LAYERS=${encodeURIComponent(s.layer ?? '')}&STYLES=`
        + `&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&${v === '1.3.0' ? 'CRS' : 'SRS'}=EPSG:3857&BBOX={bbox-epsg-3857}`;
    }
    default:
      return s.url;
  }
}

function colorExpr(st: ServiceStyle): string | ExpressionSpecification {
  const by = st.by;
  if (!by) return st.color;
  if (by.stops) return ['interpolate', ['linear'], ['to-number', ['get', by.field], 0], ...by.stops.flat()] as ExpressionSpecification;
  return ['match', ['get', by.field], ...(by.categories ?? []).flat(), st.color] as unknown as ExpressionSpecification;
}

/** A validated LinkedService → its source and its map layers (ids `svc-<id>…`), in paint order. */
export function styleToLayers(service: LinkedService): { sourceId: string; source: SourceSpecification; layers: LayerSpecification[] } {
  const sourceId = SERVICE_LAYER_PREFIX + service.id;
  const st = service.style;
  const zoom = st.minzoom !== undefined ? { minzoom: st.minzoom } : {};
  const layout = { visibility: service.visible ? 'visible' as const : 'none' as const };
  if (RASTER_KINDS.has(service.kind)) {
    const source: SourceSpecification = service.kind === 'pmtiles-raster'
      ? { type: 'raster', url: 'pmtiles://' + service.url, tileSize: 256 }
      : { type: 'raster', tiles: [tileTemplate(service)], tileSize: 256 };
    return { sourceId, source, layers: [{ id: sourceId + '-raster', type: 'raster', source: sourceId, ...zoom, layout, paint: { 'raster-opacity': st.opacity } }] };
  }
  const source: SourceSpecification = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  const color = colorExpr(st);
  let layer: LayerSpecification;
  if (st.kind === 'fill') {
    layer = { id: sourceId + '-fill', type: 'fill', source: sourceId, ...zoom, layout,
      paint: { 'fill-color': color, 'fill-opacity': st.opacity, 'fill-outline-color': color } };
  } else if (st.kind === 'line') {
    layer = { id: sourceId + '-line', type: 'line', source: sourceId, ...zoom, layout,
      paint: { 'line-color': color, 'line-opacity': st.opacity, 'line-width': st.width ?? 1.5 } };
  } else {
    layer = { id: sourceId + '-circle', type: 'circle', source: sourceId, ...zoom, layout,
      paint: { 'circle-color': color, 'circle-opacity': st.opacity, 'circle-radius': st.radius ?? 4,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.5, 'circle-stroke-opacity': st.opacity } };
  }
  return { sourceId, source, layers: [layer] };
}
