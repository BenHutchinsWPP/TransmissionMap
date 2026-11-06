// ─── Proximity: the grouping contract ───────────────────────────────────────
// Role: the types every proximity method (oracle, grid, hash, production)
//       shares. Points within `km` of each other (WGS84 ellipsoid geodesic,
//       inclusive; geodesic.ts) form a group, transitively: connected components
//       of the "within km" graph. Two points with the same id (opts.ids, an int
//       per point, -1 = none) are never a pair, though they can share a group
//       through other points.
//         group      per point: 1..groups in order of each group's lowest row
//                    index; 0 when it has no neighbour within km or its
//                    coordinates are invalid
//         groups     number of groups (each has at least 2 points)
//         size       per point: its group's size (0 when group is 0)
//         nearestKm  per point: geodesic distance to its nearest OTHER point that
//                    may pair with it (a different id) when that is ≤ km, else NaN
//         skipped    points with non-finite or out-of-range coordinates
//                    (|lat| > 90, |lon| > 180)
//       A threshold outside 0.01–1000 km, or ids of another length, throws RangeError.
//       PairsResult (proximityPairs): every pair within km as rows a < b (original
//       row indices) with its geodesic km, sorted by (group of a, km, a, b);
//       `truncated` when more than opts.max pairs exist (then a partial list).
//       Pure types: no DOM, no map, no imports.
//
// Deps: none. Used by oracle.ts, methods.ts, proximity.ts, fixtures.ts, proximity.test.ts.

export interface ProximityResult {
  group: Int32Array;
  groups: number;
  size: Int32Array;
  nearestKm: Float64Array;
  skipped: number;
}

export interface ProximityOptions {
  /** per point: its id (≥ 0) or -1; equal ids ≥ 0 never pair */
  ids?: Int32Array;
}

export interface PairsOptions extends ProximityOptions {
  /** most pairs returned (default 1,000,000) */
  max?: number;
  /** called about every 50,000 pairs found, with the count so far */
  onProgress?: (found: number) => void;
}

export interface PairsResult {
  a: Int32Array;
  b: Int32Array;
  km: Float64Array;
  truncated: boolean;
}

export type ProximityMethod = (lon: Float64Array, lat: Float64Array, km: number, opts?: ProximityOptions) => ProximityResult;
