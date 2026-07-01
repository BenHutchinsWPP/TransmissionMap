#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

RAW="data/raw/hydrothermal"
BUILD="data/build/hydrothermal"
OUT="data/layers"

ZIP_URL="https://gdr.openei.org/files/842/us_low_temp_hydro_shps_080316.zip"
ZIP="$RAW/us_low_temp_hydro_shps_080316.zip"

mkdir -p "$RAW" "$BUILD" "$OUT"

# 1. Download (skip if present)
[ -f "$ZIP" ] || curl -fSL "$ZIP_URL" -o "$ZIP"
echo "[ok] zip: $(du -sh "$ZIP" | cut -f1)"

# 2. Extract point shapefile
unzip -o -j "$ZIP" "us_low_temp_hydro_shps_080316/us_low_temp_hydro_pt_080316.*" \
  -d "$BUILD" >/dev/null
echo "[ok] shapefile extracted"

# 3. Convert to raw GeoJSON (ogr2ogr preserves all fields; we filter in python)
ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$BUILD/geo_hydro_raw.geojson" \
  "$BUILD/us_low_temp_hydro_pt_080316.shp"

# 4. Clean fields, rename, drop nulls
python3 - << 'EOF'
import json, sys

KEEP = {
    "GEO_AREA":   "name",
    "STATE":      "state",
    "COUNTY":     "county",
    "RES_TEMP":   "temp_c",
    "MIN_DEPTH":  "min_depth_m",
    "MAX_DEPTH":  "max_depth_m",
    "BENHEATMWT": "heat_mwt",
    "REFERENCE":  "reference",
}

with open("data/build/hydrothermal/geo_hydro_raw.geojson") as f:
    fc = json.load(f)

out_features = []
for feat in fc["features"]:
    p = feat["properties"]
    if feat["geometry"] is None:
        continue
    new_props = {}
    for src, dst in KEEP.items():
        v = p.get(src)
        # Drop None and 0.0 depth values (uninformative)
        if v is None or v == "" or (dst in ("min_depth_m", "max_depth_m") and v == 0.0):
            continue
        new_props[dst] = v
    out_features.append({"type": "Feature", "geometry": feat["geometry"],
                         "properties": new_props})

out_fc = {"type": "FeatureCollection", "features": out_features}
with open("data/build/hydrothermal/nrel_hydrothermal_points.geojson", "w") as f:
    json.dump(out_fc, f, separators=(",", ":"))
print(f"  wrote {len(out_features)} features")
EOF

# 5. Hosted copy → gzip for the app (fetchGeojson decompresses client-side)
gzip -9 -c "$BUILD/nrel_hydrothermal_points.geojson" > "$OUT/nrel_hydrothermal_points.geojson.gz"
echo "[ok] hosted: $(du -sh "$OUT/nrel_hydrothermal_points.geojson.gz" | cut -f1)"

echo "=== hydrothermal pts build complete ==="
