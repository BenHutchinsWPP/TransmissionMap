// ─── Renewable resource raster + geothermal + BOEM offshore-lease layers ─────
// Each plan* returns a LayerPlan (layer-plan.ts); add-all-layers.ts applies it.

import type { LayerSpecification } from "maplibre-gl";
import { planPolygon, planRaster } from './layer-init.js';
import { layerSource } from './layer-source.js';
import type { LayerPlan } from './layer-plan.js';

export const planWindResource = () => planRaster("nlr-wind-100m");
export const planSolarResource = () => planRaster("gsa-solar-pvout");
export const planGeoResource = () => planRaster("ihfc-geo-heatflow");

const GEO_HYDRO_TEMP_COLOR = [
  "step", ["coalesce", ["to-number", ["get", "temp_c"]], 0],
  "#fde68a",
  50, "#f97316",
  90, "#dc2626",
];

const GEO_HYDRO_TEMP_RADIUS = [
  "step", ["coalesce", ["to-number", ["get", "temp_c"]], 0],
  5,
  90, 7,
];

export function planGeoHydroPts(): LayerPlan {
  return [layerSource("nrel-hydrothermal-points"), { layer: {
    id: "nrel-hydrothermal-points",
    type: "circle",
    source: "nrel-hydrothermal-points",
    minzoom: 3,
    paint: {
      "circle-color":        GEO_HYDRO_TEMP_COLOR,
      "circle-radius":       GEO_HYDRO_TEMP_RADIUS,
      "circle-opacity":      0.85,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  } as LayerSpecification }];
}

export function planBoemWindLeases(): LayerPlan {
  return planPolygon({
    sourceId: "boem-wind-leases",
    prefix: "boem-wind-leases",
    color: "#0ea5e9",
    fillMinzoom: 0, fillOpacity: 0.15,
    outlineMinzoom: 0, outlineWidth: 1.5, outlineOpacity: 1,
  });
}
