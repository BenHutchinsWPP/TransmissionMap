// ─── Popup system ─────────────────────────────────────────────────────────────
// Role: map-click popups. Owns click priority (CLICKABLE_LAYERS, pinned by
//       src/registry/registry.test.ts), the hover cursor, and rendering: the
//       feature popup, the disambiguation picker and edit mode's copy popups.
//       Which of those a click gets is decided by click-resolve.ts's pure
//       resolveHits(); the HTML body comes from popup-format.ts.
// Deps: state, src/registry (LAYERS — clickPriority), click-resolve.ts,
//       popup-format.ts, map-input.ts (onMapTap/onMapHover), hover.ts,
//       user-data, layers/map-layers-wecc.ts (clearWeccHighlight), icons.ts,
//       feature-id.ts + ui/table-open.ts (the popup's "Show in table" for a
//       queryable layer's feature; the table itself is a lazy chunk),
//       a tap on a Proximity point (px-points) is the Proximity tab's, not a popup's;
//       toolOwnsTap(e) tells other tap subscribers (grid-ops.ts) a tool owns the tap;
//       services/service-spec.ts (SERVICE_LAYER_PREFIX — linked services' layers are clickable);
//       @maplibre/maplibre-gl-style-spec (picker swatches) is a lazy chunk,
//       fetched on the first multi-feature click; src/units.ts (fmtDistance).
//       A transmission line (LayerDef.data.analysis) gets its exact length and a
//       Copy to My Data and Line tools buttons from the lazy lines/ chunk (line-read.ts lookup,
//       line-copy.ts; Line tools opens the drawer's Line tab through ui/line-open.ts) once one IDX read lands: the popup renders first, a later
//       click (popupToken) drops a stale answer, and nothing is added when the
//       line files are not there. Edit mode copies such a line through the same
//       chunk (resolveHits' `copy-tiled`); on a host without the line files it
//       turns into the "can't copy" note.

import * as maplibregl from 'maplibre-gl';
import { LAYERS } from '../src/registry/index.js';
import { type MapGeoJSONFeature } from 'maplibre-gl';
import { state } from './state.js';
import { highlightLine, clearLineHighlight, hoverFillIds } from './hover.js';
import { highlightUserFeature, clearUserHighlight, copyFeatureToMyData } from './user-data/user-data.js';
import { clearFeatureInfo } from './user-data/user-data-geom.js';
import { buildPopupHtml, LINE_LENGTH_SLOT } from './popup-format.js';
import { fmtDistance } from '../src/units.js';
import { clearWeccHighlight } from './layers/map-layers-wecc.js';
import { resolveHits, hitLit } from './click-resolve.js';
import { ICON_SVG } from './icons.js';
import { escapeHtml } from './utils/utils.js';
import { t } from '../src/i18n/index.js';
import { onMapTap, onMapHover, onMapPointLeave, tapBox, type MapPointerEvent } from './map-input.js';
import { featureId } from './feature-id.js';
import { openTable } from './ui/table-open.js';
import { openLineTools } from './ui/line-open.js';
import { SERVICE_LAYER_PREFIX } from './services/service-spec.js';

function showCopyPopup(lngLat: maplibregl.LngLat, f: MapGeoJSONFeature) {
  const name = featureLabel(f);
  const owner = f.sourceLayer ? analysisOwner(f) : undefined;
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="copy-popup">
        <div class="copy-popup-name">${escapeHtml(name)}</div>
        <button type="button" class="copy-popup-btn">${escapeHtml(t('popup.copyToMyData'))}</button>
      </div>`)
    .addTo(state.map!);
  const btn = state.popup!.getElement()?.querySelector<HTMLButtonElement>('.copy-popup-btn');
  btn?.addEventListener('click', () => {
    if (owner) { void copyLine(owner.id, f, btn); return; }
    const r = copyFeatureToMyData(f);
    if (r.saved) { state.popup!.remove(); return; }
    // The save failed: nothing was kept, so the button offers the file instead.
    const chars = JSON.stringify(r.feature).length;
    void import('./user-data/copy-fit.js').then(m => {
      btn.disabled = false;
      m.showCopyResult(btn, { ...m.toDownload([r.feature], null, f.layer.id, chars), storageFull: true });
    });
  }, { once: true });
}

// ─── Transmission lines: exact length and full-geometry copy (lines/ chunk) ──
// Bumped by every click and every rendered popup, so a lookup that lands after
// the visitor moved on is dropped.
let popupToken = 0;

function analysisOwner(f: { layer: { id: string } }) {
  const owner = LAYERS.find(l => l.mapLayerIds.includes(f.layer.id));
  return owner?.data?.analysis ? owner : undefined;
}

function addLineExtras(f: MapGeoJSONFeature, token: number) {
  const owner = analysisOwner(f);
  const id = owner && featureId(owner.id, f);
  if (!owner || id === undefined) return;
  void import('./lines/line-read.js')
    .then(m => m.lookup(owner.id, id))
    .then(got => {
      const content = state.popup?.getElement()?.querySelector('.maplibregl-popup-content');
      if (!got.ok || token !== popupToken || !state.popup?.isOpen() || !content) return;
      const slot = content.querySelector<HTMLElement>('.' + LINE_LENGTH_SLOT);
      if (slot) {
        const key = Object.assign(document.createElement('span'), { className: 'popup-key', textContent: t('popup.length') });
        const val = Object.assign(document.createElement('span'), { className: 'popup-val', textContent: fmtDistance(got.result.length_km * 1000) });
        slot.replaceChildren(key, ' ', val);
        slot.hidden = false;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'popup-table-btn popup-copy-btn';
      btn.textContent = t('popup.copyToMyData');
      btn.addEventListener('click', () => void copyLine(owner.id, f, btn), { once: true });
      const tools = document.createElement('button');
      tools.type = 'button';
      tools.className = 'popup-table-btn popup-line-tools-btn';
      tools.textContent = t('line.tools');
      tools.addEventListener('click', () => {
        const properties = JSON.parse(JSON.stringify(f.properties ?? {})) as Record<string, unknown>;
        state.popup?.remove();
        void openLineTools({ layerId: owner.id, fid: id, properties }, state.map?.getCanvas());
      });
      content.append(btn, tools);
    })
    .catch(() => { /* the lines chunk did not load (offline): the popup stays as it is */ });
}

async function copyLine(layerId: string, f: MapGeoJSONFeature, btn: HTMLButtonElement) {
  const id = featureId(layerId, f);
  if (id === undefined) return;
  btn.disabled = true;
  btn.textContent = t('line.copying');
  try {
    const m = await import('./lines/line-copy.js');
    const r = await m.copyLines(layerId, [{
      fid: id, mapLayerId: f.layer.id,
      properties: JSON.parse(JSON.stringify(f.properties ?? {})),
      tileGeometry: JSON.parse(JSON.stringify(f.geometry)),
    }]);
    // No line files on this host: the edit-mode copy is the tiled "can't copy" note after all.
    if (r.kind === 'refused' && r.reason === 'unavailable' && btn.isConnected && state.popup) showNotCopyablePopup(state.popup.getLngLat());
    else m.showCopyResult(btn, r);
  } catch {
    btn.textContent = t('line.copyFailed', { reason: t('line.reason.offline') });
  }
}


function showNotCopyablePopup(lngLat: maplibregl.LngLat) {
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="copy-popup">
        <div class="copy-popup-note">${escapeHtml(t('popup.tiledCannotCopy'))}</div>
      </div>`)
    .addTo(state.map!);
}

async function showEditPicker(lngLat: maplibregl.LngLat, features: MapGeoJSONFeature[]) {
  if (!await swatchesReady()) return;
  const rows = features.map((f, i) =>
    `<button type="button" class="feat-pick-btn" data-i="${i}">${featureSwatch(f)}${escapeHtml(featureLabel(f))}</button>`
  ).join('');
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="feat-picker">
        <div class="feat-picker-head">${escapeHtml(t('popup.featuresHere', { count: features.length }))}</div>
        <div class="feat-picker-list">${rows}</div>
      </div>`)
    .addTo(state.map!);
  state.popup!.getElement()?.querySelectorAll<HTMLButtonElement>('.feat-pick-btn')
    .forEach(btn => btn.addEventListener('click', () => {
      showCopyPopup(lngLat, features[Number(btn.dataset.i)]);
    }));
}

// Click hit-test priority for style layers that are still built (by
// map-layers-hifld.ts / map-layers-petroleum.ts / nws-zone-join.ts) but whose
// LayerDef carries no mapLayerIds entry for them, so the registry has nowhere
// to hang a clickPriority.
export const UNOWNED_CLICKABLE: Record<string, number> = {
  // LayerDef commented out in src/registry/pipelines.ts (crude/refined-oil
  // delivery has no grid-planning value); map layer still built.
  "hifld-petroleum-facilities": 870,
  "eia-crude-pipelines": 640,
  "eia-product-pipelines": 630,
  // Feature-state-joined choropleths built outside any mapLayerIds array.
  "nws-zone-fill": 600,
  "nws-county-fill": 590,
};

// All clickable MapLibre layer IDs, derived from every LayerDef.clickPriority
// plus UNOWNED_CLICKABLE and sorted by descending priority — that order is
// what queryRenderedFeatures uses below, so it decides both which feature a
// click resolves to and the disambiguation picker's row order.
// >>> ADD-LAYER: clickable-layers — see docs/adding-a-layer.md §10
const CLICK_PRIORITY: Record<string, number> = { ...UNOWNED_CLICKABLE };
for (const layer of LAYERS) {
  if (layer.clickPriority) Object.assign(CLICK_PRIORITY, layer.clickPriority);
}
export const CLICKABLE_LAYERS = Object.keys(CLICK_PRIORITY)
  .sort((a, b) => CLICK_PRIORITY[b] - CLICK_PRIORITY[a]);

// Layers that earn a pointer cursor but are not popup targets — their click
// does something else (the datacenter cluster zooms in). They ride along in the
// shared hit-test below rather than registering their own mouse delegates.
const CURSOR_ONLY_LAYERS = ["osm-dc-clusters"];

// Switched-off layers are dropped here, not after the query. Style
// .queryRenderedFeatures marks a source as included for every layer id handed
// to it regardless of visibility, and each included source projects the query
// box separately — under 3D terrain that is a ray walk over the DEM per
// corner, so an all-layers list makes one click pay for a sweep per source. A hidden layer has nothing clickable in it either way.
function activeClickableLayers() {
  if (!state.map) return [];
  const userLayerIds = state.userLayers.flatMap(l =>
    [l.id + "-circle", l.id + "-line", l.id + "-fill"]);
  const serviceLayerIds = state.services.flatMap(s =>
    ["-circle", "-line", "-fill"].map(x => SERVICE_LAYER_PREFIX + s.id + x));
  return [...userLayerIds, ...serviceLayerIds, ...CLICKABLE_LAYERS].filter(id =>
    state.map!.getLayer(id) && state.map!.getLayoutProperty(id, "visibility") !== "none");
}

function tryHighlightLine(feature: MapGeoJSONFeature) {
  return !feature.layer.id.startsWith("user-") &&
         highlightLine(feature.layer.id, feature.properties || {});
}

// Both halves of a double tap arrive as taps — the measure tool builds on that —
// and the second lands a pixel or two off the first. Picking a feature is a
// single decision either way, so the pair resolves to one: without this, an
// empty second tap would call popup.remove() on what the first tap just opened.
const DOUBLE_TAP_MS = 350;
let lastTapAt = -Infinity;

// The route pane claims a tap on a hole in its similar-cost areas (it pins a cell card);
// a claimed tap opens no feature popup. Set by ui-route.ts, asked here so the order of the
// two tap subscribers does not matter.
let routeTapClaims: ((e: MapPointerEvent) => boolean) | null = null;
export function setRouteTapClaims(fn: ((e: MapPointerEvent) => boolean) | null) { routeTapClaims = fn; }

// A tool holds the tap: the measure tool, the route pane's pick / inspect, or a tap it claims.
const toolHoldsTap = (e: MapPointerEvent) =>
  !!(state.measure.active || state.routePick || state.routeInspect || routeTapClaims?.(e));
/** Whether a tool owns this tap — one of the above, or edit mode (whose taps copy
 *  features) — so a panel such as the Grid Ops tab (grid-ops.ts) does not open on it. */
export function toolOwnsTap(e: MapPointerEvent): boolean {
  return toolHoldsTap(e) || state.editMode === 'edit';
}

function onMapClick(e: MapPointerEvent) {
  if (toolHoldsTap(e)) return;
  if (!state.map || !state.popup) return;
  // A tap on a Proximity point focuses its table row (ui/proximity-map.ts), not a feature popup.
  if (state.map.getLayer('px-points') && state.map.queryRenderedFeatures(tapBox(e), { layers: ['px-points'] }).length) return;
  const at = performance.now();
  if (at - lastTapAt < DOUBLE_TAP_MS) return;
  lastTapAt = at;
  const activeLayers = activeClickableLayers();
  if (!activeLayers.length) return;

  const box = tapBox(e);
  popupToken++;

  // Edit mode: click any feature (including user loaded layers) to get a Copy button.
  if (state.editMode === 'edit') {
    // While MapboxDraw is sketching a new shape or editing an existing one's
    // vertices, a click is placing/dragging a vertex, not picking a feature to
    // copy — the copy popup would otherwise pop up on top of the in-progress shape.
    const drawMode = state.draw?.getMode();
    if (drawMode && drawMode !== 'simple_select' && drawMode !== 'static') return;
  }

  const hit = resolveHits(
    state.map.queryRenderedFeatures(box, { layers: activeLayers }),
    state.editMode === 'edit' ? 'edit' : 'view', ft => !!analysisOwner(ft));
  switch (hit.kind) {
    case 'copy-picker':  void showEditPicker(e.lngLat, hit.features); return;
    case 'copy':
    case 'copy-tiled':   showCopyPopup(e.lngLat, hit.feature); return;
    case 'not-copyable': showNotCopyablePopup(e.lngLat); return;
    case 'picker':       void showFeaturePicker(e.lngLat, hit.features); return;
    case 'single':       renderFeature(e.lngLat, hit.feature); return;
    case 'none':
      state.popup.remove();
      if (state.editMode !== 'edit') { clearUserHighlight(); clearLineHighlight(); clearWeccHighlight(); }
  }
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
  const html = buildPopupHtml(f.layer.id, props as Record<string, unknown>, f.id);
  const token = ++popupToken;
  if (html) {
    state.popup!.setLngLat(lngLat).setHTML(html).addTo(state.map!);
    addShowInTable(f);
    addLineExtras(f, token);
  }
}

// A feature of a queryable layer (a field schema and a stable id) gets a
// "Show in table" button: the popup and its click highlights close, and the
// drawer opens on its layer with this row active (the table's highlight).
function addShowInTable(f: MapGeoJSONFeature) {
  const owner = LAYERS.find(l => l.mapLayerIds.includes(f.layer.id));
  if (!owner?.dataset || !owner.data?.id) return;
  const id = featureId(owner.id, f);
  const content = state.popup!.getElement()?.querySelector('.maplibregl-popup-content');
  if (id === undefined || !content) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'popup-table-btn';
  btn.textContent = t('table.open');
  btn.addEventListener('click', () => {
    state.popup?.remove();
    clearUserHighlight(); clearLineHighlight(); clearWeccHighlight();
    void openTable({ layerId: owner.id, focusId: id });
  });
  content.append(btn);
}

// Resolve a feature's rendered color by evaluating its layer's color paint
// expression against the feature. Returns a CSS color string, or null.
type ColorPaintProperty = 'circle-color' | 'line-color' | 'fill-color' | 'fill-extrusion-color';
const COLOR_PROP: Record<string, ColorPaintProperty> = {
  circle: 'circle-color', line: 'line-color',
  fill: 'fill-color', 'fill-extrusion': 'fill-extrusion-color',
};
// The style-spec expression engine only paints picker swatches, so it loads on
// the first picker. A tap made while it loads supersedes the one that asked.
// When the chunk cannot load (offline), the picker opens without swatches and
// the next picker tries again.
type CreateExpression = typeof import('@maplibre/maplibre-gl-style-spec').createExpression;
let createExpression: CreateExpression | null = null;
let createExpressionLoad: Promise<CreateExpression | null> | null = null;
async function swatchesReady(): Promise<boolean> {
  if (createExpression) return true;
  const tap = lastTapAt;
  createExpression = await (createExpressionLoad ??= import('@maplibre/maplibre-gl-style-spec')
    .then(({ createExpression }) => createExpression)
    .catch(() => { createExpressionLoad = null; return null; }));
  return tap === lastTapAt;
}

// createExpression's TS sig wants a full property spec; only `type` matters at runtime.
const COLOR_SPEC = { type: 'color', 'property-type': 'data-driven',
  transition: false, overridable: false } as unknown as Parameters<CreateExpression>[2];
function featureColor(f: MapGeoJSONFeature): string | null {
  const lt = state.map!.getLayer(f.layer.id)?.type;
  const prop = lt && COLOR_PROP[lt];
  if (!prop || !createExpression) return null;
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
    if (!createExpression) return null;
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
async function showFeaturePicker(lngLat: maplibregl.LngLat, features: MapGeoJSONFeature[]) {
  if (!await swatchesReady()) return;
  const rows = features.map((f, i) =>
    `<button type="button" class="feat-pick-btn" data-i="${i}">${featureSwatch(f)}${escapeHtml(featureLabel(f))}</button>`
  ).join('');
  state.popup!.setLngLat(lngLat)
    .setHTML(`<div class="feat-picker">
        <div class="feat-picker-head">${escapeHtml(t('popup.featuresHere', { count: features.length }))}</div>
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
  // popup), so one tap can never both open a popup and close it again.
  state.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" });

  onMapTap(onMapClick);

  // Cursor feedback: one hit-test per animation frame across every clickable
  // layer at once, rather than a per-layer mouseenter/mouseleave pair.
  // MapLibre's layer-scoped delegates each run their own queryRenderedFeatures
  // on every mousemove — 50-odd of them here — and under 3D terrain a query
  // projects its box onto the ground, a ray walk over the DEM per corner per
  // source. One shared query holds that to one per frame however many layers
  // are clickable.
  //
  // Querying everything together (rather than trusting the layer the delegate
  // fired for) is also what makes feature-state-joined layers behave: they
  // hit-test their transparent unlit features too, so with e.g. ODIN on, an
  // unlit county covers the whole map. hitLit() (click-resolve.ts) decides, and a lit feature
  // underneath an unlit polygon still gets the pointer.
  //
  // The hit-test is also skipped while the camera is in motion: a pointer
  // shape during a drag has nothing to report, and every frame is already
  // busy re-rendering the view. moveend runs the deferred one so the cursor
  // lands correct.
  let hoverPoint: [number, number] | null = null;
  let hoverFrame = 0;
  const updateCursor = () => {
    hoverFrame = 0;
    if (!state.map || !hoverPoint || state.routePick || state.map.isMoving()) return;
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
  onMapHover(e => {
    if (state.measure.active || state.routePick) return;
    hoverPoint = [e.point.x, e.point.y];
    scheduleCursor();
  });
  state.map.on("moveend", scheduleCursor);
  onMapPointLeave(() => {
    hoverPoint = null;
    if (!state.measure.active && !state.routePick) state.map!.getCanvas().style.cursor = "";
  });
}
