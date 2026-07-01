// MapLibre builder — BTS NARN rail network lines (PMTiles vector).
// Role: addRailroads() adds the rail source + single line layer.
// Deps: ../state, ../constants (DATA), ./layer-init (pmtilesUrl, initialVisibility,
//       registerBaseFilter). Called from ./add-all-layers.
import type { LayerSpecification } from 'maplibre-gl';
import { state, SOURCE_ATTRIB } from '../state.js';
import { DATA } from '../constants.js';
import { pmtilesUrl, initialVisibility, registerBaseFilter } from './layer-init.js';

export function addRailroads() {
  if (!state.map || state.map.getSource("railroads")) return;

  state.map.addSource("railroads", {
    type: "vector",
    url: pmtilesUrl(DATA.railroads),
    attribution: SOURCE_ATTRIB["railroads"],
  });

  state.map.addLayer({
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
  } as unknown as LayerSpecification);
  registerBaseFilter("railroads", null);
}
