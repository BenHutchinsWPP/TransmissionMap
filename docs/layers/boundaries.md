# County Boundaries

US county polygons from Census TIGER/Line, cartographic boundary vintage.
Paints the **US Counties** layer in the Regions panel group, and doubles as
shared join infrastructure: county-keyed data layers (power outages, weather
alerts) draw these same polygons once and join their values onto them via
MapLibre `feature-state`, instead of each shipping duplicated county geometry.

## Source

| | |
|---|---|
| **Provider** | [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html) |
| **Dataset** | TIGER/Line 2024 cartographic boundary file — counties, 1:500,000 (generalized) |
| **Download** | `https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip` (bump year for newer vintages) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "U.S. Census Bureau, TIGER/Line" |
| **Served** | `data/layers/county_boundaries.pmtiles` — PMTiles, source layer `county_boundaries`, z2–8 |
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
3. Tiling params live in `scripts/tile_manifest.yaml`, not in the shell
   script, so `make tiles` and `make boundaries` can't drift apart —
   `build_boundaries.sh` shells out to `build_tiles.py --only
   county_boundaries`: source layer name `county_boundaries`, `min_zoom: 2`,
   `max_zoom: 8`, `simplification: 8`, `--detect-shared-borders`,
   `--coalesce-densest-as-needed`, `--extend-zooms-if-still-dropping`.

## Load-bearing contract

Any consumer layer that joins onto these polygons depends on:

- **Source layer name is exactly `county_boundaries`.**
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

## Caveats

- **Zoom ceiling.** `max_zoom: 8` keeps county outlines light enough to serve
  as background context under the electrical region layers; past roughly
  z10 the outlines read as over-generalized. That's the accepted tradeoff for
  reusing one shared tileset across a Regions layer and every county-keyed
  join, not a defect — a survey-grade boundary isn't what a join layer needs.
- **Connecticut counts 9 Councils of Governments, not 8 counties.** From the
  2022 vintage onward, Census tabulates Connecticut's county-equivalents as 9
  Councils of Governments (Capitol, Greater Bridgeport, Lower Connecticut
  River Valley, Naugatuck Valley, Northeastern Connecticut, Northwest Hills,
  South Central Connecticut, Southeastern Connecticut, Western Connecticut),
  FIPS `09110`–`09190`, replacing the eight historical counties. Confirmed
  present in the 2024 vintage this layer ships (9 records with `STATEFP =
  "09"`, verified against the built `cb_2024_us_county_500k` DBF). Any
  Connecticut-specific logic keyed on the old eight-county FIPS list needs
  updating for this layer.

## Frontend

Sources the **US Counties** layer in the Regions panel group. County-coded
[NWS weather alerts](nws-alerts.md) (curated US alerts issued against
`/zones/county/`, joined via `geocode.SAME`) and [ODIN outages](outages.md)
join onto this same tileset by `GEOID` via `feature-state`. See
[adding-a-layer.md](../adding-a-layer.md) for how a new county-keyed consumer
wires onto this source.
