// ─── Renewable resource raster + geothermal + BOEM offshore-lease layers ─────

import type { LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { pmtilesUrl, initialVisibility, registerBaseFilter, addPolygonLayer, addRasterLayer } from './layer-init.js';

export const addWindResource = () => addRasterLayer("nlr-wind-100m", DATA.nlr_wind_100m,
  '<a href="https://www.nrel.gov/">NREL WIND Toolkit</a>');

export const addSolarResource = () => addRasterLayer("gsa-solar-pvout", DATA.gsa_solar_pvout,
  '© <a href="https://globalsolaratlas.info">Global Solar Atlas</a> / Solargis');

export const addGeoResource = () => addRasterLayer("ihfc-geo-heatflow", DATA.ihfc_geo_heatflow,
  '© <a href="https://ihfc-iugg.org">IHFC</a> / GFZ');

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

export function addGeoHydroPts() {
  if (!state.map || state.map.getSource("nrel-hydrothermal-points")) return;
  state.map.addSource("nrel-hydrothermal-points", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["nrel-hydrothermal-points"] });
  const vis = initialVisibility("nrel-hydrothermal-points");
  state.map.addLayer({
    id: "nrel-hydrothermal-points",
    type: "circle",
    source: "nrel-hydrothermal-points",
    minzoom: 3,
    layout: { visibility: vis },
    paint: {
      "circle-color":        GEO_HYDRO_TEMP_COLOR,
      "circle-radius":       GEO_HYDRO_TEMP_RADIUS,
      "circle-opacity":      0.85,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  } as LayerSpecification);
  registerBaseFilter("nrel-hydrothermal-points", null);
}

export function addBoemWindLeases() {
  addPolygonLayer({
    sourceId: "boem-wind-leases",
    source: { type: "geojson", data: EMPTY_FC },
    prefix: "boem-wind-leases",
    color: "#0ea5e9",
    fillMinzoom: 0, fillOpacity: 0.15,
    outlineMinzoom: 0, outlineWidth: 1.5, outlineOpacity: 1,
  });
}
