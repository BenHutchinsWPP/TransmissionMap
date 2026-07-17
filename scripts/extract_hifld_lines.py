#!/usr/bin/env python3
"""
extract_hifld_lines.py — Load SeerAI HIFLD transmission lines parquet → SHP + CSV

Reads the manually-placed SeerAI HIFLD Electric Power Transmission Lines parquet,
cleans fields, adds a kv_range bucket column, and writes a shapefile and companion
CSV for use as a standalone map layer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEERAI HIFLD ELECTRIC POWER TRANSMISSION LINES DATASET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Source:    SeerAI via source.coop (original data: Oak Ridge National Laboratory
           for DHS CISA / Homeland Infrastructure Foundation-Level Data (HIFLD))
Page:      https://source.coop/seerai/hifld/transmission-lines/transmission-lines
License:   CC BY 4.0 — credit SeerAI and source.coop
Coverage:  US electric transmission lines ≈ 69–765 kV  (~75,000 records)

Input:     data/raw/hifld/transmission_lines.parquet  (manual placement required)
           Download from the page above (requires a source.coop account), then:
             mkdir -p data/raw/hifld
             cp <downloaded-file> data/raw/hifld/transmission_lines.parquet

Key fields retained:
  ID         — HIFLD unique ID
  OWNER      — utility/operator name
  TYPE       — e.g. "AC; OVERHEAD", "DC; UNDERGROUND"
  STATUS     — IN SERVICE / NOT AVAILABLE / UNDER CONSTRUCTION
  VOLTAGE    — nominal voltage in kV (integer; -999999 = unknown)
  VOLT_CLASS — HIFLD voltage class string ("100-161", "345", "500", etc.)
  INFERRED   — Y if voltage was inferred rather than confirmed
  SUB_1      — name of substation at one end
  SUB_2      — name of substation at other end
  VAL_DATE   — validation date
  kv_range   — derived voltage bucket matching OSM transmission line convention

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage:
  python scripts/extract_hifld_lines.py
  python scripts/extract_hifld_lines.py -o data/build/transmission_hifld.gpkg
"""

import argparse
import logging
import os
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_hifld_lines")

try:
    import pandas as pd
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: pandas/geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Source constants
# ---------------------------------------------------------------------------
RAW_FILE = Path("data/raw/hifld/transmission_lines.parquet")
SEERAI_PAGE_URL = "https://source.coop/seerai/hifld/transmission-lines/transmission-lines"


# ---------------------------------------------------------------------------
# Load and process
# ---------------------------------------------------------------------------
def load_and_process(shp_path: Path) -> "gpd.GeoDataFrame":
    log.info("Reading parquet: %s ...", shp_path)
    gdf = gpd.read_parquet(str(shp_path))
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    log.info("  Records: %d  |  CRS: %s", len(gdf), gdf.crs)

    # Normalise column names to uppercase
    gdf.columns = [c.strip().upper() if c != "geometry" else c for c in gdf.columns]

    # Resolve field name variations across HIFLD export versions
    _rename = {}
    for old, new in [("SHAPE__LEN", "SHAPE_LEN"), ("SHAPE__LENGTH", "SHAPE_LEN"),
                     ("SHAPE_LEN_", "SHAPE_LEN")]:
        if old in gdf.columns:
            _rename[old] = new
    if _rename:
        gdf = gdf.rename(columns=_rename)

    # Convert epoch-millisecond timestamps → readable dates.
    # SeerAI stores VAL_DATE/SOURCEDATE as corrupted int32 — discard those.
    for col in ("SOURCEDATE", "VAL_DATE"):
        if col in gdf.columns:
            numeric = pd.to_numeric(gdf[col], errors="coerce")
            if numeric.notna().any() and (numeric > 1e9).any():
                gdf[col] = pd.to_datetime(numeric, unit="ms", utc=True).dt.strftime("%Y-%m-%d")
            elif numeric.notna().any():
                # int32 junk (SeerAI artifact) — discard
                gdf[col] = pd.NA

    # VOLTAGE: -999999 → NaN; column is kV
    if "VOLTAGE" in gdf.columns:
        gdf["VOLTAGE"] = pd.to_numeric(gdf["VOLTAGE"], errors="coerce").replace(-999999, pd.NA)

    # kv_range bucket (mirrors OSM transmission line convention in enrich_osm_tags.py)
    kv = pd.to_numeric(gdf.get("VOLTAGE"), errors="coerce")
    cats = pd.cut(
        kv.where(kv > 0),
        bins=[0, 50, 100, 200, 300, 400, 500, 600, float("inf")],
        labels=["0-50", "50-100", "100-200", "200-300",
                "300-400", "400-500", "500-600", "600+"],
        right=False,
    )
    gdf["kv_range"] = cats.cat.add_categories("unknown").fillna("unknown").astype(str)

    # Keep only useful columns (drop NAICS boilerplate, duplicate shape-length fields)
    keep = [c for c in [
        "ID", "TYPE", "STATUS", "OWNER", "VOLTAGE", "VOLT_CLASS",
        "INFERRED", "SUB_1", "SUB_2", "VAL_DATE", "kv_range",
    ] if c in gdf.columns] + ["geometry"]
    gdf = gdf[keep]

    # Summary
    log.info("  STATUS breakdown:")
    for status, cnt in gdf["STATUS"].value_counts().items():
        log.info("    %-30s %d", status, cnt)
    log.info("  kv_range breakdown:")
    for rng, cnt in gdf["kv_range"].value_counts().items():
        log.info("    %-12s %d", rng, cnt)
    if "VOLTAGE" in gdf.columns:
        kv2 = pd.to_numeric(gdf["VOLTAGE"], errors="coerce")
        log.info("  VOLTAGE: min=%.0f kV  max=%.0f kV  unknown=%d",
                 kv2.min(), kv2.max(), kv2.isna().sum())

    return gdf


# ---------------------------------------------------------------------------
# Write outputs
# ---------------------------------------------------------------------------
def write_outputs(gdf: "gpd.GeoDataFrame", out_shp: Path) -> None:
    out_shp.parent.mkdir(parents=True, exist_ok=True)

    # Delete any existing sidecar files first
    for f in out_shp.parent.glob(out_shp.stem + ".*"):
        f.unlink()

    out_shp = out_shp.with_suffix(".gpkg")
    log.info("Writing GeoPackage: %s ...", out_shp)
    gdf.to_file(str(out_shp), driver="GPKG")
    log.info("  ✓ %s  (%d features)", out_shp.name, len(gdf))

    # Companion CSV with midpoint lon/lat
    csv_path = out_shp.with_suffix(".csv")
    ctr = gdf.geometry.to_crs("EPSG:3857").centroid.to_crs("EPSG:4326")
    valid = ~(gdf.geometry.is_empty | gdf.geometry.isna())
    csv_df = gdf.drop(columns="geometry").copy()
    csv_df.insert(0, "lat", ctr.y.where(valid).round(6))
    csv_df.insert(0, "lon", ctr.x.where(valid).round(6))
    csv_df.to_csv(str(csv_path), index=False)
    log.info("  ✓ %s  (midpoint lat/lon + attributes)", csv_path.name)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Load SeerAI HIFLD transmission lines parquet → SHP + CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "-o", "--output",
        default="data/build/transmission_hifld.gpkg",
        help="Output GeoPackage path (default: data/build/transmission_hifld.gpkg)",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    if not RAW_FILE.exists():
        log.error("Input parquet not found: %s", RAW_FILE)
        log.error("Download the SeerAI Transmission Lines parquet from:")
        log.error("  %s", SEERAI_PAGE_URL)
        log.error("and place it at %s, then re-run.", RAW_FILE)
        sys.exit(1)

    gdf = load_and_process(RAW_FILE)
    write_outputs(gdf, Path(args.output))

    log.info("")
    log.info("Done. Source: %s", SEERAI_PAGE_URL)


if __name__ == "__main__":
    main()
