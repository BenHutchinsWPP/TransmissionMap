#!/usr/bin/env bash
# TransmissionMap — NREL/NLR Wind Resource (100 m) raster pipeline
# Run from the repo root:  bash scripts/build_wind_resource.sh
#
# Produces, from the three WIND Toolkit regional GeoTIFF zips:
#   data/layers/nlr_wind_100m.pmtiles   raster PMTiles (WEBP, baked color) — HOSTED layer
#   data/build/nlr_wind_100m.tif   merged NA Cloud-Optimized GeoTIFF (real m/s) — DOWNLOAD
#
# Why these formats (the "best format" decision):
#   HOSTING  -> raster PMTiles. One range-requested file, same-origin on GitHub
#               Pages (no CORS), and the pmtiles:// protocol is already registered
#               in assets/map.js. Color is baked at build time with gdaldem
#               color-relief, so the map shows it as a plain `raster` layer with
#               opacity — no MapLibre raster-color (4.x-only) and no float-tile
#               encoding needed. Tradeoff: no per-pixel m/s readout; the legend
#               carries the value key. Acceptable for a regional resource overlay.
#   DOWNLOAD -> Cloud-Optimized GeoTIFF carrying the actual Float64 wind-speed
#               values in EPSG:4326 — openable in any GIS, unlike the colored tiles.
#
# Source data: WIND Toolkit multi-year (2007-2013) annual average wind speed,
# 2 km, recovered from the Internet Archive (NREL rebranded to NLR; nrel.gov is
# gone). See docs/layers/nlr-wind-100m.md and docs/data-sources.md.
#
# Prerequisites:  gdalwarp / gdaldem / gdal_translate / gdaladdo (GDAL >= 3.8),
#                 pmtiles (https://github.com/protomaps/go-pmtiles), unzip.

set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/raster_common.sh

RAW="data/raw/wind"                 # the three *-wind-data.zip live here (gitignored)
BUILD="data/build/wind"             # scratch
OUT_TILES="data/layers"          # hosted PMTiles
OUT_DL="data/build"             # download artifacts
RAMP="scripts/wind_color_ramp.txt"
HEIGHT="100m"

# Region -> filename of the 100 m raster inside each zip.
declare -A TIF=(
  [us]="wtk_conus_${HEIGHT}_mean_masked.tif"
  [canada]="wtk_can_bc_${HEIGHT}_mean_masked.tif"
  [mexico]="wtk_mex_${HEIGHT}_mean_masked.tif"
)

extract() {
  echo "--- extracting 100 m rasters from regional zips ---"
  mkdir -p "$BUILD"
  for r in us canada mexico; do
    local zip="$RAW/${r}-wind-data.zip"
    [ -f "$zip" ] || { echo "ERROR: missing $zip — see docs/data-sources.md for Wayback URLs"; exit 1; }
    unzip -o -j "$zip" "*/${TIF[$r]}" -d "$BUILD" >/dev/null
    echo "  [ok] ${TIF[$r]}"
  done
}

merge_reproject() {
  echo "--- mosaic 3 regions + reproject LCC -> EPSG:4326 ---"
  # All three share an identical LCC/NAD83 grid, so gdalwarp mosaics them in one
  # pass. Upstream metadata mislabels the CRS as 4326; it is really LCC metres,
  # so this reproject is required. nodata 0 keeps water/seams transparent.
  gdalwarp -overwrite -q \
    -s_srs "+proj=lcc +lat_0=40 +lon_0=-96 +lat_1=20 +lat_2=60 +datum=NAD83 +units=m +no_defs" \
    -t_srs EPSG:4326 -r bilinear \
    -srcnodata 0 -dstnodata 0 \
    -co COMPRESS=DEFLATE \
    "$BUILD/${TIF[us]}" "$BUILD/${TIF[canada]}" "$BUILD/${TIF[mexico]}" \
    "$BUILD/wind_${HEIGHT}_na.tif"
  echo "  [ok] wind_${HEIGHT}_na.tif"
}

build_download() {
  echo "--- download artifact: Cloud-Optimized GeoTIFF (real m/s values) ---"
  mkdir -p "$OUT_DL"
  # Float32 is ample for m/s wind speed and ~halves the file vs the source Float64.
  rc_cog "$BUILD/wind_${HEIGHT}_na.tif" "$OUT_DL/nlr_wind_${HEIGHT}.tif"
  echo "  [ok] $OUT_DL/nlr_wind_${HEIGHT}.tif  $(du -sh "$OUT_DL/nlr_wind_${HEIGHT}.tif" | cut -f1)"
}

build_pmtiles() {
  rc_bake_tiles "$BUILD/wind_${HEIGHT}_na.tif" "$RAMP" \
    "$OUT_TILES/nlr_wind_${HEIGHT}.pmtiles" "$BUILD/wind_${HEIGHT}"
}

build_probe_lut() {
  echo "--- hover lookup grid: coarse Int16 m/s grid for the legend arrow ---"
  # A small EPSG:4326 grid the browser samples on hover to show the wind speed at
  # the cursor (the hosted tiles only carry baked color, not values). 0.1 deg
  # (~11 km) is ample for a legend readout. Stored as Int16 = round(m/s * 100),
  # row-major from the NW corner; 0 = NoData. ~1.3 MB, lazy-loaded by the app.
  gdalwarp -overwrite -q -tr 0.1 0.1 -r average -t_srs EPSG:4326 \
    -srcnodata 0 -dstnodata 0 "$BUILD/wind_${HEIGHT}_na.tif" "$BUILD/wind_lut_f.tif"
  gdal_translate -q -ot Int16 -scale 0 16 0 1600 -a_nodata 0 \
    "$BUILD/wind_lut_f.tif" "$BUILD/wind_lut_i.tif"
  rc_write_lut "$BUILD/wind_lut_i.tif" "$OUT_TILES/nlr_wind_${HEIGHT}_lut.i16" \
    "$OUT_TILES/nlr_wind_${HEIGHT}_lut.json" 100 "$BUILD/wind"
  echo "  [ok] $OUT_TILES/nlr_wind_${HEIGHT}_lut.i16  $(du -sh "$OUT_TILES/nlr_wind_${HEIGHT}_lut.i16" | cut -f1)  ($(cat "$OUT_TILES/nlr_wind_${HEIGHT}_lut.json"))"
}

rc_check_deps gdalwarp gdaldem gdal_translate gdaladdo gdalinfo pmtiles unzip
extract
merge_reproject
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== wind resource build complete ==="
