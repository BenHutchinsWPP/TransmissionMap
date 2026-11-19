// ─── Substation snapping + name search for the route planner ─────────────────
// Role: pure. Builds an in-memory index over HIFLD substation points (CONUS
//       only) and answers three questions: which HIFLD substation does a clicked
//       point snap to for a line of a given nominal kV (`snapAt`; known kV ≥ the
//       floor first, then unknown kV), which OpenStreetMap substation point it
//       snaps to (`snapAmong`; known kV ≥ the floor only, US points on the 250 m
//       routing grid, traction/industrial dropped), and which substations match a
//       typed name (`searchSubstations`, HIFLD only). `osmKv` reads an OSM point's
//       `nominal_kv` (a numeric string, empty when unknown). Every hit names its
//       `source`. No fetching, no DOM, no app state. The caller supplies the line
//       type's nominal kV.
// Deps: route/grid.ts (GRID_250, cellOfLngLat). GeoJSON types are ambient.

import { GRID_250, cellOfLngLat } from './grid.js';

export interface SnapHit {
  id: string;
  name: string | null;
  lngLat: [number, number];
  maxKv: number | null;
  kvUnknown: boolean;
  distanceKm: number;
  states: string[];
  ba: string[];
  source: 'hifld' | 'osm';
}

/** One OSM substation point as read from the points archive (osm-substation.ts). */
export interface OsmPoint {
  fid: number | string;
  lngLat: [number, number];
  name: string | null;
  kv: number | null;
  subType?: string | null;
  countries?: string | null;
}

interface Sub {
  id: string;
  lng: number;
  lat: number;
  name: string;
  lname: string;
  isPlaceholder: boolean;
  maxKv: number | null;
  states: string[];
  ba: string[];
}

export interface SubstationIndex {
  subs: Sub[];
  grid: Map<string, Sub[]>;
}

const CONUS = new Set(
  ("AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND " +
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split(" "),
);
const LADDER = [765, 500, 345, 230, 161, 138, 115, 69];
const CELL = 0.1;

export function kvFloor(kv: number): number {
  if (kv === 500) return 345;
  if (kv === 345) return 230;
  if (kv === 230) return 115;
  for (const l of LADDER) if (l < kv) return l;
  return 69;
}

const tags = (v: unknown): string[] =>
  typeof v === "string" ? v.split("|").filter((s) => s && s !== "none") : [];
const cell = (lng: number, lat: number): string => `${Math.floor(lng / CELL)},${Math.floor(lat / CELL)}`;

export function buildSubstationIndex(fc: GeoJSON.FeatureCollection): SubstationIndex {
  const subs: Sub[] = [];
  const grid = new Map<string, Sub[]>();
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const states = tags(p.states);
    if (!states.some((s) => CONUS.has(s))) continue;
    const [lng, lat] = f.geometry.coordinates;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const n = typeof p.max_kv === "string" || typeof p.max_kv === "number" ? Number(p.max_kv) : NaN;
    const kv = Number.isFinite(n) && n > 0 ? n : null;
    const s: Sub = {
      id: String(p.hifld_id ?? ""),
      lng,
      lat,
      name,
      lname: name.toLowerCase(),
      isPlaceholder: name === "" || /^UNKNOWN\d*$/i.test(name),
      maxKv: kv,
      states,
      ba: tags(p.ba),
    };
    subs.push(s);
    const k = cell(lng, lat);
    const b = grid.get(k);
    if (b) b.push(s);
    else grid.set(k, [s]);
  }
  return { subs, grid };
}

function km(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function hit(s: Sub, distanceKm: number): SnapHit {
  return {
    id: s.id,
    name: s.isPlaceholder ? null : s.name,
    lngLat: [s.lng, s.lat],
    maxKv: s.maxKv,
    kvUnknown: s.maxKv === null,
    distanceKm,
    states: s.states,
    ba: s.ba,
    source: 'hifld',
  };
}

/** An OSM point's `nominal_kv` as kV: a finite number > 0 (number or numeric string), else null. */
export function osmKv(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Items within `radiusKm` of `at` whose kV is unknown or ≥ the floor for a `kv` line,
 *  split into known and unknown kV, each nearest first. The one eligibility and ranking
 *  rule snapAt and snapAmong share. */
function ranked<T>(
  items: Iterable<T>,
  at: [number, number],
  kv: number,
  radiusKm: number,
  pos: (t: T) => [number, number],
  kvOf: (t: T) => number | null,
): { known: { item: T; d: number }[]; unknown: { item: T; d: number }[] } {
  const floor = kvFloor(kv);
  const known: { item: T; d: number }[] = [];
  const unknown: { item: T; d: number }[] = [];
  for (const t of items) {
    const k = kvOf(t);
    if (k !== null && k < floor) continue;
    const [lng, lat] = pos(t);
    const d = km(at[0], at[1], lng, lat);
    if (!(d <= radiusKm)) continue;
    (k === null ? unknown : known).push({ item: t, d });
  }
  const byDist = (a: { d: number }, b: { d: number }) => a.d - b.d;
  return { known: known.sort(byDist), unknown: unknown.sort(byDist) };
}

function* near(index: SubstationIndex, lng: number, lat: number, radiusKm: number): Generator<Sub> {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let x = Math.floor((lng - dLng) / CELL); x <= Math.floor((lng + dLng) / CELL); x++) {
    for (let y = Math.floor((lat - dLat) / CELL); y <= Math.floor((lat + dLat) / CELL); y++) {
      yield* index.grid.get(`${x},${y}`) ?? [];
    }
  }
}

export function snapAt(
  index: SubstationIndex,
  lngLat: [number, number],
  kv: number,
  radiusKm = 3,
): { best: SnapHit | null; others: SnapHit[] } {
  const r = ranked(near(index, lngLat[0], lngLat[1], radiusKm), lngLat, kv, radiusKm, (s) => [s.lng, s.lat], (s) => s.maxKv);
  const all = [...r.known, ...r.unknown].map(({ item, d }) => hit(item, d));
  return { best: all[0] ?? null, others: all.slice(1, 4) };
}

const OSM_EXCLUDED = new Set(['minor_distribution', 'traction', 'industrial']);   // minor_distribution: dropped at build; kept as a guard
const onGrid = ([lng, lat]: [number, number]): boolean => {
  const [c, r] = cellOfLngLat(GRID_250, lng, lat);
  return c >= 0 && r >= 0 && c < GRID_250.cols && r < GRID_250.rows;
};

/** The nearest OSM substation point within `radiusKm` of `at` for a `kv` line: known kV ≥ the floor only,
 *  tagged in the US (`countries` holds USA) and on the 250 m routing grid, sub type not traction or industrial.
 *  A blank name keeps the hit with `name: null`. */
export function snapAmong(points: Iterable<OsmPoint>, at: [number, number], kv: number, radiusKm = 3): SnapHit | null {
  const usable = [...points].filter((p) =>
    tags(p.countries).includes('USA') &&
    !OSM_EXCLUDED.has(String(p.subType ?? '').trim().toLowerCase()) &&
    onGrid(p.lngLat));
  const best = ranked(usable, at, kv, radiusKm, (p) => p.lngLat, (p) => p.kv).known[0];
  if (!best) return null;
  const p = best.item;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  return {
    id: `osm:${p.fid}`,
    name: name || null,
    lngLat: [p.lngLat[0], p.lngLat[1]],
    maxKv: p.kv,
    kvUnknown: false,
    distanceKm: best.d,
    states: [],
    ba: [],
    source: 'osm',
  };
}

export function searchSubstations(index: SubstationIndex, query: string, kv: number, limit = 8): SnapHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const floor = kvFloor(kv);
  const ranked: { s: Sub; rank: number }[] = [];
  for (const s of index.subs) {
    if (s.isPlaceholder) continue;
    const at = s.lname.indexOf(q);
    if (at < 0) continue;
    const tier = s.maxKv === null ? 1 : s.maxKv >= floor ? 0 : 2;
    ranked.push({ s, rank: (at === 0 ? 0 : 3) + tier });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.s.lname.localeCompare(b.s.lname));
  return ranked.slice(0, limit).map((r) => hit(r.s, NaN));
}
