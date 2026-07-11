#!/usr/bin/env python3
"""
extract_boem_wind.py — BOEM offshore wind leases → GeoJSON

Source:   Bureau of Ocean Energy Management (BOEM)
License:  Public domain (U.S. federal government work)
Geometry: Polygon (EPSG:4326)

URL: https://www.boem.gov/renewable-energy/boem-renewable-energy-shapefiles
Serves the zip directly; save to data/raw/boem_wind/

Extract Offshore_Wind_Leases_outlines.shp → data/build/boem_wind_leases.geojson
with fields renamed:
lease←LEASE_NUMB, company←COMPANY, project←PROJECT_NA, type←LEASE_TYPE, state←STATE, acres←ACRES, date←LEASE_DATE, term←LEASE_TERM.

Usage:
  venv/bin/python scripts/extract_boem_wind.py
"""

import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

try:
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

RAW = Path("data/raw/boem_wind")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (benrhutchins@gmail.com)"
ZIP_URL = "https://www.boem.gov/renewable-energy/boem-renewable-energy-shapefiles"
ZIP_NAME = "boem-renewable-energy-shapefiles.zip"

def _fetch(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=60) as r:
        return r.read()

def ensure_shapefile() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    existing = next(RAW.rglob("Offshore_Wind_Leases_outlines.shp"), None)
    if existing:
        print(f"  ✓ BOEM Wind: using existing {existing}")
        return existing

    zpath = RAW / ZIP_NAME
    if not zpath.exists():
        print(f"  ↓ BOEM Wind: downloading {ZIP_URL}")
        data = _fetch(ZIP_URL)
        zpath.write_bytes(data)

    print(f"  ↓ BOEM Wind: extracting {zpath}")
    with zipfile.ZipFile(zpath) as z:
        z.extractall(RAW)

    shp = next(RAW.rglob("Offshore_Wind_Leases_outlines.shp"), None)
    if not shp:
        sys.exit(f"no Offshore_Wind_Leases_outlines.shp found after unzipping {zpath}")
    return shp

def main():
    shp = ensure_shapefile()
    gdf = gpd.read_file(shp)
    
    # Rename fields
    rename_map = {
        "LEASE_NUMB": "lease",
        "COMPANY": "company",
        "PROJECT_NA": "project",
        "LEASE_TYPE": "type",
        "STATE": "state",
        "ACRES": "acres",
        "LEASE_DATE": "date",
        "LEASE_TERM": "term"
    }
    gdf = gdf.rename(columns=rename_map)
    
    keep_cols = ["lease", "company", "project", "type", "state", "acres", "date", "term", "geometry"]
    gdf = gdf[keep_cols]
    
    if gdf.crs is not None and str(gdf.crs) != "EPSG:4326":
        gdf = gdf.to_crs(4326)
        
    BUILD.mkdir(parents=True, exist_ok=True)
    out = BUILD / "boem_wind_leases.geojson"
    out.unlink(missing_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    print(f"  ✓ {out} ({len(gdf)} features)")

if __name__ == "__main__":
    main()
