// ─── Legends + legend-filter registry ────────────────────────────────────────

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import type { RampDef } from '../../src/types.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import {
  KV_BUCKETS, VOLTAGE_LEGEND, PIPELINE_TYPE_BUCKETS, CRITHAB_BUCKETS, PADUS_CLASS_BUCKETS,
  TRIBAL_BUCKETS, NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS,
  NERC_BUCKETS, RETAIL_TYPE_BUCKETS, OGF_STATUS_BUCKETS, SUBSTANCE_BUCKETS,
  OGF_SCENARIO_BUCKETS, OGF_PLANAUTH_BUCKETS, SECTOR_BUCKETS, LINE_PLACEMENT_BUCKETS,
  NWS_GROUP_BUCKETS, WESTTEC_SCENARIO_BUCKETS, WESTTEC_DATASET_BUCKETS,
} from '../../src/colors/buckets.js';
import {
  applyVoltageFilter, applyGeneratorFilters, applyPipelineTypeFilter,
  applyCritHabFilter, applyPadusClassFilter, applyTribalClassFilter,
  applyNatgasLineFilter, applyNatgasPtsFilter, applyNercFilter,
  applyRetailTypeFilter, applyOGFFilters, applySubstanceFilter, applyMinesFilter,
  applyNwsGroupFilter, applyWestTECFilters,
} from '../filters.js';
import { MINES_COMMODITY_BUCKETS, MINES_STATUS_BUCKETS } from '../../src/colors/minerals.js';
import { escapeHtml } from '../utils/utils.js';
import { fmtAgeShort } from '../live-staleness.js';
import { ICON_SVG } from '../icons.js';
import { WEATHER_VARIABLES } from '../../src/registry/conditions.js';

// >>> ADD-LAYER: legend-filters — see docs/adding-a-layer.md §opt
export const LEGEND_FILTERS = [
  { key: "kv", groupCode: "v", buckets: VOLTAGE_LEGEND, syncBuckets: KV_BUCKETS,
    masterId: "kvAllCb", legendId: "voltageLegend", itemsId: "voltageLegendItems",
    title: "Voltage (kV)", swatch: "color", apply: applyVoltageFilter },
  { key: "underground", groupCode: "o", buckets: LINE_PLACEMENT_BUCKETS,
    masterId: "linePlacementAllCb", legendId: "linePlacementLegend", itemsId: "linePlacementLegendItems",
    title: "Line placement", swatch: "line", apply: applyVoltageFilter },
  { key: "fuel", groupCode: "f", buckets: FUEL_LEGEND,
    masterId: "fuelAllCb", legendId: "fuelLegend", itemsId: "fuelLegendItems",
    title: "Fuel Type", swatch: "icon", apply: applyGeneratorFilters },
  { key: "sector", groupCode: "i", buckets: SECTOR_BUCKETS,
    masterId: "sectorAllCb", legendId: "sectorLegend", itemsId: "sectorLegendItems",
    title: "EIA Plants — sector", swatch: "none", apply: applyGeneratorFilters },
  { key: "pipeline", groupCode: "p", buckets: PIPELINE_TYPE_BUCKETS,
    masterId: "pipelineAllCb", legendId: "pipelineLegend", itemsId: "pipelineLegendItems",
    title: "Pipeline Points", swatch: "icon", apply: applyPipelineTypeFilter },
  { key: "crithab", groupCode: "h", buckets: CRITHAB_BUCKETS,
    masterId: "crithabAllCb", legendId: "crithabLegend", itemsId: "crithabLegendItems",
    title: "Critical Habitat — ESA status", swatch: "color", apply: applyCritHabFilter },
  { key: "padus", groupCode: "j", buckets: PADUS_CLASS_BUCKETS,
    masterId: "padusAllCb", legendId: "padusLegend", itemsId: "padusLegendItems",
    title: "PAD-US — land type", swatch: "color", apply: applyPadusClassFilter },
  { key: "tribal", groupCode: "t", buckets: TRIBAL_BUCKETS,
    masterId: "tribalAllCb", legendId: "tribalLegend", itemsId: "tribalLegendItems",
    title: "Tribal (Census)", swatch: "color", apply: applyTribalClassFilter },
  { key: "natgasLine", groupCode: "n", buckets: NATGAS_PIPE_TYPE_BUCKETS,
    masterId: "natgasLineAllCb", legendId: "natgasLineLegend", itemsId: "natgasLineLegendItems",
    title: "Pipeline type", swatch: "color", apply: applyNatgasLineFilter },
  { key: "natgasPts", groupCode: "r", buckets: NATGAS_FAC_TYPE_BUCKETS,
    masterId: "natgasPtsAllCb", legendId: "natgasPtsLegend", itemsId: "natgasPtsLegendItems",
    title: "Facility type", swatch: "icon", apply: applyNatgasPtsFilter },
  { key: "substance", groupCode: "u", buckets: SUBSTANCE_BUCKETS,
    masterId: "substanceAllCb", legendId: "substanceLegend", itemsId: "substanceLegendItems",
    title: "Pipeline fuel", swatch: "color",
    defaultActive: ["gas", "oil", "products", "hydrogen", "coal"], apply: applySubstanceFilter },
  { key: "nerc", groupCode: "c", buckets: NERC_BUCKETS,
    masterId: "nercAllCb", legendId: "nercLegend", itemsId: "nercLegendItems",
    title: "NERC Region", swatch: "color", apply: applyNercFilter },
  { key: "retail", groupCode: "e", buckets: RETAIL_TYPE_BUCKETS,
    masterId: "retailAllCb", legendId: "retailLegend", itemsId: "retailLegendItems",
    title: "Utility type", swatch: "color", apply: applyRetailTypeFilter },
  { key: "ogfStatus", groupCode: "g", buckets: OGF_STATUS_BUCKETS,
    masterId: "ogfStatusAllCb", legendId: "ogfStatusLegend", itemsId: "ogfStatusLegendItems",
    title: "Project status", swatch: "color", apply: applyOGFFilters },
  { key: "ogfScenario", groupCode: "w", buckets: OGF_SCENARIO_BUCKETS,
    masterId: "ogfScenarioAllCb", legendId: "ogfScenarioLegend", itemsId: "ogfScenarioLegendItems",
    title: "WestTEC scenario", swatch: "color", apply: applyOGFFilters },
  { key: "ogfPlanAuth", groupCode: "a", buckets: OGF_PLANAUTH_BUCKETS,
    masterId: "ogfPlanAuthAllCb", legendId: "ogfPlanAuthLegend", itemsId: "ogfPlanAuthLegendItems",
    title: "Planning authority", swatch: "color", apply: applyOGFFilters },
  { key: "mines", groupCode: "k", buckets: MINES_COMMODITY_BUCKETS,
    masterId: "minesAllCb", legendId: "minesLegend", itemsId: "minesLegendItems",
    title: "Mines — commodity", swatch: "icon", apply: applyMinesFilter },
  { key: "minesStatus", groupCode: "d", buckets: MINES_STATUS_BUCKETS,
    masterId: "minesStatusAllCb", legendId: "minesStatusLegend", itemsId: "minesStatusLegendItems",
    title: "Mines — status", swatch: "none", defaultActive: ["active"], apply: applyMinesFilter },
  { key: "nwsGroup", groupCode: "q", buckets: NWS_GROUP_BUCKETS,
    masterId: "nwsGroupAllCb", legendId: "nwsGroupLegend", itemsId: "nwsGroupLegendItems",
    title: "Weather Alerts", swatch: "color", apply: applyNwsGroupFilter },
  { key: "westtecScenario", groupCode: "x", buckets: WESTTEC_SCENARIO_BUCKETS,
    masterId: "westtecScenarioAllCb", legendId: "westtecScenarioLegend", itemsId: "westtecScenarioLegendItems",
    title: "Scenario", swatch: "color", apply: applyWestTECFilters },
  { key: "westtecDataset", groupCode: "z", buckets: WESTTEC_DATASET_BUCKETS,
    masterId: "westtecDatasetAllCb", legendId: "westtecDatasetLegend", itemsId: "westtecDatasetLegendItems",
    title: "Project Type", swatch: "color", apply: applyWestTECFilters },
];

export const LEGEND_FILTERS_BY_KEY = Object.fromEntries(LEGEND_FILTERS.map(c => [c.key, c]));

type LegendFilter = (typeof LEGEND_FILTERS)[number];

export function legendAllIds(cfg: LegendFilter) {
  return (cfg.syncBuckets ?? cfg.buckets).map(b => b.id);
}

// Continuous color-ramp legend HTML
export function rampLegendHtml(entry: { id: string; ramp?: RampDef }) {
  if (!entry.ramp) return "";
  const { stops, min = 0, max, unit, minLabel, maxLabel } = entry.ramp;
  const css = stops
    .map(([v, rgb]: (number | string)[]) =>
      `rgb(${rgb}) ${Math.round((((v as number) - min) / (max - min)) * 100)}%`)
    .join(", ");
  const minStr = minLabel ?? String(min);
  const maxStr = maxLabel ?? `${max}+ ${escapeHtml(unit ?? "")}`;
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
        <div class="legend-title"><span class="legend-title-label">${escapeHtml(entry.label)}</span></div>
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
  el.innerHTML = rampLegendHtml({ id: "weather-live", ramp: v.ramp });
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
  const title = document.querySelector(`#${cfg.legendId} .legend-title-label`);
  if (title) title.innerHTML =
    `<label style="display:flex;align-items:center;gap:6px;cursor:pointer">` +
    `<input type="checkbox" class="legend-master-cb" id="${cfg.masterId}" data-legend-key="${cfg.key}"> ${cfg.title}</label>`;

  const items = document.getElementById(cfg.itemsId);
  if (items) items.innerHTML = cfg.buckets.map(b => {
    const checked = state.legendFilters[cfg.key].has(b.id) ? " checked" : "";
    const swatch  = cfg.swatch === "icon"
      ? `<svg class="legend-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${ICON_SVG[(b as { icon?: string }).icon ?? ""] ?? ""}</svg>`
      : cfg.swatch === "none"
      ? ""
      : cfg.swatch === "line"
      ? `<span class="legend-line-swatch${b.id === "underground" ? " legend-line-swatch--dashed" : ""}"></span>`
      : `<span class="legend-swatch" style="background:${b.color}"></span>`;
    return `<label class="legend-item legend-filter-item">
       <input type="checkbox" class="legend-filter-cb" data-legend-key="${cfg.key}" data-bucket-id="${b.id}"${checked}>
       ${swatch}
       <span>${escapeHtml(b.label)}</span>
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

// " 3h" since the subfeed's last successful pull, "" when unknown.
function downFor(lastOk: string | null | undefined): string {
  const t = lastOk ? Date.parse(lastOk) : NaN;
  return Number.isNaN(t) ? "" : ` ${fmtAgeShort(Date.now() - t)}`;
}

// Compact text for a degraded feed ("CA perim down 3h"), or null when ok.
function feedIssue(feed: string, status: string, lastOk?: string | null): string | null {
  if (status === "ok") return null;
  const name = { perimeters_us: "US perim", perimeters_ca: "CA perim",
                 incidents: "incidents", smoke: "smoke" }[feed] ?? feed;
  const m = status.match(/^fallback-(\d+)d$/);
  return m ? `${name} ${m[1]}d old` : `${name} down${downFor(lastOk)}`;
}

function relAge(tsIso: string, freshMaxMin = 180, agingMaxMin = 360): { short: string; level: string; abs: string } {
  const then = Date.parse(tsIso);
  if (Number.isNaN(then)) return { short: "", level: "", abs: "" };
  // Show the pull time in the viewer's local timezone (e.g. "Pulled Jun 28, 7:30 AM PDT").
  const abs = "Pulled " + new Date(then).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const min = Math.max(0, Math.round((Date.now() - then) / 60000));
  // Compact on purpose — the chip widens the whole legend; the verbose pull
  // time lives in the title attribute.
  const short = min < 1 ? "now" : fmtAgeShort(Date.now() - then);
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

const NWS_FEED_NAMES: Record<string, string> = { nws: "US", eccc: "Canada" };

function nwsIssues(): string[] {
  return Object.entries(nwsFeedStatus ?? {})
    .filter(([, status]) => status !== "ok")
    .map(([feed]) => `${NWS_FEED_NAMES[feed] ?? feed} down${downFor(nwsFeedLastOk?.[feed])}`);
}

function renderNwsAge() {
  if (!nwsGeneratedUtc) return;
  const el = document.getElementById("nwsAge");
  if (!el) return;
  const { short, level, abs } = relAge(nwsGeneratedUtc, 60, 180);
  const issues = nwsIssues();
  el.textContent = issues.length ? `${short} · ${issues.join(", ")}` : short;
  el.title = abs + " — when the map last fetched the alert feed; expired alerts are removed automatically"
    + (issues.length ? ". A source feed is degraded — this layer shows the last good data, which may be incomplete." : "");
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
    el.title = abs + " — when the map last fetched the feeds; observations can be older (see legend note)"
      + (issues.length ? ". A source feed is degraded — this layer shows the last good data, which may be incomplete." : "");
    // A degraded feed is at least "aging" (amber) even seconds after a pull.
    el.className = "legend-age legend-age--" + (issues.length && level === "fresh" ? "aging" : level);
  }
  for (const id of ["smokeDataTimestamp", "wildfireDataTimestamp", "incidentDataTimestamp"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = abs;
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

const LEGEND_VISIBILITY = [
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
  { el: "ogfStatusLegend",       show: () => !!state.layerVisibility["ogf-planned-transmission"] },
  { el: "ogfScenarioLegend",     show: () => !!state.layerVisibility["ogf-planned-transmission"] },
  { el: "ogfPlanAuthLegend",     show: () => !!state.layerVisibility["ogf-planned-transmission"] },
  { el: "minesLegend",           show: () => !!state.layerVisibility["mines"] },
  { el: "minesStatusLegend",     show: () => !!state.layerVisibility["mines"] },
  { el: "smokeLiveLegend",        show: () => !!state.layerVisibility["wildfire-smoke"] },
  { el: "wildfireLiveLegend",    show: () => !!state.layerVisibility["wildfire-live"] },
  { el: "nwsGroupLegend",        show: () => !!state.layerVisibility["nws-alerts"] },
  { el: "incidentLegend",        show: () => !!state.layerVisibility["wildfire-incidents"] },
  { el: "odinLegend",            show: () => !!state.layerVisibility["odin-outages"] },
  { el: "radarLegend",           show: () => !!state.layerVisibility["nexrad-radar"] },
  { el: "westtecScenarioLegend", show: () => !!state.layerVisibility["westtec-10yr"] },
  { el: "westtecDatasetLegend",  show: () => !!state.layerVisibility["westtec-10yr"] },
  { el: "weatherLegend",         show: () => !!state.layerVisibility["weather-live"] },
  { el: "dataCounterLegend",     show: () => { const cb = document.getElementById("dataCounterToggle") as HTMLInputElement | null; return !cb || cb.checked; } },
];

export function updateLegends() {
  let anyShown = renderRasterRampLegends();
  refreshWeatherRampBlock();
  for (const { el, show } of LEGEND_VISIBILITY) {
    const visible = show();
    if (visible) anyShown = true;
    const node = document.getElementById(el);
    if (node) node.hidden = !visible;
  }

  const container = document.getElementById("legendContainer");
  if (container) container.hidden = !anyShown;
}
