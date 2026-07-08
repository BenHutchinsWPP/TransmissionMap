// Layer registry entries — renewable resource rasters and hydrothermal points.
import {
  WIND_RAMP_STOPS, WIND_RAMP_MAX,
  SOLAR_RAMP_STOPS, SOLAR_RAMP_MAX,
  GEO_RAMP_STOPS, GEO_RAMP_MAX,
} from '../colors/ramps.js';
import type { LayerDef } from '../types.js';

export const renewableLayers: LayerDef[] = [
  {
    id:            "nlr-wind-100m",
    urlCode:       "WND",
    label:         "Wind Resource (100 m)",
    group:         "renewable",
    sourceId:      "nlr-wind",
    swatch:        `rgb(${WIND_RAMP_STOPS[2][1]})`,
    ramp:          { stops: WIND_RAMP_STOPS, max: WIND_RAMP_MAX, unit: "m/s" },
    defaultOn:     false,
    rasterLayer:   true,
    mapLayerIds:   ["nlr-wind-100m"],
    downloads: {
      tif: "data/releases/nlr-wind-100m.zip",
    },
  },
  {
    id:            "gsa-solar-pvout",
    urlCode:       "SOL",
    label:         "Solar Resource (PVOUT)",
    group:         "renewable",
    sourceId:      "global-solar-atlas",
    swatch:        `rgb(${SOLAR_RAMP_STOPS[2][1]})`,
    ramp:          { stops: SOLAR_RAMP_STOPS, max: SOLAR_RAMP_MAX, unit: "kWh/kWp" },
    defaultOn:     false,
    rasterLayer:   true,
    mapLayerIds:   ["gsa-solar-pvout"],
    downloads: {
      url: "https://energydata.info/dataset/world-photovoltaic-power-potential-pvout-gis-data-global-solar-atlas",
    },
  },
  {
    id:            "ihfc-geo-heatflow",
    urlCode:       "GEO",
    label:         "Geothermal Heat Flow",
    group:         "renewable",
    sourceId:      "ihfc-gfz",
    swatch:        `rgb(${GEO_RAMP_STOPS[2][1]})`,
    ramp:          { stops: GEO_RAMP_STOPS, max: GEO_RAMP_MAX, unit: "mW/m²" },
    defaultOn:     false,
    rasterLayer:   true,
    mapLayerIds:   ["ihfc-geo-heatflow"],
    downloads: {
      tif: "data/releases/ihfc-geo-heatflow.zip",
    },
  },
  {
    id:          "nrel-hydrothermal-points",
    urlCode:     "GHP",
    label:       "Hydrothermal Systems",
    group:       "renewable",
    sourceId:    "nrel-doe-hydrothermal",
    swatch:      "#f97316",
    defaultOn:   false,
    mapLayerIds: ["nrel-hydrothermal-points"],
    downloads: {
      csv: "data/releases/nrel-hydrothermal-points.zip",
    },
  },
];
