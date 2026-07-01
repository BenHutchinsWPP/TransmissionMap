#!/usr/bin/env python3
"""
extract_osm_plants.py — Extract OSM power=plant features from OSM PBF → CSV

Captures plant-level records (whole facilities), not individual generators:

  node      — plant centroid node (most common tagging for smaller facilities)
  closed way — plant area polygon (large facilities mapped as polygons)
  relation  — complex multipolygon plants

Key OSM tags used:
  plant:source              → fuel type (wind, solar, hydro, nuclear, coal, gas, …)
  plant:output:electricity  → total nameplate capacity (e.g. "500 MW", "1.2 GW")
  name                      → facility name
  operator                  → operating company
  start_date                → commissioning date

Results (North America, May 2026):
  Typically 5,000–15,000 plant features — small enough to serve as GeoJSON.

Usage:
  python extract_osm_plants.py                          # uses data/raw/osm/*.osm.pbf
  python extract_osm_plants.py -i data/raw/osm/myfile.pbf
  python extract_osm_plants.py -o data/build/plant_osm.csv
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

from osm_common import (
    _run, _has, find_pbf,
    parse_output_mw as _parse_output_mw,
    normalise_plant_source as _normalise_source,
)
from osm_plant_polygons import extract_site_relation_plants, build_plant_polygons

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_osm_plants")

try:
    import pandas as pd
    import numpy as np
    from scipy.spatial import cKDTree
    import geopandas as gpd
    from shapely.geometry import shape as shp_shape
except ImportError:
    sys.stderr.write("ERROR: pandas/numpy/scipy/geopandas not found. Run: source venv/bin/activate\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Output field schema
# ---------------------------------------------------------------------------
COLS = ["lon", "lat", "osm_id", "name", "source", "output_mw", "operator", "start_date"]

# Deduplication radius: polygon centroid within this distance of a node → drop polygon
_DEDUP_RADIUS_M = 500   # larger than generators since plants are big facilities


# ---------------------------------------------------------------------------
# Extract plant nodes via ogr2ogr
# ---------------------------------------------------------------------------
def extract_node_plants(pbf_path, tmp_dir):
    """Extract power=plant point nodes from the PBF."""
    if not _has("ogr2ogr"):
        log.warning("ogr2ogr not found; node plants will be skipped.")
        return pd.DataFrame()

    out_shp = Path(tmp_dir) / "plant_nodes.shp"
    where = """other_tags LIKE '%"power"=>"plant"%'"""

    local_osmconf = Path(__file__).parent.parent / "osmconf.ini"
    osmconf_args = (["--config", "OSM_CONFIG_FILE", str(local_osmconf)]
                    if local_osmconf.exists() else [])

    log.info("Extracting plant nodes via ogr2ogr ...")
    ok = _run([
        "ogr2ogr", "-f", "ESRI Shapefile",
        "-lco", "ENCODING=UTF-8",
        "-overwrite",
        *osmconf_args,
        str(out_shp), str(pbf_path),
        "points",
        "-sql", f'SELECT * FROM "points" WHERE {where}',
    ], "ogr2ogr plant nodes", check=False)

    if not ok or not out_shp.exists():
        log.warning("ogr2ogr plant node extraction failed or returned empty.")
        return pd.DataFrame()

    try:
        gdf = gpd.read_file(str(out_shp))
    except Exception as e:
        log.warning("Cannot read plant node shapefile: %s", e)
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

        output_raw = _tag("plant:output:electricity")
        rows.append({
            "lon":        lon,
            "lat":        lat,
            "osm_type":   "node",
            "osm_id":     feat.get("osm_id"),
            "name":       str(feat.get("name") or "").strip() or _tag("name"),
            "source":     _normalise_source(_tag("plant:source")),
            "output_mw":  _parse_output_mw(output_raw),
            "operator":   _tag("operator"),
            "start_date": _tag("start_date"),
        })

    log.info("  Plant nodes: %d", len(rows))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Extract plant polygons/relations via osmium
# ---------------------------------------------------------------------------
def extract_polygon_plants(pbf_path, tmp_dir):
    """
    Extract power=plant polygon and multipolygon-relation centroids from the PBF.

    Returns (DataFrame, plant_pbf_path) — the plant PBF is reused by
    extract_site_relation_plants() for the two-pass pyosmium centroid step.

    Member nodes of site-type relations are included in the plant PBF by
    default (osmium tags-filter includes referenced objects unless -R is given),
    so their coordinates are available in Pass 2.
    """
    plant_pbf     = Path(tmp_dir) / "plant_only.osm.pbf"
    plant_geojson = Path(tmp_dir) / "plant_polys.geojsonseq"

    # Note: this osmium version includes referenced objects by default
    # (use -R / --omit-referenced to suppress them — we do NOT want that here,
    #  since member nodes of site relations must be in the plant PBF for Pass 2).
    log.info("Step 1/3: osmium tags-filter (power=plant, member nodes included by default) ...")
    _run(["osmium", "tags-filter", str(pbf_path), "power=plant",
          "-o", str(plant_pbf), "--overwrite"],
         "osmium tags-filter")

    log.info("Step 2/3: osmium export (polygon + multipolygon geometry) ...")
    _run(["osmium", "export",
          "-f", "geojsonseq",
          str(plant_pbf),
          "--geometry-types=polygon,multipolygon",
          "-a", "type,id",
          "-o", str(plant_geojson),
          "--overwrite"],
         "osmium export")

    log.info("Step 3/3: Parsing GeoJSON-Seq, extracting centroids ...")
    rows = []
    geom_dict = {}   # osm_id (str) → Shapely geometry (full polygon, for polygon SHP output)
    skipped = 0

    with open(plant_geojson) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue

            props = feat.get("properties") or {}
            if props.get("power") != "plant":
                skipped += 1
                continue

            geom = feat.get("geometry") or {}
            gtype = geom.get("type")
            if gtype not in ("MultiPolygon", "Polygon"):
                skipped += 1
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
                skipped += 1
                continue

            output_raw = props.get("plant:output:electricity", "")
            osm_id = props.get("@id")
            if osm_id is not None:
                try:
                    geom_dict[str(osm_id)] = shp_shape(geom)
                except Exception:
                    pass
            rows.append({
                "lon":        clon,
                "lat":        clat,
                "osm_type":   props.get("@type", "way"),
                "osm_id":     osm_id,
                "name":       props.get("name", "").strip(),
                "source":     _normalise_source(props.get("plant:source", "")),
                "output_mw":  _parse_output_mw(output_raw),
                "operator":   props.get("operator", "").strip(),
                "start_date": props.get("start_date", "").strip(),
            })

    log.info("  Plant polygons/relations: %d  (skipped: %d)", len(rows), skipped)
    log.info("  Polygon geometries captured: %d", len(geom_dict))
    captured_ids = {int(r["osm_id"]) for r in rows if r["osm_id"] is not None}
    return pd.DataFrame(rows), plant_pbf, captured_ids, geom_dict


# ---------------------------------------------------------------------------
# Extract site-type plant relations via pyosmium (two-pass centroid)
# ---------------------------------------------------------------------------
def merge_and_write(node_df, poly_df, site_df, out_csv, dedup_radius_m=_DEDUP_RADIUS_M):
    """
    Merge node + polygon DataFrames, then remove polygon rows that already
    have a node counterpart within dedup_radius_m metres.
    """
    frames = [df for df in [node_df, poly_df, site_df] if not df.empty]
    if not frames:
        log.error("No plant features extracted.")
        sys.exit(1)

    merged = pd.concat(frames, ignore_index=True).reindex(columns=["lon","lat","osm_type","osm_id","name","source","output_mw","operator","start_date"])

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
            "  Polygon dedup: %d poly rows → %d kept  (%d removed — within %dm of a node)",
            n_poly_before, n_poly_before - n_removed, n_removed, dedup_radius_m,
        )

    n_nodes = (merged["osm_type"] == "node").sum()
    n_polys = (merged["osm_type"] == "way").sum()
    n_sites = (merged["osm_type"] == "relation").sum()
    merged  = merged.drop(columns=["osm_type"], errors="ignore")

    # Normalise empty strings → None
    for col in ["source", "operator", "start_date"]:
        if col in merged.columns:
            merged[col] = merged[col].replace("", None)

    # Scrub "nan"/"NaN"/"None" strings from all object columns (pandas NaN artifact)
    _nan_strings = {"nan", "NaN", "None", "none", "NULL", "null", "<NA>"}
    for col in merged.select_dtypes(include="object").columns:
        merged[col] = merged[col].replace(_nan_strings, None)

    merged.to_csv(str(out_csv), index=False)

    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s", out_csv)
    log.info("  Total plants       : %d", len(merged))
    log.info("  From nodes         : %d", n_nodes)
    log.info("  From polygons (way): %d", n_polys)
    log.info("  From site relations: %d  ← wind farms etc.", n_sites)
    log.info("  Polygon dupes rmvd : %d", n_removed)
    if "output_mw" in merged.columns:
        mw = pd.to_numeric(merged["output_mw"], errors="coerce")
        log.info("  With output_mw     : %d", mw.notna().sum())
        log.info("  >= 100 MW          : %d", (mw >= 100).sum())
    if "source" in merged.columns:
        log.info("  Source breakdown:")
        for src, cnt in merged["source"].value_counts().head(10).items():
            log.info("    %-20s %d", src, cnt)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Extract all OSM power=plant features → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-i", "--input",     help="Input .osm.pbf file (auto-detected if omitted)")
    ap.add_argument("-I", "--input-dir", default="data/raw/osm",
                    help="Directory to search for PBF if -i not given (default: data/raw/osm)")
    ap.add_argument("-o", "--output",    default="data/build/plant_osm.csv",
                    help="Output CSV path (default: data/build/plant_osm.csv)")
    ap.add_argument("--dedup-radius",    type=float, default=float(_DEDUP_RADIUS_M),
                    help=f"Dedup radius metres (default: {_DEDUP_RADIUS_M})")
    ap.add_argument("--poly-shp",        default=None,
                    help="Output shapefile for plant polygons (default: skip polygon build). "
                         "Enables generation of concave-hull polygons for site-type relations "
                         "and actual OSM polygons for way/relation plants.")
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

    with tempfile.TemporaryDirectory(prefix="osm_plant_") as tmp:
        node_df                               = extract_node_plants(pbf, tmp)
        poly_df, plant_pbf, captured_ids, geom_dict = extract_polygon_plants(pbf, tmp)
        site_df, site_coord_dict              = extract_site_relation_plants(plant_pbf, captured_ids)
        merge_and_write(node_df, poly_df, site_df, out_csv, dedup_radius_m=args.dedup_radius)
        if args.poly_shp:
            log.info("")
            log.info("=== Building plant polygon shapefile ===")
            build_plant_polygons(poly_df, geom_dict, site_df, site_coord_dict, args.poly_shp)


if __name__ == "__main__":
    main()
