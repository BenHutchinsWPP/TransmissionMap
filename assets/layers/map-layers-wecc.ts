// ─── WECC Path Rating Catalog layer ──────────────────────────────────────────
// One point per active WECC path; the path Number is the on-map label. Ratings /
// directionality / line list live in feature properties (rendered by popup-format.ts).
// Clicking a path marker highlights the OSM/HIFLD transmission lines matched to that
// path (separate "wecc-path-lines" source — maintained by hand).
//
// Additional digitized corridor LineStrings sit in the same "wecc-paths" source,
// flagged by isCorridor=true. They render as thick semi-transparent bands showing
// the interface cut-plane / approximate path extent. Hand-digitized from
// WECC_Path_Markup.geojson (37 paths as of Jul 2026); maintained by hand.
//
// Source data: data/layers/wecc_paths.geojson.gz + wecc_path_lines.geojson.gz
//   (maintained by hand).
// Imported by: add-all-layers.ts. Lazy-loaded via layer-init.ts LAZY_GEOJSON.

import type { FilterSpecification, LayerSpecification } from "maplibre-gl";
import { state, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { initialVisibility, registerBaseFilter, ensureLayerData } from './layer-init.js';

const SWATCH = "#eab308";
// filter that matches nothing — the highlight shows lines only after a path is clicked
const NONE_FILTER = ["==", ["get", "path"], -1] as unknown as never;

// Marker size factor by rated capacity (higher of fwd/rev MW). 3 buckets:
//   small <1000 MW, medium 1000–3000 MW, large ≥3000 MW (≈terciles of the catalog).
// Multiplied into the zoom-based radius/text-size so big paths read bigger.
const RATED_MW = ["max", ["coalesce", ["get", "mw_fwd"], 0], ["coalesce", ["get", "mw_rev"], 0]];
const SIZE_FACTOR = ["step", RATED_MW, 0.9, 1000, 1.15, 3000, 1.45];

// Filters to separate corridor lines from path markers
const IS_CORRIDOR  = ["==", ["get", "isCorridor"], true] as unknown as FilterSpecification;
const NOT_CORRIDOR = ["!=", ["get", "isCorridor"], true] as unknown as FilterSpecification;

export function addWeccPaths() {
  if (!state.map || state.map.getSource("wecc-paths")) return;

  state.map.addSource("wecc-paths", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["wecc-paths"] });
  state.map.addSource("wecc-path-lines", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["wecc-paths"] });

  const vis = initialVisibility("wecc-paths");

  // ── Digitized corridor lines (isCorridor=true) ──────────────────────────────
  // Thick semi-transparent bands showing approximate path extent.
  state.map.addLayer({
    id: "wecc-path-corridors", type: "line", source: "wecc-paths",
    filter: IS_CORRIDOR,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": SWATCH,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 18, 8, 48, 12, 96],
      "line-opacity": 0.20,
      "line-blur": 4,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("wecc-path-corridors", null);

  // Corridor outline
  state.map.addLayer({
    id: "wecc-path-corridors-outline", type: "line", source: "wecc-paths",
    filter: IS_CORRIDOR,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#d97706",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 8, 3, 12, 5],
      "line-opacity": 0.4,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("wecc-path-corridors-outline", null);

  // ── Catalog path markers (point geometries, isCorridor != true) ────────────

  // Highlight lines matched from OSM/HIFLD (shown on click)
  state.map.addLayer({
    id: "wecc-path-lines-highlight", type: "line", source: "wecc-path-lines",
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    filter: NONE_FILTER,
    paint: {
      "line-color": SWATCH,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 4, 10, 9],
      "line-opacity": 0.55,
      "line-blur": 0.5,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("wecc-path-lines-highlight", null);

  // Path number circles
  state.map.addLayer({
    id: "wecc-paths-circles", type: "circle", source: "wecc-paths",
    filter: NOT_CORRIDOR,
    minzoom: 3,
    layout: { visibility: vis },
    paint: {
      "circle-color": SWATCH,
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        3, ["*", 7, SIZE_FACTOR], 8, ["*", 12, SIZE_FACTOR], 12, ["*", 16, SIZE_FACTOR]],
      "circle-stroke-color": "#422006",
      "circle-stroke-width": 1.2,
      "circle-opacity": 0.9,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("wecc-paths-circles", null);

  // Path number label
  state.map.addLayer({
    id: "wecc-paths-label", type: "symbol", source: "wecc-paths",
    filter: NOT_CORRIDOR,
    minzoom: 3,
    layout: {
      visibility: vis,
      "text-field": ["to-string", ["get", "number"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"],
        3, ["*", 9, SIZE_FACTOR], 8, ["*", 12, SIZE_FACTOR], 12, ["*", 15, SIZE_FACTOR]],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#1c1917",
      "text-halo-color": "rgba(255,255,255,0.7)",
      "text-halo-width": 0.6,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("wecc-paths-label", null);

  // Clicking a path marker highlights that path's matched lines (lazy-loads them once).
  state.map.on("click", "wecc-paths-circles", (e) => {
    const num = e.features?.[0]?.properties?.number;
    if (num == null) return;
    ensureLayerData("wecc-path-lines").then(() => {
      state.map?.setFilter("wecc-path-lines-highlight",
        ["==", ["get", "path"], Number(num)] as unknown as never);
    });
  });
}

/** Clear the WECC path-line highlight (called when the popup closes / selection clears). */
export function clearWeccHighlight() {
  if (state.map?.getLayer("wecc-path-lines-highlight")) {
    state.map.setFilter("wecc-path-lines-highlight", NONE_FILTER);
  }
}
