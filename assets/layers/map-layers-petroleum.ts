// ─── EIA petroleum (liquids) pipeline layers ─────────────────────────────────
// Crude-oil + petroleum-product pipelines from the EIA U.S. Energy Atlas, served
// as browser-direct GeoJSON (small; no PMTiles). Lazy-loaded via layer-data.ts
// LAYER_DATA_URLS; popup in popup-format.ts; registry entries in src/registry/pipelines.ts.
// planPetroleumPipelines() returns a LayerPlan (layer-plan.ts).
// Imported by: add-all-layers.ts.

import type { LayerSpecification } from "maplibre-gl";
import { EMPTY_FC } from '../constants.js';
import { initialVisibility } from './layer-init.js';
import type { LayerPlan } from './layer-plan.js';

// [registryId (also the source id), color]
const LINES: [string, string][] = [
  ["eia-crude-pipelines", "#7c2d12"],
  ["eia-product-pipelines", "#ca8a04"],
];

export function planPetroleumPipelines(): LayerPlan {
  return LINES.flatMap(([id, color]): LayerPlan => [
    { source: id, spec: { type: "geojson", data: EMPTY_FC } },
    { layer: {
      id, type: "line", source: id,
      minzoom: 3,
      layout: { visibility: initialVisibility(id), "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 6, 1.8, 10, 3, 13, 5],
        "line-opacity": 0.9,
      },
    } as unknown as LayerSpecification },
  ]);
}
