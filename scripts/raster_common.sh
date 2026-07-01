# TransmissionMap — shared raster-pipeline helpers (sourced, not executed)
# Source from a build_*_resource.sh after `cd`-ing to the repo root:
#   source scripts/raster_common.sh
#
# Collapses the ~40% duplication across the wind/solar/geothermal/population
# raster builders. Each layer still owns its fetch/clip/transform steps; these
# four helpers own the identical tail (deps check, COG, baked-color PMTiles,
# hover-LUT sidecar). Per-layer knobs (NoData, Int16 scale, resampling res,
# extra gdalwarp flags) stay in the caller — passed as args, not hardcoded.

# rc_check_deps <cmd...> — fail unless every CLI is on PATH; echo versions.
rc_check_deps() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null || { echo "ERROR: $c not found (see prerequisites)"; exit 1; }
  done
  echo "[deps] $(gdalinfo --version)"
  echo "[deps] pmtiles $(pmtiles version 2>&1 | head -1)"
}

# rc_cog <src_tif> <out_cog> — Float32 Cloud-Optimized GeoTIFF (real values).
# Callers that need to downsample first do it themselves into a scratch tif.
rc_cog() {
  gdal_translate -q -of COG -ot Float32 \
    -co COMPRESS=DEFLATE -co PREDICTOR=3 -co RESAMPLING=BILINEAR \
    "$1" "$2"
}

# rc_bake_tiles <value_tif> <ramp> <out_pmtiles> <work_prefix> [extra gdalwarp flags...]
#   color-relief -> EPSG:3857 -> MBTiles(WEBP) -> PMTiles.
#   work_prefix : scratch path stem, e.g. data/build/wind/wind_100m
#   extra flags : appended to the 3857 reproject (e.g. -tr 5000 5000 for geo).
rc_bake_tiles() {
  local val="$1" ramp="$2" out="$3" wp="$4"; shift 4
  echo "--- hosted tiles: color-relief -> 3857 -> MBTiles(WEBP) -> PMTiles ---"
  mkdir -p "$(dirname "$out")"
  gdaldem color-relief -q -alpha "$val" "$ramp" "${wp}_color.tif"
  gdalwarp -overwrite -q -t_srs EPSG:3857 -r bilinear "$@" \
    -co COMPRESS=DEFLATE "${wp}_color.tif" "${wp}_3857.tif"
  rm -f "${wp}.mbtiles"
  gdal_translate -q -of MBTILES -co TILE_FORMAT=WEBP -co QUALITY=85 \
    "${wp}_3857.tif" "${wp}.mbtiles"
  gdaladdo -q -r average "${wp}.mbtiles" 2 4 8 16 32
  rm -f "$out"
  pmtiles convert "${wp}.mbtiles" "$out" >/dev/null
  echo "  [ok] $out  $(du -sh "$out" | cut -f1)"
  echo "  zooms: $(pmtiles show "$out" 2>/dev/null | grep -iE 'min zoom|max zoom' | tr '\n' ' ')"
}

# rc_write_lut <int16_tif> <out_i16> <out_json> <scale> <work_prefix>
#   Dump band-1 bytes (ENVI = flat NW-origin row-major) to .i16 and write the
#   dims/bbox/scale sidecar. Caller builds the Int16 tif (its -scale differs).
rc_write_lut() {
  local i16="$1" out_i16="$2" out_json="$3" scale="$4" wp="$5"
  mkdir -p "$(dirname "$out_i16")"
  gdal_translate -q -of ENVI "$i16" "${wp}_lut.envi"
  cp "${wp}_lut.envi" "$out_i16"
  gdalinfo -json "$i16" | SCALE="$scale" python3 -c '
import sys, json, os
d = json.load(sys.stdin)
w, h = d["size"]
gt = d["geoTransform"]            # [ox, dx, 0, oy, 0, -dy]
print(json.dumps({
  "width": w, "height": h,
  "west": gt[0], "north": gt[3],
  "dx": gt[1], "dy": -gt[5],
  "scale": int(os.environ["SCALE"]), "nodata": 0,
}))' > "$out_json"
}
