// ─── Route orchestrator ───────────────────────────────────────────────────────
// Role: one least-cost route A → B over the routing cube, end to end:
//       grid.json (band spec v8: `version: 8`, the 19 pd / 3 osm band order of
//       scripts/route_grid.py, the isoreg code table and landval constants; anything
//       else is refused, so an old cube asks for a rebuild) → endpoints to EPSG:5070
//       cells → corridor mask (cells within max(0.35·L, 25 km) × bufferFactor of
//       segment A–B, and its bbox) → the bbox's blocks of the pd_/osm_ super-tiles
//       (cog-read, decoded straight into the band arrays; readBands allocates only
//       the bands asked for, + state, and one limiter keeps ≤ 16 tiles in flight
//       across every window of both files; a super-tile not in `super_tiles_present`
//       is all nodata, so state 0 = barrier) → buildSurfaces → solve → reducePath
//       (δ 0.005 of the whole route's routing cost) → costPath (end kinds `terminals`, checked by
//       preset-patch.ts validateTerminals; cost only) → RouteResult.
//       When the path is not proven optimal (a path that touches the mask edge never
//       is), or no path is found, it retries once at 2× the buffer; a retry over the
//       cell cap keeps the first result. `maskLimited` = the returned path still
//       contains a mask-edge cell. `optimality: 'proven'` when no path leaving the
//       mask can be cheaper than the one found; the proof is at provenOptimal().
//       Cap: `cap` counts bbox cells (the arrays are bbox-sized), so a diagonal
//       corridor, whose bbox is about 1.8× its mask, reaches it first. About 30 B of
//       typed arrays per bbox cell, so the default 30 M cells hold about 0.9 GB; JS
//       heap, read buffers and buildSurfaces' temporaries come on top.
//       An endpoint whose cell has state 0 (sea, outside CONUS land) is refused
//       before the solve. A preset with a straight-line length rule is costed without
//       data or solve.
//       A request may carry `presetPatch` (the Route settings editor's session edits,
//       applied to a copy of the preset in the worker path, never to the registry) and
//       the `alternatives` / `altStretch` / `surface` options (preset-patch.ts
//       validates them). Similar-cost areas and Alternatives (similar-cost.ts) run on
//       the final attempt only. Byte budget: base B/cell = band arrays read + 20;
//       surface adds SURFACE_BYTES, alternatives PENALTY_BYTES_PER_CELL; when the bbox
//       exceeds floor(cap × base / (base + extra)) both are skipped
//       (`surface: {skipped}`, `altSkipped`) and the route still returns. `clipped` =
//       a classed cell is a mask-edge cell (raise bufferFactor). pctRoute is the raw
//       routing cost above the optimum's, pctUsd the 2025 $ against the route's (may
//       be negative, since routing weight is not $).
//       Profile (`profile: true`) and the alternatives' crossings (profile.ts) read the
//       PROFILE_BANDS the preset does not load sparsely (readPathTiles), outside the
//       byte budget. `weightImage: true` paints the in-mask routing weight
//       (`weightMode` 'route', 'cost' or 'cause') through surface-image.ts, in the
//       same byte budget as the surface.
//       Live repaint: route(req, io, windows) with a caller-kept WindowCache keeps the
//       final attempt's band window of a `weightImage` solve (≤ WINDOW_CACHE_BYTES);
//       repaint() and repaintRows() rebuild the overlay over it without a read or a
//       solve, NO_WINDOW_REASONS listing the refusals that mean the shell has no window.
//       inspect() reads only the blocks holding one cell (InspectCache) and returns
//       inspect.ts's decodeCell + explainCell. exactRouteCrossings() (on demand, never
//       part of a solve) takes ≤ 4 EPSG:5070 polylines, reads the report GeoParquet
//       under io.reportUrl (report-read.ts, EXACT_BUDGET_MS) and intersects
//       (crossings-exact.ts); a family whose files fail is left out of `exact` with its
//       reason in `note`. Optional screening.ts aviation observations are read
//       under the same deadline.
//       Uploaded layers: a patch's `add_rows` entry is a row on band upl_<hash>, which
//       is not in the cube: attempt() rasterises the layer (upload-layer.ts) over the
//       bbox beside the read bands. The geometry comes only from io.uploads (posted to
//       the worker by hash); a request naming a hash io.uploads lacks is refused, and
//       attempt() refuses before any read when layers × bbox cells exceed
//       UPLOAD_BYTES_BUDGET. windowKey() keys a held window by the ends, the line type
//       and the add_rows hashes.
//       Inputs are checked here (the trust boundary); every failure is an Outcome,
//       never a throw. Pure: no DOM; runs in a worker (route-worker.ts) and in Node
//       (tests). All I/O goes through `io` (range reads + JSON). See
//       docs/internal/routing-notes.md.
// Deps: grid.ts, cog-read.ts, dijkstra.ts, pi-reduce.ts, cost.ts, similar-cost.ts,
//       surface-image.ts, preset-patch.ts, upload-layer.ts, profile.ts, inspect.ts, report-read.ts, crossings-exact.ts, screening.ts,
//       src/registry/route-presets.ts; dataset-query.ts
//       (Outcome, type only).

import type { Outcome } from '../dataset-query.js';
import { routePreset, type BandName, type EndKind, type RoutePreset } from '../../src/registry/route-presets.js';
import { albersForward, albersInverse, gridFromJson, type Grid } from './grid.js';
import { createLimiter, openTiff, readTile, readWindow, type Fetcher, type Limiter, type TiffInfo } from './cog-read.js';
import { distances, solve, traverse, type Scratch } from './dijkstra.js';
import { reducePath } from './pi-reduce.js';
import { buildSurfaces, cellFactors, matches, cellsToCoords, compile, costPath, rowFactors, type Compiled, gridSampler, minRouteWeight, presetBands, straightLine, METRES_PER_MILE, type CostResult, type Sampler } from './cost.js';
import { searchLimitFactor, uploadBand, uploadBudgetReason, uploadHashes, UPLOAD_BYTES_BUDGET, validatePresetPatch, validateRouteOptions, validateTerminals, type PresetPatch, type RouteOptions } from './preset-patch.js';
import { isUploadBand } from '../../src/registry/route-presets.js';
import { insideCell, rasterize, type UploadLayer } from './upload-layer.js';
import { classify, DEFAULT_BANDS, PENALTY_BYTES_PER_CELL, penaltyAlternatives, shareWithin } from './similar-cost.js';
import { buildCrossings, buildProfile, PROFILE_BANDS, type CrossingPoint, type RouteCrossings, type RouteProfile } from './profile.js';
import { surfaceImage, MAX_SIDE, type CellWindow, type Palette, type SurfaceImage } from './surface-image.js';
import { routeCategory } from './categories.js';
import { causeColour, hexRgb } from './cause-colours.js';
import { decodeCell, explainCell, type CellExplain, type DecodedCell } from './inspect.js';
import { readReport, type ReportRead } from './report-read.js';
import { exactCrossings, type ExactResult, type Family } from './crossings-exact.js';
import { readRouteScreening, type RouteScreening } from './screening.js';

type LngLat = [number, number];

export interface RouteRequest {
  from: LngLat;
  to: LngLat;
  preset: string;
  lineType: string;
  cap?: number;           // max bbox cells, default 30e6 (header)
  bufferFactor?: number;  // scales the corridor buffer, default 1
  presetPatch?: PresetPatch; // session edits to the preset (preset-patch.ts)
  alternatives?: number;  // 0–3, default 0
  altStretch?: number;    // (0, 0.5], default 0.2
  surface?: boolean;      // default false
  profile?: boolean;      // default false: RouteResult.profile (profile.ts)
  weightImage?: boolean;  // default false: RouteResult.weightImage, the routing-weight overlay
  weightMode?: WeightMode; // default 'route': what weightImage draws
  uploads?: string[];     // hashes of the uploaded layers the request reads (presetPatch.add_rows' layers); geometry is in RouteIO.uploads
  terminals?: [EndKind, EndKind]; // what each end is, default ['new', 'new'] (cost only: not part of windowKey)
}

/** What the cell-weight overlay draws: the routing weight the solver sees, or the cost multiplier. */
export type WeightMode = 'route' | 'cost' | 'cause';
/** What the overlay shows: a cell-weight mode, or the Method grid's highlighted rows. */
export type OverlayMode = WeightMode | 'rows';
/** At most this many Method rows are highlighted at once, each in its own HIGHLIGHT_PALETTE slot. */
export const MAX_HIGHLIGHT = 8;
/** Highlight colours: class slot + 1 (index 0 unused). */
export const HIGHLIGHT_PALETTE: Palette = [[0, 0, 0, 0], [225, 29, 72, 200], [8, 145, 178, 200], [124, 58, 237, 200],
  [202, 138, 4, 200], [22, 163, 74, 200], [219, 39, 119, 200], [37, 99, 235, 200], [234, 88, 12, 200]];
/** One highlighted Method row (or its except entry `except`), addressed as saved methods address rows; slot 0…7. */
export interface RowPick { row: number; band: BandName; note?: string; except?: number; slot: number }
/** A rows-highlight overlay image. */
export interface RowsImage extends SurfaceImage { mode: 'rows' }
/** Repaint the highlighted rows over the window held for this route (no read). `presetPatch` only matters for
 *  its uploaded-layer rows (add_rows, picked at their index after the preset's rows). */
export interface RepaintRowsRequest { from: LngLat; to: LngLat; lineType: string; preset: string; rows: RowPick[]; presetPatch?: PresetPatch; uploads?: string[] }
/** One category present in a 'cause' overlay: its colour (#rrggbb), label key and share of the coloured cells. */
export interface CausePresent { key: string; colour: string; labelKey: string; share: number }
/** A cell-weight overlay image and what it draws. A 'cause' image lists the categories it shows (largest share first)
 *  and whether any cell is a barrier (drawn hatched). */
export interface WeightImage extends SurfaceImage { mode: WeightMode; cause?: { present: CausePresent[]; barrier: boolean } }

export interface RouteIO {
  /** Bytes [start, end) of `url`. */
  fetchRange(url: string, start: number, end: number): Promise<Uint8Array>;
  fetchJson(url: string): Promise<unknown>;
  /** Cube directory, ending in '/': grid.json, pd_{c}_{r}.tif, osm_{c}_{r}.tif. */
  baseUrl: string;
  /** Route report directory, ending in '/': the report-read.ts GeoParquet files. */
  reportUrl?: string;
  /** Size of `url` in bytes (non-finite when unknown). */
  byteLength?(url: string): Promise<number>;
  /** Called at the start of each phase of a routed solve. */
  progress?: (step: RouteStep) => void;
  /** Uploaded layers posted to this worker, by hash (route-worker.ts); a request naming any other is refused. */
  uploads?: ReadonlyMap<string, UploadLayer>;
  /** Bytes of upload bands one attempt may hold (default UPLOAD_BYTES_BUDGET; tests and the Node harness only). */
  uploadBudget?: number;
}

export type RouteStep = 'read' | 'surfaces' | 'solve' | 'prove' | 'reduce' | 'similar' | 'alternatives';

export interface RouteSegment { from: LngLat; to: LngLat; lengthMi: number; usd: number; meanCostX: number }

export interface RouteResult {
  path: GeoJSON.LineString;   // lng/lat; the PI polyline (2 points for a straight-line preset)
  lengthMi: number;
  cost: CostResult;           // nominal + 2025$ + estimate band, per-band table
  segments: RouteSegment[];
  tribalMiles: number;
  tribalNote: string | null;
  optimality: 'proven' | 'within-mask' | 'not-solved';
  maskLimited: boolean;
  bufferM: number;
  /** visited: cells the forward solve settled, including the extended search's when `surface` is on (the optimality check's backward search is not counted). */
  cells: { bbox: number; mask: number; visited: number; path: number; pis: number };
  /** similar / alternatives: the final attempt's similar-cost areas (backward search, classify,
   *  image) and alternatives (re-solves, reduce, cost); 0 when not asked for. attempts: the wall time
   *  of each attempt, first first (two when the first was retried at 2×). */
  timingsMs: { read: number; surfaces: number; solve: number; prove: number; reduce: number; similar: number; alternatives: number; total: number; attempts: number[] };
  /** Routing cost (per-metre weight × metres) of the raw cell path and of the drawn PI
   *  line (pi-reduce.ts: pis ≤ (1 + δ) × raw); null for a straight-line preset. */
  routeCost: { raw: number; pis: number } | null;
  preset: { id: string; label: string; attribution: string; caveat: string };
  /** Similar-cost areas, when `surface` was asked for. */
  surface?: RouteSurface | { skipped: string };
  /** Alternatives, when `alternatives` > 0: up to that many, cheapest first found. */
  alternatives?: RouteAlternative[];
  altFound?: number;
  altMethod?: 'penalty';
  /** Why fewer alternatives than asked for came back. */
  altSkipped?: string;
  /** Runs, samples and crossings along `path`, when `profile` was asked for; null for a straight-line preset. */
  profile?: RouteProfile | null;
  /** The cell-weight overlay over the search area (WEIGHT_PALETTE or COST_PALETTE classes, by `weightMode`), when `weightImage` was asked for. */
  weightImage?: WeightImage | { skipped: string };
}

export interface RouteSurface {
  bands: readonly number[];   // routing cost above optimal of classes 1..4 (0.02, 0.05, 0.10, 0.20)
  cellsByBand: number[];      // cells of class 1..4 (each cell counted in its own class only)
  clipped: boolean;           // a classed cell is a mask-edge cell: the areas may continue outside the mask
  edgeCellsInBands: number;
  bufferM: number;
  /** Class per cell (0 = none) over `window` (grid cells, row-major), the classed cells' bounding window. */
  classes: Uint8Array;
  window: CellWindow;
  image: SurfaceImage;        // RGBA in Web Mercator for a MapLibre image source
}

export interface RouteAlternative {
  path: GeoJSON.LineString;
  lengthMi: number;
  cost: CostResult;
  routeCostRaw: number;       // routing cost of its raw cell path, on the original weights
  pctRoute: number;           // routing cost above optimal, % (raw paths)
  pctUsd: number;             // 2025 $ against the route's, % (may be negative)
  shared: number;             // largest share (0..1) with the route or an earlier alternative
  sharedWithRoute: number;    // share (0..1) with the route alone
  crossings?: RouteCrossings; // along its path (profile.ts)
  ms: number;                 // its re-solve
}

const DEFAULT_CAP = 30e6;
const MIN_BUFFER_M = 25_000;
const BUFFER_SHARE = 0.35;
const DELTA = 0.005;
const BLOCK = 32;  // provenOptimal's Q blocks, cells
/** Bytes per bbox cell the similar-cost areas add (header). */
const SURFACE_BYTES = 11;
/** Class 1..4 colours (index 0 unused): darkest = closest to the optimal cost. */
export const SURFACE_PALETTE: Palette = [[0, 0, 0, 0], [8, 81, 156, 220], [49, 130, 189, 190], [107, 174, 214, 160], [189, 215, 231, 130]];
/** Routing-weight overlay: class k (1–7) holds weights in [WEIGHT_BREAKS[k-2], WEIGHT_BREAKS[k-1]) (class 1 from
 *  just above ×1), class WEIGHT_BARRIER the hard barriers; a weight ≤ 1 or a cell outside the mask is 0. */
export const WEIGHT_BREAKS: readonly number[] = [2, 5, 10, 30, 100, 1000];
export const WEIGHT_BARRIER = 8;
export const WEIGHT_PALETTE: Palette = [[0, 0, 0, 0], [253, 231, 160, 60], [253, 186, 120, 115], [240, 120, 90, 150],
  [200, 70, 120, 175], [130, 40, 140, 195], [64, 20, 110, 215], [12, 6, 40, 230], [150, 0, 0, 235]];
/** Bytes per bbox cell the routing-weight overlay adds (its class array). */
const WEIGHT_BYTES = 1;
/** Cost-multiplier overlay: class k (1–4) holds multipliers in [COST_BREAKS[k-2], COST_BREAKS[k-1]) (class 1 from
 *  just above ×1), class COST_BARRIER the hard barriers. */
export const COST_BREAKS: readonly number[] = [1.5, 2, 3];
export const COST_BARRIER = 5;
export const COST_PALETTE: Palette = [[0, 0, 0, 0], [199, 233, 192, 80], [116, 196, 118, 130], [35, 139, 69, 175],
  [0, 68, 27, 215], [150, 0, 0, 235]];
/** Band arrays + mask a WindowCache may hold. */
export const WINDOW_CACHE_BYTES = 400 * 1024 * 1024;
/** A held window plus the next solve's typed arrays must fit this, else the window goes before the solve reads. */
const WINDOW_SOLVE_BYTES = 1.4e9;

// Band order in the files: the one TS copy of route_grid.py PD_BANDS / OSM_BANDS (band spec
// v8), imported by the validate tests. Preset names of the OSM file's flags and maxkv carry
// an `osm_` prefix; grid.json names them without it (osmBandsFile).
export const PD_BANDS: readonly BandName[] = ['landcover', 'slope', 'protect', 'agency', 'wildfire', 'whpclass', 'flags', 'state',
  'desig', 'flags2', 'isoreg', 'landval', 'bldg', 'wetland', 'built', 'nonres', 'bldgunk', 'aviation', 'nfhl'];
export const OSM_BANDS: readonly BandName[] = ['osm_flags', 'osm_maxkv', 'adj'];
const GRID_VERSION = 8;
const MAX_TILES_IN_FLIGHT = 16;

const fail = <T>(reason: string): Outcome<T> => ({ ok: false, reason });
const now = (): number => globalThis.performance?.now() ?? Date.now();

/** The first attempt's search-area buffer (m) either side of segment A–B, whose length is `lengthM`
 *  (EPSG:5070 metres): max(0.35·L, 25 km) × bufferFactor. Pure; the route panel draws its outline. */
export function searchBufferM(lengthM: number, factor = 1): number {
  return Math.max(BUFFER_SHARE * lengthM, MIN_BUFFER_M) * factor;
}

const isLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
  p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;

export async function route(req: RouteRequest, io: RouteIO, windows?: WindowCache): Promise<Outcome<RouteResult>> {
  try {
    return await run(req, io, windows);
  } catch (err) {
    return fail(`route failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run(req: RouteRequest, io: RouteIO, windows?: WindowCache): Promise<Outcome<RouteResult>> {
  const t0 = now();
  if (!req || typeof req !== 'object') return fail('request must be an object');
  if (!isLngLat(req.from) || !isLngLat(req.to)) return fail('from and to must be [lng, lat] with lng in [-180, 180] and lat in [-90, 90]');
  const base = typeof req.preset === 'string' ? routePreset(req.preset) : undefined;
  if (!base) return fail(`unknown preset "${String(req.preset)}"`);
  const patched = validatePresetPatch(base, req.presetPatch);
  if (!patched.ok) return patched;
  const preset = patched.result;
  const layers = uploadsFor(req.uploads, req.presetPatch, io.uploads);
  if (typeof layers === 'string') return fail(layers);
  const valid = validateRouteOptions(req);
  if (!valid.ok) return valid;
  if (req.weightImage !== undefined && typeof req.weightImage !== 'boolean') return fail('weightImage must be true or false');
  if (req.weightMode !== undefined && !isWeightMode(req.weightMode)) return fail("weightMode must be 'route', 'cost' or 'cause'");
  const opts = { ok: true as const, result: { ...valid.result, weightImage: req.weightImage === true, weightMode: req.weightMode ?? 'route' } };
  if (typeof req.lineType !== 'string' || !Object.hasOwn(preset.line_types, req.lineType))
    return fail(`preset ${preset.id} has no line type "${String(req.lineType)}" (has ${Object.keys(preset.line_types).join(', ')})`);
  const ends = validateTerminals(req.terminals ?? ['new', 'new'], preset, req.lineType);
  if (!ends.ok) return ends;
  const kinds = ends.result;
  const cap = req.cap ?? DEFAULT_CAP;
  if (!(Number.isFinite(cap) && cap > 0)) return fail('cap must be a positive number');
  const factor = req.bufferFactor ?? 1;
  if (!(Number.isFinite(factor) && factor > 0)) return fail('bufferFactor must be a positive number');

  const presetInfo = { id: preset.id, label: preset.label, attribution: preset.attribution, caveat: preset.caveat };

  if (preset.length !== 'routed') {
    const cost = straightLine(req.from, req.to, preset, req.lineType, kinds);
    return {
      ok: true,
      result: {
        path: { type: 'LineString', coordinates: [req.from, req.to] },
        lengthMi: cost.lengthM / METRES_PER_MILE,
        cost,
        segments: [{ from: req.from, to: req.to, lengthMi: cost.lengthM / METRES_PER_MILE, usd: cost.lineUsdNominal, meanCostX: 1 }],
        tribalMiles: 0, tribalNote: null,
        optimality: 'not-solved', maskLimited: false, bufferM: 0,
        cells: { bbox: 0, mask: 0, visited: 0, path: 0, pis: 0 },
        timingsMs: { read: 0, surfaces: 0, solve: 0, prove: 0, reduce: 0, similar: 0, alternatives: 0, total: now() - t0, attempts: [] },
        routeCost: null,
        preset: presetInfo,
        ...(opts.result.profile ? { profile: null } : {}),
      },
    };
  }

  const gj = await io.fetchJson(io.baseUrl + 'grid.json');
  const meta = readGridJson(gj);
  if (typeof meta === 'string') return fail(meta);
  const { grid } = meta;
  const isoNames = new Set(meta.isoreg.values());
  const missing = Object.keys(preset.regions?.sets ?? {}).find((iso) => !isoNames.has(iso));
  if (missing !== undefined) return fail(`preset ${preset.id} names region "${missing}", which grid.json's isoreg table does not have: ${REBUILD}`);
  const offGrid = layers.find((l) => !sameGrid(l.grid, grid));
  if (offGrid) return fail(`upload layer ${offGrid.hash} is on another grid than the cube's`);
  const wanted = presetBands(preset);

  // Endpoints in fractional cell units (cell (c, r) spans [c, c+1) × [r, r+1)).
  const frac = (p: LngLat): [number, number] => {
    const [x, y] = albersForward(p[0], p[1]);
    return [(x - grid.x0) / grid.cell, (grid.y0 - y) / grid.cell];
  };
  const a = frac(req.from), b = frac(req.to);
  for (const [name, p] of [['from', a], ['to', b]] as const) {
    if (!(p[0] >= 0 && p[0] < grid.cols && p[1] >= 0 && p[1] < grid.rows))
      return fail(`${name} point is outside the routing grid (${grid.crs}, ${grid.cols} × ${grid.rows} cells)`);
  }
  const ac = [Math.floor(a[0]), Math.floor(a[1])], bc = [Math.floor(b[0]), Math.floor(b[1])];
  if (ac[0] === bc[0] && ac[1] === bc[1]) return fail(`from and to fall in the same ${grid.cell} m cell`);

  const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1]) * grid.cell;
  const buffer1 = searchBufferM(lengthM, factor);
  const minW = minRouteWeight(preset, req.lineType);

  const retryCells = bboxOf(grid, a, b, buffer1 * 2).cells, retryFits = retryCells <= cap && layers.length * retryCells <= (io.uploadBudget ?? UPLOAD_BYTES_BUDGET);
  if (windows?.held) {
    const key = windowKey(req.from, req.to, req.lineType, req.presetPatch), estimate = solveEstimateBytes(retryFits ? retryCells : bboxOf(grid, a, b, buffer1).cells, wanted, opts.result);
    if (windows.held.key !== key || windows.held.bytes + estimate > WINDOW_SOLVE_BYTES) windows.held = null;
  }
  let ta = now();
  const first = await attempt(meta, wanted, layers, io, preset, req.lineType, a, b, buffer1, cap, minW, opts.result, retryFits, kinds);
  if (typeof first === 'string') return fail(first);
  const attempts = [now() - ta];
  let best = first;
  if (!first.solved || !first.proven) {
    if (retryFits) {
      ta = now();
      const second = await attempt(meta, wanted, layers, io, preset, req.lineType, a, b, buffer1 * 2, cap, minW, opts.result, false, kinds);
      if (typeof second === 'string') return fail(second);
      attempts.push(now() - ta);
      best = second;
      best.timings.read += first.timings.read; best.timings.surfaces += first.timings.surfaces;
      best.timings.solve += first.timings.solve; best.timings.prove += first.timings.prove; best.timings.reduce += first.timings.reduce;
    }
  }
  if (!best.solved) return fail(best.error);
  if (windows && best.win && opts.result.weightImage) {
    const { box, mask, bands } = best.win;
    const bytes = Object.values(bands).reduce((s, x) => s + (x?.byteLength ?? 0), mask.byteLength);
    windows.held = bytes <= windows.maxBytes ? { key: windowKey(req.from, req.to, req.lineType, req.presetPatch), meta, box, mask, bands, bytes } : null;
  }

  const { coords, cost, timings } = best;
  const lngLats = coords.map(([x, y]) => albersInverse(x, y));
  const segments = cost.segments.map((s, i) => ({
    from: lngLats[i], to: lngLats[i + 1], lengthMi: s.lengthM / METRES_PER_MILE, usd: s.usd, meanCostX: s.meanCostX,
  }));
  return {
    ok: true,
    result: {
      path: { type: 'LineString', coordinates: lngLats },
      lengthMi: cost.lengthM / METRES_PER_MILE,
      cost,
      segments,
      tribalMiles: cost.tribalMiles,
      tribalNote: cost.tribalMiles > 0 ? preset.tribal.note : null,
      optimality: best.proven ? 'proven' : 'within-mask',
      maskLimited: best.touches,
      bufferM: best.bufferM,
      cells: best.cells,
      timingsMs: { similar: 0, alternatives: 0, ...timings, total: now() - t0, attempts },
      routeCost: best.routeCost,
      preset: presetInfo,
      ...best.extras,
    },
  };
}

// ─── grid.json ────────────────────────────────────────────────────────────────

/** What grid.json gives the solve beyond the grid itself (band spec v8). */
export interface GridMeta {
  grid: Grid;
  present: Set<string>;
  /** isoreg code (1…) → ISO name, the names preset `regions.sets` is keyed by. */
  isoreg: Map<number, string>;
  /** landval decode: $/ac = base · 2^((code − 1) / steps), code 1…max_code; 0 = no value. */
  landval: { base: number; steps: number; max_code: number };
}

const REBUILD = 'rebuild the cube (make route-cube)';
/** The names grid.json uses for the OSM file's bands. */
const osmBandsFile = (names: readonly BandName[]) => names.map((n) => n.replace(/^osm_/, ''));

export function readGridJson(j: unknown): GridMeta | string {
  const o = j as Record<string, unknown>;
  if (!o || typeof o !== 'object') return 'grid.json is not an object';
  if (o.version !== GRID_VERSION)
    return o.version === undefined
      ? `grid.json is a v1 routing cube (no "version": ${GRID_VERSION}; this reader needs band spec v${GRID_VERSION}): ${REBUILD}`
      : `grid.json version is ${JSON.stringify(o.version)}, this reader needs version ${GRID_VERSION}: ${REBUILD}`;
  const nums = ['cell', 'cols', 'rows', 'super', 'block'];
  if (!Array.isArray(o.origin) || o.origin.length !== 2 ||
    !o.origin.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    nums.some((k) => !(typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0)))
    return 'grid.json is missing origin / cell / cols / rows / super / block';
  if (o.crs !== 'EPSG:5070') return `grid.json crs is ${String(o.crs)}, expected EPSG:5070 (the projection grid.ts implements)`;
  const grid = gridFromJson(o as unknown as Parameters<typeof gridFromJson>[0]);
  const names = (bands: unknown) =>
    bands && typeof bands === 'object' ? Object.entries(bands).sort((x, y) => +x[0] - +y[0]).map(([, v]) => String(v)).join() : null;
  const pd = names(o.pd_bands), osm = names(o.osm_bands);
  if (pd === null || osm === null) return `grid.json has no pd_bands / osm_bands: ${REBUILD}`;
  if (pd !== PD_BANDS.join() || osm !== osmBandsFile(OSM_BANDS).join())
    return `grid.json band order differs from the reader's (pd: ${PD_BANDS.join(', ')}; osm: ${osmBandsFile(OSM_BANDS).join(', ')})`;

  const codes = (o.isoreg as { codes?: unknown } | undefined)?.codes;
  const isoreg = new Map<number, string>();
  if (codes && typeof codes === 'object') {
    for (const [k, v] of Object.entries(codes)) {
      const code = Number(k);
      if (!(Number.isInteger(code) && code >= 1 && code <= 255) || typeof v !== 'string' || !v)
        return `grid.json isoreg.codes has a bad entry ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
      isoreg.set(code, v);
    }
  }
  if (!isoreg.size) return `grid.json has no isoreg code table (isoreg.codes): ${REBUILD}`;
  const lv = o.landval as Record<string, unknown> | undefined;
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!lv || typeof lv !== 'object' || !pos(lv.base) || !pos(lv.steps) ||
    !(Number.isInteger(lv.max_code) && (lv.max_code as number) >= 1 && (lv.max_code as number) <= 255))
    return `grid.json has no landval constants (landval.base / steps / max_code): ${REBUILD}`;
  const landval = { base: lv.base as number, steps: lv.steps as number, max_code: lv.max_code as number };

  // Entries as [scol, srow] or "…{scol}_{srow}…"; absent = every super-tile present.
  const present = new Set<string>();
  const list = o.super_tiles_present;
  if (Array.isArray(list)) {
    for (const e of list) {
      const m = Array.isArray(e) ? e : /(\d+)_(\d+)/.exec(String(e))?.slice(1);
      if (m) present.add(`${+m[0]}_${+m[1]}`);
    }
  } else {
    for (let r = 0; r * grid.super < grid.rows; r++) for (let c = 0; c * grid.super < grid.cols; c++) present.add(`${c}_${r}`);
  }
  return { grid, present, isoreg, landval };
}

// ─── one solve over one corridor ─────────────────────────────────────────────

interface Bbox { c0: number; r0: number; w: number; h: number; cells: number }

function bboxOf(grid: Grid, a: number[], b: number[], bufferM: number): Bbox {
  const B = bufferM / grid.cell;
  const c0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - B)), c1 = Math.min(grid.cols, Math.ceil(Math.max(a[0], b[0]) + B));
  const r0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - B)), r1 = Math.min(grid.rows, Math.ceil(Math.max(a[1], b[1]) + B));
  return { c0, r0, w: c1 - c0, h: r1 - r0, cells: (c1 - c0) * (r1 - r0) };
}

type Attempt =
  | { solved: false; touches: boolean; error: string; timings: Timings }
  | {
      solved: true; touches: boolean; proven: boolean; bufferM: number;
      coords: [number, number][]; cost: CostResult; timings: Timings;
      cells: RouteResult['cells']; routeCost: { raw: number; pis: number };
      extras: Pick<RouteResult, 'surface' | 'alternatives' | 'altFound' | 'altMethod' | 'altSkipped' | 'profile' | 'weightImage'>;
      /** The final attempt's band window (for a WindowCache). */
      win?: { box: Bbox; mask: Uint8Array; bands: Bands };
    };
const IMAGE_BYTES = MAX_SIDE * MAX_SIDE * 4;
type ByteOpts = Pick<RouteOptions, 'surface' | 'alternatives'> & { weightImage: boolean };
/** One attempt's bytes (header): per bbox cell `base` (bands read or rasterised, state included, + 20) and `extra`
 *  (similar-cost areas, alternatives, overlay), plus `images`, the fixed RGBA allowance(s). */
export function cellBytes(wanted: Set<BandName>, opts: ByteOpts): { base: number; extra: number; images: number } {
  const base = [...PD_BANDS, ...OSM_BANDS].filter((nm) => wanted.has(nm) || nm === 'state').length + [...wanted].filter(isUploadBand).length + 20;
  const extra = (opts.surface ? SURFACE_BYTES : 0) + (opts.alternatives > 0 ? PENALTY_BYTES_PER_CELL : 0) + (opts.weightImage ? WEIGHT_BYTES : 0);
  return { base, extra, images: (+opts.surface + +opts.weightImage) * IMAGE_BYTES };
}
/** What a solve over `cells` bbox cells holds at most, by cellBytes (the held-window check before a solve reads). */
export function solveEstimateBytes(cells: number, wanted: Set<BandName>, opts: ByteOpts): number {
  const { base, extra, images } = cellBytes(wanted, opts);
  return cells * (base + extra) + images;
}
interface Timings { read: number; surfaces: number; solve: number; prove: number; reduce: number; similar?: number; alternatives?: number }

async function attempt(
  meta: GridMeta, wanted: Set<BandName>, layers: UploadLayer[], io: RouteIO, preset: RoutePreset, lineType: string,
  a: number[], b: number[], bufferM: number, cap: number, minW: number, opts: RouteOptions & { weightImage: boolean; weightMode: WeightMode }, retryFits: boolean, kinds: [EndKind, EndKind],
): Promise<Attempt | string> {
  const { grid, present } = meta;
  const box = bboxOf(grid, a, b, bufferM);
  if (box.cells > cap)
    return `the search area's bounding box of ${box.cells} cells exceeds the cap of ${cap} (a diagonal search area's bounding box is larger than the area itself): shorten the line or narrow the buffer`;
  const { c0, r0, w, h, cells: n } = box;
  const uploadBudget = io.uploadBudget ?? UPLOAD_BYTES_BUDGET;
  if (layers.length * n > uploadBudget) return uploadBudgetReason(layers.length, n, uploadBudget);

  // Byte budget for the similar-cost areas / alternatives (header).
  const wantSurface = opts.surface, wantAlts = opts.alternatives > 0, wantWeight = opts.weightImage;
  const { base, extra, images } = cellBytes(wanted, opts);
  // Each RGBA image (≤ MAX_SIDE² × 4 B) is a fixed cost: it comes off the byte pool first.
  const imageCells = (images / IMAGE_BYTES) * Math.ceil(IMAGE_BYTES / base);
  const extraCap = Math.max(0, Math.floor((cap - imageCells) * base / (base + extra)));
  const skipped = extra && n > extraCap
    ? `cap: the bbox has ${n} cells; with ${base} B/cell for the route and ${extra} B/cell more for ${[wantSurface && 'similar-cost areas', wantAlts && 'alternatives', wantWeight && 'the routing-weight overlay'].filter(Boolean).join(' and ')}, the cap of ${cap} cells allows ${extraCap} (raise cap or narrow the buffer)`
    : null;
  const limitF = searchLimitFactor(opts.altStretch);

  // Mask: cell centre within bufferM of segment A–B (cell units). The capsule is
  // convex, so each row's mask is one run of columns [lo, hi] (lo > hi: empty).
  const B = bufferM / grid.cell, B2 = B * B;
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy;
  const mask = new Uint8Array(n);
  const lo = new Int32Array(h).fill(w), hi = new Int32Array(h).fill(-1);
  let maskCells = 0;
  for (let r = 0; r < h; r++) {
    const py = r0 + r + 0.5;
    for (let c = 0; c < w; c++) {
      const px = c0 + c + 0.5;
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / dd));
      const ex = px - a[0] - t * dx, ey = py - a[1] - t * dy;
      if (ex * ex + ey * ey <= B2) { mask[r * w + c] = 1; maskCells++; lo[r] = Math.min(lo[r], c); hi[r] = c; }
    }
  }

  io.progress?.('read');
  let t = now();
  const bands = await readBands(grid, wanted, present, io, box);
  // Uploaded layers are not cube bands: upl_<hash> is that add_rows entry rasterised over the bbox.
  layers.forEach((l) => { bands[uploadBand(l.hash)] = rasterize(l, { col0: c0, row0: r0, cols: w, rows: h }); });
  const read = now() - t;

  io.progress?.('surfaces');
  t = now();
  const surf = buildSurfaces(preset, lineType, bands, w, h, { cost: false });
  const surfaces = now() - t;

  io.progress?.('solve');
  t = now();
  const local = (p: number[]) => (Math.floor(p[1]) - r0) * w + (Math.floor(p[0]) - c0);
  const start = local(a), goal = local(b);
  for (const [name, e] of [['from', start], ['to', goal]] as const) {
    if (bands.state![e] === 0) return `${name} endpoint is outside CONUS land (state band 0)`;
  }
  const g = { width: w, height: h, cost: surf.route, barrier: surf.barrier, mask, cellM: grid.cell, maxCells: cap };
  // The parent array is ours so the alternatives' re-solves can reuse it after the proof.
  const parent = new Int32Array(n);
  const sol = solve({ ...g, start, goal }, { extend: wantSurface && !skipped ? limitF - 1 : 0, parent });
  const solveMs = now() - t;
  if (!sol.ok) return { solved: false, touches: false, error: sol.error, timings: { read, surfaces, solve: solveMs, prove: 0, reduce: 0 } };

  // Touches the mask edge: the path contains a mask-edge cell, the same set the
  // optimality bound uses (a path that does can never be proven).
  io.progress?.('prove');
  t = now();
  const edge = edgeCells(grid, box, lo, hi);
  const onPath = new Set(sol.path);
  const touches = edge.some((i) => onPath.has(i));
  const mayBeFinal = !touches || !retryFits;
  const extras: Extract<Attempt, { solved: true }>['extras'] = {};
  let prove = now() - t;

  // Similar-cost areas: dB in its own buffers, classified while sol.dist (dA) is intact.
  let similar = 0, dB: Float64Array | undefined, classes: Uint8Array | undefined;
  if (mayBeFinal && wantSurface) {
    io.progress?.('similar');
    t = now();
    if (skipped) extras.surface = { skipped };
    else {
      const back = distances({ ...g, start: goal }, limitF * sol.cost, [start, goal], { dist: new Float64Array(n), state: new Uint8Array(n) });
      if ('error' in back) extras.surface = { skipped: `backward search failed: ${back.error}` };
      else { dB = back.dist; classes = classify(sol.dist, dB, sol.cost, DEFAULT_BANDS); }
    }
    similar = now() - t;
  }

  t = now();
  // sol.dist is valid here only: provenOptimal's distances() (when no dB) reuses its buffer.
  const proven = !touches && provenOptimal(g, start, goal, sol.cost, sol.dist, sol.scratch, edge, minW, dB);
  prove += now() - t;
  const final = proven || !retryFits;

  if (final && classes) {
    t = now();
    extras.surface = surfaceResult(grid, box, classes, edge, bufferM);
    similar += now() - t;
  }
  if (final && wantWeight) {
    extras.weightImage = skipped ? { skipped }
      : opts.weightMode === 'cause' ? causeImage(grid, preset, lineType, meta, box, mask, bands)
      : opts.weightMode === 'cost' ? weightImageOf(grid, box, costClasses(preset, lineType, meta, box, mask, bands), 'cost')
      : weightImageOf(grid, box, routeClasses(box, mask, surf.route, surf.barrier), 'route');
  }

  io.progress?.('reduce');
  t = now();
  const red = reducePath({ ...g, path: sol.path, delta: DELTA });
  const x0 = grid.x0 + c0 * grid.cell, y0 = grid.y0 - r0 * grid.cell;
  const coords = cellsToCoords(red.pis, w, grid.cell, x0, y0);
  const sampler = gridSampler(bands, w, h, grid.cell, x0, y0);
  const consts = { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval };
  const cost = costPath(coords, preset, lineType, sampler, consts, kinds);
  const reduce = now() - t;

  let alternatives = 0;
  const altCoords: [number, number][][] = [];
  if (final && wantAlts) {
    io.progress?.('alternatives');
    t = now();
    if (skipped) extras.altSkipped = skipped;
    else {
      // The forward solve's dist/state/parent are free after the proof: the re-solves reuse them.
      const res = penaltyAlternatives({
        input: { ...g, start, goal }, optimum: { path: sol.path, cost: sol.cost }, k: opts.alternatives,
        scratch: sol.scratch, parent, stretchMax: opts.altStretch,
      });
      extras.alternatives = res.alts.map((alt) => {
        const r = reducePath({ ...g, path: alt.path, delta: DELTA });
        const xy = cellsToCoords(r.pis, w, grid.cell, x0, y0);
        altCoords.push(xy);
        const c = costPath(xy, preset, lineType, sampler, consts, kinds);
        return {
          path: { type: 'LineString', coordinates: xy.map(([x, y]) => albersInverse(x, y)) },
          lengthMi: c.lengthM / METRES_PER_MILE, cost: c, routeCostRaw: alt.cost,
          pctRoute: 100 * alt.stretch, pctUsd: 100 * (c.total2025 / cost.total2025 - 1), shared: alt.share,
          // penaltyAlternatives' share radius (2 cells), against the optimum only.
          sharedWithRoute: shareWithin(alt.path, sol.path, 2, w), ms: alt.ms,
        };
      });
      if (res.alts.length < opts.alternatives) {
        const { stretch, share, selfTouch } = res.rejected;
        extras.altSkipped = res.stopped === 'attempts'
          ? `found ${res.alts.length} of ${opts.alternatives} in ${res.attempts} re-solves (rejected: ${stretch} over ${Math.round(opts.altStretch * 100)} % routing cost, ${share} sharing > 50 %, ${selfTouch} doubling back)`
          : `found ${res.alts.length} of ${opts.alternatives}; a re-solve failed: ${res.stopped}`;
      }
    }
    extras.altFound = extras.alternatives?.length ?? 0;
    extras.altMethod = 'penalty';
    alternatives = now() - t;
  }

  // Profile / alternatives' crossings: the profile bands the preset does not load, for the
  // blocks the polylines cross only (header).
  if (final && (opts.profile || altCoords.length)) {
    const extra = PROFILE_BANDS.filter((nm) => !wanted.has(nm));
    const lines = opts.profile ? [coords, ...altCoords] : altCoords;
    const tiles = extra.length ? await readPathTiles(grid, present, io, extra, lines) : null;
    const ps = pathSampler(sampler, grid, present, c0, r0, extra, tiles);
    const loaded = new Set<string>([...wanted, ...PROFILE_BANDS]);
    if (opts.profile) {
      extras.profile = buildProfile(coords, ps, {
        compiled: compile(preset, lineType, consts), preset, lineTypeId: lineType, toLngLat: albersInverse,
        lengthMi: cost.lengthM / METRES_PER_MILE, present: loaded,
      });
    }
    extras.alternatives?.forEach((alt, i) => {
      alt.crossings = buildCrossings(altCoords[i], ps, { toLngLat: albersInverse, lengthMi: alt.lengthMi, present: loaded });
    });
  }

  return {
    solved: true, touches, proven, bufferM, coords, cost, extras, ...(final ? { win: { box, mask, bands } } : {}),
    timings: { read, surfaces, solve: solveMs, prove, reduce, similar, alternatives },
    cells: { bbox: n, mask: maskCells, visited: sol.visited, path: sol.path.length, pis: red.pis.length },
    routeCost: { raw: red.rawCost, pis: red.cost },
  };
}

/** In-mask cells with a 16-move neighbour outside the mask (or outside the bbox but
 *  inside the grid), from the mask's row runs [lo, hi]. Rows ±2 are tested over
 *  columns c ± 1 (a superset of the two knight cells: a few extra edge cells only
 *  weaken the bound). */
export function edgeCells(grid: Pick<Grid, 'cols' | 'rows'>, box: Omit<Bbox, 'cells'>, lo: Int32Array, hi: Int32Array): number[] {
  const { c0, r0, w, h } = box;
  const out: number[] = [];
  // Outside the grid nothing can be entered: a run touching the grid's side reaches it.
  const runLo = (r: number) => (lo[r] === 0 && c0 === 0 ? -Infinity : lo[r]);
  const runHi = (r: number) => (hi[r] === w - 1 && c0 + w === grid.cols ? Infinity : hi[r]);
  for (let r = 0; r < h; r++) {
    if (lo[r] > hi[r]) continue;
    // Interior columns: [L, H]; every other in-mask column of row r is an edge cell.
    let L = -Infinity, H = Infinity;
    for (let dr = -2; dr <= 2; dr++) {
      const rr = r + dr, span = Math.abs(dr) === 1 ? 2 : 1;
      if (r0 + rr < 0 || r0 + rr >= grid.rows) continue;
      if (rr < 0 || rr >= h || lo[rr] > hi[rr]) { L = Infinity; H = -Infinity; break; }
      L = Math.max(L, runLo(rr) + span); H = Math.min(H, runHi(rr) - span);
    }
    for (let c = lo[r]; c <= hi[r]; c++) {
      if (c >= L && c <= H) c = Math.min(H, hi[r]);
      else out.push(r * w + c);
    }
  }
  return out;
}

/** Class counts, the mask-edge clip test and the image over the classed cells' bounding window. */
function surfaceResult(grid: Grid, box: Bbox, classes: Uint8Array, edge: number[], bufferM: number): RouteSurface {
  const { w, h } = box;
  const cellsByBand = DEFAULT_BANDS.map(() => 0);
  let cMin = w, cMax = -1, rMin = h, rMax = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0, i = r * w; c < w; c++, i++) {
      const k = classes[i];
      if (!k) continue;
      cellsByBand[k - 1]++;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
      if (r < rMin) rMin = r;
      rMax = r;
    }
  }
  const edgeCellsInBands = edge.reduce((s, i) => s + (classes[i] ? 1 : 0), 0);
  // The optimal path's cells are class 1, so the window is never empty.
  const cw = cMax - cMin + 1, ch = rMax - rMin + 1;
  const crop = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) crop.set(classes.subarray((rMin + r) * w + cMin, (rMin + r) * w + cMin + cw), r * cw);
  const window: CellWindow = { col0: box.c0 + cMin, row0: box.r0 + rMin, cols: cw, rows: ch };
  return {
    bands: DEFAULT_BANDS, cellsByBand, clipped: edgeCellsInBands > 0, edgeCellsInBands, bufferM,
    classes: crop, window, image: surfaceImage(grid, window, crop, SURFACE_PALETTE),
  };
}

/** Class of one factor against `breaks` (class k from breaks[k-2]); 0 for ≤ ×1. */
const classOf = (x: number, breaks: readonly number[]): number => {
  if (!(x > 1)) return 0;
  let k = 1;
  while (k <= breaks.length && x >= breaks[k - 1]) k++;
  return k;
};

/** Routing-weight class of one weight (WEIGHT_BREAKS); 0 for ≤ ×1. */
export const weightClass = (w: number): number => classOf(w, WEIGHT_BREAKS);
/** Cost-multiplier class of one multiplier (COST_BREAKS); 0 for ≤ ×1. */
export const costClass = (c: number): number => classOf(c, COST_BREAKS);

const isWeightMode = (m: unknown): m is WeightMode => m === 'route' || m === 'cost' || m === 'cause';

/** In-mask cells by weightClass, barriers as WEIGHT_BARRIER. */
function routeClasses(box: Bbox, mask: Uint8Array, route: Float32Array, barrier: Uint8Array): Uint8Array {
  const classes = new Uint8Array(box.cells);
  for (let i = 0; i < classes.length; i++) if (mask[i]) classes[i] = barrier[i] ? WEIGHT_BARRIER : weightClass(route[i]);
  return classes;
}

/** In-mask cells classed by `classOfCell(k, vals)` for the compiled preset `k`. Only the bands the preset
 *  reads are keyed; each distinct tuple of their values is evaluated once (a run of equal cells skips
 *  even the lookup). */
function classesByTuple(preset: RoutePreset, lineType: string, meta: GridMeta, box: Bbox, mask: Uint8Array, bands: Bands,
  classOfCell: (k: Compiled, vals: Partial<Record<BandName, number>>) => number): Uint8Array {
  const k = compile(preset, lineType, { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval });
  const read = new Set<BandName>([...k.mul.keys(), ...k.barrier.keys(), ...k.exc.flatMap((x) => [x.self.band, ...x.any.map((e) => e.band)])]);
  for (const g of k.groups.values()) for (const nm of g.bands.keys()) read.add(nm);
  if (preset.regions) read.add(preset.regions.band);
  const names = [...read].filter((nm) => bands[nm]), arrs = names.map((nm) => bands[nm]!), nb = arrs.length;
  const classes = new Uint8Array(box.cells), vals: Partial<Record<BandName, number>> = {};
  // Nested maps, six 8-bit band values packed per level (< 2^48, exact in a double).
  const memo = new Map<number, unknown>(), levels = Math.max(1, Math.ceil(nb / 6));
  let prev = -1, cls = 0;
  for (let i = 0; i < classes.length; i++) {
    if (!mask[i]) continue;
    let same = prev >= 0;
    for (let j = 0; same && j < nb; j++) same = arrs[j][i] === arrs[j][prev];
    prev = i;
    if (same) { classes[i] = cls; continue; }
    let m = memo;
    for (let l = 0; l < levels; l++) {
      let key = 0;
      for (let j = l * 6; j < Math.min(nb, l * 6 + 6); j++) key = key * 256 + arrs[j][i];
      if (l === levels - 1) {
        const hit = m.get(key) as number | undefined;
        if (hit !== undefined) cls = hit;
        else {
          for (let j = 0; j < nb; j++) vals[names[j]] = arrs[j][i];
          cls = classOfCell(k, vals);
          m.set(key, cls);
        }
      } else {
        let next = m.get(key) as Map<number, unknown> | undefined;
        if (!next) m.set(key, (next = new Map()));
        m = next;
      }
    }
    classes[i] = cls;
  }
  return classes;
}


/** In-mask cells by costClass of the cost multiplier costPolyline() charges there (cellFactors' c,
 *  the cell's regional set), barriers as COST_BARRIER. */
function costClasses(preset: RoutePreset, lineType: string, meta: GridMeta, box: Bbox, mask: Uint8Array, bands: Bands): Uint8Array {
  return classesByTuple(preset, lineType, meta, box, mask, bands, (k, vals) => {
    const f = cellFactors(k, vals, lineType);
    return f.barrier ? COST_BARRIER : costClass(f.c);
  });
}

/** Class of a barrier cell in a 'cause' overlay; categories take 2.. in order of first appearance. */
const CAUSE_BARRIER = 1;
const CAUSE_ALPHA = 215;

/** In-mask cells by the category of the routing row that drives the method's weight there (the winner
 *  with the largest |ln r|, as inspect.ts explains it), barriers as CAUSE_BARRIER, no penalty as 0;
 *  the palette and present-category list follow the categories the window holds. */
function causeImage(grid: Grid, preset: RoutePreset, lineType: string, meta: GridMeta, box: Bbox, mask: Uint8Array, bands: Bands): WeightImage {
  const keys: string[] = [];
  const classes = classesByTuple(preset, lineType, meta, box, mask, bands, (k, vals) => {
    if (cellFactors(k, vals, lineType).barrier) return CAUSE_BARRIER;
    let top: { row: number; a: number } | null = null;
    for (const f of rowFactors(k, vals, lineType)) {
      const a = Math.abs(Math.log(f.r));
      if (f.winsRoute && f.r !== 1 && (!top || a > top.a)) top = { row: f.row, a };
    }
    if (!top) return 0;
    const key = routeCategory(preset.rows[top.row]);
    let i = keys.indexOf(key);
    if (i < 0) i = keys.push(key) - 1;
    return i + 2;
  });
  const counts = new Float64Array(keys.length + 2);
  for (let i = 0; i < classes.length; i++) counts[classes[i]]++;
  const palette: [number, number, number, number][] = [[0, 0, 0, 0], [...WEIGHT_PALETTE[WEIGHT_BARRIER]] as [number, number, number, number]];
  const coloured = counts.reduce((n, c, i) => (i >= 2 ? n + c : n), 0) || 1;
  const present = keys.map((key, i) => ({ key, ...causeColour(key), share: counts[i + 2] / coloured }));
  for (const x of present) palette.push([...hexRgb(x.colour), CAUSE_ALPHA]);
  present.sort((a, b) => b.share - a.share);
  const img = weightImageOf(grid, box, classes, 'cause', palette, CAUSE_BARRIER);
  return { ...img, cause: { present: present.map(({ key, colour, labelKey, share }) => ({ key, colour, labelKey, share })), barrier: counts[CAUSE_BARRIER] > 0 } };
}

/** The cell-weight overlay over the bbox from its classes; barriers hatched in the image
 *  (every other 3-pixel diagonal stripe lighter). */
function weightImageOf(grid: Grid, box: Bbox, classes: Uint8Array, mode: WeightMode,
  palette: Palette = mode === 'cost' ? COST_PALETTE : WEIGHT_PALETTE, bar = mode === 'cost' ? COST_BARRIER : WEIGHT_BARRIER): WeightImage {
  const img = surfaceImage(grid, { col0: box.c0, row0: box.r0, cols: box.w, rows: box.h }, classes, palette);
  const [br, bg, bb] = palette[bar], d = img.rgba;
  for (let j = 0; j < img.height; j++) {
    for (let i = 0; i < img.width; i++) {
      const o = (j * img.width + i) * 4;
      if (d[o + 3] && d[o] === br && d[o + 1] === bg && d[o + 2] === bb && (i + j) % 6 >= 3) d[o + 3] = 90;
    }
  }
  return { ...img, mode };
}

// ─── live repaint over a held band window ──────────────────────────────

type Bands = Partial<Record<BandName, Uint8Array>>;

/** The last solve's band window, as a WindowCache holds it. */
export interface BandWindow { key: string; meta: GridMeta; box: Bbox; mask: Uint8Array; bands: Bands; bytes: number }
/** Caller-kept (one per worker): at most one window, of ≤ maxBytes of band arrays + mask. */
export interface WindowCache { maxBytes: number; held: BandWindow | null }
export const createWindowCache = (maxBytes = WINDOW_CACHE_BYTES): WindowCache => ({ maxBytes, held: null });
/** The one key of a held window (solve, repaint, repaintRows): the route's ends and line type, and the
 *  uploaded layers in add_rows order when there are any (a changed list is another window). */
const windowKey = (from: unknown, to: unknown, lineType: unknown, patch: PresetPatch | undefined): string => {
  const h = uploadHashes(patch);
  return JSON.stringify(h.length ? [from, to, lineType, h] : [from, to, lineType]);
};

const HASH = /^[0-9a-f]{16}$/;
/** The uploaded layers `patch` reads, in add_rows order, once every hash the request names
 *  (`named` and the patch's) is loaded; else why not (never a solve with that band as nodata). */
function uploadsFor(named: unknown, patch: PresetPatch | undefined, loaded: ReadonlyMap<string, UploadLayer> | undefined): UploadLayer[] | string {
  if (named !== undefined && !(Array.isArray(named) && named.every((h) => typeof h === 'string' && HASH.test(h))))
    return 'uploads must be an array of uploaded layer hashes';
  const order = uploadHashes(patch);
  for (const h of new Set([...order, ...((named as string[] | undefined) ?? [])])) if (!loaded?.has(h)) return `upload layer ${h} not loaded`;
  return order.map((h) => loaded!.get(h)!);
}
const sameGrid = (a: Grid, b: Grid): boolean => a.x0 === b.x0 && a.y0 === b.y0 && a.cell === b.cell && a.cols === b.cols && a.rows === b.rows;

/** `from`/`to`/`lineType` name the route the overlay is for: a held window of another route is refused. */
export interface RepaintRequest { from: LngLat; to: LngLat; preset: string; lineType: string; presetPatch?: PresetPatch; mode: WeightMode; uploads?: string[] }
export interface RepaintResult { image: WeightImage; mode: WeightMode }

/** The cell-weight overlay of `req`'s preset + patch over the held window, without reading or solving. */
export function repaint(req: RepaintRequest, windows: WindowCache, uploads?: ReadonlyMap<string, UploadLayer>): Outcome<RepaintResult> {
  try {
    const held = windows.held;
    if (!held) return fail('no cached window');
    if (!req || typeof req !== 'object') return fail('request must be an object');
    if (!isWeightMode(req.mode)) return fail("mode must be 'route', 'cost' or 'cause'");
    const base = typeof req.preset === 'string' ? routePreset(req.preset) : undefined;
    if (!base) return fail(`unknown preset "${String(req.preset)}"`);
    const patched = validatePresetPatch(base, req.presetPatch);
    if (!patched.ok) return patched;
    const preset = patched.result;
    const layers = uploadsFor(req.uploads, req.presetPatch, uploads);
    if (typeof layers === 'string') return fail(layers);
    if (windowKey(req.from, req.to, req.lineType, req.presetPatch) !== held.key) return fail('window is for another route');
    if (preset.length !== 'routed') return fail(`preset ${preset.id} is costed on a straight line: it has no cell weights`);
    if (typeof req.lineType !== 'string' || !Object.hasOwn(preset.line_types, req.lineType))
      return fail(`preset ${preset.id} has no line type "${String(req.lineType)}" (has ${Object.keys(preset.line_types).join(', ')})`);
    const lacking = [...presetBands(preset)].find((nm) => !held.bands[nm]);
    if (lacking) return fail(`the cached window has no ${lacking} band: re-solve to repaint this method`);
    const { meta: { grid }, box, mask, bands } = held;
    if (req.mode === 'cause') {
      const image = causeImage(grid, preset, req.lineType, held.meta, box, mask, bands);
      return { ok: true, result: { image, mode: 'cause' } };
    }
    const classes = req.mode === 'cost'
      ? costClasses(preset, req.lineType, held.meta, box, mask, bands)
      : (() => { const s = buildSurfaces(preset, req.lineType, bands, box.w, box.h); return routeClasses(box, mask, s.route, s.barrier); })();
    return { ok: true, result: { image: weightImageOf(grid, box, classes, req.mode), mode: req.mode } };
  } catch (err) {
    return fail(`repaint failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Refusal reasons that mean the shell holds no usable window for the rows highlight (it greys the Map column). */
export const NO_WINDOW_REASONS: readonly string[] = ['no cached window', 'window is for another route', 'the cached window has no '];

/** Classes per cell over held.box: mask[i] ? slot + 1 of the last pick (list order) whose row, or for an
 *  except pick whose parent row and exemption, matches the cell : 0. Pure; picks are checked by repaintRows. */
export function rowClasses(held: BandWindow, picks: RowPick[], preset: RoutePreset): Uint8Array {
  const n = held.box.w * held.box.h, out = new Uint8Array(n);
  for (const p of picks) {
    const row = preset.rows[p.row], ex = p.except === undefined ? undefined : row.except?.[p.except];
    const a = held.bands[row.band]!, b = ex ? held.bands[ex.band]! : a;
    for (let i = 0; i < n; i++) {
      if (!held.mask[i]) continue;
      if (matches(row.match, a[i]) && (!ex || matches(ex.match, b[i]))) out[i] = p.slot + 1;
    }
  }
  return out;
}

/** The rows highlight over the held window: no read, no solve. */
export function repaintRows(req: RepaintRowsRequest, windows: WindowCache, uploads?: ReadonlyMap<string, UploadLayer>): Outcome<{ image: RowsImage }> {
  try {
    const held = windows.held;
    if (!held) return fail('no cached window');
    if (!req || typeof req !== 'object') return fail('request must be an object');
    const base = typeof req.preset === 'string' ? routePreset(req.preset) : undefined;
    if (!base) return fail(`unknown preset "${String(req.preset)}"`);
    const patched = validatePresetPatch(base, req.presetPatch);
    if (!patched.ok) return patched;
    const preset = patched.result;
    const layers = uploadsFor(req.uploads, req.presetPatch, uploads);
    if (typeof layers === 'string') return fail(layers);
    if (windowKey(req.from, req.to, req.lineType, req.presetPatch) !== held.key) return fail('window is for another route');
    if (!Array.isArray(req.rows)) return fail('rows must be an array');
    if (req.rows.length > MAX_HIGHLIGHT) return fail(`at most ${MAX_HIGHLIGHT} rows can be highlighted`);
    const wanted = presetBands(preset), seen = new Set<string>();
    for (const [k, p] of req.rows.entries()) {
      const row = p && typeof p === 'object' && Number.isInteger(p.row) ? preset.rows[p.row] : undefined;
      if (!row) return fail(`rows[${k}].row is out of range`);
      if (p.band !== row.band || p.note !== row.note)
        return fail(`rows[${k}] names band "${String(p.band)}" / note "${String(p.note)}", but row ${p.row} is ${row.band} / "${row.note ?? ''}"`);
      if (p.except !== undefined && (!Number.isInteger(p.except) || !row.except?.[p.except])) return fail(`rows[${k}].except is out of range`);
      if (!Number.isInteger(p.slot) || p.slot < 0 || p.slot >= MAX_HIGHLIGHT) return fail(`rows[${k}].slot must be 0 to ${MAX_HIGHLIGHT - 1}`);
      const dup = `${p.row}/${p.except ?? ''}`;
      if (seen.has(dup)) return fail(`rows[${k}] repeats row ${p.row}${p.except === undefined ? '' : ` except ${p.except}`}`);
      seen.add(dup);
      const ex = p.except === undefined ? undefined : row.except![p.except];
      for (const nm of ex ? [row.band, ex.band] : [row.band])
        if (!held.bands[nm])
          return fail(wanted.has(nm) ? `the cached window has no ${nm} band: re-solve to show this row`
            : `the ${nm} band is read only by an exemption that is off: turn the exemption on to show this row`);
    }
    const { meta: { grid }, box } = held;
    const image = { ...surfaceImage(grid, { col0: box.c0, row0: box.r0, cols: box.w, rows: box.h }, rowClasses(held, req.rows, preset), HIGHLIGHT_PALETTE), mode: 'rows' as const };
    return { ok: true, result: { image } };
  } catch (err) {
    return fail(`repaint failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True when no path through a cell outside the mask can cost less than `C` (cost of the path found).
 *  Such a path leaves the mask for the first time from an in-mask cell P (A → P: ≥ dA(P), the
 *  solve's own in-mask distance) and returns for the last time to an in-mask cell Q (Q → B: ≥ dB(Q));
 *  between them it is at least |PQ| long at no less than the preset's lowest routing weight per
 *  metre (minW: outside the mask nothing is read). So it costs ≥ dA(P) + minW·|PQ| + dB(Q), over P, Q
 *  on the mask edge (an in-mask cell with a 16-move neighbour outside the mask; a move between two
 *  in-mask cells that straddles an outside cell also starts and ends at such cells). Steps, cheapest
 *  first: dA(P) + minW·|PB| ≥ C for every edge P (no second search); else a backward search from B
 *  (dijkstra.ts distances(), reusing the solve's buffers) to C − min dA, then the pairs (Q grouped in
 *  blocks, a block skipped when its nearest, cheapest corner already gives ≥ C). Only a path that
 *  does not touch the mask edge is checked; else 'within-mask'. minW is taken 1e-6 lower in the bound.
 *  `dB`, when given, is a backward search from the goal exact to ≥ C − min dA over edge cells. */
export function provenOptimal(
  g: { width: number; height: number; cost: Float32Array; barrier: Uint8Array; mask: Uint8Array; cellM: number; maxCells: number },
  start: number, goal: number, C: number, dA: Float64Array, scratch: Scratch, edge: number[], minW: number,
  dB?: Float64Array,
): boolean {
  const W = g.width, len = (i: number, j: number) => Math.hypot(Math.floor(i / W) - Math.floor(j / W), (i % W) - (j % W)) * g.cellM;
  minW *= 1 - 1e-6;  // float32 weights may round just below the float64 minimum
  // dA < C is exact (settled before the goal); any other edge cell gives ≥ C already.
  const P = edge.filter((i) => dA[i] < C).map((i) => ({ i, d: dA[i] }));
  if (P.every(({ i, d }) => d + minW * len(i, goal) >= C)) return true;
  const limit = C - P.reduce((m, p) => Math.min(m, p.d), Infinity);
  // A caller's dB (exact to ≥ limit, same guard) is used as it is; else a search that reuses
  // the solve's buffers: dA (= scratch.dist) is invalid from here on.
  const back = dB ? { dist: dB } : distances({ ...g, start: goal }, limit, [start, goal], scratch);
  if ('error' in back) return false;
  // dB < limit is exact; an edge cell with dB ≥ limit gives dA + dB ≥ C for every P.
  // Q in blocks of BLOCK × BLOCK cells: a block whose least dB + minW × (distance from
  // P to the block) is ≥ C − dA(P) is skipped whole.
  const blocks = new Map<number, { r0: number; c0: number; min: number; q: { r: number; c: number; d: number }[] }>();
  for (const i of edge) {
    const d = back.dist[i];
    if (!(d < limit)) continue;
    const r = Math.floor(i / W), c = i % W, key = Math.floor(r / BLOCK) * W + Math.floor(c / BLOCK);
    let bl = blocks.get(key);
    if (!bl) blocks.set(key, (bl = { r0: r - (r % BLOCK), c0: c - (c % BLOCK), min: Infinity, q: [] }));
    bl.q.push({ r, c, d });
    bl.min = Math.min(bl.min, d);
  }
  const k = minW * g.cellM;
  for (const p of P) {
    const pr = Math.floor(p.i / W), pc = p.i % W, room = C - p.d;
    for (const bl of blocks.values()) {
      const er = Math.max(0, bl.r0 - pr, pr - (bl.r0 + BLOCK - 1)), ec = Math.max(0, bl.c0 - pc, pc - (bl.c0 + BLOCK - 1));
      if (bl.min + k * Math.hypot(er, ec) >= room) continue;
      for (const q of bl.q) if (q.d + k * Math.hypot(q.r - pr, q.c - pc) < room) return false;
    }
  }
  return true;
}

// ─── band reads ───────────────────────────────────────────────────────────────

// openTiff per file URL, kept across calls (a worker lives across routes).
const tiffs = new Map<string, Promise<TiffInfo>>();

/** The file's TiffInfo (opened once per URL through `limit`), checked against the expected size and band count. */
async function openChecked(url: string, fetch: Fetcher, limit: Limiter, tw: number, th: number, nb: number): Promise<TiffInfo> {
  let info = tiffs.get(url);
  if (!info) {
    info = limit(() => openTiff(fetch));
    tiffs.set(url, info);
    info.catch(() => tiffs.delete(url));
  }
  const ti = await info.catch((err: unknown) => { throw new Error(`${url}: ${err instanceof Error ? err.message : err}`); });
  if (ti.width !== tw || ti.height !== th || ti.bands !== nb)
    throw new Error(`${url}: ${ti.width}×${ti.height}×${ti.bands}, expected ${tw}×${th}×${nb}`);
  return ti;
}

/**
 * The bbox's cells of the `wanted` bands (+ state, always), one bbox-sized array each;
 * a band not wanted is neither allocated nor decoded, and the OSM files are not read when
 * no OSM band is wanted. Tiles are decoded straight into the arrays; one limiter keeps
 * ≤ MAX_TILES_IN_FLIGHT tile reads (and file opens) in flight across every window of both files.
 */
export async function readBands(
  grid: Grid, wanted: Set<BandName>, present: Set<string>, io: RouteIO, box: Omit<Bbox, 'cells'>,
): Promise<Partial<Record<BandName, Uint8Array>>> {
  const { c0, r0, w, h } = box;
  const out: Partial<Record<BandName, Uint8Array>> = {};
  for (const name of [...PD_BANDS, ...OSM_BANDS]) if (wanted.has(name) || name === 'state') out[name] = new Uint8Array(w * h);
  const files = ([['pd', PD_BANDS], ['osm', OSM_BANDS]] as const)
    .map(([kind, names]) => ({ kind, names, dest: names.map((n) => out[n] ?? null) }))
    .filter((f) => f.dest.some(Boolean));
  const limit: Limiter = createLimiter(MAX_TILES_IN_FLIGHT);
  const S = grid.super;
  const jobs: Promise<void>[] = [];
  for (let sr = Math.floor(r0 / S); sr <= Math.floor((r0 + h - 1) / S); sr++) {
    for (let sc = Math.floor(c0 / S); sc <= Math.floor((c0 + w - 1) / S); sc++) {
      if (!present.has(`${sc}_${sr}`)) continue;
      const tw = Math.min(S, grid.cols - sc * S), th = Math.min(S, grid.rows - sr * S);
      for (const { kind, names, dest } of files) {
        const url = `${io.baseUrl}${kind}_${sc}_${sr}.tif`;
        jobs.push((async () => {
          const fetch: Fetcher = (s, e) => io.fetchRange(url, s, e);
          const ti = await openChecked(url, fetch, limit, tw, th, names.length);
          // Window of this super-tile inside the bbox, in the super-tile's own pixels.
          const lc0 = Math.max(c0, sc * S) - sc * S, lr0 = Math.max(r0, sr * S) - sr * S;
          const lc1 = Math.min(c0 + w, sc * S + tw) - sc * S, lr1 = Math.min(r0 + h, sr * S + th) - sr * S;
          const into = { bands: dest, width: w, col: sc * S + lc0 - c0, row: sr * S + lr0 - r0 };
          await readWindow(ti, fetch, lc0, lr0, lc1 - lc0, lr1 - lr0, { into, limit });
        })());
      }
    }
  }
  await Promise.all(jobs);
  return out;
}

/** Band values read sparsely: grid cell (col, row) → value, undefined where no block was read. */
export interface PathTiles { tiles: Map<string, Uint8Array>; value(band: BandName, col: number, row: number): number | undefined }

/**
 * `bands` for the blocks (the files' internal tiles, grid.block cells square) that the
 * polylines (EPSG:5070 metres) pass through — no bbox arrays: one block-sized array per band
 * and block, keyed `band:scol_srow:bx_by`. A block of a super-tile not in `present` is not read.
 * Tile reads and file opens run through one ≤ MAX_TILES_IN_FLIGHT limiter.
 */
export async function readPathTiles(
  grid: Grid, present: Set<string>, io: RouteIO, bands: readonly BandName[], lines: [number, number][][],
): Promise<PathTiles> {
  const S = grid.super, B = grid.block;
  const blocks = new Set<string>();
  for (const line of lines) {
    for (let s = 1; s < line.length; s++) {
      const [ax, ay] = line[s - 1], [bx, by] = line[s];
      const fx = (x: number) => (x - grid.x0) / grid.cell, fy = (y: number) => (grid.y0 - y) / grid.cell;
      traverse(fx(ax), fy(ay), fx(bx), fy(by), (col, row, len) => {
        if (len <= 0 || col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return;
        const sc = Math.floor(col / S), sr = Math.floor(row / S);
        blocks.add(`${sc}_${sr}:${Math.floor((col - sc * S) / B)}_${Math.floor((row - sr * S) / B)}`);
      });
    }
  }
  const tiles = new Map<string, Uint8Array>();
  const limit = createLimiter(MAX_TILES_IN_FLIGHT);
  const files = ([['pd', PD_BANDS], ['osm', OSM_BANDS]] as const)
    .map(([kind, names]) => ({ kind, names, take: bands.filter((b) => names.includes(b)) }))
    .filter((f) => f.take.length);
  const jobs: Promise<void>[] = [];
  for (const key of blocks) {
    const [st, bk] = key.split(':');
    if (!present.has(st)) continue;
    const [sc, sr] = st.split('_').map(Number), [tx, ty] = bk.split('_').map(Number);
    const tw = Math.min(S, grid.cols - sc * S), th = Math.min(S, grid.rows - sr * S);
    for (const { kind, names, take } of files) {
      const url = `${io.baseUrl}${kind}_${sc}_${sr}.tif`;
      jobs.push((async () => {
        const fetch: Fetcher = (s, e) => io.fetchRange(url, s, e);
        const ti = await openChecked(url, fetch, limit, tw, th, names.length);
        if (ti.tileWidth !== B || ti.tileHeight !== B) throw new Error(`${url}: blocks ${ti.tileWidth}×${ti.tileHeight}, grid.json says ${B}`);
        const tile = await limit(() => readTile(ti, fetch, tx, ty));
        const nb = names.length, n = B * B;
        for (const band of take) {
          const k = names.indexOf(band), out = new Uint8Array(n);
          for (let i = 0; i < n; i++) out[i] = tile[i * nb + k];
          tiles.set(`${band}:${key}`, out);
        }
      })());
    }
  }
  await Promise.all(jobs);
  return {
    tiles,
    value(band, col, row) {
      const sc = Math.floor(col / S), sr = Math.floor(row / S), lc = col - sc * S, lr = row - sr * S;
      const bx = Math.floor(lc / B), by = Math.floor(lr / B);
      return tiles.get(`${band}:${sc}_${sr}:${bx}_${by}`)?.[(lr - by * B) * B + (lc - bx * B)];
    },
  };
}

/** The bbox sampler plus the sparsely read bands; a cell of a super-tile not in `present` gives no values. */
function pathSampler(
  base: Sampler, grid: Grid, present: Set<string>, c0: number, r0: number, extra: readonly BandName[], tiles: PathTiles | null,
): Sampler {
  return {
    cellM: base.cellM, x0: base.x0, y0: base.y0,
    at(col, row) {
      const v = base.at(col, row);
      if (!v) return null;
      const gc = c0 + col, gr = r0 + row;
      if (!present.has(`${Math.floor(gc / grid.super)}_${Math.floor(gr / grid.super)}`)) return {};
      if (tiles) for (const b of extra) { const x = tiles.value(b, gc, gr); if (x !== undefined) v[b] = x; }
      return v;
    },
  };
}

// ─── cell inspector ───────────────────────────────────────────────────────────

export interface InspectRequest {
  lngLat: LngLat;
  preset: string;
  lineType: string;
  presetPatch?: PresetPatch;
  /** With all three, the reply says whether the cell is inside that search area (inMask). */
  from?: LngLat;
  to?: LngLat;
  bufferM?: number;
  uploads?: string[];
}

export interface InspectResult {
  values: Partial<Record<BandName, number>>;
  decoded: DecodedCell;
  explain: CellExplain;
  cell: [col: number, row: number];
  grid: { x0: number; y0: number; cell: number };
  inMask?: boolean;
}

/** What one inspecting caller keeps across calls: grid.json per cube, the last compile, and
 *  an LRU of decoded blocks (one block-sized array per band, keyed `band:scol_srow:bx_by`). */
export interface InspectCache {
  max: number;
  blocks: Map<string, Uint8Array>;
  meta: Map<string, GridMeta>;
  compiled: { key: string; k: ReturnType<typeof compile>; preset: RoutePreset } | null;
}
export const createInspectCache = (max = 64): InspectCache => ({ max, blocks: new Map(), meta: new Map(), compiled: null });

/** Every band's value at grid cell (col, row): only the blocks holding that cell are read,
 *  through the cache (a hit moves to the back; the oldest beyond `max` go). An absent super-tile is all 0. */
export async function readCell(
  grid: Grid, present: Set<string>, io: RouteIO, col: number, row: number, cache: InspectCache,
): Promise<Partial<Record<BandName, number>>> {
  const S = grid.super, B = grid.block;
  const sc = Math.floor(col / S), sr = Math.floor(row / S), lc = col - sc * S, lr = row - sr * S;
  const bx = Math.floor(lc / B), by = Math.floor(lr / B), at = (lr - by * B) * B + (lc - bx * B);
  const out: Partial<Record<BandName, number>> = {};
  if (!present.has(`${sc}_${sr}`)) {
    for (const b of [...PD_BANDS, ...OSM_BANDS]) out[b] = 0;
    return out;
  }
  const key = (band: BandName) => `${band}:${sc}_${sr}:${bx}_${by}`;
  const limit = createLimiter(MAX_TILES_IN_FLIGHT);
  const tw = Math.min(S, grid.cols - sc * S), th = Math.min(S, grid.rows - sr * S);
  await Promise.all(([['pd', PD_BANDS], ['osm', OSM_BANDS]] as const).map(async ([kind, names]) => {
    if (names.every((b) => cache.blocks.has(key(b)))) return;
    const url = `${io.baseUrl}${kind}_${sc}_${sr}.tif`;
    const fetch: Fetcher = (s, e) => io.fetchRange(url, s, e);
    const ti = await openChecked(url, fetch, limit, tw, th, names.length);
    if (ti.tileWidth !== B || ti.tileHeight !== B) throw new Error(`${url}: blocks ${ti.tileWidth}×${ti.tileHeight}, grid.json says ${B}`);
    const tile = await limit(() => readTile(ti, fetch, bx, by));
    const nb = names.length, n = B * B;
    names.forEach((band, k) => {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = tile[i * nb + k];
      cache.blocks.set(key(band), a);
    });
  }));
  for (const band of [...PD_BANDS, ...OSM_BANDS]) {
    const a = cache.blocks.get(key(band));
    if (!a) continue;
    cache.blocks.delete(key(band));
    cache.blocks.set(key(band), a);
    out[band] = a[at];
  }
  for (const k of cache.blocks.keys()) {
    if (cache.blocks.size <= cache.max) break;
    cache.blocks.delete(k);
  }
  return out;
}

/** One cell's decoded bands and the method's explanation of its weight (inspect.ts). The
 *  preset and patch pass the same checks as a solve's. Every failure is an Outcome. */
export async function inspect(req: InspectRequest, io: RouteIO, cache: InspectCache, windows?: WindowCache): Promise<Outcome<InspectResult>> {
  try {
    if (!req || typeof req !== 'object' || !isLngLat(req.lngLat)) return fail('lngLat must be [lng, lat]');
    const base = typeof req.preset === 'string' ? routePreset(req.preset) : undefined;
    if (!base) return fail(`unknown preset "${String(req.preset)}"`);
    const patched = validatePresetPatch(base, req.presetPatch);
    if (!patched.ok) return patched;
    const preset = patched.result;
    if (typeof req.lineType !== 'string' || !Object.hasOwn(preset.line_types, req.lineType))
      return fail(`preset ${preset.id} has no line type "${String(req.lineType)}"`);
    const layers = uploadsFor(req.uploads, req.presetPatch, io.uploads);
    if (typeof layers === 'string') return fail(layers);
    let meta = cache.meta.get(io.baseUrl);
    if (!meta) {
      const m = readGridJson(await io.fetchJson(io.baseUrl + 'grid.json'));
      if (typeof m === 'string') return fail(m);
      cache.meta.set(io.baseUrl, (meta = m));
    }
    const { grid } = meta;
    const [x, y] = albersForward(req.lngLat[0], req.lngLat[1]);
    const fc = (x - grid.x0) / grid.cell, fr = (grid.y0 - y) / grid.cell;
    if (!(fc >= 0 && fc < grid.cols && fr >= 0 && fr < grid.rows)) return fail('the point is outside the routing grid');
    const col = Math.floor(fc), row = Math.floor(fr);
    const offGrid = layers.find((l) => !sameGrid(l.grid, grid));
    if (offGrid) return fail(`upload layer ${offGrid.hash} is on another grid than the cube's`);
    const values = await readCell(grid, meta.present, io, col, row, cache);
    // upl_<hash>: the held window's rasterised cell when it holds this band there, else the layer's own test.
    const held = windows?.held;
    layers.forEach((l) => {
      const b = uploadBand(l.hash), a = held?.bands[b];
      const lc = col - (held?.box.c0 ?? 0), lr = row - (held?.box.r0 ?? 0);
      values[b] = a && lc >= 0 && lr >= 0 && lc < held!.box.w && lr < held!.box.h ? a[lr * held!.box.w + lc] : +insideCell(l, col, row);
    });
    const key = JSON.stringify([io.baseUrl, req.preset, req.lineType, req.presetPatch ?? null]);
    if (cache.compiled?.key !== key) {
      const consts = { isoreg: { codes: Object.fromEntries(meta.isoreg) }, landval: meta.landval };
      cache.compiled = { key, k: compile(preset, req.lineType, consts), preset };
    }
    const { k } = cache.compiled;
    const result: InspectResult = {
      values, decoded: decodeCell(values, meta), explain: explainCell(k, values, preset, req.lineType),
      cell: [col, row], grid: { x0: grid.x0, y0: grid.y0, cell: grid.cell },
    };
    if (isLngLat(req.from) && isLngLat(req.to) && typeof req.bufferM === 'number' && req.bufferM > 0) {
      const f = (p: LngLat) => { const [px, py] = albersForward(p[0], p[1]); return [(px - grid.x0) / grid.cell, (grid.y0 - py) / grid.cell]; };
      const a = f(req.from), b = f(req.to), dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy || 1;
      const px = col + 0.5, py = row + 0.5;
      const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / dd));
      result.inMask = Math.hypot(px - a[0] - u * dx, py - a[1] - u * dy) <= req.bufferM / grid.cell;
    }
    return { ok: true, result };
  } catch (err) {
    return fail(`inspect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── exact crossings (on demand) ──────────────────────────────────────────────

export interface ExactCrossingsRequest { polylines: [number, number][][]; lengthsMi: number[] }
export interface ExactCrossingsResult {
  routes: ExactResult[];                 // one per polyline, in order
  screening?: RouteScreening[];          // optional aviation observations for the same paths
  status: ReportRead['status'];
  exact: CrossingPoint['kind'][];        // kinds whose family read ok
  note?: string;                         // the failed families' reasons
}
/** Time the report read may take before unfinished families fall back. */
export const EXACT_BUDGET_MS = 30_000;
const MAX_EXACT_POLYLINES = 4, MAX_EXACT_VERTICES = 20_000;
const FAMILY_KINDS: Record<Family, CrossingPoint['kind'][]> =
  { river: ['river'], road: ['road'], rail: ['rail'], pipeline: ['pipeline'], line: ['line230', 'line100'] };

/** Exact road / river / rail / pipeline / line crossings of up to 4 EPSG:5070 polylines (the panel sends
 *  the shown route), from the report GeoParquet under io.reportUrl (report-read.ts → crossings-exact.ts). A family
 *  whose files fail is left out of `exact`. Every failure is an Outcome. */
export async function exactRouteCrossings(req: ExactCrossingsRequest, io: RouteIO): Promise<Outcome<ExactCrossingsResult>> {
  try {
    if (!req || typeof req !== 'object' || !Array.isArray(req.polylines) || !Array.isArray(req.lengthsMi))
      return fail('polylines and lengthsMi must be arrays');
    const { polylines, lengthsMi } = req;
    if (polylines.length < 1 || polylines.length > MAX_EXACT_POLYLINES) return fail(`1 to ${MAX_EXACT_POLYLINES} polylines`);
    if (lengthsMi.length !== polylines.length) return fail('one length per polyline');
    for (const p of polylines) {
      if (!Array.isArray(p) || p.length < 2 || p.length > MAX_EXACT_VERTICES) return fail(`a polyline has 2 to ${MAX_EXACT_VERTICES} vertices`);
      if (!p.every((v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])))
        return fail('vertices must be [x, y] finite numbers');
    }
    if (!lengthsMi.every((l) => typeof l === 'number' && Number.isFinite(l) && l >= 0)) return fail('lengths must be finite numbers ≥ 0');
    // Bound projected extents and densification before any corridor allocation.
    let samples = 0;
    for (const p of polylines) {
      let lengthM = 0;
      for (let i = 0; i < p.length; i++) {
        if (Math.abs(p[i][0]) > 10_000_000 || Math.abs(p[i][1]) > 10_000_000) return fail('projected coordinates exceed report bounds');
        if (i) {
          const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
          lengthM += d;
          samples += Math.max(1, Math.ceil(d / 2000));
        }
      }
      if (lengthM > 20_000_000 || samples > 40_000) return fail('report path exceeds geometry budget');
    }
    if (typeof io.reportUrl !== 'string' || !io.reportUrl) return fail('no report data');
    const deadline = Date.now() + EXACT_BUDGET_MS;
    const reportIO = { fetchRange: io.fetchRange.bind(io), byteLength: io.byteLength?.bind(io), reportUrl: io.reportUrl };
    const [read, screening] = await Promise.all([
      readReport(reportIO, polylines, deadline),
      readRouteScreening(polylines, reportIO, deadline).catch(() => polylines.map(() => ({
        aviation: { status: 'unavailable' as const, reason: 'aviation observations unavailable' },
      }))),
    ]);
    const routes = exactCrossings(polylines, read.features, { toLngLat: albersInverse, lengthsMi });
    const fams = Object.keys(FAMILY_KINDS) as Family[];
    const exact = fams.filter((f) => read.status[f]?.ok).flatMap((f) => FAMILY_KINDS[f]);
    const notes = fams.filter((f) => !read.status[f]?.ok).map((f) => `${f}: ${read.status[f]?.note ?? 'not read'}`);
    return { ok: true, result: { routes, screening, status: read.status, exact, ...(notes.length ? { note: notes.join('; ') } : {}) } };
  } catch (err) {
    return fail(`exact crossings failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
