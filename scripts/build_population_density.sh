#!/usr/bin/env bash
# TransmissionMap — WorldPop 2020 population density raster pipeline
# Run from the repo root:  bash scripts/build_population_density.sh
#
# Produces, from the WorldPop 2020 1 km global population-count mosaic:
#   data/layers/worldpop_pop_density.pmtiles       raster PMTiles (WEBP, log-scale baked color) — HOSTED
#   data/layers/worldpop_pop_density_lut.i16.gz       coarse Int16 raw ppl/km² grid — hover readout
#   data/layers/worldpop_pop_density_lut.json      grid dims + bbox + scale sidecar
#   data/build/worldpop_pop_density.tif  world Cloud-Optimized GeoTIFF (real values) — DOWNLOAD
#
# Metric: population density (people/km²), derived from the 1 km count mosaic.
# WorldPop publishes density only per country; the one worldwide product is
# population COUNT per pixel, so counts are summed into an equal-area grid where
# every cell is exactly 4 km² and divided by that constant — which is why no
# latitude-dependent cell-area correction appears anywhere below.
# Visualization uses log10(1+x) transform so sparse rural areas remain visible
# alongside dense urban cores (ratio spans ~5 orders of magnitude worldwide).
# See docs/layers/worldpop-pop-density.md.
#
# Source: WorldPop (www.worldpop.org), University of Southampton — CC BY 4.0.
#   World: https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif
#   License: CC BY 4.0 — visible attribution is REQUIRED (see docs/data-sources.md).
#
# Prerequisites: gdalwarp / gdalbuildvrt / gdaldem / gdal_translate / gdaladdo /
#                gdalinfo (GDAL >= 3.4), gdal_calc.py or gdal_calc (from gdal-bin),
#                pmtiles (https://github.com/protomaps/go-pmtiles), curl.

set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/raster_common.sh

RAW="data/raw/population"
BUILD="data/build/population"
OUT_TILES="data/layers"
OUT_DL="data/build"
RAMP="scripts/pop_density_color_ramp.txt"

# WorldPop 2020 1km global population-count mosaic (~830 MB)
WORLDPOP_URL="https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif"
SRC_COUNTS="$RAW/ppp_2020_1km_Aggregated.tif"

# Equal-area accumulation grid: 2000 m cells in World Cylindrical Equal Area,
# so every cell is exactly 4 km².
CEA_SRS="+proj=cea +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m +no_defs"
CEA_RES=2000
CEA_CELL_KM2=4.0

# World clip box: xmin ymin xmax ymax. Cut at 60S/75N — beyond that WorldPop is
# empty, and the rows would only pad every artifact with NoData.
WORLD_BBOX=(-180 -60 180 75)

check_deps() {
  rc_check_deps gdalwarp gdalbuildvrt gdaldem gdal_translate gdaladdo gdalinfo pmtiles curl
  # Detect gdal_calc variant (name changed in GDAL 3.3+) — pop-only dep.
  if command -v gdal_calc.py >/dev/null 2>&1; then
    GDAL_CALC_CMD="gdal_calc.py"
  elif command -v gdal_calc >/dev/null 2>&1; then
    GDAL_CALC_CMD="gdal_calc"
  else
    echo "ERROR: gdal_calc / gdal_calc.py not found — install gdal-bin (apt) or gdal (brew)"
    exit 1
  fi
  echo "[deps] gdal_calc: $GDAL_CALC_CMD"
}

fetch() {
  mkdir -p "$RAW"
  if [ -f "$SRC_COUNTS" ]; then
    echo "--- source mosaic present ($(du -sh "$SRC_COUNTS" | cut -f1)) — skipping download ---"
    return
  fi
  echo "--- downloading WorldPop 2020 1km global count mosaic (~830 MB) ---"
  curl -fSL "$WORLDPOP_URL" -o "$SRC_COUNTS"
  echo "  [ok] $SRC_COUNTS  $(du -sh "$SRC_COUNTS" | cut -f1)"
}

to_density() {
  echo "--- counts -> equal-area sum -> people/km² ---"
  mkdir -p "$BUILD"
  # -r sum is area-weighted, so folding the 1 km count grid into 2 km equal-area
  # cells conserves people. Anything but 'sum' here would silently average counts
  # and understate every dense cell.
  #
  # No -srcnodata: the mosaic declares its own NoData (-3.4028235e+38, the Float32
  # floor). Overriding it makes gdalwarp treat those cells as real counts and sum
  # them, which drives every part-ocean cell hugely negative — and since the next
  # step keeps only A > 0, that erases coastline cells, where most people live.
  gdalwarp -overwrite -q \
    -t_srs "$CEA_SRS" -tr "$CEA_RES" "$CEA_RES" -r sum \
    -dstnodata -99999 \
    -co COMPRESS=DEFLATE -co BIGTIFF=YES \
    "$SRC_COUNTS" "$BUILD/pop_counts_cea.tif"

  # Every cell is CEA_CELL_KM2 km², so density is one division — no latitude term.
  $GDAL_CALC_CMD \
    -A "$BUILD/pop_counts_cea.tif" \
    --outfile="$BUILD/pop_density_cea.tif" \
    --calc="numpy.where(A > 0, A / $CEA_CELL_KM2, 0.0)" \
    --NoDataValue=0 --type=Float32 --overwrite --quiet \
    --co COMPRESS=DEFLATE --co BIGTIFF=YES

  # Back to 4326 for tiling + the hover LUT. Density is an intensity, so bilinear
  # is correct on the way back (it is only 'sum' that must run on the counts).
  gdalwarp -overwrite -q \
    -te "${WORLD_BBOX[@]}" \
    -t_srs EPSG:4326 -tr 0.02 0.02 -r bilinear \
    -srcnodata 0 -dstnodata 0 \
    -co COMPRESS=DEFLATE -co BIGTIFF=YES \
    "$BUILD/pop_density_cea.tif" "$BUILD/pop_world.tif"
  echo "  [ok] pop_world.tif  $(du -sh "$BUILD/pop_world.tif" | cut -f1)"
}

log_transform() {
  echo "--- log10(1+x) transform for color tiling ---"
  # Population density spans ~5 orders of magnitude worldwide (0 → ~50k ppl/km²).
  # A log transform maps the full range into ~0-4.7 so that rural areas are
  # visible alongside urban cores. The color ramp operates on these log values.
  # NoData (0) and negatives → 0 (transparent in the RGBA ramp).
  $GDAL_CALC_CMD \
    -A "$BUILD/pop_world.tif" \
    --outfile="$BUILD/pop_log.tif" \
    --calc="numpy.where(A > 0, numpy.log10(1 + numpy.maximum(A, 0.0)), 0.0)" \
    --NoDataValue=0 \
    --type=Float32 \
    --overwrite \
    --quiet
  echo "  [ok] pop_log.tif  (log10(1+ppl/km²) values, range 0-4.7)"
}

build_download() {
  echo "--- download artifact: COG with real ppl/km² values ---"
  mkdir -p "$OUT_DL"
  # Resample to ~2 km (0.02 deg) to keep file size manageable (~20-30 MB),
  # matching the solar/wind download conventions.
  gdalwarp -overwrite -q -tr 0.02 0.02 -r average -t_srs EPSG:4326 \
    -srcnodata 0 -dstnodata 0 \
    "$BUILD/pop_world.tif" "$BUILD/pop_world_dl.tif"
  rc_cog "$BUILD/pop_world_dl.tif" "$OUT_DL/worldpop_pop_density.tif"
  echo "  [ok] $OUT_DL/worldpop_pop_density.tif  $(du -sh "$OUT_DL/worldpop_pop_density.tif" | cut -f1)"
}

build_pmtiles() {
  # Colors the log10(1+x) transform (pop_log.tif), not the raw values.
  rc_bake_tiles "$BUILD/pop_log.tif" "$RAMP" \
    "$OUT_TILES/worldpop_pop_density.pmtiles" "$BUILD/pop_density"
}

build_probe_lut() {
  echo "--- hover lookup grid: coarse Int16 raw ppl/km² grid ---"
  # 0.06 deg EPSG:4326 grid (~6.7 km) sampled on hover. The browser downloads this
  # grid whole, so it is sized for the wire, not for the screen: 0.025 deg
  # worldwide would be ~150 MB of flat Int16.
  # Stores raw population density (ppl/km²) as Int16; values clamped at 32767
  # (sufficient at these cell sizes; Manhattan ~7k/km² at 1 km avg).
  # NoData = 0 (ocean/outside/truly unpopulated).
  gdalwarp -overwrite -q -tr 0.06 0.06 -r average -t_srs EPSG:4326 \
    -srcnodata 0 -dstnodata 0 \
    "$BUILD/pop_world.tif" "$BUILD/pop_lut_f.tif"
  # Clamp float→Int16 (values above 32767 saturate; GDAL clamps at output type range)
  gdal_translate -q -ot Int16 -a_nodata 0 \
    "$BUILD/pop_lut_f.tif" "$BUILD/pop_lut_i.tif"
  rc_write_lut "$BUILD/pop_lut_i.tif" "$OUT_TILES/worldpop_pop_density_lut.i16.gz" \
    "$OUT_TILES/worldpop_pop_density_lut.json" 1 "$BUILD/pop"
  echo "  [ok] $OUT_TILES/worldpop_pop_density_lut.i16.gz  $(du -sh "$OUT_TILES/worldpop_pop_density_lut.i16.gz" | cut -f1)"
  echo "  meta: $(cat "$OUT_TILES/worldpop_pop_density_lut.json")"
}

check_deps
fetch
to_density
log_transform
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== population density build complete ==="
