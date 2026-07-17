// ─── WestTEC 10-Year Horizon portfolio lines ─────────────────────────────────
// Imported by: add-all-layers.ts
// Deps: state.js (state/DATA/EMPTY_FC), src/colors/buckets.js (westtecColorExpr),
//       layer-init.js (initialVisibility, registerBaseFilter)

import type { LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC } from '../state.js';
import { westtecColorExpr } from '../../src/colors/buckets.js';
import { initialVisibility, registerBaseFilter } from './layer-init.js';

export function addWestTEC() {
  if (!state.map || state.map.getSource("westtec-10yr")) return;

  state.map.addSource("westtec-10yr", { type: "geojson", data: EMPTY_FC });

  const vis = initialVisibility("westtec-10yr");

  state.map.addLayer({
    id: "westtec-lines-casing",
    type: "line", source: "westtec-10yr", minzoom: 3,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 4.5, 7, 6.5, 12, 10],
      "line-opacity": 0.75,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("westtec-lines-casing", null);

  state.map.addLayer({
    id: "westtec-lines",
    type: "line", source: "westtec-10yr", minzoom: 3,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": westtecColorExpr(state.westtecColorBy),
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2, 7, 3.5, 12, 6],
      "line-dasharray": [4, 2],
      "line-opacity": 0.95,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("westtec-lines", null);
}
