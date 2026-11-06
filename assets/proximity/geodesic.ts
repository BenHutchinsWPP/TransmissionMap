// ─── Proximity: WGS84 geodesic distance (Karney) ────────────────────────────
// Role: the length of the shortest path between two lon/lat points on the WGS84
//       ellipsoid, in km: the distance geopy's `geodesic` reports. A pure port of
//       the inverse problem's distance path from GeographicLib's JavaScript
//       Geodesic.js (series of order 6, Newton iteration with bisection fallback;
//       azimuth, reduced length, scale and area outputs left out). Accurate to
//       about 15 nm; it converges for every pair, antipodal included.
//         geodesicKm(lon1, lat1, lon2, lat2)   km; NaN for a non-finite or |lat| > 90 input
//         SPHERE_RATIO_MIN / SPHERE_RATIO_MAX  bounds of geodesicKm / great-circle km
//                                              (sphere of EARTH_KM), the sure and candidate
//                                              bands the grid methods use
//       State lives in module scratch variables (no allocation per call), so a
//       call is not re-entrant. Pure: no DOM, no map.
//
// Algorithms: C. F. F. Karney, "Algorithms for geodesics", J. Geodesy 87, 43-55 (2013).
// Port of GeographicLib Geodesic.js / Math.js, Copyright (c) Charles Karney (2011-2022)
// <karney@alum.mit.edu>, MIT/X11 License: permission is hereby granted, free of charge,
// to any person obtaining a copy of the software and associated documentation files, to
// deal in it without restriction, provided the copyright notice and this permission
// notice are included in all copies or substantial portions of it. THE SOFTWARE IS
// PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Deps: none. Used by oracle.ts, methods/*, proximity.test.ts.

/** geodesic / sphere(EARTH_KM) lies in [MIN, MAX] for every pair of 0.01-1000 km (swept in geodesic.test.ts). */
export const SPHERE_RATIO_MIN = 0.9943;
export const SPHERE_RATIO_MAX = 1.0068;

const A = 6378137;
const F = 1 / 298.257223563;
const F1 = 1 - F;
const E2 = F * (2 - F);
const EP2 = E2 / (F1 * F1);
const N = F / (2 - F);
const B = A * F1;
const DEG = Math.PI / 180;
const TOL0 = 2 ** -52;
const TOL1 = 200 * TOL0;
const TOL2 = Math.sqrt(TOL0);
const TOLB = TOL0;
const XTHRESH = 1000 * TOL2;
const MAXIT1 = 20;
const MAXIT2 = MAXIT1 + 53 + 10;
const TINY = Math.sqrt(Number.MIN_VALUE / Number.EPSILON);
const ETOL2 = (0.1 * TOL2) / Math.sqrt((Math.max(0.001, Math.abs(F)) * Math.min(1, 1 - F / 2)) / 2);

function polyval(n: number, p: ArrayLike<number>, s: number, x: number): number {
  let y = n < 0 ? 0 : p[s++];
  while (--n >= 0) y = y * x + p[s++];
  return y;
}

const A1M1F = [1, 4, 64, 0, 256];
const C1F = [-1, 6, -16, 32, -9, 64, -128, 2048, 9, -16, 768, 3, -5, 512, -7, 1280, -7, 2048];
const A2M1F = [-11, -28, -192, 0, 256];
const C2F = [1, 2, 16, 32, 35, 64, 384, 2048, 15, 80, 768, 7, 35, 512, 63, 1280, 77, 2048];
const A3C = [-3, 128, -2, -3, 64, -1, -3, -1, 16, 3, -1, -2, 8, 1, -1, 2, 1, 1];
const C3C = [
  3, 128, 2, 5, 128, -1, 3, 3, 64, -1, 0, 1, 8, -1, 1, 4,
  5, 256, 1, 3, 128, -3, -2, 3, 64, 1, -3, 2, 32,
  7, 512, -10, 9, 384, 5, -9, 5, 192,
  7, 512, -14, 7, 512,
  21, 2560,
];

const A3X = new Float64Array(6);
const C3X = new Float64Array(15);
{
  let o = 0, k = 0;
  for (let j = 5; j >= 0; --j) {
    const p = Math.min(5 - j, j);
    A3X[k++] = polyval(p, A3C, o, N) / A3C[o + p + 1];
    o += p + 2;
  }
  o = 0; k = 0;
  for (let l = 1; l < 6; ++l) {
    for (let j = 5; j >= l; --j) {
      const p = Math.min(5 - j, j);
      C3X[k++] = polyval(p, C3C, o, N) / C3C[o + p + 1];
      o += p + 2;
    }
  }
}

const C1a = new Float64Array(7);
const C2a = new Float64Array(7);
const C3a = new Float64Array(6);

const a1m1f = (eps: number): number => (polyval(3, A1M1F, 0, eps * eps) / A1M1F[4] + eps) / (1 - eps);
const a2m1f = (eps: number): number => (polyval(3, A2M1F, 0, eps * eps) / A2M1F[4] - eps) / (1 + eps);
const a3f = (eps: number): number => polyval(5, A3X, 0, eps);

function seriesC(eps: number, coeff: number[], c: Float64Array): void {
  const eps2 = eps * eps;
  let d = eps, o = 0;
  for (let l = 1; l <= 6; ++l) {
    const p = (6 - l) >> 1;
    c[l] = (d * polyval(p, coeff, o, eps2)) / coeff[o + p + 1];
    o += p + 2;
    d *= eps;
  }
}

function c3f(eps: number, c: Float64Array): void {
  let mult = 1, o = 0;
  for (let l = 1; l < 6; ++l) {
    const p = 6 - l - 1;
    mult *= eps;
    c[l] = mult * polyval(p, C3X, o, eps);
    o += p + 1;
  }
}

/** y = sum(c[i] sin(2 i x), i = 1..n) by Clenshaw summation. */
function sinSeries(sinx: number, cosx: number, c: Float64Array): number {
  let k = c.length, n = k - 1;
  const ar = 2 * (cosx - sinx) * (cosx + sinx);
  let y0 = n & 1 ? c[--k] : 0, y1 = 0;
  n >>= 1;
  while (n--) {
    y1 = ar * y0 - y1 + c[--k];
    y0 = ar * y1 - y0 + c[--k];
  }
  return 2 * sinx * cosx * y0;
}

function astroid(x: number, y: number): number {
  const p = x * x, q = y * y, r = (p + q - 1) / 6;
  if (q === 0 && r <= 0) return 0;
  const S = (p * q) / 4, r2 = r * r, r3 = r * r2, disc = S * (S + 2 * r3);
  let u = r;
  if (disc >= 0) {
    let T3 = S + r3;
    T3 += T3 < 0 ? -Math.sqrt(disc) : Math.sqrt(disc);
    const T = Math.cbrt(T3);
    u += T + (T !== 0 ? r2 / T : 0);
  } else {
    const ang = Math.atan2(Math.sqrt(-disc), -(S + r3));
    u += 2 * r * Math.cos(ang / 3);
  }
  const v = Math.sqrt(u * u + q), uv = u < 0 ? q / (v - u) : u + v, w = (uv - q) / (2 * v);
  return uv / (Math.sqrt(uv + w * w) + w);
}

const hypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);
const copysign = (x: number, y: number): number => Math.abs(x) * (y < 0 || (y === 0 && 1 / y < 0) ? -1 : 1);

function angRound(x: number): number {
  const z = 1 / 16;
  let y = Math.abs(x);
  y = y < z ? z - (z - y) : y;
  return copysign(y, x);
}

const remainder = (x: number, y: number): number => {
  x %= y;
  return x < -y / 2 ? x + y : x < y / 2 ? x : x - y;
};

// two-sum results
let sumS = 0, sumT = 0;
function sum(u: number, v: number): void {
  const s = u + v;
  let up = s - v, vpp = s - up;
  up -= u; vpp -= v;
  sumS = s;
  sumT = s ? 0 - (up + vpp) : s;
}

let sinOut = 0, cosOut = 0;
function sincosde(x: number, t: number): void {
  let d = x % 360;
  const q = Math.round(d / 90);
  d = angRound(d - 90 * q + t);
  const r = d * DEG;
  let s = Math.sin(r), c = Math.cos(r);
  if (Math.abs(d) === 45) { c = Math.sqrt(0.5); s = copysign(c, r); }
  else if (Math.abs(d) === 30) { c = Math.sqrt(0.75); s = copysign(0.5, r); }
  let sinx: number, cosx: number;
  switch (q & 3) {
    case 0: sinx = s; cosx = c; break;
    case 1: sinx = c; cosx = -s; break;
    case 2: sinx = -s; cosx = -c; break;
    default: sinx = -c; cosx = s; break;
  }
  cosx += 0;
  if (sinx === 0) sinx = copysign(sinx, x + t);
  sinOut = sinx; cosOut = cosx;
}
const sincosd = (x: number): void => sincosde(x, 0);

// lengths(): s12b (distance / b) and m12b (reduced length / b)
let L_s12b = 0, L_m12b = 0;
function lengths(eps: number, sig12: number, ssig1: number, csig1: number, dn1: number, ssig2: number, csig2: number, dn2: number, wantS: boolean, wantM: boolean): void {
  let A1 = a1m1f(eps), A2 = 0, m0x = 0, J12 = 0;
  seriesC(eps, C1F, C1a);
  if (wantM) {
    A2 = a2m1f(eps);
    seriesC(eps, C2F, C2a);
    m0x = A1 - A2;
    A2 = 1 + A2;
  }
  A1 = 1 + A1;
  if (wantS) {
    const B1 = sinSeries(ssig2, csig2, C1a) - sinSeries(ssig1, csig1, C1a);
    L_s12b = A1 * (sig12 + B1);
    if (wantM) {
      const B2 = sinSeries(ssig2, csig2, C2a) - sinSeries(ssig1, csig1, C2a);
      J12 = m0x * sig12 + (A1 * B1 - A2 * B2);
    }
  } else if (wantM) {
    for (let l = 1; l <= 6; ++l) C2a[l] = A1 * C1a[l] - A2 * C2a[l];
    J12 = m0x * sig12 + (sinSeries(ssig2, csig2, C2a) - sinSeries(ssig1, csig1, C2a));
  }
  if (wantM) L_m12b = dn2 * (csig1 * ssig2) - dn1 * (ssig1 * csig2) - csig1 * csig2 * J12;
}

// inverseStart() results
let I_sig12 = 0, I_salp1 = 0, I_calp1 = 0, I_salp2 = 0, I_calp2 = 0, I_dnm = 0;
function inverseStart(sbet1: number, cbet1: number, sbet2: number, cbet2: number, lam12: number, slam12: number, clam12: number): void {
  const sbet12 = sbet2 * cbet1 - cbet2 * sbet1, cbet12 = cbet2 * cbet1 + sbet2 * sbet1;
  let sbet12a = sbet2 * cbet1;
  sbet12a += cbet2 * sbet1;
  I_sig12 = -1;
  const shortline = cbet12 >= 0 && sbet12 < 0.5 && cbet2 * lam12 < 0.5;
  let somg12: number, comg12: number;
  if (shortline) {
    let sbetm2 = (sbet1 + sbet2) * (sbet1 + sbet2);
    sbetm2 /= sbetm2 + (cbet1 + cbet2) * (cbet1 + cbet2);
    I_dnm = Math.sqrt(1 + EP2 * sbetm2);
    const omg12 = lam12 / (F1 * I_dnm);
    somg12 = Math.sin(omg12); comg12 = Math.cos(omg12);
  } else {
    somg12 = slam12; comg12 = clam12;
  }
  I_salp1 = cbet2 * somg12;
  I_calp1 = comg12 >= 0
    ? sbet12 + (cbet2 * sbet1 * somg12 * somg12) / (1 + comg12)
    : sbet12a - (cbet2 * sbet1 * somg12 * somg12) / (1 - comg12);
  const ssig12 = hypot(I_salp1, I_calp1), csig12 = sbet1 * sbet2 + cbet1 * cbet2 * comg12;
  if (shortline && ssig12 < ETOL2) {
    I_salp2 = cbet1 * somg12;
    I_calp2 = sbet12 - cbet1 * sbet2 * (comg12 >= 0 ? (somg12 * somg12) / (1 + comg12) : 1 - comg12);
    const t = hypot(I_salp2, I_calp2);
    I_salp2 /= t; I_calp2 /= t;
    I_sig12 = Math.atan2(ssig12, csig12);
  } else if (Math.abs(N) > 0.1 || csig12 >= 0 || ssig12 >= 6 * Math.abs(N) * Math.PI * cbet1 * cbet1) {
    // not nearly antipodal: the Newton start below is used as is
  } else {
    // nearly antipodal: the astroid solution for the start azimuth
    const lam12x = Math.atan2(-slam12, -clam12);
    const k2 = sbet1 * sbet1 * EP2, eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
    const lamscale = F * cbet1 * a3f(eps) * Math.PI, betscale = lamscale * cbet1;
    const x = lam12x / lamscale, y = sbet12a / betscale;
    if (y > -TOL1 && x > -1 - XTHRESH) {
      I_salp1 = Math.min(1, -x);
      I_calp1 = -Math.sqrt(1 - I_salp1 * I_salp1);
    } else {
      const k = astroid(x, y), omg12a = lamscale * (-x * k) / (1 + k);
      somg12 = Math.sin(omg12a); comg12 = -Math.cos(omg12a);
      I_salp1 = cbet2 * somg12;
      I_calp1 = sbet12a - (cbet2 * sbet1 * somg12 * somg12) / (1 - comg12);
    }
  }
  if (!(I_salp1 <= 0)) {
    const t = hypot(I_salp1, I_calp1);
    I_salp1 /= t; I_calp1 /= t;
  } else {
    I_salp1 = 1; I_calp1 = 0;
  }
}

// lambda12() results
let M_lam12 = 0, M_calp2 = 0, M_sig12 = 0, M_ssig1 = 0, M_csig1 = 0, M_ssig2 = 0, M_csig2 = 0, M_eps = 0;
function lambda12(sbet1: number, cbet1: number, dn1: number, sbet2: number, cbet2: number, dn2: number, salp1: number, calp1: number, slam120: number, clam120: number): void {
  if (sbet1 === 0 && calp1 === 0) calp1 = -TINY;
  const salp0 = salp1 * cbet1, calp0 = hypot(calp1, salp1 * sbet1);
  M_ssig1 = sbet1;
  const somg1 = salp0 * sbet1;
  M_csig1 = calp1 * cbet1;
  const comg1 = M_csig1;
  let t = hypot(M_ssig1, M_csig1);
  M_ssig1 /= t; M_csig1 /= t;
  M_calp2 = cbet2 !== cbet1 || Math.abs(sbet2) !== -sbet1
    ? Math.sqrt(calp1 * cbet1 * calp1 * cbet1 + (cbet1 < -sbet1 ? (cbet2 - cbet1) * (cbet1 + cbet2) : (sbet1 - sbet2) * (sbet1 + sbet2))) / cbet2
    : Math.abs(calp1);
  M_ssig2 = sbet2;
  const somg2 = salp0 * sbet2;
  M_csig2 = M_calp2 * cbet2;
  const comg2 = M_csig2;
  t = hypot(M_ssig2, M_csig2);
  M_ssig2 /= t; M_csig2 /= t;
  M_sig12 = Math.atan2(Math.max(0, M_csig1 * M_ssig2 - M_ssig1 * M_csig2), M_csig1 * M_csig2 + M_ssig1 * M_ssig2);
  const somg12 = Math.max(0, comg1 * somg2 - somg1 * comg2), comg12 = comg1 * comg2 + somg1 * somg2;
  const eta = Math.atan2(somg12 * clam120 - comg12 * slam120, comg12 * clam120 + somg12 * slam120);
  const k2 = calp0 * calp0 * EP2;
  M_eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
  c3f(M_eps, C3a);
  const B312 = sinSeries(M_ssig2, M_csig2, C3a) - sinSeries(M_ssig1, M_csig1, C3a);
  const domg12 = -F * a3f(M_eps) * salp0 * (M_sig12 + B312);
  M_lam12 = eta + domg12;
}

/** d(lam12)/d(alp1) at the last lambda12() evaluation. */
function dlam12(cbet2: number, dn1: number, dn2: number, sbet1: number): number {
  if (M_calp2 === 0) return (-2 * F1 * dn1) / sbet1;
  lengths(M_eps, M_sig12, M_ssig1, M_csig1, dn1, M_ssig2, M_csig2, dn2, false, true);
  return (L_m12b * F1) / (M_calp2 * cbet2);
}

/** WGS84 geodesic distance in km between two lon/lat points in degrees; NaN for non-finite or |lat| > 90. */
export function geodesicKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  if (!(Math.abs(lat1) <= 90 && Math.abs(lat2) <= 90 && Number.isFinite(lon1) && Number.isFinite(lon2))) return NaN;
  lat1 = angRound(lat1);
  lat2 = angRound(lat2);
  // lon12 = lon2 - lon1 reduced to [-180, 180], with its rounding error lon12s
  sum(remainder(-lon1, 360), remainder(lon2, 360));
  const s = sumS, tt = sumT;
  sum(remainder(s, 360), tt);
  let lon12 = sumS, lon12s = sumT;
  if (lon12 === 0 || Math.abs(lon12) === 180) lon12 = copysign(lon12, lon12s === 0 ? lon2 - lon1 : -lon12s);
  const lonsign = copysign(1, lon12);
  lon12 *= lonsign; lon12s *= lonsign;
  const lam12 = lon12 * DEG;
  sincosde(lon12, lon12s);
  const slam12 = sinOut, clam12 = cosOut;
  lon12s = 180 - lon12 - lon12s;

  if (Math.abs(lat1) < Math.abs(lat2)) { const t = lat1; lat1 = lat2; lat2 = t; }
  const latsign = copysign(1, -lat1);
  lat1 *= latsign; lat2 *= latsign;

  sincosd(lat1);
  let sbet1 = F1 * sinOut, cbet1 = cosOut;
  let t = hypot(sbet1, cbet1);
  sbet1 /= t; cbet1 /= t;
  cbet1 = Math.max(TINY, cbet1);
  sincosd(lat2);
  let sbet2 = F1 * sinOut, cbet2 = cosOut;
  t = hypot(sbet2, cbet2);
  sbet2 /= t; cbet2 /= t;
  cbet2 = Math.max(TINY, cbet2);

  if (cbet1 < -sbet1) {
    if (cbet2 === cbet1) sbet2 = copysign(sbet1, sbet2);
  } else if (Math.abs(sbet2) === -sbet1) cbet2 = cbet1;

  const dn1 = Math.sqrt(1 + EP2 * sbet1 * sbet1), dn2 = Math.sqrt(1 + EP2 * sbet2 * sbet2);

  let meridian = lat1 === -90 || slam12 === 0;
  let s12x = 0;
  if (meridian) {
    const calp1 = clam12, calp2 = 1;
    const ssig1 = sbet1, csig1 = calp1 * cbet1, ssig2 = sbet2, csig2 = calp2 * cbet2;
    const sig12 = Math.atan2(Math.max(0, csig1 * ssig2 - ssig1 * csig2), csig1 * csig2 + ssig1 * ssig2);
    lengths(N, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, true, true);
    s12x = L_s12b;
    const m12x = L_m12b;
    if (sig12 < 1 || m12x >= 0) {
      if (sig12 < 3 * TINY || (sig12 < TOL0 && (s12x < 0 || m12x < 0))) s12x = 0;
      s12x *= B;
    } else meridian = false;
  }

  if (!meridian && sbet1 === 0 && lon12s >= F * 180) {
    s12x = A * lam12; // both points on the equator, not near-antipodal
  } else if (!meridian) {
    inverseStart(sbet1, cbet1, sbet2, cbet2, lam12, slam12, clam12);
    if (I_sig12 >= 0) {
      s12x = I_sig12 * B * I_dnm;
    } else {
      let salp1 = I_salp1, calp1 = I_calp1;
      let salp1a = TINY, calp1a = 1, salp1b = TINY, calp1b = -1;
      let tripn = false, tripb = false;
      for (let numit = 0; ; ++numit) {
        lambda12(sbet1, cbet1, dn1, sbet2, cbet2, dn2, salp1, calp1, slam12, clam12);
        const v = M_lam12;
        if (tripb || !(Math.abs(v) >= (tripn ? 8 : 1) * TOL0) || numit === MAXIT2) break;
        if (v > 0 && (numit < MAXIT1 || calp1 / salp1 > calp1b / salp1b)) { salp1b = salp1; calp1b = calp1; }
        else if (v < 0 && (numit < MAXIT1 || calp1 / salp1 < calp1a / salp1a)) { salp1a = salp1; calp1a = calp1; }
        const dv = numit < MAXIT1 ? dlam12(cbet2, dn1, dn2, sbet1) : 0;
        if (numit < MAXIT1 && dv > 0) {
          const dalp1 = -v / dv;
          if (Math.abs(dalp1) < Math.PI) {
            const sdalp1 = Math.sin(dalp1), cdalp1 = Math.cos(dalp1), nsalp1 = salp1 * cdalp1 + calp1 * sdalp1;
            if (nsalp1 > 0) {
              calp1 = calp1 * cdalp1 - salp1 * sdalp1;
              salp1 = nsalp1;
              t = hypot(salp1, calp1);
              salp1 /= t; calp1 /= t;
              tripn = Math.abs(v) <= 16 * TOL0;
              continue;
            }
          }
        }
        salp1 = (salp1a + salp1b) / 2;
        calp1 = (calp1a + calp1b) / 2;
        t = hypot(salp1, calp1);
        salp1 /= t; calp1 /= t;
        tripn = false;
        tripb = Math.abs(salp1a - salp1) + (calp1a - calp1) < TOLB || Math.abs(salp1 - salp1b) + (calp1 - calp1b) < TOLB;
      }
      lengths(M_eps, M_sig12, M_ssig1, M_csig1, dn1, M_ssig2, M_csig2, dn2, true, false);
      s12x = L_s12b * B;
    }
  }
  return (0 + s12x) / 1000;
}
