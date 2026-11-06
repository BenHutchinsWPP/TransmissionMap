// ─── Per region: the page's half of the points-per-polygon template ─────────
// Role: what show-template.ts adds to a points-per-polygon payload (a layer's
//       count, or sum of a measure, per region tag — dataset-query.ts shapeRows
//       by a region field), and the county overlay it paints instead.
//         classBreaks(values, k)  quantile class upper bounds (≤ k, distinct)
//         classOf(v, breaks)      a value's class index
//         rampColours(k)          k colours spread over the sequential RAMP (none for 0)
//         classLabels(breaks, whole, locale)  "1–3", "4–9", … per class
//         regionLayer(kind)       the GeoJSON boundary layer and key column a
//                    region kind is drawn from in the frame (states, NERC,
//                    BA, countries, admin-1); none for counties (the main
//                    map paints those) or retail (tiled boundaries: the
//                    frame lists the regions without a map)
//         regionFeatures(kind, codes)  those boundaries for the codes given,
//                    one feature per code (its parts merged), id = the code,
//                    coordinates snapped to the kind's grid step (0.01° for
//                    states/NERC/BA, 0.02° admin-1, 0.05° countries: a world
//                    by countries is ~2.7 MB of outlines, by admin-1 ~6.9 MB,
//                    within show-template.ts's 8 MB payload cap)
//                    with repeats and straight-run midpoints dropped (rings
//                    under 4 points go), no properties; null when the kind
//                    has no layer or the file did not load. The boundary
//                    file stays in state.sourcesData: it is that registry
//                    layer's own source cache (loadSource), which the map,
//                    the table and the next frame reuse without a refetch
//         regionCentre(geometry)  where a region's pie sits: the area centroid of its
//                    largest polygon (planar, in degrees; its outer ring), the middle of
//                    its bounding box when the ring has no area; null for no polygon.
//                    pies-per-region sends one per code (payload.centres)
//       Region codes are the tags region_join.py writes (scripts/region_join.py
//       BOUNDARIES: the same key columns as here).
//
// Deps: layers/layer-data.ts (loadSource), layers/layer-source.ts
//       (layerSourceId), state.ts (sourcesData, sourcesLoaded), area-filter.ts
//       (AreaKind type).

import { loadSource } from '../layers/layer-data.js';
import { layerSourceId } from '../layers/layer-source.js';
import { state } from '../state.js';
import type { AreaKind } from '../../src/registry/area-filter.js';

/** Sequential, light to dark (ColorBrewer YlGnBu 6). */
export const RAMP = ['#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#2c7fb8', '#253494'] as const;
export const MAX_CLASSES = RAMP.length;

/** Quantile upper bounds of `values`, at most `k` and strictly rising. */
export function classBreaks(values: readonly number[], k = MAX_CLASSES): number[] {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i <= k && xs.length; i++) {
    const q = xs[Math.min(xs.length - 1, Math.ceil((i / k) * xs.length) - 1)];
    if (!out.length || q > out[out.length - 1]) out.push(q);
  }
  return out;
}

export function classOf(v: number, breaks: readonly number[]): number {
  const i = breaks.findIndex(b => v <= b);
  return i < 0 ? breaks.length - 1 : i;
}

export function rampColours(k: number): string[] {
  if (k <= 0) return [];
  if (k === 1) return [RAMP[RAMP.length - 2]];
  return Array.from({ length: k }, (_, i) => RAMP[Math.round((i * (RAMP.length - 1)) / (k - 1))]);
}

/** Each class's range as text: whole numbers start one above the previous bound. */
export function classLabels(breaks: readonly number[], min: number, whole: boolean, locale?: string): string[] {
  const nf = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: whole || Math.abs(n) >= 10 ? 0 : 1 });
  return breaks.map((hi, i) => {
    const lo = i === 0 ? min : whole ? breaks[i - 1] + 1 : breaks[i - 1];
    return lo >= hi ? nf(hi) : `${nf(lo)}–${nf(hi)}`;
  });
}

interface RegionLayer { layer: string; key: string; step: number }
const REGION_LAYERS: Partial<Record<AreaKind, RegionLayer>> = {
  states: { layer: 'us-states', key: 'stusps', step: 0.01 },
  nerc: { layer: 'nerc-regions', key: 'code', step: 0.01 },
  ba: { layer: 'eia-ba', key: 'abbrev', step: 0.01 },
  countries: { layer: 'countries', key: 'iso_a3', step: 0.05 },
  admin1: { layer: 'admin1', key: 'code', step: 0.02 },
};

export const regionLayer = (kind: string): RegionLayer | undefined =>
  Object.hasOwn(REGION_LAYERS, kind) ? REGION_LAYERS[kind as AreaKind] : undefined;

type Ring = GeoJSON.Position[];

/** A ring snapped to a `step` grid with repeated points and points on a straight run dropped; null when under 4 points. */
export function snapRing(ring: Ring, step: number): Ring | null {
  const cells: [number, number][] = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  for (const p of ring) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const c: [number, number] = [Math.round(p[0] / step), Math.round(p[1] / step)];
    let last = cells[cells.length - 1];
    if (last && same(last, c)) continue;
    // Whole grid cells, so the straight-run test is exact: the middle of three collinear points goes.
    const prev = cells[cells.length - 2];
    if (prev && (last[0] - prev[0]) * (c[1] - prev[1]) === (last[1] - prev[1]) * (c[0] - prev[0])) {
      cells.pop();
      last = cells[cells.length - 1];
      if (same(last, c)) continue;
    }
    cells.push(c);
  }
  if (cells.length && !same(cells[0], cells[cells.length - 1])) cells.push(cells[0]);
  if (cells.length < 4) return null;
  return cells.map(c => [Math.round(c[0] * step * 1e6) / 1e6, Math.round(c[1] * step * 1e6) / 1e6]);
}

function polygonsOf(g: GeoJSON.Geometry | null | undefined): Ring[][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(polygonsOf);
  return [];
}

export async function regionFeatures(kind: string, codes: ReadonlySet<string>): Promise<GeoJSON.Feature[] | null> {
  const def = regionLayer(kind);
  if (!def) return null;
  try { await loadSource(def.layer); } catch { return null; }
  const src = layerSourceId(def.layer);
  if (!state.sourcesLoaded[src]) return null;
  const parts = new Map<string, Ring[][]>();
  for (const f of (state.sourcesData[src] ?? []) as GeoJSON.Feature[]) {
    const code = f.properties?.[def.key];
    if (typeof code !== 'string' || !codes.has(code)) continue;
    const polys = polygonsOf(f.geometry).flatMap(poly => {
      const rings = poly.map(r => snapRing(r, def.step));
      return rings[0] ? [rings.filter((r): r is Ring => !!r)] : [];
    });
    if (polys.length) parts.set(code, [...(parts.get(code) ?? []), ...polys]);
  }
  return [...parts].map(([code, polys]) => ({
    type: 'Feature', id: code, properties: {},
    geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys },
  }));
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The area centroid of a polygon's outer ring and its (unsigned) area; the bounding-box centre with area 0 for a sliver. */
function ringCentre(ring: Ring): { c: [number, number]; area: number } | null {
  let a = 0, cx = 0, cy = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [px, py] = ring[i], [qx, qy] = ring[i + 1];
    if (![px, py, qx, qy].every(Number.isFinite)) continue;
    const w = px * qy - qx * py;
    a += w; cx += (px + qx) * w; cy += (py + qy) * w;
    x0 = Math.min(x0, px, qx); x1 = Math.max(x1, px, qx); y0 = Math.min(y0, py, qy); y1 = Math.max(y1, py, qy);
  }
  if (x0 > x1) return null;
  return Math.abs(a) < 1e-12 ? { c: [(x0 + x1) / 2, (y0 + y1) / 2], area: 0 } : { c: [cx / (3 * a), cy / (3 * a)], area: Math.abs(a / 2) };
}

export function regionCentre(g: GeoJSON.Geometry | null | undefined): [number, number] | null {
  let best: { c: [number, number]; area: number } | null = null;
  for (const poly of polygonsOf(g)) {
    const r = poly[0] && ringCentre(poly[0]);
    if (r && (!best || r.area > best.area)) best = r;
  }
  return best && [round4(best.c[0]), round4(best.c[1])];
}
