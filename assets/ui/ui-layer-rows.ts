// ─── Layers-panel row HTML builders ───────────────────────────────────────────
// Pure HTML-string generators for the layers panel: one row per LayerDef plus
// its action buttons (filter / year / download / source) and the gen-mode and
// filter sub-panels. buildLayersPanel() renders every group's rows into the DOM.
// Deps: state.js, registry/index.js (LAYERS, LAYER_SOURCES), colors/ramps.js
// (HEAT_RAMP), ui-legends.js (rampLegendHtml), utils.js (escapeHtml).
// Consumed by ui.ts (init + resetLayersToDefaults).

import { state } from '../state.js';
import { LAYERS, LAYER_SOURCES } from '../../src/registry/index.js';
import type { LayerDef, BucketDef } from '../../src/types.js';
import { HEAT_RAMP } from '../../src/colors/ramps.js';
import { DATA_ORIGIN } from '../constants.js';
import { rampLegendHtml } from './ui-legends.js';
import { escapeHtml } from '../utils/utils.js';

export function buildLayersPanel() {
  const groups = ["transmission", "substations", "generators", "pipelines", "rail", "renewable", "load", "land", "regions", "hazards"];
  for (const group of groups) {
    const container = document.getElementById(`layer-rows-${group}`);
    if (!container) continue;
    const entries = LAYERS.filter(l => l.group === group);
    container.innerHTML = entries.map(layerRowHtml).join("");
  }
}

function layerRowHtml(entry: LayerDef) {
  const checked = state.layerVisibility[entry.id] ? " checked" : "";
  return `
    <div class="layer-row">
      <label class="layer-label">
        <input type="checkbox" data-layer-id="${entry.id}"${checked}>
        <span class="swatch${entry.live ? " swatch--live" : ""}" style="background:${entry.swatch}${entry.live ? `;color:${entry.swatch}` : ""}" ${entry.live ? 'title="Live data — updates regularly"' : ""}></span>
        <span class="layer-name truncate" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span>
      </label>
      <div class="layer-actions">
        ${yearFilterButtonHtml(entry)}${filterButtonHtml(entry)}${downloadMenuHtml(entry)}${sourceButtonHtml(entry)}
      </div>
    </div>
    ${rampLegendHtml(entry)}
    ${genModeBlockHtml(entry)}
    ${ogfColorByBlockHtml(entry)}
    ${filterPanelHtml(entry)}
    ${yearFilterBlockHtml(entry)}`;
}

function downloadMenuHtml(entry: LayerDef) {
  const { csv, geojson, shp, tif, url } = entry.downloads ?? {};
  // No format pack → no download button. The source link lives on the Data Credits
  // page, reachable via the info button — one fewer link to maintain.
  if (!csv && !geojson && !shp && !tif) return "";
  const items = [
    csv ? `<a href="${DATA_ORIGIN}${csv}" download>CSV</a>` : "",
    geojson ? `<a href="${DATA_ORIGIN}${geojson}" download>GeoJSON</a>` : "",
    shp ? `<a href="${DATA_ORIGIN}${shp}" download>SHP</a>` : "",
    tif ? `<a href="${DATA_ORIGIN}${tif}" download>GeoTIFF</a>` : "",
    url ? `<a href="${url}" target="_blank" rel="noopener">Source data ↗</a>` : "",
  ].filter(Boolean).join("");
  return `
    <div class="dl-wrap">
      <button class="icon-btn dl-btn" title="Download" aria-label="Download ${escapeHtml(entry.label)}">⬇</button>
      <div class="dropdown dl-menu" hidden>${items}</div>
    </div>`;
}

function filterButtonHtml(entry: LayerDef) {
  if (!entry.filterBuckets) return "";
  return `
    <button class="icon-btn filter-btn" data-filter-layer="${entry.id}" title="Filter" aria-label="Filter ${escapeHtml(entry.label)}">▾</button>`;
}

function yearFilterButtonHtml(entry: LayerDef) {
  if (!entry.yearFilterLayer) return "";
  return `
    <button class="icon-btn filter-btn" id="genYearFilterBtn" title="Filter by year (with playback)" aria-label="Filter ${escapeHtml(entry.label)} by year">📅</button>`;
}

function yearFilterBlockHtml(entry: LayerDef) {
  if (!entry.yearFilterLayer) return "";
  return `
    <div class="section-filter-panel" id="genYearFilterPanel" hidden>
      <div class="year-filter-wrap">
        <div class="year-filter-controls">
          <button type="button" class="year-btn" id="yearPlayBtn" title="Play through years">▶</button>
          <span class="year-readout" id="yearReadout">All years</span>
          <button type="button" class="year-all-btn" id="yearAllBtn" title="Show all generators (clear year filter)">All years</button>
        </div>
        <input type="range" class="year-slider year-slider--off" id="yearSlider"
               min="1900" max="2031" step="1" value="2025">
        <div class="year-ticks"><span>1900</span><span>1965</span><span>2031</span></div>
        <div class="year-note">EIA only — generators alive in the selected year</div>
      </div>
    </div>`;
}

function sourceButtonHtml(entry: LayerDef) {
  const source = LAYER_SOURCES[entry.sourceId];
  if (!source) return "";
  return `
    <button class="icon-btn source-btn" type="button" data-source-id="${escapeHtml(entry.sourceId)}"
            title="${escapeHtml(source.tooltip)}"
            aria-label="Show source for ${escapeHtml(entry.label)}: ${escapeHtml(source.label)}">i</button>`;
}

function filterPanelHtml(entry: LayerDef) {
  if (!entry.filterBuckets) return "";
  return `
    <div class="layer-filter-panel" id="filter-panel-${entry.id}" hidden>
      ${entry.filterBuckets.map((b: BucketDef) => {
        const checked = state.layerFilters[entry.id]?.has(b.id) ? " checked" : "";
        return `
        <label class="filter-chip">
          <input type="checkbox" data-filter-layer="${entry.id}" data-bucket-id="${b.id}"${checked}>
          <span class="chip-swatch" style="background:${b.color}"></span>
          <span class="chip-label">${escapeHtml(b.label)}</span>
        </label>`;
      }).join("")}
    </div>`;
}

function ogfColorByBlockHtml(entry: LayerDef) {
  if (!entry.ogfStatusLayer) return "";
  const btn = (m: string, label: string) =>
    `<button type="button" class="gen-mode-btn${state.ogfColorBy === m ? " gen-mode-btn--active" : ""}"` +
    ` data-ogf-colorby="${m}">${label}</button>`;
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="Color ${escapeHtml(entry.label)} by">
        ${btn("status", "Status")}${btn("scenario", "Scenario")}${btn("planauth", "Authority")}
      </div>
    </div>`;
}

function genModeBlockHtml(entry: LayerDef) {
  if (!entry.heatLayerId && !entry.modes) return "";
  const mode = state.genMode[entry.id] || entry.defaultMode || "icons";
  const btn = (m: string, label: string) =>
    `<button type="button" class="gen-mode-btn${mode === m ? " gen-mode-btn--active" : ""}"` +
    ` data-gen-mode-layer="${entry.id}" data-gen-mode="${m}">${label}</button>`;
  const buttons = entry.modes
    ? entry.modes.map(m => btn(m.id, m.label)).join("")
    : btn("icons", "Icons") + btn("heat", "Heatmap") + btn("both", "Both");
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="Display mode for ${escapeHtml(entry.label)}">
        ${buttons}
      </div>
      <div class="gen-heat-ramp" id="${entry.id}-heat-ramp" hidden>
        ${rampLegendHtml({ id: entry.id + "-heat", ramp: HEAT_RAMP })}
      </div>
    </div>`;
}
