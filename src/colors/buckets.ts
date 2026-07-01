import type { ExpressionSpecification } from 'maplibre-gl';
import { FUEL_LEGEND } from './fuel.js';
import type { BucketDef } from '../types.js';

// ─── Categorical fill from buckets ────────────────────────────────────────────
export function bucketColorExpr(field: string, buckets: BucketDef[], defaultColor: string): ExpressionSpecification {
  const expr: unknown[] = ["match", ["get", field]];
  for (const b of buckets) {
    if (!b.values || !b.values.length) continue;
    expr.push(b.values.length === 1 ? b.values[0] : b.values, b.color);
  }
  expr.push(defaultColor);
  return expr as unknown as ExpressionSpecification;
}

// ─── Line / circle geometry helpers ──────────────────────────────────────────
export const LINE_WIDTH = ["interpolate", ["linear"], ["zoom"],
  4, 1.0,
  7, 1.5,
  10, 2.2,
  13, 3.5
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
    5,  kvBucket(1, 2, 3, 4),
    10, kvBucket(2, 4, 6, 8),
    15, kvBucket(3, 6, 9, 12),
  ] as unknown as ExpressionSpecification;
}

// ─── Voltage filter buckets ───────────────────────────────────────────────────
export const KV_BUCKETS = [
  { id: "550+",    urlCode: "H", label: "≥ 550",   color: "#f97316" },
  { id: "500-549", urlCode: "F", label: "500–549", color: "#ef4444" },
  { id: "300-499", urlCode: "G", label: "300–499", color: "#22c55e" },
  { id: "200-299", urlCode: "T", label: "200–299", color: "#3b82f6" },
  { id: "100-199", urlCode: "P", label: "100–199", color: "#ec4899" },
  { id: "<100",    urlCode: "L", label: "< 100",   color: "#eab308" },
  { id: "unknown", urlCode: "U", label: "Unknown", color: "#c4b5fd" },
];

export const OSM_FUEL_BUCKETS = FUEL_LEGEND.map(f => ({ id: f.osmBucket, label: f.label, color: f.color }));
export const EIA_FUEL_BUCKETS = FUEL_LEGEND.map(f => ({ id: f.eiaBucket, label: f.label, color: f.color }));

// ─── PAD-US land management ───────────────────────────────────────────────────
export const PADUS_CLASS_DEFAULT = "#64748b";
export const PADUS_CLASS_BUCKETS = [
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
export const PADUS_CLASS_MAP = Object.fromEntries(
  PADUS_CLASS_BUCKETS.map(b => [b.id, b.values]));

// ─── Tribal lands ─────────────────────────────────────────────────────────────
export const TRIBAL_DEFAULT_COLOR = "#64748b";
export const TRIBAL_BUCKETS = [
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
export const TRIBAL_MAP = Object.fromEntries(TRIBAL_BUCKETS.map(b => [b.id, b.values]));

// ─── Critical Habitat ─────────────────────────────────────────────────────────
export const CRITHAB_BUCKETS = [
  { id: "endangered",          urlCode: "E", label: "Endangered",          color: "#dc2626",
    values: ["Endangered"] },
  { id: "threatened",          urlCode: "T", label: "Threatened",          color: "#f97316",
    values: ["Threatened"] },
  { id: "prop-endangered",     urlCode: "P", label: "Proposed Endangered", color: "#fca5a5",
    values: ["Proposed Endangered"] },
  { id: "prop-threatened",     urlCode: "Q", label: "Proposed Threatened", color: "#fcd34d",
    values: ["Proposed Threatened"] },
];
export const CRITHAB_MAP = Object.fromEntries(CRITHAB_BUCKETS.map(b => [b.id, b.values]));

// ─── Natural gas pipeline types ───────────────────────────────────────────────
export const NATGAS_PIPE_TYPE_BUCKETS = [
  { id: "interstate", urlCode: "I", label: "Interstate",  color: "#f97316" },
  { id: "intrastate", urlCode: "N", label: "Intrastate",  color: "#fbbf24" },
  { id: "hgl",        urlCode: "H", label: "HGL / NGL",   color: "#38bdf8" },
  { id: "gathering",  urlCode: "G", label: "Gathering",   color: "#a78bfa" },
];

export const NATGAS_FAC_TYPE_BUCKETS = [
  { id: "lng_terminal",  urlCode: "L", label: "LNG Terminal",               color: "#06b6d4", icon: "natgas-lng_terminal"  },
  { id: "underground",   urlCode: "U", label: "Underground Storage",         color: "#8b5cf6", icon: "natgas-underground"   },
  { id: "spr",           urlCode: "S", label: "Strategic Petroleum Reserve", color: "#ef4444", icon: "natgas-spr"           },
  { id: "trading_hub",   urlCode: "T", label: "Trading Hub",                 color: "#fbbf24", icon: "natgas-trading_hub"   },
  { id: "processing",    urlCode: "P", label: "Processing Plant",            color: "#f97316", icon: "natgas-processing"    },
  { id: "border_cross",  urlCode: "B", label: "Border Crossing",             color: "#ec4899", icon: "natgas-border_cross"  },
  { id: "peak_shaving",  urlCode: "K", label: "Peak Shaving",                color: "#84cc16", icon: "natgas-peak_shaving"  },
  { id: "lng_storage",   urlCode: "N", label: "Above-Ground LNG",            color: "#0ea5e9", icon: "natgas-lng_storage"   },
  { id: "pol_terminal",  urlCode: "O", label: "Petroleum Terminal",          color: "#94a3b8", icon: "natgas-pol_terminal"  },
];

export const PIPELINE_TYPE_BUCKETS = [
  { id: "pig_launcher", urlCode: "P", label: "Pig launcher",    color: "#64748b", icon: "pipeline-pig_launcher" },
  { id: "compressor",   urlCode: "C", label: "Compressor/Pump", color: "#f97316", icon: "pipeline-compressor"   },
  { id: "delivery",     urlCode: "D", label: "Delivery/Meter",  color: "#3b82f6", icon: "pipeline-delivery"     },
  { id: "interconnect", urlCode: "I", label: "Interconnect",    color: "#06b6d4", icon: "pipeline-interconnect" },
  { id: "end",          urlCode: "E", label: "End point",       color: "#ef4444", icon: "pipeline-end"          },
  { id: "other",        urlCode: "O", label: "Other",           color: "#d1d5db", icon: "pipeline-other"        },
];

// ─── OSM pipeline substance → generator-fuel type ─────────────────────────────
// Only generator fuels survive the data strip (scripts/enrich_osm_tags.py);
// non-fuel pipelines are gone. Buckets group by generator fuel type. "other" is
// the catch-all for untagged pipelines. Keep values in sync with
// _FUEL_SUBSTANCES in scripts/enrich_osm_tags.py.
export const SUBSTANCE_BUCKETS = [
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
export const SUBSTANCE_MAP = Object.fromEntries(
  SUBSTANCE_BUCKETS.filter(b => "values" in b).map(b => [b.id, (b as { values: string[] }).values]));

// Pipeline line color by generator-fuel type. Derived from SUBSTANCE_BUCKETS so
// the palette and the legend never drift. Untagged → "Unknown" grey.
export const PIPELINE_LINE_COLOR = bucketColorExpr("substance", SUBSTANCE_BUCKETS, "#9ca3af");

// ─── NERC regions ─────────────────────────────────────────────────────────────
export const NERC_BUCKETS = [
  { id: "WECC",  urlCode: "W", label: "WECC — Western",        color: "#3b82f6", values: ["WECC"]  },
  { id: "SERC",  urlCode: "S", label: "SERC — Southeast",       color: "#22c55e", values: ["SERC"]  },
  { id: "RFC",   urlCode: "R", label: "RFC — Mid-Atl./Midwest", color: "#f97316", values: ["RFC"]   },
  { id: "NPCC",  urlCode: "N", label: "NPCC — Northeast",       color: "#a855f7", values: ["NPCC"]  },
  { id: "MRO",   urlCode: "M", label: "MRO — Midwest/Plains",   color: "#06b6d4", values: ["MRO"]   },
  { id: "SPP",   urlCode: "P", label: "SPP — S. Plains",        color: "#fbbf24", values: ["SPP"]   },
  { id: "TRE",   urlCode: "T", label: "TRE — Texas (ERCOT)",    color: "#ef4444", values: ["TRE"]   },
  { id: "FRCC",  urlCode: "F", label: "FRCC — Florida",         color: "#ec4899", values: ["FRCC"]  },
];
export const NERC_MAP = Object.fromEntries(NERC_BUCKETS.map(b => [b.id, b.values]));

// ─── Retail service territory types ──────────────────────────────────────────
export const RETAIL_TYPE_BUCKETS = [
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
export const RETAIL_TYPE_MAP = Object.fromEntries(
  RETAIL_TYPE_BUCKETS.filter(b => b.values.length).map(b => [b.id, b.values]));

// ─── OGF planned transmission status ─────────────────────────────────────────
export const OGF_STATUS_BUCKETS = [
  { id: "conceptual",   urlCode: "N", label: "Pre-planning / conceptual", color: "#a5f3fc" },
  { id: "planning",     urlCode: "L", label: "Planning",                  color: "#67e8f9" },
  { id: "engineering",  urlCode: "E", label: "Engineering & routing",     color: "#22d3ee" },
  { id: "permitting",   urlCode: "P", label: "Permitting",                color: "#06b6d4" },
  { id: "construction", urlCode: "C", label: "Construction",              color: "#0891b2" },
  { id: "complete",     urlCode: "D", label: "Complete",                  color: "#155e75" },
  { id: "on_hold",      urlCode: "H", label: "On hold",                   color: "#94a3b8" },
  { id: "terminated",   urlCode: "T", label: "Terminated",                color: "#ef4444" },
  { id: "other",        urlCode: "O", label: "Unknown",                   color: "#d1d5db" },
];
export const OGF_STATUS_MAP = {
  construction: ["Construction"],
  permitting:   ["Permitting"],
  planning:     ["Planning"],
  engineering:  ["Engineering, design, and routing"],
  conceptual:   ["Pre-planning / conceptual"],
  on_hold:      ["On hold"],
  complete:     ["Complete"],
  terminated:   ["Terminated"],
};

// ─── OGF WestTEC study scenario (Portfolio field) ────────────────────────────
// Matches the scenario filter on ourgridfuture.org; only WestTEC projects
// carry these Portfolio values. "other" catches every other portfolio + blank.
export const OGF_SCENARIO_BUCKETS = [
  { id: "base_case",  urlCode: "B", label: "Base Case Planned Projects",    color: "#0891b2" },
  { id: "sra",        urlCode: "R", label: "Reliability Assessment (SRA)",  color: "#7c3aed" },
  { id: "ida",        urlCode: "D", label: "Deliverability Assessment (IDA)", color: "#d97706" },
  { id: "congestion", urlCode: "C", label: "Congestion Assessment",         color: "#dc2626" },
  { id: "other",      urlCode: "O", label: "Other / no scenario",           color: "#94a3b8" },
];
export const OGF_SCENARIO_MAP = {
  base_case:  ["Base Case"],
  sra:        ["SRA"],
  ida:        ["IDA"],
  congestion: ["Congestion"],
};

// ─── OGF planning authority (PlanAuth field) ─────────────────────────────────
// Combo values ("MISO, SPP") are listed under each member so checking either
// authority shows the row.
export const OGF_PLANAUTH_BUCKETS = [
  { id: "westtec", urlCode: "W", label: "WestTEC",          color: "#0891b2" },
  { id: "caiso",   urlCode: "C", label: "CAISO",            color: "#059669" },
  { id: "bpa",     urlCode: "B", label: "Bonneville (BPA)", color: "#65a30d" },
  { id: "ercot",   urlCode: "E", label: "ERCOT",            color: "#d97706" },
  { id: "spp",     urlCode: "S", label: "SPP",              color: "#ca8a04" },
  { id: "miso",    urlCode: "M", label: "MISO",             color: "#7c3aed" },
  { id: "pjm",     urlCode: "P", label: "PJM",              color: "#db2777" },
  { id: "nyiso",   urlCode: "N", label: "NYISO",            color: "#2563eb" },
  { id: "isone",   urlCode: "I", label: "ISO-NE",           color: "#0ea5e9" },
  { id: "merchant",urlCode: "H", label: "Merchant",         color: "#dc2626" },
  { id: "other",   urlCode: "O", label: "Other / none",     color: "#94a3b8" },
];
export const OGF_PLANAUTH_MAP = {
  westtec:  ["WestTEC"],
  caiso:    ["CAISO"],
  bpa:      ["Bonneville Power Administration"],
  ercot:    ["ERCOT"],
  spp:      ["SPP", "MISO, SPP"],
  miso:     ["MISO", "MISO, SPP"],
  pjm:      ["PJM"],
  nyiso:    ["NYISO"],
  isone:    ["ISO-NE", "ISO-NE, Canada Energy Regulator"],
  merchant: ["Merchant"],
};
