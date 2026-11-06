// ─── Substation snapping + name search for the route planner ─────────────────
// Role: pure. Builds an in-memory index over HIFLD substation points (CONUS
//       only) and answers two questions: which substation does a clicked point
//       snap to for a line of a given nominal kV (`snapAt`), and which
//       substations match a typed name (`searchSubstations`). No fetching, no
//       DOM, no app state. The caller supplies the line type's nominal kV.
// Deps: none (GeoJSON types are ambient).

export interface SnapHit {
  id: string;
  name: string | null;
  lngLat: [number, number];
  maxKv: number | null;
  kvUnknown: boolean;
  distanceKm: number;
  states: string[];
  ba: string[];
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
  };
}

export function snapAt(
  index: SubstationIndex,
  lngLat: [number, number],
  kv: number,
  radiusKm = 3,
): { best: SnapHit | null; others: SnapHit[] } {
  const [lng, lat] = lngLat;
  const floor = kvFloor(kv);
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const known: SnapHit[] = [];
  const unknown: SnapHit[] = [];
  for (let x = Math.floor((lng - dLng) / CELL); x <= Math.floor((lng + dLng) / CELL); x++) {
    for (let y = Math.floor((lat - dLat) / CELL); y <= Math.floor((lat + dLat) / CELL); y++) {
      for (const s of index.grid.get(`${x},${y}`) ?? []) {
        if (s.maxKv !== null && s.maxKv < floor) continue;
        const d = km(lng, lat, s.lng, s.lat);
        if (d > radiusKm) continue;
        (s.maxKv === null ? unknown : known).push(hit(s, d));
      }
    }
  }
  const byDist = (a: SnapHit, b: SnapHit) => a.distanceKm - b.distanceKm;
  const all = [...known.sort(byDist), ...unknown.sort(byDist)];
  return { best: all[0] ?? null, others: all.slice(1, 4) };
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
