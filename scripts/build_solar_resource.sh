#!/usr/bin/env bash
# TransmissionMap — Global Solar Atlas PVOUT raster pipeline
# Run from the repo root:  bash scripts/build_solar_resource.sh
#
# Produces, from the global GSA PVOUT GeoTIFF zip:
#   data/layers/gsa_solar_pvout.pmtiles   raster PMTiles (WEBP, baked color) — HOSTED layer
#   data/layers/gsa_solar_pvout_lut.i16   coarse Int16 value grid — hover readout
#   data/layers/gsa_solar_pvout_lut.json  grid dims + bbox + scale sidecar
#   data/build/gsa_solar_pvout.tif   NA-clipped Cloud-Optimized GeoTIFF (real values) — DOWNLOAD
#
# This is the SOLAR sibling of build_wind_resource.sh — same baked-color raster
# PMTiles + Int16 hover-LUT shape. Simpler than wind: GSA rasters are already
# global EPSG:4326, single continuous band, so there is NO LCC reprojection and
# NO 3-region mosaic — just clip to North America, then tile.
#
# Metric: PVOUT = specific photovoltaic power output, kWh/kWp/day (long-term
# yearly average of daily totals). It folds in module-temperature + system
# losses, so it is the truest single "generation capability" proxy (better than
# raw GHI). See docs/layers/gsa-solar-pvout.md.
#
# Source: Global Solar Atlas v2 (Solargis, funded by the World Bank).
#   https://api.globalsolaratlas.info/download/World/World_PVOUT_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF.zip
#   License: CC BY 4.0 — visible attribution is REQUIRED (see docs/data-sources.md).
#   Links are live (unlike NREL/NLR wind); curl them first, only fall back to Wayback if 404.
#
# Prerequisites:  gdalwarp / gdaldem / gdal_translate / gdaladdo (GDAL >= 3.8),
#                 pmtiles (https://github.com/protomaps/go-pmtiles), unzip, curl.

set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/raster_common.sh

RAW="data/raw/solar"                # world_pvout_ltay.zip lives here (gitignored)
BUILD="data/build/solar"            # scratch
OUT_TILES="data/layers"          # hosted PMTiles + hover LUT
OUT_DL="data/build"             # download artifacts
RAMP="scripts/solar_color_ramp.txt"

ZIP_URL="https://api.globalsolaratlas.info/download/World/World_PVOUT_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF.zip"
ZIP="$RAW/world_pvout_ltay.zip"
SRC="$BUILD/PVOUT.tif"              # the global single-band raster inside the zip

# North America clip box: xmin ymin xmax ymax. PVOUT data tops out at lat 65N
# (far-north yield is negligible / unmodeled), so the upper bound is cosmetic.
NA_BBOX=(-170 5 -50 72)

fetch() {
  mkdir -p "$RAW"
  if [ -f "$ZIP" ]; then
    echo "--- source zip present ($(du -sh "$ZIP" | cut -f1)) — skipping download ---"
    return
  fi
  echo "--- downloading Global Solar Atlas PVOUT (LTAy) zip (~360 MB) ---"
  curl -fSL "$ZIP_URL" -o "$ZIP"
  echo "  [ok] $ZIP  $(du -sh "$ZIP" | cut -f1)"
}

extract() {
  echo "--- extracting PVOUT.tif from the zip ---"
  mkdir -p "$BUILD"
  unzip -o -j "$ZIP" "*/PVOUT.tif" -d "$BUILD" >/dev/null
  [ -f "$SRC" ] || { echo "ERROR: PVOUT.tif not found in $ZIP"; exit 1; }
  echo "  [ok] $SRC"
}

clip_na() {
  echo "--- clip global raster to the North America bbox (already EPSG:4326) ---"
  # Source NoData is NaN; -dstnodata 0 makes ocean/outside == 0 to match the wind
  # layer's convention (0 = NoData in the LUT and the transparent ramp stop).
  gdalwarp -overwrite -q \
    -te "${NA_BBOX[@]}" \
    -t_srs EPSG:4326 -r bilinear \
    -dstnodata 0 \
    -co COMPRESS=DEFLATE \
    "$SRC" "$BUILD/solar_pvout_na.tif"
  echo "  [ok] solar_pvout_na.tif"
}

build_download() {
  echo "--- download artifact: Cloud-Optimized GeoTIFF (real kWh/kWp/day values) ---"
  mkdir -p "$OUT_DL"
  # The source is ~930 m; the full-res NA clip is ~100 MB Float32, which busts
  # GitHub's 100 MB per-file limit. Resample to ~2 km (0.02 deg) — ample fidelity
  # for a regional resource-overview download and ~20 MB, in line with the wind COG.
  gdalwarp -overwrite -q -tr 0.02 0.02 -r average -t_srs EPSG:4326 \
    -srcnodata 0 -dstnodata 0 "$BUILD/solar_pvout_na.tif" "$BUILD/solar_pvout_dl.tif"
  rc_cog "$BUILD/solar_pvout_dl.tif" "$OUT_DL/gsa_solar_pvout.tif"
  echo "  [ok] $OUT_DL/gsa_solar_pvout.tif  $(du -sh "$OUT_DL/gsa_solar_pvout.tif" | cut -f1)"
}

build_pmtiles() {
  rc_bake_tiles "$BUILD/solar_pvout_na.tif" "$RAMP" \
    "$OUT_TILES/gsa_solar_pvout.pmtiles" "$BUILD/solar_pvout"
}

build_probe_lut() {
  echo "--- hover lookup grid: coarse Int16 PVOUT grid for the legend arrow ---"
  # Same shape as the wind LUT: a 0.1 deg EPSG:4326 grid the browser samples on
  # hover (the hosted tiles carry only baked color). Int16 = round(kWh/kWp/day *
  # 100), NW-origin row-major; 0 = NoData. PVOUT max ~6.7 → 670, well inside Int16.
  gdalwarp -overwrite -q -tr 0.1 0.1 -r average -t_srs EPSG:4326 \
    -srcnodata 0 -dstnodata 0 "$BUILD/solar_pvout_na.tif" "$BUILD/solar_lut_f.tif"
  gdal_translate -q -ot Int16 -scale 0 7 0 700 -a_nodata 0 \
    "$BUILD/solar_lut_f.tif" "$BUILD/solar_lut_i.tif"
  rc_write_lut "$BUILD/solar_lut_i.tif" "$OUT_TILES/gsa_solar_pvout_lut.i16" \
    "$OUT_TILES/gsa_solar_pvout_lut.json" 100 "$BUILD/solar"
  echo "  [ok] $OUT_TILES/gsa_solar_pvout_lut.i16  $(du -sh "$OUT_TILES/gsa_solar_pvout_lut.i16" | cut -f1)  ($(cat "$OUT_TILES/gsa_solar_pvout_lut.json"))"
}

rc_check_deps gdalwarp gdaldem gdal_translate gdaladdo gdalinfo pmtiles unzip curl
fetch
extract
clip_na
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== solar resource build complete ==="
