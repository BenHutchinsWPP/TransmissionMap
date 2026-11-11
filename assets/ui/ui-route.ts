// ─── Route planner pane ──────────────────────────────────────────────────────
// Role: the Route tab of the bottom drawer (lazy chunk opened by
//       route-panel-open.ts through openRoutePanel, which first shows the usage
//       notice on every open — notice-gate.ts; the chat's routeForChat shows it
//       too when the pane is not open, and refuses on Cancel). Owns the one RouteSession of an open pane:
//       - layout: the input column (route-inputs.ts) left, `.rp-main` right: an idle
//         hint, the 5-step solve progress (aria-live, elapsed seconds, Cancel), the
//         engine's refusal, or the result (sub-tab tablist + optimality badge + Map ▾
//         menu, then the active tab from route-tabs/*.ts);
//       - solving: RouteRequest from the inputs (a `custom:<id>` method is its base
//         preset + its patch, with the session patch on top), cancel-before-solve only
//         when a call of ours is pending, a call counter that drops stale outcomes; Find
//         route asks for the profile only. A re-solve of the shown route (same ends)
//         keeps the result view mounted with a "Re-solving… step · Cancel" chip and
//         refreshes the header and the active tab in place (RouteTab.update, else
//         dispose + render); a refusal then shows in that chip over the kept route. New
//         ends get the full progress view, a camera fit to A–B, and clear the map, ghost
//         and `previous`. solve() is true only when a new result landed;
//       - the drawer header actions (Export ▾ GeoJSON / CSV, Report, ＋ My Data, Batch…;
//         on a phone one ⋯ menu). Batch… opens route-batch.ts (dynamic import only) in
//         `.rp-main`; `p.batch` holds its disposer and closing the pane or the view
//         cancels a running batch;
//       - the map: every source and layer id starts `rp-` and is added or removed, never
//         visibility-toggled: search-area outline + A–B chord while solving, the route cut
//         into its profile runs and coloured by cost ×, driver or plain, a hover readout,
//         alternatives, the similar-cost areas through one canvas source whose alpha is
//         rewritten from the worker's untouched RGBA on a threshold change, crossing
//         markers, the profile marker and the ghost line; a legend card in the app's
//         #legendContainer;
//       - "Make Alt n the result": the alternative is shown (session.fromAlt) and the
//         result with the lowest routing score kept (session.optimal) as "Lowest routing score";
//       - the last method, line type, colour mode and surface choice are saved
//         (route-prefs.ts) and start the next route;
//       - the cell inspector: an Inspect toggle in the Map ▾ menu (key "i"; Esc closes the
//         pinned card first); pointing at the map asks the worker for that 250 m cell
//         (route-open.ts inspectCell) for a one-line hover preview, a click or tap pins a
//         card (`.rp-icard`); a hole in the similar-cost areas runs the same inspect even
//         with Inspect off, prefixed "Not within N % of the lowest routing score —"; while on, a map tap
//         opens no feature popup;
//       - "Show cell weights": Find asks for `weightImage` (in the shown mode) while it is
//         on; switched on after a result, one solve merges only the image. Drawn through
//         one canvas source `rp-weight` under the route, with a legend block per mode. A
//         mode switch and valid Method edits (ctx.previewPatch, debounced by
//         PREVIEW_DEBOUNCE_MS) repaint from the worker's held band window
//         (route-open.ts repaintWeight; replies ordered by a counter, stale ones dropped);
//         pane close and new ends release the window (dropWindow);
//       - highlighted Method rows (ctx.highlightRows, session.highlight): a 4th overlay mode
//         'rows' on `rp-weight`, repainted by route-open.ts repaintRows over the held
//         window; picks clear when the base preset changes;
//       - "List crossings by name" (ctx.listExactCrossings): the shown result's path goes to
//         route-open.ts exactCrossings; the reply is kept as session.exact only while its
//         request token is current; a refusal is session.exactError. Every new shown
//         result clears both;
//       - RouteTabContext, the only way the tabs reach any of this;
//       - routeForChat, the map chat's planRoute (through route-panel-open.ts): opens the
//         pane in the background, refuses while a solve of ours runs, checks the line type
//         and the ends ([lng, lat] in the contiguous US; a name only by exact
//         case-insensitive match, else ≤ 5 candidates), solves on the visitor's path,
//         never saves prefs (chatDriving), and returns chat-summary.ts's summary.
//       Closing the pane (× / Esc in the drawer) disposes all of it. Session only:
//       nothing goes in the link or on the undo stack.
// Deps: ui-table.ts (openRoute, routePanel, routeActions, setRouteTall, drawerPadding),
//       route-inputs.ts, route-tabs/method.ts (dropUploads), route/route-open.ts (routeLine, cancelRoute, inspectCell, repaintWeight, repaintRows, dropWindow, exactCrossings),
//       route/route.ts (searchBufferM, SURFACE_PALETTE, WEIGHT_PALETTE, COST_PALETTE, types), route/inspect.ts (textOf, fmtX, presentFacts), colors/route-constraints.ts (palettes),
//       utils/utils-dom.ts (h, ht), route/grid.ts (albersForward), route/cost.ts (greatCircleM), route/surface-image.ts (palette types),
//       route/preset-patch.ts (validatePresetPatch, limits), route-request.ts (the request builder), dataset-query.ts (Outcome, type only),
//       notice-gate.ts (noticeAccepted, forgetNotice on close) + notice-dialog.ts (showNotice): the usage notice, asked on every open (the chat's planRoute shows it too),
//       route/custom-presets.ts, route/route-prefs.ts, route/categories.ts, registry/route-presets.ts,
//       popup.ts (setRouteTapClaims: a hole tap opens no feature popup),
//       map-input.ts (onMapPoint, onMapTap, onMapPointLeave), state-bus.ts (lang:changed), state.ts, ui-legends.ts (updateLegends),
//       ui-menubar.ts (positionColorMenu: the Map ▾ menu flips above its button near the screen's foot),
//       overlay-layers.ts (setGeojson, removeOverlay), user-data/user-data-export.ts
//       (downloadFile), route-report-model.ts (costCsv, fmtMoney), user-data/user-data.ts (dynamic: addImportedLayer),
//       route-report.ts (dynamic), route-tabs/*.ts (incl. colours.ts, chat-summary.ts), route/snap.ts (kvFloor,
//       searchSubstations), route-panel-open.ts (ChatRouteRequest, type only), i18n (t), route-panel.css.

import type { CanvasSource, FilterSpecification, LayerSpecification } from 'maplibre-gl';
import './route-panel.css';
import { openRoute, routePanel, routeActions, setRouteTall, drawerPadding } from './ui-table.js';
import { mountInputs, type End, type InputsHandle } from './route-inputs.js';
import type { ChatRouteRequest } from './route-panel-open.js';
import { chatSummary, cleanName, type ChatRouteEnd, type RouteSummary } from './route-tabs/chat-summary.js';
import { kvFloor, searchSubstations, type SnapHit, type SubstationIndex } from '../route/snap.js';
import { routeLine, cancelRoute, inspectCell, repaintWeight, repaintRows, dropWindow, exactCrossings } from '../route/route-open.js';
import {
  searchBufferM, COST_BARRIER, COST_PALETTE, SURFACE_PALETTE, WEIGHT_BARRIER, WEIGHT_PALETTE, HIGHLIGHT_PALETTE, NO_WINDOW_REASONS,
  type InspectRequest, type InspectResult, type OverlayMode, type RouteRequest, type RouteResult, type RouteStep, type RouteSurface, type RowPick, type RowsImage, type WeightImage, type WeightMode,
} from '../route/route.js';
import { fmtX, presentFacts, textOf, type Fact } from '../route/inspect.js';
import { CONCERNS, CONSTRAINT_PALETTE, LAND_MANAGER_PALETTE } from '../../src/colors/route-constraints.js';
import { albersForward } from '../route/grid.js';
import type { SurfaceImage } from '../route/surface-image.js';
import type { Outcome } from '../dataset-query.js';
import { greatCircleM } from '../route/cost.js';
import { createCustomPresetStore, presetLabel } from '../route/custom-presets.js';
import { categoryLabelKey } from '../route/categories.js';
import { localBudget, parseUploadBudget, uploadHashes, type PresetPatch } from '../route/preset-patch.js';
import { makeRequestBuilder } from './route-request.js';
import { loadRoutePrefs, localStorageAdapter, saveRoutePrefs, type RoutePrefs } from '../route/route-prefs.js';
import { ROUTE_PRESETS, routePreset } from '../../src/registry/route-presets.js';
import { setRouteTapClaims } from '../popup.js';
import { onMapPoint, onMapTap, onMapPointLeave, type MapPointerEvent, type Unsubscribe } from '../map-input.js';
import { on } from '../state-bus.js';
import { state } from '../state.js';
import { getLocale, t } from '../../src/i18n/index.js';
import { forgetNotice, noticeAccepted, ROUTE_NOTICE_VERSION } from './notice-gate.js';
import { showNotice } from './notice-dialog.js';
import { positionColorMenu } from './ui-menubar.js';
import { downloadFile } from '../user-data/user-data-export.js';
import { badge } from './route-tabs/widgets.js';
import { costCsv, fmtMoney } from './route-report-model.js';
import { setGeojson, removeOverlay } from './overlay-layers.js';
import { PLAIN } from './route-tabs/colours.js';
import type { ColourMode, PreviousRoute, RouteInputs, RouteSession, RouteSubTab, RouteTab, RouteTabContext, SolveSpec, SurfaceThreshold } from './route-tabs/types.js';
import { updateLegends } from './ui-legends.js';
import summaryTab from './route-tabs/summary.js';
import costTab from './route-tabs/cost.js';
import profileTab from './route-tabs/profile.js';
import crossingsTab, { pathKey, shownExact } from './route-tabs/crossings.js';
import alternativesTab, { otherRoutes } from './route-tabs/alternatives.js';
import methodTab, { methodOf, dropUploads } from './route-tabs/method.js';
import { h, ht } from '../utils/utils-dom.js';

type LngLat = [number, number];
type FC = GeoJSON.FeatureCollection;

const TABS: RouteTab[] = [summaryTab, costTab, profileTab, crossingsTab, alternativesTab, methodTab];
/** The input column's fold rule (route-inputs.ts): a phone or short screen, or a drawer < 900 px. */
const COMPACT = '(max-width: 640px), (max-height: 500px)';
const FOLD_W = 900;
const STEPS: RouteStep[] = ['read', 'surfaces', 'solve', 'prove', 'reduce'];
const INSPECT_DEBOUNCE_MS = 120;
/** A Method edit's overlay repaint waits this long after the last edit (before the 600 ms live solve). */
const PREVIEW_DEBOUNCE_MS = 150;

/** Cost × ramp ×1.0 → ×2.5: amber → fuchsia → deep purple, clear of the voltage reds, blues and greens. */
const COST_RAMP: [number, string][] = [[1.0, '#eab308'], [1.375, '#f59e0b'], [1.75, '#c026d3'], [2.125, '#7e22ce'], [2.5, '#3b0764']];
const NO_DRIVER = '#a8a29e';
const DRIVER_FIXED: Record<string, string> = {
  'terrain:slope': '#92400e', slope: '#92400e', 'terrain:landcover': '#4d7c0f', landcover: '#4d7c0f',
  protection: '#0e7490', protect: '#0e7490', parallel: '#4338ca', adj: '#4338ca', wildfire: '#db2777', whpclass: '#db2777',
};
const DRIVER_EXTRA = ['#c026d3', '#0f172a', '#eab308', '#06b6d4', '#64748b', '#9a3412'];
/** Crossing markers start here: at a whole-route zoom they would hide the route's colours. */
const CROSS_MINZOOM = 8;
const CROSS_COLOURS: Record<string, [string, string]> = {   // kind → [fill, stroke]
  river: ['#0ea5e9', '#ffffff'], road: ['#ffffff', '#334155'], rail: ['#334155', '#ffffff'],
  pipeline: ['#a16207', '#ffffff'], line230: ['#6b21a8', '#ffffff'], line100: ['#a78bfa', '#ffffff'],
};

/** Paint order, bottom to top; a layer is inserted below the next one present. */
const ORDER = ['rp-weight', 'rp-surface', 'rp-area-fill', 'rp-area-line', 'rp-chord', 'rp-ghost-casing', 'rp-ghost', 'rp-alts', 'rp-alts-label',
  'rp-route-casing', 'rp-route', 'rp-cross', 'rp-marker', 'rp-marker-label'];
const SOURCES = ['rp-weight', 'rp-surface', 'rp-area', 'rp-chord', 'rp-ghost', 'rp-alts', 'rp-route', 'rp-cross', 'rp-marker'];

const presetStore = createCustomPresetStore({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
});

// ─── pure helpers (exported for tests) ───────────────────────────────────────

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function costColour(x: number): string {
  const v = Math.min(COST_RAMP[COST_RAMP.length - 1][0], Math.max(COST_RAMP[0][0], x));
  let i = 0;
  while (i < COST_RAMP.length - 2 && v > COST_RAMP[i + 1][0]) i++;
  const [x0, c0] = COST_RAMP[i], [x1, c1] = COST_RAMP[i + 1];
  const u = (v - x0) / (x1 - x0);
  const a = hexRgb(c0), b = hexRgb(c1);
  return '#' + a.map((c, k) => Math.round(c + (b[k] - c) * u).toString(16).padStart(2, '0')).join('');
}

/** Cumulative great-circle metres along `coords`. */
function cumulative(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + greatCircleM(coords[i - 1], coords[i]));
  return cum;
}
function pointAt(coords: LngLat[], cum: number[], d: number): LngLat {
  if (d <= 0) return coords[0];
  const n = coords.length - 1;
  if (d >= cum[n]) return coords[n];
  let i = 1;
  while (cum[i] < d) i++;
  const u = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * u, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * u];
}
/** The part of `path` between mile fractions f0 and f1 of its length. */
export function slicePath(path: GeoJSON.LineString, f0: number, f1: number): LngLat[] {
  const coords = path.coordinates as LngLat[];
  const cum = cumulative(coords);
  const total = cum[cum.length - 1], d0 = f0 * total, d1 = f1 * total;
  const out: LngLat[] = [pointAt(coords, cum, d0)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(coords[i]);
  out.push(pointAt(coords, cum, d1));
  return out;
}
function pointAtMile(r: RouteResult, mi: number): LngLat {
  const coords = r.path.coordinates as LngLat[];
  const cum = cumulative(coords);
  return pointAt(coords, cum, (r.lengthMi ? mi / r.lengthMi : 0) * cum[cum.length - 1]);
}

/** Driver key → colour: fixed hues for the common categories, the rest in order of appearance. */
function driverColours(r: RouteResult): Map<string | null, string> {
  const out = new Map<string | null, string>();
  let extra = 0;
  for (const run of r.profile?.runs ?? []) {
    if (out.has(run.driver)) continue;
    out.set(run.driver, run.driver === null ? NO_DRIVER : DRIVER_FIXED[run.driver] ?? DRIVER_EXTRA[extra++ % DRIVER_EXTRA.length]);
  }
  return out;
}

/** The route as one feature per profile run (or one plain feature without a profile). */
export function routeFeatures(r: RouteResult, mode: ColourMode): FC {
  const runs = r.profile?.runs ?? [];
  if (!runs.length) return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: r.path, properties: { color: PLAIN } }] };
  const drivers = driverColours(r);
  const weight = runs.reduce((s, x) => s + (x.mi1 - x.mi0) * x.costX, 0) || 1;
  const L = r.lengthMi || runs[runs.length - 1].mi1 || 1;
  return {
    type: 'FeatureCollection',
    features: runs.map((run, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: slicePath(r.path, run.mi0 / L, run.mi1 / L) },
      properties: {
        i, mi0: run.mi0, mi1: run.mi1, costX: run.costX, driver: run.driver ?? '',
        usdNom: (r.cost.lineUsdNominal * (run.mi1 - run.mi0) * run.costX) / weight,
        color: mode === 'plain' ? PLAIN : mode === 'driver' ? drivers.get(run.driver) ?? NO_DRIVER : costColour(run.costX),
      },
    })),
  };
}

/** An approximate search-area outline: a capsule `bufM` either side of segment a–b. */
export function capsule(a: LngLat, b: LngLat, bufM: number, steps = 24): GeoJSON.Polygon {
  const lat0 = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const kx = 111_320 * Math.cos(lat0), ky = 110_574;
  const A = [a[0] * kx, a[1] * ky], B = [b[0] * kx, b[1] * ky];
  const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
  const ring: LngLat[] = [];
  const arc = (c: number[], from: number) => {
    for (let k = 0; k <= steps; k++) {
      const th = from + (Math.PI * k) / steps;
      ring.push([(c[0] + bufM * Math.cos(th)) / kx, (c[1] + bufM * Math.sin(th)) / ky]);
    }
  };
  arc(B, ang - Math.PI / 2);
  arc(A, ang + Math.PI / 2);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function bounds(points: LngLat[]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [[x0, y0], [x1, y1]];
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'point';
const endName = (inp: RouteInputs | null, end: 'a' | 'b') => inp?.[end]?.hit?.name ?? t('route.in.rawPoint');

// ─── the pane ────────────────────────────────────────────────────────────────

interface Pane {
  session: RouteSession;
  prefs: RoutePrefs;
  ctx: RouteTabContext;
  inputs: InputsHandle;
  main: HTMLElement;
  view: string;
  call: number;
  pending: number;              // our routeLine calls not yet answered
  timer?: ReturnType<typeof setInterval>;
  hoverOff: Unsubscribe;
  legend: HTMLElement;          // a card in the app's #legendContainer (stacks with the other legends)
  lgLabel: HTMLElement;         // its title row (the part a phone shows collapsed)
  lgBody: HTMLElement;
  tip: HTMLElement;
  activeTab: RouteTab | null;
  refine: boolean;              // the solve running re-solves the shown route: result view stays, header chip
  refineError: string | null;   // a refine solve's refusal, shown in the header chip
  surf: { src: RouteSurface; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; cls: Uint8Array; img: ImageData } | null;
  markerAt: { mi: number; label?: string } | null;
  menu: HTMLElement | null;
  menuOff?: () => void;         // removes the export menu's outside-press listener
  /** The header's Map ▾ menu: the focused item's index while open (kept across a header rebuild), its
   *  document listeners' remover, and the current menu's opener. */
  mapMenu: { at: number | null; off?: () => void; open?: (at: number) => void };
  leaveOff: Unsubscribe;
  itip: HTMLElement;            // the inspect hover preview (one line)
  icard: HTMLElement;           // the pinned inspect card
  dockRo?: ResizeObserver;      // keeps the docked card above a resized drawer
  pin: { out: Outcome<InspectResult>; at: { x: number; y: number }; hole: boolean } | null;
  tapOff: Unsubscribe;
  inspectOn: boolean;
  escOff?: () => void;          // removes Inspect's Esc listener
  insp: { timer?: ReturnType<typeof setTimeout>; seq: number; pinSeq: number; last: { key: string; out: Outcome<InspectResult> } | null; grid: InspectResult['grid'] | null };
  showWeight: boolean;
  weightLoading: boolean;
  weightDeferred: boolean;      // the weight fetch waits for a solve of ours to settle (or was cancelled by one)
  weightError: string | null;
  weight: { src: WeightImage | RowsImage; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; data: ImageData; mode: OverlayMode } | null;
  weightMode: OverlayMode;
  rowsImg: RowsImage | null;    // the Method grid's highlight image (never on the result)
  rowsTried: boolean;           // one weight fetch has been spent on a missing window for this highlight
  rowsKey: string;              // the route ends + line type rowsTried was last reset for
  hlBase: string | null;        // the base preset id the picks belong to
  /** Live repaint: debounce timer, reply counter (bumped when the ends move, so late replies drop), the last repaint's ms. */
  rp: { timer?: ReturnType<typeof setTimeout>; seq: number; ms: number | null };
  chatDriving: boolean;         // the chat is setting the inputs: rememberPrefs saves nothing
  chatLineType?: string;        // the line type the chat set; not saved as a pref until the visitor picks one
  batch: { dispose(): void } | null;   // the open Batch view (route-batch.ts), which owns `.rp-main` meanwhile
}
let pane: Pane | null = null;

const baseOf = (id: string): string | null => methodOf(id)?.base ?? null;

function newSession(prefs: RoutePrefs): RouteSession {
  return {
    inputs: { a: null, b: null, lineType: prefs.lineType, presetId: prefs.presetId, patch: null },
    status: { kind: 'idle' }, result: null, resultInputs: null, previous: null,
    altsSolving: false, altsError: null, tab: 'summary', colour: prefs.colour, threshold: 0.10,
    showSurface: prefs.showSurface, dollars: 'y2025', liveTuning: true,
    crossingKinds: ['river', 'road', 'rail'], altStretch: prefs.altStretch, snapKm: prefs.snapKm, highlight: [],
  };
}

/** The visitor's last method, line type, colour mode and surface choice become the defaults for the next route. */
function rememberPrefs(p: Pane): void {
  if (p.chatDriving) return;
  const s = p.session, was = p.prefs;
  if (p.chatLineType !== undefined && s.inputs.lineType !== p.chatLineType) p.chatLineType = undefined;
  const lineType = s.inputs.lineType === p.chatLineType ? was.lineType : s.inputs.lineType;
  const next: RoutePrefs = { ...was, presetId: s.inputs.presetId, lineType, colour: s.colour, showSurface: s.showSurface };
  if (next.presetId === was.presetId && next.lineType === was.lineType && next.colour === was.colour && next.showSurface === was.showSurface) return;
  saveRoutePrefs(localStorageAdapter(), next);
  p.prefs = loadRoutePrefs(localStorageAdapter());
}

/** Open the Route pane (creating its session on first open). `at` fills one end and
 *  starts picking the other when that one is empty. */
export function openRoutePanel(at?: { lngLat: LngLat; end: 'A' | 'B' }): void {
  if (!noticeAccepted('route', ROUTE_NOTICE_VERSION)) {
    void showNotice('route').then((ok) => { if (ok) openRoutePanel(at); });
    return;
  }
  if (!pane) pane = createPane();
  else openRoute(dispose);
  const p = pane;
  if (!at) return;
  void p.inputs.setEnd(at.end, at.lngLat).then(() => {
    if (pane !== p) return;
    const other = at.end === 'A' ? 'B' : 'A';
    if (!(other === 'A' ? p.session.inputs.a : p.session.inputs.b)) p.inputs.startPick(other);
  });
}

function createPane(background = false): Pane {
  openRoute(dispose, undefined, { background });
  const host = routePanel();
  const root = h('div', 'rp');
  const left = h('div', 'rp-inputs');
  const main = h('div', 'rp-main');
  root.append(left, main);
  host.replaceChildren(root);
  const prefs = loadRoutePrefs(localStorageAdapter());
  const session = newSession(prefs);
  const { legend, label: lgLabel, body: lgBody } = legendCard();
  const tip = h('div', 'rp-tip');
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  const itip = h('div', 'rp-tip rp-itip');
  itip.hidden = true;
  itip.setAttribute('aria-hidden', 'true');
  const icard = h('div', 'rp-icard');
  icard.hidden = true;
  icard.id = 'rp-icard';
  icard.setAttribute('role', 'dialog');
  icard.setAttribute('aria-labelledby', 'rp-ic-head');
  icard.tabIndex = -1;
  const lc = document.getElementById('legendContainer');
  if (lc) lc.prepend(legend); else state.map?.getContainer().append(legend);
  state.map?.getContainer().append(tip, itip, icard);
  const p: Pane = {
    session, prefs, ctx: null as unknown as RouteTabContext, inputs: null as unknown as InputsHandle, main, view: '', call: 0, pending: 0,
    hoverOff: onMapPoint(onHover), legend, lgLabel, lgBody, tip, activeTab: null, refine: false, refineError: null,
    surf: null, markerAt: null, menu: null, mapMenu: { at: null },
    leaveOff: onMapPointLeave(() => { if (pane) hideInspect(pane); tip.hidden = true; }),
    itip, icard, pin: null, tapOff: onMapTap(onTap), inspectOn: false, insp: { seq: 0, pinSeq: 0, last: null, grid: null },
    showWeight: false, weightLoading: false, weightDeferred: false, weightError: null, weight: null,
    weightMode: 'route', rowsImg: null, rowsTried: false, rowsKey: '', hlBase: baseOf(session.inputs.presetId), rp: { seq: 0, ms: null }, chatDriving: false, batch: null,
  };
  setRouteTapClaims((e) => holeTap(p, e));
  root.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (e.key !== 'i' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
    if (!p.session.result) return;
    e.preventDefault();
    setInspect(p, !p.inspectOn);
  });
  pane = p;
  p.ctx = makeContext(p);
  p.inputs = mountInputs(left, session, {
    onFind: () => {
      void solve(p, { patch: session.inputs.patch, profile: true, alternatives: 0, surface: false }).then((landed) => {
        if (landed && pane === p && p.prefs.autoAlternatives && !session.fromAlt) void findAlternatives(p);
      });
    },
    onChange: () => { rememberPrefs(p); syncHighlightBase(p); renderMain(p); renderStrip(p); },
    onEditMethod: () => { session.tab = 'method'; if (session.result) renderMain(p, true); },
  });
  renderMain(p, true);
  renderActions(p);
  syncFold(p);
  return p;
}

/** Before a result the inputs stay open (Find must be reachable, also on a phone); with a
 *  result a phone or a narrow drawer folds them to the one-line strip, Edit unfolds. */
function syncFold(p: Pane): void {
  const w = p.main.parentElement?.clientWidth ?? 0;
  const narrow = (typeof matchMedia === 'function' && matchMedia(COMPACT).matches) || (w > 0 && w < FOLD_W);
  p.inputs.setFolded(!!p.session.result && narrow);
}

function dispose(): void {
  const p = pane;
  if (!p) return;
  pane = null;
  forgetNotice('route');   // the notice is asked again on the next open
  p.batch?.dispose();
  p.batch = null;
  p.call++;
  if (p.pending > 0) cancelRoute();
  clearTimeout(p.rp.timer);
  p.rp.seq++;
  dropWindow();
  dropUploads();
  clearInterval(p.timer);
  p.hoverOff();
  p.leaveOff();
  p.tapOff();
  setRouteTapClaims(null);
  setInspect(p, false);
  closeCard(p);
  p.dockRo?.disconnect();
  p.itip.remove();
  p.icard.remove();
  p.inputs.destroy();
  p.activeTab?.dispose?.();
  clearMap(p, true);
  p.legend.remove();
  updateLegends();
  p.tip.remove();
  p.menuOff?.();
  p.menu?.remove();
  p.mapMenu.off?.();
  routeActions().replaceChildren();
  routePanel().replaceChildren();
}

// ─── solving ─────────────────────────────────────────────────────────────────

const { methodFor, requestFor } = makeRequestBuilder(() => presetStore.list());

const endsKey = (i: RouteInputs) => JSON.stringify([i.a?.lngLat, i.b?.lngLat, i.lineType]);
/** A new highlight, mode or route (ends or line type) earns one window fetch; a re-solve of the same route does not. */
function resetRowsTried(p: Pane, i: RouteInputs): void { p.rowsTried = false; p.rowsKey = endsKey(i); }

/** One routeLine call of ours, counted so a cancel happens only while one is pending. */
async function run(p: Pane, req: RouteRequest, onStep?: (s: RouteStep) => void) {
  p.pending++;
  try { return await routeLine(req, onStep); } finally {
    p.pending--;
    // After the caller has handled its outcome (a macrotask later), so a solve's result is in.
    if (p.pending === 0 && p.weightDeferred) setTimeout(() => weightSettled(p), 0);
  }
}
function cancelOurs(p: Pane): void { if (p.pending > 0) cancelRoute(); }

/** An engine refusal as the visitor reads it: the upload-budget one in the locale, other text as it is. */
function shownReason(reason: string): string {
  const b = parseUploadBudget(reason);
  return b ? t('route.err.uploadBudget', localBudget(b, getLocale())) : reason;
}

/** True only when a new result landed (not on a cancel, a refusal or a superseded solve). */
async function solve(p: Pane, spec: SolveSpec): Promise<boolean> {
  const s = p.session;
  const req = requestFor(s.inputs, spec, p.showWeight ? p.weightMode : null);
  if (typeof req === 'string') { s.status = { kind: 'error', reason: req }; renderMain(p, true); return false; }
  const my = ++p.call;
  hideInspect(p);
  closeCard(p);
  p.insp.last = null;
  cancelOurs(p);
  const inputs: RouteInputs = { ...s.inputs };
  const moved = !s.resultInputs || !s.result || !sameEnds(s.resultInputs, inputs);
  // Re-solving the shown route (live tuning, Re-solve) keeps the result view mounted with a
  // header chip; the full progress view is for a route that has no result yet (or new ends).
  p.refine = !moved;
  p.refineError = null;
  s.status = { kind: 'solving', step: null, started: Date.now() };
  p.inputs.setBusy(true);
  if (moved) { p.rp.seq++; p.rowsImg = null; dropWindow(); clearMap(p, true); drawSearchArea(p, req.from, req.to); fitLine([req.from, req.to]); }
  if (p.refine && p.view === 'result') renderRefineChip(p);
  else renderMain(p, true);
  const rseq = p.rp.seq;
  const out = await run(p, req, (step) => { if (my === p.call) onStep(p, step); });
  if (my !== p.call || pane !== p) return false;
  clearInterval(p.timer);
  removeOverlay(['rp-area-fill', 'rp-area-line', 'rp-chord'], ['rp-area', 'rp-chord']);
  const refine = p.refine && p.view === 'result';
  p.refine = false;
  if (out.ok) {
    s.previous = moved ? null : slimRoute(s.result);
    s.result = out.result;
    clearExact(s);
    s.fromAlt = undefined;
    s.optimal = undefined;
    s.resultInputs = inputs;
    s.status = { kind: 'result' };
    s.altsError = null;
    drawResult(p);
    syncFold(p);
    if (!refine) fitLine(out.result.path.coordinates as LngLat[]);   // live tuning keeps the camera
    // A repaint asked for after this solve started shows newer edits (or the other mode): bring the overlay back to them.
    const img = out.result.weightImage;
    if (p.showWeight && p.weightMode === 'rows') {
      // One window fetch per route: a new solve of the same ends and line type does not buy another.
      if (endsKey(inputs) !== p.rowsKey) resetRowsTried(p, inputs);
      void repaintRowsNow(p);
    } else if (p.showWeight && (p.rp.seq !== rseq || (img && 'mode' in img && img.mode !== p.weightMode)))
      void repaintNow(p, shownPatch(s));
  } else if (out.reason === 'cancelled') {
    s.status = s.result ? { kind: 'result' } : { kind: 'idle' };
    if (s.result) drawResult(p);
  } else if (refine) {
    s.status = { kind: 'result' };   // the shown route stays; the refusal goes in the header chip
    p.refineError = out.reason;
  } else {
    s.status = { kind: 'error', reason: out.reason };
  }
  p.inputs.setBusy(false);   // after the result is stored, so the button reads Re-solve
  if (refine && s.status.kind === 'result') refreshResult(p);
  else renderMain(p, true);
  renderActions(p);
  renderStrip(p);
  return out.ok;
}

/** The patch the overlay previews: the edited one while the shown result's method is being edited, else the result's. */
const shownPatch = (s: RouteSession): PresetPatch | null =>
  (s.resultInputs && s.inputs.presetId === s.resultInputs.presetId ? s.inputs.patch : s.resultInputs?.patch ?? null);

/** Only what the delta chip reads, so the replaced result's images and profile can be freed. */
const slimRoute = (r: RouteResult | null): PreviousRoute | null => (r ? { path: r.path, lengthMi: r.lengthMi, cost: r.cost } : null);

const sameEnds = (a: RouteInputs, b: RouteInputs) =>
  !!(a.a && b.a && a.b && b.b && a.a.lngLat.join() === b.a.lngLat.join() && a.b.lngLat.join() === b.b.lngLat.join());

function onStep(p: Pane, step: RouteStep): void {
  const st = p.session.status;
  if (st.kind !== 'solving') return;
  st.step = step;   // 'read' again (the 2× buffer retry) restarts the list
  if (p.refine && p.view === 'result') renderRefineChip(p);
  else renderSteps(p);
}

// ─── .rp-main ────────────────────────────────────────────────────────────────

function viewOf(p: Pane): string {
  const s = p.session;
  if (s.status.kind === 'solving' && p.refine && s.result) return 'result';
  if (s.status.kind === 'solving' || s.status.kind === 'error') return s.status.kind;
  return s.result ? 'result' : 'idle';
}

/** Re-render the right side when its view changed (or `force`). */
function renderMain(p: Pane, force = false): void {
  if (p.batch) return;
  const s = p.session, view = viewOf(p);
  if (!force && view === p.view) return;
  p.view = view;
  p.activeTab?.dispose?.();
  p.activeTab = null;
  clearInterval(p.timer);
  p.main.replaceChildren();
  p.main.classList.toggle('rp-main--result', view === 'result');
  if (view === 'idle') {
    p.main.append(ht('p', 'rp-hint', 'route.idle'));
  } else if (view === 'error') {
    const box = h('div', 'rp-error');
    box.setAttribute('role', 'alert');
    box.append(ht('b', '', 'route.error.title'), h('span', '', s.status.kind === 'error' ? shownReason(s.status.reason) : ''));
    p.main.append(box);
  } else if (view === 'solving') {
    renderSolving(p);
  } else {
    renderResult(p);
  }
}

function renderSolving(p: Pane): void {
  const s = p.session;
  const wrap = h('div', 'rp-solve');
  const head = ht('h3', 'rp-solve-h', 'route.solve.title');
  const list = h('ol', 'rp-steps');
  list.setAttribute('aria-live', 'polite');
  const elapsed = h('p', 'rp-elapsed');
  const cancel = ht('button', 'rp-btn rp-cancel', 'route.solve.cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => cancelOurs(p));
  const inp = s.inputs;
  const note = h('p', 'rp-solve-note');
  if (inp.a && inp.b) note.textContent = t('route.solve.note', { km: Math.round(searchBufferM(greatCircleM(inp.a.lngLat, inp.b.lngLat)) / 1000) });
  const row = h('div', 'rp-solve-row');
  row.append(elapsed, cancel);
  wrap.append(head, list, row, note);
  p.main.append(wrap);
  renderSteps(p);
  const tick = () => {
    const st = p.session.status;
    if (st.kind === 'solving') elapsed.textContent = t('route.solve.elapsed', { s: Math.round((Date.now() - st.started) / 1000) });
  };
  tick();
  p.timer = setInterval(tick, 1000);
  if (!routePanel().hidden) cancel.focus();   // a chat solve runs with Ask in view: focus stays there
}

function renderSteps(p: Pane): void {
  const list = p.main.querySelector('.rp-steps');
  const st = p.session.status;
  if (!list || st.kind !== 'solving') return;
  const at = st.step === null ? -1 : STEPS.indexOf(st.step as RouteStep);
  const cur = st.step !== null && at < 0 ? STEPS.length : at;   // similar/alternatives: all five done
  list.replaceChildren(...STEPS.map((step, i) => {
    const state = i < cur ? 'done' : i === cur ? 'active' : 'pending';
    const li = h('li', `rp-step rp-step--${state}`);
    const mark = h('span', 'rp-step-mark', state === 'done' ? '✓' : String(i + 1));
    mark.setAttribute('aria-hidden', 'true');
    const label = h('span', 'rp-step-label', t(`route.solve.${step}`));
    const sr = h('span', 'rp-sr', ` (${t(`route.solve.state.${state}`)})`);
    if (state === 'active') li.setAttribute('aria-current', 'step');
    li.append(mark, label, sr);
    return li;
  }));
}

function tabDisabled(tab: RouteTab, s: RouteSession): string | null { return s.result ? tab.disabled(s) : t('route.idle'); }

function renderResult(p: Pane): void {
  const s = p.session;
  if (tabDisabled(TABS.find((x) => x.id === s.tab)!, s)) s.tab = 'summary';
  const panel = h('div', 'rp-panel');
  panel.id = 'rp-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `rp-tab-${s.tab}`);
  p.main.append(resultHead(p), panel);
  syncHeadHeight(p);
  const tab = TABS.find((x) => x.id === s.tab)!;
  p.activeTab = tab;
  tab.render(panel, p.ctx);
  renderRefineChip(p);
}

/** A refine solve landed (or was refused): new header, the active tab updated in place —
 *  `update` when it has one (keeps focus), else disposed and rendered again. */
function refreshResult(p: Pane): void {
  const s = p.session, panel = p.main.querySelector<HTMLElement>('#rp-panel'), tab = p.activeTab;
  if (p.view !== 'result' || !panel || !tab || tab.id !== s.tab || tabDisabled(tab, s)) { renderMain(p, true); return; }
  const at = p.mapMenu.at;
  const head = resultHead(p);
  p.main.querySelector('.rp-head')?.replaceWith(head);
  if (at !== null && head.isConnected) p.mapMenu.open?.(at);   // the menu stays open, on the same item
  syncHeadHeight(p);
  renderRefineChip(p);
  if (tab.update) tab.update(panel, p.ctx);
  else { tab.dispose?.(); tab.render(panel, p.ctx); }
}

/** The sticky result header's height, for a tab's own sticky header under it (--rp-head-h). */
function syncHeadHeight(p: Pane): void {
  const head = p.main.querySelector<HTMLElement>('.rp-head');
  if (head) p.main.style.setProperty('--rp-head-h', `${head.offsetHeight}px`);
}

/** "Re-solving… step · Cancel" (or the refusal) in the result header while a refine solve runs. */
function renderRefineChip(p: Pane): void {
  const head = p.main.querySelector('.rp-head');
  if (!head) return;
  let chip = head.querySelector<HTMLElement>('.rp-resolving');
  const st = p.session.status;
  if (!(st.kind === 'solving' && p.refine) && !p.refineError) { chip?.remove(); syncHeadHeight(p); return; }
  if (!chip) {
    chip = h('span', 'rp-resolving');
    const at = head.querySelector('.rp-badge');
    if (at) at.after(chip); else head.append(chip);
  }
  chip.replaceChildren();
  chip.classList.toggle('rp-resolving--err', !!p.refineError && st.kind !== 'solving');
  if (st.kind === 'solving') {
    chip.setAttribute('role', 'status');
    chip.append(h('span', 'rp-resolving-spin'), h('span', '', st.step
      ? t('route.solve.chipStep', { step: t(`route.solve.${st.step}`) }) : t('route.solve.chip')));
    const cancel = ht('button', 'rp-link rp-resolving-cancel', 'route.solve.cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cancelOurs(p));
    chip.append(h('span', '', ' · '), cancel);
  } else {
    chip.setAttribute('role', 'alert');
    chip.textContent = t('route.solve.chipErr', { reason: shownReason(p.refineError ?? '') });
  }
  syncHeadHeight(p);
}

function resultHead(p: Pane): HTMLElement {
  const s = p.session, r = s.result!;
  const head = h('div', 'rp-head');
  const list = h('div', 'rp-tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', t('route.sub.tablist'));
  for (const tab of TABS) {
    const b = h('button', 'rp-tab', t(tab.labelKey));
    b.type = 'button';
    b.id = `rp-tab-${tab.id}`;
    b.dataset.tab = tab.id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'rp-panel');
    const why = tabDisabled(tab, s);
    const on = tab.id === s.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (why) { b.setAttribute('aria-disabled', 'true'); b.title = why; }
    b.addEventListener('click', () => selectTab(p, tab.id));
    list.append(b);
  }
  list.addEventListener('keydown', (e) => {
    const ids = TABS.filter((x) => !tabDisabled(x, s)).map((x) => x.id);
    const i = ids.indexOf(s.tab);
    const next = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length]
      : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    selectTab(p, next);
    p.main.querySelector<HTMLElement>(`#rp-tab-${next}`)?.focus();
  });
  const item = (cls: string, role: string, text = '') => {
    const b = h('button', `rp-mi ${cls}`, text);
    b.type = 'button';
    b.setAttribute('role', role);
    b.tabIndex = -1;
    return b;
  };
  const wt = item('rp-wt', 'menuitemcheckbox');
  wt.addEventListener('click', () => { if (!wt.disabled) setShowWeight(p, !p.showWeight); });
  const modes = h('div', 'rp-wtmode');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', t('route.insp.mode'));
  for (const m of ['route', 'cost', 'cause', 'rows'] as const) {
    const r = item('rp-wtmode-opt', 'menuitemradio', t(`route.insp.mode.${m}`));
    r.dataset.mode = m;
    r.addEventListener('click', () => { void setWeightMode(p, m); });
    modes.append(r);
  }
  const insp = item('rp-insp', 'menuitemcheckbox', t('route.insp.toggle'));
  insp.title = t('route.insp.toggleTitle');
  insp.addEventListener('click', () => setInspect(p, !p.inspectOn));
  head.append(list, s.fromAlt ? altBadge(s, s.fromAlt) : badge(r.optimality), mapMenu(p, wt, modes, insp));
  syncInspectControls(p, head);
  return head;
}

/** "Map ▾": the map-overlay controls (cell weights, their mode, Inspect) in a menu, so the sub-tabs keep the header row. */
function mapMenu(p: Pane, ...items: HTMLElement[]): HTMLElement {
  p.mapMenu.off?.();   // a rebuilt header: the old menu's document listeners go with it
  p.mapMenu.at = null;
  const wrap = h('div', 'rp-map');
  const btn = h('button', 'rp-chip rp-mapbtn', t('route.map.btn'));
  btn.type = 'button';
  btn.id = 'rp-mapbtn';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const menu = h('div', 'rp-mapmenu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', btn.id);
  menu.hidden = true;
  menu.append(...items);
  // Fixed to the viewport, below the button or flipped above it, so a short drawer neither clips nor pushes it off screen;
  // placed again when its height changes (the weight modes show).
  new ResizeObserver(() => { if (!menu.hidden) positionColorMenu(menu, btn); }).observe(menu);
  const live = () => [...menu.querySelectorAll<HTMLButtonElement>('.rp-mi')].filter((b) => !b.disabled && !b.closest('[hidden]'));
  const detach = () => {
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', esc, true);
    if (p.mapMenu.off === detach) p.mapMenu.off = undefined;
  };
  const close = (focus: boolean) => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    detach();
    p.mapMenu.at = null;
    if (focus) btn.focus();
  };
  // On the document: the focused item can be disabled (weights loading) and drop focus to the page.
  // A menu whose header was replaced only lets go of the document.
  const esc = (e: KeyboardEvent) => {
    if (!wrap.isConnected) { detach(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  const away = (e: Event) => {
    if (!wrap.isConnected) { detach(); return; }
    if (!wrap.contains(e.target as Node)) close(false);
  };
  const open = (at = 0) => {
    menu.hidden = false;
    positionColorMenu(menu, btn);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    p.mapMenu.off = detach;
    p.mapMenu.at = at;
    const els = live();
    (els[at] ?? els[0])?.focus();
  };
  p.mapMenu.open = open;
  menu.addEventListener('focusin', (e) => {
    const i = live().indexOf(e.target as HTMLButtonElement);
    if (i >= 0) p.mapMenu.at = i;
  });
  btn.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && menu.hidden) { e.preventDefault(); open(); } });
  wrap.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Tab') { close(false); return; }
    const els = live(), i = els.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? els[(i + 1) % els.length] : e.key === 'ArrowUp' ? els[(i - 1 + els.length) % els.length]
      : e.key === 'Home' ? els[0] : e.key === 'End' ? els[els.length - 1] : null;
    if (to) { e.preventDefault(); to.focus(); }
  });
  wrap.append(btn, menu);
  return wrap;
}

/** "Alt n · +x % routing score": the shown result is an alternative the user picked. */
function altBadge(s: RouteSession, n: number): HTMLElement {
  const pct = (s.optimal?.alternatives?.[n - 1]?.pctRoute ?? 0).toFixed(1);
  const b = h('span', 'rp-badge rp-badge--alt', t('route.badge.alt', { n, pct }));
  b.title = t('route.badge.alt.tip');
  return b;
}

function selectTab(p: Pane, id: RouteSubTab): void {
  const tab = TABS.find((x) => x.id === id);
  if (!tab || tabDisabled(tab, p.session) || p.session.tab === id) return;
  p.session.tab = id;
  renderMain(p, true);
}

function renderStrip(p: Pane): void {
  const extra = p.main.parentElement?.querySelector('.ri-strip-extra');
  if (!extra) return;
  const r = p.session.result;
  if (!r) { extra.textContent = ''; return; }
  const c = r.cost, m = (v2025: number) => p.ctx.money(v2025, (v2025 * c.totalNominal) / (c.total2025 || 1));
  extra.textContent = t('route.strip', { mi: r.lengthMi.toFixed(1), total: m(c.total2025), low: m(c.band.low), high: m(c.band.high) });
}

// ─── drawer header actions ──────────────────────────────────────────────────

function renderActions(p: Pane): void {
  const slot = routeActions();
  p.menuOff?.();
  p.menu?.remove();
  p.menu = null;
  slot.replaceChildren();
  const batch = h('button', 'td-btn rp-batch', t('route.act.batch'));
  batch.type = 'button';
  batch.addEventListener('click', () => openBatch(p));
  slot.append(batch);
  const r = p.session.result;
  if (!r) return;
  const report = () => { void import('./route-report.js').then((m) => m.openRouteReport(p.ctx)); };
  const exports: [string, () => void][] = [['route.act.geojson', () => exportGeojson(p)], ['route.act.csv', () => exportCsv(p)]];
  const menuBtn = (cls: string, text: string, items: [string, () => void][]) => {
    const b = h('button', `td-btn ${cls}`, text);
    b.type = 'button';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => toggleMenu(p, b, items));
    return b;
  };
  // A phone's drawer header holds one ⋯ menu, so the tabs and the summary keep the room.
  if (typeof matchMedia === 'function' && matchMedia(COMPACT).matches) {
    const more = menuBtn('rp-more', '⋯', [...exports, ['route.act.report', report], ['route.act.myData', () => { void addToMyData(p); }]]);
    more.setAttribute('aria-label', t('route.act.more'));
    more.title = t('route.act.more');
    slot.append(more);
    return;
  }
  const exp = menuBtn('rp-export', `↓ ${t('route.act.export')} ▾`, exports);
  const rep = h('button', 'td-btn rp-report', t('route.act.report'));
  rep.type = 'button';
  rep.addEventListener('click', report);
  const my = h('button', 'td-btn rp-mydata', t('route.act.myData'));
  my.type = 'button';
  my.addEventListener('click', () => { void addToMyData(p, my); });
  slot.append(exp, rep, my);
}

/** Batch…: the batch view in `.rp-main` (lazy chunk; the production bundle never reaches this file). */
function openBatch(p: Pane): void {
  if (p.batch) return;
  const s = p.session;
  p.batch = { dispose() { /* replaced when the chunk lands */ } };
  const mine = p.batch;
  void import('./route-batch.js').then((m) => {
    if (pane !== p || p.batch !== mine) return;
    p.activeTab?.dispose?.();
    p.activeTab = null;
    clearInterval(p.timer);
    p.view = 'batch';
    p.main.classList.remove('rp-main--result');
    const view = m.mountBatch(p.main, {
      presetId: s.inputs.presetId, patch: s.inputs.patch, lineType: s.inputs.lineType, snapKm: p.prefs.snapKm,
      methodLabel: methodLabelOf(s.inputs.presetId), saved: () => presetStore.list(),
      close() { p.batch = null; renderMain(p, true); renderActions(p); },
    });
    p.batch = view;
  }, () => { if (p.batch === mine) p.batch = null; });
}

function toggleMenu(p: Pane, btn: HTMLButtonElement, items: [string, () => void][]): void {
  if (p.menu) { closeMenu(p, btn); return; }
  const menu = h('div', 'rp-menu');
  menu.setAttribute('role', 'menu');
  for (const [key, fn] of items) {
    const b = h('button', 'rp-menu-item', t(key));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeMenu(p, btn); btn.focus(); fn(); });
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => {
    const els = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(p, btn); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      els[e.key === 'Home' ? 0 : els.length - 1]?.focus();
    } else if (e.key === 'Tab') closeMenu(p, btn);
  });
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 228))}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 4)}px`;
  document.body.append(menu);
  p.menu = menu;
  btn.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  const away = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) closeMenu(p, btn);
  };
  const arm = setTimeout(() => document.addEventListener('pointerdown', away), 0);
  p.menuOff = () => { clearTimeout(arm); document.removeEventListener('pointerdown', away); };
}
function closeMenu(p: Pane, btn: HTMLElement): void {
  p.menuOff?.();
  p.menuOff = undefined;
  p.menu?.remove();
  p.menu = null;
  btn.setAttribute('aria-expanded', 'false');
}

function fileBase(p: Pane): string {
  const inp = p.session.resultInputs;
  return `route-${slug(endName(inp, 'a'))}-${slug(endName(inp, 'b'))}`;
}

/** The route and its alternatives as GeoJSON, with summary properties; `style` adds stroke colours. */
function resultGeojson(s: RouteSession, style = false): FC {
  const r = s.result!, c = r.cost, inp = s.resultInputs;
  const features: GeoJSON.Feature[] = [{
    type: 'Feature', geometry: r.path, properties: {
      name: `${endName(inp, 'a')} → ${endName(inp, 'b')}`, kind: 'route', preset: r.preset.id, lineType: c.lineType,
      lengthMi: +r.lengthMi.toFixed(2), dollarYear: c.dollarYear, totalNominalUsd: Math.round(c.totalNominal),
      total2025Usd: Math.round(c.total2025), low2025Usd: Math.round(c.band.low), high2025Usd: Math.round(c.band.high),
      tribalMiles: +r.tribalMiles.toFixed(2), lowestScoreProof: r.optimality,
      ...(style ? { stroke: PLAIN, 'stroke-width': 4 } : {}),
    },
  }];
  for (const a of otherRoutes(s)) features.push({
    type: 'Feature', geometry: a.path, properties: {
      name: a.name, kind: a.alt < 0 ? 'lowest-score' : 'alternative', lengthMi: +a.lengthMi.toFixed(2),
      total2025Usd: Math.round(a.cost.total2025), routingScoreAboveLowestPct: +a.pctRoute.toFixed(2),
      usdVsRoutePct: +((a.cost.total2025 / (c.total2025 || 1) - 1) * 100).toFixed(2),
      sharedWithLowest: a.sharedWithRoute === null ? null : +a.sharedWithRoute.toFixed(3),
      ...(style ? { stroke: a.colour, 'stroke-width': 3 } : {}),
    },
  });
  return { type: 'FeatureCollection', features };
}

function exportGeojson(p: Pane): void {
  downloadFile(JSON.stringify(resultGeojson(p.session)), `${fileBase(p)}.geojson`, 'application/geo+json');
}

function exportCsv(p: Pane): void {
  downloadFile(costCsv(p.session.result!, p.session.dollars, p.session.resultInputs), `${fileBase(p)}-cost.csv`, 'text/csv;charset=utf-8');
}

async function addToMyData(p: Pane, btn?: HTMLButtonElement): Promise<void> {
  if (!p.session.result) return;
  const { addImportedLayer } = await import('../user-data/user-data.js');
  addImportedLayer(`${fileBase(p)}.geojson`, resultGeojson(p.session, true));
  if (!btn) return;
  btn.textContent = t('route.act.myDataDone');
  btn.disabled = true;
}

// ─── map ─────────────────────────────────────────────────────────────────────

function addLayer(spec: LayerSpecification): void {
  const map = state.map;
  if (!map) return;
  if (map.getLayer(spec.id)) map.removeLayer(spec.id);
  const i = ORDER.indexOf(spec.id);
  const before = ORDER.slice(i + 1).find((id) => map.getLayer(id));
  map.addLayer(spec, before);
}
/** Remove every rp- layer and source (`all`), or only the result's (route, alts, surface, crossings, marker). */
function clearMap(p: Pane, all: boolean): void {
  const keep = all ? [] : ['rp-ghost-casing', 'rp-ghost'];
  removeOverlay([...ORDER].reverse().filter((id) => !keep.includes(id)), SOURCES.filter((id) => !keep.includes(id)));
  releaseSurface(p);
  releaseWeight(p);
  p.markerAt = null;
  p.tip.hidden = true;
  hideInspect(p);
  closeCard(p);
  renderLegend(p);
}

function drawSearchArea(p: Pane, a: LngLat, b: LngLat): void {
  const buf = searchBufferM(greatCircleM(a, b));
  setGeojson('rp-area', { type: 'Feature', geometry: capsule(a, b, buf), properties: {} });
  setGeojson('rp-chord', { type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: {} });
  addLayer({ id: 'rp-area-fill', type: 'fill', source: 'rp-area', paint: { 'fill-color': '#7e22ce', 'fill-opacity': 0.12 } });
  addLayer({ id: 'rp-area-line', type: 'line', source: 'rp-area', paint: { 'line-color': '#7e22ce', 'line-opacity': 0.55, 'line-width': 1.5 } });
  addLayer({ id: 'rp-chord', type: 'line', source: 'rp-chord', paint: { 'line-color': '#334155', 'line-width': 1.5, 'line-dasharray': [3, 3] } });
  renderLegend(p, Math.round(buf / 1000));
}

/** (Re)draw the result's layers from the session. */
function drawResult(p: Pane): void {
  const s = p.session, r = s.result;
  if (!r || !state.map) return;
  drawRoute(p);
  drawAlternatives(p);
  drawWeight(p);
  drawSurface(p);
  drawCrossings(p);
  drawMarker(p);
  renderLegend(p);
}

function drawRoute(p: Pane): void {
  const r = p.session.result!;
  setGeojson('rp-route', routeFeatures(r, p.session.colour));
  if (!state.map?.getLayer('rp-route-casing')) {
    addLayer({ id: 'rp-route-casing', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.95 } });
  }
  if (!state.map?.getLayer('rp-route')) {
    addLayer({ id: 'rp-route', type: 'line', source: 'rp-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 } });
  }
}

function drawAlternatives(p: Pane): void {
  const alts = otherRoutes(p.session);
  if (!alts.length) { removeOverlay(['rp-alts-label', 'rp-alts'], ['rp-alts']); return; }
  setGeojson('rp-alts', {
    type: 'FeatureCollection',
    features: alts.map((a) => ({ type: 'Feature', geometry: a.path, properties: { i: a.alt, name: a.name, color: a.colour } })),
  });
  addLayer({ id: 'rp-alts', type: 'line', source: 'rp-alts', layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9 } });
  addLayer({ id: 'rp-alts-label', type: 'symbol', source: 'rp-alts',
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'symbol-spacing': 300 },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
}

function crossFilter(p: Pane): FilterSpecification {
  return ['in', ['get', 'kind'], ['literal', [...p.session.crossingKinds]]] as unknown as FilterSpecification;
}

function drawCrossings(p: Pane): void {
  const grid = p.session.result?.profile?.crossings.points ?? [];
  const ex = shownExact(p.session);
  const pts = ex ? [...grid.filter((c) => !ex.exact.includes(c.kind)), ...ex.result.points.filter((c) => ex.exact.includes(c.kind))] : grid;
  if (!pts.length) { removeOverlay(['rp-cross'], ['rp-cross']); return; }
  setGeojson('rp-cross', {
    type: 'FeatureCollection',
    features: pts.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c.lngLat }, properties: { kind: c.kind, mi: c.mi } })),
  });
  const pick = (k: 0 | 1) => ['match', ['get', 'kind'], ...Object.entries(CROSS_COLOURS).flatMap(([kind, c]) => [kind, c[k]]), '#64748b'];
  addLayer({ id: 'rp-cross', type: 'circle', source: 'rp-cross', filter: crossFilter(p), minzoom: CROSS_MINZOOM,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], CROSS_MINZOOM, 6, 13, 9], 'circle-color': pick(0),
      'circle-stroke-color': pick(1), 'circle-stroke-width': 2.5 } } as unknown as LayerSpecification);
}

function drawMarker(p: Pane): void {
  const r = p.session.result;
  if (!r || !p.markerAt) { removeOverlay(['rp-marker-label', 'rp-marker'], ['rp-marker']); return; }
  const { mi, label } = p.markerAt;
  setGeojson('rp-marker', { type: 'Feature', geometry: { type: 'Point', coordinates: pointAtMile(r, mi) },
    properties: { label: label ?? t('route.marker', { mi: Math.round(mi) }) } });
  if (!state.map?.getLayer('rp-marker')) {
    addLayer({ id: 'rp-marker', type: 'circle', source: 'rp-marker',
      paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 3 } });
    addLayer({ id: 'rp-marker-label', type: 'symbol', source: 'rp-marker',
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  }
}

// One canvas; the worker's RGBA is kept untouched and only alpha is rewritten.
function releaseSurface(p: Pane): void {
  removeOverlay(['rp-surface'], ['rp-surface']);
  if (p.surf) { p.surf.canvas.width = 0; p.surf.canvas.height = 0; }
  p.surf = null;
}

/** Palette class (1..4) per pixel of the worker's image; 0 = transparent / no class. */
export function pixelClasses(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    if (!rgba[i + 3]) continue;
    for (let k = 1; k < SURFACE_PALETTE.length; k++) {
      const c = SURFACE_PALETTE[k];
      if (rgba[i] === c[0] && rgba[i + 1] === c[1] && rgba[i + 2] === c[2]) { out[j] = k; break; }
    }
  }
  return out;
}

/** Write `img` from the original RGBA with alpha 0 for classes above `threshold`. */
export function maskSurface(orig: Uint8ClampedArray, cls: Uint8Array, bands: readonly number[], threshold: number, out: Uint8ClampedArray): void {
  const maxClass = bands.filter((b) => b <= threshold + 1e-9).length;
  out.set(orig);
  for (let j = 0; j < cls.length; j++) if (cls[j] > maxClass || !cls[j]) out[j * 4 + 3] = 0;
}

function drawSurface(p: Pane): void {
  const s = p.session, map = state.map;
  const surface = s.result?.surface && 'image' in s.result.surface ? s.result.surface : null;
  if (!surface || !s.showSurface || !map) { releaseSurface(p); renderLegend(p); return; }
  if (p.surf?.src !== surface) {
    releaseSurface(p);
    const { width, height, rgba } = surface.image;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return;
    p.surf = { src: surface, canvas, g, cls: pixelClasses(rgba), img: g.createImageData(width, height) };
  }
  const sf = p.surf!;
  maskSurface(surface.image.rgba, sf.cls, surface.bands, s.threshold, sf.img.data);
  sf.g.putImageData(sf.img, 0, 0);
  const src = map.getSource('rp-surface') as CanvasSource | undefined;
  if (src) {
    src.play();                                  // a paused canvas source uploads only while playing
    map.once('render', () => src.pause());
    map.triggerRepaint();
  } else {
    map.addSource('rp-surface', { type: 'canvas', canvas: sf.canvas, coordinates: surface.image.coordinates, animate: false });
    addLayer({ id: 'rp-surface', type: 'raster', source: 'rp-surface', paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' } });
  }
  renderLegend(p);
}

function fitLine(points: LngLat[]): void {
  const map = state.map, b = bounds(points);
  if (!map || !b) return;
  // On a phone the layer panel covers the map: collapse it (its own close button) before the fit.
  const lp = document.getElementById('layersPanel');
  if (lp && !lp.hidden && map.getContainer().clientWidth <= 640) document.getElementById('closeLayers')?.click();
  const point = b[0][0] === b[1][0] && b[0][1] === b[1][1];
  map.fitBounds(b, { padding: fitPadding(), maxZoom: point ? Math.max(map.getZoom(), 10) : 12, duration: 600 });
}

/** drawerPadding, and on a phone also clear of the legend cards stacked above the drawer (most of the map's width there). */
export function fitPadding(): { top: number; left: number; right: number; bottom: number } {
  const pad = drawerPadding(), box = state.map?.getContainer(), lc = document.getElementById('legendContainer');
  if (!box || !lc || lc.hidden || lc.classList.contains('legends-off') || box.clientWidth > 640) return pad;
  const above = box.getBoundingClientRect().bottom - lc.getBoundingClientRect().top + 8;
  return { ...pad, bottom: Math.min(Math.max(pad.bottom, above), Math.max(40, box.clientHeight - pad.top - 140)) };
}

// ─── legend + hover ──────────────────────────────────────────────────────────

/** The legend card: the app's collapsible `.legend` markup (ui.ts toggles `.collapse-btn`),
 *  collapsed to its title row on a phone or short screen; a tap on the title toggles it. */
function legendCard(): { legend: HTMLElement; label: HTMLElement; body: HTMLElement } {
  const legend = h('div', 'legend rp-legend');
  legend.dataset.collapsible = '';
  legend.hidden = true;
  const title = h('div', 'legend-title rp-lg-title');
  const btn = h('button', 'collapse-btn');
  btn.type = 'button';
  btn.setAttribute('aria-label', t('legend.toggle'));
  const label = h('span', 'legend-title-label');
  const body = h('div', 'collapsible-content rp-lg-body');
  const compact = typeof matchMedia === 'function' && matchMedia(COMPACT).matches;
  legend.classList.toggle('collapsed', compact);
  btn.setAttribute('aria-expanded', String(!compact));
  title.addEventListener('click', (e) => { if (e.target !== btn) btn.click(); });
  title.append(btn, label);
  legend.append(title, body);
  return { legend, label, body };
}

/** Show or hide the card; the legend container shows while any card does (updateLegends). */
function showLegend(p: Pane, on: boolean): void {
  if (p.legend.hidden === !on) return;
  p.legend.hidden = !on;
  const lc = p.legend.parentElement;
  if (on && lc?.id === 'legendContainer') lc.hidden = false;
  else if (!on) updateLegends();
}

function renderLegend(p: Pane, searchKm?: number): void {
  const s = p.session, lg = p.lgBody, r = s.result;
  lg.replaceChildren();
  if (searchKm !== undefined) {
    p.lgLabel.textContent = t('route.legend.plain');
    const row = h('div', 'rp-lg-row');
    row.append(h('i', 'rp-lg-area'), h('span', '', t('route.legend.area', { km: searchKm })));
    lg.append(row);
    showLegend(p, true);
    return;
  }
  if (!r || !state.map?.getLayer('rp-route')) { showLegend(p, false); return; }
  const runs = r.profile?.runs ?? [];
  const mode: ColourMode = runs.length ? s.colour : 'plain';
  p.lgLabel.textContent = t(`route.legend.${mode}`);
  if (mode === 'cost') {
    const bar = h('div', 'rp-lg-ramp');
    bar.style.background = `linear-gradient(to right, ${COST_RAMP.map(([, c]) => c).join(', ')})`;
    const ticks = h('div', 'rp-lg-ticks');
    for (const x of ['×1.0', '×1.5', '×2.0', '×2.5']) ticks.append(h('span', '', x));
    const mean = r.cost.meanCostX;
    lg.append(bar, ticks, h('p', 'rp-lg-note', t('route.legend.costNote', { x: mean.toFixed(2) })));
  } else if (mode === 'driver') {
    for (const [key, colour] of driverColours(r)) {
      const row = h('div', 'rp-lg-row');
      const sw = h('i', 'rp-lg-sw');
      sw.style.background = colour;
      row.append(sw, h('span', '', key === null ? t('route.legend.noDriver') : t(categoryLabelKey(key))));
      lg.append(row);
    }
    lg.append(h('p', 'rp-lg-note', t('route.legend.driverNote')));
  } else {
    const row = h('div', 'rp-lg-row');
    const sw = h('i', 'rp-lg-sw');
    sw.style.background = PLAIN;
    row.append(sw, h('span', '', s.fromAlt ? t('route.alt.name', { n: s.fromAlt }) : t('route.legend.route')));
    lg.append(row);
  }
  for (const a of otherRoutes(s)) {
    const row = h('div', 'rp-lg-row');
    const sw = h('i', 'rp-lg-sw rp-lg-sw--thin');
    sw.style.background = a.colour;
    row.append(sw, h('span', '', a.name));
    lg.append(row);
  }
  if (p.surf && state.map?.getLayer('rp-surface')) {
    lg.append(h('div', 'rp-lg-h rp-lg-h--sub', t('route.legend.surface')));
    const row = h('div', 'rp-lg-swatches');
    p.surf.src.bands.forEach((b, k) => {
      if (b > s.threshold + 1e-9) return;
      const c = SURFACE_PALETTE[k + 1];
      const item = h('span', 'rp-lg-row');
      const sw = h('i', 'rp-lg-sw');
      sw.style.background = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(2)})`;
      item.append(sw, h('span', '', `≤ ${Math.round(b * 100)} %`));
      row.append(item);
    });
    lg.append(row);
  }
  if (p.showWeight && p.weightMode === 'rows' && s.highlight.length) {
    lg.append(h('div', 'rp-lg-h rp-lg-h--sub', t('route.legend.rows')));
    for (const k of s.highlight) {
      const c = HIGHLIGHT_PALETTE[k.slot + 1] ?? HIGHLIGHT_PALETTE[1];
      const row = h('div', 'rp-lg-row');
      const sw = h('i', 'rp-lg-sw');
      sw.style.background = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(2)})`;
      const parent = k.note ?? k.band;
      const mm = methodFor(s.inputs.presetId, null);
      const ex = k.except !== undefined && typeof mm !== 'string' ? routePreset(mm.preset)?.rows[k.row]?.except?.[k.except]?.label : undefined;
      row.append(sw, h('span', '', ex ? t('route.mg.aria.except', { label: ex, row: parent }) : parent));
      lg.append(row);
    }
    lg.append(h('p', 'rp-lg-note', t('route.legend.rowsThin')));
    if (p.weightError) lg.append(h('p', 'rp-lg-note', t('route.mg.hlRefused', { reason: p.weightError })));
  } else if (p.weight && state.map?.getLayer('rp-weight')) {
    const cost = p.weight.mode === 'cost', cause = p.weight.mode === 'cause';
    if (weightStale(p)) { lg.append(h('div', 'rp-lg-h rp-lg-h--sub', t('route.insp.weightLoading'))); showLegend(p, true); return; }
    lg.append(h('div', 'rp-lg-h rp-lg-h--sub', t(cause ? 'route.insp.legendCause' : cost ? 'route.insp.legendCost' : 'route.insp.legend')));
    if (cause) {
      for (const x of (p.weight.src as WeightImage).cause?.present ?? []) {
        const row = h('div', 'rp-lg-row');
        const sw = h('i', 'rp-lg-sw');
        sw.style.background = x.colour;
        row.append(sw, h('span', '', t(x.labelKey)), h('span', 'rp-lg-pct', x.share < 0.01 ? '< 1 %' : `${Math.round(x.share * 100)} %`));
        lg.append(row);
      }
      if ((p.weight.src as WeightImage).cause?.barrier) {
        const row = h('div', 'rp-lg-row');
        row.append(h('i', 'rp-lg-sw rp-lg-sw--hatch'), h('span', '', t('route.insp.legend.blocked')));
        lg.append(row);
      }
      lg.append(h('p', 'rp-lg-note', t('route.insp.legendCauseNote')));
      showLegend(p, true);
      return;
    }
    const bar = h('div', 'rp-lg-ramp');
    const rgba = (c: readonly number[]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0.35, c[3] / 255).toFixed(2)})`;
    const ramp = cost ? COST_PALETTE.slice(1, COST_BARRIER) : WEIGHT_PALETTE.slice(1, WEIGHT_BARRIER);
    bar.style.background = `linear-gradient(to right, ${ramp.map(rgba).join(', ')})`;
    const ticks = h('div', 'rp-lg-ticks');
    for (const x of cost ? ['×1', '×1.5', '×2', '×3+'] : ['×1', '×10', '×100', '×1000+']) ticks.append(h('span', '', x));
    const row = h('div', 'rp-lg-row');
    row.append(h('i', 'rp-lg-sw rp-lg-sw--hatch'), h('span', '', t('route.insp.legend.blocked')));
    lg.append(bar, ticks, row);
  }
  showLegend(p, true);
}

function onHover(e: MapPointerEvent): void {
  const p = pane, map = state.map;
  if (!p || !map) return;
  const tip = p.tip;
  if (state.routePick || !p.session.result) { tip.hidden = true; hideInspect(p); return; }
  const hole = !!p.surf && !!map.getLayer('rp-surface') && holeAt(p.surf.img, p.surf.src.image, [e.lngLat.lng, e.lngLat.lat]);
  if (p.inspectOn || hole) { tip.hidden = true; if (noHover()) p.itip.hidden = true; else queueInspect(p, e, hole); return; }
  hideInspect(p);
  if (!map.getLayer('rp-route')) { tip.hidden = true; return; }
  const f = map.queryRenderedFeatures(e.point, { layers: ['rp-route'] })[0];
  const pr = f?.properties as { mi0?: number; mi1?: number; costX?: number; driver?: string; usdNom?: number } | undefined;
  if (!pr || pr.mi0 === undefined || pr.mi1 === undefined) { tip.hidden = true; return; }
  const c = p.session.result.cost, nom = pr.usdNom ?? 0;
  const short = pr.mi1 - pr.mi0 < 5;
  const mi = (v: number) => (short ? v.toFixed(1) : String(Math.round(v)));
  tip.textContent = t('route.hover', {
    mi0: mi(pr.mi0), mi1: mi(pr.mi1), x: (pr.costX ?? 1).toFixed(2),
    driver: pr.driver ? t(categoryLabelKey(pr.driver)) : t('route.hover.noDriver'),
    usd: p.ctx.money(nom * (c.totalNominal ? c.total2025 / c.totalNominal : 1), nom),
  });
  tip.style.left = `${e.point.x + 14}px`;
  tip.style.top = `${e.point.y + 14}px`;
  tip.hidden = false;
}

// ─── cell inspector + routing-weight overlay ──────────────────────────

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** True when `lngLat` falls on a transparent pixel of `img` (drawn over `geo`'s corners)
 *  that has drawn pixels left, right, above and below it: a hole in the areas, not their outside. */
export function holeAt(img: { data: Uint8ClampedArray; width: number; height: number }, geo: Pick<SurfaceImage, 'coordinates'>, lngLat: [number, number]): boolean {
  const [[W, N], , [E, S]] = geo.coordinates, [lng, lat] = lngLat, { data, width, height } = img;
  if (!(lng >= W && lng <= E && lat >= S && lat <= N)) return false;
  const x = Math.min(width - 1, Math.floor(((lng - W) / (E - W)) * width));
  const y = Math.min(height - 1, Math.floor(((mercY(N) - mercY(lat)) / (mercY(N) - mercY(S))) * height));
  const a = (i: number, j: number) => data[(j * width + i) * 4 + 3];
  if (a(x, y)) return false;
  const seen = (dx: number, dy: number) => {
    for (let i = x + dx, j = y + dy; i >= 0 && i < width && j >= 0 && j < height; i += dx, j += dy) if (a(i, j)) return true;
    return false;
  };
  return seen(-1, 0) && seen(1, 0) && seen(0, -1) && seen(0, 1);
}

/** The overlay on screen was drawn in another mode than the one picked: its image is still on its way. */
const weightStale = (p: Pane): boolean => p.showWeight && !!p.weight && p.weight.mode !== p.weightMode;

/** Dimmed while stale, so the previous mode's colours are not read as the new one's. */
function dimWeight(p: Pane): void {
  if (state.map?.getLayer('rp-weight')) state.map.setPaintProperty('rp-weight', 'raster-opacity', weightStale(p) ? 0.25 : 0.8);
}

function syncInspectControls(p: Pane, root: ParentNode = p.main): void {
  const btn = root.querySelector<HTMLButtonElement>('.rp-insp');
  if (btn) { btn.setAttribute('aria-checked', String(p.inspectOn)); btn.classList.toggle('rp-chip--on', p.inspectOn); }
  const box = root.querySelector<HTMLButtonElement>('.rp-wt');
  if (box) {
    box.setAttribute('aria-checked', String(p.showWeight));
    box.disabled = p.weightLoading;
    box.textContent = t(p.weightLoading || weightStale(p) ? 'route.insp.weightLoading' : 'route.insp.weight');
    box.title = p.weightError ?? '';
  }
  const modes = root.querySelector<HTMLElement>('.rp-wtmode');
  if (modes) {
    modes.hidden = !p.showWeight;
    for (const r of modes.querySelectorAll<HTMLButtonElement>('button')) {
      r.setAttribute('aria-checked', String(r.dataset.mode === p.weightMode));
      if (r.dataset.mode === 'rows') r.disabled = p.session.highlight.length === 0;
    }
  }
  dimWeight(p);
}

function setInspect(p: Pane, on: boolean): void {
  if (p.inspectOn === on) return;
  p.inspectOn = on;
  state.routeInspect = on;
  if (!on) { hideInspect(p); closeCard(p); }
  syncEsc(p);
  syncInspectControls(p);
}

/** Esc: closes the pinned card first; with none open it turns Inspect off. Listening only while either is up. */
function syncEsc(p: Pane): void {
  p.escOff?.();
  p.escOff = undefined;
  if (!p.inspectOn && p.icard.hidden) return;
  const esc = (e: KeyboardEvent) => {
    // Pick mode, a dialog or an open menu / list box handles its own Esc first.
    if (e.key !== 'Escape' || state.routePick) return;
    if (document.querySelector('.rp-mapmenu:not([hidden])') || (e.target instanceof Element && e.target.closest('dialog, [role="menu"], [role="listbox"]'))) return;
    e.preventDefault();
    e.stopPropagation();
    if (!p.icard.hidden) closeCard(p); else setInspect(p, false);
  };
  window.addEventListener('keydown', esc, true);
  p.escOff = () => window.removeEventListener('keydown', esc, true);
}

/** Closes the pinned card; Inspect stays as it is. */
function closeCard(p: Pane): void {
  p.insp.pinSeq++;
  p.pin = null;
  p.dockRo?.disconnect();
  if (p.icard.hidden) return;
  p.icard.hidden = true;
  p.icard.replaceChildren();
  syncEsc(p);
}

const noHover = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
const INSPECT_DOCK = '(max-width: 640px), (hover: none)';

function hideInspect(p: Pane): void {
  clearTimeout(p.insp.timer);
  p.insp.seq++;
  p.itip.hidden = true;
}

/** The inspect request for the shown result's inputs, or null. */
function inspectRequest(p: Pane, lngLat: [number, number]): InspectRequest | null {
  const s = p.session, inp = s.resultInputs ?? s.inputs;
  const req = requestFor(inp, { patch: inp.patch, profile: false, alternatives: 0, surface: false });
  if (typeof req === 'string') return null;
  return {
    lngLat, preset: req.preset, lineType: req.lineType, ...(req.presetPatch ? { presetPatch: req.presetPatch } : {}),
    from: req.from, to: req.to, ...(s.result?.bufferM ? { bufferM: s.result.bufferM } : {}),
    ...(req.uploads ? { uploads: req.uploads } : {}),
  };
}
const cellKeyOf = (req: InspectRequest, cell: readonly number[]) =>
  JSON.stringify([req.preset, req.lineType, req.presetPatch ?? null, req.bufferM ?? null, cell]);

/** The cell the last reply covers, when `req` falls in it. */
function cachedFor(p: Pane, req: InspectRequest): Outcome<InspectResult> | null {
  const g = p.insp.grid, last = p.insp.last;
  if (!g || !last) return null;
  const [x, y] = albersForward(req.lngLat[0], req.lngLat[1]);
  return last.key === cellKeyOf(req, [Math.floor((x - g.x0) / g.cell), Math.floor((g.y0 - y) / g.cell)]) ? last.out : null;
}

function keepReply(p: Pane, req: InspectRequest, out: Outcome<InspectResult>): void {
  if (!out.ok) return;
  p.insp.grid = out.result.grid;
  p.insp.last = { key: cellKeyOf(req, out.result.cell), out };
}

function queueInspect(p: Pane, e: MapPointerEvent, hole: boolean): void {
  hideInspectTimer(p);
  if (p.pending > 0 || p.session.status.kind === 'solving') { p.itip.hidden = true; return; }
  const req = inspectRequest(p, [e.lngLat.lng, e.lngLat.lat]);
  if (!req) return;
  const at = { x: e.point.x, y: e.point.y };
  const hit = cachedFor(p, req);
  if (hit) { renderInspect(p, hit, at, hole); return; }
  const my = p.insp.seq;
  p.insp.timer = setTimeout(() => {
    void inspectCell(req).then((out) => {
      if (pane !== p) return;
      keepReply(p, req, out);
      if (my === p.insp.seq && (p.inspectOn || hole)) renderInspect(p, out, at, hole);
    });
  }, INSPECT_DEBOUNCE_MS);
}
/** Drops a queued request (a newer hover replaces it) without hiding the shown tooltip. */
function hideInspectTimer(p: Pane): void {
  clearTimeout(p.insp.timer);
  p.insp.seq++;
}

/** The tap is on a hole in the drawn similar-cost areas (the route pane reads that cell). */
function holeTap(p: Pane, e: MapPointerEvent): boolean {
  const map = state.map;
  return !!map && !state.routePick && !!p.session.result && !!p.surf && !!map.getLayer('rp-surface')
    && holeAt(p.surf.img, p.surf.src.image, [e.lngLat.lng, e.lngLat.lat]);
}

/** A click or tap with Inspect on (or on a hole in the similar-cost areas): pin the cell's card. */
function onTap(e: MapPointerEvent): void {
  const p = pane, map = state.map;
  if (!p || !map || state.routePick || !p.session.result) return;
  const hole = holeTap(p, e);
  if (!p.inspectOn && !hole) return;
  if (p.pending > 0 || p.session.status.kind === 'solving') return;
  const req = inspectRequest(p, [e.lngLat.lng, e.lngLat.lat]);
  if (!req) return;
  const at = { x: e.point.x, y: e.point.y };
  const my = ++p.insp.pinSeq;
  const hit = cachedFor(p, req);
  if (hit) { renderCard(p, hit, at, hole); return; }
  void inspectCell(req).then((out) => {
    if (pane !== p) return;
    keepReply(p, req, out);
    if (my === p.insp.pinSeq) renderCard(p, out, at, hole);
  });
}

/** `el` near `at`, kept in the map's visible part: left of the layer panel, above the drawer. */
function placeNear(el: HTMLElement, at: { x: number; y: number }): void {
  const box = state.map?.getContainer(), pad = drawerPadding();
  const maxX = (box?.clientWidth ?? 0) - pad.right + 28, maxY = (box?.clientHeight ?? 0) - pad.bottom + 32;
  el.style.left = '0px';            // measured unwrapped by the previous position
  el.style.top = '0px';
  const tw = el.offsetWidth, th = el.offsetHeight;
  let left = at.x + 16, top = at.y + 16;
  if (maxX > 0 && left + tw > maxX) left = Math.max(4, at.x - 16 - tw);
  if (maxY > 0 && top + th > maxY) top = at.y - 16 - th >= 4 ? at.y - 16 - th : Math.max(4, maxY - th);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** The cell's cause line, with the threshold in front on the similar-cost "hole" path. */
function headlineOf(p: Pane, r: InspectResult, hole: boolean): string {
  const head = textOf(r.explain.head ?? r.explain.cause, t);
  return hole ? t('route.insp.hole', { pct: Math.round(p.session.threshold * 100), cause: head }) : head;
}

/** Hover preview: one line, the cause and its routing factor. */
function renderInspect(p: Pane, out: Outcome<InspectResult>, at: { x: number; y: number }, hole: boolean): void {
  const tip = p.itip;
  if (noHover()) { tip.hidden = true; return; }
  tip.replaceChildren(h('b', 'rp-it-cause', out.ok ? headlineOf(p, out.result, hole) : t('route.insp.err', { reason: out.reason })));
  tip.hidden = false;
  placeNear(tip, at);
}

/** The class colour a fact maps to, from the Routing constraints palettes; undefined where it has none. */
function swatchFor(f: Fact): string | undefined {
  const hit = (r: { band: string; bit?: number; values?: number[]; mask?: number }) =>
    r.band === f.band && (r.bit !== undefined ? r.bit === f.bit : f.value !== undefined && !!r.values?.includes(f.value & (r.mask ?? 0xff)));
  for (const c of CONCERNS) {
    const k = c.classes?.find((x) => x.rules.some(hit));
    if (k) return k.colour;
  }
  for (const c of CONCERNS) if (c.rule && hit(c.rule)) return c.colour;
  if (f.band === 'agency') return LAND_MANAGER_PALETTE.find((c) => c.rules.some(hit))?.colour;
  for (const c of CONSTRAINT_PALETTE) if (c.rules.some(hit)) return c.colour;
  return undefined;
}

/** Pinned card: what is here, the rules applied, the raw values folded. Text only. */
function renderCard(p: Pane, out: Outcome<InspectResult>, at: { x: number; y: number }, hole: boolean): void {
  const card = p.icard;
  p.pin = { out, at, hole };
  p.itip.hidden = true;
  card.replaceChildren();
  const close = h('button', 'rp-ic-x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('route.insp.close'));
  close.addEventListener('click', () => closeCard(p));
  const head = h('b', 'rp-ic-head', out.ok ? headlineOf(p, out.result, hole) : t('route.insp.err', { reason: out.reason }));
  head.id = 'rp-ic-head';
  card.append(close, head);
  if (out.ok) {
    const { explain: e, decoded, inMask } = out.result;
    if (inMask === false) card.append(h('div', 'rp-it-note', t('route.insp.outside')));
    const chips = h('div', 'rp-ic-chips');
    chips.append(e.barrier ? h('span', 'rp-ic-chip rp-ic-chip--block', t('route.insp.chipBlocked')) : h('span', 'rp-ic-chip', t('route.insp.chipRoute', { x: fmtX(e.routeW) })));
    chips.append(h('span', 'rp-ic-chip rp-ic-chip--cost', t('route.insp.chipCost', { x: fmtX(e.costX) })));
    card.append(chips);

    card.append(h('div', 'rp-it-h', t('route.insp.here')));
    const facts = presentFacts(decoded);
    if (!facts.length) card.append(h('div', 'rp-ic-none', t('route.insp.hereNone')));
    else {
      const ul = h('ul', 'rp-ic-facts');
      for (const f of facts) {
        const li = h('li');
        const sw = h('span', 'rp-ic-sw');
        const col = swatchFor(f);
        if (col) sw.style.background = col; else sw.classList.add('rp-ic-sw--none');
        li.append(sw, h('span', '', textOf(f.label, t)));
        ul.append(li);
      }
      card.append(ul);
    }

    if (e.rows.length || e.exempted.length) {
      card.append(h('div', 'rp-it-h', t('route.insp.rulesTitle')));
      const ul = h('ul', 'rp-ic-rules');
      const named = (label: string, note?: string) => (note && note.toLowerCase() !== label.toLowerCase() ? `${label} — ${note}` : label);
      const rows = [...e.rows].sort((a, b) => Number(b.winsRoute) - Number(a.winsRoute));
      for (const r of rows) {
        const li = h('li', r.winsRoute ? 'rp-it-win' : 'rp-it-lose');
        li.append(h('span', '', named(textOf(r.label, t), r.note)), h('span', 'rp-ic-x2', `×${fmtX(r.r)}${r.c !== 1 ? ` · ${t('route.insp.costX', { x: fmtX(r.c) })}` : ''}`));
        ul.append(li);
      }
      for (const x of e.exempted) {
        const li = h('li', 'rp-it-exempt');
        const name = h('span');
        name.append(h('s', '', named(textOf(x.label, t), x.note)), h('span', '', ` (${x.exceptLabel})`));
        li.append(name);
        ul.append(li);
      }
      card.append(ul);
    }

    const raw = h('details', 'rp-ic-raw');
    raw.append(h('summary', '', t('route.insp.raw')));
    const dl = h('dl', 'rp-it-bands');
    for (const d of decoded) dl.append(h('dt', '', textOf(d.label, t)), h('dd', '', d.text.map((x) => textOf(x, t)).join(', ')));
    raw.append(dl);
    card.append(raw);
  }
  const dock = typeof matchMedia === 'function' && matchMedia(INSPECT_DOCK).matches;
  card.classList.toggle('rp-icard--dock', dock);
  p.dockRo?.disconnect();
  p.dockRo = undefined;
  const wasHidden = card.hidden;
  card.hidden = false;
  if (dock) {
    card.style.left = ''; card.style.top = ''; card.style.bottom = `${drawerPadding().bottom}px`;
    // The docked card rides above the drawer: follow its height as it is dragged.
    if (typeof ResizeObserver === 'function') {
      p.dockRo = new ResizeObserver(() => { card.style.bottom = `${drawerPadding().bottom}px`; });
      p.dockRo.observe(p.main.closest('.rp')?.parentElement ?? p.main);
    }
  }
  else { card.style.bottom = ''; placeNear(card, at); }
  syncEsc(p);
  if (wasHidden) card.focus({ preventScroll: true });
}

/** The weight image can be drawn: its pixels, or (once drawn and dropped) the canvas holding them. */
function weightReady(p: Pane, img: RouteResult['weightImage'] | RowsImage): boolean {
  return !!img && 'rgba' in img && (img.rgba.length > 0 || p.weight?.src === img);
}

/** A result without a drawable weight image (a skipped one is final). */
function needsWeight(p: Pane, r: RouteResult | null): boolean {
  const img = r?.weightImage;
  return !!r && (!img || ('rgba' in img && !weightReady(p, img)));
}

function setShowWeight(p: Pane, on: boolean): void {
  p.showWeight = on;
  setInspect(p, on);
  p.weightError = null;
  if (on && p.weightMode === 'rows') { resetRowsTried(p, p.session.inputs); void repaintRowsNow(p); }
  else if (on && needsWeight(p, p.session.result)) void fetchWeight(p);
  else drawWeight(p);
  syncInspectControls(p);
}

/** A solve of ours settled while the weight fetch waited: fetch it now unless that solve brought the image. */
function weightSettled(p: Pane): void {
  if (pane !== p || p.pending > 0 || !p.weightDeferred) return;
  p.weightDeferred = false;
  p.weightLoading = false;
  const r = p.session.result;
  if (p.showWeight && needsWeight(p, r)) { void fetchWeight(p); return; }
  drawWeight(p);
  syncInspectControls(p);
}

/** One solve with the routing-weight overlay for the shown result's inputs; only the image is kept.
 *  Never alongside another solve of ours: while one is pending it waits for it to settle. */
async function fetchWeight(p: Pane): Promise<void> {
  const s = p.session, base = s.result, inp = s.resultInputs;
  if (!base || !inp || p.weightLoading) return;
  const req = requestFor(inp, { patch: inp.patch, profile: false, alternatives: 0, surface: false }, p.weightMode);
  if (typeof req === 'string') { p.weightError = req; p.showWeight = false; syncInspectControls(p); return; }
  p.weightLoading = true;
  syncInspectControls(p);
  if (p.pending > 0) { p.weightDeferred = true; return; }
  const out = await run(p, req);
  if (pane !== p) return;
  p.weightLoading = false;
  if (!out.ok && out.reason === 'cancelled') {
    // A newer solve of ours cancelled it: not an error; ask again once that one settles.
    p.weightLoading = p.weightDeferred = p.showWeight;
    if (p.pending === 0) weightSettled(p);
    syncInspectControls(p);
    return;
  }
  const img = out.ok ? out.result.weightImage : undefined;
  if (s.result === base && img && 'rgba' in img) {
    s.result = { ...base, weightImage: img };
    if (p.weightMode === 'rows') void repaintRowsNow(p);
    else drawWeight(p);
  } else if (s.result === base) {
    p.weightError = !out.ok ? out.reason : img && 'skipped' in img ? img.skipped : null;
    if (p.weightMode === 'rows') { p.weightError ??= t('route.insp.nodata'); drawWeight(p); }
    else p.showWeight = false;
  }
  syncInspectControls(p);
}

function releaseWeight(p: Pane): void {
  removeOverlay(['rp-weight'], ['rp-weight']);
  if (p.weight) { p.weight.canvas.width = 0; p.weight.canvas.height = 0; }
  p.weight = null;
}

/** Switched off, only the layer goes: the canvas stays for switching on again (the RGBA is dropped once drawn). */
function drawWeight(p: Pane): void {
  const rows = p.weightMode === 'rows';
  const img = rows ? p.rowsImg : p.session.result?.weightImage, map = state.map;
  if (rows && p.showWeight && !img && !p.weightError) { renderLegend(p); return; }   // its image is on the way: the picture stays, dimmed
  if (!p.showWeight || !img || !weightReady(p, img) || !('rgba' in img) || !map) {
    if (p.weight?.src !== img) releaseWeight(p);
    else removeOverlay(['rp-weight'], ['rp-weight']);
    renderLegend(p);
    return;
  }
  if (p.weight?.src === img && map.getLayer('rp-weight')) return;
  if (p.weight?.src !== img && !paintWeight(p, img)) return;
  if (!map.getSource('rp-weight')) map.addSource('rp-weight', { type: 'canvas', canvas: p.weight!.canvas, coordinates: img.coordinates, animate: false });
  if (!map.getLayer('rp-weight')) addLayer({ id: 'rp-weight', type: 'raster', source: 'rp-weight', paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest' } });
  renderLegend(p);
}

/** Writes `img` into the one weight canvas — in place when the size matches (a shown source is
 *  replayed for one frame to upload it), else resized with its source re-added — then drops its RGBA. */
function paintWeight(p: Pane, img: WeightImage | RowsImage): boolean {
  const map = state.map!;
  let w = p.weight;
  if (!w || w.canvas.width !== img.width || w.canvas.height !== img.height) {
    removeOverlay(['rp-weight'], ['rp-weight']);
    const canvas = w?.canvas ?? document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    if (!g) return false;
    w = p.weight = { src: img, canvas, g, data: g.createImageData(img.width, img.height), mode: img.mode ?? 'route' };
  }
  w.data.data.set(img.rgba);
  w.g.putImageData(w.data, 0, 0);
  const coordsMoved = JSON.stringify(w.src.coordinates) !== JSON.stringify(img.coordinates);
  w.src = img;
  w.mode = img.mode ?? 'route';
  img.rgba = new Uint8ClampedArray(0);   // the canvas holds the pixels now; nothing re-reads them
  const src = map.getSource('rp-weight') as CanvasSource | undefined;
  if (src) {
    if (coordsMoved) src.setCoordinates(img.coordinates);
    src.play();
    map.once('render', () => src.pause());
    map.triggerRepaint();
  }
  return true;
}

/** The overlay for `patch` (on the shown result's method, line type and the shown mode), repainted by the
 *  worker from its held window. False when it was refused (no window, a bad patch); a stale reply is dropped. */
async function repaintNow(p: Pane, patch: PresetPatch | null): Promise<boolean> {
  if (p.weightMode === 'rows') return false;
  const inp = p.session.resultInputs;
  if (!inp?.a || !inp.b) return false;
  const m = methodFor(inp.presetId, patch);
  if (typeof m === 'string') return false;
  const my = ++p.rp.seq, t0 = performance.now();
  const out = await repaintWeight({
    from: inp.a.lngLat, to: inp.b.lngLat, preset: m.preset, lineType: inp.lineType, mode: p.weightMode as WeightMode, ...(m.patch ? { presetPatch: m.patch } : {}),
    ...(uploadHashes(m.patch).length ? { uploads: uploadHashes(m.patch) } : {}),
  });
  if (pane !== p || my !== p.rp.seq) return true;
  if (!out.ok) return false;
  p.rp.ms = performance.now() - t0;
  const r = p.session.result;
  if (!r || !p.showWeight) return true;
  r.weightImage = out.result.image;      // in place: the result object (and what compares it) stays
  drawWeight(p);
  syncInspectControls(p);
  return true;
}

/** Each valid Method edit: repaint the shown overlay PREVIEW_DEBOUNCE_MS after the last one. */
function previewPatch(p: Pane, patch: PresetPatch | null): void {
  clearTimeout(p.rp.timer);
  p.rp.timer = undefined;
  const s = p.session;
  if (p.weightMode === 'rows' || !p.showWeight || !s.result || !s.resultInputs || s.inputs.presetId !== s.resultInputs.presetId) return;
  p.rp.timer = setTimeout(() => { p.rp.timer = undefined; void repaintNow(p, patch); }, PREVIEW_DEBOUNCE_MS);
}

/** Routing weight | Cost ×: repainted from the worker's window, or one solve when it holds none. */
async function setWeightMode(p: Pane, mode: OverlayMode): Promise<void> {
  if (p.weightMode === mode || (mode === 'rows' && !p.session.highlight.length)) return;
  p.weightMode = mode;
  p.weightError = null;
  resetRowsTried(p, p.session.inputs);
  syncInspectControls(p);
  renderLegend(p);
  const s = p.session, inp = s.resultInputs;
  if (!p.showWeight || !s.result || !inp) return;
  if (mode === 'rows') { void repaintRowsNow(p); return; }
  if (!(await repaintNow(p, shownPatch(s))) && pane === p && p.weightMode === mode) void fetchWeight(p);
}

/** The Method grid's highlighted rows over the worker's held window; no window → one weight fetch, then once more. */
async function repaintRowsNow(p: Pane): Promise<void> {
  const s = p.session, inp = s.resultInputs;
  if (!inp?.a || !inp.b || !s.result || !p.showWeight || p.weightMode !== 'rows' || !s.highlight.length) return;
  const m = methodFor(inp.presetId, inp.patch);
  if (typeof m === 'string') { p.weightError = m; p.rowsImg = null; drawWeight(p); syncInspectControls(p); return; }
  const my = ++p.rp.seq;
  // Uploaded-layer rows: their hashes name the window, and add_rows picks them after the preset's rows.
  const uploads = uploadHashes(m.patch);
  const out = await repaintRows({
    from: inp.a.lngLat, to: inp.b.lngLat, lineType: inp.lineType, preset: m.preset, rows: s.highlight,
    ...(uploads.length ? { presetPatch: { add_rows: m.patch!.add_rows }, uploads } : {}),
  });
  if (pane !== p || my !== p.rp.seq || p.weightMode !== 'rows') return;
  if (out.ok) {
    p.weightError = null;
    p.rowsImg = out.result.image;
    drawWeight(p);
  } else if (!p.rowsTried && NO_WINDOW_REASONS.some((r) => out.reason.startsWith(r))) {
    p.rowsTried = true;
    void fetchWeight(p);
  } else {
    p.weightError = out.reason;
    p.rowsImg = null;
    drawWeight(p);
  }
  syncInspectControls(p);
}

/** Highlighted rows belong to a base preset: another base clears them (Save as custom keeps the base). */
function syncHighlightBase(p: Pane): void {
  const base = baseOf(p.session.inputs.presetId);
  if (base === p.hlBase) return;
  p.hlBase = base;
  if (p.session.highlight.length) highlightRows(p, []);
}

function highlightRows(p: Pane, picks: RowPick[]): void {
  p.session.highlight = picks;
  if (!picks.length) {
    p.rowsImg = null;
    if (p.weightMode === 'rows') { p.weightMode = 'route'; setShowWeight(p, false); }
    else syncInspectControls(p);
    return;
  }
  p.weightMode = 'rows';
  p.showWeight = true;
  setInspect(p, true);
  resetRowsTried(p, p.session.inputs);
  p.weightError = null;
  syncInspectControls(p);
  void repaintRowsNow(p);
}

// ─── RouteTabContext ─────────────────────────────────────────────────────────

function makeContext(p: Pane): RouteTabContext {
  const s = p.session;
  const live = () => pane === p;
  return {
    session: s,
    money: (usd2025, usdPreset) => fmtMoney(s.dollars === 'y2025' ? usd2025 : usdPreset),
    setColourMode(m) {
      s.colour = m;
      rememberPrefs(p);
      if (live() && s.result && state.map?.getSource('rp-route')) setGeojson('rp-route', routeFeatures(s.result, m));
      renderLegend(p);
    },
    setProfileMarker(mi, label) {
      p.markerAt = mi === null ? null : { mi, label };
      if (live()) drawMarker(p);
    },
    showCrossings(kinds, onOff) {
      const set = new Set(s.crossingKinds);
      for (const k of kinds) if (onOff) set.add(k); else set.delete(k);
      s.crossingKinds = [...set];
      if (live() && state.map?.getLayer('rp-cross')) drawCrossings(p);   // re-added with the new filter
    },
    fitMiles(mi0, mi1) {
      const r = s.result;
      if (r) fitLine(slicePath(r.path, Math.max(0, mi0 / r.lengthMi), Math.min(1, mi1 / r.lengthMi)));
    },
    fitPoints(lngLats) { fitLine(lngLats); },
    listExactCrossings() { void listExact(p); },
    setThreshold(th: SurfaceThreshold) {
      s.threshold = th;
      if (live()) drawSurface(p);
    },
    showSurface(onOff) {
      s.showSurface = onOff;
      rememberPrefs(p);
      if (live()) drawSurface(p);
    },
    findAlternatives() { void findAlternatives(p); },
    makeAltResult(i) {
      const r = s.result, opt = s.optimal ?? r;
      if (!r || !opt) return;
      if (i < 0) {
        if (!s.optimal) return;
        s.result = opt;
        clearExact(s);
        s.fromAlt = s.optimal = undefined;
      } else {
        const alt = opt.alternatives?.[i];
        if (!alt || s.fromAlt === i + 1) return;
        // The least-cost result's alternatives stay as they are (numbering kept); otherRoutes()
        // lists them without the shown one, and the least-cost route as "Optimal (least cost)".
        s.result = {
          ...opt, path: alt.path, lengthMi: alt.lengthMi, cost: alt.cost, segments: [], tribalMiles: alt.cost.tribalMiles,
          profile: alt.crossings ? { runs: [], samples: [], crossings: alt.crossings } : undefined,
        };
        clearExact(s);
        s.optimal = opt;
        s.fromAlt = i + 1;
      }
      s.previous = slimRoute(r);
      p.markerAt = null;
      drawResult(p);
      renderMain(p, true);
      renderStrip(p);
    },
    async resolve(patch) {
      s.inputs.patch = patch;
      await solve(p, { patch, profile: true, alternatives: 0, surface: false });
    },
    runSolves(specs, onEach) {
      let stopped = false;
      const inp = s.resultInputs ?? s.inputs;
      const done = (async () => {
        for (let i = 0; i < specs.length && !stopped && live(); i++) {
          const req = requestFor(inp, specs[i]);
          if (typeof req === 'string') { onEach(i, null, req); continue; }
          const out = await run(p, req);
          if (stopped || !live()) return;
          if (out.ok) onEach(i, out.result);
          else { onEach(i, null, out.reason); if (out.reason === 'cancelled') return; }
        }
      })();
      return { cancel() { stopped = true; cancelOurs(p); }, done };
    },
    setGhost(path) {
      if (!live()) return;
      if (!path) { removeOverlay(['rp-ghost', 'rp-ghost-casing'], ['rp-ghost']); return; }
      setGeojson('rp-ghost', { type: 'Feature', geometry: path, properties: {} });
      if (!state.map?.getLayer('rp-ghost')) {
        addLayer({ id: 'rp-ghost-casing', type: 'line', source: 'rp-ghost',
          layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 } });
        addLayer({ id: 'rp-ghost', type: 'line', source: 'rp-ghost',
          paint: { 'line-color': '#334155', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
      }
    },
    setTall(onOff) { setRouteTall(onOff); },
    setMethodErrors(n) { if (live()) p.inputs.setErrors(n); },
    rerender() { if (live()) { syncHighlightBase(p); renderMain(p, true); renderActions(p); renderStrip(p); } },
    previewPatch(patch) { if (live()) previewPatch(p, patch); },
    highlightRows(picks) { if (live()) highlightRows(p, picks); },
  };
}

const exactRequests = new WeakMap<RouteSession, object>();
const clearExact = (s: RouteSession): void => { exactRequests.delete(s); s.exact = null; s.exactBusy = false; s.exactError = null; };

/** "List crossings by name": exact crossings of the shown result, kept while it is shown. */
async function listExact(p: Pane): Promise<void> {
  const s = p.session, r = s.result;
  if (!r?.profile || s.exactBusy) return;
  const key = pathKey(r.path, r.lengthMi);
  const token = {};
  exactRequests.set(s, token);
  s.exactBusy = true;
  s.exactError = null;
  p.ctx.rerender();
  const out = await exactCrossings({
    polylines: [(r.path.coordinates as LngLat[]).map(([lng, lat]) => albersForward(lng, lat))],
    lengthsMi: [r.lengthMi],
  });
  if (pane !== p) return;
  const now = s.result;
  if (!now || exactRequests.get(s) !== token || pathKey(now.path, now.lengthMi) !== key || !s.exactBusy) return;
  s.exactBusy = false;
  if (out.ok) s.exact = { ...out.result, forPath: key };
  else if (out.reason !== 'cancelled') s.exactError = out.reason;
  drawCrossings(p);
  p.ctx.rerender();
}

/** One solve with similar-cost areas + 3 alternatives for the shown result's inputs;
 *  only alternatives, surface, altFound and altSkipped are merged into the result. */
async function findAlternatives(p: Pane, count = p.prefs.altCount): Promise<void> {
  const s = p.session, shown = s.result, base = s.optimal ?? shown, inp = s.resultInputs;
  if (!base || !inp || s.altsSolving) return;
  const req = requestFor(inp, { patch: inp.patch, profile: false, alternatives: count, surface: true });
  if (typeof req === 'string') { s.altsError = req; p.ctx.rerender(); return; }
  req.altStretch = s.altStretch;
  cancelOurs(p);
  s.altsSolving = true;
  s.altsError = null;
  renderMain(p, true);
  const out = await run(p, req);
  if (pane !== p) return;
  s.altsSolving = false;
  if (s.result !== shown) return;   // a newer result replaced the one these belong to
  if (out.ok) {
    const { alternatives, surface, altFound, altSkipped } = out.result;
    s.result = { ...base, alternatives, surface, altFound, altSkipped };   // new alternatives: back to the least-cost route
    clearExact(s);
    s.fromAlt = s.optimal = undefined;
    drawResult(p);
  } else if (out.reason !== 'cancelled') {
    s.altsError = out.reason;
  }
  renderMain(p, true);
}

// ─── the map chat (planRoute) ────────────────────────────────────────────────

type ChatOutcome = Outcome<RouteSummary>;
const refuse = (reason: string): ChatOutcome => ({ ok: false, reason });
const BUSY = 'a route is being solved; try again when it finishes';
const REPLACED = 'the visitor started another route';
const CLOSED = 'the route panel was closed';

/** The method's preset (a saved method's own), for its line types; undefined when it is not usable. */
function sessionPreset(presetId: string) {
  if (!presetId.startsWith('custom:')) return routePreset(presetId);
  const c = presetStore.list().find((x) => `custom:${x.id}` === presetId);
  return c?.status === 'ok' ? c.preset : undefined;
}
/** The method's label as the panel lists it: a saved method by its own name. */
function methodLabelOf(presetId: string): string {
  if (presetId.startsWith('custom:')) return presetStore.list().find((x) => `custom:${x.id}` === presetId)?.name ?? presetId;
  const b = routePreset(presetId);
  return b ? presetLabel(b) : presetId;
}
const chatEnd = (re: RouteInputs['a']): ChatRouteEnd =>
  ({ name: re?.hit?.name ?? null, kv: re?.hit?.maxKv ?? null, lngLat: re?.lngLat ?? [0, 0] });

/** The shown route as the chat's summary; `extra` notes go first (≤ 3 notes, the estimate-range one kept last). */
function summaryOf(p: Pane, extra: string[] = []): ChatOutcome {
  const s = p.session, r = s.result, inp = s.resultInputs;
  if (!r || !inp) return refuse('no route yet');
  // The Cost tab's preset, so the drivers are the Cost tab's lines.
  const preset = routePreset(r.preset.id) ?? routePreset(r.cost.preset) ?? ROUTE_PRESETS[0];
  const out = chatSummary(r, preset, methodLabelOf(inp.presetId), chatEnd(inp.a), chatEnd(inp.b));
  if (extra.length) {
    const last = out.notes[out.notes.length - 1];
    out.notes = [...[...extra, ...out.notes.slice(0, -1)].slice(0, 2), last];
  }
  return { ok: true, result: out };
}

const isBusy = (p: Pane) => p.session.status.kind === 'solving' || p.session.altsSolving || p.pending > 0;

const inBox = (lng: number, lat: number) => lng >= -125 && lng <= -66 && lat >= 24 && lat <= 50;

type EndPlan = { at: [number, number] } | { hit: SnapHit; note?: string };

/** One end of the request → where it goes, or a refusal (end resolution rule). */
function planEnd(end: End, v: string | [number, number], idx: SubstationIndex | null, kv: number): EndPlan | string {
  if (Array.isArray(v)) {
    const [x, y] = v;
    if (v.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) return `end ${end}: give [lng, lat]`;
    if (y >= -125 && y <= -66 && x >= 24 && x <= 50) return `end ${end} looks like [lat, lng]; give [lng, lat]`;
    if (!inBox(x, y)) return `end ${end} is outside the contiguous US (routing covers lng -125…-66, lat 24…50)`;
    return { at: [x, y] };
  }
  const q = v.trim().toLowerCase();
  const asked = cleanName(v.trim()) ?? '';
  if (!idx || q.length < 2) return `end ${end}: give a substation name or [lng, lat]`;
  const floor = kvFloor(kv);
  const exact = idx.subs.filter((x) => !x.isPlaceholder && x.lname === q);
  const toHit = (x: (typeof exact)[number]): SnapHit =>
    ({ id: x.id, name: x.name, lngLat: [x.lng, x.lat], maxKv: x.maxKv, kvUnknown: x.maxKv === null, distanceKm: NaN, states: x.states, ba: x.ba });
  if (exact.length === 1) {
    const x = exact[0];
    if (x.maxKv !== null && x.maxKv >= floor) return { hit: toHit(x) };
    return { hit: toHit(x), note: x.maxKv === null ? `end ${end}: the substation's kV is unknown` : `end ${end}: the substation is below the line type's kV` };
  }
  const cands = (exact.length > 1 ? exact.slice(0, 5).map(toHit) : searchSubstations(idx, q, kv, 5)).map((c) =>
    `${cleanName(c.name) ?? '?'} (${c.maxKv === null ? 'kV unknown' : `${Math.round(c.maxKv)} kV`}${c.states.length ? `, ${c.states.join('/')}` : ''})`);
  if (!cands.length) return `no substation is named "${asked}" (end ${end}); ask the visitor for another name or a point`;
  return `ambiguous end ${end} "${asked}": ${exact.length > 1 ? `${exact.length} substations have this name` : 'no exact name match'}; ask the visitor which: ${cands.join('; ')}`;
}

const DECLINED = 'the visitor declined the route usage notice; no route was planned';

/** The map chat's planRoute. Shows the route usage notice first when the pane is not open (Cancel refuses).
 *  Opens the pane in the background (Ask stays in view, no focus move), refuses while a
 *  solve of ours runs, solves on the visitor's path (then findAlternatives with the chat's count, ≤ 2), refuses
 *  when a visitor solve replaced its call, cancels on Stop only while its own call is in flight, and with no
 *  ends summarises the shown route. Routing refusals from the engine pass through. */
export async function routeForChat(req: ChatRouteRequest, signal?: AbortSignal): Promise<ChatOutcome> {
  const hasFrom = req.from !== undefined, hasTo = req.to !== undefined;
  if (hasFrom !== hasTo) return refuse('give both from and to, or neither to recall the shown route');
  if (!hasFrom) {
    if (!pane) return refuse('no route yet');
    return isBusy(pane) ? refuse(BUSY) : summaryOf(pane);
  }
  if (signal?.aborted) return refuse('cancelled');
  if (!noticeAccepted('route', ROUTE_NOTICE_VERSION)) {
    if (!(await showNotice('route'))) return refuse(DECLINED);
    if (signal?.aborted) { forgetNotice('route'); return refuse('cancelled'); }
  }
  if (!pane) pane = createPane(true);
  else openRoute(dispose, undefined, { background: true });
  const p = pane, s = p.session;
  const busy = () => isBusy(p);
  if (busy()) return refuse(BUSY);

  // Line type first: the kV floor of a named end follows it.
  const preset = sessionPreset(s.inputs.presetId) ?? ROUTE_PRESETS[0];
  const lineType = req.lineType ?? s.inputs.lineType;
  if (!(lineType in preset.line_types)) return refuse(`unknown line type "${cleanName(lineType)}"; use one of: ${Object.keys(preset.line_types).join(', ')}`);
  const kv = preset.line_types[lineType].kv.value;

  let idx: SubstationIndex | null = null;
  if (typeof req.from === 'string' || typeof req.to === 'string') {
    const o = await p.inputs.substationIndex();
    if (!o.ok) return o;
    if (pane !== p) return refuse(CLOSED);
    idx = o.result;
  }
  const a = planEnd('A', req.from!, idx, kv), b = planEnd('B', req.to!, idx, kv);
  if (typeof a === 'string') return refuse(a);
  if (typeof b === 'string') return refuse(b);
  if (busy()) return refuse(BUSY);

  // Place the ends without making the chat's choices the visitor's defaults.
  p.chatDriving = true;
  try {
    if (lineType !== s.inputs.lineType) p.chatLineType = lineType;
    s.inputs.lineType = lineType;
    p.inputs.refresh();
    for (const [end, plan] of [['A', a], ['B', b]] as const) {
      if ('at' in plan) await p.inputs.setEnd(end, plan.at);
      else await p.inputs.setEndHit(end, plan.hit);
      if (pane !== p) return refuse(CLOSED);
    }
  } finally { p.chatDriving = false; }
  if (busy()) return refuse(BUSY);
  if (signal?.aborted) return refuse('cancelled');

  const before = p.call;
  const solving = solve(p, { patch: s.inputs.patch, profile: true, alternatives: 0, surface: false });
  if (p.call === before) { await solving; return refuse(s.status.kind === 'error' ? s.status.reason : t('route.err.ends')); }
  const my = p.call;
  const onAbort = () => { if (pane === p && p.call === my && p.pending > 0) cancelRoute(); };
  signal?.addEventListener('abort', onAbort);
  try {
    const landed = await solving;
    if (pane !== p) return refuse(CLOSED);
    if (p.call !== my) return refuse(REPLACED);
    if (!landed) {
      if (signal?.aborted) return refuse('cancelled');
      return refuse(p.refineError ?? (s.status.kind === 'error' ? s.status.reason : 'cancelled'));
    }
    const notes = [a, b].flatMap((x) => ('note' in x && x.note ? [x.note] : []));
    const n = Math.min(Math.max(0, Math.floor(req.alternatives ?? 0)), 2);
    if (n > 0 && s.result?.routeCost !== null) {
      await findAlternatives(p, n);
      if (pane !== p) return refuse(CLOSED);
      if (p.call !== my) return refuse(REPLACED);
      if (signal?.aborted) return refuse('cancelled');
      if (s.altsError) notes.push(`alternatives: ${s.altsError}`);
    }
    return summaryOf(p, notes);
  } finally { signal?.removeEventListener('abort', onAbort); }
}

on('lang:changed', () => {
  const p = pane;
  if (!p) return;
  renderMain(p, true);
  renderActions(p);
  renderStrip(p);
  renderLegend(p);
  if (p.session.result) drawAlternatives(p);
  if (p.pin) renderCard(p, p.pin.out, p.pin.at, p.pin.hole);
});

/** Test hook: the open pane's session and context (undefined when closed). */
export function _pane(): { session: RouteSession; ctx: RouteTabContext; repaintMs: number | null } | undefined {
  return pane ? { session: pane.session, ctx: pane.ctx, repaintMs: pane.rp.ms } : undefined;
}
