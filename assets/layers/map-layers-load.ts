// ─── Load context layers ──────────────────────────────────────────────────────
// Data center moratoriums: one GeoJSON source (`dc-moratoriums`) drawn at two
// z-levels — addDcMoratoriumAreas() with the context fills (state wash, then
// hatched utility service areas, then counties), addDcMoratoriumPoints() with the
// infrastructure markers. Colours from DCM_CLASSES (src/colors/buckets.ts); the
// utility hatch images are generated here from them (map.addImage); popups in
// popup-format.ts.

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { state } from '../state.js';
import { DATA, EMPTY_FC, SOURCE_ATTRIB } from '../constants.js';
import { initialVisibility, registerBaseFilter, addRasterLayer } from './layer-init.js';
import { HEAT_DENSITY_COLOR } from '../../src/colors/ramps.js';
import { DCM_CLASSES } from '../../src/colors/buckets.js';
import { onMapTap } from '../map-input.js';

export const addPopDensity = () => addRasterLayer("worldpop-pop-density", DATA.worldpop_pop_density,
  '<a href="https://www.worldpop.org/">WorldPop</a>', { opacity: 0.75 });

// Circle area ∝ facility sqft (radius ∝ √sqft, normalized to the ~135k sq ft
// median). Clamped ×[0.6, 3] so the 26.6M sq ft campuses don't swamp the map;
// rows without im3_sqft (~17%, mostly CA/MX) get a fixed slightly-small ×0.8.
// CSV-built GeoJSON carries string properties and nulls as "" — coerce.
const DC_SIZE_FACTOR: ExpressionSpecification = [
  "case", [">", ["to-number", ["get", "im3_sqft"], 0], 0],
  ["min", 3, ["max", 0.6, ["sqrt", ["/", ["to-number", ["get", "im3_sqft"]], 135000]]]],
  0.8,
] as unknown as ExpressionSpecification;

// Shared by osm-dc-circles (clustered source) and osm-dc-points (plain twin).
const DC_POINT_PAINT = {
  "circle-color": "#6366f1",
  "circle-radius": ["interpolate", ["linear"], ["zoom"],
    0, ["*", 3, DC_SIZE_FACTOR], 4, ["*", 5, DC_SIZE_FACTOR],
    8, ["*", 7, DC_SIZE_FACTOR], 12, ["*", 10, DC_SIZE_FACTOR]],
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 1,
  "circle-opacity": 0.85,
};

export function addOsmDataCenters() {
  if (!state.map || state.map.getSource("osm-datacenters")) return;
  state.map.addSource("osm-datacenters", {
    type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["osm-datacenters"],
    cluster: true, clusterRadius: 40, clusterMaxZoom: 12,
    // Per-cluster total facility area (sq ft) — sizes cluster circles + feeds heat weight.
    clusterProperties: { sqft_sum: ["+", ["to-number", ["get", "im3_sqft"], 0]] },
  });
  // Unclustered twin source for the Points display mode AND the heatmap
  // (heat needs raw point density; clusters collapse it to one dot per metro). (MapLibre cannot
  // toggle clustering on a live source). Data mirrored from the lazy fetch.
  state.map.addSource("osm-datacenters-plain", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["osm-datacenters"] });
  state.map.addLayer({
    id: "osm-dc-circles",
    type: "circle",
    source: "osm-datacenters",
    minzoom: 0,
    layout: { visibility: initialVisibility("osm-datacenters") },
    paint: DC_POINT_PAINT,
    filter: ["!", ["has", "point_count"]],
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-dc-circles", ["!", ["has", "point_count"]]);

  // Cluster bubbles: radius = max(count curve, summed-sqft curve) so a stack of
  // unsized CA/MX sites still grows, and a 2-site hyperscale campus still reads big.
  state.map.addLayer({
    id: "osm-dc-clusters", type: "circle", source: "osm-datacenters",
    filter: ["has", "point_count"],
    layout: { visibility: initialVisibility("osm-datacenters") },
    paint: {
      "circle-color": "#6366f1",
      "circle-radius": ["max",
        ["interpolate", ["linear"], ["get", "point_count"], 2, 10, 10, 15, 50, 22, 200, 30],
        ["interpolate", ["linear"], ["get", "sqft_sum"], 0, 8, 1000000, 14, 10000000, 22, 50000000, 30]],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-opacity": 0.85,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-dc-clusters", ["has", "point_count"]);

  state.map.addLayer({
    id: "osm-dc-cluster-count", type: "symbol", source: "osm-datacenters",
    filter: ["has", "point_count"],
    layout: {
      visibility: initialVisibility("osm-datacenters"),
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#ffffff" },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-dc-cluster-count", ["has", "point_count"]);

  state.map.addLayer({
    id: "osm-dc-points", type: "circle", source: "osm-datacenters-plain",
    minzoom: 0,
    layout: { visibility: "none" },
    paint: DC_POINT_PAINT,
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-dc-points", null);
  window.addEventListener("tm:layerdata", (e) => {
    if ((e as CustomEvent).detail?.registryId !== "osm-datacenters" || !state.map) return;
    const src = state.map.getSource("osm-datacenters-plain") as import("maplibre-gl").GeoJSONSource | undefined;
    if (src) src.setData({ type: "FeatureCollection", features: state.sourcesData["osm-datacenters"] || [] } as GeoJSON.FeatureCollection);
  });

  // Street-zoom companion for Heatmap mode: sqft-sized points fading in as the
  // heat fades out (z9.5-12), so the mode never goes blank up close.
  state.map.addLayer({
    id: "osm-dc-heat-points", type: "circle", source: "osm-datacenters-plain",
    minzoom: 9,
    layout: { visibility: "none" },
    paint: {
      "circle-color": "#6366f1",
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        8, ["*", 7, DC_SIZE_FACTOR], 12, ["*", 10, DC_SIZE_FACTOR]],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-opacity":        ["interpolate", ["linear"], ["zoom"], 9.5, 0, 12, 0.85],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 9.5, 0, 12, 1],
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-dc-heat-points", null);

  // Click a cluster → zoom into it.
  onMapTap("osm-dc-clusters", async (_e, features) => {
    const f = features[0];
    if (!state.map) return;
    const src = state.map.getSource("osm-datacenters") as import("maplibre-gl").GeoJSONSource;
    const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id);
    state.map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
  });
  // Pointer cursor comes from popup.ts's shared hit-test (CURSOR_ONLY_LAYERS).

  // Heatmap sibling for the Icons/Heatmap/Both toggle (visibility driven by
  // applyGenMode). Weight ∝ facility sqft; unsized rows count as a small site.
  state.map.addLayer({
    // Heat mode hands off to points at street zoom: heat fades out z9.5-12
    // while osm-dc-heat-points fades in (see below).
    id: "osm-dc-heat", type: "heatmap", source: "osm-datacenters-plain",
    maxzoom: 12,
    layout: { visibility: "none" },
    paint: {
      "heatmap-weight": ["interpolate", ["linear"],
        ["to-number", ["get", "im3_sqft"], 0],
        0, 0.15, 135000, 0.5, 1000000, 1, 5000000, 2],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 9, 2.5],
      "heatmap-radius":    ["interpolate", ["linear"], ["zoom"], 3, 12, 9, 40, 12, 55],
      "heatmap-color":     HEAT_DENSITY_COLOR,
      "heatmap-opacity":   ["interpolate", ["linear"], ["zoom"], 9.5, 0.85, 12, 0],
    },
  } as unknown as LayerSpecification, "osm-dc-circles");
  registerBaseFilter("osm-dc-heat", null);
}

// ─── Data center moratoriums ──────────────────────────────────────────────────
const DCM_COLOR = [
  "match", ["get", "cls"],
  ...DCM_CLASSES.flatMap(c => [c.id, c.color]),
  "#9ca3af",
] as unknown as ExpressionSpecification;

// "Changed recently": the newest dated event on the feature falls inside the
// last 30 days. ISO dates compare as strings; the cutoff is fixed at load.
const DCM_RECENT_DAYS = 30;
const dcmRecent = (): ExpressionSpecification => [">=", ["get", "last_event"],
  new Date(Date.now() - DCM_RECENT_DAYS * 864e5).toISOString().slice(0, 10)] as ExpressionSpecification;

// Utility service areas are hatched rather than filled, so a county or town
// inside one still reads as its own measure. One "/" stripe tile per class
// colour: 16 device px at pixelRatio 2 (8 CSS px), stripes 1.5 CSS px wide.
function dcmHatch(hex: string): { width: number; height: number; data: Uint8Array } {
  const n = 16, data = new Uint8Array(n * n * 4);
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if ((x + y) % n < 3) data.set([...rgb, 255], (y * n + x) * 4);
    }
  }
  return { width: n, height: n, data };
}

export function addDcMoratoriumAreas() {
  if (!state.map || state.map.getSource("dc-moratoriums")) return;
  state.map.addSource("dc-moratoriums", {
    type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["dc-moratoriums"],
  });
  const vis = initialVisibility("dc-moratoriums");
  // States are a light wash under a heavy dashed edge, so the county fills and
  // points inside them stay readable.
  state.map.addLayer({
    id: "dcm-state-fill", type: "fill", source: "dc-moratoriums",
    filter: ["==", ["get", "kind"], "state"],
    layout: { visibility: vis },
    paint: { "fill-color": DCM_COLOR, "fill-opacity": 0.12 },
  } as LayerSpecification);
  state.map.addLayer({
    id: "dcm-state-line", type: "line", source: "dc-moratoriums",
    filter: ["==", ["get", "kind"], "state"],
    layout: { visibility: vis },
    paint: { "line-color": DCM_COLOR, "line-width": 2.5, "line-dasharray": [3, 2], "line-opacity": 0.8 },
  } as LayerSpecification);
  // Utility (and grid-operator) service areas: hatched in the class colour under
  // a dash-dot edge, below the counties so a county or town inside one wins the
  // click.
  for (const c of DCM_CLASSES) {
    const id = `dcm-hatch-${c.id}`;
    if (!state.map.hasImage(id)) state.map.addImage(id, dcmHatch(c.color), { pixelRatio: 2 });
  }
  const isUtility = ["==", ["get", "kind"], "utility"] as ExpressionSpecification;
  state.map.addLayer({
    id: "dcm-utility-fill", type: "fill", source: "dc-moratoriums",
    filter: isUtility,
    layout: { visibility: vis },
    paint: { "fill-pattern": ["concat", "dcm-hatch-", ["get", "cls"]], "fill-opacity": 0.7 },
  } as LayerSpecification);
  state.map.addLayer({
    id: "dcm-utility-line", type: "line", source: "dc-moratoriums",
    filter: isUtility,
    layout: { visibility: vis },
    paint: {
      "line-color": ["case", dcmRecent(), "#1d4ed8", DCM_COLOR],
      "line-width": ["case", dcmRecent(), 2.5, 1.5],
      "line-dasharray": [4, 2, 1, 2],
    },
  } as LayerSpecification);
  state.map.addLayer({
    id: "dcm-county-fill", type: "fill", source: "dc-moratoriums",
    filter: ["==", ["get", "kind"], "county"],
    layout: { visibility: vis },
    paint: {
      "fill-color": DCM_COLOR,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 0.45, 11, 0.3],
    },
  } as LayerSpecification);
  state.map.addLayer({
    id: "dcm-county-line", type: "line", source: "dc-moratoriums",
    filter: ["==", ["get", "kind"], "county"],
    layout: { visibility: vis },
    paint: {
      "line-color": ["case", dcmRecent(), "#1d4ed8", DCM_COLOR],
      "line-width": ["case", dcmRecent(), 2.5, 0.8],
    },
  } as LayerSpecification);
}

export function addDcMoratoriumPoints() {
  if (!state.map || state.map.getLayer("dcm-points")) return;
  const vis = initialVisibility("dc-moratoriums");
  const isPoint = ["==", ["get", "kind"], "point"] as ExpressionSpecification;
  // A blue ring marks a point that changed in the last DCM_RECENT_DAYS.
  state.map.addLayer({
    id: "dcm-points-recent", type: "circle", source: "dc-moratoriums",
    filter: ["all", isPoint, dcmRecent()],
    layout: { visibility: vis },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 6, 8, 10, 12, 14],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#1d4ed8",
      "circle-stroke-width": 2,
    },
  } as LayerSpecification);
  state.map.addLayer({
    id: "dcm-points", type: "circle", source: "dc-moratoriums",
    filter: isPoint,
    layout: { visibility: vis },
    paint: {
      "circle-color": DCM_COLOR,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3, 8, 6, 12, 9],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  } as LayerSpecification);
}
