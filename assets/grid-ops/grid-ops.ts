// ─── Grid Operations layer: controller ────────────────────────────────────────
// Role: drive the `ba-interchange` layer (Grid Operations, EIA-930): while it
//       is on, read the selected hour through eia930-read.ts (a lazy chunk,
//       imported on first use), turn it into features with ba-graph.ts and put
//       them on the two GeoJSON sources the layer plan made
//       (layers/map-layers-load.ts planGridOps). Owns the hour bar
//       (#gridOpsTimebar in index.html: previous / play / next, date, hour)
//       and the two view settings the layer row edits: grouping and glyph.
// View state: state.gridHour (hour-ending epoch ms; null = the latest hour
//       the data holds), state.gridGroup, state.gridGlyph, state.gridNumbers
//       (numbers on bubbles; null = auto, see ba-graph.ts numbersShown; turned on
//       by the visitor, they show at every zoom, else from z4.5) — in the
//       link as `gt`, `gg`, `gd` (url-state-codec.ts; `gn` is the link's part of
//       numbers, wired separately). setGridView() is the one way
//       a view sets them (view-state.ts: links, Reset, Undo, stories); the
//       hour bar and the row's selects commit with `url:write`; a grouping
//       change closes the open popup, which names a node of the old grouping. Playback moves
//       the hour without writing the link and commits once when it stops, so
//       an animation is one undo step, not hundreds.
// Glyphs: "bubble" — a circle sized by max(load, generation) against the
//       largest in its interconnection, solid dark when the BA exports (net
//       interchange ≥ 0), white when it imports; the label (code / L / G / EXP
//       or IMP) sits beside the circle, so it reads at any size. "disc" — the generation's fuel mix as a pie
//       (the fuel legend's colours) inside a dashed ring sized by load, drawn
//       per hour into map images `bai-pie-<id>`; the bubble circle stays as
//       the click target, transparent.
// Rings: a node with a generation ÷ load ratio (`cover`) gets a canvas ring image
//       `bai-ring-<id>` just outside its bubble or disc: full dark blue when
//       generation covers load, else an orange arc of that fraction over a grey
//       track (ringSpec decides; no ring for external nodes or no ratio).
// Paint listeners: gridShown() is the hour last painted (null when nothing is
//       shown); onGridPaint(cb) calls cb at the end of every paint, and with
//       null when the layer is cleared (the Grid Ops drawer tab renders from it).
// Deps: state, state-bus (on 'layer:visibility', 'lang:changed'; emit
//       'url:write'), i18n (t, getLocale), src/colors/fuel.ts, ba-graph.ts;
//       eia930-read.ts dynamically; map-input.ts (onMapTap on bai-bubbles) +
//       popup.ts (toolOwnsTap) + ui/grid-ops-open.ts: a bubble tap opens the
//       drawer's Grid Ops tab on that node unless a tool owns the tap.
//       Started by ui/ui.ts init().

import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { state } from '../state.js';
import { on, emit } from '../state-bus.js';
import { t, getLocale } from '../../src/i18n/index.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import { buildHour, arrowAt, sizeScale, numbersShown, GROUP_BYS, GRID_GLYPHS, type GroupBy, type GridGlyph, type HourData, type NodeProps } from './ba-graph.js';
import type { ReadOutcome } from './eia930-read.js';
import { onMapTap } from '../map-input.js';
import { toolOwnsTap } from '../popup.js';
import { openGridOps } from '../ui/grid-ops-open.js';

export const GRID_LAYER = "ba-interchange";
export const GRID_NODES_SRC = "ba-interchange-nodes";
export const GRID_EDGES_SRC = "ba-interchange-edges";

const HOUR = 3_600_000;
const PLAY_MS = 900;
// Bubble and disc radius at zoom 5, px: area ∝ MW, the largest node of each
// interconnection (sizeScale) at R_MAX, so the West is not drawn to MISO's scale.
export const R_MAX = 32;
const R_MIN = 6;
const radius = (mw: number, top: number) => top > 0 ? R_MAX * Math.sqrt(Math.max(0, mw) / top) : R_MIN;
const FUEL_COLOR = new Map(FUEL_LEGEND.map(f => [f.id, f.color]));

const reader = () => import('./eia930-read.js');
let range: { first: number; last: number } | null = null;
let shown: HourData | null = null;          // the hour on the map
let seq = 0;                                // the latest load asked for wins
let playing = false;
let playTimer: ReturnType<typeof setTimeout> | null = null;
let pieIds = new Set<string>();
let ringIds = new Set<string>();
let lastShown: GridShown | null = null;
const paintListeners = new Set<(s: GridShown | null) => void>();

export type PaintedNode = GeoJSON.Feature<GeoJSON.Point, NodeProps & { exp: boolean; r: number }>;
export interface GridShown { at: number; group: GroupBy; nodes: PaintedNode[] }
/** The hour last painted; null when nothing is shown. */
export function gridShown(): GridShown | null { return lastShown; }
/** Call `cb` at the end of every paint (null when the layer is cleared); returns the unsubscribe. */
export function onGridPaint(cb: (s: GridShown | null) => void): () => void {
  paintListeners.add(cb);
  return () => { paintListeners.delete(cb); };
}
function notifyPaint() {
  for (const cb of [...paintListeners]) { try { cb(lastShown); } catch { /* a listener must not break the map */ } }
}

const RING_FULL = "#1e3a8a", RING_ARC = "#ea580c", RING_TRACK = "#cbd5e1";
export const RING_COLORS = [RING_FULL, RING_ARC, RING_TRACK] as const;
/** How a node's ring is drawn from gen ÷ load: null = none, full = closed, else an arc of `frac`. */
export function ringSpec(cover: number | null): { full: boolean; frac: number } | null {
  if (cover == null || !Number.isFinite(cover)) return null;
  if (cover >= 1) return { full: true, frac: 1 };
  return { full: false, frac: Math.min(1, Math.max(0, cover)) };
}

const isVisible = () => !!state.layerVisibility[GRID_LAYER];
/** The hour shown: the view's, else the last the data holds. */
export function gridHour(): number | null { return state.gridHour ?? range?.last ?? null; }

// ─── View setter ─────────────────────────────────────────────────────────────
/** Links, Reset, Undo and stories land here. Unknown values fall back to the defaults. */
export function setGridView(hour: number | null, group: string, glyph: string, numbers?: boolean | null) {
  state.gridHour = hour != null && Number.isFinite(hour) ? Math.round(hour / HOUR) * HOUR : null;
  state.gridGroup = (GROUP_BYS as readonly string[]).includes(group) ? group as GroupBy : "ba";
  state.gridGlyph = (GRID_GLYPHS as readonly string[]).includes(glyph) ? glyph as GridGlyph : "bubble";
  if (numbers !== undefined) state.gridNumbers = typeof numbers === "boolean" ? numbers : null;
  if (isVisible()) void showHour();
}

/** The numbers-on-bubbles checkbox: an explicit choice. */
export function setGridNumbers(on: boolean) {
  state.gridNumbers = on;
  if (shown) paint(shown);
  emit('url:write');
}

/** The row's selects. */
export function setGridGroup(group: string) {
  // The open popup names a node of the old grouping.
  if (group !== state.gridGroup) state.popup?.remove();
  setGridView(state.gridHour, group, state.gridGlyph); emit('url:write');
}
export function setGridGlyph(glyph: string) { setGridView(state.gridHour, state.gridGroup, glyph); emit('url:write'); }

// ─── Loading and painting ────────────────────────────────────────────────────
async function showHour() {
  const my = ++seq;
  setStatus(t('gridOps.loading'));
  const r = await reader();
  if (!range) {
    const span = await r.hourRange();
    if (my !== seq) return;
    if (!span.ok) { setStatus(t('gridOps.offline')); return; }
    range = { first: span.first, last: span.last };
  }
  const at = clampHour(gridHour()!);
  renderBar(at);
  const out: ReadOutcome = await r.readHour(at);
  if (my !== seq || !isVisible()) return;
  if (!out.ok) {
    setStatus(t(out.reason === 'no-data' ? 'gridOps.noData' : 'gridOps.offline'));
    paint(null);
    return;
  }
  setStatus("");
  paint(out.hour);
}

function clampHour(at: number) {
  if (!range) return at;
  return Math.min(range.last, Math.max(range.first, at));
}

function fmt(mw: number | null) { return mw == null ? "–" : Math.round(mw).toLocaleString(getLocale()); }

function paint(hour: HourData | null) {
  const map = state.map;
  if (!map) return;
  shown = hour;
  lastShown = null;
  const nodesSrc = map.getSource(GRID_NODES_SRC) as GeoJSONSource | undefined;
  const edgesSrc = map.getSource(GRID_EDGES_SRC) as GeoJSONSource | undefined;
  if (!nodesSrc || !edgesSrc) return;
  if (!hour) {
    nodesSrc.setData({ type: "FeatureCollection", features: [] });
    edgesSrc.setData({ type: "FeatureCollection", features: [] });
    for (const id of [...pieIds, ...ringIds]) if (map.hasImage(id)) map.removeImage(id);
    pieIds = new Set(); ringIds = new Set();
    notifyPaint();
    return;
  }
  const { nodes, edges } = buildHour(hour, state.gridGroup);
  const disc = state.gridGlyph === "disc";
  const pies = new Set<string>();
  const rings = new Set<string>();
  const numbers = numbersShown(state.gridNumbers, state.gridGroup);
  const top = new Map<string, number>();
  for (const f of nodes.features) {
    const k = sizeScale(f.properties.id, state.gridGroup);
    top.set(k, Math.max(top.get(k) ?? 0, f.properties.size));
  }
  const features = nodes.features.map(f => {
    const p = f.properties;
    const exp = p.net != null && p.net >= 0;
    const net = p.net == null ? "" : t(exp ? 'gridOps.expShort' : 'gridOps.impShort', { mw: fmt(Math.abs(p.net)) });
    const lines = disc || p.kind === "external" ? [net] : [t('gridOps.loadShort', { mw: fmt(p.load) }), t('gridOps.genShort', { mw: fmt(p.gen) }), net];
    const scaleTop = top.get(sizeScale(p.id, state.gridGroup)) ?? 0;
    const r = p.kind === "external" ? R_MIN : Math.max(R_MIN, radius(p.size, scaleTop));
    let pie = "", ring = "";
    let ringR = r + 2.5;
    if (disc && p.kind === "ba") { pie = "bai-pie-" + p.id; ringR = drawPie(map, pie, p, scaleTop) + 2.5; pies.add(pie); }
    const spec = p.kind === "external" ? null : ringSpec(p.cover);
    if (spec) { ring = "bai-ring-" + p.id; drawRing(map, ring, ringR, spec); rings.add(ring); }
    return { ...f, properties: { ...p, at: hour.at, exp, pie, ring, r, early: state.gridNumbers === true, detail: numbers ? lines.filter(Boolean).join("\n") : "" } };
  });
  for (const id of pieIds) if (!pies.has(id) && map.hasImage(id)) map.removeImage(id);
  for (const id of ringIds) if (!rings.has(id) && map.hasImage(id)) map.removeImage(id);
  pieIds = pies; ringIds = rings;
  nodesSrc.setData({ type: "FeatureCollection", features });
  lastShown = { at: hour.at, group: state.gridGroup, nodes: features as unknown as PaintedNode[] };
  // Each edge twice: its curve (the line layer) and a point at the curve's
  // middle carrying the arrowhead's rotation and the MW label (the symbol layer).
  edgesSrc.setData({
    type: "FeatureCollection",
    features: edges.features.flatMap(e => {
      const properties = { ...e.properties, label: fmt(e.properties.mw) };
      const { at, rotate } = arrowAt(e.geometry.coordinates as [number, number][]);
      return [
        { ...e, properties },
        { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: at }, properties: { ...properties, rotate } },
      ];
    }),
  });
  const bubbleOpacity = disc ? 0 : 1;
  if (map.getLayer("bai-bubbles")) {
    map.setPaintProperty("bai-bubbles", "circle-opacity", bubbleOpacity);
    map.setPaintProperty("bai-bubbles", "circle-stroke-opacity", bubbleOpacity);
  }
  notifyPaint();
}

/** A 3 px ring of radius `rad` (zoom-5 px); the arc runs clockwise from 12 o'clock. */
function drawRing(map: MapLibreMap, id: string, rad: number, spec: { full: boolean; frac: number }) {
  const pr = 2, half = Math.ceil(rad + 3);
  const size = half * 2 * pr;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  if (!g) return;
  g.scale(pr, pr);
  g.lineWidth = 3;
  g.lineCap = "butt";
  const top = -Math.PI / 2;
  if (spec.full) {
    g.beginPath(); g.arc(half, half, rad, 0, Math.PI * 2); g.strokeStyle = RING_FULL; g.stroke();
  } else {
    g.beginPath(); g.arc(half, half, rad, 0, Math.PI * 2); g.strokeStyle = RING_TRACK; g.stroke();
    if (spec.frac > 0) { g.beginPath(); g.arc(half, half, rad, top, top + spec.frac * Math.PI * 2); g.strokeStyle = RING_ARC; g.stroke(); }
  }
  const img = g.getImageData(0, 0, size, size);
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, img, { pixelRatio: pr });
}

/** A pie of the positive fuels sized by their sum, inside a dashed ring sized
 *  by load; drawn at the zoom-5 scale, twice over for sharpness. Returns the
 *  outer radius, max(pie, load ring), for the coverage ring. */
function drawPie(map: MapLibreMap, id: string, p: NodeProps, scaleTop: number): number {
  const fuels = (JSON.parse(p.fuels) as [string, number][]).filter(([, mw]) => mw > 0);
  const total = fuels.reduce((s, [, mw]) => s + mw, 0) || Math.max(0, p.gen ?? 0);
  const rg = Math.max(3, radius(total, scaleTop)), rl = p.load == null ? 0 : Math.max(3, radius(p.load, scaleTop));
  const pr = 2, half = Math.ceil(Math.max(rg, rl) + 3);
  const size = half * 2 * pr;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  if (!g) return Math.max(rg, rl);
  g.scale(pr, pr);
  if (rl > rg) {   // the import gap: white inside the ring
    g.beginPath(); g.arc(half, half, rl, 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,0.92)"; g.fill();
  }
  let a = -Math.PI / 2;
  const slices: [string, number][] = fuels.length ? fuels : [["other", total]];
  for (const [fuel, mw] of slices) {
    const a1 = a + (mw / total) * Math.PI * 2;
    g.beginPath(); g.moveTo(half, half); g.arc(half, half, rg, a, a1); g.closePath();
    g.fillStyle = fuels.length ? FUEL_COLOR.get(fuel) ?? "#d1d5db" : "#94a3b8"; g.fill();
    g.strokeStyle = "#ffffff"; g.lineWidth = 0.6; g.stroke();
    a = a1;
  }
  if (rl) {
    g.setLineDash([3.5, 2.5]);
    g.beginPath(); g.arc(half, half, rl, 0, Math.PI * 2);
    g.strokeStyle = "#ffffff"; g.lineWidth = 3.4; g.stroke();
    g.strokeStyle = "#0f172a"; g.lineWidth = 1.5; g.stroke();
  }
  const img = g.getImageData(0, 0, size, size);
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, img, { pixelRatio: pr });
  return Math.max(rg, rl);
}

/** The arrowhead the interchange lines carry (an SDF, coloured by the layer). */
export function addGridOpsImages(map: MapLibreMap) {
  if (map.hasImage("bai-arrow")) return;
  const s = 24, pr = 2, cv = document.createElement("canvas");
  cv.width = cv.height = s * pr;
  const g = cv.getContext("2d");
  if (!g) return;
  g.scale(pr, pr);
  g.beginPath(); g.moveTo(20, 12); g.lineTo(5, 4); g.lineTo(8.5, 12); g.lineTo(5, 20); g.closePath();
  g.fillStyle = "#000"; g.fill();
  map.addImage("bai-arrow", g.getImageData(0, 0, s * pr, s * pr), { pixelRatio: pr, sdf: true });
}

// ─── Hour bar ────────────────────────────────────────────────────────────────
const bar = () => document.getElementById("gridOpsTimebar");

function setStatus(text: string) {
  const el = bar()?.querySelector<HTMLElement>(".gridops-status");
  if (el) { el.textContent = text; el.hidden = !text; }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The hour as the viewer's local date + hour-ending, with its zone. */
function hourLabel(at: number) {
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(at));
}

function renderBar(at?: number) {
  const el = bar();
  if (!el) return;
  const show = isVisible();
  el.hidden = !show;
  el.parentElement?.classList.toggle("has-gridops-bar", show);
  if (!show) return;
  const now = at ?? (range ? clampHour(gridHour()!) : null);
  const label = el.querySelector<HTMLElement>(".gridops-label");
  const date = el.querySelector<HTMLInputElement>("input[type=date]");
  const hour = el.querySelector<HTMLInputElement>("input[type=range]");
  const play = el.querySelector<HTMLButtonElement>("[data-gridops=play]");
  if (play) {
    play.textContent = playing ? "❚❚" : "▶";
    play.setAttribute("aria-label", t(playing ? 'gridOps.pause' : 'gridOps.play'));
    play.title = t(playing ? 'gridOps.pause' : 'gridOps.play');
  }
  if (now == null) return;
  const d = new Date(now);
  if (label) {
    label.textContent = hourLabel(now);
    label.title = t('gridOps.hourEndingUtc', { time: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00 UTC` });
  }
  if (date) {
    date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (range) {
      const lo = new Date(range.first), hi = new Date(range.last);
      date.min = `${lo.getFullYear()}-${pad(lo.getMonth() + 1)}-${pad(lo.getDate())}`;
      date.max = `${hi.getFullYear()}-${pad(hi.getMonth() + 1)}-${pad(hi.getDate())}`;
    }
  }
  if (hour) hour.value = String(d.getHours());
}

/** Move to `at` (clamped); a step outside playback commits to the link. */
function goTo(at: number, commit: boolean) {
  state.gridHour = clampHour(Math.round(at / HOUR) * HOUR);
  renderBar(state.gridHour);
  void showHour();
  if (commit) emit('url:write');
}

function step(dir: 1 | -1) {
  const at = gridHour();
  if (at != null) goTo(at + dir * HOUR, true);
}

function stopPlayback() {
  if (!playing) return;
  playing = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  renderBar();
  emit('url:write');
}

function startPlayback() {
  if (playing || !range) return;
  playing = true;
  renderBar();
  const tick = async () => {
    if (!playing) return;
    const at = gridHour();
    if (at == null || at >= range!.last) { stopPlayback(); return; }
    state.gridHour = at + HOUR;
    renderBar(state.gridHour);
    await showHour();
    if (playing) playTimer = setTimeout(tick, PLAY_MS);
  };
  playTimer = setTimeout(tick, 0);
}

function wireBar() {
  const el = bar();
  if (!el) return;
  el.addEventListener("click", e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-gridops]");
    if (!btn) return;
    const what = btn.dataset.gridops;
    if (what === "play") { if (playing) stopPlayback(); else startPlayback(); return; }
    stopPlayback();
    step(what === "next" ? 1 : -1);
  });
  el.addEventListener("change", e => {
    const input = e.target as HTMLInputElement;
    if (input.type !== "date" && input.type !== "range") return;
    stopPlayback();
    const date = el.querySelector<HTMLInputElement>("input[type=date]")?.value;
    const hour = Number(el.querySelector<HTMLInputElement>("input[type=range]")?.value ?? 0);
    const m = date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return;
    goTo(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour).getTime(), true);
  });
}

// ─── Wiring ──────────────────────────────────────────────────────────────────
function sync() {
  renderBar();
  if (isVisible()) void showHour();
  else { stopPlayback(); seq++; paint(null); }
}

export function initGridOps() {
  wireBar();
  on('layer:visibility', ({ id }) => { if (id === GRID_LAYER) sync(); });
  on('lang:changed', () => { renderBar(); if (shown) paint(shown); });
  onMapTap('bai-bubbles', (e, f) => {
    if (toolOwnsTap(e)) return;
    const id = f[0]?.properties?.id;
    if (typeof id === 'string') void openGridOps(id, state.map?.getCanvas());
  });
  const map = state.map;
  if (!map) return;
  if (state.mapReady) sync(); else map.once("load", sync);
}
