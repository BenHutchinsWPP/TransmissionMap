#!/usr/bin/env python3
"""
extract_cgaz_boundaries.py — geoBoundaries CGAZ ADM0/ADM1 -> GeoJSON build layers

Source:   geoBoundaries CGAZ (Comprehensive Global Administrative Zones),
          William & Mary geoLab
License:  CC BY 4.0 — attribution required; see docs/data-sources.md
Geometry: Polygon (EPSG:4326)

Two independent outputs, sharing the same download pattern (git-lfs media
zips, ~104 MB / ~103 MB, auto-downloaded once to data/raw/geoboundaries/ and
reused — re-run skips a file already present):

  countries          data/raw/geoboundaries/geoBoundariesCGAZ_ADM0.zip
                      218 sovereign states -> data/build/countries.gpkg
                      fields: name (shapeName), iso_a3 (shapeGroup)

  admin1_boundaries   data/raw/geoboundaries/geoBoundariesCGAZ_ADM1.zip
                      3,224 states/provinces across 218 countries
                      -> data/build/admin1_boundaries.gpkg
                      fields: name (shapeName), iso_a3 (shapeGroup),
                              country (ADM0 shapeName for that shapeGroup)

Downloaded as shapefile zips rather than the CGAZ .geojson release (401 MB /
371 MB) — GDAL reads the shapefile straight out of the zip via the `zip://`
handler, no separate unzip step.

ADM0 is sovereign-state level: it folds dependencies into their parent (Hong
Kong reads "China", Bermuda reads "United Kingdom") — the tradeoff this makes
against a territory-level dataset is recorded in docs/layers/countries.md.

`country` on the admin1 output is looked up from the ADM0 GeoDataFrame this
script already loads for the countries output (shapeGroup -> shapeName), so
it costs no extra download or attribute-only read. CGAZ carries no ISO 3166-2
subdivision code — not joined in here; see docs/layers/admin1.md.

Usage:
  venv/bin/python scripts/extract_cgaz_boundaries.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen

try:
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

from geo_common import assign_color_index, write_shp_csv

RAW = Path("data/raw/geoboundaries")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (https://github.com/BenHutchinsWPP/TransmissionMap)"
CGAZ = "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/CGAZ"

ADM0_URL = f"{CGAZ}/geoBoundariesCGAZ_ADM0.zip"
ADM1_URL = f"{CGAZ}/geoBoundariesCGAZ_ADM1.zip"


def _fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        print(f"  [skip] {dest} already present")
        return dest
    print(f"  downloading {url}")
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=300) as r:
        dest.write_bytes(r.read())
    print(f"  [ok] {dest}  ({dest.stat().st_size // 1_000_000} MB)")
    return dest


def _read_4326(zpath: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"zip://{zpath}")
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


# Buffer applied before the adjacency join, in degrees. At country scale ~65 km
# of slack lets neighbours that near-miss across a strait still take separate
# colours. Admin-1 units are an order of magnitude smaller and join on touching
# geometry alone: the same buffer swallows whole clusters of small European and
# South Asian units into one mutual neighbourhood, which needs 69 colours to
# resolve and leaves ~1,800 touching pairs matching once wrapped into seven.
ADM0_NEAR_DEG = 0.6
ADM1_NEAR_DEG = 0.0


def main():
    os.chdir(Path(__file__).parent.parent)
    RAW.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)

    print("=== Countries (geoBoundaries CGAZ ADM0) ===")
    adm0_zip = _fetch(ADM0_URL, RAW / "geoBoundariesCGAZ_ADM0.zip")
    adm0 = _read_4326(adm0_zip)
    countries = gpd.GeoDataFrame({
        "name":      adm0["shapeName"],
        "iso_a3":    adm0["shapeGroup"],
        "color_idx": assign_color_index(adm0, near_deg=ADM0_NEAR_DEG, indent="  "),
    }, geometry=adm0.geometry, crs="EPSG:4326")
    print(f"  features: {len(countries)}")
    write_shp_csv(countries, BUILD / "countries.shp", indent="  ")

    print("\n=== Admin-1 (geoBoundaries CGAZ ADM1) ===")
    adm1_zip = _fetch(ADM1_URL, RAW / "geoBoundariesCGAZ_ADM1.zip")
    adm1 = _read_4326(adm1_zip)
    country_name = dict(zip(adm0["shapeGroup"], adm0["shapeName"]))
    admin1 = gpd.GeoDataFrame({
        "name":      adm1["shapeName"],
        "iso_a3":    adm1["shapeGroup"],
        "country":   adm1["shapeGroup"].map(country_name).fillna(adm1["shapeGroup"]),
        "color_idx": assign_color_index(adm1, near_deg=ADM1_NEAR_DEG, indent="  "),
    }, geometry=adm1.geometry, crs="EPSG:4326")
    n_countries = admin1["iso_a3"].nunique()
    print(f"  features: {len(admin1)}  across {n_countries} countries")
    write_shp_csv(admin1, BUILD / "admin1_boundaries.shp", indent="  ")

    print("\nDone.")


if __name__ == "__main__":
    main()
