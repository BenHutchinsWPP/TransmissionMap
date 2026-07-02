#!/usr/bin/env python3
"""
extract_mines.py — MSHA Mines dataset → filtered GeoJSON of large US mines.

Joins the MSHA Mines master file with the quarterly Employment/Production file
on MINE_ID, keeps mines whose PEAK quarterly average employment >= THRESHOLD
(default 50 → ~2.3k points, in the 2–4k target), and writes a minimal GeoJSON
FeatureCollection served like other point layers (gzipped, lazy-loaded — NO
tippecanoe; owner rejected tiling for this layer).

Inputs (unzip the two MSHA zips into data/raw/mines/ first):
  data/raw/mines/Mines.txt               (pipe-delimited, latin-1)
  data/raw/mines/MinesProdQuarterly.txt  (pipe-delimited, latin-1)
Portal: https://arlweb.msha.gov/opengovernmentdata/ogimsha.asp

Output:
  data/layers/mines.geojson  (gzipped to .gz by build step)

Properties kept per feature: name, status (active|retired), cat (commodity
category id), commodity (human string), operator, employees (peak), state.
"""

import argparse
import csv
import json
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("extract_mines")

# csv fields can be long (DIRECTIONS_TO_MINE etc.)
csv.field_size_limit(10_000_000)

THRESHOLD_DEFAULT = 50

# Commodity category from the PRIMARY_SIC text. Ordered: first match wins, so
# metals are tested before the industrial catch-all. Keyword substring match on
# the lowercased SIC string. Categories/colors mirror src/colors/minerals.ts.
_CATEGORY_RULES = [
    ("precious",   ["gold", "silver", "platinum"]),
    ("base",       ["copper", "lead", "zinc", "nickel", "tin ", "lead-zinc", "bauxite"]),
    ("ferroalloy", ["iron", "manganese", "chromium", "chromite", "molybdenum",
                    "tungsten", "titanium", "vanadium", "ferroalloy", "cobalt"]),
    ("battery",    ["lithium", "rare earth", "graphite", "beryllium", "niobium",
                    "tantalum", "columbium"]),
    ("energy",     ["coal", "uranium", "oil", "gas", "peat", "geothermal",
                    "lignite", "anthracite"]),
    ("gem",        ["gem"]),
    ("industrial", ["stone", "sand", "gravel", "clay", "limestone", "gypsum",
                    "cement", "lime", "sulfur", "phosphate", "potash", "salt",
                    "barite", "talc", "feldspar", "silica", "mica", "shale",
                    "traprock", "granite", "sandstone", "slate", "marble",
                    "dolomite", "pumice", "perlite", "borate", "fluorspar",
                    "kaolin", "bentonite", "diatomite", "vermiculite",
                    "wollastonite", "zeolite", "nonmetallic", "abrasive"]),
]


def categorize(sic: str) -> str:
    s = (sic or "").lower()
    for cat, kws in _CATEGORY_RULES:
        if any(kw in s for kw in kws):
            return cat
    return "other"


ACTIVE_STATUSES = {"Active", "Intermittent", "New Mine"}


def peak_employment(prod_path: Path) -> dict:
    """MINE_ID → max AVG_EMPLOYEE_CNT across all quarters."""
    peak: dict = {}
    with open(prod_path, encoding="latin-1", newline="") as f:
        for row in csv.DictReader(f, delimiter="|"):
            try:
                e = float(row["AVG_EMPLOYEE_CNT"] or 0)
            except ValueError:
                continue
            mid = row["MINE_ID"]
            if e > peak.get(mid, 0):
                peak[mid] = e
    return peak


def build(mines_path: Path, prod_path: Path, threshold: int) -> dict:
    log.info("Reading peak employment from %s …", prod_path.name)
    peak = peak_employment(prod_path)

    feats = []
    with open(mines_path, encoding="latin-1", newline="") as f:
        for row in csv.DictReader(f, delimiter="|"):
            mid = row["MINE_ID"]
            emp = peak.get(mid, 0)
            if emp < threshold:
                continue
            try:
                lon = float(row["LONGITUDE"]); lat = float(row["LATITUDE"])
            except ValueError:
                continue
            if lon == 0 or lat == 0:
                continue
            sic = row["PRIMARY_SIC"].strip()
            status = "active" if row["CURRENT_MINE_STATUS"] in ACTIVE_STATUSES else "retired"
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                "properties": {
                    "name": row["CURRENT_MINE_NAME"].strip() or "Mine",
                    "status": status,
                    "cat": categorize(sic),
                    "commodity": sic,
                    "operator": row["CURRENT_OPERATOR_NAME"].strip(),
                    "employees": int(emp),
                    "state": row["STATE"].strip(),
                },
            })

    log.info("Kept %d mines (peak employment >= %d)", len(feats), threshold)
    return {"type": "FeatureCollection", "features": feats}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", default="data/raw/mines", help="dir with the two MSHA .txt files")
    ap.add_argument("-o", "--out", default="data/layers/mines.geojson")
    ap.add_argument("-t", "--threshold", type=int, default=THRESHOLD_DEFAULT)
    args = ap.parse_args()

    raw = Path(args.raw)
    mines_path = raw / "Mines.txt"
    prod_path = raw / "MinesProdQuarterly.txt"
    for p in (mines_path, prod_path):
        if not p.exists():
            log.error("missing %s — unzip the MSHA zips into %s", p, raw)
            return 1

    fc = build(mines_path, prod_path, args.threshold)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc), encoding="utf-8")
    log.info("Wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
