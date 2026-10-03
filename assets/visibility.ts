// ─── Layer visibility toggle + generator display mode + OGF color-by ─────────
// setLayerVisibility() is the one way to switch a layer: it updates state, the
// map, the panel checkbox and the URL (unless `writeUrl` is false — a caller
// switching many layers writes the URL once itself), then emits
// 'layer:visibility' so modules with their own per-layer machinery
// (weather-live.ts, nws-zone-join.ts) follow along. A layer with an
// `exclusiveGroup` switches the rest of its group off when it is switched on;
// exclusiveRivals() names that rest, for view-state.ts to resolve a whole view.
// Imported by: ui.ts, live-staleness.ts, odin-outages.ts (setLayerVisibility),
//              view-state.ts (setLayerVisibility, exclusiveRivals + the appliers),
//              ui-filters.ts (applyGenMode), map.ts (applyAllGenModes, applyOGFColorBy)
// Also re-runs the fromZoom fetch gate (layer-init.ts's ensureLayerData) on
// every zoom settle, via a 'zoomend' listener attached once the map emits
// 'map:ready' — see refetchZoomGatedLayers below.

import { state } from './state.js';
import { ogfColorExpr, westtecColorExpr } from '../src/colors/buckets.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { writeUrlState } from './url-state.js';
import { RASTER_PROBES, ensureRasterLut, updateRasterArrow } from './raster-probes.js';
import { ensureLayerData } from './layers/layer-init.js';
import { TRIBAL_LAYER_IDS, showTribalDisclaimer } from './tribal-disclaimer.js';
import { on, emit } from './state-bus.js';

export function exclusiveRivals(registryId: string): string[] {
  const group = layerById(registryId)?.exclusiveGroup;
  return group ? LAYERS.filter(l => l.exclusiveGroup === group && l.id !== registryId).map(l => l.id) : [];
}

export function setLayerVisibility(registryId: string, visible: boolean, writeUrl = true) {
  const entry = layerById(registryId);
  if (!entry || !state.mapReady || !state.map) return;
  if (visible) {
    for (const id of exclusiveRivals(registryId)) {
      if (state.layerVisibility[id]) setLayerVisibility(id, false, false);
    }
  }
  state.layerVisibility[registryId] = visible;
  if (visible) ensureLayerData(registryId);
  if (RASTER_PROBES[registryId]) {
    if (visible) ensureRasterLut(registryId);
    else updateRasterArrow(registryId, null);
  }
  const v = visible ? "visible" : "none";
  for (const mlId of entry.mapLayerIds) {
    if (state.map.getLayer(mlId)) {
      state.map.setLayoutProperty(mlId, "visibility", v);
    }
  }
  if (entry.heatLayerId || entry.modes) applyGenMode(registryId);
  const cb = document.querySelector<HTMLInputElement>(`input[type=checkbox][data-layer-id="${registryId}"]`);
  if (cb) cb.checked = visible;
  if (writeUrl) writeUrlState();
  emit('layer:visibility', { id: registryId, visible });

  if (visible && TRIBAL_LAYER_IDS.includes(registryId)) showTribalDisclaimer();
}

export function applyGenMode(registryId: string) {
  const entry = layerById(registryId);
  if (!entry || !(entry.heatLayerId || entry.modes) || !state.mapReady || !state.map) return;
  const on   = !!state.layerVisibility[registryId];
  const mode = state.genMode[registryId] || entry.defaultMode || "icons";

  if (entry.modes) {
    const active = entry.modes.find(m => m.id === mode) || entry.modes[0];
    for (const mlId of entry.mapLayerIds) {
      if (!state.map.getLayer(mlId)) continue;
      const wanted = on && active.layers.includes(mlId);
      state.map.setLayoutProperty(mlId, "visibility", wanted ? "visible" : "none");
    }
    const rampEl = document.getElementById(`${registryId}-heat-ramp`);
    if (rampEl) rampEl.hidden = !(on && !!entry.heatLayerId && active.layers.includes(entry.heatLayerId));
    return;
  }

  const showHeat  = on && (mode === "heat"  || mode === "both");
  const showIcons = on && (mode === "icons" || mode === "both");
  for (const mlId of entry.mapLayerIds) {
    if (!state.map.getLayer(mlId)) continue;
    const wanted = (mlId === entry.heatLayerId) ? showHeat : showIcons;
    state.map.setLayoutProperty(mlId, "visibility", wanted ? "visible" : "none");
  }
  const rampEl = document.getElementById(`${registryId}-heat-ramp`);
  if (rampEl) rampEl.hidden = !showHeat;
}

export function applyAllGenModes() {
  for (const entry of LAYERS) if (entry.heatLayerId || entry.modes) applyGenMode(entry.id);
}

// ─── OGF planned-lines color-by ───────────────────────────────────────────────
// Repaints the lines for the selected mode and dims the swatches of the two
// OGF legend that is NOT driving color (it remains a filter, not a color key).
const OGF_LEGEND_MODES = {
  ogfRegionLegend: "region",
  ogfStatusLegend: "status",
} as const;

export function applyOGFColorBy() {
  for (const [elId, mode] of Object.entries(OGF_LEGEND_MODES)) {
    document.getElementById(elId)?.classList.toggle("legend--not-color-key", mode !== state.ogfColorBy);
  }
  if (!state.mapReady || !state.map?.getLayer("ogf-planned-lines")) return;
  state.map.setPaintProperty("ogf-planned-lines", "line-color", ogfColorExpr(state.ogfColorBy));
}

// ─── WestTEC 10-Yr color-by ───────────────────────────────────────────────────
// Same pattern as applyOGFColorBy() above, over its own two legends/mode set.
const WESTTEC_LEGEND_MODES = {
  westtecScenarioLegend: "scenario",
  westtecDatasetLegend:  "dataset",
} as const;

export function applyWestTECColorBy() {
  for (const [elId, mode] of Object.entries(WESTTEC_LEGEND_MODES)) {
    document.getElementById(elId)?.classList.toggle("legend--not-color-key", mode !== state.westtecColorBy);
  }
  if (!state.mapReady || !state.map?.getLayer("westtec-lines")) return;
  state.map.setPaintProperty("westtec-lines", "line-color", westtecColorExpr(state.westtecColorBy));
}

// ─── fromZoom fetch gate: re-run on zoom settle ────────────────────────────────
// ensureLayerData() withholds a layer's fetch below its LayerDef.fromZoom (see
// layer-init.ts's header). That gate is only checked when something calls
// ensureLayerData, so a layer switched on while zoomed out would otherwise
// stay unloaded forever once the map reaches that zoom. This re-checks every
// visible, not-yet-loaded, zoom-gated layer on each zoom settle and re-calls
// ensureLayerData for the ones that now qualify; ensureLayerData is
// idempotent and de-dupes in-flight calls, so this is cheap even when nothing
// has crossed its threshold yet.
export function refetchZoomGatedLayers() {
  if (!state.mapReady || !state.map) return;
  const zoom = state.map.getZoom();
  for (const entry of LAYERS) {
    if (entry.fromZoom === undefined) continue;
    if (!state.layerVisibility[entry.id]) continue;
    if (state.sourcesLoaded[entry.id]) continue;
    if (zoom >= entry.fromZoom) ensureLayerData(entry.id);
  }
}

// ─── Bus subscription ─────────────────────────────────────────────────────────
on('gen:mode', ({ id }) => applyGenMode(id));
on('ogf:colorby', applyOGFColorBy);
on('westtec:colorby', applyWestTECColorBy);
// Attached once the map is ready (style loaded, layers added) rather than at
// module load, since state.map does not exist yet at import time.
on('map:ready', () => state.map?.on('zoomend', refetchZoomGatedLayers));
