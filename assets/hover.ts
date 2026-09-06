// ─── Polygon hover highlight + vector line click-highlight ───────────────────
// Imported by: map.ts (init calls), popup.ts (highlightLine/clearLineHighlight,
// hoverFillIds for its shared cursor hit-test)

import { state } from './state.js';
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleLayer } from 'maplibre-gl';
import { LAYERS } from '../src/registry/index.js';

// ─── Polygon hover ────────────────────────────────────────────────────────────
// Config is driven by LayerDef.hoverField; fill/source/source-layer are derived
// from the existing map style at init time so no duplication with layer builders.

// The hover-highlight fills, which are also the extra layers popup.ts folds
// into its shared cursor hit-test (they are not all in CLICKABLE_LAYERS).
// Visibility-gated for the same reason as activeClickableLayers() in popup.ts:
// every id handed to queryRenderedFeatures pulls its whole source into the
// query, and under 3D terrain each source costs a GPU readback sweep.
export function hoverFillIds(): string[] {
  if (!state.map) return [];
  return LAYERS
    .filter(l => l.hoverField)
    .flatMap(l => l.mapLayerIds.filter(id => id.endsWith('-fill')))
    .filter(id => state.map!.getLayer(id)
      && state.map!.getLayoutProperty(id, 'visibility') !== 'none');
}

export function initPolygonHover() {
  if (!state.map) return;
  let activeHl: string | null  = null;
  let activeVal: string | null = null;

  state.map.on("click", function onPolygonClearClick(e) {
    if (state.editMode === 'edit' || state.measure.active) return;
    if (!activeHl) return;
    const hits = state.map!.queryRenderedFeatures(e.point, { layers: hoverFillIds() });
    if (!hits.length) {
      state.map!.setLayoutProperty(activeHl, "visibility", "none");
      activeHl = activeVal = null;
    }
  });

  for (const layer of LAYERS) {
    if (!layer.hoverField) continue;
    const fill = layer.mapLayerIds.find(id => id.endsWith('-fill'));
    if (!fill || !state.map.getLayer(fill)) continue;
    const styleLayer = state.map.getLayer(fill) as StyleLayer;
    const src = styleLayer.source;
    if (!src || !state.map.getSource(src)) continue;
    const sl = styleLayer.sourceLayer || undefined;
    const hl    = layer.id + "-hl";
    const field = layer.hoverField;

    const def: LayerSpecification = {
      id: hl, type: "line", source: src, minzoom: 2,
      layout: { visibility: "none" },
      filter: ["==", ["get", field], "\x00"] as FilterSpecification,
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 5, 2.5, 10, 3.5] as ExpressionSpecification,
        "line-opacity": 0.90,
      },
    };
    if (sl) (def as Record<string, unknown>)["source-layer"] = sl;
    state.map.addLayer(def);

    state.map.on("click", fill, function onPolygonFillClick(e) {
      if (state.editMode === 'edit' || state.measure.active) return;
      if (state.map!.getLayoutProperty(fill, "visibility") === "none") return;
      if (!e.features?.length) return;
      const val = e.features[0].properties[field];
      if (val == null) return;

      const same = activeHl === hl && activeVal === String(val);
      if (activeHl && state.map!.getLayer(activeHl))
        state.map!.setLayoutProperty(activeHl, "visibility", "none");

      if (same) {
        activeHl = activeVal = null;
      } else {
        activeHl  = hl;
        activeVal = String(val);
        state.map!.setFilter(hl, ["==", ["to-string", ["get", field]], activeVal]);
        state.map!.setLayoutProperty(hl, "visibility", "visible");
      }
    });
  }
}

// ─── Vector line click-highlight ─────────────────────────────────────────────
// Config is driven by LayerDef.lineHighlightKeys; sources and source-layers are
// derived from the layer's mapLayerIds at init time. A layer can be backed by
// several sources, so `hl` holds one highlight layer per source and they are
// driven together — one filter, one visibility flip, however many sources.

interface LineHlCfg { key: string[]; hl: string[] }

const NEVER_MATCH = ["==", ["get", "\x00"], "\x00\x01"];
const LINE_HL_BY_LAYER: Record<string, LineHlCfg> = {};
let activeLineHl: string[] = [];

export function initLineHighlight() {
  if (!state.map) return;
  const styleLayers = state.map.getStyle().layers;
  for (const layer of LAYERS) {
    if (!layer.lineHighlightKeys) continue;

    // Every distinct source behind this layer, with its source-layer.
    const srcs = new Map<string, string | undefined>();
    for (const id of layer.mapLayerIds) {
      const sty = state.map.getLayer(id) as StyleLayer | undefined;
      if (sty?.source && state.map.getSource(sty.source) && !srcs.has(sty.source))
        srcs.set(sty.source, sty.sourceLayer || undefined);
    }
    if (!srcs.size) continue;

    const hlIds: string[] = [];
    for (const [src, sl] of srcs) {
      const hlId = src + "-line-hl";
      const hlDef: LayerSpecification = {
        id: hlId, type: "line", source: src,
        layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        filter: NEVER_MATCH as FilterSpecification,
        paint: {
          "line-color": "#3b82f6",
          "line-gap-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 12, 4] as ExpressionSpecification,
          "line-width": 2.5,
          "line-opacity": 0.95,
        },
      };
      if (sl) (hlDef as Record<string, unknown>)["source-layer"] = sl;
      state.map.addLayer(hlDef);
      hlIds.push(hlId);
    }

    const cfg: LineHlCfg = { key: layer.lineHighlightKeys, hl: hlIds };
    for (const lyr of styleLayers) {
      const src = (lyr as { source?: string }).source;
      if (src && srcs.has(src) && lyr.type === "line" && !hlIds.includes(lyr.id))
        LINE_HL_BY_LAYER[lyr.id] = cfg;
    }
  }
}

export function highlightLine(layerId: string, props: Record<string, unknown>): boolean {
  const cfg = LINE_HL_BY_LAYER[layerId];
  if (!cfg || !state.map) return false;
  if (cfg.key.some(f => props[f] == null || props[f] === "")) return false;
  const conds = cfg.key.map(f => ["==", ["to-string", ["get", f]], String(props[f])]);
  clearLineHighlight();
  for (const hl of cfg.hl) {
    state.map.setFilter(hl, ["all", ...conds] as FilterSpecification);
    state.map.setLayoutProperty(hl, "visibility", "visible");
  }
  activeLineHl = cfg.hl;
  return true;
}

export function clearLineHighlight() {
  for (const hl of activeLineHl)
    if (state.map?.getLayer(hl)) state.map.setLayoutProperty(hl, "visibility", "none");
  activeLineHl = [];
}
