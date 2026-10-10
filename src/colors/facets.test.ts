// @vitest-environment jsdom
// Pins the legend facets and the bucket value maps to literals captured before
// the facet records (facets.ts) took over: each LEGEND_FILTERS row keeps its
// URL group code, bucket ids and URL codes, defaults, DOM ids, title key and
// swatch, and each value map keeps its exact entries in order. A shared link
// decodes through these codes, so any drift here is a broken link.
import { describe, it, expect } from 'vitest';
import { LEGEND_FILTERS } from '../../assets/ui/ui-legends.js';
import * as F from './fuel.js';
import * as B from './buckets.js';
import * as M from './minerals.js';

const LEGEND_ROWS = [
  {"key": "kv", "groupCode": "v", "buckets": [["550+", "H"], ["500-549", "F"], ["300-499", "G"], ["200-299", "T"], ["100-199", "P"], ["<100", "L"], ["unknown", "U"]], "syncBuckets": ["550+", "500-549", "300-499", "200-299", "100-199", "<100", "unknown"], "masterId": "kvAllCb", "legendId": "voltageLegend", "itemsId": "voltageLegendItems", "titleKey": "legend.voltage", "title": "Voltage (kV)", "swatch": "color"},
  {"key": "underground", "groupCode": "o", "buckets": [["overhead", "o"], ["underground", "u"]], "masterId": "linePlacementAllCb", "legendId": "linePlacementLegend", "itemsId": "linePlacementLegendItems", "titleKey": "legend.linePlacement", "title": "Line placement", "swatch": "line"},
  {"key": "fuel", "groupCode": "f", "buckets": [["wind", "w"], ["solar", "s"], ["hydro", "h"], ["pumped_storage", "p"], ["nuclear", "n"], ["coal", "c"], ["gas", "g"], ["oil", "o"], ["storage", "b"], ["geo", "e"], ["biomass", "i"], ["other", "x"]], "masterId": "fuelAllCb", "legendId": "fuelLegend", "itemsId": "fuelLegendItems", "titleKey": "legend.fuel", "title": "Fuel Type", "swatch": "icon"},
  {"key": "sector", "groupCode": "i", "buckets": [["utility", "u"], ["ipp", "i"], ["commercial", "c"], ["industrial", "n"]], "masterId": "sectorAllCb", "legendId": "sectorLegend", "itemsId": "sectorLegendItems", "titleKey": "legend.sector", "title": "EIA Plants — sector", "swatch": "none"},
  {"key": "pipeline", "groupCode": "p", "buckets": [["pig_launcher", "P"], ["compressor", "C"], ["delivery", "D"], ["interconnect", "I"], ["end", "E"], ["other", "O"]], "masterId": "pipelineAllCb", "legendId": "pipelineLegend", "itemsId": "pipelineLegendItems", "titleKey": "legend.pipelinePoints", "title": "Pipeline Points", "swatch": "icon"},
  {"key": "crithab", "groupCode": "h", "buckets": [["endangered", "E"], ["threatened", "T"], ["prop-endangered", "P"], ["prop-threatened", "Q"]], "masterId": "crithabAllCb", "legendId": "crithabLegend", "itemsId": "crithabLegendItems", "titleKey": "legend.crithab", "title": "Critical Habitat — ESA status", "swatch": "color"},
  {"key": "padus", "groupCode": "j", "buckets": [["blm", "B"], ["forest", "F"], ["refuge", "R"], ["park", "P"], ["wild", "W"], ["conserv", "C"], ["state", "S"], ["local", "L"], ["private", "V"], ["military", "M"], ["other", "O"]], "masterId": "padusAllCb", "legendId": "padusLegend", "itemsId": "padusLegendItems", "titleKey": "legend.padus", "title": "PAD-US — land type", "swatch": "color"},
  {"key": "tribal", "groupCode": "t", "buckets": [["reservation", "R"], ["hawaiian", "H"], ["anvsa", "A"], ["otsa", "O"], ["sdtsa", "S"], ["tdsa", "T"], ["statereserv", "J"]], "masterId": "tribalAllCb", "legendId": "tribalLegend", "itemsId": "tribalLegendItems", "titleKey": "layer.tribalCensus", "title": "Tribal (Census)", "swatch": "color"},
  {"key": "natgasLine", "groupCode": "n", "buckets": [["interstate", "I"], ["intrastate", "N"], ["hgl", "H"], ["gathering", "G"]], "masterId": "natgasLineAllCb", "legendId": "natgasLineLegend", "itemsId": "natgasLineLegendItems", "titleKey": "legend.pipelineType", "title": "Pipeline type", "swatch": "color"},
  {"key": "natgasPts", "groupCode": "r", "buckets": [["lng_terminal", "L"], ["underground", "U"], ["spr", "S"], ["trading_hub", "T"], ["processing", "P"], ["border_cross", "B"], ["peak_shaving", "K"], ["lng_storage", "N"], ["pol_terminal", "O"]], "masterId": "natgasPtsAllCb", "legendId": "natgasPtsLegend", "itemsId": "natgasPtsLegendItems", "titleKey": "legend.facilityType", "title": "Facility type", "swatch": "icon"},
  {"key": "substance", "groupCode": "u", "buckets": [["gas", "g"], ["oil", "o"], ["products", "p"], ["hydrogen", "h"], ["coal", "c"], ["other", "u"]], "defaultActive": ["gas", "oil", "products", "hydrogen", "coal"], "masterId": "substanceAllCb", "legendId": "substanceLegend", "itemsId": "substanceLegendItems", "titleKey": "legend.pipelineFuel", "title": "Pipeline fuel", "swatch": "color"},
  {"key": "nerc", "groupCode": "c", "buckets": [["WECC", "W"], ["SERC", "S"], ["RFC", "R"], ["NPCC", "N"], ["MRO", "M"], ["SPP", "P"], ["TRE", "T"], ["FRCC", "F"]], "masterId": "nercAllCb", "legendId": "nercLegend", "itemsId": "nercLegendItems", "titleKey": "popup.nercRegion", "title": "NERC Region", "swatch": "color"},
  {"key": "retail", "groupCode": "e", "buckets": [["iou", "I"], ["coop", "C"], ["muni", "M"], ["public", "P"], ["other", "O"]], "masterId": "retailAllCb", "legendId": "retailLegend", "itemsId": "retailLegendItems", "titleKey": "legend.utilityType", "title": "Utility type", "swatch": "color"},
  {"key": "dcm", "groupCode": "a", "buckets": [["ban", "B"], ["active", "A"], ["pending", "P"], ["ended", "E"]], "masterId": "dcmAllCb", "legendId": "dcMoratoriumLegend", "itemsId": "dcMoratoriumLegendItems", "titleKey": "layer.dcMoratoriums", "title": "Data Center Moratoriums", "swatch": "color"},
  {"key": "ogfRegion", "groupCode": "b", "buckets": [["wecc", "W"], ["ercot", "E"], ["spp", "S"], ["miso", "M"], ["pjm", "P"], ["nyiso", "N"], ["isone", "I"], ["southeast", "U"], ["other", "O"]], "masterId": "ogfRegionAllCb", "legendId": "ogfRegionLegend", "itemsId": "ogfRegionLegendItems", "titleKey": "popup.region", "title": "Region", "swatch": "color"},
  {"key": "ogfStatus", "groupCode": "g", "buckets": [["planning", "L"], ["engineering", "E"], ["permitting", "P"], ["construction", "C"], ["complete", "D"], ["on_hold", "H"], ["terminated", "T"], ["other", "O"]], "masterId": "ogfStatusAllCb", "legendId": "ogfStatusLegend", "itemsId": "ogfStatusLegendItems", "titleKey": "legend.status", "title": "Project status", "swatch": "color"},
  {"key": "ogfWork", "groupCode": "m", "buckets": [["new", "N"], ["existing", "E"]], "masterId": "ogfWorkAllCb", "legendId": "ogfWorkLegend", "itemsId": "ogfWorkLegendItems", "titleKey": "legend.typeOfWork", "title": "Type of work", "swatch": "line"},
  {"key": "mines", "groupCode": "k", "buckets": [["precious", "p"], ["base", "b"], ["ferroalloy", "f"], ["battery", "c"], ["energy", "e"], ["gem", "g"], ["industrial", "i"], ["other", "o"]], "masterId": "minesAllCb", "legendId": "minesLegend", "itemsId": "minesLegendItems", "titleKey": "legend.minesCommodity", "title": "Mines — commodity", "swatch": "icon"},
  {"key": "minesStatus", "groupCode": "d", "buckets": [["active", "1"], ["retired", "2"]], "defaultActive": ["active"], "masterId": "minesStatusAllCb", "legendId": "minesStatusLegend", "itemsId": "minesStatusLegendItems", "titleKey": "legend.minesStatus", "title": "Mines — status", "swatch": "none"},
  {"key": "nwsGroup", "groupCode": "q", "buckets": [["convective", "c"], ["flood", "l"], ["fire", "f"], ["heat", "h"], ["wind", "w"], ["winter", "i"], ["tropical", "t"], ["other", "o"]], "masterId": "nwsGroupAllCb", "legendId": "nwsGroupLegend", "itemsId": "nwsGroupLegendItems", "titleKey": "legend.weatherAlerts", "title": "Weather Alerts", "swatch": "color"},
  {"key": "westtecScenario", "groupCode": "x", "buckets": [["base_case", "B"], ["sra", "R"], ["ida", "D"], ["congestion", "C"]], "masterId": "westtecScenarioAllCb", "legendId": "westtecScenarioLegend", "itemsId": "westtecScenarioLegendItems", "titleKey": "legend.scenario", "title": "Scenario", "swatch": "color"},
  {"key": "westtecDataset", "groupCode": "z", "buckets": [["planned", "P"], ["identified", "I"]], "masterId": "westtecDatasetAllCb", "legendId": "westtecDatasetLegend", "itemsId": "westtecDatasetLegendItems", "titleKey": "legend.projectType", "title": "Project Type", "swatch": "color"},
];

// Entries in declaration order: the order of a map's values feeds the
// `!in allKnown` catch-all of buildValueFilterExpr.
const VALUE_MAPS: Record<string, [string, string[]][]> = {
  OSM_FUEL_MAP: [
    ["wind", ["wind"]],
    ["solar", ["solar"]],
    ["hydro", ["hydro"]],
    ["nuclear", ["nuclear"]],
    ["coal", ["coal"]],
    ["gas", ["gas"]],
    ["oil", ["oil"]],
    ["battery", ["battery"]],
    ["geothermal", ["geothermal"]],
    ["biomass", ["biomass", "biogas", "waste"]],
  ],
  PIPELINE_TYPE_MAP: [
    ["pig_launcher", ["pig_launcher"]],
    ["compressor", ["substation", "pump_station"]],
    ["delivery", ["delivery", "receipt", "reciept", "measurement", "meter"]],
    ["interconnect", ["interconnect"]],
    ["end", ["end"]],
  ],
  NATGAS_PIPE_TYPE_MAP: [
    ["interstate", ["Interstate"]],
    ["intrastate", ["Intrastate"]],
    ["hgl", ["HGL"]],
    ["gathering", ["Gathering"]],
  ],
  NATGAS_FAC_TYPE_MAP: [
    ["lng_terminal", ["lng_terminal"]],
    ["underground", ["underground"]],
    ["spr", ["spr"]],
    ["trading_hub", ["trading_hub"]],
    ["processing", ["processing"]],
    ["border_cross", ["border_cross"]],
    ["peak_shaving", ["peak_shaving"]],
    ["lng_storage", ["lng_storage"]],
    ["pol_terminal", ["pol_terminal"]],
  ],
  CRITHAB_MAP: [
    ["endangered", ["Endangered"]],
    ["threatened", ["Threatened"]],
    ["prop-endangered", ["Proposed Endangered"]],
    ["prop-threatened", ["Proposed Threatened"]],
  ],
  PADUS_CLASS_MAP: [
    ["blm", ["National Public Lands"]],
    ["forest", ["National Forest", "National Grassland"]],
    ["refuge", ["National Wildlife Refuge"]],
    ["park", ["National Park", "National Monument", "National Recreation Area", "National Lakeshore or Seashore", "National Scenic or Historic Trail", "National Scenic, Botanical or Volcanic Area"]],
    ["wild", ["State Wilderness", "Wild and Scenic River"]],
    ["conserv", ["Conservation Area", "Resource Management Area", "Recreation Management Area", "Watershed Protection Area", "Research or Educational Area", "Special Designation Area"]],
    ["state", ["State Resource Management Area", "State Conservation Area", "State Park", "State Recreation Area", "State Other or Unknown", "State Historic or Cultural Area"]],
    ["local", ["Local Conservation Area", "Local Other or Unknown", "Local Resource Management Area", "Local Park", "Local Recreation Area", "Local Historic or Cultural Area"]],
    ["private", ["Private Conservation", "Private Other or Unknown", "Private Recreation or Education", "Private Ranch", "Private Park", "Private Forest Stewardship", "Private Historic or Cultural", "Private Agricultural", "Conservation Easement", "Forest Stewardship Easement", "Mitigation Land or Bank"]],
    ["military", ["Military Land"]],
    ["other", []],
  ],
  TRIBAL_MAP: [
    ["reservation", ["American Indian Reservation", "Off-Reservation Trust Land", "Reservation / Off-Reservation Trust Land"]],
    ["hawaiian", ["Hawaiian Home Land"]],
    ["anvsa", ["Alaska Native Village Statistical Area"]],
    ["otsa", ["Oklahoma Tribal Statistical Area"]],
    ["sdtsa", ["State-Designated Tribal Statistical Area"]],
    ["tdsa", ["Tribal-Designated Statistical Area"]],
    ["statereserv", ["State American Indian Reservation"]],
  ],
  SUBSTANCE_MAP: [
    ["gas", ["gas", "natural_gas", "cng", "methane", "lng", "LNG", "landfill_gas", "coke_gas", "syngas", "fcc_gas"]],
    ["oil", ["oil", "crude_oil", "petroleum", "condensate"]],
    ["products", ["fuel", "ngl", "lpg", "propane", "butane", "isobutane", "n-butane", "liquid_butane", "pentane", "isopentane", "y-grade", "ethane", "naphtha", "gasoline", "diesel", "jet_fuel", "kerosene", "hvl", "natural_gasoline", "gasoil"]],
    ["hydrogen", ["hydrogen", "liquid_hydrogen"]],
    ["coal", ["coal"]],
  ],
  SECTOR_MAP: [
    ["utility", ["Electric Utility"]],
    ["ipp", ["IPP Non-CHP", "IPP CHP"]],
    ["commercial", ["Commercial Non-CHP", "Commercial CHP"]],
    ["industrial", ["Industrial Non-CHP", "Industrial CHP"]],
  ],
  NERC_MAP: [
    ["WECC", ["WECC"]],
    ["SERC", ["SERC"]],
    ["RFC", ["RFC"]],
    ["NPCC", ["NPCC"]],
    ["MRO", ["MRO"]],
    ["SPP", ["SPP"]],
    ["TRE", ["TRE"]],
    ["FRCC", ["FRCC"]],
  ],
  RETAIL_TYPE_MAP: [
    ["iou", ["INVESTOR OWNED"]],
    ["coop", ["COOPERATIVE"]],
    ["muni", ["MUNICIPAL", "MUNICIPAL MKTG AUTHORITY"]],
    ["public", ["STATE", "FEDERAL", "POLITICAL SUBDIVISION"]],
  ],
  OGF_STATUS_MAP: [
    ["construction", ["Construction"]],
    ["permitting", ["Permitting"]],
    ["planning", ["Conceptual / planning", "Planning", "Pre-planning / conceptual"]],
    ["engineering", ["Engineering, design, and routing"]],
    ["on_hold", ["On hold"]],
    ["complete", ["Complete"]],
    ["terminated", ["Terminated"]],
  ],
  OGF_REGION_MAP: [
    ["wecc", ["WECC"]],
    ["ercot", ["ERCOT", "ERCOT, MISO", "ERCOT, SPP", "SPP, ERCOT", "MISO, ERCOT", "MISO, SPP, ERCOT"]],
    ["spp", ["SPP", "MISO, SPP", "SPP, MISO", "ERCOT, SPP", "SPP, ERCOT", "MISO, SPP, ERCOT"]],
    ["miso", ["MISO", "MISO, SPP", "SPP, MISO", "MISO, PJM", "PJM, MISO", "ERCOT, MISO", "MISO, ERCOT", "MISO, SPP, ERCOT"]],
    ["pjm", ["PJM", "MISO, PJM", "PJM, MISO", "NYISO, PJM"]],
    ["nyiso", ["NYISO", "NYISO, PJM"]],
    ["isone", ["ISO-NE"]],
    ["southeast", ["None (Southeast)"]],
  ],
  OGF_WORK_MAP: [
    ["new", ["new"]],
    ["existing", ["existing"]],
  ],
  WESTTEC_SCENARIO_MAP: [
    ["base_case", ["Base Case"]],
    ["sra", ["SRA"]],
    ["ida", ["IDA"]],
    ["congestion", ["Congestion"]],
  ],
  WESTTEC_DATASET_MAP: [
    ["planned", ["planned"]],
    ["identified", ["identified"]],
  ],
  DCM_CLASS_MAP: [
    ["ban", ["ban"]],
    ["active", ["active"]],
    ["pending", ["pending"]],
    ["ended", ["ended"]],
  ],
  MINES_COMMODITY_MAP: [
    ["precious", ["precious"]],
    ["base", ["base"]],
    ["ferroalloy", ["ferroalloy"]],
    ["battery", ["battery"]],
    ["energy", ["energy"]],
    ["gem", ["gem"]],
    ["industrial", ["industrial"]],
    ["other", ["other"]],
  ],
  MINES_STATUS_MAP: [
    ["active", ["active"]],
    ["retired", ["retired"]],
  ],
  EIA_FUEL_MAP: [
    ["wind", ["WND"]],
    ["solar", ["SUN"]],
    ["hydro", ["WAT"]],
    ["nuclear", ["NUC"]],
    ["coal", ["BIT", "SUB", "LIG", "PC"]],
    ["gas", ["NG", "OG"]],
    ["oil", ["DFO", "RFO", "KER"]],
    ["storage", ["MWH", "ES"]],
    ["geo", ["GEO"]],
    ["biomass", ["WDS", "WDL", "MSW", "BLQ"]],
  ],
  NWS_GROUP_MAP: [
    ["convective", ["convective"]],
    ["flood", ["flood"]],
    ["fire", ["fire"]],
    ["heat", ["heat"]],
    ["wind", ["wind"]],
    ["winter", ["winter"]],
    ["tropical", ["tropical"]],
  ],
};

const MAPS: Record<string, Record<string, string[]>> = {
  OSM_FUEL_MAP: F.OSM_FUEL_MAP, EIA_FUEL_MAP: F.EIA_FUEL_MAP, PIPELINE_TYPE_MAP: B.PIPELINE_TYPE_MAP,
  NATGAS_PIPE_TYPE_MAP: B.NATGAS_PIPE_TYPE_MAP, NATGAS_FAC_TYPE_MAP: B.NATGAS_FAC_TYPE_MAP,
  NWS_GROUP_MAP: B.NWS_GROUP_MAP,
  CRITHAB_MAP: B.CRITHAB_MAP, PADUS_CLASS_MAP: B.PADUS_CLASS_MAP, TRIBAL_MAP: B.TRIBAL_MAP,
  SUBSTANCE_MAP: B.SUBSTANCE_MAP, SECTOR_MAP: B.SECTOR_MAP, NERC_MAP: B.NERC_MAP,
  RETAIL_TYPE_MAP: B.RETAIL_TYPE_MAP, OGF_STATUS_MAP: B.OGF_STATUS_MAP, OGF_REGION_MAP: B.OGF_REGION_MAP,
  OGF_WORK_MAP: B.OGF_WORK_MAP, WESTTEC_SCENARIO_MAP: B.WESTTEC_SCENARIO_MAP,
  WESTTEC_DATASET_MAP: B.WESTTEC_DATASET_MAP, DCM_CLASS_MAP: B.DCM_CLASS_MAP,
  MINES_COMMODITY_MAP: M.MINES_COMMODITY_MAP, MINES_STATUS_MAP: M.MINES_STATUS_MAP,
};

describe('legend facets', () => {
  it('every LEGEND_FILTERS row matches the captured snapshot, in order', () => {
    expect(LEGEND_FILTERS.map(c => c.key)).toEqual(LEGEND_ROWS.map(r => r.key));
    LEGEND_FILTERS.forEach((c, i) => {
      const row: Record<string, unknown> = {
        key: c.key, groupCode: c.groupCode,
        buckets: c.buckets.map(b => [b.id, b.urlCode]),
        syncBuckets: c.syncBuckets?.map(b => b.id),
        defaultActive: c.defaultActive,
        masterId: c.masterId, legendId: c.legendId, itemsId: c.itemsId,
        titleKey: c.titleKey, title: c.title, swatch: c.swatch,
      };
      for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
      expect(row, c.key).toEqual(LEGEND_ROWS[i]);
    });
  });

  it('group codes are unique', () => {
    const codes = LEGEND_FILTERS.map(c => c.groupCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('bucket value maps', () => {
  it('every captured map is checked', () => {
    expect(Object.keys(MAPS).sort()).toEqual(Object.keys(VALUE_MAPS).sort());
  });

  it.each(Object.keys(VALUE_MAPS))('%s keeps its exact entries, in order', name => {
    expect(Object.entries(MAPS[name])).toEqual(VALUE_MAPS[name]);
  });
});
