// ─── 3D terrain + 3D buildings (optional) ─────────────────────────────────────
// Raster-dem ground-plane elevation (AWS Terrain Tiles) and OFM building
// fill-extrusion, each toggled independently. Both only become visible once
// the camera is pitched, so enabling either auto-tilts the map.
// Deps: state.js (state + TERRAIN_* constants). Called from ui/ui.ts (toggles),
// map.ts (apply3dFromState at load-end, ensureBuildingsLayer after the OFM
// style graft resolves).

import { state, TERRAIN_TILE_URL, TERRAIN_ATTRIB_SHORT, TERRAIN_EXAGGERATION } from './state.js';
import { maybeShowRotateHint } from './terrain-hint.js';

const TERRAIN_SOURCE_ID = 'terrain-dem';
const BUILDINGS_LAYER_ID = 'buildings-3d';
const AUTO_TILT_PITCH = 45;

function easePitch(target: number) {
  if (!state.map || state.map.getPitch() === target) return;
  state.map.easeTo({ pitch: target, duration: target > 0 ? 800 : 600 });
}

// Auto-tilt on enabling either toggle (so the effect is immediately visible);
// ease back to flat only once BOTH are off, restoring the map's default
// guaranteed-2D reading mode.
function syncPitch() {
  if (state.terrain3d || state.buildings3d) {
    if (state.map && state.map.getPitch() === 0) easePitch(AUTO_TILT_PITCH);
  } else {
    easePitch(0);
  }
}

export function setTerrain3d(on: boolean) {
  state.terrain3d = on;
  if (!state.map) return;
  if (on) {
    if (!state.map.getSource(TERRAIN_SOURCE_ID)) {
      state.map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem',
        tiles: [TERRAIN_TILE_URL],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: TERRAIN_ATTRIB_SHORT,
      });
    }
    state.map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
  } else {
    state.map.setTerrain(null);
  }
  syncPitch();
}

// Inserted right above the topmost basemap layer ("aerial-bg") and below
// whatever overlay/infra layer currently follows it — works whether this runs
// before addAllLayers() (nothing follows yet; plain append lands in the same
// spot) or after (the OFM style fetch resolved late), since overlays must
// always render above extruded buildings, not be occluded by them.
function buildingsBeforeId(): string | undefined {
  const layers = state.map?.getStyle()?.layers ?? [];
  const i = layers.findIndex(l => l.id === 'aerial-bg');
  return i >= 0 ? layers[i + 1]?.id : undefined;
}

export function ensureBuildingsLayer() {
  if (!state.map || !state.buildings3d) return;
  if (state.map.getLayer(BUILDINGS_LAYER_ID)) return;
  if (!state.map.getSource('ofm-openmaptiles')) return; // OFM style not grafted yet
  state.map.addLayer({
    id: BUILDINGS_LAYER_ID,
    type: 'fill-extrusion',
    source: 'ofm-openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    // hide_3d marks building PARTS whose parent outline already renders —
    // extruding both would double up geometry at the same footprint.
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      'fill-extrusion-color': '#aab0b6',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  }, buildingsBeforeId());
}

export function setBuildings3d(on: boolean) {
  state.buildings3d = on;
  if (!state.map) return;
  ensureBuildingsLayer();
  if (state.map.getLayer(BUILDINGS_LAYER_ID)) {
    state.map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', on ? 'visible' : 'none');
  }
  syncPitch();
}

// Restores both toggles from state (e.g. read from the URL) once the map and
// its base layers are ready. Called once at load, after addAllLayers().
export function apply3dFromState() {
  if (state.terrain3d) setTerrain3d(true);
  if (state.buildings3d) setBuildings3d(true);
  if (state.terrain3d || state.buildings3d) maybeShowRotateHint();
}
