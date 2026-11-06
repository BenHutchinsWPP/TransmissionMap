// ─── Layers-panel row HTML builders ───────────────────────────────────────────
// Pure HTML-string generators for the layers panel: one row per LayerDef — the
// checkbox, the full name, the Area flag and one ⋯ button whose menu holds the
// layer's actions (filter / year / table / visualize / about / downloads;
// wired by layer-menu.ts) — and the gen-mode and filter sub-panels.
// hasPanelRow() is the one rule for which layers get a row (in
// the region scope, or switched on so it can be switched off); panelRows() renders
// each group's rows from an explicit { scope, visible }. Reads no state and touches
// no DOM; the HTML follows the active locale through t(). Structure only: no
// template writes a control's value (checked, active, selected, the year, the
// Area-filter note — each row's hidden `.layer-area-flag`; the `where` chip's
// text) — panel-mirror.ts
// writes the rows into the DOM and every value right after.
// Deps: registry/index.js (LAYER_SOURCES), templates/catalogue.js (templatesFor: a row's
// Visualize item), registry/conditions.js (WEATHER_VARIABLES,
// NRI_HAZARDS), grid-ops/ba-graph.js (GROUP_BYS, GRID_GLYPHS), colors/route-constraints.js (CONCERNS, CONCERN_GROUPS), colors/ramps.js (HEAT_RAMP), download-packs.js (packLinks),
// ui-legends.js (rampLegendHtml), utils.js (escapeHtml), src/i18n/index.js (t).
// Consumed by panel-mirror.ts (panelRows, hasPanelRow), which then writes every
// control value from state (syncPanel); PANEL_GROUPS also by panel-mirror.test.ts;
// TABLE_ICON and VIZ_ICON also by ui-table.ts (the drawer's tabs).

import { LAYER_SOURCES } from '../../src/registry/index.js';
import { templatesFor } from '../templates/catalogue.js';
import { WEATHER_VARIABLES, NRI_HAZARDS } from '../../src/registry/conditions.js';
import type { LayerDef, BucketDef, LayerScope } from '../../src/types.js';
import { HEAT_RAMP } from '../../src/colors/ramps.js';
import { CONCERNS, CONCERN_GROUPS, concernGroupKey } from '../../src/colors/route-constraints.js';
import { packLinks } from '../download-packs.js';
import { GROUP_BYS, GRID_GLYPHS } from '../grid-ops/ba-graph.js';
import { rampLegendHtml } from './ui-legends.js';
import { escapeHtml } from '../utils/utils.js';
import { t } from '../../src/i18n/index.js';

// 'usa' lists everything — a US visitor wants the worldwide layers too, so the
// US scope is the superset. 'global' is the narrowing one: it drops layers whose
// data stops at the US border (HIFLD, PAD-US, NERC, tribal, ZCTA, EIA), which
// would otherwise render as an empty checkbox everywhere else on Earth.
export function isLayerInRegion(layer: LayerDef, scope: LayerScope): boolean {
  if (scope === 'usa') return true;
  if (!layer.regions || layer.regions.length === 0) return true;
  return layer.regions.includes('global');
}

/** What decides the row set: the region scope and which layers are switched on. */
export type PanelView = { scope: LayerScope; visible: Record<string, boolean> };

// A layer outside the scope keeps its row while it is on, so a link, a story or a
// region change never leaves a drawn layer the panel cannot switch off.
export function hasPanelRow(layer: LayerDef, { scope, visible }: PanelView): boolean {
  return !layer.hidden && (isLayerInRegion(layer, scope) || !!visible[layer.id]);
}

// Panel sections in display order; each renders into #layer-rows-<group> (index.html).
export const PANEL_GROUPS = ["transmission", "substations", "generators", "pipelines", "rail", "renewable", "load", "land", "regions", "conditions"];

/** Every group in PANEL_GROUPS order — an empty one as { ids: [], html: "" } — with
 *  the ids of its rows in registry order and their HTML. */
export function panelRows(layers: readonly LayerDef[], view: PanelView): Record<string, { ids: string[]; html: string }> {
  return Object.fromEntries(PANEL_GROUPS.map(group => {
    const entries = layers.filter(l => l.group === group && hasPanelRow(l, view));
    return [group, { ids: entries.map(l => l.id), html: entries.map(layerRowHtml).join("") }];
  }));
}

function layerRowHtml(entry: LayerDef) {
  const label = t(entry.titleKey);
  const liveTooltip = t('layer.liveTooltip');
  // The row keeps the checkbox, the full name, the Area flag and one ⋯ menu button;
  // the `where` chip of a layer that takes conditions (text and × written by
  // panel-mirror.ts) sits on its own line under the row.
  return `
    <div class="layer-row">
      <label class="layer-label">
        <input type="checkbox" data-layer-id="${entry.id}">
        <span class="swatch${entry.live ? " swatch--live" : ""}" style="background:${entry.swatch}${entry.live ? `;color:${entry.swatch}` : ""}" ${entry.live ? `title="${escapeHtml(liveTooltip)}"` : ""}></span>
        <span class="layer-name">${escapeHtml(label)}</span>
      </label>
      <button type="button" class="layer-area-flag" data-area-flag="${entry.id}" hidden></button>
      ${layerMenuHtml(entry)}
    </div>
    ${entry.dataset ? `<div class="layer-where" data-where-chip="${entry.id}" hidden><span class="layer-where-text"></span><button type="button" class="layer-where-clear" data-where-clear="${entry.id}">×</button></div>` : ""}
    ${genModeBlockHtml(entry)}
    ${ogfColorByBlockHtml(entry)}
    ${westtecColorByBlockHtml(entry)}
    ${weatherVarBlockHtml(entry)}
    ${nriHazardBlockHtml(entry)}
    ${gridOpsBlockHtml(entry)}
    ${routeConcernBlockHtml(entry)}
    ${filterPanelHtml(entry)}
    ${yearFilterBlockHtml(entry)}`;
}

// One ⋯ button per row opens the layer's actions as a role=menu (layer-menu.ts
// wires it): the sub-panel toggles (Filter, Filter by year — menuitemcheckbox,
// checked while the panel shows), Show in table, Visualize, About this data,
// then the download formats. A row with no action has no button.
function layerMenuHtml(entry: LayerDef) {
  const items = filterItemHtml(entry) + yearFilterItemHtml(entry) + tableItemHtml(entry)
    + vizItemHtml(entry) + sourceItemHtml(entry) + downloadItemsHtml(entry);
  if (!items) return "";
  const label = t(entry.titleKey);
  return `
    <div class="layer-menu-wrap">
      <button type="button" class="icon-btn layer-menu-btn" id="layer-menu-btn-${entry.id}"
              aria-haspopup="menu" aria-expanded="false" aria-controls="layer-menu-${entry.id}"
              title="${escapeHtml(t('layer.menu'))}" aria-label="${escapeHtml(t('layer.menuAria', { label }))}">⋯</button>
      <div class="dropdown layer-menu" id="layer-menu-${entry.id}" role="menu"
           aria-labelledby="layer-menu-btn-${entry.id}" hidden>${items}</div>
    </div>`;
}

// Each item starts with a fixed-width icon slot (.lm-icon) so the labels align.
const icon = (svg: string) => `<span class="lm-icon" aria-hidden="true">${svg}</span>`;
const FILTER_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 5.5h10l-4 4.5v3.5l-2-1V10z"/></svg>';
const YEAR_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/></svg>';
const INFO_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.9v.1"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10"/></svg>';
const item = (attrs: string, text: string, svg: string, role = "menuitem") =>
  `<button type="button" class="layer-menu-item" role="${role}"${role === "menuitemcheckbox" ? ' aria-checked="false"' : ""} tabindex="-1" ${attrs}>${icon(svg)}${escapeHtml(text)}</button>`;

// A continental pack expands to the continent list via a native <details> inside
// the menu; layer-menu.ts walks only the items that show.
function downloadItemsHtml(entry: LayerDef) {
  const formats = packLinks(entry.downloads);
  if (!formats.length) return "";
  const link = (url: string, text: string) =>
    `<a class="layer-menu-item" role="menuitem" tabindex="-1" href="${url}" download>${icon(DOWNLOAD_ICON)}${escapeHtml(text)}</a>`;
  const items = formats.map(({ label: fmt, links }) =>
    links.length === 1 && !links[0].labelKey
      ? link(links[0].url, fmt)
      : `<details class="dl-group"><summary class="layer-menu-item" role="menuitem" tabindex="-1">${icon(DOWNLOAD_ICON)}${escapeHtml(fmt)}</summary><div class="dl-regions">${
          links.map(l => link(l.url, t(l.labelKey ?? ''))).join("")
        }</div></details>`
  ).join("");
  return `<div class="layer-menu-sep" role="separator"></div><div class="layer-menu-label" aria-hidden="true">${escapeHtml(t('layer.download'))}</div>${items}`;
}

// The table drawer (ui-table.ts) reads the layers a query reaches: the ones
// with a field schema (`dataset`) and a stable id. ui.ts opens it on click.
function tableItemHtml(entry: LayerDef) {
  if (!entry.dataset || !entry.data?.id) return "";
  return item(`data-table-layer="${entry.id}"`, t('table.open'), TABLE_ICON);
}
export const TABLE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M2 9.5h12M6.5 6v7.5"/></svg>';

// The Visualize pane (ui-templates.ts) for a layer at least one ready template
// fits; ui.ts opens it, with this layer picked, through templates-open.ts.
function vizItemHtml(entry: LayerDef) {
  if (!templatesFor(entry.id).length) return "";
  return item(`data-viz-layer="${entry.id}"`, t('viz.open'), VIZ_ICON);
}
export const VIZ_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 14h12"/><rect x="3" y="8" width="2.4" height="5"/><rect x="6.8" y="4" width="2.4" height="9"/><rect x="10.6" y="6.5" width="2.4" height="6.5"/></svg>';

// Toggles #filter-panel-<id> (ui-filters.ts).
function filterItemHtml(entry: LayerDef) {
  if (!entry.filterBuckets) return "";
  return item(`data-filter-toggle="${entry.id}"`, t('layer.filter'), FILTER_ICON, "menuitemcheckbox");
}

// Toggles #genYearFilterPanel (ui-filters.ts).
function yearFilterItemHtml(entry: LayerDef) {
  if (!entry.yearFilterLayer) return "";
  return item(`id="genYearFilterBtn" title="${escapeHtml(t('year.filterAria', { label: t(entry.titleKey) }))}"`,
    t('year.filterTitle'), YEAR_ICON, "menuitemcheckbox");
}

function yearFilterBlockHtml(entry: LayerDef) {
  if (!entry.yearFilterLayer) return "";
  const playTitle = t('year.playTitle');
  const allYears = t('year.allYears');
  const allYearsTitle = t('year.allYearsTitle');
  const note = t('year.note');
  return `
    <div class="section-filter-panel" id="genYearFilterPanel" hidden>
      <div class="year-filter-wrap">
        <div class="year-filter-controls">
          <button type="button" class="year-btn" id="yearPlayBtn" title="${escapeHtml(playTitle)}">▶</button>
          <span class="year-readout" id="yearReadout">${escapeHtml(allYears)}</span>
          <button type="button" class="year-all-btn" id="yearAllBtn" title="${escapeHtml(allYearsTitle)}">${escapeHtml(allYears)}</button>
        </div>
        <input type="range" class="year-slider year-slider--off" id="yearSlider"
               min="1900" max="2031" step="1" value="2025">
        <div class="year-ticks"><span>1900</span><span>1965</span><span>2031</span></div>
        <div class="year-note">${escapeHtml(note)}</div>
      </div>
    </div>`;
}

// Opens the layer's Data Credits entry (ui.ts).
function sourceItemHtml(entry: LayerDef) {
  const source = LAYER_SOURCES[entry.sourceId];
  if (!source) return "";
  return item(`data-source-id="${escapeHtml(entry.sourceId)}" title="${escapeHtml(source.tooltip)}"`, t('layer.about'), INFO_ICON);
}

function filterPanelHtml(entry: LayerDef) {
  if (!entry.filterBuckets) return "";
  return `
    <div class="layer-filter-panel" id="filter-panel-${entry.id}" hidden>
      ${entry.filterBuckets.map((b: BucketDef) => `
        <label class="filter-chip">
          <input type="checkbox" data-filter-layer="${entry.id}" data-bucket-id="${b.id}">
          <span class="chip-swatch" style="background:${b.color}"></span>
          <span class="chip-label">${escapeHtml(b.label)}</span>
        </label>`).join("")}
    </div>`;
}

function ogfColorByBlockHtml(entry: LayerDef) {
  if (!entry.ogfStatusLayer) return "";
  const label = t(entry.titleKey);
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn" data-ogf-colorby="${m}">${escapeHtml(text)}</button>`;
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="${escapeHtml(t('colorby.groupAria', { label }))}">
        ${btn("region", t('colorby.region'))}${btn("status", t('colorby.status'))}
      </div>
    </div>`;
}

function westtecColorByBlockHtml(entry: LayerDef) {
  if (!entry.westtecColorLayer) return "";
  const label = t(entry.titleKey);
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn" data-westtec-colorby="${m}">${escapeHtml(text)}</button>`;
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="${escapeHtml(t('colorby.groupAria', { label }))}">
        ${btn("scenario", t('colorby.scenario'))}${btn("dataset", t('colorby.dataset'))}
      </div>
    </div>`;
}

function weatherVarBlockHtml(entry: LayerDef) {
  if (!entry.weatherVarLayer) return "";
  const label = t(entry.titleKey);
  const options = WEATHER_VARIABLES.map(v => {
    const vLabel = v.labelKey ? t(v.labelKey) : v.label;
    return `<option value="${v.id}">${escapeHtml(vLabel)}</option>`;
  }).join("");
  return `
    <div class="gen-mode">
      <select class="weather-var-select" data-weather-var-select
              aria-label="${escapeHtml(t('weather.varAria', { label }))}">${options}</select>
    </div>`;
}

function nriHazardBlockHtml(entry: LayerDef) {
  if (!entry.nriHazardLayer) return "";
  const label = t(entry.titleKey);
  const options = NRI_HAZARDS.map(h =>
    `<option value="${h.id}">${escapeHtml(h.label)}</option>`,
  ).join("");
  return `
    <div class="gen-mode">
      <select class="weather-var-select" data-nri-hazard-select
              aria-label="${escapeHtml(t('layer.hazardAria', { label }))}">${options}</select>
    </div>`;
}

// Grid Operations: grouping and glyph selects and the numbers checkbox (the bubble key is #gridOpsLegend).
function gridOpsBlockHtml(entry: LayerDef) {
  if (!entry.gridOpsLayer) return "";
  const label = t(entry.titleKey);
  const opts = (ids: readonly string[], key: string) =>
    ids.map(id => `<option value="${id}">${escapeHtml(t(`gridOps.${key}.${id}`))}</option>`).join("");
  return `
    <div class="gen-mode">
      <select class="weather-var-select" data-grid-group-select
              aria-label="${escapeHtml(t('gridOps.groupAria', { label }))}">${opts(GROUP_BYS, "group")}</select>
      <select class="weather-var-select" data-grid-glyph-select
              aria-label="${escapeHtml(t('gridOps.glyphAria', { label }))}">${opts(GRID_GLYPHS, "glyph")}</select>
      <label class="grid-numbers"><input type="checkbox" data-grid-numbers-toggle> ${escapeHtml(t('gridOps.numbers'))}</label>
    </div>`;
}

function routeConcernBlockHtml(entry: LayerDef) {
  if (!entry.routeConcernLayer) return "";
  const label = t(entry.titleKey);
  const groups = CONCERN_GROUPS.map(g => {
    const options = CONCERNS.filter(c => c.group === g)
      .map(c => `<option value="${c.id}">${escapeHtml(t(c.labelKey))}</option>`).join("");
    return `<optgroup label="${escapeHtml(t(concernGroupKey(g)))}">${options}</optgroup>`;
  }).join("");
  return `
    <div class="gen-mode">
      <select class="weather-var-select" data-route-concern-select
              aria-label="${escapeHtml(t('layer.routeConcernAria', { label }))}">${groups}</select>
    </div>`;
}

function genModeBlockHtml(entry: LayerDef) {
  if (!entry.heatLayerId && !entry.modes) return "";
  const label = t(entry.titleKey);
  const modeLabels: Record<string, string> = {
    icons: t('mode.icons'),
    heat: t('mode.heatmap'),
    both: t('mode.both'),
    points: t('mode.points'),
    clusters: t('mode.clusters'),
  };
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn" data-gen-mode-layer="${entry.id}" data-gen-mode="${m}">${escapeHtml(text)}</button>`;
  const buttons = entry.modes
    ? entry.modes.map(m => btn(m.id, modeLabels[m.id] ?? m.label)).join("")
    : btn("icons", t('mode.icons')) + btn("heat", t('mode.heatmap')) + btn("both", t('mode.both'));
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="${escapeHtml(t('mode.groupAria', { label }))}">
        ${buttons}
      </div>
      <div class="gen-heat-ramp" id="${entry.id}-heat-ramp" hidden>
        ${rampLegendHtml({ id: entry.id + "-heat", ramp: HEAT_RAMP })}
      </div>
    </div>`;
}
