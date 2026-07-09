// ─── Pure formatting logic for popups ────────────────────────────────────────

import { escapeHtml } from './utils/utils.js';
import { NATGAS_FAC_TYPE_BUCKETS } from '../src/colors/buckets.js';

const _natgasFacLabel = Object.fromEntries(NATGAS_FAC_TYPE_BUCKETS.map(b => [b.id, b.label]));

// BTS NARN NET (network classification) codes → human labels.
const RAIL_NET_LABELS: Record<string, string> = {
  M: "Main", I: "Industrial", Y: "Yard", S: "Siding", A: "Abandoned",
  X: "Out of service", O: "Other", T: "Transit", R: "Removed/rail-trail", F: "Ferry",
};

export function row(key: string, val: unknown) {
  if (val == null || val === "" || val === "0" || val === 0) return "";
  return `<div class="popup-row"><span class="popup-key">${key}</span> <span class="popup-val">${escapeHtml(val)}</span></div>`;
}

export function websiteRow(url: string) {
  if (!url) return "";
  return `<div class="popup-row"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Website</a></div>`;
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
    row("Fuel", p.source) +
    row("Capacity", p.output_mw ? p.output_mw + " MW" : null) +
    row("Operator", p.operator) +
    row("Since", p.start_date);
}

export function renderOgfPlanned(p: Record<string, unknown>) {
  const link = (p.Link as string || "").trim();
  const voltStr = p.MinVolt && p.MaxVolt && p.MinVolt !== p.MaxVolt
    ? p.MinVolt + "–" + p.MaxVolt + " kV"
    : (p.MaxVolt || p.MinVolt) ? (p.MaxVolt || p.MinVolt) + " kV" : null;
  return title((p.Project as string) || "Planned Transmission") +
    row("Owner", p.Owner) +
    row("Status", (p.Status as string || "").trim() || null) +
    row("Type", p.Type) +
    row("Voltage", voltStr) +
    row("Capacity", p.CapacityMW ? p.CapacityMW + " MW" : null) +
    row("Est. Year", p.EstYear) +
    row("AC/DC", (p.ACDC as string || "").trim() || null) +
    row("From", p.FromSub) +
    row("To", p.ToSub) +
    row("States", p.StatesFull) +
    row("RTO/ISO", p.ISO_RTO) +
    row("Plan Authority", p.PlanAuth) +
    row("Portfolio", p.Portfolio) +
    row("Length", typeof p.Length_mi === 'number' ? p.Length_mi.toFixed(1) + " mi" : null) +
    (link ? `<div class="popup-row"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">Project page</a></div>` : "") +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">Our Grid Future — Horizon Energy Systems, 2026</div>`;
}

export function renderEiaGen(p: Record<string, unknown>) {
  const onlineLabel = p.gen_status === "proposed" ? "Est. Online" : "Online";
  const retireRow = p.gen_status === "retirement" && p.retirement_year ? row("Retires", p.retirement_year) : "";
  const retiredRow = p.gen_status === "retired" && p.retirement_year ? row("Retired", p.retirement_year) : "";
  return title((p.plant_name as string) || "EIA Plant") +
    row("Technology", p.technology) +
    row("Fuel", p.energy_source) +
    row("Capacity", p.nameplate_mw ? p.nameplate_mw + " MW" : null) +
    row("Utility", p.utility_name) +
    row("Sector", p.sector_name) +
    row("NERC Region", p.nerc_region) +
    row("BA Code", p.ba_code) +
    row("State", p.state) +
    row(onlineLabel, p.op_year) +
    retireRow + retiredRow +
    row("Pipelines", p.pipelines);
}

export function renderHifldNatgasPts(p: Record<string, unknown>) {
  const typeLabel = _natgasFacLabel[p.fac_type as string] || (p.fac_type as string) || "NatGas Facility";
  return title((p.name as string) || typeLabel) +
    row("Type", typeLabel) +
    row("Operator", p.operator) +
    row("State", p.state) +
    row("Status", p.status) +
    row("Detail", p.detail);
}

export function renderGeoHydroPts(p: Record<string, unknown>) {
  const depthStr = p.min_depth_m != null
    ? (p.max_depth_m != null ? p.min_depth_m + "–" + p.max_depth_m + " m" : p.min_depth_m + " m")
    : null;
  return title((p.name as string) || "Hydrothermal System") +
    row("Temperature", p.temp_c != null ? p.temp_c + " °C" : null) +
    row("State", p.state) +
    row("County", p.county) +
    row("Depth", depthStr) +
    row("Beneficial heat", typeof p.heat_mwt === 'number' ? p.heat_mwt.toFixed(2) + " MWt (30 yr)" : null) +
    row("Source", p.reference);
}

export function renderWeccPath(p: Record<string, unknown>) {
  // MapLibre serialises array/object GeoJSON properties to JSON strings.
  let lines: string[] = [];
  if (Array.isArray(p.lines)) lines = p.lines as string[];
  else if (typeof p.lines === "string" && p.lines.startsWith("[")) {
    try { lines = JSON.parse(p.lines); } catch { /* ignore */ }
  }
  const linesBlock = lines.length
    ? `<details class="popup-row"><summary>${lines.length} line${lines.length > 1 ? "s" : ""} in path</summary>` +
      `<ul style="margin:4px 0 0;padding-left:18px">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`
    : "";
  const seasonalBlock = p.seasonal && p.rating_detail
    ? `<div class="popup-row"><span class="popup-key">Seasonal limits</span> ` +
      `<span class="popup-val">${escapeHtml(p.rating_detail as string)}</span></div>`
    : "";
  // `revised` embeds status+date ("Revised March 2022" / "Added March 2024").
  // Render it as its own labelled row (key = status word, value = date).
  const rev = (p.revised as string) || "";
  const revRow = rev
    ? row((p.status as string) || "Revised", rev.replace(/^(Revised|Added)\s+/, ""))
    : "";
  // name already carries the "N:" prefix, so title is just "Path <name>".
  return title(`Path ${p.name || p.number}`) +
    row("Rating type", p.rating_category) +
    revRow +
    row(p.dir_fwd as string || "Forward", p.mw_fwd_raw) +
    row(p.dir_rev as string || "Reverse", p.mw_rev_raw) +
    row("Note", p.note) +
    seasonalBlock +
    linesBlock +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">${escapeHtml((p.source as string) || "WECC Path Rating Catalog")}</div>`;
}

export function renderBa(p: Record<string, unknown>) {
  return title((p.name as string) || "Balancing Authority") +
    row("State", p.state) +
    row("Total capacity", typeof p.tot_cap === 'number' && p.tot_cap > 0 ? p.tot_cap.toLocaleString() + " MW" : null) +
    row("Peak load", typeof p.peak_ld === 'number' && p.peak_ld > 0 ? p.peak_ld.toLocaleString() + " MW" : null) +
    row("Year", p.year) +
    websiteRow(p.website as string);
}

// OSM substations come in two map layers: node points and way/relation polygons.
// Same fields, different OSM object type for the ID link.
export function substationRenderer(osmType: "node" | "way") {
  return (p: Record<string, unknown>) =>
    title((p.name as string) || "Substation") +
    row("Voltage", p.nominal_kv ? p.nominal_kv + " kV" : null) +
    row("Type", p.sub_type) +
    row("Operator", p.operator) +
    osmLink(osmType, p.osm_id);
}

export function renderRetail(p: Record<string, unknown>) {
  return title((p.name as string) || "Retail Territory") +
    row("Type", p.type) +
    row("State", p.state) +
    row("Customers", typeof p.customers === 'number' && p.customers > 0 ? p.customers.toLocaleString() : null) +
    row("Retail MWh", typeof p.retail_mwh === 'number' && p.retail_mwh > 0 ? p.retail_mwh.toLocaleString() + " MWh" : null) +
    row("Summer peak", typeof p.sumr_peak === 'number' && p.sumr_peak > 0 ? p.sumr_peak + " MW" : null) +
    row("Control area", p.ctrl_area) +
    websiteRow(p.website as string);
}

export const POPUP_RENDERERS: Record<string, (p: Record<string, unknown>) => string> = {};

// >>> ADD-LAYER: popup-renderers — see docs/adding-a-layer.md §10. Add a
// [ [mapLayerIds…], (p) => html ] tuple; the loop below registers it into POPUP_RENDERERS.
const _defs = [
  [["ogf-planned-lines"], renderOgfPlanned],
  [["osm-transmission-lines-hv", "osm-transmission-lines-mv", "osm-transmission-lines-lv", "osm-transmission-lines-unknown"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Transmission Line") +
    row("Voltage", p.nominal_kv ? p.nominal_kv + " kV" : null) +
    row("Operator", p.operator) +
    osmLink("way", p.osm_id)],
  [["hifld-transmission-lines-hv", "hifld-transmission-lines-mv", "hifld-transmission-lines-lv", "hifld-transmission-lines-unknown"], (p: Record<string, unknown>) =>
    title(p.SUB_1 && p.SUB_2 ? p.SUB_1 + " → " + p.SUB_2 : "HIFLD Transmission Line") +
    row("Voltage", p.VOLTAGE ? p.VOLTAGE + " kV" : null) +
    row("Class", p.VOLT_CLASS) +
    row("Owner", p.OWNER) +
    row("Type", p.TYPE) +
    row("Status", p.STATUS) +
    row("HIFLD ID", p.ID)],
  [["osm-substations-points-hv", "osm-substations-points-lv"], substationRenderer("node")],
  [["osm-substations-polygons-fill"], substationRenderer("way")],
  [["hifld-substations-hv", "hifld-substations-lv"], (p: Record<string, unknown>) =>
    title((p.name as string) || "HIFLD Substation") +
    row("Max kV", p.max_kv) +
    row("Min kV", p.min_kv) +
    row("HIFLD ID", p.hifld_id)],
  [["eia-gen-circles"], renderEiaGen],
  [["eia-crude-pipelines"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Crude Oil Pipeline") +
    row("Type", "Crude oil") +
    row("Operator", p.operator)],
  [["eia-product-pipelines"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Petroleum Product Pipeline") +
    row("Type", "Refined products") +
    row("Operator", p.operator)],
  [["wecc-paths-circles"], renderWeccPath],
  [["osm-plant-icons"], plantRenderer("OSM Power Plant")],
  [["osm-plants-polygons-fill"], plantRenderer("Power Plant Site")],
  [["osm-gen-circles"], (p: Record<string, unknown>) =>
    title((p.name as string) || "OSM Generator") +
    row("Fuel", p.source) +
    row("Method", p.gen_method) +
    row("Type", p.gen_type) +
    row("Capacity", p.output_mw ? p.output_mw + " MW" : null) +
    row("Operator", p.operator)],
  [["hifld-natgas-interstate", "hifld-natgas-intrastate", "hifld-natgas-hgl", "hifld-natgas-gathering"], (p: Record<string, unknown>) =>
    title((p.name as string) || (p.operator as string) || "HIFLD Pipeline") +
    row("Type", p.pipe_type) +
    row("Operator", p.operator)],
  [["hifld-natgas-points", "hifld-petroleum-facilities"], renderHifldNatgasPts],
  [["osm-pipelines-lines"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Pipeline") +
    row("Substance", p.substance) +
    row("Type", p.facil_type) +
    row("Operator", p.operator)],
  [["railroads"], (p: Record<string, unknown>) =>
    title((p.RROWNER1 as string) || "Railroad") +
    row("Subdivision", p.SUBDIV) +
    row("Division", p.DIVISION) +
    row("Branch", p.BRANCH) +
    row("Net class", RAIL_NET_LABELS[p.NET as string] || (p.NET as string)) +
    row("Tracks", p.TRACKS) +
    row("Passenger", p.PASSNGR ? "Yes" : null) +
    row("State", p.STATEAB)],
  [["osm-pipelines-points"], (p: Record<string, unknown>) =>
    title((p.pipeline as string) || "Pipeline Feature") +
    row("Operator", p.operator)],
  [["osm-dc-circles", "osm-dc-points", "osm-dc-heat-points"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Data Center") +
    row("Operator", p.operator) +
    row("Site code", p.im3_ref) +
    websiteRow(p.website as string) +
    row("City", p.addr_city) +
    row("State", p.addr_state) +
    row("Since", p.start_date) +
    row("Size", Number(p.im3_sqft) > 0 ? Number(p.im3_sqft).toLocaleString() + " sq ft (IM3)" : null) +
    // osm_type absent in pre-2026-07 builds; skip the link rather than guess the type
    (p.osm_type ? osmLink(p.osm_type as "node" | "way" | "relation", p.osm_id) : "")],
  [["mines-icons"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Mine") +
    row("Commodity", p.commodity) +
    row("Status", p.status === "active" ? "Active" : "Retired / idled") +
    row("Peak employment", p.employees) +
    row("Operator", p.operator) +
    row("State", p.state)],
  [["nrel-hydrothermal-points"], renderGeoHydroPts],
  [["padus-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Protected Land") +
    row("Designation", p.desig) +
    row("Manager", p.mng_agency) +
    row("Manager type", p.mng_type) +
    row("GAP status", p.gap) +
    row("Public access", p.access) +
    row("Acres", p.acres ? Number(p.acres).toLocaleString() : null) +
    row("State", p.state) +
    row("Established", p.yr_est) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em">Filtered highlight of selected features — not the complete USGS PAD-US database</div>`],
  [["tribal-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || "Tribal (Census)") +
    row("Area type", p.area_type) +
    row("Recognition", p.recognized) +
    row("Land acres", p.acres_land ? Number(p.acres_land).toLocaleString() : null) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em;padding-top:4px;">Census administrative boundary. Not intended for consultation or determining historical extent.</div>`],
  [["bia-tribal-fill"], (p: Record<string, unknown>) =>
    title((p.LARNAME as string) || "Tribal (BIA)") +
    row("Agency", p.AGENCY) +
    `<div class="popup-row" style="opacity:0.6;font-size:0.8em;padding-top:4px;">Boundary for illustrative purposes. Does not constitute legal jurisdiction or land title.</div>`],
  [["crithab-fill"], (p: Record<string, unknown>) =>
    title((p.comname as string) || (p.sciname as string) || "Critical Habitat") +
    row("Scientific name", p.sciname) +
    row("Status", p.status) +
    row("Listing", p.listing_st) +
    row("Unit", p.unitname) +
    row("Subunit", p.subunitnam) +
    row("Effective", p.effectdate)],
  [["nerc-fill"], (p: Record<string, unknown>) =>
    title((p.sub_nm as string) || (p.code as string) || "NERC Region") +
    row("Region", p.region) +
    row("Code", p.code) +
    websiteRow(p.website as string)],
  [["ba-fill"], renderBa],
  [["retail-fill"], renderRetail],
  [["wildfire-incidents-circle"], (p: Record<string, unknown>) => {
    const typeCat = p.type_cat as string | null;
    const typeLabel = typeCat === "WF" ? "WF — Wildfire"
      : typeCat === "RX" ? "RX — Prescribed Fire"
      : typeCat === "WFU" ? "WFU — Wildland Fire Use"
      : typeCat || null;
    const acresStr = p.acres != null
      ? Number(p.acres).toLocaleString(undefined, { maximumFractionDigits: 0 })
      : null;
    const fmtDt = (iso: unknown) => {
      if (!iso) return null;
      try {
        return new Date(iso as string).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
      } catch { return iso as string; }
    };
    return title(((p.name as string) || "Unnamed Incident") + " INCIDENT") +
      row("ID", p.fire_id) +
      row("Type", typeLabel) +
      row("State", p.state) +
      row("Acres Burned", acresStr) +
      row("Contained", p.pct_contained != null ? p.pct_contained + "%" : null) +
      row("Discovered", fmtDt(p.discovery_dt)) +
      row("Current as of", fmtDt(p.modified_dt));
  }],
  [["odin-outages-fill"], (p: Record<string, unknown>) => {
    // Numbers come from the feature-state join (merged into p by popup.ts);
    // county NAME/STATE_NAME come from the county_boundaries tile properties.
    // No join value → unlit county → no popup.
    if (p.odin_out == null) return "";
    const county = (p.NAME as string) || "County";
    const heading = p.STATE_NAME ? `${county}, ${p.STATE_NAME}` : county;
    return title(heading) +
      row("Customers affected", typeof p.odin_out === "number" ? Number(p.odin_out).toLocaleString() : p.odin_out) +
      row("Active incidents", p.odin_n) +
      `<div class="popup-row" style="opacity:0.6;font-size:0.8em">Data from ORNL ODIN — utilities self-report; coverage is partial.</div>`;
  }],
  [["smoke-live-fill"], (p: Record<string, unknown>) =>
    title("Smoke Plume") +
    row("Density", p.density as string) +
    row("Satellite", p.satellite) +
    row("Start", p.start_dt) +
    row("End", p.end_dt)],
  [["wildfire-perimeters-fill"], (p: Record<string, unknown>) =>
    title((p.name as string) || (p.country === "CA" ? "Fire Perimeter Estimate (CWFIS)" : "Fire Perimeter")) +
    row("State", p.state) +
    row("Cause", p.cause) +
    row("Discovered", p.discovery_date) +
    row("Contained", p.pct_contained != null ? p.pct_contained + "%" : null) +
    row("Size (acres)", p.gis_acres ? Number(p.gis_acres).toLocaleString(undefined, { maximumFractionDigits: 0 }) : null) +
    row("Hotspots", p.hotspot_count) +
    row("Updated", p.updated_dt) +
    (p.country === "CA" ? row("Note", "Estimated extent from hotspots") : "")],
  [["wildfire-hotspots-circle"], (p: Record<string, unknown>) =>
    title("Fire Hotspot") +
    row("FRP", p.frp ? p.frp + " MW" : null) +
    row("Confidence", p.confidence === "h" ? "High" : p.confidence === "n" ? "Nominal" : p.confidence) +
    row("Satellite", p.satellite) +
    row("Detected", p.acq_date ? p.acq_date + (p.acq_time ? " " + String(p.acq_time).padStart(4, "0").replace(/(..)(..)/, "$1:$2") + " UTC" : "") : null) +
    row("Age", p.age_hours != null ? p.age_hours + " hrs ago" : null)],
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
