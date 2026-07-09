// ─── OSM-derived layers (transmission, substations, plants, generators, pipelines)
// Imported by: layer-init.ts

import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import { state, DATA, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { voltageColorExpr } from '../../src/colors/voltage.js';
import { OSM_GEN_ICON, OSM_GEN_COLOR, genIconSize } from '../../src/colors/fuel.js';
import { PIPELINE_LINE_COLOR, OSM_UNDERGROUND_EXPR } from '../../src/colors/buckets.js';
import { HEAT_MW_STOPS, OSM_MW_FLOOR, HEAT_DENSITY_COLOR } from '../../src/colors/ramps.js';
import {
  addTransmissionLines, addSubstationPoints, addPolygonLayer,
  pmtilesUrl, initialVisibility, registerBaseFilter,
  genPlantTextLayout, GEN_PLANT_TEXT_PAINT,
} from './layer-init.js';
import { PIPELINE_TYPE_MAP } from '../filters.js';

export function addOsmTransmission() {
  addTransmissionLines({
    sourceId: "osm-transmission-lines", url: DATA.osm_transmission_lines, sourceLayer: "osm_transmission_lines",
    registryId: "osm-transmission-lines", prefix: "osm-transmission-lines",
    kvExpr: ["coalesce", ["get", "nominal_kv"], -1],
    color: voltageColorExpr("nominal_kv", "#c4b5fd"),
    opacity: { hv: 0.9, mv: 0.9, unknown: 0.6, lv: 0.75 },
    nameField: "name",
    undergroundExpr: OSM_UNDERGROUND_EXPR,
  });
}

export function addOsmSubstationPoints() {
  addSubstationPoints({
    sourceId: "osm-substations-points",
    kvField:  "nominal_kv",
    layerIds: { hv: "osm-substations-points-hv", lv: "osm-substations-points-lv", label: "osm-substations-label" },
  });
}

export function addOsmSubstationPolygons() {
  addPolygonLayer({
    sourceId: "osm-substations-polygons", source: { type: "geojson", data: EMPTY_FC },
    prefix: "osm-substations-polygons", color: voltageColorExpr("nominal_kv", "#a78bfa"),
    fillMinzoom: 9, fillOpacity: 0.30,
    outlineMinzoom: 9, outlineWidth: 1.5, outlineOpacity: 0.7,
  });
}

export function addOsmPlantPolygons() {
  addPolygonLayer({
    sourceId: "osm-plants-polygons", source: { type: "geojson", data: EMPTY_FC },
    prefix: "osm-plants-polygons", color: OSM_GEN_COLOR,
    fillMinzoom: 5, fillOpacity: 0.20,
    outlineMinzoom: 5, outlineWidth: 1.5, outlineOpacity: 0.7,
  });
}

export function addOsmPlants() {
  if (!state.map || state.map.getSource("osm-plants-points")) return;

  state.map.addSource("osm-plants-points", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["osm-plants-points"] });

  const vis      = initialVisibility("osm-plants-points");
  const mwExpr   = ["coalesce", ["to-number", ["get", "output_mw"]], 0] as unknown as ExpressionSpecification;
  const plantName = ["coalesce", ["get", "name"], ""] as unknown as ExpressionSpecification;

  state.map.addLayer({
    id: "osm-plant-icons",
    type: "symbol",
    source: "osm-plants-points",
    minzoom: 3,
    layout: {
      visibility:           vis,
      "symbol-sort-key":    ["-", 100000, mwExpr],
      "icon-image":         OSM_GEN_ICON,
      "icon-size":          genIconSize("output_mw"),
      "icon-allow-overlap": true,
      ...genPlantTextLayout(plantName, mwExpr),
    },
    paint: { ...GEN_PLANT_TEXT_PAINT },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-plant-icons", null);

  state.map.addLayer({
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
  } as unknown as LayerSpecification, "osm-plant-icons");
  registerBaseFilter("osm-plant-heat", null);
}

export function addOsmGenerators() {
  if (!state.map || state.map.getSource("osm-generators")) return;

  state.map.addSource("osm-generators", {
    type: "vector",
    url: pmtilesUrl(DATA.osm_generators),
    attribution: SOURCE_ATTRIB["osm-generators"],
  });

  const vis      = initialVisibility("osm-generators");
  const osmGenMw = ["coalesce", ["to-number", ["get", "output_mw"]], 0];

  const osmGenName = ["match",
    ["coalesce", ["get", "name"], ""],
    ["", "nan", "NaN", "None"], "",
    ["coalesce", ["get", "name"], ""]
  ];

  state.map.addLayer({
    id: "osm-gen-circles",
    type: "symbol",
    source: "osm-generators",
    "source-layer": "osm_generators",
    minzoom: 5,
    layout: {
      visibility:           vis,
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
      "text-font":            ["Open Sans Regular", "Arial Unicode MS Regular"],
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
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-gen-circles", null);
}

export function addPipelineLines() {
  if (!state.map || state.map.getSource("osm-pipelines-lines")) return;

  state.map.addSource("osm-pipelines-lines", {
    type: "vector",
    url: pmtilesUrl(DATA.osm_pipelines_lines),
    attribution: SOURCE_ATTRIB["osm-pipelines-lines"],
  });

  const vis = initialVisibility("osm-pipelines-lines");

  state.map.addLayer({
    id: "osm-pipelines-lines",
    type: "line",
    source: "osm-pipelines-lines",
    "source-layer": "osm_pipelines_lines",
    minzoom: 3,
    layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": PIPELINE_LINE_COLOR,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 5, 1.5, 9, 2.5, 12, 4],
      "line-dasharray": [3, 2],
      "line-opacity": 0.9,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-pipelines-lines", null);
}

export function addPipelinePoints() {
  if (!state.map || state.map.getSource("osm-pipelines-points")) return;

  state.map.addSource("osm-pipelines-points", { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB["osm-pipelines-points"] });

  const vis = initialVisibility("osm-pipelines-points");
  const noValve = ["!=", ["get", "pipeline"], "valve"] as unknown as FilterSpecification;

  const matchArgs: string[] = [];
  for (const [bucketId, values] of Object.entries(PIPELINE_TYPE_MAP)) {
    for (const v of values) matchArgs.push(v, `pipeline-${bucketId}`);
  }
  const iconExpr = ["match", ["get", "pipeline"], ...matchArgs, "pipeline-other"];

  state.map.addLayer({
    id: "osm-pipelines-points",
    type: "symbol",
    source: "osm-pipelines-points",
    minzoom: 3,
    filter: noValve,
    layout: {
      visibility: vis,
      "icon-image": iconExpr,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 8, 1.0, 12, 1.4],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  } as unknown as LayerSpecification);
  registerBaseFilter("osm-pipelines-points", noValve);
}
