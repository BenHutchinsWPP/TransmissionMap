#!/usr/bin/env python3
"""Extract HIFLD region layers → trimmed SHP + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    data/raw/hifld/regions/*.parquet  ->  this script  ->  data/build/{nerc_regions,control_areas,retail_territories}.{shp,csv}
    then scripts/build_tiles.py tiles + packages them.

Inputs (manual placement; gitignored under data/raw/):
  data/raw/hifld/regions/nerc-regions.parquet
  data/raw/hifld/regions/control-areas.parquet
  data/raw/hifld/regions/retail-service-territories.parquet

  Download from HIFLD via SeerAI (source.coop or geodesic API).

Output schemas:
  nerc_regions      code, sub_nm, region, state, website
  control_areas     name, state, tot_cap, peak_ld, min_ld, avail_cap, year, website
  retail_territories name, type, state, customers, retail_mwh, sumr_peak, wntr_peak,
                     hold_co, ctrl_area, year, website
"""
from __future__ import annotations
import os
import re
import sys
import zlib
from pathlib import Path

import geopandas as gpd
import pandas as pd

from geo_common import write_shp_csv

RAW_DIR  = Path("data/raw/hifld/regions")
BUILD    = Path("data/build")

INPUTS = {
    "nerc":   RAW_DIR / "nerc-regions.parquet",
    "ba":     RAW_DIR / "control-areas.parquet",
    "retail": RAW_DIR / "retail-service-territories.parquet",
}


# ── helpers ────────────────────────────────────────────────────────────────────

def clean_str(s):
    """Replace 'NOT AVAILABLE' sentinel with empty string."""
    if isinstance(s, str) and s.strip().upper() == "NOT AVAILABLE":
        return ""
    return s if isinstance(s, str) else (s if not pd.isna(s) else "")

def clean_num(v, sentinel=-999999):
    """Replace -999999 sentinel with None."""
    try:
        f = float(v)
        return None if f <= sentinel else f
    except (TypeError, ValueError):
        return None

def clean_int(v, sentinel=-999999):
    n = clean_num(v, sentinel)
    return None if n is None else int(round(n))

def _write(gdf: gpd.GeoDataFrame, stem: str) -> None:
    write_shp_csv(gdf, BUILD / f"{stem}.shp", indent="  ")


# ── NERC Regions ───────────────────────────────────────────────────────────────

def _nerc_code(name: str) -> str:
    """Extract abbreviation from 'FULL NAME (ABBR)' parenthetical."""
    m = re.search(r'\(([A-Z]+(?:,\s*RE)?)\)', name)
    if m:
        code = m.group(1).replace(",", "").replace(" RE", "").strip()
        return code
    return name[:10]

def _nerc_region(name: str) -> str:
    """Strip trailing parenthetical from full name."""
    return re.sub(r'\s*\([^)]*\)\s*$', '', name).strip()

def _read(parquet: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_parquet(parquet)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf

def build_nerc(parquet: Path) -> gpd.GeoDataFrame:
    gdf = _read(parquet)
    return gpd.GeoDataFrame({
        "code":   gdf["NAME"].apply(_nerc_code),
        "sub_nm": gdf["SUBNAME"],
        "region": gdf["NAME"].apply(_nerc_region),
        "state":  gdf["STATE"],
        "website": gdf["WEBSITE"].apply(clean_str),
    }, geometry=gdf.geometry, crs="EPSG:4326")


# ── Control Areas (Balancing Authorities) ──────────────────────────────────────

def _color_idx(name: str, n: int = 6) -> int:
    """Stable hash → 0..n-1 so adjacent BAs get distinct fill colors."""
    return zlib.crc32(str(name).encode()) % n

def build_control_areas(parquet: Path) -> gpd.GeoDataFrame:
    gdf = _read(parquet)
    return gpd.GeoDataFrame({
        "name":      gdf["NAME"].apply(clean_str),
        "state":     gdf["STATE"].apply(clean_str),
        "color_idx": gdf["NAME"].apply(_color_idx),
        "tot_cap":   [clean_int(v) for v in gdf["TOTAL_CAP"]],
        "peak_ld":   [clean_int(v) for v in gdf["PEAK_LOAD"]],
        "min_ld":    [clean_int(v) for v in gdf["MIN_LOAD"]],
        "avail_cap": [clean_int(v) for v in gdf["AVAIL_CAP"]],
        "year":      gdf["YEAR"].apply(clean_str),
        "website":   gdf["WEBSITE"].apply(clean_str),
    }, geometry=gdf.geometry, crs="EPSG:4326")


# ── Retail Service Territories ─────────────────────────────────────────────────

def build_retail(parquet: Path) -> gpd.GeoDataFrame:
    gdf = _read(parquet)
    return gpd.GeoDataFrame({
        "name":       gdf["NAME"].apply(clean_str),
        "type":       gdf["TYPE"].apply(clean_str),
        "state":      gdf["STATE"].apply(clean_str),
        "customers":  [clean_int(v) for v in gdf["CUSTOMERS"]],
        "retail_mwh": [clean_int(v) for v in gdf["RETAIL_MWH"]],
        "sumr_peak":  [clean_num(v) for v in gdf["SUMMR_PEAK"]],
        "wntr_peak":  [clean_num(v) for v in gdf["WINTR_PEAK"]],
        "hold_co":    gdf["HOLDING_CO"].apply(clean_str),
        "ctrl_area":  gdf["CNTRL_AREA"].apply(clean_str),
        "year":       gdf["YEAR"].apply(clean_str),
        "website":    gdf["WEBSITE"].apply(clean_str),
    }, geometry=gdf.geometry, crs="EPSG:4326")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    os.chdir(Path(__file__).parent.parent)
    BUILD.mkdir(parents=True, exist_ok=True)

    missing = [str(p) for p in INPUTS.values() if not p.exists()]
    if missing:
        print("ERROR: missing input files:", file=sys.stderr)
        for m in missing:
            print(f"  {m}", file=sys.stderr)
        sys.exit(1)

    print("=== NERC Regions ===")
    nerc = build_nerc(INPUTS["nerc"])
    print(f"  codes: {sorted(nerc['code'].unique())}")
    _write(nerc, "nerc_regions")

    print("\n=== Control Areas (Balancing Authorities) ===")
    ba = build_control_areas(INPUTS["ba"])
    print(f"  features: {len(ba)}")
    _write(ba, "control_areas")

    print("\n=== Retail Service Territories ===")
    retail = build_retail(INPUTS["retail"])
    print(f"  features: {len(retail)}")
    print(f"  types: {sorted(retail['type'].dropna().unique())}")
    _write(retail, "retail_territories")

    print("\nDone.")


if __name__ == "__main__":
    main()
