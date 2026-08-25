# Census States

US state, DC, and territory polygons from the Census cartographic boundary series.

## Source

| | |
|---|---|
| **Provider** | [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html) |
| **Dataset** | TIGER/Line 2025 cartographic boundary file — states, 1:500,000 (generalized) |
| **Download** | `https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip` (~3.2 MB; bump year for newer vintages) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "U.S. Census Bureau, TIGER/Line" |
| **Coverage** | 56 features — 50 states + DC + Puerto Rico + the four other territories |
| **Served** | `data/layers/us_states.geojson.gz` — gzipped GeoJSON, simplified for whole-polygon serving (same rationale as [nerc_regions](hifld-regions.md): small enough to copy cleanly in edit mode) |
| **Built by** | `scripts/extract_us_census_boundaries.py` (`make census-boundaries`) → `data/build/us_states.gpkg` |
| **Raw input** | `data/raw/census_boundaries/cb_2025_us_state_500k.zip` |

## Processing

`extract_us_census_boundaries.py`:
1. Downloads the zip to `data/raw/census_boundaries/` (skips if already present).
2. Reads the shapefile straight out of the zip (`zip://` GDAL handler), reprojects
   NAD83 (EPSG:4269) → EPSG:4326.
3. Keeps only `STATEFP`, `STUSPS`, `NAME` — renamed to `geoid`, `stusps`, `name`.
4. `scripts/tile_manifest.yaml` (`make tiles`) serves it as simplified GeoJSON
   (`precision: 5`, `simplify: 0.005`) — the same pattern as `nerc_regions`.

## Fields

| Field | Source column | Notes |
|---|---|---|
| `geoid` | `STATEFP` | 2-digit state FIPS code, string (e.g. `"08"` for Colorado) |
| `stusps` | `STUSPS` | 2-letter postal abbreviation (e.g. `"CO"`) |
| `name` | `NAME` | Full state/territory name (e.g. `"Colorado"`) |
| `color_idx` | derived | `0`–`6` — map-palette bucket, Welsh-Powell colouring so no two touching states match |

## Caveats

- Cartographic boundary (not TIGER/Line legal boundary), chosen for its smaller,
  web-friendly generalized geometry — not survey-grade.
- No download pack is shipped (`skip: true` in `release_manifest.yaml`) — the
  source is directly downloadable from Census, which the Data Credits panel
  links to. The layer panel shows no download button.

Whole polygons can be copied into My Data from the map: the layer is served as
GeoJSON rather than vector tiles, so a feature arrives unclipped. Census ZIP
Codes and Census Counties are tiled and show a "tiled layer" note instead.
