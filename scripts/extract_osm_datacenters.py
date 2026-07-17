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

Enriched with IM3 datacenter sqft (ODbL) via nearest building/campus match.
IM3 operator backfills OSM operator where OSM is null (via exact or spatial match).

Fields extracted (all others dropped):
  osm_id       — OSM element ID
  osm_type     — node | way | relation (for OSM links + unambiguous ID joins)
  name         — facility name
  operator     — who operates it (Google, Amazon, Equinix, etc.); backfilled from IM3
  website      — URL when present
  addr_city    — city (from addr:city)
  addr_state   — state / province (from addr:state)
  start_date   — opening date (from start_date or opening_date)
  im3_sqft     — facility size in sqft (IM3 enrichment; exact or spatial match)
  im3_ref      — facility reference code from IM3 (site codes like IAD69, SV1; kept only if matches ^[A-Za-z0-9-]{1,10}$)

Deduplication: polygon/multipolygon centroid within _DEDUP_RADIUS_M of a
node → node wins (deliberately-placed point preferred over computed centroid).

Usage:
  python extract_osm_datacenters.py                          # auto-detects PBF
  python extract_osm_datacenters.py -i data/raw/osm/na.osm.pbf
  python extract_osm_datacenters.py -o data/build/datacenter_osm.csv
  python extract_osm_datacenters.py --no-im3                 # skip IM3 enrichment
"""

import argparse
import json
import logging
import math
import os
import sys
import tempfile
import urllib.request
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
        "website", "addr_city", "addr_state", "start_date", "im3_sqft", "im3_ref"]

_DEDUP_RADIUS_M = 100
_IM3_URL = "https://raw.githubusercontent.com/IMMM-SFA/datacenter-atlas/main/data_center_database/im3_us_data_center_locations.gpkg"
_IM3_DEFAULT_PATH = "data/raw/im3/im3_us_data_center_locations.gpkg"
_IM3_SPATIAL_RADIUS_M = 150

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


def fetch_im3(im3_path):
    """
    Download IM3 GeoPackage if missing. Returns path if successful (or already present),
    None on download failure (pipeline continues offline).
    """
    im3_path = Path(im3_path)
    if im3_path.exists():
        log.info("IM3 GeoPackage found: %s", im3_path)
        return im3_path

    im3_path.parent.mkdir(parents=True, exist_ok=True)
    log.info("Downloading IM3 GeoPackage from %s ...", _IM3_URL)
    try:
        urllib.request.urlretrieve(_IM3_URL, str(im3_path))
        log.info("  Downloaded: %s  (%.1f MB)", im3_path, im3_path.stat().st_size / 1e6)
        return im3_path
    except Exception as e:
        log.warning("IM3 download failed: %s — continuing without IM3 enrichment", e)
        return None


def load_im3(gpkg_path, tmp_dir):
    """
    Load IM3 GeoPackage via ogr2ogr, extract id/sqft/operator/ref/lon/lat from each layer,
    add osm_type, and return merged DataFrame [osm_id, osm_type, sqft, im3_operator, im3_ref, lon, lat].
    im3_ref is cleaned: kept only if it matches ^[A-Za-z0-9-]{1,10}$ (site codes like IAD69, SV1).
    Returns None if gpkg missing or load fails.
    """
    gpkg_path = Path(gpkg_path)
    if not gpkg_path.exists():
        return None

    tmp_dir = Path(tmp_dir)
    dfs = []

    # Layer configs: (layer_name, osm_type)
    layers = [
        ("point", "node"),
        ("building", "way"),
        ("campus", "relation"),
    ]

    for layer_name, osm_type in layers:
        csv_out = tmp_dir / f"im3_{layer_name}.csv"
        try:
            # Use ogr2ogr to extract id, sqft, operator, ref, lon/lat; compute centroid for polygons
            if osm_type == "node":
                sql = f"SELECT id, sqft, operator, ref, lon, lat FROM {layer_name}"
            else:
                # For building/campus: compute centroid
                sql = f"SELECT id, sqft, operator, ref, ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat FROM {layer_name}"

            _run(
                ["ogr2ogr", "-f", "CSV", str(csv_out), str(gpkg_path),
                 "-dialect", "SQLite", "-sql", sql],
                f"ogr2ogr {layer_name}",
                check=False,  # Allow graceful failure if layer missing
            )

            if not csv_out.exists():
                log.debug("  Layer %s not extracted (may not exist)", layer_name)
                continue

            df = pd.read_csv(str(csv_out))
            df["osm_type"] = osm_type
            df.rename(columns={"id": "osm_id", "operator": "im3_operator", "ref": "im3_ref"}, inplace=True)

            # Clean im3_ref: keep only if it matches ^[A-Za-z0-9-]{1,10}$ (site codes like IAD69, SV1)
            # Use pandas .str.fullmatch to check the pattern
            if "im3_ref" in df.columns:
                valid_ref_mask = df["im3_ref"].astype(str).str.fullmatch(r"[A-Za-z0-9-]{1,10}")
                df.loc[~valid_ref_mask, "im3_ref"] = pd.NA

            dfs.append(df)
            log.debug("  Loaded %s: %d rows", layer_name, len(df))
        except Exception as e:
            log.warning("  Failed to load IM3 layer %s: %s", layer_name, e)
            continue

    if not dfs:
        log.warning("No IM3 layers loaded")
        return None

    im3_df = pd.concat(dfs, ignore_index=True)
    # Coerce id to int64, drop rows with null id/lon/lat
    im3_df["osm_id"] = pd.to_numeric(im3_df["osm_id"], errors="coerce").astype("Int64")
    im3_df = im3_df.dropna(subset=["osm_id", "lon", "lat"])
    log.info("IM3 loaded: %d total records", len(im3_df))
    return im3_df[["osm_id", "osm_type", "sqft", "im3_operator", "im3_ref", "lon", "lat"]]


def enrich_im3(df, im3_df, spatial_radius_m=_IM3_SPATIAL_RADIUS_M):
    """
    Enrich df with im3_sqft, im3_operator, and im3_ref via exact match (osm_type, osm_id) then spatial fallback.
    After both passes, backfill df["operator"] in place where it is null/empty and im3_operator is not null.
    Returns df with im3_sqft, im3_ref columns and backfilled operator (im3_operator temp column dropped).
    """
    if im3_df is None or im3_df.empty:
        log.info("IM3 enrichment: no data available")
        df["im3_sqft"] = pd.NA
        df["im3_ref"] = pd.NA
        return df

    # deduplicate() reindexes to COLS, leaving empty im3_* placeholder columns
    # that would collide in the merge (suffixed _x/_y) — drop them first.
    df = df.drop(columns=["im3_sqft", "im3_ref"], errors="ignore")

    # Ensure osm_id is int64 in both dfs for clean join
    df["osm_id"] = df["osm_id"].astype("Int64")
    im3_df_copy = im3_df.copy()
    im3_df_copy["osm_id"] = im3_df_copy["osm_id"].astype("Int64")

    # Pass 1: exact match on (osm_type, osm_id)
    # Pull sqft, im3_operator, and im3_ref alongside
    df = df.merge(
        im3_df_copy[["osm_id", "osm_type", "sqft", "im3_operator", "im3_ref"]].rename(columns={"sqft": "im3_sqft"}),
        on=["osm_id", "osm_type"],
        how="left",
    )

    # Pass 2: spatial match for remaining nulls
    R = 6_371_000.0
    chord = 2 * math.sin(spatial_radius_m / (2 * R))

    def _xyz(lats, lons):
        la = np.deg2rad(np.asarray(lats, dtype=float))
        lo = np.deg2rad(np.asarray(lons, dtype=float))
        return np.column_stack([np.cos(la)*np.cos(lo),
                                np.cos(la)*np.sin(lo),
                                np.sin(la)])

    # Only search for nulls
    null_mask = df["im3_sqft"].isna()
    if null_mask.any():
        null_rows = df[null_mask].copy()
        # Build tree from IM3 records with valid sqft
        im3_with_sqft = im3_df_copy.dropna(subset=["sqft"])
        if not im3_with_sqft.empty:
            im3_xyz = _xyz(im3_with_sqft["lat"].values, im3_with_sqft["lon"].values)
            tree = cKDTree(im3_xyz)

            # Query each null row
            for idx, row in null_rows.iterrows():
                if pd.isna(row["lon"]) or pd.isna(row["lat"]):
                    continue
                point_xyz = _xyz([row["lat"]], [row["lon"]])
                dists, indices = tree.query(point_xyz, k=1, distance_upper_bound=chord * 1.5)
                if dists[0] < chord * 1.5:
                    best_match = im3_with_sqft.iloc[indices[0]]
                    df.loc[idx, "im3_sqft"] = best_match["sqft"]
                    # Also copy im3_operator and im3_ref from the spatial match
                    df.loc[idx, "im3_operator"] = best_match["im3_operator"]
                    df.loc[idx, "im3_ref"] = best_match["im3_ref"]

    # Round im3_sqft to Int64 where present
    df["im3_sqft"] = df["im3_sqft"].apply(
        lambda x: int(round(x)) if pd.notna(x) else pd.NA
    ).astype("Int64")

    # Count results for logging
    exact_matches = (~null_mask).sum()  # Non-null after first merge
    spatial_matches = (null_mask & df["im3_sqft"].notna()).sum()  # Null before, filled by spatial
    total_filled = df["im3_sqft"].notna().sum()
    ref_filled = df["im3_ref"].notna().sum()

    # Backfill operator in place: where df["operator"] is null/empty and im3_operator is not null
    operator_backfill_mask = (df["operator"].isna() | (df["operator"] == "")) & df["im3_operator"].notna()
    operator_backfills = operator_backfill_mask.sum()
    df.loc[operator_backfill_mask, "operator"] = df.loc[operator_backfill_mask, "im3_operator"]

    # Drop the temporary im3_operator column (must not appear in CSV)
    df = df.drop(columns=["im3_operator"])

    log.info("IM3 enrichment: %d exact matches, %d spatial matches, %d total sqft filled, %d ref filled, %d operator backfills",
             exact_matches, spatial_matches, total_filled, ref_filled, operator_backfills)

    return df


def write_csv(df, out_csv):
    # osm_type is kept: the frontend needs it to link the correct OSM object
    # page (node/way/relation), and it disambiguates osm_id joins against
    # external datasets (OSM node and way ID namespaces overlap).
    _nan_strings = {"nan", "NaN", "None", "none", "NULL", "null", "<NA>"}
    for col in df.select_dtypes(include="object").columns:
        df[col] = df[col].replace(_nan_strings, None)

    df.to_csv(str(out_csv), index=False)

    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s  (%d features)", out_csv, len(df))
    for col in ["name", "operator", "website", "addr_city", "addr_state", "start_date", "im3_sqft", "im3_ref"]:
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
    ap.add_argument("--im3",             default=_IM3_DEFAULT_PATH,
                    help=f"IM3 GeoPackage path (default: {_IM3_DEFAULT_PATH})")
    ap.add_argument("--no-im3",          action="store_true",
                    help="Skip IM3 enrichment")
    ap.add_argument("-v", "--verbose",   action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    if args.input:
        pbf = Path(args.input)
    else:
        pbf = Path(find_pbf(args.input_dir, need_tags=_OSMIUM_FILTERS))
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

        # IM3 enrichment (optional)
        im3_df = None
        if not args.no_im3:
            log.info("=== IM3 Enrichment ===")
            im3_path = fetch_im3(args.im3)
            if im3_path:
                im3_df = load_im3(im3_path, tmp)
        else:
            log.info("IM3 enrichment skipped (--no-im3)")

        # Add empty im3_sqft and im3_ref columns if no IM3 data
        if im3_df is None:
            merged["im3_sqft"] = pd.NA
            merged["im3_ref"] = pd.NA

        merged = enrich_im3(merged, im3_df)

    write_csv(merged, out_csv)


if __name__ == "__main__":
    main()
