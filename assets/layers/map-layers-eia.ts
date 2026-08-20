// ─── EIA generator layers ────────────────────────────────────────────────────

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { EIA_GEN_ICON, genIconSize } from '../../src/colors/fuel.js';
import { HEAT_MW_STOPS, HEAT_DENSITY_COLOR } from '../../src/colors/ramps.js';
import { initialVisibility, registerBaseFilter, genPlantTextLayout, GEN_PLANT_TEXT_PAINT, addPolygonLayer } from './layer-init.js';

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

export function addEiaBalancingAuthorities() {
  // Each balancing authority carries its own hex fill from the extract
  // (golden-ratio hue sequence — see scripts/extract_eia_ba.py).
  const EIA_BA_COLOR = ["coalesce", ["get", "color"], "#14b8a6"] as unknown as ExpressionSpecification;

  addPolygonLayer({
    sourceId: "eia-ba", source: { type: "geojson", data: EMPTY_FC },
    prefix: "eiaba", color: EIA_BA_COLOR,
    fillMinzoom: 2, fillOpacity: 0.22,
    outlineMinzoom: 2,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 2, 0.8, 5, 1.3, 8, 2.0],
    outlineOpacity: ["case", ["boolean", ["feature-state", "hover"], false], 0.90, 0.70],
  });

  if (!state.map || state.map.getLayer("eiaba-label")) return;
  const vis = initialVisibility("eia-ba");
  state.map.addLayer({
    id: "eiaba-label", type: "symbol", source: "eia-ba",
    minzoom: 4, layout: {
      visibility: vis,
      "text-field": ["get", "abbrev"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 4, 8, 7, 11, 10, 13],
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#1e293b",
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": 1.2,
      "text-opacity": 0.85,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("eiaba-label", null);
}
