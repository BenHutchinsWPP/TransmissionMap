// ─── Draw + edit mode + color-picker wiring ───────────────────────────────────
// Deps: state.js, user-data-geom.js, user-data.js (commitUserData() after every
// draw edit; saveUserData() after a colour pick, which repaints its swatch in
// place so an open picker survives a drag; restoreDrawnFeatures() once
// MapboxDraw and its draw.* listeners are attached, to replay shapes loaded
// from storage before this lazy chunk was ready), user-data-colors.js,
// tool-mode.js (deactivate measure tool without importing measure.js → avoids
// a circular dep), layers/layer-plan.js (setMapLayerVisibility). MapboxDraw
// API calls fire no draw.* events, so an edit made through the API saves
// explicitly.
// initDraw() is idempotent. In view mode it answers Draw's own hit-tests empty
// (skipStaticHitTests) — static shapes take no input — and syncDrawLayers()
// keeps only the current mode's fill/line layers shown (each shown run costs
// a terrain pass per frame under 3D terrain).

import MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { IControl, GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import { state } from '../state.js';
import { showFeatureInfo, clearFeatureInfo } from './user-data-geom.js';
import { clearUserHighlight, commitUserData, saveUserData, restoreDrawnFeatures } from './user-data.js';
import { toolHooks } from '../tool-mode.js';
import { drawnFeatureColor, colorPickerInner } from './user-data-colors.js';
import { setMapLayerVisibility } from '../layers/layer-plan.js';

type DrawFeature = GeoJSON.Feature & { id: string };
type DrawFeatureEvent<Type extends string> = {
  target: MapLibreMap;
  type: Type;
  features: DrawFeature[];
};

declare module 'maplibre-gl' {
  interface Map {
    on<T extends keyof DrawEventType>(
      type: T,
      listener: (event: DrawEventType[T]) => void,
    ): { unsubscribe(): void };
  }
}

type DrawEventType = {
  'draw.create': DrawFeatureEvent<'draw.create'>;
  'draw.update': DrawFeatureEvent<'draw.update'> & { action: string };
  'draw.delete': DrawFeatureEvent<'draw.delete'>;
  'draw.selectionchange': DrawFeatureEvent<'draw.selectionchange'> & { points: GeoJSON.Feature<GeoJSON.Point>[] };
};

// Fills and lines come first: under 3D terrain MapLibre drapes each run of
// fill/line layers in its own pass over the terrain, every frame, so Draw's
// draped layers form one run per source (cold, hot) rather than one per gap.
function drawStyles() {
  const ORANGE = '#f97316';
  const BLUE   = '#3b82f6';
  const COLOR  = ['coalesce', ['get', 'user_color'], ORANGE];
  const LABEL      = ['coalesce', ['get', 'user_name'], ''];
  // OFM glyph server serves single-font Noto Sans stacks only (see constants.ts).
  const LABEL_FONT = ['Noto Sans Regular'];
  const LABEL_SIZE = ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13, 18, 15];
  const LABEL_PAINT = { 'text-color': '#1a1a2e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'text-halo-blur': 0.5 };
  return [
    { id: 'gl-draw-polygon-fill-inactive',       type: 'fill',   filter: ['all',['==','active','false'],['==','$type','Polygon'],['!=','mode','static']], paint: { 'fill-color': COLOR, 'fill-outline-color': COLOR, 'fill-opacity': 0.35 } },
    { id: 'gl-draw-polygon-fill-active',         type: 'fill',   filter: ['all',['==','active','true'], ['==','$type','Polygon']], paint: { 'fill-color': BLUE,   'fill-outline-color': BLUE,   'fill-opacity': 0.35 } },
    { id: 'gl-draw-polygon-fill-static',         type: 'fill',   filter: ['all',['==','mode','static'],['==','$type','Polygon']], paint: { 'fill-color': COLOR, 'fill-outline-color': COLOR, 'fill-opacity': 0.35 } },
    { id: 'gl-draw-polygon-stroke-inactive',     type: 'line',   filter: ['all',['==','active','false'],['==','$type','Polygon'],['!=','mode','static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-polygon-stroke-active',       type: 'line',   filter: ['all',['==','active','true'], ['==','$type','Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': BLUE,   'line-width': 2 } },
    { id: 'gl-draw-line-inactive',               type: 'line',   filter: ['all',['==','active','false'],['==','$type','LineString'],['!=','mode','static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-line-active',                 type: 'line',   filter: ['all',['==','active','true'], ['==','$type','LineString']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': BLUE,   'line-width': 2 } },
    { id: 'gl-draw-polygon-stroke-static',       type: 'line',   filter: ['all',['==','mode','static'],['==','$type','Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-line-static',                 type: 'line',   filter: ['all',['==','mode','static'],['==','$type','LineString']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-polygon-midpoint',            type: 'circle', filter: ['all',['==','$type','Point'],['==','meta','midpoint']], paint: { 'circle-radius': 4, 'circle-color': BLUE } },
    { id: 'gl-draw-polygon-and-line-vertex-stroke-inactive', type: 'circle', filter: ['all',['==','meta','vertex'],['==','$type','Point'],['!=','mode','static']], paint: { 'circle-radius': 6, 'circle-color': '#fff' } },
    { id: 'gl-draw-polygon-and-line-vertex-inactive',        type: 'circle', filter: ['all',['==','meta','vertex'],['==','$type','Point'],['!=','mode','static']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
    { id: 'gl-draw-point-point-stroke-inactive', type: 'circle', filter: ['all',['==','active','false'],['==','$type','Point'],['==','meta','feature'],['!=','mode','static']], paint: { 'circle-radius': 6, 'circle-opacity': 1, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-inactive',              type: 'circle', filter: ['all',['==','active','false'],['==','$type','Point'],['==','meta','feature'],['!=','mode','static']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
    { id: 'gl-draw-point-stroke-active',         type: 'circle', filter: ['all',['==','$type','Point'],['==','active','true'],['!=','meta','midpoint']], paint: { 'circle-radius': 8, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-active',                type: 'circle', filter: ['all',['==','$type','Point'],['==','active','true'],['!=','meta','midpoint']], paint: { 'circle-radius': 5, 'circle-color': BLUE } },
    { id: 'gl-draw-point-point-stroke-static',   type: 'circle', filter: ['all',['==','mode','static'],['==','$type','Point'],['==','meta','feature']], paint: { 'circle-radius': 6, 'circle-opacity': 1, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-static',                type: 'circle', filter: ['all',['==','mode','static'],['==','$type','Point'],['==','meta','feature']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
    { id: 'gl-draw-label-point',   type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','Point']],
      layout: { 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'text-variable-anchor': ['top','bottom'], 'text-radial-offset': 0.9, 'text-optional': true },
      paint: LABEL_PAINT },
    { id: 'gl-draw-label-line',    type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','LineString']],
      layout: { 'symbol-placement': 'line', 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'symbol-spacing': 400, 'text-max-angle': 30, 'text-keep-upright': true, 'text-optional': true },
      paint: LABEL_PAINT },
    { id: 'gl-draw-label-polygon', type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','Polygon']],
      layout: { 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'text-optional': true },
      paint: LABEL_PAINT },
  ];
}

const StaticMode = {
  onSetup()               { return {}; },
  onStop()                {},
  onTrash()               {},
  onCombineFeatures()     {},
  onUncombineFeatures()   {},
  toDisplayFeatures(state: unknown, geojson: GeoJSON.Feature, display: (f: GeoJSON.Feature) => void) {
    if (geojson.properties) geojson.properties.mode = 'static';
    display(geojson);
  },
};

// MapboxDraw hit-tests its own layers on every mousemove, mousedown and
// mouseup, in every mode. In view mode its shapes are 'static' and take no
// input, so nothing reads the answer — yet each query still runs, and under
// 3D terrain projects its box onto the ground. A query naming only Draw's
// layers (gl-draw-*.cold/.hot) comes from Draw alone, so view mode answers it
// empty.
function skipStaticHitTests(map: MapLibreMap) {
  const query = map.queryRenderedFeatures.bind(map) as (...a: unknown[]) => MapGeoJSONFeature[];
  map.queryRenderedFeatures = ((...args: unknown[]) => {
    const layers = (args[1] as { layers?: string[] } | undefined)?.layers;
    if (state.editMode === 'view' && layers?.length && layers.every(id => id.startsWith('gl-draw-')))
      return [];
    return query(...args);
  }) as MapLibreMap['queryRenderedFeatures'];
}

// Each draped run costs its terrain pass even when empty, and hidden layers
// form no run — so only the runs this mode can paint stay shown: the edit
// layers in edit mode, the static ones in view mode while a shape exists.
const DRAPED_DRAW_LAYERS = drawStyles()
  .filter(s => s.type === 'fill' || s.type === 'line')
  .flatMap(s => [`${s.id}.cold`, `${s.id}.hot`]);

function syncDrawLayers() {
  const map = state.map, draw = state.draw;
  if (!map || !draw) return;
  const edit = state.editMode === 'edit';
  const anyShape = draw.getAll().features.length > 0;
  for (const id of DRAPED_DRAW_LAYERS) {
    if (!map.getLayer(id)) continue;
    const isStatic = id.includes('-static.');
    setMapLayerVisibility(map, id, (edit ? !isStatic : isStatic && anyShape) ? 'visible' : 'none');
  }
}

export function initDraw() {
  if (!state.map || state.draw) return;
  toolHooks.exitEdit = () => setMode('view');
  state.draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: drawStyles(),
    userProperties: true,
    modes: { ...MapboxDraw.modes, static: StaticMode as unknown as MapboxDraw.DrawCustomMode },
  });
  state.map.addControl(state.draw as unknown as IControl);
  skipStaticHitTests(state.map);
  // Draw re-renders by setting its sources' data (and re-adds its layers after
  // a style change), so a shape added or removed through the API is seen here.
  state.map.on('sourcedata', e => {
    if (e.sourceId?.startsWith('mapbox-gl-draw-')) syncDrawLayers();
  });
  if (state.map.loaded()) {
    if (state.editMode === 'view') state.draw.changeMode('static');
  } else {
    state.map.once('load', () => {
      if (state.editMode === 'view') state.draw!.changeMode('static');
    });
  }

  state.map.on('draw.create', e => {
    for (const f of e.features) {
      state.draw!.setFeatureProperty(f.id, 'color', state.drawDefaultColor);
      const updated = state.draw!.get(f.id);
      if (updated) state.draw!.add(updated);
    }
    commitUserData();
  });
  state.map.on('draw.update', onDrawChange);
  state.map.on('draw.delete', onDrawChange);

  state.map.on('draw.selectionchange', e => {
    if (state.editMode === 'view') {
      if (state.draw) state.draw.changeMode('static');
      return;
    }
    const f = e.features.length === 1 ? e.features[0] : null;
    state.selectedDrawId = f ? f.id : null;
    setDefaultPickerDisplay(f ? drawnFeatureColor(f) : state.drawDefaultColor);
    if (f) showFeatureInfo(f.geometry); else clearFeatureInfo();
  });

  // After the listeners, so drawing saves even if a stored shape is rejected.
  restoreDrawnFeatures();
}

function onDrawChange() {
  commitUserData();
  if (state.selectedDrawId && state.draw) {
    const f = state.draw.get(state.selectedDrawId);
    if (f) showFeatureInfo(f.geometry); else clearFeatureInfo();
  }
  if (state.userHighlightKey && state.draw) {
    const f = state.draw.get(state.userHighlightKey);
    if (f) (state.map?.getSource('user-highlight') as GeoJSONSource)
      ?.setData({ type: 'FeatureCollection', features: [f] });
  }
}

export function setMode(mode: string) {
  if (mode === 'edit' && state.measure.active) toolHooks.deactivateMeasure();
  state.editMode = mode;
  document.getElementById('modeViewBtn')?.classList.toggle('mode-btn--active', mode === 'view');
  document.getElementById('modeEditBtn')?.classList.toggle('mode-btn--active', mode === 'edit');
  const isEdit = mode === 'edit';
  const addBtn = document.getElementById('menuAddBtn');
  const colorPicker = document.getElementById('drawColorPicker');
  const measureBtn = document.getElementById('measureBtn');
  if (addBtn) addBtn.hidden = !isEdit;
  if (colorPicker) colorPicker.hidden = !isEdit;
  if (measureBtn) measureBtn.hidden = isEdit; // no measure tool in edit mode
  if (state.draw) {
    state.draw.changeMode((mode === 'view' ? 'static' : 'simple_select') as string);
  }
  syncDrawLayers();
  state.selectedDrawId = null;
  setDefaultPickerDisplay(state.drawDefaultColor);
  clearUserHighlight();
}

export function startDraw(drawMode: string) {
  if (state.editMode !== 'edit') return;
  state.popup?.remove();
  if (state.draw) state.draw.changeMode(drawMode);
}

function setDefaultPickerDisplay(color: string) {
  const el = document.getElementById('drawColorPicker');
  if (el) el.innerHTML = colorPickerInner(color);
}

export function applyColorPick(picker: HTMLElement, color: string) {
  if (picker.dataset.target === 'default') {
    if (state.selectedDrawId && state.draw?.get(state.selectedDrawId)) {
      const id = state.selectedDrawId;
      setDrawnFeatureColor(id, color);
      state.draw!.changeMode('simple_select', { featureIds: [id] });
    } else {
      state.drawDefaultColor = color;
    }
  } else if (picker.dataset.target === 'feature') {
    setDrawnFeatureColor(picker.dataset.featureId!, color);
  }
  const btn = picker.querySelector('.color-swatch-btn') as HTMLElement | null;
  if (btn) btn.style.background = color;
  picker.querySelectorAll('.color-opt').forEach(o =>
    (o as HTMLElement).classList.toggle('color-opt--sel', (o as HTMLElement).dataset.color!.toLowerCase() === color.toLowerCase()));
}

function setDrawnFeatureColor(id: string, hex: string) {
  if (!state.draw) return;
  state.draw.setFeatureProperty(id, 'color', hex);
  const f = state.draw.get(id);
  if (f) state.draw.add(f);
  saveUserData();
}
