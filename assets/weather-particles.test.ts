// @vitest-environment jsdom
// The particle canvas carries the weather layer's opacity override, set before
// or after the canvas exists, and returns to full opacity when it clears.
import { it, expect, vi, afterEach } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { setParticleOpacity, startWindParticles, stopWindParticles } from './weather-particles.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fades the particle canvas with the weather opacity override', async () => {
  const container = document.createElement('div');
  state.map = {
    getContainer: () => container,
    getCanvas: () => ({ clientWidth: 100, clientHeight: 100 }),
    getBounds: () => ({ getWest: () => 0, getEast: () => 1, getSouth: () => 0, getNorth: () => 1 }),
    on: () => {}, off: () => {},
  } as unknown as MaplibreMap;
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true, json: () => Promise.resolve({ vars: { wind: { bbox: [0, 0, 1, 1], uv_min: -1, uv_max: 1 } } }),
  }));
  vi.stubGlobal('Image', class { crossOrigin = ''; src = ''; naturalWidth = 1; naturalHeight = 1; decode() { return Promise.resolve(); } });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {}, scale() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D);

  setParticleOpacity(0.4);                       // override restored before particles start
  await startWindParticles();
  const canvas = container.querySelector<HTMLCanvasElement>('canvas')!;
  expect(canvas.style.opacity).toBe('0.4');
  setParticleOpacity(1);                         // override cleared
  expect(canvas.style.opacity).toBe('1');
  stopWindParticles();
});
