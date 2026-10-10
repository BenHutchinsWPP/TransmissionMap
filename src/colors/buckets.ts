import type { ExpressionSpecification } from 'maplibre-gl';
import { FUEL_LEGEND } from './fuel.js';
import type { BucketDef } from '../types.js';

// ─── Categorical fill from buckets ────────────────────────────────────────────
// ["match", ["get", field], ...] over each bucket's `values`. First bucket wins
// a value listed under several (e.g. "MISO, SPP" under both spp and miso for
// filtering) — match branches must be unique.
export function bucketColorExpr(field: string, buckets: BucketDef[], defaultColor: string): ExpressionSpecification {
  const expr: unknown[] = ["match", ["get", field]];
  const seen = new Set<string>();
  for (const b of buckets) {
    const vals = (b.values ?? []).filter(v => !seen.has(v));
    if (!vals.length) continue;
    vals.forEach(v => seen.add(v));
    expr.push(vals.length === 1 ? vals[0] : vals, b.color);
  }
  expr.push(defaultColor);
  return expr as unknown as ExpressionSpecification;
}

// ─── Bucket id → feature values ───────────────────────────────────────────────
// One entry per bucket that declares `values`, in bucket order (an empty array
// included). A bucket with no `values` gets no entry: buildValueFilterExpr's
// "other" catch-all then matches every value no entry lists, null included.
export function bucketValueMap(buckets: BucketDef[]): Record<string, string[]> {
  return Object.fromEntries(buckets.flatMap(b => b.values ? [[b.id, b.values]] : []));
}

// ─── Line / circle geometry helpers ──────────────────────────────────────────
export const LINE_WIDTH = ["interpolate", ["linear"], ["zoom"],
  4, 1.0,
  7, 1.5,
  10, 2.2,
  13, 3.5
];

// ─── Underground transmission line detection ────────────────────────────────
export const OSM_UNDERGROUND_EXPR = ["==", ["coalesce", ["get", "is_undergrnd"], 0], 1] as ExpressionSpecification;
export const HIFLD_UNDERGROUND_EXPR = ["!=", ["index-of", "UNDERGROUND", ["coalesce", ["get", "TYPE"], ""]], -1] as ExpressionSpecification;

// ─── HVDC detection ──────────────────────────────────────────────────────────
// Colour is spoken for (kV) and dashes are spoken for (overhead/underground),
// so DC circuits get two marks that use neither:
//   1. white dashes over the base stroke — the far-out cue, visible from z0
//   2. a repeating "DC" label along the route from z6 — the unambiguous cue
// The stripe carries its own width ramp rather than a fraction of LINE_WIDTH:
// at z3-5 the base line is ~1px, so a 0.4x stripe rounded to a sub-pixel ghost
// and DC was indistinguishable when zoomed out.  This floors it at 0.9px.
export const OSM_DC_EXPR = ["==", ["coalesce", ["get", "is_dc"], 0], 1] as ExpressionSpecification;
export const HIFLD_DC_EXPR = ["==", ["index-of", "DC", ["coalesce", ["get", "TYPE"], ""]], 0] as ExpressionSpecification;
export const DC_STRIPE_COLOR = "#f8fafc";
export const DC_STRIPE_WIDTH = ["interpolate", ["linear"], ["zoom"],
  3, 0.9,
  7, 1.1,
  10, 1.5,
  13, 2.0
] as unknown as ExpressionSpecification;
// Dash lengths are multiples of line-width, so this stays ~even on/off at any zoom.
export const DC_STRIPE_DASH = [2, 1.8];
export const DC_LABEL_MINZOOM = 6;
export const DC_LABEL_COLOR = "#0f172a";
export const DC_LABEL_HALO = "#f8fafc";

export const LINE_PLACEMENT_BUCKETS: BucketDef[] = [
  { id: "overhead",    label: "Overhead",    color: "#a78bfa", urlCode: "o" },
  { id: "underground", label: "Underground", color: "#a78bfa", urlCode: "u" },
];

export function subRadius(kvField: string): ExpressionSpecification {
  const kv = ["to-number", ["get", kvField], -1];
  function kvBucket(lo: number, mid: number, hi: number, vhi: number) {
    return ["case",
      [">=", kv, 400], vhi,
      [">=", kv, 200], hi,
      [">=", kv, 100], mid,
      lo
    ];
  }
  return ["interpolate", ["linear"], ["zoom"],
    2,  kvBucket(1, 1.5, 2, 2.5),
    5,  kvBucket(1.5, 2.5, 3.5, 4.5),
    10, kvBucket(2.5, 4.5, 6.5, 8.5),
    15, kvBucket(3.5, 6.5, 9.5, 12.5),
  ] as unknown as ExpressionSpecification;
}

// ─── Voltage filter buckets ───────────────────────────────────────────────────
export const KV_BUCKETS: BucketDef[] = [
  { id: "550+",    urlCode: "H", label: "≥ 550",   color: "#f97316" },
  { id: "500-549", urlCode: "F", label: "500–549", color: "#ef4444" },
  { id: "300-499", urlCode: "G", label: "300–499", color: "#22c55e" },
  { id: "200-299", urlCode: "T", label: "200–299", color: "#3b82f6" },
  { id: "100-199", urlCode: "P", label: "100–199", color: "#c587a6" },
  { id: "<100",    urlCode: "L", label: "< 100",   color: "#bdab75" },
  { id: "unknown", urlCode: "U", label: "Unknown", color: "#a39dbe" },
];

// Same buckets with display labels ("500–549 kV") for the legend.
export const VOLTAGE_LEGEND = KV_BUCKETS.map(b =>
  b.id === "unknown" ? b : { ...b, label: `${b.label} kV` });

export const OSM_FUEL_BUCKETS = FUEL_LEGEND.map(f => ({ id: f.osmBucket, label: f.label, color: f.color }));
export const EIA_FUEL_BUCKETS = FUEL_LEGEND.map(f => ({ id: f.eiaBucket, label: f.label, color: f.color }));

// ─── PAD-US land management ───────────────────────────────────────────────────
export const PADUS_CLASS_DEFAULT = "#64748b";
export const PADUS_CLASS_BUCKETS: BucketDef[] = [
  { id: "blm",     urlCode: "B", label: "BLM Public Lands",        color: "#ca8a04",
    values: ["National Public Lands"] },
  { id: "forest",  urlCode: "F", label: "National Forest",         color: "#15803d",
    values: ["National Forest", "National Grassland"] },
  { id: "refuge",  urlCode: "R", label: "Wildlife Refuge",         color: "#0891b2",
    values: ["National Wildlife Refuge"] },
  { id: "park",    urlCode: "P", label: "Ntl Park / Monument",     color: "#b45309",
    values: ["National Park", "National Monument", "National Recreation Area",
             "National Lakeshore or Seashore", "National Scenic or Historic Trail",
             "National Scenic, Botanical or Volcanic Area"] },
  { id: "wild",    urlCode: "W", label: "Wilderness / Wild River", color: "#7c3aed",
    values: ["State Wilderness", "Wild and Scenic River"] },
  { id: "conserv", urlCode: "C", label: "Conservation Area",       color: "#84cc16",
    values: ["Conservation Area", "Resource Management Area",
             "Recreation Management Area", "Watershed Protection Area",
             "Research or Educational Area", "Special Designation Area"] },
  { id: "state",   urlCode: "S", label: "State lands",             color: "#ea580c",
    values: ["State Resource Management Area", "State Conservation Area",
             "State Park", "State Recreation Area", "State Other or Unknown",
             "State Historic or Cultural Area"] },
  { id: "local",   urlCode: "L", label: "Local lands",             color: "#eab308",
    values: ["Local Conservation Area", "Local Other or Unknown",
             "Local Resource Management Area", "Local Park",
             "Local Recreation Area", "Local Historic or Cultural Area"] },
  { id: "private", urlCode: "V", label: "Private / NGO",           color: "#db2777",
    values: ["Private Conservation", "Private Other or Unknown",
             "Private Recreation or Education", "Private Ranch", "Private Park",
             "Private Forest Stewardship", "Private Historic or Cultural",
             "Private Agricultural", "Conservation Easement",
             "Forest Stewardship Easement", "Mitigation Land or Bank"] },
  { id: "military", urlCode: "M", label: "Military",               color: "#dc2626",
    values: ["Military Land"] },
  { id: "other",   urlCode: "O", label: "Other / unknown",         color: PADUS_CLASS_DEFAULT,
    values: [] },
];

// ─── Tribal lands ─────────────────────────────────────────────────────────────
export const TRIBAL_DEFAULT_COLOR = "#64748b";
export const TRIBAL_BUCKETS: BucketDef[] = [
  { id: "reservation", urlCode: "R", label: "Reservation / Trust Land",   color: "#7c3aed",
    values: ["American Indian Reservation", "Off-Reservation Trust Land",
             "Reservation / Off-Reservation Trust Land"] },
  { id: "hawaiian",    urlCode: "H", label: "Hawaiian Home Land",         color: "#0891b2",
    values: ["Hawaiian Home Land"] },
  { id: "anvsa",       urlCode: "A", label: "Alaska Native Village (ANVSA)", color: "#2563eb",
    values: ["Alaska Native Village Statistical Area"] },
  { id: "otsa",        urlCode: "O", label: "Oklahoma Tribal (OTSA)",     color: "#ea580c",
    values: ["Oklahoma Tribal Statistical Area"] },
  { id: "sdtsa",       urlCode: "S", label: "State-Designated (SDTSA)",   color: "#db2777",
    values: ["State-Designated Tribal Statistical Area"] },
  { id: "tdsa",        urlCode: "T", label: "Tribal-Designated (TDSA)",   color: "#ca8a04",
    values: ["Tribal-Designated Statistical Area"] },
  { id: "statereserv", urlCode: "J", label: "State Reservation",          color: "#65a30d",
    values: ["State American Indian Reservation"] },
];

// ─── Critical Habitat ─────────────────────────────────────────────────────────
export const CRITHAB_BUCKETS: BucketDef[] = [
  { id: "endangered",          urlCode: "E", label: "Endangered",          color: "#dc2626",
    values: ["Endangered"] },
  { id: "threatened",          urlCode: "T", label: "Threatened",          color: "#f97316",
    values: ["Threatened"] },
  { id: "prop-endangered",     urlCode: "P", label: "Proposed Endangered", color: "#fca5a5",
    values: ["Proposed Endangered"] },
  { id: "prop-threatened",     urlCode: "Q", label: "Proposed Threatened", color: "#fcd34d",
    values: ["Proposed Threatened"] },
];

// ─── Natural gas pipeline types ───────────────────────────────────────────────
export const NATGAS_PIPE_TYPE_BUCKETS: BucketDef[] = [
  { id: "interstate", urlCode: "I", label: "Interstate",  color: "#f97316", values: ["Interstate"] },
  { id: "intrastate", urlCode: "N", label: "Intrastate",  color: "#fbbf24", values: ["Intrastate"] },
  { id: "hgl",        urlCode: "H", label: "HGL / NGL",   color: "#38bdf8", values: ["HGL"] },
  { id: "gathering",  urlCode: "G", label: "Gathering",   color: "#a78bfa", values: ["Gathering"] },
];

export const NATGAS_FAC_TYPE_BUCKETS: BucketDef[] = [
  { id: "lng_terminal",  urlCode: "L", label: "LNG Terminal",               color: "#06b6d4", icon: "natgas-lng_terminal", values: ["lng_terminal"] },
  { id: "underground",   urlCode: "U", label: "Underground Storage",         color: "#8b5cf6", icon: "natgas-underground", values: ["underground"] },
  { id: "spr",           urlCode: "S", label: "Strategic Petroleum Reserve", color: "#ef4444", icon: "natgas-spr", values: ["spr"] },
  { id: "trading_hub",   urlCode: "T", label: "Trading Hub",                 color: "#fbbf24", icon: "natgas-trading_hub", values: ["trading_hub"] },
  { id: "processing",    urlCode: "P", label: "Processing Plant",            color: "#f97316", icon: "natgas-processing", values: ["processing"] },
  { id: "border_cross",  urlCode: "B", label: "Border Crossing",             color: "#ec4899", icon: "natgas-border_cross", values: ["border_cross"] },
  { id: "peak_shaving",  urlCode: "K", label: "Peak Shaving",                color: "#84cc16", icon: "natgas-peak_shaving", values: ["peak_shaving"] },
  { id: "lng_storage",   urlCode: "N", label: "Above-Ground LNG",            color: "#0ea5e9", icon: "natgas-lng_storage", values: ["lng_storage"] },
  { id: "pol_terminal",  urlCode: "O", label: "Petroleum Terminal",          color: "#94a3b8", icon: "natgas-pol_terminal", values: ["pol_terminal"] },
];

export const PIPELINE_TYPE_BUCKETS: BucketDef[] = [
  { id: "pig_launcher", urlCode: "P", label: "Pig launcher",    color: "#64748b", icon: "pipeline-pig_launcher",
    values: ["pig_launcher"] },
  { id: "compressor",   urlCode: "C", label: "Compressor/Pump", color: "#f97316", icon: "pipeline-compressor",
    values: ["substation", "pump_station"] },
  { id: "delivery",     urlCode: "D", label: "Delivery/Meter",  color: "#3b82f6", icon: "pipeline-delivery",
    values: ["delivery", "receipt", "reciept", "measurement", "meter"] },
  { id: "interconnect", urlCode: "I", label: "Interconnect",    color: "#06b6d4", icon: "pipeline-interconnect",
    values: ["interconnect"] },
  { id: "end",          urlCode: "E", label: "End point",       color: "#ef4444", icon: "pipeline-end",
    values: ["end"] },
  { id: "other",        urlCode: "O", label: "Other",           color: "#d1d5db", icon: "pipeline-other" },
];

// ─── OSM pipeline substance → generator-fuel type ─────────────────────────────
// Only generator fuels survive the data strip (scripts/enrich_osm_tags.py);
// non-fuel pipelines are gone. Buckets group by generator fuel type. "other" is
// the catch-all for untagged pipelines. Keep values in sync with
// _FUEL_SUBSTANCES in scripts/enrich_osm_tags.py.
export const SUBSTANCE_BUCKETS: BucketDef[] = [
  { id: "gas",      urlCode: "g", label: "Natural gas",     color: "#f97316",
    values: ["gas", "natural_gas", "cng", "methane", "lng", "LNG",
             "landfill_gas", "coke_gas", "syngas", "fcc_gas"] },
  { id: "oil",      urlCode: "o", label: "Crude oil",        color: "#7c2d12",
    values: ["oil", "crude_oil", "petroleum", "condensate"] },
  { id: "products", urlCode: "p", label: "Products / NGL",   color: "#ca8a04",
    values: ["fuel", "ngl", "lpg", "propane", "butane", "isobutane", "n-butane",
             "liquid_butane", "pentane", "isopentane", "y-grade", "ethane",
             "naphtha", "gasoline", "diesel", "jet_fuel", "kerosene", "hvl",
             "natural_gasoline", "gasoil"] },
  { id: "hydrogen", urlCode: "h", label: "Hydrogen",         color: "#22d3ee",
    values: ["hydrogen", "liquid_hydrogen"] },
  { id: "coal",     urlCode: "c", label: "Coal",             color: "#334155",
    values: ["coal"] },
  { id: "other",    urlCode: "u", label: "Unknown",          color: "#9ca3af" },
];

// Pipeline line color by generator-fuel type. Derived from SUBSTANCE_BUCKETS so
// the palette and the legend never drift. Untagged → "Unknown" grey.
export const PIPELINE_LINE_COLOR = bucketColorExpr("substance", SUBSTANCE_BUCKETS, "#9ca3af");

// ─── EIA generator sector (Form 860 "Sector Name") ────────────────────────────
// Filter-only chips (legend renders swatch: "none"); colors are unused but the
// BucketDef type requires them. CHP and non-CHP variants collapse into one
// chip per ownership sector via each bucket's `values`.
export const SECTOR_BUCKETS: BucketDef[] = [
  { id: "utility",    label: "Electric Utility", color: "#9ca3af", urlCode: "u",
    values: ["Electric Utility"] },
  { id: "ipp",        label: "IPP",              color: "#9ca3af", urlCode: "i",
    values: ["IPP Non-CHP", "IPP CHP"] },
  { id: "commercial", label: "Commercial",       color: "#9ca3af", urlCode: "c",
    values: ["Commercial Non-CHP", "Commercial CHP"] },
  { id: "industrial", label: "Industrial",       color: "#9ca3af", urlCode: "n",
    values: ["Industrial Non-CHP", "Industrial CHP"] },
];

// ─── NERC regions ─────────────────────────────────────────────────────────────
export const NERC_BUCKETS: BucketDef[] = [
  { id: "WECC",  urlCode: "W", label: "WECC — Western",        color: "#3b82f6", values: ["WECC"]  },
  { id: "SERC",  urlCode: "S", label: "SERC — Southeast",       color: "#22c55e", values: ["SERC"]  },
  { id: "RFC",   urlCode: "R", label: "RFC — Mid-Atl./Midwest", color: "#f97316", values: ["RFC"]   },
  { id: "NPCC",  urlCode: "N", label: "NPCC — Northeast",       color: "#a855f7", values: ["NPCC"]  },
  { id: "MRO",   urlCode: "M", label: "MRO — Midwest/Plains",   color: "#06b6d4", values: ["MRO"]   },
  { id: "SPP",   urlCode: "P", label: "SPP — S. Plains",        color: "#fbbf24", values: ["SPP"]   },
  { id: "TRE",   urlCode: "T", label: "TRE — Texas (ERCOT)",    color: "#ef4444", values: ["TRE"]   },
  { id: "FRCC",  urlCode: "F", label: "FRCC — Florida",         color: "#ec4899", values: ["FRCC"]  },
];

// ─── NWS active weather alert groups ─────────────────────────────────────────
// Paints the alerts (NWS_GROUP_COLOR in assets/layers/map-layers-conditions.ts,
// derived from these buckets) and drives the legend filter chips over the same
// `_group` field.
export const NWS_GROUP_BUCKETS: BucketDef[] = [
  { id: "convective", label: "Convective",     color: "#a855f7", urlCode: "c", values: ["convective"] },
  { id: "flood",       label: "Flood",          color: "#22c55e", urlCode: "l", values: ["flood"] },
  { id: "fire",        label: "Fire weather",   color: "#ef4444", urlCode: "f", values: ["fire"] },
  { id: "heat",        label: "Heat",           color: "#f97316", urlCode: "h", values: ["heat"] },
  { id: "wind",        label: "Wind/Dust",      color: "#eab308", urlCode: "w", values: ["wind"] },
  { id: "winter",      label: "Winter",         color: "#38bdf8", urlCode: "i", values: ["winter"] },
  { id: "tropical",    label: "Tropical",       color: "#14b8a6", urlCode: "t", values: ["tropical"] },
  { id: "other",       label: "Other",          color: "#9ca3af", urlCode: "o" },
];

// ─── Retail service territory types ──────────────────────────────────────────
export const RETAIL_TYPE_BUCKETS: BucketDef[] = [
  { id: "iou",     urlCode: "I", label: "Investor Owned",    color: "#3b82f6",
    values: ["INVESTOR OWNED"] },
  { id: "coop",    urlCode: "C", label: "Cooperative",        color: "#22c55e",
    values: ["COOPERATIVE"] },
  { id: "muni",    urlCode: "M", label: "Municipal",          color: "#f97316",
    values: ["MUNICIPAL", "MUNICIPAL MKTG AUTHORITY"] },
  { id: "public",  urlCode: "P", label: "Public / Gov't",     color: "#a855f7",
    values: ["STATE", "FEDERAL", "POLITICAL SUBDIVISION"] },
  { id: "other",   urlCode: "O", label: "Other / Unknown",    color: "#94a3b8",
    values: [] },
];

// ─── OGF planned transmission status ─────────────────────────────────────────
// Lifecycle hue ramp: cool = early, warm = late, green = in service. The layer
// reads as "planned" via its white casing, so hue is free to encode status
// (mirrors ourgridfuture.org's own status palette semantics).
export const OGF_STATUS_BUCKETS: BucketDef[] = [
  // "Planning" and "Pre-planning / conceptual" are the source labels before
  // extract_ogf.py merged them; matched too so either build of the data draws.
  { id: "planning",     urlCode: "L", label: "Conceptual / planning",     color: "#60a5fa",
    values: ["Conceptual / planning", "Planning", "Pre-planning / conceptual"] },
  { id: "engineering",  urlCode: "E", label: "Engineering & routing",     color: "#22d3ee",
    values: ["Engineering, design, and routing"] },
  { id: "permitting",   urlCode: "P", label: "Permitting",                color: "#eab308",
    values: ["Permitting"] },
  { id: "construction", urlCode: "C", label: "Construction",              color: "#f97316",
    values: ["Construction"] },
  { id: "complete",     urlCode: "D", label: "Complete",                  color: "#16a34a",
    values: ["Complete"] },
  { id: "on_hold",      urlCode: "H", label: "On hold",                   color: "#94a3b8",
    values: ["On hold"] },
  { id: "terminated",   urlCode: "T", label: "Terminated",                color: "#ef4444",
    values: ["Terminated"] },
  { id: "other",        urlCode: "O", label: "Unknown",                   color: "#d1d5db" },
];

// ─── OGF region (derived Region field) ──────────────────────────────────────
// extract_ogf.py sets Region = "WECC" for Western lines (by the WECC boundary,
// since ISO_RTO records market membership); elsewhere it carries ISO_RTO.
// Combo values ("MISO, SPP") are listed under each member so checking either
// region shows the row; the first bucket listed wins the colour.
export const OGF_REGION_BUCKETS: BucketDef[] = [
  { id: "wecc",      urlCode: "W", label: "WECC (West)",         color: "#c026d3",
    values: ["WECC"] },
  { id: "ercot",     urlCode: "E", label: "ERCOT",               color: "#ea580c",
    values: ["ERCOT", "ERCOT, MISO", "ERCOT, SPP", "SPP, ERCOT", "MISO, ERCOT", "MISO, SPP, ERCOT"] },
  { id: "spp",       urlCode: "S", label: "SPP",                 color: "#ca8a04",
    values: ["SPP", "MISO, SPP", "SPP, MISO", "ERCOT, SPP", "SPP, ERCOT", "MISO, SPP, ERCOT"] },
  { id: "miso",      urlCode: "M", label: "MISO",                color: "#7c3aed",
    values: ["MISO", "MISO, SPP", "SPP, MISO", "MISO, PJM", "PJM, MISO", "ERCOT, MISO", "MISO, ERCOT", "MISO, SPP, ERCOT"] },
  { id: "pjm",       urlCode: "P", label: "PJM",                 color: "#0d9488",
    values: ["PJM", "MISO, PJM", "PJM, MISO", "NYISO, PJM"] },
  { id: "nyiso",     urlCode: "N", label: "NYISO",               color: "#2563eb",
    values: ["NYISO", "NYISO, PJM"] },
  { id: "isone",     urlCode: "I", label: "ISO-NE",              color: "#0ea5e9",
    values: ["ISO-NE"] },
  { id: "southeast", urlCode: "U", label: "Southeast (non-RTO)", color: "#65a30d",
    values: ["None (Southeast)"] },
  { id: "other",     urlCode: "O", label: "Other / none",        color: "#94a3b8" },
];

// ─── OGF type of work (derived Work field) ──────────────────────────────────
// Solid = a new circuit; dashed = rebuild / reconductor / upgrade of an
// existing line. Applies in every color-by mode.
export const OGF_WORK_BUCKETS: BucketDef[] = [
  { id: "new",      urlCode: "N", label: "New line",                                 color: "#64748b",
    values: ["new"] },
  { id: "existing", urlCode: "E", label: "Existing line (rebuild, reconductor, upgrade)", color: "#64748b",
    values: ["existing"] },
];
export const OGF_DASH_EXPR = [
  "match", ["get", "Work"], "existing", ["literal", [2, 1.5]], ["literal", [1, 0]],
] as unknown as ExpressionSpecification;

// ─── WestTEC 10-Year Plan ────────────────────────────────────────────────────
// Also the westtec-10yr colour-by (facets.ts westtecColorExpr). Every feature
// has a real value for both fields — no "other"/catch-all bucket.
export const WESTTEC_SCENARIO_BUCKETS: BucketDef[] = [
  { id: "base_case",  urlCode: "B", label: "Planned Projects",        color: "#1e40af", values: ["Base Case"] },
  { id: "sra",        urlCode: "R", label: "Reliability-Driven (SRA)", color: "#4ade80", values: ["SRA"] },
  { id: "ida",        urlCode: "D", label: "Deliverability (IDA)",     color: "#38bdf8", values: ["IDA"] },
  { id: "congestion", urlCode: "C", label: "Congestion",               color: "#dc2626", values: ["Congestion"] },
];

export const WESTTEC_DATASET_BUCKETS: BucketDef[] = [
  { id: "planned",    urlCode: "P", label: "Planned Projects",    color: "#2563eb", values: ["planned"] },
  { id: "identified", urlCode: "I", label: "Identified Upgrades", color: "#16a34a", values: ["identified"] },
];

// ─── FEMA National Risk Index rating classes ──────────────────────────────────
// Codes match scripts/extract_fema_nri.py: 1–5 = FEMA's five ratings, 6 =
// "Insufficient Data" (drawn grey — the hazard occurs but was not scored).
// Code 0 ("Not Applicable" / "No Rating") has no entry: the county is left
// unpainted. ColorBrewer PuRd, kept distinct from the ODIN outage YlOrRd.
export const NRI_RATINGS: { code: number; label: string; labelKey: string; color: string }[] = [
  { code: 1, label: "Very Low",            labelKey: "legend.classVeryLow",     color: "#f1eef6" },
  { code: 2, label: "Relatively Low",      labelKey: "legend.relLow",           color: "#d7b5d8" },
  { code: 3, label: "Relatively Moderate", labelKey: "legend.relModerate",      color: "#df65b0" },
  { code: 4, label: "Relatively High",     labelKey: "legend.relHigh",          color: "#dd1c77" },
  { code: 5, label: "Very High",           labelKey: "legend.classVeryHigh",    color: "#980043" },
  { code: 6, label: "Insufficient Data",   labelKey: "legend.insufficientData", color: "#9ca3af" },
];

// Data center moratorium classes — the `cls` property baked by the
// moratorium build (strongest measure in a jurisdiction wins, in this order).
// They are also the legend's filter chips (LEGEND_FILTERS key "dcm").
export const DCM_CLASSES: BucketDef[] = [
  { id: "ban",     urlCode: "B", label: "Permanent ban",              color: "#7f1d1d" },
  { id: "active",  urlCode: "A", label: "Moratorium in effect",       color: "#dc2626" },
  { id: "pending", urlCode: "P", label: "Proposed",                   color: "#f59e0b" },
  { id: "ended",   urlCode: "E", label: "Expired, lifted or replaced", color: "#9ca3af" },
];
