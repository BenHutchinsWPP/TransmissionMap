#!/usr/bin/env python3
"""Extract Census TIGER Tribal lands (AIANNH) -> trimmed SHP + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/aiannh/tl_2025_us_aiannh.zip  ->  this script  ->  data/build/tribal_lands.{shp,csv}
    then scripts/build_tiles.py tiles + packages it.

Input (manual placement; gitignored under data/raw/):
  - data/raw/aiannh/tl_2025_us_aiannh.zip
        Census TIGER/Line national AIANNH shapefile (zip), EPSG:4269 (NAD83).
        https://www2.census.gov/geo/tiger/TIGER2025/AIANNH/tl_2025_us_aiannh.zip
        Updated annually -- bump the year in the URL/filename for newer vintages.

Why TIGER, not HIFLD: HIFLD just re-hosts this same Census geography at a frozen
vintage. TIGER is the upstream source, refreshed every year. See docs/layers/hifld-tribal-lands.md.

Output schema (Shapefile-safe names, <=10 chars):
  name, area_type, recognized, acres_land, acres_wtr, geoid  (+ lon/lat in CSV)
"""
from __future__ import annotations
from pathlib import Path

import geopandas as gpd

from geo_common import run_extraction

AIANNH_ZIP = Path("data/raw/aiannh/tl_2025_us_aiannh.zip")
DEFAULT_SHP = Path("data/build/tribal_lands.gpkg")

SQM_PER_ACRE = 4046.8564224

# Census MTFCC -> readable area type (TIGER 2025 codes).
AREA_TYPE = {
    "G2100": "Reservation / Off-Reservation Trust Land",  # legacy combined code
    "G2101": "American Indian Reservation",
    "G2102": "Off-Reservation Trust Land",
    "G2120": "Hawaiian Home Land",
    "G2130": "Alaska Native Village Statistical Area",
    "G2140": "Oklahoma Tribal Statistical Area",
    "G2150": "State-Designated Tribal Statistical Area",
    "G2160": "Tribal-Designated Statistical Area",
    "G2170": "State American Indian Reservation",
}
# State-recognized areas; everything else is Federal. Derived from MTFCC alone
# (matches the CLASSFP D9/D0 state-area split in TIGER row-for-row).
STATE_MTFCC = {"G2150", "G2170"}


def build() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"zip://{AIANNH_ZIP}")[
        ["NAME", "MTFCC", "ALAND", "AWATER", "GEOID", "geometry"]
    ].to_crs("EPSG:4326")
    return gpd.GeoDataFrame(
        {
            "name": gdf["NAME"],
            "area_type": gdf["MTFCC"].map(lambda c: AREA_TYPE.get(c, c)),
            "recognized": gdf["MTFCC"].map(lambda c: "State" if c in STATE_MTFCC else "Federal"),
            "acres_land": (gdf["ALAND"].fillna(0) / SQM_PER_ACRE).round().astype(int),
            "acres_wtr": (gdf["AWATER"].fillna(0) / SQM_PER_ACRE).round().astype(int),
            "geoid": gdf["GEOID"],
        },
        geometry=gdf.geometry,
        crs="EPSG:4326",
    )


def summary(gdf):
    print(gdf["area_type"].value_counts().to_string())
    print(f"\nrecognized: {gdf['recognized'].value_counts().to_dict()}")


def main():
    run_extraction(
        build, output=DEFAULT_SHP,
        description="Extract TIGER Tribal (AIANNH) -> SHP + CSV",
        require=AIANNH_ZIP,
        missing_hint=["Download from https://www2.census.gov/geo/tiger/TIGER2025/"
                      "AIANNH/tl_2025_us_aiannh.zip"],
        summary=summary)


if __name__ == "__main__":
    main()
