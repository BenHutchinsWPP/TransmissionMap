// ─── 3D terrain + 3D buildings (optional) ─────────────────────────────────────
// Raster-dem ground-plane elevation (AWS Terrain Tiles) and OFM building
// fill-extrusion, each toggled independently. Both only become visible once
// the camera is pitched, so enabling either auto-tilts the map.
// Also owns the per-frame memo on MapLibre's Terrain.pointCoordinate, which
// every unproject and every hit-test under raised ground goes through.
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

// The v5 baseline measured Terrain.pointCoordinate() answering "what ground
// coordinate is under this screen pixel" with a blocking gl.readPixels on the
// terrain coords framebuffer — one GPU stall, ~13-15ms once the GPU is busy.
// v6.2 still performs that pointCoordinate readPixels; its DEM lookup/transform
// cache does not replace this exact-screen-point memo. Every unproject routes
// through it while terrain is on, and queryRenderedFeatures re-asks it for the
// SAME handful of points once per source (SourceCache.tilesIn projects the
// query box itself), so one click across ~40 sources paid for ~400 stalls.
//
// The framebuffer only changes when the camera matrix changes or tiles reload,
// which MapLibre itself relies on (Painter.maybeDrawDepth's dirty check), so
// one answer per point per frame is enough. Keys are the exact screen
// coordinates, not rounded: the redundancy being collapsed is literally the
// same numbers repeated per source, so exact keys hit just as often without
// merging two genuinely different pixels.
const coordCache = new Map<string, unknown>();
let coordCacheBound = false;
const wrapped = new WeakSet<object>();

function memoizePointCoordinate() {
  const map = state.map, terrain = map?.terrain;
  // setTerrain() builds a fresh Terrain each time it is switched on, so the
  // wrap has to be re-applied per instance; the cache and its listeners are
  // module-level and bound once.
  if (!map || !terrain || wrapped.has(terrain)) return;
  wrapped.add(terrain);
  coordCache.clear();
  const raw = terrain.pointCoordinate.bind(terrain);
  terrain.pointCoordinate = (p) => {
    const key = p.x + ',' + p.y;
    // has(), not a falsy check: the real function returns null for a pixel
    // showing sky rather than ground, and that answer is worth caching too.
    if (!coordCache.has(key)) coordCache.set(key, raw(p));
    return coordCache.get(key) as ReturnType<typeof raw>;
  };
  if (!coordCacheBound) {
    coordCacheBound = true;
    map.on('render', () => coordCache.clear());
    map.on('move', () => coordCache.clear());
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
    memoizePointCoordinate();
  } else {
    state.map.setTerrain(null);
  }
  syncPitch();
}

// Inserted right above the topmost basemap layer ("aerial-bg") and below
// whatever currently follows it — works whether this runs before addAllLayers()
// (nothing follows yet; plain append lands in the same spot) or after (the OFM
// style fetch resolved late), since overlays must always render above extruded
// buildings, not be occluded by them.
//
// On Aerial what follows "aerial-bg" is now the first cloned road layer of the
// map.ts overlay group, so that overlay's roads and labels paint above the
// extrusions — same rule, and the same way the Light basemap already behaves.
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
