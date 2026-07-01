// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerDef } from '../src/types.js';

// ─── Mocks (must come before importing the module under test) ─────────────────

vi.mock('./url-state.js', () => ({ writeUrlState: vi.fn() }));
vi.mock('./layers/layer-init.js', () => ({ ensureLayerData: vi.fn() }));
vi.mock('./raster-probes.js', () => ({
  RASTER_PROBES: {} as Record<string, unknown>,
  ensureRasterLut: vi.fn(),
  updateRasterArrow: vi.fn(),
}));

const _mockLayerById = vi.fn<(id: string) => LayerDef | undefined>();
const _mockLayers: LayerDef[] = [];
vi.mock('../src/registry/index.js', () => ({
  get LAYERS()     { return _mockLayers; },
  layerById: (id: string) => _mockLayerById(id),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { state } from './state.js';
import { writeUrlState } from './url-state.js';
import { ensureLayerData } from './layers/layer-init.js';
import { ensureRasterLut, updateRasterArrow, RASTER_PROBES } from './raster-probes.js';
import { setLayerVisibility, applyGenMode, applyAllGenModes } from './visibility.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLayer(id: string, mapLayerIds: string[], heatLayerId?: string): LayerDef {
  return {
    id, urlCode: 'X', label: id, group: 'test', sourceId: id,
    swatch: '#fff', defaultOn: false, mapLayerIds, downloads: {},
    ...(heatLayerId ? { heatLayerId } : {}),
  } as LayerDef;
}

function mockMap(existingLayerIds: string[] = []) {
  return {
    getLayer: vi.fn((id: string) => existingLayerIds.includes(id) ? {} : undefined),
    setLayoutProperty: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.genMode = {};
  _mockLayers.length = 0;
  _mockLayerById.mockReturnValue(undefined);
  for (const k of Object.keys(RASTER_PROBES)) delete (RASTER_PROBES as Record<string, unknown>)[k];
});

// ─── setLayerVisibility ───────────────────────────────────────────────────────

describe('setLayerVisibility', () => {
  it('does nothing when entry not found', () => {
    state.mapReady = true;
    state.map = mockMap() as unknown as typeof state.map;
    setLayerVisibility('unknown', true);
    expect(writeUrlState).not.toHaveBeenCalled();
  });

  it('does nothing when mapReady is false', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = false;
    state.map = mockMap(['gen-circles']) as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(writeUrlState).not.toHaveBeenCalled();
  });

  it('does nothing when map is null', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = true;
    state.map = null;
    setLayerVisibility('gen', true);
    expect(writeUrlState).not.toHaveBeenCalled();
  });

  it('sets state.layerVisibility', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = true;
    state.map = mockMap(['gen-circles']) as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(state.layerVisibility['gen']).toBe(true);
  });

  it('calls ensureLayerData when showing', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = true;
    state.map = mockMap(['gen-circles']) as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(ensureLayerData).toHaveBeenCalledWith('gen');
  });

  it('does NOT call ensureLayerData when hiding', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = true;
    state.map = mockMap(['gen-circles']) as unknown as typeof state.map;
    setLayerVisibility('gen', false);
    expect(ensureLayerData).not.toHaveBeenCalled();
  });

  it('calls setLayoutProperty "visible" for each existing map layer', () => {
    const layer = makeLayer('gen', ['gen-circles', 'gen-heat']);
    _mockLayerById.mockReturnValue(layer);
    const map = mockMap(['gen-circles', 'gen-heat']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'visible');
  });

  it('calls setLayoutProperty "none" when hiding', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    const map = mockMap(['gen-circles']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    setLayerVisibility('gen', false);
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'none');
  });

  it('skips map layers that do not exist on the map', () => {
    const layer = makeLayer('gen', ['gen-circles', 'gen-ghost']);
    _mockLayerById.mockReturnValue(layer);
    const map = mockMap(['gen-circles']); // gen-ghost not on map
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(map.setLayoutProperty).toHaveBeenCalledTimes(1);
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
  });

  it('calls writeUrlState', () => {
    const layer = makeLayer('gen', ['gen-circles']);
    _mockLayerById.mockReturnValue(layer);
    state.mapReady = true;
    state.map = mockMap(['gen-circles']) as unknown as typeof state.map;
    setLayerVisibility('gen', true);
    expect(writeUrlState).toHaveBeenCalled();
  });

  it('calls ensureRasterLut when showing a raster layer', () => {
    const layer = makeLayer('wind', ['wind-raster']);
    _mockLayerById.mockReturnValue(layer);
    (RASTER_PROBES as Record<string, unknown>)['wind'] = {};
    state.mapReady = true;
    state.map = mockMap(['wind-raster']) as unknown as typeof state.map;
    setLayerVisibility('wind', true);
    expect(ensureRasterLut).toHaveBeenCalledWith('wind');
  });

  it('calls updateRasterArrow(null) when hiding a raster layer', () => {
    const layer = makeLayer('wind', ['wind-raster']);
    _mockLayerById.mockReturnValue(layer);
    (RASTER_PROBES as Record<string, unknown>)['wind'] = {};
    state.mapReady = true;
    state.map = mockMap(['wind-raster']) as unknown as typeof state.map;
    setLayerVisibility('wind', false);
    expect(updateRasterArrow).toHaveBeenCalledWith('wind', null);
  });
});

// ─── applyGenMode ─────────────────────────────────────────────────────────────

describe('applyGenMode', () => {
  function setup(opts: {
    layerIds: string[];
    heatLayerId: string;
    visible: boolean;
    mode?: 'icons' | 'heat' | 'both';
    hasRampEl?: boolean;
  }) {
    const { layerIds, heatLayerId, visible, mode = 'icons', hasRampEl = false } = opts;
    const layer = makeLayer('gen', layerIds, heatLayerId);
    _mockLayerById.mockReturnValue(layer);
    state.layerVisibility['gen'] = visible;
    state.genMode['gen'] = mode;
    const map = mockMap(layerIds);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    if (hasRampEl) {
      const el = document.createElement('div');
      el.id = 'gen-heat-ramp';
      document.body.appendChild(el);
    }
    return map;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when entry not found', () => {
    state.mapReady = true;
    state.map = mockMap() as unknown as typeof state.map;
    applyGenMode('unknown'); // should not throw
  });

  it('does nothing when no heatLayerId', () => {
    const layer = makeLayer('gen', ['gen-circles']); // no heatLayerId
    _mockLayerById.mockReturnValue(layer);
    const map = mockMap(['gen-circles']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    applyGenMode('gen');
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });

  it('does nothing when mapReady is false', () => {
    const layer = makeLayer('gen', ['gen-circles', 'gen-heat'], 'gen-heat');
    _mockLayerById.mockReturnValue(layer);
    const map = mockMap(['gen-circles', 'gen-heat']);
    state.mapReady = false;
    state.map = map as unknown as typeof state.map;
    applyGenMode('gen');
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });

  it('mode=icons: shows icon layers, hides heat layer', () => {
    const map = setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: true, mode: 'icons' });
    applyGenMode('gen');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'none');
  });

  it('mode=heat: shows heat layer, hides icon layers', () => {
    const map = setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: true, mode: 'heat' });
    applyGenMode('gen');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'none');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'visible');
  });

  it('mode=both: shows all layers', () => {
    const map = setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: true, mode: 'both' });
    applyGenMode('gen');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'visible');
  });

  it('layer off: hides everything regardless of mode', () => {
    const map = setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: false, mode: 'both' });
    applyGenMode('gen');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'none');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'none');
  });

  it('defaults to "icons" mode when state.genMode not set', () => {
    const layer = makeLayer('gen', ['gen-circles', 'gen-heat'], 'gen-heat');
    _mockLayerById.mockReturnValue(layer);
    state.layerVisibility['gen'] = true;
    delete state.genMode['gen'];
    const map = mockMap(['gen-circles', 'gen-heat']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    applyGenMode('gen');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'none');
  });

  it('hides ramp element when heat is off', () => {
    setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: true, mode: 'icons', hasRampEl: true });
    applyGenMode('gen');
    const el = document.getElementById('gen-heat-ramp');
    expect(el?.hidden).toBe(true);
  });

  it('shows ramp element when heat is on', () => {
    setup({ layerIds: ['gen-circles', 'gen-heat'], heatLayerId: 'gen-heat', visible: true, mode: 'heat', hasRampEl: true });
    applyGenMode('gen');
    const el = document.getElementById('gen-heat-ramp');
    expect(el?.hidden).toBe(false);
  });
});

// ─── applyAllGenModes ─────────────────────────────────────────────────────────

describe('applyAllGenModes', () => {
  it('calls applyGenMode for every layer with a heatLayerId', () => {
    const genLayer = makeLayer('gen', ['gen-circles', 'gen-heat'], 'gen-heat');
    const noHeatLayer = makeLayer('lines', ['lines-mv']);
    _mockLayers.push(genLayer, noHeatLayer);
    _mockLayerById.mockImplementation((id) => _mockLayers.find(l => l.id === id));
    const map = mockMap(['gen-circles', 'gen-heat']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    state.layerVisibility['gen'] = true;
    state.genMode['gen'] = 'icons';
    applyAllGenModes();
    // only the gen layer (with heatLayerId) should have setLayoutProperty called
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-circles', 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('gen-heat', 'visibility', 'none');
    expect(map.setLayoutProperty).not.toHaveBeenCalledWith('lines-mv', expect.anything(), expect.anything());
  });

  it('skips layers without heatLayerId', () => {
    const noHeatLayer = makeLayer('lines', ['lines-mv']);
    _mockLayers.push(noHeatLayer);
    _mockLayerById.mockImplementation((id) => _mockLayers.find(l => l.id === id));
    const map = mockMap(['lines-mv']);
    state.mapReady = true;
    state.map = map as unknown as typeof state.map;
    applyAllGenModes();
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });
});
