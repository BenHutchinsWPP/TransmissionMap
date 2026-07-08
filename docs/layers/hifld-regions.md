# HIFLD Regions — NERC / Control Areas / Retail Territories

Three administrative-boundary polygon layers giving regulatory context to the infrastructure layers.

## Source

| | |
|---|---|
| **Provider** | DHS / CISA — Homeland Infrastructure Foundation-Level Data (HIFLD) |
| **Origin** | Oak Ridge NL (ORNL), Los Alamos NL (LANL), Idaho NL (INL), NGA |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "HIFLD / DHS CISA" |
| **Download origin** | [SeerAI HIFLD Archive](https://source.coop/repositories/seerai/hifld/description/) (source.coop) / Geodesic API — **manually placed** at `data/raw/hifld/regions/` |
| **Served** | `data/layers/nerc_regions.geojson.gz` (16 feats, simplified) · `data/layers/control_areas.geojson.gz` (71 feats, simplified) · `data/layers/retail_territories.pmtiles` (z2–10) — NERC/BA are too small to tile and serve whole geometry so they copy cleanly in edit mode; Retail (~2,900 feats) stays PMTiles |
| **Built by** | `extract_regions.py` → `data/build/{nerc_regions,control_areas,retail_territories}.{shp,csv}` |

> The HIFLD Open portal closed September 16, 2025; datasets have been archived by SeerAI on source.coop.

## Download pack

Three separate polygon packs (one per map layer), each offered as **GeoJSON** and
**SHP**:

- `nerc-regions.zip` (GeoJSON) / `nerc-regions-shp.zip` (SHP)
- `control-areas.zip` (GeoJSON) / `control-areas-shp.zip` (SHP)
- `retail-territories.zip` (GeoJSON) / `retail-territories-shp.zip` (SHP)

Each GeoJSON zip holds `<id>.geojson` + `<id>.csv`; each SHP zip holds the
shapefile set (`.shp/.shx/.dbf/.prj/.cpg`) + `<id>.csv`. Both also include
`hifld-regions.txt` (this doc) + `disclaimer.txt`. The attribute CSV carries no
geometry — it's a tabular preview.

## Processing (all three)

- **CRS:** reprojected to EPSG:4326 (or `set_crs` if missing on load)
- **Sentinel cleaning:** `"NOT AVAILABLE"` string → empty; `-999999` numeric → null
- **Columns:** trimmed to the readable subset listed per-layer below

### NERC Regions

- **Computed:** `code` extracted from the `(ABBR)` parenthetical of `NAME`; `region` =
  `NAME` with trailing parenthetical stripped
- **Columns kept:** `code`, `sub_nm`, `region`, `state`, `website`

| Field | Source column | Notes |
|---|---|---|
| `code` | derived from `NAME` | NERC region abbreviation (e.g. WECC, MRO, SERC) |
| `sub_nm` | `SUBNAME` | Sub-region name |
| `region` | derived from `NAME` | Full region name, parenthetical removed |
| `state` | `STATE` | |
| `website` | `WEBSITE` | sentinel-cleaned |

### Control Areas (Balancing Authorities)

- **Computed:** `color_idx` = stable CRC32 hash of `NAME` mod 6, so adjacent BAs get
  distinct fill colors
- **Columns kept:** `name`, `state`, `color_idx`, `tot_cap`, `peak_ld`, `min_ld`,
  `avail_cap`, `year`, `website`

| Field | Source column | Notes |
|---|---|---|
| `name` | `NAME` | |
| `state` | `STATE` | |
| `color_idx` | derived | 0–5 hash bucket for map fill |
| `tot_cap` | `TOTAL_CAP` | total capacity (int, sentinel-cleaned) |
| `peak_ld` | `PEAK_LOAD` | |
| `min_ld` | `MIN_LOAD` | |
| `avail_cap` | `AVAIL_CAP` | |
| `year` | `YEAR` | |
| `website` | `WEBSITE` | |

### Retail Service Territories

- **Columns kept:** `name`, `type`, `state`, `customers`, `retail_mwh`, `sumr_peak`,
  `wntr_peak`, `hold_co`, `ctrl_area`, `year`, `website`

| Field | Source column | Notes |
|---|---|---|
| `name` | `NAME` | |
| `type` | `TYPE` | utility type |
| `state` | `STATE` | |
| `customers` | `CUSTOMERS` | int, sentinel-cleaned |
| `retail_mwh` | `RETAIL_MWH` | int |
| `sumr_peak` | `SUMMR_PEAK` | summer peak |
| `wntr_peak` | `WINTR_PEAK` | winter peak |
| `hold_co` | `HOLDING_CO` | holding company |
| `ctrl_area` | `CNTRL_AREA` | parent balancing authority |
| `year` | `YEAR` | |
| `website` | `WEBSITE` | |

## Caveats

- Load/capacity columns (`tot_cap`, `peak_ld`, `customers`, `retail_mwh`, peaks) carry the
  source's reporting `year`, not the current year.
- NERC (16) and control-area (71) geometries are **simplified** for serving; retail
  territories (~2,900) are tiled. Boundaries are administrative approximations, not survey lines.
