#!/usr/bin/env bash
# TransmissionMap — USGS NSHM 2018 Seismic Hazard (PGA, 2% in 50yr) raster pipeline
# Run from the repo root:  bash scripts/build_seismic_hazard.sh
#
# Produces, from the USGS 2018 National Seismic Hazard Model CSV grid:
#   data/layers/usgs_seismic_pga.pmtiles    raster PMTiles (WEBP, baked color) — HOSTED layer
#   data/layers/usgs_seismic_pga_lut.i16    coarse Int16 value grid — hover readout
#   data/layers/usgs_seismic_pga_lut.json   grid dims + bbox + scale sidecar
#   data/build/usgs_seismic_pga.tif         Cloud-Optimized GeoTIFF (real g) — DOWNLOAD
#
# The source is a COMPLETE regular 0.05° lon/lat grid (1201×513, CONUS), so no
# interpolation is needed — gdal_grid with `nearest` reproduces exact cell values.
# Column 3 of the CSV is PGA; cols 4-6 are 0.2s/1.0s/5.0s spectral accel (dropped).
#
# Source: USGS 2018 National Seismic Hazard Model data release, DOI 10.5066/P9WT5OVB.
#   File: US_2018_2PctIn50_pga_0pt2sec_1sec_5sec_BC.csv (2% in 50yr ≈ 2475-yr return,
#   Site Class B/C). Public domain (US Government work). No login required.
#   https://www.sciencebase.gov/catalog/item/5d5597d0e4b01d82ce8e3ff1
#
# Prerequisites:  gdalwarp / gdaldem / gdal_translate / gdaladdo / gdal_grid
#                 / gdalinfo (GDAL >= 3.4), pmtiles, python3.

set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="$HOME/.local/bin:$PATH"   # pick up pmtiles
source scripts/raster_common.sh

RAW="data/raw/usgs"
BUILD="data/build/seismic"
OUT_TILES="data/layers"
OUT_DL="data/build"
RAMP="scripts/seis_color_ramp.txt"
SRC="$RAW/US_2018_2PctIn50_pga_0pt2sec_1sec_5sec_BC.csv"
VRT="$BUILD/seismic_pga.vrt"

# Complete grid extent (computed from the CSV): lon -125..-65, lat 24.4..50, 0.05°.
# gdal_grid extent is cell-edge; pad a half cell (0.025°) so cell centers land on
# the data points. outsize = grid dims.
TXE_MIN=-125.025; TXE_MAX=-64.975
TYE_MIN=24.375;   TYE_MAX=50.025
NX=1201; NY=513

prep_csv() {
  echo "--- writing clean lon,lat,pga CSV for gdal_grid (PGA = col 3) ---"
  mkdir -p "$BUILD"
  [ -f "$SRC" ] || { echo "ERROR: $SRC not found — download from $SRC's ScienceBase item"; exit 1; }
  python3 - "$SRC" "$BUILD/seismic_pga.csv" << 'EOF'
import sys
src, out = sys.argv[1], sys.argv[2]
n = 0
with open(src) as f, open(out, "w") as o:
    o.write("lon,lat,pga\n")
    for line in f:
        p = line.split(",")
        if len(p) < 3:
            continue
        try:
            lon = float(p[0]); lat = float(p[1]); pga = float(p[2])
        except ValueError:
            continue
        o.write(f"{lon},{lat},{pga}\n")
        n += 1
print(f"  wrote {n} grid points to {out}")
EOF
}

write_vrt() {
  echo "--- writing VRT wrapper for gdal_grid ---"
  cat > "$VRT" << 'VRTEOF'
<OGRVRTDataSource>
  <OGRVRTLayer name="seismic_pga">
    <SrcDataSource>data/build/seismic/seismic_pga.csv</SrcDataSource>
    <GeometryType>wkbPoint</GeometryType>
    <GeometryField encoding="PointFromColumns" x="lon" y="lat" z="pga"/>
  </OGRVRTLayer>
</OGRVRTDataSource>
VRTEOF
  echo "  [ok] $VRT"
}

grid_nearest() {
  echo "--- gridding complete 0.05° grid (gdal_grid nearest, exact cell values) ---"
  gdal_grid -q \
    -a nearest:radius1=0.03:radius2=0.03:nodata=0 \
    -txe $TXE_MIN $TXE_MAX \
    -tye $TYE_MIN $TYE_MAX \
    -outsize $NX $NY \
    -ot Float32 -of GTiff \
    -a_srs EPSG:4326 \
    -zfield pga -l seismic_pga \
    "$VRT" "$BUILD/seismic_pga.tif"
  echo "  [ok] $BUILD/seismic_pga.tif  $(du -sh "$BUILD/seismic_pga.tif" | cut -f1)"
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
  # PGA max ≈ 2.87 g → ×1000 = 2866, well inside Int16. nodata 0.
  gdal_translate -q -ot Int16 -scale 0 32.767 0 32767 -a_nodata 0 \
    "$BUILD/seismic_pga.tif" "$BUILD/seismic_lut_i.tif"
  rc_write_lut "$BUILD/seismic_lut_i.tif" "$OUT_TILES/usgs_seismic_pga_lut.i16" \
    "$OUT_TILES/usgs_seismic_pga_lut.json" 1000 "$BUILD/seismic"
  echo "  [ok] $OUT_TILES/usgs_seismic_pga_lut.i16  $(du -sh "$OUT_TILES/usgs_seismic_pga_lut.i16" | cut -f1)  ($(cat "$OUT_TILES/usgs_seismic_pga_lut.json"))"
}

rc_check_deps gdalwarp gdaldem gdal_translate gdaladdo gdalinfo gdal_grid pmtiles python3
prep_csv
write_vrt
grid_nearest
build_download
build_pmtiles
build_probe_lut
echo ""
echo "=== seismic hazard build complete ==="
