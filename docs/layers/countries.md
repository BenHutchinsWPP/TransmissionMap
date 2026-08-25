# Countries (geoBoundaries CGAZ)

World country polygons — global background context for the US-focused infrastructure layers.

## Source

| | |
|---|---|
| **Provider** | [geoBoundaries](https://www.geoboundaries.org/) (William & Mary geoLab) |
| **Dataset** | CGAZ (Comprehensive Global Administrative Zones) — ADM0, a composite of per-country authoritative sources (e.g. US Census for the USA), clipped to the US State Department LSIB |
| **Download** | `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/CGAZ/geoBoundariesCGAZ_ADM0.zip` (~104 MB, shapefile — used in preference to the 401 MB `.geojson` release; GDAL reads a shapefile straight out of the zip) |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** |
| **Attribution** | "geoBoundaries — William & Mary geoLab" |
| **Coverage** | 218 sovereign states |
| **Served** | `data/layers/countries.geojson.gz` — gzipped GeoJSON, Douglas-Peucker 0.005° |
| **Built by** | `scripts/extract_cgaz_boundaries.py` (`make world-boundaries`) → `data/build/countries.gpkg` |
| **Raw input** | `data/raw/geoboundaries/geoBoundariesCGAZ_ADM0.zip` |

## Processing

`extract_cgaz_boundaries.py`:
1. Downloads the ADM0 shapefile zip to `data/raw/geoboundaries/` (skips if already
   present), reads it straight out of the zip (`zip://` GDAL handler) — already
   EPSG:4326, no reprojection needed.
2. Keeps `shapeName`, `shapeGroup` — renamed to `name`, `iso_a3` — and derives `color_idx`.
3. `scripts/tile_manifest.yaml` (`make tiles`) tiles it (`min_zoom: 0`,
   `max_zoom: 8`, `simplification: 8`, `--detect-shared-borders`,
   `--coalesce-densest-as-needed`, `--extend-zooms-if-still-dropping`).

This same download also feeds [Admin-1 boundaries](admin1.md) (`country` lookup)
— see that script's header for how the two outputs share the ADM0 read.

## Fields

| Field | Source column | Notes |
|---|---|---|
| `name` | `shapeName` | Country name, e.g. `"United States"` |
| `iso_a3` | `shapeGroup` | ISO 3166-1 alpha-3 code, e.g. `"USA"` |
| `color_idx` | derived | `0`–`6` — map-palette bucket, Welsh-Powell colouring so no two touching units match |

## Caveats

**Sovereign-state level, not territory level.** CGAZ ADM0 folds dependencies
into their parent — Hong Kong reads `"China"`, Bermuda reads `"United
Kingdom"`. This layer draws that same parent geometry for those territories
rather than naming them separately: the sibling GeoJoiner project appends
~39 Natural Earth territory polygons for exactly this purpose, because it
needs distinct point-in-polygon labels. This map is a visual overlay, not a
lookup service — the territory's geometry is still drawn, just under its
parent's name — so the append (and the second ~13 MB source + merge step it
requires) is skipped here.

- No download pack is shipped (`skip: true` in `release_manifest.yaml`) — the
  source zip is directly downloadable from
  [geoboundaries.org](https://www.geoboundaries.org/), which the Data Credits
  panel links to. The layer panel shows no download button.

Whole polygons can be copied into My Data from the map: the layer is served as
GeoJSON rather than vector tiles, so a feature arrives unclipped. Census ZIP
Codes and Census Counties are tiled and show a "tiled layer" note instead.
