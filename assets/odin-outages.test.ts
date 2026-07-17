// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { state as StateSingleton } from './state.js';

vi.mock('./layers/layer-init.js', () => ({
  COUNTY_SRC: 'county_boundaries',
  COUNTY_SRC_LAYER: 'county_boundaries',
}));

const REFRESH_MS = 15 * 60_000;

// vi.resetModules() gives odin-outages.js its OWN copy of state.js's module
// singleton, distinct from anything imported statically at file scope here —
// so `state` must be re-imported dynamically, in the same reset module graph,
// after each reset.
async function setupMap() {
  const { state } = await import('./state.js');
  document.body.innerHTML = '<span id="odinAge"></span>';
  state.layerVisibility = { 'odin-outages': true };
  const map = {
    on: vi.fn(),
    getSource: vi.fn(() => ({})),
    setFeatureState: vi.fn(),
    removeFeatureState: vi.fn(),
  };
  state.map = map as unknown as typeof StateSingleton.map;
  return map;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('odin-outages', () => {
  it('paints fresh data via setFeatureState and marks the age chip fresh', async () => {
    const map = await setupMap();
    const now = new Date().toISOString();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: now, counties: { '06037': [1200, 3] } }),
    })));

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);

    expect(map.setFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06037' },
      { odin_out: 1200, odin_n: 3, odin_utils: null },
    );
    const el = document.getElementById('odinAge')!;
    expect(el.textContent).not.toBe('');
    expect(el.className).toContain('fresh');
  });

  it('does not paint a stale snapshot on the success path', async () => {
    const map = await setupMap();
    const old = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: old, counties: { '06037': [1200, 3] } }),
    })));

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);

    expect(map.setFeatureState).not.toHaveBeenCalled();
  });

  it('unpaints a previously-fresh snapshot once a later success response arrives stale', async () => {
    const map = await setupMap();
    const fresh = new Date().toISOString();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: fresh, counties: { '06037': [1200, 3] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);
    expect(map.setFeatureState).toHaveBeenCalledTimes(1);

    // Advance the clock so the SAME generated_utc is now stale, and the next
    // poll's response also reports that (unchanged) stale timestamp.
    vi.setSystemTime(new Date(Date.now() + 7 * 60 * 60_000));

    await vi.advanceTimersByTimeAsync(REFRESH_MS);

    expect(map.removeFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06037' },
      'odin_out',
    );
  });

  it('catch-path unpaints when the last snapshot has gone stale and the refetch fails', async () => {
    const map = await setupMap();
    const fresh = new Date().toISOString();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: fresh, counties: { '06037': [1200, 3] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);
    expect(map.setFeatureState).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 7 * 60 * 60_000));
    fetchMock.mockImplementation(async () => { throw new Error('network down'); });

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(map.removeFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06037' },
      'odin_out',
    );
    expect(map.removeFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06037' },
      'odin_n',
    );
    expect(map.removeFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: '06037' },
      'odin_utils',
    );
    const el = document.getElementById('odinAge')!;
    expect(el.className).toContain('stale');
  });

  it('catch-path leaves painted data intact when the last snapshot is still fresh', async () => {
    const map = await setupMap();
    const fresh = new Date().toISOString();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: fresh, counties: { '06037': [1200, 3] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);
    expect(map.setFeatureState).toHaveBeenCalledTimes(1);

    // Only a small amount of time passes — well under MAX_AGE_MS (6h) — before
    // the next poll fails.
    fetchMock.mockImplementation(async () => { throw new Error('network down'); });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(map.removeFeatureState).not.toHaveBeenCalled();
  });

  it('clears counties dropped from a newer snapshot and repaints the ones that remain', async () => {
    const map = await setupMap();
    const t1 = new Date().toISOString();
    const counties: Record<string, number[]> = { A: [100, 1], B: [200, 2] };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ generated_utc: t1, counties }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./odin-outages.js');
    mod.initOdinOutages();
    await vi.advanceTimersByTimeAsync(0);
    expect(map.setFeatureState).toHaveBeenCalledTimes(2);

    const t2 = new Date(Date.now() + 60_000).toISOString();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ generated_utc: t2, counties: { A: [150, 1] } as Record<string, number[]> }),
    }));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);

    expect(map.removeFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: 'B' },
      'odin_out',
    );
    expect(map.setFeatureState).toHaveBeenCalledWith(
      { source: 'county_boundaries', sourceLayer: 'county_boundaries', id: 'A' },
      { odin_out: 150, odin_n: 1, odin_utils: null },
    );
  });
});
