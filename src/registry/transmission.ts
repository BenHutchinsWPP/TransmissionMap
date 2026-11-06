// Layer registry entries — substations and transmission lines.
import type { LayerDef } from '../types.js';
import { OSM_CREDIT, HIFLD_CREDIT } from './sources.js';
import { OSM_NATIVE_FID } from './osm-fid.js';

// The voltage tiers planTransmissionLines() paints, lowest first, with the
// half-open kV range each one's filter selects (`-1` encodes unknown voltage).
export const OSM_TL_TIERS: { id: string; kv: [number, number] }[] = [
  { id: "lv",      kv: [1, 50] },
  { id: "unknown", kv: [-Infinity, 1] },
  { id: "mv",      kv: [50, 100] },
  { id: "hv",      kv: [100, Infinity] },
];

// Overlays drawn over every tier: HVDC stripes and "DC" labels, and the name label.
const OSM_TL_OVERLAYS = ["dc", "dc-label", "label"];

const tlId = (part: string) => `osm-transmission-lines-${part}`;

// Every style layer planTransmissionLines() builds on the one source, in paint order.
const OSM_TL_LAYER_IDS = [...OSM_TL_TIERS.map(t => t.id), ...OSM_TL_OVERLAYS].map(tlId);

/** Style-layer ids of the line tiers a click can hit (and the popup renders for),
 *  highest voltage first, then the DC stripe. Priority order for queryRenderedFeatures. */
export const OSM_TL_POPUP_IDS = ["hv", "mv", "lv", "unknown", "dc"].map(tlId);

// Click hit-test priority for the tiered (non-overlay) style layers, highest
// voltage tier tested first — matches OSM_TL_TIERS order (hv, mv, lv, unknown
// is the priority order used by the popup's queryRenderedFeatures list, so the
// tiers are named explicitly rather than via OSM_TL_TIERS' own order).
const OSM_TL_CLICK_IDS = OSM_TL_POPUP_IDS.slice(0, 4);
const OSM_TL_CLICK_PRIORITY: Record<string, number> = Object.fromEntries(
  OSM_TL_CLICK_IDS.map((id, i) => [id, 800 - i * 10])
);

export const transmissionLayers: LayerDef[] = [
  // ── Substations ──────────────────────────────────────────────────────────────
  {
    id:            "osm-substations-points",
    urlCode:       "OSP",
    label:         "OSM Substations",
    titleKey:      "layer.osmSubstations",
    group:         "substations",
    sourceId:      "osm",
    data:          { kind: "pmtiles", key: "osm_substations_points", credit: OSM_CREDIT, id: OSM_NATIVE_FID },
    dataset:       "osm_substations_points",
    swatch:        "#f97316",
    defaultOn:     false,
    voltageLayer:  true,
    mapLayerIds:   ["osm-substations-points-hv", "osm-substations-points-lv", "osm-substations-label"],
    clickPriority: { "osm-substations-points-hv": 980, "osm-substations-points-lv": 970 },
    filterType:    "kv",
    filterField:   "nominal_kv",
    regions:       ["global"],
    downloads: {
      csv: "data/releases/osm-substations-points.zip",
    },
  },
  {
    id:            "osm-substations-polygons",
    urlCode:       "OSR",
    label:         "OSM Sub Polygons",
    titleKey:      "layer.osmSubPolygons",
    group:         "substations",
    sourceId:      "osm",
    data:          { kind: "pmtiles", key: "osm_substations_polygons", credit: OSM_CREDIT, id: OSM_NATIVE_FID,
                     analysis: "osm_substations_polygons" },
    dataset:       "osm_substations_polygons",
    swatch:        "#f97316",
    defaultOn:     false,
    voltageLayer:  true,
    hoverField:    "osm_id",
    mapLayerIds:   ["osm-substations-polygons-fill", "osm-substations-polygons-outline"],
    clickPriority: { "osm-substations-polygons-fill": 940 },
    filterType:    "kv",
    filterField:   "nominal_kv",
    regions:       ["global"],
    downloads: {
      geojson: "data/releases/osm-substations-polygons.zip",
      shp: "data/releases/osm-substations-polygons-shp.zip",
    },
  },
  {
    id:            "hifld-substations",
    urlCode:       "HSP",
    label:         "HIFLD Substations",
    titleKey:      "layer.hifldSubstations",
    group:         "substations",
    sourceId:      "hifld-substations",
    data:          { kind: "geojson", key: "hifld_substations", credit: HIFLD_CREDIT, id: { field: "hifld_id" } },
    dataset:       "hifld_substations",
    swatch:        "#a78bfa",
    defaultOn:     false,
    voltageLayer:  true,
    mapLayerIds:   ["hifld-substations-hv", "hifld-substations-lv", "hifld-substations-label"],
    clickPriority: { "hifld-substations-hv": 960, "hifld-substations-lv": 950 },
    filterType:    "kv",
    filterField:   "max_kv",
    regions:       ["usa"],
    downloads: {
      csv: "data/releases/hifld-substations.zip",
    },
  },

  // ── Transmission lines ───────────────────────────────────────────────────────
  {
    id:                  "osm-transmission-lines",
    urlCode:             "OTL",
    label:               "OSM Lines",
    titleKey:            "layer.osmLines",
    group:               "transmission",
    sourceId:            "osm",
    data:                { kind: "pmtiles", key: "osm_transmission_lines", credit: OSM_CREDIT, id: OSM_NATIVE_FID,
                           analysis: "osm_transmission_lines" },
    dataset:             "osm_transmission_lines",
    swatch:              "#3b82f6",
    defaultOn:           true,
    voltageLayer:        true,
    lineHighlightKeys:   ["name"],
    mapLayerIds:         OSM_TL_LAYER_IDS,
    clickPriority:       OSM_TL_CLICK_PRIORITY,
    filterType:    "kv",
    filterField:   "nominal_kv",
    regions:       ["global"],
    downloads: {
      geojson: "data/releases/osm-transmission-lines.zip",
      shp: "data/releases/osm-transmission-lines-shp.zip",
    },
  },
  {
    id:                  "hifld-transmission-lines",
    urlCode:             "HTL",
    label:               "HIFLD Lines",
    titleKey:            "layer.hifldLines",
    group:               "transmission",
    sourceId:            "hifld-power",
    data:                { kind: "pmtiles", key: "hifld_transmission_lines", credit: HIFLD_CREDIT, id: { field: "ID" },
                           analysis: "hifld_transmission_lines" },
    dataset:             "hifld_transmission_lines",
    swatch:              "#ef4444",
    defaultOn:           false,
    voltageLayer:        true,
    lineHighlightKeys:   ["SUB_1", "SUB_2"],
    mapLayerIds:         ["hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown", "hifld-transmission-lines-dc", "hifld-transmission-lines-dc-label"],
    clickPriority:       {
      "hifld-transmission-lines-hv": 730, "hifld-transmission-lines-mv": 720,
      "hifld-transmission-lines-lv": 710, "hifld-transmission-lines-unknown": 700,
    },
    filterType:    "kv",
    filterField:   "VOLTAGE",
    regions:       ["usa"],
    downloads: {
      geojson: "data/releases/hifld-transmission-lines.zip",
      shp: "data/releases/hifld-transmission-lines-shp.zip",
    },
  },
  {
    id:                "westtec-10yr",
    urlCode:           "WTC",
    label:             "WestTEC 10 Yr",
    titleKey:          "layer.westtec10yr",
    group:             "transmission",
    sourceId:          "westtec",
    dataset:           "westtec_10yr",
    data:              { kind: "geojson", key: "westtec_10yr", credit: '<a href="https://www.westernpowerpool.org/">WestTEC (Western Power Pool)</a>', id: { field: "fid" } },
    swatch:            "#0891b2",
    defaultOn:         false,
    westtecColorLayer: true,
    mapLayerIds:       ["westtec-lines-casing", "westtec-lines"],
    clickPriority:     { "westtec-lines": 990 },
    lineHighlightKeys: ["name"],
    regions:           ["usa"],
    downloads: {},
  },
  {
    id:             "ogf-planned-transmission",
    urlCode:        "OGF",
    label:          "Our Grid Future",
    titleKey:       "layer.ogfPlanned",
    group:          "transmission",
    sourceId:       "ogf",
    dataset:        "ogf_planned_transmission",
    data:           { kind: "geojson", key: "ogf_planned_transmission", credit: '<a href="https://ourgridfuture.org">Our Grid Future</a>', id: { field: "RecordID" } },
    swatch:         "#06b6d4",
    defaultOn:      false,
    ogfStatusLayer: true,
    mapLayerIds:    ["ogf-planned-lines-casing", "ogf-planned-lines"],
    clickPriority:  { "ogf-planned-lines": 1000 },
    regions:        ["usa"],
    downloads: {},
  },
  {
    id:          "wecc-paths",
    urlCode:     "WPT",
    label:       "WECC Paths",
    titleKey:    "layer.weccPaths",
    group:       "transmission",
    sourceId:    "wecc-paths",
    data:        { kind: "geojson", key: "wecc_paths", credit: '<a href="https://www.wecc.org/">WECC</a>', id: { field: "id" } },
    dataset:     "wecc_paths",
    swatch:      "#eab308",
    defaultOn:   false,
    mapLayerIds: ["wecc-path-corridors", "wecc-path-corridors-outline",
                  "wecc-path-lines-highlight", "wecc-paths-circles", "wecc-paths-label"],
    clickPriority: { "wecc-paths-circles": 910 },
    drawnOnly:   ["wecc-path-corridors", "wecc-path-corridors-outline"],
    regions:     ["usa"],
    downloads: {
      geojson: "data/releases/wecc-paths.zip",
    },
  },
];
