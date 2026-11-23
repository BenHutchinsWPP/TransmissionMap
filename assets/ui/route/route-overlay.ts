// ─── Route planner map overlay ───────────────────────────────────────────────
// Role: every `rp-` map source and layer of the Route pane, drawn on a map handed in through `getMap`
//       (a plain fake in tests). Layers and sources are added or removed, never visibility-toggled; a layer
//       goes below the next present one of ORDER. Holds the two canvases (the similar-cost areas, whose
//       worker RGBA is kept and only alpha is rewritten; the cell-weight image, whose RGBA is dropped once
//       drawn) and releases them (width/height 0) with their sources. Every call is a no-op, false or null
//       without a map. Decisions (what to draw, when, the legend) stay with the pane.
// Deps: route/route.ts (searchBufferM, SURFACE_PALETTE, types), route/cost.ts (greatCircleM),
//       route/surface-image.ts (SurfaceImage, type only); maplibre-gl types only. Never state.ts, ui-route.ts or a tab.
import type { CanvasSource, CanvasSourceSpecification, FilterSpecification, GeoJSONSource, LayerSpecification, MapGeoJSONFeature, PointLike, SourceSpecification } from 'maplibre-gl';
import { searchBufferM, SURFACE_PALETTE, type OverlayMode, type RouteResult, type RouteSurface, type RowsImage, type WeightImage } from '../../route/route.js';
import { greatCircleM } from '../../route/cost.js';
import type { SurfaceImage } from '../../route/surface-image.js';

type LngLat = [number, number];
type FC = GeoJSON.FeatureCollection;

/** The subset of maplibre's Map the overlay calls. */
export interface OverlayMap {
  getLayer(id: string): unknown;
  addLayer(spec: LayerSpecification, before?: string): unknown;
  removeLayer(id: string): unknown;
  getSource(id: string): unknown;
  addSource(id: string, spec: SourceSpecification | CanvasSourceSpecification): unknown;
  removeSource(id: string): unknown;
  setPaintProperty(layer: string, name: string, value: unknown): unknown;
  once(type: 'render', fn: () => void): unknown;
  triggerRepaint(): void;
  queryRenderedFeatures(point: PointLike, opts: { layers: string[] }): MapGeoJSONFeature[];
}

/** Crossing markers start here: at a whole-route zoom they would hide the route's colours. */
const CROSS_MINZOOM = 8;
const CROSS_COLOURS: Record<string, [string, string]> = {   // kind → [fill, stroke]
  river: ['#0ea5e9', '#ffffff'], road: ['#ffffff', '#334155'], rail: ['#334155', '#ffffff'],
  pipeline: ['#a16207', '#ffffff'], line230: ['#6b21a8', '#ffffff'], line100: ['#a78bfa', '#ffffff'],
};

/** Paint order, bottom to top; a layer is inserted below the next one present. */
export const ORDER: readonly string[] = ['rp-weight', 'rp-surface', 'rp-area-fill', 'rp-area-line', 'rp-chord', 'rp-ghost-casing', 'rp-ghost', 'rp-alts', 'rp-alts-label',
  'rp-route-casing', 'rp-route', 'rp-cross', 'rp-marker', 'rp-marker-label'];
export const SOURCES: readonly string[] = ['rp-weight', 'rp-surface', 'rp-area', 'rp-chord', 'rp-ghost', 'rp-alts', 'rp-route', 'rp-cross', 'rp-marker'];

// ─── pure helpers ────────────────────────────────────────────────────────────

/** An approximate search-area outline: a capsule `bufM` either side of segment a–b. */
export function capsule(a: LngLat, b: LngLat, bufM: number, steps = 24): GeoJSON.Polygon {
  const lat0 = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const kx = 111_320 * Math.cos(lat0), ky = 110_574;
  const A = [a[0] * kx, a[1] * ky], B = [b[0] * kx, b[1] * ky];
  const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
  const ring: LngLat[] = [];
  const arc = (c: number[], from: number) => {
    for (let k = 0; k <= steps; k++) {
      const th = from + (Math.PI * k) / steps;
      ring.push([(c[0] + bufM * Math.cos(th)) / kx, (c[1] + bufM * Math.sin(th)) / ky]);
    }
  };
  arc(B, ang - Math.PI / 2);
  arc(A, ang + Math.PI / 2);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Palette class (1..4) per pixel of the worker's image; 0 = transparent / no class. */
export function pixelClasses(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    if (!rgba[i + 3]) continue;
    for (let k = 1; k < SURFACE_PALETTE.length; k++) {
      const c = SURFACE_PALETTE[k];
      if (rgba[i] === c[0] && rgba[i + 1] === c[1] && rgba[i + 2] === c[2]) { out[j] = k; break; }
    }
  }
  return out;
}

/** Write `img` from the original RGBA with alpha 0 for classes above `threshold`. */
export function maskSurface(orig: Uint8ClampedArray, cls: Uint8Array, bands: readonly number[], threshold: number, out: Uint8ClampedArray): void {
  const maxClass = bands.filter((b) => b <= threshold + 1e-9).length;
  out.set(orig);
  for (let j = 0; j < cls.length; j++) if (cls[j] > maxClass || !cls[j]) out[j * 4 + 3] = 0;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** True when `lngLat` falls on a transparent pixel of `img` (drawn over `geo`'s corners)
 *  that has drawn pixels left, right, above and below it: a hole in the areas, not their outside. */
export function holeAt(img: { data: Uint8ClampedArray; width: number; height: number }, geo: Pick<SurfaceImage, 'coordinates'>, lngLat: [number, number]): boolean {
  const [[W, N], , [E, S]] = geo.coordinates, [lng, lat] = lngLat, { data, width, height } = img;
  if (!(lng >= W && lng <= E && lat >= S && lat <= N)) return false;
  const x = Math.min(width - 1, Math.floor(((lng - W) / (E - W)) * width));
  const y = Math.min(height - 1, Math.floor(((mercY(N) - mercY(lat)) / (mercY(N) - mercY(S))) * height));
  const a = (i: number, j: number) => data[(j * width + i) * 4 + 3];
  if (a(x, y)) return false;
  const seen = (dx: number, dy: number) => {
    for (let i = x + dx, j = y + dy; i >= 0 && i < width && j >= 0 && j < height; i += dx, j += dy) if (a(i, j)) return true;
    return false;
  };
  return seen(-1, 0) && seen(1, 0) && seen(0, -1) && seen(0, 1);
}

// ─── the overlay ─────────────────────────────────────────────────────────────

/** failed = no 2D context; kept = already showing this image. */
export type Drawn = 'drawn' | 'kept' | 'failed';

export interface RouteOverlay {
  /** The map is present and the layer is on it. */
  has(layerId: string): boolean;
  /** Remove every rp- layer and source (`all`), or all but the ghost line; both canvases are released. */
  clear(all: boolean): void;
  /** The search-area outline and A–B chord; returns the km the legend shows. */
  searchArea(a: LngLat, b: LngLat): number;
  clearSearchArea(): void;
  route(fc: FC): void;
  /** setData on the route source, only when it exists. */
  recolour(fc: FC): void;
  /** [] removes the layers and source. */
  alternatives(alts: { path: GeoJSON.LineString; alt: number; name: string; colour: string }[]): void;
  /** [] removes the layers and source; `kinds` is the shown kinds (the layer's filter). */
  crossings(pts: { lngLat: LngLat; kind: string; mi: number }[], kinds: Iterable<string>): void;
  /** null removes the layers and source. */
  marker(at: { lngLat: LngLat; label: string } | null): void;
  ghost(path: GeoJSON.LineString | null): void;
  /** The similar-cost areas at `threshold`; null (or no map) releases them ('released'). */
  surface(sf: RouteSurface | null, threshold: number): Drawn | 'released';
  /** A surface canvas is held and rp-surface is shown: its class bands, else null. */
  surfaceBands(): readonly number[] | null;
  /** The surface is held, shown, and `lngLat` is a hole in it. */
  surfaceHole(lngLat: [number, number]): boolean;
  /** The rp-route feature under `point`; undefined without the layer. */
  routeFeatureAt(point: PointLike): MapGeoJSONFeature | undefined;
  /** The weight image on rp-weight (its RGBA is dropped once drawn); 'drawn' when it is newly on the map. */
  showWeight(img: WeightImage | RowsImage): Drawn;
  /** Release the canvas unless `img` is the held one, then only the layer goes. */
  hideWeight(img: RouteResult['weightImage'] | RowsImage | null): void;
  releaseWeight(): void;
  /** Dimmed (opacity 0.25) while the image on screen is another mode's, else 0.8. */
  dimWeight(dim: boolean): void;
  weightHeld(): { src: WeightImage | RowsImage; mode: OverlayMode } | null;
}

export function createRouteOverlay(getMap: () => OverlayMap | null): RouteOverlay {
  let surf: { src: RouteSurface; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; cls: Uint8Array; img: ImageData } | null = null;
  let weight: { src: WeightImage | RowsImage; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; data: ImageData; mode: OverlayMode } | null = null;

  const has = (id: string): boolean => !!getMap()?.getLayer(id);
  const setGeojson = (id: string, data: GeoJSON.FeatureCollection | GeoJSON.Feature): void => {
    const map = getMap();
    if (!map) return;
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else map.addSource(id, { type: 'geojson', data });
  };
  const remove = (layerIds: string[], sourceIds: string[]): void => {
    const map = getMap();
    if (!map) return;
    for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of sourceIds) if (map.getSource(id)) map.removeSource(id);
  };
  const addLayer = (spec: LayerSpecification): void => {
    const map = getMap();
    if (!map) return;
    if (map.getLayer(spec.id)) map.removeLayer(spec.id);
    const i = ORDER.indexOf(spec.id);
    const before = ORDER.slice(i + 1).find((id) => map.getLayer(id));
    map.addLayer(spec, before);
  };
  const releaseSurface = (): void => {
    remove(['rp-surface'], ['rp-surface']);
    if (surf) { surf.canvas.width = 0; surf.canvas.height = 0; }
    surf = null;
  };
  const releaseWeight = (): void => {
    remove(['rp-weight'], ['rp-weight']);
    if (weight) { weight.canvas.width = 0; weight.canvas.height = 0; }
    weight = null;
  };
  /** Writes `img` into the one weight canvas — in place when the size matches (a shown source is
   *  replayed for one frame to upload it), else resized with its source re-added — then drops its RGBA. */
  const paintWeight = (map: OverlayMap, img: WeightImage | RowsImage): boolean => {
    let w = weight;
    if (!w || w.canvas.width !== img.width || w.canvas.height !== img.height) {
      remove(['rp-weight'], ['rp-weight']);
      const canvas = w?.canvas ?? document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d');
      if (!g) return false;
      w = weight = { src: img, canvas, g, data: g.createImageData(img.width, img.height), mode: img.mode ?? 'route' };
    }
    w.data.data.set(img.rgba);
    w.g.putImageData(w.data, 0, 0);
    const coordsMoved = JSON.stringify(w.src.coordinates) !== JSON.stringify(img.coordinates);
    w.src = img;
    w.mode = img.mode ?? 'route';
    img.rgba = new Uint8ClampedArray(0);   // the canvas holds the pixels now; nothing re-reads them
    const src = map.getSource('rp-weight') as CanvasSource | undefined;
    if (src) {
      if (coordsMoved) src.setCoordinates(img.coordinates);
      src.play();
      map.once('render', () => src.pause());
      map.triggerRepaint();
    }
    return true;
  };

  return {
    has,
    clear(all) {
      const keep = all ? [] : ['rp-ghost-casing', 'rp-ghost'];
      remove([...ORDER].reverse().filter((id) => !keep.includes(id)), SOURCES.filter((id) => !keep.includes(id)));
      releaseSurface();
      releaseWeight();
    },
    searchArea(a, b) {
      const buf = searchBufferM(greatCircleM(a, b));
      setGeojson('rp-area', { type: 'Feature', geometry: capsule(a, b, buf), properties: {} });
      setGeojson('rp-chord', { type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: {} });
      addLayer({ id: 'rp-area-fill', type: 'fill', source: 'rp-area', paint: { 'fill-color': '#7e22ce', 'fill-opacity': 0.12 } });
      addLayer({ id: 'rp-area-line', type: 'line', source: 'rp-area', paint: { 'line-color': '#7e22ce', 'line-opacity': 0.55, 'line-width': 1.5 } });
      addLayer({ id: 'rp-chord', type: 'line', source: 'rp-chord', paint: { 'line-color': '#334155', 'line-width': 1.5, 'line-dasharray': [3, 3] } });
      return Math.round(buf / 1000);
    },
    clearSearchArea() { remove(['rp-area-fill', 'rp-area-line', 'rp-chord'], ['rp-area', 'rp-chord']); },
    route(fc) {
      setGeojson('rp-route', fc);
      if (!has('rp-route-casing')) {
        addLayer({ id: 'rp-route-casing', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.95 } });
      }
      if (!has('rp-route')) {
        addLayer({ id: 'rp-route', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 } });
      }
    },
    recolour(fc) { if (getMap()?.getSource('rp-route')) setGeojson('rp-route', fc); },
    alternatives(alts) {
      if (!alts.length) { remove(['rp-alts-label', 'rp-alts'], ['rp-alts']); return; }
      setGeojson('rp-alts', {
        type: 'FeatureCollection',
        features: alts.map((a) => ({ type: 'Feature', geometry: a.path, properties: { i: a.alt, name: a.name, color: a.colour } })),
      });
      addLayer({ id: 'rp-alts', type: 'line', source: 'rp-alts', layout: { 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9 } });
      addLayer({ id: 'rp-alts-label', type: 'symbol', source: 'rp-alts',
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'symbol-spacing': 300 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    },
    crossings(pts, kinds) {
      if (!pts.length) { remove(['rp-cross'], ['rp-cross']); return; }
      setGeojson('rp-cross', {
        type: 'FeatureCollection',
        features: pts.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c.lngLat }, properties: { kind: c.kind, mi: c.mi } })),
      });
      const pick = (k: 0 | 1) => ['match', ['get', 'kind'], ...Object.entries(CROSS_COLOURS).flatMap(([kind, c]) => [kind, c[k]]), '#64748b'];
      const filter = ['in', ['get', 'kind'], ['literal', [...kinds]]] as unknown as FilterSpecification;
      addLayer({ id: 'rp-cross', type: 'circle', source: 'rp-cross', filter, minzoom: CROSS_MINZOOM,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], CROSS_MINZOOM, 6, 13, 9], 'circle-color': pick(0),
          'circle-stroke-color': pick(1), 'circle-stroke-width': 2.5 } } as unknown as LayerSpecification);
    },
    marker(at) {
      if (!at) { remove(['rp-marker-label', 'rp-marker'], ['rp-marker']); return; }
      setGeojson('rp-marker', { type: 'Feature', geometry: { type: 'Point', coordinates: at.lngLat }, properties: { label: at.label } });
      if (!has('rp-marker')) {
        addLayer({ id: 'rp-marker', type: 'circle', source: 'rp-marker',
          paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 3 } });
        addLayer({ id: 'rp-marker-label', type: 'symbol', source: 'rp-marker',
          layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' },
          paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
      }
    },
    ghost(path) {
      if (!path) { remove(['rp-ghost', 'rp-ghost-casing'], ['rp-ghost']); return; }
      setGeojson('rp-ghost', { type: 'Feature', geometry: path, properties: {} });
      if (!has('rp-ghost')) {
        addLayer({ id: 'rp-ghost-casing', type: 'line', source: 'rp-ghost',
          layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 } });
        addLayer({ id: 'rp-ghost', type: 'line', source: 'rp-ghost',
          paint: { 'line-color': '#334155', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
      }
    },
    surface(sf, threshold) {
      const map = getMap();
      if (!sf || !map) { releaseSurface(); return 'released'; }
      if (surf?.src !== sf) {
        releaseSurface();
        const { width, height, rgba } = sf.image;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d');
        if (!g) return 'failed';
        surf = { src: sf, canvas, g, cls: pixelClasses(rgba), img: g.createImageData(width, height) };
      }
      const held = surf!;
      maskSurface(sf.image.rgba, held.cls, sf.bands, threshold, held.img.data);
      held.g.putImageData(held.img, 0, 0);
      const src = map.getSource('rp-surface') as CanvasSource | undefined;
      if (src) {
        src.play();                                  // a paused canvas source uploads only while playing
        map.once('render', () => src.pause());
        map.triggerRepaint();
      } else {
        map.addSource('rp-surface', { type: 'canvas', canvas: held.canvas, coordinates: sf.image.coordinates, animate: false });
        addLayer({ id: 'rp-surface', type: 'raster', source: 'rp-surface', paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' } });
      }
      return 'drawn';
    },
    surfaceBands() { return surf && has('rp-surface') ? surf.src.bands : null; },
    surfaceHole(lngLat) { return !!surf && has('rp-surface') && holeAt(surf.img, surf.src.image, lngLat); },
    routeFeatureAt(point) {
      const map = getMap();
      return map && has('rp-route') ? map.queryRenderedFeatures(point, { layers: ['rp-route'] })[0] : undefined;
    },
    showWeight(img) {
      const map = getMap();
      if (!map) return 'failed';
      if (weight?.src === img && has('rp-weight')) return 'kept';
      if (weight?.src !== img && !paintWeight(map, img)) return 'failed';
      if (!map.getSource('rp-weight')) map.addSource('rp-weight', { type: 'canvas', canvas: weight!.canvas, coordinates: img.coordinates, animate: false });
      if (!has('rp-weight')) addLayer({ id: 'rp-weight', type: 'raster', source: 'rp-weight', paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest' } });
      return 'drawn';
    },
    hideWeight(img) {
      if (weight?.src !== img) releaseWeight();
      else remove(['rp-weight'], ['rp-weight']);
    },
    releaseWeight,
    dimWeight(dim) { if (has('rp-weight')) getMap()!.setPaintProperty('rp-weight', 'raster-opacity', dim ? 0.25 : 0.8); },
    weightHeld() { return weight ? { src: weight.src, mode: weight.mode } : null; },
  };
}
