// @vitest-environment jsdom
// The radar frame poll: switching the layer on fetches the current frame at
// once, the poll is skipped while the layer is off, and setTiles fires only
// when the frame changes, never back to an older scan.
import { describe, it, expect, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { emit } from './state-bus.js';
import { startNexradRadar } from './nexrad-radar.js';

describe('NEXRAD radar frame poll', () => {
  it('fetches on switch-on, polls only while on, swaps tiles on a new frame', async () => {
    vi.useFakeTimers();
    let frame = 'ridge::USCOMP-N0Q-202610101200';
    const tms = vi.fn(async () => new Response(JSON.stringify({
      services: [{ id: 'ridge_uscomp_n0q', layername: frame }],
    })));
    vi.stubGlobal('fetch', tms);
    let vis = 'none';
    const setTiles = vi.fn();
    state.map = {
      getLayer: () => ({}),
      getLayoutProperty: () => vis,
      getSource: (id: string) => (id === 'nexrad-radar' ? { setTiles } : undefined),
    } as unknown as MaplibreMap;
    state.layerVisibility = {};

    startNexradRadar();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tms).not.toHaveBeenCalled();           // off: no polling

    vis = 'visible';
    state.layerVisibility = { 'nexrad-radar': true };
    emit('layer:visibility', { id: 'nexrad-radar', visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(tms).toHaveBeenCalledTimes(1);         // switch-on: at once
    expect(setTiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tms).toHaveBeenCalledTimes(2);
    expect(setTiles).toHaveBeenCalledTimes(1);    // same frame: no swap

    frame = 'ridge::USCOMP-N0Q-202610101205';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setTiles).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('NEXRAD radar overlapping fetches', () => {
  it('keeps the newer frame when an older answer lands last', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { state: s } = await import('./state.js');
    const bus = await import('./state-bus.js');
    const { startNexradRadar: start } = await import('./nexrad-radar.js');
    const resp = (frame: string) => new Response(JSON.stringify({ services: [{ id: 'ridge_uscomp_n0q', layername: frame }] }));
    const answers: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => answers.push(r))));
    const setTiles = vi.fn();
    s.map = { getLayer: () => ({}), getLayoutProperty: () => 'visible',
      getSource: (id: string) => (id === 'nexrad-radar' ? { setTiles } : undefined) } as unknown as MaplibreMap;
    s.layerVisibility = { 'nexrad-radar': true };

    start();                                                         // boot fetch
    bus.emit('layer:visibility', { id: 'nexrad-radar', visible: true });  // switch-on fetch
    await vi.advanceTimersByTimeAsync(0);
    answers[1](resp('ridge::USCOMP-N0Q-202610101205'));
    await vi.advanceTimersByTimeAsync(0);
    answers[0](resp('ridge::USCOMP-N0Q-202610101200'));
    await vi.advanceTimersByTimeAsync(0);
    expect(setTiles.mock.calls.map(c => c[0][0])).toEqual([expect.stringContaining('202610101205')]);
    vi.useRealTimers();
  });
});
