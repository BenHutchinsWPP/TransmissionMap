// ─── Pure formatting logic for popups ────────────────────────────────────────
// Deps: utils/utils.js (escapeHtml), src/colors/buckets.js (label maps),
// nws-zone-join.js (alert lookups), src/units.js (every quantity with a unit
// goes through a fmt* helper so it follows the File ▸ Settings… preference —
// see docs/settings.md). Row labels must stay unit-neutral ("Area", not
// "Acres") because the rendered value changes with that preference.
// src/i18n/index.js (t).

import { escapeHtml } from './utils/utils.js';
import { osmTlLayerIds } from '../src/registry/transmission.js';
import { NATGAS_FAC_TYPE_BUCKETS, WESTTEC_SCENARIO_BUCKETS, WESTTEC_SCENARIO_MAP } from '../src/colors/buckets.js';
import { lookupByZone, lookupByFips, type ZoneAlertEntry } from './nws-zone-join.js';
import { fmtTemp, fmtElevation, fmtElevationRange, fmtDistanceMi, fmtAreaAcres, fmtAreaSqFt, fmtArea } from '../src/units.js';
import { t } from '../src/i18n/index.js';

const _natgasFacLabel = Object.fromEntries(NATGAS_FAC_TYPE_BUCKETS.map(b => [b.id, b.label]));

// BTS NARN NET (network classification) codes → human labels.
const RAIL_NET_LABELS: Record<string, string> = {
  M: "Main", I: "Industrial", Y: "Yard", S: "Siding", A: "Abandoned",
  X: "Out of service", O: "Other", T: "Transit", R: "Removed/rail-trail", F: "Ferry",
};

export function row(key: string, val: unknown) {
  if (val == null || val === "" || val === "0" || val === 0) return "";
  const label = t(key);
  return `<div class="popup-row"><span class="popup-key">${escapeHtml(label)}</span> <span class="popup-val">${escapeHtml(val)}</span></div>`;
}

export function websiteRow(url: string) {
  if (!url) return "";
  // Browsers strip ASCII control chars/whitespace when parsing a URL scheme,
  // so "java\tscript:alert(1)" navigates as javascript: — strip the same
  // range before checking or the guard is bypassable.
  // eslint-disable-next-line no-control-regex -- control chars are the point: strip what browsers strip
  if (url.replace(/[\u0000-\u0020]/g, '').toLowerCase().startsWith('javascript:')) return "";
  return `<div class="popup-row"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(t('popup.website'))}</a></div>`;
}

// OSM object ID, hyperlinked to its openstreetmap.org page. `osmType` must be
// node/way/relation — the URL 404s on the wrong type. The OGR OSM `lines` layer
// is ways-only and substation points are nodes, so those are exact; polygon
// substations are overwhelmingly ways (route relations are rare).
// ponytail: relation-backed substation polygons mislink; add osm_type to the
// pipeline if that ever matters.
export function osmLink(osmType: "node" | "way" | "relation", id: unknown) {
  if (id == null || id === "") return "";
  return `<div class="popup-row"><span class="popup-key">OSM ID</span> ` +
    `<span class="popup-val"><a href="https://www.openstreetmap.org/${osmType}/${encodeURIComponent(String(id))}" ` +
    `target="_blank" rel="noopener">${escapeHtml(id)}</a></span></div>`;
}

export function title(text: string) {
  return `<div class="popup-title truncate">${escapeHtml(text)}</div>`;
}

export function plantRenderer(defaultTitle: string) {
  return (p: Record<string, unknown>) => title((p.name as string) || defaultTitle) +
    row("popup.fuel", p.source) +
    row("popup.capacity", p.output_mw ? p.output_mw + " MW" : null) +
    row("popup.operator", p.operator) +
    row("popup.since", p.start_date);
}

export function renderOgfPlanned(p: Record<string, unknown>) {
  const link = (p.Link as string || "").trim();
  const voltStr = p.MinVolt && p.MaxVolt && p.MinVolt !== p.MaxVolt
    ? p.MinVolt + "–" + p.MaxVolt + " kV"
    : (p.MaxVolt || p.MinVolt) ? (p.MaxVolt || p.MinVolt) + " kV" : null;
  return title((p.Project as string) || t("popup.plannedTransmission")) +
    row("popup.owner", p.Owner) +
    row("popup.status", (p.Status as string || "").trim() || null) +
    row("popup.type", p.Type) +
    row("popup.voltage", voltStr) +
    row("popup.capacity", p.CapacityMW ? p.CapacityMW + " MW" : null) +
    row("popup.estYear", p.EstYear) +
    row("popup.acdc", (p.ACDC as string || "").trim() || null) +
    row("popup.from", p.FromSub) +
    row("popup.to", p.ToSub) +
    row("popup.states", p.StatesFull) +
    row("popup.rtoIso", p.ISO_RTO) +
    row("popup.planAuth", p.PlanAuth) +
    row("popup.portfolio", p.Portfolio) +
    row("popup.length", typeof p.Length_mi === 'number' ? fmtDistanceMi(p.Length_mi) : null) +
    (link ? `<div class="popup-row"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(t("popup.projectPage"))}</a></div>` : "") +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">Our Grid Future — Horizon Energy Systems, 2026</div>`;
}

export function renderEiaGen(p: Record<string, unknown>) {
  const onlineLabel = p.gen_status === "proposed" ? "popup.estOnline" : "popup.online";
  const retireRow = p.gen_status === "retirement" && p.retirement_year ? row("popup.retires", p.retirement_year) : "";
  const retiredRow = p.gen_status === "retired" && p.retirement_year ? row("popup.retired", p.retirement_year) : "";
  return title((p.plant_name as string) || t("popup.eiaPlant")) +
    row("popup.technology", p.technology) +
    row("popup.fuel", p.energy_source) +
    row("popup.capacity", p.nameplate_mw ? p.nameplate_mw + " MW" : null) +
    row("popup.utility", p.utility_name) +
    row("popup.sector", p.sector_name) +
    row("popup.nercRegion", p.nerc_region) +
    row("popup.baCode", p.ba_code) +
    row("popup.state", p.state) +
    row(onlineLabel, p.op_year) +
    retireRow + retiredRow +
    row("popup.pipelines", p.pipelines);
}

export function renderHifldNatgasPts(p: Record<string, unknown>) {
  const typeLabel = _natgasFacLabel[p.fac_type as string] || (p.fac_type as string) || t("popup.natgasFacility");
  return title((p.name as string) || typeLabel) +
    row("popup.type", typeLabel) +
    row("popup.operator", p.operator) +
    row("popup.state", p.state) +
    row("popup.status", p.status) +
    row("popup.detail", p.detail);
}

export function renderGeoHydroPts(p: Record<string, unknown>) {
  const depthStr = typeof p.min_depth_m === 'number'
    ? (typeof p.max_depth_m === 'number' ? fmtElevationRange(p.min_depth_m, p.max_depth_m) : fmtElevation(p.min_depth_m))
    : null;
  return title((p.name as string) || t("popup.hydrothermalSystem")) +
    row("popup.temperature", typeof p.temp_c === 'number' ? fmtTemp(p.temp_c) : null) +
    row("popup.state", p.state) +
    row("popup.county", p.county) +
    row("popup.depth", depthStr) +
    row("popup.beneficialHeat", typeof p.heat_mwt === 'number' ? p.heat_mwt.toFixed(2) + " MWt (30 yr)" : null) +
    row("popup.source", p.reference);
}

export function renderWeccPath(p: Record<string, unknown>) {
  // MapLibre serialises array/object GeoJSON properties to JSON strings.
  let lines: string[] = [];
  if (Array.isArray(p.lines)) lines = p.lines as string[];
  else if (typeof p.lines === "string" && p.lines.startsWith("[")) {
    try { lines = JSON.parse(p.lines); } catch { /* ignore */ }
  }
  const linesBlock = lines.length
    ? `<details class="popup-row"><summary>${lines.length === 1 ? escapeHtml(t("popup.linesInPathOne", { count: 1 })) : escapeHtml(t("popup.linesInPath", { count: lines.length }))}</summary>` +
      `<ul style="margin:4px 0 0;padding-left:18px">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`
    : "";
  const seasonalBlock = p.seasonal && p.rating_detail
    ? `<div class="popup-row"><span class="popup-key">${escapeHtml(t("popup.seasonalLimits"))}</span> ` +
      `<span class="popup-val">${escapeHtml(p.rating_detail as string)}</span></div>`
    : "";
  // `revised` embeds status+date ("Revised March 2022" / "Added March 2024").
  // Render it as its own labelled row (key = status word, value = date).
  const rev = (p.revised as string) || "";
  const revRow = rev
    ? row(p.status === "Added" ? "popup.added" : (p.status as string) || "popup.revised", rev.replace(/^(Revised|Added)\s+/, ""))
    : "";
  // name already carries the "N:" prefix, so title is just "Path <name>".
  return title(t("popup.pathTitle", { name: String(p.name || p.number) })) +
    row("popup.ratingType", p.rating_category) +
    revRow +
    row((p.dir_fwd as string) || "popup.forward", p.mw_fwd_raw) +
    row((p.dir_rev as string) || "popup.reverse", p.mw_rev_raw) +
    row("popup.note", p.note) +
    seasonalBlock +
    linesBlock +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">${escapeHtml((p.source as string) || "WECC Path Rating Catalog")}</div>`;
}

export function renderBa(p: Record<string, unknown>) {
  return title((p.name as string) || t("popup.balancingAuthority")) +
    row("popup.state", p.state) +
    row("popup.totalCapacity", typeof p.tot_cap === 'number' && p.tot_cap > 0 ? p.tot_cap.toLocaleString() + " MW" : null) +
    row("popup.peakLoad", typeof p.peak_ld === 'number' && p.peak_ld > 0 ? p.peak_ld.toLocaleString() + " MW" : null) +
    row("popup.year", p.year) +
    websiteRow(p.website as string);
}

// OSM substations come in two map layers: node points and way/relation polygons.
// Same fields, different OSM object type for the ID link.
export function substationRenderer(osmType: "node" | "way") {
  return (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.substation")) +
    row("popup.voltage", p.nominal_kv ? p.nominal_kv + " kV" : null) +
    row("popup.type", p.sub_type) +
    row("popup.operator", p.operator) +
    osmLink(osmType, p.osm_id);
}

export function renderRetail(p: Record<string, unknown>) {
  return title((p.name as string) || t("popup.retailTerritory")) +
    row("popup.type", p.type) +
    row("popup.state", p.state) +
    row("popup.customers", typeof p.customers === 'number' && p.customers > 0 ? p.customers.toLocaleString() : null) +
    row("popup.retailMwh", typeof p.retail_mwh === 'number' && p.retail_mwh > 0 ? p.retail_mwh.toLocaleString() + " MWh" : null) +
    row("popup.summerPeak", typeof p.sumr_peak === 'number' && p.sumr_peak > 0 ? p.sumr_peak + " MW" : null) +
    row("popup.controlArea", p.ctrl_area) +
    websiteRow(p.website as string);
}

export const POPUP_RENDERERS: Record<string, (p: Record<string, unknown>) => string> = {};

// ── Joined zone/county alert-list popups (nws-zone-fill / nws-county-fill) ──
// Several alerts can name one zone/county; list all of them (not just the
// feature-state "winner" nws-zone-join.ts paints with), same severity-desc /
// earliest-ends-first ordering as that module's pickWinner (replicated here,
// not imported — nws-zone-join.ts only exports the lookup indexes).
const _ZONE_SEV_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
function _zoneSevRank(sev?: string): number {
  return sev ? (_ZONE_SEV_RANK[sev] ?? 0) : 0;
}
function _zoneEndsMs(e: ZoneAlertEntry): number {
  const t = e.ends ? Date.parse(e.ends) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}
function sortZoneAlerts(entries: ZoneAlertEntry[]): ZoneAlertEntry[] {
  return [...entries].sort((a, b) =>
    _zoneSevRank(b.severity) - _zoneSevRank(a.severity) || _zoneEndsMs(a) - _zoneEndsMs(b));
}
function fmtDt(iso: unknown): string | null {
  if (!iso) return null;
  try {
    return new Date(iso as string).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch { return iso as string; }
}
function renderZoneAlertBlock(e: ZoneAlertEntry): string {
  const eccc = e.senderName === "Environment and Climate Change Canada";
  return `<div class="popup-row"><strong>${escapeHtml(e.event)}${eccc ? " (ECCC)" : ""}</strong></div>` +
    row("popup.headline", e.headline) +
    row("popup.ends", fmtDt(e.ends || e.expires));
}
function renderZoneAlertList(entries: ZoneAlertEntry[]): string {
  return sortZoneAlerts(entries).map(renderZoneAlertBlock).join("");
}

// >>> ADD-LAYER: popup-renderers — see docs/adding-a-layer.md §10. Add a
// [ [mapLayerIds…], (p) => html ] tuple; the loop below registers it into POPUP_RENDERERS.
// Raw scenario value → legend label, derived from the legend buckets so the
// popup can never drift from the legend.
const WESTTEC_SCENARIO_LABELS: Record<string, string> = Object.fromEntries(
  WESTTEC_SCENARIO_BUCKETS.flatMap(b =>
    (WESTTEC_SCENARIO_MAP[b.id as keyof typeof WESTTEC_SCENARIO_MAP] ?? []).map(v => [v, b.label])));

const OSM_TL_POPUP_IDS = osmTlLayerIds("hv", "mv", "lv", "unknown", "dc");

const _defs = [
  [["ogf-planned-lines"], renderOgfPlanned],
  [["westtec-lines"], (p: Record<string, unknown>) =>
    title(p.name as string) +
    row("popup.scenario", WESTTEC_SCENARIO_LABELS[p.scenario as string] || (p.scenario as string)) +
    row("popup.projectType", p.dataset === "planned" ? t("popup.plannedProject") : p.dataset === "identified" ? t("popup.identifiedUpgrade") : null) +
    row("popup.upgradeType", p.upgrade_type) +
    row("popup.voltage", p.voltage_kv ? `${p.voltage_kv} kV` : null) +
    row("popup.lineType", p.line_type) +
    row("popup.length", p.length_mi ? fmtDistanceMi(Number(p.length_mi)) : null)],
  [OSM_TL_POPUP_IDS, (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.transmissionLine")) +
    row("popup.voltage", p.nominal_kv ? p.nominal_kv + " kV" : null) +
    row("popup.current", p.is_dc ? "DC" : null) +
    row("popup.placement", p.is_undergrnd ? t("popup.underground") : null) +
    row("popup.operator", p.operator) +
    osmLink("way", p.osm_id)],
  [["hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown", "hifld-transmission-lines-dc"], (p: Record<string, unknown>) =>
    title(p.SUB_1 && p.SUB_2 ? p.SUB_1 + " → " + p.SUB_2 : t("popup.hifldTransmissionLine")) +
    row("popup.voltage", p.VOLTAGE ? p.VOLTAGE + " kV" : null) +
    row("popup.class", p.VOLT_CLASS) +
    row("popup.owner", p.OWNER) +
    row("popup.type", p.TYPE) +
    row("popup.status", p.STATUS) +
    row("popup.hifldId", p.ID)],
  [["osm-substations-points-hv", "osm-substations-points-lv"], substationRenderer("node")],
  [["osm-substations-polygons-fill"], substationRenderer("way")],
  [["hifld-substations-hv", "hifld-substations-lv"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.hifldSubstation")) +
    row("popup.maxKv", p.max_kv) +
    row("popup.minKv", p.min_kv) +
    row("popup.hifldId", p.hifld_id)],
  [["eia-gen-circles"], renderEiaGen],
  [["eia-crude-pipelines"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.crudeOilPipeline")) +
    row("popup.type", t("popup.crudeOil")) +
    row("popup.operator", p.operator)],
  [["eia-product-pipelines"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.petroleumProductPipeline")) +
    row("popup.type", t("popup.refinedProducts")) +
    row("popup.operator", p.operator)],
  [["wecc-paths-circles"], renderWeccPath],
  [["osm-plant-icons"], plantRenderer(t("popup.osmPowerPlant"))],
  [["osm-plants-polygons-fill"], plantRenderer(t("popup.powerPlantSite"))],
  [["osm-gen-circles"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.osmGenerator")) +
    row("popup.fuel", p.source) +
    row("popup.method", p.gen_method) +
    row("popup.type", p.gen_type) +
    row("popup.capacity", p.output_mw ? p.output_mw + " MW" : null) +
    row("popup.operator", p.operator)],
  [["hifld-natgas-interstate", "hifld-natgas-intrastate", "hifld-natgas-hgl", "hifld-natgas-gathering"], (p: Record<string, unknown>) =>
    title((p.name as string) || (p.operator as string) || t("popup.hifldPipeline")) +
    row("popup.type", p.pipe_type) +
    row("popup.operator", p.operator)],
  [["hifld-natgas-points", "hifld-petroleum-facilities"], renderHifldNatgasPts],
  [["osm-pipelines-lines"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.pipeline")) +
    row("popup.substance", p.substance) +
    row("popup.type", p.facil_type) +
    row("popup.operator", p.operator)],
  [["railroads"], (p: Record<string, unknown>) =>
    title((p.RROWNER1 as string) || t("popup.railroad")) +
    row("popup.subdivision", p.SUBDIV) +
    row("popup.division", p.DIVISION) +
    row("popup.branch", p.BRANCH) +
    row("popup.netClass", RAIL_NET_LABELS[p.NET as string] || (p.NET as string)) +
    row("popup.tracks", p.TRACKS) +
    row("popup.passenger", p.PASSNGR ? t("popup.yes") : null) +
    row("popup.state", p.STATEAB)],
  [["osm-pipelines-points"], (p: Record<string, unknown>) =>
    title((p.pipeline as string) || t("popup.pipelineFeature")) +
    row("popup.operator", p.operator)],
  [["osm-dc-circles", "osm-dc-points", "osm-dc-heat-points"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.dataCenter")) +
    row("popup.operator", p.operator) +
    row("popup.siteCode", p.im3_ref) +
    websiteRow(p.website as string) +
    row("popup.city", p.addr_city) +
    row("popup.state", p.addr_state) +
    row("popup.since", p.start_date) +
    row("popup.size", Number(p.im3_sqft) > 0 ? fmtAreaSqFt(Number(p.im3_sqft)) + " (IM3)" : null) +
    // osm_type absent in pre-2026-07 builds; skip the link rather than guess the type
    (p.osm_type ? osmLink(p.osm_type as "node" | "way" | "relation", p.osm_id) : "")],
  [["mines-icons"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.mine")) +
    row("popup.commodity", p.commodity) +
    row("popup.status", p.status === "active" ? t("popup.active") : t("popup.retiredIdled")) +
    row("popup.peakEmployment", p.employees) +
    row("popup.operator", p.operator) +
    row("popup.state", p.state)],
  [["nrel-hydrothermal-points"], renderGeoHydroPts],
  [["padus-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.protectedLand")) +
    row("popup.designation", p.desig) +
    row("popup.manager", p.mng_agency) +
    row("popup.managerType", p.mng_type) +
    row("popup.gapStatus", p.gap) +
    row("popup.publicAccess", p.access) +
    row("popup.area", p.acres ? fmtAreaAcres(Number(p.acres)) : null) +
    row("popup.state", p.state) +
    row("popup.established", p.yr_est) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">${escapeHtml(t("popup.padusFooter"))}</div>`],
  [["tribal-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.tribalCensus")) +
    row("popup.areaType", p.area_type) +
    row("popup.recognition", p.recognized) +
    row("popup.landArea", p.acres_land ? fmtAreaAcres(Number(p.acres_land)) : null) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em;padding-top:4px;">${escapeHtml(t("popup.tribalCensusFooter"))}</div>`],
  [["bia-tribal-fill"], (p: Record<string, unknown>) =>
    title((p.LARNAME as string) || t("popup.tribalBia")) +
    row("popup.agency", p.AGENCY) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em;padding-top:4px;">${escapeHtml(t("popup.tribalBiaFooter"))}</div>`],
  [["crithab-fill"], (p: Record<string, unknown>) =>
    title((p.comname as string) || (p.sciname as string) || t("popup.criticalHabitat")) +
    row("popup.scientificName", p.sciname) +
    row("popup.status", p.status) +
    row("popup.listing", p.listing_st) +
    row("popup.unit", p.unitname) +
    row("popup.subunit", p.subunitnam) +
    row("popup.effective", p.effectdate)],
  [["nerc-fill"], (p: Record<string, unknown>) =>
    title((p.sub_nm as string) || (p.code as string) || t("popup.nercRegion")) +
    row("popup.region", p.region) +
    row("popup.code", p.code) +
    websiteRow(p.website as string)],
  [["ba-fill"], renderBa],
  [["eiaba-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.balancingAuthority")) +
    row("popup.abbreviation", p.abbrev) +
    row("popup.area", p.area_sqmi ? fmtArea(Number(p.area_sqmi) * 2589988.11) : null)],
  [["retail-fill"], renderRetail],
  [["countries-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.country")) +
    row("popup.isoCode", p.iso_a3)],
  [["admin1-fill"], (p: Record<string, unknown>) =>
    // `country` is absent from some builds — row() drops it cleanly rather
    // than rendering a blank/"undefined" line.
    title((p.name as string) || t("popup.state")) +
    row("popup.country", p.country) +
    row("popup.isoCode", p.iso_a3)],
  [["us-states-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || t("popup.state")) +
    row("popup.abbreviation", p.stusps) +
    row("popup.geoid", p.geoid)],
  [["us-counties-fill"], (p: Record<string, unknown>) => {
    const county = (p.NAME as string) || t("popup.county");
    const heading = p.STATE_NAME ? `${county}, ${p.STATE_NAME}` : county;
    return title(heading) + row("popup.geoid", p.GEOID);
  }],
  [["us-zcta-fill"], (p: Record<string, unknown>) =>
    title(`ZCTA ${p.zcta5 ?? ""}`) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">${escapeHtml(t("popup.zctaNote"))}</div>`],
  [["wildfire-incidents-circle"], (p: Record<string, unknown>) => {
    const typeCat = p.type_cat as string | null;
    const typeLabel = typeCat === "WF" ? t("popup.wildfireWF")
      : typeCat === "RX" ? t("popup.prescribedFireRX")
      : typeCat === "WFU" ? t("popup.wildlandFireUseWFU")
      : typeCat || null;
    const acresStr = p.acres != null ? fmtAreaAcres(Number(p.acres)) : null;
    return title(((p.name as string) || t("popup.unnamedIncident")) + " " + t("popup.incidentSuffix")) +
      row("popup.id", p.fire_id) +
      row("popup.type", typeLabel) +
      row("popup.state", p.state) +
      row("popup.areaBurned", acresStr) +
      row("popup.contained", p.pct_contained != null ? p.pct_contained + "%" : null) +
      row("popup.discovered", fmtDt(p.discovery_dt)) +
      row("popup.currentAsOf", fmtDt(p.modified_dt));
  }],
  [["nws-alerts-fill"], (p: Record<string, unknown>) => {
    const severity = p.urgency ? `${p.severity} (${p.urgency})` : (p.severity as string | undefined) || null;
    const eccc = p.country === "CA";
    const eventTitle = ((p.event as string) || t("popup.weatherAlert")) + (eccc ? " (ECCC)" : "");
    return title(eventTitle) +
      row("popup.severity", severity) +
      row("popup.onset", fmtDt(p.onset)) +
      row("popup.ends", fmtDt(p.ends || p.expires)) +
      row("popup.area", p.areaDesc) +
      row("popup.issuedBy", p.senderName) +
      row("popup.headline", p.headline);
  }],
  [["odin-outages-fill"], (p: Record<string, unknown>) => {
    // Numbers come from the feature-state join (merged into p by popup.ts);
    // county NAME/STATE_NAME come from the county_boundaries tile properties.
    // No join value → unlit county → no popup.
    if (p.odin_out == null) return "";
    const county = (p.NAME as string) || t("popup.county");
    const heading = p.STATE_NAME ? `${county}, ${p.STATE_NAME}` : county;
    const fmt = (v: unknown) => escapeHtml(Number(v).toLocaleString());
    // No "Since" column: the snapshot's per-utility `since` is min(start) across
    // the group, so 1 customer out for 8h dominates 1000 out for 2min — a
    // worst-case time that reads worse than reality. Per-report times live in
    // the raw incident pager instead.
    const hasUtils = Array.isArray(p.odin_utils) && p.odin_utils.length;
    // County total lives in the table's Total row; without a per-utility
    // breakdown (older snapshot) it falls back to a plain popup row.
    const utilRows = hasUtils
      ? `<table class="popup-table"><thead><tr><th>${escapeHtml(t("popup.utilityOutageMap"))}</th><th>${escapeHtml(t("popup.out"))}</th></tr></thead><tbody>` +
        (p.odin_utils as [string, number, number, (string | null)?][]).map(([name, out]) => {
          const href = `https://www.google.com/search?q=${encodeURIComponent(`${name} power outage map`)}`;
          return `<tr><td><a href="${href}" target="_blank" rel="noopener">${escapeHtml(name)} ↗</a></td>` +
            `<td>${fmt(out)}</td></tr>`;
        }).join("") +
        `<tr class="popup-table-total"><td>${escapeHtml(t("popup.totalCustomersAffected"))}</td><td>${fmt(p.odin_out)}</td></tr>` +
        `</tbody></table>`
      : "";
    // Per-outage report pager: shell only — records are fetched on demand
    // and the buttons are wired by odin-outages.ts (document-level delegation).
    const rawUi = typeof p.GEOID === "string"
      ? `<div class="odin-raw" data-fips="${escapeHtml(p.GEOID)}">` +
        `<button type="button" class="odin-raw-btn">${escapeHtml(t("popup.viewIncidentReports"))}</button>` +
        `<div class="odin-raw-body"></div></div>`
      : "";
    return title(heading) +
      (hasUtils ? "" : row("popup.customersAffected", typeof p.odin_out === "number" ? Number(p.odin_out).toLocaleString() : p.odin_out)) +
      row("popup.activeIncidents", p.odin_n) +
      utilRows +
      rawUi +
      `<div class="popup-row" style="opacity:0.6;font-size:0.8em">${escapeHtml(t("popup.odinFooter"))}</div>`;
  }],
  [["nws-zone-fill"], (p: Record<string, unknown>) => {
    // nws_group comes from the feature-state join (merged into p by popup.ts).
    // No join value → unlit zone → no popup.
    if (p.nws_group == null) return "";
    const type = p.type as string;
    const ugc = p.ugc as string;
    const entries = lookupByZone(type, ugc);
    if (!entries.length) return "";
    const heading = (p.name as string || t("popup.weatherZone")) + (type === "fire" ? ` (${t("popup.fireWeatherZone")})` : type === "marine" ? ` (${t("popup.marineZone")})` : "");
    return title(heading) + renderZoneAlertList(entries);
  }],
  [["nws-county-fill"], (p: Record<string, unknown>) => {
    // Same unlit-feature guard as nws-zone-fill, keyed by county GEOID instead.
    if (p.nws_group == null) return "";
    const geoid = p.GEOID as string;
    const entries = lookupByFips(geoid);
    if (!entries.length) return "";
    const county = (p.NAME as string) || t("popup.county");
    const heading = p.STATE_NAME ? `${county}, ${p.STATE_NAME}` : county;
    return title(heading) + renderZoneAlertList(entries);
  }],
  [["smoke-live-fill"], (p: Record<string, unknown>) =>
    title(t("popup.smokePlume")) +
    row("popup.density", p.density as string) +
    row("popup.satellite", p.satellite) +
    row("popup.start", p.start_dt) +
    row("popup.end", p.end_dt)],
  [["wildfire-perimeters-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || (p.country === "CA" ? t("popup.firePerimeterEstimateCwfis") : t("popup.firePerimeter"))) +
    row("popup.state", p.state) +
    row("popup.cause", p.cause) +
    row("popup.discovered", p.discovery_date) +
    row("popup.contained", p.pct_contained != null ? p.pct_contained + "%" : null) +
    row("popup.size", p.gis_acres ? fmtAreaAcres(Number(p.gis_acres)) : null) +
    row("popup.hotspots", p.hotspot_count) +
    row("popup.updated", p.updated_dt) +
    (p.country === "CA" ? row("popup.note", t("popup.estimatedExtentFromHotspots")) : "")],
  [["wildfire-hotspots-circle"], (p: Record<string, unknown>) =>
    title(t("popup.fireHotspot")) +
    row("popup.frp", p.frp ? p.frp + " MW" : null) +
    row("popup.confidence", p.confidence === "h" ? t("popup.high") : p.confidence === "n" ? t("popup.nominal") : p.confidence) +
    row("popup.satellite", p.satellite) +
    row("popup.detected", p.acq_date ? p.acq_date + (p.acq_time ? " " + String(p.acq_time).padStart(4, "0").replace(/(..)(..)/, "$1:$2") + " UTC" : "") : null) +
    row("popup.age", p.age_hours != null ? t("popup.hoursAgo", { hours: String(p.age_hours) }) : null)],
  [["boem-wind-leases-fill"], (p: Record<string, unknown>) =>
    title((p.project as string) || (p.company as string) || t("popup.offshoreWindLease")) +
    row("popup.company", p.company) +
    row("popup.leaseNo", p.lease) +
    row("popup.type", p.type) +
    row("popup.state", p.state) +
    row("popup.area", p.acres ? fmtAreaAcres(Number(p.acres)) : null) +
    row("popup.leaseDate", p.date) +
    row("popup.term", p.term)],
] as [string[], (p: Record<string, unknown>) => string][];

for (const [ids, fn] of _defs) {
  for (const id of ids) POPUP_RENDERERS[id] = fn;
}

export function buildUserFeatureHtml(p: Record<string, unknown>) {
  const name = (p.name || p.Name || p.label || p.title || "Feature") as string;
  const skip = new Set([
    "__uid", "__src", "name", "Name", "label", "title",
    "styleUrl", "styleHash", "styleMapHash", "stroke", "stroke-width",
    "stroke-opacity", "fill", "fill-opacity", "icon", "visibility",
  ]);
  let html = title(name);
  for (const [k, v] of Object.entries(p)) {
    if (skip.has(k) || v == null || typeof v === "object") continue;
    html += row(k, v);
  }
  return html;
}

export function buildPopupHtml(layerId: string, properties: Record<string, unknown>) {
  if (layerId.startsWith("user-")) {
    // Features copied from a main layer carry __src = origin layer id; reuse its
    // formatted popup so the source's data/labels survive the copy.
    const src = properties.__src as string | undefined;
    if (src && POPUP_RENDERERS[src]) return POPUP_RENDERERS[src](properties);
    return buildUserFeatureHtml(properties);
  }
  const renderer = POPUP_RENDERERS[layerId];
  return renderer ? renderer(properties) : null;
}
