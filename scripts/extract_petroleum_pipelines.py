#!/usr/bin/env python3
"""
extract_petroleum_pipelines.py — EIA crude-oil + petroleum-product pipelines → GeoJSON

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EIA LIQUIDS PIPELINE INFRASTRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Source:   U.S. Energy Information Administration (EIA) — eia.gov/maps/map_data
License:  Public domain (U.S. federal government work)
Geometry: LineString (WGS84)
Vintage:  Jan 2020 (the publicly downloadable shapefile release; EIA's newer
          ~2024 vintage on atlas.eia.gov is behind an auth token — see roadmap).

Closes the liquids-fuel gap alongside the natural-gas pipeline layers.

Raw inputs (downloaded to data/raw/eia_petroleum/):
  CrudeOil_Pipelines_US_EIA.zip          — 236 crude-oil pipeline lines
  PetroleumProduct_Pipelines_US_EIA.zip  — 329 refined-product pipeline lines
  (shapefile fields: Opername, Pipename)

Outputs (data/build/):
  eia_crude_pipelines.geojson    — fields: name, operator
  eia_product_pipelines.geojson  — fields: name, operator
The tile_manifest gzips these to data/layers/*.geojson.gz (browser-direct, no PMTiles).
"""
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

RAW = Path("data/raw/eia_petroleum")
BUILD = Path("data/build")
BASE = "https://www.eia.gov/maps/map_data"

LAYERS = [
    ("CrudeOil_Pipelines_US_EIA",         "eia_crude_pipelines"),
    ("PetroleumProduct_Pipelines_US_EIA", "eia_product_pipelines"),
]


def fetch_and_unzip(remote: str) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    zpath = RAW / f"{remote}.zip"
    if not zpath.exists():
        print(f"  ↓ {remote}.zip")
        urlretrieve(f"{BASE}/{remote}.zip", zpath)
    dest = RAW / remote
    dest.mkdir(exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(dest)
    shp = next(dest.glob("*.shp"), None)
    if not shp:
        sys.exit(f"no .shp in {zpath}")
    return shp


def to_geojson(shp: Path, out_id: str):
    BUILD.mkdir(parents=True, exist_ok=True)
    out = BUILD / f"{out_id}.geojson"
    out.unlink(missing_ok=True)
    layer = shp.stem
    # rename Opername/Pipename → operator/name, reproject to WGS84
    subprocess.run([
        "ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326",
        "-dialect", "OGRSQL",
        "-sql", f'SELECT Pipename AS name, Opername AS operator FROM "{layer}"',
        str(out), str(shp),
    ], check=True)
    print(f"  ✓ {out}")


def main():
    for remote, out_id in LAYERS:
        print(f"{remote}:")
        to_geojson(fetch_and_unzip(remote), out_id)


if __name__ == "__main__":
    main()
