# County Boundaries (shared join infra)

US county polygons from Census TIGER/Line, cartographic boundary vintage.
**Not a map layer with its own legend or registry entry** — this is shared
infrastructure. Future county-keyed data layers (outages, risk indices, ...)
draw these polygons once and join their values onto them via MapLibre
`feature-state`, instead of each shipping duplicated county geometry.

## Source

| | |
|---|---|
| **Provider** | [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html) |
| **Dataset** | TIGER/Line 2024 cartographic boundary file — counties, 1:500,000 (generalized) |
| **Download** | `https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip` (bump year for newer vintages) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "U.S. Census Bureau, TIGER/Line" |
| **Served** | `data/layers/county_boundaries.pmtiles` — PMTiles, source layer `county` |
| **Built by** | `scripts/build_boundaries.sh` (`make boundaries`); also wired as a `scripts/tile_manifest.yaml` block so `make tiles` can rebuild it from the same intermediate |
| **Raw input** | `data/raw/boundaries/cb_2024_us_county_500k.zip` |

Cartographic boundary (not TIGER/Line legal boundary) chosen deliberately:
generalized geometry is far smaller and renders cleanly at low zoom, which is
what a shared background join layer needs — legal-boundary precision isn't.

## Processing

`build_boundaries.sh`:
1. Downloads the zip to `data/raw/boundaries/` (skips if already present),
   extracts the shapefile.
2. `ogr2ogr` → `data/build/county_boundaries.geojson`: reprojects NAD83
   (EPSG:4269) → EPSG:4326, keeps only `GEOID`, `NAME`, `STUSPS`,
   `STATE_NAME` (all confirmed as native shapefile String fields via
   `ogrinfo -so` — no numeric-cast risk).
3. `tippecanoe` → `data/layers/county_boundaries.pmtiles`, source layer name
   `county`, `-zg` (capped `--maximum-zoom=10`), `--simplification=8`,
   `--coalesce-densest-as-needed`, `--detect-shared-borders`, `--force`.

## Load-bearing contract

Any consumer layer that joins onto these polygons depends on:

- **Source layer name is exactly `county`.**
- **`GEOID` is a string**, zero-padded 5-digit county FIPS (e.g. `"08123"` for
  Weld County, CO) — a numeric cast would silently drop the leading zero and
  break every join. Verified by decoding a built tile
  (`tippecanoe-decode`/`pmtiles`) and confirming `"GEOID": "08123"` renders
  quoted.

Do not rename the source layer or cast `GEOID` to a number without updating
every consumer layer.

## Fields

| Field | Notes |
|---|---|
| `GEOID` | 5-digit county FIPS, string, e.g. `"08123"`. Join key. |
| `NAME` | County name, e.g. `"Weld"`. |
| `STUSPS` | 2-letter state abbreviation, e.g. `"CO"`. |
| `STATE_NAME` | Full state name, e.g. `"Colorado"`. |

## Frontend

None yet — this layer draws nothing on its own. A future task adds the
consumer (e.g. an outages or risk-index layer) that sources this PMTiles and
sets per-feature `feature-state` keyed by `GEOID`. See
[adding-a-layer.md](../adding-a-layer.md) for how to wire a new map layer once
that consumer exists.
