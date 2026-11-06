// Route-optimizer presets — every routing/costing method as data.
// Role: pure data. A preset is the whole method: line types (base $/mi, dollar year,
//       terminal rule), cost-surface rows (band + match → routing weight and cost
//       multiplier, optionally one cost multiplier per regional set, optionally
//       exempted on cells another band marks — `except`), group-combine
//       rules (max / min / multiply), region barrier, regional cost sets, mitigation,
//       markups, contingency, ROW land, escalation, uncertainty band, length rules and
//       report notes. The engine (assets/route/cost.ts) has no per-preset branch; a new
//       method is a new entry.
//       Band names and code tables mirror scripts/route_grid.py (PD bands by name;
//       the OSM file's bands as `osm_flags` / `osm_maxkv` / `adj`). `upl_<hash>` bands are not cube
//       bands: an uploaded layer's cells (1 in, 0 out), rows added by a patch's `add_rows`
//       (assets/route/preset-patch.ts), never by a preset here. 0 is nodata in every
//       band. Code tables that grid.json carries (isoreg code → ISO name, landval
//       decode) are never repeated here: `regions.sets` is keyed by ISO name.
//       Every number carries a `src`. Source keys: "PNAS S5/S6/S7" = Wu et al. 2023
//       SI Tables S5–S7; "B&V 2014" = Black & Veatch, Capital Costs for Transmission
//       and Substations (WECC TEPPC, 2014); "SWCA 2013 T6" = SWCA Environmental
//       Mitigation Costs Study for WECC, Table 6; "MISO MTEP25" = MISO Transmission
//       Cost Estimation Guide for MTEP25; "reVX" = NREL reVX least_cost_xmission config
//       @ efb1977 (BSD-3); "S17" = PNAS SI Table S17; "ours" = this project's choice.
// Deps: none. No side effects.

/** An uploaded layer's band (`upl_` + its 16-hex hash); not a cube band. */
export type UploadBand = `upl_${string}`;
export const isUploadBand = (name: string): name is UploadBand => /^upl_[0-9a-f]{16}$/.test(name);
export type BandName =
  | 'landcover' | 'slope' | 'protect' | 'agency' | 'wildfire' | 'whpclass' | 'flags' | 'state'
  | 'desig' | 'flags2' | 'isoreg' | 'landval' | 'bldg' | 'wetland' | 'built' | 'nonres' | 'bldgunk'
  | 'aviation' | 'nfhl'
  | 'osm_flags' | 'osm_maxkv' | 'adj'
  | UploadBand;

/** Which band values a row applies to. Value 0 (nodata) never matches. */
export type Match =
  | { codes: number[] }                                          // value ∈ codes
  | { range: [lo: number, hi: number] }                          // lo ≤ value ≤ hi
  | { bit: number }                                              // value has this bit set
  | { field: { shift: number; mask: number }; codes: number[] }; // (value >> shift) & mask ∈ codes

/** A constant factor, or a linear ramp over a `range` match: `from` at lo → `to` at hi. */
export type Factor = number | { ramp: [from: number, to: number] };

/** A routing weight at or above this is an exclusion in the Method tab (the Excl. tick sets it). */
export const EXCLUDED_W = 1000;

/** The one short reference the Method grid shows for a row: the study its value comes from, or WPP when
 *  the value is our own choice. docs/routing.md § *Weights* sets each beside the others;
 *  `src` keeps the full trail (pages, tables, files) and shows on hover. */
export const ROW_REFS = ['B&V 2014', 'Wu 2023', 'NREL reVX', 'EPRI-GTC 2006', 'EPRI-KY 2024', 'BLM 2025 RODs', 'WPP', 'WestTEC ES'] as const;
export type RowRef = typeof ROW_REFS[number];
const [BV_REF, WU_REF, REVX_REF, GTC_REF, KY_REF, BLM_REF, WPP_REF, ES_REF] = ROW_REFS;

export interface CostRow {
  band: BandName;
  match: Match;
  route_w: Factor;          // routing weight (preference); 1 = neutral
  cost_x: Factor;           // construction-cost multiplier; 1 = neutral. With `cost_by_region`
                            // it is one scalar multiplied onto every set's value (an edit scales all)
  cost_by_region?: Record<string, number>; // regional set name → cost multiplier (costs only, never routing)
  group?: string;           // rows sharing a group combine by the preset's `combine` rule
  line_types?: string[];    // row applies only to these line types
  barrier?: 'hard';         // matching cells are impassable
  excludable?: { link?: string; off_w?: number; off_src?: string }; // Method tab "Excl." tick: on = route_w EXCLUDED_W; off_w/off_src (required iff route_w ≥ EXCLUDED_W) = what unticking sets; rows sharing a link tick together
  except?: RowExcept[];     // cells where an active entry matches are treated as if the row did not match them
  note?: string;
  ref?: RowRef;             // the Method grid's short reference (ROW_REFS)
  src: string;
}

/** An exemption from a row: on cells where `match` holds the row does not apply (for an
 *  ungrouped row: route_w and cost_x are 1 there; a hard barrier stays). `active: false`
 *  ships the entry switched off; a Method-tab patch toggles it (preset-patch.ts). */
export interface RowExcept {
  band: BandName;
  match: Match;
  label: string;            // short human label for a settings checkbox
  active?: boolean;         // default true
  ref?: RowRef;
  src: string;
}

export interface Money { usd: number; year: number; src: string }

export interface TerminalRule {
  usd_each: number | null;  // per station, in `year` dollars; null = no sourced value
  year: number;
  min: number;              // stations at minimum (both ends)
  every_mi?: number;        // +1 station per `every_mi` beyond `after_mi`
  after_mi?: number;
  report_only?: boolean;    // the count rule is unsourced: report, never gate
  arithmetic?: string;
  src: string;
}

export interface LineType {
  label: string;
  kv: { value: number; src: string };      // nominal voltage class, kV (HVDC: its pole voltage class)
  base_per_mi: Money;
  terminals: TerminalRule;
}

export interface MitigationClass {
  class: 1 | 2 | 3;
  any: { band: BandName; match: Match }[];
  src: string;
}

export interface Mitigation {
  classes: MitigationClass[];               // a cell takes the highest class it matches
  pct: { ca: [number, number, number]; other: [number, number, number] }; // class 1, 2, 3
  ca: { band: BandName; codes: number[] };
  range: string;
  src: string;
}

/** How a group's rows combine in a cell. A cell matching no row of a group gets 1. */
export type Combine = 'max' | 'min' | 'multiply';

/** Regional cost sets: the band's value → ISO name (grid.json) → set name; unknown or 0 → `default`. */
export interface Regions {
  band: BandName;
  sets: Record<string, string>;  // ISO name (grid.json isoreg table) → set name used in `cost_by_region`
  default: string;
  src: string;
}

/** Length rule on line $ by routed length: the first tier that holds applies, else × 1. */
export type LengthTier = { lt_mi: number; x: number } | { le_mi: number; x: number };

/** ROW land $: width × length × county land value; decode constants come from grid.json. */
export interface RowLand {
  band: BandName;                       // county land value code (landval)
  year: number;                         // dollar year of the land values
  width_ft: Record<string, number>;     // per line type
  width_src: string;
  developed: { band: BandName; match: Match };
  developed_x: number;                  // multiplier on developed cells
  developed_src: string;
  federal: 'as-private';                // federal land priced like private land (assumption)
  tribal: 0;                            // tribal cells (preset.tribal) carry no ROW $
  note: string;                         // shown with every ROW land line item
  src: string;
}

export interface RoutePreset {
  id: string;
  label: string;
  attribution: string;
  caveat: string;
  dollar_year: number;
  escalation: { rate: number; to_year: number; src: string; cross_check?: string };
  line_types: Record<string, LineType>;
  rows: CostRow[];
  combine: Record<string, Combine>;         // group → rule; ungrouped rows and groups multiply
  region: { band: BandName; barrier_codes?: number[]; allowed_codes?: number[]; src: string };
  regions?: Regions;
  mitigation?: Mitigation;
  markups: { label: string; x: number; src: string }[];
  contingency?: { pct: number; label: string; src: string }; // own line item on the whole subtotal
  row_land?: RowLand;
  uncertainty: { low: number; high: number; label: string; src: string };
  length: 'routed' | { straight_line_factor: number; src: string };
  length_factor?: { tiers: LengthTier[]; src: string };
  tribal: { band: BandName; match: Match; note: string; src: string };
  notes: string[];
}

// ─── shared values ────────────────────────────────────────────────────────────

const ESCALATION = {
  rate: 0.04, to_year: 2025,
  src: 'MISO MTEP25 p.1; MISO MTEP26 PSC slides 2026-03-11, slide 4 (4 %/yr)',
  cross_check: 'BLS WPU117 implies ≈ ×1.23 for 2018→2025 (~3.0 %/yr); the spread sits inside the rough-early-estimate band',
};

const CLASS5 = {
  low: -0.30, high: 0.50, label: 'Rough early estimate (−30 % / +50 %)',
  src: 'AACE Class 5 −30 %/+50 %; MISO MTEP25 p.6 (exploratory = Class 5); range as quoted from AACE 18R-97 in the West Contra Costa TAC study (2011); −30/+50 = ours',
};

const BV = 'B&V 2014 (WECC TEPPC) §2 base cost per mile, ACSR, >10 mi';

const LOWER_KV_NOTE =
  'our derivation (B&V 2014 has no entry below 230 kV); MISO MTEP26 Transmission Cost Estimation Workbook, Cost Guide Tables, Illinois; docs/routing.md § Lower-voltage line types';

const BV_LINES: Record<string, LineType> = {
  ac500: {
    label: '500 kV AC double circuit',
    kv: { value: 500, src: 'nominal voltage class of this line type (500 kV AC double circuit)' },
    base_per_mi: { usd: 3_071_750, year: 2014, src: BV },
    terminals: {
      usd_each: 87.9e6, year: 2018, min: 2, every_mi: 400, after_mi: 400,
      src: 'PNAS S6 (500 kV HVAC substation $87.9M 2018$, ≥ 2, +1 per 400 mi beyond 400); count = 2 + floor(max(0, L − 400)/400), our reading of PNAS SI Table S6',
    },
  },
  ac345: {
    label: '345 kV AC double circuit',
    kv: { value: 345, src: 'nominal voltage class of this line type (345 kV AC double circuit)' },
    base_per_mi: { usd: 2_150_300, year: 2014, src: BV },
    terminals: {
      usd_each: 22_286_886, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6: 345 kV substation base $2,132,700 + 6 positions × 1.5 (breaker-and-a-half) × $2,239,354 per position = $22,286,886',
      src: 'B&V 2014 p.4-7 T4-6 (base, per-position cost, BAAH 1.5); 6 positions and count 2 (one per end) = ours',
    },
  },
  ac230: {
    label: '230 kV AC double circuit',
    kv: { value: 230, src: 'nominal voltage class of this line type (230 kV AC double circuit)' },
    base_per_mi: { usd: 1_536_400, year: 2014, src: BV },
    terminals: {
      usd_each: 15_142_377, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6: 230 kV substation base $1,706,250 + 6 positions × 1.5 × $1,492,903 per position = $15,142,377',
      src: 'B&V 2014 p.4-7 T4-6; 6 positions and count 2 = ours',
    },
  },
  ac161: {
    label: '161 kV AC double circuit',
    kv: { value: 161, src: 'nominal voltage class of this line type (161 kV AC double circuit)' },
    base_per_mi: {
      usd: 1_322_800, year: 2014,
      src: `B&V 2014 230 kV double circuit $1,536,400 × MISO MTEP26 ratio 0.861 (161/230 kV double circuit, Table 4.1-2, ROW land and the 30 % contingency + 7.5 % AFUDC removed); ${LOWER_KV_NOTE}`,
    },
    terminals: {
      usd_each: 13_376_000, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6 230 kV substation $15,142,377 × 0.883 = $13,376,000; 0.883 = MISO MTEP26 Table 4.2-2, 6 positions breaker-and-a-half, 161 kV $ 21.268 M / 230 kV $24.075 M',
      src: 'B&V 2014 p.4-7 T4-6 scaled by MISO MTEP26 Table 4.2-2 ratio 0.883; 6 positions and count 2 = ours; our derivation',
    },
  },
  ac138: {
    label: '138 kV AC double circuit',
    kv: { value: 138, src: 'nominal voltage class of this line type (138 kV AC double circuit)' },
    base_per_mi: {
      usd: 1_296_600, year: 2014,
      src: `B&V 2014 230 kV double circuit $1,536,400 × MISO MTEP26 ratio 0.844 (138/230 kV double circuit, Table 4.1-2, ROW land and the 30 % contingency + 7.5 % AFUDC removed); ${LOWER_KV_NOTE}`,
    },
    terminals: {
      usd_each: 12_447_000, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6 230 kV substation $15,142,377 × 0.822 = $12,447,000; 0.822 = MISO MTEP26 Table 4.2-2, 6 positions breaker-and-a-half, 138 kV $ 19.789 M / 230 kV $24.075 M',
      src: 'B&V 2014 p.4-7 T4-6 scaled by MISO MTEP26 Table 4.2-2 ratio 0.822; 6 positions and count 2 = ours; our derivation',
    },
  },
  ac115: {
    label: '115 kV AC double circuit',
    kv: { value: 115, src: 'nominal voltage class of this line type (115 kV AC double circuit)' },
    base_per_mi: {
      usd: 1_226_000, year: 2014,
      src: `B&V 2014 230 kV double circuit $1,536,400 × MISO MTEP26 ratio 0.798 (115/230 kV double circuit, Table 4.1-2, ROW land and the 30 % contingency + 7.5 % AFUDC removed); ${LOWER_KV_NOTE}`,
    },
    terminals: {
      usd_each: 11_541_000, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6 230 kV substation $15,142,377 × 0.762 = $11,541,000; 0.762 = MISO MTEP26 Table 4.2-2, 6 positions breaker-and-a-half, 115 kV $ 18.350 M / 230 kV $24.075 M',
      src: 'B&V 2014 p.4-7 T4-6 scaled by MISO MTEP26 Table 4.2-2 ratio 0.762; 6 positions and count 2 = ours; our derivation',
    },
  },
  ac69: {
    label: '69 kV AC double circuit',
    kv: { value: 69, src: 'nominal voltage class of this line type (69 kV AC double circuit)' },
    base_per_mi: {
      usd: 1_086_200, year: 2014,
      src: `B&V 2014 230 kV double circuit $1,536,400 × MISO MTEP26 ratio 0.707 (69/230 kV double circuit, Table 4.1-2, ROW land and the 30 % contingency + 7.5 % AFUDC removed); ${LOWER_KV_NOTE}`,
    },
    terminals: {
      usd_each: 10_551_000, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6 230 kV substation $15,142,377 × 0.697 = $10,551,000; 0.697 = MISO MTEP26 Table 4.2-2, 6 positions breaker-and-a-half, 69 kV $ 16.776 M / 230 kV $24.075 M',
      src: 'B&V 2014 p.4-7 T4-6 scaled by MISO MTEP26 Table 4.2-2 ratio 0.697; 6 positions and count 2 = ours; our derivation',
    },
  },
  dc500: {
    label: '500 kV HVDC bipole',
    kv: { value: 500, src: 'nominal voltage class of this line type (500 kV HVDC bipole)' },
    base_per_mi: { usd: 1_536_400, year: 2014, src: BV },
    terminals: {
      usd_each: 460.7e6, year: 2014, min: 2, report_only: true,
      src: 'B&V 2014 p.3-4 T3-5 (500 kV, 3,000 MW converter); count 2, one per end = ours (no source states it); HVDC $ is report-only',
    },
  },
};

const MARKUP_AFUDC = { label: 'AFUDC + overhead', x: 1.175, src: 'B&V 2014 (7.5 % AFUDC + 10 % overhead); PNAS §C formula' };

const TRIBAL_NOTE =
  'Tribal land is crossed only with the consent of the tribal nation; these miles are a negotiation, not a cost, and carry no $.';
const TRIBAL = { band: 'flags' as const, match: { bit: 0 }, note: TRIBAL_NOTE, src: 'ours (crossing needs the tribal nation\'s consent; no $)' };

const NO_ROW_LAND = 'This preset carries no ROW land cost.';

// ─── tm-default ───────────────────────────────────────────────────────────────

const BV_WECC = 'B&V 2014 §2.4 terrain multipliers, WECC column';
const REVX =
  "ours: reVX ISO multipliers (relative to each ISO's own base cost) applied to the B&V 2014 WECC base; " +
  'values from NREL reVX reVX/least_cost_xmission/config/iso_multipliers.json @ efb1977 L1-66 (BSD-3), SCE / MISO / Southeast sets; ' +
  'reVX multiplies them onto its own per-ISO base $/mi (config/base_line_costs.json L1-30; layers/dry_cost_creator.py L154-156, L163); ' +
  'TEPPC set = B&V 2014 WECC (reVX TEPPC reproduces it, rounding suburban to 1.3); ' +
  'terrain stays a max group although reVX multiplies land use × slope (dry_cost_creator.py L319-328)';
const REVX_SLOPE = `${REVX}; reVX slope bins 2 %/8 % (iso_multipliers.json hill_slope/mtn_slope; dry_cost_creator.py L215-216) = 1.15°/4.57°, approximated by our 1°/4° edges`;
const PNAS_FIRE =
  'PNAS S7 wildfire ramp 1 + (5 − 1)·RR/max(RR), used for routing and costing (SI Appendix p.14 Table S7 "Wildfire risk … both … 1 to 5"; p.16 Routing modifications item 7: "the lines would be fire hardened or undergrounded in areas with the highest fire risk", cap 5× above the 3.07–4.17× undergrounding multiplier from SCE\'s 2020 CAISO PTO costs), evaluated on WHP 2023 continuous (pd b5) as in pnas-wu2023';
const MIL_SRC =
  'NREL reVX barrier multiplier 100 (reVX/least_cost_xmission/config/constants.py L41 BARRIERS_MULT = 100 @ efb1977, BSD-3; README L73 barrier_layers: "areas that should not have any transmission in them. Transmission will route through barriers if there is no other possible route"); = the tribal, airfield and GAP 1 rows; PNAS S7 gives its one techno-economic transmission exclusion (airports ≤ 5 km) the same 100× (SI Appendix p.16 Routing modifications item 5); treating military land as such a barrier is ours (soft, so an endpoint on a base still solves)';
const GAP = { shift: 0, mask: 0b111 };
const DESIG = 'ours: PNAS SI Table S17 risk class 4/3/2 mapped to the GAP 1/2/3 weights';
const HOMES_WHY = 'rationale: PUCT 16 TAC §25.101 counts habitable structures within 300/500 ft of a route';

const tmDefault: RoutePreset = {
  id: 'tm-default',
  label: 'TransmissionMap default',
  attribution:
    'Multipliers: Black & Veatch 2014 (WECC TEPPC); regional sets: NREL reVX (BSD-3-Clause); mitigation: SWCA 2013 for WECC; ' +
    'land values: USDA NASS Census of Agriculture 2022; escalation: MISO MTEP25; ' +
    'residential structures: USA Structures, Oak Ridge National Laboratory (ORNL); Federal Emergency Management Agency (FEMA) Geospatial Response Office (CC BY 4.0).',
  caveat: 'Routes are illustrative, not siting recommendations.',
  dollar_year: 2014,
  escalation: ESCALATION,
  line_types: BV_LINES,
  combine: { terrain: 'max', military: 'max', protection: 'max', parallel: 'min', sites: 'max' },
  rows: [
    { band: 'landcover', match: { codes: [41, 42, 43] }, route_w: 2.25, cost_x: 1, cost_by_region: { TEPPC: 2.25, SCE: 3, MISO: 1.2, Southeast: 1.47 }, group: 'terrain', ref: BV_REF, note: 'forest', src: `${BV_WECC} (forested); reVX forest key (land_use_classes.json L6-10: NLCD 41–43); ${REVX}` },
    { band: 'landcover', match: { codes: [22, 23] }, route_w: 1.27, cost_x: 1, cost_by_region: { TEPPC: 1.27, SCE: 2, MISO: 1.08, Southeast: 1.75 }, group: 'terrain', ref: BV_REF, note: 'developed low/medium', src: `${BV_WECC} (suburban); reVX suburban key (config/land_use_classes.json L11-15: NLCD 21, 22, 23; our NLCD 21 stays in the neutral row = ours); ${REVX}` },
    { band: 'landcover', match: { codes: [24] }, route_w: 1.59, cost_x: 1, cost_by_region: { TEPPC: 1.59, SCE: 3, MISO: 1.2, Southeast: 1.12 }, group: 'terrain', ref: BV_REF, note: 'developed high', src: `${BV_WECC} (urban); reVX urban key (land_use_classes.json L16-18: NLCD 24); ${REVX}` },
    { band: 'landcover', match: { codes: [31] }, route_w: 1.05, cost_x: 1, cost_by_region: { TEPPC: 1.05, SCE: 1, MISO: 1, Southeast: 1 }, group: 'terrain', ref: BV_REF, note: 'barren', src: `${BV_WECC} (desert); reVX has no barren class (→ 1); ${REVX}` },
    { band: 'landcover', match: { codes: [90, 95] }, route_w: 2.5, cost_x: 1, cost_by_region: { TEPPC: 1.2, SCE: 2, MISO: 1.8, Southeast: 1.33 }, group: 'terrain', ref: WPP_REF, note: 'wetland', src: `${BV_WECC} (wetland $); reVX wetland key (land_use_classes.json L19-22: NLCD 90, 95); ${REVX}; routing weight 2.5 = ours, above forest (2.25): EPRI-KY (EKPC 2024, KY PSC 2024-00108 Exh. 19 Table 4) scores woody wetland 9 and emergent 8.7 of 9, and a wetland crossing adds a CWA §404 permit and matting` },
    { band: 'landcover', match: { codes: [12] }, route_w: 1.75, cost_x: 1, cost_by_region: { TEPPC: 1.75, SCE: 2, MISO: 1.21, Southeast: 1.6 }, group: 'terrain', ref: WPP_REF, note: 'ice/snow, treated as mountain', src: `ours (each set's mountain value); ${REVX}` },
    { band: 'landcover', match: { codes: [82] }, route_w: 1, cost_x: 1, cost_by_region: { TEPPC: 1, SCE: 1, MISO: 1.03, Southeast: 1 }, group: 'terrain', ref: BV_REF, note: 'cultivated crops', src: `${BV_WECC} (farmland 1.0 = reVX TEPPC cropland); reVX cropland key (land_use_classes.json L2-5 and dry_cost_creator.py L31 list codes 80 and 81; 80 is not an NLCD class and 81 is pasture/hay, so applying the key to NLCD 82 cultivated crops = ours, and 81 stays in the neutral row); ${REVX}` },
    { band: 'landcover', match: { codes: [21, 52, 71, 81] }, route_w: 1, cost_x: 1, group: 'terrain', ref: BV_REF, note: 'other NLCD', src: `${BV_WECC} (scrub/flat, farmland)` },
    { band: 'slope', match: { range: [2, 3] }, route_w: 1.4, cost_x: 1, cost_by_region: { TEPPC: 1.4, SCE: 1.5, MISO: 1.1, Southeast: 1.2 }, group: 'terrain', ref: BV_REF, note: 'rolling, 1–4°', src: `${BV_WECC} (rolling hill 2–8 %); PNAS S7 1°/4° bands; ${REVX_SLOPE}` },
    { band: 'slope', match: { range: [4, 8] }, route_w: 1.75, cost_x: 1, cost_by_region: { TEPPC: 1.75, SCE: 2, MISO: 1.21, Southeast: 1.6 }, group: 'terrain', ref: BV_REF, note: 'mountain, ≥ 4°', src: `${BV_WECC} (mountain >8 %); PNAS S7; ${REVX_SLOPE}` },
    { band: 'flags', match: { bit: 5 }, route_w: 1, cost_x: 1.5, line_types: ['ac500'], ref: BV_REF, note: 'pop > 100/mi² → tubular steel', src: 'B&V 2014 §2 structure (tubular 1.50 at 500 kV); PNAS S7' },
    { band: 'flags', match: { bit: 5 }, route_w: 1, cost_x: 1.3, line_types: ['ac345'], ref: BV_REF, note: 'pop > 100/mi² → tubular steel', src: 'B&V 2014 §2 structure (tubular 1.30 at 345 kV); PNAS S7' },
    { band: 'whpclass', match: { codes: [4] }, route_w: 1.03, cost_x: 1.03, ref: WU_REF, note: 'WHP high', src: `${PNAS_FIRE}; on class-4 cells of the 2026-10-16 cube the ramp has median 1.031, mean 1.034 → 1.03 (fire hardening in proportion to risk)` },
    { band: 'whpclass', match: { codes: [5] }, route_w: 1.5, cost_x: 1.5, ref: WPP_REF, note: 'WHP very high', src: 'ours (hardening)' },
    { band: 'protect', match: { field: GAP, codes: [1] }, route_w: 100, cost_x: 1, excludable: {}, group: 'protection', ref: WU_REF, note: 'GAP 1', src: 'ours, following PNAS S7 Cat 1 = 100; $ via mitigation' },
    { band: 'protect', match: { field: GAP, codes: [2] }, route_w: 10, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'GAP 2', src: 'ours (routing preference; $ via mitigation)' },
    { band: 'protect', match: { field: GAP, codes: [3] }, route_w: 2, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'GAP 3', src: 'ours (routing preference; $ via mitigation)' },
    { band: 'desig', match: { bit: 0 }, route_w: 1000, cost_x: 1, excludable: { off_w: 100, off_src: 'S17 WSA RC 4 weight before the v1.3 exclusion (ours)' }, group: 'protection', ref: WPP_REF, note: 'Wilderness Study Area', src: `${DESIG} (S17 WSA RC 4); FLPMA §603(c) non-impairment until Congress acts (BLM IM 2017-002: most high-voltage ROW projects will not meet it); WECC risk class 4 (precluded by law or regulation); exclusion weight 1000 = the ES/WestTEC military barrier multiplier, finite so an endpoint inside still solves` },
    { band: 'desig', match: { bit: 1 }, route_w: 10, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'National Monument (land) / NCA', src: `${DESIG} (S17 NM/NCA RC 3)` },
    { band: 'desig', match: { bit: 2 }, route_w: 10, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'Inventoried Roadless Area (2001 rule; rescission proposed 2026-08-18, not final as of 2026-10-16)', src: `${DESIG} (S17 IRA RC 3); 36 CFR 294.12` },
    { band: 'desig', match: { bit: 3 }, route_w: 10, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'ACEC', src: `${DESIG} (S17 ACEC RC 3)` },
    { band: 'desig', match: { bit: 4 }, route_w: 100, cost_x: 1, excludable: {}, group: 'protection', ref: WU_REF, note: 'Wild & Scenic River corridor', src: `${DESIG}; PNAS Category 1 (Wu et al. 2023); 16 USC 1278` },
    { band: 'desig', match: { bit: 5 }, route_w: 2, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'National Historic/Scenic Trail corridor', src: `${DESIG} (S17 NHT RC 2)` },
    { band: 'desig', match: { bit: 6 }, route_w: 2, cost_x: 1, group: 'protection', ref: WPP_REF, note: 'other special federal area (RNA/SDA/NSBV/HCA/NRA)', src: `${DESIG} (S17 RC 2)` },
    {
      band: 'flags2', match: { bit: 0 }, route_w: 20, cost_x: 1, ref: WU_REF, note: 'sage-grouse PHMA/IHMA', src: 'PNAS S7 Cat 2 weight (S17 lists PHMA as Cat 2); applies to every line type: the 2025 RODs define major ROW as "transmission lines > 100kv" (glossary, WY/NV-CA/UT Vol 2 p.6-9, ID p.61, CO p.6-9, OR p.6-9, MT/Dakotas p.7-6), and lines at or below 100 kV (minor ROW) stay avoidance in PHMA in six of the seven RODs (Oregon: avoidance in breeding, nesting and seasonal habitat, otherwise open)',
      except: [
        {
          band: 'flags', match: { bit: 4 }, ref: BLM_REF, label: 'inside Section 368 corridors',
          src: 'BLM GRSG 2025 RODs, PHMA "Major Rights of Way Avoidance Criteria" 1): "RMP designated corridors within PHMA are open to consideration of a new major ROW ' +
            'in the category of ROW for which the corridor was designated if …" — WY ROD p.38, ID p.38, NV/CA p.39, UT p.41, CO p.2-11 (allocation: "Avoidance for new ' +
            'major ROWs … except for designated corridors, which will be open to consideration"), OR p.2-9. Section 368 corridors are RMP-designated (BLM 2009 energy-corridor ' +
            'ROD amended the RMPs); ours: other RMP corridors are not mapped, the NV/CA ROD (MD LR 2, p.58) keeps only its Figure 2-10 corridors, and the "category of ROW" ' +
            'and impact conditions are not checked',
        },
        {
          band: 'adj', match: { field: { shift: 0, mask: 0b11 }, codes: [1, 2] }, ref: BLM_REF, label: 'on/beside existing ≥230 kV lines', active: false,
          src: 'off by default: outside designated corridors the 2025 RODs keep PHMA an avoidance area for major ROWs and make "co-location with existing, similarly sized, ' +
            'infrastructure" a micro-siting condition once a criterion is met (WY ROD p.38 condition a; same in ID, NV/CA, UT, CO, OR), not a criterion of its own; ' +
            'MT/Dakotas ROD p.52 criterion 1 ("neutral or beneficial to GRSG habitat through … avoidance and minimization measures, including co-location") is the only ' +
            'path that leans on it. Glossary (ID ROD p.54): "Co-location (electrical lines). Installation of new rights-of-way adjacent to current ROWs boundaries". ' +
            'adj class 1–2 (≤ 1 cell, ≈ 250 m) approximates "adjacent"; no ROD gives a distance',
        },
        {
          band: 'adj', match: { field: { shift: 5, mask: 0b11 }, codes: [1, 2] }, ref: BLM_REF, label: 'on/beside existing 100–229 kV lines', active: false,
          src: 'off by default, as the ≥230 kV entry (same RODs and "co-location with existing, similarly sized infrastructure" condition); ' +
            'meant for 69–161 kV builds, which an existing 100–229 kV line is similar in size to; applies to every line type when on; ' +
            'no exemption beside lines under 100 kV (the cube marks existing lines from 100 kV only)',
        },
      ],
    },
    { band: 'flags2', match: { bit: 1 }, route_w: 1.5, cost_x: 1, ref: WPP_REF, note: 'sage-grouse GHMA', src: 'ours (weight); the 2025 RODs open GHMA to major ROWs: WY "SHMA and GHMA are open to … major ROWs with …", CO linkage areas open, NV/CA other HMA (OHMA) no ROW restriction, MT/Dakotas CHMA same as GHMA (grid.json pd_band_sources.flags2.sage_grouse.meaning)' },
    { band: 'flags2', match: { bit: 5 }, route_w: 100, cost_x: 1, ref: WPP_REF, note: 'Superfund NPL site', src: 'ours (avoidance per the EKPC 2024 siting study, KY PSC case 2024-00108 Exhibit 19; = GAP 1 row)' },
    { band: 'flags', match: { bit: 3 }, route_w: 5, cost_x: 1, ref: WPP_REF, note: 'critical habitat', src: 'ours' },
    { band: 'flags', match: { bit: 4 }, route_w: 0.8, cost_x: 1, group: 'parallel', ref: WPP_REF, note: 'Section 368 corridor', src: 'ours (preference discount); min with the existing-line discount, not compounded' },
    {
      band: 'adj', match: { field: { shift: 0, mask: 0b11 }, codes: [1, 2] }, route_w: 0.5, cost_x: 1, group: 'parallel',
      ref: GTC_REF, note: 'on or beside an existing ≥ 230 kV line (adj line class 1–2)',
      src: 'derived from EPRI-GTC Georgia 2006 suitability (existing corridor 1 vs open land 2), Table 2-1 of the EPRI-GTC siting methodology (EPRI 1013080, 2006) as reproduced publicly on Yumpu; PUCT 16 TAC 25.101(b)(3)(B)(i) and FERC Order 1977 resource report 10 name the factor without a value',
    },
    { band: 'flags', match: { bit: 0 }, route_w: 100, cost_x: 1, excludable: {}, ref: WPP_REF, note: 'tribal land (soft barrier)', src: 'ours (soft barrier: finite, so endpoints inside or enclosed by tribal land still solve)' },
    { band: 'flags', match: { bit: 1 }, route_w: 100, cost_x: 1, excludable: { link: 'mil' }, group: 'military', ref: REVX_REF, note: 'military (PAD-US DOD)', src: MIL_SRC },
    { band: 'osm_flags', match: { bit: 7 }, route_w: 100, cost_x: 1, excludable: { link: 'mil' }, group: 'military', ref: REVX_REF, note: 'military (OSM landuse=military)', src: `${MIL_SRC}; max with PAD-US so overlap counts once` },
    { band: 'aviation', match: { codes: [2] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'notice zone (14 CFR 77.9)', src: 'ours (a notice is a filing, not a prohibition: weight 1, report miles only); FAA Form 7460-1 / OE/AAA decides' },
    { band: 'osm_flags', match: { bit: 0 }, route_w: 20, cost_x: 1, ref: WPP_REF, note: 'lake (OSM)', src: 'ours (routing preference; NLCD 11 already prices water)' },
    {
      band: 'adj', match: { field: { shift: 5, mask: 0b11 }, codes: [1, 2] }, route_w: 0.7, cost_x: 1, group: 'parallel',
      ref: WPP_REF, note: 'on/beside existing 100–229 kV line',
      src: 'ours; EPRI-GTC scores paralleling existing transmission as most suitable (EPRI 1013080 p.46); weaker than ≥ 230 kV because a 345/500 kV line beside a 115 kV ROW often needs new ROW width',
    },
    { band: 'flags2', match: { bit: 2 }, route_w: 1.5, cost_x: 1, except: [{ band: 'nfhl', match: { codes: [1, 2] }, label: 'where FEMA has an effective flood map', ref: WPP_REF, src: "ours: FEMA's map replaces the estimate where it exists, so a floodplain counts once" }], ref: WPP_REF, note: 'floodplain', src: 'ours; EPRI-KY (EKPC 2024, KY PSC 2024-00108 Exh. 19 Table 4) scores the 100-yr floodplain 9 of 9; a line spans a floodplain and the modelled layer covers 10.9 % of CONUS land, so the weight stays below GAP 3 (2); no $ source for floodplain foundations at concept level; layer: EPA EnviroAtlas estimated floodplain (Woznicki et al. 2019)' },
    { band: 'flags2', match: { bit: 3 }, route_w: 10, cost_x: 1, group: 'sites', ref: WPP_REF, note: 'occupied facility (school, day care and similar)', src: 'ours; EPRI-GTC treats school, day care and similar parcels as avoidance areas (EPRI 1013080 p.40, p.44); 91 m (300 ft) buffer from the 300 ft proximity step (p.46)' },
    { band: 'flags2', match: { bit: 4 }, route_w: 10, cost_x: 1, group: 'sites', ref: WPP_REF, note: 'NRHP historic property', src: 'ours; EPRI-GTC lists NRHP properties as avoidance areas (EPRI 1013080 p.44; 1,500 ft APE p.46 not modelled)' },
    { band: 'flags2', match: { bit: 6 }, route_w: 3, cost_x: 1, ref: WPP_REF, note: 'Coastal Barrier Resources System unit', src: 'ours; CBRA (16 U.S.C. 3501 et seq.) bars new federal expenditures and financial assistance in System Units; Otherwise Protected Areas carry only the federal flood-insurance limit; both are weighted here' },
    { band: 'flags2', match: { bit: 7 }, route_w: 3, cost_x: 1, ref: WPP_REF, note: 'FUDS munitions response site', src: 'ours; USACE FUDS munitions response sites carry explosives-safety review; clearance cost not priced' },
    { band: 'flags', match: { bit: 7 }, route_w: 3, cost_x: 1, ref: WPP_REF, note: 'tall structure or dam', src: 'ours; FAA obstruction marking from 200 ft (61 m) (14 CFR 77 / AC 70/7460-1); NID high/significant hazard dams: a line beside a dam crosses its inspection and inundation zone' },
    { band: 'landcover', match: { codes: [11] }, route_w: 1.2, cost_x: 1, cost_by_region: { TEPPC: 1.2, SCE: 2, MISO: 1.8, Southeast: 1.33 }, group: 'terrain', ref: BV_REF, note: 'open water', src: `${BV_WECC} (wetland); applying the reVX wetland key to NLCD 11 = ours; reVX water NLCD 11 × 10 (constants.py L73-75, set last in dry_cost_creator.py L349-351) not adopted (the OSM lake row weights lakes); ${REVX}` },
    { band: 'bldg', match: { range: [2, 3] }, route_w: 1.3, cost_x: 1, ref: WPP_REF, note: `1–2 homes in cell (${HOMES_WHY})`, src: 'ours (step below the EPRI-KY-derived ≥ 10 row)' },
    { band: 'bldg', match: { range: [4, 10] }, route_w: 1.6, cost_x: 1, ref: WPP_REF, note: `3–9 homes in cell (${HOMES_WHY})`, src: 'ours (step below the EPRI-KY-derived ≥ 10 row)' },
    { band: 'bldg', match: { range: [11, 255] }, route_w: 2, cost_x: 1, ref: KY_REF, note: `10+ homes in cell (${HOMES_WHY})`, src: 'derived: EPRI-KY (EKPC 2024, KY PSC 2024-00108 Exh. 19 Table 1) scores 0–300 ft from a building 9 against a background of 4.4 → 9 / 4.4 ≈ 2.0; no $ (cost_x 1)' },
    { band: 'flags', match: { bit: 5 }, route_w: 1, cost_x: 1.1, line_types: ['ac230', 'ac161', 'ac138', 'ac115', 'ac69'], ref: BV_REF, note: 'pop > 100/mi² → tubular steel', src: 'B&V 2014 §2 structure (tubular 1.10 at 230 kV); PNAS S7; ≤ 161 kV take the 230 kV value = ours (no source below 230 kV)' },
    { band: 'desig', match: { bit: 7 }, route_w: 1000, cost_x: 1, excludable: { off_w: 100, off_src: 'ours: = the GAP 1 row and the WSA row before v1.3 (100)' }, group: 'protection', ref: WPP_REF, note: 'Wilderness or National Park (excluded)', src: `${DESIG} (WA, State Wilderness SW) + PAD-US 4.1 Fee Des_Tp NP; Wilderness Act 16 USC 1133(c), a utility line only by Presidential authorization (1133(d)(4)); National Park: Secretary approval under 54 USC 100902 and NPS's no-practicable-alternative rule; weight 1000 as the WSA row` },
    { band: 'flags', match: { bit: 6 }, route_w: 5, cost_x: 1, ref: WPP_REF, note: 'state or local park (GAP 3–4)', src: 'ours (× GAP 3 = 10, the GAP 2 level; GAP 1–2 parks are weighted by their GAP row); state rules restrict utility lines in parks, e.g. Minn. R. 7850.4300 subp. 2, LWCF Act §6(f)(3) (54 USC 200305(f)(3)) conversion review, N.Y. Const. art. XIV' },
    {
      band: 'wetland', match: { range: [52, 101] }, route_w: 2.5, cost_x: 1, ref: WPP_REF, note: 'NWI wetland, over half the cell',
      src: 'USFWS NWI (emergent, forested/shrub, estuarine/marine wetland); weight = the NLCD wetland row (EPRI-KY wetland 8.7–9 of 9, CWA §404 permit and matting); cost on NLCD only',
      except: [{ band: 'landcover', match: { codes: [41, 42, 43, 90, 95] }, ref: WPP_REF, label: 'where NLCD already marks forest or wetland', src: 'ours: those cells are weighted by their land-cover row (forest 2.25, wetland 2.5), so a wetland counts once' }],
    },
    {
      band: 'wetland', match: { range: [27, 51] }, route_w: 1.5, cost_x: 1, ref: WPP_REF, note: 'NWI wetland, a quarter to half the cell',
      src: 'USFWS NWI; ours (a line can often span a partial-cell wetland)',
      except: [{ band: 'landcover', match: { codes: [41, 42, 43, 90, 95] }, ref: WPP_REF, label: 'where NLCD already marks forest or wetland', src: 'ours: those cells are weighted by their land-cover row, so a wetland counts once' }],
    },
    {
      band: 'protect', match: { bit: 7 }, route_w: 1, cost_x: 1, excludable: {}, group: 'protection',
      ref: WPP_REF, note: 'NPS unit named Preserve (PAD-US Fee)',
      src: 'ours: no public method weights National Preserves on their own and PAD-US 4.1 has no preserve code, so the cells are NPS-managed PAD-US Fee units whose name contains Preserve (CONUS only; takes in a few units that are not National Preserves, e.g. Timucuan Ecological and Historic Preserve; misses land NPS does not own, e.g. most of Tallgrass Prairie); 1 in the max group leaves the other protection rows in force; the Excl. tick follows 54 USC 100902 (a ROW across any System unit needs the Secretary\'s grant)',
    },
    { band: 'nonres', match: { range: [2, 101] }, route_w: 1, cost_x: 1,
      ref: WPP_REF, note: 'observed nonresidential footprints',
      src: 'FEMA/ORNL USA Structures; ours: neutral editable observation, no calibrated routing penalty or dollar multiplier; processed coverage, not a clearance or occupancy determination' },
    { band: 'bldgunk', match: { range: [2, 101] }, route_w: 1, cost_x: 1,
      ref: WPP_REF, note: 'observed footprints, unknown class',
      src: 'FEMA/ORNL USA Structures; ours: neutral editable observation of a structure with unknown occupancy class, not vacant land; processed coverage' },
    { band: 'aviation', match: { codes: [3, 4, 5, 6] }, route_w: 100, cost_x: 1.2, line_types: ['ac500', 'dc500'], ref: WU_REF, note: 'exceeds an obstruction standard — screening (≤ 61 m / 200 ft)', src: 'PNAS S7 (airports within 5 km: weight 100, cost 1.2); the Part 77 surface classes are the screening of the FAA NTAD airport and runway layers; FAA Form 7460-1 / OE/AAA decides' },
    { band: 'aviation', match: { codes: [4, 5, 6] }, route_w: 100, cost_x: 1.2, line_types: ['ac230', 'ac345'], ref: WU_REF, note: 'exceeds an obstruction standard — screening (≤ 46 m)', src: 'PNAS S7 (airports within 5 km: weight 100, cost 1.2); the Part 77 surface classes are the screening of the FAA NTAD airport and runway layers; FAA Form 7460-1 / OE/AAA decides' },
    { band: 'aviation', match: { codes: [5, 6] }, route_w: 100, cost_x: 1.2, line_types: ['ac161', 'ac138', 'ac115', 'ac69'], ref: WU_REF, note: 'exceeds an obstruction standard — screening (≤ 30 m)', src: 'PNAS S7 (airports within 5 km: weight 100, cost 1.2); the Part 77 surface classes are the screening of the FAA NTAD airport and runway layers; FAA Form 7460-1 / OE/AAA decides' },
    { band: 'nfhl', match: { codes: [2] }, route_w: 1.5, cost_x: 1, ref: WPP_REF, note: 'FEMA special flood hazard area', src: 'FEMA National Flood Hazard Layer (NFHL_Key_Layers_202610), SFHA ≥ 50 % of the cell; weight = the EPA floodplain row\'s (ours; EPRI-KY: EKPC 2024, KY PSC 2024-00108 Exh. 19 Table 4)' },
  ],
  region: { band: 'state', barrier_codes: [0], src: 'ours (state 0 = outside CONUS land)' },
  regions: {
    band: 'isoreg',
    sets: { TEPPC: 'TEPPC', CAISO: 'SCE', NYISO: 'SCE', ISONE: 'SCE', PJM: 'SCE', MISO: 'MISO', SPP: 'MISO', ERCOT: 'Southeast', Southeast: 'Southeast' },
    default: 'TEPPC',
    src: 'Lopez et al. 2025 (NREL 2024 supply curves) §2.5 ISO → reVX set mapping; ISO codes from eia_ba; no BA → TEPPC = ours',
  },
  mitigation: {
    classes: [
      {
        class: 3,
        any: [
          { band: 'protect', match: { field: GAP, codes: [1, 2] } },
          { band: 'flags', match: { bit: 3 } },
        ],
        src: 'ours: class 3 = GAP 1–2 ∪ crithab (EDTF class 3: critical habitat, monuments)',
      },
      {
        class: 2,
        any: [
          { band: 'protect', match: { field: GAP, codes: [3] } },
          { band: 'agency', match: { range: [2, 9] } },
        ],
        src: 'ours: class 2 = GAP 3 ∪ other federal (agency codes 2–9, scripts/route_grid.py)',
      },
      {
        class: 1,
        any: [
          { band: 'flags', match: { bit: 4 } },
          { band: 'osm_flags', match: { bit: 2 } },
        ],
        src: 'ours: class 1 = Section 368 ∪ existing ≥ 230 kV line cell',
      },
    ],
    pct: { ca: [0.02, 0.01, 0.055], other: [0.005, 0.005, 0.01] },
    ca: { band: 'state', codes: [6] },
    range: 'SWCA gives point values; low/high apply the rough-early-estimate band (ours)',
    src: 'SWCA 2013 T6 (% of line capital; highest class wins = ours)',
  },
  markups: [MARKUP_AFUDC],
  contingency: {
    pct: 0.3, label: 'contingency (rough early estimate)',
    src: 'MISO MTEP26 exploratory estimates carry 30 % (MISO MTEP26 cost workbook, cell B606; MISO MTEP25 p.4); PJM 30 % (PJM DESTF cost evaluation, 2025-07-15, slides 3–4). ' +
      'B&V 2014 §4.3 p.4-8 calls its costs "overnight" and never uses the word "contingency", so 30 % is not a double count. ' +
      'Applied to line + markups + mitigation + terminals + ROW land (MISO applies it to the whole project)',
  },
  row_land: {
    band: 'landval', year: 2022,
    width_ft: { ac500: 250, ac345: 200, ac230: 150, ac161: 100, ac138: 95, ac115: 90, ac69: 80, dc500: 200 },
    width_src: 'B&V 2014 §2.5.1 Table 2-6 p.2-7 ROW widths: 500 kV DC 250 ft, 345 kV DC 200 ft, 230 kV DC 150 ft, 500 kV HVDC bipole 200 ft; 161/138/115/69 kV: MISO MTEP26 Transmission Cost Estimation Workbook Table 3.1-1 (100/95/90/80 ft, used as published; MISO uses 125 ft at 230 kV)',
    developed: { band: 'landcover', match: { codes: [22, 23, 24] } }, developed_x: 5,
    developed_src: 'MISO MTEP25 p.7 (urban/suburban land = 5 × pasture); applied to the NASS all-ag county mean on NLCD 22–24 = ours',
    federal: 'as-private', tribal: 0,
    note: 'Federal ROW priced at county private land value; BLM/USFS rent schedules not modelled. Tribal land carries no ROW $.',
    src: 'USDA NASS Census of Agriculture 2022, county "AG LAND, INCL BUILDINGS - ASSET VALUE, $ / ACRE" (2022$; withheld (D) counties take the state value)',
  },
  uncertainty: CLASS5,
  length: 'routed',
  length_factor: {
    tiers: [{ lt_mi: 3, x: 1.5 }, { le_mi: 10, x: 1.2 }],
    src: 'B&V 2014 / E3 2019 TEPPC calculator rows 63–65 (< 3 mi 1.5, 3–10 mi 1.2, > 10 mi 1.0), on line $ by routed length',
  },
  tribal: TRIBAL,
  notes: [
    'Observed building footprints cover processed regions only. No returned footprint does not establish vacancy; nonresidential and unknown-class rows are neutral until edited.',
    'ROW land = ROW width × routed length × county farmland $/ac (USDA NASS 2022), × 5 on developed land (MISO MTEP25 p.7).',
    'Assumption: federal ROW priced at county private land value; BLM/USFS rent schedules not modelled.',
    'Regional cost sets: NREL reVX config/iso_multipliers.json @ efb1977, BSD-3-Clause licence (LICENSE at efb1977: Copyright (c) 2026, Alliance for Energy Innovation); costs only, routing is national.',
    'Markups apply to line $ and ROW land, not terminals (PNAS §C formula); contingency applies to the whole subtotal.',
  ],
};

// ─── pnas-wu2023 ──────────────────────────────────────────────────────────────

const S7 = 'PNAS S7';
const TNC = { shift: 4, mask: 0b11 };
const WEST_FIPS = [4, 6, 8, 16, 30, 32, 35, 41, 49, 53, 56];
const PNAS_TRIBAL =
  "ours: calibration to PNAS's published lines (our tribal share 1.8 % vs PNAS 1.6 %); PNAS SI p.4 removed tribal layers from the Category inputs; " +
  'Table S7 has no tribal row; 15 = S7 Cat 3 weight';

const pnasWu2023: RoutePreset = {
  id: 'pnas-wu2023',
  label: 'Power of Place – West (Wu et al. 2023)',
  attribution:
    'Method: Wu, G. C., et al. (2023). Minimizing habitat conflicts in meeting net-zero energy targets in the western United States. PNAS 120(4), e2204098120. https://doi.org/10.1073/pnas.2204098120. Data: Zenodo https://doi.org/10.5281/zenodo.7460026. CC BY 4.0.',
  caveat: 'Schematic, for scenario analysis only; not vetted by any planning authority.',
  dollar_year: 2018,
  escalation: ESCALATION,
  line_types: {
    ac500: {
      label: 'New 500 kV double-circuit HVAC',
      kv: { value: 500, src: 'nominal voltage class of this line type (New 500 kV double-circuit HVAC)' },
      base_per_mi: { usd: 3_278_535, year: 2018, src: 'PNAS S5 (B&V calculator, 2018$)' },
      terminals: {
        usd_each: 87.9e6, year: 2018, min: 2, every_mi: 400, after_mi: 400,
        src: 'PNAS S6; count = 2 + floor(max(0, L − 400)/400), our reading of Table S6',
      },
    },
    dc500: {
      label: 'New 500 kV HVDC',
      kv: { value: 500, src: 'nominal voltage class of this line type (New 500 kV HVDC)' },
      base_per_mi: { usd: 1_639_820, year: 2018, src: 'PNAS S5 (2018$)' },
      terminals: {
        usd_each: 654.5e6, year: 2018, min: 2, every_mi: 100, after_mi: 200, report_only: true,
        src: 'PNAS SI Table S6 (+1 per 100 mi beyond 200); report-only',
      },
    },
  },
  combine: {},
  rows: [
    { band: 'landcover', match: { codes: [41, 42, 43] }, route_w: 2.25, cost_x: 2.25, ref: WU_REF, note: 'forested', src: S7 },
    { band: 'landcover', match: { codes: [22, 23, 24] }, route_w: 1.59, cost_x: 1.59, ref: WU_REF, note: 'urban', src: `${S7}; NLCD 22–24 as "urban" = ours` },
    { band: 'landcover', match: { codes: [11, 90, 95] }, route_w: 1.2, cost_x: 1.2, ref: WU_REF, note: 'wetland, water', src: S7 },
    { band: 'landcover', match: { codes: [31] }, route_w: 1.05, cost_x: 1.05, ref: WU_REF, note: 'desert/barren', src: S7 },
    { band: 'slope', match: { range: [2, 3] }, route_w: 1.4, cost_x: 1.4, ref: WU_REF, note: 'rolling 1–4°', src: S7 },
    { band: 'slope', match: { range: [4, 8] }, route_w: 1.75, cost_x: 1.75, ref: WU_REF, note: 'mountain > 4°', src: S7 },
    { band: 'protect', match: { field: TNC, codes: [1] }, route_w: 100, cost_x: 1.2, ref: WU_REF, note: 'TNC Cat 1', src: S7 },
    { band: 'protect', match: { field: TNC, codes: [2] }, route_w: 20, cost_x: 1.1, ref: WU_REF, note: 'TNC Cat 2', src: S7 },
    { band: 'protect', match: { field: TNC, codes: [3] }, route_w: 15, cost_x: 1.05, ref: WU_REF, note: 'TNC Cat 3', src: S7 },
    { band: 'flags', match: { bit: 2 }, route_w: 100, cost_x: 1.2, ref: WU_REF, note: 'airport within 5 km', src: S7 },
    { band: 'osm_flags', match: { bit: 2 }, route_w: 9, cost_x: 1, ref: WU_REF, note: 'new line inside existing ≥ 230 kV ROW', src: S7 },
    { band: 'flags', match: { bit: 5 }, route_w: 1.5, cost_x: 1.5, line_types: ['ac500'], ref: BV_REF, note: 'pop > 100/mi² → tubular steel', src: `${S7} (1.1/1.3/1.5 at 230/345/500 kV)` },
    {
      band: 'wildfire', match: { range: [1, 255] }, route_w: { ramp: [1, 5] }, cost_x: { ramp: [1, 5] },
      ref: WU_REF, note: '1 + 4·(b5 − 1)/254; b5 is WHP cnt, a substitution for PNAS RR',
      src: 'PNAS S7 wildfire 1 + (max − 1)·RR/max(RR), max 5; WHP 2023 continuous (pd b5) stands in for RR',
    },
    { band: 'flags', match: { bit: 0 }, route_w: 15, cost_x: 1, ref: WPP_REF, note: 'tribal land', src: PNAS_TRIBAL },
    { band: 'aviation', match: { codes: [2, 3, 4, 5, 6] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'Part 77 screening (report only)', src: 'ours (PNAS S7 prices the airport 5 km flag, kept above; the aviation screening adds no weight); FAA Form 7460-1 / OE/AAA decides' },
    { band: 'nfhl', match: { codes: [2] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'FEMA special flood hazard area (report only)', src: 'ours (PNAS S7 has no floodplain row; weight 1)' },
  ],
  region: { band: 'state', allowed_codes: WEST_FIPS, src: 'PNAS study area (11 western states); ours (state 0 = outside CONUS land)' },
  markups: [{ label: 'AFUDC + overhead', x: 1.175, src: 'PNAS §C formula (B&V)' }],
  uncertainty: CLASS5,
  length: 'routed',
  tribal: { ...TRIBAL, note: `${TRIBAL_NOTE} PNAS excluded tribal land from its analysis; its tribal routing weight 15 is our calibration to PNAS's published lines (SI p.4 removed tribal layers from the Category inputs; Table S7 has no tribal row; 15 = the S7 Cat 3 weight).` },
  notes: [NO_ROW_LAND, 'PNAS formula: (base × Π cost_x + ROW land) × 1.175, plus substations.'],
};

// ─── straight-line-quick ──────────────────────────────────────────────────────

const straightLineQuick: RoutePreset = {
  id: 'straight-line-quick',
  label: 'Straight line × 1.30 (rough early estimate)',
  attribution: 'Length rule: MISO MTEP25 Transmission Cost Estimation Guide; base costs: Black & Veatch 2014 (WECC TEPPC).',
  caveat: 'No route is solved: length is the great-circle distance × 1.30, with no terrain or land multipliers.',
  dollar_year: 2014,
  escalation: ESCALATION,
  line_types: BV_LINES,
  combine: {},
  rows: [],
  region: { band: 'state', barrier_codes: [0], src: 'ours (state 0 = outside CONUS land)' },
  markups: [MARKUP_AFUDC],
  uncertainty: CLASS5,
  length: { straight_line_factor: 1.3, src: 'MISO MTEP25 p.15 (exploratory/planning: straight line × 1.30)' },
  tribal: TRIBAL,
  notes: [NO_ROW_LAND],
};

// ─── nrel-revx ────────────────────────────────────────────────────────────────

const RX = 'NREL reVX least_cost_xmission @ efb1977 (BSD-3)';
const RX_MULT = `${RX} config/iso_multipliers.json (TEPPC L2-16, SCE L18-32, MISO L34-48, Southeast L50-64); applied as published to NLCD classes per config/land_use_classes.json`;
const RX_SLOPE = `${RX} config/iso_multipliers.json hill_mult/mtn_mult (hill_slope 2 %, mtn_slope 8 %, README L16 "Slopes are in %"; dry_cost_creator.py L215-216) = 1.15°/4.57°, approximated by our 1°/4° edges (as tm-default)`;
const RX_TERM = `${RX} config/upgrade_substation_costs.json TEPPC (L20-25); reVX states no dollar year for substation costs, so 2019 (its line-cost year, README L24-26) is assumed = ours; count 2, one per end, is ours (our ends snap to existing substations, as Lopez et al. 2025 p.36 "connects to an existing substation"); reVX's regional upgrade costs and Lopez's $15/kW are not modelled, transformers are not modelled`;

const revxLine = (label: string, kv: number, mw: number, usd: number, term: number): LineType => ({
  label,
  kv: { value: kv, src: `nominal voltage class of this line type (${label}); config/power_to_voltage.json L2-11 maps ${mw} MW to ${kv} kV` },
  base_per_mi: { usd, year: 2019, src: `${RX} config/base_line_costs.json TEPPC "${mw}" (L23-29), 2019 US$ per mile (README L24-26); TEPPC excludes ROW` },
  terminals: { usd_each: term, year: 2019, min: 2, src: RX_TERM },
});

const revxRegional = (id: string, mw: number, ratios: Record<string, number>, arithmetic: string): CostRow => ({
  band: 'isoreg', match: { range: [1, 255] }, route_w: 1, cost_x: 1, cost_by_region: ratios, line_types: [id], ref: REVX_REF, note: 'regional base cost',
  src: `${RX} config/base_line_costs.json (${mw} MW: MISO L2-8, SCE L9-15, Southeast L16-22, TEPPC L23-29); ratio = regional base / TEPPC base, to 4 decimals: ${arithmetic}; reVX routes on $ x (1 + barrier) (trans_cap_costs.py L396-400), here the ratio affects cost only`,
});

const revxLand = (codes: number[], note: string, w: [number, number, number, number], key: string): CostRow => ({
  band: 'landcover', match: { codes }, route_w: w[0], cost_x: 1, cost_by_region: { TEPPC: w[0], SCE: w[1], MISO: w[2], Southeast: w[3] }, ref: REVX_REF, note,
  src: `${RX_MULT}; ${key}; ungrouped, so land use multiplies with the terrain group as reVX does (dry_cost_creator.py L319-328)`,
});

const revxSlope = (range: [number, number], note: string, w: [number, number, number, number]): CostRow => ({
  band: 'slope', match: { range }, route_w: w[0], cost_x: 1, cost_by_region: { TEPPC: w[0], SCE: w[1], MISO: w[2], Southeast: w[3] }, group: 'terrain', ref: REVX_REF, note,
  src: `${RX_SLOPE}; max group with the water row`,
});

const nrelRevx: RoutePreset = {
  id: 'nrel-revx',
  label: 'NREL reVX least-cost transmission',
  attribution:
    'Method and values: NREL reVX least_cost_xmission (BSD-3-Clause), commit efb1977; region map and GAP 1 exclusion: Lopez et al. 2025, NREL/TP-6A20-91900; ' +
    'escalation: MISO MTEP25.',
  caveat: 'Routes are illustrative, not siting recommendations.',
  dollar_year: 2019,
  escalation: ESCALATION,
  line_types: {
    ac500: revxLine('500 kV (reVX 1,500 MW)', 500, 1500, 3_052_857, 10_236_000),
    ac230: revxLine('230 kV (reVX 400 MW)', 230, 400, 1_579_572, 5_500_000),
    ac138: revxLine('138 kV (reVX 205 MW)', 138, 205, 1_180_083, 2_198_000),
    ac69: revxLine('69 kV (reVX 102 MW)', 69, 102, 983_701, 1_352_000),
  },
  combine: { terrain: 'max' },
  rows: [
    revxLand([81], 'cropland', [1, 1, 1.03, 1], 'cropland key lists NLCD 80 and 81 (land_use_classes.json L2-5); 80 is not an NLCD class, so 81 as published'),
    revxLand([41, 42, 43], 'forest', [2.25, 3, 1.2, 1.47], 'forest key NLCD 41-43 (land_use_classes.json L6-10)'),
    revxLand([21, 22, 23], 'suburban', [1.3, 2, 1.08, 1.75], 'suburban key NLCD 21-23 (land_use_classes.json L11-15)'),
    revxLand([24], 'urban', [1.59, 3, 1.2, 1.12], 'urban key NLCD 24 (land_use_classes.json L16-18)'),
    revxLand([90, 95], 'wetland', [1.2, 2, 1.8, 1.33], 'wetland key NLCD 90, 95 (land_use_classes.json L19-22)'),
    revxSlope([2, 3], 'hill, 1-4°', [1.4, 1.5, 1.1, 1.2]),
    revxSlope([4, 8], 'mountain, 4° and up', [1.75, 2, 1.21, 1.6]),
    {
      band: 'landcover', match: { codes: [11] }, route_w: 10, cost_x: 10, group: 'terrain', ref: REVX_REF, note: 'water',
      src: `${RX} config/constants.py L73-76 (WATER_NLCD_CODE 11, WATER_MULT 10.0), set last in layers/dry_cost_creator.py L349-351 so water is 10, not 10 x slope; no regional sets; ` +
        'here water sits in the max group with the slope rows, so on a water cell (no land-use row matches NLCD 11) the cell takes the larger of slope and 10, which is 10; on a dry cell land use x slope as reVX (L319-328)',
    },
    {
      band: 'protect', match: { field: GAP, codes: [1] }, route_w: EXCLUDED_W, cost_x: 1,
      excludable: { off_w: 100, off_src: 'reVX BARRIERS_MULT = 100 (constants.py L41-46)' }, ref: REVX_REF, note: 'GAP 1 (excluded)',
      src: 'Lopez et al. 2025 p.35: "we excluded PAD-US GAP Status 1 areas from transmission development" and set "the cost to infinity" in excluded areas, approximated by weight 1000 so a route that starts inside still solves = ours; ' +
        `unticked: ${RX} BARRIERS_MULT = 100 (constants.py L41-46)`,
    },
    revxRegional('ac500', 1500, { TEPPC: 1, SCE: 1.5648, MISO: 0.913, Southeast: 1.3287 },
      'SCE 4,777,000 / 3,052,857 = 1.5648; MISO 2,787,303 / 3,052,857 = 0.9130; Southeast 4,056,410 / 3,052,857 = 1.3287'),
    revxRegional('ac230', 400, { TEPPC: 1, SCE: 1.9208, MISO: 1.0729, Southeast: 0.9925 },
      'SCE 3,034,000 / 1,579,572 = 1.9208; MISO 1,694,747 / 1,579,572 = 1.0729; Southeast 1,567,655 / 1,579,572 = 0.9925'),
    revxRegional('ac138', 205, { TEPPC: 1, SCE: 1.7661, MISO: 1.2257, Southeast: 0.8341 },
      'SCE 2,084,122 / 1,180,083 = 1.7661; MISO 1,446,469 / 1,180,083 = 1.2257; Southeast 984,325 / 1,180,083 = 0.8341'),
    revxRegional('ac69', 102, { TEPPC: 1, SCE: 1.5493, MISO: 1.2757, Southeast: 0.8324 },
      'SCE 1,524,000 / 983,701 = 1.5493; MISO 1,254,921 / 983,701 = 1.2757; Southeast 818,852 / 983,701 = 0.8324'),
    { band: 'aviation', match: { codes: [2, 3, 4, 5, 6] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'Part 77 screening (report only)', src: 'ours (reVX has no aviation row; weight 1, as pnas-wu2023); FAA Form 7460-1 / OE/AAA decides' },
    { band: 'nfhl', match: { codes: [2] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'FEMA special flood hazard area (report only)', src: 'ours (reVX has no floodplain row; weight 1, as pnas-wu2023)' },
  ],
  region: { band: 'state', barrier_codes: [0], src: 'ours (state 0 = outside CONUS land; national, as tm-default)' },
  regions: {
    band: 'isoreg',
    sets: { TEPPC: 'TEPPC', CAISO: 'SCE', NYISO: 'SCE', ISONE: 'SCE', PJM: 'SCE', MISO: 'MISO', SPP: 'MISO', ERCOT: 'Southeast', Southeast: 'Southeast' },
    default: 'TEPPC',
    src: 'Lopez et al. 2025 p.34 Table 11 header: SCE (CAISO, NYISO, ISONE, PJM), MISO (SPP), Southeast (ERCOT), TEPPC; the Western ISO names and Southeast take their own set; a cell with no BA takes TEPPC = ours',
  },
  markups: [],
  uncertainty: CLASS5,
  length: 'routed',
  length_factor: {
    tiers: [{ lt_mi: 3, x: 1.5 }, { le_mi: 10, x: 1.2 }],
    src: `${RX} config/constants.py L16-23 (SHORT_MULT 1.5 below 3 mi, MEDIUM_MULT 1.2 to 10 mi); step tiers are reVX's "intended original" (trans_cap_costs.py L1944-1948); reVX's default is linear (L1309, L1966-1971)`,
  },
  tribal: TRIBAL,
  notes: [
    NO_ROW_LAND,
    'Routing weights are the TEPPC multipliers everywhere; the regional base cost and multiplier sets affect cost only (reVX routes on $ x (1 + barrier), trans_cap_costs.py L396-400).',
    'The TEPPC base cost excludes ROW and the other regional sets include it (reVX config README L24-26); no ROW land is added.',
    'Left out: the SWCA risk 4 exclusion (no band) and the SWCA mitigation $ per mile (Lopez et al. 2025 p.34; the engine mitigation is a percentage).',
    'reVX CONUS barrier and friction layers are not published (README L118-150), so there are no tribal, military or airfield rows.',
    'No markups or contingency: reVX adds none. Short-line factors use reVX step tiers; its default is linear.',
    'Apart from GAP 1 land, routes weigh no tribal, military or other protected land. No HVDC line type: reVX models none.',
  ],
};

// ─── bv-2014 ──────────────────────────────────────────────────────────────────

const BVP = 'B&V 2014 (WECC TEPPC)';
const BV_T25 = `${BVP} p.2-6 Table 2-5 Terrain Cost Multipliers, WECC column; routing weight = the cost multiplier is ours (B&V gives costs only); one terrain multiplier per cell, the larger where land cover and slope both apply = ours (group max)`;
const BV_TERM = (kv: string, base: string, perPos: string): string =>
  `${BVP} ${kv} kV: p.3-2 Table 3-1 (base ${base}), p.3-3 Table 3-2 (breaker-and-a-half 1.5), p.4-7 Table 4-6 (per-position ${perPos}); × 1.175 AFUDC + overhead from p.4-8 §4.4 and Table 4-7, applied here because the engine's markups skip terminals; 6 positions and count 2 (one per end) = ours`;

const bvLine = (label: string, kv: number, usd: number, term: TerminalRule): LineType => ({
  label,
  kv: { value: kv, src: `nominal voltage class of this line type (${label})` },
  base_per_mi: { usd, year: 2014, src: `${BV}; p.2-3 Table 2-1` },
  terminals: term,
});

const bvTerrain = (band: BandName, match: Match, x: number, note: string, extra = ''): CostRow => ({
  band, match, route_w: x, cost_x: x, group: 'terrain', ref: BV_REF, note, src: `${BV_T25}${extra}`,
});

const BV_SLOPE_NOTE = '; B&V slope 2 %/8 % = 1.15°/4.57°, approximated by our 1°/4° edges (as tm-default)';

const bv2014: RoutePreset = {
  id: 'bv-2014',
  label: 'Black & Veatch 2014 (WECC TEPPC)',
  attribution:
    'Method and values: Black & Veatch 2014, Capital Costs for Transmission and Substations (WECC TEPPC); escalation: MISO MTEP25.',
  caveat: 'Routes are illustrative; B&V gives costs only, so routing on its cost multipliers is ours.',
  dollar_year: 2014,
  escalation: ESCALATION,
  line_types: {
    ac500: bvLine('500 kV AC double circuit', 500, 3_071_750, {
      usd_each: 34_582_007, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6: 500 kV substation base $2,559,250 + 6 positions × 1.5 × $2,985,805 per position = $29,431,495; × 1.175 AFUDC + overhead = $34,582,007',
      src: BV_TERM('500', '$2,559,250', '$2,985,805'),
    }),
    ac345: bvLine('345 kV AC double circuit', 345, 2_150_300, {
      usd_each: 26_187_091, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6: 345 kV substation base $2,132,700 + 6 positions × 1.5 × $2,239,354 per position = $22,286,886; × 1.175 AFUDC + overhead = $26,187,091',
      src: BV_TERM('345', '$2,132,700', '$2,239,354'),
    }),
    ac230: bvLine('230 kV AC double circuit', 230, 1_536_400, {
      usd_each: 17_792_293, year: 2014, min: 2,
      arithmetic: 'B&V 2014 T4-6: 230 kV substation base $1,706,250 + 6 positions × 1.5 × $1,492,903 per position = $15,142,377; × 1.175 AFUDC + overhead = $17,792,293',
      src: BV_TERM('230', '$1,706,250', '$1,492,903'),
    }),
    dc500: bvLine('500 kV HVDC bipole', 500, 1_536_400, {
      usd_each: 541_332_488, year: 2014, min: 2, report_only: true,
      arithmetic: 'B&V 2014 T3-5: 500 kV HVDC converter station, 3,000 MW, $460,708,500; × 1.175 AFUDC + overhead = $541,332,488',
      src: `${BVP} p.3-4 Table 3-5 (500 kV, 3,000 MW converter); × 1.175 from p.4-8 §4.4 and Table 4-7, applied here because the engine's markups skip terminals; count 2, one per end = ours (no source states it); HVDC $ is report-only`,
    }),
  },
  combine: { terrain: 'max' },
  rows: [
    bvTerrain('landcover', { codes: [31] }, 1.05, 'desert'),
    bvTerrain('landcover', { codes: [52, 71] }, 1, 'scrub / flat'),
    bvTerrain('landcover', { codes: [81, 82] }, 1, 'farmland'),
    bvTerrain('landcover', { codes: [41, 42, 43] }, 2.25, 'forested'),
    bvTerrain('slope', { range: [2, 3] }, 1.4, 'rolling hill, 1-4°', BV_SLOPE_NOTE),
    bvTerrain('slope', { range: [4, 8] }, 1.75, 'mountain, 4° and up', BV_SLOPE_NOTE),
    bvTerrain('landcover', { codes: [90, 95] }, 1.2, 'wetland'),
    bvTerrain('landcover', { codes: [11] }, 1.2, 'open water', '; water priced as wetland = ours (B&V has no water row)'),
    bvTerrain('landcover', { codes: [22, 23] }, 1.27, 'suburban', '; NLCD 21 left neutral = ours (as tm-default)'),
    bvTerrain('landcover', { codes: [24] }, 1.59, 'urban'),
    { band: 'aviation', match: { codes: [2, 3, 4, 5, 6] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'Part 77 screening (report only)', src: 'ours (B&V has no aviation row; weight 1, as pnas-wu2023); FAA Form 7460-1 / OE/AAA decides' },
    { band: 'nfhl', match: { codes: [2] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'FEMA special flood hazard area (report only)', src: 'ours (B&V has no floodplain row; weight 1, as pnas-wu2023)' },
  ],
  region: { band: 'state', barrier_codes: [0], src: 'ours (state 0 = outside CONUS land; national, as tm-default)' },
  markups: [MARKUP_AFUDC],
  uncertainty: CLASS5,
  length: 'routed',
  length_factor: {
    tiers: [{ lt_mi: 3, x: 1.5 }, { le_mi: 10, x: 1.2 }],
    src: `${BVP} p.2-5 Table 2-4 Transmission Length Cost Multipliers (< 3 mi 1.50, 3-10 mi 1.20, > 10 mi 1.00; the same in every column)`,
  },
  tribal: TRIBAL,
  notes: [
    NO_ROW_LAND,
    'ROW land is left out: B&V prices ROW by BLM land zone (Table 2-7, p.2-7) and the cube has no BLM-zone band.',
    'Structure type (Table 2-3, p.2-4) is not applied: the base assumes tubular structures at 230 kV and lattice above (Table 2-1), so the multiplier is 1.00 for the base design; conductor is ACSR (Table 2-2, 1.00).',
    'No contingency: B&V costs are "overnight" costs (§4.3, p.4-8). AFUDC + overhead (7.5 % + 10 %, Table 4-7, p.4-8) is a markup on lines and is baked into the terminal and converter costs.',
    'B&V applies one terrain multiplier; taking the larger where land cover and slope both apply is ours. Routing on the cost multipliers is ours: B&V gives costs only. The national region is ours.',
    'No lower-voltage line types: B&V has none below 230 kV.',
    'Routes weigh no tribal, military or protected land: B&V gives costs only.',
  ],
};

// ─── westtec-es ───────────────────────────────────────────────────────────────

const ES_DLG = 'Energy Strategies Transmission Cost Estimator (WestTEC), Line modifiers';
const esTerrain = (band: BandName, match: Match, x: number, note: string): CostRow => ({
  band, match, route_w: x, cost_x: x, ref: ES_REF, note,
  src: `${ES_DLG}: ${note} ${x}, in cost and routing`,
});
const ES_DESIG =
  `per-designation weights 1.2–4.0, baked in, scale 1 (${ES_DLG}); the published screening run shows PAD-US designation ×4; which designation takes which weight is not shown — assumed: the strictest designations take 4.0, the rest 1.2 = ours`;
const esDesig = (bit: number, w: number, note: string): CostRow => ({
  band: 'desig', match: { bit }, route_w: w, cost_x: 1, group: 'protection', ref: ES_REF, note, src: ES_DESIG,
});
const ES_MIL = (note: string, band: 'flags' | 'osm_flags', bit: number): CostRow => ({
  band, match: { bit }, route_w: EXCLUDED_W, cost_x: 1,
  excludable: { link: 'mil', off_w: 100, off_src: 'ours: = tm-default military weight' },
  group: 'military', ref: ES_REF, note,
  src: `${ES_DLG}: Military × (barrier) 1000, routing only; which cells ES reads as military is not shown, ours = PAD-US DOD and OSM landuse=military as tm-default`,
});

const westtecEs: RoutePreset = {
  id: 'westtec-es',
  label: 'WestTEC (Energy Strategies)',
  attribution:
    'An imitation of the WestTEC cost estimator\'s scales (Energy Strategies), applied to TransmissionMap\'s public routing data.',
  caveat:
    'Routes are illustrative, not siting recommendations.',
  dollar_year: 2025,
  escalation: ESCALATION,
  line_types: {
    ...BV_LINES,
    ac500: {
      ...BV_LINES.ac500,
      base_per_mi: {
        usd: 4_180_000, year: 2025,
        src: `Energy Strategies Transmission Cost Estimator (WestTEC), 500 kV base $4.18M/mi; 2025 real dollars (WestTEC report p.iv fn 2)`,
      },
    },
  },
  combine: { military: 'max', protection: 'max' },
  rows: [
    esTerrain('slope', { range: [4, 8] }, 1.75, 'mountain slope (bands baked at 1° / 4°, exactly our bands)'),
    esTerrain('slope', { range: [2, 3] }, 1.4, 'rolling hills slope (bands baked at 1° / 4°, exactly our bands)'),
    esTerrain('landcover', { codes: [41, 42, 43] }, 2.25, 'forested'),
    esTerrain('landcover', { codes: [22, 23, 24] }, 1.59, 'developed'),
    esTerrain('landcover', { codes: [90, 95] }, 1.2, 'wetland'),
    esTerrain('landcover', { codes: [31] }, 1.2, 'barren'),
    esTerrain('landcover', { codes: [82] }, 1, 'cultivated crops'),
    esTerrain('landcover', { codes: [52, 71, 81] }, 1, 'pasture / shrub'),
    esTerrain('osm_flags', { bit: 1 }, 1.3, 'river (open water that is not a lake)'),
    esTerrain('osm_flags', { bit: 0 }, 5, 'lake (a barrier the dialog lists inside cost)'),
    esTerrain('flags', { bit: 2 }, 5, 'airfield (a barrier the dialog lists inside cost; our flag is a 5 km buffer, ES\'s buffer is not shown = ours)'),
    esDesig(7, 4, 'Wilderness or National Park'),
    esDesig(0, 4, 'Wilderness Study Area'),
    esDesig(1, 4, 'National Monument / NCA'),
    esDesig(2, 1.2, 'Inventoried Roadless Area'),
    esDesig(3, 1.2, 'ACEC'),
    esDesig(4, 1.2, 'Wild & Scenic River'),
    esDesig(5, 1.2, 'National Historic/Scenic Trail'),
    esDesig(6, 1.2, 'other special federal area'),
    {
      band: 'flags', match: { bit: 0 }, route_w: 5, cost_x: 1, ref: ES_REF, note: 'tribal land (barrier, routing only)',
      src: `${ES_DLG}: Tribal lands × (barrier) 5, routing only`,
    },
    {
      band: 'adj', match: { field: { shift: 0, mask: 0b11 }, codes: [0, 3] }, route_w: 2, cost_x: 1, ref: ES_REF,
      note: 'off existing transmission (≥ 230 kV, more than 1 cell away)',
      src: `${ES_DLG}: Follow existing transmission × ("cells off an existing line; 1–100, 1 = off"), default 1; the published screening run used 2 = shipped; the target voltage is not shown, ≥ 230 kV assumed = ours; a cell on or next to a line counts as on it (a new line runs beside an existing one), as tm-default's parallel rows = ours`,
    },
    {
      band: 'whpclass', match: { codes: [4, 5] }, route_w: 1.2, cost_x: 1, ref: ES_REF, note: 'high wildfire risk (WHP high, very high)',
      src: `${ES_DLG}: Wildfire × (USFS top quartile) 1.2, routing only; WHP classes high and very high stand in for the top quartile = ours`,
    },
    ES_MIL('military (PAD-US DOD)', 'flags', 1),
    ES_MIL('military (OSM landuse=military)', 'osm_flags', 7),
    { band: 'aviation', match: { codes: [2, 3, 4, 5, 6] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'Part 77 screening (report only)', src: 'ours (the estimator shows no such row; weight 1, as pnas-wu2023); FAA Form 7460-1 / OE/AAA decides' },
    { band: 'nfhl', match: { codes: [2] }, route_w: 1, cost_x: 1, ref: WPP_REF, note: 'FEMA special flood hazard area (report only)', src: 'ours (the estimator shows no such row; weight 1, as pnas-wu2023)' },
  ],
  region: { band: 'state', barrier_codes: [0], src: 'ours (state 0 = outside CONUS land; national, as tm-default)' },
  markups: [],
  uncertainty: CLASS5,
  length: 'routed',
  tribal: TRIBAL,
  notes: [
    NO_ROW_LAND,
    'How the estimator stacks several modifiers on one cell is not shown; multiplicative is assumed = ours (rows outside the military and protection groups multiply).',
    'PAD-US designation weights are assumed: the estimator shows only "1.2–4.0" and a ×4 screening result, so the strictest designations take 4.0 and the rest 1.2 = ours.',
    'Follow existing transmission: the target voltage is not shown, ≥ 230 kV is assumed = ours; ×2 is the published screening run.',
    'The airfield buffer is our 5 km flag; the estimator\'s buffer is not shown = ours.',
    'Barriers apply to new lines (the estimator\'s routing summary).',
    'Base costs for the other line types and all terminals are the TransmissionMap default\'s (B&V 2014; 500 kV terminals from Wu 2023; 69–161 kV from B&V 2014 × MISO MTEP26 ratios) = ours (not visible in the tool); only the 500 kV base is read from the estimator and is unverified.',
    'No markups or contingency: the estimator shows a terrain-only estimate.',
  ],
};

export const ROUTE_PRESETS: RoutePreset[] = [tmDefault, pnasWu2023, straightLineQuick, nrelRevx, bv2014, westtecEs];

export const routePreset = (id: string): RoutePreset | undefined => ROUTE_PRESETS.find((p) => p.id === id);
