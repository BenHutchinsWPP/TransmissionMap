// Route cube band → source dataset, for the Method tab's "Map data from" column.
// Role: pure data. `bandData(band, match)` names the dataset that marks the cells a row's
//       `match` selects: a label (publisher + dataset + vintage, short), a vintage, and
//       `tokens` — words the cube's own source text (grid.json `pd_band_sources` /
//       `osm_band_sources`) must contain, checked against the real cube by
//       assets/route/band-data.validate.test.ts so a rebuild with new vintages fails loudly.
//       Written from the cube's source text (grid.json); tokens come only from the string literals
//       of the build scripts (build_route_bands/restrict/flags/costbands/structures/wetland/buildings*.py).
//       Bit-matched bands (flags, flags2, desig, osm_flags, and protect bit 7 through PROTECT_DATA) have one entry per bit and no band
//       fallback: an unknown bit throws.
// Deps: type-only import of BandName/Match from route-presets.ts. No side effects.

import { isUploadBand, type BandName, type Match, type UploadBand } from './route-presets.js';

export interface BandData { label: string; vintage: string; tokens: string[] }

const d = (label: string, vintage: string, tokens: string[]): BandData => ({ label, vintage, tokens });

export type BitBand = 'flags' | 'flags2' | 'desig' | 'osm_flags';

/** One entry per bit, for every band a row selects by bit. */
export const BIT_DATA: Record<BitBand, Record<number, BandData>> = {
  flags: {
    0: d('Census AIANNH + BIA tribal lands', '2026', ['AIANNH', 'BIA']),
    1: d('PAD-US DOD + DoD MIRTA', 'PAD-US 4.1; MIRTA', ['PAD-US', 'MIRTA']),
    2: d('FAA airports and runways (5 km)', 'FAA ADDS', ['FAA', 'ADDS']),
    3: d('USFWS critical habitat (Final)', 'USFWS ECOS', ['USFWS', 'CRITHAB']),
    4: d('DOE/ANL Section 368 corridors', 'Section 368', ['Section', '368']),
    5: d('WorldPop 2020 population density', 'WorldPop 2020', ['WorldPop', '2020']),
    6: d('PAD-US 4.1 state and local parks', 'PAD-US 4.1', ['PAD-US', '4.1']),
    7: d('NID dams + FCC ASR towers', 'NID; FCC ASR', ['NID', 'ASR']),
  },
  flags2: {
    0: d('BLM sage-grouse RODs 2025–26', 'BLM GRSG ROD Feb 2026', ['GRSG', 'Feb 2026']),
    1: d('BLM sage-grouse RODs 2025–26', 'BLM GRSG ROD Feb 2026', ['GRSG', 'Feb 2026']),
    2: d('EPA EnviroAtlas floodplain 2019', 'EnviroAtlas 2019', ['EnviroAtlas', '2019']),
    3: d('HIFLD schools, hospitals, care homes', 'HIFLD mirror (source.coop)', ['public_schools', 'hospitals']),
    4: d('NPS National Register (NRHP)', 'NPS nrhp_locations', ['NPS', 'nrhp']),
    5: d('EPA Superfund NPL sites', 'EPA NPL', ['EPA', 'NPL']),
    6: d('USFWS CBRS units', 'CBRS Mapper', ['CBRS', 'USFWS']),
    7: d('USACE FUDS munitions sites', 'HIFLD mirror (source.coop)', ['FUDS', 'USACE']),
  },
  desig: {
    0: d('PAD-US 4.1 (WSA)', 'PAD-US 4.1', ['PAD-US', '4.1']),
    1: d('PAD-US 4.1 (NM, NCA)', 'PAD-US 4.1', ['PAD-US', '4.1']),
    2: d('USFS roadless areas (PAD-US 4.1)', 'PAD-US 4.1', ['Roadless', '4.1']),
    3: d('PAD-US 4.1 (ACEC)', 'PAD-US 4.1', ['PAD-US', '4.1']),
    4: d('rivers.gov Wild & Scenic + PAD-US', 'rivers.gov; PAD-US 4.1', ['rivers.gov', 'Scenic']),
    5: d('NPS National Trails System', 'NPS NHT/NST', ['NPS', 'Trails']),
    6: d('PAD-US 4.1 (RNA/SDA/NSBV/HCA/NRA)', 'PAD-US 4.1', ['PAD-US', '4.1']),
    7: d('PAD-US 4.1 (WA, SW, NP)', 'PAD-US 4.1', ['PAD-US', 'Fee']),
  },
  osm_flags: {
    0: d('OpenStreetMap lakes (natural=water)', 'OSM 2026-10', ['natural=water']),
    1: d('OpenStreetMap waterway=river', 'OSM 2026-10', ['waterway=river']),
    2: d('OSM + HIFLD lines, 230 kV and up', 'OSM 2026-10; HIFLD frozen', ['HIFLD', '230 kV']),
    3: d('OSM + HIFLD lines, 100–229 kV', 'OSM 2026-10; HIFLD frozen', ['HIFLD', '100-229 kV']),
    4: d('OpenStreetMap major roads', 'OSM 2026-10', ['highway=motorway']),
    5: d('BTS North American Rail Network', 'NARN 2026', ['NARN', 'BTS']),
    6: d('HIFLD gas lines + OSM pipelines', 'OSM 2026-10; HIFLD frozen', ['HIFLD', 'pipelines']),
    7: d('OpenStreetMap landuse=military', 'OSM 2026-10', ['landuse=military']),
  },
};

/** Bands that carry one dataset for every match. */
export const BAND_DATA: Partial<Record<Exclude<BandName, UploadBand>, BandData>> = {
  landcover: d('NLCD 2025 (MRLC/USGS)', 'Annual NLCD C1V2 2025', ['NLCD', '2025']),
  slope: d('USGS 3DEP 1 arc-second DEM', '3DEP 1 arc-second', ['3DEP', 'arc-second']),
  agency: d('PAD-US 4.1 (USGS)', 'PAD-US 4.1', ['PAD-US', '4.1']),
  wildfire: d('USFS Wildfire Hazard Potential 2023', 'WHP 2023', ['WHP', '2023']),
  whpclass: d('USFS Wildfire Hazard Potential 2023', 'WHP 2023', ['WHP', '2023']),
  state: d('Census cartographic boundaries 1:500k', 'Census 500k', ['Census', '500k']),
  isoreg: d('EIA Balancing Authorities', 'EIA BA', ['EIA', 'Balancing']),
  landval: d('USDA NASS Census of Agriculture 2022', 'Census of Agriculture 2022', ['NASS', '2022']),
  bldg: d('FEMA/ORNL USA Structures', 'USA Structures 2025–26', ['FEMA', 'Structures']),
  built: d('FEMA/ORNL USA Structures, observed footprints', 'Imagery dates vary by source area', ['FEMA', 'Structures']),
  nonres: d('USA Structures (FEMA/ORNL), nonresidential', 'Imagery dates vary by source area', ['FEMA', 'Structures']),
  bldgunk: d('USA Structures (FEMA/ORNL), unknown class', 'Imagery dates vary by source area', ['FEMA', 'Structures']),
  aviation: d('FAA NTAD airports, Part 77 screening', 'NTAD effective 2026/10/29', ['FAA NTAD', '2026/10/29']),
  nfhl: d('FEMA National Flood Hazard Layer', 'NFHL_Key_Layers_202610', ['FEMA National Flood Hazard Layer', '202610']),
  wetland: d('USFWS National Wetlands Inventory', 'NWI 2026', ['USFWS', 'Wetlands']),
  osm_maxkv: d('OSM + HIFLD existing lines (kV)', 'OSM 2026-10; HIFLD frozen', ['OpenStreetMap']),
  adj: d('Rings around OSM + HIFLD lines', 'OSM 2026-10; HIFLD frozen', ['OpenStreetMap']),
};

/** An uploaded layer's rows (`upl_<hash>`): the visitor's file, so no cube source text to check; the Method tab
 *  names the row "uploaded layer: <label>" from the row's own label. */
export const UPLOAD_DATA: BandData = d('Uploaded layer', 'Visitor file', []);

/** `protect` holds three datasets: GAP status (field shift 0), TNC category (field shift 4) and NPS units named Preserve (bit 7). */
export const PROTECT_DATA = {
  gap: d('PAD-US 4.1 GAP status (USGS)', 'PAD-US 4.1', ['PAD-US', '4.1']),
  tnc: d('PoPWest exclusions (TNC et al.)', 'PoPWest EnvExclusions', ['PoPWest', '7460026']),
  preserve: d('PAD-US 4.1 Fee (NPS units named Preserve)', 'PAD-US 4.1', ['PAD-US', 'Preserve']),
};

/** The dataset that marks the cells `match` selects in `band`. Bit-matched flags/flags2/desig/osm_flags rows: the
 *  bit's own entry, never a band fallback (throws for an unknown bit so the coverage test fails). */
export function bandData(band: BandName, match: Match): BandData {
  if (band === 'flags' || band === 'flags2' || band === 'desig' || band === 'osm_flags') {
    if (!('bit' in match)) throw new Error(`band data: ${band} row without a bit match`);
    const e = BIT_DATA[band][match.bit];
    if (!e) throw new Error(`band data: no entry for ${band} bit ${match.bit}`);
    return e;
  }
  if (band === 'protect') {
    if ('field' in match && match.field.shift === 0) return PROTECT_DATA.gap;
    if ('field' in match && match.field.shift === 4) return PROTECT_DATA.tnc;
    if ('bit' in match && match.bit === 7) return PROTECT_DATA.preserve;
    throw new Error('band data: protect row outside the GAP / TNC fields or bit 7');
  }
  if (isUploadBand(band)) return UPLOAD_DATA;
  const e = BAND_DATA[band];
  if (!e) throw new Error(`band data: no entry for ${band}`);
  return e;
}

export const bandDataLabel = (band: BandName, match: Match): string => bandData(band, match).label;
