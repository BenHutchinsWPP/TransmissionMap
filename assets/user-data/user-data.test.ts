// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../state.js';
import {
  saveUserData, loadUserData, restoreDrawnFeatures, addImportedLayer, renderMyDataTab, startInlineEdit,
} from './user-data.js';
import { initDraw, applyColorPick } from './user-data-draw.js';
import { handleFileOpen } from './user-data-import.js';
import { wireMyData } from '../ui/ui-mydata.js';

const initDrawMock = vi.fn();
vi.mock('./draw-chunk.js', () => ({
  initDraw: () => initDrawMock(),
}));

// In-memory stand-in for MapboxDraw: API calls mutate the store and fire no events.
const { FakeDraw } = vi.hoisted(() => {
  class FakeDraw {
    static instances = 0;
    static modes = {};
    store = new Map<string, GeoJSON.Feature>();
    constructor() { FakeDraw.instances++; }
    add(g: GeoJSON.Feature | GeoJSON.FeatureCollection) {
      const feats = g.type === 'FeatureCollection' ? g.features : [g];
      // Like MapboxDraw, adds features in order and throws on a feature without geometry.
      return feats.map(f => {
        if (!f.geometry) throw new Error('Invalid GeoJSON');
        const id = String(f.id ?? `auto${this.store.size}`);
        this.store.set(id, structuredClone({ ...f, id }));
        return id;
      });
    }
    get(id: string) { return this.store.get(id); }
    getAll(): GeoJSON.FeatureCollection {
      return { type: 'FeatureCollection', features: [...this.store.values()].map(f => structuredClone(f)) };
    }
    set(fc: GeoJSON.FeatureCollection) { this.store.clear(); this.add(fc); }
    delete(id: string) { this.store.delete(id); return this; }
    setFeatureProperty(id: string, k: string, v: unknown) {
      const f = this.store.get(id);
      if (f) f.properties = { ...f.properties, [k]: v };
      return this;
    }
    changeMode() { return this; }
    trash() { return this; }
  }
  return { FakeDraw };
});
vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: FakeDraw }));

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

function makeFeature(id: string, props: Record<string, unknown> = {}): GeoJSON.Feature {
  return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [-100, 40] }, properties: props };
}
const fcOf = (...ids: string[]): GeoJSON.FeatureCollection =>
  ({ type: 'FeatureCollection', features: ids.map(id => makeFeature(id)) });

function makeStubMap() {
  return {
    addControl: vi.fn(), on: vi.fn(), once: vi.fn(), loaded: () => true,
    addSource: vi.fn(), addLayer: vi.fn(), getSource: () => undefined, getLayer: () => undefined,
    setLayoutProperty: vi.fn(), fitBounds: vi.fn(),
  };
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY)!);
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

wireMyData();

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  initDrawMock.mockClear();
  document.body.innerHTML = '<div id="myDataBody"></div>';
  state.userLayers = [];
  state.userLayerCounter = 0;
  state.draw = null;
  state.map = null;
  state.editMode = 'edit';
  FakeDraw.instances = 0;
  loadUserData(); // empty storage: resets the module's drawn-feature cache
});

describe('drawn-feature persistence', () => {
  it('saveUserData with state.draw present serializes drawn features', () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [makeFeature('a')] };
    state.draw = { getAll: () => fc } as unknown as typeof state.draw;
    saveUserData();
    const payload = stored();
    expect(payload.drawnFeatures.features).toHaveLength(1);
    expect(payload.drawnFeatures.features[0].id).toBe('a');
  });

  it('saveUserData with state.draw null preserves previously loaded drawn features instead of wiping them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userLayers: [], drawnFeatures: fcOf('a', 'b') }));

    loadUserData(); // state.draw is null here — must cache, not restore-to-map
    expect(state.draw).toBeNull();

    saveUserData();

    const payload = stored();
    expect(payload.drawnFeatures.features.map((f: GeoJSON.Feature) => f.id)).toEqual(['a', 'b']);
  });

  it('restoreDrawnFeatures replays cached features into state.draw once it becomes available', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userLayers: [], drawnFeatures: fcOf('a') }));
    loadUserData();

    const added: unknown[] = [];
    state.draw = {
      add: (data: unknown) => added.push(data),
      getAll: () => ({ type: 'FeatureCollection', features: [] }),
    } as unknown as typeof state.draw;

    restoreDrawnFeatures();
    expect(added).toHaveLength(1);
    expect((added[0] as GeoJSON.Feature).id).toBe('a');
  });

  it('loadUserData triggers draw-chunk loading if drawn features exist and map is present', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userLayers: [], drawnFeatures: fcOf('a') }));
    state.map = {} as unknown as typeof state.map;

    loadUserData();
    await flush();
    expect(initDrawMock).toHaveBeenCalledTimes(1);
  });
});

describe('restore path', () => {
  const payload = () => JSON.stringify({
    userLayers: [
      { filename: 'one.geojson', geojson: fcOf('l1'), color: '#ff0000', visible: true },
      { filename: 'two.geojson', geojson: fcOf('l2'), color: '#00ff00', visible: false },
    ],
    drawnFeatures: fcOf('a', 'b'),
  });

  it('loadUserData with stored layers and drawn features makes no localStorage writes', () => {
    localStorage.setItem(STORAGE_KEY, payload());
    state.map = makeStubMap() as unknown as typeof state.map;
    const setItem = vi.spyOn(localStorage, 'setItem');

    loadUserData();

    expect(setItem).not.toHaveBeenCalled();
    expect(state.userLayers.map(l => [l.filename, l.visible])).toEqual([['one.geojson', true], ['two.geojson', false]]);
  });

  it('drawn features survive load, then initDraw, then a save', async () => {
    localStorage.setItem(STORAGE_KEY, payload());
    state.map = makeStubMap() as unknown as typeof state.map;

    loadUserData();
    initDraw();
    addImportedLayer('three.geojson', fcOf('l3'));

    const saved = stored();
    expect(saved.drawnFeatures.features.map((f: GeoJSON.Feature) => f.id)).toEqual(['a', 'b']);
    expect(saved.userLayers.map((l: { filename: string }) => l.filename))
      .toEqual(['one.geojson', 'two.geojson', 'three.geojson']);
  });

  it('a malformed stored layer is skipped and the rest load', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      userLayers: [{ filename: 'bad' }, { filename: 'good.geojson', geojson: fcOf('g') }],
      drawnFeatures: fcOf(),
    }));
    loadUserData();
    expect(state.userLayers.map(l => l.filename)).toEqual(['good.geojson']);
  });
});

// Hold-back and flush before the first load are covered by user-data-store.test.ts.
describe('loading when draw is already up', () => {
  it('joins the stored drawings to the ones on the map and skips a malformed one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.map = makeStubMap() as unknown as typeof state.map;
    initDraw();
    state.draw!.add(makeFeature('pin'));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      userLayers: [],
      drawnFeatures: { type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: null, properties: {} }, makeFeature('a'),
      ] },
    }));

    expect(() => loadUserData()).not.toThrow();
    expect(state.draw!.getAll().features.map(f => f.id).sort()).toEqual(['a', 'pin']);
  });
});

describe('initDraw', () => {
  it('called twice creates one draw control', () => {
    const map = makeStubMap();
    state.map = map as unknown as typeof state.map;
    initDraw();
    initDraw();
    expect(FakeDraw.instances).toBe(1);
    expect(map.addControl).toHaveBeenCalledTimes(1);
  });
});

describe('a malformed stored drawing', () => {
  it('is skipped on restore, and drawing still saves', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      userLayers: [],
      drawnFeatures: { type: 'FeatureCollection', features: [
        makeFeature('a'), { type: 'Feature', geometry: null, properties: {} },
      ] },
    }));
    loadUserData();
    const map = makeStubMap();
    state.map = map as unknown as typeof state.map;

    initDraw();

    const handler = (type: string) => map.on.mock.calls.find(c => c[0] === type)?.[1];
    expect(handler('draw.create')).toBeTypeOf('function');
    expect(handler('draw.update')).toBeTypeOf('function');
    expect(handler('draw.delete')).toBeTypeOf('function');
    expect(state.draw!.getAll().features.map(f => f.id)).toEqual(['a']);

    state.draw!.add(makeFeature('new'));
    handler('draw.create')({ features: [{ id: 'new' }] });
    expect(stored().drawnFeatures.features.map((f: GeoJSON.Feature) => f.id)).toEqual(['a', 'new']);
  });
});

describe('edits made through the draw API persist', () => {
  function withDrawn(...feats: GeoJSON.Feature[]) {
    const draw = new FakeDraw();
    draw.add({ type: 'FeatureCollection', features: feats });
    state.draw = draw as unknown as typeof state.draw;
    renderMyDataTab();
    return draw;
  }
  const storedDrawn = () => stored().drawnFeatures.features as GeoJSON.Feature[];

  it('renaming a drawn feature', () => {
    withDrawn(makeFeature('a', { name: 'old' }));
    const span = document.querySelector<HTMLElement>('.my-feature-name[data-edit="drawn"]')!;
    startInlineEdit(span);
    const input = span.querySelector('input')!;
    input.value = 'new name';
    input.dispatchEvent(new Event('blur'));
    expect(storedDrawn()[0].properties?.name).toBe('new name');
  });

  it('renaming a file feature', () => {
    addImportedLayer('f.geojson', fcOf('x'));
    state.userLayers[0].expanded = true;
    renderMyDataTab();
    const span = document.querySelector<HTMLElement>('.my-feature-name[data-edit="file-feature"]')!;
    startInlineEdit(span);
    const input = span.querySelector('input')!;
    input.value = 'renamed';
    input.dispatchEvent(new Event('blur'));
    expect(stored().userLayers[0].geojson.features[0].properties.name).toBe('renamed');
  });

  it('× on a drawn row', () => {
    withDrawn(makeFeature('a'), makeFeature('b'));
    saveUserData();
    document.querySelector<HTMLElement>('[data-action="delete-drawn"][data-feature-id="a"]')!.click();
    expect(storedDrawn().map(f => f.id)).toEqual(['b']);
  });

  it('a colour change', () => {
    withDrawn(makeFeature('a'));
    const picker = document.querySelector<HTMLElement>('.color-picker[data-feature-id="a"]')!;
    applyColorPick(picker, '#123456');
    expect(storedDrawn()[0].properties?.color).toBe('#123456');
  });

  it('a colour change leaves the open picker in place (no re-render)', () => {
    withDrawn(makeFeature('a'));
    const picker = document.querySelector<HTMLElement>('.color-picker[data-feature-id="a"]')!;
    applyColorPick(picker, '#123456');
    applyColorPick(picker, '#654321');
    expect(document.querySelector('.color-picker[data-feature-id="a"]')).toBe(picker);
    expect(document.getElementById('myDataBody')!.contains(picker)).toBe(true);
    expect(storedDrawn()[0].properties?.color).toBe('#654321');
  });

  it('importing a TransmissionMap drawings file', async () => {
    withDrawn();
    const body = JSON.stringify({ ...fcOf('d1', 'd2'), _tmSource: 'TransmissionMap' });
    handleFileOpen(new File([body], 'drawings.geojson'));
    await flush();
    expect(storedDrawn().map(f => f.id)).toEqual(['d1', 'd2']);
  });
});

describe('addImportedLayer', () => {
  it('drops a file-supplied __src so the file cannot pick a main-layer popup', () => {
    const f = { ...makeFeature('a'), properties: { __src: 'osm-dc-circles', name: 'x' } };
    addImportedLayer('evil.geojson', { type: 'FeatureCollection', features: [f] });
    const props = state.userLayers[0].geojson.features[0].properties!;
    expect(props).not.toHaveProperty('__src');
    expect(props.name).toBe('x');
  });
});
