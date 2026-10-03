// ─── View state — one path for a whole view to reach the app ─────────────────
// Role: owns how a view (every field a shared link carries: layers, filters,
//       modes, basemap, projection, 3D, region) gets into the app and back out.
//         seedView(data)   cold boot, before the map exists: writes `state`
//                          only; map.ts's load handler paints it.
//         applyView(data)  live map: drives the map to the view, then emits
//                          'view:applied' (ui.ts resyncs panels and controls)
//                          and 'url:write' — the apply's one URL write.
//         currentView()    the live view in the codec's shape, for the link.
//       Both entry points resolve `data` over the codec's defaultView() first,
//       so a field the data leaves out (the codec omits defaults) lands at its
//       default instead of keeping the last view's value — a story, a link or
//       Reset never inherits leftovers. Reset is applyView({}). Resolving also
//       settles each exclusive layer group on one member, so a link that names
//       two boots and applies to the same single layer.
//
// Adding a view field: a UrlStateData field with its param and default in
// url-state-codec.ts, then its write in writeState() and its map call in
// applyView() here. Nothing else has to learn about it.
//
// Camera stays outside the view: map.ts owns the hash's position segment, and
// applyView() takes it as a separate argument.
//
// Deps: state.js, url-state-codec.js (defaultView, UrlStateData, CameraView),
//       visibility.js (setLayerVisibility, exclusiveRivals + the gen-mode/colour-by appliers),
//       map.js (switchBasemap, switchProjection),
//       terrain.js (setTerrain3d, setBuildings3d, setHillshade),
//       weather-live.js (setWeatherVar), fema-nri.js (setNriHazard),
//       layers/map-layers-conditions.js (applySmokeOpacity), state-bus.js.

import { state } from './state.js';
import { defaultView, type UrlStateData, type CameraView } from './url-state-codec.js';
import {
  setLayerVisibility, exclusiveRivals, applyAllGenModes, applyOGFColorBy, applyWestTECColorBy,
} from './visibility.js';
import { switchBasemap, switchProjection } from './map.js';
import { setTerrain3d, setBuildings3d, setHillshade } from './terrain.js';
import { setWeatherVar } from './weather-live.js';
import { setNriHazard } from './fema-nri.js';
import { applySmokeOpacity } from './layers/map-layers-conditions.js';
import { emit } from './state-bus.js';

// The fields a view carries; the link adds `lang` and `exp` on top.
export type View = Omit<UrlStateData, 'lang' | 'experienceId'>;

export type CameraMode = 'fly' | 'jump';

function resolve(data: Partial<UrlStateData>): View {
  const v = defaultView();
  // Keyed fields merge per key: a link lists only the layers and filters that
  // differ from their defaults.
  Object.assign(v.layerVisibility, data.layerVisibility);
  Object.assign(v.legendFilters, data.legendFilters);
  Object.assign(v.layerFilters, data.layerFilters);
  Object.assign(v.genMode, data.genMode);
  // The layer furthest down the registry wins its exclusive group, as it would
  // switching the group's members on in registry order.
  for (const id of Object.keys(v.layerVisibility).reverse()) {
    if (v.layerVisibility[id]) for (const r of exclusiveRivals(id)) v.layerVisibility[r] = false;
  }
  for (const k of [
    'mwFilter', 'yearFilter', 'ogfColorBy', 'westtecColorBy', 'weatherVar', 'nriHazard',
    'smokeOpacity', 'basemap', 'projection', 'terrain3d', 'buildings3d', 'hillshade', 'region',
  ] as const) {
    if (data[k] !== undefined) (v as unknown as Record<string, unknown>)[k] = data[k];
  }
  return v;
}

// The state-only half, shared by both entry points. Fields with a live-map
// side (layer visibility, basemap, projection, 3D, weather variable, NRI
// hazard) go through their setters in applyView() instead.
function writeState(v: View) {
  Object.assign(state.legendFilters, v.legendFilters);
  Object.assign(state.layerFilters, v.layerFilters);
  Object.assign(state.genMode, v.genMode);
  state.mwFilter = { ...v.mwFilter };
  // min/max are the slider's bounds, set once in ui.ts's init(); not part of a view.
  state.yearFilter.enabled = v.yearFilter.enabled;
  state.yearFilter.year = v.yearFilter.year;
  state.ogfColorBy = v.ogfColorBy as typeof state.ogfColorBy;
  state.westtecColorBy = v.westtecColorBy as typeof state.westtecColorBy;
  state.smokeOpacity = v.smokeOpacity;
  if (v.region) state.regionScope = v.region;
}

export function seedView(data: Partial<UrlStateData>) {
  const v = resolve(data);
  writeState(v);
  Object.assign(state.layerVisibility, v.layerVisibility);
  state.weatherVar = v.weatherVar;
  state.nriHazard = v.nriHazard;
  state.basemap = v.basemap;
  state.projection = v.projection;
  state.terrain3d = v.terrain3d;
  state.buildings3d = v.buildings3d;
  state.hillshade = v.hillshade;
}

export function applyView(data: Partial<UrlStateData>, camera?: CameraView & { mode?: CameraMode }) {
  if (!state.mapReady || !state.map) return;
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

  applySmokeOpacity();
  emit('filter:all');
  applyAllGenModes();
  applyOGFColorBy();
  applyWestTECColorBy();

  emit('view:applied');
  emit('url:write');

  if (!camera) return;
  const { mode = 'fly', ...view } = camera;
  if (mode === 'jump') map.jumpTo(view);
  else map.flyTo({ ...view, speed: 0.8, curve: 1.4, essential: true });
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
    region: state.regionScope,
  };
}
