// ─── Grid Operations: one hour of EIA-930 → map features ─────────────────────
// Role: the pure half of the Grid Operations layer. buildHour() turns one hour
//       read by eia930-read.ts into two FeatureCollections: a point per
//       balancing authority (or per group of them) carrying load, generation,
//       net interchange and its fuel mix, and a line per pair of neighbours
//       carrying the interchange between them. Raw MW only.
// Pairs: EIA-930 has each BA report its own net flow to each neighbour
//       (positive = it exports to that neighbour). The two sides of a tie need
//       not agree, so a pair's value is the mean of the two reports, each taken
//       from the exporter's side; both raw reports ride on the feature for the
//       popup. A pair only one side reports uses that report.
// Groups: "region" sums the BAs of each EIA region, "interconnect" each
//       interconnection (Canada and Mexico stay their own groups). A group's
//       load, generation and net interchange are its members' sums; flows
//       between two members drop out, and flows to another group add up. A
//       group sits at the mean of its members' positions.
//       "wecc" sums the BAs of each WECC area (WECC_AREAS; a BA covering several
//       areas makes one node named with all of them); every BA outside the
//       table falls back to its EIA region. A BA that sits in no WECC area but
//       is wired into the western grid (OFF_AREA: GRID) stays its own node in
//       "wecc", drawn at a fixed spot off the coast with its reason on the node.
//       A BA with no EIA region (GRID, CEA) stands alone in "region" and "wecc"
//       instead of dropping off the map. Membership follows the data: a
//       retired code stops reporting and its successor starts.
// Fuels: EIA-930's energy sources fold into the map's fuel legend rows
//       (src/colors/fuel.ts). Coarse (before 2024-07) and fine (after) sources
//       of one fuel never both carry a value in the same hour, so they add.
//       Storage is signed: a charging battery is negative; the disc draws
//       positive values only and the popup prints the sign.
// Deps: src/registry/eia930-bas.json (positions, names, regions — built by
//       scripts/build_eia930_bas.py), src/colors/fuel.ts (FUEL_LEGEND). Pure.

import BA_TABLE from '../../src/registry/eia930-bas.json';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';

export type GroupBy = "ba" | "region" | "interconnect" | "wecc";
export const GROUP_BYS: readonly GroupBy[] = ["ba", "region", "interconnect", "wecc"];
/** How grid-ops.ts draws a node: a bubble, or a fuel disc in a load ring. */
export type GridGlyph = "bubble" | "disc";
export const GRID_GLYPHS: readonly GridGlyph[] = ["bubble", "disc"];

export interface BaInfo {
  code: string; name: string; region: string | null; interconnect: string | null;
  retired: string | null; lon: number; lat: number;
}
export const BAS: readonly BaInfo[] = BA_TABLE.bas;
const BA_BY_CODE = new Map(BAS.map(b => [b.code, b]));

/** One BA's values for an hour, as eia930-read.ts returns them. */
export interface BaHour { load: number | null; gen: number | null; net: number | null; fuels: Record<string, number> }
/** One BA's report of its net flow to one neighbour (positive: `ba` exports). */
export interface PairReport { ba: string; adj: string; mw: number }
export interface HourData { at: number; bas: Map<string, BaHour>; pairs: PairReport[] }

export const REGION_NAMES: Record<string, string> = {
  NW: "Northwest", CAL: "California", SW: "Southwest", CENT: "Central", MIDW: "Midwest",
  TEX: "Texas", SE: "Southeast", FLA: "Florida", CAR: "Carolinas", TEN: "Tennessee",
  MIDA: "Mid-Atlantic", NY: "New York", NE: "New England", CAN: "Canada", MEX: "Mexico",
};
export const INTERCONNECT_NAMES: Record<string, string> = {
  western: "Western Interconnection", eastern: "Eastern Interconnection", ercot: "ERCOT",
  CAN: "Canada", MEX: "Mexico",
};

// EIA-930 energy source → FUEL_LEGEND id.
export const SOURCE_FUEL: Record<string, string> = {
  solar: "solar", solar_w_integrated_battery_storage: "solar", solar_wo_integrated_battery_storage: "solar",
  wind: "wind", wind_w_integrated_battery_storage: "wind", wind_wo_integrated_battery_storage: "wind",
  hydro: "hydro", hydro_excluding_pumped_storage: "hydro", pumped_storage: "pumped_storage",
  battery_storage: "storage", other_energy_storage: "storage", unknown_energy_storage: "storage",
  geothermal: "geo", coal: "coal", gas: "gas", nuclear: "nuclear", oil: "oil", other: "other", unknown: "other",
};
/** The fuel rows in legend order, as a node's `fuels` lists them. */
export const FUEL_ORDER = FUEL_LEGEND.map(f => f.id);

/** WECC area groups: id → name and the EIA-930 BAs reporting inside it. Areas
 *  17 (AEPCO), 52 (FortisBC), 78 (PRPA) and 82 (SunZia) have no BA of their own. */
/** WECC areas: `short` is the 2–5 letter code the bubble label shows after the
 *  area number ("A65: PACE"); `name` is the popup title. */
export const WECC_AREAS: Record<string, { short: string; name: string; members: readonly string[] }> = {
  A10: { short: "PNM", name: "Area 10 · New Mexico", members: ["PNM"] },
  A11: { short: "EPE", name: "Area 11 · El Paso", members: ["EPE"] },
  A14: { short: "APS", name: "Area 14 · Arizona (APS)", members: ["AZPS", "DEAA", "HGMA", "GRMA"] },
  A15: { short: "SRP", name: "Area 15 · SRP", members: ["SRP"] },
  A16: { short: "TEP", name: "Area 16 · Tucson (TEP)", members: ["TEPC"] },
  A19: { short: "WALC", name: "Area 19 · WAPA Lower Colorado", members: ["WALC", "GRIF"] },
  A20: { short: "CFE", name: "Area 20 · Mexico (CFE Baja)", members: ["CEN", "CFE"] },
  A21: { short: "IID", name: "Area 21 · Imperial (IID)", members: ["IID"] },
  "A22-24-30": { short: "CAISO", name: "Areas 22, 24, 30 · California (CAISO, BANC, TID)", members: ["CISO", "BANC", "TIDC"] },
  A26: { short: "LDWP", name: "Area 26 · LADWP", members: ["LDWP"] },
  "A18-64": { short: "NEVP", name: "Areas 18, 64 · Nevada (NV Energy)", members: ["NEVP"] },
  A40: { short: "NW", name: "Area 40 · Northwest", members: ["BPAT", "PACW", "PSEI", "SCL", "TPWR", "PGE", "AVA", "CHPD", "DOPD", "GCPD", "AVRN"] },
  A50: { short: "BCHA", name: "Area 50 · BC Hydro", members: ["BCHA"] },
  A54: { short: "AESO", name: "Area 54 · Alberta", members: ["AESO"] },
  A60: { short: "IPCO", name: "Area 60 · Idaho", members: ["IPCO"] },
  A62: { short: "NWMT", name: "Area 62 · Montana", members: ["NWMT", "GWA", "WWA"] },
  A63: { short: "WAUW", name: "Area 63 · WAPA Upper West", members: ["WAUW"] },
  A65: { short: "PACE", name: "Area 65 · PacifiCorp East", members: ["PACE"] },
  A70: { short: "PSCO", name: "Area 70 · Colorado (PSCo)", members: ["PSCO"] },
  A73: { short: "WACM", name: "Area 73 · WAPA Rocky Mountain", members: ["WACM"] },
  "A63-73": { short: "SPPW", name: "Areas 63, 73 · SPP West", members: ["SWPW"] },
  A74: { short: "BHBA", name: "Area 74 · Black Hills", members: ["BHBA"] },
};
/** A WECC area's bubble label: "A65: PACE", "A22/24/30: CAISO". */
export const weccTag = (id: string): string => `${id.replace(/-/g, "/")}: ${WECC_AREAS[id].short}`;
const WECC_OF = new Map(Object.entries(WECC_AREAS).flatMap(([id, a]) => a.members.map(m => [m, id] as const)));

/** Western BAs that belong to no WECC area: where "wecc" draws them and the
 *  i18n key of the popup's reason. */
export const OFF_AREA: Record<string, { at: [number, number]; why: string }> = {
  GRID: { at: [-126.3, 43.0], why: "gridOps.offArea.GRID" },
};
/** Whether a node prints its numbers: the visitor's choice, else on except by WECC area. */
export const numbersShown = (numbers: boolean | null, by: GroupBy): boolean => numbers ?? by !== "wecc";

const WESTERN_REGIONS = new Set(["NW", "CAL", "SW"]);
function groupOf(b: BaInfo, by: GroupBy): string | null {
  if (by === "ba") return b.code;
  if (by === "region") return b.region ?? b.code;
  if (by === "wecc") return OFF_AREA[b.code] ? b.code : WECC_OF.get(b.code) ?? b.region ?? b.code;
  if (b.region === "CAN" || b.region === "MEX") return b.region;
  return b.interconnect ?? (b.region === "TEX" ? "ercot" : b.region && WESTERN_REGIONS.has(b.region) ? "western" : b.region ? "eastern" : null);
}

const REGION_SYSTEM: Record<string, string> = { NW: "western", CAL: "western", SW: "western", TEX: "ercot", CAN: "CAN", MEX: "MEX" };
/** The system a node's size is measured against: its interconnection (Canada
 *  and Mexico apart), so WECC's largest BA draws as large as the East's. One
 *  scale for everything when the nodes are the interconnections themselves. */
export function sizeScale(id: string, by: GroupBy): string {
  if (by === "interconnect") return "all";
  if (by === "wecc" && id in WECC_AREAS) return "western";
  if ((by === "region" || by === "wecc") && (id in OFF_AREA || (BA_BY_CODE.has(id) && !(id in REGION_NAMES)))) return sizeScale(id, "ba");
  if (by === "region" || by === "wecc") return REGION_SYSTEM[id] ?? "eastern";
  const b = BA_BY_CODE.get(id);
  return (b && groupOf(b, "interconnect")) ?? "eastern";
}

function groupName(id: string, by: GroupBy): string {
  if (by === "ba") return BA_BY_CODE.get(id)?.name ?? id;
  if (by === "wecc" && id in WECC_AREAS) return WECC_AREAS[id].name;
  const named = (by === "region" || by === "wecc" ? REGION_NAMES : INTERCONNECT_NAMES)[id];
  return named ?? BA_BY_CODE.get(id)?.name ?? id;
}

const add = (a: number | null, b: number | null) => b == null ? a : (a ?? 0) + b;

export interface NodeProps {
  id: string; name: string; kind: "ba" | "external";
  tag: string;                  // the bubble label: the id, or "A65: PACE" for a WECC area
  load: number | null; gen: number | null; net: number | null;
  short: string;                // a WECC area's short code ("NW"); else the id
  cover: number | null;         // gen / load, 2 decimals, when load > 0 and gen is a number; else null
  offArea: string;              // i18n key: why an off-area BA sits apart in "wecc"; else ""
  size: number;                 // max(load, gen), for the bubble's area
  members: string;              // JSON string[]: the BA codes in a group ([] for a BA)
  fuels: string;                // JSON [fuel id, MW][] in legend order, MW ≠ 0
  ties: string;                 // JSON Tie[]: this node's neighbours, by |MW| descending
}
export interface Tie { with: string; mw: number; mine: number | null; theirs: number | null }
export interface EdgeProps { from: string; to: string; mw: number; a: number | null; b: number | null }

interface PairAcc { a: number | null; b: number | null }

/** The hour as map features. `dropped` lists codes in the data with no
 *  position in eia930-bas.json (left off the map). */
export function buildHour(hour: HourData, by: GroupBy): {
  nodes: GeoJSON.FeatureCollection<GeoJSON.Point, NodeProps>;
  edges: GeoJSON.FeatureCollection<GeoJSON.LineString, EdgeProps>;
  dropped: string[];
} {
  const dropped = new Set<string>();
  const known = (code: string) => { const b = BA_BY_CODE.get(code); if (!b) dropped.add(code); return b; };

  // Pairs first: average the two sides of each tie, from the first code's side.
  const pairs = new Map<string, PairAcc>();
  for (const r of hour.pairs) {
    if (!Number.isFinite(r.mw)) continue;
    const [x, y] = r.ba < r.adj ? [r.ba, r.adj] : [r.adj, r.ba];
    const acc = pairs.get(x + "|" + y) ?? { a: null, b: null };
    if (r.ba === x) acc.a = r.mw; else acc.b = -r.mw;
    pairs.set(x + "|" + y, acc);
  }

  // Nodes: every BA with values or a tie, folded into its group.
  interface Acc { load: number | null; gen: number | null; net: number | null; fuels: Map<string, number>; members: Set<string>; lon: number[]; lat: number[]; hasOps: boolean }
  const groups = new Map<string, Acc>();
  const groupOfCode = new Map<string, string>();
  const touch = (code: string) => {
    if (groupOfCode.has(code)) return groupOfCode.get(code)!;
    const b = known(code);
    const g = b ? groupOf(b, by) : null;
    if (!b || !g) return null;
    groupOfCode.set(code, g);
    const acc: Acc = groups.get(g) ?? { load: null, gen: null, net: null, fuels: new Map(), members: new Set(), lon: [], lat: [], hasOps: false };
    acc.members.add(code); acc.lon.push(b.lon); acc.lat.push(b.lat);
    groups.set(g, acc);
    return g;
  };
  for (const [code, v] of hour.bas) {
    const g = touch(code);
    if (!g) continue;
    const acc = groups.get(g)!;
    acc.load = add(acc.load, v.load); acc.gen = add(acc.gen, v.gen); acc.net = add(acc.net, v.net);
    if (v.load != null || v.gen != null) acc.hasOps = true;
    for (const [src, mw] of Object.entries(v.fuels)) {
      const fuel = SOURCE_FUEL[src];
      if (fuel && Number.isFinite(mw)) acc.fuels.set(fuel, (acc.fuels.get(fuel) ?? 0) + mw);
    }
  }
  for (const key of pairs.keys()) for (const code of key.split("|")) touch(code);

  // Edges between groups: each pair's mean, summed per group pair.
  const mean = (p: PairAcc) => p.a != null && p.b != null ? (p.a + p.b) / 2 : (p.a ?? p.b ?? 0);
  const links = new Map<string, PairAcc & { mw: number }>();
  const ties = new Map<string, Map<string, Tie>>();
  for (const [key, p] of pairs) {
    const [x, y] = key.split("|");
    const gx = groupOfCode.get(x), gy = groupOfCode.get(y);
    if (!gx || !gy || gx === gy) continue;
    const [g1, g2, s] = gx < gy ? [gx, gy, 1] : [gy, gx, -1];
    const l = links.get(g1 + "|" + g2) ?? { a: null, b: null, mw: 0 };
    l.mw += s * mean(p);
    if (p.a != null) l.a = (l.a ?? 0) + s * p.a;
    if (p.b != null) l.b = (l.b ?? 0) + s * p.b;
    links.set(g1 + "|" + g2, l);
  }
  for (const [key, l] of links) {
    const [g1, g2] = key.split("|");
    const tie = (from: string, to: string, sign: number) => {
      const m = ties.get(from) ?? new Map<string, Tie>();
      m.set(to, { with: to, mw: sign * l.mw, mine: sign > 0 ? l.a : l.b == null ? null : -l.b, theirs: sign > 0 ? l.b : l.a == null ? null : -l.a });
      ties.set(from, m);
    };
    tie(g1, g2, 1); tie(g2, g1, -1);
  }

  const pos = (id: string, acc: Acc): [number, number] =>
    by === "wecc" && OFF_AREA[id] ? OFF_AREA[id].at : [acc.lon.reduce((s, v) => s + v, 0) / acc.lon.length, acc.lat.reduce((s, v) => s + v, 0) / acc.lat.length];

  const nodes: GeoJSON.Feature<GeoJSON.Point, NodeProps>[] = [...groups].map(([id, acc]) => {
    const fuels = FUEL_ORDER.filter(f => acc.fuels.has(f) && acc.fuels.get(f) !== 0).map(f => [f, Math.round(acc.fuels.get(f)!)]);
    const nodeTies = [...(ties.get(id)?.values() ?? [])].sort((p, q) => Math.abs(q.mw) - Math.abs(p.mw))
      .map(t => ({ ...t, mw: Math.round(t.mw), mine: t.mine == null ? null : Math.round(t.mine), theirs: t.theirs == null ? null : Math.round(t.theirs) }));
    const r = (v: number | null) => v == null ? null : Math.round(v);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: pos(id, acc) },
      properties: {
        id, name: groupName(id, by), kind: acc.hasOps ? "ba" : "external",
        tag: by === "wecc" && id in WECC_AREAS ? weccTag(id) : id,
        short: by === "wecc" && id in WECC_AREAS ? WECC_AREAS[id].short : id,
        cover: acc.load != null && acc.load > 0 && acc.gen != null ? Math.round(acc.gen / acc.load * 100) / 100 : null,
        offArea: by === "wecc" && OFF_AREA[id] ? OFF_AREA[id].why : "",
        load: r(acc.load), gen: r(acc.gen), net: r(acc.net),
        size: Math.max(acc.load ?? 0, acc.gen ?? 0),
        members: JSON.stringify(by === "ba" ? [] : [...acc.members].sort()),
        fuels: JSON.stringify(fuels), ties: JSON.stringify(nodeTies),
      },
    };
  });

  const where = new Map(nodes.map(n => [n.properties.id, n.geometry.coordinates as [number, number]]));
  const edges: GeoJSON.Feature<GeoJSON.LineString, EdgeProps>[] = [];
  for (const [key, l] of links) {
    const [g1, g2] = key.split("|");
    if (Math.round(l.mw) === 0) continue;
    // Each side's own report, from the exporter's side: `a` by `from`, `b` by `to`.
    const [from, to, a, b] = l.mw > 0
      ? [g1, g2, l.a, l.b]
      : [g2, g1, l.b == null ? null : -l.b, l.a == null ? null : -l.a];
    edges.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: arc(where.get(from)!, where.get(to)!) },
      properties: { from, to, mw: Math.round(Math.abs(l.mw)), a: round(a), b: round(b) },
    });
  }
  return {
    nodes: { type: "FeatureCollection", features: nodes },
    edges: { type: "FeatureCollection", features: edges },
    dropped: [...dropped].sort(),
  };
}

const round = (v: number | null) => v == null ? null : Math.round(v);

/** A gentle curve from a to b (bowed left of the direction of travel), so the
 *  two directions of a busy corridor and nearby parallel ties stay apart. */
export function arc(a: [number, number], b: [number, number], steps = 12): [number, number][] {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const cx = mx - dy * 0.12, cy = my + dx * 0.12;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return out;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;

/** Where an edge's arrowhead sits (the curve's middle point) and its
 *  `icon-rotate` in degrees, clockwise from east, for an icon drawn pointing
 *  east with map rotation alignment. The direction is measured in Web Mercator,
 *  as the map draws it, not in raw degrees. */
export function arrowAt(line: [number, number][]): { at: [number, number]; rotate: number } {
  const mid = Math.floor(line.length / 2);
  const p = line[Math.max(0, mid - 1)], q = line[Math.min(line.length - 1, mid + 1)];
  const east = q[0] - p[0], north = mercY(q[1]) - mercY(p[1]);
  return { at: line[mid], rotate: -Math.atan2(north, east) * 180 / Math.PI };
}
