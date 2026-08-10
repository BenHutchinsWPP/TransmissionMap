// ─── 3D terrain + 3D buildings + hillshade (optional) ─────────────────────────
// Three basemap-relief toggles, each independent: raster-dem ground-plane
// elevation (AWS Terrain Tiles) via setTerrain(), OFM building fill-extrusion,
// and a 2D hillshade layer. Terrain and buildings only become visible once the
// camera is pitched, so enabling either auto-tilts the map; hillshade renders
// flat at pitch 0 and never touches the camera.
// Also owns the per-frame memo on MapLibre's Terrain.pointCoordinate, which
// every unproject and every hit-test under raised ground goes through.
// Deps: state.js (state + TERRAIN_* constants). Called from ui/ui.ts (toggles),
// map.ts (apply3dFromState at load-end, ensureBuildingsLayer after the OFM
// style graft resolves, repositionHillshade from switchBasemap).

import { state, TERRAIN_TILE_URL, TERRAIN_ATTRIB_SHORT, TERRAIN_EXAGGERATION } from './state.js';
import { maybeShowRotateHint } from './terrain-hint.js';

const TERRAIN_SOURCE_ID = 'terrain-dem';
const BUILDINGS_LAYER_ID = 'buildings-3d';
const AUTO_TILT_PITCH = 45;

// A second raster-dem source over the same tile URL as terrain-dem, kept
// separate because setTerrain() re-tunes the source it binds: that source's
// tile manager switches to a 512px covering size with roundZoom off, which is
// the resolution a hillshade layer reading it would get. MapLibre 6.2
// warnOnce's on the shared case for exactly that reason.
//
// Two consequences worth knowing. A hillshade layer at visibility 'none' asks
// for no tiles, so this source costs nothing while the toggle is off. And
// because the two sources resolve different DEM zooms for the same camera
// (512/roundZoom-off vs 256/roundZoom-on), running 3D Terrain and Hillshade
// together fetches two sets of elevation tiles rather than sharing one.
const HILLSHADE_SOURCE_ID = 'hillshade-dem';
const HILLSHADE_LAYER_ID = 'terrain-hillshade';

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

function ensureDemSource(id: string) {
  if (!state.map || state.map.getSource(id)) return;
  state.map.addSource(id, {
    type: 'raster-dem',
    tiles: [TERRAIN_TILE_URL],
    tileSize: 256,
    encoding: 'terrarium',
    maxzoom: 15,
    attribution: TERRAIN_ATTRIB_SHORT,
  });
}

// Terrain runs under both projections. MapLibre warns that it is not fully
// supported on the globe's vertical perspective — elevation sits out of
// `recalculateZoomAndCenter`, and `calculateFogMatrix` returns identity there —
// but the fog that would consume that matrix is itself skipped under globe, so
// the drape renders.
export function setTerrain3d(on: boolean) {
  state.terrain3d = on;
  if (!state.map) return;
  if (on) {
    ensureDemSource(TERRAIN_SOURCE_ID);
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
//
// Hillshade is skipped when it is the layer sitting there: it shades the
// ground plane the extrusions rise from, so buildings belong above it. The
// skip and the hillshade fallback in hillshadeBeforeId() are the two halves of
// that ordering, so it holds whichever toggle is switched on first.
function buildingsBeforeId(): string | undefined {
  const layers = state.map?.getStyle()?.layers ?? [];
  const i = layers.findIndex(l => l.id === 'aerial-bg');
  if (i < 0) return undefined;
  const next = layers[i + 1];
  return (next?.id === HILLSHADE_LAYER_ID ? layers[i + 2] : next)?.id;
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

// Sit under the active basemap's own linework and labels so type stays
// legible. The OFM vector styles graft in below the raster basemaps and the
// Aerial roads/places overlay clones graft in above them, so the anchor is the
// first `ofm-` line/symbol layer currently visible — on Light and Dark that
// lands just under `waterway`, i.e. above the landcover and water fills and
// below every road, boundary and label.
//
// Raster basemaps (Street, Topo) carry their labels inside the tile image and
// fall back to the overlay anchor, which is above the raster. That fallback
// prefers the buildings layer when it exists, so hillshade stays under the
// extrusions there the same way it does on the vector basemaps.
function hillshadeBeforeId(): string | undefined {
  const layers = state.map?.getStyle()?.layers ?? [];
  const hit = layers.find(l =>
    l.id.startsWith('ofm-') &&
    (l.type === 'line' || l.type === 'symbol') &&
    l.layout?.visibility !== 'none');
  if (hit) return hit.id;
  return state.map?.getLayer(BUILDINGS_LAYER_ID) ? BUILDINGS_LAYER_ID : 'basemap-overlay-top';
}

export function setHillshade(on: boolean) {
  state.hillshade = on;
  if (!state.map) return;
  if (on && !state.map.getLayer(HILLSHADE_LAYER_ID)) {
    ensureDemSource(HILLSHADE_SOURCE_ID);
    state.map.addLayer({
      id: HILLSHADE_LAYER_ID,
      type: 'hillshade',
      source: HILLSHADE_SOURCE_ID,
      paint: {
        // Past 0.5 the shader's slope curve keeps expanding contrast even though
        // its overall multiplier has already saturated, so this is the lever for
        // relief that reads without touching a single elevation value.
        'hillshade-exaggeration': 0.6,
        // Warm brown shadows read as earth under sunlight where a neutral gray
        // reads as overcast, and they sit better against the green and tan of
        // the raster basemaps.
        'hillshade-shadow-color': '#473B24',
        // Highlight and accent carry the other two thirds of the relief: the
        // highlight picks out sun-facing slopes, the accent creases ridges and
        // valleys by slope magnitude. Both stay under full strength so the
        // shading holds up over raster basemaps (Street, Topo), whose labels are
        // baked into the tile image.
        'hillshade-highlight-color': 'rgba(255,255,255,0.9)',
        'hillshade-accent-color': 'rgba(0,0,0,0.9)',
        // Pin the light to north so relief doesn't re-light as the map rotates
        // (the spec default is `viewport`). Under 3D Terrain this is also the
        // anchor that stays consistent tile to tile: hillshade is draped through
        // the render-to-texture cache, which re-renders on tile changes rather
        // than on bearing changes, so a viewport-anchored light would refresh
        // only for the tiles that happened to reload.
        'hillshade-illumination-anchor': 'map',
      },
    }, hillshadeBeforeId());
  }
  if (state.map.getLayer(HILLSHADE_LAYER_ID)) {
    state.map.setLayoutProperty(HILLSHADE_LAYER_ID, 'visibility', on ? 'visible' : 'none');
  }
}

// Called when the basemap changes so the anchor tracks the newly visible
// basemap group, and so a late-resolving OFM graft self-corrects.
export function repositionHillshade() {
  if (!state.map?.getLayer(HILLSHADE_LAYER_ID)) return;
  state.map.moveLayer(HILLSHADE_LAYER_ID, hillshadeBeforeId());
}

// Restores all three toggles from state (e.g. read from the URL) once the map
// and its base layers are ready. Called once at load, after addAllLayers().
export function apply3dFromState() {
  if (state.terrain3d) setTerrain3d(true);
  if (state.buildings3d) setBuildings3d(true);
  if (state.hillshade) setHillshade(true);
  if (state.terrain3d || state.buildings3d) maybeShowRotateHint();
}
