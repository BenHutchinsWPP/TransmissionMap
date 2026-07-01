#!/usr/bin/env python3
"""
extract_hifld_substations.py — Download and filter HIFLD electric substations → CSV

Loads the HIFLD Electric Substations dataset, strips internal placeholder records
(TAP*, DEADEND*, RISER*, pure numeric IDs), and writes a clean CSV for use as a
standalone map layer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HIFLD ELECTRIC SUBSTATIONS DATASET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Source:    HIFLD / DHS CISA
Copyright: Oak Ridge National Laboratory (ORNL), Los Alamos National Laboratory (LANL),
           Idaho National Laboratory (INL), National Geospatial-Intelligence Agency (NGA),
           Homeland Security Infrastructure Program (HSIP) Team
Program:   Homeland Infrastructure Foundation-Level Data (HIFLD)
Item:      https://www.arcgis.com/home/item.html?id=ef04dc8231c9491e804a008e5faa7d3a
Server:    https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer/0
Coverage:  Continental US substations ≥ 69 kV  (~77,946 records)
License:   Public domain — no use restrictions ("None (Public Use)")

Note: The original HIFLD Open portal closed September 2025. The full national dataset
is hosted as a public ArcGIS Online item (id ef04dc8231c9491e804a008e5faa7d3a) with
77,946 records and the same HIFLD description and license text.

Placeholder names excluded:
  TAP{n}      — transmission tap points    (~19k)  ← not real substations
  DEADEND{n}  — dead-end stubs              (~447)  ← not real substations
  RISER{n}    — riser-pole stubs            (~453)  ← not real substations
  {digits}    — pure numeric IDs

UNKNOWN* records are included with a blank name field.

Download: paginates FeatureServer (2 000 records/page) on first run → data/raw/hifld/electric_substations.csv

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage:
  python scripts/extract_hifld_substations.py
  python scripts/extract_hifld_substations.py -H data/raw/hifld/my_hifld.csv
  python scripts/extract_hifld_substations.py -o data/build/substation_hifld.csv
"""

import argparse
import json
import logging
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_hifld_substations")

try:
    import pandas as pd
except ImportError:
    sys.stderr.write("ERROR: pandas not found.  Run: source venv/bin/activate\n")
    sys.exit(1)

# ---------------------------------------------------------------------------
# HIFLD download — paginates the public ArcGIS FeatureServer
# ---------------------------------------------------------------------------
HIFLD_ITEM_PAGE = "https://www.arcgis.com/home/item.html?id=ef04dc8231c9491e804a008e5faa7d3a"
HIFLD_FEATURE_SERVER = (
    "https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer/0"
)

_CODE_PATTERNS = [
    r"^TAP\d+$",
    r"^DEADEND\d*$",
    r"^RISER\d+$",
    r"^\d+$",
]
_EMPTY_NAMES = {"", "N/A", "UNKNOWN", "NOT AVAILABLE"}


def _is_code(name_upper_series: "pd.Series") -> "pd.Series":
    import re
    mask = pd.Series(False, index=name_upper_series.index)
    for pat in _CODE_PATTERNS:
        mask |= name_upper_series.str.match(pat)
    return mask


def _download_from_featureserver(dest_csv: Path) -> None:
    dest_csv.parent.mkdir(parents=True, exist_ok=True)
    query_url = HIFLD_FEATURE_SERVER + "/query"
    headers = {"User-Agent": "Mozilla/5.0 extract_hifld_substations.py"}

    # Get total count first
    count_params = urllib.parse.urlencode({
        "where": "1=1", "returnCountOnly": "true", "f": "json",
    })
    req = urllib.request.Request(f"{query_url}?{count_params}", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = json.loads(resp.read())["count"]
    log.info("FeatureServer record count: %d  source: %s", total, HIFLD_ITEM_PAGE)

    # Paginate 2 000 records at a time
    all_rows = []
    page_size = 2000
    offset = 0
    while offset < total:
        params = urllib.parse.urlencode({
            "where": "1=1",
            "outFields": "*",
            "returnGeometry": "false",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "f": "json",
        })
        req = urllib.request.Request(f"{query_url}?{params}", headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        features = data.get("features", [])
        if not features:
            break
        all_rows.extend(f["attributes"] for f in features)
        offset += len(features)
        log.info("  %d / %d records downloaded ...", offset, total)

    df = pd.DataFrame(all_rows)
    df.to_csv(str(dest_csv), index=False)
    log.info("  Raw CSV written: %s  (%d records)", dest_csv, len(df))


# ---------------------------------------------------------------------------
# Load and filter
# ---------------------------------------------------------------------------
def load_and_filter(hifld_csv: Path) -> "pd.DataFrame":
    """Load HIFLD CSV, strip internal codes, return clean DataFrame."""
    log.info("Loading HIFLD data from %s ...", hifld_csv)
    raw = pd.read_csv(hifld_csv, low_memory=False)
    raw.columns = [c.strip().upper() for c in raw.columns]

    lat_col  = next((c for c in raw.columns if c in ("LATITUDE",  "LAT", "Y")), None)
    lon_col  = next((c for c in raw.columns if c in ("LONGITUDE", "LON", "LONG", "X")), None)
    name_col = next((c for c in raw.columns if c in ("NAME", "SUBST_NAME", "STATION")), None)
    id_col   = next((c for c in raw.columns if c in ("ID", "OBJECTID", "FID")), None)

    if not (lat_col and lon_col and name_col):
        log.error("Cannot find lat/lon/name columns. Columns: %s", list(raw.columns))
        sys.exit(1)

    raw = raw.rename(columns={lat_col: "lat", lon_col: "lon", name_col: "name"})
    raw["lat"] = pd.to_numeric(raw["lat"], errors="coerce")
    raw["lon"] = pd.to_numeric(raw["lon"], errors="coerce")
    raw = raw.dropna(subset=["lat", "lon", "name"]).reset_index(drop=True)

    name_up = raw["name"].str.strip().str.upper()
    is_code    = _is_code(name_up)
    is_unknown = name_up.str.match(r"^UNKNOWN\d+$") | name_up.isin(_EMPTY_NAMES)
    is_real    = ~is_code & ~is_unknown

    # Voltage: HIFLD uses -999999 as null; values are in kV
    volt_col = next((c for c in raw.columns if "MAX" in c and "VOLT" in c), None)
    raw["max_kv"] = (pd.to_numeric(raw[volt_col], errors="coerce").replace(-999999.0, None)
                     if volt_col else None)

    min_volt_col = next((c for c in raw.columns if "MIN" in c and "VOLT" in c), None)
    raw["min_kv"] = (pd.to_numeric(raw[min_volt_col], errors="coerce").replace(-999999.0, None)
                     if min_volt_col else None)

    raw["hifld_id"] = raw[id_col].astype(str) if id_col else raw.index.astype(str)

    # Title-case real names; blank out UNKNOWN*
    raw["name_clean"] = raw["name"].where(is_real, other=None)
    raw.loc[is_real, "name_clean"] = raw.loc[is_real, "name"].str.strip().str.title()

    # kv_range bucket
    _kv = pd.to_numeric(raw["max_kv"], errors="coerce")
    _cats = pd.cut(
        _kv.where(_kv > 0),
        bins=[0, 50, 100, 200, 300, 400, 500, 600, float("inf")],
        labels=["0-50", "50-100", "100-200", "200-300",
                "300-400", "400-500", "500-600", "600+"],
        right=False,
    )
    raw["kv_range"] = _cats.cat.add_categories("unknown").fillna("unknown").astype(str)

    filtered = raw[~is_code].copy()   # real + UNKNOWN*, no TAP/DEADEND/RISER

    log.info(
        "  HIFLD: %d total  |  codes excluded: %d  |  real-named: %d  |  unnamed (UNKNOWN*): %d",
        len(raw), is_code.sum(), is_real.sum(),
        (is_unknown & ~is_code).sum(),
    )
    return filtered


# ---------------------------------------------------------------------------
# Write output CSV
# ---------------------------------------------------------------------------
def write_csv(filtered: "pd.DataFrame", out_path: Path) -> None:
    df = pd.DataFrame({
        "lat":      filtered["lat"].round(6).values,
        "lon":      filtered["lon"].round(6).values,
        "hifld_id": filtered["hifld_id"].values,
        "name":     filtered["name_clean"].values,
        "max_kv":   filtered["max_kv"].values,
        "min_kv":   filtered["min_kv"].values,
        "kv_range": filtered["kv_range"].values,
    })
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(str(out_path), index=False)
    log.info("OUTPUT: %s  (%d records)", out_path, len(df))
    named = df["name"].notna().sum()
    log.info("  Named: %d  (%.1f%%)  |  Unnamed: %d", named, 100 * named / len(df), len(df) - named)
    kv = pd.to_numeric(df["max_kv"], errors="coerce")
    log.info("  ≥ 230 kV: %d  |  kv_range breakdown:", (kv >= 230).sum())
    for rng, cnt in df["kv_range"].value_counts().items():
        log.info("    %-12s %d", rng, cnt)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Download and filter HIFLD electric substations → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "-H", "--hifld",
        default="data/raw/hifld/electric_substations.csv",
        help="HIFLD CSV; auto-downloaded if absent (default: data/raw/hifld/electric_substations.csv)",
    )
    ap.add_argument(
        "-o", "--output",
        default="data/build/substation_hifld.csv",
        help="Output CSV path (default: data/build/substation_hifld.csv)",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    hifld_csv = Path(args.hifld)
    if not hifld_csv.exists():
        log.info("HIFLD CSV not found — downloading from FeatureServer ...")
        try:
            _download_from_featureserver(hifld_csv)
        except Exception as e:
            log.error(
                "Auto-download failed (%s): %s\n"
                "  Source: %s", type(e).__name__, e, HIFLD_ITEM_PAGE,
            )
            sys.exit(1)

    filtered = load_and_filter(hifld_csv)
    write_csv(filtered, Path(args.output))


if __name__ == "__main__":
    main()
