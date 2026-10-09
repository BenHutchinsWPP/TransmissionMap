// ─── Layer visibility toggle + generator display mode ────────────────────────
// setLayerVisibility() is the one way to switch a layer: it updates state and
// the map, commits with 'url:write' (the URL write and the undo stack — unless
// `writeUrl` is false: a caller switching many layers commits once itself),
// then emits 'layer:visibility' so modules with their own per-layer machinery
// (weather-live.ts, nws-zone-join.ts), the legends (ui-legends.ts's
// updateLegends) and the panel row (ui/panel-mirror.ts) follow along. No panel
// control is written here: the checkbox and heat ramp are panel-mirror's. A
// layer with an `exclusiveGroup` switches the rest of its group off when it is
// switched on; settleExclusiveGroups() is the
// same rule over a whole view's visibility map, for view-state.ts before the
// map exists. wantedLayout() is the pure layer → map-layer visibility rule
// (plain, `modes` and heat/icons layers) that setLayerVisibility() and
// applyGenMode() both apply; heatRampShown() is the pure rule panel-mirror.ts
// shows a layer's heat ramp legend by.
// Imported by: ui.ts, live-staleness.ts, odin-outages.ts (setLayerVisibility),
//              view-state.ts (setLayerVisibility, settleExclusiveGroups, applyAllGenModes);
//              ui-filters.ts (applyGenMode); ui/panel-mirror.ts (heatRampShown, modeOf).
// Deps: layers/layer-init.ts (ensureLayerData), raster-probes.ts,
//       tribal-disclaimer.ts, state-bus.ts.

import { state } from './state.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { RASTER_PROBES, ensureRasterLut, updateRasterArrow } from './raster-probes.js';
import { ensureLayerData } from './layers/layer-init.js';
import { TRIBAL_LAYER_IDS, showTribalDisclaimer } from './tribal-disclaimer.js';
import { emit } from './state-bus.js';
import type { LayerDef } from '../src/types.js';

export function exclusiveRivals(registryId: string): string[] {
  const group = layerById(registryId)?.exclusiveGroup;
  return group ? LAYERS.filter(l => l.exclusiveGroup === group && l.id !== registryId).map(l => l.id) : [];
}

/** Settle each exclusive group on one member, in place: the layer furthest
 *  down `vis` (registry order) wins, as it would switching the group's members
 *  on one by one. The pre-map form of setLayerVisibility's rival switch-off. */
export function settleExclusiveGroups(vis: Record<string, boolean>): void {
  for (const id of Object.keys(vis).reverse()) {
    if (vis[id]) for (const r of exclusiveRivals(id)) vis[r] = false;
  }
}

/** A layer's display mode: the view's choice, else its default, else icons. */
export function modeOf(entry: LayerDef): string {
  return state.genMode[entry.id] || entry.defaultMode || "icons";
}

/** The visibility each of a layer's map layers should have: all of them for a
 *  plain layer; the active mode's set for a `modes` layer (an unknown mode
 *  falls back to the first); heat and/or icons for a `heatLayerId` layer. */
export function wantedLayout(entry: LayerDef, on: boolean, mode: string): Record<string, 'visible' | 'none'> {
  let wanted: (mlId: string) => boolean;
  if (entry.modes) {
    const active = entry.modes.find(m => m.id === mode) || entry.modes[0];
    wanted = mlId => active.layers.includes(mlId);
  } else if (entry.heatLayerId) {
    const showHeat  = mode === "heat"  || mode === "both";
    const showIcons = mode === "icons" || mode === "both";
    wanted = mlId => mlId === entry.heatLayerId ? showHeat : showIcons;
  } else {
    wanted = () => true;
  }
  return Object.fromEntries(entry.mapLayerIds.map(mlId => [mlId, on && wanted(mlId) ? "visible" : "none"]));
}

/** Whether a layer's heat ramp legend shows: while its heat layer is drawn. A
 *  `modes` layer draws it only when the active mode lists it (an unknown mode
 *  falls back to the first); a heat/icons layer in heat or both. */
export function heatRampShown(entry: LayerDef, on: boolean, mode: string): boolean {
  if (!on) return false;
  if (entry.modes) {
    const active = entry.modes.find(m => m.id === mode) || entry.modes[0];
    return !!entry.heatLayerId && active.layers.includes(entry.heatLayerId);
  }
  return !!entry.heatLayerId && (mode === "heat" || mode === "both");
}

function applyLayout(layout: Record<string, 'visible' | 'none'>) {
  for (const [mlId, v] of Object.entries(layout)) {
    if (state.map?.getLayer(mlId)) state.map.setLayoutProperty(mlId, "visibility", v);
  }
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
  if (entry.heatLayerId || entry.modes) applyGenMode(registryId);
  else applyLayout(wantedLayout(entry, visible, modeOf(entry)));
  if (writeUrl) emit('url:write');
  emit('layer:visibility', { id: registryId, visible });

  if (visible && TRIBAL_LAYER_IDS.includes(registryId)) showTribalDisclaimer();
}

export function applyGenMode(registryId: string) {
  const entry = layerById(registryId);
  if (!entry || !(entry.heatLayerId || entry.modes) || !state.mapReady || !state.map) return;
  applyLayout(wantedLayout(entry, !!state.layerVisibility[registryId], modeOf(entry)));
}

export function applyAllGenModes() {
  for (const entry of LAYERS) if (entry.heatLayerId || entry.modes) applyGenMode(entry.id);
}
