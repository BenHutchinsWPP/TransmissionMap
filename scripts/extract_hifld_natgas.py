#!/usr/bin/env python3
"""
extract_hifld_natgas.py — Merge HIFLD natural gas / petroleum parquet datasets
                           → SHP+CSV (pipeline lines) and CSV (facility points)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HIFLD NATURAL GAS & PETROLEUM INFRASTRUCTURE DATASETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Source:    SeerAI via source.coop (original data: EIA / HIFLD / DHS CISA)
License:   U.S. federal government public domain data
Coverage:  Continental US + Alaska/Hawaii infrastructure

Raw inputs (data/raw/hifld/natgas/):
  LINE SOURCES (2):
    natural-gas-interstate-and-intrastate-pipelines.parquet  — 32,961 rows
    hydrocarbon-gas-liquid-pipelines.parquet                 — 133 rows

  POINT SOURCES (9):
    above-ground-lng-storage-facilities.parquet      — 266 rows
    border-crossings---natural-gas.parquet           — 51 rows
    liquified-natural-gas-lng-import-and-export-terminals.parquet — 9 rows
    natural-gas-processing-plants.parquet            — 478 rows
    natural-gas-trading-hubs.parquet                 — 32 rows
    natural-gas-underground-storage.parquet          — 413 rows
    peak-shaving-facilities.parquet                  — 89 rows
    pol-terminals.parquet                            — 2,302 rows
    strategic-petroleum-reserves.parquet             — 4 rows

Outputs:
  data/build/hifld_natgas_lines.gpkg  — merged pipeline lines (pipe_type, operator, name)
  data/build/hifld_natgas_lines.csv  — companion CSV with midpoint lat/lon
  data/build/hifld_natgas_points.csv — merged facility points (normalized schema)

Normalized lines schema:
  pipe_type  Interstate | Intrastate | Gathering | HGL
  operator   operator/company name
  name       pipeline name (HGL only; nat gas has no name field)

Normalized points schema:
  fac_type   facility type bucket id (lng_terminal|underground|trading_hub|spr|
             processing|pol_terminal|lng_storage|peak_shaving|border_cross)
  name       facility name
  operator   operator/company name
  state      state abbreviation or name
  status     operational status (normalized string)
  detail     key additional info (capacity, commodity, pipeline type, etc.)
  lat, lon   WGS84 coordinates

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage:
  python scripts/extract_hifld_natgas.py
  python scripts/extract_hifld_natgas.py -o data/build
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
log = logging.getLogger("extract_hifld_natgas")

try:
    import pandas as pd
    import geopandas as gpd
    from shapely.geometry import Point
except ImportError:
    sys.stderr.write("ERROR: pandas/geopandas/shapely missing. Run: source venv/bin/activate\n")
    sys.exit(1)

RAW_DIR = Path("data/raw/hifld/natgas")

# ── Sentinel cleanup ──────────────────────────────────────────────────────────
# HIFLD datasets use -999 / -999.0 / "NOT AVAILABLE" as null sentinels.
def clean_sentinel(val, sentinels=(-999, -999.0, -999999, "-999", "NOT AVAILABLE",
                                   "NOT APPLICABLE", "N/A", "", None)):
    if val in sentinels:
        return None
    if isinstance(val, float) and val < -900:
        return None
    return val

def _clean_col(series):
    return series.apply(clean_sentinel)


# ─────────────────────────────────────────────────────────────────────────────
# LINES
# ─────────────────────────────────────────────────────────────────────────────

def load_natgas_lines() -> "gpd.GeoDataFrame":
    path = RAW_DIR / "natural-gas-interstate-and-intrastate-pipelines.parquet"
    log.info("Loading nat gas lines: %s", path.name)
    gdf = gpd.read_parquet(str(path))
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    log.info("  %d features  |  CRS: %s", len(gdf), gdf.crs)

    out = gpd.GeoDataFrame({
        "pipe_type": gdf["TYPEPIPE"].str.strip(),
        "operator":  _clean_col(gdf["Operator"].str.strip()),
        "name":      None,
    }, geometry=gdf.geometry, crs=gdf.crs)

    for pt, cnt in out["pipe_type"].value_counts().items():
        log.info("    pipe_type=%-15s %d", pt, cnt)
    return out


def load_hgl_lines() -> "gpd.GeoDataFrame":
    path = RAW_DIR / "hydrocarbon-gas-liquid-pipelines.parquet"
    log.info("Loading HGL lines: %s", path.name)
    gdf = gpd.read_parquet(str(path))
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    log.info("  %d features  |  CRS: %s", len(gdf), gdf.crs)

    out = gpd.GeoDataFrame({
        "pipe_type": "HGL",
        "operator":  _clean_col(gdf["Opername"].str.strip()),
        "name":      _clean_col(gdf["Pipename"].str.strip()),
    }, geometry=gdf.geometry, crs=gdf.crs)

    log.info("    pipe_type=HGL  %d", len(out))
    return out


def build_lines(out_dir: Path) -> None:
    ng  = load_natgas_lines()
    hgl = load_hgl_lines()
    gdf = gpd.GeoDataFrame(pd.concat([ng, hgl], ignore_index=True), crs=ng.crs)

    # Explode MultiLineString → LineString so tippecanoe handles them cleanly
    gdf = gdf.explode(index_parts=False).reset_index(drop=True)
    log.info("Lines total: %d features after explode", len(gdf))

    # Truncate long strings to fit shapefile 254-char field limit
    for col in ("operator", "name"):
        gdf[col] = gdf[col].fillna("").str[:254]

    out_shp = out_dir / "hifld_natgas_lines.gpkg"
    for f in out_dir.glob("hifld_natgas_lines.*"):
        f.unlink()
    log.info("Writing %s ...", out_shp)
    gdf.to_file(str(out_shp), driver="GPKG")
    log.info("  ✓ %s  (%d features)", out_shp.name, len(gdf))

    # Companion CSV (midpoint lat/lon)
    csv_path = out_shp.with_suffix(".csv")
    ctr = gdf.geometry.to_crs("EPSG:3857").centroid.to_crs("EPSG:4326")
    valid = ~(gdf.geometry.is_empty | gdf.geometry.isna())
    csv_df = gdf.drop(columns="geometry").copy()
    csv_df.insert(0, "lat", ctr.y.where(valid).round(6))
    csv_df.insert(0, "lon", ctr.x.where(valid).round(6))
    csv_df.to_csv(str(csv_path), index=False)
    log.info("  ✓ %s", csv_path.name)


# ─────────────────────────────────────────────────────────────────────────────
# POINTS — one loader per dataset
# ─────────────────────────────────────────────────────────────────────────────

def _pt_row(fac_type, name, operator, state, status, detail, lat, lon):
    return {
        "fac_type": fac_type,
        "name":     str(name)[:120] if name else "",
        "operator": str(operator)[:120] if operator else "",
        "state":    str(state)[:50]   if state    else "",
        "status":   str(status)[:50]  if status   else "",
        "detail":   str(detail)[:200] if detail   else "",
        "lat":      round(float(lat), 6) if lat is not None else None,
        "lon":      round(float(lon), 6) if lon is not None else None,
    }


# Row builders: return _pt_row kwargs for one dataframe row, or None to skip it.
# Datasets whose detail needs real logic get a named builder; the rest are
# inline lambdas in POINT_SOURCES.

def _spr_row(r):
    cap = r.get("Capacity")
    detail = f"{cap} MMbbl capacity, {r.get('Caverns')} caverns" if cap else None
    return dict(name=r.get("Site"), operator="US DOE", state=r.get("State"),
                status="Active", detail=detail,
                lat=r.get("Latitude"), lon=r.get("Longitude"))


def _underground_row(r):
    lat, lon = r.get("Latitude"), r.get("Longitude")
    if not lat or not lon:
        return None
    work_cap = r.get("work_cap")
    detail = r.get("Field_Type", "")
    if work_cap and work_cap > 0:
        detail = f"{r.get('Field_Type')} — {int(work_cap):,} Mcf working cap"
    return dict(name=r.get("Field"), operator=clean_sentinel(r.get("Company")),
                state=r.get("State"), status=r.get("Status"), detail=detail,
                lat=lat, lon=lon)


def _processing_row(r):
    lat, lon = r.get("Latitude"), r.get("Longitude")
    if not lat or not lon:
        return None
    cap = clean_sentinel(r.get("Cap_MMcfd"))
    return dict(name=r.get("Plant_Name"), operator=clean_sentinel(r.get("Operator")),
                state=r.get("State"), status="Active",
                detail=f"{cap} MMcfd capacity" if cap else None, lat=lat, lon=lon)


def _pol_terminal_row(r):
    cap = clean_sentinel(r.get("CAPACITY"))
    parts = [p for p in [clean_sentinel(r.get("TYPE")),
                         clean_sentinel(r.get("COMMODITY"))] if p]
    detail = " — ".join(parts[:2]) if parts else None
    if cap and cap > 0:
        detail = (detail + f" ({int(cap):,} bbl)" if detail else f"{int(cap):,} bbl")
    return dict(name=r.get("NAME"), operator=clean_sentinel(r.get("OPERATOR")),
                state=r.get("STATE"), status=r.get("STATUS"), detail=detail,
                lat=r.get("LATITUDE"), lon=r.get("LONGITUDE"))


def _border_row(r):
    vol = r.get("Vol_MMcfd")
    detail = f"{r.get('FrmCountry')} → {r.get('ToCountry')}"
    if vol and vol > 0:
        detail += f"  ({vol} MMcfd)"
    return dict(name=r.get("Pipeline"), operator=clean_sentinel(r.get("Owner")),
                state=r.get("FrmState"), status="Active", detail=detail,
                lat=r.get("Latitude"), lon=r.get("Longitude"))


def _upper_row(r):
    """UPPERCASE-column datasets (lng_storage, peak_shaving): TYPE as detail."""
    return dict(name=r.get("NAME"), operator=clean_sentinel(r.get("OPERATOR")),
                state=r.get("STATE"), status=r.get("STATUS"),
                detail=clean_sentinel(r.get("TYPE")),
                lat=r.get("LATITUDE"), lon=r.get("LONGITUDE"))


# (fac_type, parquet filename, log label, gdf pre-filter or None, row builder)
POINT_SOURCES = [
    ("lng_terminal", "liquified-natural-gas-lng-import-and-export-terminals.parquet",
     "LNG terminal", None,
     # status/detail = Functions: Import / Export / Import/Export
     lambda r: dict(name=r.get("Facility"), operator=clean_sentinel(r.get("Operator")),
                    state=r.get("State"), status=r.get("Functions"),
                    detail=r.get("Functions"),
                    lat=r.get("Latitude"), lon=r.get("Longitude"))),
    ("trading_hub", "natural-gas-trading-hubs.parquet", "trading hub", None,
     lambda r: dict(name=r.get("HubName"), operator=None, state=None,
                    status="Active", detail=None,
                    lat=r.get("Latitude"), lon=r.get("Longitude"))),
    ("spr", "strategic-petroleum-reserves.parquet", "SPR", None, _spr_row),
    ("underground", "natural-gas-underground-storage.parquet",
     "underground storage", None, _underground_row),
    ("processing", "natural-gas-processing-plants.parquet",
     "processing plant", None, _processing_row),
    ("pol_terminal", "pol-terminals.parquet", "POL terminal",
     lambda g: g[g["STATUS"] != "DISMANTLED"], _pol_terminal_row),
    ("lng_storage", "above-ground-lng-storage-facilities.parquet",
     "above-ground LNG storage",
     lambda g: g[g["STATUS"] != "ABANDONED"], _upper_row),
    ("peak_shaving", "peak-shaving-facilities.parquet", "peak shaving", None,
     _upper_row),
    ("border_cross", "border-crossings---natural-gas.parquet", "border crossing",
     None, _border_row),
]


def load_point_source(fac_type, filename, label, prefilter, row_fn) -> list:
    log.info("Loading %ss ...", label)
    gdf = gpd.read_parquet(str(RAW_DIR / filename))
    if prefilter is not None:
        gdf = prefilter(gdf)
    rows = []
    for _, r in gdf.iterrows():
        kwargs = row_fn(r)
        if kwargs is not None:
            rows.append(_pt_row(fac_type=fac_type, **kwargs))
    log.info("  %d %s records", len(rows), label)
    return rows


def build_points(out_dir: Path) -> None:
    all_rows = []
    for spec in POINT_SOURCES:
        all_rows.extend(load_point_source(*spec))

    df = pd.DataFrame(all_rows)
    df = df.dropna(subset=["lat", "lon"])
    df = df[df["lat"].between(-90, 90) & df["lon"].between(-180, 180)]

    log.info("Points total: %d features", len(df))
    log.info("  fac_type breakdown:")
    for ft, cnt in df["fac_type"].value_counts().items():
        log.info("    %-20s %d", ft, cnt)

    out_csv = out_dir / "hifld_natgas_points.csv"
    df.to_csv(str(out_csv), index=False)
    log.info("  ✓ %s", out_csv.name)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Merge HIFLD natural gas / petroleum datasets → SHP + CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-o", "--output", default="data/build",
                    help="Output directory (default: data/build)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    if not RAW_DIR.exists():
        log.error("Raw data directory not found: %s", RAW_DIR)
        log.error("Place parquet files at %s/ then re-run.", RAW_DIR)
        sys.exit(1)

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info("=== Building pipeline lines ===")
    build_lines(out_dir)

    log.info("")
    log.info("=== Building facility points ===")
    build_points(out_dir)

    log.info("")
    log.info("Done. Outputs in %s/", out_dir)


if __name__ == "__main__":
    main()
