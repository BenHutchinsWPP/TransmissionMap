// Layer registry entries — renewable resource rasters and hydrothermal points.
import {
  WIND_RAMP_STOPS, WIND_RAMP_MAX,
  SOLAR_RAMP_STOPS, SOLAR_RAMP_MAX,
  GEO_RAMP_STOPS, GEO_RAMP_MAX,
} from '../colors/ramps.js';
import type { LayerDef } from '../types.js';
import { fmtSpeed } from '../units.js';

export const renewableLayers: LayerDef[] = [
  {
    id:            "nlr-wind-100m",
    urlCode:       "WND",
    label:         "Wind Resource (100 m)",
    titleKey:      "layer.wind100m",
    group:         "renewable",
    sourceId:      "nlr-wind",
    swatch:        `rgb(${WIND_RAMP_STOPS[2][1]})`,
    ramp:          { stops: WIND_RAMP_STOPS, max: WIND_RAMP_MAX, minLabel: "0.0", fmt: fmtSpeed },
    defaultOn:     false,
    mapLayerIds:   ["nlr-wind-100m"],
    regions:       ["usa"],
    downloads: {
      tif: "data/releases/nlr-wind-100m.zip",
    },
  },
  {
    id:            "gsa-solar-pvout",
    urlCode:       "SOL",
    label:         "Solar Resource (PVOUT)",
    titleKey:      "layer.solarPvout",
    group:         "renewable",
    sourceId:      "global-solar-atlas",
    swatch:        `rgb(${SOLAR_RAMP_STOPS[2][1]})`,
    ramp:          { stops: SOLAR_RAMP_STOPS, max: SOLAR_RAMP_MAX, unit: "kWh/kWp" },
    defaultOn:     false,
    mapLayerIds:   ["gsa-solar-pvout"],
    regions:       ["global"],
    downloads: {},
  },
  {
    id:            "ihfc-geo-heatflow",
    urlCode:       "GEO",
    label:         "Geothermal Heat Flow",
    titleKey:      "layer.geoHeatflow",
    group:         "renewable",
    sourceId:      "ihfc-gfz",
    swatch:        `rgb(${GEO_RAMP_STOPS[2][1]})`,
    ramp:          { stops: GEO_RAMP_STOPS, max: GEO_RAMP_MAX, unit: "mW/m²" },
    defaultOn:     false,
    mapLayerIds:   ["ihfc-geo-heatflow"],
    regions:       ["global"],
    downloads: {
      tif: "data/releases/ihfc-geo-heatflow.zip",
    },
  },
  {
    id:          "nrel-hydrothermal-points",
    urlCode:     "GHP",
    label:       "Hydrothermal Systems",
    titleKey:    "layer.hydrothermal",
    group:       "renewable",
    sourceId:    "nrel-doe-hydrothermal",
    swatch:      "#f97316",
    defaultOn:   false,
    mapLayerIds: ["nrel-hydrothermal-points"],
    regions:     ["usa"],
    downloads: {
      csv: "data/releases/nrel-hydrothermal-points.zip",
    },
  },
  {
    id:          "boem-wind-leases",
    urlCode:     "BWL",
    label:       "Offshore Wind Leases (BOEM)",
    titleKey:    "layer.boemWindLeases",
    group:       "renewable",
    sourceId:    "boem",
    swatch:      "#0ea5e9",
    defaultOn:   false,
    hoverField:  "lease",
    mapLayerIds: ["boem-wind-leases-fill", "boem-wind-leases-outline"],
    regions:     ["usa"],
    downloads: {
      geojson: "data/releases/boem-wind-leases.zip",
      shp: "data/releases/boem-wind-leases-shp.zip",
    },
  },
];
