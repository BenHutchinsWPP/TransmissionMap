// ─── Route report reader ──────────────────────────────────────────────────────
// Role: the road / river / rail / pipeline / line features near routed polylines, read by range
//       from the data/route/report/ GeoParquet files (scripts/build_route_report_data.py; lng/lat,
//       `bbox` covering, ZSTD), as crossings-exact.ts ExactFeatures in EPSG:5070 metres.
//       Corridor: each polyline densified to ≤ DENSIFY_M in EPSG:5070, then per-segment lng/lat
//       boxes padded by a margin in 0.1° cells (route_crossings.py Corridor); boxes per polyline.
//       Margin: CORRIDOR_M for road/river/rail/pipeline files, LINE_CORRIDOR_M (≥ FOLLOW_M, so the
//       follow rule sees every line it could follow) for the line files.
//       Per file: byteLength, PAR1 at head and tail, the footer; then (1) row groups whose `bbox.*`
//       statistics meet the corridor (missing stats → read), only their `bbox` column; (2) rows
//       whose bbox hits → runs (gap < RUN_GAP, within a group) → attributes + geometry through the
//       offset index. Rows filtered and labelled as the grid does (no EIA files):
//         road     group name || ref || road#file#row; detail highway
//         river    group name || ref || river#file#row
//         rail     NET A (abandoned) / R (removed) / F (ferry) dropped, X (out of service) kept and labelled; group RROWNER1 || '?';
//                  detail "tracks N" (N > 0) and "out of service", joined by " · "
//         pipeline substance water/sewage/wastewater dropped; group name || operator || pipe#file#row
//         line     OSM: line_type bay/internal/substation/bus* dropped, kv = nominal_kv (≤ 0 or > 800
//                  unknown); HIFLD: STATUS INACTIVE / UNDER CONSTRUCTION dropped, kv = VOLTAGE > 0
//                  else VOLT_CLASS, DC halves VOLTAGE; kv < 100 or unknown dropped. id fid ?? osm_id / ID.
//       Text cleaned ('' / None / nan → missing, control chars stripped, ≤ 80 chars).
//       Files run ≤ 4 at a time; a family is all-or-nothing: any failure in one of its files (throw,
//       not Parquet, deadline, > MAX_FAMILY_BYTES fetched) gives it `ok: false` and no features.
//       Never throws. FamilyStatus.ms = time from the call's start until the family's last file
//       finished (includes queue wait behind the limiter).
// Deps: hyparquet + fzstd, crossings-exact.ts (types, FOLLOW_M), grid.ts (Albers), cog-read.ts (createLimiter),
//       route.ts (RouteIO type).

import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type Compressors, type FileMetaData } from 'hyparquet';
import { decompress } from 'fzstd';
import { FOLLOW_M, type ExactFeature, type Family } from './crossings-exact.js';
import { albersForward, albersInverse } from './grid.js';
import { createLimiter } from './cog-read.js';
import type { RouteIO } from './route.js';

export type FamilyStatus = { ok: boolean; bytes: number; groups: number; rowsDecoded: number; rowsKept: number; ms: number; note?: string };
export interface ReportRead { features: ExactFeature[]; status: Record<Family, FamilyStatus> }
type Src = ExactFeature['src'];
type Row = Record<string, unknown>;

export const CORRIDOR_M = 100, LINE_CORRIDOR_M = Math.max(CORRIDOR_M, FOLLOW_M), MAX_FAMILY_BYTES = 48 * 2 ** 20;
const DENSIFY_M = 2000, CELL = 0.1, RUN_GAP = 64, TEXT_MAX = 80;
const COMPRESSORS: Compressors = { ZSTD: (input: Uint8Array) => decompress(input) };

const FILES: { file: string; family: Family; src: Src; cols: string[] }[] = [
  { file: 'roads_motorway_trunk', family: 'road', src: 'osm', cols: ['name', 'ref', 'highway'] },
  { file: 'roads_primary', family: 'road', src: 'osm', cols: ['name', 'ref', 'highway'] },
  { file: 'rivers', family: 'river', src: 'osm', cols: ['name', 'ref'] },
  { file: 'railroads', family: 'rail', src: 'narn', cols: ['RROWNER1', 'TRACKS', 'NET'] },
  { file: 'pipelines_osm', family: 'pipeline', src: 'osm', cols: ['name', 'operator', 'substance'] },
  { file: 'pipelines_hifld_natgas', family: 'pipeline', src: 'hifld', cols: ['name', 'operator', 'pipe_type'] },
  { file: 'transmission_osm_us', family: 'line', src: 'osm', cols: ['fid', 'osm_id', 'name', 'ref', 'operator', 'nominal_kv', 'line_type'] },
  { file: 'transmission_hifld', family: 'line', src: 'hifld', cols: ['ID', 'OWNER', 'VOLTAGE', 'VOLT_CLASS', 'STATUS'] },
];
const FAMILIES: Family[] = ['road', 'river', 'rail', 'pipeline', 'line'];

// ─── Corridor ────────────────────────────────────────────────────────────────
export interface Corridor { hits(x0: number, y0: number, x1: number, y1: number): boolean }

/** Does a lng/lat box come within `margin` metres of any polyline (EPSG:5070 metres)? */
export function buildCorridor(polylines5070: [number, number][][], margin = CORRIDOR_M): Corridor {
  const lls = polylines5070.map((poly) => {
    const out: [number, number][] = [];
    poly.forEach(([x, y], i) => {
      if (i) {
        const [px, py] = poly[i - 1], n = Math.ceil(Math.hypot(x - px, y - py) / DENSIFY_M);
        for (let k = 1; k < n; k++) out.push(albersInverse(px + (x - px) * k / n, py + (y - py) * k / n));
      }
      out.push(albersInverse(x, y));
    });
    return out;
  });
  let lat = 0;
  for (const ll of lls) for (const p of ll) lat = Math.max(lat, Math.abs(p[1]));
  const dy = margin / 111000, dx = margin / (111000 * Math.cos(Math.min(lat + 1, 89) * Math.PI / 180));
  const boxes: number[][] = [], cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 8192 + cy;
  for (const ll of lls) {
    for (let i = 1; i < ll.length; i++) {
      const [p, q] = [ll[i - 1], ll[i]];
      const b = [Math.min(p[0], q[0]) - dx, Math.min(p[1], q[1]) - dy, Math.max(p[0], q[0]) + dx, Math.max(p[1], q[1]) + dy];
      const id = boxes.push(b) - 1;
      for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[2] / CELL); cx++) {
        for (let cy = Math.floor(b[1] / CELL); cy <= Math.floor(b[3] / CELL); cy++) {
          const list = cells.get(key(cx, cy));
          if (list) list.push(id); else cells.set(key(cx, cy), [id]);
        }
      }
    }
  }
  const r = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes) { r[0] = Math.min(r[0], b[0]); r[1] = Math.min(r[1], b[1]); r[2] = Math.max(r[2], b[2]); r[3] = Math.max(r[3], b[3]); }
  const meets = (b: number[], x0: number, y0: number, x1: number, y1: number) => !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]);
  return {
    hits(x0, y0, x1, y1) {
      if (!meets(r, x0, y0, x1, y1)) return false;
      const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) return boxes.some((b) => meets(b, x0, y0, x1, y1));
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (const id of cells.get(key(cx, cy)) ?? []) if (meets(boxes[id], x0, y0, x1, y1)) return true;
        }
      }
      return false;
    },
  };
}

// ─── Rows → features ─────────────────────────────────────────────────────────
const clean = (v: unknown): string | undefined => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return undefined;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return s === '' || s === 'None' || s === 'nan' ? undefined : s.slice(0, TEXT_MAX);
};
const VOLT_CLASS: Record<string, number> = { '100-161': 100, '220-287': 220, '345': 345, '500': 500, '735 AND ABOVE': 735 };
const DROP_SUBSTANCE = new Set(['water', 'sewage', 'wastewater']);
const DROP_RAIL_NET = new Set(['A', 'R', 'F']);
const DROP_LINE_TYPE = new Set(['bay', 'internal', 'substation']);

/** One row's display/merge fields, or null when the grid's rules drop it. */
function describe(spec: typeof FILES[number], r: Row, row: number): Omit<ExactFeature, 'family' | 'src' | 'lines'> | null {
  const rid = `${spec.file}#${row}`;
  const name = clean(r.name), ref = clean(r.ref), operator = clean(r.operator);
  switch (spec.family) {
    case 'road': return { id: rid, group: name ?? ref ?? `road#${rid}`,
      name: name && ref ? `${name} (${ref})`.slice(0, TEXT_MAX) : name ?? ref, detail: clean(r.highway) };
    case 'river': return { id: rid, group: name ?? ref ?? `river#${rid}`, name: name ?? ref, detail: 'river' };
    case 'rail': {
      if (DROP_RAIL_NET.has(clean(r.NET) ?? '')) return null;
      const o = clean(r.RROWNER1), owner = o === 'XXXX' ? undefined : o, tracks = clean(r.TRACKS);   // XXXX: NARN's unknown owner
      const detail = [tracks && tracks !== '0' ? `tracks ${tracks}` : undefined, clean(r.NET) === 'X' ? 'out of service' : undefined].filter(Boolean).join(' · ');
      return { id: rid, group: owner ?? '?', name: owner, detail: detail || undefined };
    }
    case 'pipeline': {
      const substance = clean(r.substance);
      if (substance && DROP_SUBSTANCE.has(substance.toLowerCase())) return null;
      return { id: rid, group: name ?? operator ?? `pipe#${rid}`, name: name ?? operator,
        detail: spec.src === 'osm' ? substance : clean(r.pipe_type) };
    }
    case 'line': {
      if (spec.src === 'osm') {
        const lt = (clean(r.line_type) ?? '').toLowerCase();
        if (DROP_LINE_TYPE.has(lt) || lt.startsWith('bus')) return null;
        const kv = Number(r.nominal_kv);
        if (!Number.isFinite(kv) || kv <= 0 || kv > 800 || kv < 100) return null;
        const id = clean(r.fid) ?? clean(r.osm_id);
        if (!id) return null;
        return { id, kv, name: name ?? ref ?? operator, detail: `${kv} kV${operator ? ' · ' + operator : ''}` };
      }
      const status = (clean(r.STATUS) ?? '').toUpperCase();
      if (status === 'INACTIVE' || status === 'UNDER CONSTRUCTION') return null;
      const cls = (clean(r.VOLT_CLASS) ?? '').toUpperCase(), v = Number(clean(r.VOLTAGE));
      const kv = Number.isFinite(v) && v > 0 ? (cls === 'DC' ? v / 2 : v) : VOLT_CLASS[cls];
      if (!(kv >= 100)) return null;
      const owner = clean(r.OWNER), id = clean(r.ID);
      if (!id) return null;
      return { id, kv, name: owner, detail: `${kv} kV${owner ? ' · ' + owner : ''}` };
    }
  }
}

/** GeoJSON LineString / MultiLineString → EPSG:5070 parts; null for any other type. */
function project(g: unknown): [number, number][][] | null {
  const geom = g as { type?: string; coordinates?: unknown } | null;
  const part = (c: unknown) => (c as [number, number][]).map(([lng, lat]) => albersForward(lng, lat));
  if (geom?.type === 'LineString' && Array.isArray(geom.coordinates)) return [part(geom.coordinates)];
  if (geom?.type === 'MultiLineString' && Array.isArray(geom.coordinates)) return geom.coordinates.map(part);
  return null;
}

// ─── Files ───────────────────────────────────────────────────────────────────
/** One budget per family: `bytes` counts every footer and range of its files (48 MiB), `uncompressed` the row groups read (256 MiB). */
export interface SpatialBudget { failed: string | null; bytes: number; groups: number; rowsDecoded: number; uncompressed?: number }
const BYTE_BUDGET_MSG = 'byte budget passed', MAX_ROWS = 100_000, CHUNK_ROWS = 16_384, MAX_UNCOMPRESSED = 256 * 2 ** 20;
interface Tally extends SpatialBudget { rowsKept: number; skipped: number; ms: number; features: ExactFeature[] }

/** Throw unless the family is still alive and in time. */
function check(t: SpatialBudget, deadline: number): void {
  if (t.failed) throw new Error(t.failed);
  if (Date.now() > deadline) throw new Error('out of time');
  if (t.bytes > MAX_FAMILY_BYTES) throw new Error(BYTE_BUDGET_MSG);
}

const statOf = (md: FileMetaData, g: number, path: string, which: 'min_value' | 'max_value') => {
  const v = md.row_groups[g].columns.find((c) => c.meta_data?.path_in_schema.join('.') === path)?.meta_data?.statistics?.[which];
  return typeof v === 'number' ? v : null;
};

export interface SpatialRow { row: Record<string, unknown>; index: number }
/** Bounded raw GeoParquet rows near a corridor. The caller validates attributes and geometry. */
export async function readSpatialRows(io: Pick<RouteIO, 'fetchRange' | 'byteLength'>, url: string, columns: string[],
  corridor: Corridor, t: SpatialBudget, deadline: number): Promise<SpatialRow[]> {
  check(t, deadline);
  if (!io.byteLength) throw new Error('no byteLength');
  const size = await io.byteLength(url);
  if (!Number.isFinite(size) || size <= 12) throw new Error('not a Parquet file');
  const cache: { start: number; end: number; data: Promise<Uint8Array> }[] = [];
  const range = (start: number, end: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) throw new Error('invalid or oversized Parquet range');
    if (end - start > MAX_FAMILY_BYTES || t.bytes + end - start > MAX_FAMILY_BYTES) throw new Error(BYTE_BUDGET_MSG);
    const c = cache.find((r) => r.start <= start && end <= r.end);
    if (c) return c.data.then((b) => b.subarray(start - c.start, end - c.start));
    check(t, deadline);
    const data = io.fetchRange(url, start, end).then((b) => {
      if (b.byteLength !== end - start) throw new Error('short read');
      t.bytes += b.byteLength;
      check(t, deadline);
      return b;
    });
    cache.push({ start, end, data });
    return data;
  };
  const buf: AsyncBuffer = {
    byteLength: size,
    slice: (start, end = size) => range(start, end).then((u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer),
  };
  const [head, tail] = await Promise.all([range(0, 4), range(size - 8, size)]);
  const magic = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 4)) === 'PAR1';
  if (!magic(head) || !magic(tail.subarray(4))) throw new Error('not a Parquet file');
  const footer = new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0, true);
  if (footer + 12 > size || footer > 2 * 2 ** 20) throw new Error('invalid or oversized Parquet footer');
  const md = await parquetMetadataAsync(buf, { initialFetchSize: footer + 8 });
  const read = (rowStart: number, rowEnd: number, columns: string[], useOffsetIndex: boolean) => parquetReadObjects({
    file: buf, metadata: md, rowStart, rowEnd, columns, compressors: COMPRESSORS, useOffsetIndex, rowFormat: 'object' }) as Promise<Row[]>;

  // Phase 1: groups by bbox statistics, then rows by their bbox.
  const groups: [number, number][] = [];
  let at = 0;
  md.row_groups.forEach((rg, g) => {
    const n = Number(rg.num_rows), start = at;
    at += n;
    const s = [statOf(md, g, 'bbox.xmin', 'min_value'), statOf(md, g, 'bbox.ymin', 'min_value'),
      statOf(md, g, 'bbox.xmax', 'max_value'), statOf(md, g, 'bbox.ymax', 'max_value')];
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid Parquet row count');
    if (n > 0 && (s.some((v) => v === null) || corridor.hits(s[0]!, s[1]!, s[2]!, s[3]!))) {
      const bytes = Number(rg.total_byte_size);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 2 ** 20 || n > 100_000) throw new Error('Parquet row group exceeds decode budget');
      t.uncompressed = (t.uncompressed ?? 0) + bytes;
      if (t.uncompressed > MAX_UNCOMPRESSED) throw new Error('Parquet decode budget passed');
      groups.push([start, start + n]);
    }
  });
  t.groups += groups.length;
  const runs: [number, number][] = [], kept = new Set<number>();
  for (const [g0, g1] of groups) {
    check(t, deadline);
    if (g1 - g0 > MAX_ROWS) throw new Error('Parquet row budget passed');
    const rows = await read(g0, g1, ['bbox'], false);
    let last: [number, number] | undefined;
    rows.forEach((r, i) => {
      const b = r.bbox as { xmin?: unknown; ymin?: unknown; xmax?: unknown; ymax?: unknown } | null;
      const box = b && [b.xmin, b.ymin, b.xmax, b.ymax].map(Number);
      if (box && box.every(Number.isFinite) && !corridor.hits(box[0], box[1], box[2], box[3])) return;
      const row = g0 + i;
      kept.add(row);
      if (last && row - last[1] < RUN_GAP) last[1] = row + 1; else runs.push(last = [row, row + 1]);
    });
  }

  // Phase 2: attributes + geometry for the kept rows' runs.
  const out: SpatialRow[] = [];
  for (const [a, b] of runs) {
    check(t, deadline);
    for (let c0 = a; c0 < b; c0 += CHUNK_ROWS) {
      const c1 = Math.min(b, c0 + CHUNK_ROWS);
      check(t, deadline);
      if (t.rowsDecoded + c1 - c0 > MAX_ROWS) throw new Error('Parquet row budget passed');
      const rows = await read(c0, c1, [...columns, 'geometry'], true);
      t.rowsDecoded += rows.length;
      rows.forEach((r, i) => { if (kept.has(c0 + i)) out.push({ row: r, index: c0 + i }); });
    }
  }
  return out;
}

async function readFile(io: Pick<RouteIO, 'fetchRange' | 'byteLength'> & { reportUrl: string }, spec: typeof FILES[number],
  corridor: Corridor, t: Tally, deadline: number): Promise<ExactFeature[]> {
  const rows = await readSpatialRows(io, `${io.reportUrl}${spec.file}.parquet`, spec.cols, corridor, t, deadline);
  const out: ExactFeature[] = [];
  for (const { row, index } of rows) {
    const d = describe(spec, row, index);
    if (!d) continue;
    const lines = project(row.geometry);
    if (!lines) { t.skipped++; continue; }
    const f: ExactFeature = { family: spec.family, src: spec.src, id: d.id, lines };
    if (d.group !== undefined) f.group = d.group;
    if (d.name !== undefined) f.name = d.name;
    if (d.detail !== undefined) f.detail = d.detail;
    if (d.kv !== undefined) f.kv = d.kv;
    out.push(f);
  }
  return out;
}

/** The features near the polylines, per family all-or-nothing. Never throws. */
export async function readReport(io: Pick<RouteIO, 'fetchRange' | 'byteLength'> & { reportUrl: string },
  polylines5070: [number, number][][], deadline: number): Promise<ReportRead> {
  const t0 = Date.now();
  const tallies = Object.fromEntries(FAMILIES.map((f): [Family, Tally] => [f, { failed: null, bytes: 0, groups: 0, rowsDecoded: 0, rowsKept: 0, skipped: 0, ms: 0, features: [] }])) as Record<Family, Tally>;
  let near: Corridor, nearLines: Corridor;
  try { near = buildCorridor(polylines5070, CORRIDOR_M); nearLines = buildCorridor(polylines5070, LINE_CORRIDOR_M); }
  catch { near = nearLines = { hits: () => false }; for (const f of FAMILIES) tallies[f].failed = 'corridor failed'; }
  const limit = createLimiter(4);
  await Promise.all(FILES.map((spec) => limit(async () => {
    const t = tallies[spec.family];
    try {
      const got = await readFile(io, spec, spec.family === 'line' ? nearLines : near, t, deadline);
      t.features.push(...got);
    } catch (e) {
      t.failed ??= `${spec.file}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    } finally {
      t.ms = Date.now() - t0;
    }
  })));
  const features: ExactFeature[] = [];
  const status = {} as Record<Family, FamilyStatus>;
  for (const f of FAMILIES) {
    const t = tallies[f], ok = !t.failed;
    if (ok) features.push(...t.features);
    const s: FamilyStatus = { ok, bytes: t.bytes, groups: t.groups, rowsDecoded: t.rowsDecoded, rowsKept: ok ? t.features.length : 0, ms: t.ms };
    const note = [t.failed, t.skipped ? `${t.skipped} geometries not lines, skipped` : null].filter(Boolean).join('; ');
    if (note) s.note = note;
    status[f] = s;
  }
  return { features, status };
}
