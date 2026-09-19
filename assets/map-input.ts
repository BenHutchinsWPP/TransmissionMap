// ─── Unified map pointer input ───────────────────────────────────────────────
// The single place in the app that subscribes to MapLibre's pointer events.
// Every other module takes taps, pointer positions and hover from here.
// Imported by: popup.ts, measure.ts, raster-probes.ts, hover.ts,
//   layers/map-layers-{load,wecc}.ts, and the panels that close when the reader
//   goes back to the map — ui/{ui,ui-menubar,ui-search,ui-geocoder,ui-openwith}.ts.
//   Wired by map.ts.
// Depends on: state.js (state.map). No other imports.
//
// A touch screen reaches `click`, `dblclick` and `mousemove` only through the
// browser's compatibility mouse events, and a browser emits those only for a
// touch whose `touchend` runs its default action — which is not the case while
// the draw control is attached (mapbox/mapbox-gl-draw#1301). Recognising taps
// from MapLibre's touch events instead keeps tap delivery independent of that,
// and merges mouse and touch once rather than in each consumer.
// eslint.config.js keeps the raw subscriptions confined to this file.

import type { MapGeoJSONFeature, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import { state } from './state.js';

/** A tap, wherever it came from: a mouse click or a finger. */
export type MapPointerEvent = MapMouseEvent | MapTouchEvent;
export type Unsubscribe = () => void;

type PointerHandler = (e: MapPointerEvent) => void;
type LayerTapHandler = (e: MapPointerEvent, features: MapGeoJSONFeature[]) => void;
type MouseHandler = (e: MapMouseEvent) => void;

// A finger is less precise than a cursor, so a tap tests a wider box. Sized by
// device rather than per event: `TouchEvent` is undefined on a non-touch
// desktop browser, and `pointer: coarse` is the reliable "finger" signal.
// Read lazily — module scope runs in environments with no matchMedia.
let coarsePointer: boolean | null = null;
function hitRadius() {
  coarsePointer ??= typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches;
  return coarsePointer ? 8 : 3;
}

/** The box a tap at `e` should hit-test, widened for touch. */
export function tapBox(e: MapPointerEvent): [[number, number], [number, number]] {
  const r = hitRadius();
  return [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
}

// A tap is one finger, down and up close together in space and time.
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 500;
const DOUBLE_TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_PX = 30;
// Where a browser does still synthesise mouse events from a tap, they arrive
// after the touchend that already produced a tap here. Ignoring mouse input for
// a window after any touch keeps one finger from delivering two taps, and
// covers the 300 ms click delay older mobile browsers add.
const MOUSE_MUTE_MS = 700;

const tapHandlers = new Set<PointerHandler>();
const doubleTapHandlers = new Set<PointerHandler>();
const pointHandlers = new Set<PointerHandler>();
const leaveHandlers = new Set<() => void>();
const hoverHandlers = new Set<MouseHandler>();
const contextMenuHandlers = new Set<MouseHandler>();

function subscribe<T>(set: Set<T>, fn: T): Unsubscribe {
  set.add(fn);
  return () => { set.delete(fn); };
}

// Dispatch over a snapshot: a handler may unsubscribe itself or a sibling, and
// one that subscribes mid-dispatch waits for the next event rather than joining
// this one.
function fire<A extends unknown[]>(set: Set<(...a: A) => void>, ...args: A) {
  for (const fn of [...set]) fn(...args);
}

/**
 * A tap on the map: a mouse click, or a single-finger tap on a touch screen.
 * The layer form hit-tests that one layer and only calls back on a hit,
 * standing in for MapLibre's layer-scoped `map.on("click", id, fn)`.
 */
export function onMapTap(fn: PointerHandler): Unsubscribe;
export function onMapTap(layerId: string, fn: LayerTapHandler): Unsubscribe;
export function onMapTap(a: PointerHandler | string, b?: LayerTapHandler): Unsubscribe {
  if (typeof a !== 'string') return subscribe(tapHandlers, a);
  const layerId = a;
  const fn = b!;
  return subscribe(tapHandlers, e => {
    // Hidden layers are gated before the query, not by it: under 3D terrain
    // each queryRenderedFeatures costs a GPU readback per source, and every
    // hoverField layer registers one of these.
    if (!state.map?.getLayer(layerId)) return;
    if (state.map.getLayoutProperty(layerId, 'visibility') === 'none') return;
    const features = state.map.queryRenderedFeatures(tapBox(e), { layers: [layerId] });
    if (features.length) fn(e, features);
  });
}

/** A double click, or two taps in quick succession at the same spot. */
export function onMapDoubleTap(fn: PointerHandler): Unsubscribe {
  return subscribe(doubleTapHandlers, fn);
}

/**
 * Where the pointer is, for readouts the user wants on either device: the mouse
 * position as it moves, and the spot a finger tapped.
 */
export function onMapPoint(fn: PointerHandler): Unsubscribe {
  return subscribe(pointHandlers, fn);
}

/**
 * The mouse left the map, so anything tracking it should stand down. A finger
 * never leaves, so this is mouse-only — a touch readout stays until the next tap.
 */
export function onMapPointLeave(fn: () => void): Unsubscribe {
  return subscribe(leaveHandlers, fn);
}

/**
 * Mouse-only hover, for affordances a touch screen has no equivalent of —
 * cursor shape, rubber-band previews. Deliberately silent on touch.
 */
export function onMapHover(fn: MouseHandler): Unsubscribe {
  return subscribe(hoverHandlers, fn);
}

/** Right-click. Mouse-only; a long press is not mapped to it. */
export function onMapContextMenu(fn: MouseHandler): Unsubscribe {
  return subscribe(contextMenuHandlers, fn);
}

let lastTouchAt = -Infinity;
let touchStart: { x: number; y: number; at: number } | null = null;
let lastTap: { x: number; y: number; at: number } | null = null;

function mouseMuted() {
  return performance.now() - lastTouchAt < MOUSE_MUTE_MS;
}

function emitTap(e: MapPointerEvent) {
  fire(tapHandlers, e);
  fire(pointHandlers, e);
}

// Keyed on the map instance so a second call for the same map is a no-op while
// a new map still gets wired.
let wiredMap: unknown = null;

export function initMapInput() {
  const map = state.map;
  if (!map || wiredMap === map) return;
  wiredMap = map;

  map.on('click', e => { if (!mouseMuted()) emitTap(e); });
  map.on('dblclick', e => { if (!mouseMuted()) fire(doubleTapHandlers, e); });
  // Also gated on touchStart: during a long press the finger is still down, so
  // lastTouchAt stops advancing and the mute would expire under it — letting a
  // phone's long-press context menu reach a right-click handler.
  map.on('contextmenu', e => {
    if (!mouseMuted() && !touchStart) fire(contextMenuHandlers, e);
  });
  map.on('mousemove', e => {
    if (mouseMuted()) return;
    fire(hoverHandlers, e);
    fire(pointHandlers, e);
  });
  // Not muted: standing down is idempotent and always safe, and withholding it
  // would strand the cursor shape on a laptop with both a mouse and a screen.
  map.on('mouseout', () => { fire(leaveHandlers); });

  // touchstart carries every live finger (MapTouchEvent reads `touches` there),
  // so a second finger landing is what cancels the candidate tap — touchend
  // reads `changedTouches` and would see just the one finger that lifted.
  map.on('touchstart', e => {
    lastTouchAt = performance.now();
    touchStart = e.points.length === 1
      ? { x: e.point.x, y: e.point.y, at: lastTouchAt }
      : null;
  });
  map.on('touchmove', () => { lastTouchAt = performance.now(); });
  map.on('touchcancel', () => {
    lastTouchAt = performance.now();
    touchStart = null;
    lastTap = null; // a cancelled gesture is no half of a double tap
  });
  map.on('touchend', e => {
    lastTouchAt = performance.now();
    const start = touchStart;
    touchStart = null;
    if (!start) return;
    if (Math.hypot(e.point.x - start.x, e.point.y - start.y) > TAP_MAX_MOVE_PX) return;
    if (lastTouchAt - start.at > TAP_MAX_MS) return;

    const previous = lastTap;
    lastTap = { x: e.point.x, y: e.point.y, at: lastTouchAt };
    emitTap(e);
    if (previous
        && lastTouchAt - previous.at <= DOUBLE_TAP_MAX_MS
        && Math.hypot(e.point.x - previous.x, e.point.y - previous.y) <= DOUBLE_TAP_MAX_PX) {
      lastTap = null; // a third tap opens a fresh pair rather than extending this one
      fire(doubleTapHandlers, e);
    }
  });
}

// Test seam: drops every subscription and the gesture state. Pair it with a
// fresh map — it also forgets which map is wired.
export function resetMapInput() {
  for (const set of [tapHandlers, doubleTapHandlers, pointHandlers, leaveHandlers,
                     hoverHandlers, contextMenuHandlers]) {
    (set as Set<unknown>).clear();
  }
  wiredMap = null;
  coarsePointer = null;
  lastTouchAt = -Infinity;
  touchStart = null;
  lastTap = null;
}
