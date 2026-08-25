// ─── Administrative boundary layers (Regions group) ───────────────────────────
// Role: reference boundary polygons — countries and states/provinces worldwide
//       (geoBoundaries CGAZ), plus US states/counties/ZCTAs (Census cartographic
//       boundary files). Background context, not data layers: no filters, no
//       legends. Each unit takes a muted hue off a shared palette so adjacent
//       units read apart, the same idea the HIFLD/EIA balancing-authority
//       layers use.
// Countries, States/Provinces and Census States are GeoJSON-backed so their
// whole polygons can be copied to My Data — a vector-tile feature is clipped at
// tile borders, and popup.ts gates the copy button on the absence of a
// sourceLayer. Census ZIP Codes and Census Counties stay tiled: 33.8k features
// is past what a single fetch should carry, and the county tiles are shared
// join infrastructure owned by layer-init.ts.
// Deps: layer-init.ts (addPolygonLayer, pmtilesUrl, initialVisibility,
//       registerBaseFilter, ensureCountyBoundaries, COUNTY_SRC, COUNTY_SRC_LAYER),
//       state (DATA, EMPTY_FC).
//
// addUsCounties() does NOT add its own source — it mounts on the shared
// county_boundaries PMTiles (owned by layer-init.ts, also used by the ODIN
// live outage choropleth in map-layers-conditions.ts). It carries no
// feature-state of its own, so it can't collide with ODIN's `odin_out`/
// `odin_n`/`odin_utils` keys, and add-all-layers.ts calls it before
// addOdinOutages() so the live choropleth paints over these county outlines.

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC } from '../state.js';
import {
  addPolygonLayer, pmtilesUrl, initialVisibility, registerBaseFilter,
  ensureCountyBoundaries, COUNTY_SRC, COUNTY_SRC_LAYER,
} from './layer-init.js';

// Seven hues far enough apart in both hue and lightness to stay distinguishable
// once a fill drops to a quarter opacity, which is where a pale wash starts
// converging on the basemap regardless of the colour underneath. Length must
// stay in step with COLOR_BUCKETS in scripts/extract_cgaz_boundaries.py, which
// bakes the index these are looked up by.
const ADMIN_PALETTE = [
  "#2f6fad", "#3f8f5c", "#c2762c", "#8250b0", "#1f8f96", "#c04a5e", "#8a8a2e",
];

// Every layer carries a `color_idx` map-coloured at extract time (Welsh-Powell,
// see geo_common.assign_color_index), so no two touching units share a hue and
// the style needs no adjacency knowledge of its own.
// `to-color` is load-bearing: a ["literal", [...]] array of hex strings types as
// array<string>, which fill-color/line-color reject outright — the whole paint
// expression then fails to parse and the polygon renders nothing.
export function paletteColor(field: string): ExpressionSpecification {
  return ["to-color",
    ["at",
      ["%", ["to-number", ["get", field], 0], ADMIN_PALETTE.length],
      ["literal", ADMIN_PALETTE],
    ],
  ] as unknown as ExpressionSpecification;
}

const LABEL_PAINT = {
  "text-halo-color": "rgba(255,255,255,0.85)",
  "text-halo-width": 1.2,
  "text-opacity": 0.85,
};

export function addCountries() {
  addPolygonLayer({
    sourceId: "countries", source: { type: "geojson", data: EMPTY_FC },
    prefix: "countries",
    color: paletteColor("color_idx"),
    fillMinzoom: 0, fillOpacity: 0.26,
    outlineMinzoom: 0,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 1.2, 10, 1.8] as unknown as ExpressionSpecification,
    outlineOpacity: 0.8,
  });

  if (!state.map || state.map.getLayer("countries-label")) return;
  state.map.addLayer({
    id: "countries-label", type: "symbol", source: "countries",
    minzoom: 1,
    layout: {
      visibility: initialVisibility("countries"),
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 1, 8, 5, 12] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#2f4356", ...LABEL_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("countries-label", null);
}

export function addAdmin1() {
  addPolygonLayer({
    sourceId: "admin1", source: { type: "geojson", data: EMPTY_FC },
    prefix: "admin1",
    color: paletteColor("color_idx"),
    fillMinzoom: 0, fillOpacity: 0.26,
    outlineMinzoom: 0,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 1, 0.5, 5, 1.0, 10, 1.5] as unknown as ExpressionSpecification,
    outlineOpacity: 0.8,
  });

  if (!state.map || state.map.getLayer("admin1-label")) return;
  state.map.addLayer({
    id: "admin1-label", type: "symbol", source: "admin1",
    minzoom: 2,
    layout: {
      visibility: initialVisibility("admin1"),
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 8, 7, 12] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#3d3350", ...LABEL_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("admin1-label", null);
}

export function addUsStates() {
  addPolygonLayer({
    sourceId: "us-states", source: { type: "geojson", data: EMPTY_FC },
    prefix: "us-states", color: paletteColor("color_idx"),
    fillMinzoom: 0, fillOpacity: 0.26,
    outlineMinzoom: 0,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 2, 0.8, 6, 1.4, 10, 2.2] as unknown as ExpressionSpecification,
    outlineOpacity: 0.8,
  });

  if (!state.map || state.map.getLayer("us-states-label")) return;
  state.map.addLayer({
    id: "us-states-label", type: "symbol", source: "us-states",
    minzoom: 3,
    layout: {
      visibility: initialVisibility("us-states"),
      // Abbreviation reads cleanly zoomed out; the full name earns its space
      // once the state fills more of the screen.
      "text-field": ["step", ["zoom"], ["get", "stusps"], 6, ["get", "name"]] as unknown as ExpressionSpecification,
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 6, 11, 10, 14] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#2f4356", ...LABEL_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("us-states-label", null);
}

export function addUsCounties() {
  if (!state.map || state.map.getLayer("us-counties-fill")) return;
  // The source is SHARED infra owned by layer-init.ts — guard on our own layer
  // above, never on the source, or whichever county-keyed layer initializes
  // first would silently suppress the others.
  ensureCountyBoundaries();

  const vis = initialVisibility("us-counties");
  const color = paletteColor("color_idx");

  // z2 is the county tileset's floor (tile_manifest.yaml `county_boundaries`).
  state.map.addLayer({
    id: "us-counties-fill", type: "fill", source: COUNTY_SRC, "source-layer": COUNTY_SRC_LAYER,
    minzoom: 2,
    layout: { visibility: vis },
    paint: { "fill-color": color, "fill-opacity": 0.26 },
  } as LayerSpecification);
  registerBaseFilter("us-counties-fill", null);

  state.map.addLayer({
    id: "us-counties-outline", type: "line", source: COUNTY_SRC, "source-layer": COUNTY_SRC_LAYER,
    minzoom: 2,
    layout: { visibility: vis },
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.0, 12, 1.4] as unknown as ExpressionSpecification,
      "line-opacity": 0.8,
    },
  } as LayerSpecification);
  registerBaseFilter("us-counties-outline", null);

  state.map.addLayer({
    id: "us-counties-label", type: "symbol", source: COUNTY_SRC, "source-layer": COUNTY_SRC_LAYER,
    minzoom: 7,
    layout: {
      visibility: vis,
      "text-field": ["get", "NAME"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 12] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#4a3f36", ...LABEL_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("us-counties-label", null);
}

export function addUsZcta() {
  addPolygonLayer({
    sourceId: "us-zcta",
    source: { type: "vector", url: pmtilesUrl(DATA.us_zcta) },
    sourceLayer: "us_zcta", prefix: "us-zcta",
    color: paletteColor("color_idx"),
    // z4 is the ZCTA tileset's floor (tile_manifest.yaml `us_zcta`). 33k
    // polygons tiled from z0 would be dropped down to an arbitrary sparse
    // subset, which reads worse than the layer simply starting at z4.
    fillMinzoom: 4, fillOpacity: 0.26,
    outlineMinzoom: 4,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 6, 0.5, 10, 1.0, 14, 1.4] as unknown as ExpressionSpecification,
    outlineOpacity: 0.8,
  });

  if (!state.map || state.map.getLayer("us-zcta-label")) return;
  state.map.addLayer({
    id: "us-zcta-label", type: "symbol", source: "us-zcta", "source-layer": "us_zcta",
    // 33k features — a label earlier than z10 is unreadable clutter.
    minzoom: 10,
    layout: {
      visibility: initialVisibility("us-zcta"),
      "text-field": ["get", "zcta5"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 12] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#5c3f3f", ...LABEL_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("us-zcta-label", null);
}
