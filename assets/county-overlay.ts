// ─── County overlay: one template's per-county colours on the main map ──────
// Role: the session-only choropleth a page-owned template paints on the main
//       map (per-county results paint the map, the card shows the
//       ranking): a colour per county as MapLibre feature-state on the SHARED
//       `county_boundaries` source (layers/layer-init.ts, promoteId = GEOID),
//       under the one namespaced key `tpl_v` (NRI writes nri_*, ODIN odin_*,
//       NWS its own, so none of them touch this key and this module touches
//       no other), drawn by its own fill + outline pair above the static county
//       choropleths and below the live layers (add-all-layers.ts order), with a
//       legend card in #legendContainer.
//         paintCountyOverlay(colours, legend)  GEOID → '#rrggbb' (anything
//                    else dropped); replaces the overlay there is (one at a
//                    time), returns its token. `legend` may be a function: it is
//                    called again on every lang:changed.
//         clearCountyOverlay(token?, {restore?})  removes it when `token` is the
//                    current one (or none is given); with restore (a frame
//                    that failed to draw) the overlay it replaced comes back
//                    instead. True when something was cleared.
//         ownCountyOverlay(token, alive)  ties an overlay to its card.
//         countyOverlayHeld(token)  the overlay is current or the held prev.
//         countyOverlayToken()   the current token, or null.
//         onCountyOverlay(fn)    called after every paint, restore and clear;
//                    returns the unsubscribe.
//       Not view state: never in the link — no url:write, no undo step,
//       not restored after a reload. Cleared by Reset (ui.ts and map-api.ts
//       call clearCountyOverlay after applyView({})), by its card's × or its
//       Clear map colours button, by the legend card's Clear, and by the next
//       paint. Feature-state sticks to loaded tiles only, so the colours are
//       written again on the first `idle` after county tiles load (the NRI
//       pattern). A basemap change keeps the source, the layers and their
//       state (basemap.ts never calls setStyle).
//
//
// Deps: state.ts (map), state-bus.ts (on: lang:changed), constants.ts (COUNTY_SRC*), layers/layer-plan.ts
//       (applyLayerPlan), layers/layer-init.ts (countyBoundariesSource),
//       ui/ui-legends.ts (updateLegends: the legend container's shown state),
//       i18n (t).
// Used by: templates/show-template.ts (points-per-polygon by counties),
//       ui/ui-canvas.ts (the card's Clear button and ×), ui/ui.ts and
//       map-api.ts (Reset).

import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import { state } from './state.js';
import { on } from './state-bus.js';
import { COUNTY_SRC as SRC, COUNTY_SRC_LAYER as SRC_LAYER } from './constants.js';
import { applyLayerPlan } from './layers/layer-plan.js';
import { countyBoundariesSource } from './layers/layer-init.js';
import { updateLegends } from './ui/ui-legends.js';
import { t } from '../src/i18n/index.js';

/** The overlay's one feature-state key on the shared county features. */
export const OVERLAY_KEY = 'tpl_v';
export const OVERLAY_LAYERS = ['tpl-county-fill', 'tpl-county-line'] as const;
/** The overlay goes directly above this layer: over the NRI outline, under ODIN, NWS, wildfire and radar. */
const ABOVE = 'fema-nri-line';
const LEGEND_ID = 'tplCountyLegend';
const GEOID = /^\d{5}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export interface CountyLegend {
  title: string;
  /** One row per colour class, lowest first. */
  classes: { colour: string; label: string }[];
  note?: string;
}

interface Overlay {
  token: number; colours: Map<string, string>; legend: () => CountyLegend;
  /** The overlay this one replaced, for a restore when this one's frame fails. */
  prev?: Overlay;
  /** Whether the card that owns it is still in the page. */
  alive?: () => boolean;
}

let current: Overlay | null = null;
let seq = 0;
let dirty = false;
let hooked: unknown = null;
const listeners = new Set<() => void>();

export const countyOverlayToken = (): number | null => current?.token ?? null;
export const countyOverlayHeld = (token: number): boolean => current?.token === token || current?.prev?.token === token;

export function ownCountyOverlay(token: number, alive: () => boolean): void {
  const o = current?.token === token ? current : current?.prev?.token === token ? current.prev : null;
  if (o) o.alive = alive;
}

export function onCountyOverlay(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { queueMicrotask(() => { throw e; }); } } };
const target = (id: string) => ({ source: SRC, sourceLayer: SRC_LAYER, id });

function apply(): void {
  const map = state.map;
  if (!map || !current || !map.getSource(SRC)) return;
  for (const [id, colour] of current.colours) map.setFeatureState(target(id), { [OVERLAY_KEY]: colour });
  dirty = false;
}

function unset(o: Overlay): void {
  const map = state.map;
  if (!map || !map.getSource(SRC)) return;
  for (const id of o.colours.keys()) map.removeFeatureState(target(id), OVERLAY_KEY);
}

function layers(): LayerSpecification[] {
  const v = ['feature-state', OVERLAY_KEY] as ExpressionSpecification;
  const unlit = ['==', v, null] as ExpressionSpecification;
  const base = { source: SRC, 'source-layer': SRC_LAYER, layout: { visibility: 'visible' } } as const;
  return [
    { ...base, id: OVERLAY_LAYERS[0], type: 'fill', paint: {
      'fill-color': ['case', unlit, 'rgba(0,0,0,0)', ['to-color', v]],
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.78, 8, 0.6, 11, 0.4],
    } },
    { ...base, id: OVERLAY_LAYERS[1], type: 'line', paint: {
      'line-color': ['case', unlit, 'rgba(0,0,0,0)', '#334155'], 'line-width': 0.4, 'line-opacity': 0.55,
    } },
  ] as LayerSpecification[];
}

function ensureLayers(): void {
  const map = state.map;
  if (!map) return;
  if (hooked !== map) {
    hooked = map;
    map.on('sourcedata', e => {
      const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
      if (ev.sourceId === SRC && ev.isSourceLoaded) dirty = true;
    });
    map.on('idle', () => { if (current && dirty) apply(); });
  }
  if (map.getLayer(OVERLAY_LAYERS[0])) return;
  const ids = (map.getStyle()?.layers ?? []).map(l => l.id);
  const at = ids.indexOf(ABOVE);
  const beforeId = at >= 0 ? ids[at + 1] : undefined;
  applyLayerPlan(map, [countyBoundariesSource(), ...layers().map(layer => ({ layer, ...(beforeId && { beforeId }) }))]);
}

function removeLayers(): void {
  const map = state.map;
  if (!map) return;
  for (const id of [...OVERLAY_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
}

// ─── Legend card ─────────────────────────────────────────────────────────────
function renderLegend(o: Overlay): void {
  const legend = o.legend();
  document.getElementById(LEGEND_ID)?.remove();
  const lc = document.getElementById('legendContainer');
  if (!lc) return;
  const mk = (tag: string, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const box = mk('div', 'legend tpl-overlay-legend');
  box.id = LEGEND_ID;
  const head = box.appendChild(mk('div', 'legend-title'));
  head.appendChild(mk('span', 'legend-title-label', legend.title));
  const clear = head.appendChild(mk('button', 'unfilter-btn tpl-overlay-clear', t('template.overlay.clear'))) as HTMLButtonElement;
  clear.type = 'button';
  clear.dataset.i18n = 'template.overlay.clear';
  clear.addEventListener('click', () => { clearCountyOverlay(o.token); });
  const items = box.appendChild(mk('div', 'legend-items'));
  for (const c of legend.classes) {
    const row = items.appendChild(mk('span', 'legend-item'));
    const sw = row.appendChild(mk('span', 'legend-swatch tpl-overlay-swatch'));
    sw.style.background = c.colour;
    row.appendChild(document.createTextNode(c.label));
  }
  if (legend.note) box.appendChild(mk('p', 'tpl-overlay-note', legend.note));
  lc.prepend(box);
  lc.hidden = false;
}

// ─── Paint and clear ─────────────────────────────────────────────────────────
function show(o: Overlay): void {
  current = o;
  ensureLayers();
  apply();
  dirty = true;   // tiles still loading take the colours on the next idle
  renderLegend(o);
  notify();
}

export function paintCountyOverlay(colours: Readonly<Record<string, string>>, legend: CountyLegend | (() => CountyLegend)): number {
  const clean = new Map<string, string>();
  for (const [id, c] of Object.entries(colours)) if (GEOID.test(id) && typeof c === 'string' && HEX.test(c)) clean.set(id, c);
  const prev = current ? { ...current, prev: undefined } : undefined;
  if (current) unset(current);
  show({ token: ++seq, colours: clean, legend: typeof legend === 'function' ? legend : () => legend, ...(prev && { prev }) });
  return seq;
}

export function clearCountyOverlay(token?: number, opts: { restore?: boolean } = {}): boolean {
  if (!current) return false;
  if (token !== undefined && token !== current.token) {
    if (current.prev?.token === token) delete current.prev;
    return false;
  }
  const back = opts.restore && current.prev && (current.prev.alive?.() ?? true) ? current.prev : null;
  unset(current);
  if (back) { show({ ...back, prev: undefined }); return true; }
  current = null;
  removeLayers();
  document.getElementById(LEGEND_ID)?.remove();
  updateLegends();
  notify();
  return true;
}

on('lang:changed', () => { if (current) renderLegend(current); });
