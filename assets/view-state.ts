// ─── View state — one path for a whole view to reach the app ─────────────────
// Role: owns how a view (every field a shared link carries: layers, filters,
//       modes, basemap, projection, 3D, region) gets into the app and back out.
//         seedView(data)   cold boot, before the map exists: writes `state`
//                          only, through the setters applyView() uses;
//                          map.ts's load handler paints it.
//         applyView(data)  live map: drives the map to the view, then emits
//                          'view:applied' (ui/panel-mirror.ts repaints the
//                          panel controls, ui.ts the legends)
//                          and 'url:write' — the apply's one URL write.
//         currentView()    the live view in the codec's shape, for the link.
//         repaintView()    the one repaint sequence after state is written:
//                          smoke opacity, filter:all (which carries `where`),
//                          gen modes, then the styles and colour-bys; run by
//                          applyView() and by the cold-boot paint
//                          (url-state.ts's paintLinkedView(), from map.ts).
//       Both entry points resolve `data` over the codec's defaultView() first,
//       so a field the data leaves out (the codec omits defaults) lands at its
//       default instead of keeping the last view's value — a story, a link or
//       Reset never inherits leftovers. Reset is applyView({}). Resolving also
//       settles each exclusive layer group on one member, so a link that names
//       two boots and applies to the same single layer.
//
// Adding a view field: a UrlStateData field with its param and default in
// url-state-codec.ts, then its write in writeState() and its map call in
// applyView() here (or in repaintView(), when cold boot must paint it
// too). A field with its own setter is called from both seedView() and
// applyView() instead, and that setter must write state before its map
// guard. Nothing else has to learn about it.
//
// AppState by kind (fields not listed are the map handle, popups and caches):
//   view (in the link): basemap, basemapLabels, projection, terrain3d, buildings3d,
//     hillshade, smokeOpacity, layerVisibility, layerFilters, legendFilters, mwFilter,
//     yearFilter (enabled/year), genMode, ogfColorBy, westtecColorBy, weatherVar,
//     nriHazard, regionScope, where and styleOverrides (both in the `vx` param).
//   device preference (localStorage): display units live in units.ts, not AppState.
//   personal data: userLayers, userLayerCounter, drawDefaultColor, selectedDrawId,
//     userHighlightKey, draw.
//   session: map, mapReady, popup, editMode, measure, weatherStepSuffix, yearPlayback,
//     sourcesLoaded, sourcesData, liveFcMeta, rasterLut, rasterLutLoading.
//   Map Experience link (story id, snapshot, dirty flag): experience-link.ts,
//     not AppState.
//
// Camera stays outside the view: map.ts owns the hash's position segment, and
// applyView() takes it as a separate argument.
//
// Deps: state.js, url-state-codec.js (defaultView, UrlStateData, CameraView),
//       visibility.js (setLayerVisibility, settleExclusiveGroups, applyAllGenModes),
//       basemap.js (switchBasemap, switchProjection),
//       terrain.js (setTerrain3d, setBuildings3d, setHillshade),
//       weather-live.js (setWeatherVar), fema-nri.js (setNriHazard),
//       layers/map-layers-conditions.js (applySmokeOpacity), state-bus.js,
//       style-overrides.js (applyAllStyles — the styles and colour-bys), diag-log.js.

import { state } from './state.js';
import { defaultView, type UrlStateData, type CameraView } from './url-state-codec.js';
import {
  setLayerVisibility, settleExclusiveGroups, applyAllGenModes,
} from './visibility.js';
import { switchBasemap, switchProjection } from './basemap.js';
import { setTerrain3d, setBuildings3d, setHillshade } from './terrain.js';
import { setWeatherVar } from './weather-live.js';
import { setNriHazard } from './fema-nri.js';
import { applySmokeOpacity } from './layers/map-layers-conditions.js';
import type { StyleOverride } from '../src/types.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { emit } from './state-bus.js';
import { applyAllStyles, type DroppedStyle } from './style-overrides.js';
import { recordDiagEvent } from './diag-log.js';

// The fields a view carries; the link adds `lang` and `exp` on top.
export type View = Omit<UrlStateData, 'lang' | 'experienceId'>;

export type CameraMode = 'fly' | 'jump';

function copyWhere(w: UrlStateData['where']): Record<string, Condition[]> {
  return Object.fromEntries(Object.entries(w ?? {}).map(([id, cs]) => [id, cs.map(c => ({ ...c }))]));
}
function copyStyle(s: UrlStateData['style']): Record<string, StyleOverride> {
  return Object.fromEntries(Object.entries(s ?? {}).map(([id, o]) => [id, { ...o }]));
}

function resolve(data: Partial<UrlStateData>): View {
  const v = defaultView();
  // Keyed fields merge per key: a link lists only the layers and filters that
  // differ from their defaults.
  Object.assign(v.layerVisibility, data.layerVisibility);
  Object.assign(v.legendFilters, data.legendFilters);
  Object.assign(v.layerFilters, data.layerFilters);
  Object.assign(v.genMode, data.genMode);
  settleExclusiveGroups(v.layerVisibility);
  // Replaced wholesale: a key from the previous view must not survive a Reset.
  v.where = copyWhere(data.where);
  v.style = copyStyle(data.style);
  for (const k of [
    'mwFilter', 'yearFilter', 'ogfColorBy', 'westtecColorBy', 'weatherVar', 'nriHazard',
    'smokeOpacity', 'basemap', 'projection', 'terrain3d', 'buildings3d', 'hillshade', 'basemapLabels', 'region',
  ] as const) {
    if (data[k] !== undefined) (v as unknown as Record<string, unknown>)[k] = data[k];
  }
  return v;
}

// The state-only half, shared by both entry points. Fields with a live-map
// side (layer visibility, basemap, projection, 3D, weather variable, NRI
// hazard) go through their setters in seedView() and applyView() instead;
// switchBasemap() reads the labels flag set here.
function writeState(v: View) {
  Object.assign(state.legendFilters, v.legendFilters);
  Object.assign(state.layerFilters, v.layerFilters);
  Object.assign(state.genMode, v.genMode);
  state.where = copyWhere(v.where);
  state.styleOverrides = copyStyle(v.style);
  state.mwFilter = { ...v.mwFilter };
  // min/max are the slider's bounds, set once in ui.ts's init(); not part of a view.
  state.yearFilter.enabled = v.yearFilter.enabled;
  state.yearFilter.year = v.yearFilter.year;
  state.ogfColorBy = v.ogfColorBy as typeof state.ogfColorBy;
  state.westtecColorBy = v.westtecColorBy as typeof state.westtecColorBy;
  state.smokeOpacity = v.smokeOpacity;
  state.basemapLabels = v.basemapLabels;
  state.regionScope = v.region;
}

// The same setters applyView() calls, each of which writes its state field
// before its map guard, so before the map exists they only write state. Layer
// visibility is the exception: setLayerVisibility() returns before writing
// until the map is ready, so the seed writes it directly.
export function seedView(data: Partial<UrlStateData>) {
  const v = resolve(data);
  writeState(v);
  switchBasemap(v.basemap);
  switchProjection(v.projection);
  setWeatherVar(v.weatherVar);
  setNriHazard(v.nriHazard);
  Object.assign(state.layerVisibility, v.layerVisibility);
  setTerrain3d(v.terrain3d);
  setBuildings3d(v.buildings3d);
  setHillshade(v.hillshade);
}

/** Repaint the whole view from state: re-applies smoke opacity, re-filters
 *  every layer (`where` rides on 'filter:all'), re-applies gen modes, then
 *  paints the style overrides and colour-bys. Returns the style keys the map could not take. */
export function repaintView(): DroppedStyle[] {
  applySmokeOpacity();
  emit('filter:all');
  applyAllGenModes();
  return applyAllStyles();
}

export function applyView(data: Partial<UrlStateData>, camera?: CameraView & { mode?: CameraMode }): DroppedStyle[] {
  if (!state.mapReady || !state.map) return [];
  const map = state.map;
  const v = resolve(data);

  writeState(v);
  switchBasemap(v.basemap);
  if (state.projection !== v.projection) switchProjection(v.projection);
  // Before the layers switch on, so the weather wash and NRI fill come up
  // showing the variable and hazard this view asked for.
  setWeatherVar(v.weatherVar);
  setNriHazard(v.nriHazard);

  // Only layers whose visibility changes are touched. Off before on: a layer
  // the view turns off gives up its map layers before the ones it turns on
  // claim theirs (and an exclusive group never switches its new member off).
  for (const [id, on] of Object.entries(v.layerVisibility)) {
    if (!on && state.layerVisibility[id]) setLayerVisibility(id, false, false);
  }
  for (const [id, on] of Object.entries(v.layerVisibility)) {
    if (on && !state.layerVisibility[id]) setLayerVisibility(id, true, false);
  }

  if (state.terrain3d !== v.terrain3d) setTerrain3d(v.terrain3d);
  if (state.buildings3d !== v.buildings3d) setBuildings3d(v.buildings3d);
  if (state.hillshade !== v.hillshade) setHillshade(v.hillshade);

  // Returned for a caller that shows them (a view file); recorded either way,
  // since in a story a skipped key is an authoring slip.
  const dropped = repaintView();
  for (const d of dropped) recordDiagEvent('link', `view style ${d.id}.${d.key}: ${d.reason}`);

  emit('view:applied');
  emit('url:write');

  if (camera) {
    const { mode = 'fly', ...view } = camera;
    if (mode === 'jump') map.jumpTo(view);
    else map.flyTo({ ...view, speed: 0.8, curve: 1.4, essential: true });
  }
  return dropped;
}

export function currentView(): View {
  return {
    layerVisibility: state.layerVisibility,
    legendFilters: state.legendFilters,
    layerFilters: state.layerFilters,
    mwFilter: state.mwFilter,
    yearFilter: state.yearFilter,
    genMode: state.genMode,
    ogfColorBy: state.ogfColorBy,
    westtecColorBy: state.westtecColorBy,
    weatherVar: state.weatherVar,
    nriHazard: state.nriHazard,
    smokeOpacity: state.smokeOpacity,
    basemap: state.basemap,
    projection: state.projection,
    terrain3d: state.terrain3d,
    buildings3d: state.buildings3d,
    hillshade: state.hillshade,
    basemapLabels: state.basemapLabels,
    region: state.regionScope,
    where: copyWhere(state.where),
    style: copyStyle(state.styleOverrides),
  };
}
