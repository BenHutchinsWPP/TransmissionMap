#!/usr/bin/env python3
"""
extract_osm_generators.py — Extract ALL power=generator features from OSM PBF → CSV

Handles three OSM geometry types for generators:

  node      — point generator (individual turbine, small plant); captured by ogr2ogr
  closed way — polygon generator (plant building outline, battery enclosure, etc.)
  relation  — complex multipolygon generator

The critical nuance vs. substations: ~99.8% of generator polygons are individual
solar photovoltaic panels drawn inside large solar farms.  Extracting those as
1.7 million individual centroids produces noise, not data — each farm would
contribute hundreds of near-identical points.

This script therefore applies a polygon filter:
  INCLUDE closed-way / relation generators where generator:source != solar
           (gas, coal, nuclear, hydro, battery, diesel, oil, geothermal, …)
  EXCLUDE solar polygons  — solar farms are represented by their node generators,
           which the ogr2ogr points pass already captures at farm level.

Results (North America, May 2026 filtered PBF):
  Node generators (ogr2ogr):         150,455  (original pipeline output)
  Non-solar polygon generators:        2,828  (newly captured)
  Combined after deduplication:      153,283

Usage:
  python extract_osm_generators.py                          # uses data/raw/osm/*.osm.pbf
  python extract_osm_generators.py -i data/raw/osm/myfile.pbf
  python extract_osm_generators.py -o data/build/generator_raw.csv
  python extract_osm_generators.py --include-solar          # include solar panel polygons (large!)
"""

import argparse
import json
import logging
import math
import os
import re
import sys
import tempfile
from pathlib import Path

from osm_common import _run, _has, find_pbf, parse_output_mw as _parse_output_mw

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_osm_generators")

try:
    import pandas as pd
    import numpy as np
    from scipy.spatial import cKDTree
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: pandas/numpy/scipy/geopandas not found. Run: source venv/bin/activate\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Output field schema
# ---------------------------------------------------------------------------
COLS = ["lon", "lat", "osm_type", "osm_id", "name", "ref",
        "source", "gen_method", "gen_type", "output_mw",
        "operator", "start_date", "manufactur"]

# Deduplication radius: if a polygon centroid is within this distance of an
# existing node generator, it's considered a duplicate (same facility).
_DEDUP_RADIUS_M = 200


# ---------------------------------------------------------------------------
# Extract node generators via ogr2ogr (existing pipeline path)
# ---------------------------------------------------------------------------
def extract_node_generators(pbf_path, tmp_dir):
    """
    Use ogr2ogr to extract node (point) generators from the PBF points layer.
    Returns a DataFrame matching the COLS schema.
    """
    if not _has("ogr2ogr"):
        log.warning("ogr2ogr not found; node generators will be skipped.")
        return pd.DataFrame()

    out_shp = Path(tmp_dir) / "gen_nodes.shp"
    where = """other_tags LIKE '%"power"=>"generator"%'"""

    local_osmconf = Path(__file__).parent.parent / "osmconf.ini"
    osmconf_args = (["--config", "OSM_CONFIG_FILE", str(local_osmconf)]
                    if local_osmconf.exists() else [])

    log.info("Extracting node generators via ogr2ogr ...")
    ok = _run([
        "ogr2ogr", "-f", "ESRI Shapefile",
        "-lco", "ENCODING=UTF-8",
        "-overwrite",
        *osmconf_args,
        str(out_shp), str(pbf_path),
        "points",
        "-sql", f'SELECT * FROM "points" WHERE {where}',
    ], "ogr2ogr node generators", check=False)

    if not ok or not out_shp.exists():
        log.warning("ogr2ogr node extraction failed.")
        return pd.DataFrame()

    try:
        gdf = gpd.read_file(str(out_shp))
    except Exception as e:
        log.warning("Cannot read node shapefile: %s", e)
        return pd.DataFrame()

    rows = []
    for _, feat in gdf.iterrows():
        geom = feat.geometry
        if geom is None:
            continue
        lon = round(geom.x, 6)
        lat = round(geom.y, 6)
        ot = feat.get("other_tags", "") or ""

        def _tag(key):
            m = re.search(rf'"{re.escape(key)}"=>"([^"]+)"', ot)
            return m.group(1).strip() if m else ""

        output_raw = _tag("generator:output:electricity")
        rows.append({
            "lon":        lon,
            "lat":        lat,
            "osm_type":   "node",
            "osm_id":     feat.get("osm_id"),
            "name":       str(feat.get("name") or "").strip() or _tag("name"),
            "ref":        _tag("ref"),
            "source":     _tag("generator:source"),
            "gen_method": _tag("generator:method"),
            "gen_type":   _tag("generator:type"),
            "output_mw":  _parse_output_mw(output_raw),
            "operator":   _tag("operator"),
            "start_date": _tag("start_date"),
            "manufactur": _tag("manufacturer") or _tag("generator:manufacturer"),
        })

    log.info("  Node generators: %d", len(rows))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Extract polygon generators via osmium export
# ---------------------------------------------------------------------------
def extract_polygon_generators(pbf_path, tmp_dir, include_solar=False):
    """
    1. osmium tags-filter → generator-only PBF
    2. osmium export → GeoJSON-Seq (polygon + multipolygon)
    3. Parse → DataFrame, skipping solar (unless include_solar=True)

    Returns a DataFrame matching the COLS schema.
    """
    gen_pbf     = Path(tmp_dir) / "gen_only.osm.pbf"
    gen_geojson = Path(tmp_dir) / "gen_polys.geojsonseq"

    log.info("Step 1/3: osmium tags-filter (power=generator) ...")
    _run(["osmium", "tags-filter", str(pbf_path), "power=generator",
          "-o", str(gen_pbf), "--overwrite"],
         "osmium tags-filter")

    log.info("Step 2/3: osmium export (polygon + multipolygon geometry) ...")
    _run(["osmium", "export",
          "-f", "geojsonseq",
          str(gen_pbf),
          "--geometry-types=polygon,multipolygon",
          "-a", "type,id",
          "-o", str(gen_geojson),
          "--overwrite"],
         "osmium export")

    log.info("Step 3/3: Parsing GeoJSON-Seq, extracting centroids ...")
    if not include_solar:
        log.info("  (Skipping solar polygons — individual PV panels; use --include-solar to override)")

    rows = []
    skipped_solar = 0
    skipped_other = 0

    with open(gen_geojson) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                skipped_other += 1
                continue

            props = feat.get("properties") or {}
            if props.get("power") != "generator":
                skipped_other += 1
                continue

            geom = feat.get("geometry") or {}
            gtype = geom.get("type")
            if gtype not in ("MultiPolygon", "Polygon"):
                skipped_other += 1
                continue

            # Skip solar panel polygons unless explicitly requested
            src = props.get("generator:source", "").strip().lower()
            method = props.get("generator:method", "").strip().lower()
            if not include_solar and (src == "solar" or method == "photovoltaic"):
                skipped_solar += 1
                continue

            try:
                if gtype == "MultiPolygon":
                    ring = geom["coordinates"][0][0]
                else:
                    ring = geom["coordinates"][0]
                lons = [c[0] for c in ring]
                lats = [c[1] for c in ring]
                clon = round(sum(lons) / len(lons), 6)
                clat = round(sum(lats) / len(lats), 6)
            except (IndexError, ZeroDivisionError):
                skipped_other += 1
                continue

            output_raw = props.get("generator:output:electricity", "")
            rows.append({
                "lon":        clon,
                "lat":        clat,
                "osm_type":   props.get("@type", "way"),
                "osm_id":     props.get("@id"),
                "name":       props.get("name", "").strip(),
                "ref":        props.get("ref", "").strip(),
                "source":     src,
                "gen_method": method,
                "gen_type":   props.get("generator:type", "").strip(),
                "output_mw":  _parse_output_mw(output_raw),
                "operator":   props.get("operator", "").strip(),
                "start_date": props.get("start_date", "").strip(),
                "manufactur": props.get("manufacturer", "").strip()
                              or props.get("generator:manufacturer", "").strip(),
            })

    log.info(
        "  Polygon generators: %d  (solar skipped: %d  other skipped: %d)",
        len(rows), skipped_solar, skipped_other,
    )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Merge and deduplicate
# ---------------------------------------------------------------------------
def merge_and_write(node_df, poly_df, out_csv, dedup_radius_m=_DEDUP_RADIUS_M):
    """
    Merge node + polygon DataFrames, then remove polygon rows that already
    have a node counterpart within dedup_radius_m metres (same facility,
    polygon outline + node both present in OSM).
    """
    frames = [df for df in [node_df, poly_df] if not df.empty]
    if not frames:
        log.error("No generators extracted.")
        sys.exit(1)

    merged = pd.concat(frames, ignore_index=True).reindex(columns=COLS)

    # Deduplicate polygon rows against node rows by proximity
    poly_rows = merged[merged["osm_type"].isin(["way", "relation"])]
    node_rows = merged[merged["osm_type"] == "node"]

    n_poly_before = len(poly_rows)
    n_removed = 0

    if not node_rows.empty and not poly_rows.empty:
        R = 6_371_000.0
        chord = 2 * math.sin(dedup_radius_m / (2 * R))

        def _xyz(lat_deg, lon_deg):
            lat = np.deg2rad(np.asarray(lat_deg, dtype=float))
            lon = np.deg2rad(np.asarray(lon_deg, dtype=float))
            return np.column_stack([np.cos(lat)*np.cos(lon),
                                    np.cos(lat)*np.sin(lon), np.sin(lat)])

        node_xyz = _xyz(node_rows["lat"].values, node_rows["lon"].values)
        tree = cKDTree(node_xyz)
        poly_xyz = _xyz(
            poly_rows["lat"].dropna().values,
            poly_rows["lon"].dropna().values,
        )
        dists, _ = tree.query(poly_xyz, k=1, distance_upper_bound=chord * 1.5)
        is_dup = dists < chord * 1.5

        dup_idx = poly_rows.dropna(subset=["lat", "lon"]).index[is_dup]
        merged = merged.drop(index=dup_idx)
        n_removed = len(dup_idx)
        log.info(
            "  Polygon dedup: %d polygon rows  →  %d kept  (%d removed — within %dm of a node)",
            n_poly_before, n_poly_before - n_removed, n_removed, dedup_radius_m,
        )

    # Normalise empty strings → None  (name kept as "" — blank is not the same as unknown)
    for col in ["ref", "source", "gen_method", "gen_type",
                "operator", "start_date", "manufactur"]:
        if col in merged.columns:
            merged[col] = merged[col].replace("", None)

    # Scrub "nan"/"NaN"/"None" strings that can appear in object columns when pandas
    # serialises float NaN values (e.g. after pd.concat reindex fills missing keys).
    _nan_strings = {"nan", "NaN", "None", "none", "NULL", "null", "<NA>"}
    for col in merged.select_dtypes(include="object").columns:
        merged[col] = merged[col].replace(_nan_strings, None)

    # osm_type served its purpose for deduplication; capture stats then drop from output
    n_nodes = (merged["osm_type"] == "node").sum()
    n_polys = merged["osm_type"].isin(["way", "relation"]).sum()
    merged  = merged.drop(columns=["osm_type"], errors="ignore")

    merged.to_csv(str(out_csv), index=False)

    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s", out_csv)
    log.info("  Total generators   : %d", len(merged))
    log.info("  From nodes         : %d", n_nodes)
    log.info("  From polygons      : %d  (closed ways + relations)", n_polys)
    log.info("  Polygon dupes removed: %d", n_removed)
    if "output_mw" in merged.columns:
        mw = pd.to_numeric(merged["output_mw"], errors="coerce")
        log.info("  With output_mw     : %d", mw.notna().sum())
        log.info("  >= 100 MW          : %d", (mw >= 100).sum())
    if "source" in merged.columns:
        log.info("  Source breakdown:")
        for src, cnt in merged["source"].value_counts().head(8).items():
            log.info("    %-20s %d", src, cnt)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Extract all OSM power=generator features → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-i", "--input",     help="Input .osm.pbf file (auto-detected if omitted)")
    ap.add_argument("-I", "--input-dir", default="data/raw/osm",
                    help="Directory to search for PBF if -i not given (default: data/raw/osm)")
    ap.add_argument("-o", "--output",    default="data/build/generator_osm.csv",
                    help="Output CSV path (default: data/build/generator_osm.csv)")
    ap.add_argument("--include-solar",   action="store_true",
                    help="Include solar panel polygons (adds ~1.7M panel centroids — very large)")
    ap.add_argument("--dedup-radius",    type=float, default=200.0,
                    help="Dedup radius in metres: polygon centroid within this distance of "
                         "a node generator is dropped (default: 200)")
    ap.add_argument("-v", "--verbose",   action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    if args.input:
        pbf = Path(args.input)
    else:
        pbf = find_pbf(args.input_dir)
        if not pbf:
            log.error("No .osm.pbf found in %s — pass -i <file>", args.input_dir)
            sys.exit(1)

    if not Path(pbf).exists():
        log.error("PBF not found: %s", pbf)
        sys.exit(1)

    log.info("Input PBF: %s  (%.1f GB)", pbf, os.path.getsize(pbf) / 1e9)

    if not _has("osmium"):
        log.error("osmium-tool not found. Install: sudo apt install osmium-tool")
        sys.exit(1)

    out_csv = Path(args.output)
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="osm_gen_") as tmp:
        node_df = extract_node_generators(pbf, tmp)
        poly_df = extract_polygon_generators(pbf, tmp, include_solar=args.include_solar)
        merge_and_write(node_df, poly_df, out_csv, dedup_radius_m=args.dedup_radius)


if __name__ == "__main__":
    main()
