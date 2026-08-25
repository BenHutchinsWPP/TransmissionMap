# US ZIP Codes / ZCTAs (Census)

US ZIP Code Tabulation Area (ZCTA) polygons from the Census cartographic boundary series.

## Source

| | |
|---|---|
| **Provider** | [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html) |
| **Dataset** | TIGER/Line 2020 cartographic boundary file — ZCTAs, 1:500,000 (generalized) |
| **Download** | `https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip` (~66 MB) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "U.S. Census Bureau, TIGER/Line" |
| **Coverage** | 33,791 ZCTA polygons |
| **Vintage** | 2020 — see Caveats below |
| **Served** | `data/layers/us_zcta.pmtiles` — vector PMTiles, z4–11 (overzoomed past z11) |
| **Built by** | `scripts/extract_us_census_boundaries.py` (`make census-boundaries`) → `data/build/us_zcta.gpkg` |
| **Raw input** | `data/raw/census_boundaries/cb_2020_us_zcta520_500k.zip` |

## Processing

`extract_us_census_boundaries.py`:
1. Downloads the zip to `data/raw/census_boundaries/` (skips if already present).
2. Reads the shapefile straight out of the zip (`zip://` GDAL handler), reprojects
   NAD83 (EPSG:4269) → EPSG:4326.
3. Keeps only `ZCTA5CE20` — renamed to `zcta5`, kept as a string field throughout
   (the source DBF types it `C`, so `ogr2ogr` never numeric-casts it and leading
   zeros survive, e.g. `"01001"`).
4. `scripts/tile_manifest.yaml` (`make tiles`) tiles it (`min_zoom: 4`,
   `max_zoom: 12`, `simplification: 6`, `--detect-shared-borders`,
   `--coalesce-densest-as-needed`, `--extend-zooms-if-still-dropping`,
   `--drop-densest-as-needed`) — a denser tuning than the region layers since
   ZCTAs pack far more tightly per tile.

## Fields

| Field | Source column | Notes |
|---|---|---|
| `zcta5` | `ZCTA5CE20` | 5-digit ZCTA code, string, e.g. `"01001"` |
| `color_idx` | derived | `0`–`6` — map-palette bucket, Welsh-Powell colouring so touching ZCTAs rarely match |

## Caveats

**ZCTAs are not ZIP codes.** A ZCTA (ZIP Code Tabulation Area) is a Census
*tabulation* geography approximating ZIP delivery routes, built only from
address-range census blocks. ZIP codes assigned to a single delivery point or
to PO boxes have no ZCTA — for example, the White House's ZIP (20500) is
absent from this layer; that location falls inside ZCTA 20006. USPS publishes
no ZIP polygons at all, because a ZIP code is a set of delivery points along
street segments, not an area — every ZIP-polygon product on the market is a
derived approximation, and the commercial ones cannot be redistributed. ZCTAs
are decennial; this is the 2020 set, current until the 2030 census retires it
(GENZ2020 was the last cartographic-boundary release Census shipped ZCTAs in).

- No download pack is shipped (`skip: true` in `release_manifest.yaml`) — the
  source is directly downloadable from Census, which the Data Credits panel
  links to. The layer panel shows no download button.
