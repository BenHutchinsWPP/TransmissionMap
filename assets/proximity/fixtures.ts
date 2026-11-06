// ─── Proximity fixtures ─────────────────────────────────────────────────────
// Role: seeded, deterministic point sets for the proximity harness and the
//       benchmarks (never read from data/). Each generator takes (n, seed, km?)
//       and returns {lon, lat} of exactly n points:
//         d1Uniform    uniform over CONUS
//         d2Clustered  Gaussian clusters (σ 2–20 km) of 5–34 points
//         d3Disc       all points inside one disc of diameter 0.9·km, so every
//                      pair is within km (complete graph)
//         d4Chains     chains of 3–60 points, spacing 0.7·km along a great
//                      circle, so only neighbours link (ends far apart:
//                      transitivity matters)
//         d5Edges      antimeridian pairs and chains, points at and near the
//                      poles, duplicates, invalid rows (NaN, Infinity, lat 95,
//                      lon 200), scattered globally, shuffled; keep n ≥ 200 so
//                      the special rows survive the final cut to n
//       Threshold band: structured sets use spacings of 0.25·km, 0.4·km, 0.5·km,
//       0.7·km, 1.4·km and 0.9·km, never km itself, so no pair sits within 1e-9 km
//       of the threshold; random sets hit it with negligible probability, and
//       methods that use distKm agree with the oracle to the bit regardless.
//       withBuses(points, seed, km) adds ids: consecutive rows form "substations" of
//         1–4 buses sharing one id (a single bus has none, -1); the later buses of a
//         substation move to within 0.05·km of the first, so equal-id points sit
//         close together and a pair test that ignored ids would link them
//       Pure: no DOM, no map.
//
// Deps: none. Used by proximity.test.ts and the benchmarks.

export interface Points { lon: Float64Array; lat: Float64Array }

const KM_PER_DEG = 111.19492664455873; // 2π·6371.0088 / 360
const RAD = Math.PI / 180;
const R = 6371.0088;

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (x: number) => ((x + 180) % 360 + 360) % 360 - 180;
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

function pack(lon: number[], lat: number[], n: number): Points {
  return { lon: Float64Array.from(lon.slice(0, n)), lat: Float64Array.from(lat.slice(0, n)) };
}

function conus(r: () => number): [number, number] {
  return [-125 + r() * 58.5, 24.5 + r() * 25];
}

/** A point `km` away from (lon, lat) along `bearing` radians, on the sphere. */
function destination(lon: number, lat: number, bearing: number, km: number): [number, number] {
  const d = km / R, p = lat * RAD, l = lon * RAD;
  const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(bearing));
  const l2 = l + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
  return [wrap(l2 / RAD), p2 / RAD];
}

export function d1Uniform(n: number, seed: number): Points {
  const r = rng(seed), lon: number[] = [], lat: number[] = [];
  for (let i = 0; i < n; i++) { const [x, y] = conus(r); lon.push(x); lat.push(y); }
  return pack(lon, lat, n);
}

export function d2Clustered(n: number, seed: number): Points {
  const r = rng(seed), lon: number[] = [], lat: number[] = [];
  while (lon.length < n) {
    const [cx, cy] = conus(r);
    const sigma = 2 + r() * 18, size = 5 + Math.floor(r() * 30);
    for (let k = 0; k < size; k++) {
      lon.push(cx + gauss(r) * sigma / (KM_PER_DEG * Math.cos(cy * RAD)));
      lat.push(cy + gauss(r) * sigma / KM_PER_DEG);
    }
  }
  return pack(lon, lat, n);
}

export function d3Disc(n: number, seed: number, km = 1): Points {
  const r = rng(seed), [cx, cy] = conus(r), lon: number[] = [], lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const rad = 0.45 * km * Math.sqrt(r()), th = 2 * Math.PI * r();
    lon.push(cx + rad * Math.cos(th) / (KM_PER_DEG * Math.cos(cy * RAD)));
    lat.push(cy + rad * Math.sin(th) / KM_PER_DEG);
  }
  return pack(lon, lat, n);
}

export function d4Chains(n: number, seed: number, km = 1): Points {
  const r = rng(seed), lon: number[] = [], lat: number[] = [];
  while (lon.length < n) {
    let [x, y] = conus(r);
    const bearing = r() * 2 * Math.PI, len = 3 + Math.floor(r() * 58);
    for (let k = 0; k < len; k++) {
      [x, y] = destination(x, y, bearing, k === 0 ? 0 : 0.7 * km);
      lon.push(x); lat.push(y);
    }
  }
  return pack(lon, lat, n);
}

export function d5Edges(n: number, seed: number, km = 1): Points {
  const r = rng(seed), lon: number[] = [], lat: number[] = [];
  const add = (x: number, y: number) => { lon.push(x); lat.push(y); };
  const lonDeg = (dist: number, y: number) => dist / (KM_PER_DEG * Math.cos(y * RAD));
  const target = Math.max(n, 40);
  // antimeridian: pairs split across ±180, a chain across it, and ±180 themselves
  for (let k = 0; k < Math.max(4, target / 25); k++) {
    const y = -60 + r() * 120, half = lonDeg(0.25 * km, y);
    add(180 - (0.2 + 0.8 * r()) * half, y); add(-180 + (0.2 + 0.8 * r()) * half, y);
  }
  for (let k = 0; k < Math.max(2, target / 100); k++) {
    const y = -60 + r() * 120, step = lonDeg(0.7 * km, y);
    for (let i = -3; i <= 3; i++) add(wrap(180 + i * step + 0.5 * step), y);
  }
  add(180, 10); add(-180, 10); add(180, -10); add(-180, -10);
  // poles: exact poles at several longitudes, rings near them, opposite sides
  add(0, 90); add(77, 90); add(-120, -90); add(10, -90);
  for (let k = 0; k < Math.max(8, target / 20); k++) {
    const sign = r() < 0.5 ? 1 : -1, off = (0.4 * km / KM_PER_DEG) * (0.2 + r());
    add(-180 + r() * 360, sign * (90 - off));
  }
  for (let k = 0; k < Math.max(3, target / 100); k++) {
    const sign = k % 2 ? 1 : -1, off = 0.4 * km / KM_PER_DEG;
    add(0, sign * (90 - off)); add(180, sign * (90 - off));
  }
  // duplicates and invalid rows
  for (let k = 0; k < Math.max(3, target / 50); k++) {
    const [x, y] = conus(r);
    add(x, y); add(x, y);
  }
  for (const [x, y] of [[NaN, 10], [10, NaN], [10, 95], [200, 10], [Infinity, 0], [0, -91], [-181, 0], [NaN, NaN]] as const) add(x, y);
  // scatter, then shuffle (Fisher-Yates) so group order is not the build order
  while (lon.length < n) {
    const y = Math.asin(2 * r() - 1) / RAD;
    add(-180 + r() * 360, r() < 0.3 ? Math.sign(y || 1) * (85 + r() * 5) : y);
  }
  for (let i = lon.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [lon[i], lon[j]] = [lon[j], lon[i]]; [lat[i], lat[j]] = [lat[j], lat[i]];
  }
  return pack(lon, lat, n);
}

export interface PointsWithIds extends Points { ids: Int32Array }

export function withBuses(p: Points, seed: number, km: number): PointsWithIds {
  const r = rng(seed), n = p.lon.length;
  const lon = Float64Array.from(p.lon), lat = Float64Array.from(p.lat), ids = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n;) {
    const k = Math.min(n - i, 1 + Math.floor(r() * 4));
    for (let m = 1; m < k; m++) {
      const rad = 0.05 * km * r(), th = 2 * Math.PI * r();
      lon[i + m] = lon[i] + (rad * Math.cos(th)) / (KM_PER_DEG * Math.max(0.01, Math.cos(lat[i] * RAD)));
      lat[i + m] = lat[i] + (rad * Math.sin(th)) / KM_PER_DEG;
      if (Math.abs(lat[i + m]) > 90 || Math.abs(lon[i + m]) > 180) { lon[i + m] = lon[i]; lat[i + m] = lat[i]; }
    }
    if (k > 1) for (let m = 0; m < k; m++) ids[i + m] = next;
    if (k > 1) next++;
    i += k;
  }
  return { lon, lat, ids };
}
