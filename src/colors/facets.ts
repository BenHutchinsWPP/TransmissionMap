// Legend facets: one BucketedField record per legend filter, in legend order.
// Each record carries the facet's URL group code, field, buckets (with their
// URL codes and `values`), default active set, title key, swatch and target map
// layers. facet(key) looks one up; facetValueMap() is its bucket id → feature
// values map, the one every filter and value domain reads.
// assets/filters.ts derives each facet's applier (FACET_APPLIERS),
// assets/ui/ui-legends.ts pairs record and applier into LEGEND_FILTERS and
// src/registry/field-schema.ts flattens value domains from facetValueMap().
// Also owns the OGF / WestTEC colour-by: each mode names the facet whose field
// and bucket colours paint the line (ogfColorExpr, westtecColorExpr).
// Pure data: imports src/colors/* and types only, never assets/ or
// src/registry/.
import type { ExpressionSpecification } from 'maplibre-gl';
import type { BucketedField } from '../types.js';
import { FUEL_LEGEND } from './fuel.js';
import {
  bucketColorExpr, bucketValueMap,
  KV_BUCKETS, VOLTAGE_LEGEND, PIPELINE_TYPE_BUCKETS, CRITHAB_BUCKETS, PADUS_CLASS_BUCKETS,
  TRIBAL_BUCKETS, NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS,
  NERC_BUCKETS, RETAIL_TYPE_BUCKETS, OGF_STATUS_BUCKETS, SUBSTANCE_BUCKETS, DCM_CLASSES,
  OGF_REGION_BUCKETS, OGF_WORK_BUCKETS, SECTOR_BUCKETS, LINE_PLACEMENT_BUCKETS,
  NWS_GROUP_BUCKETS, WESTTEC_SCENARIO_BUCKETS, WESTTEC_DATASET_BUCKETS,
} from './buckets.js';
import { MINES_COMMODITY_BUCKETS, MINES_STATUS_BUCKETS } from './minerals.js';

const OGF_LINES     = ["ogf-planned-lines-casing", "ogf-planned-lines"];
const WESTTEC_LINES = ["westtec-lines-casing", "westtec-lines"];
const MINES         = ["mines-icons"];

// >>> ADD-LAYER: legend-filters — see docs/adding-a-layer.md §opt
export const FACETS: BucketedField[] = [
  { key: "kv", groupCode: "v", buckets: VOLTAGE_LEGEND, syncBuckets: KV_BUCKETS,
    legendId: "voltageLegend",
    title: "Voltage (kV)", titleKey: "legend.voltage", swatch: "color" },
  { key: "underground", groupCode: "o", buckets: LINE_PLACEMENT_BUCKETS,
    masterId: "linePlacementAllCb", legendId: "linePlacementLegend",
    title: "Line placement", titleKey: "legend.linePlacement", swatch: "line" },
  { key: "fuel", groupCode: "f", buckets: FUEL_LEGEND,
    title: "Fuel Type", titleKey: "legend.fuel", swatch: "icon" },
  { key: "sector", groupCode: "i", buckets: SECTOR_BUCKETS, field: "sector_name",
    title: "EIA Plants — sector", titleKey: "legend.sector", swatch: "none" },
  { key: "pipeline", groupCode: "p", buckets: PIPELINE_TYPE_BUCKETS, field: "pipeline",
    mapLayerIds: ["osm-pipelines-points"],
    title: "Pipeline Points", titleKey: "legend.pipelinePoints", swatch: "icon" },
  { key: "crithab", groupCode: "h", buckets: CRITHAB_BUCKETS, field: "listing_st",
    mapLayerIds: ["crithab-fill", "crithab-outline"],
    title: "Critical Habitat — ESA status", titleKey: "legend.crithab", swatch: "color" },
  { key: "padus", groupCode: "j", buckets: PADUS_CLASS_BUCKETS, field: "desig",
    mapLayerIds: ["padus-fill", "padus-outline"],
    title: "PAD-US — land type", titleKey: "legend.padus", swatch: "color" },
  { key: "tribal", groupCode: "t", buckets: TRIBAL_BUCKETS, field: "area_type",
    mapLayerIds: ["tribal-fill", "tribal-outline"],
    title: "Tribal (Census)", titleKey: "layer.tribalCensus", swatch: "color" },
  { key: "natgasLine", groupCode: "n", buckets: NATGAS_PIPE_TYPE_BUCKETS, field: "pipe_type",
    mapLayerIds: ["hifld-natgas-interstate", "hifld-natgas-intrastate",
                  "hifld-natgas-hgl", "hifld-natgas-gathering"],
    title: "Pipeline type", titleKey: "legend.pipelineType", swatch: "color" },
  { key: "natgasPts", groupCode: "r", buckets: NATGAS_FAC_TYPE_BUCKETS, field: "fac_type",
    mapLayerIds: ["hifld-natgas-points", "hifld-petroleum-facilities"],
    title: "Facility type", titleKey: "legend.facilityType", swatch: "icon" },
  { key: "substance", groupCode: "u", buckets: SUBSTANCE_BUCKETS, field: "substance",
    mapLayerIds: ["osm-pipelines-lines"],
    title: "Pipeline fuel", titleKey: "legend.pipelineFuel", swatch: "color",
    defaultActive: ["gas", "oil", "products", "hydrogen", "coal"] },
  { key: "nerc", groupCode: "c", buckets: NERC_BUCKETS, field: "code",
    mapLayerIds: ["nerc-fill", "nerc-outline"],
    title: "NERC Region", titleKey: "popup.nercRegion", swatch: "color" },
  { key: "retail", groupCode: "e", buckets: RETAIL_TYPE_BUCKETS, field: "type",
    mapLayerIds: ["retail-fill", "retail-outline"],
    title: "Utility type", titleKey: "legend.utilityType", swatch: "color" },
  { key: "dcm", groupCode: "a", buckets: DCM_CLASSES, field: "cls", layerRef: "dc-moratoriums",
    legendId: "dcMoratoriumLegend",
    title: "Data Center Moratoriums", titleKey: "layer.dcMoratoriums", swatch: "color" },
  { key: "ogfRegion", groupCode: "b", buckets: OGF_REGION_BUCKETS, field: "Region",
    mapLayerIds: OGF_LINES,
    title: "Region", titleKey: "popup.region", swatch: "color" },
  { key: "ogfStatus", groupCode: "g", buckets: OGF_STATUS_BUCKETS, field: "Status",
    mapLayerIds: OGF_LINES,
    title: "Project status", titleKey: "legend.status", swatch: "color" },
  { key: "ogfWork", groupCode: "m", buckets: OGF_WORK_BUCKETS, field: "Work",
    mapLayerIds: OGF_LINES,
    title: "Type of work", titleKey: "legend.typeOfWork", swatch: "line" },
  { key: "mines", groupCode: "k", buckets: MINES_COMMODITY_BUCKETS, field: "cat",
    mapLayerIds: MINES,
    title: "Mines — commodity", titleKey: "legend.minesCommodity", swatch: "icon" },
  { key: "minesStatus", groupCode: "d", buckets: MINES_STATUS_BUCKETS, field: "status",
    mapLayerIds: MINES,
    title: "Mines — status", titleKey: "legend.minesStatus", swatch: "none", defaultActive: ["active"] },
  { key: "nwsGroup", groupCode: "q", buckets: NWS_GROUP_BUCKETS, field: "_group",
    mapLayerIds: ["nws-alerts-fill", "nws-alerts-line"],
    title: "Weather Alerts", titleKey: "legend.weatherAlerts", swatch: "color" },
  { key: "westtecScenario", groupCode: "x", buckets: WESTTEC_SCENARIO_BUCKETS, field: "scenario",
    mapLayerIds: WESTTEC_LINES,
    title: "Scenario", titleKey: "legend.scenario", swatch: "color" },
  { key: "westtecDataset", groupCode: "z", buckets: WESTTEC_DATASET_BUCKETS, field: "dataset",
    mapLayerIds: WESTTEC_LINES,
    title: "Project Type", titleKey: "legend.projectType", swatch: "color" },
];

const BY_KEY: Record<string, BucketedField> = Object.fromEntries(FACETS.map(f => [f.key, f]));

/** The facet record for a state.legendFilters key; throws on an unknown key. */
export function facet(key: string): BucketedField {
  const f = BY_KEY[key];
  if (!f) throw new Error(`unknown facet "${key}"`);
  return f;
}

/** A facet's bucket id → feature values: the buckets' `values`, or, when no
 *  bucket declares any, each bucket id as its own literal value. */
export function facetValueMap(f: BucketedField): Record<string, string[]> {
  return f.buckets.some(b => b.values)
    ? bucketValueMap(f.buckets)
    : Object.fromEntries(f.buckets.map(b => [b.id, [b.id]]));
}

// ─── Colour-by: mode → the facet that paints the line ─────────────────────────
// ogf-planned-lines / westtec-lines take line-color from state.ogfColorBy /
// state.westtecColorBy (assets/style-overrides.ts validates the mode). The
// fallback is the facet's "other" bucket colour; buckets without one (WestTEC —
// every row has a real value) fall back to neutral gray, never hit in practice.
export type OgfColorMode = "region" | "status";
export type WesttecColorMode = "scenario" | "dataset";
export const OGF_COLOR_BY: Record<OgfColorMode, string> = { region: "ogfRegion", status: "ogfStatus" };
export const WESTTEC_COLOR_BY: Record<WesttecColorMode, string> = {
  scenario: "westtecScenario", dataset: "westtecDataset",
};
export const OGF_COLOR_MODES = Object.keys(OGF_COLOR_BY) as OgfColorMode[];
export const WESTTEC_COLOR_MODES = Object.keys(WESTTEC_COLOR_BY) as WesttecColorMode[];

function facetColorExpr(key: string): ExpressionSpecification {
  const { field, buckets } = facet(key);
  return bucketColorExpr(field!, buckets, buckets.find(b => b.id === "other")?.color ?? "#94a3b8");
}
export const ogfColorExpr = (mode: OgfColorMode) => facetColorExpr(OGF_COLOR_BY[mode]);
export const westtecColorExpr = (mode: WesttecColorMode) => facetColorExpr(WESTTEC_COLOR_BY[mode]);
