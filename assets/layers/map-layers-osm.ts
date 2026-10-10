// ─── OSM-derived layers (transmission, substations, plants, generators, pipelines)
// Each plan* returns a LayerPlan (layer-plan.ts); add-all-layers.ts applies it.
// Sources come from each registry layer's `data` (layer-source.ts); visibility
// is stamped by applyLayerPlan().
// Imported by: add-all-layers.ts

import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import { voltageColorExpr } from '../../src/colors/voltage.js';
import { OSM_GEN_ICON, OSM_GEN_COLOR, genIconSize } from '../../src/colors/fuel.js';
import { PIPELINE_LINE_COLOR, PIPELINE_TYPE_BUCKETS, OSM_UNDERGROUND_EXPR, OSM_DC_EXPR } from '../../src/colors/buckets.js';
import { HEAT_MW_STOPS, OSM_MW_FLOOR, HEAT_DENSITY_COLOR } from '../../src/colors/ramps.js';
import {
  planTransmissionLines, planSubstationPoints, planPolygon,
  genPlantTextLayout, GEN_PLANT_TEXT_PAINT,
} from './layer-init.js';
import { layerSource } from './layer-source.js';
import type { LayerPlan } from './layer-plan.js';
import { OSM_TL_BANDS } from '../../src/registry/transmission.js';

export function planOsmTransmission(): LayerPlan {
  return planTransmissionLines({
    // One source per voltage-class archive, ascending — OSM_TL_BANDS is the
    // single definition of the split and also derives the layer ids the registry
    // lists. Ascending order is paint order: EHV is added last and draws on top.
    sources: OSM_TL_BANDS.map(b => ({
      id:     `osm-transmission-lines${b.suffix}`,
      key:    b.dataKey,
      suffix: b.suffix,
      kv:     b.kv,
    })),
    sourceLayer: "osm_transmission_lines",
    registryId: "osm-transmission-lines", prefix: "osm-transmission-lines",
    kvExpr: ["coalesce", ["get", "nominal_kv"], -1],
    color: voltageColorExpr("nominal_kv", "#a39dbe"),
    opacity: { hv: 0.9, hvLow: 0.55, mv: 0.5, unknown: 0.45, lv: 0.5 },
    nameField: "name",
    undergroundExpr: OSM_UNDERGROUND_EXPR,
    dcExpr: OSM_DC_EXPR,
  });
}

export function planOsmSubstationPoints(): LayerPlan {
  return planSubstationPoints({
    sourceId: "osm-substations-points",
    sourceLayer: "osm_substations_points",
    kvField:  "nominal_kv",
    layerIds: { hv: "osm-substations-points-hv", lv: "osm-substations-points-lv", label: "osm-substations-label" },
  });
}

export function planOsmSubstationPolygons(): LayerPlan {
  return planPolygon({
    sourceId: "osm-substations-polygons",
    sourceLayer: "osm_substations_polygons",
    prefix: "osm-substations-polygons", color: voltageColorExpr("nominal_kv", "#a78bfa"),
    fillMinzoom: 9, fillOpacity: 0.30,
    outlineMinzoom: 9, outlineWidth: 1.5, outlineOpacity: 0.7,
  });
}

export function planOsmPlantPolygons(): LayerPlan {
  return planPolygon({
    sourceId: "osm-plants-polygons",
    sourceLayer: "osm_plants_polygons",
    prefix: "osm-plants-polygons", color: OSM_GEN_COLOR,
    fillMinzoom: 5, fillOpacity: 0.20,
    outlineMinzoom: 5, outlineWidth: 1.5, outlineOpacity: 0.7,
  });
}

export function planOsmPlants(): LayerPlan {
  const mwExpr   = ["coalesce", ["to-number", ["get", "output_mw"]], 0] as unknown as ExpressionSpecification;
  const plantName = ["coalesce", ["get", "name"], ""] as unknown as ExpressionSpecification;

  return [layerSource("osm-plants-points"), { layer: {
    id: "osm-plant-icons",
    type: "symbol",
    source: "osm-plants-points",
    minzoom: 3,
    layout: {
      "symbol-sort-key":    ["-", 100000, mwExpr],
      "icon-image":         OSM_GEN_ICON,
      "icon-size":          genIconSize("output_mw"),
      "icon-allow-overlap": true,
      ...genPlantTextLayout(plantName, mwExpr),
    },
    paint: { ...GEN_PLANT_TEXT_PAINT },
  } as unknown as LayerSpecification }, { layer: {
    id: "osm-plant-heat", type: "heatmap", source: "osm-plants-points",
    maxzoom: 9,
    layout: { visibility: "none" },
    paint: {
      "heatmap-weight": ["interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", "output_mw"]], OSM_MW_FLOOR], ...HEAT_MW_STOPS.flat()],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 9, 2.5],
      "heatmap-radius":    ["interpolate", ["linear"], ["zoom"], 3, 12, 9, 40],
      "heatmap-color":     HEAT_DENSITY_COLOR,
      "heatmap-opacity":   ["interpolate", ["linear"], ["zoom"], 7, 0.9, 9, 0],
    },
  } as unknown as LayerSpecification, beforeId: "osm-plant-icons" }];
}

export function planOsmGenerators(): LayerPlan {
  const osmGenMw = ["coalesce", ["to-number", ["get", "output_mw"]], 0];

  const osmGenName = ["match",
    ["coalesce", ["get", "name"], ""],
    ["", "nan", "NaN", "None"], "",
    ["coalesce", ["get", "name"], ""]
  ];

  return [layerSource("osm-generators"), { layer: {
    id: "osm-gen-circles",
    type: "symbol",
    source: "osm-generators",
    "source-layer": "osm_generators",
    minzoom: 5,
    layout: {
      "symbol-sort-key":    ["-", 100000, osmGenMw],
      "icon-image":         OSM_GEN_ICON,
      "icon-size":          ["interpolate", ["linear"], ["zoom"], 7, 0.45, 10, 0.70, 13, 1.00, 15, 1.30],
      "icon-allow-overlap": true,
      "text-field": ["step", ["zoom"],
        "",
        9, ["case",
          [">", osmGenMw, 0],
          ["concat", ["to-string", ["round", osmGenMw]], " MW"],
          ""
        ],
        12, ["case",
          ["all", [">", osmGenMw, 0], ["!=", osmGenName, ""]],
          ["concat", osmGenName, "\n", ["to-string", ["round", osmGenMw]], " MW"],
          ["case",
            [">", osmGenMw, 0],
            ["concat", ["to-string", ["round", osmGenMw]], " MW"],
            osmGenName
          ]
        ]
      ],
      "text-font":            ["Noto Sans Regular"],
      "text-variable-anchor": ["top", "bottom", "left", "right"],
      "text-radial-offset":   0.8,
      "text-size":            ["interpolate", ["linear"], ["zoom"], 9, 8, 12, 10, 16, 12],
      "text-max-width":       8,
      "text-optional":        true,
    },
    paint: {
      "text-color":      "#1a1a2e",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  } as unknown as LayerSpecification }];
}

export function planPipelineLines(): LayerPlan {

  return [layerSource("osm-pipelines-lines"), { layer: {
    id: "osm-pipelines-lines",
    type: "line",
    source: "osm-pipelines-lines",
    "source-layer": "osm_pipelines_lines",
    minzoom: 0,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": PIPELINE_LINE_COLOR,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 5, 1.5, 9, 2.5, 12, 4],
      "line-dasharray": [3, 2],
      "line-opacity": 0.9,
    },
  } as unknown as LayerSpecification }];
}

export function planPipelinePoints(): LayerPlan {
  const noValve = ["!=", ["get", "pipeline"], "valve"] as unknown as FilterSpecification;

  const matchArgs: string[] = [];
  for (const b of PIPELINE_TYPE_BUCKETS) {
    for (const v of b.values ?? []) matchArgs.push(v, `pipeline-${b.id}`);
  }
  const iconExpr = ["match", ["get", "pipeline"], ...matchArgs, "pipeline-other"];

  return [layerSource("osm-pipelines-points"), { layer: {
    id: "osm-pipelines-points",
    type: "symbol",
    source: "osm-pipelines-points",
    minzoom: 3,
    filter: noValve,
    layout: {
      "icon-image": iconExpr,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 8, 1.0, 12, 1.4],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  } as unknown as LayerSpecification }];
}
