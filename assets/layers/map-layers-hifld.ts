// ─── HIFLD + region/land layers ──────────────────────────────────────────────
// Each plan* returns a LayerPlan (layer-plan.ts); add-all-layers.ts applies it.
// Imported by: add-all-layers.ts

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { state } from '../state.js';
import { DATA, EMPTY_FC } from '../constants.js';
import { voltageColorExpr } from '../../src/colors/voltage.js';
import { bucketColorExpr, ogfColorExpr, OGF_DASH_EXPR, TRIBAL_BUCKETS, TRIBAL_DEFAULT_COLOR, NERC_BUCKETS, NATGAS_PIPE_TYPE_BUCKETS, RETAIL_TYPE_BUCKETS, HIFLD_UNDERGROUND_EXPR, HIFLD_DC_EXPR } from '../../src/colors/buckets.js';
import {
  planTransmissionLines, planSubstationPoints, planPolygon,
  pmtilesUrl, initialVisibility,
} from './layer-init.js';
import type { LayerPlan } from './layer-plan.js';

export function planHifldTransmission(): LayerPlan {
  return planTransmissionLines({
    sources: [{ id: "hifld-transmission-lines", url: DATA.hifld_transmission_lines }],
    sourceLayer: "hifld_transmission_lines",
    registryId: "hifld-transmission-lines", prefix: "hifld-transmission-lines",
    kvExpr: ["to-number", ["get", "VOLTAGE"], -1],
    color: voltageColorExpr("VOLTAGE", "#a39dbe"),
    opacity: { hv: 0.85, hvLow: 0.55, mv: 0.5, unknown: 0.45, lv: 0.5 },
    undergroundExpr: HIFLD_UNDERGROUND_EXPR,
    dcExpr: HIFLD_DC_EXPR,
  });
}

export function planHifldSubstationPoints(): LayerPlan {
  return planSubstationPoints({
    sourceId: "hifld-substations",
    kvField:  "max_kv",
    layerIds: { hv: "hifld-substations-hv", lv: "hifld-substations-lv", label: "hifld-substations-label" },
  });
}

export function planTribalLands(): LayerPlan {
  return planPolygon({
    sourceId: "tribal-lands", source: { type: "geojson", data: EMPTY_FC },
    prefix: "tribal",
    color: bucketColorExpr("area_type", TRIBAL_BUCKETS, TRIBAL_DEFAULT_COLOR),
    fillMinzoom: 3, fillOpacity: 0.30,
    outlineMinzoom: 5, outlineWidth: 0.8, outlineOpacity: 0.6,
  });
}

export function planBiaTribalLands(): LayerPlan {
  return planPolygon({
    sourceId: "bia-tribal-lands", source: { type: "geojson", data: EMPTY_FC },
    prefix: "bia-tribal",
    color: "#8b5cf6",
    fillMinzoom: 3, fillOpacity: 0.30,
    outlineMinzoom: 5, outlineWidth: 0.8, outlineOpacity: 0.6,
  });
}

export function planHifldNatgasLines(): LayerPlan {
  const NATGAS_LINE_COLOR = bucketColorExpr("pipe_type", NATGAS_PIPE_TYPE_BUCKETS, "#f97316");
  const lineWidth = ["interpolate", ["linear"], ["zoom"],
    3, 0.8, 6, 1.5, 9, 2.2, 12, 3.5];
  const dashArray = [4, 3];

  const visI = initialVisibility("hifld-natgas-lines");
  const sublayers = [
    { id: "hifld-natgas-interstate", pipeType: "Interstate", minzoom: 0, opacity: 0.85 },
    { id: "hifld-natgas-intrastate", pipeType: "Intrastate", minzoom: 0, opacity: 0.80 },
    { id: "hifld-natgas-hgl",        pipeType: "HGL",        minzoom: 0, opacity: 0.80 },
    { id: "hifld-natgas-gathering",  pipeType: "Gathering",  minzoom: 0, opacity: 0.75 },
  ];
  return [
    { source: "hifld-natgas-lines", spec: { type: "vector", url: pmtilesUrl(DATA.hifld_natgas_lines) } },
    ...sublayers.map(({ id, pipeType, minzoom, opacity }) => ({ layer: {
      id,
      type: "line", source: "hifld-natgas-lines",
      "source-layer": "hifld_natgas_lines", minzoom,
      filter: ["==", ["get", "pipe_type"], pipeType],
      layout: { visibility: visI, "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": NATGAS_LINE_COLOR, "line-width": lineWidth,
               "line-dasharray": dashArray, "line-opacity": opacity },
    } as unknown as LayerSpecification })),
  ];
}

export function planHifldNatgasPts(): LayerPlan {
  const vis = initialVisibility("hifld-natgas-points");

  const FAC_ICON = [
    "match", ["get", "fac_type"],
    "lng_terminal",  "natgas-lng_terminal",
    "underground",   "natgas-underground",
    "spr",           "natgas-spr",
    "trading_hub",   "natgas-trading_hub",
    "processing",    "natgas-processing",
    "border_cross",  "natgas-border_cross",
    "peak_shaving",  "natgas-peak_shaving",
    "lng_storage",   "natgas-lng_storage",
    "pol_terminal",  "natgas-pol_terminal",
    "natgas-other"
  ];

  const FAC_SIZE = ["interpolate", ["linear"], ["zoom"],
    3,  ["match", ["get", "fac_type"], ["lng_terminal", "spr"], 1.2, ["trading_hub", "underground"], 0.9, 0.0],
    5,  ["match", ["get", "fac_type"], ["lng_terminal", "spr"], 1.4, ["trading_hub", "underground", "border_cross"], 1.0, 0.7],
    7,  ["match", ["get", "fac_type"], ["lng_terminal", "spr"], 1.6, ["trading_hub", "underground", "border_cross"], 1.2, 0.9],
    12, ["match", ["get", "fac_type"], ["lng_terminal", "spr"], 2.0, 1.4],
  ];

  const SORT_KEY = ["match", ["get", "fac_type"],
    "lng_terminal", 1, "spr", 2, "trading_hub", 3,
    "underground", 4, "border_cross", 5, "processing", 6,
    "peak_shaving", 7, "lng_storage", 8, "pol_terminal", 9, 10];

  const PETRO_TYPES = ["pol_terminal", "spr"];
  // gas facilities = everything except the petroleum fac_types
  const GAS_BASE   = ["match", ["get", "fac_type"], PETRO_TYPES, false, true] as unknown as ExpressionSpecification;
  const PETRO_BASE = ["match", ["get", "fac_type"], PETRO_TYPES, true, false] as unknown as ExpressionSpecification;

  return [{ source: "hifld-natgas-points", spec: { type: "geojson", data: EMPTY_FC } },
  // Gas facilities (processing, storage, LNG, hubs, border, peak shaving)
  { layer: {
    id: "hifld-natgas-points",
    type: "symbol",
    source: "hifld-natgas-points",
    minzoom: 3,
    filter: GAS_BASE,
    layout: {
      visibility:             vis,
      "icon-image":           FAC_ICON,
      "icon-size":            FAC_SIZE,
      "icon-allow-overlap":   true,
      "icon-ignore-placement": true,
      "symbol-sort-key":      SORT_KEY,
    },
    paint: {},
  } as unknown as LayerSpecification },
  // Petroleum facilities (POL terminals + Strategic Petroleum Reserve) — same source
  { layer: {
    id: "hifld-petroleum-facilities",
    type: "symbol",
    source: "hifld-natgas-points",
    minzoom: 3,
    filter: PETRO_BASE,
    layout: {
      visibility:             initialVisibility("hifld-petroleum-facilities"),
      "icon-image":           FAC_ICON,
      "icon-size":            FAC_SIZE,
      "icon-allow-overlap":   true,
      "icon-ignore-placement": true,
      "symbol-sort-key":      SORT_KEY,
    },
    paint: {},
  } as unknown as LayerSpecification }];
}

export function planNercRegions(): LayerPlan {
  return planPolygon({
    sourceId: "nerc-regions", source: { type: "geojson", data: EMPTY_FC },
    prefix: "nerc",
    color: bucketColorExpr("code", NERC_BUCKETS, "#94a3b8"),
    fillMinzoom: 2, fillOpacity: 0.12,
    outlineMinzoom: 2,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 2, 1.0, 5, 1.8, 8, 2.5],
    outlineOpacity: 0.80,
  });
}

export function planControlAreas(): LayerPlan {
  const BA_COLOR = ["match", ["to-number", ["get", "color_idx"], 0],
    0, "#3b82f6",
    1, "#06b6d4",
    2, "#8b5cf6",
    3, "#10b981",
    4, "#f59e0b",
    "#f43f5e"
  ] as unknown as ExpressionSpecification;

  return [...planPolygon({
    sourceId: "control-areas", source: { type: "geojson", data: EMPTY_FC },
    prefix: "ba", color: BA_COLOR,
    fillMinzoom: 2, fillOpacity: 0.10,
    outlineMinzoom: 2,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 2, 0.8, 5, 1.3, 8, 2.0],
    outlineOpacity: ["case", ["boolean", ["feature-state", "hover"], false], 0.90, 0.70],
  }), { layer: {
    id: "ba-label", type: "symbol", source: "control-areas",
    minzoom: 4, layout: {
      visibility: initialVisibility("control-areas"),
      "text-field": ["get", "name"],
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
  } as unknown as LayerSpecification }];
}

export function planOGFPlannedTransmission(): LayerPlan {
  const OGF_LINE_WIDTH = ["interpolate", ["linear"], ["zoom"], 3, 2, 7, 3.5, 12, 6];
  const vis = initialVisibility("ogf-planned-transmission");

  return [{ source: "ogf-planned-transmission", spec: { type: "geojson", data: EMPTY_FC } }, { layer: {
    id: "ogf-planned-lines-casing",
    type: "line", source: "ogf-planned-transmission", minzoom: 3,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 4.5, 7, 6.5, 12, 10],
      "line-opacity": 0.75,
    },
  } as unknown as LayerSpecification }, { layer: {
    id: "ogf-planned-lines",
    type: "line", source: "ogf-planned-transmission", minzoom: 3,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ogfColorExpr(state.ogfColorBy),
      "line-width": OGF_LINE_WIDTH,
      "line-dasharray": OGF_DASH_EXPR,
      "line-opacity": 0.95,
    },
  } as unknown as LayerSpecification }];
}

export function planRetailTerritories(): LayerPlan {
  const RETAIL_COLOR = bucketColorExpr("type", RETAIL_TYPE_BUCKETS, "#94a3b8");
  return planPolygon({
    sourceId: "retail-territories",
    source: { type: "vector", url: pmtilesUrl(DATA.retail_territories) },
    sourceLayer: "retail_territories", prefix: "retail", color: RETAIL_COLOR,
    fillMinzoom: 2, fillOpacity: 0.15,
    outlineMinzoom: 3,
    outlineWidth: ["interpolate", ["linear"], ["zoom"], 3, 0.4, 6, 0.7, 10, 1.0],
    outlineOpacity: 0.55,
  });
}
