// ─── Routing constraints layer: the concern picker's state, url and legend ───
// Role: the one place a concern id becomes the layer's raster url
//       (routeConcernUrl: data/route/constraints/<concern-id>.pmtiles, beside
//       DATA.route_constraints) and the one setter for state.routeConcern
//       (setRouteConcern: picker, shared link, Undo, story and Reset all land
//       here). The setter writes state before its map guard, so seedView() can
//       call it before the map exists; on a live map it swaps the one raster
//       source's url through layer-plan.ts's setRasterUrl() (a source still held
//       keeps the url for its first show). Also renders the legend's body
//       (index.html #routeConstraintsLegend) from the palettes in
//       src/colors/route-constraints.ts: the precedence classes for the
//       overview, the manager colours for Land manager, one swatch for a mask, one per class for
//       a classes concern, then its notes and credit line (OpenStreetMap, PoPWest).
//       A concern that draws tribal land shows the Tribal layer's disclaimer, once a session
//       (routeConstraintsDisclaimer: from setRouteConcern and visibility.ts).
//       Text carries data-i18n keys, so ui.ts's lang:changed pass re-translates it.
// Deps: state.ts (map, routeConcern), constants.ts (DATA.route_constraints),
//       layers/layer-plan.ts (setRasterUrl, setMapLayerVisibility), tribal-disclaimer.ts, src/colors/route-constraints.ts
//       (CONCERNS, palettes, DEFAULT_CONCERN, isConcernId), src/i18n (t),
//       utils/utils.ts (escapeHtml).
// Called by: view-state.ts (seedView/applyView), ui/ui-filters.ts
//       (wireRouteConcernSelect), layers/map-layers-land.ts (routeConcernUrl, the
//       boot url). The layer itself is src/registry/land.ts routeConstraintsLayer
//       (dev server only).

import { state } from './state.js';
import { DATA } from './constants.js';
import { setRasterUrl, setMapLayerVisibility } from './layers/layer-plan.js';
import { showTribalDisclaimer } from './tribal-disclaimer.js';
import {
  CONSTRAINT_PALETTE, LAND_MANAGER_PALETTE, CONCERN_MAX_NOTE_KEY, CONCERN_MODE_NOTE_KEY, DEFAULT_CONCERN, concernById, concernColour, concernReadsOsm, isConcernId,
} from '../src/colors/route-constraints.js';
import { t } from '../src/i18n/index.js';
import { escapeHtml } from './utils/utils.js';

export const ROUTE_CONSTRAINTS_ID = "route-constraints";

/** The pmtiles:// url of concern `id`'s raster (the caller passes a CONCERNS id). */
export function routeConcernUrl(id: string): string {
  const path = DATA.route_constraints.replace(/[^/]+\.pmtiles$/, `${id}.pmtiles`);
  return "pmtiles://" + new URL(path, location.href).href;
}

const text = (key: string) => `<span data-i18n="${key}">${escapeHtml(t(key))}</span>`;
const item = (colour: string, key: string) =>
  `<div class="legend-item"><span class="legend-swatch" style="background:${colour}"></span>${text(key)}</div>`;
const note = (key: string) => `<div class="legend-item" style="opacity:0.55;font-size:0.75em">${text(key)}</div>`;

/** The legend body for concern `id` (an unknown id draws the default's). */
export function routeConcernLegendHtml(id: string): string {
  const c = concernById(id) ?? concernById(DEFAULT_CONCERN)!;
  if (c.kind === "overview") {
    return CONSTRAINT_PALETTE.map(k => item(k.colour, k.labelKey)).join("")
      + CONSTRAINT_PALETTE.flatMap(k => k.noteKey ? [note(k.noteKey)] : []).join("")
      + note("route.concern.noteMaxOverview");
  }
  if (c.kind === "categorical") {
    return LAND_MANAGER_PALETTE.map(k => item(k.colour, k.labelKey)).join("")
      + note("route.concern.noteUnshaded");
  }
  const rows = c.kind === "classes"
    ? (c.classes ?? []).map(k => item(k.colour, k.labelKey)).join("")
    : item(concernColour(c.id), c.labelKey);
  const resample = c.kind === "classes" && c.resampling === "mode" ? CONCERN_MODE_NOTE_KEY : CONCERN_MAX_NOTE_KEY;
  const credit = creditKey(c.id, concernReadsOsm(c));
  return rows + (c.noteKey ? note(c.noteKey) : "") + note(resample) + (credit ? note(credit) : "");
}

const OSM_LINE_CONCERNS = ["existing-line-230", "parallel-230", "parallel-100"];
/** The credit line a concern adds to the layer's: OpenStreetMap for an OSM concern, PoPWest for TNC. */
function creditKey(id: string, osm: boolean): string | undefined {
  if (id === "tnc") return "route.concern.creditPopwest";
  if (!osm) return undefined;
  return OSM_LINE_CONCERNS.includes(id) ? "route.concern.creditOsmLines" : "route.concern.creditOsm";
}

function renderLegend() {
  const items = document.getElementById("routeConstraintsLegendItems");
  if (items) items.innerHTML = routeConcernLegendHtml(state.routeConcern);
  const title = document.getElementById("routeConstraintsConcern");
  if (title) {
    const key = concernById(state.routeConcern)!.labelKey;
    title.dataset.i18n = key;
    title.textContent = t(key);
  }
}

/** Show concern `id`; an unknown id falls back to DEFAULT_CONCERN. */
export function setRouteConcern(id: string) {
  state.routeConcern = isConcernId(id) ? id : DEFAULT_CONCERN;
  renderLegend();
  if (state.map) {
    setRasterUrl(state.map, ROUTE_CONSTRAINTS_ID, routeConcernUrl(state.routeConcern));
    // A source still held (a failed or not-yet-made first show) loads the newly picked concern.
    if (state.layerVisibility[ROUTE_CONSTRAINTS_ID]) setMapLayerVisibility(state.map, ROUTE_CONSTRAINTS_ID, 'visible');
  }
  routeConstraintsDisclaimer();
}

const TRIBAL_CONCERNS = ["what-constrains", "land-manager", "tribal"];
let disclaimerShown = false;

/** Once a session, when the layer is on with a concern that draws tribal land: the Tribal layer's disclaimer. */
export function routeConstraintsDisclaimer() {
  if (disclaimerShown || !state.layerVisibility[ROUTE_CONSTRAINTS_ID] || !TRIBAL_CONCERNS.includes(state.routeConcern)) return;
  disclaimerShown = true;
  showTribalDisclaimer();
}

/** Test support: a new session. */
export function _resetDisclaimer() { disclaimerShown = false; }
