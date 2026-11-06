// ─── Proximity check: the map half (lazy chunk, with ui-proximity.ts) ────────
// Role: draws the grouped points of the Proximity tab: a coloured dot per point and a
//       bubble of radius x/2 around it (a circle sized by bubbles.ts), so two bubbles
//       touch when the points are within the threshold. Map: source `px-points` and its
//       layers `px-bubbles`, `px-points`, `px-focus` (the focused group's bubbles),
//       `px-focus-pt` (the focused point), added on the first result and removed (layers,
//       then the source) on close or Reset, never visibility-toggled. The bubble layers
//       stop at the zoom where the largest bubble outgrows the tile buffer (bubbleMaxZoom).
//       Each result replaces the data; the first result of a file that has points fits the map to it.
//       A row click only outlines its point and group (no camera move); the row's zoom button
//       (onFly) flies to the point; a tap on a point (map-input.ts onMapTap) focuses its row. popup.ts skips a tap on `px-points`.
//       Session only: no URL, no undo step, no value from the file in any log.
// Deps: state.ts (map), map-input.ts (onMapTap), proximity/bubbles.ts, proximity/clear.ts, overlay-layers.ts.
//       Used by: ui-proximity.ts (startProximityMap), which passes its seam in.

import type { LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { onMapTap, type Unsubscribe } from '../map-input.js';
import { proxFeatures, bubbleRadiusExpr, bubbleMaxZoom, bubblePx, mercScale, MAX_BUBBLE_PX } from '../proximity/bubbles.js';
import { setProximityClear } from '../proximity/clear.js';
import { setGeojson, removeOverlay } from './overlay-layers.js';

/** What the map half needs from the tab (so it does not import it). */
export interface ProxSeam {
  onResult(cb: (s: MapState | null) => void): () => void;
  onRow(cb: (i: number) => void): () => void;
  onFly(cb: (i: number) => void): () => void;
  focusPoint(i: number): void;
  padding(): { top: number; left: number; right: number; bottom: number };
}
export interface MapState {
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  km: number;
  result: { group: ArrayLike<number> };
}

/** Ten colours that read on light and dark basemaps. */
export const PX_PALETTE = ['#e6194b', '#3cb44b', '#f58231', '#4363d8', '#911eb4', '#0aa5a5', '#c8a000', '#f032e6', '#7a5230', '#6b7a1e'];
const SOURCES = ['px-points'];
const LAYERS = ['px-focus-pt', 'px-focus', 'px-points', 'px-bubbles'];
const BUBBLE_LAYERS = ['px-bubbles', 'px-focus'];
const NONE = ['==', ['get', 'g'], -1] as never;
const colour = ['match', ['get', 'c'], ...PX_PALETTE.flatMap((c, k) => [k, c]), '#888888'] as never;

let cur: MapState | null = null;
let fittedFor: WeakRef<object> | null = null;
let tapOff: Unsubscribe | null = null;
let started = false;

function addLayer(spec: LayerSpecification) {
  if (!state.map!.getLayer(spec.id)) state.map!.addLayer(spec);
}

function removeAll() {
  tapOff?.(); tapOff = null;
  setProximityClear(null);
  removeOverlay(LAYERS, SOURCES);
}

function setFocus(i: number | null) {
  const map = state.map;
  if (!map || !map.getLayer('px-focus')) return;
  const g = i === null || !cur ? -1 : Number(cur.result.group[i]);
  map.setFilter('px-focus', ['==', ['get', 'g'], g] as never);
  map.setFilter('px-focus-pt', (i === null ? ['==', ['get', 'i'], -1] : ['==', ['get', 'i'], i]) as never);
}

function draw(s: MapState, seam: ProxSeam) {
  const map = state.map;
  if (!map) return;
  const f = proxFeatures(s.lon, s.lat, s.result.group);
  setGeojson('px-points', f.points, MAX_BUBBLE_PX);
  const radius = bubbleRadiusExpr(s.km) as never;
  addLayer({ id: 'px-bubbles', type: 'circle', source: 'px-points',
    paint: { 'circle-color': colour, 'circle-opacity': 0.16, 'circle-radius': radius, 'circle-stroke-color': colour,
      'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.8, 'circle-pitch-alignment': 'map' } });
  addLayer({ id: 'px-points', type: 'circle', source: 'px-points',
    paint: { 'circle-color': colour, 'circle-radius': 4.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } });
  addLayer({ id: 'px-focus', type: 'circle', source: 'px-points', filter: NONE,
    paint: { 'circle-opacity': 0, 'circle-radius': radius, 'circle-stroke-color': '#111111', 'circle-stroke-width': 3,
      'circle-pitch-alignment': 'map' } });
  const maxZoom = bubbleMaxZoom(s.km, f.sMax);
  for (const id of BUBBLE_LAYERS) {
    map.setPaintProperty(id, 'circle-radius', radius);
    map.setLayerZoomRange(id, 0, maxZoom);
  }
  addLayer({ id: 'px-focus-pt', type: 'circle', source: 'px-points', filter: ['==', ['get', 'i'], -1] as never,
    paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 9, 'circle-stroke-color': '#111111', 'circle-stroke-width': 3 } });
  setProximityClear(removeAll);
  tapOff ??= onMapTap('px-points', (_e, feats) => {
    const i = Number(feats[0]?.properties?.i);
    if (!Number.isInteger(i)) return;
    setFocus(i);
    seam.focusPoint(i);
  });
  setFocus(null);
  if (fittedFor?.deref() !== s.lon) {
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    for (const ft of f.points.features) {
      const [x, y] = ft.geometry.coordinates;
      w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y);
    }
    if (w <= e) {
      fittedFor = new WeakRef(s.lon as object);
      map.fitBounds([[w, so], [e, n]], { padding: seam.padding(), maxZoom: 16, duration: 600 });
    }
  }
}

/** The zoom at which a bubble of the threshold's radius spans about 100 px. */
export function bubbleZoom(lat: number, km: number): number {
  const z = Math.log2(100 / bubblePx(km, mercScale(lat), 0));
  return Math.max(3, Math.min(17, z));
}

function flyTo(i: number) {
  const map = state.map;
  if (!map || !cur) return;
  const target = bubbleZoom(cur.lat[i], cur.km);
  const z = map.getZoom();
  map.flyTo({ center: [cur.lon[i], cur.lat[i]], zoom: z >= target - 1 && z <= target + 2 ? z : target });
  setFocus(i);
}

/** Wire the map half to the tab once; the subscriptions live as long as the chunk. */
export function startProximityMap(seam: ProxSeam): void {
  if (started) return;
  started = true;
  seam.onResult(s => {
    cur = s;
    if (!s) { removeAll(); return; }
    draw(s, seam);
  });
  seam.onRow(setFocus);
  seam.onFly(flyTo);
}

/** Test support: forget module state. */
export function resetProximityMapForTest(): void { cur = null; fittedFor = null; tapOff = null; started = false; }
