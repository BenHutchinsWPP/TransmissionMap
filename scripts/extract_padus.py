#!/usr/bin/env python3
"""Extract USGS PAD-US 4.1 -> data/build/padus.gpkg

Combines two PAD-US subsets into one output (same field schema, same bucket
color system on the frontend):
  - GAP 1-3: conservation/protection land (Fee layer)
  - GAP 4 federal restricted: DoD military, DOE (NNSS/Hanford/etc.), USACE
    reservoirs/flood control (Combined layer, catches all ownership types)

Input (manual placement; gitignored under data/raw/):
  data/raw/padus/PADUS4_1Geodatabase.gdb
    USGS PAD-US 4.1 Full Inventory. Download PADUS4_1Geodatabase.zip from
    https://www.sciencebase.gov/catalog/item/652d4fc5d34e44db0e2ee45e
    then unzip and place the .gdb directory at the path above.

Stable id: PAD-US has no key on every record (Source_PAID is blank on about half
and repeats), so `fid` is a content id: the first 13 hex digits of a sha1 over
the subset, the source attributes in ID_COLS (missing values as ""), the bounds
in the source CRS (Albers metres) rounded to 1 m, and the vertex count, as an integer below 2**53. The few records that match on
all of that (identical duplicates in the source) take an occurrence suffix in
source order. An edited record gets a new id.
"""
from __future__ import annotations
import hashlib
import os
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio

from geo_common import write_shp_csv

PAD_GDB = Path("data/raw/padus/PADUS4_1Geodatabase.gdb")
PADUS_URL = "https://www.sciencebase.gov/catalog/item/652d4fc5d34e44db0e2ee45e"
OUT = Path("data/build/padus.gpkg")

FILTER_CONSERVATION = ("GAP_Sts IN ('1','2','3') "
                       "AND NOT (Unit_Nm LIKE '%Marine%' OR GIS_Acres > 20000000)")
FILTER_FEDERAL = ("GAP_Sts = '4' "
                  "AND Mang_Name IN ('DOD','DOE','USACE','USBR') "
                  "AND NOT GIS_Acres > 20000000")
ID_COLS = ["Unit_Nm", "Des_Tp", "Mang_Name", "Own_Name", "State_Nm", "GAP_Sts",
           "GIS_Acres", "Source_PAID", "Agg_Src", "GIS_Src"]


def _load_domains() -> dict:
    def dom(name):
        df = pyogrio.read_dataframe(PAD_GDB, layer=name, read_geometry=False)
        return dict(zip(df["Code"], df["Dom"]))
    return {
        "agency": dom("Agency_Name"),
        "atype":  dom("Agency_Type"),
        "desig":  dom("Designation_Type"),
        "access": dom("Public_Access"),
    }


def _content_key(subset: str, gdf: gpd.GeoDataFrame) -> pd.Series:
    """Hash input per record; call on the source-CRS frame (Albers metres)."""
    bounds = gdf.geometry.bounds.round(0).astype(str).agg(",".join, axis=1)
    attrs = gdf[ID_COLS].astype(object).fillna("").astype(str)
    return (subset + "\x1f" + attrs.agg("\x1f".join, axis=1)
            + "\x1f" + bounds + "\x1f" + gdf.geometry.count_coordinates().astype(str))


def _extract(layer: str, where: str, domains: dict, subset: str) -> gpd.GeoDataFrame:
    cols = ["Unit_Nm", "Des_Tp", "Mang_Name", "Mang_Type", "Own_Name", "Own_Type",
            "GAP_Sts", "Pub_Access", "State_Nm", "GIS_Acres", "Date_Est",
            "Source_PAID", "Agg_Src", "GIS_Src"]
    gdf = pyogrio.read_dataframe(PAD_GDB, layer=layer, columns=cols, where=where)
    key = _content_key(subset, gdf)
    gdf = gdf.to_crs("EPSG:4326")
    dec = lambda s, t: s.map(lambda c: t.get(c, c))
    d = domains
    return gpd.GeoDataFrame({
        "key":        key.values,
        "name":       gdf["Unit_Nm"],
        "desig":      dec(gdf["Des_Tp"],    d["desig"]),
        "mng_agency": dec(gdf["Mang_Name"], d["agency"]),
        "mng_type":   dec(gdf["Mang_Type"], d["atype"]),
        "own_agency": dec(gdf["Own_Name"],  d["agency"]),
        "own_type":   dec(gdf["Own_Type"],  d["atype"]),
        "gap":        gdf["GAP_Sts"],
        "access":     dec(gdf["Pub_Access"], d["access"]),
        "state":      gdf["State_Nm"],
        "acres":      gdf["GIS_Acres"],
        "yr_est":     gdf["Date_Est"],
    }, geometry=gdf.geometry, crs=gdf.crs)


def main():
    os.chdir(Path(__file__).parent.parent)
    if not PAD_GDB.exists():
        print(f"ERROR: input not found: {PAD_GDB}", file=sys.stderr)
        print(f"  Download PADUS4_1Geodatabase.zip from {PADUS_URL}", file=sys.stderr)
        print(f"  then unzip and place the .gdb directory at {PAD_GDB}", file=sys.stderr)
        sys.exit(1)

    print("Loading PAD-US domain tables …")
    domains = _load_domains()

    print("Extracting GAP 1-3 conservation land …")
    conservation = _extract("PADUS4_1Fee", FILTER_CONSERVATION, domains, "fee")
    print(f"  {len(conservation):,} features")

    print("Extracting GAP 4 federal restricted land (DoD / DOE / USACE) …")
    combined = "PADUS4_1Combined_Proclamation_Marine_Fee_Designation_Easement"
    federal = _extract(combined, FILTER_FEDERAL, domains, "fed")
    print(f"  {len(federal):,} features")
    print(federal["mng_agency"].value_counts().to_string())

    merged = pd.concat([conservation, federal], ignore_index=True)
    merged = gpd.GeoDataFrame(merged, geometry="geometry", crs="EPSG:4326")
    nth = merged.groupby("key").cumcount()
    key = merged["key"].where(nth == 0, merged["key"] + "#" + nth.astype(str))
    fid = key.map(lambda k: int(hashlib.sha1(k.encode()).hexdigest()[:13], 16))
    if fid.duplicated().any():
        sys.exit(f"ERROR: {fid.duplicated().sum()} duplicate content ids")
    merged = merged.drop(columns="key")
    merged.insert(0, "fid", fid.astype("int64"))
    print(f"  total: {len(merged):,} features ({int((nth > 0).sum())} identical duplicates suffixed)")
    write_shp_csv(merged, OUT)


if __name__ == "__main__":
    main()
