// ─── Layer visibility toggle + generator display mode + colour-by ────────────
// setLayerVisibility() is the one way to switch a layer: it updates state, the
// map, the panel checkbox and the URL (unless `writeUrl` is false — a caller
// switching many layers writes the URL once itself), then emits
// 'layer:visibility' so modules with their own per-layer machinery
// (weather-live.ts, nws-zone-join.ts) and the legends (ui-legends.ts's
// updateLegends) follow along. A layer with an `exclusiveGroup` switches the
// rest of its group off when it is switched on; settleExclusiveGroups() is the
// same rule over a whole view's visibility map, for view-state.ts before the
// map exists. wantedLayout() is the pure layer → map-layer visibility rule
// (plain, `modes` and heat/icons layers) that setLayerVisibility() and
// applyGenMode() both apply.
// Imported by: ui.ts, live-staleness.ts, odin-outages.ts (setLayerVisibility),
//              view-state.ts (setLayerVisibility, settleExclusiveGroups + the appliers),
//              style-overrides.ts (applyOGFColorBy, applyWestTECColorBy);
//              ui-filters.ts reaches applyGenMode and the colour-bys over the bus
//              ('gen:mode', 'ogf:colorby', 'westtec:colorby').
// Deps: style-overrides.ts (effectiveOverride; cyclic, call-time only)
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
import { effectiveOverride } from './style-overrides.js';
import type { LayerDef } from '../src/types.js';
import type { ExpressionSpecification } from 'maplibre-gl';

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

function modeOf(entry: LayerDef): string {
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
  const mode = modeOf(entry);
  applyLayout(wantedLayout(entry, on, mode));

  // The heat ramp shows while the heat layer is drawn. A `modes` layer draws it
  // only when the active mode lists it; a heat/icons layer in heat or both.
  let heatShown: boolean;
  if (entry.modes) {
    const active = entry.modes.find(m => m.id === mode) || entry.modes[0];
    heatShown = !!entry.heatLayerId && active.layers.includes(entry.heatLayerId);
  } else {
    heatShown = mode === "heat" || mode === "both";
  }
  const rampEl = document.getElementById(`${registryId}-heat-ramp`);
  if (rampEl) rampEl.hidden = !(on && heatShown);
}

export function applyAllGenModes() {
  for (const entry of LAYERS) if (entry.heatLayerId || entry.modes) applyGenMode(entry.id);
}

// ─── Colour-by: OGF planned lines and WestTEC 10-Yr ───────────────────────────
// Repaints the lines for the selected mode and dims the swatches of the
// legend that is NOT driving color (it remains a filter, not a color key).
// A view's color override (state.styleOverrides) wins over the colour-by
// expression; style-overrides.ts re-runs these when that override is cleared.
function applyColorBy(legendModes: Record<string, string>, mode: string,
                      mapLayerId: string, registryId: string, expr: () => ExpressionSpecification) {
  for (const [elId, m] of Object.entries(legendModes)) {
    document.getElementById(elId)?.classList.toggle("legend--not-color-key", m !== mode);
  }
  if (!state.mapReady || !state.map?.getLayer(mapLayerId)) return;
  state.map.setPaintProperty(mapLayerId, "line-color", effectiveOverride(registryId).color ?? expr());
}

const OGF_LEGEND_MODES = {
  ogfRegionLegend: "region",
  ogfStatusLegend: "status",
} as const;

export function applyOGFColorBy() {
  applyColorBy(OGF_LEGEND_MODES, state.ogfColorBy, "ogf-planned-lines", "ogf-planned-transmission",
    () => ogfColorExpr(state.ogfColorBy));
}

const WESTTEC_LEGEND_MODES = {
  westtecScenarioLegend: "scenario",
  westtecDatasetLegend:  "dataset",
} as const;

export function applyWestTECColorBy() {
  applyColorBy(WESTTEC_LEGEND_MODES, state.westtecColorBy, "westtec-lines", "westtec-10yr",
    () => westtecColorExpr(state.westtecColorBy));
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
