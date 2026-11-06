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
//                          smoke opacity, applyAllFilters() (which carries `where`,
//                          the area and the selection),
//                          gen modes, then the styles and colour-bys, then the
//                          linked services (renderServices(), which fetches
//                          only an allowed one); run by applyView() and by the
//                          cold-boot paint (url-state.ts's paintLinkedView(), from map.ts).
//         setServices(list) / addService(svc) / skipService(id)
//                          the linked-services commits: checked with the link's
//                          caps (view-validate.ts validateServices), drawn, one
//                          'url:write' each — so each is an undo step.
//         pendingServices() / approveAndLoad(url)
//                          the services in the view that may not fetch yet
//                          (neither vetted nor approved this session), and the
//                          visitor's Load: approve the URL, then draw.
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
//     nriHazard, routeConcern, gridHour, gridGroup, gridGlyph, gridNumbers, regionScope, where, styleOverrides, sel and services (all in the `vx` param),
//     area (the `af` param).
//   device preference (localStorage): display units live in units.ts, not AppState.
//   personal data: userLayers, userLayerCounter, drawDefaultColor, selectedDrawId,
//     userHighlightKey, draw.
//   session: map, mapReady, popup, editMode, measure, yearPlayback,
//     sourcesLoaded, sourcesData, liveFcMeta. The hover LUTs and the weather step
//     they follow live in raster-probes.ts, not AppState.
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
//       route-constraints.js (setRouteConcern), grid-ops/grid-ops.js (setGridView),
//       layers/map-layers-conditions.js (applySmokeOpacity), state-bus.js,
//       style-overrides.js (applyAllStyles — the styles and colour-bys), diag-log.js,
//       filters.js (applyAllFilters), src/registry/area-filter.js (normalizeArea),
//       services/service-render.js (renderServices), services/service-trust.js
//       (approve, isAllowed), src/registry/view-validate.js (validateServices).

import { state } from './state.js';
import { defaultView, type UrlStateData, type CameraView } from './url-state-codec.js';
import {
  setLayerVisibility, settleExclusiveGroups, applyAllGenModes,
} from './visibility.js';
import { switchBasemap, switchProjection } from './basemap.js';
import { setTerrain3d, setBuildings3d, setHillshade } from './terrain.js';
import { setWeatherVar } from './weather-live.js';
import { setNriHazard } from './fema-nri.js';
import { setRouteConcern } from './route-constraints.js';
import { setGridView } from './grid-ops/grid-ops.js';
import { applySmokeOpacity } from './layers/map-layers-conditions.js';
import type { Selection, StyleOverride } from '../src/types.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { normalizeArea } from '../src/registry/area-filter.js';
import { emit } from './state-bus.js';
import { applyAllStyles, type DroppedStyle } from './style-overrides.js';
import { recordDiagEvent } from './diag-log.js';
import { applyAllFilters } from './filters.js';
import { renderServices } from './services/service-render.js';
import { approve, isAllowed } from './services/service-trust.js';
import { validateServices } from '../src/registry/view-validate.js';
import type { LinkedService } from './services/service-spec.js';

// The fields a view carries; the link adds `lang` and `exp` on top.
export type View = Omit<UrlStateData, 'lang' | 'experienceId'>;

export type CameraMode = 'fly' | 'jump';

function copyWhere(w: UrlStateData['where']): Record<string, Condition[]> {
  return Object.fromEntries(Object.entries(w ?? {}).map(([id, cs]) => [id, cs.map(c => ({ ...c }))]));
}
function copyStyle(s: UrlStateData['style']): Record<string, StyleOverride> {
  return Object.fromEntries(Object.entries(s ?? {}).map(([id, o]) => [id, { ...o }]));
}

function copySel(s: UrlStateData['sel']): Selection | null {
  return s ? { mode: s.mode, ids: Object.fromEntries(Object.entries(s.ids).map(([id, l]) => [id, [...l]])) } : null;
}

const copyServices = (list: UrlStateData['services']): LinkedService[] => structuredClone(list ?? []);

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
  v.area = data.area ? { kind: data.area.kind, codes: [...data.area.codes] } : null;
  v.sel = copySel(data.sel);
  v.services = copyServices(data.services);
  for (const k of [
    'mwFilter', 'yearFilter', 'ogfColorBy', 'westtecColorBy', 'weatherVar', 'nriHazard', 'routeConcern',
    'gridHour', 'gridGroup', 'gridGlyph', 'gridNumbers', 'smokeOpacity', 'basemap', 'projection', 'terrain3d', 'buildings3d', 'hillshade', 'basemapLabels', 'region',
  ] as const) {
    if (data[k] !== undefined) (v as unknown as Record<string, unknown>)[k] = data[k];
  }
  return v;
}

// The state-only half, shared by both entry points. Fields with a live-map
// side (layer visibility, basemap, projection, 3D, weather variable, NRI
// hazard, route concern) go through their setters in seedView() and applyView() instead;
// switchBasemap() reads the labels flag set here.
function writeState(v: View) {
  Object.assign(state.legendFilters, v.legendFilters);
  Object.assign(state.layerFilters, v.layerFilters);
  Object.assign(state.genMode, v.genMode);
  state.where = copyWhere(v.where);
  state.styleOverrides = copyStyle(v.style);
  state.area = v.area ? normalizeArea(v.area) : null;
  state.sel = copySel(v.sel);
  state.services = copyServices(v.services);
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
  setRouteConcern(v.routeConcern);
  setGridView(v.gridHour, v.gridGroup, v.gridGlyph, v.gridNumbers);
  Object.assign(state.layerVisibility, v.layerVisibility);
  setTerrain3d(v.terrain3d);
  setBuildings3d(v.buildings3d);
  setHillshade(v.hillshade);
}

/** Repaint the whole view from state: re-applies smoke opacity, re-filters
 *  every layer (`where` rides on applyAllFilters()), re-applies gen modes,
 *  paints the style overrides and colour-bys, then draws the linked services.
 *  Returns the style keys the map could not take. */
export function repaintView(): DroppedStyle[] {
  applySmokeOpacity();
  applyAllFilters();
  applyAllGenModes();
  const dropped = applyAllStyles();
  renderServices();
  return dropped;
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
  setRouteConcern(v.routeConcern);
  setGridView(v.gridHour, v.gridGroup, v.gridGlyph, v.gridNumbers);

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
    routeConcern: state.routeConcern,
    gridHour: state.gridHour,
    gridGroup: state.gridGroup,
    gridGlyph: state.gridGlyph,
    gridNumbers: state.gridNumbers,
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
    area: state.area && { kind: state.area.kind, codes: [...state.area.codes] },
    sel: copySel(state.sel),
    services: copyServices(state.services),
  };
}

// ─── Linked services ─────────────────────────────────────────────────────────

/** Replace the view's linked services. Refused (with the reason, state
 *  untouched) past the link's caps or on any invalid entry; else drawn and
 *  committed with one 'url:write'. Approves nothing: a URL not yet allowed stays pending. */
export function setServices(list: LinkedService[]): string | null {
  const v = validateServices(list);
  if (!v.ok) return v.reason;
  state.services = v.result;
  renderServices();
  emit('url:write');
  return null;
}

/** The visitor's own add (the dialog after its warning, a confirmed chat call):
 *  appended through setServices(), and its URL approved for this session once accepted. */
export function addService(svc: LinkedService): string | null {
  const v = validateServices([...state.services, svc]);
  if (!v.ok) return v.reason;
  approve(v.result[v.result.length - 1].url);
  return setServices(v.result);
}

/** Skip on a pending card: the entry leaves the view (one 'url:write'); an undo
 *  brings it back still pending. False when no service has that id. */
export function skipService(id: string): boolean {
  if (!state.services.some(s => s.id === id)) return false;
  state.services = state.services.filter(s => s.id !== id);
  renderServices();
  emit('url:write');
  return true;
}

/** The view's services that may not fetch: neither vetted nor approved this session. */
export function pendingServices(): LinkedService[] {
  return state.services.filter(s => !isAllowed(s));
}

/** Load on a pending card: approve the URL for this session, then draw. No view change. */
export function approveAndLoad(url: string): void {
  approve(url);
  renderServices();
}
