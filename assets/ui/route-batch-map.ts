// ─── Route batch map capture ─────────────────────────────────────────────────
// Role: the `Capture` of the batch export one hidden MapLibre map per batch (fixed
//       off-screen 800×500 CSS px container, pixelRatio 2, preserveDrawingBuffer) on the OpenFreeMap light
//       basemap. Per picture it draws the route (rp- sources and layers, same colours as the pane) and the
//       overlay the picture asks for (cause / weight / cost / similar: the solver's RGBA image as a canvas
//       source; alternatives: the other paths), fits the route's bounds without animation, waits for `idle`
//       (20 s per picture; a style that loads late is waited for again by the next picture), captures `canvas.toBlob('image/jpeg', 0.85)` and removes what it added and releases the overlay canvas. A timeout or a failed
//       capture returns `{note}`, never throws. Never touches the visitor's main map (`state.map`).
//       The overlay is a local canvas, the basemap hosts are in CSP_HOSTS, so the canvas stays untainted.
//       `close()` removes the map and its container; the runner (route-batch-run.ts) calls it once at the end.
// Deps: maplibre-gl, constants.ts (OFM_STYLE_URLS), ./route-batch-types.ts (Capture, types only).

import * as maplibregl from 'maplibre-gl';
import { OFM_STYLE_URLS } from '../constants.js';
import type { SurfaceImage } from '../route/surface-image.js';
import type { Capture, CaptureView, PictureId } from './route-batch-types.js';

export const IDLE_TIMEOUT_MS = 20000;
const WIDTH = 800, HEIGHT = 500;
const ALT_COLOURS = ['#2563eb', '#d97706', '#0d9488'];

export interface BatchCapture extends Capture { close(): void }

type MapLike = maplibregl.Map;

const NOTE_INCOMPLETE = 'basemap incomplete';

function overlayCanvas(img: SurfaceImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx?.putImageData(new ImageData(img.rgba as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

const wantsOverlay = (p: PictureId): boolean => p !== 'route' && p !== 'alternatives';

const line = (coordinates: [number, number][]) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates }, properties: {} });

export function createBatchCapture(timeoutMs = IDLE_TIMEOUT_MS): BatchCapture {
  let map: MapLike | null = null;
  let host: HTMLDivElement | null = null;
  let loadedP: Promise<boolean> | null = null;
  let loaded = false;
  let added: { layers: string[]; sources: string[] } = { layers: [], sources: [] };
  let released: HTMLCanvasElement[] = [];

  /** The style has loaded, waiting up to the timeout from this call: a slow load costs one picture, not the batch. */
  const open = async (): Promise<boolean> => {
    if (!loadedP) {
      loadedP = new Promise<boolean>((resolve) => {
        host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = `position:fixed;left:-10000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;pointer-events:none`;
        document.body.append(host);
        const m = new maplibregl.Map({
          container: host, style: OFM_STYLE_URLS.light, interactive: false, attributionControl: false,
          pixelRatio: 2, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true },
        } as maplibregl.MapOptions);
        map = m;
        m.once('load', () => { loaded = true; resolve(true); });
      });
    }
    if (loaded) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const ok = await Promise.race([loadedP, late]);
    clearTimeout(timer);
    return ok;
  };

  const clear = (): void => {
    if (!map) return;
    for (const id of added.layers) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of added.sources) if (map.getSource(id)) map.removeSource(id);
    added = { layers: [], sources: [] };
    for (const c of released) c.width = c.height = 0;
    released = [];
  };

  const draw = (m: MapLike, picture: PictureId, view: CaptureView): void => {
    const source = (id: string, spec: maplibregl.SourceSpecification): void => { m.addSource(id, spec); added.sources.push(id); };
    const layer = (spec: maplibregl.LayerSpecification): void => { m.addLayer(spec); added.layers.push(spec.id); };
    if (wantsOverlay(picture) && view.overlay) {
      const o = view.overlay, canvas = overlayCanvas(o);
      released.push(canvas);
      source('rp-weight', { type: 'canvas', canvas, coordinates: o.coordinates, animate: false } as unknown as maplibregl.SourceSpecification);
      layer({ id: 'rp-weight', type: 'raster', source: 'rp-weight',
        paint: { 'raster-opacity': picture === 'similar' ? 0.7 : 0.8, 'raster-resampling': 'nearest' } });
    }
    if (picture === 'alternatives' && view.alternatives?.length) {
      source('rp-alts', { type: 'geojson', data: { type: 'FeatureCollection', features: view.alternatives.map((a, i) => ({
        ...line(a), properties: { color: ALT_COLOURS[i % ALT_COLOURS.length] } })) } });
      layer({ id: 'rp-alts', type: 'line', source: 'rp-alts', layout: { 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9 } });
    }
    source('rp-route', { type: 'geojson', data: line(view.path) });
    layer({ id: 'rp-route-casing', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.95 } });
    layer({ id: 'rp-route', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0f172a', 'line-width': 4.5 } });
  };

  const idle = (m: MapLike): Promise<boolean> => new Promise((resolve) => {
    const timer = setTimeout(() => { m.off('idle', done); resolve(false); }, timeoutMs);
    function done(): void { clearTimeout(timer); resolve(true); }
    m.once('idle', done);
    m.triggerRepaint();
  });

  const capture: Capture = async (picture, view) => {
    try {
      if (wantsOverlay(picture) && !view.overlay) return { note: 'not available (area too large)' };
      if (!(await open()) || !map) return { note: NOTE_INCOMPLETE };
      const m = map;
      clear();
      draw(m, picture, view);
      const [w, s, e, n] = view.bounds;
      m.fitBounds([[w, s], [e, n]], { animate: false, padding: 0 });
      if (!(await idle(m))) return { note: NOTE_INCOMPLETE };
      const blob = await new Promise<Blob | null>((resolve) => m.getCanvas().toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) return { note: 'picture not available' };
      return { jpeg: new Uint8Array(await blob.arrayBuffer()) };
    } catch {
      return { note: 'picture not available' };
    } finally {
      clear();
    }
  };

  return Object.assign(capture, {
    close(): void {
      clear();
      map?.remove();
      map = null;
      host?.remove();
      host = null;
      loadedP = null;
      loaded = false;
    },
  });
}
