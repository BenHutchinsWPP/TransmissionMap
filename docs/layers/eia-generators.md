# EIA Generators (Form 860)

One row per generator within a plant. The layer spans the
**full lifecycle** — operating, planned-future, and retired units — partitioned by
`gen_status`:

_Counts approximate, from the EIA-860 2025 early-release build (`eia8602025ER.zip`)._

| `gen_status` | Count | Source sheet | Meaning |
|---|---:|---|---|
| `existing` | ~26,500 | Operable | Operating / standby, no future retirement scheduled |
| `retired` | ~4,800 | Retired and Canceled | Actually retired (`status` RE; canceled units excluded) |
| `proposed` | ~2,500 | Proposed | Planned future additions |
| `retirement` | ~540 | Operable | Operating now, but with a future planned retirement year |

## Source

| | |
|---|---|
| **Provider** | [U.S. Energy Information Administration](https://www.eia.gov/) |
| **Dataset** | [EIA-860 Annual Electric Generator Report](https://www.eia.gov/electricity/data/eia860/) — `eia8602025ER.zip` |
| **Coverage** | US utility-scale plants ≥1 MW nameplate |
| **Vintage** | 2025 (early release) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution requested** | "Source: U.S. Energy Information Administration, Form EIA-860" |
| **Served** | `data/layers/eia_generators.geojson.gz` — gzipped GeoJSON |
| **Built by** | `extract_eia_generators.py` → `data/build/generator_eia.csv` |
| **Raw input** | `data/raw/eia/2___Plant_Y2025.xlsx` + `data/raw/eia/3_1_Generator_Y2025.xlsx` |

## Download pack

`eia-generators.zip` — `eia-generators.geojson` · `eia-generators.csv` · `eia-generators.md` · `disclaimer.txt`

## Processing

- **Joined:** generator sheets (`3_1_Generator_Y2025`) to the plant sheet (`2___Plant_Y2025`)
  for location + NERC/BA + utility/sector metadata
- **Three generator sheets concatenated:** `Operable` (filtered to `status` OP/SB),
  `Proposed`, and `Retired and Canceled` (filtered to `status` RE — canceled units dropped)
- **Computed:** `gen_status` partition (see table above); `mw_range` bucket from
  `nameplate_mw`; point geometry from plant lat/lon
- **Columns kept:** `plant_code`, `plant_name`, `state`, `nerc_region`, `ba_code`,
  `generator_id`, `technology`, `energy_source`, `nameplate_mw`, `mw_range`, `status`,
  `op_year`, `prime_mover`, `retirement_year`, `gen_status`, `utility_name`, `sector_name`

## Fields

| Field | % filled | Example values |
|---|---:|---|
| `plant_code` | 100% | 60539, 59310 (EIA plant ID) |
| `plant_name` | 100% | "McIntosh Combined Cycle Facility", "City of Peru Water Street Generating Sta", "Baker City Solar" |
| `state` | 100% | RI, IA, OH, CA, TX, … (all 50 + DC + PR) |
| `nerc_region` | ~97% | TRE, SERC, RFC, WECC, MRO, NPCC |
| `ba_code` | ~97% | PSCO, MISO, SC, CISO, ERCO, … (66 unique) |
| `utility_name` | 100% | "Alabama Power Co", "El Paso Electric Co" — operator/reporting utility (from plant sheet) |
| `sector_name` | 100% | "Electric Utility", "IPP Non-CHP", "IPP CHP", "Commercial Non-CHP", … |
| `generator_id` | 100% | "T-13", "EMDA", "TROYL" — combine with `plant_code` to identify a unit |
| `technology` | 100% | "Solar Photovoltaic" (7.1k), "Petroleum Liquids" (3.8k), "Conventional Hydroelectric" (3.7k), "Natural Gas Fired Combustion Turbine" (2.2k), "Natural Gas Fired Combined Cycle" (1.9k), "Onshore Wind Turbine" (1.5k), "Landfill Gas", "Batteries" |
| `energy_source` | 100% | SUN (7.1k), NG (6.6k), WAT (3.9k), DFO (3.7k), WND (1.5k), LFG (1.2k), MWH (764), … |
| `nameplate_mw` | 100% | 0.9, 556.2, 801.0 |
| `mw_range` | 100% | `<5`, `5-10`, `10-20`, `20-100`, `100-500`, `500-1000`, `1000+`, `unknown` |
| `status` | 100% | OP (operating), SB (standby), RE (retired), plus EIA proposed codes (e.g. `P`, `V`, `TS`, `U`) |
| `op_year` | 100% | 1982, 2020 — operating/commissioning year. For `proposed` rows it is the **planned online year** (EIA "Effective Year"), so the timeline reads correctly into the future |
| `prime_mover` | 100% | CT (combustion turbine), GT (gas turbine), BA (battery), ST, HY, … |
| `retirement_year` | ~16% | 2025, 2031 — planned (operating units) or actual (retired units) retirement year; blank for `existing`/`proposed` |
| `gen_status` | 100% | `existing` (26.5k), `retired` (4.8k), `proposed` (2.5k), `retirement` (544) — lifecycle partition (see table above) |

## EIA fuel-code key

`SUN`=solar, `WND`=wind, `WAT`=hydro, `NUC`=nuclear, `NG`/`OG`=gas, `DFO`/`RFO`/`KER`=oil,
`BIT`/`SUB`/`LIG`/`PC`=coal, `GEO`=geothermal, `MWH`/`ES`=battery,
`WDS`/`WDL`/`MSW`/`BLQ`/`LFG`/`OBG`=biomass.

## Caveats

- **`gen_status` is the lifecycle key.** Filter on it to separate operating, planned, and
  retired units — the layer is no longer operating-only. This is what makes the
  planned playback/year-filter feature feasible (`op_year` = `year_in`,
  `retirement_year` = `year_out`).
- **Proposed `op_year` = planned online year.** For `gen_status == "proposed"`, `op_year`
  is mapped from EIA's "Effective Year" (the planned commercial-operation year), not the
  report year ("Current Year"). Values run 2007–2031, clustered in the near future — so a
  forward playback timeline would place proposed units at their expected
  COD. A handful of past-year proposed units are delayed/under-construction projects still
  carried in the Proposed sheet.
