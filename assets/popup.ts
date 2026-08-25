// ─── Popup system ─────────────────────────────────────────────────────────────

import * as maplibregl from 'maplibre-gl';
import { type MapMouseEvent, type MapTouchEvent, type MapGeoJSONFeature } from 'maplibre-gl';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { highlightLine, clearLineHighlight, hoverFillIds } from './hover.js';
import { highlightUserFeature, clearUserHighlight, copyFeatureToMyData } from './user-data/user-data.js';
import { clearFeatureInfo } from './user-data/user-data-geom.js';
import { buildPopupHtml } from './popup-format.js';
import { clearWeccHighlight } from './layers/map-layers-wecc.js';
import { zoneFeatureLit } from './nws-zone-join.js';
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
  "westtec-lines",
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
  "mines-icons",
  "osm-dc-circles",
  "osm-dc-points",
  "osm-dc-heat-points",
  "osm-transmission-lines-hv", "osm-transmission-lines-mv", "osm-transmission-lines-lv", "osm-transmission-lines-unknown",
  "hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown",
  "hifld-natgas-interstate", "hifld-natgas-intrastate",
  "hifld-natgas-hgl", "hifld-natgas-gathering",
  "osm-pipelines-lines",
  "eia-crude-pipelines", "eia-product-pipelines",
  "railroads",
  "nws-alerts-fill",
  "nws-zone-fill", "nws-county-fill",
  "smoke-live-fill",
  "wildfire-incidents-circle",
  "wildfire-hotspots-circle",
  "wildfire-perimeters-fill",
  "tribal-fill", "bia-tribal-fill", "padus-fill", "crithab-fill",
  "nerc-fill", "ba-fill", "eiaba-fill", "retail-fill",
  "odin-outages-fill",
  "boem-wind-leases-fill",
  // Administrative reference boundaries — background context, lowest priority.
  "us-zcta-fill", "us-counties-fill", "us-states-fill", "admin1-fill", "countries-fill",
];

// Layers that earn a pointer cursor but are not popup targets — their click
// does something else (the datacenter cluster zooms in). They ride along in the
// shared hit-test below rather than registering their own mouse delegates.
const CURSOR_ONLY_LAYERS = ["osm-dc-clusters"];

// Switched-off layers are dropped here, not after the query. Style
// .queryRenderedFeatures marks a source as included for every layer id handed
// to it regardless of visibility, and each included source projects the query
// box separately — under 3D terrain each of those projections is a synchronous
// GPU readback, so an all-layers list makes one click cost a readback sweep per
// source. A hidden layer has nothing clickable in it either way.
function activeClickableLayers() {
  if (!state.map) return [];
  const userLayerIds = state.userLayers.flatMap(l =>
    [l.id + "-circle", l.id + "-line", l.id + "-fill"]);
  return [...userLayerIds, ...CLICKABLE_LAYERS].filter(id =>
    state.map!.getLayer(id) && state.map!.getLayoutProperty(id, "visibility") !== "none");
}

// Feature-state-joined choropleths (ODIN outages, NWS zone/county) draw EVERY
// county/zone from the shared boundary tiles and paint unlit ones transparent
// (setFilter can't read feature-state), but queryRenderedFeatures still
// hit-tests transparent fills — so invisible polygons were selectable. Each
// predicate mirrors its layer's opacity paint expression; a feature is a valid
// hit only when it's actually painted.
const HIT_LIT: Record<string, (f: MapGeoJSONFeature) => boolean> = {
  "odin-outages-fill": f => f.state?.odin_out != null,
  "nws-zone-fill":     f => zoneFeatureLit(f.state),
  "nws-county-fill":   f => zoneFeatureLit(f.state),
};
function hitLit(f: MapGeoJSONFeature): boolean {
  return HIT_LIT[f.layer.id]?.(f) ?? true;
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
// popup never appeared. Swallow the second click of a tap.
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
    // While MapboxDraw is sketching a new shape or editing an existing one's
    // vertices, a click is placing/dragging a vertex, not picking a feature to
    // copy — the copy popup would otherwise pop up on top of the in-progress shape.
    const drawMode = state.draw?.getMode();
    if (drawMode && drawMode !== 'simple_select' && drawMode !== 'static') return;
    const cands = state.map.queryRenderedFeatures(box, { layers: activeLayers }).filter(hitLit);
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

  const features = state.map.queryRenderedFeatures(box, { layers: activeLayers }).filter(hitLit);
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

// Common title-ish fields across our layers; first non-empty wins. "NAME" is
// the Census TIGER county-name field (county_boundaries source, e.g. ODIN
// outages) — without it, picker rows for that source all fall through to the
// generic layer-id label and look like duplicate entries.
const LABEL_FIELDS = ["name", "Name", "NAME", "label", "title", "plant_name",
  "operator", "pipeline", "comname", "unitname", "OWNER", "RROWNER", "zcta5"];

function featureLabel(f: MapGeoJSONFeature) {
  const p = f.properties || {};
  for (const k of LABEL_FIELDS) {
    if (p[k]) {
      const label = k === "NAME" && p.STATE_NAME ? `${p[k]}, ${p.STATE_NAME}` : String(p[k]);
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
    // queryRenderedFeatures includes MapLibre-only class instances; keep only
    // JSON-safe GeoJSON fields before setData sends it to the worker.
    const plainFeature = JSON.parse(JSON.stringify({
      type: 'Feature',
      ...(f.id == null ? {} : { id: f.id }),
      properties: f.properties || {},
      geometry: f.geometry,
    })) as GeoJSON.Feature;
    highlightUserFeature(plainFeature, { info: !clipped });
  }

  // Feature-state-joined layers (ODIN outages) carry their data in f.state, not
  // f.properties — merge it in so the renderer sees both the tile attributes
  // (county NAME/STATE_NAME) and the joined numbers (out, n).
  const props = f.state && Object.keys(f.state).length
    ? { ...(f.properties || {}), ...f.state }
    : (f.properties || {});
  const html = buildPopupHtml(f.layer.id, props as Record<string, unknown>);
  if (html) {
    state.popup!.setLngLat(lngLat).setHTML(html).addTo(state.map!);
  }
}

// Resolve a feature's rendered color by evaluating its layer's color paint
// expression against the feature. Returns a CSS color string, or null.
type ColorPaintProperty = 'circle-color' | 'line-color' | 'fill-color' | 'fill-extrusion-color';
const COLOR_PROP: Record<string, ColorPaintProperty> = {
  circle: 'circle-color', line: 'line-color',
  fill: 'fill-color', 'fill-extrusion': 'fill-extrusion-color',
};
// createExpression's TS sig wants a full property spec; only `type` matters at runtime.
const COLOR_SPEC = { type: 'color', 'property-type': 'data-driven',
  transition: false, overridable: false } as unknown as Parameters<typeof createExpression>[2];
function featureColor(f: MapGeoJSONFeature): string | null {
  const lt = state.map!.getLayer(f.layer.id)?.type;
  const prop = lt && COLOR_PROP[lt];
  if (!prop) return null;
  const raw = state.map!.getPaintProperty(f.layer.id, prop);
  if (raw == null) return null;
  const c = createExpression(raw, prop, COLOR_SPEC);
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
    const c = createExpression(raw, 'icon-image');
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

  // Cursor feedback: one hit-test per animation frame across every clickable
  // layer at once, rather than a per-layer mouseenter/mouseleave pair.
  // MapLibre's layer-scoped delegates each run their own queryRenderedFeatures
  // on every mousemove — 50-odd of them here — and under 3D terrain a query
  // projects its box through the terrain coords framebuffer, costing a
  // synchronous GPU readback per corner per source. One shared query holds
  // that at one readback per frame however many layers are clickable.
  //
  // Querying everything together (rather than trusting the layer the delegate
  // fired for) is also what makes feature-state-joined layers behave: they
  // hit-test their transparent unlit features too, so with e.g. ODIN on, an
  // unlit county covers the whole map. hitLit() decides, and a lit feature
  // underneath an unlit polygon still gets the pointer.
  //
  // The hit-test is also skipped while the camera is in motion. A query costs
  // one of those readbacks per box corner per source, which is affordable once
  // the view is settled but not while every frame is already rendering the
  // terrain surface — and a pointer shape during a drag has nothing to report
  // anyway. moveend runs the deferred one so the cursor lands correct.
  let hoverPoint: [number, number] | null = null;
  let hoverFrame = 0;
  const updateCursor = () => {
    hoverFrame = 0;
    if (!state.map || !hoverPoint || state.map.isMoving()) return;
    // activeClickableLayers() and hoverFillIds() are already visibility-gated;
    // the cursor-only ids need the same treatment before joining them.
    const layers = [...new Set([...activeClickableLayers(), ...hoverFillIds(),
      ...CURSOR_ONLY_LAYERS.filter(id => state.map!.getLayer(id)
        && state.map!.getLayoutProperty(id, "visibility") !== "none")])];
    const lit = layers.length > 0 &&
      state.map.queryRenderedFeatures(hoverPoint, { layers }).some(hitLit);
    state.map.getCanvas().style.cursor = lit ? "pointer" : "";
  };
  const scheduleCursor = () => {
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateCursor);
  };
  state.map.on("mousemove", e => {
    if (state.measure.active) return;
    hoverPoint = [e.point.x, e.point.y];
    scheduleCursor();
  });
  state.map.on("moveend", scheduleCursor);
  state.map.on("mouseout", () => {
    hoverPoint = null;
    if (!state.measure.active) state.map!.getCanvas().style.cursor = "";
  });
}
