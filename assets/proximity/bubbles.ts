// ─── Proximity: points and bubble sizes for the map ─────────────────────────
// Role: pure data for the Proximity tool's map half. A bubble is a circle of radius
//       x/2 around a grouped point (x = the threshold), so two bubbles touch when the
//       points are a pair. It is drawn as a MapLibre circle on the point itself (no
//       polygon source to tile): its radius in pixels is x/2 over the Web Mercator
//       metres per pixel at the point's latitude, 2^z · 512 / (2π·6378137) · sec(lat),
//       read from the point's `s` = sec(lat) property and exact at the point (within
//       the sphere/ellipsoid difference, under 0.7 %; Mercator's scale change across a
//       bubble grows with its size). With circle-pitch-alignment `map` the same circle
//       lies on the globe. Only points with group > 0 are emitted; latitudes are
//       clamped to ±89.9° for `s`.
// Deps: none. Used by: ui/proximity-map.ts.

const RAD = Math.PI / 180;
const MAX_LAT = 89.9;
/** Web Mercator metres per CSS pixel at zoom 0 on the equator (512 px world). */
const MPP0 = (2 * Math.PI * 6378137) / 512;
/** Bubbles are shown only while every one is at most this many pixels in radius (the GeoJSON tile buffer). */
export const MAX_BUBBLE_PX = 512;
/** Group colours cycle through this many palette entries. */
export const PALETTE_SIZE = 10;

/** sec(lat): Web Mercator's scale at a latitude. */
export const mercScale = (lat: number): number => 1 / Math.cos(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD);

/** A bubble's radius in pixels at zoom z for a point of scale s (sec lat). */
export const bubblePx = (km: number, s: number, z: number): number => (km / 2 * 1000) / MPP0 * s * 2 ** z;

/** circle-radius for bubbles of half the threshold: exponential in zoom, per point by `s`. */
export function bubbleRadiusExpr(km: number): unknown {
  const r0 = bubblePx(km, 1, 0);
  return ['interpolate', ['exponential', 2], ['zoom'], 0, ['*', r0, ['get', 's']], 24, ['*', r0 * 2 ** 24, ['get', 's']]];
}

/** The highest zoom at which every bubble (largest scale sMax) stays within MAX_BUBBLE_PX. */
export function bubbleMaxZoom(km: number, sMax: number): number {
  return Math.max(0, Math.min(24, Math.log2(MAX_BUBBLE_PX / bubblePx(km, sMax, 0))));
}

export interface ProxFeatures {
  points: GeoJSON.FeatureCollection<GeoJSON.Point>;
  /** The largest `s` among the points (1 when there are none). */
  sMax: number;
}

/** Point features for the grouped points; props i (point index), g (group), c (colour index), s (sec lat). */
export function proxFeatures(lon: ArrayLike<number>, lat: ArrayLike<number>, group: ArrayLike<number>): ProxFeatures {
  const points: GeoJSON.Feature<GeoJSON.Point>[] = [];
  let sMax = 1;
  for (let i = 0; i < group.length; i++) {
    const g = group[i];
    if (!(g > 0)) continue;
    const s = mercScale(lat[i]);
    if (s > sMax) sMax = s;
    points.push({ type: 'Feature', properties: { i, g, c: (g - 1) % PALETTE_SIZE, s }, geometry: { type: 'Point', coordinates: [lon[i], lat[i]] } });
  }
  return { points: { type: 'FeatureCollection', features: points }, sMax };
}
