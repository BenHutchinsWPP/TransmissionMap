// ─── MSHA Large Mines layer (filtered) ───────────────────────────────────────
// One lazy GeoJSON source (~2.3k points) → one symbol layer: SVG icon per
// commodity category, sized by peak employment (retired = dimmed).
// Colors/icons come from src/colors/minerals.ts; filter logic in
// assets/filters.ts (applyMinesFilter); popup in assets/popup-format.ts.
import type { LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC } from '../state.js';
import { minesIconExpr } from '../../src/colors/minerals.js';
import { initialVisibility, registerBaseFilter } from './layer-init.js';

export function addMines() {
  if (!state.map || state.map.getSource("mines")) return;
  state.map.addSource("mines", { type: "geojson", data: EMPTY_FC });
  const vis = initialVisibility("mines");
  const retired = ["==", ["get", "status"], "retired"];
  // Size scales with mine size (peak employment) — same shape as genIconSize()
  // in src/colors/fuel.ts (small/medium/large buckets per zoom stop).
  const emp = ["coalesce", ["to-number", ["get", "employees"]], 0];
  const empBucket = (sm: number, md: number, lg: number) =>
    ["case", [">=", emp, 1000], lg, [">=", emp, 300], md, sm];

  state.map.addLayer({
    id: "mines-icons",
    type: "symbol",
    source: "mines",
    minzoom: 3,
    layout: {
      visibility: vis,
      "icon-image": minesIconExpr(),
      "icon-size": ["interpolate", ["linear"], ["zoom"],
        4,  empBucket(0.9, 1.2, 1.5),
        8,  empBucket(1.1, 1.5, 2.0),
        12, empBucket(1.5, 1.9, 2.5)],
      "icon-allow-overlap": true,
      "symbol-sort-key": ["case", ["==", ["get", "status"], "active"], 0, 1],
    },
    paint: { "icon-opacity": ["case", retired, 0.55, 1] },
  } as unknown as LayerSpecification);
  registerBaseFilter("mines-icons", null);
}
