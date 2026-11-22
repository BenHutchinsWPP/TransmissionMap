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
//       state.sourcesData, loading it first with loadSource().
//       A vector-tile layer whose dataset is in COLUMNS_DATASETS (scope
//       'dataset', the default) reads its columns file (columns/columns-read.ts,
//       dynamic import): every row, pruned by row group on the Conditions of
//       `where`, `area` and (asDrawn) the view's where and Area, each row tested
//       as {type, id, properties}; rows carry a point on the feature
//       (`pointOnly`), length/area come from the file's measures. `fragments`,
//       `ids`, `scope: 'view'` and shapeRows `geometry: 'full'` stay on the view,
//       and so does a call whose file is missing, stale, timed out or over
//       COLUMNS_MAX_BYTES (`reason` says why). Any other vector-tile layer reads
//       only the loaded tiles (querySourceFeatures, deduplicated on
//       featureId()) and says so: `complete: false, reason`. With
//       `fragments: true` the pieces of a tile-cut polygon are merged into one
//       MultiPolygon per id (parts concatenated, not unioned).
//       The pure half — buildTest(), runQuery(), runAggregate(), the row-source
//       rules and the shape passes — is dataset-core.ts and needs no map; the
//       map reads are dataset-view.ts. Outside tests only this module and
//       dataset-view.ts import them; this one keeps the columns-file I/O and the public async API, and re-exports
//       the names the rest of the app imports.
//
// Deps: state.ts, dataset-core.ts, dataset-view.ts, registry (layerById, LAYERS),
//       field-schema.ts (FIELD_SCHEMA), field-roles.ts (rolesOf),
//       condition-compile.ts (Condition), area-filter.ts (areaCondition),
//       filters.ts (whereOwnership), feature-id.ts (featureId),
//       layers/layer-data.ts (liveGeneratedUtc), layers/layer-source.ts
//       (layerSourceId), layers/base-filters.ts (BASE_LAYER_FILTERS); dynamic imports: @maplibre/maplibre-gl-style-spec
//       (featureFilter) and columns/columns-read.ts (hyparquet stays out of the
//       boot bundle).

import type { FilterSpecification } from 'maplibre-gl';
import { state } from './state.js';
import { layerById, LAYERS } from '../src/registry/index.js';
import { FIELD_SCHEMA } from '../src/registry/field-schema.js';
import { rolesOf } from '../src/registry/field-roles.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { areaCondition, type AreaFilter } from '../src/registry/area-filter.js';
import { whereOwnership } from './filters.js';
import { featureId } from './feature-id.js';
import { liveGeneratedUtc } from './layers/layer-data.js';
import { layerSourceId } from './layers/layer-source.js';
import { BASE_LAYER_FILTERS } from './layers/base-filters.js';
import type { ColumnsEntry, ColumnsRow } from './columns/columns-read.js';
import type { Outcome, Refusal } from '../src/outcome.js';
import {
  queryable, allowedFields, hasColumns, readFrom, coverageOf, rowSource, queryRows, countRows, aggregateRows, shapeViewRefusal,
  buildTest, rowPlan, propOrder, aggregator, planShape, runShape, shapeFeature, shapeAccumulator, usTagged, mergeViewPieces,
  type FeatureFilterFn, type RowSource, type Description, type FieldInfo, type QueryOpts, type RowOpts,
  type AggregateOpts, type QueryRow, type QueryResult, type CountResult, type AggregateResult, type ColumnsFeature,
  type ShapeOpts, type ShapeResult, type ShapePlan, type Coverage,
} from './dataset-core.js';
import {
  drawnFilters, drawnView, featuresOf, tileFeatures, baseFilters, drawsFeatures, shownMapLayers, inZoom, hiddenTiers,
} from './dataset-view.js';

export { QUERY_MAX_ROWS, allowedFields, hasColumns, shapeSlots } from './dataset-core.js';
export type { FieldInfo, QueryOpts, QueryRow, Group, QueryResult, CountResult, AggregateResult, ShapeKey, ShapeRow } from './dataset-core.js';

const MODEL_MAX_ROWS = 50;
const MODEL_MAX_BYTES = 8 * 1024;
const MODEL_MAX_GROUPS = 200;
const MODEL_MAX_STRING = 120;
const MAX_DOMAIN_VALUES = 60;

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
    queryable: true, kind, ...coverageOf(layerId, kind === 'geojson' ? 'geojson' : hasColumns(layerId) ? 'columns' : 'view'),
    idField: q.idField, fields,
    ...(roles && { geometry: roles.geometry, label: roles.label, derived: roles.derived }),
    ...(loaded !== undefined && { rowCount: loaded }),
    credit: entry.data!.credit,
    ...(generated && { generated_utc: generated }),
  } };
}

// ─── Columns files (scope 'dataset') ─────────────────────────────────────────
/** The most a dataset-scope call may plan to read (compressed column chunks); above it the call uses the view. */
const COLUMNS_MAX_BYTES = 32 * 1024 * 1024;


// Why a dataset-scope call answered from the view instead.
const WHY: Record<string, string> = {
  unavailable: 'no whole-dataset file is published for it',
  offline: 'its whole-dataset file could not be reached',
  'stale-build': 'its whole-dataset file is out of date',
  timeout: 'its whole-dataset file timed out',
  'unsafe-id': 'its whole-dataset file holds an id too large to read',
  'too-large': `the whole-dataset read would exceed ${COLUMNS_MAX_BYTES / 1024 / 1024} MiB`,
  error: 'its whole-dataset file could not be read',
};
class Miss extends Error { constructor(readonly reason: string) { super(reason); } }
const whyOf = (e: unknown) => {
  const r = (e as { reason?: unknown } | null)?.reason;
  return WHY[typeof r === 'string' && Object.hasOwn(WHY, r) ? r : 'error'];
};

type ColumnsMod = typeof import('./columns/columns-read.js');
let columnsMod: Promise<ColumnsMod> | null = null;
const loadColumns = () => columnsMod ??= import('./columns/columns-read.js');

/** `conds` and `filters`: everything the row test reads (what columnsFor reads columns for). */
interface ColumnsCtx { mod: ColumnsMod; entry: ColumnsEntry; groups: number[]; conds: Condition[]; filters: unknown[] }

/** The dataset's columns file and the row groups the `prune` Conditions leave (none when `nothing`);
 *  throws a Miss or a read failure. */
async function openColumns(
  dataset: string, prune: Condition[], conds: Condition[], filters: unknown[], nothing = false,
): Promise<ColumnsCtx> {
  const mod = await loadColumns();
  const e = await mod.columnsEntry(dataset);
  if (!e.ok) throw new Miss(e.reason);
  const md = await mod.columnsMeta(e.result);
  return { mod, entry: e.result, groups: nothing ? [] : mod.pruneGroups(md, prune), conds, filters };
}

async function withinBudget(c: ColumnsCtx, columns: readonly string[]) {
  if (await c.mod.plannedBytes(c.entry, c.groups, columns) > COLUMNS_MAX_BYTES) throw new Miss('too-large');
}

function asFeature(r: ColumnsRow): ColumnsFeature {
  const { px, py } = r.measures;
  return { type: 'Feature', id: r.id, properties: r.properties, gtype: r.type, measures: r.measures,
    geometry: px !== undefined && py !== undefined ? { type: 'Point', coordinates: [px, py] } : null as never };
}

let ownerOf: Record<string, string> | null = null;

/** The call's own Conditions — `where` and the area's — which the row test applies (buildTest). */
function ownConds(dataset: string, opts: QueryOpts): Condition[] {
  const c = opts.area && areaCondition(dataset, opts.area);
  return [...(opts.where ?? []), ...(c && c !== 'all' && !('unfiltered' in c) ? [c] : [])];
}

/** The Conditions every row a call passes must meet, for row-group pruning: `where`, the area's and, under
 *  asDrawn, the view's where and Area — when every map layer of the layer obeys them (effectiveFilter ANDs
 *  them unless a kept selection ORs its ids in). The legend parts are not pruned. */
function pruneConds(dataset: string, layerId: string, opts: QueryOpts): Condition[] {
  const out = ownConds(dataset, opts);
  const add = (a: AreaFilter | null) => {
    const c = a && areaCondition(dataset, a);
    if (c && c !== 'all' && !('unfiltered' in c)) out.push(c);
  };
  if (opts.asDrawn) {
    ownerOf ??= whereOwnership(LAYERS);
    const owned = (layerById(layerId)?.mapLayerIds ?? []).every(id => ownerOf![id] === layerId);
    const kept = state.sel?.mode !== 'isolate' && !!state.sel?.ids[layerId]?.length;
    if (owned && !kept) { out.push(...(state.where[layerId] ?? [])); add(state.area); }
  }
  return out;
}

// ─── Map-facing ──────────────────────────────────────────────────────────────
let featureFilterFn: FeatureFilterFn | null = null;
async function loadFeatureFilter(): Promise<FeatureFilterFn> {
  return featureFilterFn ??= (await import('@maplibre/maplibre-gl-style-spec')).featureFilter;
}

/** The feature test for `opts` and, under asDrawn, the drawn filters it holds (at the map's zoom); or why there is none.
 *  `dataset`: the same for a columns-file read, where "as drawn" is the layer's filters over the whole dataset at any zoom. */
async function compileTest(layerId: string, opts: QueryOpts): Promise<Refusal | {
  test: (f: GeoJSON.Feature) => boolean; drawn?: (FilterSpecification | null)[];
  dataset: { test: (f: GeoJSON.Feature) => boolean; drawn?: (FilterSpecification | null)[] };
}> {
  const q = queryable(layerId);
  if ('reason' in q) return q;
  const compile = await loadFeatureFilter();
  const drawn = opts.asDrawn ? drawnFilters(layerId) : undefined;
  // A layer with `drawnOnly` map layers reads only the features its other map layers draw.
  const own = drawn ?? (layerById(layerId)?.drawnOnly ? baseFilters(layerId) : undefined);
  const test = buildTest(layerId, opts, compile, state.map?.getZoom() ?? 0, own);
  if (typeof test !== 'function') return test;
  if (!opts.asDrawn || readFrom(layerId, opts) !== 'columns') return { test, drawn, dataset: { test, drawn } };
  const all = drawnFilters(layerId, false);
  const dtest = buildTest(layerId, opts, compile, state.map?.getZoom() ?? 0, all);
  return typeof dtest === 'function' ? { test, drawn, dataset: { test: dtest, drawn: all } } : dtest;
}


/** `run` over the layer's columns file (scope 'dataset'): its result, or why the call goes to the view. */
async function fromColumns<T>(
  layerId: string, opts: QueryOpts, drawn: (FilterSpecification | null)[] | undefined, run: (c: ColumnsCtx) => Promise<T>,
): Promise<{ result: T } | { why: string }> {
  const ds = layerById(layerId)!.dataset!;
  try {
    // asDrawn with nothing drawn passes no row: no row group is read.
    const c = await openColumns(ds, pruneConds(ds, layerId, opts), ownConds(ds, opts), drawn ?? [], !!drawn && !drawn.length);
    return { result: await run(c) };
  } catch (e) {
    return { why: whyOf(e) };
  }
}

/** The rows a view-scope call reads, and their coverage (`why`: the reason a dataset-scope call is here). */
async function viewFeatures(layerId: string, opts: QueryOpts & { fragments?: boolean }, why?: string): Promise<Refusal | RowSource> {
  const features = await featuresOf(layerId, opts.fragments);
  if (typeof features === 'string') return { reason: features };
  const geojson = layerById(layerId)!.data!.kind === 'geojson';
  return rowSource(layerId, geojson ? 'geojson' : 'view', features, opts, drawnView(layerId, opts), why);
}

/** Dataset-scope rows in two phases: the test and sort columns for every row of the kept groups, then the
 *  fields (and the point) for the kept rows only. Unsorted, the first `limit` passing rows in file order. */
async function queryColumns(
  layerId: string, c: ColumnsCtx, test: (f: GeoJSON.Feature) => boolean, opts: RowOpts, plan: { fields: string[]; limit: number },
): Promise<Omit<QueryResult, keyof Coverage>> {
  const { mod, entry } = c;
  const order = opts.orderBy && propOrder(opts.orderBy);
  const first = mod.columnsFor(entry, c.conds, c.filters, opts.orderBy ? [opts.orderBy.field] : []);
  const rest = mod.columnsFor(entry, [], [], [...plan.fields, 'px', 'py'], { rows: true });
  await withinBudget(c, first);
  let total = 0;
  const kept = await mod.readTwoPhase(entry, c.groups, first, rest, async rows => {
    let keep: ColumnsRow[] = [];
    for await (const r of rows) {
      if (!test(asFeature(r))) continue;
      total++;
      if (!order) { if (keep.length < plan.limit) keep.push(r); continue; }
      keep.push(r);
      // A stable sort keeps file order among equals, as runQuery's sort of every hit does.
      if (keep.length >= 2 * plan.limit) keep = keep.sort(order).slice(0, plan.limit);
    }
    return order ? keep.sort(order).slice(0, plan.limit) : keep;
  });
  const rows = kept.map((r): QueryRow => {
    const f = asFeature(r);
    return {
      id: featureId(layerId, f) ?? null,
      props: Object.fromEntries(plan.fields.map(k => [k, r.properties[k] ?? null])),
      feature: { type: 'Feature', id: f.id, geometry: f.geometry, properties: f.properties },
      pointOnly: true,
    };
  });
  return { fields: plan.fields, rows, total, truncated: total > rows.length };
}

export async function query(layerId: string, opts: QueryOpts & RowOpts = {}): Promise<Outcome<QueryResult>> {
  const p = await compileTest(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  let why: string | undefined;
  if (readFrom(layerId, opts) === 'columns') {
    const plan = rowPlan(layerId, opts);
    if (typeof plan === 'string') return { ok: false, reason: plan };
    const r = await fromColumns(layerId, opts, p.dataset.drawn, c => queryColumns(layerId, c, p.dataset.test, opts, plan));
    if ('result' in r) return { ok: true, result: { ...coverageOf(layerId, 'columns', opts, drawnView(layerId, opts)), ...r.result } };
    why = r.why;
  }
  const v = await viewFeatures(layerId, opts, why);
  if ('reason' in v) return { ok: false, ...v };
  return queryRows(layerId, v, p.test, opts);
}

export async function count(layerId: string, opts: QueryOpts = {}): Promise<Outcome<CountResult>> {
  const p = await compileTest(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  let why: string | undefined;
  if (readFrom(layerId, opts) === 'columns') {
    const r = await fromColumns(layerId, opts, p.dataset.drawn, async c => {
      const cols = c.mod.columnsFor(c.entry, c.conds, c.filters, []);
      await withinBudget(c, cols);
      let total = 0;
      for await (const row of c.mod.readGroups(c.entry, c.groups, cols)) if (p.dataset.test(asFeature(row))) total++;
      return total;
    });
    if ('result' in r) return { ok: true, result: { ...coverageOf(layerId, 'columns', opts, drawnView(layerId, opts)), total: r.result } };
    why = r.why;
  }
  const v = await viewFeatures(layerId, opts, why);
  if ('reason' in v) return { ok: false, ...v };
  return { ok: true, result: countRows(v, p.test) };
}

export async function aggregate(layerId: string, opts: QueryOpts & AggregateOpts): Promise<Outcome<AggregateResult>> {
  const p = await compileTest(layerId, opts);
  if ('reason' in p) return { ok: false, ...p };
  let why: string | undefined;
  if (readFrom(layerId, opts) === 'columns') {
    const acc = aggregator(layerId, opts);
    if (typeof acc === 'string') return { ok: false, reason: acc };
    const r = await fromColumns(layerId, opts, p.dataset.drawn, async c => {
      const cols = c.mod.columnsFor(c.entry, c.conds, c.filters, [opts.groupBy, ...(opts.sum ?? [])]);
      await withinBudget(c, cols);
      for await (const row of c.mod.readGroups(c.entry, c.groups, cols)) {
        const f = asFeature(row);
        if (p.dataset.test(f)) acc.add(f);
      }
      return acc.result();
    });
    if ('result' in r) return { ok: true, result: { ...coverageOf(layerId, 'columns', opts, drawnView(layerId, opts)), ...r.result } };
    why = r.why;
  }
  const v = await viewFeatures(layerId, opts, why);
  if ('reason' in v) return { ok: false, ...v };
  return aggregateRows(layerId, v, p.test, opts);
}

/** The shape pass over a columns file: the grouping columns of every passing row in one read; then, for
 *  point features, every k-th passing row (k = ceil(passing / limit), so the sample spans the whole result)
 *  read again with its label and point. */
async function shapeColumns(
  layerId: string, c: ColumnsCtx, test: (f: GeoJSON.Feature) => boolean, plan: ShapePlan, baseFilters: unknown[],
): Promise<Omit<ShapeResult, 'layerId' | 'scope' | 'complete' | 'precision'>> {
  const { mod, entry } = c;
  const wanted = [...plan.by.map(b => b.read ?? b.name), ...(plan.time ? [plan.time] : []),
    ...(plan.bins ? [plan.bins.field] : []), plan.measure];
  const filters = [...c.filters, ...baseFilters];
  const first = mod.columnsFor(entry, c.conds, filters, wanted);
  const second = plan.geometry === 'none' ? [] : mod.columnsFor(entry, [], [], [...wanted, plan.label, 'px', 'py'], { rows: true });
  await withinBudget(c, [...new Set([...first, ...second])]);
  const acc = shapeAccumulator(plan);
  const passing: number[] = [];
  for await (const row of mod.readGroups(entry, c.groups, first)) {
    const f = asFeature(row);
    if (!test(f) || (plan.usOnly && !usTagged(f))) continue;
    acc.add(f);
    if (second.length) passing.push(row.at);
  }
  if (!second.length) return acc.finish(null);
  const k = Math.max(1, Math.ceil(passing.length / plan.limit));
  const picked = k > 1 ? passing.filter((_, i) => i % k === 0) : passing;
  const got = await mod.readRowsAt(entry, picked, second);
  const features: GeoJSON.Feature[] = [];
  for (const at of picked) {
    const r = got.get(at);
    if (!r) throw new Miss('stale-build');
    const g = shapeFeature(layerId, asFeature(r), plan);
    if (g) features.push(g);
  }
  const cut = k > 1 ? `features: every ${k}-th of ${passing.length} kept (${features.length})`
    : features.length < passing.length ? `features: ${features.length} of ${passing.length} kept` : undefined;
  return acc.finish(features, cut);
}

/** The template data pass: the layer's features (`where`, `area` and the
 *  base filter of its feature-drawing map layers — not the legend chips) grouped by up to two fields
 *  and a year, with counts and a measure's sum per row, in one pass with no
 *  row cap below SHAPE_MAX_ROWS and every cut reported (`truncated`).
 *  GeoJSON layers read the whole file (scope 'area'). A COLUMNS_DATASETS layer
 *  reads its columns file (scope 'area', `complete: true`, on or off; features
 *  are points, every k-th passing row past the limit); with `geometry: 'full'`,
 *  `scope: 'view'` or a file it cannot use it reads like any other vector-tile
 *  layer: the current view only (scope 'view', `complete: false`), must be on,
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
  let why: string | undefined;
  if (readFrom(layerId, opts) === 'columns' && plan.geometry !== 'full') {
    const test = buildTest(layerId, { where: opts.where, area: opts.area }, compile, zoom, baseFilters(layerId));
    if (typeof test !== 'function') return { ok: false, ...test };
    const r = await fromColumns(layerId, { where: opts.where, area: opts.area }, undefined, c => shapeColumns(layerId, c, test, plan, baseFilters(layerId) ?? []));
    if ('result' in r) return { ok: true, result: { layerId, scope: 'area', ...r.result, complete: true, precision: 'whole features (columns file)' } };
    why = r.why;
  }
  const whyNote = why ? ` (${why})` : '';
  const refusal = shapeViewRefusal(layerId, opts, !!state.layerVisibility[layerId], why);
  if (refusal) return { ok: false, ...refusal };
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
    complete: false, reason: `vector tiles: the current view only, from the tiles loaded at zoom ${zoom.toFixed(1)}${whyNote}`,
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
