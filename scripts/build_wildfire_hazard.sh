#!/usr/bin/env bash
# TransmissionMap — USFS Wildfire Hazard Potential (classified) raster pipeline
# Run from the repo root:  bash scripts/build_wildfire_hazard.sh
#
# Produces, from the USFS RMRS Fire Lab WHP 2023 classified CONUS raster:
#   data/layers/usfs_wildfire_potential.pmtiles   raster PMTiles (WEBP, baked discrete color) — HOSTED
#
# Categorical 270 m raster, values 1-7:
#   1 Very Low  2 Low  3 Moderate  4 High  5 Very High  6 Non-burnable  7 Water
# Discrete official symbology baked in (scripts/whp_color_ramp.txt). No hover LUT
# (categorical — the 7 distinct colors + static legend convey the class).
# CONUS only; Alaska/Hawaii ship as separate rasters in the same .gdb if needed.
# See docs/layers/wildfire-hazard.md.
#
# Source: USFS Rocky Mountain Research Station, Fire, Fuel, and Smoke Science
#   Program — Wildfire Hazard Potential for the United States (270 m), version 2023.
#   Dillon, G.K.; et al. RDS-2015-0047-4. Public domain (US Government work).
#   https://www.fs.usda.gov/rds/archive/catalog/RDS-2015-0047-4
#
# Prerequisites: gdaldem / gdalwarp / gdal_translate / gdaladdo / gdalinfo
#                (GDAL >= 3.4), pmtiles (https://github.com/protomaps/go-pmtiles).

set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/raster_common.sh

RAW="data/raw/wildfire_hazard/whp2023_GeoTIF"
BUILD="data/build/wildfire_hazard"
OUT_TILES="data/layers"
RAMP="scripts/whp_color_ramp.txt"
SRC="$RAW/whp2023_cls_conus.tif"

check_deps() {
  rc_check_deps gdaldem gdalwarp gdal_translate gdaladdo gdalinfo pmtiles
  [ -f "$SRC" ] || { echo "ERROR: $SRC not found — extract RDS-2015-0047-4_Data.zip into data/raw/wildfire_hazard/"; exit 1; }
}

build_pmtiles() {
  mkdir -p "$BUILD"
  # color-relief reads the byte classes directly (EPSG:5070 Albers); rc_bake_tiles
  # then reprojects the baked RGBA to 3857 and tiles it.
  rc_bake_tiles "$SRC" "$RAMP" "$OUT_TILES/usfs_wildfire_potential.pmtiles" "$BUILD/whp"
}

check_deps
build_pmtiles
echo ""
echo "=== wildfire hazard potential build complete ==="
