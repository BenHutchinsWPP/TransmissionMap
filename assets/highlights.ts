// ─── Search highlight layers ──────────────────────────────────────────────────
// Yellow highlight sources + layers for feature-search results; set and cleared
// by ui/ui-search.ts. The line/polygon layers stay hidden while their source is
// empty, so 3D terrain does not drape an empty source every frame.
// Deps: state.ts (map), constants.ts (EMPTY_FC).

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { state } from './state.js';
import { EMPTY_FC } from './constants.js';

const LINE_LAYERS = ["highlight-lines", "highlight-poly-fill"];

function setLines(map: MlMap, fc: GeoJSON.FeatureCollection) {
  (map.getSource("highlight-lines") as GeoJSONSource)?.setData(fc);
  const vis = fc.features.length ? "visible" : "none";
  for (const id of LINE_LAYERS) map.setLayoutProperty(id, "visibility", vis);
}

export function addHighlightLayers() {
  if (!state.map) return;
  state.map.addSource("highlight-pts",   { type: "geojson", data: EMPTY_FC });
  state.map.addSource("highlight-lines", { type: "geojson", data: EMPTY_FC });

  state.map.addLayer({
    id: "highlight-lines",
    type: "line",
    source: "highlight-lines",
    layout: { visibility: "none" },
    paint: {
      "line-color": "#facc15",
      "line-width": 5,
      "line-opacity": 0.9,
    },
  });

  state.map.addLayer({
    id: "highlight-poly-fill",
    type: "fill",
    source: "highlight-lines",
    filter: ["==", ["geometry-type"], "Polygon"],
    layout: { visibility: "none" },
    paint: { "fill-color": "#facc15", "fill-opacity": 0.25 },
  });

  state.map.addLayer({
    id: "highlight-pts",
    type: "circle",
    source: "highlight-pts",
    paint: {
      "circle-color": "#facc15",
      "circle-radius": 13,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2.5,
      "circle-opacity": 0.85,
      "circle-stroke-opacity": 1,
    },
  });
}

export function setHighlightFeatures(features: GeoJSON.Feature[]) {
  if (!state.mapReady || !state.map) return;
  const pts: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: features.filter(f => f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint"),
  };
  const lines: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: features.filter(f => f.geometry?.type !== "Point" && f.geometry?.type !== "MultiPoint"),
  };
  (state.map.getSource("highlight-pts") as GeoJSONSource)?.setData(pts);
  setLines(state.map, lines);
}

export function clearHighlights() {
  if (!state.mapReady || !state.map) return;
  (state.map.getSource("highlight-pts") as GeoJSONSource)?.setData(EMPTY_FC);
  setLines(state.map, EMPTY_FC);
}
