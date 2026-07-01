// ─── Layer visibility toggle + generator display mode ────────────────────────
// Imported by: ui.ts (setLayerVisibility, applyAllGenModes),
//              ui-filters.ts (applyGenMode), map.ts (applyAllGenModes)

import { state } from './state.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { writeUrlState } from './url-state.js';
import { RASTER_PROBES, ensureRasterLut, updateRasterArrow } from './raster-probes.js';
import { ensureLayerData } from './layers/layer-init.js';

export function setLayerVisibility(registryId: string, visible: boolean) {
  const entry = layerById(registryId);
  if (!entry || !state.mapReady || !state.map) return;
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
  if (entry.heatLayerId) applyGenMode(registryId);
  writeUrlState();
}

export function applyGenMode(registryId: string) {
  const entry = layerById(registryId);
  if (!entry || !entry.heatLayerId || !state.mapReady || !state.map) return;
  const on        = !!state.layerVisibility[registryId];
  const mode      = state.genMode[registryId] || "icons";
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
  for (const entry of LAYERS) if (entry.heatLayerId) applyGenMode(entry.id);
}

// ─── Bus subscription ─────────────────────────────────────────────────────────
import { on } from './state-bus.js';
on('gen:mode', ({ id }) => applyGenMode(id));
