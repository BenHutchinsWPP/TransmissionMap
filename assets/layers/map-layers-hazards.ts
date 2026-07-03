// ─── Hazard layers ────────────────────────────────────────────────────────────
// Role: MapLibre builders for the hazards group — baked-color raster PMTiles
//       (wildfire hazard potential, seismic PGA) and live GeoJSON (smoke, wildfire, incidents).
// Deps: layer-init.ts (pmtilesUrl, initialVisibility), state (DATA).
//
// All live data shares one source ("wildfire-live") and one GeoJSON file.
// _type field distinguishes: "smoke" | "perimeter" | "hotspot" | "incident"
// Three registry entries control separate layer groups via mapLayerIds:
//   wildfire-smoke     → wildfire-smoke-fill, wildfire-smoke-line
//   wildfire-live      → wildfire-perimeters-fill/line, wildfire-hotspots-heat/circle
//   wildfire-incidents → wildfire-incidents-circle

import type { LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC } from '../state.js';
import { pmtilesUrl, initialVisibility } from './layer-init.js';

export function addWildfireLive() {
  if (!state.map || state.map.getSource("wildfire-live")) return;

  state.map.addSource("wildfire-live", {
    type: "geojson",
    data: EMPTY_FC,
  });

  const smokeVis     = initialVisibility("wildfire-smoke");
  const wildfireVis  = initialVisibility("wildfire-live");
  const incidentVis  = initialVisibility("wildfire-incidents");

  // ── Smoke layers (bottom — below fire perimeters) ──────────────────────────
  state.map.addLayer({
    id: "wildfire-smoke-fill",
    type: "fill",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "smoke"],
    layout: { visibility: smokeVis },
    paint: {
      "fill-color": [
        "match", ["get", "density"],
        "Light",  "#ffd700",
        "Medium", "#ff8c00",
        "Heavy",  "#8b4513",
        "#aaaaaa",
      ],
      "fill-opacity": [
        "match", ["get", "density"],
        "Light",  0.18,
        "Medium", 0.28,
        "Heavy",  0.38,
        0.2,
      ],
    },
  } as LayerSpecification);

  state.map.addLayer({
    id: "wildfire-smoke-line",
    type: "line",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "smoke"],
    layout: { visibility: smokeVis },
    paint: {
      "line-color": [
        "match", ["get", "density"],
        "Light",  "#c8a000",
        "Medium", "#c86000",
        "Heavy",  "#5a2a00",
        "#888888",
      ],
      "line-width": 1,
      "line-opacity": 0.5,
    },
  } as LayerSpecification);

  // ── Fire perimeter fill — thin so basemap terrain reads through ────────────
  state.map.addLayer({
    id: "wildfire-perimeters-fill",
    type: "fill",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "perimeter"],
    layout: { visibility: wildfireVis },
    paint: {
      "fill-color": "#ff6600",
      "fill-opacity": 0.12,
    },
  } as LayerSpecification);

  // ── Perimeter outline — colored by % contained (red→orange→green) ──────────
  state.map.addLayer({
    id: "wildfire-perimeters-line",
    type: "line",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "perimeter"],
    layout: { visibility: wildfireVis },
    paint: {
      "line-color": [
        "interpolate", ["linear"],
        ["to-number", ["get", "pct_contained"], 0],
        0,   "#cc2200",
        50,  "#ff8800",
        100, "#22aa44",
      ],
      "line-width": 2,
      "line-opacity": 0.9,
    },
  } as LayerSpecification);

  // ── Hotspot heatmap — FRP-weighted, shown at low zoom ─────────────────────
  state.map.addLayer({
    id: "wildfire-hotspots-heat",
    type: "heatmap",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "hotspot"],
    maxzoom: 9,
    layout: { visibility: wildfireVis },
    paint: {
      "heatmap-weight": [
        "interpolate", ["linear"], ["to-number", ["get", "frp"], 0],
        0, 0, 10, 0.1, 50, 0.3, 200, 0.6, 500, 0.85, 2000, 1,
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 8, 9, 20],
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0,   "rgba(255,200,0,0)",
        0.2, "rgba(255,200,0,0.7)",
        0.5, "rgba(255,100,0,0.9)",
        1.0, "rgba(180,0,0,1)",
      ],
      "heatmap-opacity": 0.85,
    },
  } as LayerSpecification);

  // ── Hotspot circles — individual dots at high zoom, colored by confidence ──
  state.map.addLayer({
    id: "wildfire-hotspots-circle",
    type: "circle",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "hotspot"],
    minzoom: 8,
    layout: { visibility: wildfireVis },
    paint: {
      "circle-color": [
        "interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", "age_hours"], null], 24],
        0, "#ff2200",
        24, "#ffcc00",
      ],
      "circle-radius": [
        "interpolate", ["linear"], ["to-number", ["get", "frp"], 0],
        0, 4, 100, 7, 1000, 12,
      ],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 0.5,
      "circle-opacity": 0.9,
    },
  } as LayerSpecification);

  // ── Named incident points — human-reported; always visible, above hotspots ─
  state.map.addLayer({
    id: "wildfire-incidents-circle",
    type: "circle",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "incident"],
    layout: { visibility: incidentVis },
    paint: {
      "circle-color": [
        "interpolate", ["linear"], ["to-number", ["get", "pct_contained"], 0],
        0,   "#cc0000",
        90,  "#f1c40f",
        100, "#2ecc71",
      ],
      "circle-radius": [
        "step", ["to-number", ["get", "acres"], 0],
        6,
        100,   8,
        1000,  11,
        10000, 14,
      ],
      "circle-stroke-color": [
        "match", ["get", "type_cat"],
        "RX", "#3498db",
        "#ffffff",
      ],
      "circle-stroke-width": 2,
      "circle-opacity": 0.9,
    },
  } as LayerSpecification);
}

export function addSeismicHazard() {
  if (!state.map || state.map.getSource("usgs-seismic-pga")) return;
  state.map.addSource("usgs-seismic-pga", {
    type: "raster",
    url: pmtilesUrl(DATA.usgs_seismic_pga),
    tileSize: 256,
    attribution: '<a href="https://www.usgs.gov/programs/earthquake-hazards/science/2018-nshm">USGS NSHM</a>',
  });
  state.map.addLayer({
    id: "usgs-seismic-pga",
    type: "raster",
    source: "usgs-seismic-pga",
    layout: { visibility: initialVisibility("usgs-seismic-pga") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
  } as LayerSpecification);
}

export function addWildfireHazard() {
  if (!state.map || state.map.getSource("usfs-wildfire-potential")) return;
  state.map.addSource("usfs-wildfire-potential", {
    type: "raster",
    url: pmtilesUrl(DATA.usfs_wildfire_potential),
    tileSize: 256,
    attribution: '<a href="https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-hazard-potential">USFS Fire Lab</a>',
  });
  state.map.addLayer({
    id: "usfs-wildfire-potential",
    type: "raster",
    source: "usfs-wildfire-potential",
    layout: { visibility: initialVisibility("usfs-wildfire-potential") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "nearest" },
  } as LayerSpecification);
}
