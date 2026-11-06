// ─── Proximity: geodesic.ts tests ───────────────────────────────────────────
// Role: holds geodesicKm to published GeographicLib test data (GeodTest.dat lines
//       and the Flinders Peninsula - Buninyong line) to 1 mm, covers short lines,
//       the antimeridian, poles, coincident points and symmetry, and sweeps
//       latitude, azimuth and distance to check the geodesic / sphere ratio stays
//       inside SPHERE_RATIO_MIN..MAX (the bands the grid methods rely on).
//
// Deps: ./geodesic.js, ./oracle.js (distKm, the EARTH_KM sphere). Test support only.

import { describe, expect, it } from 'vitest';
import { geodesicKm, SPHERE_RATIO_MAX, SPHERE_RATIO_MIN } from './geodesic.js';
import { distKm } from './oracle.js';

// [lat1, lon1, lat2, lon2, s12 in metres]: GeodTest.dat (Karney, GeographicLib test data, 500,000 lines),
// picked as the shortest lines, near-antipodal lines, equatorial, meridional, polar and random ones,
// plus the Flinders Peninsula - Buninyong line (54972.271 m).
const VECTORS: [number, number, number, number, number][] = [
  [35.36284833173, 0.0, 35.36284832650837, 8.643945765e-09, 0.0009761],
  [48.69774549571, 0.0, 48.697745495486856, 2.130591666e-08, 0.0015686],
  [33.649966460751, 0.0, 33.64996637391755, 1.01943289803e-07, 0.0134976],
  [59.068624533029, 0.0, 59.06862443638499, 6.62100839117e-07, 0.0394751],
  [61.049756162351, 0.0, 61.04975571809879, 1.873893686e-09, 0.0495031],
  [36.126800929914, 0.0, 36.12680086041579, 6.72553087674e-07, 0.0610318],
  [22.255982320231, 0.0, -22.161279163300282, 179.80619487083368, 19990521.8488503],
  [16.434840795972, 0.0, -16.464235770681192, 179.55484558836665, 19983460.8677313],
  [74.098356057014, 0.0, -74.07317536404098, 179.99585371619742, 20001120.0416458],
  [54.947018934705, 0.0, -54.96833281038973, 179.88084087793553, 20000377.3861816],
  [41.397454385832, 0.0, -41.4148945511962, 179.4317126481559, 19975167.732445],
  [3.051859226495, 0.0, -3.1486922921830955, 179.89831778319564, 19992401.768184],
  [89.95111275015, 0.0, 89.95076010283844, 1.178484212777688, 119.3985162],
  [89.985711256443, 0.0, 89.9767379125297, 8.98354085697944, 1051.7961787],
  [89.935260253701, 0.0, 89.93770576317279, 3.8427722506525845, 548.4934048],
  [89.912012365199, 0.0, 89.91185893836206, 0.583054094144916, 101.5517131],
  [9.16954194197, 0.0, 19.47074126191232, 0.000917016300134217, 1139774.8325526],
  [17.500537671811, 0.0, -17.193411200508535, 179.90729539406942, 19969431.322778],
  [0.004024436814, 0.0, 0.004238749663025265, 7.639644672194049, 850441.3528803],
  [9.61349109089, 0.0, 9.60980505893595, 0.00389027776312375, 590.3935138],
  [5.246020511776, 0.0, -5.246020511776, 179.3990093774047, 19970605.79018965],
  [0.003420251916, 0.0, -0.004094788250199127, 112.19952936588018, 12489994.4940459],
  [30.187092925159, 0.0, -30.187092925138057, 179.47800511131942, 19978788.2693798],
  [88.517933397336, 0.0, -88.517933397336, 179.98435154284365, 20003908.855572924],
  [-37.95103341666667, 144.42486788888888, -37.65282113888889, 143.92649552777777, 54972.271],
];

const MM = 1e-6; // km

describe('geodesicKm against published GeographicLib test data', () => {
  it('has at least 20 vectors', () => expect(VECTORS.length).toBeGreaterThanOrEqual(20));
  it.each(VECTORS)('(%f, %f) to (%f, %f) is %f m', (lat1, lon1, lat2, lon2, s12) => {
    expect(Math.abs(geodesicKm(lon1, lat1, lon2, lat2) - s12 / 1000)).toBeLessThanOrEqual(s12 === 54972.271 ? 1e-6 : MM / 100);
    expect(Math.abs(geodesicKm(lon2, lat2, lon1, lat1) - s12 / 1000)).toBeLessThanOrEqual(s12 === 54972.271 ? 1e-6 : MM / 100);
  });
});

describe('geodesicKm edge cases', () => {
  const A = 6378.137;
  it('coincident points are 0 km, also at the poles and across the antimeridian', () => {
    expect(geodesicKm(10, 20, 10, 20)).toBe(0);
    expect(geodesicKm(0, 90, 77, 90)).toBe(0);
    expect(geodesicKm(-120, -90, 10, -90)).toBe(0);
    expect(geodesicKm(180, 5, -180, 5)).toBe(0);
  });
  it('short lines along the equator are a·dλ (1 m, 100 m, 1 mile)', () => {
    for (const m of [1, 100, 1609.344]) {
      const dl = m / 1000 / A;
      expect(Math.abs(geodesicKm(0, 0, (dl * 180) / Math.PI, 0) - m / 1000)).toBeLessThan(1e-9);
    }
  });
  it('short lines along a meridian match the meridian arc length', () => {
    // M(0) = b²/a = 6335.439 km per radian at the equator
    const M0 = (6356.752314245179 ** 2) / A;
    for (const m of [1, 100, 1609.344]) {
      const dphi = m / 1000 / M0;
      expect(Math.abs(geodesicKm(0, 0, 0, (dphi * 180) / Math.PI) - m / 1000)).toBeLessThan(1e-7);
    }
  });
  it('crosses the antimeridian the short way', () => {
    const d = geodesicKm(179.999, 0, -179.999, 0);
    expect(Math.abs(d - (A * 0.002 * Math.PI) / 180)).toBeLessThan(1e-9);
    expect(geodesicKm(-179.999, 0, 179.999, 0)).toBe(d);
  });
  it('pole to pole is twice the meridian quadrant', () => {
    expect(Math.abs(geodesicKm(0, 90, 0, -90) - 20003.9314586)).toBeLessThan(1e-6);
    expect(Math.abs(geodesicKm(33, 90, -100, -90) - 20003.9314586)).toBeLessThan(1e-6);
  });
  it('near the pole, opposite longitudes pass over it', () => {
    const d = geodesicKm(0, 89.99, 180, 89.99);
    expect(Math.abs(d - 2 * geodesicKm(0, 89.99, 0, 90))).toBeLessThan(1e-9);
  });
  it('is symmetric and returns NaN for bad input', () => {
    expect(geodesicKm(10, 20, -30, 40)).toBe(geodesicKm(-30, 40, 10, 20));
    for (const bad of [[NaN, 0, 0, 0], [0, 91, 0, 0], [0, 0, Infinity, 0], [0, 0, 0, -90.5]] as [number, number, number, number][]) {
      expect(geodesicKm(bad[0], bad[1], bad[2], bad[3])).toBeNaN();
    }
  });
});

describe('geodesic / sphere ratio', () => {
  it(`stays within ${SPHERE_RATIO_MIN}..${SPHERE_RATIO_MAX} over latitude, azimuth and 0.01-1000 km`, () => {
    const R = 6371.0088, RAD = Math.PI / 180;
    let lo = Infinity, hi = -Infinity, at = '';
    const dests = [0.01, 0.1, 1, 10, 100, 500, 1000];
    for (let lat = -89.9; lat <= 89.95; lat += lat < -85 || lat > 85 ? 0.5 : 2.5) {
      for (let az = 0; az < 360; az += 7.5) {
        for (const km of dests) {
          const d = km / R, p = lat * RAD, b = az * RAD;
          const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
          const l2 = Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
          const lon2 = l2 / RAD, lat2 = p2 / RAD;
          const sphere = distKm(0, lat, lon2, lat2), geo = geodesicKm(0, lat, lon2, lat2);
          const r = geo / sphere;
          if (r < lo) { lo = r; at = `min ${r} at lat ${lat} az ${az} km ${km}`; }
          if (r > hi) { hi = r; at = `max ${r} at lat ${lat} az ${az} km ${km}`; }
        }
      }
    }
    console.log(`ratio sweep: min ${lo}, max ${hi} (last extreme ${at})`);
    expect(lo).toBeGreaterThanOrEqual(SPHERE_RATIO_MIN);
    expect(hi).toBeLessThanOrEqual(SPHERE_RATIO_MAX);
  });
});
