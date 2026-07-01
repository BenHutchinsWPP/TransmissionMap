# OGF Planned Transmission

Planned and under-construction transmission projects from the Our Grid Future national database.

## Source

| | |
|---|---|
| **Provider** | [Our Grid Future](https://ourgridfuture.org) — Horizon Energy Systems |
| **Dataset** | Planned Transmission Projects National Database, April 2025 |
| **Citation** | Abramson, E., Ramsay, E., McFarlane, D., Prorok, M. (2026). *Our Grid Future Planned Transmission Projects National Database*. Horizon Energy Systems. |
| **License** | Custom — free for non-commercial use; attribution required |
| **Attribution** | Abramson et al., Horizon Energy Systems, 2026 — see citation in `index.html` |
| **Served** | GeoJSON (lazy-loaded) — `data/layers/ogf_planned_transmission.geojson.gz` |
| **Built by** | `scripts/extract_ogf.py` → `build_tiles.py` |
| **Raw input** | `data/raw/ogf/ogf_planned_transmission.geojson` (manual placement; gitignored) |
| **Source URL** | OGF FeatureServer (Audubon ArcGIS Hub mirror), layer 2 — see `extract_ogf.py` header |

## Download pack

Not redistributed — license does not permit redistribution of the raw data. The
layer links out ("Source data ↗") to [ourgridfuture.org](https://ourgridfuture.org).
Marked `skip: true` in `scripts/release_manifest.yaml`.

## Processing

`extract_ogf.py` reads the OGF FeatureServer GeoJSON export, keeps only line
features with geometry, and drops the two ArcGIS server-added length columns
(`Shape_Leng`, `Shape__Length`); everything else is kept as-is with no geometry
simplification. `build_tiles.py` then serves it raw as gzipped GeoJSON (zoom-less,
lazy-loaded). The `Status` field drives the color expression (`ogfStatusLayer` in
the registry, rendered by `addOGFPlannedTransmission()` in `map-layers-hifld.ts`).

## Fields

| Field | Description | Example |
|---|---|---|
| `Project` | Project name | "Southwest Intertie Project" |
| `Owner` | Project owner / developer | "NV Energy" |
| `Status` | Development stage | "Proposed", "Under Construction", "Operational" |
| `Type` | Line type | "AC", "DC" |
| `ACDC` | AC or DC flag | "AC" |
| `MinVolt` | Minimum voltage (kV) | 230 |
| `MaxVolt` | Maximum voltage (kV) | 500 |
| `CalcCapMW` | Estimated capacity (MW) | 1000 |
| `EstYear` | Estimated in-service year | 2028 |
| `FromSub` | Origin substation | "Eldorado" |
| `ToSub` | Destination substation | "Midpoint" |
| `StatesFull` | States traversed | "Nevada, Idaho" |
| `ISO_RTO` | RTO/ISO | "WECC" |
| `Length_mi` | Length in miles | 285.4 |
| `Link` | Project page URL | |

## Caveats

- Data represents planned projects and may not reflect current approval or construction status.
- No redistribution of raw data; users wanting the source file should download directly from ourgridfuture.org.
- Coverage is US-focused; some cross-border projects may be included.
- Vintage: April 2025 release (OGF FeatureServer).
