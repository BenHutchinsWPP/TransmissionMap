// ─── EIA petroleum (liquids) pipeline layers ─────────────────────────────────
// Crude-oil + petroleum-product pipelines from the EIA U.S. Energy Atlas, served
// as browser-direct GeoJSON (small; no PMTiles). Popup in popup-format.ts;
// registry entries in src/registry/pipelines.ts are commented out, so the
// sources are written here (credit included) and never loaded or shown today.
// Restoring them: swap each inline source for layerSource(id) (layer-source.ts).
// planPetroleumPipelines() returns a LayerPlan (layer-plan.ts).
// Imported by: add-all-layers.ts.

import type { LayerSpecification } from "maplibre-gl";
import { EMPTY_FC } from '../constants.js';
import { EIA_ATLAS_CREDIT } from '../../src/registry/sources.js';
import type { LayerPlan } from './layer-plan.js';

// [registryId (also the source id), color]
const LINES: [string, string][] = [
  ["eia-crude-pipelines", "#7c2d12"],
  ["eia-product-pipelines", "#ca8a04"],
];

export function planPetroleumPipelines(): LayerPlan {
  return LINES.flatMap(([id, color]): LayerPlan => [
    { source: id, spec: { type: "geojson", data: EMPTY_FC, attribution: EIA_ATLAS_CREDIT } },
    { layer: {
      id, type: "line", source: id,
      minzoom: 3,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 6, 1.8, 10, 3, 13, 5],
        "line-opacity": 0.9,
      },
    } as unknown as LayerSpecification },
  ]);
}
