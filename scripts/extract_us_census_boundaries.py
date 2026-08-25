#!/usr/bin/env python3
"""
extract_us_census_boundaries.py — US Census cartographic boundary files -> GeoJSON build layers

Source:   US Census Bureau, TIGER/Line cartographic boundary files (1:500,000,
          generalized for small-scale mapping)
License:  Public domain (US federal government work, 17 U.S.C. § 105)
Geometry: Polygon (EPSG:4326)

Two independent outputs, sharing the same download + reproject pattern (auto-
downloaded to data/raw/census_boundaries/; re-run skips a file already present):

  us_states  data/raw/census_boundaries/cb_2025_us_state_500k.zip
             56 states/DC/territories -> data/build/us_states.gpkg
             fields: geoid (STATEFP), stusps (STUSPS), name (NAME)

  us_zcta    data/raw/census_boundaries/cb_2020_us_zcta520_500k.zip
             ~33.8k ZIP Code Tabulation Areas -> data/build/us_zcta.gpkg
             fields: zcta5 (ZCTA5CE20, kept as string — leading zeros matter)

GENZ2025 is the current annual vintage for states. GENZ2020 is the LAST
cartographic-boundary vintage Census shipped ZCTAs in — ZCTAs are decennial,
so ZCTA520 stays current until the 2030 census (see docs/layers/us-zcta.md).

Usage:
  venv/bin/python scripts/extract_us_census_boundaries.py
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

RAW = Path("data/raw/census_boundaries")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (https://github.com/BenHutchinsWPP/TransmissionMap)"

STATES_URL = "https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip"
ZCTA_URL = "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip"


def _fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        print(f"  [skip] {dest} already present")
        return dest
    print(f"  downloading {url}")
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=180) as r:
        dest.write_bytes(r.read())
    print(f"  [ok] {dest}  ({dest.stat().st_size // 1024} KiB)")
    return dest


def _read_4326(zpath: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"zip://{zpath}")
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


# 56 large areas: a ~0.3 degree buffer (~30 km) lets states that face each other
# across a lake or a river mouth count as neighbours, so they take separate
# colours. ZCTAs are joined on touching geometry alone — at 33.8k features a
# buffer both costs minutes and makes half a metro area mutually adjacent.
STATE_NEAR_DEG = 0.3


def build_states(zpath: Path) -> gpd.GeoDataFrame:
    gdf = _read_4326(zpath)
    return gpd.GeoDataFrame({
        "geoid":     gdf["STATEFP"],
        "stusps":    gdf["STUSPS"],
        "name":      gdf["NAME"],
        "color_idx": assign_color_index(gdf, near_deg=STATE_NEAR_DEG, indent="  "),
    }, geometry=gdf.geometry, crs="EPSG:4326")


def build_zcta(zpath: Path) -> gpd.GeoDataFrame:
    gdf = _read_4326(zpath)
    return gpd.GeoDataFrame({
        "zcta5":     gdf["ZCTA5CE20"],
        "color_idx": assign_color_index(gdf, indent="  "),
    }, geometry=gdf.geometry, crs="EPSG:4326")


def main():
    os.chdir(Path(__file__).parent.parent)
    RAW.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)

    print("=== US States (Census cb_2025_us_state_500k) ===")
    states_zip = _fetch(STATES_URL, RAW / "cb_2025_us_state_500k.zip")
    states = build_states(states_zip)
    print(f"  features: {len(states)}")
    write_shp_csv(states, BUILD / "us_states.shp", indent="  ")

    print("\n=== US ZCTAs (Census cb_2020_us_zcta520_500k) ===")
    zcta_zip = _fetch(ZCTA_URL, RAW / "cb_2020_us_zcta520_500k.zip")
    zcta = build_zcta(zcta_zip)
    print(f"  features: {len(zcta)}")
    write_shp_csv(zcta, BUILD / "us_zcta.shp", indent="  ")

    print("\nDone.")


if __name__ == "__main__":
    main()
