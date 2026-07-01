// ─── EIA petroleum (liquids) pipeline layers ─────────────────────────────────
// Crude-oil + petroleum-product pipelines from the EIA U.S. Energy Atlas, served
// as browser-direct GeoJSON (small; no PMTiles). Lazy-loaded via layer-init.ts
// LAZY_GEOJSON; popup in popup-format.ts; registry entries in src/registry/pipelines.ts.
// Imported by: add-all-layers.ts.

import type { LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { initialVisibility, registerBaseFilter } from './layer-init.js';

// [registryId, sourceAttribKey, color]
const LINES: [string, string][] = [
  ["eia-crude-pipelines", "#7c2d12"],
  ["eia-product-pipelines", "#ca8a04"],
];

export function addPetroleumPipelines() {
  if (!state.map || state.map.getSource("eia-crude-pipelines")) return;

  for (const [id, color] of LINES) {
    state.map.addSource(id, { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB[id] });
    state.map.addLayer({
      id, type: "line", source: id,
      minzoom: 3,
      layout: { visibility: initialVisibility(id), "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 6, 1.8, 10, 3, 13, 5],
        "line-opacity": 0.9,
      },
    } as unknown as LayerSpecification);
    registerBaseFilter(id, null);
  }
}
