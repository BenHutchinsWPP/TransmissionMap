// MapLibre builder — BTS NARN rail network lines (PMTiles vector).
// Role: planRailroads() plans the rail source + single line layer.
// Deps: ../constants (DATA), ./layer-init (pmtilesUrl, initialVisibility),
//       ./layer-plan (LayerPlan type). Called from ./add-all-layers.
import type { LayerSpecification } from 'maplibre-gl';
import { DATA } from '../constants.js';
import { pmtilesUrl, initialVisibility } from './layer-init.js';
import type { LayerPlan } from './layer-plan.js';

export function planRailroads(): LayerPlan {
  return [{ source: "railroads", spec: { type: "vector", url: pmtilesUrl(DATA.railroads) } }, { layer: {
    id: "railroads",
    type: "line",
    source: "railroads",
    "source-layer": "railroads",
    minzoom: 4,
    layout: {
      visibility: initialVisibility("railroads"),
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
