# OGF Planned Transmission

Planned and under-construction transmission projects from the Our Grid Future national database.

## Source

| | |
|---|---|
| **Provider** | [Our Grid Future](https://ourgridfuture.org) — Horizon Energy Systems |
| **Dataset** | Planned Transmission Projects National Database, June 2026 edition |
| **Citation** | Abramson, E., Ramsay, E., McFarlane, D., Prorok, M. (2026). *Our Grid Future Planned Transmission Projects National Database*. Horizon Energy Systems. |
| **License** | Custom — free for non-commercial use; attribution required |
| **Attribution** | Abramson et al., Horizon Energy Systems, 2026 — see citation in `index.html` |
| **Served** | GeoJSON (lazy-loaded) — `data/layers/ogf_planned_transmission.geojson.gz` |
| **Built by** | `scripts/extract_ogf.py` → `build_tiles.py` |
| **Raw input** | `data/raw/ogf/OurGridFuture_PlannedTransmissionProjects_Jun2026.zip` (shapefile ZIP; manual placement via the download form at ourgridfuture.org; gitignored) |

## Download pack

Not redistributed — license does not permit redistribution of the raw data. The
layer links out ("Source data ↗") to [ourgridfuture.org](https://ourgridfuture.org).
Marked `skip: true` in `scripts/release_manifest.yaml`.

## Processing

`extract_ogf.py` reads the shapefile from inside the ZIP (`/vsizip/`), reprojects
to EPSG:4326, keeps only line features with geometry, normalizes inconsistent
`Status` spellings ("On Hold"/"Hold" → "On hold"), and drops server-computed
columns (`Shape_Leng`, `Shape__Length`, `OBJECTID`, `CalcCapMW`). No geometry
simplification. `build_tiles.py` then serves it raw as gzipped GeoJSON
(zoom-less, lazy-loaded). Line color is selectable via a "color by" toggle on
the layer row (`ogfStatusLayer` in the registry): `Status` (default),
`Portfolio` (WestTEC scenario), or `PlanAuth` — expression built by
`ogfColorExpr()` in `src/colors/buckets.ts`, applied by `applyOGFColorBy()`
in `assets/visibility.ts`, persisted as URL param `oc`. The two OGF legends
not driving color get dimmed swatches (they remain filters).

## Fields

Notable columns (June 2026 edition; the full list also includes `RecordID`,
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
| `PlanProc` | Planning process / study | "WestTEC 10 Yr Plan", "MTEP24" |
| `Portfolio` | Study portfolio / scenario | "Base Case", "SRA", "IDA", "Congestion", "LRTP Tranche 1" |
| `Length_mi` | Length in miles | 285.4 |
| `Link` | Project page URL | |

WestTEC note: projects from the WestTEC 10-Year Plan carry
`PlanAuth = "WestTEC"` (and `PlanProc = "WestTEC 10 Yr Plan"` — one misspelled
variant "WestTec 10 Yr Plan" exists in the raw data). Their `Portfolio` values
map to the scenario filters on ourgridfuture.org: `Base Case` (Base Case
Planned Projects), `SRA` (Reliability Assessment), `IDA` (Deliverability
Assessment), `Congestion` (Congestion Assessment).

## Filters

Three legend filters target this layer (all combined in `applyOGFFilters()`
in `assets/filters.ts` — they share the same map layers, so they must be
applied in a single `setFilter` call):

| Legend | Field | groupCode |
|---|---|---|
| Project status | `Status` | `g` |
| WestTEC scenario | `Portfolio` | `w` |
| Planning authority | `PlanAuth` | `a` |

## Caveats

- Data represents planned projects and may not reflect current approval or construction status.
- No redistribution of raw data; users wanting the source file should download directly from ourgridfuture.org.
- Coverage is US-focused; some cross-border projects may be included.
- Vintage: June 2026 edition (shapefile ZIP via ourgridfuture.org download form).
