// ─── Layer initialisation: lazy GeoJSON loading + shared add* helpers ─────────
// Imported by: add-all-layers.ts (addAllLayers, addPadus, addCritHab, ensureLayerData),
//              visibility.ts (ensureLayerData),
//              map-layers-*.ts (addTransmissionLines, addPolygonLayer,
//              addSubstationPoints, pmtilesUrl, initialVisibility, registerBaseFilter)
// >>> ADD-LAYER: lazy-geojson — see docs/adding-a-layer.md §7

import type { ExpressionSpecification, GeoJSONSource, FilterSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { state, DATA, EMPTY_FC, SOURCE_ATTRIB } from '../state.js';
import { voltageColorExpr } from '../../src/colors/voltage.js';
import {
  subRadius, bucketColorExpr, LINE_WIDTH,
  PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT, CRITHAB_BUCKETS,
} from '../../src/colors/buckets.js';
import { registerBaseFilter } from '../filters.js';

// Re-export so map-layers-*.ts can import from one place
export { registerBaseFilter };

// Maps registry ID → real data URL for GeoJSON-backed layers.
// >>> ADD-LAYER: lazy-geojson
const LAZY_GEOJSON: Record<string, string> = {
  "ogf-planned-transmission":   DATA.ogf_planned_transmission,
  "osm-substations-points":     DATA.osm_substations_points,
  "osm-substations-polygons":   DATA.osm_substations_polygons,
  "hifld-substations":          DATA.hifld_substations,
  "osm-plants-points":          DATA.osm_plants_points,
  "osm-plants-polygons":        DATA.osm_plants_polygons,
  "eia-generators":             DATA.eia_generators,
  "osm-pipelines-points":       DATA.osm_pipelines_points,
  "hifld-natgas-points":        DATA.hifld_natgas_points,
  "eia-crude-pipelines":        DATA.eia_crude_pipelines,
  "eia-product-pipelines":      DATA.eia_product_pipelines,
  "nrel-hydrothermal-points":   DATA.nrel_hydrothermal_points,
  "osm-datacenters":            DATA.osm_datacenters,
  "mines":                      DATA.mines,
  "wecc-paths":                 DATA.wecc_paths,
  "wecc-path-lines":            DATA.wecc_path_lines,
  "nerc-regions":               DATA.nerc_regions,
  "control-areas":              DATA.control_areas,
  "tribal-lands":               DATA.tribal_lands,
  "bia-tribal-lands":           DATA.bia_tribal_lands,
  "wildfire-live":              DATA.wildfire_live,
  "nws-alerts":                 DATA.nws_alerts,
};

// Registry IDs that share a source with another registry ID.
// Enabling one of these triggers ensureLayerData on the owning source instead.
const LAYER_SOURCE_ALIAS: Record<string, string> = {
  "wildfire-smoke":     "wildfire-live",
  "wildfire-incidents": "wildfire-live",
  // petroleum facilities share the HIFLD points source (split by fac_type base filter)
  "hifld-petroleum-facilities": "hifld-natgas-points",
};

const _inflight: Partial<Record<string, Promise<void>>> = {};

export function ensureLayerData(registryId: string): Promise<void> {
  const alias = LAYER_SOURCE_ALIAS[registryId];
  if (alias) return ensureLayerData(alias);
  const url = LAZY_GEOJSON[registryId];
  if (!url || state.sourcesLoaded[registryId]) return Promise.resolve();
  const existing = _inflight[registryId];
  if (existing) return existing;
  _inflight[registryId] = (async () => {
    try {
      const geojson = await fetchGeojson(url);
      state.sourcesLoaded[registryId] = true;
      state.sourcesData[registryId] = geojson.features || [];
      (state.map!.getSource(registryId) as GeoJSONSource).setData(geojson);
      window.dispatchEvent(new CustomEvent('tm:layerdata', { detail: { registryId } }));
    } catch (err) {
      console.warn('[TransmissionMap] ensureLayerData failed for', registryId, err);
    } finally {
      delete _inflight[registryId];
    }
  })();
  return _inflight[registryId];
}

async function fetchGeojson(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
  if (url.endsWith(".gz")) {
    const stream = resp.body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }
  return resp.json();
}

export function pmtilesUrl(path: string): string {
  return "pmtiles://" + new URL(path, location.href).href;
}

export function initialVisibility(registryId: string): "visible" | "none" {
  return state.layerVisibility[registryId] ? "visible" : "none";
}

// ─── Shared county-boundary source (data-join infra) ──────────────────────────
// Census TIGER county polygons, added ONCE and reused by every county-keyed data
// layer (ODIN outages today; risk indices etc. later). Those layers ship no
// geometry — only FIPS→value — and paint via MapLibre feature-state.
// `promoteId` makes each feature's id its GEOID, which is what setFeatureState
// addresses. GEOID is a zero-padded 5-digit string ("08123") — never parseInt it.
// Consumers MUST namespace their feature-state keys (e.g. `odin_out`), since all
// of them share one per-feature state bag on these same features.
export const COUNTY_SRC = "county_boundaries";
export const COUNTY_SRC_LAYER = "county_boundaries";   // tippecanoe names the layer after the manifest id

export function ensureCountyBoundaries() {
  if (!state.map || state.map.getSource(COUNTY_SRC)) return;
  state.map.addSource(COUNTY_SRC, {
    type: "vector",
    url: pmtilesUrl(DATA.county_boundaries),
    promoteId: { [COUNTY_SRC_LAYER]: "GEOID" },
    // MapLibre attributes SOURCES, not layers, and only while a layer using the
    // source is visible — so this string must credit the geometry (Census) AND
    // whatever data is painted on it. ODIN is the sole consumer today. When a
    // second county-keyed layer lands, this over-credits ODIN whenever that
    // other layer is on alone: move each layer's credit out to the credits panel
    // (registry `creditId`) and leave only Census here.
    attribution:
      '<a href="https://www.census.gov/programs-surveys/geography/guidance/geo-areas.html">US Census TIGER</a>' +
      ' | <a href="https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/">ORNL ODIN</a>',
  });
}

export function genPlantTextLayout(nameExpr: ExpressionSpecification, mwExpr: ExpressionSpecification) {
  return {
    "text-field": ["step", ["zoom"],
      "",
      6, nameExpr,
      8, ["case",
        [">", mwExpr, 0],
        ["concat", nameExpr, "\n", ["to-string", ["round", mwExpr]], " MW"],
        nameExpr,
      ],
    ],
    "text-font":            ["Open Sans Regular", "Arial Unicode MS Regular"],
    "text-variable-anchor": ["top", "bottom"],
    "text-radial-offset":   1.0,
    "text-size":            ["interpolate", ["linear"], ["zoom"], 6, 10, 12, 13],
    "text-max-width":       8,
    "text-optional":        true,
  };
}

export const GEN_PLANT_TEXT_PAINT = {
  "text-color":      "#1a1a2e",
  "text-halo-color": "#ffffff",
  "text-halo-width": 1.5,
};

// ─── Polygon fill + outline helper ────────────────────────────────────────────
export function addPolygonLayer({ sourceId, source, sourceLayer = undefined as (string | undefined), prefix, color,
                          fillMinzoom, fillOpacity,
                          outlineMinzoom, outlineWidth, outlineOpacity }: {
  sourceId: string; source: SourceSpecification; sourceLayer?: string; prefix: string; color: ExpressionSpecification | string;
  fillMinzoom: number; fillOpacity: number | ExpressionSpecification;
  outlineMinzoom: number; outlineWidth: number | ExpressionSpecification; outlineOpacity: number | ExpressionSpecification;
}) {
  if (!state.map || state.map.getSource(sourceId)) return;
  state.map.addSource(sourceId, { ...source, attribution: SOURCE_ATTRIB[sourceId] } as SourceSpecification);
  const vis = initialVisibility(sourceId);
  const common: Partial<LayerSpecification> = { source: sourceId, layout: { visibility: vis } };
  if (sourceLayer) (common as Record<string, unknown>)["source-layer"] = sourceLayer;

  state.map.addLayer({
    ...common, id: `${prefix}-fill`, type: "fill", minzoom: fillMinzoom,
    paint: { "fill-color": color, "fill-opacity": fillOpacity },
  } as LayerSpecification);
  registerBaseFilter(`${prefix}-fill`, null);

  state.map.addLayer({
    ...common, id: `${prefix}-outline`, type: "line", minzoom: outlineMinzoom,
    paint: { "line-color": color, "line-width": outlineWidth, "line-opacity": outlineOpacity },
  } as LayerSpecification);
  registerBaseFilter(`${prefix}-outline`, null);
}

// ─── Transmission lines helper ────────────────────────────────────────────────
export function addTransmissionLines({ sourceId, url, sourceLayer, registryId, prefix,
                               kvExpr, color, opacity, nameField = undefined as (string | undefined), undergroundExpr = undefined as (ExpressionSpecification | undefined) }: {
  sourceId: string; url: string; sourceLayer: string; registryId: string; prefix: string;
  kvExpr: ExpressionSpecification; color: string | ExpressionSpecification; opacity: Record<string, number>; nameField?: string; undergroundExpr?: ExpressionSpecification;
}) {
  if (!state.map || state.map.getSource(sourceId)) return;
  state.map.addSource(sourceId, { type: "vector", url: pmtilesUrl(url), attribution: SOURCE_ATTRIB[sourceId] });
  const vis = initialVisibility(registryId);

  const tiers = [
    { id: "hv",      minzoom: 0, filter: [">=", kvExpr, 100] as FilterSpecification },
    { id: "mv",      minzoom: 5, filter: ["all", [">=", kvExpr, 50], ["<", kvExpr, 100]] as FilterSpecification },
    { id: "unknown", minzoom: 5, filter: ["<=", kvExpr, 0] as FilterSpecification },
    { id: "lv",      minzoom: 9, filter: ["all", [">", kvExpr, 0], ["<", kvExpr, 50]] as FilterSpecification },
  ];
  for (const t of tiers) {
    const id = `${prefix}-${t.id}`;
    const paint: Record<string, unknown> = { "line-color": color, "line-width": LINE_WIDTH, "line-opacity": opacity[t.id] };
    if (undergroundExpr) {
      paint["line-dasharray"] = ["case", undergroundExpr, ["literal", [3, 3]], ["literal", [1, 0]]] as unknown as ExpressionSpecification;
    }
    state.map.addLayer({
      id, type: "line", source: sourceId, "source-layer": sourceLayer,
      minzoom: t.minzoom, filter: t.filter,
      layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
      paint: paint as unknown as Record<string, unknown>,
    } as LayerSpecification);
    registerBaseFilter(id, t.filter);
  }

  if (!nameField) return;
  const name    = ["coalesce", ["get", nameField], ""] as unknown as ExpressionSpecification;
  const hasName = ["!=", name, ""] as FilterSpecification;
  const labelId = `${prefix}-label`;
  state.map.addLayer({
    id: labelId, type: "symbol", source: sourceId, "source-layer": sourceLayer,
    minzoom: 9, filter: hasName,
    layout: {
      visibility: vis,
      "symbol-placement":        "line",
      "text-field":              name,
      "text-font":               ["Open Sans Regular", "Arial Unicode MS Regular"],
      "text-size":               ["interpolate", ["linear"], ["zoom"], 9, 9, 12, 11, 15, 13] as unknown as ExpressionSpecification,
      "symbol-spacing":          400,
      "text-max-angle":          30,
      "text-keep-upright":       true,
      "text-rotation-alignment": "map",
      "text-pitch-alignment":    "viewport",
      "text-optional":           true,
      "text-allow-overlap":      false,
    },
    paint: {
      "text-color":      color,
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": 2,
      "text-halo-blur":  0.5,
    },
  } as LayerSpecification);
  registerBaseFilter(labelId, hasName);
}

// ─── Substation points helper ─────────────────────────────────────────────────
export function addSubstationPoints({ sourceId, kvField, layerIds }: {
  sourceId: string; kvField: string; layerIds: { hv: string; lv: string; label: string };
}) {
  if (!state.map || state.map.getSource(sourceId)) return;
  state.map.addSource(sourceId, { type: "geojson", data: EMPTY_FC, attribution: SOURCE_ATTRIB[sourceId] });

  const vis = initialVisibility(sourceId);
  const paint = {
    "circle-color": voltageColorExpr(kvField, "#a78bfa"),
    "circle-radius": subRadius(kvField),
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.2,
    "circle-stroke-opacity": 0.8,
  };
  const kvNum = ["to-number", ["get", kvField], -1];

  state.map.addLayer({
    id: layerIds.hv, type: "circle", source: sourceId,
    minzoom: 0, filter: [">=", kvNum, 200] as unknown as FilterSpecification,
    layout: { visibility: vis }, paint,
  } as LayerSpecification);
  registerBaseFilter(layerIds.hv, [">=", kvNum, 200] as unknown as FilterSpecification);

  state.map.addLayer({
    id: layerIds.lv, type: "circle", source: sourceId,
    minzoom: 7, filter: ["<", kvNum, 200] as unknown as FilterSpecification,
    layout: { visibility: vis }, paint,
  } as LayerSpecification);
  registerBaseFilter(layerIds.lv, ["<", kvNum, 200] as unknown as FilterSpecification);

  const labelVisible = ["any",
    [">", kvNum, 399],
    ["all", [">", kvNum, 199], [">", ["zoom"], 6]],
    ["all", [">", kvNum,  99], [">", ["zoom"], 8]],
    ["all", [">", kvNum,  49], [">", ["zoom"], 10]],
    [">", ["zoom"], 11],
  ] as unknown as FilterSpecification;
  const subName = ["coalesce", ["get", "name"], ""] as unknown as ExpressionSpecification;
  state.map.addLayer({
    id: layerIds.label, type: "symbol", source: sourceId,
    minzoom: 6, filter: labelVisible,
    layout: {
      visibility: vis,
      "symbol-sort-key": ["-", 10000, kvNum] as unknown as ExpressionSpecification,
      "text-field": ["step", ["zoom"],
        subName,
        10, ["case",
          [">", kvNum, 0],
          ["concat", subName, "\n", ["to-string", ["round", kvNum]], " kV"],
          subName,
        ],
      ] as unknown as ExpressionSpecification,
      "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
      "text-variable-anchor": ["top", "bottom"],
      "text-radial-offset": 0.9,
      "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 12, 13, 16, 15] as unknown as ExpressionSpecification,
      "text-max-width": 8,
      "text-optional": true,
    },
    paint: {
      "text-color": "#1a1a2e",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
      "text-halo-blur": 0.5,
    },
  } as LayerSpecification);
  registerBaseFilter(layerIds.label, labelVisible);
}

// ─── PAD-US and CritHab ───────────────────────────────────────────────────────
export function addPadus() {
  addPolygonLayer({
    sourceId: "padus", source: { type: "vector", url: pmtilesUrl(DATA.padus) },
    sourceLayer: "padus", prefix: "padus",
    color: bucketColorExpr("desig", PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT),
    fillMinzoom: 3, fillOpacity: 0.28,
    outlineMinzoom: 6, outlineWidth: 0.6, outlineOpacity: 0.5,
  });
}


export function addCritHab() {
  addPolygonLayer({
    sourceId: "crithab", source: { type: "vector", url: pmtilesUrl(DATA.crithab) },
    sourceLayer: "crithab", prefix: "crithab",
    color: bucketColorExpr("listing_st", CRITHAB_BUCKETS, "#dc2626"),
    fillMinzoom: 3, fillOpacity: 0.30,
    outlineMinzoom: 5, outlineWidth: 0.7, outlineOpacity: 0.6,
  });
}

