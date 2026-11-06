// @vitest-environment jsdom
// Tests for popup.ts's route-pick guard: while state.routePick is set the map
// tap handler opens (or closes) no popup, so a pick tap only places the end.
// Deps: popup.js, map-input.js (mocked), maplibre-gl (mocked Popup), state.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const input = vi.hoisted(() => ({ tap: null as null | ((e: unknown) => void) }));
vi.mock('./map-input.js', () => ({
  onMapTap: (f: (e: unknown) => void) => { input.tap = f; return () => {}; },
  onMapHover: () => () => {},
  onMapPointLeave: () => () => {},
  tapBox: () => [[0, 0], [1, 1]],
}));
vi.mock('maplibre-gl', () => ({ default: { Popup: class {} }, Popup: class {} }));

import { initPopups, setRouteTapClaims } from './popup.js';
import { state } from './state.js';

describe('popup tap handler', () => {
  const query = vi.fn(() => [] as unknown[]);
  const remove = vi.fn();

  beforeEach(() => {
    query.mockClear();
    remove.mockClear();
    state.routePick = false;
    setRouteTapClaims(null);
    state.measure.active = false;
    state.editMode = 'view';
    state.userLayers = [{ id: 'u1' }] as unknown as typeof state.userLayers;
    state.map = {
      getLayer: () => ({}),
      getSource: () => undefined,
      isMoving: () => false,
      setFilter: () => {},
      setLayoutProperty: () => {},
      setPaintProperty: () => {},
      getLayoutProperty: () => 'visible',
      queryRenderedFeatures: query,
      on: () => {},
      getCanvas: () => document.createElement('canvas'),
    } as unknown as typeof state.map;
    initPopups();
    state.popup = { remove } as unknown as typeof state.popup;
  });

  const tap = () => input.tap!({ point: { x: 5, y: 5 }, lngLat: { lng: 0, lat: 0 } });

  it('acts on a tap when not picking (empty hit closes the popup)', () => {
    tap();
    expect(query).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it('does nothing on a tap the route pane claims (a hole in its similar-cost areas)', () => {
    setRouteTapClaims(() => true);
    tap();
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does nothing while a route end is being picked', () => {
    state.routePick = true;
    tap();
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
