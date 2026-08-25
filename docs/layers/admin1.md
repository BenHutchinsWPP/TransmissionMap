# States / Provinces (geoBoundaries CGAZ Admin-1)

World first-level administrative divisions (states, provinces, regions) — global
background context for the US-focused infrastructure layers.

## Source

| | |
|---|---|
| **Provider** | [geoBoundaries](https://www.geoboundaries.org/) (William & Mary geoLab) |
| **Dataset** | CGAZ (Comprehensive Global Administrative Zones) — ADM1, first-level administrative divisions |
| **Download** | `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/CGAZ/geoBoundariesCGAZ_ADM1.zip` (~103 MB, shapefile) |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** |
| **Attribution** | "geoBoundaries — William & Mary geoLab" |
| **Coverage** | 3,224 units across 218 countries |
| **Served** | `data/layers/admin1_boundaries.geojson.gz` — gzipped GeoJSON, Douglas-Peucker 0.01° |
| **Built by** | `scripts/extract_cgaz_boundaries.py` (`make world-boundaries`) → `data/build/admin1_boundaries.gpkg` |
| **Raw input** | `data/raw/geoboundaries/geoBoundariesCGAZ_ADM1.zip` |

## Processing

`extract_cgaz_boundaries.py`:
1. Downloads the ADM1 shapefile zip to `data/raw/geoboundaries/` (skips if already
   present), reads it straight out of the zip (`zip://` GDAL handler) — already
   EPSG:4326, no reprojection needed.
2. Keeps `shapeName`, `shapeGroup` — renamed to `name`, `iso_a3` — and derives `color_idx`.
3. Looks up `country` from the [Countries](countries.md) ADM0 GeoDataFrame this
   same script run already holds in memory (`shapeGroup` → `shapeName`) — no
   extra download or attribute-only read needed, since both outputs come from
   one script. Coverage is complete: every ADM1 `shapeGroup` matched an ADM0
   row in the 3,224-feature build that shipped with this layer.
4. `scripts/tile_manifest.yaml` (`make tiles`) tiles it (`min_zoom: 1`,
   `max_zoom: 8`, `simplification: 8`, `--detect-shared-borders`,
   `--coalesce-densest-as-needed`, `--extend-zooms-if-still-dropping`).

## Fields

| Field | Source column | Notes |
|---|---|---|
| `name` | `shapeName` | State/province name, e.g. `"Colorado"` |
| `iso_a3` | `shapeGroup` | ISO 3166-1 alpha-3 code of the parent country, e.g. `"USA"` |
| `color_idx` | derived | `0`–`6` — map-palette bucket, Welsh-Powell colouring so no two touching units match |
| `country` | derived (ADM0 `shapeName` for that `shapeGroup`) | Parent country name, e.g. `"United States"` |

## Caveats

**No ISO 3166-2 subdivision code.** CGAZ ADM1 does not carry one, and it is
not joined in here — the sibling GeoJoiner project tried a name-based join
against Natural Earth's admin-1 codes and measured only 86% coverage. A
column that is blank for a meaningful fraction of rows is worse than no
column, so `admin1_boundaries` ships `name` + `iso_a3` + `country` + `color_idx`.

- No download pack is shipped (`skip: true` in `release_manifest.yaml`) — the
  source is directly downloadable from geoBoundaries, which the Data Credits panel
  links to. The layer panel shows no download button.

Whole polygons can be copied into My Data from the map: the layer is served as
GeoJSON rather than vector tiles, so a feature arrives unclipped. Census ZIP
Codes and Census Counties are tiled and show a "tiled layer" note instead.
