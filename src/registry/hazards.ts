// Layer registry entries — natural hazards.
// Role: pure-data LayerDef for the hazards group; consumed by src/registry/index.ts.
// Deps: ../types (LayerDef). No side effects.
import type { LayerDef } from '../types.js';
import { SEIS_RAMP_STOPS, SEIS_RAMP_MAX } from '../colors/ramps.js';

export const hazardLayers: LayerDef[] = [
  {
    id:          "wildfire-live",
    urlCode:     "WFL",
    label:       "Active Wildfire (~24h)",
    group:       "hazards",
    sourceId:    "nasa-firms-nifc",
    swatch:      "#ff4400",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-perimeters-fill", "wildfire-perimeters-line", "wildfire-hotspots-heat", "wildfire-hotspots-circle"],
    downloads: { url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/" },
  },
  {
    id:          "wildfire-smoke",
    urlCode:     "SMK",
    label:       "Smoke Detection (~24h)",
    group:       "hazards",
    sourceId:    "noaa-hms",
    swatch:      "#ff8c00",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-smoke-fill", "wildfire-smoke-line"],
    downloads: { url: "https://www.ospo.noaa.gov/Products/land/hms.html" },
  },
  {
    id:          "wildfire-incidents",
    urlCode:     "WFI",
    label:       "Named Incidents (~24h)",
    group:       "hazards",
    sourceId:    "nasa-firms-nifc",
    swatch:      "#cc0000",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-incidents-circle"],
    downloads: { url: "https://data-nifc.opendata.arcgis.com/" },
  },
  {
    id:           "usfs-wildfire-potential",
    urlCode:      "WHP",
    label:        "Wildfire Hazard Potential",
    group:        "hazards",
    sourceId:     "usfs-firelab",
    swatch:       "#FF0000",
    defaultOn:    false,
    rasterLayer:  true,
    mapLayerIds:  ["usfs-wildfire-potential"],
    downloads: {
      url: "https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-hazard-potential",
    },
  },
  /* DISABLED until the ODIN data feed is live — everything gates on this entry; delete this line and the closing one to ship. urlCode "OUT" stays reserved.
  {
    id:          "odin-outages",
    urlCode:     "OUT",
    label:       "Power Outages (live)",
    group:       "hazards",
    sourceId:    "ornl-odin",
    swatch:      "#fd8d3c",   // mid-bucket (100–1k) of the YlOrRd outage ramp
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["odin-outages-fill", "odin-outages-line"],
    downloads: { url: "https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/" },
  },
  */
  {
    id:           "usgs-seismic-pga",
    urlCode:      "PGA",
    label:        "Seismic Hazard (PGA, 2% in 50yr)",
    group:        "hazards",
    sourceId:     "usgs-nshm",
    swatch:       `rgb(${SEIS_RAMP_STOPS[3][1]})`,
    ramp:         { stops: SEIS_RAMP_STOPS, max: SEIS_RAMP_MAX, unit: "g" },
    defaultOn:    false,
    rasterLayer:  true,
    mapLayerIds:  ["usgs-seismic-pga"],
    downloads: {
      url: "https://www.sciencebase.gov/catalog/item/5d5597d0e4b01d82ce8e3ff1",
    },
  },
];
