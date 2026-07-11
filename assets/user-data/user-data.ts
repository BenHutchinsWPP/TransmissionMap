// ─── User data: layer management + My Data tab + selection highlight ──────────
// Deps: state, utils, user-data-geom, user-data-colors (no back-imports from url-state)
// Caches loaded drawnFeatures in `_cachedDrawnFeatures` so a save that happens
// before MapboxDraw is loaded (lazy chunk; see user-data-draw.ts) doesn't
// overwrite localStorage with an empty FeatureCollection. `restoreDrawnFeatures()`
// is called by `initDraw()` (user-data-draw.ts) once `state.draw` exists, to
// replay features loaded before draw was ready.

import type { GeoJSONSource, FilterSpecification, LayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import { state, USER_FEATURE_THRESHOLD, USER_LAYER_COLORS } from '../state.js';
import type { UserLayer } from '../../src/types.js';
import { ensureFeatureUid, ensureGeoJsonFeatureUids } from '../utils/utils-uid.js';
import { escapeHtml } from '../utils/utils.js';
import { collectCoords, coordsBounds, showFeatureInfo, clearFeatureInfo } from './user-data-geom.js';
import { drawnFeatureColor, colorPickerInner } from './user-data-colors.js';

const USER_SUBLAYER_SUFFIXES = ['-fill', '-line', '-circle', '-point-label', '-line-label'];

function addUserLayerToMap(layer: UserLayer) {
  const map = state.map;
  if (!map) return;
  const { id, geojson, color } = layer;
  map.addSource(id, { type: 'geojson', data: geojson });
  map.addLayer({
    id: id + '-fill', type: 'fill', source: id,
    filter: ['==', '$type', 'Polygon'] as FilterSpecification,
    paint: {
      'fill-color': ['coalesce', ['get', 'fill'], color] as unknown,
      'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.25] as unknown,
    },
  } as LayerSpecification);
  map.addLayer({
    id: id + '-line', type: 'line', source: id,
    filter: ['in', '$type', 'LineString', 'Polygon'] as FilterSpecification,
    paint: {
      'line-color': ['coalesce', ['get', 'stroke'], color] as unknown,
      'line-width': ['coalesce', ['get', 'stroke-width'], 2] as unknown,
    },
  } as LayerSpecification);
  map.addLayer({
    id: id + '-circle', type: 'circle', source: id,
    filter: ['==', '$type', 'Point'] as FilterSpecification,
    paint: {
      'circle-color': ['coalesce', ['get', 'marker-color'], ['get', 'icon-color'], color] as unknown,
      'circle-radius': 5, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff',
    },
  } as LayerSpecification);

  const nameExpr = ['coalesce', ['get', 'name'], ['get', 'Name'], ['get', 'label'], ['get', 'title'], ''] as unknown;
  const hasName  = ['!=', nameExpr, ''] as FilterSpecification;
  map.addLayer({
    id: id + '-point-label', type: 'symbol', source: id, minzoom: 3,
    filter: ['all', ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]], hasName] as FilterSpecification,
    layout: {
      'text-field': nameExpr,
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-variable-anchor': ['top', 'bottom'],
      'text-radial-offset': 0.9,
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13, 18, 15] as unknown,
      'text-max-width': 8,
      'text-optional': true,
    },
    paint: { 'text-color': '#1a1a2e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'text-halo-blur': 0.5 },
  } as LayerSpecification);
  map.addLayer({
    id: id + '-line-label', type: 'symbol', source: id, minzoom: 4,
    filter: ['all', ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]], hasName] as FilterSpecification,
    layout: {
      'symbol-placement': 'line',
      'text-field': nameExpr,
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 12, 11, 15, 13] as unknown,
      'symbol-spacing': 400,
      'text-max-angle': 30,
      'text-keep-upright': true,
      'text-optional': true,
      'text-allow-overlap': false,
    },
    paint: { 'text-color': color, 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 2, 'text-halo-blur': 0.5 },
  } as LayerSpecification);

  for (const suffix of ['-fill', '-line', '-circle']) {
    map.on('mouseenter', id + suffix, () => {
      if (state.editMode !== 'edit') map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id + suffix, () => { map.getCanvas().style.cursor = ''; });
  }
}

export function removeUserLayer(id: string) {
  const idx = state.userLayers.findIndex(l => l.id === id);
  if (idx === -1) return;
  for (const suffix of USER_SUBLAYER_SUFFIXES) {
    if (state.map?.getLayer(id + suffix)) state.map.removeLayer(id + suffix);
  }
  if (state.map?.getSource(id)) state.map.removeSource(id);
  state.userLayers.splice(idx, 1);
  renderMyDataTab();
  saveUserData();
}

export function toggleUserLayerVisibility(id: string, visible: boolean) {
  const layer = state.userLayers.find(l => l.id === id);
  if (!layer) return;
  layer.visible = visible;
  const viz = visible ? 'visible' : 'none';
  for (const suffix of USER_SUBLAYER_SUFFIXES) {
    if (state.map?.getLayer(id + suffix)) {
      state.map.setLayoutProperty(id + suffix, 'visibility', viz);
    }
  }
  saveUserData();
}

export function removeUserFeature(layerId: string, featureUid: string) {
  const layer = state.userLayers.find(l => l.id === layerId);
  if (!layer) return;
  layer.geojson.features = layer.geojson.features.filter(
    f => String(f.id) !== featureUid && String(f.properties?.__uid) !== featureUid
  );
  (state.map?.getSource(layerId) as GeoJSONSource)?.setData(layer.geojson);
  renderMyDataTab();
  saveUserData();
}

function zoomToUserLayer(layer: UserLayer) {
  const coords = layer.geojson.features.flatMap(f => collectCoords(f.geometry));
  const b = coordsBounds(coords);
  if (b) {
    state.map?.fitBounds([[b.minLng, b.minLat], [b.maxLng, b.maxLat]], { padding: 60, maxZoom: 14 });
  }
}

// ─── My Data tab rendering ────────────────────────────────────────────────────
export function renderMyDataTab() {
  const body = document.getElementById('myDataBody');
  if (!body) return;

  const frag = document.createDocumentFragment();

  if (state.userLayers.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'my-data-section';
    sec.innerHTML = '<div class="section-title">Loaded Files</div>';
    for (const layer of state.userLayers) {
      try {
        sec.appendChild(buildFileRow(layer));
      } catch (err) {
        console.error('[MyData] buildFileRow error (layer:', layer.id,
                      'expanded:', layer.expanded, ')', err);
        layer.expanded = false;
        try { sec.appendChild(buildFileRow(layer)); } catch (_) { /* skip */ }
      }
    }
    frag.appendChild(sec);
  }

  const drawSec = document.createElement('div');
  drawSec.className = 'my-data-section';
  drawSec.innerHTML = '<div class="section-title">My Drawings</div>';
  const drawn = state.draw ? state.draw.getAll().features : [];
  if (drawn.length === 0) {
    drawSec.insertAdjacentHTML('beforeend',
      '<p class="my-data-empty">No drawings yet. Use Add menu to draw.</p>');
  } else {
    for (const f of drawn) {
      drawSec.appendChild(buildDrawnFeatureRow(f));
    }
  }
  frag.appendChild(drawSec);

  body.innerHTML = '';
  body.appendChild(frag);
}

function buildFileRow(layer: UserLayer) {
  const count = layer.geojson.features.length;
  const isSmall = count <= USER_FEATURE_THRESHOLD;
  const expandable = isSmall && count > 0;
  const expanded = expandable && !!layer.expanded;

  const wrap = document.createElement('div');
  wrap.className = 'my-file-row';
  wrap.dataset.layerId = layer.id;
  wrap.innerHTML = fileRowHeaderHtml(layer, count, expandable, expanded);
  if (expanded) wrap.appendChild(buildFileFeatureList(layer));
  return wrap;
}

function fileRowHeaderHtml(layer: UserLayer, count: number, expandable: boolean, expanded: boolean) {
  const caret = expandable
    ? `<button type="button" class="my-caret-btn"
               data-action="toggle-expand" data-layer-id="${escapeHtml(layer.id)}"
               title="${expanded ? 'Collapse' : 'Expand'} feature list">
         <span class="my-caret${expanded ? ' my-caret--open' : ''}">▸</span>
       </button>`
    : '<span class="my-caret my-caret--empty"></span>';
  return `
    <div class="my-file-header">
      ${caret}
      <button class="my-vis-btn${layer.visible ? ' my-vis-btn--on' : ''}"
              data-action="toggle-layer" data-layer-id="${escapeHtml(layer.id)}"
              title="${layer.visible ? 'Hide' : 'Show'}" type="button">👁</button>
      <span class="my-file-name truncate" title="${escapeHtml(layer.filename)}">${escapeHtml(layer.filename)}</span>
      <span class="my-file-count">${count} feat.</span>
      <button class="my-delete-btn" data-action="delete-layer" data-layer-id="${escapeHtml(layer.id)}"
              title="Remove" type="button">🗑</button>
    </div>`;
}

function buildFileFeatureList(layer: UserLayer) {
  const list = document.createElement('div');
  list.className = 'my-feature-list';
  for (const f of layer.geojson.features) {
    const uid = ensureFeatureUid(f, layer.id);
    list.insertAdjacentHTML('beforeend', fileFeatureRowHtml(layer, f, uid));
  }
  return list;
}

function fileFeatureRowHtml(layer: UserLayer, f: GeoJSON.Feature, uid: string) {
  const idx = layer.geojson.features.indexOf(f);
  const name = f.properties?.name || f.properties?.Name || f.properties?.label
               || `${f.geometry?.type ?? 'Feature'} ${idx + 1}`;
  const active = state.userHighlightKey === String(uid) ? ' my-feature-row--active' : '';
  return `
        <div class="my-feature-row${active}">
          <span class="my-feature-name truncate" data-edit="file-feature"
                data-layer-id="${escapeHtml(layer.id)}"
                data-feature-uid="${escapeHtml(String(uid))}">${escapeHtml(String(name))}</span>
          <button class="my-delete-btn my-delete-btn--sm"
                  data-action="delete-feature"
                  data-layer-id="${escapeHtml(layer.id)}"
                  data-feature-uid="${escapeHtml(String(uid))}"
                  type="button" title="Delete">×</button>
        </div>`;
}

function buildDrawnFeatureRow(feature: GeoJSON.Feature) {
  const typeLabel = feature.geometry?.type ?? 'Feature';
  const name = feature.properties?.name || `${typeLabel} ${String(feature.id ?? '').slice(0, 6)}`;
  const fid = escapeHtml(String(feature.id ?? ''));
  const color = drawnFeatureColor(feature);
  const active = state.userHighlightKey === String(feature.id ?? '') ? ' my-feature-row--active' : '';
  const row = document.createElement('div');
  row.className = 'my-feature-row' + active;
  row.innerHTML = `
    <span class="color-picker" data-target="feature" data-feature-id="${fid}">${colorPickerInner(color)}</span>
    <span class="my-feature-name truncate" data-edit="drawn" data-feature-id="${fid}">${escapeHtml(name)}</span>
    <button class="my-delete-btn my-delete-btn--sm"
            data-action="delete-drawn"
            data-feature-id="${fid}"
            type="button" title="Delete">×</button>`;
  return row;
}

function startInlineEdit(span: HTMLElement) {
  if (span.dataset.editing) return;
  span.dataset.editing = '1';
  const original = span.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'my-feature-name-edit';
  span.textContent = '';
  span.appendChild(input);
  input.focus();
  input.select();

  let committed = false;

  input.addEventListener('blur', () => {
    if (committed) return;
    committed = true;
    saveFeatureName(span, input.value.trim() || original);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      span.textContent = original;
    }
  });
}

function saveFeatureName(span: HTMLElement, newName: string) {
  if (span.dataset.edit === 'drawn') {
    if (state.draw) {
      state.draw.setFeatureProperty(span.dataset.featureId!, 'name', newName);
      state.draw.set(state.draw.getAll());
    }
  } else if (span.dataset.edit === 'file-feature') {
    const layer = state.userLayers.find(l => l.id === span.dataset.layerId);
    if (layer) {
      const uid = span.dataset.featureUid;
      const feat = layer.geojson.features.find(
        f => String(f.id) === uid || String(f.properties?.__uid) === uid
      );
      if (feat) {
        feat.properties = feat.properties ?? {};
        feat.properties.name = newName;
        (state.map?.getSource(layer.id) as GeoJSONSource)?.setData(layer.geojson);
      }
    }
  }
  renderMyDataTab();
}

// ─── Feature highlight ────────────────────────────────────────────────────────
const EMPTY_HIGHLIGHT = { type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] };

function ensureHighlightLayers() {
  if (!state.map || state.map.getSource('user-highlight')) return;
  state.map.addSource('user-highlight', { type: 'geojson', data: EMPTY_HIGHLIGHT });
  const lineLike = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]] as FilterSpecification;
  const pointLike = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]] as FilterSpecification;
  state.map.addLayer({
    id: 'user-highlight-casing', type: 'line', source: 'user-highlight',
    filter: lineLike,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
  } as LayerSpecification);
  state.map.addLayer({
    id: 'user-highlight-line', type: 'line', source: 'user-highlight',
    filter: lineLike,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-width': 4 },
  } as LayerSpecification);
  state.map.addLayer({
    id: 'user-highlight-circle', type: 'circle', source: 'user-highlight',
    filter: pointLike,
    paint: {
      'circle-radius': 10, 'circle-color': 'rgba(59,130,246,0.25)',
      'circle-stroke-color': '#3b82f6', 'circle-stroke-width': 4,
    },
  } as LayerSpecification);
}

export function highlightUserFeature(feature: GeoJSON.Feature, opts: { info?: boolean; zoom?: boolean } = {}) {
  if (!feature?.geometry) return;
  ensureHighlightLayers();
  (state.map?.getSource('user-highlight') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [feature] });
  if (opts.info === false) clearFeatureInfo();
  else showFeatureInfo(feature.geometry);

  if (!opts.zoom) return;
  const coords = collectCoords(feature.geometry);
  if (coords.length === 1) {
    state.map?.easeTo({ center: coords[0] as [number, number] });
  } else if (coords.length > 1) {
    const b = coordsBounds(coords);
    if (b) state.map?.fitBounds([[b.minLng, b.minLat], [b.maxLng, b.maxLat]], { padding: 80, maxZoom: 15 });
  }
}

export function clearUserHighlight() {
  state.userHighlightKey = null;
  (state.map?.getSource('user-highlight') as GeoJSONSource)?.setData(EMPTY_HIGHLIGHT);
  clearFeatureInfo();
  document.querySelectorAll('.my-feature-row--active')
    .forEach(r => r.classList.remove('my-feature-row--active'));
}

export function selectUserFeature(span: HTMLElement) {
  let feature: GeoJSON.Feature | null = null;
  let key: string | null = null;
  if (span.dataset.edit === 'drawn') {
    key = span.dataset.featureId ?? null;
    feature = key ? state.draw?.get(key) as GeoJSON.Feature : null;
  } else if (span.dataset.edit === 'file-feature') {
    const layer = state.userLayers.find(l => l.id === span.dataset.layerId);
    key = span.dataset.featureUid ?? null;
    feature = (layer?.geojson.features.find(
      f => String(f.id) === key || String(f.properties?.__uid) === key) as GeoJSON.Feature) || null;
  }
  if (!feature) return;
  state.userHighlightKey = key;
  highlightUserFeature(feature, { zoom: true });
  document.querySelectorAll('.my-feature-row--active')
    .forEach(r => r.classList.remove('my-feature-row--active'));
  span.closest('.my-feature-row')?.classList.add('my-feature-row--active');
}

export { startInlineEdit };

// ─── User layer add ───────────────────────────────────────────────────────────
export function addUserLayer(filename: string, geojson: GeoJSON.FeatureCollection, { color, visible = true, skipZoom = false }: { color?: string; visible?: boolean; skipZoom?: boolean } = {}) {
  const id = 'user-' + state.userLayerCounter++;
  const layerColor = color ?? USER_LAYER_COLORS[state.userLayers.length % USER_LAYER_COLORS.length];
  ensureGeoJsonFeatureUids(geojson, filename);
  const layer = { id, filename, geojson, visible: true, color: layerColor };
  state.userLayers.push(layer);
  addUserLayerToMap(layer);
  if (!visible) toggleUserLayerVisibility(id, false);
  if (!skipZoom) zoomToUserLayer(layer);
  renderMyDataTab();
  saveUserData();
}

// ─── Copy a main-map feature into My Data ─────────────────────────────────────
const COPY_LAYER_NAME = 'Copied from map';

// ponytail: queryRenderedFeatures returns tile-clipped geometry — lines/polygons
// spanning tile boundaries get truncated. Points are exact. Full-geometry refetch
// isn't feasible client-side from PMTiles; accept clipping or copy at higher zoom.
export function copyFeatureToMyData(f: MapGeoJSONFeature) {
  const clean: GeoJSON.Feature = {
    type: 'Feature',
    geometry: f.geometry,
    properties: { ...f.properties, __src: f.layer.id },
  };
  const layer = state.userLayers.find(l => l.filename === COPY_LAYER_NAME);
  if (!layer) {
    addUserLayer(COPY_LAYER_NAME, { type: 'FeatureCollection', features: [clean] }, { skipZoom: true });
    return;
  }
  ensureGeoJsonFeatureUids({ type: 'FeatureCollection', features: [clean] }, layer.id);
  layer.geojson.features.push(clean);
  (state.map?.getSource(layer.id) as GeoJSONSource)?.setData(layer.geojson);
  renderMyDataTab();
  saveUserData();
}

// ─── localStorage persistence ─────────────────────────────────────────────────
const _STORAGE_KEY = 'tm-user-data';
let _storageQuotaAlertShown = false;

// Cache of the last-known drawn FeatureCollection, kept in sync whenever
// state.draw is available. Lets saveUserData() preserve drawn shapes even
// when called while MapboxDraw's lazy chunk hasn't loaded yet (state.draw is
// null), and lets restoreDrawnFeatures() replay them once draw does load.
let _cachedDrawnFeatures: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function saveUserData() {
  try {
    if (state.draw) _cachedDrawnFeatures = state.draw.getAll();
    const payload = {
      userLayers: state.userLayers.map(l => ({
        filename: l.filename,
        geojson:  l.geojson,
        color:    l.color,
        visible:  l.visible,
      })),
      drawnFeatures: _cachedDrawnFeatures,
    };
    localStorage.setItem(_STORAGE_KEY, JSON.stringify(payload));
  } catch (e: unknown) {
    console.warn('[TransmissionMap] saveUserData failed:', (e as Error).message);
    if (!_storageQuotaAlertShown) {
      _storageQuotaAlertShown = true;
      alert('Storage full: could not save your data. Please delete some layers or drawings.');
    }
  }
}

export function loadUserData() {
  let payload;
  try {
    const raw = localStorage.getItem(_STORAGE_KEY);
    if (!raw) return;
    payload = JSON.parse(raw);
  } catch (e: unknown) {
    console.warn('[TransmissionMap] loadUserData parse failed:', (e as Error).message);
    return;
  }
  const { userLayers = [], drawnFeatures } = payload;
  for (const l of userLayers) {
    try {
      addUserLayer(l.filename, l.geojson, { color: l.color, visible: l.visible, skipZoom: true });
    } catch (e) {
      console.warn('[TransmissionMap] loadUserData: failed to restore layer', l.filename, e);
    }
  }
  if (drawnFeatures?.features?.length) {
    _cachedDrawnFeatures = drawnFeatures;
    if (state.draw) {
      state.draw.add(drawnFeatures);
      renderMyDataTab();
    }
  }
}

// Called by initDraw() (user-data-draw.ts) right after MapboxDraw is attached
// to the map, to replay any drawn features that were loaded from storage
// before the lazy draw chunk was ready.
export function restoreDrawnFeatures() {
  if (state.draw && _cachedDrawnFeatures.features.length) {
    state.draw.add(_cachedDrawnFeatures);
    renderMyDataTab();
  }
}
