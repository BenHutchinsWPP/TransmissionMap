#!/usr/bin/env bash
# TransmissionMap — USGS 2023 50-State NSHM Seismic Hazard (PGA, 2% in 50yr) raster pipeline
# Run from the repo root:  bash scripts/build_seismic_hazard.sh
#
# Produces, from the USGS 2023 National Seismic Hazard Model contour-band polygons:
#   data/layers/usgs_seismic_pga.pmtiles    raster PMTiles (WEBP, baked color) — HOSTED layer
#   data/layers/usgs_seismic_pga_lut.i16.gz    coarse Int16 value grid — hover readout
#   data/layers/usgs_seismic_pga_lut.json   grid dims + bbox + scale sidecar
#   data/build/usgs_seismic_pga.tif         Cloud-Optimized GeoTIFF (real g) — DOWNLOAD
#
# Source: USGS 2023 50-State National Seismic Hazard Model data release,
#   DOI 10.5066/P9GNPCOD, ScienceBase child "04. Uniform-hazard ground motion maps".
#   File: US_PGA_2Pct_5Pct_10Pct_50Yrs_BC.zip -> US_PGA_2Pct50Yrs_BC_poly.shp
#   (2% in 50yr ≈ 2475-yr return, Vs30 760 = Site Class B/C; CONUS, Alaska, Hawaii;
#   0.01 g contour bands, 0.01-3.03 g, EPSG:4326). Public domain (US Government work).
#   https://www.sciencebase.gov/catalog/item/64ff886dd34ed30c2057b4d9
#
# Bands are rasterised at 0.05° (cell centre) with value = band midpoint (±0.005 g).
# Bands do not overlap (checked below by a burn count). Cells outside every band
# (below 0.01 g, ocean) stay 0 = transparent. The Aleutians cross the antimeridian:
# the tiles and download COG span -180..180; the hover LUT is clipped at -180..-64.5.
#
# Prerequisites:  gdalwarp / gdaldem / gdal_translate / gdaladdo / gdal_rasterize
#                 / ogr2ogr / gdalinfo (GDAL >= 3.4), curl, unzip, pmtiles, python3.

set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="$HOME/.local/bin:$PATH"   # pick up pmtiles
source scripts/raster_common.sh

RAW="data/raw/usgs/nshm2023"
BUILD="data/build/seismic"
OUT_TILES="data/layers"
OUT_DL="data/build"
RAMP="scripts/seis_color_ramp.txt"
ZIP="$RAW/US_PGA_2Pct_5Pct_10Pct_50Yrs_BC.zip"
ZIP_URL='https://www.sciencebase.gov/catalog/file/get/64ff886dd34ed30c2057b4d9?f=__disk__76%2Ff4%2Fb4%2F76f4b416aadf6f70680106a36acc31714473b4ff'
ZIP_SHA256=b7c5106b66398776f7506a7608e93a51f028b1d21b5fb4d7f738e6aabc621af1
SHP="$RAW/US_PGA_2Pct50Yrs_BC_poly.shp"

fetch_raw() {
  echo "--- fetching the 2023 NSHM PGA contour bands (skipped when present) ---"
  mkdir -p "$RAW"
  if [ ! -f "$ZIP" ]; then
    curl -fL --retry 3 -o "$ZIP.part" "$ZIP_URL"
    mv "$ZIP.part" "$ZIP"
  fi
  echo "$ZIP_SHA256  $ZIP" | sha256sum -c - >/dev/null || { echo "ERROR: $ZIP sha256 differs from the pinned file"; exit 1; }
  [ -f "$SHP" ] || unzip -qo "$ZIP" 'US_PGA_2Pct50Yrs_BC_poly.*' -d "$RAW"
}

# Midpoint of each band as pga (g). One junk sliver carries the -1000000 sentinel; dropped.
grid_bands() {
  echo "--- rasterising bands at 0.05° (cell centre, value = band midpoint) ---"
  mkdir -p "$BUILD"
  rm -f "$BUILD/seismic_bands.gpkg" "$BUILD"/seismic_pga.tif* "$BUILD"/seismic_burns.tif* "$BUILD"/seismic_lut*  "$OUT_DL/usgs_seismic_pga.tif"*
  ogr2ogr -q -f GPKG -nlt MULTIPOLYGON -dialect sqlite -nln bands \
    -sql "SELECT geometry, (CAST(low_cont AS REAL)+CAST(high_cont AS REAL))/2.0 AS pga FROM US_PGA_2Pct50Yrs_BC_poly WHERE CAST(low_cont AS REAL) >= 0" \
    "$BUILD/seismic_bands.gpkg" "$SHP"
  gdal_rasterize -q -l bands -a pga -tr 0.05 0.05 -te -180 18.5 180 72 \
    -a_nodata 0 -ot Float32 -of GTiff -a_srs EPSG:4326 \
    "$BUILD/seismic_bands.gpkg" "$BUILD/seismic_pga.tif"
  # Bands must not overlap, or the burn order would decide a cell's value.
  gdal_rasterize -q -l bands -burn 1 -add -init 0 -tr 0.05 0.05 -te -180 18.5 180 72 \
    -ot Byte -of GTiff "$BUILD/seismic_bands.gpkg" "$BUILD/seismic_burns.tif"
  local burns
  burns=$(gdalinfo -stats "$BUILD/seismic_burns.tif" | sed -n 's/.*STATISTICS_MAXIMUM=//p')
  [ "${burns%.*}" -le 1 ] || { echo "ERROR: bands overlap (max burns per cell $burns)"; exit 1; }
  echo "  [ok] $BUILD/seismic_pga.tif  $(du -sh "$BUILD/seismic_pga.tif" | cut -f1)  (max burns per cell: $burns)"
}

build_download() {
  echo "--- download artifact: Cloud-Optimized GeoTIFF (real g values) ---"
  mkdir -p "$OUT_DL"
  rc_cog "$BUILD/seismic_pga.tif" "$OUT_DL/usgs_seismic_pga.tif"
  echo "  [ok] $OUT_DL/usgs_seismic_pga.tif  $(du -sh "$OUT_DL/usgs_seismic_pga.tif" | cut -f1)"
}

build_pmtiles() {
  # -tr 5000 5000: force a sane native zoom (~5) — 0.05° tiles too coarse natively.
  rc_bake_tiles "$BUILD/seismic_pga.tif" "$RAMP" \
    "$OUT_TILES/usgs_seismic_pga.pmtiles" "$BUILD/seismic" -tr 5000 5000
}

build_probe_lut() {
  echo "--- hover lookup grid: Int16 PGA*1000 grid for the legend arrow ---"
  # PGA max ≈ 3 g → ×1000 = 3030, well inside Int16. nodata 0. The grid is clipped
  # at -180..-64.5 (the LUT is one west-to-east grid; the Aleutian cells east of the
  # antimeridian are drawn in the tiles only).
  gdal_translate -q -ot Int16 -scale 0 32.767 0 32767 -a_nodata 0 \
    -projwin -180 72 -64.5 18.5 \
    "$BUILD/seismic_pga.tif" "$BUILD/seismic_lut_i.tif"
  rc_write_lut "$BUILD/seismic_lut_i.tif" "$OUT_TILES/usgs_seismic_pga_lut.i16.gz" \
    "$OUT_TILES/usgs_seismic_pga_lut.json" 1000 "$BUILD/seismic"
  echo "  [ok] $OUT_TILES/usgs_seismic_pga_lut.i16.gz  $(du -sh "$OUT_TILES/usgs_seismic_pga_lut.i16.gz" | cut -f1)  ($(cat "$OUT_TILES/usgs_seismic_pga_lut.json"))"
}

rc_check_deps gdalwarp gdaldem gdal_translate gdaladdo gdalinfo gdal_rasterize ogr2ogr curl unzip pmtiles python3
fetch_raw
grid_bands
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== seismic hazard build complete ==="
