// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../state.js';
import { saveUserData, loadUserData, restoreDrawnFeatures } from './user-data.js';

const STORAGE_KEY = 'tm-user-data';

// jsdom (as configured here, without a real http origin) doesn't provide a
// working localStorage — stub a minimal in-memory version for these tests.
function makeLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}
Object.defineProperty(globalThis, 'localStorage', { value: makeLocalStorageStub(), configurable: true });

function makeFeature(id: string): GeoJSON.Feature {
  return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [-100, 40] }, properties: {} };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="myDataBody"></div>';
  state.userLayers = [];
  state.userLayerCounter = 0;
  state.draw = null;
});

describe('drawn-feature persistence', () => {
  it('saveUserData with state.draw present serializes drawn features', () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [makeFeature('a')] };
    state.draw = { getAll: () => fc } as unknown as typeof state.draw;
    saveUserData();
    const payload = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(payload.drawnFeatures.features).toHaveLength(1);
    expect(payload.drawnFeatures.features[0].id).toBe('a');
  });

  it('saveUserData with state.draw null preserves previously loaded drawn features instead of wiping them', () => {
    // Simulate a prior page load that restored drawn features into localStorage,
    // then a fresh load() call before MapboxDraw's lazy chunk has attached
    // (state.draw still null).
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [makeFeature('a'), makeFeature('b')] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userLayers: [], drawnFeatures: fc }));

    loadUserData(); // state.draw is null here — must cache, not restore-to-map
    expect(state.draw).toBeNull();

    // Some other save happens (e.g. file import, layer delete) while draw is
    // still not loaded.
    saveUserData();

    const payload = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(payload.drawnFeatures.features).toHaveLength(2);
    expect(payload.drawnFeatures.features.map((f: GeoJSON.Feature) => f.id)).toEqual(['a', 'b']);
  });

  it('restoreDrawnFeatures replays cached features into state.draw once it becomes available', () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [makeFeature('a')] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userLayers: [], drawnFeatures: fc }));
    loadUserData();

    const added: unknown[] = [];
    state.draw = {
      add: (data: unknown) => added.push(data),
      getAll: () => ({ type: 'FeatureCollection', features: [] }),
    } as unknown as typeof state.draw;

    restoreDrawnFeatures();
    expect(added).toHaveLength(1);
    expect((added[0] as GeoJSON.FeatureCollection).features[0].id).toBe('a');
  });
});
