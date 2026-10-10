// ─── Layer initialisation: shared plan helpers for the map-layers-*.ts builders ─
// Each plan* helper returns a LayerPlan (layer-plan.ts) and never touches the
// map; add-all-layers.ts hands the plans to applyLayerPlan().
// Sources come from the registry layer's `data` through layer-source.ts, and
// applyLayerPlan() stamps each style layer's starting visibility, so the
// helpers here only describe style layers.
// Imported by: nws-zone-join.ts (ensureCountyBoundaries),
//              map-layers-*.ts (planTransmissionLines, planPolygon, planRaster,
//              planSubstationPoints, countyBoundariesSource,
//              genPlantTextLayout, GEN_PLANT_TEXT_PAINT)
// Deps: state.ts, constants.ts (COUNTY_SRC*), layer-source.ts (layerSource,
//       pmtilesUrl), layer-plan.ts (applyLayerPlan, LayerPlan),
//       src/colors/voltage.ts, src/registry/transmission.ts (OSM_TL_TIERS),
//       src/types.ts (DataKey).
// The lazy GeoJSON loader (ensureLayerData, fetchGeojson) lives in layer-data.ts.

import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { COUNTY_SRC, COUNTY_SRC_LAYER } from '../constants.js';
import { layerSource, pmtilesUrl } from './layer-source.js';
import type { DataKey } from '../../src/types.js';
import { voltageColorExpr } from '../../src/colors/voltage.js';
import { applyLayerPlan, type LayerPlan, type PlanStep } from './layer-plan.js';
import { OSM_TL_TIERS } from '../../src/registry/transmission.js';

// ─── Shared county-boundary source (data-join infra) ──────────────────────────
// Census TIGER county polygons, added ONCE and reused by every county layer:
// the US Counties outlines and the county-keyed data layers (ODIN outages,
// FEMA NRI, NWS county alerts). The data layers ship no geometry — only
// FIPS→value — and paint via MapLibre feature-state.
// `promoteId` makes each feature's id its GEOID, which is what setFeatureState
// addresses. GEOID is a zero-padded 5-digit string ("08123") — never parseInt it.
// Consumers MUST namespace their feature-state keys (e.g. `odin_out`), since all
// of them share one per-feature state bag on these same features.
export const countyBoundariesSource = (): PlanStep => ({
  source: COUNTY_SRC,
  spec: {
    type: "vector",
    url: pmtilesUrl("county_boundaries"),
    promoteId: { [COUNTY_SRC_LAYER]: "GEOID" },
    // MapLibre attributes SOURCES, not layers, and only while a layer using the
    // source is visible — so this one string credits the geometry (Census) and
    // every dataset painted on it (ODIN outages, FEMA NRI), whichever of those
    // layers is on.
    attribution:
      '<a href="https://www.census.gov/programs-surveys/geography/guidance/geo-areas.html">US Census TIGER</a>' +
      ' | <a href="https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/">ORNL ODIN</a>' +
      ' | <a href="https://www.arcgis.com/home/item.html?id=39485e8035d446a5bff03259508ae355">FEMA NRI</a>',
  },
});

// For layers added after boot (nws-zone-join.ts).
export function ensureCountyBoundaries() {
  if (state.map) applyLayerPlan(state.map, [countyBoundariesSource()]);
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
    "text-font":            ["Noto Sans Regular"],
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

// ─── Raster helper ────────────────────────────────────────────────────────────
// A raster registry layer's source + its one layer, id == source id.
export function planRaster(id: string,
                           { opacity = 0.7, resampling = "linear" }: { opacity?: number; resampling?: "linear" | "nearest" } = {}): LayerPlan {
  return [
    layerSource(id),
    { layer: {
      id, type: "raster", source: id,
      paint: { "raster-opacity": opacity, "raster-resampling": resampling },
    } as LayerSpecification },
  ];
}

// ─── Polygon fill + outline helper ────────────────────────────────────────────

// A polygon registry layer's source (id == registry id) + fill and outline.
export function planPolygon({ sourceId, sourceLayer = undefined as (string | undefined), prefix, color,
                          fillMinzoom, fillOpacity,
                          outlineMinzoom, outlineWidth, outlineOpacity }: {
  sourceId: string; sourceLayer?: string; prefix: string; color: ExpressionSpecification | string;
  fillMinzoom: number; fillOpacity: number | ExpressionSpecification;
  outlineMinzoom: number; outlineWidth: number | ExpressionSpecification; outlineOpacity: number | ExpressionSpecification;
}): LayerPlan {
  const common: Partial<LayerSpecification> = { source: sourceId };
  if (sourceLayer) (common as Record<string, unknown>)["source-layer"] = sourceLayer;

  return [
    layerSource(sourceId),
    { layer: {
      ...common, id: `${prefix}-fill`, type: "fill", minzoom: fillMinzoom,
      paint: { "fill-color": color, "fill-opacity": fillOpacity },
    } as LayerSpecification },
    { layer: {
      ...common, id: `${prefix}-outline`, type: "line", minzoom: outlineMinzoom,
      paint: { "line-color": color, "line-width": outlineWidth, "line-opacity": outlineOpacity },
    } as LayerSpecification },
  ];
}

// ─── Transmission lines helper ────────────────────────────────────────────────
const LINE_WIDTH = ["interpolate", ["linear"], ["zoom"],
  4, 1.0,
  7, 1.5,
  10, 2.2,
  13, 3.5
];

// HVDC: colour is spoken for (kV) and dashes are spoken for (overhead/underground),
// so DC circuits get two marks that use neither:
//   1. white dashes over the base stroke — the far-out cue, visible from z0
//   2. a repeating "DC" label along the route from z6 — the unambiguous cue
// The stripe carries its own width ramp rather than a fraction of LINE_WIDTH:
// at z3-5 the base line is ~1px, so a 0.4x stripe rounded to a sub-pixel ghost
// and DC was indistinguishable when zoomed out.  This floors it at 0.9px.
const DC_STRIPE_COLOR = "#f8fafc";
const DC_STRIPE_WIDTH = ["interpolate", ["linear"], ["zoom"],
  3, 0.9,
  7, 1.1,
  10, 1.5,
  13, 2.0
] as unknown as ExpressionSpecification;
// Dash lengths are multiples of line-width, so this stays ~even on/off at any zoom.
const DC_STRIPE_DASH = [2, 1.8];
const DC_LABEL_MINZOOM = 6;
const DC_LABEL_COLOR = "#0f172a";
const DC_LABEL_HALO = "#f8fafc";

// `sources` is a list so a layer can span several archives; `key` names an
// archive's DATA file when it is not the registry layer's own `data.key`. Every style layer is
// added across ALL sources before the next one starts, so paint order stays
// global: a 765 kV line in one archive draws over a 20 kV line in another, not
// under it. `suffix` distinguishes the per-source layer ids and is "" when there
// is only one source, which is what the HIFLD caller passes.
//
// A source may also declare the voltage range it holds, as `kv: [min, max)`.
// OSM transmission ships as six archives split by voltage class, and a style
// tier only needs a layer on a source whose range it overlaps — an `mv` layer
// over the EHV archive would match nothing but still cost a per-frame filter
// evaluation. Omitting `kv` means "could hold anything", which is what a single
// undivided archive is.
export function planTransmissionLines({ sources, sourceLayer, registryId, prefix,
                               kvExpr, color, opacity, nameField = undefined as (string | undefined), undergroundExpr = undefined as (ExpressionSpecification | undefined),
                               dcExpr = undefined as (ExpressionSpecification | undefined) }: {
  sources: { id: string; key?: DataKey; suffix?: string; kv?: [number, number] }[];
  sourceLayer: string; registryId: string; prefix: string;
  kvExpr: ExpressionSpecification; color: string | ExpressionSpecification; opacity: Record<string, number>; nameField?: string; undergroundExpr?: ExpressionSpecification;
  dcExpr?: ExpressionSpecification;
}): LayerPlan {
  // Every source carries the registry layer's credit: the six voltage-class
  // sources share one, and MapLibre collapses the byte-identical strings into one.
  const plan: LayerPlan = sources.map(s => layerSource(registryId, { id: s.id, key: s.key }));

  // Half-open [min, max) overlap. A tier with no range (the DC overlays) applies
  // to every source, since HVDC runs at every voltage class.
  const holds = (s: { kv?: [number, number] }, kv?: [number, number]) =>
    !s.kv || !kv || (s.kv[0] < kv[1] && kv[0] < s.kv[1]);

  // Plans one style layer per source that can hold the tier.
  const addAcross = (tier: string, spec: (srcId: string) => Record<string, unknown>, kv?: [number, number]) => {
    for (const s of sources) {
      if (!holds(s, kv)) continue;
      const id = `${prefix}${s.suffix ?? ""}-${tier}`;
      plan.push({ layer: { id, source: s.id, "source-layer": sourceLayer, ...spec(s.id) } as LayerSpecification });
    }
  };

  // Tiers added lowest-voltage first so higher tiers paint on top; line-sort-key
  // orders by kV within each tier. z2 is the floor both transmission tilesets
  // are built to; the tiers above it are style choices about clutter. The kV
  // range each tier selects comes from OSM_TL_TIERS, the same table the registry
  // derives its layer ids from, so the two cannot disagree about which archive
  // carries which tier.
  const tierStyle: Record<string, { minzoom: number; filter: FilterSpecification }> = {
    lv:      { minzoom: 9, filter: ["all", [">", kvExpr, 0], ["<", kvExpr, 50]] },
    unknown: { minzoom: 5, filter: ["<=", kvExpr, 0] },
    mv:      { minzoom: 5, filter: ["all", [">=", kvExpr, 50], ["<", kvExpr, 100]] },
    hv:      { minzoom: 2, filter: [">=", kvExpr, 100] },
  };
  const tiers = OSM_TL_TIERS.map(t => ({ ...t, ...tierStyle[t.id] }));
  for (const t of tiers) {
    // 100-199 kV shares the hv tier but fades like the low classes: alpha-blending
    // toward the basemap keeps it muted on light and dark maps alike.
    const op = t.id === "hv" && opacity.hvLow !== undefined
      ? ["case", ["<", kvExpr, 200], opacity.hvLow, opacity.hv]
      : opacity[t.id];
    const paint: Record<string, unknown> = { "line-color": color, "line-width": LINE_WIDTH, "line-opacity": op };
    if (undergroundExpr) {
      paint["line-dasharray"] = ["case", undergroundExpr, ["literal", [3, 3]], ["literal", [1, 0]]] as unknown as ExpressionSpecification;
    }
    addAcross(t.id, () => ({
      type: "line",
      minzoom: t.minzoom, filter: t.filter,
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": kvExpr },
      paint,
    }), t.kv);
  }

  // HVDC white dashes, drawn over every kV tier.  This is the zoomed-OUT cue:
  // the kV colour still reads between the dashes, but the line visibly ticks.
  // Underground DC ends up dashed-over-dashed; the two periods do not align and
  // are not meant to — placement (dash of the base stroke) and current (these
  // white ticks) are separate readings.
  if (dcExpr) {
    addAcross("dc", () => ({
      type: "line",
      minzoom: 2, filter: dcExpr as FilterSpecification,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color":     DC_STRIPE_COLOR,
        "line-width":     DC_STRIPE_WIDTH,
        "line-dasharray": DC_STRIPE_DASH,
        "line-opacity":   0.95,
      },
    }));

    // Zoomed-IN cue: name the circuit outright with a repeating "DC" along the
    // route, dense enough that a corridor is unmistakable at a glance.
    addAcross("dc-label", () => ({
      type: "symbol",
      minzoom: DC_LABEL_MINZOOM, filter: dcExpr as FilterSpecification,
      layout: {
        "symbol-placement":        "line",
        "text-field":              "DC",
        "text-font":               ["Noto Sans Regular"],
        "text-size":               ["interpolate", ["linear"], ["zoom"], 6, 10, 10, 12, 14, 14] as unknown as ExpressionSpecification,
        "symbol-spacing":          120,
        "text-letter-spacing":     0.08,
        "text-keep-upright":       true,
        "text-rotation-alignment": "map",
        "text-pitch-alignment":    "viewport",
        "text-allow-overlap":      false,
        "text-ignore-placement":   false,
      },
      paint: {
        "text-color":      DC_LABEL_COLOR,
        "text-halo-color": DC_LABEL_HALO,
        "text-halo-width": 1.8,
        "text-halo-blur":  0.3,
      },
    }));
  }

  if (!nameField) return plan;
  const name    = ["coalesce", ["get", nameField], ""] as unknown as ExpressionSpecification;
  const hasName = ["!=", name, ""] as FilterSpecification;
  addAcross("label", () => ({
    type: "symbol",
    minzoom: 9, filter: hasName,
    layout: {
      "symbol-placement":        "line",
      "text-field":              name,
      "text-font":               ["Noto Sans Regular"],
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
  }));
  return plan;
}

// ─── Substation points helper ─────────────────────────────────────────────────
// Circle radius by zoom, stepped by kV class. Exported for layer-init.test.ts.
export function subRadius(kvField: string): ExpressionSpecification {
  const kv = ["to-number", ["get", kvField], -1];
  function kvBucket(lo: number, mid: number, hi: number, vhi: number) {
    return ["case",
      [">=", kv, 400], vhi,
      [">=", kv, 200], hi,
      [">=", kv, 100], mid,
      lo
    ];
  }
  return ["interpolate", ["linear"], ["zoom"],
    2,  kvBucket(1, 1.5, 2, 2.5),
    5,  kvBucket(1.5, 2.5, 3.5, 4.5),
    10, kvBucket(2.5, 4.5, 6.5, 8.5),
    15, kvBucket(3.5, 6.5, 9.5, 12.5),
  ] as unknown as ExpressionSpecification;
}

export function planSubstationPoints({ sourceId, kvField, layerIds, sourceLayer }: {
  sourceId: string; kvField: string; layerIds: { hv: string; lv: string; label: string };
  sourceLayer?: string;
}): LayerPlan {
  const paint = {
    "circle-color": voltageColorExpr(kvField, "#a78bfa"),
    "circle-radius": subRadius(kvField),
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.2,
    "circle-stroke-opacity": 0.8,
  };
  const kvNum = ["to-number", ["get", kvField], -1];
  const srcLayerProp = sourceLayer ? { "source-layer": sourceLayer } : {};

  const labelVisible = ["any",
    [">", kvNum, 399],
    ["all", [">", kvNum, 199], [">", ["zoom"], 6]],
    ["all", [">", kvNum,  99], [">", ["zoom"], 8]],
    ["all", [">", kvNum,  49], [">", ["zoom"], 10]],
    [">", ["zoom"], 11],
  ] as unknown as FilterSpecification;
  const subName = ["match",
    ["coalesce", ["get", "name"], ""],
    ["", "nan", "NaN", "None"], "",
    ["coalesce", ["get", "name"], ""]
  ] as unknown as ExpressionSpecification;
  const labelFilter = ["all",
    labelVisible,
    ["!=", subName, ""],
  ] as unknown as FilterSpecification;

  return [
    layerSource(sourceId),
    { layer: {
      id: layerIds.lv, type: "circle", source: sourceId, ...srcLayerProp,
      minzoom: 7, filter: ["<", kvNum, 200] as unknown as FilterSpecification,
      layout: {
        "circle-sort-key": kvNum as unknown as ExpressionSpecification,
      },
      paint,
    } as LayerSpecification },
    { layer: {
      id: layerIds.hv, type: "circle", source: sourceId, ...srcLayerProp,
      minzoom: 0, filter: [">=", kvNum, 200] as unknown as FilterSpecification,
      layout: {
        "circle-sort-key": kvNum as unknown as ExpressionSpecification,
      },
      paint,
    } as LayerSpecification },
    { layer: {
      id: layerIds.label, type: "symbol", source: sourceId, ...srcLayerProp,
      minzoom: 6, filter: labelFilter,
      layout: {
        "symbol-sort-key": ["-", 10000, kvNum] as unknown as ExpressionSpecification,
        "text-field": ["step", ["zoom"],
          subName,
          10, ["case",
            [">", kvNum, 0],
            ["concat", subName, "\n", ["to-string", ["round", kvNum]], " kV"],
            subName,
          ],
        ] as unknown as ExpressionSpecification,
        "text-font": ["Noto Sans Regular"],
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
    } as LayerSpecification },
  ];
}
