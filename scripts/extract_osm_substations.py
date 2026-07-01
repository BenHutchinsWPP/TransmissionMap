#!/usr/bin/env python3
"""
extract_osm_substations.py — Extract ALL power=substation features from OSM PBF → CSV

Uses osmium export (not ogr2ogr) for polygon substations so that all ~80k
closed-way polygon substations are captured, not just the ~500 relation
multipolygons that OGR's default osmconf.ini produces.

OSM substation geometry types:
  node      — simple point substation (tagged power=substation on a node)
  closed way — polygon substation area (most common; tagged power=substation on a way)
  relation  — complex multipolygon substation (largest sites)

Output:
  power_substation_all.csv   — all three types merged, deduplicated by OSM ID

Usage:
  python extract_osm_substations.py                        # uses data/raw/osm/*.osm.pbf
  python extract_osm_substations.py -i data/raw/osm/myfile.pbf
  python extract_osm_substations.py -o data/build/mysubs.csv
"""

import argparse
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path

from shapely.geometry import shape as _shape

from osm_common import _run, _has, find_pbf


# ---------------------------------------------------------------------------
# Voltage parsing
# ---------------------------------------------------------------------------
def _to_kv(v: int) -> int:
    """Convert a raw OSM voltage integer to kV.

    OSM convention is volts (138000), but many mappers enter kV directly (138).
    Heuristic: ≥ 1000 → volts, divide by 1000.  < 1000 → already kV, use as-is.
    All standard transmission/distribution voltages (12, 34, 69, 115, 138, 230,
    345, 500, 765 kV) are well below 1000, so the boundary is unambiguous.
    """
    return v // 1000 if v >= 1000 else v


def _best_name(props: dict) -> str:
    """Return the best available name from an OSM property dict.

    Fallback chain (most-to-least authoritative):
      name → alt_name → official_name → name:en → loc_name

    'old_name' and 'short_name' are intentionally excluded:
      old_name   = historical name, potentially misleading
      short_name = internal abbreviation (e.g. 'BTS', 'GIB'), not a public label
    """
    for key in ("name", "alt_name", "official_name", "name:en", "loc_name"):
        v = props.get(key)
        if v and str(v).strip():
            return str(v).strip()
    return ""


def _best_name_hstore(ot: str) -> str:
    """Same fallback chain but parsed from an OGR hstore other_tags string."""
    for key in ("name", "alt_name", "official_name", "name:en", "loc_name"):
        m = re.search(rf'"{re.escape(key)}"=>"([^"]+)"', ot)
        if m:
            return m.group(1).strip()
    return ""


def _parse_voltage(v_str: str):
    """Parse an OSM voltage string → (nominal_kv: int|None, voltage_raw: str).

    Handles:
      '138000'          → (138, '138')
      '138'             → (138, '138')      ← kV already; previously gave (0, '0')
      '345000;138000'   → (345, '345;138')
      '345;138'         → (345, '345;138')
      ''  / None        → (None, '')
    """
    if not v_str:
        return None, ""
    levels = sorted(
        {_to_kv(int(p)) for p in str(v_str).split(";") if p.strip().isdigit() and int(p) > 0},
        reverse=True,
    )
    if not levels:
        return None, ""
    return levels[0], ";".join(str(v) for v in levels)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_osm_substations")

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
try:
    import pandas as pd
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: pandas / geopandas not found. Run: source venv/bin/activate\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Extract polygon substations via osmium export
# ---------------------------------------------------------------------------
def extract_polygon_substations(pbf_path, tmp_dir):
    """
    1. osmium tags-filter → substation-only PBF
    2. osmium export → GeoJSON-Seq (polygon + multipolygon geometry)
    3. Parse GeoJSON-Seq → DataFrame with lon/lat centroid

    Returns a DataFrame.
    """
    sub_pbf = Path(tmp_dir) / "subs_only.osm.pbf"
    sub_geojson = Path(tmp_dir) / "subs_polys.geojsonseq"

    log.info("Step 1/3: osmium tags-filter (power=substation) ...")
    _run(["osmium", "tags-filter", str(pbf_path), "power=substation",
          "-o", str(sub_pbf), "--overwrite"],
         "osmium tags-filter")

    log.info("Step 2/3: osmium export (polygon + multipolygon geometry) ...")
    _run(["osmium", "export",
          "-f", "geojsonseq",
          str(sub_pbf),
          "--geometry-types=polygon,multipolygon",
          "-a", "type,id",    # include @type and @id in properties for deduplication
          "-o", str(sub_geojson),
          "--overwrite"],
         "osmium export")

    log.info("Step 3/3: Parsing GeoJSON-Seq and extracting centroids + polygon geometry ...")
    rows = []
    geoms = []   # shapely geometry objects — one per row
    skipped = 0

    with open(sub_geojson) as f:
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
            if props.get("power") != "substation":
                skipped += 1
                continue

            geom = feat.get("geometry") or {}
            gtype = geom.get("type")
            if gtype not in ("MultiPolygon", "Polygon"):
                skipped += 1
                continue

            # Centroid via average of outer ring coordinates
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

            # osmium export -a type,id provides @id (int) and @type ("way"/"relation")
            osm_id   = props.get("@id")
            osm_type = props.get("@type", "way")

            # Voltage — match enrich_osm_tags.py sub_poly_fdefs:
            #   nominal_kv  = highest level in kV as integer  (e.g. 345)
            #   voltage_raw = all levels in kV, desc order    (e.g. "345;138")
            nominal_kv, voltage_raw = _parse_voltage(props.get("voltage", ""))

            row = {
                "lon":         clon,
                "lat":         clat,
                "osm_type":    osm_type,
                "osm_id":      osm_id,
                "name":        _best_name(props),
                "operator":    props.get("operator", ""),
                "op_wikidata": props.get("operator:wikidata", ""),
                "voltage_raw": voltage_raw,
                "nominal_kv":  nominal_kv,
                "sub_type":    props.get("substation", ""),
                "ref":         props.get("ref", ""),
            }
            rows.append(row)
            geoms.append(_shape(geom))

    log.info("  Polygon substations: %d  (skipped %d non-substation/non-polygon)",
             len(rows), skipped)

    df = pd.DataFrame(rows)

    # Build GeoDataFrame — SHP field names are capped at 10 chars.
    # Mapping: op_wikidata → op_wikidta, voltage_raw → volt_raw
    if rows:
        poly_df = gpd.GeoDataFrame(
            {
                "osm_id":     [r["osm_id"]      for r in rows],
                "name":       [r["name"]         for r in rows],
                "operator":   [r["operator"]     for r in rows],
                "op_wikidta": [r["op_wikidata"]  for r in rows],
                "volt_raw":   [r["voltage_raw"]  for r in rows],
                "nominal_kv": [r["nominal_kv"]   for r in rows],
                "sub_type":   [r["sub_type"]     for r in rows],
                "ref":        [r["ref"]          for r in rows],
            },
            geometry=geoms,
            crs="EPSG:4326",
        )
    else:
        poly_df = gpd.GeoDataFrame(columns=[
            "osm_id", "name", "operator", "op_wikidta",
            "volt_raw", "nominal_kv", "sub_type", "ref", "geometry",
        ], crs="EPSG:4326")

    return df, poly_df


# ---------------------------------------------------------------------------
# Extract node substations via ogr2ogr
# ---------------------------------------------------------------------------
def extract_node_substations(pbf_path, tmp_dir):
    """
    Use ogr2ogr to extract node (point) substations from the PBF points layer.
    Falls back to geopandas/osmium if ogr2ogr is unavailable.

    Returns a DataFrame.
    """
    if not _has("ogr2ogr"):
        log.warning("ogr2ogr not found; node substations will be skipped.")
        return pd.DataFrame()

    out_shp = Path(tmp_dir) / "subs_nodes.shp"
    # Point substations store power=substation in other_tags
    where = """other_tags LIKE '%"power"=>"substation"%'"""

    # Use project osmconf.ini if present
    local_osmconf = Path(__file__).parent.parent / "osmconf.ini"
    osmconf_args = (["--config", "OSM_CONFIG_FILE", str(local_osmconf)]
                    if local_osmconf.exists() else [])

    log.info("Extracting node (point) substations via ogr2ogr ...")
    ok = _run([
        "ogr2ogr", "-f", "ESRI Shapefile",
        "-lco", "ENCODING=UTF-8",
        "-overwrite",
        *osmconf_args,
        str(out_shp), str(pbf_path),
        "points",
        "-sql", f'SELECT * FROM "points" WHERE {where}',
    ], "ogr2ogr node substations", check=False)

    if not ok or not out_shp.exists():
        log.warning("ogr2ogr node extraction failed or returned no output.")
        return pd.DataFrame()

    try:
        gdf = gpd.read_file(str(out_shp))
    except Exception as e:
        log.warning("Cannot read node shapefile: %s", e)
        return pd.DataFrame()

    rows = []
    for _, feat in gdf.iterrows():
        geom = feat.geometry
        lon = round(geom.x, 6) if geom else None
        lat = round(geom.y, 6) if geom else None

        ot = feat.get("other_tags", "") or ""

        # Voltage — match enrich_osm_tags.py sub_pt_fdefs
        v_m = re.search(r'"voltage"=>"(\d+(?:;\d+)*)"', ot)
        nominal_kv, voltage_raw = _parse_voltage(v_m.group(1) if v_m else "")

        op_m  = re.search(r'"operator"=>"([^"]+)"', ot)
        opwd_m = re.search(r'"operator:wikidata"=>"([^"]+)"', ot)
        sub_m = re.search(r'"substation"=>"([^"]+)"', ot)
        ref_m = re.search(r'"ref"=>"([^"]+)"', ot)

        # Name: OGR promotes 'name' to a direct column; alt_name etc. stay in other_tags
        node_name = str(feat.get("name") or "").strip() or _best_name_hstore(ot)

        rows.append({
            "lon":         lon,
            "lat":         lat,
            "osm_type":    "node",
            "osm_id":      feat.get("osm_id"),
            "name":        node_name,
            "operator":    op_m.group(1)   if op_m   else "",
            "op_wikidata": opwd_m.group(1) if opwd_m else "",
            "voltage_raw": voltage_raw,
            "nominal_kv":  nominal_kv,
            "sub_type":    sub_m.group(1)  if sub_m  else "",
            "ref":         ref_m.group(1)  if ref_m  else "",
        })

    log.info("  Node substations: %d", len(rows))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Merge and write CSV
# ---------------------------------------------------------------------------
def merge_and_write(poly_df, node_df, out_csv):
    """Merge polygon-centroid and node DataFrames → write the unified CSV."""
    frames = [df for df in [poly_df, node_df] if not df.empty]
    if not frames:
        log.error("No substations extracted — check input PBF and osmium installation.")
        sys.exit(1)

    # Canonical column order matching enrich_osm_tags.py sub_poly_fdefs / sub_pt_fdefs
    COLS = ["lon", "lat", "osm_type", "osm_id", "name",
            "operator", "op_wikidata", "voltage_raw", "nominal_kv", "sub_type", "ref"]

    merged = pd.concat(frames, ignore_index=True).reindex(columns=COLS)

    # De-duplicate by (osm_type, osm_id) — way/12345 and node/12345 are different objects.
    before = len(merged)
    merged["_dedup_key"] = merged["osm_type"].astype(str) + "/" + merged["osm_id"].astype(str)
    merged = merged.drop_duplicates(subset=["_dedup_key"], keep="first").drop(columns=["_dedup_key"])
    dupes = before - len(merged)
    if dupes:
        log.info("  Removed %d duplicate (osm_type, osm_id) pairs", dupes)

    # Normalise empty strings → None so sort treats them as NaN (goes last)
    for col in ["name", "operator", "op_wikidata", "voltage_raw", "sub_type", "ref"]:
        if col in merged.columns:
            merged[col] = merged[col].replace("", None)

    # Sort: named substations first, then by nominal_kv descending within each group
    merged = merged.sort_values(
        ["name", "nominal_kv"],
        ascending=[True, False],
        na_position="last",
    )

    # osm_type (way/node/relation) served its purpose for deduplication; drop from output
    merged = merged.drop(columns=["osm_type"], errors="ignore")

    # Scrub "nan"/"NaN"/"None" strings from all object columns (pandas NaN artifact)
    _nan_strings = {"nan", "NaN", "None", "none", "NULL", "null", "<NA>"}
    for col in merged.select_dtypes(include="object").columns:
        merged[col] = merged[col].replace(_nan_strings, None)

    merged.to_csv(str(out_csv), index=False)
    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s", out_csv)
    log.info("  Total substations : %d", len(merged))
    poly_ct = len(poly_df)
    node_ct = len(node_df)
    log.info("  From polygons     : %d  (closed ways + relations)", poly_ct)
    log.info("  From nodes        : %d  (point-tagged substations)", node_ct)
    if "nominal_kv" in merged.columns:
        kv = merged["nominal_kv"].dropna()
        gte230 = (kv >= 230).sum()
        log.info("  ≥ 230 kV          : %d  (transmission-level)", gte230)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Write polygon shapefile
# ---------------------------------------------------------------------------
def write_polygon_shp(poly_gdf, out_shp):
    """Write SubstationPolygons.shp from the GeoDataFrame of actual footprints.

    The SHP contains the same attribute columns as the CSV (with SHP-safe names)
    so the two layers can be joined by osm_id.  Empty-string fields are normalised
    to None so they appear as proper nulls in most GIS apps.

    Fields (all ≤ 10 chars):
      osm_id, name, operator, op_wikidta, volt_raw, nominal_kv, sub_type, ref
    """
    if poly_gdf is None or poly_gdf.empty:
        log.warning("No polygon geometry available — SubstationPolygons.shp not written.")
        return

    out_shp = Path(out_shp)
    out_shp.parent.mkdir(parents=True, exist_ok=True)

    # Normalise empty strings → None for clean nulls in the SHP attribute table
    str_cols = ["name", "operator", "op_wikidta", "volt_raw", "sub_type", "ref"]
    gdf = poly_gdf.copy()
    for col in str_cols:
        if col in gdf.columns:
            gdf[col] = gdf[col].replace("", None)

    # Force all to MultiPolygon so the SHP has a single geometry type
    from shapely.geometry import MultiPolygon
    gdf["geometry"] = gdf["geometry"].apply(
        lambda g: MultiPolygon([g]) if g.geom_type == "Polygon" else g
    )

    gdf.to_file(str(Path(out_shp).with_suffix(".gpkg")), driver="GPKG")

    log.info("")
    log.info("=" * 60)
    log.info("OUTPUT: %s", out_shp)
    log.info("  Polygon features  : %d", len(gdf))
    if "nominal_kv" in gdf.columns:
        kv = gdf["nominal_kv"].dropna()
        gte230 = (kv >= 230).sum()
        log.info("  ≥ 230 kV          : %d  (transmission-level)", gte230)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Extract all OSM power=substation features → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-i", "--input",  help="Input .osm.pbf file (auto-detected if omitted)")
    ap.add_argument("-I", "--input-dir", default="data/raw/osm",
                    help="Directory to search for PBF if -i not given (default: data/raw/osm)")
    ap.add_argument("-o", "--output", default="data/build/substation_osm.csv",
                    help="Output CSV path (default: data/build/substation_osm.csv)")
    ap.add_argument("--poly-shp", default="data/build/substation_polygons.gpkg",
                    help="Output GeoPackage path for polygon footprints "
                         "(default: data/build/substation_polygons.gpkg; pass empty string to skip)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    # Change to script directory so relative paths work
    os.chdir(Path(__file__).parent.parent)

    # Locate PBF
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

    log.info("Input PBF : %s  (%.1f GB)", pbf, os.path.getsize(pbf) / 1e9)

    if not _has("osmium"):
        log.error("osmium-tool not found. Install: sudo apt install osmium-tool")
        sys.exit(1)

    out_csv = Path(args.output)
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="osm_subs_") as tmp:
        poly_df, poly_gdf = extract_polygon_substations(pbf, tmp)
        node_df = extract_node_substations(pbf, tmp)
        merge_and_write(poly_df, node_df, out_csv)
        if args.poly_shp:
            write_polygon_shp(poly_gdf, args.poly_shp)


if __name__ == "__main__":
    main()
