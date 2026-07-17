#!/usr/bin/env bash
# TransmissionMap — IHFC Global Heat Flow Database raster pipeline
# Run from the repo root:  bash scripts/build_geothermal_resource.sh
#
# Produces, from the IHFC 2024 heat flow point data:
#   data/layers/ihfc_geo_heatflow.pmtiles   raster PMTiles (WEBP, baked color) — HOSTED layer
#   data/layers/ihfc_geo_heatflow_lut.i16   coarse Int16 value grid — hover readout
#   data/layers/ihfc_geo_heatflow_lut.json  grid dims + bbox + scale sidecar
#   data/build/ihfc_geo_heatflow.tif  Cloud-Optimized GeoTIFF (real mW/m²) — DOWNLOAD
#
# Key difference vs wind/solar: source is scattered measurement points, not a
# pre-made raster. Extra step: CSV → VRT → gdal_grid IDW before the standard
# bake-color → PMTiles pipeline. gdal_grid is slow (~5-15 min for 33K points).
#
# Source: IHFC Global Heat Flow Database Release 2024 (GFZ Data Services).
#   DOI: 10.5880/fidgeo.2024.014
#   License: CC BY 4.0 — visible attribution REQUIRED.
#   Direct zip: https://datapub.gfz.de/download/10.5880.FIDGEO.2024.014-VEueRf/GHFBD-R2024_v.2026-03.zip
#   (~18 MB, direct HTTP GET, no login required)
#
# Prerequisites:  gdalwarp / gdaldem / gdal_translate / gdaladdo / gdal_grid
#                 / gdalinfo (GDAL >= 3.8), pmtiles (~/.local/bin/pmtiles),
#                 unzip, curl, python3.

set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="$HOME/.local/bin:$PATH"   # pick up pmtiles
source scripts/raster_common.sh

RAW="data/raw/geothermal"             # ihfc_2024_ghfdb.zip lives here (gitignored)
BUILD="data/build/geothermal"         # scratch
OUT_TILES="data/layers"            # hosted PMTiles + hover LUT
OUT_DL="data/build"              # download artifacts
RAMP="scripts/geo_color_ramp.txt"
VRT="$BUILD/na_heatflow.vrt"

ZIP_URL="https://datapub.gfz.de/download/10.5880.FIDGEO.2024.014-VEueRf/GHFBD-R2024_v.2026-03.zip"
ZIP="$RAW/ihfc_2024_ghfdb.zip"

fetch() {
  mkdir -p "$RAW"
  if [ -f "$ZIP" ]; then
    echo "--- source zip present ($(du -sh "$ZIP" | cut -f1)) — skipping download ---"
    return
  fi
  echo "--- downloading IHFC 2024 Global Heat Flow Database (~18 MB) ---"
  curl -fSL "$ZIP_URL" -o "$ZIP"
  echo "  [ok] $ZIP  $(du -sh "$ZIP" | cut -f1)"
}

extract() {
  echo "--- extracting .txt from the zip ---"
  mkdir -p "$BUILD"
  unzip -o -j "$ZIP" "*.txt" -d "$BUILD" >/dev/null
  TXT=$(ls "$BUILD"/*.txt 2>/dev/null | head -1)
  [ -n "$TXT" ] || { echo "ERROR: no .txt found in $ZIP"; exit 1; }
  echo "  [ok] $TXT"
}

filter_na() {
  echo "--- filtering to NA bbox, writing CSV for gdal_grid ---"
  python3 - << 'EOF'
import sys, os

build = "data/build/geothermal"
txt = next((os.path.join(build, f) for f in os.listdir(build) if f.endswith(".txt")), None)
if not txt:
    print("ERROR: no .txt in data/build/geothermal/"); sys.exit(1)

outrows = []
with open(txt, encoding="latin-1") as f:
    for line in f:
        if line.startswith("#"):
            continue
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 5:
            continue
        try:
            hf  = float(parts[0])
            lat = float(parts[3])
            lon = float(parts[4])
        except ValueError:
            continue
        if 5 <= lat <= 75 and -170 <= lon <= -50 and 1 < hf < 1000:
            outrows.append((lon, lat, hf))

csv_path = os.path.join(build, "na_heatflow.csv")
with open(csv_path, "w") as f:
    f.write("lon,lat,hf\n")
    for lon, lat, hf in outrows:
        f.write(f"{lon},{lat},{hf}\n")
print(f"  wrote {len(outrows)} NA heat-flow points to {csv_path}")
EOF
}

write_vrt() {
  echo "--- writing VRT wrapper for gdal_grid ---"
  cat > "$VRT" << 'VRTEOF'
<OGRVRTDataSource>
  <OGRVRTLayer name="na_heatflow">
    <SrcDataSource>data/build/geothermal/na_heatflow.csv</SrcDataSource>
    <GeometryType>wkbPoint</GeometryType>
    <GeometryField encoding="PointFromColumns" x="lon" y="lat" z="hf"/>
  </OGRVRTLayer>
</OGRVRTDataSource>
VRTEOF
  echo "  [ok] $VRT"
}

grid_idw() {
  echo "--- gridding points via IDW (gdal_grid, 0.5° = 240×140 cells) ---"
  echo "    This takes ~5-15 minutes …"
  gdal_grid -q \
    -a invdist:power=2:smoothing=0.5:radius=2.0:max_points=7:min_points=1:nodata=0 \
    -txe -170 -50 \
    -tye 5 75 \
    -outsize 240 140 \
    -ot Float32 \
    -of GTiff \
    -a_srs EPSG:4326 \
    -zfield hf \
    -l na_heatflow \
    "$VRT" \
    "$BUILD/geo_heatflow_na.tif"
  echo "  [ok] $BUILD/geo_heatflow_na.tif  $(du -sh "$BUILD/geo_heatflow_na.tif" | cut -f1)"
}

build_download() {
  echo "--- download artifact: Cloud-Optimized GeoTIFF (real mW/m² values) ---"
  mkdir -p "$OUT_DL"
  # The 0.5° grid is already small — no resampling needed. Wrap as COG.
  rc_cog "$BUILD/geo_heatflow_na.tif" "$OUT_DL/ihfc_geo_heatflow.tif"
  echo "  [ok] $OUT_DL/ihfc_geo_heatflow.tif  $(du -sh "$OUT_DL/ihfc_geo_heatflow.tif" | cut -f1)"
}

build_pmtiles() {
  # -tr 5000 5000: force a sane native zoom (~5). Without it the 0.5° source
  # tiles at zoom 2 native and MapLibre upscales excessively at zoom 3-6.
  rc_bake_tiles "$BUILD/geo_heatflow_na.tif" "$RAMP" \
    "$OUT_TILES/ihfc_geo_heatflow.pmtiles" "$BUILD/geo_heatflow" -tr 5000 5000
}

build_probe_lut() {
  echo "--- hover lookup grid: coarse Int16 heat-flow grid for the legend arrow ---"
  # 0.5° grid resampled to 0.5° (already coarse). Int16 = round(mW/m² * 10).
  # Max realistic value ≈ 300 mW/m² × 10 = 3000, well inside Int16.
  # Use the gridded tif directly — no further resampling needed at 0.5°.
  gdal_translate -q -ot Int16 -scale 0 200 0 2000 -a_nodata 0 \
    "$BUILD/geo_heatflow_na.tif" "$BUILD/geo_lut_i.tif"
  rc_write_lut "$BUILD/geo_lut_i.tif" "$OUT_TILES/ihfc_geo_heatflow_lut.i16" \
    "$OUT_TILES/ihfc_geo_heatflow_lut.json" 10 "$BUILD/geo"
  echo "  [ok] $OUT_TILES/ihfc_geo_heatflow_lut.i16  $(du -sh "$OUT_TILES/ihfc_geo_heatflow_lut.i16" | cut -f1)  ($(cat "$OUT_TILES/ihfc_geo_heatflow_lut.json"))"
}

rc_check_deps gdalwarp gdaldem gdal_translate gdaladdo gdalinfo gdal_grid pmtiles unzip curl python3
fetch
extract
filter_na
write_vrt
grid_idw
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== geothermal resource build complete ==="
