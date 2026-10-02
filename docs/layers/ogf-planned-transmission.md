# OGF Planned Transmission

Planned and under-construction transmission projects from the Our Grid Future national database.

## Source

| | |
|---|---|
| **Provider** | [Our Grid Future](https://ourgridfuture.org) — Horizon Energy Systems |
| **Dataset** | Planned Transmission Projects National Database, 2026-08-20 detailed edition |
| **Citation** | Abramson, E., Ramsay, E., McFarlane, D., Prorok, M. (2026). *Our Grid Future Planned Transmission Projects National Database*. Horizon Energy Systems. |
| **License** | Custom — free for non-commercial use; attribution required |
| **Attribution** | Abramson et al., Horizon Energy Systems, 2026 — see citation in `index.html` |
| **Served** | GeoJSON (lazy-loaded) — `data/layers/ogf_planned_transmission.geojson.gz` |
| **Built by** | `scripts/extract_ogf.py` → `build_tiles.py` |
| **Raw input** | `data/raw/ogf/OurGridFuture_PlannedTx_Detailed_08202026.zip` (shapefile ZIP supplied by Horizon; manual placement; gitignored) |

## Download pack

Not redistributed — license does not permit redistribution of the raw data. The
layer links out ("Source data ↗") to [ourgridfuture.org](https://ourgridfuture.org).
Marked `skip: true` in `scripts/release_manifest.yaml`.

## Processing

`extract_ogf.py` reads the shapefile from inside the ZIP (`/vsizip/`), reprojects
to EPSG:4326, keeps only line features with geometry, normalizes inconsistent
`Status` spellings ("On Hold"/"Hold" → "On hold"), collapses line breaks
inside `PlanProc` values, and drops server-computed
columns (`Shape_Leng`, `Shape__Length`, `OBJECTID`, `CalcCapMW`). No geometry
simplification. `build_tiles.py` then serves it raw as gzipped GeoJSON
(zoom-less, lazy-loaded).

Two derived fields drive the styling:

- `Region` — `WECC` when at least half a line's length lies inside the WECC
  polygon of `data/build/nerc_regions.gpkg` (so `extract_regions.py` must run
  first), or the project is in the WestTEC 10-Year Plan (this adds North
  Plains Connector, which runs into North Dakota); otherwise OGF's `ISO_RTO`.
  `ISO_RTO` records market membership, so SPP's western (RTO West) lines such
  as Colorado's Power Pathway and Ready Wyoming need the geometry test. 181
  lines are WECC in the 2026-08-20 edition.
- `Work` — `new` when `Type` includes a new circuit (greenfield or existing
  right-of-way), else `existing` (rebuild, reconductor, upgrade).

Line color is selectable via a "color by" toggle on the layer row
(`ogfStatusLayer` in the registry): `Region` (default) or `Status` —
expression built by `ogfColorExpr()` in `src/colors/buckets.ts`, applied by
`applyOGFColorBy()` in `assets/visibility.ts`, persisted as URL param `oc`.
Line style is fixed across both modes: solid for new lines, dashed for work on
existing lines (`OGF_DASH_EXPR`). The OGF layer does not symbolize WestTEC
scenarios; the WestTEC 10 Yr layer is the one place those are shown.

## Fields

Notable columns (2026-08-20 edition, 714 features; the full list also includes `RecordID`,
`ProjectID`, `Segment`, `InfoDate`, `LineType`, `FedPerm`, `StatePerm`,
`Perm_Updat`, `FP_Filter`, `SP_Filter`, `AltName`, `AllSub`, `StatesAbbr`,
`LengthSrc`, `Link2`):

| Field | Description | Example |
|---|---|---|
| `Project` | Project name | "Southwest Intertie Project" |
| `Owner` | Project owner / developer | "NV Energy" |
| `Status` | Development stage | "Planning", "Permitting", "Construction", "Complete" |
| `Type` | Line type | "New", "Upgrade" |
| `ACDC` | AC or DC flag | "AC" |
| `MinVolt` / `MaxVolt` | Voltage range (kV) | 230 / 500 |
| `CapacityMW` | Capacity (MW; replaces the old `CalcCapMW`) | 1000 |
| `EstYear` | Estimated in-service year | 2028 |
| `FromSub` / `ToSub` | Origin / destination substation | "Eldorado" / "Midpoint" |
| `StatesFull` | States traversed | "Nevada, Idaho" |
| `ISO_RTO` | RTO/ISO | "WECC" |
| `PlanAuth` | Planning authority | "WestTEC", "CAISO", "MISO" |
| `PlanProc` | Planning process / study | "WestTEC 10 Yr Plan (Base Case)", "MTEP24" |
| `Portfolio` | Study portfolio / scenario | "Base Case", "SRA", "IDA", "Congestion", "LRTP Tranche 1" |
| `Length_mi` | Length in miles | 285.4 |
| `Link` | Project page URL | |

WestTEC note: `PlanProc` is the complete WestTEC membership field. The
2026-08-20 edition labels every project in the WestTEC 10-Year Report as
`WestTEC 10 Yr Plan (<scenario>)`, where the scenario is `Base Case`, `SRA`,
`IDA` or `Congestion` (96 features, 91 projects). `PlanAuth` and `Portfolio`
record where OGF first sourced a project, so many WestTEC projects keep their
sponsor there (e.g. Greenlink North/West: `PlanAuth` empty, `Owner = NV
Energy`). Every WestTEC-labelled line at 345 kV and above lies on the WestTEC
shapefile routes; 15 of the 27 WestTEC-labelled 230 kV lines appear in the
report but not on the WestTEC maps.

## Filters

Three legend filters target this layer (all combined in `applyOGFFilters()`
in `assets/filters.ts` — they share the same map layers, so they must be
applied in a single `setFilter` call):

| Legend | Field | groupCode |
|---|---|---|
| Region | `Region` | `b` |
| Project status | `Status` | `g` |
| Type of work | `Work` | `m` |

## Caveats

- Data represents planned projects and may not reflect current approval or construction status.
- No redistribution of raw data; users wanting the source file should download directly from ourgridfuture.org.
- Coverage is US-focused; some cross-border projects may be included.
- Vintage: 2026-08-20 detailed edition (shapefile ZIP supplied by Horizon).
