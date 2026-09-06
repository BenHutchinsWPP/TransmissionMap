// ─── Map Experiences runtime controller ───────────────────────────────────────
// Role: turns a MapExperience preset (src/registry/experiences.ts) into live map
//       state — layers, filters, basemap, 3D and camera — and tracks which story
//       is active. Owns no DOM: the gallery and the floating story card live in
//       ui/ui-experiences.ts, which is the only module that imports this one.
//
// Applying a preset always starts from ui.ts's resetLayersToDefaults(), the same
// clean slate the Reset button produces: layers back to their registry defaults,
// filters and 3D toggles cleared, wind particles stopped and alert zones
// unpainted. Reusing it means a story can never inherit the leftovers of the
// last one. Note it hides a live layer rather than shutting its feed down — a
// poller keeps running for the rest of the session once its source exists
// (live-staleness.ts gates refetch on the source, not on visibility).
//
// The pristine/edited split lives in url-state.ts: this module records the id
// and clears the snapshot, and the next writeUrlState() decides whether the link
// still names the story. See docs/url-state.md.
//
// Deps: state.js, visibility.js (setLayerVisibility, applyAllGenModes,
//       applyOGFColorBy, applyWestTECColorBy), map.js (switchBasemap,
//       switchProjection), terrain.js (setTerrain3d, setHillshade),
//       weather-live.js (setWeatherVar, syncWeatherLiveVisibility),
//       nws-zone-join.js (syncZoneVisibility),
//       layers/map-layers-conditions.js (applySmokeOpacity),
//       ui/ui.js (resetLayersToDefaults), ui/ui-layer-rows.js (buildLayersPanel),
//       ui/ui-legends.js (buildLegends), url-state.js, state-bus.js,
//       registry/experiences.js (the catalogue), registry/conditions.js
//       (WEATHER_VARIABLES), registry/index.js (LAYERS, for the gallery badges).

import { state } from './state.js';
import {
  EXPERIENCES, experienceById, AERIAL_MAX_ZOOM,
  type MapExperience, type ExperienceHighlight,
} from '../src/registry/experiences.js';
import { WEATHER_VARIABLES } from '../src/registry/conditions.js';
import { LAYERS } from '../src/registry/index.js';
import { setLayerVisibility, applyAllGenModes, applyOGFColorBy, applyWestTECColorBy } from './visibility.js';
import { switchBasemap } from './map.js';
import { setTerrain3d, setHillshade } from './terrain.js';
import { setWeatherVar, syncWeatherLiveVisibility } from './weather-live.js';
import { syncZoneVisibility } from './nws-zone-join.js';
import { applySmokeOpacity } from './layers/map-layers-conditions.js';
import { resetLayersToDefaults } from './ui/ui.js';
import { buildLayersPanel } from './ui/ui-layer-rows.js';
import { buildLegends } from './ui/ui-legends.js';
import { writeUrlState } from './url-state.js';
import { emit } from './state-bus.js';

const DEFAULT_WEATHER_VAR = WEATHER_VARIABLES[0].id;

export type CameraMode = 'fly' | 'jump';

export function activeExperience(): MapExperience | null {
  return state.experienceId ? experienceById(state.experienceId) : null;
}

export function experienceIndex(id: string): number {
  return EXPERIENCES.findIndex(e => e.id === id);
}

// Wraps at both ends so Next never dead-ends on the last story.
export function neighbourExperience(id: string, delta: number): MapExperience | null {
  const i = experienceIndex(id);
  if (i < 0) return null;
  const n = EXPERIENCES.length;
  return EXPERIENCES[(i + delta % n + n) % n];
}

// Gallery badges: what a story will switch on that the reader can't tell from
// the title. Derived from the layer registry so a layer gaining `live` shows up
// here without the catalogue being touched.
export function experienceTags(exp: MapExperience): string[] {
  const tags: string[] = [];
  if (exp.state.terrain3d) tags.push('3D Terrain');
  const on = exp.state.layersOn ?? [];
  if (LAYERS.some(l => l.live && on.includes(l.id))) tags.push('Live Data');
  if (exp.state.basemap === 'aerial') tags.push('Aerial');
  return tags;
}

export function applyExperience(id: string, camera: CameraMode = 'fly'): MapExperience | null {
  const exp = experienceById(id);
  // A link can name a story that has since been retired or renamed — the codec
  // validates the slug's shape, not its existence. Drop it off the link rather
  // than leaving a dead id in the URL.
  if (!exp) {
    if (state.experienceId === id) endExperience();
    return null;
  }
  if (!state.mapReady || !state.map) return null;
  const map = state.map;

  // Halt whatever the last flyTo is still doing before anything else touches
  // the camera, or its easing keeps running over the new view.
  map.stop();

  // Cleared up front so the reset's own url:write can't be read as the user
  // editing their way out of the story that is being replaced.
  state.experienceId = null;
  state.experienceDirty = false;
  state.experiencePristine = null;

  resetLayersToDefaults();

  const preset = exp.state;

  // Terrain and the globe fight over the same vertex pipeline. No guard is
  // needed here: resetLayersToDefaults() above has already pinned the
  // projection back to mercator, which is what a 3D story requires.
  switchBasemap(preset.basemap ?? 'light');

  for (const [key, ids] of Object.entries(preset.legendFilters ?? {})) {
    state.legendFilters[key] = new Set(ids);
  }
  for (const [layerId, ids] of Object.entries(preset.layerFilters ?? {})) {
    state.layerFilters[layerId] = new Set(ids);
  }
  Object.assign(state.genMode, preset.genMode ?? {});
  // Assigned unconditionally, not `if (preset.x)`: resetLayersToDefaults() does
  // not touch the two colour-by modes, so a conditional would let the last
  // story's choice — and its `oc`/`wc` URL param — ride into the next one.
  state.ogfColorBy = preset.ogfColorBy ?? 'status';
  state.westtecColorBy = preset.westtecColorBy ?? 'scenario';
  if (preset.smokeOpacity !== undefined) state.smokeOpacity = preset.smokeOpacity;
  // Set before the panel is rebuilt below, so the variable dropdown renders on
  // the value the story asked for.
  setWeatherVar(preset.weatherVar ?? DEFAULT_WEATHER_VAR);

  for (const layerId of preset.layersOff ?? []) setLayerVisibility(layerId, false);
  for (const layerId of preset.layersOn ?? []) setLayerVisibility(layerId, true);

  if (preset.terrain3d) setTerrain3d(true);
  if (preset.hillshade) setHillshade(true);

  // setLayerVisibility() flips map layout visibility without dispatching the
  // checkbox `change` event these two listen for, so they get told by hand —
  // the same reason resetLayersToDefaults() calls them.
  syncWeatherLiveVisibility();
  syncZoneVisibility();

  applySmokeOpacity();
  emit('filter:all');
  applyAllGenModes();
  applyOGFColorBy();
  applyWestTECColorBy();

  buildLayersPanel();
  buildLegends();
  syncViewControls();

  const { center, zoom, pitch = 0, bearing = 0 } = exp.camera;
  const view = {
    center,
    // Aerial imagery thins out past this, and the story would land on blank
    // tiles. Clamped here as well as in the catalogue so a later edit to either
    // one can't reintroduce it.
    zoom: preset.basemap === 'aerial' ? Math.min(zoom, AERIAL_MAX_ZOOM) : zoom,
    pitch,
    bearing,
  };
  if (camera === 'jump') map.jumpTo(view);
  else map.flyTo({ ...view, speed: 0.8, curve: 1.4, essential: true });

  state.experienceId = exp.id;
  state.experienceDirty = false;
  state.experiencePristine = null; // the write below records the fresh snapshot
  writeUrlState();
  return exp;
}

// Dismisses the story without disturbing the map — "Explore Freely". The view
// stays exactly as the story left it; only the card and the `exp` link go.
export function endExperience() {
  if (!state.experienceId) return;
  state.experienceId = null;
  state.experienceDirty = false;
  state.experiencePristine = null;
  writeUrlState();
  emit('exp:ended');
}

// Re-applies the active story after the user has edited their way out of it.
export function restoreExperience(): MapExperience | null {
  return state.experienceId ? applyExperience(state.experienceId) : null;
}

export function flyToHighlight(h: ExperienceHighlight) {
  state.map?.flyTo({ center: h.coordinates, zoom: 11, speed: 0.9, essential: true });
}

// Mirrors the preset onto the basemap radios and 3D checkboxes, which are wired
// to fire only on user input and would otherwise still show the reset defaults.
function syncViewControls() {
  const basemap = document.querySelector<HTMLInputElement>(
    `input[type=radio][name=basemap][value="${state.basemap}"]`);
  if (basemap) basemap.checked = true;
  const projection = document.querySelector<HTMLInputElement>(
    `input[type=radio][name=projection][value="${state.projection}"]`);
  if (projection) projection.checked = true;
  for (const [elId, on] of [
    ['terrain3dToggle', state.terrain3d],
    ['buildings3dToggle', state.buildings3d],
    ['hillshadeToggle', state.hillshade],
  ] as const) {
    const el = document.getElementById(elId) as HTMLInputElement | null;
    if (el) el.checked = on;
  }
}
