// Layer registry entries — substations and transmission lines.
import type { LayerDef } from '../types.js';

// OSM transmission ships as six planet-wide archives split by voltage class —
// one world file is past the host's 100 MiB per-file ceiling. This table is the
// single definition of that split: assets/layers/map-layers-osm.ts builds the
// MapLibre sources from it, and OSM_TL_LAYER_IDS below derives the style-layer
// ids, so the two cannot drift. `kv` is the half-open [min, max) class the
// archive holds; `-1` encodes unknown voltage, so it falls into the first band.
// Ascending order is paint order. See docs/hosting-plan.md.
export const OSM_TL_BANDS: { suffix: string; dataKey: string; kv: [number, number] }[] = [
  { suffix: "",       dataKey: "osm_transmission_lines_kv0",   kv: [-Infinity, 50] },
  { suffix: "-kv50",  dataKey: "osm_transmission_lines_kv50",  kv: [50, 100] },
  { suffix: "-kv100", dataKey: "osm_transmission_lines_kv100", kv: [100, 125] },
  { suffix: "-kv125", dataKey: "osm_transmission_lines_kv125", kv: [125, 200] },
  { suffix: "-kv200", dataKey: "osm_transmission_lines_kv200", kv: [200, 300] },
  { suffix: "-kv300", dataKey: "osm_transmission_lines_kv300", kv: [300, Infinity] },
];

// The voltage tiers addTransmissionLines() paints, lowest first, with the
// half-open range each one's filter selects. A tier only gets a style layer on
// an archive whose class it overlaps, so most bands carry a single tier.
export const OSM_TL_TIERS: { id: string; kv: [number, number] }[] = [
  { id: "lv",      kv: [1, 50] },
  { id: "unknown", kv: [-Infinity, 1] },
  { id: "mv",      kv: [50, 100] },
  { id: "hv",      kv: [100, Infinity] },
];

// Overlays that apply to every archive: HVDC runs at every voltage class, and a
// line can carry a name in any of them.
const OSM_TL_OVERLAYS = ["dc", "dc-label", "label"];

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/** Style-layer ids for the named tiers, across every archive that can hold them.
 *
 * Anything that names a transmission style layer must go through this: the layer
 * is spread over six archives, and an id built as `osm-transmission-lines-hv`
 * only ever matches the first one. That is a silent failure — clicks and popups
 * just stop working above 50 kV. Tiers are returned in the order given, which is
 * priority order for `queryRenderedFeatures`.
 */
export const osmTlLayerIds = (...tiers: string[]) =>
  tiers.flatMap(tier => {
    const t = OSM_TL_TIERS.find(x => x.id === tier);
    const bands = t ? OSM_TL_BANDS.filter(b => overlaps(b.kv, t.kv)) : OSM_TL_BANDS;
    return bands.map(b => `osm-transmission-lines${b.suffix}-${tier}`);
  });

// Every style layer addTransmissionLines() builds, in paint order.
const OSM_TL_LAYER_IDS = [
  ...osmTlLayerIds(...OSM_TL_TIERS.map(t => t.id)),
  ...osmTlLayerIds(...OSM_TL_OVERLAYS),
];

export const transmissionLayers: LayerDef[] = [
  // ── Substations ──────────────────────────────────────────────────────────────
  {
    id:            "osm-substations-points",
    urlCode:       "OSP",
    label:         "OSM Substations",
    titleKey:      "layer.osmSubstations",
    group:         "substations",
    sourceId:      "osm",
    swatch:        "#f97316",
    defaultOn:     false,
    voltageLayer:  true,
    mapLayerIds:   ["osm-substations-points-hv", "osm-substations-points-lv", "osm-substations-label"],
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
    swatch:        "#f97316",
    defaultOn:     false,
    voltageLayer:  true,
    hoverField:    "osm_id",
    mapLayerIds:   ["osm-substations-polygons-fill", "osm-substations-polygons-outline"],
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
    swatch:        "#a78bfa",
    defaultOn:     false,
    voltageLayer:  true,
    mapLayerIds:   ["hifld-substations-hv", "hifld-substations-lv", "hifld-substations-label"],
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
    swatch:              "#3b82f6",
    defaultOn:           true,
    voltageLayer:        true,
    lineHighlightKeys:   ["name"],
    mapLayerIds:         OSM_TL_LAYER_IDS,
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
    swatch:              "#ef4444",
    defaultOn:           false,
    voltageLayer:        true,
    lineHighlightKeys:   ["SUB_1", "SUB_2"],
    mapLayerIds:         ["hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown", "hifld-transmission-lines-dc", "hifld-transmission-lines-dc-label"],
    filterType:    "kv",
    filterField:   "VOLTAGE",
    regions:       ["usa"],
    downloads: {
      geojson: "data/releases/hifld-transmission-lines.zip",
      shp: "data/releases/hifld-transmission-lines-shp.zip",
    },
  },
  /* Commenting out layer while OGF statuses are further compared against WestTEC. 
  {
    id:             "ogf-planned-transmission",
    urlCode:        "OGF",
    label:          "OGF Planned Lines",
    group:          "transmission",
    sourceId:       "ogf",
    swatch:         "#06b6d4",
    defaultOn:      false,
    ogfStatusLayer: true,
    mapLayerIds:    ["ogf-planned-lines-casing", "ogf-planned-lines"],
    downloads: {},
  },
  */
  {
    id:                "westtec-10yr",
    urlCode:           "WTC",
    label:             "WestTEC 10 Yr",
    titleKey:          "layer.westtec10yr",
    group:             "transmission",
    sourceId:          "westtec",
    swatch:            "#0891b2",
    defaultOn:         false,
    westtecColorLayer: true,
    mapLayerIds:       ["westtec-lines-casing", "westtec-lines"],
    lineHighlightKeys: ["name"],
    regions:           ["usa"],
    downloads: {},
  },
  {
    id:          "wecc-paths",
    urlCode:     "WPT",
    label:       "WECC Paths",
    titleKey:    "layer.weccPaths",
    group:       "transmission",
    sourceId:    "wecc-paths",
    swatch:      "#eab308",
    defaultOn:   false,
    mapLayerIds: ["wecc-path-corridors", "wecc-path-corridors-outline",
                  "wecc-path-lines-highlight", "wecc-paths-circles", "wecc-paths-label"],
    regions:     ["usa"],
    downloads: {
      geojson: "data/releases/wecc-paths.zip",
    },
  },
];
