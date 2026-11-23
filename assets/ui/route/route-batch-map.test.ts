// @vitest-environment jsdom
// Tests for route-batch-map.ts with maplibre mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ mock: null as FakeMap | null, idleFires: true, loadDelay: 0 }));
interface FakeMap { specs: Record<string, { canvas?: HTMLCanvasElement } & Record<string, unknown>>; sources: Set<string>; layers: Set<string>; removed: boolean; blobArgs: unknown[]; ctx: Record<string, unknown> }

vi.mock('maplibre-gl', () => {
  class Map {
    specs: Record<string, { canvas?: HTMLCanvasElement } & Record<string, unknown>> = {}; sources = new Set<string>(); layers = new Set<string>(); handlers: Record<string, (() => void)[]> = {};
    removed = false; ctx: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.ctx = opts; h.mock = this;
      setTimeout(() => this.emit('load'), h.loadDelay);
    }
    emit(ev: string) { const hs = this.handlers[ev] ?? []; this.handlers[ev] = []; hs.forEach((f) => f()); }
    once(ev: string, f: () => void) { (this.handlers[ev] ??= []).push(f); }
    off(ev: string, f: () => void) { this.handlers[ev] = (this.handlers[ev] ?? []).filter((x) => x !== f); }
    addSource(id: string, spec: Record<string, unknown>) { this.sources.add(id); this.specs[id] = spec; }
    addLayer(s: { id: string }) { this.layers.add(s.id); }
    getSource(id: string) { return this.sources.has(id) ? {} : undefined; }
    getLayer(id: string) { return this.layers.has(id) ? {} : undefined; }
    removeSource(id: string) { this.sources.delete(id); }
    removeLayer(id: string) { this.layers.delete(id); }
    fitBounds() {}
    triggerRepaint() { if (h.idleFires) setTimeout(() => this.emit('idle'), 0); }
    getCanvas() { return { toBlob: (cb: (b: Blob) => void, type: string, q: number) => { this.blobArgs = [type, q]; cb(new Blob([new Uint8Array([1, 2, 3])])); } }; }
    blobArgs: unknown[] = [];
    remove() { this.removed = true; }
  }
  return { Map };
});

import { createBatchCapture, type BatchCapture } from './route-batch-map.js';
import type { Capture } from './route-batch-types.js';

const view = { bounds: [-120, 39, -119, 40] as [number, number, number, number], path: [[-120, 39], [-119, 40]] as [number, number][] };

describe('createBatchCapture', () => {
  beforeEach(() => { h.idleFires = true; h.loadDelay = 0; h.mock = null; document.body.innerHTML = ''; });

  it('typechecks as Capture and returns a jpeg from toBlob', async () => {
    const c: BatchCapture = createBatchCapture(200);
    const cap: Capture = c;
    const r = await cap('route', view);
    expect(r).toEqual({ jpeg: new Uint8Array([1, 2, 3]) });
    expect(h.mock!.blobArgs).toEqual(['image/jpeg', 0.85]);
    expect(h.mock!.ctx.pixelRatio).toBe(2);
    expect(h.mock!.ctx.canvasContextAttributes).toEqual({ preserveDrawingBuffer: true });
    c.close();
  });

  it('removes its sources and layers between pictures and map.remove() on close', async () => {
    const c = createBatchCapture(200);
    await c('alternatives', { ...view, alternatives: [[[-120, 39], [-119.5, 39.5]]] });
    expect(h.mock!.sources.size).toBe(0);
    expect(h.mock!.layers.size).toBe(0);
    const m = h.mock!;
    expect(document.body.children.length).toBe(1);
    c.close();
    expect(m.removed).toBe(true);
    expect(document.body.children.length).toBe(0);
  });

  it('returns a note on idle timeout, without capturing', async () => {
    h.idleFires = false;
    const c = createBatchCapture(30);
    const r = await c('route', view);
    expect(r).toEqual({ note: 'basemap incomplete' });
    expect(h.mock!.blobArgs).toEqual([]);
    c.close();
  });

  it('notes an overlay picture whose overlay is missing', async () => {
    const c = createBatchCapture(200);
    expect(await c('cost', view)).toEqual({ note: 'not available (area too large)' });
    c.close();
  });

  it('uses one map for several pictures', async () => {
    const c = createBatchCapture(200);
    await c('route', view);
    const first = h.mock;
    await c('cause', view);
    expect(h.mock).toBe(first);
    c.close();
  });

  it('a style slower than the timeout costs one picture, not the batch', async () => {
    h.loadDelay = 150;
    const c = createBatchCapture(100);
    expect(await c('route', view)).toEqual({ note: 'basemap incomplete' });
    expect(await c('route', view)).toEqual({ jpeg: new Uint8Array([1, 2, 3]) });
    expect(await c('route', view)).toEqual({ jpeg: new Uint8Array([1, 2, 3]) });
    c.close();
  });

  it('draws an overlay as a canvas source, removes it afterwards and releases the canvas', async () => {
    const ctx = { putImageData: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[-120, 40], [-119, 40], [-119, 39], [-120, 39]];
    const overlay = { rgba: new Uint8ClampedArray(16), width: 2, height: 2, coordinates };
    const c = createBatchCapture(200);
    const r = await c('similar', { ...view, overlay });
    expect(r).toEqual({ jpeg: new Uint8Array([1, 2, 3]) });
    const m = h.mock!;
    expect(m.specs['rp-weight']).toMatchObject({ type: 'canvas', coordinates, animate: false });
    const canvas = m.specs['rp-weight'].canvas!;
    expect(ctx.putImageData).toHaveBeenCalledTimes(1);
    expect((ctx.putImageData.mock.calls[0][0] as { width: number }).width).toBe(2);
    expect(m.sources.size).toBe(0);
    expect(m.layers.size).toBe(0);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    c.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
