// Locks the mouse/touch normalisation in map-input.ts. A desktop browser
// exercises only half of it, so the touch half has to be held here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { state } from './state.js';
import {
  initMapInput, resetMapInput,
  onMapTap, onMapDoubleTap, onMapPoint, onMapPointLeave, onMapHover,
  onMapContextMenu,
} from './map-input.js';

// ─── A MapLibre stand-in that records subscriptions and replays them ─────────

type Listener = (...args: unknown[]) => void;

function makeMap(layers: Record<string, unknown[]> = {}, hidden: string[] = []) {
  const listeners: Record<string, Listener[]> = {};
  return {
    on(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    getLayer: (id: string) => (id in layers ? { id } : undefined),
    getLayoutProperty: (id: string) => (hidden.includes(id) ? 'none' : 'visible'),
    queryRenderedFeatures: (_p: unknown, opts: { layers: string[] }) =>
      layers[opts.layers[0]] ?? [],
    emit(type: string, e: unknown) { for (const fn of listeners[type] ?? []) fn(e); },
    types: () => Object.keys(listeners),
  };
}
type FakeMap = ReturnType<typeof makeMap>;

const mouse = (x = 10, y = 10) => ({ point: { x, y }, lngLat: { lng: 0, lat: 0 } });
const touch = (x = 10, y = 10, count = 1) => ({
  point: { x, y },
  points: Array.from({ length: count }, (_, i) => ({ x: x + i, y })),
  lngLat: { lng: 0, lat: 0 },
});

/** Runs a single-finger tap at (x, y) through the fake map. */
function tap(map: FakeMap, x = 10, y = 10) {
  map.emit('touchstart', touch(x, y));
  map.emit('touchend', touch(x, y));
}

/**
 * Drives performance.now(). Every threshold below is asserted from both sides —
 * a constant tested only from outside can be widened or narrowed to nonsense
 * and the suite stays green.
 */
function clock() {
  let t = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => t);
  return { at(ms: number) { t = ms; } };
}

let map: FakeMap;

beforeEach(() => {
  resetMapInput();
  vi.restoreAllMocks();
  map = makeMap();
  state.map = map as unknown as typeof state.map;
  initMapInput();
});

// ─── Mouse ───────────────────────────────────────────────────────────────────

describe('mouse input', () => {
  it('a click is a tap, and reports a point', () => {
    const tapped = vi.fn(); const pointed = vi.fn();
    onMapTap(tapped); onMapPoint(pointed);
    map.emit('click', mouse());
    expect(tapped).toHaveBeenCalledTimes(1);
    expect(pointed).toHaveBeenCalledTimes(1);
  });

  it('mousemove reports hover and point; mouseout stands them down', () => {
    const hover = vi.fn(); const point = vi.fn(); const left = vi.fn();
    onMapHover(hover); onMapPoint(point); onMapPointLeave(left);
    map.emit('mousemove', mouse(4, 5));
    map.emit('mouseout', mouse(4, 5));
    expect(hover).toHaveBeenCalledTimes(1);
    expect(point).toHaveBeenCalledTimes(1);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('withholds contextmenu while a finger is still down', () => {
    // A phone's long-press menu would otherwise reach a right-click handler —
    // in measure mode, silently discarding the reader's last point.
    const ctx = vi.fn();
    onMapContextMenu(ctx);
    map.emit('touchstart', touch());
    map.emit('contextmenu', mouse());
    expect(ctx).not.toHaveBeenCalled();
  });

  it('withholds dblclick just after a touch', () => {
    const dbl = vi.fn();
    onMapDoubleTap(dbl);
    tap(map);
    map.emit('dblclick', mouse());
    expect(dbl).not.toHaveBeenCalled();
  });

  it('dblclick is a double tap; contextmenu is its own event', () => {
    const dbl = vi.fn(); const ctx = vi.fn();
    onMapDoubleTap(dbl); onMapContextMenu(ctx);
    map.emit('dblclick', mouse());
    map.emit('contextmenu', mouse());
    expect(dbl).toHaveBeenCalledTimes(1);
    expect(ctx).toHaveBeenCalledTimes(1);
  });
});

// ─── Touch ───────────────────────────────────────────────────────────────────

describe('touch input', () => {
  it('a tap is a tap even though no click ever arrives', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    tap(map);
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('a tap reports a point, so readouts work without a mouse', () => {
    const pointed = vi.fn();
    onMapPoint(pointed);
    tap(map, 40, 60);
    expect(pointed).toHaveBeenCalledTimes(1);
  });

  it('a tap does not report hover — there is no cursor to shape', () => {
    const hover = vi.fn();
    onMapHover(hover);
    tap(map);
    expect(hover).not.toHaveBeenCalled();
  });

  it('a finger that shifts a little is still a tap', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    map.emit('touchstart', touch(10, 10));
    map.emit('touchend', touch(15, 13));
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('a drag is not a tap, even a short one', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    map.emit('touchstart', touch(10, 10));
    map.emit('touchmove', touch(30, 10));
    map.emit('touchend', touch(30, 10));
    expect(tapped).not.toHaveBeenCalled();
  });

  it('an ordinary press is a tap; a lingering one is not', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    const c = clock();
    map.emit('touchstart', touch());
    c.at(400);
    map.emit('touchend', touch());
    expect(tapped).toHaveBeenCalledTimes(1);

    c.at(1000);
    map.emit('touchstart', touch());
    c.at(1700);
    map.emit('touchend', touch());
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('a lifted finger cannot be lifted twice', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    tap(map);
    map.emit('touchend', touch()); // no touchstart of its own
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('a second finger landing cancels the tap, however the fingers lift', () => {
    // touchstart carries every live finger, so that is where a pinch is
    // rejected; touchend only ever reports the finger that lifted.
    const tapped = vi.fn();
    onMapTap(tapped);
    map.emit('touchstart', touch(10, 10, 1));
    map.emit('touchstart', touch(10, 10, 2)); // second finger lands
    map.emit('touchend', touch(10, 10, 1));   // one lifts
    map.emit('touchend', touch(12, 12, 1));   // then the other
    expect(tapped).not.toHaveBeenCalled();
  });

  it('a cancelled touch is not a tap', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    map.emit('touchstart', touch());
    map.emit('touchcancel', touch());
    map.emit('touchend', touch());
    expect(tapped).not.toHaveBeenCalled();
  });

  it('two quick taps at one spot are a double tap, and still two taps', () => {
    const tapped = vi.fn(); const dbl = vi.fn();
    onMapTap(tapped); onMapDoubleTap(dbl);
    tap(map); tap(map, 12, 12);
    expect(tapped).toHaveBeenCalledTimes(2);
    expect(dbl).toHaveBeenCalledTimes(1);
  });

  it('a third tap opens a fresh pair rather than firing again', () => {
    const dbl = vi.fn();
    onMapDoubleTap(dbl);
    tap(map); tap(map); tap(map);
    expect(dbl).toHaveBeenCalledTimes(1);
  });

  it('does not pair a tap with one across a cancelled gesture', () => {
    const dbl = vi.fn();
    onMapDoubleTap(dbl);
    tap(map);
    map.emit('touchstart', touch());
    map.emit('touchcancel', touch());
    tap(map);
    expect(dbl).not.toHaveBeenCalled();
  });

  it('pairs taps a thumb-width apart, but not a hand-width apart', () => {
    const dbl = vi.fn();
    onMapDoubleTap(dbl);
    tap(map, 10, 10); tap(map, 25, 10);
    expect(dbl).toHaveBeenCalledTimes(1);

    tap(map, 100, 100); tap(map, 160, 100);
    expect(dbl).toHaveBeenCalledTimes(1);
  });

  it('pairs taps a moment apart, but not a pause apart', () => {
    const dbl = vi.fn();
    onMapDoubleTap(dbl);
    const c = clock();
    tap(map); c.at(250); tap(map);
    expect(dbl).toHaveBeenCalledTimes(1);

    c.at(2_000); tap(map);
    c.at(2_400); tap(map);
    expect(dbl).toHaveBeenCalledTimes(1);
  });
});

// ─── Mouse/touch dedupe ──────────────────────────────────────────────────────

describe('a device that still synthesises mouse events from a tap', () => {
  it('delivers one tap, not two', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    tap(map);
    map.emit('click', mouse()); // the browser's compatibility click
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('does not let the compatibility mousemove fake a hover', () => {
    const hover = vi.fn();
    onMapHover(hover);
    tap(map);
    map.emit('mousemove', mouse());
    expect(hover).not.toHaveBeenCalled();
  });

  it('still stands the cursor down when the mouse leaves the map', () => {
    // Withholding a leave would strand the cursor shape on a laptop that has
    // both a mouse and a touch screen.
    const left = vi.fn();
    onMapPointLeave(left);
    tap(map);
    map.emit('mouseout', mouse());
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('is still muted just after the touch, and open again well after', () => {
    const tapped = vi.fn();
    onMapTap(tapped);
    const c = clock();
    tap(map);
    c.at(600);
    map.emit('click', mouse());
    expect(tapped).toHaveBeenCalledTimes(1);

    c.at(1_500);
    map.emit('click', mouse());
    expect(tapped).toHaveBeenCalledTimes(2);
  });

  it('stays muted through a long drag, where only touchmove marks the time', () => {
    const hover = vi.fn();
    onMapHover(hover);
    const c = clock();
    map.emit('touchstart', touch());
    c.at(2_000);
    map.emit('touchmove', touch(400, 400));
    c.at(2_100);
    map.emit('mousemove', mouse()); // still mid-drag, finger down
    expect(hover).not.toHaveBeenCalled();
  });
});

// ─── Layer-scoped taps ───────────────────────────────────────────────────────

describe('layer-scoped taps', () => {
  it('calls back with the features under a tap', () => {
    const feature = { id: 1 };
    map = makeMap({ 'some-layer': [feature] });
    state.map = map as unknown as typeof state.map;
    resetMapInput();
    initMapInput();

    const query = vi.spyOn(map, 'queryRenderedFeatures');
    const hit = vi.fn();
    onMapTap('some-layer', hit);
    tap(map, 50, 50);
    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit.mock.calls[0][1]).toEqual([feature]);
    // A box, not a point: a finger is wider than a cursor.
    expect(query.mock.calls[0][0]).toEqual([[47, 47], [53, 53]]);
  });

  it('stays quiet when nothing is under the tap', () => {
    map = makeMap({ 'some-layer': [] });
    state.map = map as unknown as typeof state.map;
    resetMapInput();
    initMapInput();

    const hit = vi.fn();
    onMapTap('some-layer', hit);
    tap(map);
    expect(hit).not.toHaveBeenCalled();
  });

  it('widens the hit box on a coarse pointer, for a thumb', () => {
    const mm = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', mm);
    map = makeMap({ 'some-layer': [{ id: 1 }] });
    state.map = map as unknown as typeof state.map;
    resetMapInput();
    initMapInput();

    const query = vi.spyOn(map, 'queryRenderedFeatures');
    onMapTap('some-layer', vi.fn());
    tap(map, 50, 50);
    expect(query.mock.calls[0][0]).toEqual([[42, 42], [58, 58]]);
    expect(mm).toHaveBeenCalledWith('(pointer: coarse)');
    vi.unstubAllGlobals();
  });

  it('does not query a hidden layer', () => {
    map = makeMap({ 'some-layer': [{ id: 1 }] }, ['some-layer']);
    state.map = map as unknown as typeof state.map;
    resetMapInput();
    initMapInput();

    const query = vi.spyOn(map, 'queryRenderedFeatures');
    const hit = vi.fn();
    onMapTap('some-layer', hit);
    tap(map);
    expect(query).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
  });

  it('does not query a layer the style has not added', () => {
    const query = vi.spyOn(map, 'queryRenderedFeatures');
    const hit = vi.fn();
    onMapTap('missing-layer', hit);
    tap(map);
    expect(query).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
  });
});

// ─── Subscription lifecycle ──────────────────────────────────────────────────

describe('unsubscribing', () => {
  it('stops delivery, for the measure tool toggling off', () => {
    const tapped = vi.fn();
    const stop = onMapTap(tapped);
    tap(map);
    stop();
    tap(map, 40, 40);
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it('does not pull a handler subscribed mid-dispatch into that dispatch', () => {
    const late = vi.fn();
    onMapTap(() => { onMapTap(late); });
    tap(map);
    expect(late).not.toHaveBeenCalled();
    tap(map, 40, 40);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('is safe from inside a handler', () => {
    const second = vi.fn();
    let stopSecond = () => {};
    onMapTap(() => stopSecond());
    stopSecond = onMapTap(second);
    expect(() => tap(map)).not.toThrow();
  });
});

// ─── The contract the rest of the app relies on ──────────────────────────────

it('wires a given map once, however often it is initialised', () => {
  // Asserted on a click, not a tap: duplicate touchend listeners mask the fault
  // by cancelling each other out — the first consumes the candidate tap and the
  // second finds none — while duplicate click listeners fire twice.
  const tapped = vi.fn();
  onMapTap(tapped);
  initMapInput();
  initMapInput();
  map.emit('click', mouse());
  expect(tapped).toHaveBeenCalledTimes(1);
});

it('subscribes to every pointer event MapLibre offers, in one place', () => {
  expect(map.types().sort()).toEqual([
    'click', 'contextmenu', 'dblclick', 'mousemove', 'mouseout',
    'touchcancel', 'touchend', 'touchmove', 'touchstart',
  ]);
});
