// ─── EIA generator layers ────────────────────────────────────────────────────

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { EIA_GEN_ICON, genIconSize } from '../../src/colors/fuel.js';
import { HEAT_MW_STOPS, HEAT_DENSITY_COLOR } from '../../src/colors/ramps.js';
import { initialVisibility, registerBaseFilter, genPlantTextLayout, GEN_PLANT_TEXT_PAINT } from './layer-init.js';

export function addEiaGenerators() {
  if (!state.map || state.map.getSource("eia-generators")) return;

  state.map.addSource("eia-generators", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["eia-generators"] });

  const vis      = initialVisibility("eia-generators");
  const mwExpr   = ["coalesce", ["to-number", ["get", "nameplate_mw"]], 0] as unknown as ExpressionSpecification;
  const plantName = ["coalesce", ["get", "plant_name"], ""] as unknown as ExpressionSpecification;

  state.map.addLayer({
    id: "eia-gen-circles", type: "symbol", source: "eia-generators",
    minzoom: 3,
    layout: {
      visibility:           vis,
      "icon-image":         EIA_GEN_ICON,
      "icon-size":          genIconSize("nameplate_mw"),
      "icon-allow-overlap": true,
      "symbol-sort-key":    ["-", 100000, mwExpr],
      ...genPlantTextLayout(plantName, mwExpr),
    },
    paint: { ...GEN_PLANT_TEXT_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("eia-gen-circles", null);

  state.map.addLayer({
    id: "eia-gen-heat", type: "heatmap", source: "eia-generators",
    maxzoom: 9,
    layout: { visibility: "none" },
    paint: {
      "heatmap-weight": ["interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", "nameplate_mw"]], 0], ...HEAT_MW_STOPS.flat()],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 9, 2.5],
      "heatmap-radius":    ["interpolate", ["linear"], ["zoom"], 3, 12, 9, 40],
      "heatmap-color":     HEAT_DENSITY_COLOR,
      "heatmap-opacity":   ["interpolate", ["linear"], ["zoom"], 7, 0.9, 9, 0],
    },
  } as unknown as LayerSpecification, "eia-gen-circles");
  registerBaseFilter("eia-gen-heat", null);
}
