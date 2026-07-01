// ─── Popup system ─────────────────────────────────────────────────────────────

import maplibregl, { type MapMouseEvent, type MapTouchEvent, type MapGeoJSONFeature } from 'maplibre-gl';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { highlightLine, clearLineHighlight } from './hover.js';
import { highlightUserFeature, clearUserHighlight, copyFeatureToMyData } from './user-data/user-data.js';
import { clearFeatureInfo } from './user-data/user-data-geom.js';
import { buildPopupHtml } from './popup-format.js';
import { clearWeccHighlight } from './layers/map-layers-wecc.js';
import { ICON_SVG } from './icons.js';
import { escapeHtml } from './utils/utils.js';

function showCopyPopup(lngLat: maplibregl.LngLat, f: MapGeoJSONFeature) {
  const name = featureLabel(f);
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="copy-popup">
        <div class="copy-popup-name">${escapeHtml(name)}</div>
        <button type="button" class="copy-popup-btn">＋ Copy to My Data</button>
      </div>`)
    .addTo(state.map!);
  state.popup!.getElement()
    ?.querySelector('.copy-popup-btn')
    ?.addEventListener('click', () => {
      copyFeatureToMyData(f);
      state.popup!.remove();
    }, { once: true });
}

function showNotCopyablePopup(lngLat: maplibregl.LngLat) {
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="copy-popup">
        <div class="copy-popup-note">Tiled layer — can't copy (geometry is clipped at tile borders).</div>
      </div>`)
    .addTo(state.map!);
}

function showEditPicker(lngLat: maplibregl.LngLat, features: MapGeoJSONFeature[]) {
  const rows = features.map((f, i) =>
    `<button type="button" class="feat-pick-btn" data-i="${i}">${featureSwatch(f)}${escapeHtml(featureLabel(f))}</button>`
  ).join('');
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="feat-picker">
        <div class="feat-picker-head">${features.length} features here</div>
        <div class="feat-picker-list">${rows}</div>
      </div>`)
    .addTo(state.map!);
  state.popup!.getElement()?.querySelectorAll<HTMLButtonElement>('.feat-pick-btn')
    .forEach(btn => btn.addEventListener('click', () => {
      showCopyPopup(lngLat, features[Number(btn.dataset.i)]);
    }));
}

// All clickable MapLibre layer IDs (in priority order for queryRenderedFeatures)
// >>> ADD-LAYER: clickable-layers — see docs/adding-a-layer.md §10
const CLICKABLE_LAYERS = [
  "ogf-planned-lines",
  "osm-substations-points-hv", "osm-substations-points-lv",
  "hifld-substations-hv", "hifld-substations-lv",
  "osm-substations-polygons-fill",
  "osm-plants-polygons-fill",
  "osm-plant-icons",
  "wecc-paths-circles",
  "eia-gen-circles",
  "osm-gen-circles",
  "hifld-natgas-points", "hifld-petroleum-facilities",
  "osm-pipelines-points",
  "nrel-hydrothermal-points",
  "osm-dc-circles",
  "osm-transmission-lines-hv", "osm-transmission-lines-mv", "osm-transmission-lines-lv", "osm-transmission-lines-unknown",
  "hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown",
  "hifld-natgas-interstate", "hifld-natgas-intrastate",
  "hifld-natgas-hgl", "hifld-natgas-gathering",
  "osm-pipelines-lines",
  "eia-crude-pipelines", "eia-product-pipelines",
  "railroads",
  "smoke-live-fill",
  "wildfire-incidents-circle",
  "wildfire-hotspots-circle",
  "wildfire-perimeters-fill",
  "tribal-fill", "padus-fill", "crithab-fill",
  "nerc-fill", "ba-fill", "retail-fill",
];

function activeClickableLayers() {
  if (!state.map) return [];
  const userLayerIds = state.userLayers.flatMap(l =>
    [l.id + "-circle", l.id + "-line", l.id + "-fill"]);
  return [...userLayerIds, ...CLICKABLE_LAYERS].filter(id => state.map!.getLayer(id));
}

function tryHighlightLine(feature: MapGeoJSONFeature) {
  return !feature.layer.id.startsWith("user-") &&
         highlightLine(feature.layer.id, feature.properties || {});
}

// Wider hit box for thumb taps. Sized by device, not per-event: synthesized
// touch clicks arrive as MouseEvents, and `TouchEvent` is undefined on
// non-touch desktop browsers (referencing it throws). `pointer: coarse` is the
// reliable "finger, not mouse" signal.
const TOUCH_HIT = matchMedia('(pointer: coarse)').matches;
function hitBox(e: MapMouseEvent | MapTouchEvent): [maplibregl.PointLike, maplibregl.PointLike] {
  const r = TOUCH_HIT ? 8 : 3;
  return [
    [e.point.x - r, e.point.y - r],
    [e.point.x + r, e.point.y + r],
  ];
}

// A mobile tap fires two map `click` events (synthesized touch-click + native).
// They can land a pixel or two apart, so the edit branch's empty-tap
// `popup.remove()` could tear down a copy popup the sibling click just opened —
// popup never appeared. Swallow the second click of a tap. See commit 87664a9.
let lastClickTime = 0;
function onMapClick(e: MapMouseEvent | MapTouchEvent) {
  if (state.measure.active) return;
  if (!state.map || !state.popup) return;
  const now = e.originalEvent.timeStamp || Date.now();
  if (now - lastClickTime < 350) return;
  lastClickTime = now;
  const activeLayers = activeClickableLayers();
  if (!activeLayers.length) return;

  const box = hitBox(e);

  // Edit mode: click any feature (including user loaded layers) to get a Copy button.
  if (state.editMode === 'edit') {
    const cands = state.map.queryRenderedFeatures(box, { layers: activeLayers });
    // Vector-tile (PMTiles) features carry a sourceLayer and are clipped at tile
    // borders, so copies would be truncated — only allow GeoJSON-backed features.
    const copyable = cands.filter(ft => !ft.sourceLayer);
    if (copyable.length > 1) {
      showEditPicker(e.lngLat, copyable);
    } else if (copyable.length === 1) {
      showCopyPopup(e.lngLat, copyable[0]);
    } else if (cands.length) {
      showNotCopyablePopup(e.lngLat);
    } else {
      state.popup.remove();
    }
    return;
  }

  const features = state.map.queryRenderedFeatures(box, { layers: activeLayers });
  if (!features.length) {
    state.popup.remove(); clearUserHighlight(); clearLineHighlight(); clearWeccHighlight(); return;
  }

  // Dedupe tile-boundary duplicates: queryRenderedFeatures repeats a tiled feature
  // once per tile it straddles. Tiled features always carry ft.id; GeoJSON features
  // without explicit IDs do not — so only dedup when ft.id is present.
  const uniq: MapGeoJSONFeature[] = [];
  const seen = new Set<string>();
  for (const ft of features) {
    if (ft.id == null) { uniq.push(ft); continue; }
    const key = ft.layer.id + '|' + String(ft.id);
    if (!seen.has(key)) { seen.add(key); uniq.push(ft); }
  }
  if (uniq.length > 1) { showFeaturePicker(e.lngLat, uniq); return; }

  renderFeature(e.lngLat, features[0]);
}

// Common title-ish fields across our layers; first non-empty wins.
const LABEL_FIELDS = ["name", "Name", "label", "title", "plant_name", "operator",
  "pipeline", "comname", "unitname", "OWNER", "RROWNER"];

function featureLabel(f: MapGeoJSONFeature) {
  const p = f.properties || {};
  for (const k of LABEL_FIELDS) {
    if (p[k]) {
      const label = String(p[k]);
      const mw = p.nameplate_mw ?? p.output_mw;
      return mw ? `${label} (${mw} MW)` : label;
    }
  }
  // Fallback: prettify the layer id (e.g. "eia-gen-circles" → "Eia Gen").
  return f.layer.id.replace(/-(circles|points|lines|fill|hv|lv|mv|unknown).*$/, "")
    .replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function renderFeature(lngLat: maplibregl.LngLat, f: MapGeoJSONFeature) {
  const gt = f.geometry?.type;
  const clipped = !!f.sourceLayer && gt !== "Point" && gt !== "MultiPoint";
  if (tryHighlightLine(f)) {
    clearUserHighlight();
    clearFeatureInfo();
  } else {
    clearLineHighlight();
    highlightUserFeature(f, { info: !clipped });
  }

  const html = buildPopupHtml(f.layer.id, (f.properties || {}) as Record<string, unknown>);
  if (html) {
    state.popup!.setLngLat(lngLat).setHTML(html).addTo(state.map!);
  }
}

// Resolve a feature's rendered color by evaluating its layer's color paint
// expression against the feature. Returns a CSS color string, or null.
const COLOR_PROP: Record<string, string> = {
  circle: 'circle-color', line: 'line-color',
  fill: 'fill-color', 'fill-extrusion': 'fill-extrusion-color',
};
// createExpression's TS sig wants a full property spec; only `type` matters at runtime.
const COLOR_SPEC = { type: 'color', 'property-type': 'data-driven',
  transition: false, overridable: false } as unknown as Parameters<typeof createExpression>[1];
function featureColor(f: MapGeoJSONFeature): string | null {
  const lt = state.map!.getLayer(f.layer.id)?.type;
  const prop = lt && COLOR_PROP[lt];
  if (!prop) return null;
  const raw = state.map!.getPaintProperty(f.layer.id, prop);
  if (raw == null) return null;
  const c = createExpression(raw, COLOR_SPEC);
  if (c.result !== 'success') return null;
  // ponytail: color comes from our own style, not user input — safe to inline.
  return String(c.value.evaluate({ zoom: state.map!.getZoom() }, f as never));
}

// Symbol layers (generators, plant/natgas/pipeline points) use icon-image —
// resolve it per feature and inline the matching SVG from ICON_SVG.
function featureIcon(f: MapGeoJSONFeature): string | null {
  if (state.map!.getLayer(f.layer.id)?.type !== 'symbol') return null;
  const raw = state.map!.getLayoutProperty(f.layer.id, 'icon-image');
  if (raw == null) return null;
  let name: string;
  if (typeof raw === 'string') name = raw;
  else {
    const c = createExpression(raw);
    if (c.result !== 'success') return null;
    name = String(c.value.evaluate({ zoom: state.map!.getZoom() }, f as never));
  }
  const body = ICON_SVG[name];
  return body
    ? `<svg class="feat-sw-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`
    : null;
}

// A little shape swatch: icon for symbol points, else dot/bar/square by geometry.
function featureSwatch(f: MapGeoJSONFeature): string {
  const icon = featureIcon(f);
  if (icon) return icon;
  const color = featureColor(f) || '#888';
  const gt = f.geometry?.type || '';
  const shape = /Line/.test(gt) ? 'line' : /Polygon/.test(gt) ? 'sq' : 'dot';
  return `<span class="feat-sw feat-sw-${shape}" style="background:${color}"></span>`;
}

// Multiple features under the cursor: list them, click one to drill in.
function showFeaturePicker(lngLat: maplibregl.LngLat, features: MapGeoJSONFeature[]) {
  const rows = features.map((f, i) =>
    `<button type="button" class="feat-pick-btn" data-i="${i}">${featureSwatch(f)}${escapeHtml(featureLabel(f))}</button>`
  ).join('');
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="feat-picker">
        <div class="feat-picker-head">${features.length} features here</div>
        <div class="feat-picker-list">${rows}</div>
      </div>`)
    .addTo(state.map!);
  state.popup!.getElement()?.querySelectorAll<HTMLButtonElement>('.feat-pick-btn')
    .forEach(btn => btn.addEventListener('click', () => {
      renderFeature(lngLat, features[Number(btn.dataset.i)]);
    }));
}

export function initPopups() {
  if (!state.map) return;
  // closeOnClick:false — we manage lifecycle in onMapClick (empty-tap removes the
  // popup). Leaving it true let a touch tap's double-fired click (synthesized +
  // native) close the popup on the same tap that opened it — popups never showed
  // on mobile. See onMapClick.
  state.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" });

  state.map.on("click", onMapClick);

  // In edit mode, MapboxDraw's simple_select swallows the browser's emulated
  // click on touch, so the `click` handler above never fires — tapping a feature
  // to copy did nothing on mobile. Drive the same handler from a detected tap
  // (single finger, small move). Fires in all modes; the lastClickTime debounce
  // dedupes against the real `click` on platforms where both arrive.
  let touchStart: { x: number; y: number; t: number } | null = null;
  state.map.on("touchstart", e => {
    touchStart = e.points.length === 1
      ? { x: e.point.x, y: e.point.y, t: Date.now() } : null;
  });
  state.map.on("touchend", e => {
    if (!touchStart) return;
    const moved = Math.hypot(e.point.x - touchStart.x, e.point.y - touchStart.y);
    const dt = Date.now() - touchStart.t;
    touchStart = null;
    if (moved < 10 && dt < 500) onMapClick(e);
  });

  for (const layerId of CLICKABLE_LAYERS) {
    state.map.on("mouseenter", layerId, () => {
      if (!state.measure.active) state.map!.getCanvas().style.cursor = "pointer";
    });
    state.map.on("mouseleave", layerId, () => {
      if (!state.measure.active) state.map!.getCanvas().style.cursor = "";
    });
  }
}
