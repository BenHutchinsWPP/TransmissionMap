// ─── Legends + legend-filter registry ────────────────────────────────────────
// LEGEND_FILTERS pairs each facet record (src/colors/facets.ts: group code,
// buckets, defaults, DOM ids, title, swatch) with its applier from
// ../filters.js's FACET_APPLIERS. The URL codec and ui-filters.ts read it.
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
// The live-feed age chips refresh on the 'layer:data' bus event (state-bus.ts).

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import type { RampDef, BucketDef, BucketedField } from '../../src/types.js';
import { FACETS } from '../../src/colors/facets.js';
import { FACET_APPLIERS } from '../filters.js';
import { escapeHtml } from '../utils/utils.js';
import { fmtAgeShort, downFor, feedIssue } from '../live-staleness.js';
import { ICON_SVG } from '../icons.js';
import { WEATHER_VARIABLES } from '../../src/registry/conditions.js';
import { t } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';

export interface LegendFilter {
  key: string;
  groupCode: string;
  buckets: BucketDef[];
  syncBuckets?: BucketDef[];
  masterId: string;
  legendId: string;
  itemsId: string;
  title: string;
  titleKey: string;
  swatch: BucketedField["swatch"];
  defaultActive?: string[];
  apply: () => void;
}

export const LEGEND_FILTERS: LegendFilter[] = FACETS.map(f => {
  const legendId = f.legendId ?? `${f.key}Legend`;
  return {
    key: f.key, groupCode: f.groupCode, buckets: f.buckets,
    ...(f.syncBuckets && { syncBuckets: f.syncBuckets }),
    masterId: f.masterId ?? `${f.key}AllCb`, legendId, itemsId: `${legendId}Items`,
    title: f.title, titleKey: f.titleKey, swatch: f.swatch,
    ...(f.defaultActive && { defaultActive: f.defaultActive }),
    apply: FACET_APPLIERS[f.key],
  };
});

export const LEGEND_FILTERS_BY_KEY = Object.fromEntries(LEGEND_FILTERS.map(c => [c.key, c]));

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
on('layer:data', ({ id }) => {
  if (id === "wildfire-live") {
    const first = (state.sourcesData?.["wildfire-live"]?.[0] as GeoJSON.Feature | undefined)?.properties;
    const fcMeta = state.liveFcMeta["wildfire-live"];
    liveGeneratedUtc = (first?.generated_utc as string | undefined) ?? fcMeta?.generated_utc;
    liveFeedStatus = (first?.feed_status as Record<string, string> | undefined) ?? fcMeta?.feed_status;
    liveFeedLastOk = fcMeta?.feed_last_ok;
    renderLiveAge();
  } else if (id === "nws-alerts") {
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
