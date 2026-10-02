#!/usr/bin/env python3
"""Extract Our Grid Future planned transmission -> GPKG + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/ogf/OurGridFuture_PlannedTx_Detailed_08202026.zip  ->  this script
        ->  data/build/ogf_planned_transmission.gpkg
    then scripts/build_tiles.py emits data/layers/ogf_planned_transmission.geojson.gz
    (served raw / lazy-loaded; not tiled).

Input (manual placement; gitignored under data/raw/ -- license forbids
redistribution of the raw data, so it is never committed):
  - data/raw/ogf/OurGridFuture_PlannedTx_Detailed_08202026.zip
        Our Grid Future "Planned Transmission Projects" detailed shapefile,
        2026-08-20 edition, supplied directly by Horizon (the public download
        form at https://ourgridfuture.org serves the same database). This
        edition labels every WestTEC 10-Year Report project in `PlanProc` as
        "WestTEC 10 Yr Plan (<scenario>)".

Processing: loaded as-is -- no geometry simplification. Only line features with
geometry are kept. ArcGIS server-added length columns are dropped if present.
Two derived fields drive the map styling:
  - Region: "WECC" when at least half the line's length lies inside the WECC
    polygon of data/build/nerc_regions.gpkg (built by extract_regions.py), or
    the project is in the WestTEC 10-Year Plan; otherwise OGF's ISO_RTO. ISO_RTO
    records market membership, so SPP's western (RTO West) lines need geometry.
  - Work: "new" when Type includes a new circuit, else "existing" (rebuild,
    reconductor, upgrade).

License: free for non-commercial use, attribution required (Abramson et al.,
Horizon Energy Systems). No download pack is offered; the layer links out to
ourgridfuture.org.
"""
from __future__ import annotations
from pathlib import Path

import geopandas as gpd

from geo_common import run_extraction

OGF_ZIP = Path("data/raw/ogf/OurGridFuture_PlannedTx_Detailed_08202026.zip")
OGF_LAYER = "PlannedTx_Detailed_08202026.shp"
NERC_REGIONS = Path("data/build/nerc_regions.gpkg")
DEFAULT_OUT = Path("data/build/ogf_planned_transmission.gpkg")

# ArcGIS-server computed columns; dropped when present, harmless if absent.
DROP = {"Shape_Leng", "Shape__Length", "OBJECTID", "CalcCapMW"}


def build() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"/vsizip/{OGF_ZIP}/{OGF_LAYER}").to_crs("EPSG:4326")
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    gdf = gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    # Source data has inconsistent status spellings; normalize to one form.
    gdf["Status"] = gdf["Status"].replace({"On Hold": "On hold", "Hold": "On hold"})
    # Some PlanProc values carry embedded line breaks; collapse to one space.
    gdf["PlanProc"] = gdf["PlanProc"].str.split().str.join(" ")

    if not NERC_REGIONS.exists():
        raise SystemExit(f"ERROR: {NERC_REGIONS} missing -- run extract_regions.py first")
    nerc = gpd.read_file(NERC_REGIONS).to_crs("EPSG:5070")
    wecc = nerc[nerc["code"] == "WECC"].geometry.union_all()
    lines = gdf.geometry.to_crs("EPSG:5070")
    in_wecc = lines.intersection(wecc).length >= 0.5 * lines.length
    westtec = gdf["PlanProc"].fillna("").str.startswith("WestTEC")
    gdf["Region"] = gdf["ISO_RTO"].where(~(in_wecc | westtec), "WECC")

    gdf["Work"] = gdf["Type"].fillna("New circuit").str.contains("New circuit").map(
        {True: "new", False: "existing"})
    return gdf.drop(columns=[c for c in gdf.columns if c in DROP])


def summary(gdf):
    print(gdf["Status"].value_counts().to_string())
    print(gdf["Region"].value_counts(dropna=False).to_string())
    print(gdf["Work"].value_counts().to_string())
    print(f"\n{len(gdf):,} planned-transmission lines")


def main():
    run_extraction(
        build, output=DEFAULT_OUT,
        description="Extract Our Grid Future planned transmission -> GPKG + CSV",
        require=OGF_ZIP,
        missing_hint=["Place the 2026-08-20 OGF shapefile ZIP at",
                      f"data/raw/ogf/{OGF_ZIP.name}"],
        summary=summary)


if __name__ == "__main__":
    main()
