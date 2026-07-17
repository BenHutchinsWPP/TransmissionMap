#!/usr/bin/env bash
# TransmissionMap — WorldPop 2020 population density raster pipeline
# Run from the repo root:  bash scripts/build_population_density.sh
#
# Produces, from WorldPop 2020 1 km UN-adjusted population density (USA/CAN/MEX):
#   data/layers/worldpop_pop_density.pmtiles       raster PMTiles (WEBP, log-scale baked color) — HOSTED
#   data/layers/worldpop_pop_density_lut.i16       coarse Int16 raw ppl/km² grid — hover readout
#   data/layers/worldpop_pop_density_lut.json      grid dims + bbox + scale sidecar
#   data/build/worldpop_pop_density.tif  NA-clipped Cloud-Optimized GeoTIFF (real values) — DOWNLOAD
#
# Metric: population density (people/km²), 1 km resolution, 2020 UN-adjusted.
# Visualization uses log10(1+x) transform so sparse rural areas remain visible
# alongside dense urban cores (ratio spans ~5 orders of magnitude in North America).
# See docs/layers/worldpop-pop-density.md.
#
# Source: WorldPop (www.worldpop.org), University of Southampton — CC BY 4.0.
#   USA: https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km/2020/USA/usa_pd_2020_1km.tif
#   CAN: https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km/2020/CAN/can_pd_2020_1km.tif
#   MEX: https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km/2020/MEX/mex_pd_2020_1km.tif
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

# WorldPop 2020 1km UN-adjusted population density GeoTIFFs
WORLDPOP_BASE="https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km/2020"
declare -A COUNTRIES=(["USA"]="usa_pd_2020_1km.tif" ["CAN"]="can_pd_2020_1km.tif" ["MEX"]="mex_pd_2020_1km.tif")

# North America clip box (same as solar/wind layers)
NA_BBOX=(-170 5 -50 72)

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
  for iso in "${!COUNTRIES[@]}"; do
    local filename="${COUNTRIES[$iso]}"
    local dest="$RAW/$filename"
    if [ -f "$dest" ]; then
      echo "--- $iso source present ($(du -sh "$dest" | cut -f1)) — skipping download ---"
    else
      echo "--- downloading WorldPop 2020 1km $iso (~50-70 MB) ---"
      local url="$WORLDPOP_BASE/$iso/$filename"
      curl -fSL "$url" -o "$dest"
      echo "  [ok] $dest  $(du -sh "$dest" | cut -f1)"
    fi
  done
}

mosaic() {
  echo "--- building NA mosaic from USA + CAN + MEX ---"
  mkdir -p "$BUILD"
  # gdalbuildvrt handles overlapping extents and different NoData values gracefully
  gdalbuildvrt \
    -srcnodata -99999 \
    -vrtnodata -99999 \
    "$BUILD/pop_world.vrt" \
    "$RAW/usa_pd_2020_1km.tif" \
    "$RAW/can_pd_2020_1km.tif" \
    "$RAW/mex_pd_2020_1km.tif"
  echo "  [ok] pop_world.vrt"
}

clip_na() {
  echo "--- clip mosaic to North America bbox (already EPSG:4326) ---"
  # Clamp NoData to -99999; set output NoData to -99999 for the raw clipped TIF
  # and to 0 for the log-transform step (0 = NoData/transparent, matches wind/solar).
  gdalwarp -overwrite -q \
    -te "${NA_BBOX[@]}" \
    -t_srs EPSG:4326 -r bilinear \
    -srcnodata -99999 -dstnodata -99999 \
    -co COMPRESS=DEFLATE \
    "$BUILD/pop_world.vrt" "$BUILD/pop_na.tif"
  echo "  [ok] pop_na.tif  $(du -sh "$BUILD/pop_na.tif" | cut -f1)"
}

log_transform() {
  echo "--- log10(1+x) transform for color tiling ---"
  # Population density spans ~5 orders of magnitude in NA (0 → ~50k ppl/km²).
  # A log transform maps the full range into ~0-4.7 so that rural areas are
  # visible alongside urban cores. The color ramp operates on these log values.
  # NoData (-99999) and negatives → 0 (transparent in the RGBA ramp).
  $GDAL_CALC_CMD \
    -A "$BUILD/pop_na.tif" \
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
    -srcnodata -99999 -dstnodata -99999 \
    "$BUILD/pop_na.tif" "$BUILD/pop_na_dl.tif"
  rc_cog "$BUILD/pop_na_dl.tif" "$OUT_DL/worldpop_pop_density.tif"
  echo "  [ok] $OUT_DL/worldpop_pop_density.tif  $(du -sh "$OUT_DL/worldpop_pop_density.tif" | cut -f1)"
}

build_pmtiles() {
  # Colors the log10(1+x) transform (pop_log.tif), not the raw values.
  rc_bake_tiles "$BUILD/pop_log.tif" "$RAMP" \
    "$OUT_TILES/worldpop_pop_density.pmtiles" "$BUILD/pop_density"
}

build_probe_lut() {
  echo "--- hover lookup grid: coarse Int16 raw ppl/km² grid ---"
  # 0.025 deg EPSG:4326 grid (~2.8 km) sampled on hover.
  # Stores raw population density (ppl/km²) as Int16; values clamped at 32767
  # (sufficient for 1km cells across North America; Manhattan ~7k/km² at 1km avg).
  # NoData = 0 (ocean/outside/truly unpopulated).
  gdalwarp -overwrite -q -tr 0.025 0.025 -r average -t_srs EPSG:4326 \
    -srcnodata -99999 -dstnodata 0 \
    "$BUILD/pop_na.tif" "$BUILD/pop_lut_f.tif"
  # Clamp float→Int16 (values above 32767 saturate; GDAL clamps at output type range)
  gdal_translate -q -ot Int16 -a_nodata 0 \
    "$BUILD/pop_lut_f.tif" "$BUILD/pop_lut_i.tif"
  rc_write_lut "$BUILD/pop_lut_i.tif" "$OUT_TILES/worldpop_pop_density_lut.i16" \
    "$OUT_TILES/worldpop_pop_density_lut.json" 1 "$BUILD/pop"
  echo "  [ok] $OUT_TILES/worldpop_pop_density_lut.i16  $(du -sh "$OUT_TILES/worldpop_pop_density_lut.i16" | cut -f1)"
  echo "  meta: $(cat "$OUT_TILES/worldpop_pop_density_lut.json")"
}

check_deps
fetch
mosaic
clip_na
log_transform
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== population density build complete ==="
