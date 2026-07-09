# HIFLD Transmission Lines

HIFLD transmission line segments (US, 69–765 kV).

## Source

| | |
|---|---|
| **Provider** | DHS / CISA — Homeland Infrastructure Foundation-Level Data (HIFLD) |
| **Origin** | Oak Ridge NL (ORNL), Los Alamos NL (LANL), Idaho NL (INL), NGA |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "HIFLD / DHS CISA" |
| **Download origin** | [SeerAI HIFLD Archive](https://source.coop/repositories/seerai/hifld/description/) (source.coop), GeoParquet — **manually placed** at `data/raw/hifld/transmission_lines.parquet` |
| **Served** | `data/layers/hifld_transmission_lines.pmtiles` — PMTiles, zoom 2–11 |
| **Built by** | `extract_hifld_lines.py` → `data/build/transmission_hifld.gpkg` → `tippecanoe -l hifld_transmission_lines` |

> The HIFLD Open portal closed September 16, 2025; datasets have been archived by third parties.
> The SeerAI parquet adds ~23,000 lines at 69 kV and ~4,800 new ≥100 kV lines vs. the prior local HIFLD export.

## Download pack

`hifld-transmission-lines.zip` — `hifld-transmission-lines.geojson` · `hifld-transmission-lines.csv` · `hifld-transmission-lines.md` · `disclaimer.txt`

## Processing

- **Selected:** all line segments from the SeerAI parquet (~94,600 raw features in source)
- **Row filter:** none on output
- **Column repair:** `VAL_DATE` is a corrupted int32 in the SeerAI parquet → **null-coerced**
- **Columns kept:** `ID`, `VOLTAGE`, `VOLT_CLASS`, `TYPE`, `STATUS`, `OWNER`, `SUB_1`,
  `SUB_2`, `INFERRED`, `VAL_DATE`

## Fields

_Counts approximate, from the SeerAI HIFLD archive snapshot (`transmission_lines.parquet`)._

| Field | % filled | Example values |
|---|---:|---|
| `ID` | 100% | `141176` (HIFLD object ID) |
| `VOLTAGE` | 100% | 115 (21k), 138 (14k), 230 (7.1k), 161 (4.5k), 345 (2.5k), 500 (795), 765 (46) |
| `VOLT_CLASS` | 100% | `100-161`, `220-287`, `345`, `500`, `735 And Above` |
| `TYPE` | 100% | "AC; OVERHEAD" (50k), "OVERHEAD" (1.4k), "AC; UNDERGROUND" (281), "DC; OVERHEAD" (5). UNDERGROUND drives dashed rendering + Line placement filter |
| `STATUS` | 100% | "IN SERVICE" (41k), "NOT AVAILABLE" (11k), "INACTIVE" (53), "UNDER CONSTRUCTION" (11), "PROPOSED" (1) |
| `OWNER` | 100% | "MIDWEST ENERGY INC", "WHEAT BELT PUBLIC POWER DIST" |
| `SUB_1`, `SUB_2` | 100% | Terminal substation names. Mostly `UNKNOWN######` / `TAP######` placeholders |
| `INFERRED` | 100% | `N` / `Y` — whether geometry was inferred by HIFLD |
| `VAL_DATE` | 100% | "2014-12-16" — last validation date |

## Caveats

- `SUB_1` / `SUB_2` are dominated by HIFLD's internal placeholders (`UNKNOWN`, `TAP`,
  `DEADEND`, `RISER`). Use them only after filtering those prefixes.
- SeerAI `SUB_1`/`SUB_2` names are noisier than the original HIFLD export.
- Validation dates run through June 2021.
