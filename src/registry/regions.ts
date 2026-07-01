// Layer registry entries — regions, load context, and test layers.
import { POP_RAMP_STOPS, POP_LOG_MAX } from '../colors/ramps.js';
import type { LayerDef } from '../types.js';

export const regionLayers: LayerDef[] = [
  // ── Load context ─────────────────────────────────────────────────────────────
  {
    id:            "osm-datacenters",
    urlCode:       "DCT",
    label:         "OSM Data Centers",
    group:         "load",
    sourceId:      "osm",
    swatch:        "#6366f1",
    defaultOn:     false,
    mapLayerIds:   ["osm-dc-circles"],
    downloads: {
      zip: "data/releases/osm-datacenters.zip",
    },
  },
  {
    id:            "worldpop-pop-density",
    urlCode:       "POP",
    label:         "Population Density",
    group:         "load",
    sourceId:      "worldpop",
    swatch:        `rgb(${POP_RAMP_STOPS[2][1]})`,
    ramp:          { stops: POP_RAMP_STOPS, max: POP_LOG_MAX, unit: "",
                     minLabel: "0", maxLabel: "10k+ ppl/km²" },
    defaultOn:     false,
    rasterLayer:   true,
    mapLayerIds:   ["worldpop-pop-density"],
    downloads: {
      zip: "data/releases/worldpop-pop-density.zip",
    },
  },

  // ── Regions ──────────────────────────────────────────────────────────────────
  {
    id:           "nerc-regions",
    urlCode:      "NRC",
    label:        "HIFLD NERC Regions",
    group:        "regions",
    sourceId:     "hifld-nerc",
    swatch:       "#3b82f6",
    defaultOn:    false,
    nercLayer:    true,
    hoverField:   "sub_nm",
    mapLayerIds:  ["nerc-fill", "nerc-outline"],
    downloads: {
      zip: "data/releases/hifld-regions.zip",
    },
  },
  {
    id:           "control-areas",
    urlCode:      "CTA",
    label:        "HIFLD Balancing Authorities",
    group:        "regions",
    sourceId:     "hifld-ba",
    swatch:       "#64748b",
    defaultOn:    false,
    hoverField:   "name",
    mapLayerIds:  ["ba-fill", "ba-outline", "ba-label"],
    downloads: {
      zip: "data/releases/hifld-regions.zip",
    },
  },
  {
    id:           "retail-territories",
    urlCode:      "RTL",
    label:        "HIFLD Retail Territories",
    group:        "regions",
    sourceId:     "hifld-retail",
    swatch:       "#f97316",
    defaultOn:    false,
    retailLayer:  true,
    hoverField:   "name",
    mapLayerIds:  ["retail-fill", "retail-outline"],
    downloads: {
      zip: "data/releases/hifld-regions.zip",
    },
  },

];
