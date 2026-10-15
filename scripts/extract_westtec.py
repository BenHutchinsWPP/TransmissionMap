#!/usr/bin/env python3
"""Extract WestTEC 10-Year Horizon transmission portfolio -> GPKG for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/westtec/WestTEC 10yr Identified Upgrades.zip     \\
    data/raw/westtec/WestTEC 10yr Planned Projects.zip         }->  this script
        ->  data/build/westtec_10yr.gpkg
    then scripts/build_tiles.py emits data/layers/westtec_10yr.geojson.gz
    (served raw / lazy-loaded; not tiled).

Input (auto-downloaded to data/raw/westtec/, which is gitignored):
  - https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Identified%20Upgrades.zip
  - https://www.westernpowerpool.org/static/shapefiles/WestTEC%2010yr%20Planned%20Projects.zip
        GIS export accompanying the WestTEC West-Wide Transmission Study,
        10-Year Horizon Report (Feb 2026), a Western Power Pool initiative.
        Both dated 2026-02-19. Each is a flat-packed ESRI Shapefile ZIP
        (no subfolder), EPSG:3857, LineString.

Processing: the two shapefiles are merged into one GeoDataFrame. "Identified
Upgrades" rows get scenario = their `Assessment` value (IDA/SRA/Congestion);
"Planned Projects" has no such flag and *is* the Base Case by definition, so
its rows get scenario = "Base Case". `line_type` (AC/DC) only exists on the
Planned file -- Identified rows get None. Length is recomputed in EPSG:5070
(never trust the source `Shape_Leng`, which is dropped). A row identical to an
earlier one in every raw field and in its geometry is dropped: Identified
Upgrades carries "Add a new Mead - Liberty - West Wing 500 kV line" three times.

Ids and crosswalk (scripts/westtec_ogf.py): `fid` is a content id (no publisher
key exists), and `ogf_ids` lists the Our Grid Future RecordIDs of the same line
(`|R-0195|R-0494|`) from the reviewed table scripts/westtec_ogf_crosswalk.csv.
The build fails when a feature, or an OGF "WestTEC 10 Yr Plan" record in
data/build/ogf_planned_transmission.gpkg, has no row there -- run
`scripts/westtec_ogf.py seed`, then review the new rows.

License: published by WPP. No download pack is offered -- WPP publishes both
shapefiles directly, so the layer links out to westernpowerpool.org rather
than mirroring them (see release_manifest.yaml skip:true entry).
"""
from __future__ import annotations
import urllib.parse
import urllib.request
from pathlib import Path

import geopandas as gpd
import pandas as pd

from geo_common import run_extraction
import westtec_ogf

BASE_URL = "https://www.westernpowerpool.org/static/shapefiles/"
RAW_DIR = Path("data/raw/westtec")
IDENTIFIED_ZIP = RAW_DIR / "WestTEC 10yr Identified Upgrades.zip"
IDENTIFIED_LAYER = "WestTEC 10yr Identified Upgrades.shp"
PLANNED_ZIP = RAW_DIR / "WestTEC 10yr Planned Projects.zip"
PLANNED_LAYER = "WestTEC 10yr Planned Projects.shp"
DEFAULT_OUT = Path("data/build/westtec_10yr.gpkg")


def fetch() -> None:
    """Download both ZIPs into data/raw/westtec/ if not already there."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for zip_path in (IDENTIFIED_ZIP, PLANNED_ZIP):
        if zip_path.exists():
            continue
        url = BASE_URL + urllib.parse.quote(zip_path.name)
        print(f"Downloading {url}")
        urllib.request.urlretrieve(url, zip_path)


def _load(zip_path: Path, layer: str) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(f"/vsizip/{zip_path}/{layer}")
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    gdf = gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    exact = gdf.drop(columns="geometry").assign(_wkb=gdf.geometry.to_wkb())
    return gdf[~exact.duplicated()]


def _length_mi(gdf: gpd.GeoDataFrame) -> pd.Series:
    return (gdf.geometry.to_crs("EPSG:5070").length / 1609.34).round(2)


def build(join: bool = True) -> gpd.GeoDataFrame:
    identified = _load(IDENTIFIED_ZIP, IDENTIFIED_LAYER)
    identified_out = gpd.GeoDataFrame({
        "name": identified["Upgrade_Na"],
        "dataset": "identified",
        "scenario": identified["Assessment"],
        "upgrade_type": identified["Upgrade_Ty"],
        "voltage_kv": identified["Upgrade_Vo"],
        "line_type": None,
        "length_mi": _length_mi(identified),
    }, geometry=identified.geometry.values, crs=identified.crs)

    planned = _load(PLANNED_ZIP, PLANNED_LAYER)
    planned_out = gpd.GeoDataFrame({
        "name": planned["Line_Name"],
        "dataset": "planned",
        "scenario": "Base Case",
        "upgrade_type": planned["Upgrade_Ty"],
        "voltage_kv": planned["Upgrade_Vo"],
        "line_type": planned["line_type"],
        "length_mi": _length_mi(planned),
    }, geometry=planned.geometry.values, crs=planned.crs)

    gdf = pd.concat([identified_out, planned_out], ignore_index=True)
    gdf = gpd.GeoDataFrame(gdf, geometry="geometry", crs=identified.crs).to_crs("EPSG:4326")

    assert len(gdf) == 106, f"expected 106 merged features, got {len(gdf)}"
    for col in ("name", "dataset", "scenario"):
        n_bad = (gdf[col].isna() | (gdf[col].astype(str).str.strip() == "")).sum()
        assert n_bad == 0, f"{col} has {n_bad} null/empty values"
    assert set(gdf["scenario"]) == {"Base Case", "IDA", "SRA", "Congestion"}, \
        f"unexpected scenario values: {set(gdf['scenario'])}"
    assert set(gdf["dataset"]) == {"planned", "identified"}, \
        f"unexpected dataset values: {set(gdf['dataset'])}"

    gdf.insert(0, "fid", [westtec_ogf.westtec_fid(r.dataset, r.scenario, r.name, r.voltage_kv,
                                                  r.upgrade_type, r.geometry)
                          for r in gdf.itertuples()])
    assert gdf["fid"].is_unique, "WestTEC fid collision: add a field to westtec_fid()"
    if join:
        _join_crosswalk(gdf)
    return gdf


def _join_crosswalk(gdf: gpd.GeoDataFrame) -> None:
    rows = westtec_ogf.read_table()
    ogf_records = (westtec_ogf.load_ogf_westtec()["RecordID"]
                   if westtec_ogf.OGF_GPKG.exists() else [])
    missing, unnamed, stale = westtec_ogf.uncovered(rows, gdf["fid"], ogf_records)
    if not westtec_ogf.OGF_GPKG.exists():
        print(f"  [skip] OGF coverage check: {westtec_ogf.OGF_GPKG} missing")
    if stale:
        print(f"  WARNING: crosswalk rows for fids no longer in the data: {stale}")
    if missing or unnamed:
        raise SystemExit(f"ERROR: {westtec_ogf.CROSSWALK.name} lacks rows for WestTEC fids {missing} "
                         f"and OGF records {unnamed}; run scripts/westtec_ogf.py seed and review them")
    gdf["ogf_ids"] = gdf["fid"].map(westtec_ogf.ogf_ids(rows))


def summary(gdf):
    print(gdf["dataset"].value_counts().to_string())
    print()
    print(gdf["scenario"].value_counts().to_string())
    print(f"\n{gdf['ogf_ids'].notna().sum()} features linked to Our Grid Future records")
    print(f"\n{len(gdf):,} WestTEC 10-Yr features")


def main():
    fetch()
    run_extraction(
        build, output=DEFAULT_OUT,
        description="Extract WestTEC 10-Year Horizon portfolio -> GPKG",
        require=IDENTIFIED_ZIP,
        missing_hint=["Download failed. Fetch both ZIPs manually from",
                      f"  {BASE_URL}", "and place them at",
                      f"  {IDENTIFIED_ZIP}", f"  {PLANNED_ZIP}"],
        summary=summary)


if __name__ == "__main__":
    main()
