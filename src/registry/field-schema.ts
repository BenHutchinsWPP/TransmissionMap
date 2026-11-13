// Declarative per-dataset field schema: for each dataset built by
// scripts/tile_manifest.yaml, the fields a filter UI or query builder can
// safely target, their type, the comparison operators that make sense for
// them, and — where the domain is closed — the exact codes/categories a
// value can take.
//
// Pure data plus its types; no runtime logic. src/registry/condition-compile.ts
// compiles a condition array against this schema into a MapLibre filter
// expression, and assets/filters.ts routes seven live legend filters through
// it (see BUCKET_FILTER_DATASETS). Dataset keys are the `id` values from
// scripts/tile_manifest.yaml; field keys are drawn from that dataset's
// `select:` list, so every entry here has a build-time guarantee the field
// reaches the tiles/GeoJSON the frontend reads.
//
// Deps: src/registry/region-codes.ts (generated region domains),
// src/colors/facets.ts, for four closed value-sets flattened from the
// legend facets' value maps (substance, NERC code, retail territory type, EIA
// sector), and
// src/colors/fuel.ts for the OSM source / EIA energy_source fuel values — kept
// in sync with the legend filters and their map colors by construction
// instead of a second, driftable copy.
//
// A few filters keep their own bespoke builders in assets/filters.ts instead
// of a schema entry here: the pumped-storage carve-out, the year filter's
// NA→0/9999 sentinel handling, the kV bucket ranges (KV_BUCKET_RANGES in
// src/colors/buckets.ts), the underground
// negation, and the NWS group filter's feature-state half.
//
// Also left out: other fields on datasets with no `select:` allow-list in
// tile_manifest.yaml (tribal_lands `area_type`, osm_pipelines_points
// `pipeline`) — those datasets keep every column, so there is no allow-list
// for a schema key to line up against. The built-elsewhere datasets (mines,
// dc_moratoriums) carry a `select:` naming what their script writes. The NWS
// live-alert `_group` field isn't built via tile_manifest.yaml at all.
//
// Region fields are the exception: every tagged asset dataset declares the
// `|…|`-wrapped region lists scripts/region_join.py writes (states, counties,
// ba, nerc, retail on US data; countries, admin1 and the US keys on world
// data), including datasets without a `select:` and the built-elsewhere
// `mines` / `nrel_hydrothermal_points`. Their source of truth is the pipeline
// (build_global_tiles.py field lists, the Makefile region-tags recipe), which
// scripts/test_field_schema.py checks both ways. A region field is a `list`
// field, filtered only by exact code with `contains` / `contains_any`; its
// domain is a closed list from the generated region-codes.ts or, for the
// large kinds, a `pattern`. Each region field is its own `name: CONSTANT,`
// line and every `pattern` lives in the shared consts above FIELD_SCHEMA —
// the test's scanner reads neither spreads nor regex literals.
// REGION_FIELD_DEFS names the seven shared defs by field, for the Area
// filter's validateArea() (view-validate.ts).
//
// Every field also carries its role, which a visualization template binds to
// instead of a field name (src/registry/field-roles.ts adds what a schema entry
// cannot hold: geometry, label, display-field roles, legend facets):
//   category — a code or name to group by (closed when `values` is set);
//   measure  — a number with a `unit`; `additive: false` (kV) is never summed;
//   time     — a year or date (`time`); a string time field is free text whose
//              year is the first YEAR_IN_TEXT match;
//   region   — a `|code|` region list (`list`).
// `id` and `label` roles belong to registry and display fields (field-roles.ts).
// A field with `ops: []` reaches rows and templates but takes no condition.

import { facet, facetValueMap } from '../colors/facets.js';
import { OSM_FUEL_MAP, EIA_FUEL_MAP } from '../colors/fuel.js';
import { STATE_CODES, BA_CODES, COUNTRY_CODES } from './region-codes.js';

// Every value a legend facet's buckets match: the field's closed domain.
const facetValues = (key: string): string[] => Object.values(facetValueMap(facet(key))).flat();

type FieldType = 'string' | 'number' | 'boolean';
export type FieldRole = 'category' | 'measure' | 'time' | 'id' | 'label' | 'region';
export type FieldOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not_in' | 'contains' | 'contains_any' | 'has';

export interface FieldDef {
  type: FieldType;
  ops: FieldOp[];
  values?: readonly string[];  // present only when the domain is closed
  pattern?: RegExp;       // the shape of every value, for a domain too large to list
  list?: boolean;         // a `|code|code|` list: `contains` / `contains_any` only
  description?: string;
  role?: FieldRole;
  unit?: string;          // a measure's unit: 'MW', 'kV', 'MWh', 'mi', 'acres', 'customers', 'sqft', …
  additive?: false;       // a measure that must not be summed (a level such as kV)
  time?: 'year' | 'date'; // a time field's granularity
}

// ─── Shared shapes ─────────────────────────────────────────────────────────
const CATEGORY_OPS: FieldOp[] = ['=', '!=', 'in', 'not_in'];
const RANGE_OPS: FieldOp[] = ['=', '!=', '<', '<=', '>', '>='];

const KV_LEVEL = (description: string): FieldDef =>
  ({ type: 'number', ops: RANGE_OPS, description, role: 'measure', unit: 'kV', additive: false });

const category = (description: string, values?: readonly string[]): FieldDef =>
  ({ type: 'string', ops: CATEGORY_OPS, description, role: 'category', ...(values && { values }) });

const measure = (unit: string, description: string): FieldDef =>
  ({ type: 'number', ops: RANGE_OPS, description, role: 'measure', unit });

// A year as free text (no condition; its year is the first YEAR_IN_TEXT match).
const textYear = (description: string): FieldDef =>
  ({ type: 'string', ops: [], description, role: 'time', time: 'year' });

const KV_FIELD = KV_LEVEL('Nominal voltage class, in kV; a value of 0 or less means unknown and matches no kV test except != and not_in.');
const OUTPUT_MW_FIELD = measure('MW', 'Rated output capacity, in MW.');
const OSM_SOURCE_FIELD = category('OSM power-generation source tag.', Object.values(OSM_FUEL_MAP).flat());
// OSM start_date: free text; no condition (its text does not order).
const OSM_START_DATE_FIELD = textYear('OSM start_date tag, free text; its year is the first YEAR_IN_TEXT match.');

/** A date condition's value: `YYYY-MM-DD`. */
const ISO_DATE = /^(?:18|19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** The year in a free-text date: the first standalone four-digit 1800–2099
 *  ("2019", "2019-05", "05/2019", "~1955"; in "1955;2001" the first wins). */
export const YEAR_IN_TEXT = /(?<!\d)((?:18|19|20)\d\d)(?!\d)/;

// ─── Region fields (scripts/region_join.py) ────────────────────────────────
// Exact-code lists; `none` (no region, or the key absent) is in every domain.
const REGION_OPS: FieldOp[] = ['contains', 'contains_any'];
const region = (description: string, domain: { values: readonly string[] } | { pattern: RegExp }): FieldDef =>
  ({ type: 'string', ops: REGION_OPS, list: true, description, role: 'region', ...domain });

const STATES_FIELD = region('US states and territories (USPS code).', { values: [...STATE_CODES, 'none'] });
const COUNTIES_FIELD = region('US counties (5-digit GEOID).', { pattern: /^(?:\d{5}|none)$/ });
const BA_FIELD = region('Balancing authorities (EIA code).', { values: [...BA_CODES, 'none'] });
const NERC_FIELD = region('NERC reliability regions.', { values: [...facetValues('nerc'), 'none'] });
const RETAIL_FIELD = region('Retail electric service territories (EIA utility id).', { pattern: /^(?:(?:NA)?\d{1,6}(?:_\d+)?|none)$/ });
const COUNTRIES_FIELD = region('Countries (ISO 3166-1 alpha-3, or a numeric disputed unit).', { values: [...COUNTRY_CODES, 'none'] });
const ADMIN1_FIELD = region('First-level subdivisions (scripts/admin1_codes.csv code).', { pattern: /^(?:[0-9A-Z]{4,5}|none)$/ });

/** Region field name → its shared def: what an Area filter's codes of that
 *  kind (src/registry/area-filter.ts) are checked against. */
export const REGION_FIELD_DEFS: Readonly<Record<string, FieldDef>> = {
  states: STATES_FIELD, counties: COUNTIES_FIELD, ba: BA_FIELD, nerc: NERC_FIELD,
  retail: RETAIL_FIELD, countries: COUNTRIES_FIELD, admin1: ADMIN1_FIELD,
};

export const FIELD_SCHEMA: Record<string, Record<string, FieldDef>> = {
  eia_generators: {
    energy_source: category('EIA Form 860 fuel-type code.', Object.values(EIA_FUEL_MAP).flat()),
    gen_status: category('Generator lifecycle status.', ['existing', 'retirement', 'retired', 'proposed']),
    status: category('EIA Form 860 status code: OP operating, SB standby, RE retired; proposed P, L, T, U, V, TS, OT.', ['OP', 'SB', 'RE', 'P', 'L', 'T', 'U', 'V', 'TS', 'OT']),
    prime_mover: category('EIA Form 860 prime mover code (PV, IC, HY, GT, ST, WT, BA, CT, CA, PS, …).'),
    sector_name: category('EIA Form 860 ownership sector.', facetValues('sector')),
    nameplate_mw: OUTPUT_MW_FIELD,
    op_year: {
      type: 'number',
      ops: RANGE_OPS,
      description: 'Year the unit began commercial operation.',
      role: 'time', time: 'year',
    },
    retirement_year: {
      type: 'number',
      ops: RANGE_OPS,
      description: 'Year the unit retired or plans to retire; unset for most units.',
      role: 'time', time: 'year',
    },
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },

  osm_plants_points: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
    start_date: OSM_START_DATE_FIELD,
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_plants_polygons: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
    start_date: OSM_START_DATE_FIELD,
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_generators: {
    source: OSM_SOURCE_FIELD,
    output_mw: OUTPUT_MW_FIELD,
    gen_method: category('OSM generator:method tag (wind_turbine, photovoltaic, combustion, …); set on ~97 %.'),
    gen_type: category('OSM generator:type tag (horizontal_axis, solar_photovoltaic_panel, gas_turbine, …); set on ~89 %.'),
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },

  osm_substations_points: {
    nominal_kv: KV_FIELD,
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_substations_polygons: {
    nominal_kv: KV_FIELD,
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_transmission_lines: {
    nominal_kv: KV_FIELD,
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },
  hifld_substations: {
    max_kv: KV_FIELD,
    min_kv: KV_LEVEL('Lowest voltage at the substation, in kV; set on ~64 %.'),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  hifld_transmission_lines: {
    VOLTAGE: KV_FIELD,
    VOLT_CLASS: category('HIFLD voltage class.',
      ['UNDER 100', 'SUB 100', '100-161', '220-287', '345', '500', '735 AND ABOVE', 'DC', 'NOT AVAILABLE']),
    STATUS: category('HIFLD line status.', ['IN SERVICE', 'UNDER CONSTRUCTION', 'INACTIVE', 'NOT AVAILABLE']),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },

  hifld_natgas_lines: {
    pipe_type: category('HIFLD natural-gas pipeline class.', ['Interstate', 'Intrastate', 'HGL', 'Gathering']),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },
  railroads: {
    NET: category('FRA network class: M main, O other, Y yard, I industrial, S siding, X out of service, A abandoned, T transit, R removed (rail-trail), F ferry.', ['M', 'O', 'Y', 'I', 'S', 'X', 'A', 'T', 'R', 'F']),
    RROWNER1: category('Primary rail owner, by reporting mark (e.g. BNSF, UP).'),
    PASSNGR: category('Passenger service code; absent on freight-only track.'),
    STATEAB: category('Two-letter state or province abbreviation.'),
    DIVISION: category('Operating division.'),
    SUBDIV: category('Subdivision name.'),
    BRANCH: category('Branch or line name.'),
    TRACKS: { ...measure('tracks', 'Number of tracks; 0 means not recorded.'), additive: false },
  },
  hifld_natgas_points: {
    fac_type: category('HIFLD natural-gas / petroleum facility type.', ['lng_terminal', 'underground', 'spr', 'trading_hub', 'processing', 'border_cross', 'peak_shaving', 'lng_storage', 'pol_terminal']),
    status: category('Facility status as the source records it (IN SERVICE, Active, ACTIVE, Inactive, …).'),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_pipelines_lines: {
    substance: category('OSM pipeline contents tag, grouped by generator-fuel type.', facetValues('substance')),
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },

  mines: {
    cat: category('Commodity group from the MSHA primary SIC.', facetValues('mines')),
    status: category('MSHA mine status, collapsed: active (active, intermittent, new) or retired.', facetValues('minesStatus')),
    employees: measure('employees', 'Peak quarterly average employment.'),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  // Region-tagged with no other schema field.
  nrel_hydrothermal_points: {
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  ogf_planned_transmission: {
    Status: category('Project status.', facetValues('ogfStatus')),
    Work: category('New line, or work on an existing one.', facetValues('ogfWork')),
    Region: category('Planning region (an RTO, WECC, or a non-RTO area; several joined by ", ").'),
    Type: category('Type of work (new circuit, rebuild, reconductor, upgrade; several joined by "; ").'),
    MaxVolt: KV_LEVEL('Highest voltage of the project, in kV.'),
    Length_mi: measure('mi', 'Line length, in miles, reported or estimated (LengthSrc).'),
    EstYear: textYear('Estimated in-service year; "0" when not given.'),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },
  westtec_10yr: {
    scenario: category('WestTEC study scenario.', facetValues('westtecScenario')),
    dataset: category('Planned project or identified upgrade.', facetValues('westtecDataset')),
    upgrade_type: category('Type of upgrade (New Line, Reconductor, Rebuild, Uprate, …).'),
    voltage_kv: KV_LEVEL('Line voltage, in kV.'),
    line_type: category('AC or DC; set on the planned projects only.', ['AC', 'DC']),
    length_mi: measure('mi', 'Line length, in miles.'),
    states: STATES_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
  },
  osm_datacenters: {
    start_date: OSM_START_DATE_FIELD,
    im3_sqft: measure('sqft', 'Floor area from the IM3 Data Center Atlas, in square feet; set on ~30 % of sites.'),
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },
  osm_pipelines_points: {
    countries: COUNTRIES_FIELD,
    admin1: ADMIN1_FIELD,
    counties: COUNTIES_FIELD,
    ba: BA_FIELD,
    nerc: NERC_FIELD,
    retail: RETAIL_FIELD,
  },

  nerc_regions: {
    code: category('NERC reliability region abbreviation.', facetValues('nerc')),
  },
  control_areas: {
    tot_cap: measure('MW', 'Total generating capacity, in MW; 0 or empty where unreported (~20 %).'),
    peak_ld: measure('MW', 'Peak load, in MW; 0 or empty where unreported (~20 %).'),
    min_ld: measure('MW', 'Minimum load, in MW; 0 or empty where unreported (~20 %).'),
    avail_cap: measure('MW', 'Available capacity, in MW; 0 or empty where unreported (~20 %).'),
  },
  county_boundaries: {
    STUSPS: category('State or territory (USPS code).'),
    STATE_NAME: category('State or territory name.'),
  },
  us_zcta: {
    zcta5: category('Five-digit ZIP Code Tabulation Area code, a zero-padded string.'),
  },
  bia_tribal_lands: {
    AGENCY: category('BIA agency that administers the land area.'),
  },
  boem_wind_leases: {
    type: category('Lease type.', ['Commercial', 'Easement', 'Research']),
    state: category('State or states the lease lies off, free text (e.g. "CA", "Rhode Island / Massachusetts").'),
    company: category('Leaseholder.'),
    acres: measure('acres', 'Lease area, in acres.'),
    date: textYear('Lease date, free text MM/DD/YYYY; its year is the first YEAR_IN_TEXT match.'),
  },
  wecc_paths: {
    status: category('Catalog status of the path (markers only).', ['Revised', 'Added', 'Active']),
    rating_category: category('Catalog rating type (markers only).', ['Accepted Rating', 'Existing Rating', 'Other Rating']),
    mw_fwd: { ...measure('MW', 'Transfer limit in the forward direction (dir_fwd); null when not rated. Limits of different paths are not additive.'), additive: false },
    mw_rev: { ...measure('MW', 'Transfer limit in the reverse direction (dir_rev); null when not rated. Limits of different paths are not additive.'), additive: false },
  },
  us_states: {
    name: category('State or territory name.'),
  },
  countries: {
    name: category('Country or territory name.'),
  },
  admin1_boundaries: {
    country: category('Country the first-level subdivision belongs to.'),
    iso_a3: category('Country code (ISO 3166-1 alpha-3, or a numeric disputed unit).'),
  },
  tribal_lands: {
    area_type: category('Census tribal area type.', facetValues('tribal')),
    recognized: category('Federal or state recognition, derived from the Census feature class.', ['Federal', 'State']),
    acres_land: measure('acres', 'Land area, in acres.'),
  },
  eia_ba: {
    area_sqmi: measure('sq mi', 'Balancing authority area, in square miles.'),
  },
  retail_territories: {
    type: category('Retail electric service territory ownership type.', facetValues('retail')),
    customers: measure('customers', 'Retail customers served.'),
    retail_mwh: measure('MWh', 'Annual retail sales, in MWh; set on ~42 % of territories.'),
    sumr_peak: measure('MW', 'Summer peak demand, in MW; set on ~42 % of territories.'),
    wntr_peak: measure('MW', 'Winter peak demand, in MW; set on ~42 % of territories.'),
    hold_co: category('Holding company.'),
    ctrl_area: category('Control area (EIA balancing authority code).'),
  },

  // Context layers (untagged).
  padus: {
    desig: category('PAD-US designation type, decoded (State Park, National Forest, Private Conservation, …).'),
    mng_agency: category('Managing agency.'),
    mng_type: category('Managing agency type (Federal, State, Local Government, …).'),
    own_agency: category('Owning agency.'),
    own_type: category('Owner type (Federal, State, Private, …).'),
    gap: category('GAP status: 1–2 managed for biodiversity, 3 multiple use, 4 no known mandate (here DoD, DOE, USACE and USBR land only).',
      ['1', '2', '3', '4']),
    access: category('Public access.', ['Open Access', 'Restricted Access', 'Closed', 'Unknown']),
    state: category('State or territory (USPS code).'),
    acres: measure('acres', 'GIS area, in acres.'),
    yr_est: textYear('Year established, free text; set on ~38 %.'),
  },
  crithab: {
    listing_st: category('ESA listing status of the species.', facetValues('crithab')),
    status: category('Critical habitat designation: final or proposed.', ['Final', 'Proposed']),
  },

  // One feature per jurisdiction (scripts/moratoriums/build_layer.py).
  dc_moratoriums: {
    kind: category('How the jurisdiction is drawn.', ['state', 'county', 'utility', 'point']),
    level: category('Level of government that adopted it (county, city, township, tribal, utility, state, …).'),
    cls: category('Strongest measure in the jurisdiction: ban > active > pending > ended.', facetValues('dcm')),
    state: category('State (USPS code).'),
    n: measure('measures', 'Number of measures in the jurisdiction.'),
    last_event: {
      // ISO dates order as text, so a range condition (a month or year of a template) reads them.
      type: 'string', ops: ['<', '<=', '>', '>='], pattern: ISO_DATE,
      description: 'Date of the newest dated event, YYYY-MM-DD; set on ~94 %.',
      role: 'time', time: 'date',
    },
  },
};
