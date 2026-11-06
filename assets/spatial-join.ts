// ─── Spatial joins: points per polygon, polygons a line crosses ──────────────
// Role: the two deterministic joins the map API offers (no model, no network),
//       over dataset-query.ts rows and the geo kit. Reads only: nothing here
//       commits to the URL or the undo stack.
//         joinPoints({points, polygons, where?})   a point count per polygon of
//                                  `polygons`, the points of `points` (a Point
//                                  feature by its position, any other geometry
//                                  by the centre of its bounding box). A point
//                                  inside several polygons counts in each.
//         crossings({geometry, polygons})   the features of each polygon layer
//                                  a LineString crosses or starts inside; the
//                                  per-row `crossings` count is null for a
//                                  vector-tile layer (tile cuts add edges).
//       A tile-cut polygon is read as all its pieces merged (query `fragments`).
//       Both take registry dataset layers only. Each side reads up to
//       QUERY_MAX_ROWS rows; the result says `complete: false` when a side was
//       capped or is a vector-tile layer (only the loaded tiles) and gives the
//       `precision` of the geometry it used (tile geometry is clipped and
//       simplified for the zoom; GeoJSON is the full file). Not antimeridian-aware
//       (geo-kit.ts).
//
// Deps: dataset-query.ts (query, describe, QUERY_MAX_ROWS, Outcome, QueryRow, QueryResult),
//       sandbox/geo-kit.ts, condition-compile.ts (Condition), state.ts (zoom).

import { state } from './state.js';
import { describe, query, QUERY_MAX_ROWS, type Outcome, type QueryRow, type QueryResult } from './dataset-query.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { bbox, pointInGeometry, lineIntersectsGeometry, lineCrossingCount } from './sandbox/geo-kit.js';

export const MAX_LINE_VERTICES = 5000;
export const MAX_CROSSING_LAYERS = 5;

export interface JoinPointsArgs { points: string; polygons: string; where?: Condition[] }
export interface JoinRow { polygonId: string | number | null; polygonLabel?: string; count: number }
interface Coverage { complete: boolean; precision: string; reason?: string }
export interface JoinPointsResult extends Coverage {
  points: string; polygons: string; pointCount: number; polygonCount: number; rows: JoinRow[];
}
export interface CrossingsArgs { geometry: GeoJSON.LineString; polygons: string[] }
export interface CrossingRow { layer: string; id: string | number | null; label?: string; crossings: number | null }
/** `crossings` is null for a vector-tile layer: tile cuts add edges, so only crossed-or-not is reliable (`countReason` says so). */
export interface CrossingsResult extends Coverage { layers: string[]; rows: CrossingRow[]; countReason?: string }

const fail = <T = never>(reason: string): Outcome<T> => ({ ok: false, reason });

/** The first name-like property of a row, as its label. */
function labelOf(row: QueryRow): string | undefined {
  const k = Object.keys(row.props).find(f => /name/i.test(f) && typeof row.props[f] === 'string' && row.props[f] !== '');
  return k ? String(row.props[k]) : undefined;
}

function precisionOf(layerIds: string[]): string {
  const vector = layerIds.some(id => {
    const d = describe(id);
    return d.ok && d.result.queryable && d.result.kind === 'pmtiles';
  });
  return vector ? `tile geometry at zoom ${(state.map?.getZoom() ?? 0).toFixed(1)}` : 'full geometry';
}

/** Rows of a registry dataset layer with geometry, or why not. */
async function rowsOf(layerId: string, polygons: boolean, where?: Condition[]): Promise<Outcome<QueryResult>> {
  const d = describe(layerId);
  if (!d.ok) return d;
  if (!d.result.queryable) return fail(d.result.reason);
  return query(layerId, { limit: QUERY_MAX_ROWS, fragments: polygons, ...(where?.length && { where }) });
}

function coverage(results: QueryResult[], layerIds: string[]): Coverage {
  const reasons = results.flatMap(r => [
    ...(!r.complete && r.reason ? [r.reason] : []),
    ...(r.truncated ? [`"${r.layerId}" has ${r.total} matches; only the first ${QUERY_MAX_ROWS} were read`] : []),
  ]);
  return { complete: reasons.length === 0, precision: precisionOf(layerIds), ...(reasons.length && { reason: [...new Set(reasons)].join('; ') }) };
}

export async function joinPoints(args: JoinPointsArgs): Promise<Outcome<JoinPointsResult>> {
  if (!args || typeof args.points !== 'string' || typeof args.polygons !== 'string') return fail('points and polygons must be layer ids');
  const pts = await rowsOf(args.points, false, args.where);
  if (!pts.ok) return pts;
  const polys = await rowsOf(args.polygons, true);
  if (!polys.ok) return polys;
  const positions: number[][] = [];
  for (const r of pts.result.rows) {
    const g = r.feature.geometry as { type: string; coordinates: unknown } | null;
    if (!g) continue;
    if (g.type === 'Point') positions.push(g.coordinates as number[]);
    else if (g.type === 'MultiPoint' && (g.coordinates as number[][]).length) positions.push((g.coordinates as number[][])[0]);
    else {
      const b = bbox(g);
      if (b) positions.push([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    }
  }
  const rows: JoinRow[] = [];
  let polygonCount = 0;
  for (const p of polys.result.rows) {
    const g = p.feature.geometry as { type: string; coordinates: unknown } | null;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    polygonCount++;
    const b = bbox(g)!;
    let count = 0;
    for (const pos of positions) {
      if (pos[0] < b[0] || pos[0] > b[2] || pos[1] < b[1] || pos[1] > b[3]) continue;
      if (pointInGeometry(pos, g)) count++;
    }
    if (count > 0) {
      const polygonLabel = labelOf(p);
      rows.push({ polygonId: p.id, ...(polygonLabel && { polygonLabel }), count });
    }
  }
  rows.sort((a, b) => b.count - a.count);
  return { ok: true, result: {
    points: args.points, polygons: args.polygons, pointCount: positions.length, polygonCount, rows,
    ...coverage([pts.result, polys.result], [args.points, args.polygons]),
  } };
}

/** The LineString in `g`, or why it is not one the joins take. */
export function checkLine(g: unknown): string | null {
  const l = g as { type?: unknown; coordinates?: unknown } | null;
  if (!l || typeof l !== 'object' || l.type !== 'LineString' || !Array.isArray(l.coordinates)) return 'geometry must be a GeoJSON LineString';
  const c = l.coordinates as unknown[];
  if (c.length < 2) return 'geometry needs at least 2 positions';
  if (c.length > MAX_LINE_VERTICES) return `geometry takes at most ${MAX_LINE_VERTICES} positions`;
  for (const p of c) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number'
      || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) {
      return 'positions must be [longitude, latitude] with longitude -180..180 and latitude -90..90';
    }
  }
  return null;
}

export async function crossings(args: CrossingsArgs): Promise<Outcome<CrossingsResult>> {
  const err = checkLine(args?.geometry);
  if (err) return fail(err);
  const layers = args.polygons;
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_CROSSING_LAYERS || layers.some(l => typeof l !== 'string')) {
    return fail(`polygons must be 1 to ${MAX_CROSSING_LAYERS} layer ids`);
  }
  const line = args.geometry.coordinates.map(p => [p[0], p[1]]);
  const lb = bbox(args.geometry)!;
  const results: QueryResult[] = [];
  const rows: CrossingRow[] = [];
  const tiled: string[] = [];
  for (const layer of new Set(layers)) {
    const r = await rowsOf(layer, true);
    if (!r.ok) return r;
    results.push(r.result);
    const d = describe(layer);
    const isTiled = d.ok && d.result.queryable && d.result.kind === 'pmtiles';
    if (isTiled) tiled.push(layer);
    for (const p of r.result.rows) {
      const g = p.feature.geometry as { type: string; coordinates: unknown } | null;
      const b = g && bbox(g);
      if (!g || !b || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
      if (b[2] < lb[0] || b[0] > lb[2] || b[3] < lb[1] || b[1] > lb[3]) continue;
      if (!lineIntersectsGeometry(line, g)) continue;
      const label = labelOf(p);
      rows.push({ layer, id: p.id, ...(label && { label }), crossings: isTiled ? null : lineCrossingCount(line, g) });
    }
  }
  return { ok: true, result: { layers: [...new Set(layers)], rows, ...coverage(results, layers),
    ...(tiled.length && { countReason: `tile pieces: count not reliable (${tiled.join(', ')})` }) } };
}
