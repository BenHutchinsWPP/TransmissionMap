// ─── Legends + legend-filter registry ────────────────────────────────────────
// Live-feed age/degraded-feed status text (downFor, feedIssue, fmtAgeShort)
// comes from ../live-staleness.js, which owns those helpers so they can be
// shared with other live-feed displays.
// rampLegendHtml() renders a ramp's end labels from the RampDef's own `fmt`
// when it has one (a formatter from src/units.ts), so a ramp in a convertible
// unit re-renders in the user's preference on each buildLegends() — which
// ui.ts triggers from the 'units:changed' bus event, and from its one
// 'lang:changed' handler (wireLangChanged), after the DOM translations, so a
// language change rebuilds the legends once. Covered by
// ui-legends.test.ts.
// updateLegends() also dims the OGF/WestTEC legend that is not the active
// colour key (state.ogfColorBy / state.westtecColorBy), via LEGEND_VISIBILITY's
// `colorKey`.

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import type { RampDef } from '../../src/types.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import {
  KV_BUCKETS, VOLTAGE_LEGEND, PIPELINE_TYPE_BUCKETS, CRITHAB_BUCKETS, PADUS_CLASS_BUCKETS,
  TRIBAL_BUCKETS, NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS,
  NERC_BUCKETS, RETAIL_TYPE_BUCKETS, OGF_STATUS_BUCKETS, SUBSTANCE_BUCKETS, DCM_CLASSES,
  OGF_REGION_BUCKETS, OGF_WORK_BUCKETS, SECTOR_BUCKETS, LINE_PLACEMENT_BUCKETS,
  NWS_GROUP_BUCKETS, WESTTEC_SCENARIO_BUCKETS, WESTTEC_DATASET_BUCKETS,
} from '../../src/colors/buckets.js';
import {
  applyVoltageFilter, applyGeneratorFilters, applyPipelineTypeFilter,
  applyCritHabFilter, applyPadusClassFilter, applyTribalClassFilter,
  applyNatgasLineFilter, applyNatgasPtsFilter, applyNercFilter,
  applyRetailTypeFilter, applyOGFFilters, applySubstanceFilter, applyMinesFilter, applyDcMoratoriumFilter,
  applyNwsGroupFilter, applyWestTECFilters,
} from '../filters.js';
import { MINES_COMMODITY_BUCKETS, MINES_STATUS_BUCKETS } from '../../src/colors/minerals.js';
import { escapeHtml } from '../utils/utils.js';
import { fmtAgeShort, downFor, feedIssue } from '../live-staleness.js';
import { ICON_SVG } from '../icons.js';
import { WEATHER_VARIABLES } from '../../src/registry/conditions.js';
import { t } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';

// >>> ADD-LAYER: legend-filters — see docs/adding-a-layer.md §opt
export const LEGEND_FILTERS = [
  { key: "kv", groupCode: "v", buckets: VOLTAGE_LEGEND, syncBuckets: KV_BUCKETS,
    masterId: "kvAllCb", legendId: "voltageLegend", itemsId: "voltageLegendItems",
    title: "Voltage (kV)", titleKey: "legend.voltage", swatch: "color", apply: applyVoltageFilter },
  { key: "underground", groupCode: "o", buckets: LINE_PLACEMENT_BUCKETS,
    masterId: "linePlacementAllCb", legendId: "linePlacementLegend", itemsId: "linePlacementLegendItems",
    title: "Line placement", titleKey: "legend.linePlacement", swatch: "line", apply: applyVoltageFilter },
  { key: "fuel", groupCode: "f", buckets: FUEL_LEGEND,
    masterId: "fuelAllCb", legendId: "fuelLegend", itemsId: "fuelLegendItems",
    title: "Fuel Type", titleKey: "legend.fuel", swatch: "icon", apply: applyGeneratorFilters },
  { key: "sector", groupCode: "i", buckets: SECTOR_BUCKETS,
    masterId: "sectorAllCb", legendId: "sectorLegend", itemsId: "sectorLegendItems",
    title: "EIA Plants — sector", titleKey: "legend.sector", swatch: "none", apply: applyGeneratorFilters },
  { key: "pipeline", groupCode: "p", buckets: PIPELINE_TYPE_BUCKETS,
    masterId: "pipelineAllCb", legendId: "pipelineLegend", itemsId: "pipelineLegendItems",
    title: "Pipeline Points", titleKey: "legend.pipelinePoints", swatch: "icon", apply: applyPipelineTypeFilter },
  { key: "crithab", groupCode: "h", buckets: CRITHAB_BUCKETS,
    masterId: "crithabAllCb", legendId: "crithabLegend", itemsId: "crithabLegendItems",
    title: "Critical Habitat — ESA status", titleKey: "legend.crithab", swatch: "color", apply: applyCritHabFilter },
  { key: "padus", groupCode: "j", buckets: PADUS_CLASS_BUCKETS,
    masterId: "padusAllCb", legendId: "padusLegend", itemsId: "padusLegendItems",
    title: "PAD-US — land type", titleKey: "legend.padus", swatch: "color", apply: applyPadusClassFilter },
  { key: "tribal", groupCode: "t", buckets: TRIBAL_BUCKETS,
    masterId: "tribalAllCb", legendId: "tribalLegend", itemsId: "tribalLegendItems",
    title: "Tribal (Census)", titleKey: "layer.tribalCensus", swatch: "color", apply: applyTribalClassFilter },
  { key: "natgasLine", groupCode: "n", buckets: NATGAS_PIPE_TYPE_BUCKETS,
    masterId: "natgasLineAllCb", legendId: "natgasLineLegend", itemsId: "natgasLineLegendItems",
    title: "Pipeline type", titleKey: "legend.pipelineType", swatch: "color", apply: applyNatgasLineFilter },
  { key: "natgasPts", groupCode: "r", buckets: NATGAS_FAC_TYPE_BUCKETS,
    masterId: "natgasPtsAllCb", legendId: "natgasPtsLegend", itemsId: "natgasPtsLegendItems",
    title: "Facility type", titleKey: "legend.facilityType", swatch: "icon", apply: applyNatgasPtsFilter },
  { key: "substance", groupCode: "u", buckets: SUBSTANCE_BUCKETS,
    masterId: "substanceAllCb", legendId: "substanceLegend", itemsId: "substanceLegendItems",
    title: "Pipeline fuel", titleKey: "legend.pipelineFuel", swatch: "color",
    defaultActive: ["gas", "oil", "products", "hydrogen", "coal"], apply: applySubstanceFilter },
  { key: "nerc", groupCode: "c", buckets: NERC_BUCKETS,
    masterId: "nercAllCb", legendId: "nercLegend", itemsId: "nercLegendItems",
    title: "NERC Region", titleKey: "popup.nercRegion", swatch: "color", apply: applyNercFilter },
  { key: "retail", groupCode: "e", buckets: RETAIL_TYPE_BUCKETS,
    masterId: "retailAllCb", legendId: "retailLegend", itemsId: "retailLegendItems",
    title: "Utility type", titleKey: "legend.utilityType", swatch: "color", apply: applyRetailTypeFilter },
  { key: "dcm", groupCode: "a", buckets: DCM_CLASSES,
    masterId: "dcmAllCb", legendId: "dcMoratoriumLegend", itemsId: "dcMoratoriumLegendItems",
    title: "Data Center Moratoriums", titleKey: "layer.dcMoratoriums", swatch: "color", apply: applyDcMoratoriumFilter },
  { key: "ogfRegion", groupCode: "b", buckets: OGF_REGION_BUCKETS,
    masterId: "ogfRegionAllCb", legendId: "ogfRegionLegend", itemsId: "ogfRegionLegendItems",
    title: "Region", titleKey: "popup.region", swatch: "color", apply: applyOGFFilters },
  { key: "ogfStatus", groupCode: "g", buckets: OGF_STATUS_BUCKETS,
    masterId: "ogfStatusAllCb", legendId: "ogfStatusLegend", itemsId: "ogfStatusLegendItems",
    title: "Project status", titleKey: "legend.status", swatch: "color", apply: applyOGFFilters },
  { key: "ogfWork", groupCode: "m", buckets: OGF_WORK_BUCKETS,
    masterId: "ogfWorkAllCb", legendId: "ogfWorkLegend", itemsId: "ogfWorkLegendItems",
    title: "Type of work", titleKey: "legend.typeOfWork", swatch: "line", apply: applyOGFFilters },
  { key: "mines", groupCode: "k", buckets: MINES_COMMODITY_BUCKETS,
    masterId: "minesAllCb", legendId: "minesLegend", itemsId: "minesLegendItems",
    title: "Mines — commodity", titleKey: "legend.minesCommodity", swatch: "icon", apply: applyMinesFilter },
  { key: "minesStatus", groupCode: "d", buckets: MINES_STATUS_BUCKETS,
    masterId: "minesStatusAllCb", legendId: "minesStatusLegend", itemsId: "minesStatusLegendItems",
    title: "Mines — status", titleKey: "legend.minesStatus", swatch: "none", defaultActive: ["active"], apply: applyMinesFilter },
  { key: "nwsGroup", groupCode: "q", buckets: NWS_GROUP_BUCKETS,
    masterId: "nwsGroupAllCb", legendId: "nwsGroupLegend", itemsId: "nwsGroupLegendItems",
    title: "Weather Alerts", titleKey: "legend.weatherAlerts", swatch: "color", apply: applyNwsGroupFilter },
  { key: "westtecScenario", groupCode: "x", buckets: WESTTEC_SCENARIO_BUCKETS,
    masterId: "westtecScenarioAllCb", legendId: "westtecScenarioLegend", itemsId: "westtecScenarioLegendItems",
    title: "Scenario", titleKey: "legend.scenario", swatch: "color", apply: applyWestTECFilters },
  { key: "westtecDataset", groupCode: "z", buckets: WESTTEC_DATASET_BUCKETS,
    masterId: "westtecDatasetAllCb", legendId: "westtecDatasetLegend", itemsId: "westtecDatasetLegendItems",
    title: "Project Type", titleKey: "legend.projectType", swatch: "color", apply: applyWestTECFilters },
];

export const LEGEND_FILTERS_BY_KEY = Object.fromEntries(LEGEND_FILTERS.map(c => [c.key, c]));

type LegendFilter = (typeof LEGEND_FILTERS)[number];

export function legendAllIds(cfg: LegendFilter) {
  return (cfg.syncBuckets ?? cfg.buckets).map(b => b.id);
}

// Continuous color-ramp legend HTML
export function rampLegendHtml(entry: { id: string; ramp?: RampDef }) {
  if (!entry.ramp) return "";
  const { stops, min = 0, max, unit, minLabel, maxLabel, fmt } = entry.ramp;
  const css = stops
    .map(([v, rgb]: (number | string)[]) =>
      `rgb(${rgb}) ${Math.round((((v as number) - min) / (max - min)) * 100)}%`)
    .join(", ");
  // minLabel still wins at the bottom end: a ramp starting at zero reads better
  // bare than with a unit repeated from the other end.
  const minStr = minLabel ?? (fmt ? escapeHtml(fmt(min)) : String(min));
  const maxStr = fmt ? escapeHtml(fmt(max, "+")) : (maxLabel ?? `${max}+ ${escapeHtml(unit ?? "")}`);
  return `
    <div class="ramp-legend">
      <span class="ramp-min">${minStr}</span>
      <span class="ramp-bar-wrap">
        <span class="ramp-bar" style="background:linear-gradient(to right, ${css})"></span>
      </span>
      <span class="ramp-max">${maxStr}</span>
    </div>`;
}

// ── Raster color-scale legend boxes ───────────────────────────────────────────
// The legend container is the keeper of every raster's continuous color scale;
// the value under the cursor shows in the hover bubble (raster-probes.ts), so
// the layer-panel rows carry no ramp. Rendered into #rasterRampLegends on
// every updateLegends() pass.
const RASTER_RAMP_LEGEND_IDS = [
  "nlr-wind-100m", "gsa-solar-pvout", "ihfc-geo-heatflow",
  "worldpop-pop-density", "usgs-seismic-pga",
];

function renderRasterRampLegends(): boolean {
  const host = document.getElementById("rasterRampLegends");
  if (!host) return false;
  host.innerHTML = RASTER_RAMP_LEGEND_IDS
    .filter(id => state.layerVisibility[id])
    .map(id => {
      const entry = LAYERS.find(l => l.id === id);
      if (!entry?.ramp) return "";
      return `<div class="legend">
        <div class="legend-title"><span class="legend-title-label">${escapeHtml(t(entry.titleKey))}</span></div>
        <div class="legend-items">${rampLegendHtml(entry)}</div></div>`;
    }).join("");
  return host.innerHTML.trim() !== "";
}

// Weather Forecast's scale lives in its static legend box (#weather-legend-ramp
// inside #weatherLegend) and swaps with the variable dropdown. Called from
// ui-filters.ts on dropdown change and from updateLegends().
export function refreshWeatherRampBlock() {
  const el = document.getElementById("weather-legend-ramp");
  if (!el) return;
  const v = WEATHER_VARIABLES.find(w => w.id === state.weatherVar) ?? WEATHER_VARIABLES[0];
  // noWash variables (Windstream) paint no color raster, so a color scale
  // would be misleading — rampLegendHtml() already renders "" for no ramp.
  el.innerHTML = rampLegendHtml({ id: "weather-live", ramp: v.noWash ? undefined : v.ramp });
}

export function syncLegendMaster(cfg: LegendFilter) {
  const master = document.getElementById(cfg.masterId) as HTMLInputElement | null;
  if (!master) return;
  const active = state.legendFilters[cfg.key].size;
  const total  = legendAllIds(cfg).length;
  master.checked       = active > 0;
  master.indeterminate = active > 0 && active < total;
}

function buildLegendSection(cfg: LegendFilter) {
  const titleText = (cfg as { titleKey?: string }).titleKey
    ? t((cfg as { titleKey?: string }).titleKey!)
    : cfg.title;
  const title = document.querySelector(`#${cfg.legendId} .legend-title-label`);
  if (title) title.innerHTML =
    `<label style="display:flex;align-items:center;gap:6px;cursor:pointer">` +
    `<input type="checkbox" class="legend-master-cb" id="${cfg.masterId}" data-legend-key="${cfg.key}"> ${escapeHtml(titleText)}</label>`;

  const items = document.getElementById(cfg.itemsId);
  if (items) items.innerHTML = cfg.buckets.map(b => {
    const checked = state.legendFilters[cfg.key].has(b.id) ? " checked" : "";
    const swatch  = cfg.swatch === "icon"
      ? `<svg class="legend-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${ICON_SVG[(b as { icon?: string }).icon ?? ""] ?? ""}</svg>`
      : cfg.swatch === "none"
      ? ""
      : cfg.swatch === "line"
      ? `<span class="legend-line-swatch${b.id === "underground" || b.id === "existing" ? " legend-line-swatch--dashed" : ""}"></span>`
      : `<span class="legend-swatch" style="background:${b.color}"></span>`;
    const labelText = (b as { labelKey?: string }).labelKey
      ? t((b as { labelKey?: string }).labelKey!)
      : b.label;
    return `<label class="legend-item legend-filter-item">
       <input type="checkbox" class="legend-filter-cb" data-legend-key="${cfg.key}" data-bucket-id="${b.id}"${checked}>
       ${swatch}
       <span>${escapeHtml(labelText)}</span>
     </label>`;
  }).join("");

  syncLegendMaster(cfg);
}

// ── Live-data age readout ─────────────────────────────────────────────────────
// The three wildfire layers share one file and one `generated_utc` (the pull
// time). We show the *pull age* (now − generated_utc) — the true staleness of
// what's on screen, including how long the page has sat open without refetching.
let liveGeneratedUtc: string | undefined;
// Per-feed degradation flags from the pipeline (stamped on the first feature,
// same carrier as generated_utc). A fresh pull can still be missing a feed —
// e.g. ArcGIS down → zero perimeters — and that must not look like a calm day.
let liveFeedStatus: Record<string, string> | undefined;
// Per-subfeed last-successful-pull stamps (top-level `feed_last_ok`, written
// by the fetch scripts) — a down feed shows the last good data carried
// forward, and this says how old that carry is.
let liveFeedLastOk: Record<string, string | null> | undefined;

// Chip element id → the upstream feeds it depends on (hotspots hard-fail the
// whole pull, so they never appear here — a published file always has them).
const CHIP_FEEDS: Record<string, string[]> = {
  wildfireAge: ["perimeters_us", "perimeters_ca"],
  incidentAge: ["incidents"],
  smokeAge:    ["smoke"],
};

function relAge(tsIso: string, freshMaxMin = 180, agingMaxMin = 360): { short: string; level: string; abs: string } {
  const then = Date.parse(tsIso);
  if (Number.isNaN(then)) return { short: "", level: "", abs: "" };
  // Show the pull time in the viewer's local timezone (e.g. "Pulled Jun 28, 7:30 AM PDT").
  const abs = t("age.pulled", { time: new Date(then).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }) });
  const min = Math.max(0, Math.round((Date.now() - then) / 60000));
  // Compact on purpose — the chip widens the whole legend; the verbose pull
  // time lives in the title attribute.
  const short = min < 1 ? t("age.now") : fmtAgeShort(Date.now() - then);
  // Wildfire defaults: cron misses of 1–3h are routine and VIIRS obs are hours
  // old anyway — warn only when meaningfully behind; "stale" aligns with the
  // 6h kill-switch. Faster feeds (NWS alerts) pass tighter thresholds.
  const level = min <= freshMaxMin ? "fresh" : min <= agingMaxMin ? "aging" : "stale";
  return { short, level, abs };
}

// NWS alerts: ~10 min cadence, 3 h kill-switch — tighter thresholds than
// wildfire. feed_status carries per-feed degradation (e.g. {"eccc":"failed"}
// when the Canada pull failed and the file shipped US-only).
let nwsGeneratedUtc: string | undefined;
let nwsFeedStatus: Record<string, string> | undefined;
let nwsFeedLastOk: Record<string, string | null> | undefined;

const NWS_FEED_NAMES: Record<string, string> = { nws: "feed.us", eccc: "feed.canada" };

function nwsIssues(): string[] {
  return Object.entries(nwsFeedStatus ?? {})
    .filter(([, status]) => status !== "ok")
    .map(([feed]) => t("age.feedDown", {
      name: NWS_FEED_NAMES[feed] ? t(NWS_FEED_NAMES[feed]) : feed, age: downFor(nwsFeedLastOk?.[feed]),
    }));
}

function renderNwsAge() {
  if (!nwsGeneratedUtc) return;
  const el = document.getElementById("nwsAge");
  if (!el) return;
  const { short, level, abs } = relAge(nwsGeneratedUtc, 60, 180);
  const issues = nwsIssues();
  el.textContent = issues.length ? `${short} · ${issues.join(", ")}` : short;
  el.title = abs + t("age.nwsTip") + (issues.length ? t("age.degradedTip") : "");
  // A degraded feed is at least "aging" (amber), same rule as renderLiveAge.
  el.className = "legend-age legend-age--" + (issues.length && level === "fresh" ? "aging" : level);
}

function renderLiveAge() {
  if (!liveGeneratedUtc) return;
  const { short, level, abs } = relAge(liveGeneratedUtc);
  for (const id of ["smokeAge", "wildfireAge", "incidentAge"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const issues = CHIP_FEEDS[id]
      .map(f => feedIssue(f, liveFeedStatus?.[f] ?? "ok", liveFeedLastOk?.[f]))
      .filter((s): s is string => s !== null);
    el.textContent = issues.length ? `${short} · ${issues.join(", ")}` : short;
    el.title = abs + t("age.fireTip") + (issues.length ? t("age.degradedTip") : "");
    // A degraded feed is at least "aging" (amber) even seconds after a pull.
    el.className = "legend-age legend-age--" + (issues.length && level === "fresh" ? "aging" : level);
  }
  for (const id of ["smokeDataTimestamp", "wildfireDataTimestamp", "incidentDataTimestamp"]) {
    const el = document.getElementById(id);
    // The pull time replaces the "loading…" placeholder; a language change
    // must not put the placeholder back.
    if (el) { el.removeAttribute("data-i18n"); el.textContent = abs; }
  }
}

// Register live-data listener and refresh interval once at module load.
// Hoisted outside buildLegends() to prevent stacking multiple listeners/intervals
// when buildLegends() is called multiple times (init + reset).
window.addEventListener("tm:layerdata", (e) => {
  const { registryId } = (e as CustomEvent<{ registryId: string }>).detail;
  if (registryId === "wildfire-live") {
    const first = (state.sourcesData?.["wildfire-live"]?.[0] as GeoJSON.Feature | undefined)?.properties;
    const fcMeta = state.liveFcMeta["wildfire-live"];
    liveGeneratedUtc = (first?.generated_utc as string | undefined) ?? fcMeta?.generated_utc;
    liveFeedStatus = (first?.feed_status as Record<string, string> | undefined) ?? fcMeta?.feed_status;
    liveFeedLastOk = fcMeta?.feed_last_ok;
    renderLiveAge();
  } else if (registryId === "nws-alerts") {
    const first = (state.sourcesData?.["nws-alerts"]?.[0] as GeoJSON.Feature | undefined)?.properties;
    const fcMeta = state.liveFcMeta["nws-alerts"];
    nwsGeneratedUtc = (first?.generated_utc as string | undefined) ?? fcMeta?.generated_utc;
    nwsFeedStatus = (first?.feed_status as Record<string, string> | undefined) ?? fcMeta?.feed_status;
    nwsFeedLastOk = fcMeta?.feed_last_ok;
    renderNwsAge();
  }
});
setInterval(() => { renderLiveAge(); renderNwsAge(); }, 60_000);

export function buildLegends() {
  for (const cfg of LEGEND_FILTERS) buildLegendSection(cfg);
  updateLegends();
}

// Every layer switch (visibility.ts's setLayerVisibility) re-runs the show/hide pass.
on('layer:visibility', () => updateLegends());

// `colorKey`: for a legend that only colours the lines in one colour-by mode,
// whether it is the active key; otherwise its swatches dim (it stays a filter).
const LEGEND_VISIBILITY: { el: string; show: () => boolean; colorKey?: () => boolean }[] = [
  { el: "voltageLegend",    show: () => LAYERS.some(l => l.voltageLayer  && state.layerVisibility[l.id]) },
  { el: "linePlacementLegend", show: () => !!state.layerVisibility["osm-transmission-lines"] || !!state.layerVisibility["hifld-transmission-lines"] },
  { el: "fuelLegend",       show: () => LAYERS.some(l => l.fuelLayer     && state.layerVisibility[l.id]) },
  { el: "pipelineLegend",   show: () => LAYERS.some(l => l.pipelineLayer && state.layerVisibility[l.id]) },
  { el: "sectorLegend",     show: () => !!state.layerVisibility["eia-generators"] },
  { el: "crithabLegend",    show: () => !!state.layerVisibility["crithab"] },
  { el: "padusLegend",      show: () => !!state.layerVisibility["padus"] },
  { el: "tribalLegend",     show: () => !!state.layerVisibility["tribal-lands"] },
  { el: "natgasLineLegend", show: () => !!state.layerVisibility["hifld-natgas-lines"] },
  { el: "natgasPtsLegend",  show: () => !!state.layerVisibility["hifld-natgas-points"] || !!state.layerVisibility["hifld-petroleum-facilities"] },
  { el: "substanceLegend",  show: () => !!state.layerVisibility["osm-pipelines-lines"] },
  { el: "nercLegend",       show: () => !!state.layerVisibility["nerc-regions"] },
  { el: "retailLegend",     show: () => !!state.layerVisibility["retail-territories"] },
  { el: "whpLegend",             show: () => !!state.layerVisibility["usfs-wildfire-potential"] },
  { el: "ogfRegionLegend",       show: () => !!state.layerVisibility["ogf-planned-transmission"], colorKey: () => state.ogfColorBy === "region" },
  { el: "ogfStatusLegend",       show: () => !!state.layerVisibility["ogf-planned-transmission"], colorKey: () => state.ogfColorBy === "status" },
  { el: "ogfWorkLegend",         show: () => !!state.layerVisibility["ogf-planned-transmission"] },
  { el: "minesLegend",           show: () => !!state.layerVisibility["mines"] },
  { el: "minesStatusLegend",     show: () => !!state.layerVisibility["mines"] },
  { el: "smokeLiveLegend",        show: () => !!state.layerVisibility["wildfire-smoke"] },
  { el: "wildfireLiveLegend",    show: () => !!state.layerVisibility["wildfire-live"] },
  { el: "nwsGroupLegend",        show: () => !!state.layerVisibility["nws-alerts"] },
  { el: "incidentLegend",        show: () => !!state.layerVisibility["wildfire-incidents"] },
  { el: "odinLegend",            show: () => !!state.layerVisibility["odin-outages"] },
  { el: "femaNriLegend",         show: () => !!state.layerVisibility["fema-nri"] },
  { el: "dcMoratoriumLegend",    show: () => !!state.layerVisibility["dc-moratoriums"] },
  { el: "radarLegend",           show: () => !!state.layerVisibility["nexrad-radar"] },
  { el: "westtecScenarioLegend", show: () => !!state.layerVisibility["westtec-10yr"], colorKey: () => state.westtecColorBy === "scenario" },
  { el: "westtecDatasetLegend",  show: () => !!state.layerVisibility["westtec-10yr"], colorKey: () => state.westtecColorBy === "dataset" },
  { el: "weatherLegend",         show: () => !!state.layerVisibility["weather-live"] },
];

export function updateLegends() {
  let anyShown = renderRasterRampLegends();
  refreshWeatherRampBlock();
  for (const { el, show, colorKey } of LEGEND_VISIBILITY) {
    const visible = show();
    if (visible) anyShown = true;
    const node = document.getElementById(el);
    if (node) node.hidden = !visible;
    if (node && colorKey) node.classList.toggle("legend--not-color-key", !colorKey());
  }

  const container = document.getElementById("legendContainer");
  if (container) container.hidden = !anyShown;
}
