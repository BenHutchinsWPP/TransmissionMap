// @vitest-environment jsdom
// A return to the tab refetches the weather meta, and that refetch leaves a
// scrubbed timebar where the user put it. A switch-off while the particle
// chunk loads keeps the particles from starting.
import { describe, it, expect, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { initWeatherLive } from './weather-live.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');

describe('weather refresh on return to the tab', () => {
  it('refetches but keeps a scrubbed step', async () => {
    vi.useFakeTimers({ now: NOW });
    document.body.innerHTML = `<div><div id="weatherTimebar">
      <button id="weatherPlayBtn"></button><span class="weather-timebar-label"></span>
      <input type="range"><div class="weather-timebar-ticks"></div></div></div>`;
    const range = document.querySelector<HTMLInputElement>('#weatherTimebar input')!;
    const steps = [-2, -1, 0, 1, 2, 3].map(h => ({
      step: h, valid_utc: new Date(NOW + h * HOUR).toISOString(), suffix: h === 0 ? '' : `_${h}`,
    }));
    const metaFetches = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).includes('meta.json')) return new Response('', { status: 404 });
      metaFetches();
      return new Response(JSON.stringify({ generated_utc: new Date(NOW).toISOString(), steps }));
    }));
    vi.stubGlobal('Image', class { crossOrigin = ''; src = ''; decode() { return Promise.resolve(); } });
    state.map = {
      getLayer: () => ({}),
      getSource: () => ({ updateImage: () => {} }),
      setPaintProperty: () => {},
      once: () => {},
    } as unknown as MaplibreMap;
    state.weatherVar = 'temp';
    state.layerVisibility = { 'weather-live': true };

    initWeatherLive();
    await vi.advanceTimersByTimeAsync(0);
    expect(metaFetches).toHaveBeenCalled();
    expect(range.value).toBe('2');                // parked on the step nearest now

    range.value = '5';
    range.dispatchEvent(new Event('input'));      // the user scrubs ahead
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const before = metaFetches.mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(metaFetches.mock.calls.length).toBeGreaterThan(before); // refetched on return
    expect(range.value).toBe('5');                // scrub kept
    vi.useRealTimers();
  });
});

describe('wind particles and a switch-off during the chunk import', () => {
  it('does not start particles once the layer is off', async () => {
    vi.useFakeTimers({ now: NOW });
    const start = vi.fn(async () => {});
    vi.doMock('./weather-particles.js', () => ({
      startWindParticles: start, stopWindParticles: vi.fn(), updateWindField: vi.fn(async () => {}), setParticleOpacity: vi.fn(),
    }));
    vi.resetModules();
    const { state: s } = await import('./state.js');
    const bus = await import('./state-bus.js');
    const { initWeatherLive: init } = await import('./weather-live.js');
    document.body.innerHTML = `<div><div id="weatherTimebar"><button id="weatherPlayBtn"></button><span class="weather-timebar-label"></span>
      <input type="range"><div class="weather-timebar-ticks"></div></div></div>`;
    const steps = [0, 1].map(h => ({ step: h, valid_utc: new Date(NOW + h * HOUR).toISOString(), suffix: h === 0 ? '' : `_${h}` }));
    let landMeta!: (m: unknown) => void;
    const meta = new Promise(r => { landMeta = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('meta.json')
      ? { ok: true, json: () => meta } : new Response('', { status: 404 })));
    vi.stubGlobal('Image', class { crossOrigin = ''; src = ''; decode() { return Promise.resolve(); } });
    s.map = { getLayer: () => ({}), getSource: () => ({ updateImage: () => {} }), setPaintProperty: () => {}, once: () => {} } as unknown as MaplibreMap;
    s.weatherVar = 'wind';
    s.layerVisibility = { 'weather-live': true };
    init();
    await vi.advanceTimersByTimeAsync(0);
    landMeta({ generated_utc: new Date(NOW).toISOString(), steps, vars: { wind: { bbox: [-130, 20, -60, 55] } } });
    queueMicrotask(() => {                     // switched off while the particle chunk loads
      s.layerVisibility['weather-live'] = false;
      bus.emit('layer:visibility', { id: 'weather-live', visible: false });
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();
    vi.doUnmock('./weather-particles.js');
    vi.useRealTimers();
  });
});
