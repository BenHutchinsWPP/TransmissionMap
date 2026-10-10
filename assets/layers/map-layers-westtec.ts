// ─── WestTEC 10-Year Horizon portfolio lines ─────────────────────────────────
// planWestTEC() returns a LayerPlan (layer-plan.ts); add-all-layers.ts applies it.
// Imported by: add-all-layers.ts
// Deps: state.js (state.westtecColorBy), src/colors/facets.js (westtecColorExpr),
//       layer-source.js (layerSource), layer-plan.js (LayerPlan type)

import type { LayerSpecification } from "maplibre-gl";
import { state } from '../state.js';
import { westtecColorExpr } from '../../src/colors/facets.js';
import { layerSource } from './layer-source.js';
import type { LayerPlan } from './layer-plan.js';

export function planWestTEC(): LayerPlan {

  return [layerSource("westtec-10yr"), { layer: {
    id: "westtec-lines-casing",
    type: "line", source: "westtec-10yr", minzoom: 3,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 4.5, 7, 6.5, 12, 10],
      "line-opacity": 0.75,
    },
  } as unknown as LayerSpecification }, { layer: {
    id: "westtec-lines",
    type: "line", source: "westtec-10yr", minzoom: 3,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": westtecColorExpr(state.westtecColorBy),
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2, 7, 3.5, 12, 6],
      "line-dasharray": [4, 2],
      "line-opacity": 0.95,
    },
  } as unknown as LayerSpecification }];
}
