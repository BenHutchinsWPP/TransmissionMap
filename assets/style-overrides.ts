// ─── Per-layer style overrides: the view's `style` section on the map ────────
// state.styleOverrides[registryId] = { opacity?, size?, color? } spreads to the
// LayerDef's mapLayerIds by MapLibre layer type (STYLE_PROPS). opacity and size
// are multipliers on each map layer's own baseline value (scaleBy); color
// replaces it. Baselines are read off the map the first time an override
// touches a (layer, property) and restored exactly when it goes away; the
// registry and src/colors/* are never mutated.
// Colour-by: OGF planned lines and WestTEC 10-Yr take their line-color from a
// mode (state.ogfColorBy / state.westtecColorBy, the private COLOR_BY table).
// setColorBy() validates and writes the mode, then repaints; a view's colour
// override still wins over it, and clearing that override returns the line to
// the current mode. The weather wash's crossfade opacity folds the override in
// itself (weather-live.ts).
// Smoke opacity belongs to the smoke slider and is not overridable; the
// weather wash takes opacity only, its raster pair folded in by weather-live.ts
// and its border-line layers scaled here. Colour skips `-casing` map layers.
// setStyle() validates and paints one layer; clearStyle() drops one or all;
// applyAllStyles() repaints every override and colour-by from state
// (whole-view applies, Reset, undo) and returns the keys it had to skip,
// removing them from state so they never reach a link or view file;
// listStylable() names what each registry layer accepts. The map-free checks
// (keys, ranges, colours, barred keys) live in src/registry/view-validate.ts;
// effectiveOverride() is the one validated read of state for other writers.
// Deps: state.ts, registry (LAYERS, layerById), view-validate.ts,
// src/colors/buckets.ts (ogfColorExpr, westtecColorExpr and their mode lists
// OGF_COLOR_MODES, WESTTEC_COLOR_MODES), state-bus.js. The
// weather wash repaints on the 'style:weather' event, so this module never
// imports weather-live.ts (that chain reaches filters.ts). It imports no UI
// module: ui-legends.ts derives the colour-key dimming from state itself.
// Imported by: hover.ts (scaleBy, effectiveOverride), weather-live.ts
// (effectiveOverride), ui-filters.ts (setColorBy), view-state.ts
// (applyAllStyles), dev-console.ts (setStyle, clearStyle, listStylable).

import { state } from './state.js';
import type { StyleOverride } from '../src/types.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import {
  ogfColorExpr, westtecColorExpr, OGF_COLOR_MODES, WESTTEC_COLOR_MODES, type OgfColorMode, type WesttecColorMode,
} from '../src/colors/buckets.js';
import type { ExpressionSpecification } from 'maplibre-gl';
import { emit } from './state-bus.js';
import { STYLE_KEYS, barredReason, keyError, validateStyleOverride, type StyleKey } from '../src/registry/view-validate.js';

const KEYS = STYLE_KEYS;

// Symbol layers take no colour: no project icon is SDF, so icon-color/halo do nothing.
const STYLE_PROPS: Record<StyleKey, Record<string, string[]>> = {
  opacity: {
    circle: ["circle-opacity", "circle-stroke-opacity"],
    line: ["line-opacity"],
    fill: ["fill-opacity"],
    symbol: ["icon-opacity", "text-opacity"],
    raster: ["raster-opacity"],
    heatmap: ["heatmap-opacity"],
    "fill-extrusion": ["fill-extrusion-opacity"],
  },
  size: {
    circle: ["circle-radius"],
    line: ["line-width"],
    symbol: ["icon-size", "text-size"],
  },
  color: {
    circle: ["circle-color"],
    line: ["line-color"],
    fill: ["fill-color"],
  },
};
const LAYOUT_PROPS = new Set(["icon-size", "text-size"]);
// MapLibre spec defaults, for a multiplier on a property the builder left unset.
const SPEC_DEFAULT: Record<string, number> = {
  "circle-radius": 5, "line-width": 1, "icon-size": 1, "text-size": 16,
};

const WEATHER_ID = "weather-live";
// Colour-by layers: line-color comes from the state field's mode, unless the
// view's colour override replaces it.
const COLOR_BY: Record<string, {
  mapLayerId: string;
  modes: readonly string[];
  field: "ogfColorBy" | "westtecColorBy";
  expr: (mode: string) => ExpressionSpecification;
}> = {
  "ogf-planned-transmission": {
    mapLayerId: "ogf-planned-lines", modes: OGF_COLOR_MODES, field: "ogfColorBy",
    expr: m => ogfColorExpr(m as OgfColorMode),
  },
  "westtec-10yr": {
    mapLayerId: "westtec-lines", modes: WESTTEC_COLOR_MODES, field: "westtecColorBy",
    expr: m => westtecColorExpr(m as WesttecColorMode),
  },
};
// The white casing under a planned line is its "planned" cue; colour skips it.
const isCasing = (mlId: string) => mlId.endsWith("-casing");

const baselines = new Map<string, unknown>(); // `${mapLayerId}|${prop}` → original value
const touched = new Set<string>();             // registry ids painted with an override

/** Multiply a size/opacity value by k. A top-level zoom interpolate/step has
 *  each stop output scaled (MapLibre forbids ["zoom"] nested inside "*"). */
export function scaleBy<T>(value: T, k: number): T {
  const v: unknown = value;
  if (k === 1 || (typeof v !== "number" && !Array.isArray(v))) return value;
  if (typeof v === "number") return (v * k) as T;
  const isZoom = (x: unknown) => Array.isArray(x) && x[0] === "zoom";
  const outputs = (head: number) =>
    [...v.slice(0, head), ...v.slice(head).map((x, i) => (i % 2 ? scaleBy(x, k) : x))];
  if (v[0] === "interpolate" && isZoom(v[2])) return outputs(3) as T;
  if (v[0] === "step" && isZoom(v[1])) {
    const r = outputs(3);
    r[2] = scaleBy(v[2], k);
    return r as T;
  }
  return ["*", k, v] as T;
}

function mapLayerType(mlId: string): string | undefined {
  return (state.map?.getLayer(mlId) as { type?: string } | undefined)?.type;
}

function accepts(registryId: string): StyleKey[] {
  const entry = layerById(registryId);
  if (!entry) return [];
  return KEYS.filter(k => !barredReason(registryId, k)
    && entry.mapLayerIds.some(id => {
      const t = mapLayerType(id);
      return t && STYLE_PROPS[k][t] && !(k === "color" && isCasing(id));
    }));
}

function mapError(registryId: string, k: StyleKey): string | null {
  if (accepts(registryId).includes(k)) return null;
  return k === "color"
    ? `"${registryId}" takes no color: its icons and labels cannot be tinted`
    : `"${registryId}" has no map layer that takes ${k}`;
}

function styleError(registryId: string, o: StyleOverride): string | null {
  const err = validateStyleOverride(registryId, o);
  if (err) return err;
  for (const k of KEYS) {
    if (o[k] === undefined) continue;
    const e = mapError(registryId, k);
    if (e) return e;
  }
  return null;
}

/** The valid part of a registry layer's stored override (map-free): each key
 *  that fails validation is left out. The one read for writers that fold an
 *  override into their own property. */
export function effectiveOverride(registryId: string): StyleOverride {
  const raw: unknown = Object.hasOwn(state.styleOverrides, registryId) ? state.styleOverrides[registryId] : undefined;
  const out: StyleOverride = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (Object.hasOwn(raw, k) && v !== undefined && !keyError(registryId, k, v)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface DroppedStyle { id: string; key: string; reason: string }

// Property names come from STYLE_PROPS, never from input.
interface PropMap {
  getPaintProperty(id: string, p: string): unknown;
  getLayoutProperty(id: string, p: string): unknown;
  setPaintProperty(id: string, p: string, v: unknown): void;
  setLayoutProperty(id: string, p: string, v: unknown): void;
}

function readProp(mlId: string, prop: string): unknown {
  const m = state.map as unknown as PropMap;
  return LAYOUT_PROPS.has(prop) ? m.getLayoutProperty(mlId, prop) : m.getPaintProperty(mlId, prop);
}

function writeProp(mlId: string, prop: string, value: unknown) {
  const m = state.map as unknown as PropMap;
  if (LAYOUT_PROPS.has(prop)) m.setLayoutProperty(mlId, prop, value);
  else m.setPaintProperty(mlId, prop, value);
}

// Paint one registry layer from state: every supported property an override
// sets, and every property an earlier override touched (back to its baseline).
// Keys the layer cannot take are skipped and returned.
function paint(registryId: string): DroppedStyle[] {
  const entry = layerById(registryId);
  if (!entry || !state.map) return [];
  const o = effectiveOverride(registryId);
  const dropped: DroppedStyle[] = [];
  const raw: unknown = Object.hasOwn(state.styleOverrides, registryId) ? state.styleOverrides[registryId] : undefined;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    dropped.push({ id: registryId, key: "style", reason: "style must be an object" });
  } else if (raw) {
    for (const k of Object.keys(raw)) {
      const err = keyError(registryId, k, (raw as Record<string, unknown>)[k])
        ?? ((KEYS as string[]).includes(k) ? mapError(registryId, k as StyleKey) : null);
      if (err) {
        dropped.push({ id: registryId, key: k, reason: err });
        delete o[k as StyleKey];
      }
    }
  }
  if (registryId === WEATHER_ID) emit('style:weather');
  for (const mlId of entry.mapLayerIds) {
    const type = mapLayerType(mlId);
    if (!type || (registryId === WEATHER_ID && type === "raster")) continue;
    for (const k of KEYS) {
      if (k === "color" && isCasing(mlId)) continue;
      for (const prop of STYLE_PROPS[k][type] ?? []) {
        if (k === "color" && COLOR_BY[registryId]?.mapLayerId === mlId) { paintColorBy(registryId); continue; }
        const key = `${mlId}|${prop}`;
        if (o[k] === undefined && !baselines.has(key)) continue;
        if (!baselines.has(key)) baselines.set(key, readProp(mlId, prop));
        const base = baselines.get(key);
        writeProp(mlId, prop,
          o[k] === undefined ? base
          : k === "color" ? o.color
          : scaleBy(base ?? SPEC_DEFAULT[prop] ?? 1, o[k]));
      }
    }
  }
  if (Object.keys(o).length) touched.add(registryId);
  else touched.delete(registryId);
  return dropped;
}

function paintColorBy(registryId: string) {
  const c = COLOR_BY[registryId];
  if (!state.mapReady || !state.map?.getLayer(c.mapLayerId)) return;
  state.map.setPaintProperty(c.mapLayerId, "line-color", effectiveOverride(registryId).color ?? c.expr(state[c.field]));
}

/** Switch a colour-by layer (OGF planned lines, WestTEC 10-Yr) to `mode` and
 *  repaint it; state is written even before the map exists. Returns null, or
 *  the reason it was rejected — state and map untouched. */
export function setColorBy(registryId: string, mode: string): string | null {
  const c = Object.hasOwn(COLOR_BY, registryId) ? COLOR_BY[registryId] : undefined;
  if (!c) return `"${registryId}" has no colour-by`;
  if (!c.modes.includes(mode)) return `"${registryId}" has no colour-by mode "${mode}"`;
  Object.assign(state, { [c.field]: mode });
  paintColorBy(registryId);
  return null;
}

/** Set one registry layer's override (replacing any earlier one; `{}` clears
 *  it) and paint it. Returns null, or the reason it was rejected — state and
 *  map untouched. */
export function setStyle(registryId: string, override: StyleOverride): string | null {
  if (!state.map) return "the map is not ready";
  const err = styleError(registryId, override);
  if (err) return err;
  const clean: StyleOverride = {};
  for (const k of KEYS) if (override[k] !== undefined) (clean as Record<string, unknown>)[k] = override[k];
  const next = { ...state.styleOverrides };
  if (Object.keys(clean).length) next[registryId] = clean;
  else delete next[registryId];
  state.styleOverrides = next;
  paint(registryId);
  return null;
}

/** Drop one layer's override, or every override. */
export function clearStyle(registryId?: string) {
  if (registryId === undefined) {
    state.styleOverrides = {};
    applyAllStyles();
    return;
  }
  const next = { ...state.styleOverrides };
  delete next[registryId];
  state.styleOverrides = next;
  paint(registryId);
}

/** Repaint every override and colour-by from state — for a whole-view apply
 *  (cold boot, applyView, Reset, undo): call once after state is written. A
 *  layer whose override vanished returns to its baseline. Returns the keys it
 *  skipped (invalid, or not takeable by that layer) so the caller can say so. */
export function applyAllStyles(): DroppedStyle[] {
  if (!state.map) return [];
  const dropped = [...new Set([...touched, ...Object.keys(state.styleOverrides)])].flatMap(paint);
  if (dropped.length) {
    const next: Record<string, StyleOverride> = {};
    for (const [id, o] of Object.entries(state.styleOverrides)) {
      const gone = new Set(dropped.filter(d => d.id === id).map(d => d.key));
      if (gone.has("style")) continue;
      const kept = Object.fromEntries(Object.entries(o).filter(([k]) => !gone.has(k)));
      if (Object.keys(kept).length) next[id] = kept;
    }
    state.styleOverrides = next;
  }
  for (const id of Object.keys(COLOR_BY)) paintColorBy(id);
  return dropped;
}

/** Every registry layer on the map that takes an override, with what it takes. */
export function listStylable(): { id: string; accepts: StyleKey[] }[] {
  return LAYERS.map(l => ({ id: l.id, accepts: accepts(l.id) })).filter(l => l.accepts.length);
}
