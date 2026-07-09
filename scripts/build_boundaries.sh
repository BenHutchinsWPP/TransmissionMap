#!/usr/bin/env bash
# TransmissionMap — Shared county boundary PMTiles (Census TIGER cartographic
# boundary file, 1:500k generalized). Run from the repo root:
#   bash scripts/build_boundaries.sh
#
# Produces:
#   data/build/county_boundaries.geojson   cleaned GeoJSON (GEOID, NAME, STUSPS,
#                                           STATE_NAME only) — intermediate
#   data/layers/county_boundaries.pmtiles  vector PMTiles — HOSTED layer
#
# This is SHARED INFRASTRUCTURE, not a map layer on its own: future
# county-keyed data layers (outages, risk indices, ...) join their values onto
# these polygons via MapLibre feature-state instead of shipping duplicate
# county geometry. The source layer name (`county_boundaries`, set by
# build_tiles.py from the manifest layer id) and the `GEOID` field (string,
# zero-padded 5-digit FIPS, e.g. "08123") are a load-bearing contract — do not
# rename either without updating every consumer.
#
# Coverage note: all 50 states + DC + PR (78 municipios) are present at every
# zoom. American Samoa (60030/60040) and USVI (78010) are dropped below z5 by
# the tile-size limit; ODIN does not report them, so this is accepted.
#
# Source: US Census Bureau TIGER/Line, cartographic boundary file (1:500,000,
# generalized for small-scale mapping), 2024 vintage. Public domain (US
# Government work, 17 U.S.C. § 105). No login required.
#   https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
#
# Prerequisites: curl, unzip, ogr2ogr (GDAL), tippecanoe.

set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="$HOME/.local/bin:$PATH"   # pick up tippecanoe/pmtiles if user-installed

RAW="data/raw/boundaries"
BUILD="data/build"
OUT_TILES="data/layers"

ZIP_URL="https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip"
ZIP="$RAW/cb_2024_us_county_500k.zip"
SHP_DIR="$RAW/cb_2024_us_county_500k"
SHP="$SHP_DIR/cb_2024_us_county_500k.shp"
GEOJSON="$BUILD/county_boundaries.geojson"
OUT="$OUT_TILES/county_boundaries.pmtiles"

for cmd in curl unzip ogr2ogr tippecanoe; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' not found on PATH"; exit 1; }
done

mkdir -p "$RAW" "$BUILD" "$OUT_TILES"

echo "--- 1/3 download (Census TIGER cartographic boundary, cb_2024_us_county_500k) ---"
if [ -f "$ZIP" ]; then
  echo "  [skip] $ZIP already present"
else
  curl -fsSL -o "$ZIP" "$ZIP_URL"
  echo "  [ok] $ZIP  $(du -sh "$ZIP" | cut -f1)"
fi

if [ ! -f "$SHP" ]; then
  echo "  extracting shapefile ..."
  unzip -o -q "$ZIP" -d "$SHP_DIR"
fi
echo "  [ok] $SHP"

echo "--- 2/3 ogr2ogr → GeoJSON (GEOID, NAME, STUSPS, STATE_NAME only; reproject to EPSG:4326) ---"
# Schema confirmed via `ogrinfo -so` on the extracted shapefile:
#   STATEFP, COUNTYFP, COUNTYNS, GEOIDFQ, GEOID, NAME, NAMELSAD, STUSPS,
#   STATE_NAME, LSAD, ALAND, AWATER — source CRS is NAD83 (EPSG:4269).
# GEOID/NAME/STUSPS/STATE_NAME are all native String fields (GEOID keeps
# leading zeros, e.g. "08123") — no numeric-cast risk from ogr2ogr itself.
rm -f "$GEOJSON"
ogr2ogr -f GeoJSON "$GEOJSON" "$SHP" \
  -t_srs EPSG:4326 \
  -select GEOID,NAME,STUSPS,STATE_NAME \
  -lco COORDINATE_PRECISION=5
echo "  [ok] $GEOJSON  $(du -sh "$GEOJSON" | cut -f1)"

echo "--- 3/3 build_tiles.py → PMTiles (source layer: county_boundaries) ---"
# Tiling params live in scripts/tile_manifest.yaml, not here — one source of
# truth, so `make tiles` and `make boundaries` cannot drift apart.
# build_tiles.py needs pyyaml, which lives in the venv (`make install`).
PY="venv/bin/python"
[ -x "$PY" ] || PY="python3"
"$PY" scripts/build_tiles.py --only county_boundaries

echo ""
echo "=== county boundaries build complete ==="
echo "  $OUT  $(du -sh "$OUT" | cut -f1)"
