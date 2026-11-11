// ─── Dev console handle ───────────────────────────────────────────────────────
// Role: dev-only `window.tm`, the view API for the browser console. Loaded by
//       src/main.ts behind import.meta.env.DEV only, so it never ships.
//       Every call of map-api.ts is here as it is (each returns an Outcome and
//       commits the way a control does — one url:write, one undo step), plus
//       the raw view and link readers and two helpers the map API leaves out:
//         applyView / currentView / currentHash   the whole view, in and out
//         listStylable                            layers and the style keys each takes
//         summarise                               the capped copy of a result a model sees
//         route                                   a least-cost line A → B, drawn as the
//                                                 My Data layer "Route" (each call
//                                                 replaces it; {keep: true} adds a
//                                                 route-<preset>.geojson layer instead —
//                                                 My Data layers persist in localStorage);
//                                                 opts cap / bufferFactor / presetPatch /
//                                                 surface / alternatives / altStretch go to
//                                                 the solver; alternatives are drawn as
//                                                 "Route alternative 1…k" (route magenta,
//                                                 alternatives in other colours, labelled
//                                                 "Alt k +n%": colours no voltage class uses;
//                                                 colour and width are the features'
//                                                 `stroke` / `stroke-width` properties, so
//                                                 they survive a reload and removal; no dashes)
//                                                 and the similar-cost
//                                                 areas as image source + raster layer
//                                                 route-similar-cost (a canvas → blob URL,
//                                                 revoked on replace; a call that is no longer
//                                                 the latest drops its image), both replaced each call
//                                                 (removed when not asked for); the result
//                                                 comes back without the raw RGBA / class arrays
//
// Deps: map-api.js (every call), view-state.js (applyView, currentView),
//       url-state.js (currentHash), style-overrides.js (listStylable), state.js (userLayers),
//       dataset-query.js (summarise; Outcome type), route/route.js and route/preset-patch.js
//       (types only), route/route-open.js and user-data/user-data.js (dynamic, on the first
//       tm.route call).

import * as api from './map-api.js';
import { applyView, currentView } from './view-state.js';
import { currentHash } from './url-state.js';
import { listStylable } from './style-overrides.js';
import { summarise, type Outcome } from './dataset-query.js';
import type { RouteResult, RouteSurface } from './route/route.js';
import type { PresetPatch } from './route/preset-patch.js';
import { state } from './state.js';

const ROUTE_LAYER = 'Route';
const ALT_LAYER = 'Route alternative';
const SIMILAR_ID = 'route-similar-cost';
let similarUrl: string | null = null;
// Route styling in colours no voltage class uses (src/colors/voltage.ts), written as the
// features' `stroke` / `stroke-width` properties (user-data.ts reads them). Labels come from
// the My Data line-label layer (`name`).
const ROUTE_COLOR = '#d0008a';
const ALT_COLORS = ['#7a3cff', '#1a1a1a', '#00a6a6'];
let routeCall = 0;

type RouteOpts = {
  cap?: number; bufferFactor?: number; keep?: boolean;
  surface?: boolean; alternatives?: number; altStretch?: number; presetPatch?: PresetPatch;
};

/** RouteResult without the raw arrays (the image's RGBA, the class window): sizes in their place. */
type PublicRouteResult = Omit<RouteResult, 'surface'> & {
  surface?: { skipped: string } | (Omit<RouteSurface, 'image' | 'classes'> & {
    image: Omit<RouteSurface['image'], 'rgba'>; classes: { length: number };
  });
};

/** Replaces the similar-cost image source + raster layer (below the My Data layers), or removes it. */
async function drawSimilarCost(s: RouteSurface | null, call: number): Promise<void> {
  const map = state.map;
  if (!map || call !== routeCall) return;
  if (map.getLayer(SIMILAR_ID)) map.removeLayer(SIMILAR_ID);
  if (map.getSource(SIMILAR_ID)) map.removeSource(SIMILAR_ID);
  if (similarUrl) { URL.revokeObjectURL(similarUrl); similarUrl = null; }
  if (!s) return;
  const { width, height, rgba, coordinates } = s.image;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
  const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  if (call !== routeCall) { URL.revokeObjectURL(url); return; }
  similarUrl = url;
  map.addSource(SIMILAR_ID, { type: 'image', url, coordinates });
  const userIds = new Set(state.userLayers.map((l) => l.id + '-fill'));
  const before = map.getStyle().layers.find((l) => userIds.has(l.id))?.id;
  map.addLayer({ id: SIMILAR_ID, type: 'raster', source: SIMILAR_ID, paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' } }, before);
}

export interface LastRouteRequest { from: [number, number]; to: [number, number]; preset: string; lineType: string; opts: RouteOpts }
let lastRouteRequest: LastRouteRequest | null = null;

async function route(
  from: [number, number], to: [number, number], preset = 'tm-default', lineType = 'ac500', opts: RouteOpts = {},
): Promise<Outcome<PublicRouteResult>> {
  lastRouteRequest = { from, to, preset, lineType, opts };
  const call = ++routeCall;
  const { routeLine } = await import('./route/route-open.js');
  const out = await routeLine({
    from, to, preset, lineType, cap: opts.cap, bufferFactor: opts.bufferFactor,
    surface: opts.surface, alternatives: opts.alternatives, altStretch: opts.altStretch, presetPatch: opts.presetPatch,
  });
  if (!out.ok) { await drawSimilarCost(null, call); return out; }
  if (call !== routeCall) return out as Outcome<PublicRouteResult>;
  const r = out.result, c = r.cost;
  const { addImportedLayer, removeUserLayer } = await import('./user-data/user-data.js');
  if (!opts.keep) {
    for (const l of state.userLayers.filter((u) => u.filename === ROUTE_LAYER || u.filename.startsWith(ALT_LAYER + ' '))) {
      removeUserLayer(l.id);
    }
  }
  const line = (geometry: GeoJSON.LineString, properties: Record<string, unknown>): GeoJSON.FeatureCollection =>
    ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties }] });
  addImportedLayer(opts.keep ? `route-${preset}.geojson` : ROUTE_LAYER, line(r.path, {
    preset, lineType, lengthMi: +r.lengthMi.toFixed(1), dollarYear: c.dollarYear,
    totalNominalUsd: Math.round(c.totalNominal), total2025Usd: Math.round(c.total2025),
    low2025Usd: Math.round(c.band.low), high2025Usd: Math.round(c.band.high),
    meanCostX: +c.meanCostX.toFixed(3), tribalMiles: +r.tribalMiles.toFixed(1),
    lowestScoreProof: r.optimality, maskLimited: r.maskLimited, pis: r.cells.pis, name: 'Route',
    stroke: ROUTE_COLOR, 'stroke-width': 4,
  }));
  (r.alternatives ?? []).forEach((alt, i) => {
    addImportedLayer(opts.keep ? `route-${preset}-alternative-${i + 1}.geojson` : `${ALT_LAYER} ${i + 1}`, line(alt.path, {
      preset, lineType, lengthMi: +alt.lengthMi.toFixed(1), total2025Usd: Math.round(alt.cost.total2025),
      routingScoreAboveLowestPct: +alt.pctRoute.toFixed(2), usdVsRoutePct: +alt.pctUsd.toFixed(2), shared: +alt.shared.toFixed(3),
      name: `Alt ${i + 1} +${Math.round(alt.pctRoute)}%`,
      stroke: ALT_COLORS[i % ALT_COLORS.length], 'stroke-width': 3,
    }));
  });
  const s = r.surface && 'image' in r.surface ? r.surface : null;
  await drawSimilarCost(s, call);
  if (!s) return out as Outcome<PublicRouteResult>;
  const { width, height, coordinates } = s.image;
  return { ok: true, result: { ...r, surface: { ...s, image: { width, height, coordinates }, classes: { length: s.classes.length } } } };
}

const tm = { ...api, applyView, currentView, currentHash, listStylable, summarise, route, lastRouteRequest: () => lastRouteRequest };

declare global {
  interface Window { tm?: typeof tm }
}

window.tm = tm;
