// ─── Filter value maps (bucket id → array of feature property values) ────────

import { state } from './state.js';
import type { FilterSpecification } from 'maplibre-gl';
import type { BucketDef } from '../src/types.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { FUEL_LEGEND } from '../src/colors/fuel.js';
import {
  KV_BUCKETS, OSM_FUEL_BUCKETS, EIA_FUEL_BUCKETS,
  NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS,
  PIPELINE_TYPE_BUCKETS, CRITHAB_BUCKETS, CRITHAB_MAP,
  PADUS_CLASS_BUCKETS, PADUS_CLASS_MAP,
  TRIBAL_BUCKETS, TRIBAL_MAP,
  NERC_BUCKETS, NERC_MAP,
  OGF_STATUS_BUCKETS, OGF_STATUS_MAP,
  OGF_SCENARIO_BUCKETS, OGF_SCENARIO_MAP,
  OGF_PLANAUTH_BUCKETS, OGF_PLANAUTH_MAP,
  RETAIL_TYPE_BUCKETS, RETAIL_TYPE_MAP,
  SUBSTANCE_BUCKETS, SUBSTANCE_MAP,
  SECTOR_BUCKETS, SECTOR_MAP,
} from '../src/colors/buckets.js';
import {
  MINES_COMMODITY_BUCKETS, MINES_COMMODITY_MAP,
  MINES_STATUS_BUCKETS, MINES_STATUS_MAP,
} from '../src/colors/minerals.js';

const OSM_FUEL_MAP = {
  wind:       ["wind"],
  solar:      ["solar"],
  hydro:      ["hydro"],
  nuclear:    ["nuclear"],
  coal:       ["coal"],
  gas:        ["gas"],
  oil:        ["oil"],
  battery:    ["battery"],
  geothermal: ["geothermal"],
  biomass:    ["biomass", "biogas", "waste"],
};

const EIA_FUEL_MAP = {
  wind:    ["WND"],
  solar:   ["SUN"],
  hydro:   ["WAT"],
  nuclear: ["NUC"],
  coal:    ["BIT", "SUB", "LIG", "PC"],
  gas:     ["NG", "OG"],
  oil:     ["DFO", "RFO", "KER"],
  storage: ["MWH", "ES"],
  geo:     ["GEO"],
  biomass: ["WDS", "WDL", "MSW", "BLQ"],
};

const NATGAS_PIPE_TYPE_MAP = {
  interstate: ["Interstate"],
  intrastate: ["Intrastate"],
  hgl:        ["HGL"],
  gathering:  ["Gathering"],
};

const NATGAS_FAC_TYPE_MAP = {
  lng_terminal:  ["lng_terminal"],
  underground:   ["underground"],
  spr:           ["spr"],
  trading_hub:   ["trading_hub"],
  processing:    ["processing"],
  border_cross:  ["border_cross"],
  peak_shaving:  ["peak_shaving"],
  lng_storage:   ["lng_storage"],
  pol_terminal:  ["pol_terminal"],
};

export const PIPELINE_TYPE_MAP = {
  pig_launcher: ["pig_launcher"],
  compressor:   ["substation", "pump_station"],
  delivery:     ["delivery", "receipt", "reciept", "measurement", "meter"],
  interconnect: ["interconnect"],
  end:          ["end"],
};

const GEN_MW_FIELDS: Record<string, string> = {
  "osm-plant-icons":      "output_mw",
  "osm-plant-heat":       "output_mw",
  "osm-gen-circles":      "output_mw",
  "eia-gen-circles":      "nameplate_mw",
  "eia-gen-heat":         "nameplate_mw",
  "osm-plants-polygons-fill":    "output_mw",
  "osm-plants-polygons-outline": "output_mw",
};

export const MW_SLIDER_MAX = 10000; // sentinel MW: top of range = no upper bound

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
  for (const mlId of mapLayerIds) {
    if (!state.map.getLayer(mlId)) continue;
    state.map.setFilter(mlId, combineFilters(BASE_LAYER_FILTERS[mlId] ?? null, bucketExpr));
  }
}

function applyBucketFilterToLayers(layerIds: string[], field: string, activeSet: Set<string>, buckets: BucketDef[], valueMap: Record<string, string[]>) {
  if (!state.mapReady) return;
  const bucketExpr = buildValueFilterExpr(field, activeSet, buckets, valueMap);
  setBucketFilter(layerIds, bucketExpr);
}

export function applyNatgasLineFilter() {
  applyBucketFilterToLayers(
    ["hifld-natgas-interstate", "hifld-natgas-intrastate",
     "hifld-natgas-hgl", "hifld-natgas-gathering"],
    "pipe_type", state.legendFilters.natgasLine, NATGAS_PIPE_TYPE_BUCKETS, NATGAS_PIPE_TYPE_MAP);
}

export function applyNatgasPtsFilter() {
  applyBucketFilterToLayers(
    ["hifld-natgas-points", "hifld-petroleum-facilities"],
    "fac_type", state.legendFilters.natgasPts, NATGAS_FAC_TYPE_BUCKETS, NATGAS_FAC_TYPE_MAP);
}

export function applySubstanceFilter() {
  applyBucketFilterToLayers(
    ["osm-pipelines-lines"],
    "substance", state.legendFilters.substance, SUBSTANCE_BUCKETS, SUBSTANCE_MAP);
}

// Status + scenario + planning-authority all target the same two OGF map
// layers, so they must be combined in one setFilter call — applying them via
// separate applyBucketFilterToLayers calls would clobber each other.
export function applyOGFFilters() {
  if (!state.mapReady) return;
  const expr = combineFilters(
    buildValueFilterExpr("Status",    state.legendFilters.ogfStatus,   OGF_STATUS_BUCKETS,   OGF_STATUS_MAP),
    buildValueFilterExpr("Portfolio", state.legendFilters.ogfScenario, OGF_SCENARIO_BUCKETS, OGF_SCENARIO_MAP),
    buildValueFilterExpr("PlanAuth",  state.legendFilters.ogfPlanAuth, OGF_PLANAUTH_BUCKETS, OGF_PLANAUTH_MAP));
  setBucketFilter(["ogf-planned-lines-casing", "ogf-planned-lines"], expr);
}

// Commodity + status both target the same two mine layers, so combine into one
// setFilter call (like applyOGFFilters).
export function applyMinesFilter() {
  if (!state.mapReady) return;
  const expr = combineFilters(
    buildValueFilterExpr("cat",    state.legendFilters.mines,       MINES_COMMODITY_BUCKETS, MINES_COMMODITY_MAP),
    buildValueFilterExpr("status", state.legendFilters.minesStatus, MINES_STATUS_BUCKETS,    MINES_STATUS_MAP));
  setBucketFilter(["mines-icons"], expr);
}

export function applyPipelineTypeFilter() {
  applyBucketFilterToLayers(
    ["osm-pipelines-points"],
    "pipeline", state.legendFilters.pipeline, PIPELINE_TYPE_BUCKETS, PIPELINE_TYPE_MAP);
}

export function applyCritHabFilter() {
  applyBucketFilterToLayers(
    ["crithab-fill", "crithab-outline"],
    "listing_st", state.legendFilters.crithab, CRITHAB_BUCKETS, CRITHAB_MAP);
}

export function applyPadusClassFilter() {
  applyBucketFilterToLayers(
    ["padus-fill", "padus-outline"],
    "desig", state.legendFilters.padus, PADUS_CLASS_BUCKETS, PADUS_CLASS_MAP);
}

export function applyTribalClassFilter() {
  applyBucketFilterToLayers(
    ["tribal-fill", "tribal-outline"],
    "area_type", state.legendFilters.tribal, TRIBAL_BUCKETS, TRIBAL_MAP);
}

export function applyNercFilter() {
  applyBucketFilterToLayers(
    ["nerc-fill", "nerc-outline"],
    "code", state.legendFilters.nerc, NERC_BUCKETS, NERC_MAP);
}

export function applyRetailTypeFilter() {
  applyBucketFilterToLayers(
    ["retail-fill", "retail-outline"],
    "type", state.legendFilters.retail, RETAIL_TYPE_BUCKETS, RETAIL_TYPE_MAP);
}

export function applyVoltageFilter() {
  if (!state.mapReady) return;
  for (const entry of LAYERS) {
    if (entry.filterType !== "kv") continue;
    const bucketExpr = buildKvFilterExpr(entry.filterField!, state.legendFilters.kv, KV_BUCKETS);
    setBucketFilter(entry.mapLayerIds, bucketExpr);
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
    return buildValueFilterExpr(
      entry.filterField!, globalFuelToOsm(fuelFilter), OSM_FUEL_BUCKETS, OSM_FUEL_MAP);
  }
  if (entry.filterType === "fuel_eia") {
    return buildEiaFuelExpr(entry.filterField!, fuelFilter);
  }
  return null;
}

export function applyGeneratorFilters() {
  if (!state.mapReady || !state.map) return;
  for (const entry of LAYERS) {
    if (entry.group !== "generators") continue;

    const fuelExpr = buildGenFuelExpr(entry);
    const yearExpr = entry.yearFilterLayer ? buildYearFilterExpr() : null;
    // sector_name only exists on EIA data; OSM generators are untouched
    const sectorExpr = entry.filterType === "fuel_eia"
      ? buildValueFilterExpr("sector_name", state.legendFilters.sector, SECTOR_BUCKETS, SECTOR_MAP)
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
      if (!state.map.getLayer(mlId)) continue;
      const base    = BASE_LAYER_FILTERS[mlId] ?? null;
      const mwField = GEN_MW_FIELDS[mlId];
      const mwExpr  = mwField ? buildMwFilterExpr(mwField, state.mwFilter.min, state.mwFilter.max) : null;
      state.map.setFilter(mlId, combineFilters(base, fuelExpr, mwExpr, statusExpr, yearExpr, sectorExpr));
    }
  }
}

// ─── Base-filter registry ─────────────────────────────────────────────────────
const BASE_LAYER_FILTERS: Record<string, FilterSpecification | null> = {};

// Must be called once per MapLibre layer ID immediately after map.addLayer().
// Integration contract between layer renderers (map-layers-*.ts) and the
// filter/visibility system — every add*Layer() call must register here.
export function registerBaseFilter(layerId: string, filter: FilterSpecification | null) {
  BASE_LAYER_FILTERS[layerId] = filter ?? null;
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

const LAYER_FILTER_VALUE_MAPS: Record<string, Record<string, string[]>> = {
  pipeline_type:    PIPELINE_TYPE_MAP,
  natgas_pipe_type: NATGAS_PIPE_TYPE_MAP,
  natgas_fac_type:  NATGAS_FAC_TYPE_MAP,
};

export function applyLayerFilter(registryId: string) {
  const entry = layerById(registryId);
  if (!entry || !state.mapReady) return;
  if (entry.group === "generators") { applyGeneratorFilters(); return; }
  if (!entry.filterType) return;
  const active = state.layerFilters[registryId];
  if (!active) return;

  const valueMap = LAYER_FILTER_VALUE_MAPS[entry.filterType];
  const bucketExpr = valueMap
    ? buildValueFilterExpr(entry.filterField!, active, entry.filterBuckets ?? [], valueMap)
    : null;

  setBucketFilter(entry.mapLayerIds, bucketExpr);
}

// ─── Bus subscriptions ────────────────────────────────────────────────────────
import { on } from './state-bus.js';
on('filter:generators',    applyGeneratorFilters);
on('filter:voltage',       applyVoltageFilter);
on('filter:natgas-line',   applyNatgasLineFilter);
on('filter:natgas-pts',    applyNatgasPtsFilter);
on('filter:ogf-status',    applyOGFFilters);
on('filter:ogf-scenario',  applyOGFFilters);
on('filter:ogf-planauth',  applyOGFFilters);
on('filter:substance',     applySubstanceFilter);
on('filter:pipeline-type', applyPipelineTypeFilter);
on('filter:padus',         applyPadusClassFilter);
on('filter:tribal',        applyTribalClassFilter);
on('filter:crithab',       applyCritHabFilter);
on('filter:nerc',          applyNercFilter);
on('filter:retail',        applyRetailTypeFilter);
on('filter:layer',         ({ id }) => applyLayerFilter(id));
on('filter:all',           () => {
  applyVoltageFilter();
  applyGeneratorFilters();
  applyPipelineTypeFilter();
  applyPadusClassFilter();
  applyTribalClassFilter();
  applyCritHabFilter();
  applyNercFilter();
  applyRetailTypeFilter();
  applyNatgasLineFilter();
  applyNatgasPtsFilter();
  applySubstanceFilter();
  applyOGFFilters();
  applyMinesFilter();
});
