// ─── Measure tool ─────────────────────────────────────────────────────────────
// Deps: state.js, user-data-geom.js (geom/info), tool-mode.js (exit edit mode
// without importing user-data-draw → breaks the old circular dep).

import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { state } from './state.js';
import { haversineMeters, clearFeatureInfo } from './user-data/user-data-geom.js';
import { exitEdit, registerMeasureDeactivator } from './tool-mode.js';

const MEASURE_EMPTY = { type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] };

function ensureMeasureLayers() {
  if (!state.map || state.map.getSource('measure')) return;
  state.map.addSource('measure', { type: 'geojson', data: MEASURE_EMPTY });
  state.map.addLayer({
    id: 'measure-line', type: 'line', source: 'measure',
    filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'rubber'], false]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 2.5 },
  });
  state.map.addLayer({
    id: 'measure-rubber', type: 'line', source: 'measure',
    filter: ['all', ['==', ['geometry-type'], 'LineString'], ['get', 'rubber']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 },
  });
  state.map.addLayer({
    id: 'measure-points', type: 'circle', source: 'measure',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 4, 'circle-color': '#ffffff',
      'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 2,
    },
  });
}

function measureGeoJSON(hover: [number, number] | null | undefined) {
  const pts = state.measure.points;
  const features: GeoJSON.Feature[] = [];
  if (pts.length >= 2) {
    features.push({ type: 'Feature', properties: { rubber: false },
      geometry: { type: 'LineString', coordinates: pts } });
  }
  if (hover && pts.length >= 1 && !state.measure.finished) {
    features.push({ type: 'Feature', properties: { rubber: true },
      geometry: { type: 'LineString', coordinates: [pts[pts.length - 1], hover] } });
  }
  for (const c of pts) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });
  }
  return { type: 'FeatureCollection' as const, features };
}

function measureTotalMeters(hover: [number, number] | null | undefined) {
  const pts = hover ? [...state.measure.points, hover] : state.measure.points;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversineMeters(pts[i - 1] as number[], pts[i] as number[]);
  return total;
}

function renderMeasure(hover?: [number, number]) {
  ensureMeasureLayers();
  (state.map!.getSource('measure') as GeoJSONSource).setData(measureGeoJSON(hover));
  updateMeasureReadout(hover);
}

function updateMeasureReadout(hover?: [number, number]) {
  const el = document.getElementById('featureInfo');
  if (!el) return;
  if (!state.measure.points.length) {
    el.textContent = '📏 Click map to start measuring';
  } else {
    const m = measureTotalMeters(state.measure.finished ? null : hover);
    el.textContent = `📏 ${(m / 1609.344).toFixed(2)} mi · ${(m / 1000).toFixed(2)} km`;
  }
  el.hidden = false;
}

function onMeasureClick(e: MapMouseEvent) {
  if (state.measure.finished) { state.measure.points = []; state.measure.finished = false; }
  state.measure.points.push([e.lngLat.lng, e.lngLat.lat]);
  renderMeasure();
}

function onMeasureMove(e: MapMouseEvent) {
  if (!state.measure.points.length || state.measure.finished) return;
  renderMeasure([e.lngLat.lng, e.lngLat.lat]);
}

function onMeasureDblClick(e: MapMouseEvent) {
  if (state.measure.finished) return;
  e.preventDefault();
  const pts = state.measure.points;
  if (pts.length >= 2) pts.pop();
  state.measure.finished = true;
  renderMeasure();
}

function onMeasureContext(e: MapMouseEvent) {
  e.preventDefault();
  e.originalEvent?.preventDefault();
  if (!state.measure.points.length) return;
  state.measure.points.pop();
  state.measure.finished = false;
  renderMeasure();
}

function onMeasureKey(e: KeyboardEvent) {
  if (!state.measure.active) return;
  if (e.key === 'Escape') clearMeasure();
}

function clearMeasure() {
  state.measure.points = [];
  state.measure.finished = false;
  (state.map?.getSource('measure') as GeoJSONSource)?.setData(MEASURE_EMPTY);
  updateMeasureReadout();
}

function setMeasureActive(on: boolean) {
  if (on === state.measure.active) return;
  if (!state.map) return;
  state.measure.active = on;

  const btn = document.getElementById('measureBtn');
  btn?.classList.toggle('measure-btn--active', on);
  btn?.setAttribute('aria-pressed', String(on));

  const canvas = state.map.getCanvas();
  if (on) {
    if (state.editMode === 'edit') exitEdit();
    ensureMeasureLayers();
    state.map.doubleClickZoom.disable();
    canvas.style.cursor = 'crosshair';
    state.map.on('click', onMeasureClick);
    state.map.on('mousemove', onMeasureMove);
    state.map.on('dblclick', onMeasureDblClick);
    state.map.on('contextmenu', onMeasureContext);
    updateMeasureReadout();
  } else {
    state.map.off('click', onMeasureClick);
    state.map.off('mousemove', onMeasureMove);
    state.map.off('dblclick', onMeasureDblClick);
    state.map.off('contextmenu', onMeasureContext);
    state.map.doubleClickZoom.enable();
    canvas.style.cursor = '';
    clearMeasure();
    clearFeatureInfo();
  }
}

export function initMeasure() {
  registerMeasureDeactivator(() => setMeasureActive(false));
  document.getElementById('measureBtn')?.addEventListener('click', () => {
    setMeasureActive(!state.measure.active);
  });
  document.addEventListener('keydown', onMeasureKey);
}
