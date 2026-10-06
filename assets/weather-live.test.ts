// @vitest-environment jsdom
// The weather wash's A/B crossfade on a fake map and a fake rAF: the settled
// repaint waits out a running fade, and W is cached between 'style:weather' events.
import { describe, it, expect, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { emit } from './state-bus.js';
import { WEATHER_WASH_OPACITY, WEATHER_FADE_MS } from './constants.js';
import { initWeatherLive, paintImage, crossfadeOpacities } from './weather-live.js';

describe('weather crossfade', () => {
  const opacity: Record<string, number> = { 'weather-live': WEATHER_WASH_OPACITY, 'weather-live-b': 0 };
  const writes: [string, number][] = [];
  const frames: ((t: number) => void)[] = [];
  const runFrame = (now: number) => frames.splice(0).forEach(f => f(now));

  state.map = {
    getLayer: (id: string) => (id in opacity ? {} : undefined),
    getSource: () => ({ updateImage: vi.fn() }),
    setPaintProperty: (id: string, _p: string, v: number) => { opacity[id] = v; writes.push([id, v]); },
  } as unknown as MaplibreMap;
  state.layerVisibility = {};
  vi.stubGlobal('Image', class { crossOrigin = ''; src = ''; decode() { return Promise.resolve(); } });
  vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => frames.push(f));
  vi.spyOn(performance, 'now').mockReturnValue(0);
  initWeatherLive();

  it('leaves a running fade alone, then repaints the settled pair', async () => {
    await paintImage('u');
    runFrame(WEATHER_FADE_MS / 2);
    state.styleOverrides = { 'weather-live': { opacity: 0.5 } };
    const n = writes.length;
    emit('style:weather');
    expect(writes.length).toBe(n);                 // no stomp mid-fade
    runFrame(WEATHER_FADE_MS);                     // the fade's last frame picks up the new W
    const W = WEATHER_WASH_OPACITY * 0.5;
    expect(opacity['weather-live-b']).toBeCloseTo(W, 10);
    expect(opacity['weather-live']).toBe(0);
    state.styleOverrides = {};
    emit('style:weather');                         // settled: repainted at once
    expect(opacity['weather-live-b']).toBe(WEATHER_WASH_OPACITY);
    expect(opacity['weather-live']).toBe(0);
  });

  it('reads a cached W: only the event refreshes it', () => {
    state.styleOverrides = { 'weather-live': { opacity: 0.25 } };
    expect(crossfadeOpacities(1)[0]).toBe(WEATHER_WASH_OPACITY);
    emit('style:weather');
    expect(crossfadeOpacities(1)[0]).toBeCloseTo(WEATHER_WASH_OPACITY * 0.25, 10);
    state.styleOverrides = {};
    emit('style:weather');
  });
});
