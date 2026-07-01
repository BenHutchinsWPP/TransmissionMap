#!/usr/bin/env python3
"""
extract_osm_datacenters.py — OSM PBF → CSV (telecom=data_center facilities)

Handles all three OSM geometry types:
  node      — point-tagged data center (use coords directly)
  closed way — building footprint (centroid computed)
  relation  — campus / complex multipolygon (centroid computed)

OSM tags matched (any one of):
  telecom=data_center
  building=data_center
  building=data_centre

Fields extracted (all others dropped):
  osm_id       — OSM element ID
  name         — facility name
  operator     — who operates it (Google, Amazon, Equinix, etc.)
  website      — URL when present
  addr_city    — city (from addr:city)
  addr_state   — state / province (from addr:state)
  start_date   — opening date (from start_date or opening_date)

Deduplication: polygon/multipolygon centroid within _DEDUP_RADIUS_M of a
node → node wins (deliberately-placed point preferred over computed centroid).

Usage:
  python extract_osm_datacenters.py                          # auto-detects PBF
  python extract_osm_datacenters.py -i data/raw/osm/na.osm.pbf
  python extract_osm_datacenters.py -o data/build/datacenter_osm.csv
"""

import argparse
import json
import logging
import math
import os
import sys
import tempfile
from pathlib import Path

from osm_common import _run, _has, find_pbf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_osm_datacenters")

try:
    import pandas as pd
    import numpy as np
    from scipy.spatial import cKDTree
except ImportError:
    sys.stderr.write("ERROR: pandas/numpy/scipy not found. Run: source venv/bin/activate\n")
    sys.exit(1)

COLS = ["lon", "lat", "osm_id", "osm_type", "name", "operator",
        "website", "addr_city", "addr_state", "start_date"]

_DEDUP_RADIUS_M = 100

# Tags used to identify data centers in osmium tags-filter expressions.
_OSMIUM_FILTERS = [
    "telecom=data_center",
    "building=data_center",
    "building=data_centre",
]


def _centroid(geom):
    """Return (lon, lat) centroid of a Polygon or MultiPolygon, or None."""
    gtype = geom.get("type")
    try:
        if gtype == "Polygon":
            ring = geom["coordinates"][0]
        elif gtype == "MultiPolygon":
            ring = geom["coordinates"][0][0]
        elif gtype == "Point":
            c = geom["coordinates"]
            return round(c[0], 6), round(c[1], 6)
        else:
            return None
        lons = [c[0] for c in ring]
        lats = [c[1] for c in ring]
        return round(sum(lons) / len(lons), 6), round(sum(lats) / len(lats), 6)
    except (IndexError, ZeroDivisionError, KeyError):
        return None


def _row_from_feature(feat):
    """Extract a COLS-matching dict from a GeoJSON-Seq feature, or None."""
    props = feat.get("properties") or {}
    geom  = feat.get("geometry") or {}

    coord = _centroid(geom)
    if coord is None:
        return None

    lon, lat = coord
    osm_type = props.get("@type", "node")
    osm_id   = props.get("@id")

    start = (props.get("start_date") or props.get("opening_date") or "").strip()

    return {
        "lon":        lon,
        "lat":        lat,
        "osm_id":     osm_id,
        "osm_type":   osm_type,
        "name":       props.get("name", "").strip() or None,
        "operator":   props.get("operator", "").strip() or None,
        "website":    props.get("website", "").strip() or None,
        "addr_city":  props.get("addr:city", "").strip() or None,
        "addr_state": props.get("addr:state", "").strip() or None,
        "start_date": start or None,
    }


def extract(pbf_path, tmp_dir):
    """
    1. osmium tags-filter → dc_only.osm.pbf
    2. osmium export      → dc.geojsonseq (all geometry types)
    3. Parse features     → two DataFrames (nodes, poly-centroids)
    4. Deduplicate        → node wins when a polygon centroid is within _DEDUP_RADIUS_M
    """
    pbf_path   = Path(pbf_path)
    dc_pbf     = Path(tmp_dir) / "dc_only.osm.pbf"
    dc_geojson = Path(tmp_dir) / "dc.geojsonseq"

    log.info("Step 1/3: osmium tags-filter (%d patterns) ...", len(_OSMIUM_FILTERS))
    _run(
        ["osmium", "tags-filter", str(pbf_path), *_OSMIUM_FILTERS,
         "-o", str(dc_pbf), "--overwrite"],
        "osmium tags-filter",
    )

    log.info("Step 2/3: osmium export (all geometry types) ...")
    _run(
        ["osmium", "export",
         "-f", "geojsonseq",
         str(dc_pbf),
         "-a", "type,id",          # add @type and @id as properties
         "-o", str(dc_geojson),
         "--overwrite"],
        "osmium export",
    )

    log.info("Step 3/3: Parsing GeoJSON-Seq ...")
    nodes, polys = [], []
    skipped = 0

    with open(dc_geojson) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue

            r = _row_from_feature(feat)
            if r is None:
                skipped += 1
                continue

            (nodes if r["osm_type"] == "node" else polys).append(r)

    log.info("  Raw: %d nodes  %d polygon centroids  %d skipped",
             len(nodes), len(polys), skipped)

    node_df = pd.DataFrame(nodes)
    poly_df = pd.DataFrame(polys)
    return node_df, poly_df


def deduplicate(node_df, poly_df, radius_m=_DEDUP_RADIUS_M):
    """
    Drop polygon-centroid rows that fall within radius_m of a node.
    Node wins: deliberately-placed point is more accurate than a computed centroid.
    """
    frames = [df for df in (node_df, poly_df) if not df.empty]
    if not frames:
        return pd.DataFrame(columns=COLS)

    merged = pd.concat(frames, ignore_index=True).reindex(columns=COLS)

    if node_df.empty or poly_df.empty:
        return merged

    R     = 6_371_000.0
    chord = 2 * math.sin(radius_m / (2 * R))

    def _xyz(lats, lons):
        la = np.deg2rad(np.asarray(lats, dtype=float))
        lo = np.deg2rad(np.asarray(lons, dtype=float))
        return np.column_stack([np.cos(la)*np.cos(lo),
                                np.cos(la)*np.sin(lo),
                                np.sin(la)])

    poly_rows  = merged[merged["osm_type"].isin(["way", "relation"])]
    node_rows  = merged[merged["osm_type"] == "node"]
    node_xyz   = _xyz(node_rows["lat"].values, node_rows["lon"].values)
    tree       = cKDTree(node_xyz)

    valid_polys = poly_rows.dropna(subset=["lat", "lon"])
    poly_xyz    = _xyz(valid_polys["lat"].values, valid_polys["lon"].values)
    dists, _    = tree.query(poly_xyz, k=1, distance_upper_bound=chord * 1.5)
    dup_mask    = dists < chord * 1.5
    dup_idx     = valid_polys.index[dup_mask]

    n_removed = len(dup_idx)
    merged = merged.drop(index=dup_idx)
    log.info("  Dedup: %d polygon rows → %d kept  (%d within %dm of a node)",
             len(poly_rows), len(poly_rows) - n_removed, n_removed, radius_m)

    return merged


def write_csv(df, out_csv):
    df = df.drop(columns=["osm_type"], errors="ignore")

    _nan_strings = {"nan", "NaN", "None", "none", "NULL", "null", "<NA>"}
    for col in df.select_dtypes(include="object").columns:
        df[col] = df[col].replace(_nan_strings, None)

    df.to_csv(str(out_csv), index=False)

    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s  (%d features)", out_csv, len(df))
    for col in ["name", "operator", "website", "addr_city", "addr_state", "start_date"]:
        if col in df.columns:
            filled = df[col].notna().sum()
            log.info("  %-12s %4d  (%.0f%%)", col, filled, 100 * filled / max(len(df), 1))
    if "operator" in df.columns:
        log.info("  Top operators:")
        for op, cnt in df["operator"].value_counts().head(8).items():
            log.info("    %-30s %d", op, cnt)
    log.info("=" * 60)


def main():
    ap = argparse.ArgumentParser(
        description="Extract OSM data center features → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-i", "--input",     help="Input .osm.pbf (auto-detected if omitted)")
    ap.add_argument("-I", "--input-dir", default="data/raw/osm",
                    help="Directory to search for PBF (default: data/raw/osm)")
    ap.add_argument("-o", "--output",    default="data/build/datacenter_osm.csv",
                    help="Output CSV (default: data/build/datacenter_osm.csv)")
    ap.add_argument("--dedup-radius",    type=float, default=float(_DEDUP_RADIUS_M),
                    help=f"Dedup radius in metres (default: {_DEDUP_RADIUS_M})")
    ap.add_argument("-v", "--verbose",   action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    if args.input:
        pbf = Path(args.input)
    else:
        pbf = Path(find_pbf(args.input_dir))
        if not pbf:
            log.error("No .osm.pbf found in %s — pass -i <file>", args.input_dir)
            sys.exit(1)

    if not pbf.exists():
        log.error("PBF not found: %s", pbf)
        sys.exit(1)

    log.info("Input PBF: %s  (%.1f GB)", pbf, pbf.stat().st_size / 1e9)

    if not _has("osmium"):
        log.error("osmium-tool not found. Install: sudo apt install osmium-tool")
        sys.exit(1)

    out_csv = Path(args.output)
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="osm_dc_") as tmp:
        node_df, poly_df = extract(pbf, tmp)
        merged = deduplicate(node_df, poly_df, radius_m=args.dedup_radius)

    write_csv(merged, out_csv)


if __name__ == "__main__":
    main()
