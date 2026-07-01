// ─── Legends + legend-filter registry ────────────────────────────────────────

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import type { RampDef } from '../../src/types.js';
import { VOLTAGE_LEGEND, FUEL_LEGEND } from '../../src/colors/fuel.js';
import {
  KV_BUCKETS, PIPELINE_TYPE_BUCKETS, CRITHAB_BUCKETS, PADUS_CLASS_BUCKETS,
  TRIBAL_BUCKETS, NATGAS_PIPE_TYPE_BUCKETS, NATGAS_FAC_TYPE_BUCKETS,
  NERC_BUCKETS, RETAIL_TYPE_BUCKETS, OGF_STATUS_BUCKETS, SUBSTANCE_BUCKETS,
} from '../../src/colors/buckets.js';
import {
  applyVoltageFilter, applyGeneratorFilters, applyPipelineTypeFilter,
  applyCritHabFilter, applyPadusClassFilter, applyTribalClassFilter,
  applyNatgasLineFilter, applyNatgasPtsFilter, applyNercFilter,
  applyRetailTypeFilter, applyOGFStatusFilter, applySubstanceFilter,
} from '../filters.js';
import { escapeHtml } from '../utils/utils.js';
import { ICON_SVG } from '../icons.js';

// >>> ADD-LAYER: legend-filters — see docs/adding-a-layer.md §opt
export const LEGEND_FILTERS = [
  { key: "kv", groupCode: "v", buckets: VOLTAGE_LEGEND, syncBuckets: KV_BUCKETS,
    masterId: "kvAllCb", legendId: "voltageLegend", itemsId: "voltageLegendItems",
    title: "Voltage (kV)", swatch: "color",
    defaultActive: ["550+", "500-549", "300-499", "200-299"], apply: applyVoltageFilter },
  { key: "fuel", groupCode: "f", buckets: FUEL_LEGEND,
    masterId: "fuelAllCb", legendId: "fuelLegend", itemsId: "fuelLegendItems",
    title: "Fuel Type", swatch: "icon", apply: applyGeneratorFilters },
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
    title: "Tribal Lands (AIANNH)", swatch: "color", apply: applyTribalClassFilter },
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
    title: "Project status", swatch: "color", apply: applyOGFStatusFilter },
];

export const LEGEND_FILTERS_BY_KEY = Object.fromEntries(LEGEND_FILTERS.map(c => [c.key, c]));

type LegendFilter = (typeof LEGEND_FILTERS)[number];

export function legendAllIds(cfg: LegendFilter) {
  return (cfg.syncBuckets ?? cfg.buckets).map(b => b.id);
}

// Continuous color-ramp legend HTML
export function rampLegendHtml(entry: { id: string; ramp?: RampDef }) {
  if (!entry.ramp) return "";
  const { stops, max, unit, minLabel, maxLabel } = entry.ramp;
  const css = stops
    .map(([v, rgb]: (number | string)[]) => `rgb(${rgb}) ${Math.round(((v as number) / max) * 100)}%`)
    .join(", ");
  const minStr = minLabel ?? "0";
  const maxStr = maxLabel ?? `${max}+ ${escapeHtml(unit ?? "")}`;
  return `
    <div class="ramp-legend">
      <span class="ramp-min">${minStr}</span>
      <span class="ramp-bar-wrap">
        <span class="ramp-bar" style="background:linear-gradient(to right, ${css})"></span>
        <span class="ramp-arrow" id="${entry.id}-ramp-arrow" hidden>▼</span>
      </span>
      <span class="ramp-max">${maxStr}</span>
    </div>
    <div class="ramp-readout" id="${entry.id}-ramp-readout" hidden></div>`;
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

function relAge(tsIso: string): { short: string; level: string; abs: string } {
  const then = Date.parse(tsIso);
  if (Number.isNaN(then)) return { short: "", level: "", abs: "" };
  // Show the pull time in the viewer's local timezone (e.g. "Pulled Jun 28, 7:30 AM PDT").
  const abs = "Pulled " + new Date(then).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const min = Math.max(0, Math.round((Date.now() - then) / 60000));
  const short =
    min < 1    ? "live"
    : min < 60   ? `${min}m old`
    : min < 1440 ? `${Math.round(min / 60)}h old`
    :              `${Math.round(min / 1440)}d old`;
  const level = min <= 90 ? "fresh" : min <= 360 ? "aging" : "stale";  // hourly feed: >90m = a cycle missed
  return { short, level, abs };
}

function renderLiveAge() {
  if (!liveGeneratedUtc) return;
  const { short, level, abs } = relAge(liveGeneratedUtc);
  for (const id of ["smokeAge", "wildfireAge", "incidentAge"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = short;
    el.title = abs;
    el.className = "legend-age legend-age--" + level;
  }
  for (const id of ["smokeDataTimestamp", "wildfireDataTimestamp", "incidentDataTimestamp"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = abs;
  }
}

export function buildLegends() {
  for (const cfg of LEGEND_FILTERS) buildLegendSection(cfg);
  updateLegends();
  // Refresh the age when the shared wildfire-live source loads, then tick it
  // every minute so the displayed age stays honest while the page is open.
  window.addEventListener("tm:layerdata", (e) => {
    const { registryId } = (e as CustomEvent<{ registryId: string }>).detail;
    if (registryId !== "wildfire-live") return;
    liveGeneratedUtc = (state.sourcesData?.["wildfire-live"]?.[0] as GeoJSON.Feature | undefined)?.properties?.generated_utc as string | undefined;
    renderLiveAge();
  });
  setInterval(renderLiveAge, 60_000);
}

const LEGEND_VISIBILITY = [
  { el: "voltageLegend",    show: () => LAYERS.some(l => l.voltageLayer  && state.layerVisibility[l.id]) },
  { el: "fuelLegend",       show: () => LAYERS.some(l => l.fuelLayer     && state.layerVisibility[l.id]) },
  { el: "pipelineLegend",   show: () => LAYERS.some(l => l.pipelineLayer && state.layerVisibility[l.id]) },
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
  { el: "smokeLiveLegend",        show: () => !!state.layerVisibility["wildfire-smoke"] },
  { el: "wildfireLiveLegend",    show: () => !!state.layerVisibility["wildfire-live"] },
  { el: "incidentLegend",        show: () => !!state.layerVisibility["wildfire-incidents"] },
  { el: "dataCounterLegend",     show: () => { const cb = document.getElementById("dataCounterToggle") as HTMLInputElement | null; return !cb || cb.checked; } },
];

export function updateLegends() {
  let anyShown = false;
  for (const { el, show } of LEGEND_VISIBILITY) {
    const visible = show();
    if (visible) anyShown = true;
    const node = document.getElementById(el);
    if (node) node.hidden = !visible;
  }

  const container = document.getElementById("legendContainer");
  if (container) container.hidden = !anyShown;
}
