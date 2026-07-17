// ─── Search highlight layers ──────────────────────────────────────────────────

import type { GeoJSONSource } from 'maplibre-gl';
import { state, EMPTY_FC } from './state.js';

export function addHighlightLayers() {
  if (!state.map) return;
  state.map.addSource("highlight-pts",   { type: "geojson", data: EMPTY_FC });
  state.map.addSource("highlight-lines", { type: "geojson", data: EMPTY_FC });

  state.map.addLayer({
    id: "highlight-lines",
    type: "line",
    source: "highlight-lines",
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
  (state.map.getSource("highlight-lines") as GeoJSONSource)?.setData(lines);
}

export function clearHighlights() {
  if (!state.mapReady || !state.map) return;
  (state.map.getSource("highlight-pts") as GeoJSONSource)?.setData(EMPTY_FC);
  (state.map.getSource("highlight-lines") as GeoJSONSource)?.setData(EMPTY_FC);
}
