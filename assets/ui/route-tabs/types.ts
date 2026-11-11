// ─── Route panel: shared types ───────────────────────────────────────────────
// Role: the contract between the route pane shell (ui-route.ts), its input column
//       (route-inputs.ts) and the result sub-tabs (route-tabs/*.ts). A tab gets a
//       RouteTabContext and renders from `ctx.session`; it never imports ui-route.ts
//       (no import cycle) and changes the map only through the context's calls.
//       Session only: nothing here goes in the link or on the undo stack.
// Deps: route/route.ts, route/snap.ts, route/preset-patch.ts (types only).

import type { ExactCrossingsResult, RouteResult, RowPick } from '../../route/route.js';
import type { SnapHit } from '../../route/snap.js';
import type { PresetPatch } from '../../route/preset-patch.js';

/** One endpoint: a snapped substation, or a raw point (hit null). */
export interface RouteEnd { lngLat: [number, number]; hit: SnapHit | null }

/** What the input column edits. `presetId` is a built-in preset id or `custom:<id>`. */
export interface RouteInputs {
  a: RouteEnd | null;
  b: RouteEnd | null;
  lineType: string;
  presetId: string;
  patch: PresetPatch | null;   // session edits on top of the preset (Method tab); null = none
}

export type RouteSubTab = 'summary' | 'cost' | 'profile' | 'crossings' | 'alternatives' | 'method';
export type ColourMode = 'cost' | 'driver' | 'plain';
export type SurfaceThreshold = 0.02 | 0.05 | 0.10 | 0.20;
export type DollarYear = 'y2025' | 'preset';

export type RouteStatus =
  | { kind: 'idle' }
  | { kind: 'picking'; end: 'A' | 'B' }
  | { kind: 'solving'; step: string | null; started: number }
  | { kind: 'result' }
  | { kind: 'error'; reason: string };

/** What the delta chip needs of the result before the last re-solve (no images kept alive). */
export type PreviousRoute = Pick<RouteResult, 'path' | 'lengthMi' | 'cost'>;

/** The one per-pane state object; tabs read it and never copy it. */
export interface RouteSession {
  inputs: RouteInputs;
  status: RouteStatus;
  result: RouteResult | null;      // the shown result (an alternative after "Make Alt n the result")
  resultInputs: RouteInputs | null;// the inputs `result` was solved with (dirty check, Method "was" values)
  previous: PreviousRoute | null;  // the result before the last re-solve (delta chip)
  /** While "Make Alt n the result" shows an alternative: n (1-based, numbered as in `optimal.alternatives`). */
  fromAlt?: number;
  /** While an alternative is shown: the lowest-scoring result, listed as "Lowest routing score" to switch back. */
  optimal?: RouteResult;
  altsSolving: boolean;
  altsError: string | null;
  tab: RouteSubTab;
  colour: ColourMode;
  threshold: SurfaceThreshold;
  showSurface: boolean;
  dollars: DollarYear;
  liveTuning: boolean;
  /** Crossing kinds drawn as map markers (river, road, rail, pipeline, line230, line100). */
  crossingKinds: string[];
  /** The stretch (fraction above least routing cost) alternatives are searched within. */
  altStretch: number;
  /** Substation snap radius in km (3 when unset). */
  snapKm?: number;
  /** "List crossings by name" (route.ts exactRouteCrossings): routes[0] is the shown result;
   *  used only while `forPath` (crossings.ts pathKey) is the shown result's. Cleared on a new result. */
  exact?: (ExactCrossingsResult & { forPath: string }) | null;
  exactBusy?: boolean;
  /** Why the last "List crossings by name" failed (one line in the Crossings tab). */
  exactError?: string | null;
  /** The Method grid's rows highlighted on the map (session only). */
  highlight: RowPick[];
}

/** One solve request the tabs may ask the shell to run (sensitivity, live tuning). */
export interface SolveSpec { patch: PresetPatch | null; profile: boolean; alternatives: number; surface: boolean }

/** Everything a sub-tab may do. Implemented by ui-route.ts. */
export interface RouteTabContext {
  session: RouteSession;
  /** Money in the session's dollar year: "$3.10 B", "$716 M". */
  money(usd2025: number, usdPreset: number): string;
  setColourMode(m: ColourMode): void;
  /** A point on the route at `mi`; `label` (e.g. "mi 132 · 1,134 m") replaces the default "mi 132". */
  setProfileMarker(mi: number | null, label?: string): void;
  /** Add (`on`) or remove these kinds from session.crossingKinds and redraw the markers. */
  showCrossings(kinds: string[], on: boolean): void;
  fitMiles(mi0: number, mi1: number): void;
  fitPoints(lngLats: [number, number][]): void;
  /** Read the exact crossings of the shown result into session.exact (busy state, markers, rerender). */
  listExactCrossings(): void;
  setThreshold(t: SurfaceThreshold): void;
  showSurface(on: boolean): void;
  findAlternatives(): void;
  /** Show alternative `i` (index into the least-cost result's alternatives) as the result; -1 = the least-cost route again. */
  makeAltResult(i: number): void;
  /** Re-solve the current inputs with this patch (Method tab); resolves when shown. */
  resolve(patch: PresetPatch | null): Promise<void>;
  /** Run solves one at a time; onEach gets each outcome; the returned cancel stops the run. */
  runSolves(specs: SolveSpec[], onEach: (i: number, r: RouteResult | null, reason?: string) => void): { cancel(): void; done: Promise<void> };
  setGhost(path: GeoJSON.LineString | null): void;
  setTall(on: boolean): void;
  /** The Method tab's invalid-cell count, shown in the input column (Find is held while > 0). */
  setMethodErrors(n: number): void;
  rerender(): void;
  /** A valid Method edit (the session patch): the shell repaints the cell-weight overlay for it, debounced
   *  (no-op while the overlay is off or the worker holds no window). Optional for test contexts. */
  previewPatch?(patch: PresetPatch | null): void;
  /** The Method grid's Map toggles: show these rows on the map (empty = none). Optional for test contexts. */
  highlightRows?(picks: RowPick[]): void;
}

/** A result sub-tab. `render` fills `el` from ctx.session; `dispose` drops listeners/map state.
 *  `update`, when present, is called instead of dispose + render when a re-solve of the shown
 *  route lands while the tab is mounted (live tuning): it refreshes from the new result and
 *  keeps the rest of the DOM — and the focused element — in place. */
export interface RouteTab {
  id: RouteSubTab;
  labelKey: string;
  /** Why the tab is disabled for this session, or null. */
  disabled(s: RouteSession): string | null;
  render(el: HTMLElement, ctx: RouteTabContext): void;
  update?(el: HTMLElement, ctx: RouteTabContext): void;
  dispose?(): void;
}
