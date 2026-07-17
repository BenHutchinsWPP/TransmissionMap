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
(never trust the source `Shape_Leng`, which is dropped).

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
    return gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]


def _length_mi(gdf: gpd.GeoDataFrame) -> pd.Series:
    return (gdf.geometry.to_crs("EPSG:5070").length / 1609.34).round(2)


def build() -> gpd.GeoDataFrame:
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

    assert len(gdf) == 108, f"expected 108 merged features, got {len(gdf)}"
    for col in ("name", "dataset", "scenario"):
        n_bad = (gdf[col].isna() | (gdf[col].astype(str).str.strip() == "")).sum()
        assert n_bad == 0, f"{col} has {n_bad} null/empty values"
    assert set(gdf["scenario"]) == {"Base Case", "IDA", "SRA", "Congestion"}, \
        f"unexpected scenario values: {set(gdf['scenario'])}"
    assert set(gdf["dataset"]) == {"planned", "identified"}, \
        f"unexpected dataset values: {set(gdf['dataset'])}"

    return gdf


def summary(gdf):
    print(gdf["dataset"].value_counts().to_string())
    print()
    print(gdf["scenario"].value_counts().to_string())
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
