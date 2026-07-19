// ─── Draw + edit mode + color-picker wiring ───────────────────────────────────
// Deps: state.js, user-data-geom.js, user-data.js (also calls restoreDrawnFeatures()
// after attaching MapboxDraw, to replay shapes loaded from storage before this
// lazy chunk was ready), user-data-colors.js, tool-mode.js (deactivate measure
// tool without importing measure.js → avoids a circular dep).

import MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { IControl, GeoJSONSource } from "maplibre-gl";
import { state } from '../state.js';
import { showFeatureInfo, clearFeatureInfo } from './user-data-geom.js';
import { renderMyDataTab, clearUserHighlight, saveUserData, restoreDrawnFeatures } from './user-data.js';
import { deactivateMeasureTool, registerEditExit } from '../tool-mode.js';
import { drawnFeatureColor, colorPickerInner } from './user-data-colors.js';

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
    { id: 'gl-draw-polygon-midpoint',            type: 'circle', filter: ['all',['==','$type','Point'],['==','meta','midpoint']], paint: { 'circle-radius': 4, 'circle-color': BLUE } },
    { id: 'gl-draw-polygon-stroke-inactive',     type: 'line',   filter: ['all',['==','active','false'],['==','$type','Polygon'],['!=','mode','static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-polygon-stroke-active',       type: 'line',   filter: ['all',['==','active','true'], ['==','$type','Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': BLUE,   'line-width': 2 } },
    { id: 'gl-draw-line-inactive',               type: 'line',   filter: ['all',['==','active','false'],['==','$type','LineString'],['!=','mode','static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-line-active',                 type: 'line',   filter: ['all',['==','active','true'], ['==','$type','LineString']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': BLUE,   'line-width': 2 } },
    { id: 'gl-draw-polygon-and-line-vertex-stroke-inactive', type: 'circle', filter: ['all',['==','meta','vertex'],['==','$type','Point'],['!=','mode','static']], paint: { 'circle-radius': 6, 'circle-color': '#fff' } },
    { id: 'gl-draw-polygon-and-line-vertex-inactive',        type: 'circle', filter: ['all',['==','meta','vertex'],['==','$type','Point'],['!=','mode','static']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
    { id: 'gl-draw-point-point-stroke-inactive', type: 'circle', filter: ['all',['==','active','false'],['==','$type','Point'],['==','meta','feature'],['!=','mode','static']], paint: { 'circle-radius': 6, 'circle-opacity': 1, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-inactive',              type: 'circle', filter: ['all',['==','active','false'],['==','$type','Point'],['==','meta','feature'],['!=','mode','static']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
    { id: 'gl-draw-point-stroke-active',         type: 'circle', filter: ['all',['==','$type','Point'],['==','active','true'],['!=','meta','midpoint']], paint: { 'circle-radius': 8, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-active',                type: 'circle', filter: ['all',['==','$type','Point'],['==','active','true'],['!=','meta','midpoint']], paint: { 'circle-radius': 5, 'circle-color': BLUE } },
    { id: 'gl-draw-label-point',   type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','Point']],
      layout: { 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'text-variable-anchor': ['top','bottom'], 'text-radial-offset': 0.9, 'text-optional': true },
      paint: LABEL_PAINT },
    { id: 'gl-draw-label-line',    type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','LineString']],
      layout: { 'symbol-placement': 'line', 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'symbol-spacing': 400, 'text-max-angle': 30, 'text-keep-upright': true, 'text-optional': true },
      paint: LABEL_PAINT },
    { id: 'gl-draw-label-polygon', type: 'symbol', filter: ['all',['==','meta','feature'],['==','$type','Polygon']],
      layout: { 'text-field': LABEL, 'text-font': LABEL_FONT, 'text-size': LABEL_SIZE, 'text-optional': true },
      paint: LABEL_PAINT },
    { id: 'gl-draw-polygon-fill-static',         type: 'fill',   filter: ['all',['==','mode','static'],['==','$type','Polygon']], paint: { 'fill-color': COLOR, 'fill-outline-color': COLOR, 'fill-opacity': 0.35 } },
    { id: 'gl-draw-polygon-stroke-static',       type: 'line',   filter: ['all',['==','mode','static'],['==','$type','Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-line-static',                 type: 'line',   filter: ['all',['==','mode','static'],['==','$type','LineString']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-point-point-stroke-static',   type: 'circle', filter: ['all',['==','mode','static'],['==','$type','Point'],['==','meta','feature']], paint: { 'circle-radius': 6, 'circle-opacity': 1, 'circle-color': '#fff' } },
    { id: 'gl-draw-point-static',                type: 'circle', filter: ['all',['==','mode','static'],['==','$type','Point'],['==','meta','feature']], paint: { 'circle-radius': 4, 'circle-color': COLOR } },
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

export function initDraw() {
  if (!state.map) return;
  registerEditExit(() => setMode('view'));
  state.draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: drawStyles(),
    userProperties: true,
    modes: { ...MapboxDraw.modes, static: StaticMode as unknown as MapboxDraw.DrawCustomMode },
  });
  state.map.addControl(state.draw as unknown as IControl);
  restoreDrawnFeatures();
  state.map.once('load', () => { state.draw!.changeMode('static'); });

  state.map.on('draw.create', e => {
    for (const f of e.features) {
      state.draw!.setFeatureProperty(f.id, 'color', state.drawDefaultColor);
    }
    state.draw!.set(state.draw!.getAll());
    renderMyDataTab();
    saveUserData();
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
}

function onDrawChange() {
  renderMyDataTab();
  saveUserData();
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
  if (mode === 'edit' && state.measure.active) deactivateMeasureTool();
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
  state.draw.set(state.draw.getAll());
}

