// MapLibre builder — BTS NARN rail network lines (PMTiles vector).
// Role: planRailroads() plans the rail source + single line layer.
// Deps: ./layer-source (layerSource), ./layer-plan (LayerPlan type).
// Called from ./add-all-layers.
import type { LayerSpecification } from 'maplibre-gl';
import { layerSource } from './layer-source.js';
import type { LayerPlan } from './layer-plan.js';

export function planRailroads(): LayerPlan {
  return [layerSource("railroads"), { layer: {
    id: "railroads",
    type: "line",
    source: "railroads",
    "source-layer": "railroads",
    minzoom: 4,
    layout: {
      "line-cap": "round", "line-join": "round",
    },
    paint: {
      "line-color": "#525252",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 8, 1.0, 12, 2.0],
      "line-opacity": 0.85,
      // crossties effect: dashed at high zoom reads as rail
      "line-dasharray": [3, 1.5],
    },
  } as unknown as LayerSpecification }];
}
