// Layer registry entries — protected lands, tribal lands, critical habitat.
import type { LayerDef } from '../types.js';

export const landLayers: LayerDef[] = [
  {
    id:            "padus",
    urlCode:       "PAD",
    label:         "✂️ PAD-US Protected Lands (Filtered)",
    group:         "land",
    sourceId:      "usgs-padus",
    swatch:        "#15803d",
    defaultOn:     false,
    hoverField:    "name",
    mapLayerIds:   ["padus-fill", "padus-outline"],
    downloads:     {},   // no download offered — map layer is a filtered summary subset, not the full dataset
  },
  {
    id:            "tribal-lands",
    urlCode:       "TRB",
    label:         "Tribal (Census)",
    group:         "land",
    sourceId:      "hifld-tribal",
    swatch:        "#7c3aed",
    defaultOn:     false,
    hoverField:    "name",
    mapLayerIds:   ["tribal-fill", "tribal-outline"],
    downloads: {
      url: "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html",
    },
  },
  {
    id:            "bia-tribal-lands",
    urlCode:       "BIA",
    label:         "Tribal (BIA AIAN-LAR)",
    group:         "land",
    sourceId:      "bia-bogs",
    swatch:        "#8b5cf6",
    defaultOn:     false,
    hoverField:    "LARNAME",
    mapLayerIds:   ["bia-tribal-fill", "bia-tribal-outline"],
    downloads: {
      geojson: "data/releases/bia-tribal-lands.zip",
      shp: "data/releases/bia-tribal-lands-shp.zip",
    },
  },
  {
    id:            "mines",
    urlCode:       "MNE",
    label:         "✂️ Large Mines (MSHA, Filtered)",
    group:         "load",
    sourceId:      "msha-mines",
    swatch:        "#b45309",
    defaultOn:     false,
    mapLayerIds:   ["mines-icons"],
    downloads:     {},   // filtered subset (peak employment ≥ 50), not the full MSHA dataset
  },
  {
    id:          "crithab",
    urlCode:     "CHB",
    label:       "Critical Habitat (ESA)",
    group:       "land",
    sourceId:    "fws-crithab",
    swatch:      "#f59e0b",
    defaultOn:   false,
    mapLayerIds: ["crithab-fill", "crithab-outline"],
    downloads:   { url: "https://ecos.fws.gov/ecp/report/table/critical-habitat.html" },
  },
];
