// ─── Polygon hover highlight + vector line click-highlight ───────────────────
// Imported by: map.ts (init calls), popup.ts (highlightLine/clearLineHighlight)

import { state } from './state.js';
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleLayer } from 'maplibre-gl';
import { LAYERS } from '../src/registry/index.js';

// ─── Polygon hover ────────────────────────────────────────────────────────────
// Config is driven by LayerDef.hoverField; fill/source/source-layer are derived
// from the existing map style at init time so no duplication with layer builders.

export function initPolygonHover() {
  if (!state.map) return;
  let activeHl: string | null  = null;
  let activeVal: string | null = null;

  state.map.on("click", function onPolygonClearClick(e) {
    if (state.editMode === 'edit' || state.measure.active) return;
    if (!activeHl) return;
    const fillIds = LAYERS
      .filter(l => l.hoverField)
      .flatMap(l => l.mapLayerIds.filter(id => id.endsWith('-fill')))
      .filter(id => state.map!.getLayer(id));
    const hits = state.map!.queryRenderedFeatures(e.point, { layers: fillIds });
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

    state.map.on("mousemove", fill, () => {
      if (state.map!.getLayoutProperty(fill, "visibility") !== "none")
        state.map!.getCanvas().style.cursor = "pointer";
    });
    state.map.on("mouseleave", fill, () => {
      state.map!.getCanvas().style.cursor = "";
    });

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
// Config is driven by LayerDef.lineHighlightKeys; source/source-layer derived
// from first mapLayerIds entry at init time.

interface LineHlCfg { src: string; sl: string | undefined; key: string[]; hl: string }

const NEVER_MATCH = ["==", ["get", "\x00"], "\x00\x01"];
const LINE_HL_BY_LAYER: Record<string, LineHlCfg> = {};
let activeLineHl: string | null = null;

export function initLineHighlight() {
  if (!state.map) return;
  const styleLayers = state.map.getStyle().layers;
  for (const layer of LAYERS) {
    if (!layer.lineHighlightKeys) continue;
    const firstId = layer.mapLayerIds.find(id => state.map!.getLayer(id));
    if (!firstId) continue;
    const styleLayer = state.map.getLayer(firstId) as StyleLayer;
    const src = styleLayer.source;
    const sl  = styleLayer.sourceLayer || undefined;
    if (!src || !state.map.getSource(src)) continue;

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

    const cfg: LineHlCfg = { src, sl, key: layer.lineHighlightKeys, hl: hlId };
    for (const lyr of styleLayers) {
      if ((lyr as { source?: string }).source === src && lyr.type === "line" && lyr.id !== hlId)
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
  state.map.setFilter(cfg.hl, ["all", ...conds] as FilterSpecification);
  state.map.setLayoutProperty(cfg.hl, "visibility", "visible");
  activeLineHl = cfg.hl;
  return true;
}

export function clearLineHighlight() {
  if (activeLineHl && state.map?.getLayer(activeLineHl))
    state.map.setLayoutProperty(activeLineHl, "visibility", "none");
  activeLineHl = null;
}
