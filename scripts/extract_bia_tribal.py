#!/usr/bin/env python3
"""
extract_bia_tribal.py — Extract BIA AIAN-LAR tribal lands -> GEOJSON

Reads data/raw/bia/bia_aian_national_lar.geojson and writes data/build/bia_tribal_lands.geojson
retaining columns LARNAME and AGENCY.
"""

import argparse
import logging
import os
import sys
from pathlib import Path

try:
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("extract_bia_tribal")

RAW_FILE = Path("data/raw/bia/bia_aian_national_lar.geojson")

def build() -> gpd.GeoDataFrame:
    log.info("Reading GeoJSON: %s ...", RAW_FILE)
    gdf = gpd.read_file(RAW_FILE)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    else:
        gdf = gdf.to_crs("EPSG:4326")

    # Retain LARNAME and AGENCY
    keep = [c for c in ["LARNAME", "AGENCY"] if c in gdf.columns] + ["geometry"]
    gdf = gdf[keep]
    return gdf

def main():
    ap = argparse.ArgumentParser(description="Extract BIA Tribal Lands -> GEOJSON")
    ap.add_argument("-o", "--output", default="data/build/bia_tribal_lands.geojson", help="Output GeoJSON path")
    args = ap.parse_args()

    os.chdir(Path(__file__).parent.parent)

    if not RAW_FILE.exists():
        log.error("Input not found: %s", RAW_FILE)
        log.error("Place the file at %s and re-run.", RAW_FILE)
        sys.exit(1)

    gdf = build()
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Delete existing if any
    out_path.unlink(missing_ok=True)
    
    log.info("Writing GeoJSON: %s ...", out_path)
    gdf.to_file(out_path, driver="GeoJSON")
    log.info("  ✓ %s  (%d features)", out_path.name, len(gdf))

if __name__ == "__main__":
    main()
