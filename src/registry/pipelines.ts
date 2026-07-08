// Layer registry entries — natural gas and OSM pipeline layers.
import type { LayerDef } from '../types.js';

export const pipelineLayers: LayerDef[] = [
  {
    id:                  "hifld-natgas-lines",
    urlCode:             "HNL",
    label:               "Gas Pipelines",
    group:               "pipelines",
    sourceId:            "hifld-natgas",
    swatch:              "#f97316",
    defaultOn:           false,
    natgasLineLayer:     true,
    lineHighlightKeys:   ["name"],
    mapLayerIds:         ["hifld-natgas-interstate", "hifld-natgas-intrastate",
                          "hifld-natgas-hgl", "hifld-natgas-gathering"],
    downloads: {
      geojson: "data/releases/hifld-natgas-lines.zip",
      shp: "data/releases/hifld-natgas-lines-shp.zip",
    },
  },
  {
    id:             "hifld-natgas-points",
    urlCode:        "HNP",
    label:          "Gas Facilities",
    group:          "pipelines",
    sourceId:       "hifld-natgas",
    swatch:         "#06b6d4",
    defaultOn:      false,
    natgasPtsLayer: true,
    mapLayerIds:    ["hifld-natgas-points"],
    downloads: {
      csv: "data/releases/hifld-natgas-points.zip",
    },
  },
  // Hidden 2026-07: crude/refined-oil delivery has no grid-planning value
  // (oil peakers are truck-fed; crude feeds refineries, not generators).
  // Map builders still add these layers (hidden); uncomment to restore.
  /*
  {
    // Petroleum facilities (POL terminals + SPR) — shares the HIFLD points source,
    // base-filtered to the petroleum fac_types (the gas layer excludes them).
    id:             "hifld-petroleum-facilities",
    urlCode:        "PTF",
    label:          "Oil Terminals & SPR",
    group:          "pipelines",
    sourceId:       "hifld-natgas",
    swatch:         "#94a3b8",
    defaultOn:      false,
    natgasPtsLayer: true,
    mapLayerIds:    ["hifld-petroleum-facilities"],
    downloads:      {},   // no pack; wire a csv/geojson pack if restored
  },
  {
    id:                "eia-crude-pipelines",
    urlCode:           "COP",
    label:             "Crude Pipelines",
    group:             "pipelines",
    sourceId:          "eia-atlas",
    swatch:            "#7c2d12",
    defaultOn:         false,
    lineHighlightKeys: ["name", "operator"],
    mapLayerIds:       ["eia-crude-pipelines"],
    downloads: {
      url: "https://www.eia.gov/maps/map_data/CrudeOil_Pipelines_US_EIA.zip",
    },
  },
  {
    id:                "eia-product-pipelines",
    urlCode:           "PPP",
    label:             "Refined Oil Pipelines",
    group:             "pipelines",
    sourceId:          "eia-atlas",
    swatch:            "#ca8a04",
    defaultOn:         false,
    lineHighlightKeys: ["name", "operator"],
    mapLayerIds:       ["eia-product-pipelines"],
    downloads: {
      url: "https://www.eia.gov/maps/map_data/PetroleumProduct_Pipelines_US_EIA.zip",
    },
  },
  */
  {
    id:                "osm-pipelines-lines",
    urlCode:           "PLL",
    label:             "OSM Pipelines",
    group:             "pipelines",
    sourceId:          "osm",
    swatch:            "#0d9488",
    defaultOn:         false,
    lineHighlightKeys: ["name"],
    mapLayerIds:       ["osm-pipelines-lines"],
    downloads: {
      geojson: "data/releases/osm-pipelines-lines.zip",
      shp: "data/releases/osm-pipelines-lines-shp.zip",
    },
  },
  // Restored 2026-07: complements HIFLD Gas Facilities (inline equipment —
  // valves, pig launchers, pressure stations — absent from HIFLD taxonomy).
  {
    id:            "osm-pipelines-points",
    urlCode:       "PLP",
    label:         "Pipeline Equipment",
    group:         "pipelines",
    sourceId:      "osm",
    swatch:        "#64748b",
    defaultOn:     false,
    pipelineLayer: true,
    mapLayerIds:   ["osm-pipelines-points"],
    downloads: {
      csv: "data/releases/osm-pipelines-points.zip",
    },
  },
];
