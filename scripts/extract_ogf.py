#!/usr/bin/env python3
"""Extract Our Grid Future planned transmission -> GPKG + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/ogf/OurGridFuture_PlannedTransmissionProjects_Jun2026.zip  ->  this script
        ->  data/build/ogf_planned_transmission.gpkg
    then scripts/build_tiles.py emits data/layers/ogf_planned_transmission.geojson.gz
    (served raw / lazy-loaded; not tiled).

Input (manual placement; gitignored under data/raw/ -- license forbids
redistribution of the raw data, so it is never committed):
  - data/raw/ogf/OurGridFuture_PlannedTransmissionProjects_Jun2026.zip
        Our Grid Future "Planned Transmission Projects" Jun 2026 release.
        Download the shapefile ZIP from https://ourgridfuture.org via their form.

Processing: loaded as-is -- no geometry simplification. Only line features with
geometry are kept. ArcGIS server-added length columns are dropped if present.

License: free for non-commercial use, attribution required (Abramson et al.,
Horizon Energy Systems). No download pack is offered; the layer links out to
ourgridfuture.org.
"""
from __future__ import annotations
from pathlib import Path

import geopandas as gpd

from geo_common import run_extraction

OGF_ZIP = Path("data/raw/ogf/OurGridFuture_PlannedTransmissionProjects_Jun2026.zip")
OGF_LAYER = "OurGridFuture_PlannedTransmissionProjects_Jun2026/Shapefile/OurGridFuture_PlannedTransmissionProjects_Jun2026.shp"
DEFAULT_OUT = Path("data/build/ogf_planned_transmission.gpkg")

# ArcGIS-server computed columns; dropped when present, harmless if absent.
DROP = {"Shape_Leng", "Shape__Length", "OBJECTID", "CalcCapMW"}


def build() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"/vsizip/{OGF_ZIP}/{OGF_LAYER}").to_crs("EPSG:4326")
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    gdf = gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    # Source data has inconsistent status spellings; normalize to one form.
    gdf["Status"] = gdf["Status"].replace({"On Hold": "On hold", "Hold": "On hold"})
    return gdf.drop(columns=[c for c in gdf.columns if c in DROP])


def summary(gdf):
    print(gdf["Status"].value_counts().to_string())
    print(f"\n{len(gdf):,} planned-transmission lines")


def main():
    run_extraction(
        build, output=DEFAULT_OUT,
        description="Extract Our Grid Future planned transmission -> GPKG + CSV",
        require=OGF_ZIP,
        missing_hint=["Download the Jun 2026 ZIP from https://ourgridfuture.org to",
                      f"data/raw/ogf/{OGF_ZIP.name}"],
        summary=summary)


if __name__ == "__main__":
    main()
