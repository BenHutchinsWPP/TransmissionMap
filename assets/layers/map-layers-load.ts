// ─── Load context layers ──────────────────────────────────────────────────────

import type { LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { pmtilesUrl, initialVisibility, registerBaseFilter } from './layer-init.js';

export function addPopDensity() {
  if (!state.map || state.map.getSource("worldpop-pop-density")) return;
  state.map.addSource("worldpop-pop-density", {
    type: "raster",
    url: pmtilesUrl(DATA.worldpop_pop_density),
    tileSize: 256,
    attribution: '<a href="https://www.worldpop.org/">WorldPop</a>',
  });
  state.map.addLayer({
    id: "worldpop-pop-density",
    type: "raster",
    source: "worldpop-pop-density",
    layout: { visibility: initialVisibility("worldpop-pop-density") },
    paint: { "raster-opacity": 0.75, "raster-resampling": "linear" },
  } as LayerSpecification);
}

export function addOsmDataCenters() {
  if (!state.map || state.map.getSource("osm-datacenters")) return;
  state.map.addSource("osm-datacenters", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["osm-datacenters"] });
  state.map.addLayer({
    id: "osm-dc-circles",
    type: "circle",
    source: "osm-datacenters",
    minzoom: 0,
    layout: { visibility: initialVisibility("osm-datacenters") },
    paint: {
      "circle-color": "#6366f1",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 4, 5, 8, 7, 12, 10],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-opacity": 0.85,
    },
  } as LayerSpecification);
  registerBaseFilter("osm-dc-circles", null);
}
