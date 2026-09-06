// ─── Layers-panel row HTML builders ───────────────────────────────────────────
// Pure HTML-string generators for the layers panel: one row per LayerDef plus
// its action buttons (filter / year / download / source) and the gen-mode and
// filter sub-panels. buildLayersPanel() renders every group's rows into the DOM.
// Deps: state.js, registry/index.js (LAYERS, LAYER_SOURCES), colors/ramps.js
// (HEAT_RAMP), ui-legends.js (rampLegendHtml), utils.js (escapeHtml),
// src/i18n/index.js (t).
// Consumed by ui.ts (init + resetLayersToDefaults + wireLangChanged).

import { state } from '../state.js';
import { LAYERS, LAYER_SOURCES, REGION_CODE_MAP } from '../../src/registry/index.js';
import { WEATHER_VARIABLES } from '../../src/registry/conditions.js';
import type { LayerDef, BucketDef, LayerScope, DownloadRegion } from '../../src/types.js';
import { HEAT_RAMP } from '../../src/colors/ramps.js';
import { DATA_ORIGIN } from '../constants.js';
import { rampLegendHtml } from './ui-legends.js';
import { escapeHtml } from '../utils/utils.js';
import { t } from '../../src/i18n/index.js';

// 'usa' lists everything — a US visitor wants the worldwide layers too, so the
// US scope is the superset. 'global' is the narrowing one: it drops layers whose
// data stops at the US border (HIFLD, PAD-US, NERC, tribal, ZCTA, EIA), which
// would otherwise render as an empty checkbox everywhere else on Earth.
export function isLayerInRegion(layer: LayerDef, scope: LayerScope = state.regionScope): boolean {
  if (scope === 'usa') return true;
  if (!layer.regions || layer.regions.length === 0) return true;
  return layer.regions.includes('global');
}

// Every OSM-derived pack is built per continent: Geofabrik's continental
// extracts are the pipeline's unit of work, and a download is a file someone
// opens in QGIS, so each format (CSV, GeoJSON, SHP) ships one archive per
// continental code. Non-OSM packs are single-file and stay flat links.
export function isContinentalPack(pathStr?: string | null): boolean {
  return !!pathStr && pathStr.includes('data/releases/osm-');
}

// The continent code sits ahead of the format suffix:
//   osm-transmission-lines.zip      → osm-transmission-lines-eu.zip
//   osm-transmission-lines-shp.zip  → osm-transmission-lines-eu-shp.zip
// An already-coded path is rewritten in place, so repeat calls are idempotent.
const PACK_SUFFIX_RE = /(?:-(?:na|eu|as|sa|af|oc|ca|an))?(-shp)?\.zip$/;

export function getRegionalDownloadPath(pathStr: string, region: DownloadRegion): string {
  if (!isContinentalPack(pathStr)) return pathStr;
  const code = REGION_CODE_MAP[region] || 'na';
  return pathStr.replace(PACK_SUFFIX_RE, (_match, shp = '') => `-${code}${shp}.zip`);
}

export function buildLayersPanel() {
  const groups = ["transmission", "substations", "generators", "pipelines", "rail", "renewable", "load", "land", "regions", "conditions"];
  for (const group of groups) {
    const container = document.getElementById(`layer-rows-${group}`);
    if (!container) continue;
    const entries = LAYERS.filter(l => l.group === group && isLayerInRegion(l, state.regionScope));
    container.innerHTML = entries.map(layerRowHtml).join("");
  }

  // Hide or show collapsible layer-sections if all child row containers are empty
  const sections = document.querySelectorAll<HTMLElement>('.layers-body .layer-section[data-collapsible]');
  sections.forEach(section => {
    const rowContainers = section.querySelectorAll('[id^="layer-rows-"]');
    if (rowContainers.length > 0) {
      const hasAnyRows = Array.from(rowContainers).some(c => c.children.length > 0);
      section.style.display = hasAnyRows ? '' : 'none';
    }
  });

  const regionMenu = document.getElementById('regionMenu');
  if (regionMenu) {
    const activeItem = regionMenu.querySelector<HTMLButtonElement>(`.region-menu-item[data-region="${state.regionScope}"]`);
    regionMenu.querySelectorAll<HTMLButtonElement>('.region-menu-item').forEach(item => {
      const active = item.dataset.region === state.regionScope;
      item.classList.toggle('region-menu-item--active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    const iconEl = document.getElementById('regionActiveIcon');
    const textEl = document.getElementById('regionActiveText');
    if (activeItem) {
      const svg = activeItem.querySelector('svg');
      if (iconEl && svg) iconEl.innerHTML = svg.outerHTML;
      const label = activeItem.querySelector('.region-menu-label');
      if (textEl && label) textEl.textContent = label.textContent;
    }
  }
}

function layerRowHtml(entry: LayerDef) {
  const checked = state.layerVisibility[entry.id] ? " checked" : "";
  const label = t(entry.titleKey);
  const liveTooltip = t('layer.liveTooltip');
  return `
    <div class="layer-row">
      <label class="layer-label">
        <input type="checkbox" data-layer-id="${entry.id}"${checked}>
        <span class="swatch${entry.live ? " swatch--live" : ""}" style="background:${entry.swatch}${entry.live ? `;color:${entry.swatch}` : ""}" ${entry.live ? `title="${escapeHtml(liveTooltip)}"` : ""}></span>
        <span class="layer-name truncate" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      </label>
      <div class="layer-actions">
        ${yearFilterButtonHtml(entry)}${filterButtonHtml(entry)}${downloadMenuHtml(entry)}${sourceButtonHtml(entry)}
      </div>
    </div>
    ${genModeBlockHtml(entry)}
    ${ogfColorByBlockHtml(entry)}
    ${westtecColorByBlockHtml(entry)}
    ${weatherVarBlockHtml(entry)}
    ${filterPanelHtml(entry)}
    ${yearFilterBlockHtml(entry)}`;
}

// Continents offered for a continental pack, in the order the packs are built.
// Labels come from the same region.* keys the old selector used.
const DOWNLOAD_REGIONS: { id: DownloadRegion; key: string }[] = [
  { id: 'north-america',  key: 'region.northAmerica' },
  { id: 'europe',         key: 'region.europe' },
  { id: 'asia',           key: 'region.asia' },
  { id: 'south-america',  key: 'region.southAmerica' },
  { id: 'africa',         key: 'region.africa' },
  { id: 'oceania',        key: 'region.oceania' },
  { id: 'central-america',key: 'region.centralAmerica' },
  { id: 'antarctica',     key: 'region.antarctica' },
];

// One format entry. A continental pack expands to the continent list via a native
// <details> — no JS, and ui.ts's outside-click handler already ignores clicks
// inside .dl-menu, so opening one does not dismiss the menu.
function downloadFormatHtml(label: string, path?: string | null) {
  if (!path) return "";
  if (!isContinentalPack(path)) {
    return `<a href="${DATA_ORIGIN}${path}" download>${label}</a>`;
  }
  const links = DOWNLOAD_REGIONS.map(r =>
    `<a href="${DATA_ORIGIN}${getRegionalDownloadPath(path, r.id)}" download>${escapeHtml(t(r.key))}</a>`
  ).join("");
  return `<details class="dl-group"><summary>${label}</summary><div class="dl-regions">${links}</div></details>`;
}

function downloadMenuHtml(entry: LayerDef) {
  const { csv, geojson, shp, tif } = entry.downloads ?? {};
  // No format pack → no download button. The source link lives on the Data Credits
  // page, reachable via the info button — one fewer link to maintain.
  if (!csv && !geojson && !shp && !tif) return "";
  const label = t(entry.titleKey);
  const dlText = t('layer.download');
  const items = [
    downloadFormatHtml("CSV", csv),
    downloadFormatHtml("GeoJSON", geojson),
    downloadFormatHtml("SHP", shp),
    downloadFormatHtml("GeoTIFF", tif),
  ].filter(Boolean).join("");
  return `
    <div class="dl-wrap">
      <button class="icon-btn dl-btn" title="${escapeHtml(dlText)}" aria-label="${escapeHtml(dlText)} ${escapeHtml(label)}">⬇</button>
      <div class="dropdown dl-menu" hidden>${items}</div>
    </div>`;
}

function filterButtonHtml(entry: LayerDef) {
  if (!entry.filterBuckets) return "";
  const label = t(entry.titleKey);
  const filterText = t('layer.filter');
  return `
    <button class="icon-btn filter-btn" data-filter-layer="${entry.id}" title="${escapeHtml(filterText)}" aria-label="${escapeHtml(filterText)} ${escapeHtml(label)}">▾</button>`;
}

function yearFilterButtonHtml(entry: LayerDef) {
  if (!entry.yearFilterLayer) return "";
  const label = t(entry.titleKey);
  const filterTitle = t('year.filterTitle');
  const filterAria = t('year.filterAria', { label });
  return `
    <button class="icon-btn filter-btn" id="genYearFilterBtn" title="${escapeHtml(filterTitle)}" aria-label="${escapeHtml(filterAria)}">📅</button>`;
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

function sourceButtonHtml(entry: LayerDef) {
  const source = LAYER_SOURCES[entry.sourceId];
  if (!source) return "";
  const label = t(entry.titleKey);
  const aria = t('layer.sourceAria', { label, source: source.label });
  return `
    <button class="icon-btn source-btn" type="button" data-source-id="${escapeHtml(entry.sourceId)}"
            title="${escapeHtml(source.tooltip)}"
            aria-label="${escapeHtml(aria)}">i</button>`;
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
  const label = t(entry.titleKey);
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn${state.ogfColorBy === m ? " gen-mode-btn--active" : ""}"` +
    ` data-ogf-colorby="${m}">${escapeHtml(text)}</button>`;
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="Color ${escapeHtml(label)} by">
        ${btn("status", t('colorby.status'))}${btn("scenario", t('colorby.scenario'))}${btn("planauth", t('colorby.planauth'))}
      </div>
    </div>`;
}

function westtecColorByBlockHtml(entry: LayerDef) {
  if (!entry.westtecColorLayer) return "";
  const label = t(entry.titleKey);
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn${state.westtecColorBy === m ? " gen-mode-btn--active" : ""}"` +
    ` data-westtec-colorby="${m}">${escapeHtml(text)}</button>`;
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="Color ${escapeHtml(label)} by">
        ${btn("scenario", t('colorby.scenario'))}${btn("dataset", t('colorby.dataset'))}
      </div>
    </div>`;
}

function weatherVarBlockHtml(entry: LayerDef) {
  if (!entry.weatherVarLayer) return "";
  const label = t(entry.titleKey);
  const options = WEATHER_VARIABLES.map(v => {
    const vLabel = v.labelKey ? t(v.labelKey) : v.label;
    return `<option value="${v.id}"${state.weatherVar === v.id ? " selected" : ""}>${escapeHtml(vLabel)}</option>`;
  }).join("");
  return `
    <div class="gen-mode">
      <select class="weather-var-select" data-weather-var-select
              aria-label="Weather variable for ${escapeHtml(label)}">${options}</select>
    </div>`;
}

function genModeBlockHtml(entry: LayerDef) {
  if (!entry.heatLayerId && !entry.modes) return "";
  const label = t(entry.titleKey);
  const mode = state.genMode[entry.id] || entry.defaultMode || "icons";
  const modeLabels: Record<string, string> = {
    icons: t('mode.icons'),
    heat: t('mode.heatmap'),
    both: t('mode.both'),
    points: t('mode.points'),
    clusters: t('mode.clusters'),
  };
  const btn = (m: string, text: string) =>
    `<button type="button" class="gen-mode-btn${mode === m ? " gen-mode-btn--active" : ""}"` +
    ` data-gen-mode-layer="${entry.id}" data-gen-mode="${m}">${escapeHtml(text)}</button>`;
  const buttons = entry.modes
    ? entry.modes.map(m => btn(m.id, modeLabels[m.id] ?? m.label)).join("")
    : btn("icons", t('mode.icons')) + btn("heat", t('mode.heatmap')) + btn("both", t('mode.both'));
  return `
    <div class="gen-mode">
      <div class="gen-mode-toggle" role="group" aria-label="Display mode for ${escapeHtml(label)}">
        ${buttons}
      </div>
      <div class="gen-heat-ramp" id="${entry.id}-heat-ramp" hidden>
        ${rampLegendHtml({ id: entry.id + "-heat", ramp: HEAT_RAMP })}
      </div>
    </div>`;
}
