# WestTEC 10 Yr

Transmission portfolio from the [WestTEC: West-Wide Transmission Study, 10-Year
Horizon Report](https://www.westernpowerpool.org/) (Western Power Pool). Panel
group: Transmission.

## Source

| | |
|---|---|
| **Provider** | WestTEC, a [Western Power Pool](https://www.westernpowerpool.org/) initiative |
| **Dataset** | 10-Year Horizon Report — Planned Projects + Identified Upgrades shapefiles (February 2026 release; DBF `DATE_LAST_UPDATE` = 2026-02-19) |
| **Served** | `data/layers/westtec_10yr.geojson.gz` |
| **Built by** | `scripts/extract_westtec.py` → `build_tiles.py` |
| **Download** | Auto-downloaded by the extract script to `data/raw/westtec/` (gitignored):<br>`https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Identified%20Upgrades.zip`<br>`https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Planned%20Projects.zip` |

## Build

Two source shapefiles merged into one layer. The `dataset` field records the
origin: `planned` (Planned Projects) or `identified` (Identified Upgrades).

No download pack ships — the layer links out to the WPP source (marked
`skip: true` in `release_manifest.yaml`), so the authoritative copy is always
westernpowerpool.org.

## Fields

108 features (70 planned, 38 identified).

| Field | % filled | Example values |
|---|---|---|
| `name` | 100% | "Gateway West: Cedar Hill to Midpoint (Segment E)" |
| `dataset` | 100% | "planned" (70), "identified" (38) |
| `scenario` | 100% | "Base Case" (70), "IDA" (17), "SRA" (16), "Congestion" (5) |
| `upgrade_type` | 100% | "New Line" (82), "Reconductor" (12), "Rebuild" (7), "Uprate" (4), "Rebuild Double Ckt" (2), "Series Cap Upgrade" (1) |
| `voltage_kv` | 100% | 500 (73), 345 (27), 230 (5), 525 (2), 600 (1) |
| `line_type` | 65% | "AC" (65), "DC" (5) — planned rows only; null on all 38 identified rows |
| `length_mi` | 100% | 62.3 — per-segment length, not per-project |

Geometry is per-segment: the 108 features represent ~78 named projects (count
distinct `name`, not features).

## Categorical views

"Color by" toggle (`state.westtecColorBy`, expression from `westtecColorExpr()`
in `src/colors/buckets.ts`) between two views, each with its own legend and
filter chip panel:

- **Scenario** (`WESTTEC_SCENARIO_BUCKETS`) — colors by `scenario`.
- **Project Type** (`WESTTEC_DATASET_BUCKETS`) — colors by `dataset`.

Every feature has a real value for both fields, so neither bucket set needs an
"other" catch-all.
