// ─── Renewable resource raster + geothermal layers ───────────────────────────

import type { LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { pmtilesUrl, initialVisibility, registerBaseFilter, addPolygonLayer } from './layer-init.js';

export function addWindResource() {
  if (!state.map || state.map.getSource("nlr-wind-100m")) return;
  state.map.addSource("nlr-wind-100m", {
    type: "raster",
    url: pmtilesUrl(DATA.nlr_wind_100m),
    tileSize: 256,
    attribution: '<a href="https://www.nrel.gov/">NREL WIND Toolkit</a>',
  });
  state.map.addLayer({
    id: "nlr-wind-100m",
    type: "raster",
    source: "nlr-wind-100m",
    layout: { visibility: initialVisibility("nlr-wind-100m") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
  } as LayerSpecification);
}

export function addSolarResource() {
  if (!state.map || state.map.getSource("gsa-solar-pvout")) return;
  state.map.addSource("gsa-solar-pvout", {
    type: "raster",
    url: pmtilesUrl(DATA.gsa_solar_pvout),
    tileSize: 256,
    attribution: '© <a href="https://globalsolaratlas.info">Global Solar Atlas</a> / Solargis',
  });
  state.map.addLayer({
    id: "gsa-solar-pvout",
    type: "raster",
    source: "gsa-solar-pvout",
    layout: { visibility: initialVisibility("gsa-solar-pvout") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
  } as LayerSpecification);
}

export function addGeoResource() {
  if (!state.map || state.map.getSource("ihfc-geo-heatflow")) return;
  state.map.addSource("ihfc-geo-heatflow", {
    type: "raster",
    url: pmtilesUrl(DATA.ihfc_geo_heatflow),
    tileSize: 256,
    attribution: '© <a href="https://ihfc-iugg.org">IHFC</a> / GFZ',
  });
  state.map.addLayer({
    id: "ihfc-geo-heatflow",
    type: "raster",
    source: "ihfc-geo-heatflow",
    layout: { visibility: initialVisibility("ihfc-geo-heatflow") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
  } as LayerSpecification);
}

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
