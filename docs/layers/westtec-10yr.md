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
| **Stable id** | `fid` — a 12-hex content id derived by `scripts/westtec_ogf.py` (string, promoted); see [§ Stable id](#stable-id) |
| **Region tags** | `states`, `counties`, `ba`, `nerc`, by `make region-tags` — [pipeline.md § Region tags](../pipeline.md#region-tags-scriptsregion_joinpy) |
| **Download** | Auto-downloaded by the extract script to `data/raw/westtec/` (gitignored):<br>`https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Identified%20Upgrades.zip`<br>`https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Planned%20Projects.zip` |

## Build

Two source shapefiles merged into one layer. The `dataset` field records the
origin: `planned` (Planned Projects) or `identified` (Identified Upgrades). A row
identical to an earlier one in every raw field and in its geometry is dropped:
Identified Upgrades lists one "Add a new Mead - Liberty - West Wing 500 kV line"
segment three times, so 108 source rows become 106 features.

No download pack ships — the layer links out to the WPP source (marked
`skip: true` in `release_manifest.yaml`), so the authoritative copy is always
westernpowerpool.org.

## Fields

106 features (70 planned, 36 identified).

| Field | % filled | Example values |
|---|---|---|
| `fid` | 100% | "0e405abc24af" — stable id, see below |
| `name` | 100% | "Gateway West: Cedar Hill to Midpoint (Segment E)" |
| `dataset` | 100% | "planned" (70), "identified" (36) |
| `scenario` | 100% | "Base Case" (70), "IDA" (17), "SRA" (14), "Congestion" (5) |
| `upgrade_type` | 100% | "New Line" (82), "Reconductor" (12), "Rebuild" (7), "Uprate" (4), "Rebuild Double Ckt" (2), "Series Cap Upgrade" (1) |
| `voltage_kv` | 100% | 500 (73), 345 (27), 230 (5), 525 (2), 600 (1) |
| `line_type` | 65% | "AC" (65), "DC" (5) — planned rows only; null on all 36 identified rows |
| `length_mi` | 100% | 62.3 — per-segment length, not per-project |
| `ogf_ids` | 97% | "\|R-0684\|", "\|R-0195\|R-0494\|" — the matching [Our Grid Future](ogf-planned-transmission.md) `RecordID`s, see below |

Geometry is per-segment: the 106 features represent ~78 named projects (count
distinct `name`, not features).

## Categorical views

"Color by" toggle (`state.westtecColorBy`, expression from `westtecColorExpr()`
in `src/colors/facets.ts`, applied by `setColorBy()` in
`assets/style-overrides.ts`) between two views, each with its own legend and
filter chip panel:

- **Scenario** (`WESTTEC_SCENARIO_BUCKETS`) — colors by `scenario`.
- **Project Type** (`WESTTEC_DATASET_BUCKETS`) — colors by `dataset`.

Every feature has a real value for both fields, so neither bucket set needs an
"other" catch-all.

## Stable id

The publisher shapefiles carry no key (`Upgrade_Na`/`Line_Name` repeat across
segments), so `fid` is derived from content: the first 12 hex digits of a sha1
over `dataset`, `scenario`, `name`, `voltage_kv`, `upgrade_type` and the
endpoints of every line part on a 0.01° grid (about 1 km), sorted so a reversed
line or reordered parts give the same id (`westtec_fid()` in
`scripts/westtec_ogf.py`). It repeats exactly on a rebuild from the same
shapefiles and survives coordinate rounding to 5 decimals. Because it is derived
from content, a publisher change to any of those fields — a renamed project, a
moved endpoint — yields a new id for that feature.

## Our Grid Future crosswalk

`ogf_ids` links a WestTEC feature to the [Our Grid Future](ogf-planned-transmission.md)
records of the same line, in the region-tag form (`|R-0195|R-0494|`, so a
`contains` filter on `|R-0195|` selects it). It comes from the reviewed table
`scripts/westtec_ogf_crosswalk.csv`, one row per WestTEC feature plus one per
OGF "WestTEC 10 Yr Plan" record that has no WestTEC feature:

| Column | |
|---|---|
| `westtec_fid` | the feature's `fid` (empty on an OGF-only row) |
| `westtec_name`, `scenario` | for reading the table |
| `ogf_record_ids` | `R-0195\|R-0494` |
| `status` | `auto` (pre-filled by the rule below), `confirmed` (checked by hand), `review` (undecided), `none` (no counterpart) |
| `note` | the evidence: terminal substations (OSM/HIFLD), scenario, voltage, overlap scores — RecordIDs only, never OGF project names (OGF's licence bars redistributing its attributes) |

Only `confirmed` and `auto` rows ship their ids; a `review` or `none` row's
feature gets no `ogf_ids`. `extract_westtec.py` fails when a feature, or an
OGF record whose `PlanProc` starts with "WestTEC" (from
`data/build/ogf_planned_transmission.gpkg`), has no row, and warns about rows
whose `fid` is gone. After a new edition of either dataset, run
`venv/bin/python scripts/westtec_ogf.py seed` — it appends a row for each
uncovered feature or record and keeps every existing row — then review the new
rows.

**Matching rule** (`propose()`): same scenario (the OGF `PlanProc` suffix),
the WestTEC voltage within OGF `MinVolt`–`MaxVolt`, and at least 90 % of
either line within 500 m of the other (EPSG:5070). It only seeds new rows:
geometry alone has no clean threshold, because OGF often draws one record per
project while WestTEC draws one feature per segment, and shared corridors put
different projects within a few hundred metres.

**Review (2026-10-14, OGF 2026-08-20 edition).** Every row was decided by hand
on the OSM/HIFLD substations at each end of both lines, the OGF scenario and
voltage, and the overlap scores: 103 features `confirmed`, 3 `none`, none left
in `review`. A link means the same planned work, not a shared corridor: where
two scenarios draw the same line (Keeler–Pearl Base Case vs SRA, Townsend–Ashe
IDA vs M2W Base Case, RioSol vs SunZia, Mead–Liberty–Westwing vs Mead–Perkins)
each feature links only its own scenario's record. A segment of a longer OGF
record links that record (Gateway West, Townsend–Ashe); a feature spanning
several OGF records links all of them (Grand Coulee–Schultz–Olympia, North
Plains Connector). Two OGF records outside the WestTEC plan in OGF (`PlanProc`
empty) are linked where their ends and work match a WestTEC feature (Bonanza
to Lower Columbia: R-0679, R-0680). The 3 `none` features have no OGF record
of the same work: the SRA Ostrander–Pearl reconductor, and the two IDA
Hemingway–Summer Lake uprate segments (OGF carries only the rebuild). 23 OGF
WestTEC records have no WestTEC feature, all at 230 kV or below (the
shapefiles hold 5 230-kV features, each matched elsewhere).
