// ─── Route structure and aviation observations ────────────────────────────────
// Role: bounded optional report reads and exact drawn-route roof intervals / finite runway distances.
//       Coverage is the source query rectangle, never verified building completeness or occupancy.
//       Intervals are unioned along each traversal; holes and boundary-only contacts contribute no length.
//       National data (manifest version 2, id_kind "piece"; v1 regional manifests are refused): one GeoParquet
//       file per state, chosen by `bounds5070` overlap with each polyline's box (+100 m). The files are read
//       one after another with ONE budget per call (256 MiB counting every footer and range, 1 GiB decode,
//       no row cap); report-read.ts hands each decoded chunk to a sink here that turns a row into a footprint,
//       adds its roof intervals to every polyline's tally and drops the geometry. Piece ids are
//       `<ST>:<tile>:<ordinal>`: a duplicate id in one call throws. Over budget -> buildings are
//       `unavailable` (reasonKey route.obs.overBudget); never a zero. Class "Nonresidential" is the cache's
//       group 1; image_date is null, so imagery years are the union of the read files' manifest `imageryYears`.
//       aviation.json (version 2) is fetched once per worker session per generation, facilities keyed by
//       ARPT_ID, and filtered to each polyline's box + AVIATION_BUFFER_M; more than 100 facilities or runways
//       within that make the aviation family unavailable (never a silent cut).
// Deps: report-read.ts (bounded GeoParquet rows), grid.ts (Albers), route.ts (I/O type only).
import { BYTE_BUDGET_MSG, DECODE_BUDGET_MSG, buildCorridor, readSpatialRows, type SpatialBudget } from './report-read.js';
import { albersForward } from './grid.js';
import type { RouteIO } from './route.js';

type XY = [number, number];
type Bounds = [number, number, number, number];
type Interval = [number, number];
export type StructureClass = 'all' | 'residential' | 'nonresidential' | 'unknown';
export interface ObservationProvenance { source: string; sha256: string; fetchedAt: string; credit: string; license: string }
/** `reasonKey` names an i18n key whose text says the same as `reason` (English). */
export interface UnavailableObservation { status: 'unavailable'; reason: string; reasonKey?: string }
export interface BuildingObservation {
  status: 'ok'; totalM: number; observedM: number;
  counts: Record<StructureClass, number>; metres: Record<StructureClass, number>;
  imageryYears: number[]; provenance: ObservationProvenance;
}
export interface AviationFacilityObservation {
  id: string; name: string; type: string; use: string; operationalStatus: string;
  distanceM: number; runwayCoverage: 'sampled' | 'not-queried';
}
export interface AviationRunwayObservation {
  airport: string; runway: string; centrelineM: number; endM: number; airportPointM: number;
  elevationsFt: [number | null, number | null]; surveyDates: [string | null, string | null];
}
export interface AviationObservation {
  status: 'ok'; cycle: string; scope: string; provenance: ObservationProvenance;
  facilities: AviationFacilityObservation[]; runways: AviationRunwayObservation[];
}
export interface RouteScreening {
  buildings: BuildingObservation | UnavailableObservation;
  aviation: AviationObservation | UnavailableObservation;
}
interface Descriptor extends ObservationProvenance { file: string; bounds5070: Bounds; coverage?: Bounds[]; imageryYears?: number[]; cycle?: string; scope?: string }
export interface BuildingFeature { id: string; class: string | null; polygons: XY[][][] }
interface Facility { id: string; name: string; type: string; use: string; status: string; point: XY }
interface Runway { airport: string; runway: string; ends: [XY, XY]; elevationsFt: [number | null, number | null]; surveyDates: [string | null, string | null] }
interface AviationData { version: 2; facilities: Facility[]; runways: Runway[] }
type IO = Pick<RouteIO, 'fetchRange' | 'byteLength'> & { reportUrl: string };
const NONRES = new Set(['Nonresidential', 'Commercial', 'Industrial', 'Assembly', 'Education', 'Government', 'Utility and Misc']);
const BUDGET_BYTES = 256 * 2 ** 20, BUDGET_UNCOMPRESSED = 2 ** 30, AVIATION_JSON_CAP = 8 * 2 ** 20, AVIATION_BUFFER_M = 10_000, AVIATION_LIMIT = 500;
export const OVER_BUDGET = { reason: 'structure data along this route exceeds 256 MiB', reasonKey: 'route.obs.overBudget' };
const EPS = 1e-7, MAX_OPS = 8_000_000, MAX_VERTICES = 500_000;
const classes: StructureClass[] = ['all', 'residential', 'nonresidential', 'unknown'];
const blank = (): Record<StructureClass, number> => ({ all: 0, residential: 0, nonresidential: 0, unknown: 0 });
const unavailable = (e: unknown): UnavailableObservation => ({ status: 'unavailable', reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid observation object'); return v as Record<string, unknown>; };
const text = (v: unknown, max = 200): string => { if (typeof v !== 'string' || v.length > max) throw new Error('invalid observation text'); return v; };
const xy = (v: unknown, limit = 10_000_000): XY => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit)) throw new Error('invalid projected coordinate');
  return [v[0], v[1]];
};
const bounds = (v: unknown, limit?: number): Bounds => {
  if (!Array.isArray(v) || v.length !== 4) throw new Error('invalid observation bounds');
  const a = xy(v.slice(0, 2), limit), b = xy(v.slice(2), limit);
  if (a[0] >= b[0] || a[1] >= b[1]) throw new Error('empty observation bounds');
  return [...a, ...b];
};
const provenance = (d: Descriptor): ObservationProvenance => ({ source: d.source, sha256: d.sha256, fetchedAt: d.fetchedAt, credit: d.credit, license: d.license });
function descriptor(v: unknown, file: string): Descriptor {
  const r = record(v);
  if (r.file !== file || !/^[a-f0-9]{64}$/.test(text(r.sha256, 64))) throw new Error('invalid observation source identity');
  return { ...r, file, bounds5070: bounds(r.bounds5070, 1e8), source: text(r.source, 1000), sha256: r.sha256 as string,
    fetchedAt: text(r.fetchedAt, 80), credit: text(r.credit, 500), license: text(r.license, 200) } as Descriptor;
}
interface Work { tick(n?: number): void; vertices(n: number): void }
function work(deadline: number): Work {
  let ops = 0, vertices = 0;
  return { tick(n = 1) { ops += n; if (ops > MAX_OPS || Date.now() > deadline) throw new Error('observation geometry budget passed'); },
    vertices(n) { vertices += n; if (vertices > MAX_VERTICES) throw new Error('observation vertex budget passed'); } };
}
const cross = (a: XY, b: XY) => a[0] * b[1] - a[1] * b[0];
const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const at = (a: XY, b: XY, t: number): XY => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
function onSegment(p: XY, a: XY, b: XY): boolean {
  const d = sub(b, a), q = sub(p, a), len = Math.hypot(...d);
  if (len <= EPS) return Math.hypot(...q) <= EPS;
  return Math.abs(cross(d, q)) <= EPS * Math.max(1, len) && q[0] * d[0] + q[1] * d[1] >= -EPS && q[0] * d[0] + q[1] * d[1] <= len * len + EPS;
}
function inRing(p: XY, ring: XY[], w: Work): boolean | null {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    w.tick(); const a = ring[i - 1], b = ring[i];
    if (onSegment(p, a, b)) return null;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function inPolygon(p: XY, rings: XY[][], w: Work): boolean {
  if (inRing(p, rings[0], w) !== true) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(p, rings[i], w) !== false) return false;
  return true;
}
function cuts(a: XY, b: XY, c: XY, d: XY): number[] {
  const r = sub(b, a), s = sub(d, c), q = sub(c, a), den = cross(r, s);
  if (Math.abs(den) > 1e-12) {
    const t = cross(q, s) / den, u = cross(q, r) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t] : [];
  }
  if (Math.abs(cross(q, r)) > EPS * Math.max(1, Math.hypot(...r))) return [];
  const dd = r[0] ** 2 + r[1] ** 2;
  if (!dd) return [];
  return [c, d].map(p => ((p[0] - a[0]) * r[0] + (p[1] - a[1]) * r[1]) / dd).filter(t => t >= 0 && t <= 1);
}
function segmentInside(a: XY, b: XY, polygons: XY[][][], w: Work): Interval[] {
  const ts = [0, 1];
  for (const poly of polygons) for (const ring of poly) for (let i = 1; i < ring.length; i++) { w.tick(); ts.push(...cuts(a, b, ring[i - 1], ring[i])); }
  ts.sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] <= 1e-12) continue;
    const mid = at(a, b, (ts[i] + ts[i - 1]) / 2);
    if (polygons.some(p => inPolygon(mid, p, w))) out.push([ts[i - 1], ts[i]]);
  }
  return out;
}
function union(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const p of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && p[0] <= last[1] + EPS) last[1] = Math.max(last[1], p[1]); else out.push([...p]);
  }
  return out;
}
const lengthOf = (ivs: Interval[]) => union(ivs).reduce((s, [a, b]) => s + b - a, 0);
const rectangle = ([x0, y0, x1, y1]: Bounds): XY[][][] => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
function routeIntervals(route: XY[], polygons: XY[][][], w: Work): Interval[] {
  let along = 0; const out: Interval[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const p of ring) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    w.tick();
    if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < y0 || Math.min(a[1], b[1]) > y1) { along += len; continue; }
    if (len > EPS) for (const [t0, t1] of segmentInside(a, b, polygons, w)) out.push([along + t0 * len, along + t1 * len]);
    along += len;
  }
  return union(out);
}
function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi - lo > EPS) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}
function routeLength(route: XY[]): number { return route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - route[i][0], p[1] - route[i][1]), 0); }
interface BuildingTally { add(f: BuildingFeature): void; done(): BuildingObservation }
/** Roof intervals accumulate feature by feature; a feature's geometry is not kept. */
function buildingTally(route: XY[], d: Descriptor, deadline: number): BuildingTally | UnavailableObservation {
  const totalM = routeLength(route), covered = routeIntervals(route, (d.coverage ?? [d.bounds5070]).flatMap(rectangle), work(deadline)), observedM = lengthOf(covered);
  if (totalM <= EPS || observedM <= EPS) return unavailable('outside the building query area or zero-length route');
  const sets = Object.fromEntries(classes.map(c => [c, new Set<string>()])) as Record<StructureClass, Set<string>>;
  const intervals: Record<StructureClass, Interval[]> = { all: [], residential: [], nonresidential: [], unknown: [] };
  return {
    add(f) {
      const w = work(deadline); w.tick();
      const ivs = intersectIntervals(routeIntervals(route, f.polygons, w), covered);
      if (lengthOf(ivs) <= EPS) return;
      const cls = f.class === 'Residential' ? 'residential' : NONRES.has(f.class ?? '') ? 'nonresidential' : 'unknown';
      sets.all.add(f.id); sets[cls].add(f.id);
      for (const c of ['all', cls] as StructureClass[]) { intervals[c].push(...ivs); if (intervals[c].length > 20_000) intervals[c] = union(intervals[c]); }
    },
    done() {
      const counts = blank(), metres = blank();
      for (const c of classes) { counts[c] = sets[c].size; metres[c] = lengthOf(intervals[c]); }
      return { status: 'ok', totalM, observedM, counts, metres, imageryYears: d.imageryYears ?? [], provenance: provenance(d) };
    },
  };
}
/** Exact interior roof lengths, unioned along the route rather than across ground traversed twice. */
export function buildingObservation(route: XY[], features: BuildingFeature[], d: Descriptor, deadline = Infinity): BuildingObservation | UnavailableObservation {
  try {
    const t = buildingTally(route, d, deadline);
    if ('status' in t) return t;
    for (const f of features) t.add(f);
    return t.done();
  } catch (e) { return unavailable(e); }
}
function projectedFeature(row: Record<string, unknown>, w: Work): BuildingFeature {
  const id = text(row.id, 100), cls = row.class === null ? null : text(row.class, 100), g = record(row.geometry);
  if (!id || !Array.isArray(g.coordinates)) throw new Error('invalid footprint geometry');
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polys || !polys.length || polys.length > 1000) throw new Error('invalid footprint polygon');
  const polygons = polys.map(p => {
    if (!Array.isArray(p) || !p.length || p.length > 1000) throw new Error('invalid footprint rings');
    return p.map((r: unknown) => {
      if (!Array.isArray(r) || r.length < 4 || r.length > 20_000) throw new Error('invalid footprint ring');
      w.vertices(r.length);
      const ring = r.map((v: unknown): XY => {
        if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || Math.abs(v[0]) > 180 || Math.abs(v[1]) > 90) throw new Error('invalid geographic footprint coordinate');
        return albersForward(v[0], v[1]);
      });
      if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) > EPS) throw new Error('unclosed footprint ring');
      let twiceArea = 0;
      for (let i = 1; i < ring.length; i++) twiceArea += cross(sub(ring[i - 1], ring[0]), sub(ring[i], ring[0]));
      if (Math.abs(twiceArea) <= EPS) throw new Error('empty footprint ring');
      return ring;
    });
  });
  return { id, class: cls, polygons };
}
function pointSegment(p: XY, a: XY, b: XY): number {
  const d = sub(b, a), dd = d[0] ** 2 + d[1] ** 2;
  const t = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / dd)) : 0;
  return Math.hypot(...sub(p, at(a, b, t)));
}
function pointRoute(p: XY, route: XY[]): number { return Math.min(...route.slice(1).map((b, i) => pointSegment(p, route[i], b))); }
function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  if (cuts(a, b, c, d).length || onSegment(a, c, d) || onSegment(b, c, d)) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
/** Distances to the known inventory only; no height, notice or clearance decision. */
export function aviationObservation(route: XY[], data: AviationData, d: Descriptor, deadline = Infinity): AviationObservation | UnavailableObservation {
  try {
    const w = work(deadline);
    if (routeLength(route) <= EPS || lengthOf(routeIntervals(route, rectangle(d.bounds5070), w)) <= EPS) return unavailable('outside the aviation inventory area or zero-length route');
    const sites = new Map(data.facilities.map(f => [f.id, f])), withRunways = new Set(data.runways.map(r => r.airport));
    const facilities = data.facilities.map(f => ({ id: f.id, name: f.name, type: f.type, use: f.use, operationalStatus: f.status,
      distanceM: pointRoute(f.point, route), runwayCoverage: withRunways.has(f.id) ? 'sampled' as const : 'not-queried' as const })).sort((a, b) => a.distanceM - b.distanceM);
    const runways = data.runways.map(r => {
      const facility = sites.get(r.airport)!;
      w.tick(route.length);
      return { airport: r.airport, runway: r.runway, centrelineM: Math.min(...route.slice(1).map((b, i) => segmentDistance(route[i], b, ...r.ends))),
        endM: Math.min(...r.ends.map(p => pointRoute(p, route))), airportPointM: pointRoute(facility.point, route), elevationsFt: r.elevationsFt, surveyDates: r.surveyDates };
    }).sort((a, b) => a.centrelineM - b.centrelineM);
    return { status: 'ok', cycle: d.cycle!, scope: d.scope!, provenance: provenance(d), facilities, runways };
  } catch (e) { return unavailable(e); }
}
interface AviationIndex { facilities: Facility[]; runways: Runway[]; byAirport: Map<string, Runway[]> }
function aviationIndex(value: unknown): AviationIndex {
  const raw = record(value);
  if (raw.version !== 2 || !Array.isArray(raw.facilities) || !Array.isArray(raw.runways) || !raw.facilities.length || !raw.runways.length || raw.facilities.length > 50_000 || raw.runways.length > 50_000) throw new Error('invalid aviation inventory');
  const facilities = raw.facilities.map(v => { const f = record(v); return { id: text(f.id, 80), name: text(f.name), type: text(f.type, 80), use: text(f.use, 80), status: text(f.status, 80), point: xy(f.point, 1e8) }; });
  const sites = new Set(facilities.map(f => f.id));
  if (sites.size !== facilities.length) throw new Error('duplicate aviation facility');
  const runways = raw.runways.map(v => {
    const r = record(v), airport = text(r.airport, 80), runway = text(r.runway, 80);
    if (!sites.has(airport) || !Array.isArray(r.ends) || r.ends.length !== 2 || !Array.isArray(r.elevationsFt) || r.elevationsFt.length !== 2 || !r.elevationsFt.every(v => v === null || (typeof v === 'number' && Number.isFinite(v))) || !Array.isArray(r.surveyDates) || r.surveyDates.length !== 2) throw new Error('invalid runway join');
    const ends: [XY, XY] = [xy(r.ends[0], 1e8), xy(r.ends[1], 1e8)];
    if (Math.hypot(...sub(ends[0], ends[1])) <= EPS) throw new Error('empty runway');
    return { airport, runway, ends, elevationsFt: r.elevationsFt as [number | null, number | null], surveyDates: r.surveyDates.map(v => v === null ? null : text(v, 80)) as [string | null, string | null] };
  });
  if (new Set(runways.map(r => `${r.airport}/${r.runway}`)).size !== runways.length) throw new Error('duplicate runway');
  const byAirport = new Map<string, Runway[]>();
  for (const r of runways) { const l = byAirport.get(r.airport); if (l) l.push(r); else byAirport.set(r.airport, [r]); }
  return { facilities, runways, byAirport };
}
/** The facilities (with all their runways) whose point or a runway end lies within the polyline's box + the buffer. */
function aviationNear(ix: AviationIndex, route: XY[]): AviationData {
  const [bx0, by0, bx1, by1] = polyBox(route);
  const x0 = bx0 - AVIATION_BUFFER_M, x1 = bx1 + AVIATION_BUFFER_M, y0 = by0 - AVIATION_BUFFER_M, y1 = by1 + AVIATION_BUFFER_M;
  const inside = (p: XY) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const facilities = ix.facilities.filter(f => inside(f.point) || (ix.byAirport.get(f.id) ?? []).some(r => r.ends.some(inside)));
  const runways = facilities.flatMap(f => ix.byAirport.get(f.id) ?? []);
  if (facilities.length > AVIATION_LIMIT || runways.length > AVIATION_LIMIT) throw new Error(`more than ${AVIATION_LIMIT} aviation facilities within ${AVIATION_BUFFER_M / 1000} km of the route`);
  return { version: 2, facilities, runways };
}
const polyBox = (p: XY[]): Bounds => [Math.min(...p.map(a => a[0])), Math.min(...p.map(a => a[1])), Math.max(...p.map(a => a[0])), Math.max(...p.map(a => a[1]))];
async function json(io: IO, url: string, cap: number, deadline: number): Promise<unknown> {
  if (Date.now() > deadline || !io.byteLength) throw new Error('observation read unavailable');
  const size = await io.byteLength(url);
  if (!Number.isSafeInteger(size) || size <= 0 || size > cap) throw new Error('observation JSON byte budget passed');
  const bytes = await io.fetchRange(url, 0, size);
  if (bytes.length !== size || Date.now() > deadline) throw new Error('short or expired observation read');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
/** Stop waiting for an optional source even when its I/O never settles. */
async function byDeadline<T>(task: () => Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('observation read deadline passed')), Math.max(0, Math.min(30_000, deadline - Date.now())));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const aviationCache = new Map<string, Promise<AviationIndex>>();
/** One fetch of the national inventory per worker session and generation; a failed fetch is not kept. */
function aviationFor(io: IO, url: string, key: string, cycle: string, deadline: number): Promise<AviationIndex> {
  let p = aviationCache.get(key);
  if (!p) {
    aviationCache.clear();
    p = json(io, url, AVIATION_JSON_CAP, deadline).then(v => {
      const parsed = record(v);
      if (parsed.cycle !== undefined && parsed.cycle !== cycle) throw new Error('aviation cycle differs from manifest');
      return aviationIndex(parsed);
    });
    aviationCache.set(key, p);
    p.catch(() => { if (aviationCache.get(key) === p) aviationCache.delete(key); });
  }
  return p;
}
interface StateFile { name: string; bounds5070: Bounds; imageryYears: number[]; sha256: string }
function stateFiles(v: unknown): StateFile[] {
  const files = record(v).files;
  if (!Array.isArray(files) || !files.length || files.length > 100) throw new Error('invalid building file list');
  return files.map(x => {
    const r = record(x), years = r.imageryYears ?? [];
    if (!/^[A-Za-z0-9_-]{1,40}\.parquet$/.test(text(r.name, 60)) || !/^[a-f0-9]{64}$/.test(text(r.sha256, 64))) throw new Error('invalid building file identity');
    if (!Array.isArray(years) || years.length > 100 || !years.every(y => Number.isInteger(y) && y >= 1900 && y <= 2100)) throw new Error('invalid imagery years');
    return { name: r.name as string, bounds5070: bounds(r.bounds5070), imageryYears: years as number[], sha256: r.sha256 as string };
  });
}
async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const overlaps = (a: Bounds, b: Bounds, pad: number) => !(b[2] + pad < a[0] || b[0] - pad > a[2] || b[3] + pad < a[1] || b[1] - pad > a[3]);
/** Independent optional families; unavailable input never becomes a successful clear/zero report. */
export async function readRouteScreening(polylines: XY[][], io: IO, deadline: number): Promise<RouteScreening[]> {
  const empty = (e: unknown) => polylines.map(() => ({ buildings: unavailable(e), aviation: unavailable(e) }));
  let raw: Record<string, unknown>;
  try {
    raw = record(await byDeadline(() => json(io, `${io.reportUrl}screening/manifest.json`, 128 * 1024, deadline), deadline));
    if (raw.version === 1) throw new Error('regional structure data is retired; the national generation (manifest version 2) is required');
    if (raw.version !== 2 || raw.id_kind !== 'piece' || raw.complete !== true || !/^[a-f0-9]{16,64}$/.test(text(raw.generation, 64))) throw new Error('invalid observation generation');
  } catch (e) { return empty(e); }
  const base = `${io.reportUrl}screening/${raw.generation}/`;
  const buildingTask = async (): Promise<(BuildingObservation | UnavailableObservation)[]> => {
    try {
      const b = record(raw.buildings), files = stateFiles(b);
      const meta = { source: text(b.source, 1000), credit: text(b.credit, 500), license: text(b.license, 200), fetchedAt: typeof b.fetchedAt === 'string' ? text(b.fetchedAt, 80) : 'unknown' };
      const picks = polylines.map(p => { const box = polyBox(p); return files.filter(f => overlaps(f.bounds5070, box, 100)); });
      const tallies = await Promise.all(picks.map(async (pick, i): Promise<BuildingTally | UnavailableObservation> => {
        if (!pick.length) return unavailable('outside the national building data');
        const years = [...new Set(pick.flatMap(f => f.imageryYears))].sort((x, y) => x - y);
        const bb = pick.map(f => f.bounds5070);
        const d: Descriptor = { ...meta, file: 'buildings', sha256: await sha256Hex(pick.map(f => `${f.name}:${f.sha256}`).join('\n')), imageryYears: years, coverage: bb,
          bounds5070: [Math.min(...bb.map(x => x[0])), Math.min(...bb.map(x => x[1])), Math.max(...bb.map(x => x[2])), Math.max(...bb.map(x => x[3]))] };
        return buildingTally(polylines[i], d, deadline);
      }));
      const live = tallies.filter((t): t is BuildingTally => !('status' in t));
      const near = buildCorridor(polylines, 100), budget: SpatialBudget = { failed: null, bytes: 0, groups: 0, rowsDecoded: 0, maxBytes: BUDGET_BYTES, maxUncompressed: BUDGET_UNCOMPRESSED };
      const ids = new Set<string>();
      const sink = (rows: { row: Record<string, unknown> }[]) => {
        for (const { row } of rows) {
          const f = projectedFeature(row, work(deadline));
          if (ids.has(f.id)) throw new Error('duplicate structure identity');
          ids.add(f.id);
          for (const t of live) t.add(f);
        }
      };
      if (live.length) for (const f of files.filter(f => picks.some(p => p.includes(f)))) await readSpatialRows(io, `${base}${f.name}`, ['id', 'class'], near, budget, deadline, sink);
      return tallies.map(t => 'status' in t ? t : t.done());
    } catch (e) {
      const over = e instanceof Error && (e.message === BYTE_BUDGET_MSG || e.message === DECODE_BUDGET_MSG);
      return polylines.map(() => over ? { status: 'unavailable' as const, ...OVER_BUDGET } : unavailable(e));
    }
  };
  const aviationTask = async (): Promise<(AviationObservation | UnavailableObservation)[]> => {
    try {
      const d = descriptor(raw.aviation, 'aviation.json'); d.cycle = text(d.cycle, 80); d.scope = text(d.scope, 1000);
      const ix = await aviationFor(io, `${base}aviation.json`, `${raw.generation}:${d.sha256}`, d.cycle, deadline);
      return polylines.map(p => { try { return aviationObservation(p, aviationNear(ix, p), d, deadline); } catch (e) { return unavailable(e); } });
    } catch (e) { return polylines.map(() => unavailable(e)); }
  };
  const [buildings, aviation] = await Promise.all([
    byDeadline(buildingTask, deadline).catch(e => polylines.map(() => unavailable(e))),
    byDeadline(aviationTask, deadline).catch(e => polylines.map(() => unavailable(e))),
  ]);
  return polylines.map((_, i) => ({ buildings: buildings[i], aviation: aviation[i] }));
}
