// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { state as StateSingleton } from './state.js';

vi.mock('./layers/layer-init.js', () => ({
  COUNTY_SRC: 'county_boundaries',
  COUNTY_SRC_LAYER: 'county_boundaries',
}));

const TABLE = {
  version: 'December 2025',
  hazards: ['RISK', 'WFIR'],
  counties: { '06007': [96.2, 4, 99.7, 5] },
};

// vi.resetModules() gives fema-nri.js its own state.js singleton, so state and
// diag-log are re-imported in the same reset module graph.
async function setup() {
  const { state } = await import('./state.js');
  const handlers: Record<string, () => void> = {};
  const map = {
    on: vi.fn((ev: string, fn: () => void) => { handlers[ev] = fn; }),
    getSource: vi.fn(() => ({})),
    setFeatureState: vi.fn(),
  };
  state.map = map as unknown as typeof StateSingleton.map;
  state.layerVisibility = { 'fema-nri': true };
  state.nriHazard = 'RISK';
  const nri = await import('./fema-nri.js');
  const diag = await import('./diag-log.js');
  nri.initFemaNri();
  handlers.idle();
  await vi.waitFor(() => expect(map.setFeatureState).toHaveBeenCalled());
  return { map, nri, diag };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => TABLE })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fema-nri applyJoin', () => {
  it('joins the selected hazard and the composite', async () => {
    const { map, nri } = await setup();
    nri.setNriHazard('WFIR');
    expect(map.setFeatureState).toHaveBeenLastCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06007' },
      { nri_r: 5, nri_s: 99.7, nri_cr: 4, nri_cs: 96.2 },
    );
  });

  it('paints nothing and logs once when the selected hazard is missing from the table', async () => {
    const { map, nri, diag } = await setup();
    nri.setNriHazard('HRCN');
    nri.setNriHazard('HRCN');
    expect(map.setFeatureState).toHaveBeenLastCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06007' },
      { nri_r: null, nri_s: null, nri_cr: 4, nri_cs: 96.2 },
    );
    expect(diag.getDiagLog().filter(e => String(e.detail).includes('HRCN'))).toHaveLength(1);
  });
});
