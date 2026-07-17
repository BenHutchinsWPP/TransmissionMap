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
    mapLayerIds:   ["osm-dc-circles", "osm-dc-heat", "osm-dc-clusters", "osm-dc-cluster-count", "osm-dc-points", "osm-dc-heat-points"],
    heatLayerId:   "osm-dc-heat",
    genModeCode:   "d",
    defaultMode:   "icons",
    modes: [
      { id: "icons",    label: "Points",   layers: ["osm-dc-points"] },
      { id: "clusters", label: "Clusters", layers: ["osm-dc-clusters", "osm-dc-cluster-count", "osm-dc-circles"] },
      { id: "heat",     label: "Heatmap",  layers: ["osm-dc-heat", "osm-dc-heat-points"] },
    ],
    downloads: {
      csv: "data/releases/osm-datacenters.zip",
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
    mapLayerIds:   ["worldpop-pop-density"],
    downloads: {
      tif: "data/releases/worldpop-pop-density.zip",
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
    hoverField:   "sub_nm",
    mapLayerIds:  ["nerc-fill", "nerc-outline"],
    downloads: {
      geojson: "data/releases/nerc-regions.zip",
      shp: "data/releases/nerc-regions-shp.zip",
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
      geojson: "data/releases/control-areas.zip",
      shp: "data/releases/control-areas-shp.zip",
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
    hoverField:   "name",
    mapLayerIds:  ["retail-fill", "retail-outline"],
    downloads: {
      geojson: "data/releases/retail-territories.zip",
      shp: "data/releases/retail-territories-shp.zip",
    },
  },

];
