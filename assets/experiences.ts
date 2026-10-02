// ─── Map Experiences runtime controller ───────────────────────────────────────
// Role: turns a MapExperience preset (src/registry/experiences.ts) into live map
//       state — layers, filters, basemap, 3D and camera — and tracks which story
//       is active. Owns no DOM: the gallery and the floating story card live in
//       ui/ui-experiences.ts, which is the only module that imports this one.
//
// A preset reaches the map in the shape a shared link parses to:
// experienceUrlState() renders it as UrlStateData and view-state.ts's
// applyView() puts that on the live map — the same path Reset and a link take,
// so a story starts from the defaults and never inherits the last one's
// leftovers. A field a preset wants therefore has to be representable in
// url-state-codec.ts — experiences.test.ts round-trips every catalogue entry
// through the codec to keep the two shapes in step. Note applyView() hides a
// live layer rather than shutting its feed down — a poller keeps running for
// the rest of the session once its source exists (live-staleness.ts gates
// refetch on the source, not on visibility).
//
// The pristine/edited split lives in url-state.ts: this module records the id
// and clears the snapshot, and the next writeUrlState() decides whether the link
// still names the story. See docs/url-state.md.
//
// Deps: state.js, view-state.js (applyView, CameraMode), url-state.js
//       (writeUrlState), url-state-codec.js (defaultView, UrlStateData),
//       state-bus.js, registry/experiences.js (the catalogue),
//       registry/index.js (LAYERS, for the gallery badges).

import { state } from './state.js';
import {
  EXPERIENCES, experienceById, AERIAL_MAX_ZOOM,
  type MapExperience, type ExperienceHighlight,
} from '../src/registry/experiences.js';
import { LAYERS } from '../src/registry/index.js';
import { applyView, type CameraMode } from './view-state.js';
import { writeUrlState } from './url-state.js';
import { defaultView, type UrlStateData } from './url-state-codec.js';
import { emit } from './state-bus.js';

export type { CameraMode };

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

// Renders a curated preset in the shape a shared link carries, so the same
// values reach the map whether they came from the catalogue or from a hash.
// Fields a preset never speaks for keep their defaults, and drop out of the
// formatted link.
export function experienceUrlState(preset: MapExperience['state']): UrlStateData {
  const view = defaultView();
  for (const layerId of preset.layersOff ?? []) view.layerVisibility[layerId] = false;
  for (const layerId of preset.layersOn ?? []) view.layerVisibility[layerId] = true;
  for (const [key, ids] of Object.entries(preset.legendFilters ?? {})) view.legendFilters[key] = new Set(ids);
  for (const [layerId, ids] of Object.entries(preset.layerFilters ?? {})) view.layerFilters[layerId] = new Set(ids);
  Object.assign(view.genMode, preset.genMode);
  if (preset.ogfColorBy) view.ogfColorBy = preset.ogfColorBy;
  if (preset.westtecColorBy) view.westtecColorBy = preset.westtecColorBy;
  if (preset.weatherVar) view.weatherVar = preset.weatherVar;
  if (preset.smokeOpacity !== undefined) view.smokeOpacity = preset.smokeOpacity;
  if (preset.basemap) view.basemap = preset.basemap;
  view.terrain3d = !!preset.terrain3d;
  view.hillshade = !!preset.hillshade;
  return view;
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

  // Halt whatever the last flyTo is still doing before anything else touches
  // the camera, or its easing keeps running over the new view.
  state.map.stop();

  // Cleared up front so the reset's own url:write can't be read as the user
  // editing their way out of the story that is being replaced.
  state.experienceId = null;
  state.experienceDirty = false;
  state.experiencePristine = null;

  const preset = exp.state;
  const { center, zoom, pitch = 0, bearing = 0 } = exp.camera;
  applyView(experienceUrlState(preset), {
    center,
    // Aerial imagery thins out past this, and the story would land on blank
    // tiles. Clamped here as well as in the catalogue so a later edit to either
    // one can't reintroduce it.
    zoom: preset.basemap === 'aerial' ? Math.min(zoom, AERIAL_MAX_ZOOM) : zoom,
    pitch,
    bearing,
    mode: camera,
  });

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
