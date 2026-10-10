// ─── Feature filters: legend/range appliers + view `where` conditions ────────
// Every MapLibre filter this module writes is effectiveFilter(mlId) =
// base ∧ applier part ∧ where, written by writeFilter()/refilter() — the one
// setFilter call site here (filters.test.ts enforces it):
//   base    — the layer's own inline filter, registered from its plan spec by
//             applyLayerPlan() through registerBaseFilter() (layers/base-filters.ts,
//             which owns BASE_LAYER_FILTERS);
//   applier — the legend/range expression last computed by an applier
//             (FACET_APPLIERS or a range applier) for that map layer,
//             remembered per map layer so a `where` change re-filters one
//             registry layer without re-running the appliers;
//   where   — state.where[registryId] for the registry layer (LayerDef.dataset
//             set) owning the map layer, compiled by toMapLibreFilter().
// setWhere() validates (view-validate.ts's validateWhere(), the pure check
// share links reuse) and applies one layer's conditions; applyAllWhere() re-filters every
// where-capable map layer from state. Whole-view applies and Reset need neither:
// their applyAllFilters() re-filters every where-owned layer (view-state-paint.test.ts).
// FACET_APPLIERS maps each legend facet (src/colors/facets.ts FACETS) to its
// applier: applyFacet() derived from the record for a facet that is one field
// on its own map layers, a hand applier (voltage, generators, OGF, WestTEC,
// mines, NWS) otherwise. Every applier reads field, buckets and value map
// from the facet record (facet(), facetValueMap()). ui/ui-legends.ts hands them to the legend rows; other
// UI controls call the appliers directly (ui/ui-filters.ts); applyAllFilters()
// (bottom of file) runs every one.
// Deps: state.ts, registry (LAYERS, layerById), src/colors/* (incl. facets.ts), condition-compile.ts,
// view-validate.ts,
// nws-zone-join.ts (NWS feature-state half), diag-log.ts, constants.ts,
// layers/base-filters.ts (BASE_LAYER_FILTERS).

import { state } from './state.js';
import type { FilterSpecification } from 'maplibre-gl';
import type { BucketDef, BucketedField } from '../src/types.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { FUEL_LEGEND, OSM_FUEL_MAP, EIA_FUEL_MAP } from '../src/colors/fuel.js';
import { FACETS, facet, facetValueMap } from '../src/colors/facets.js';
import {
  OSM_FUEL_BUCKETS, EIA_FUEL_BUCKETS, OSM_UNDERGROUND_EXPR, HIFLD_UNDERGROUND_EXPR,
} from '../src/colors/buckets.js';
import { setZoneGroupFilter } from './nws-zone-join.js';
import { toMapLibreFilter, ConditionError, type Condition } from '../src/registry/condition-compile.js';
import { recordDiagEvent } from './diag-log.js';
import { validateWhere } from '../src/registry/view-validate.js';
import { BASE_LAYER_FILTERS } from './layers/base-filters.js';

const GEN_MW_FIELDS: Record<string, string> = {
  "osm-plant-icons":      "output_mw",
  "osm-plant-heat":       "output_mw",
  "osm-gen-circles":      "output_mw",
  "eia-gen-circles":      "nameplate_mw",
  "eia-gen-heat":         "nameplate_mw",
  "osm-plants-polygons-fill":    "output_mw",
  "osm-plants-polygons-outline": "output_mw",
};

// Re-exported so filter/UI callers keep one import site; canonical home is
// constants.ts (url-state-codec.ts imports it there to stay side-effect-free).
export { MW_SLIDER_MAX } from './constants.js';
import { MW_SLIDER_MAX } from './constants.js';

// Slider is log-scaled: handle position is linear 0..MW_SLIDER_POS_MAX, mapping to
// MW decades 1, 10, 100, 1000, 10000 (1000 position units per decade). State always
// stores actual MW; these convert at the slider boundary only.
export const MW_SLIDER_POS_MAX = 4000;
export const mwPosToMw = (pos: number): number =>
  pos <= 0 ? 0 : Math.round(10 ** (Math.min(pos, MW_SLIDER_POS_MAX) / 1000));
export const mwToPos = (mw: number): number =>
  mw <= 0 ? 0 : Math.round(Math.min(Math.max(1000 * Math.log10(mw), 0), MW_SLIDER_POS_MAX));

export function buildMwFilterExpr(field: string, minMw: number, maxMw: number): FilterSpecification | null {
  const mw = ["coalesce", ["to-number", ["get", field]], 0];
  const noMin = minMw <= 0;
  const noMax = maxMw >= MW_SLIDER_MAX;
  if (noMin && noMax) return null;
  if (noMin)          return ["<=", mw, maxMw] as unknown as FilterSpecification;
  if (noMax)          return [">=", mw, minMw] as unknown as FilterSpecification;
  return ["all", [">=", mw, minMw], ["<=", mw, maxMw]] as unknown as FilterSpecification;
}

function buildYearFilterExpr(): FilterSpecification | null {
  // A unit is alive when op_year <= Y < retirement_year (null retirement = ∞/9999).
  // retirement_year is null for the ~85% still-running units; in the built GeoJSON
  // that surfaces as null OR "" (pandas Int64 NA). MapLibre quirk: to-number(null)
  // === 0 and Number("") === 0 — a naive coalesce/to-number collapses every
  // non-retiring unit to "retired in year 0" and they vanish. Normalise: any value
  // <= 0 (null/""/0) means "never retires" → 9999. Multi-arg to-number falls back
  // to 0 on null/""/unparseable (never errors).
  if (!state.yearFilter || !state.yearFilter.enabled) return null;
  const Y = state.yearFilter.year;
  const opNum  = ["to-number", ["get", "op_year"],         0];
  const retNum = ["to-number", ["get", "retirement_year"], 0];
  const opYear  = ["case", [">", opNum, 0], opNum, 0];       // missing op_year → 0 (ancient)
  const retYear = ["case", [">", retNum, 0], retNum, 9999];  // missing retire → ∞
  return ["all", ["<=", opYear, Y], ["<", Y, retYear]] as unknown as FilterSpecification;
}

function combineFilters(...exprs: (FilterSpecification | null)[]) {
  const parts = exprs.filter(Boolean) as FilterSpecification[];
  return parts.length === 0 ? null
       : parts.length === 1 ? parts[0]
       : ["all", ...parts] as FilterSpecification;
}

function setBucketFilter(mapLayerIds: string[], bucketExpr: FilterSpecification | null) {
  if (!state.map) return;
  for (const mlId of mapLayerIds) writeFilter(mlId, [bucketExpr]);
}

function applyBucketFilterToLayers(layerIds: string[], field: string, activeSet: Set<string>, buckets: BucketDef[], valueMap: Record<string, string[]>) {
  if (!state.mapReady) return;
  const bucketExpr = compileBucketExpr(field, activeSet, buckets, valueMap);
  setBucketFilter(layerIds, bucketExpr);
}

// Facets that target the same map layers (the first facet's mapLayerIds) must
// be combined into one setFilter call — separate applyBucketFilterToLayers
// calls would clobber each other. Parts combine in the order the keys list.
function applyFacetGroup(keys: string[]) {
  if (!state.mapReady) return;
  const facets = keys.map(facet);
  const expr = combineFilters(...facets.map(f =>
    buildValueFilterExpr(f.field!, state.legendFilters[f.key], f.buckets, facetValueMap(f))));
  setBucketFilter(facets[0].mapLayerIds!, expr);
}

export const applyOGFFilters     = () => applyFacetGroup(["ogfStatus", "ogfRegion", "ogfWork"]);
export const applyWestTECFilters = () => applyFacetGroup(["westtecScenario", "westtecDataset"]);
export const applyMinesFilter    = () => applyFacetGroup(["mines", "minesStatus"]);

export function applyNwsGroupFilter() {
  const nws = facet("nwsGroup");
  applyFacet(nws);

  // Joined zone/county layers (nws-zone-join.ts) paint via feature-state, which
  // setFilter/BucketFilterToLayers above can't see — drive their opacity
  // directly instead. Same active-set semantics: all buckets active → null
  // ("all groups on", uses the default null-guard paint); otherwise the exact
  // active bucket ids (possibly empty → nothing visible).
  const active = state.legendFilters.nwsGroup;
  setZoneGroupFilter(active.size === nws.buckets.length ? null : [...active]);
}

// osm/hifld transmission lines carry an overhead/underground placement flag;
// other "kv" entries (substations) have no such field and get no filter.
function buildUndergroundExpr(entryId: string): FilterSpecification | null {
  const undergroundExpr =
    entryId === "osm-transmission-lines"   ? OSM_UNDERGROUND_EXPR
    : entryId === "hifld-transmission-lines" ? HIFLD_UNDERGROUND_EXPR
    : null;
  if (!undergroundExpr) return null;

  const active = state.legendFilters.underground;
  if (!active) return null;
  if (active.size === facet("underground").buckets.length) return null; // both on → no filter
  if (active.size === 0) return anyOfConds([]); // none active → match nothing
  if (active.has("underground")) return undergroundExpr as unknown as FilterSpecification;
  return ["!", undergroundExpr] as unknown as FilterSpecification;
}

export function applyVoltageFilter() {
  if (!state.mapReady) return;
  for (const entry of LAYERS) {
    if (entry.filterType !== "kv") continue;
    const bucketExpr = buildKvFilterExpr(entry.filterField!, state.legendFilters.kv, facet("kv").buckets);
    const ugExpr = buildUndergroundExpr(entry.id);
    setBucketFilter(entry.mapLayerIds, combineFilters(bucketExpr, ugExpr));
  }
}

function globalFuelToOsm(activeGlobalIds: Set<string>) {
  const s = new Set<string>();
  for (const e of FUEL_LEGEND) if (activeGlobalIds.has(e.id)) s.add(e.osmBucket);
  return s;
}
function globalFuelToEia(activeGlobalIds: Set<string>) {
  const s = new Set<string>();
  for (const e of FUEL_LEGEND) if (activeGlobalIds.has(e.id)) s.add(e.eiaBucket);
  return s;
}

// Pumped storage shares energy_source "WAT" with hydro and is only separable via
// prime_mover == "PS". Generic value-map filter can't express that, so carve out
// the hydro/pumped-storage pair by hand; everything else goes through the value map.
// OSM gens have no prime_mover, so the pumped_storage toggle is EIA-only (it maps to
// no OSM source value and thus never matches there).
function buildEiaFuelExpr(field: string, fuelFilter: Set<string>): FilterSpecification | null {
  const eiaActive = globalFuelToEia(fuelFilter);
  if (eiaActive.size === EIA_FUEL_BUCKETS.length) return null; // all on → no filter
  const hydro = eiaActive.has("hydro");
  const ps    = eiaActive.has("pumped_storage");
  const rest  = new Set(eiaActive); rest.delete("hydro"); rest.delete("pumped_storage");
  const conds: FilterSpecification[] = [];
  if (rest.size) {
    const base = buildValueFilterExpr(field, rest, EIA_FUEL_BUCKETS, EIA_FUEL_MAP);
    if (base) conds.push(base);
  }
  if (hydro && ps) conds.push(["==", ["get", field], "WAT"] as unknown as FilterSpecification);
  else if (hydro)  conds.push(["all", ["==", ["get", field], "WAT"], ["!=", ["get", "prime_mover"], "PS"]] as unknown as FilterSpecification);
  else if (ps)     conds.push(["==", ["get", "prime_mover"], "PS"] as unknown as FilterSpecification);
  return anyOfConds(conds);
}

function buildGenFuelExpr(entry: (typeof LAYERS)[number]) {
  const fuelFilter = state.legendFilters.fuel;
  if (!fuelFilter) return null;
  if (entry.filterType === "fuel_osm") {
    return compileBucketExpr(
      entry.filterField!, globalFuelToOsm(fuelFilter), OSM_FUEL_BUCKETS, OSM_FUEL_MAP);
  }
  if (entry.filterType === "fuel_eia") {
    return buildEiaFuelExpr(entry.filterField!, fuelFilter);
  }
  return null;
}

export function applyGeneratorFilters() {
  if (!state.mapReady || !state.map) return;
  const sector = facet("sector");
  for (const entry of LAYERS) {
    if (entry.group !== "generators") continue;

    const fuelExpr = buildGenFuelExpr(entry);
    const yearExpr = entry.yearFilterLayer ? buildYearFilterExpr() : null;
    // sector_name only exists on EIA data; OSM generators are untouched
    const sectorExpr = entry.filterType === "fuel_eia"
      ? compileBucketExpr(sector.field!, state.legendFilters.sector, sector.buckets, facetValueMap(sector))
      : null;

    let statusExpr: FilterSpecification | null = null;
    if (entry.filterBuckets && entry.bucketField) {
      const active = state.layerFilters[entry.id];
      if (active && active.size < entry.filterBuckets.length) {
        statusExpr = active.size === 0
          ? anyOfConds([])
          : ["in", ["get", entry.bucketField], ["literal", [...active]]] as unknown as FilterSpecification;
      }
    }

    for (const mlId of entry.mapLayerIds) {
      const mwField = GEN_MW_FIELDS[mlId];
      const mwExpr  = mwField ? buildMwFilterExpr(mwField, state.mwFilter.min, state.mwFilter.max) : null;
      writeFilter(mlId, [fuelExpr, mwExpr, statusExpr, yearExpr, sectorExpr]);
    }
  }
}

// ─── Effective filter: base ∧ applier part ∧ where ────────────────────────────
// Last applier part per map layer, kept as the applier's list of parts so the
// combined expression stays flat (["all", base, fuel, mw, …]) exactly as the
// appliers built it before `where` existed.
const APPLIER_PARTS: Record<string, (FilterSpecification | null)[]> = {};

// Map layers that never obey a registry layer's `where`, with the reason.
// Clustered-source layers draw cluster aggregates, not features, so a
// per-feature filter cannot change what a cluster counts (the plain twin,
// osm-dc-points, stays filterable); highlight twins carry a selection filter
// that a refilter must not overwrite.
const WHERE_EXCLUDED_MAP_LAYERS: Record<string, string> = {
  "osm-dc-clusters":          "cluster aggregate",
  "osm-dc-cluster-count":     "cluster aggregate",
  "wecc-path-lines-highlight": "click-selection highlight twin",
};

/** Map layer id → the registry layer whose `where` it obeys: every map layer
 *  of a layer with a `dataset`, including its labels, heat and DC overlays
 *  (the same reach the legend filters have), minus WHERE_EXCLUDED_MAP_LAYERS. */
export function whereOwnership(
  layers: readonly { id: string; dataset?: string; mapLayerIds: readonly string[] }[],
): Record<string, string> {
  const owner: Record<string, string> = {};
  for (const entry of layers) {
    if (!entry.dataset) continue;
    for (const mlId of entry.mapLayerIds) {
      if (!WHERE_EXCLUDED_MAP_LAYERS[mlId]) owner[mlId] = entry.id;
    }
  }
  return owner;
}

const WHERE_OWNER = whereOwnership(LAYERS);

// Bad entries already recorded, so a refilter of ~30 map layers logs one event.
const REPORTED_BAD_WHERE = new Set<string>();

function whereExpr(mlId: string): FilterSpecification | null {
  const owner = WHERE_OWNER[mlId];
  const conds = owner ? state.where[owner] : undefined;
  if (!conds?.length) return null;
  // setWhere validates before writing; this guards a state.where seeded by
  // another path, so an invalid entry is recorded and skipped rather than
  // thrown into the middle of an applyAllFilters() sequence.
  try {
    return toMapLibreFilter(layerById(owner)!.dataset!, conds) as unknown as FilterSpecification;
  } catch (err) {
    if (!(err instanceof ConditionError)) throw err;
    const key = `${owner}|${JSON.stringify(conds)}`;
    if (!REPORTED_BAD_WHERE.has(key)) {
      REPORTED_BAD_WHERE.add(key);
      recordDiagEvent('layer', `where ${owner}: ${err.message}`);
    }
    return null;
  }
}

/** The filter a map layer should carry now: base ∧ last applier part ∧ where. */
export function effectiveFilter(mlId: string): FilterSpecification | null {
  return combineFilters(BASE_LAYER_FILTERS[mlId] ?? null, ...(APPLIER_PARTS[mlId] ?? []), whereExpr(mlId));
}

function refilter(mlId: string) {
  if (!state.map?.getLayer(mlId)) return;
  state.map.setFilter(mlId, effectiveFilter(mlId));
}

function writeFilter(mlId: string, parts: (FilterSpecification | null)[]) {
  APPLIER_PARTS[mlId] = parts;
  refilter(mlId);
}

/** Set (or, with an empty list, clear) one registry layer's view conditions
 *  and re-filter only that layer's map layers. Returns why the conditions were
 *  refused — and changes nothing — or null on success. */
export function setWhere(registryId: string, conditions: Condition[]): string | null {
  const err = validateWhere(registryId, conditions);
  if (err) return err;
  const entry = layerById(registryId)!;

  const where = { ...state.where };
  if (conditions.length) where[registryId] = [...conditions];
  else delete where[registryId];
  state.where = where;

  if (state.mapReady) {
    for (const mlId of entry.mapLayerIds) if (WHERE_OWNER[mlId] === registryId) refilter(mlId);
  }
  return null;
}

/** Re-filter every where-capable map layer from state, for a state.where
 *  write that no applyAllFilters() follows. A layer whose conditions vanished from
 *  state.where returns to base ∧ applier part. */
export function applyAllWhere() {
  if (!state.mapReady) return;
  for (const mlId of Object.keys(WHERE_OWNER)) refilter(mlId);
}

// ─── Filter expression builders ───────────────────────────────────────────────
function anyOfConds(conds: FilterSpecification[]) {
  if (!conds.length) return ["==", ["literal", 1], ["literal", 0]] as FilterSpecification;
  return conds.length === 1 ? conds[0] : ["any", ...conds] as FilterSpecification;
}

const KV_BUCKET_RANGES: Record<string, [(string | number)[] | null, (string | number)[] | null]> = {
  "550+":    [[">=", 550], null],
  "500-549": [[">=", 500], ["<", 550]],
  "300-499": [[">=", 300], ["<", 500]],
  "200-299": [[">=", 200], ["<", 300]],
  "100-199": [[">=", 100], ["<", 200]],
  "<100":    [[">",    0], ["<", 100]],
  "unknown": [null,        ["<=",  0]],
};

export function buildKvFilterExpr(field: string, activeSet: Set<string> | null | undefined, allBuckets: { id: string }[]) {
  if (!activeSet) return null;
  if (activeSet.size === allBuckets.length) return null;
  const kv = ["to-number", ["get", field], -1];
  const conds: FilterSpecification[] = [];
  for (const [id, [lo, hi]] of Object.entries(KV_BUCKET_RANGES)) {
    if (!activeSet.has(id)) continue;
    const parts: FilterSpecification[] = [];
    if (lo) parts.push([lo[0], kv, lo[1]] as FilterSpecification);
    if (hi) parts.push([hi[0], kv, hi[1]] as FilterSpecification);
    conds.push(parts.length === 1 ? parts[0] : ["all", ...parts] as FilterSpecification);
  }
  return anyOfConds(conds);
}

export function buildValueFilterExpr(field: string, activeSet: Set<string> | null | undefined, allBuckets: { id: string }[], valueMap: Record<string, string[]>) {
  if (!activeSet) return null;
  if (activeSet.size === allBuckets.length) return null;
  const allKnown = Object.values(valueMap).flat();
  const allowed: string[] = [];
  for (const [id, vals] of Object.entries(valueMap) as [string, string[]][]) {
    if (activeSet.has(id)) allowed.push(...vals);
  }
  const conds: FilterSpecification[] = [];
  if (allowed.length) conds.push(["in", ["get", field], ["literal", allowed]] as FilterSpecification);
  if (activeSet.has("other")) {
    conds.push(["!", ["in", ["get", field], ["literal", allKnown]]] as FilterSpecification);
  }
  return anyOfConds(conds);
}

// Filtered field → the tile_manifest dataset whose FIELD_SCHEMA entry declares
// it, so the values expression compiles schema-checked. Keyed by field name,
// which is unique across the bucket filters; a field absent here keeps the
// direct builder. `source` is declared identically by osm_plants_points,
// osm_plants_polygons and osm_generators from one shared definition, so any of
// the three names the same check.
export const BUCKET_FILTER_DATASETS: Record<string, string> = {
  pipe_type:   "hifld_natgas_lines",
  fac_type:    "hifld_natgas_points",
  substance:   "osm_pipelines_lines",
  code:        "nerc_regions",
  type:        "retail_territories",
  sector_name: "eia_generators",
  source:      "osm_plants_points",
};

// Active legend buckets → the values expression for the field's dataset.
// Fields with no schema-declared dataset, and bucket sets whose active "other"
// catch-all makes the expression a disjunction, use buildValueFilterExpr.
export function compileBucketExpr(
  field: string,
  activeSet: Set<string> | null | undefined,
  allBuckets: { id: string }[],
  valueMap: Record<string, string[]>,
): FilterSpecification | null {
  const dataset = BUCKET_FILTER_DATASETS[field];
  if (!dataset || !activeSet || activeSet.has("other")) {
    return buildValueFilterExpr(field, activeSet, allBuckets, valueMap);
  }
  if (activeSet.size === allBuckets.length) return null;
  const allowed: string[] = [];
  for (const [id, vals] of Object.entries(valueMap)) if (activeSet.has(id)) allowed.push(...vals);
  if (!allowed.length) return anyOfConds([]);
  // toMapLibreFilter validates against FIELD_SCHEMA and throws ConditionError
  // when a bucket value has drifted outside the declared domain. This runs on
  // the live applyAllFilters() path, which repaintView() calls with no
  // surrounding try/catch, so an escaped throw would abort every
  // remaining applyXFilter() in the sequence and leave the map half-filtered.
  // Falling back to the pre-schema builder keeps the filter usable; the
  // recorded diagnostic is how the drift still gets seen.
  try {
    return toMapLibreFilter(dataset, [{ field, op: "in", value: allowed }]) as unknown as FilterSpecification;
  } catch (err) {
    if (!(err instanceof ConditionError)) throw err;
    recordDiagEvent('layer', `${dataset}.${field}: ${err.message}`);
    return buildValueFilterExpr(field, activeSet, allBuckets, valueMap);
  }
}

// Per-layer legend chips (state.layerFilters): only the generator registry
// layers declare filterBuckets, and applyGeneratorFilters() folds them in.
export function applyLayerFilter(registryId: string) {
  if (layerById(registryId)?.group === "generators") applyGeneratorFilters();
}

// ─── Facet appliers ───────────────────────────────────────────────────────────
// A facet with one field on its own map layers: compileBucketExpr over the
// record's buckets, written to `mapLayerIds` (or the `layerRef` registry layer's).
function applyFacet(f: BucketedField) {
  const mapLayerIds = f.mapLayerIds ?? layerById(f.layerRef!)!.mapLayerIds;
  applyBucketFilterToLayers(mapLayerIds, f.field!, state.legendFilters[f.key], f.buckets, facetValueMap(f));
}

// Facets whose filter is more than one field on its own layers: shared map
// layers (OGF, WestTEC, mines — applyFacetGroup), registry-wide targets (kv,
// underground, fuel, sector) or a feature-state half (nwsGroup). Each reads
// its field and buckets from the facet record.
const HAND_APPLIERS: Record<string, () => void> = {
  kv: applyVoltageFilter, underground: applyVoltageFilter,
  fuel: applyGeneratorFilters, sector: applyGeneratorFilters,
  ogfRegion: applyOGFFilters, ogfStatus: applyOGFFilters, ogfWork: applyOGFFilters,
  mines: applyMinesFilter, minesStatus: applyMinesFilter,
  nwsGroup: applyNwsGroupFilter,
  westtecScenario: applyWestTECFilters, westtecDataset: applyWestTECFilters,
};

/** Facet key (src/colors/facets.ts) → the function that re-filters the map
 *  from state.legendFilters[key]. Keys sharing map layers share one function. */
export const FACET_APPLIERS: Record<string, () => void> = Object.fromEntries(
  FACETS.map(f => [f.key, HAND_APPLIERS[f.key] ?? (() => applyFacet(f))]));

// ─── Apply all ────────────────────────────────────────────────────────────────
/** Re-apply every filter: each facet applier once, in FACETS order, then every
 *  per-layer legend-chip filter. Run by view-state.ts's repaintView() (map
 *  load, Reset, a view apply). */
export function applyAllFilters() {
  for (const apply of new Set(Object.values(FACET_APPLIERS))) apply();
  for (const entry of LAYERS) if (entry.filterBuckets) applyLayerFilter(entry.id);
}
