// ─── 3D terrain + 3D buildings + hillshade (optional) ─────────────────────────
// Three basemap-relief toggles, each independent: raster-dem ground-plane
// elevation (AWS Terrain Tiles) via setTerrain(), OFM building fill-extrusion,
// and a 2D hillshade layer. Terrain and buildings only become visible once the
// camera is pitched, so enabling either auto-tilts the map; hillshade renders
// flat at pitch 0 and never touches the camera.
// Also caches MapLibre's per-frame terrain/drape tile matching
// (cacheTerrainCoords), which otherwise recomputes the same answer every frame.
// Owns the terrain tuning: TERRAIN_EXAGGERATION and the short on-map credit
// TERRAIN_ATTRIB_SHORT (index.html carries the full wording).
// Deps: state.js (state), constants.js (TERRAIN_TILE_URL), terrain-hint.js
// (maybeShowRotateHint). Called from ui/ui.ts (toggles),
// map.ts (apply3dFromState at load-end), basemap.ts (ensureBuildingsLayer after the OFM
// style graft resolves, repositionHillshade from switchBasemap).

import { state } from './state.js';
import { TERRAIN_TILE_URL } from './constants.js';
import { maybeShowRotateHint } from './terrain-hint.js';

const TERRAIN_SOURCE_ID = 'terrain-dem';
const BUILDINGS_LAYER_ID = 'buildings-3d';
const AUTO_TILT_PITCH = 45;

// Short on-map credit for the MapLibre attribution control — the required
// tilezen/joerd wording ("United States 3DEP ... U.S. Geological Survey") is
// long enough to overlap other floating UI as the only active source with
// bespoke (non-deduped) attribution while terrain is on. The full wording
// lives instead in the Data Credits dialog (index.html,
// data-source-credit="usgs-terrain" — do not reword that entry), matching
// every other dataset's short-in-map/full-in-dialog split (LayerDef.data.credit).
const TERRAIN_ATTRIB_SHORT = "USGS terrain";
// True to scale: a ridge stands as tall against its valley on screen as it does
// on the ground, so heights read as measurements rather than as an effect.
// Relief contrast is the hillshade's job instead (terrain.ts), which sharpens
// slopes without moving any elevation.
const TERRAIN_EXAGGERATION = 1;

// A second raster-dem source over the same tile URL as terrain-dem, kept
// separate because setTerrain() re-tunes the source it binds: that source's
// tile manager switches to a 512px covering size with roundZoom off, which is
// the resolution a hillshade layer reading it would get. MapLibre
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

// Every frame, MapLibre matches each visible tile of every draped source
// against every terrain tile (TerrainTileManager._getTerrainCoordsForRegularTile),
// allocating a matrix per pair — ~4 ms a frame at street level with a dozen
// draped sources. The answer depends only on the source tile's key and the set
// of renderable terrain tiles, and callers only read it, so it is kept until
// that set changes. setTerrain() builds a fresh Terrain each time, hence the
// per-instance wrap.
const coordsWrapped = new WeakSet<object>();

function cacheTerrainCoords() {
  const tm = state.map?.terrain?.tileManager;
  if (!tm || coordsWrapped.has(tm)) return;
  coordsWrapped.add(tm);
  const raw = tm._getTerrainCoordsForRegularTile.bind(tm);
  const cache = new Map<string, ReturnType<typeof raw>>();
  let tileSet = '';
  tm._getTerrainCoordsForRegularTile = (tileID) => {
    const set = tm._renderableTilesKeys.join();
    if (set !== tileSet) { cache.clear(); tileSet = set; }
    let coords = cache.get(tileID.key);
    if (!coords) cache.set(tileID.key, coords = raw(tileID));
    return coords;
  };
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
    cacheTerrainCoords();
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
// basemap.ts overlay group, so that overlay's roads and labels paint above the
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
