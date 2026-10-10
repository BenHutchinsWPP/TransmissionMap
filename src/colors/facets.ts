// Legend facets: one BucketedField record per legend filter, in legend order.
// Each record carries the facet's URL group code, buckets (with their URL codes
// and `values`), default active set, title key, swatch and target map layers.
// assets/filters.ts derives each facet's applier (FACET_APPLIERS) and
// assets/ui/ui-legends.ts pairs record and applier into LEGEND_FILTERS.
// Pure data: imports src/colors/* and types only, never assets/ or
// src/registry/.
import type { BucketedField } from '../types.js';
import { FUEL_LEGEND } from './fuel.js';
import {
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
