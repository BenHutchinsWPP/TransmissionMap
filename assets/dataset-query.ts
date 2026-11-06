// ─── Dataset query: read a layer's features as rows ──────────────────────────
// Role: answers "which / how many / how much" over the registry layers with
//       a `dataset` (FIELD_SCHEMA) — the same set `where`, the area and the
//       selection reach, so what the map filters and what a query reads agree.
//         describe(layerId)          fields (schema + display + id), ops,
//                                    domains, each field's role, the geometry,
//                                    label field and derived measures, loaded
//                                    row count, credit, completeness;
//                                    `queryable: false` and why for any other.
//         query / count / aggregate  async; each returns Outcome<…>
//                                    ({ok: true, result} | {ok: false, reason,
//                                    code?}; code 'area-unreachable': the Area
//                                    cannot filter this layer).
//         shapeRows(layerId, opts)   the template data pass (see its JSDoc);
//                                    shapeSlots() lists what each slot takes.
//         summarise(result)          the capped copy a model may see:
//                                    ≤ 50 rows or ≤ 200 groups, and ≤ 8 KB
//                                    of JSON either way (trimmed, never refused).
//       Filters are the map's: `where` and `area` compile through
//       toMapLibreFilter()/areaCondition(), `asDrawn` takes effectiveFilter()
//       of each of the layer's map layers wantedLayout() shows and the current
//       zoom reaches, `ids` keeps only those features (featureId()), and every
//       test runs through style-spec featureFilter (a lazy chunk, shared with
//       ui-search.ts). A GeoJSON layer reads the whole file from
//       state.sourcesData, loading it first with loadSource(). A vector-tile
//       layer reads only the loaded tiles (querySourceFeatures, deduplicated on
//       featureId()) and says so: `complete: false, reason`. With
//       `fragments: true` the pieces of a tile-cut polygon are merged into one
//       MultiPolygon per id (parts concatenated, not unioned).
//       The pure core — buildTest(), runQuery(), runAggregate(),
//       mergeViewPieces() — needs no map.
//
// Deps: state.ts, registry (layerById), field-schema.ts (FIELD_SCHEMA, YEAR_IN_TEXT),
//       field-roles.ts (rolesOf),
//       condition-compile.ts (toMapLibreFilter), view-validate.ts (validateWhere,
//       validateArea), area-filter.ts (areaCondition), filters.ts
//       (effectiveFilter), visibility.ts (wantedLayout, modeOf), feature-id.ts
//       (featureId), layers/layer-data.ts (loadSource, liveGeneratedUtc),
//       layers/layer-source.ts (layerSourceId), layers/base-filters.ts
//       (BASE_LAYER_FILTERS), transmission.ts (OSM_TL_TIERS), buckets.ts
//       (kvBucketOf), sandbox/geo-kit.ts (lengthKm, areaKm2, bbox);
//       @maplibre/maplibre-gl-style-spec
//       (featureFilter, dynamic import).

import type { FilterSpecification } from 'maplibre-gl';
import { state } from './state.js';
import { layerById } from '../src/registry/index.js';
import { FIELD_SCHEMA, YEAR_IN_TEXT, type FieldDef, type FieldOp } from '../src/registry/field-schema.js';
import { rolesOf, aliasFields, type RoleField, type Roles } from '../src/registry/field-roles.js';
import { toMapLibreFilter, type Condition } from '../src/registry/condition-compile.js';
import { validateWhere, validateArea } from '../src/registry/view-validate.js';
import { areaCondition, ADMIN1_TO_STATE, type AreaFilter } from '../src/registry/area-filter.js';
import { effectiveFilter } from './filters.js';
import { wantedLayout, modeOf } from './visibility.js';
import { featureId, type FeatureId } from './feature-id.js';
import { loadSource, liveGeneratedUtc } from './layers/layer-data.js';
import { layerSourceId } from './layers/layer-source.js';
import { BASE_LAYER_FILTERS } from './layers/base-filters.js';
import { OSM_TL_TIERS } from '../src/registry/transmission.js';
import { kvBucketOf } from '../src/colors/buckets.js';
import { bbox, lengthKm, areaKm2 } from './sandbox/geo-kit.js';

/** Why a call was refused; `code` names the one refusal a caller acts on. */
export type Refusal = { reason: string; code?: 'area-unreachable' };
export type Outcome<T> = { ok: true; result: T } | ({ ok: false } & Refusal);
type FeatureFilterFn = typeof import('@maplibre/maplibre-gl-style-spec').featureFilter;

export const QUERY_MAX_ROWS = 5000;
const MODEL_MAX_ROWS = 50;
const MODEL_MAX_BYTES = 8 * 1024;
const MODEL_MAX_GROUPS = 200;
const MODEL_MAX_STRING = 120;
const MAX_DOMAIN_VALUES = 60;

// The name-like columns a row shows beside its schema fields (the ones
// feature search reads, the EIA utility, the OSM substation type), per
// registry layer. Each is in its dataset's tile_manifest.yaml `select:`
// (dataset-query.test.ts). This list is what a row — and, through
// summarise(), a model — may read: `sub_type` is a free OSM tag, clipped to
// MODEL_MAX_STRING there like any string.
export const DISPLAY_FIELDS: Record<string, string[]> = {
  "eia-generators": ["plant_name", "technology", "state", "ba_code", "utility_name"],
  "osm-plants-points": ["name", "operator"],
  "osm-plants-polygons": ["name", "operator"],
  "osm-generators": ["name", "operator"],
  "osm-substations-points": ["name", "operator", "sub_type"],
  "osm-substations-polygons": ["name", "operator", "sub_type"],
  "hifld-substations": ["name"],
  "osm-transmission-lines": ["name", "operator"],
  "hifld-transmission-lines": ["OWNER"],
  "ogf-planned-transmission": ["Project", "Owner", "FromSub", "ToSub", "StatesFull"],
  "westtec-10yr": ["name"],
  "osm-pipelines-lines": ["name", "operator"],
  "osm-pipelines-points": ["pipeline", "operator"],
  "hifld-natgas-lines": ["name", "operator", "pipe_type"],
  "hifld-natgas-points": ["name", "operator", "state"],
  "nrel-hydrothermal-points": ["name", "state", "county"],
  "mines": ["name", "commodity", "operator", "state"],
  "osm-datacenters": ["name", "operator", "addr_city", "addr_state"],
  "nerc-regions": ["region", "sub_nm", "code", "state"],
  "retail-territories": ["name", "state"],
  "padus": ["name"],
  "crithab": ["comname", "sciname"],
  "dc-moratoriums": ["name"],
};

export interface FieldInfo {
  name: string;
  type: FieldDef['type'];
  ops: FieldOp[];          // empty for a display-only field: it reaches rows, not filters
  values?: readonly string[];
  valueCount?: number;     // a closed domain too long to list
  pattern?: string;
  list?: boolean;          // a `|code|code|` region list
  description?: string;
  role?: RoleField['role'];
  unit?: string;
  additive?: false;        // a measure never summed (kV)
  time?: RoleField['time'];
  facet?: string;          // the legend facet whose colours a chart of it uses
}

export type Description =
  | { layerId: string; queryable: false; reason: string }
  | {
      layerId: string; queryable: true; kind: 'geojson' | 'pmtiles';
      complete: boolean; reason?: string;
      idField: string; fields: FieldInfo[];
      geometry?: Roles['geometry']; label?: string; derived?: Roles['derived'];
      rowCount?: number;   // GeoJSON layers once loaded
      credit: string; generated_utc?: string;
    };

export interface QueryOpts {
  where?: Condition[];
  area?: AreaFilter | null;
  asDrawn?: boolean;       // also only what the map draws now (the visible map layers' filters)
  ids?: readonly FeatureId[];  // only these features (featureId()), e.g. the selection's
}
export interface RowOpts {
  fields?: string[];       // default: every allowed field
  orderBy?: { field: string; desc?: boolean };
  limit?: number;          // 1–QUERY_MAX_ROWS, default QUERY_MAX_ROWS
  fragments?: boolean;     // vector tiles: merge a polygon's tile pieces into one MultiPolygon (spatial joins)
}
export interface AggregateOpts { groupBy: string; sum?: string[] }

export interface QueryRow { id: FeatureId | null; props: Record<string, unknown>; feature: GeoJSON.Feature }
export interface Group { key: string | number | null; count: number; sums: Record<string, number> }
interface Coverage { layerId: string; complete: boolean; reason?: string }
export interface QueryResult extends Coverage { fields: string[]; rows: QueryRow[]; total: number; truncated: boolean }
export interface CountResult extends Coverage { total: number }
export interface AggregateResult extends Coverage {
  groupBy: string; sum: string[]; groups: Group[]; total: number;   // total = matching features
}

// ─── Fields ──────────────────────────────────────────────────────────────────
function queryable(layerId: string): { reason: string } | { dataset: string; idField: string; native: boolean } {
  const entry = layerById(layerId);
  if (!entry) return { reason: `"${layerId}" is not a layer id` };
  if (!entry.dataset || !Object.hasOwn(FIELD_SCHEMA, entry.dataset) || !entry.data?.id) {
    return { reason: `"${layerId}" has no field schema, so it takes no query` };
  }
  return { dataset: entry.dataset, idField: entry.data.id.field, native: !!entry.data.id.native };
}

/** Every property a row of `layerId` may carry: schema fields, display fields
 *  and the id column (when it is a property). Nothing else reaches a result. */
export function allowedFields(layerId: string): string[] {
  const q = queryable(layerId);
  if ('reason' in q) return [];
  return [...new Set([...Object.keys(FIELD_SCHEMA[q.dataset]), ...(DISPLAY_FIELDS[layerId] ?? []),
    ...(q.native ? [] : [q.idField])])];
}

export function describe(layerId: string): Outcome<Description> {
  const entry = layerById(layerId);
  if (!entry) return { ok: false, reason: `"${layerId}" is not a layer id` };
  const q = queryable(layerId);
  if ('reason' in q) return { ok: true, result: { layerId, queryable: false, reason: q.reason } };
  const schema = FIELD_SCHEMA[q.dataset];
  const roles = rolesOf(layerId);
  const roleOf = (name: string) => {
    const r = roles?.fields.find(f => f.name === name);
    return r ? { role: r.role, ...(r.unit && { unit: r.unit }), ...(r.additive === false && { additive: false as const }),
      ...(r.time && { time: r.time }), ...(r.facet && { facet: r.facet }) } : {};
  };
  const fields = allowedFields(layerId).map((name): FieldInfo => {
    const d = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!d) return { name, type: 'string', ops: [], ...roleOf(name) };
    return {
      name, type: d.type, ops: d.ops,
      ...(d.values && (d.values.length <= MAX_DOMAIN_VALUES ? { values: d.values } : { valueCount: d.values.length })),
      ...(d.pattern && { pattern: d.pattern.source }),
      ...(d.list && { list: true }),
      ...(d.description && { description: d.description }),
      ...roleOf(name),
    };
  });
  const kind = entry.data!.kind === 'geojson' ? 'geojson' : 'pmtiles';
  const src = layerSourceId(layerId);
  const loaded = kind === 'geojson' && state.sourcesLoaded[src] ? state.sourcesData[src]?.length : undefined;
  const generated = entry.live ? liveGeneratedUtc(src) : undefined;
  return { ok: true, result: {
    queryable: true, kind, ...coverage(layerId, kind),
    idField: q.idField, fields,
    ...(roles && { geometry: roles.geometry, label: roles.label, derived: roles.derived }),
    ...(loaded !== undefined && { rowCount: loaded }),
    credit: entry.data!.credit,
    ...(generated && { generated_utc: generated }),
  } };
}

function coverage(layerId: string, kind: 'geojson' | 'pmtiles'): Coverage {
  return kind === 'geojson' ? { layerId, complete: true }
    : { layerId, complete: false, reason: 'vector tiles: only the features in the tiles loaded for the current view' };
}

// ─── Pure core ───────────────────────────────────────────────────────────────
const GEOMETRY_TYPE: Record<string, number> = {
  Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3,
};

/** The feature test for `opts` on `layerId`, or why there is none. `drawn`:
 *  the filters of the map layers that draw it now (asDrawn; [] = none, so
 *  nothing passes; null in the list = that map layer draws everything). */
export function buildTest(
  layerId: string, opts: QueryOpts, compile: FeatureFilterFn, zoom: number,
  drawn?: (FilterSpecification | null)[],
): ((f: GeoJSON.Feature) => boolean) | Refusal {
  const q = queryable(layerId);
  if ('reason' in q) return q;
  const parts: unknown[] = [];
  if (opts.where?.length) {
    const err = validateWhere(layerId, opts.where);
    if (err) return { reason: err };
    parts.push(toMapLibreFilter(q.dataset, opts.where));
  }
  if (opts.area) {
    const err = validateArea(opts.area);
    if (err) return { reason: err };
    const cond = areaCondition(q.dataset, opts.area);
    if (cond !== 'all') {
      if ('unfiltered' in cond) return { reason: `the area does not reach "${layerId}" (${cond.unfiltered})`, code: 'area-unreachable' };
      parts.push(toMapLibreFilter(q.dataset, [cond]));
    }
  }
  const own = parts.length ? compile((parts.length === 1 ? parts[0] : ['all', ...parts]) as never, 'layers[0].filter') : null;
  const drawnTests = drawn?.map(f => f && compile(f as never, 'layers[0].filter'));
  const ids = opts.ids && new Set<FeatureId>(opts.ids);
  return (f) => {
    if (ids && !ids.has(featureId(layerId, f) as FeatureId)) return false;
    const feature = { type: GEOMETRY_TYPE[f.geometry?.type] ?? 0, properties: f.properties ?? {}, id: f.id };
    if (own && !own.filter({ zoom }, feature as never)) return false;
    return !drawnTests || drawnTests.some(t => !t || t.filter({ zoom }, feature as never));
  };
}

function checkFields(layerId: string, fields: string[]): string | null {
  const allowed = new Set(allowedFields(layerId));
  const bad = fields.find(f => !allowed.has(f));
  return bad === undefined ? null : `"${bad}" is not a field of "${layerId}" (describe() lists them)`;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
const compareValues = (a: unknown, b: unknown): number => {
  if (isEmpty(a)) return isEmpty(b) ? 0 : 1;   // empty last
  if (isEmpty(b)) return -1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
};

export function runQuery(
  layerId: string, features: readonly GeoJSON.Feature[], test: (f: GeoJSON.Feature) => boolean, opts: RowOpts = {},
): Outcome<Omit<QueryResult, keyof Coverage>> {
  const fields = opts.fields ?? allowedFields(layerId);
  const limit = opts.limit ?? QUERY_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_ROWS) {
    return { ok: false, reason: `limit must be a whole number from 1 to ${QUERY_MAX_ROWS}` };
  }
  const err = checkFields(layerId, [...fields, ...(opts.orderBy ? [opts.orderBy.field] : [])]);
  if (err) return { ok: false, reason: err };
  let hits = features.filter(test);
  if (opts.orderBy) {
    const { field, desc } = opts.orderBy;
    hits = [...hits].sort((a, b) => {
      const av = a.properties?.[field], bv = b.properties?.[field];
      const c = compareValues(av, bv);
      return desc && !isEmpty(av) && !isEmpty(bv) ? -c : c;
    });
  }
  const rows = hits.slice(0, limit).map(f => ({
    id: featureId(layerId, f) ?? null,
    props: Object.fromEntries(fields.map(k => [k, f.properties?.[k] ?? null])),
    feature: f,
  }));
  return { ok: true, result: { fields, rows, total: hits.length, truncated: hits.length > rows.length } };
}

export function runAggregate(
  layerId: string, features: readonly GeoJSON.Feature[], test: (f: GeoJSON.Feature) => boolean, opts: AggregateOpts,
): Outcome<Omit<AggregateResult, keyof Coverage>> {
  const q = queryable(layerId);
  if ('reason' in q) return { ok: false, reason: q.reason };
  const sum = opts.sum ?? [];
  const err = checkFields(layerId, [opts.groupBy, ...sum]);
  if (err) return { ok: false, reason: err };
  const schema = FIELD_SCHEMA[q.dataset];
  const notNumber = sum.find(f => schema[f]?.type !== 'number');
  if (notNumber) return { ok: false, reason: `"${notNumber}" is not a number field, so it cannot be summed` };
  // A region list (|TX|NM|) counts the feature once under each of its codes.
  const list = !!schema[opts.groupBy]?.list;
  const groups = new Map<string | number | null, Group>();
  let total = 0;
  for (const f of features) {
    if (!test(f)) continue;
    total++;
    const raw = f.properties?.[opts.groupBy];
    const keys: (string | number | null)[] = list && typeof raw === 'string'
      ? raw.split('|').filter(Boolean)
      : [raw === undefined || raw === '' ? null : raw as string | number];
    for (const key of keys) {
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, count: 0, sums: Object.fromEntries(sum.map(s => [s, 0])) });
      g.count++;
      for (const s of sum) {
        const n = Number(f.properties?.[s]);
        if (Number.isFinite(n)) g.sums[s] += n;
      }
    }
  }
  const order = sum[0];
  const sorted = [...groups.values()].sort((a, b) => order ? b.sums[order] - a.sums[order] : b.count - a.count);
  return { ok: true, result: { groupBy: opts.groupBy, sum, groups: sorted, total } };
}

// ─── Map-facing ──────────────────────────────────────────────────────────────
let featureFilterFn: FeatureFilterFn | null = null;
async function loadFeatureFilter(): Promise<FeatureFilterFn> {
  return featureFilterFn ??= (await import('@maplibre/maplibre-gl-style-spec')).featureFilter;
}

/** The current filters of `layerId`'s map layers that the map shows now
 *  (wantedLayout: a mode-hidden heat or icon layer does not count, nor one
 *  outside its minzoom/maxzoom at the current zoom); [] when the layer is off. */
export function drawnFilters(layerId: string): (FilterSpecification | null)[] {
  return shownMapLayers(layerId).filter(inZoom).map(id => effectiveFilter(id));
}

function shownMapLayers(layerId: string): string[] {
  const entry = layerById(layerId);
  if (!entry) return [];
  const layout = wantedLayout(entry, !!state.layerVisibility[layerId], modeOf(entry));
  return entry.mapLayerIds.filter(id => layout[id] === 'visible' && state.map?.getLayer(id));
}

function inZoom(mlId: string): boolean {
  const l = state.map!.getLayer(mlId) as { minzoom?: number; maxzoom?: number };
  const z = state.map!.getZoom();
  return (l.minzoom ?? 0) <= z && z < (l.maxzoom ?? 24);
}

// The features a query reads: the whole GeoJSON file, or the loaded tiles of
// every source the layer draws from, one copy per stable id.
async function featuresOf(layerId: string, fragments = false): Promise<GeoJSON.Feature[] | string> {
  const entry = layerById(layerId)!;
  if (entry.data!.kind === 'geojson') {
    await loadSource(layerId);
    const src = layerSourceId(layerId);
    return state.sourcesLoaded[src] ? (state.sourcesData[src] ?? []) as GeoJSON.Feature[] : `"${layerId}" could not be loaded`;
  }
  if (!state.map || !state.mapReady) return 'the map is not ready';
  const seen = new Map<FeatureId, number>();
  const out: GeoJSON.Feature[] = [];
  for (const feats of tileFeatures(entry.mapLayerIds)) {
    for (const f of feats) {
      const id = featureId(layerId, f);
      if (id === undefined) continue;
      const at = seen.get(id);
      if (at === undefined) {
        seen.set(id, out.length);
        out.push(f);
      } else if (fragments) out[at] = withPolygonParts(out[at], f);
    }
  }
  return out;
}

/** The loaded-tile features of each source the map layers `mlIds` draw from, one list per source. */
function* tileFeatures(mlIds: readonly string[]): Generator<GeoJSON.Feature[]> {
  const map = state.map!;
  const sources = new Map<string, string | undefined>();
  for (const id of mlIds) {
    const l = map.getLayer(id) as { source?: string; sourceLayer?: string } | undefined;
    if (l?.source) sources.set(l.source, l.sourceLayer);
  }
  for (const [source, sourceLayer] of sources) {
    let feats: GeoJSON.Feature[] = [];
    try { feats = map.querySourceFeatures(source, sourceLayer ? { sourceLayer } : {}); } catch { /* header still loading */ }
    yield feats;
  }
}

const polygonParts = (g: GeoJSON.Geometry | null): number[][][][] | null =>
  g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;

/** `base` with the polygon parts of `piece` added, as one MultiPolygon; `base` itself when either is not a polygon. */
export function withPolygonParts(base: GeoJSON.Feature, piece: GeoJSON.Feature): GeoJSON.Feature {
  const a = polygonParts(base.geometry), b = polygonParts(piece.geometry);
  if (!a || !b) return base;
  return { ...base, geometry: { type: 'MultiPolygon', coordinates: [...a, ...b] } };
}

async function prepare(layerId: string, opts: QueryOpts & { fragments?: boolean }): Promise<Refusal | {
  test: (f: GeoJSON.Feature) => boolean; features: GeoJSON.Feature[]; cov: Coverage;
}> {
  const q = queryable(layerId);
  if ('reason' in q) return q;
  const compile = await loadFeatureFilter();
  const test = buildTest(layerId, opts, compile, state.map?.getZoom() ?? 0, opts.asDrawn ? drawnFilters(layerId) : undefined);
  if (typeof test !== 'function') return test;
  const features = await featuresOf(layerId, opts.fragments);
  if (typeof features === 'string') return { reason: features };
  const entry = layerById(layerId)!;
  const cov = coverage(layerId, entry.data!.kind === 'geojson' ? 'geojson' : 'pmtiles');
  if (opts.asDrawn && !state.layerVisibility[layerId]) cov.reason = `"${layerId}" is off, so the map draws none of it`;
  else if (opts.asDrawn && !drawnFilters(layerId).length && shownMapLayers(layerId).length) {
    cov.reason = `"${layerId}" is not drawn at zoom ${state.map!.getZoom().toFixed(1)}`;
  }
  return { test, features, cov };
}

export async function query(layerId: string, opts: QueryOpts & RowOpts = {}): Promise<Outcome<QueryResult>> {
  const p = await prepare(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  const r = runQuery(layerId, p.features, p.test, opts);
  return r.ok ? { ok: true, result: { ...p.cov, ...r.result } } : r;
}

export async function count(layerId: string, opts: QueryOpts = {}): Promise<Outcome<CountResult>> {
  const p = await prepare(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  return { ok: true, result: { ...p.cov, total: p.features.filter(p.test).length } };
}

export async function aggregate(layerId: string, opts: QueryOpts & AggregateOpts): Promise<Outcome<AggregateResult>> {
  const p = await prepare(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  const r = runAggregate(layerId, p.features, p.test, opts);
  return r.ok ? { ok: true, result: { ...p.cov, ...r.result } } : r;
}

// ─── Template data pass ──────────────────────────────────────────────────────
export const SHAPE_MAX_FEATURES = 50_000;
export const SHAPE_MAX_ROWS = 50_000;
const SHAPE_MAX_BY = 2;
const TIER_IDS = new Set(OSM_TL_TIERS.map(t => t.id));

export interface ShapeOpts {
  area?: AreaFilter | null;
  where?: Condition[];
  by?: string[];                          // ≤ 2 category / region / kV-class fields
  measure?: string;                       // a measure field, or 'count' (default) / 'length_km' / 'area_km2'
  time?: { field: string; bin: 'year' | 'month' };   // month: a `date` time field only
  /** Numeric bins of one field (shapeSlots().bins): page-chosen edges (binEdges), rows keyed by `bin`. */
  bins?: { field: string; scale?: BinScale | 'auto'; /** Aim for about this many bins (2–60; default 20). */ buckets?: number };
  geometry?: 'none' | 'point' | 'full';   // features beside the rows (default none)
  limitFeatures?: number;                 // 1–SHAPE_MAX_FEATURES, default SHAPE_MAX_FEATURES
  /** A layer read whole (a template's second layer): a tiled layer is refused, and features are never cut. */
  complete?: true;
}
export type BinScale = 'lin' | 'log';
/** The binned values' own quantiles (nearest rank over every value, not the bins): n values, p10, median, p90. */
export interface BinStats { n: number; p10: number; median: number; p90: number }
export type ShapeKey = string | number | null;
export interface ShapeRow { [field: string]: ShapeKey | undefined; count: number; sum?: number }
export interface ShapeResult {
  layerId: string;
  scope: 'area' | 'view';                 // GeoJSON: the whole file (∧ area); tiles: the current view
  by: string[]; measure: string; unit?: string; time?: string; timeBin?: 'year' | 'month';
  /** Numeric bins: row `bin` i is [edges[i], edges[i + 1]) (also its `lo` / `hi`); a feature without a value is in the row with `bin: null`. */
  bins?: { field: string; scale: BinScale; edges: number[]; stats?: BinStats };
  rows: ShapeRow[];
  features?: GeoJSON.Feature[];
  totals: { count: number; sum?: number };   // each matching feature once (a region list does not multiply it)
  complete: boolean; reason?: string;
  truncated: boolean; truncation?: string;   // rows or features cut, and which
  tiersHidden?: string[];                 // voltage tiers (OSM_TL_TIERS ids) not drawn at this zoom
  /** by `states` on a world layer (the alias): only features in a US state or territory are read. */
  usOnly?: true;
  precision: string;
}
/** The fields each slot of `shapeRows` takes on a layer: what a refusal lists and a form offers. */
export interface ShapeSlots { by: string[]; measure: string[]; time: string[]; bins: string[] }

interface ShapePlan {
  /** `read`/`map`: the states alias reads admin1 and keeps only its US codes, as states. */
  by: { name: string; list: boolean; bin?: (v: unknown) => string; read?: string; map?: Readonly<Record<string, string>> }[];
  /** The states alias: only features with a US admin-1 tag. */
  usOnly?: true;
  measure: string; sumOf: ((f: GeoJSON.Feature) => number) | null; unit?: string;
  time?: string; timeKey: (v: unknown) => string | number | null; timeBin: 'year' | 'month';
  bins?: { field: string; scale: BinScale | 'auto'; buckets?: number; valueOf: (f: GeoJSON.Feature) => number | null };
  geometry: 'none' | 'point' | 'full'; limit: number; label: string;
}

export function shapeSlots(layerId: string): ShapeSlots | null {
  const roles = rolesOf(layerId);
  if (!roles) return null;
  const s: ShapeSlots = { by: [], measure: [...roles.derived], time: [], bins: [] };
  for (const f of roles.fields) {
    if (f.role === 'category' || f.role === 'region' || (f.role === 'measure' && f.facet === 'kv')) s.by.push(f.name);
    if (f.role === 'measure' && f.additive !== false) s.measure.push(f.name);
    if (f.role === 'time') s.time.push(f.name);
    if (f.role === 'measure') s.bins.push(f.name);
  }
  for (const f of aliasFields(roles)) s.by.push(f.name);
  // Bins: every measure (levels too), then length / area, then the time fields (by year).
  s.bins.push(...roles.derived.filter(d => d !== 'count'), ...s.time);
  return s;
}

const list = (xs: string[]) => xs.length ? xs.join(', ') : 'none on this layer';

/** The checked plan for `opts`, or why not, with the fields the slot takes. */
function planShape(layerId: string, opts: ShapeOpts): ShapePlan | string {
  const roles = rolesOf(layerId), slots = shapeSlots(layerId);
  if (!roles || !slots) return `"${layerId}" has no field roles, so it takes no template`;
  const roleOf = (name: string) => roles.fields.find(f => f.name === name);
  const by = opts.by ?? [];
  if (!Array.isArray(by) || by.length > SHAPE_MAX_BY) return `by takes up to ${SHAPE_MAX_BY} fields: ${list(slots.by)}`;
  for (const b of by) {
    if (!slots.by.includes(b)) return `"${b}" cannot group "${layerId}": by takes ${list(slots.by)}`;
  }
  const measure = opts.measure ?? 'count';
  if (!slots.measure.includes(measure)) {
    const r = roleOf(measure);
    const hint = r?.additive === false ? ` ("${measure}" is a level, not an amount: group by it instead)` : '';
    return `"${measure}" cannot be summed on "${layerId}"${hint}: measure takes ${list(slots.measure)}`;
  }
  if (opts.time !== undefined) {
    if (!opts.time || (opts.time.bin !== 'year' && opts.time.bin !== 'month')) return `time.bin must be "year" or "month"`;
    if (!slots.time.includes(opts.time.field)) return `"${opts.time.field}" is not a time field of "${layerId}": time takes ${list(slots.time)}`;
    if (opts.time.bin === 'month' && roleOf(opts.time.field)?.time !== 'date') {
      const dates = roles.fields.filter(f => f.time === 'date').map(f => f.name);
      return `"${opts.time.field}" holds years, so it bins by year only: month bins take ${list(dates)}`;
    }
  }
  let bins: ShapePlan['bins'];
  if (opts.bins !== undefined) {
    const b = opts.bins;
    if (!b || typeof b.field !== 'string' || !slots.bins.includes(b.field)) {
      return `${JSON.stringify(b?.field)} cannot be binned on "${layerId}": bins take ${list(slots.bins)}`;
    }
    const scale = b.scale ?? 'auto';
    if (!['auto', 'lin', 'log'].includes(scale)) return `bins.scale must be "auto", "lin" or "log"`;
    if (b.buckets !== undefined && (!Number.isInteger(b.buckets) || b.buckets < 2 || b.buckets > 60)) return 'bins.buckets must be a whole number from 2 to 60';
    const name = b.field;
    const valueOf = name === 'length_km' ? (f: GeoJSON.Feature) => f.geometry ? lengthKm(f.geometry as never) : null
      : name === 'area_km2' ? (f: GeoJSON.Feature) => f.geometry ? areaKm2(f.geometry as never) : null
      : roleOf(name)?.role === 'time' ? (f: GeoJSON.Feature) => yearOf(f.properties?.[name])
      : (f: GeoJSON.Feature) => numberOf(f.properties?.[name]);
    bins = { field: name, scale, ...(b.buckets !== undefined && { buckets: b.buckets }), valueOf };
  }
  const geometry = opts.geometry ?? 'none';
  if (!['none', 'point', 'full'].includes(geometry)) return `geometry must be "none", "point" or "full"`;
  const limit = opts.limitFeatures ?? SHAPE_MAX_FEATURES;
  if (!Number.isInteger(limit) || limit < 1 || limit > SHAPE_MAX_FEATURES) return `limitFeatures must be a whole number from 1 to ${SHAPE_MAX_FEATURES}`;
  const sumOf = measure === 'count' ? null
    : measure === 'length_km' ? (f: GeoJSON.Feature) => f.geometry ? lengthKm(f.geometry as never) : 0
    : measure === 'area_km2' ? (f: GeoJSON.Feature) => f.geometry ? areaKm2(f.geometry as never) : 0
    : (f: GeoJSON.Feature) => { const n = Number(f.properties?.[measure]); return Number.isFinite(n) ? n : 0; };
  const unit = measure === 'length_km' ? 'km' : measure === 'area_km2' ? 'km²' : roleOf(measure)?.unit;
  const alias = new Set(aliasFields(roles).map(f => f.name));
  return {
    by: by.map(name => {
      if (alias.has(name)) return { name, list: true, read: 'admin1', map: ADMIN1_TO_STATE };
      const r = roleOf(name)!;
      return { name, list: r.role === 'region', ...(r.facet === 'kv' && r.role === 'measure' && { bin: kvBucketOf }) };
    }),
    ...(by.some(b => alias.has(b)) && { usOnly: true as const }),
    measure, sumOf, ...(unit && { unit }), ...(opts.time && { time: opts.time.field }),
    timeKey: opts.time?.bin === 'month' ? monthOf : opts.time && roleOf(opts.time.field)?.time === 'date' ? dateYearOf : yearOf,
    timeBin: opts.time?.bin ?? 'year',
    ...(bins && { bins }), geometry, limit: opts.complete ? Infinity : limit, label: roles.label,
  };
}

/** A number as a number condition reads it (condition-compile.ts: a value, then to-number): none, null
 *  and '' have none; anything else is Number(v) when finite, else null (no finite range matches it). */
function numberOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || !['number', 'string', 'boolean'].includes(typeof v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A date as text, `YYYY-MM-DD` (digits). A month or year is read by the same text comparison its range
// condition makes (template-actions.ts conditionForBin: first day ≤ v ≤ last, days 01–31), so a bin's
// `where` matches exactly its rows.
const DATE_TEXT = /^((?:18|19|20)\d\d)-(\d\d)-\d\d$/;

/** The month a `YYYY-MM-DD` date names, as "YYYY-MM" (year 1800–2099, month 01–12, day 01–31); else null. */
export function monthOf(v: unknown): string | null {
  const m = typeof v === 'string' ? DATE_TEXT.exec(v) : null;
  if (!m || m[2] < '01' || m[2] > '12') return null;
  const k = `${m[1]}-${m[2]}`;
  return (v as string) >= `${k}-01` && (v as string) <= `${k}-31` ? k : null;
}

/** The year of a `YYYY-MM-DD` date (YYYY-01-01 ≤ v ≤ YYYY-12-31), else null. */
const dateYearOf = (v: unknown): number | null => {
  const m = typeof v === 'string' ? DATE_TEXT.exec(v) : null;
  return m && (v as string) >= `${m[1]}-01-01` && (v as string) <= `${m[1]}-12-31` ? Number(m[1]) : null;
};

const toEdge = (x: number) => Number(x.toPrecision(12));
const LOG_DECADES = 6;

/** 1, 2 or 5 × 10^k: the smallest such step ≥ `raw` (> 0). */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return toEdge((m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow);
}

/** Bin edges for `values` (finite ones): ascending, edges[0] ≤ min and the last > max, so every
 *  value is in exactly one [edges[i], edges[i + 1]). Linear: a 1/2/5 step giving ≤ ~`target` bins
 *  (whole numbers when every value is whole). Log ('auto' picks it when every value is ≥ 0 and max
 *  is over 100 × the median of the positive values): 1, 2, 5 per decade over at most 6 decades below
 *  the max, with a [0, first) bin for 0 and anything smaller. No values: no edges. */
export function binEdges(values: readonly number[], scale: BinScale | 'auto' = 'auto', target = 20): { scale: BinScale; edges: number[] } {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return { scale: 'lin', edges: [] };
  const min = xs[0], max = xs[xs.length - 1];
  const pos = xs.filter(x => x > 0);
  const median = pos[Math.floor(pos.length / 2)];
  const log = min >= 0 && pos.length > 0 && (scale === 'log' || (scale === 'auto' && max / median > 100));
  const edges: number[] = [];
  if (log) {
    // At most LOG_DECADES decades: anything below (and 0) falls in a first [0, …) bin.
    const low = Math.max(pos[0], max / 10 ** LOG_DECADES);
    if (min < low) edges.push(0);
    let k = Math.floor(Math.log10(low));
    const steps = [1, 2, 5];
    let i = steps.length - 1;
    while (i > 0 && toEdge(steps[i] * 10 ** k) > low) i--;
    for (;;) {
      const e = toEdge(steps[i] * 10 ** k);
      edges.push(e);
      if (e > max) break;
      if (++i === steps.length) { i = 0; k++; }
    }
    return { scale: 'log', edges };
  }
  let step = niceStep((max - min || Math.abs(max) || 1) / target);
  if (xs.every(Number.isInteger)) step = Math.max(1, Math.round(step));
  let e = toEdge(Math.floor(min / step) * step);
  if (e > min) e = toEdge(e - step);
  edges.push(e);
  for (let k = 1; edges[edges.length - 1] <= max; k++) edges.push(toEdge(edges[0] + k * step));
  return { scale: 'lin', edges };
}

/** Nearest-rank quantiles of the finite `values`; null when there are none. */
export function binStats(values: readonly (number | null)[]): BinStats | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
  return { n: xs.length, p10: q(0.1), median: q(0.5), p90: q(0.9) };
}

/** The bin of `v` among `edges` (binEdges): i with edges[i] ≤ v < edges[i + 1]; -1 outside. */
export function binIndex(edges: readonly number[], v: number): number {
  let lo = 0, hi = edges.length - 1;
  if (hi < 1 || !(v >= edges[0] && v < edges[hi])) return -1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (v >= edges[mid]) lo = mid; else hi = mid; }
  return lo;
}

/** The year a time value names: a number 1800–2099, or the first YEAR_IN_TEXT match of a string; else null. */
export function yearOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 1800 && v < 2100 ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  const m = YEAR_IN_TEXT.exec(v);
  return m ? Number(m[1]) : null;
}

const NULL_KEY: ShapeKey[] = [null];
function keysOf(v: unknown, slot: ShapePlan['by'][number]): ShapeKey[] {
  if (slot.bin) return [slot.bin(v)];
  if (slot.list) {
    let tags = typeof v === 'string' ? v.split('|').filter(Boolean) : [];
    if (slot.map) tags = [...new Set(tags.flatMap(t => Object.hasOwn(slot.map!, t) ? [slot.map![t]] : []))];
    return tags.length ? tags : NULL_KEY;
  }
  return isEmpty(v) ? NULL_KEY : [v as string | number];
}

/** Whether a feature has a US admin-1 tag (the states alias reads only those). */
const usTagged = (f: GeoJSON.Feature) => keysOf(f.properties?.admin1, { name: 'states', list: true, map: ADMIN1_TO_STATE })[0] !== null;

function centre(g: GeoJSON.Geometry): GeoJSON.Point | null {
  if (g.type === 'Point') return g;
  const b = bbox(g as never);
  return b ? { type: 'Point', coordinates: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] } : null;
}

/** Group the features `test` passes by the plan's `by` and time keys in one
 *  pass: a count and (for a measure) a sum per row, totals counting each
 *  feature once, and up to `limit` features carrying the binned values. */
function runShape(layerId: string, features: readonly GeoJSON.Feature[], test: (f: GeoJSON.Feature) => boolean, plan: ShapePlan) {
  const groups = new Map<string, ShapeRow>();
  const out: GeoJSON.Feature[] | null = plan.geometry === 'none' ? null : [];
  const [b0, b1] = plan.by;
  let count = 0, sum = 0;
  // Bins: the passing features' values first (the edges need them all), then one grouping pass over the same features.
  let passing: readonly GeoJSON.Feature[] = features;
  let isIn = plan.usOnly ? (f: GeoJSON.Feature) => test(f) && usTagged(f) : test;
  let binned: { values: (number | null)[]; scale: BinScale; edges: number[] } | null = null;
  if (plan.bins) {
    passing = features.filter(isIn);
    isIn = () => true;
    const values = passing.map(plan.bins.valueOf);
    binned = { values, ...binEdges(values.filter((v): v is number => v !== null), plan.bins.scale, plan.bins.buckets) };
  }
  let n = -1;
  for (const f of passing) {
    n++;
    if (!isIn(f)) continue;
    const p = f.properties ?? {};
    const m = plan.sumOf ? plan.sumOf(f) : 0;
    count++; sum += m;
    const year = plan.time ? plan.timeKey(p[plan.time]) : null;
    let bin: number | null = null;
    if (binned) { const v = binned.values[n]; const i = v === null ? -1 : binIndex(binned.edges, v); bin = i < 0 ? null : i; }
    const k0 = b0 ? keysOf(p[b0.read ?? b0.name], b0) : NULL_KEY, k1 = b1 ? keysOf(p[b1.read ?? b1.name], b1) : NULL_KEY;
    for (const a of k0) {
      for (const b of k1) {
        const key = `${a}\u0001${b}\u0001${year}\u0001${bin}`;
        let row = groups.get(key);
        if (!row) {
          row = { count: 0 } as ShapeRow;
          if (b0) row[b0.name] = a;
          if (b1) row[b1.name] = b;
          if (plan.time) row[plan.time] = year;
          if (binned) {
            row.bin = bin;
            if (bin !== null) { row.lo = binned.edges[bin]; row.hi = binned.edges[bin + 1]; }
          }
          if (plan.sumOf) row.sum = 0;
          groups.set(key, row);
        }
        row.count++;
        if (plan.sumOf) row.sum! += m;
      }
    }
    if (out && out.length < plan.limit && f.geometry) {
      const geometry = plan.geometry === 'full' ? f.geometry : centre(f.geometry);
      if (!geometry) continue;
      const props: Record<string, unknown> = { [plan.label]: p[plan.label] ?? null };
      for (const s of plan.by) {
        props[s.name] = s.bin ? s.bin(p[s.name]) : s.map ? `|${keysOf(p[s.read!], s).join('|')}|` : p[s.name] ?? null;
      }
      if (plan.time) props[plan.time] = year;
      if (binned) props[plan.bins!.field] = binned.values[n];
      if (plan.sumOf) props[plan.measure] = m;
      out.push({ type: 'Feature', id: featureId(layerId, f), geometry, properties: props });
    }
  }
  const rows = [...groups.values()];
  const stats = binned && binStats(binned.values);
  const t = plan.time;
  rows.sort((x, y) => (t ? compareValues(x[t], y[t]) : 0) || (binned ? compareValues(x.bin, y.bin) : 0) || (y.sum ?? y.count) - (x.sum ?? x.count));
  const cut: string[] = [];
  if (rows.length > SHAPE_MAX_ROWS) cut.push(`rows: the first ${SHAPE_MAX_ROWS} of ${rows.length} groups kept`);
  if (out && count > out.length) cut.push(`features: ${out.length} of ${count} kept`);
  return {
    by: plan.by.map(s => s.name), measure: plan.measure, ...(plan.unit && { unit: plan.unit }),
    ...(plan.time && { time: plan.time, timeBin: plan.timeBin }),
    ...(binned && { bins: { field: plan.bins!.field, scale: binned.scale, edges: binned.edges, ...(stats && { stats }) } }),
    rows: rows.slice(0, SHAPE_MAX_ROWS), ...(out && { features: out }), ...(plan.usOnly && { usOnly: true as const }),
    totals: { count, ...(plan.sumOf && { sum }) },
    truncated: cut.length > 0, ...(cut.length && { truncation: cut.join('; ') }),
  };
}

// Tile pieces → one feature per stable id, clipped to the view. Each piece is
// first clipped to its own tile (MapLibre's _x/_y/_z), so the tile buffers'
// overlap is counted once; a repeat of one tile (overzoom) is skipped, and when
// a feature comes in tiles of several zooms only the deepest zoom is read.
type Rect = [number, number, number, number];   // west, south, east, north
type TilePiece = GeoJSON.Feature & { _x?: number; _y?: number; _z?: number };

const tileLat = (y: number, n: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
function tileRect(p: TilePiece, view: Rect): Rect | null {
  if (p._z === undefined || p._x === undefined || p._y === undefined) return view;
  const n = 2 ** p._z;
  const r: Rect = [Math.max(view[0], p._x / n * 360 - 180), Math.max(view[1], tileLat(p._y + 1, n)),
    Math.min(view[2], (p._x + 1) / n * 360 - 180), Math.min(view[3], tileLat(p._y, n))];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

/** Segment a–b inside `r` (Liang–Barsky): the original end objects where unclipped; null when outside or touching only. */
function clipSegment(a: number[], b: number[], r: Rect): [number[], number[]] | null {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const edges: [number, number][] = [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  if (t1 <= t0) return null;
  return [t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dy], t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function clipLine(line: number[][], r: Rect, runs: number[][][]) {
  let run: number[][] | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i], line[i + 1], r);
    if (!seg) { run = null; continue; }
    if (run && seg[0] === line[i]) run.push(seg[1]);
    else runs.push(run = [seg[0], seg[1]]);
    if (seg[1] !== line[i + 1]) run = null;
  }
}

/** A ring clipped to `r` (Sutherland–Hodgman), closed; null when nothing is left. */
function clipRing(ring: number[][], r: Rect): number[][] | null {
  let pts = ring;
  for (const [axis, v, keepAbove] of [[0, r[0], true], [0, r[2], false], [1, r[1], true], [1, r[3], false]] as const) {
    const out: number[][] = [];
    const inside = (p: number[]) => keepAbove ? p[axis] >= v : p[axis] <= v;
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const cross = () => { const t = (v - prev[axis]) / (cur[axis] - prev[axis]); return [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]; };
      if (inside(cur)) { if (!inside(prev)) out.push(cross()); out.push(cur); } else if (inside(prev)) out.push(cross());
    }
    if (!out.length) return null;
    pts = out;
  }
  const [f, l] = [pts[0], pts[pts.length - 1]];
  if (f[0] !== l[0] || f[1] !== l[1]) pts.push(f);
  return pts.length >= 4 ? pts : null;
}

/** The pieces of one feature clipped (each to its tile ∩ the view) and merged, or null when none of it is in view. */
function clipPieces(pieces: TilePiece[], view: Rect): GeoJSON.Geometry | null {
  const points: number[][] = [], runs: number[][][] = [], polys: number[][][][] = [];
  for (const p of pieces) {
    const g = p.geometry, r = g && tileRect(p, view);
    if (!g || !r) continue;
    if (g.type === 'Point' || g.type === 'MultiPoint') {
      for (const c of g.type === 'Point' ? [g.coordinates] : g.coordinates) {
        if (c[0] >= r[0] && c[0] <= r[2] && c[1] >= r[1] && c[1] <= r[3]) points.push(c);
      }
    } else if (g.type === 'LineString') clipLine(g.coordinates, r, runs);
    else if (g.type === 'MultiLineString') for (const l of g.coordinates) clipLine(l, r, runs);
    else {
      for (const poly of polygonParts(g) ?? []) {
        const outer = clipRing(poly[0], r);
        if (!outer) continue;
        const holes = poly.slice(1).map(h => clipRing(h, r)).filter((h): h is number[][] => !!h);
        polys.push([outer, ...holes]);
      }
    }
  }
  if (points.length) return points.length === 1 ? { type: 'Point', coordinates: points[0] } : { type: 'MultiPoint', coordinates: points };
  if (runs.length) return { type: 'MultiLineString', coordinates: runs };
  if (polys.length) return { type: 'MultiPolygon', coordinates: polys };
  return null;
}

/** One feature per stable id from `pieces` (grouped by id), its geometry what lies in `view`; ids wholly outside are dropped. */
export function mergeViewPieces(layerId: string, pieces: Iterable<GeoJSON.Feature>, view: Rect): GeoJSON.Feature[] {
  const byId = new Map<FeatureId, TilePiece[]>();
  for (const f of pieces) {
    const id = featureId(layerId, f);
    if (id === undefined) continue;
    const list = byId.get(id);
    if (list) list.push(f); else byId.set(id, [f]);
  }
  const out: GeoJSON.Feature[] = [];
  for (const list of byId.values()) {
    const z = Math.max(...list.map(p => p._z ?? -1));
    const tiles = new Set<string>();
    const deepest = list.filter(p => {
      if ((p._z ?? -1) !== z) return false;
      if (p._z === undefined) return true;
      const k = `${p._x}/${p._y}`;
      return !tiles.has(k) && !!tiles.add(k);
    });
    const geometry = clipPieces(deepest, view);
    if (geometry) out.push({ type: 'Feature', id: list[0].id, properties: list[0].properties, geometry });
  }
  return out;
}

/** Whether map layer `mlId` draws the layer's own features: any non-symbol
 *  layer, or a symbol layer the registry makes clickable (`clickPriority`:
 *  an icon layer such as osm-gen-circles); a label companion is not. */
function drawsFeatures(layerId: string, mlId: string): boolean {
  const type = (state.map?.getLayer(mlId) as { type?: string } | undefined)?.type;
  return type !== 'symbol' || Object.hasOwn(layerById(layerId)?.clickPriority ?? {}, mlId);
}

/** The base filters (each map layer's own inline filter, null — pass-all — where
 *  none is registered) of the layer's feature-drawing map layers; undefined when it has none. */
function baseFilters(layerId: string): (FilterSpecification | null)[] | undefined {
  const ids = (layerById(layerId)?.mapLayerIds ?? []).filter(id => drawsFeatures(layerId, id));
  return ids.length ? ids.map(id => BASE_LAYER_FILTERS[id] ?? null) : undefined;
}

const tierOf = (mlId: string) => { const s = mlId.slice(mlId.lastIndexOf('-') + 1); return TIER_IDS.has(s) ? s : null; };

/** The voltage tiers among `shown` map layers that none of `drawn` (those the zoom reaches) draws; undefined for a layer with no tiers. */
function hiddenTiers(shown: string[], drawn: string[]): string[] | undefined {
  if (!shown.some(tierOf)) return undefined;
  const on = new Set(drawn.map(tierOf));
  return OSM_TL_TIERS.map(t => t.id).filter(t => !on.has(t) && shown.some(id => tierOf(id) === t));
}

/** The template data pass: the layer's features (`where`, `area` and the
 *  base filter of its feature-drawing map layers — not the legend chips) grouped by up to two fields
 *  and a year, with counts and a measure's sum per row, in one pass with no
 *  row cap below SHAPE_MAX_ROWS and every cut reported (`truncated`).
 *  GeoJSON layers read the whole file (scope 'area'); a vector-tile layer
 *  reads the current view only (scope 'view', `complete: false`), must be on,
 *  takes no `area`, and names the voltage tiers this zoom does not draw. */
export async function shapeRows(layerId: string, opts: ShapeOpts = {}): Promise<Outcome<ShapeResult>> {
  const q = queryable(layerId);
  if ('reason' in q) return { ok: false, ...q };
  const plan = planShape(layerId, opts);
  if (typeof plan === 'string') return { ok: false, reason: plan };
  const entry = layerById(layerId)!;
  const compile = await loadFeatureFilter();
  const zoom = state.map?.getZoom() ?? 0;
  if (entry.data!.kind === 'geojson') {
    const test = buildTest(layerId, { where: opts.where, area: opts.area }, compile, zoom, baseFilters(layerId));
    if (typeof test !== 'function') return { ok: false, ...test };
    const features = await featuresOf(layerId);
    if (typeof features === 'string') return { ok: false, reason: features };
    return { ok: true, result: { layerId, scope: 'area', ...runShape(layerId, features, test, plan), complete: true, precision: 'full geometry' } };
  }
  if (opts.complete) return { ok: false, reason: `"${layerId}" is a tiled layer: it covers the current view only, and this needs the whole layer` };
  if (opts.area) return { ok: false, reason: `"${layerId}" is a tiled layer: tiled layers cover the current view only, so leave out area and frame the region on the map` };
  if (!state.layerVisibility[layerId]) return { ok: false, reason: `"${layerId}" is off: switch the layer on to use it in a template` };
  const map = state.map;
  if (!map || !state.mapReady) return { ok: false, reason: 'the map is not ready' };
  const shown = shownMapLayers(layerId).filter(id => drawsFeatures(layerId, id));
  if (!shown.length) return { ok: false, reason: `"${layerId}" draws no features in its current mode` };
  const drawn = shown.filter(inZoom);
  if (!drawn.length) {
    const from = Math.min(...shown.map(id => (map.getLayer(id) as { minzoom?: number }).minzoom ?? 0));
    return { ok: false, reason: `"${layerId}" is not drawn at zoom ${zoom.toFixed(1)}${Number.isFinite(from) && from > zoom ? `: zoom in to ${from} to use it in a template` : ''}` };
  }
  const test = buildTest(layerId, { where: opts.where }, compile, zoom, drawn.map(id => BASE_LAYER_FILTERS[id] ?? null));
  if (typeof test !== 'function') return { ok: false, ...test };
  const b = map.getBounds();
  const pieces = [...tileFeatures(drawn)].flat();
  const features = mergeViewPieces(layerId, pieces, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  const tiersHidden = hiddenTiers(shown, drawn);
  return { ok: true, result: {
    layerId, scope: 'view', ...runShape(layerId, features, test, plan),
    complete: false, reason: `vector tiles: the current view only, from the tiles loaded at zoom ${zoom.toFixed(1)}`,
    ...(tiersHidden && { tiersHidden }),
    precision: `tile geometry at zoom ${zoom.toFixed(1)}, clipped to the view`,
  } };
}

// ─── What a model sees ───────────────────────────────────────────────────────
const clip = (v: unknown) => typeof v === 'string' && v.length > MODEL_MAX_STRING ? v.slice(0, MODEL_MAX_STRING) + '…' : v;

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The longest prefix of `items` whose `out(n)` fits `maxBytes` (largest n first). */
function fit<T>(items: T[], maxBytes: number, out: (n: number) => unknown) {
  let n = items.length;
  while (n > 0 && jsonBytes(out(n)) > maxBytes) n--;
  return out(n);
}

/** A result cut to what may go back to a model, its JSON ≤ `maxBytes` (8 KB):
 *  a query's first ≤ 50 rows (props only, strings ≤ 120 chars), an aggregate's
 *  largest ≤ 200 groups (keys clipped, sums to 4 decimals), each with fewer
 *  until the JSON fits; `returned`, `truncated` and an aggregate's `note`
 *  ("+N more groups") say what was cut, so the answer is always a trimmed one.
 *  The full rows reach the user through the table, never this. */
export function summarise(r: QueryResult | AggregateResult | CountResult, maxBytes = MODEL_MAX_BYTES): Record<string, unknown> {
  const cov = { layerId: r.layerId, complete: r.complete, ...(r.reason && { reason: r.reason }) };
  if ('groups' in r) {
    const groups = r.groups.slice(0, MODEL_MAX_GROUPS).map(g =>
      ({ key: clip(g.key), count: g.count, sums: Object.fromEntries(Object.entries(g.sums).map(([k, v]) => [k, round(v)])) }));
    const more = (n: number) => r.groups.length - n;
    return fit(groups, maxBytes, n => ({ ...cov, groupBy: r.groupBy, sum: r.sum, total: r.total,
      groupCount: r.groups.length, returned: n, truncated: more(n) > 0, groups: groups.slice(0, n),
      ...(more(n) > 0 && { note: `+${more(n)} more groups` }) })) as Record<string, unknown>;
  }
  if (!('rows' in r)) return { ...cov, total: r.total };
  const rows = r.rows.slice(0, MODEL_MAX_ROWS).map(row =>
    ({ id: row.id, ...Object.fromEntries(Object.entries(row.props).map(([k, v]) => [k, clip(v)])) }));
  return fit(rows, maxBytes, n => ({ ...cov, fields: r.fields, total: r.total, returned: n,
    truncated: n < r.total, rows: rows.slice(0, n) })) as Record<string, unknown>;
}

/** `rows` cut to what may go back to a model — the first ≤ `maxItems`, each
 *  string clipped, the JSON ≤ `maxBytes` — beside `head`, with `returned`,
 *  `total` and `truncated` saying what was cut. For results (joins) that are
 *  not a query's rows. */
export function capRows(
  head: Record<string, unknown>, rows: Record<string, unknown>[], maxBytes = MODEL_MAX_BYTES, maxItems = MODEL_MAX_ROWS,
): Record<string, unknown> {
  const items = rows.slice(0, maxItems).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)])));
  return fit(items, maxBytes, n => ({ ...head, total: rows.length, returned: n, truncated: n < rows.length, rows: items.slice(0, n) })) as Record<string, unknown>;
}
