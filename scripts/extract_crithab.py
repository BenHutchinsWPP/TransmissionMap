#!/usr/bin/env python3
"""Extract USFWS Critical Habitat (ESA) polygons -> trimmed GPKG + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/crithab/crithab_all_layers.zip  ->  this script  ->  data/build/crithab.{gpkg,csv}
    then scripts/build_tiles.py tiles it (data/layers/crithab.pmtiles).

Input (manual placement; gitignored under data/raw/):
  - data/raw/crithab/crithab_poly.shp  (+ sidecar .dbf/.shx/.prj/.cpg)
        USFWS national Critical Habitat polygon shapefile. Polygons only are
        tiled; the bulk download's linear habitat (CRITHAB_LINE) is not used.
        WARNING: the public bulk zip at
        https://ecos.fws.gov/docs/crithab/crithab_all_layers.zip has been gutted
        to a 2-feature placeholder polygon file. Use the preserved full export
        (873 polygons, crithab_poly.* inside _Archive/crithab_all_layers.zip in
        this repo). The live alternative is the FWS HQ FeatureServer (org
        QVENGdaPbd4LUkLV, USFWS_Critical_Habitat layer 0, "Final Critical
        Habitat Features"). FWS servers present an incomplete cert chain;
        download with `curl -k`.

Why local pmtiles, not the live ArcGIS tile service: a pre-baked file keeps the
layer independent of live service availability and browser CORS support (see
docs/layers/crithab.md). We pre-bake a PMTiles file hosted alongside the map. No download pack is offered
-- users are directed to the ECOS site for bulk data.

Output schema (native FWS DBF field names; matches the original hand-built
crithab.pmtiles so the new tiles are field-for-field equivalent):
  comname, sciname, spcode, status, listing_st, unitname, subunitnam,
  effectdate, entity_id
"""
from __future__ import annotations
from pathlib import Path

import geopandas as gpd

from geo_common import run_extraction

CRITHAB_SHP = Path("data/raw/crithab/crithab_poly.shp")
DEFAULT_OUT = Path("data/build/crithab.gpkg")

# Frontend reads these exact keys (listing_st drives the legend buckets;
# the rest populate the popup). They are the FWS shapefile's own DBF names.
NEEDED = ["comname", "sciname", "spcode", "status", "listing_st",
          "unitname", "subunitnam", "effectdate", "entity_id"]


def build() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(CRITHAB_SHP).to_crs("EPSG:4326")
    lower = {c.lower(): c for c in gdf.columns}
    missing = [c for c in NEEDED if c not in lower]
    if missing:
        raise SystemExit(
            f"CRITHAB_POLY missing expected columns {missing}; "
            f"available: {sorted(gdf.columns)}")
    out = gpd.GeoDataFrame(
        {c: gdf[lower[c]] for c in NEEDED}, geometry=gdf.geometry, crs="EPSG:4326")
    return out[out.geometry.notna() & ~out.geometry.is_empty]


def summary(gdf):
    print(gdf["listing_st"].value_counts().to_string())
    print(f"\n{len(gdf):,} critical-habitat polygons")


def main():
    run_extraction(
        build, output=DEFAULT_OUT,
        description="Extract USFWS Critical Habitat polygons -> GPKG + CSV",
        require=CRITHAB_SHP,
        missing_hint=["Place crithab_poly.shp (+ .dbf/.shx/.prj/.cpg) in data/raw/crithab/",
                      "Full export is in _Archive/crithab_all_layers.zip (see script header)"],
        summary=summary)


if __name__ == "__main__":
    main()
