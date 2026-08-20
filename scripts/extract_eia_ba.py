#!/usr/bin/env python3
"""Extract EIA Balancing Authorities → trimmed GeoJSON, SHP + CSV for the map.

Pipeline role (mirrors the other extract_*.py scripts):
    ArcGIS FeatureServer  ->  this script  ->  data/build/eia_ba.{gpkg,csv}
    then scripts/build_tiles.py tiles and packages them.

Source: ArcGIS FeatureServer
  https://services5.arcgis.com/bsqU0jSPAuI04L89/arcgis/rest/services/Balancing_Authorities/FeatureServer/0
  85 polygon features; auto-downloads to data/raw/eia-ba/balancing_authorities.geojson.

Output schema:
  name, abbrev, area_sqmi, color

The upstream NETGENMWH / NETGENRNG net-generation columns are an undated
snapshot, so they are dropped here rather than served.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.ops import unary_union

from geo_common import write_shp_csv

RAW_DIR  = Path("data/raw/eia-ba")
BUILD    = Path("data/build")
GEOJSON_FILE = RAW_DIR / "balancing_authorities.geojson"

ARCGIS_QUERY_BASE = (
    "https://services5.arcgis.com/bsqU0jSPAuI04L89/arcgis/rest/services/"
    "Balancing_Authorities/FeatureServer/0/query"
)

# ── helpers ────────────────────────────────────────────────────────────────────

def clean_str(s):
    """Replace 'NOT AVAILABLE' sentinel with empty string."""
    if isinstance(s, str) and s.strip().upper() == "NOT AVAILABLE":
        return ""
    return s if isinstance(s, str) else (s if not pd.isna(s) else "")

def clean_int(v, sentinel=-999999):
    """Replace -999999 sentinel with None; convert to int."""
    try:
        f = float(v)
        return None if f <= sentinel else int(round(f))
    except (TypeError, ValueError):
        return None

# 12 well-separated hues. Greedy graph coloring keeps touching areas apart, so
# the palette only needs to be big enough for the densest neighbourhood.
NEAR_DEG = 0.6   # ~65 km at mid-latitudes — "visually adjacent" on a zoomed-out map

PALETTE = [
    "#2563eb", "#f97316", "#16a34a", "#db2777", "#0891b2", "#ca8a04",
    "#7c3aed", "#dc2626", "#059669", "#c026d3", "#0284c7", "#65a30d",
]


def _clean_geometry(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Repair upstream rings so the fills triangulate cleanly.

    A fifth of the source polygons carry self-intersections, nested shells or
    degenerate rings; make_valid can hand back mixed collections, so the
    polygonal parts are kept and everything else dropped.
    """
    bad = int((~gdf.geometry.is_valid).sum())
    if bad:
        print(f"  repairing {bad} invalid geometries (make_valid)")
        fixed = gdf.geometry.make_valid()
        gdf = gdf.assign(geometry=[
            g if g.geom_type in ("Polygon", "MultiPolygon")
            else unary_union([p for p in getattr(g, "geoms", [])
                              if p.geom_type in ("Polygon", "MultiPolygon")])
            for g in fixed])
        still = int((~gdf.geometry.is_valid).sum())
        print(f"  invalid after repair: {still}")
    return gdf


def _assign_colors(gdf: gpd.GeoDataFrame) -> list:
    """Map-color the areas: no two that touch or overlap share a color.

    Welsh-Powell — build the adjacency graph with a spatial self-join, then walk
    the areas most-neighbours-first, giving each the first palette color none of
    its neighbours already holds. Areas count as neighbours within NEAR_DEG of
    each other, not just where they touch, so a near-miss pair still reads apart.
    """
    near = gdf[["geometry"]].copy()
    near["geometry"] = near.geometry.buffer(NEAR_DEG)
    pairs = gpd.sjoin(near, near, how="inner", predicate="intersects")
    adj = {i: set() for i in range(len(gdf))}
    for left, right in zip(pairs.index, pairs["index_right"]):
        if left != right:
            adj[left].add(right)
            adj[right].add(left)

    colors = {}
    for i in sorted(adj, key=lambda k: -len(adj[k])):
        taken = {colors[n] for n in adj[i] if n in colors}
        colors[i] = next(c for c in range(len(PALETTE) + len(adj[i]) + 1)
                         if c not in taken)

    over = max(colors.values()) + 1 - len(PALETTE)
    if over > 0:
        print(f"  WARNING: needed {over} more colors than the palette holds; "
              f"reusing from the start")
    return [PALETTE[colors[i] % len(PALETTE)] for i in range(len(gdf))]


# ── ArcGIS download ────────────────────────────────────────────────────────────

def download_arcgis_geojson(url_base: str, out_path: Path) -> None:
    """Download paginated ArcGIS FeatureServer query → merged FeatureCollection."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_features = []
    result_offset = 0

    while True:
        params = {
            "where": "1=1",
            "outFields": "*",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": result_offset,
            "resultRecordCount": 2000,
        }

        url = f"{url_base}?{urllib.parse.urlencode(params)}"
        print(f"  Fetching {result_offset}...", flush=True)

        with urllib.request.urlopen(url, timeout=30) as response:
            data = json.loads(response.read().decode())

        features = data.get("features", [])
        if not features:
            break

        all_features.extend(features)

        # Stop if transfer limit not exceeded
        if not data.get("exceededTransferLimit", False):
            break

        result_offset += len(features)

    # Write merged FeatureCollection
    out_geojson = {
        "type": "FeatureCollection",
        "features": all_features,
    }

    with open(out_path, "w") as f:
        json.dump(out_geojson, f, indent=2)

    print(f"  Downloaded {len(all_features)} features to {out_path}")


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    os.chdir(Path(__file__).parent.parent)
    BUILD.mkdir(parents=True, exist_ok=True)

    # Auto-download if missing
    if not GEOJSON_FILE.exists():
        print("=== Downloading EIA Balancing Authorities ===")
        download_arcgis_geojson(ARCGIS_QUERY_BASE, GEOJSON_FILE)

    # Read the GeoJSON
    print("\n=== Processing Balancing Authorities ===")
    gdf = gpd.read_file(GEOJSON_FILE)

    # Ensure EPSG:4326
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")

    gdf = _clean_geometry(gdf)

    # Map upstream fields → output, with cleaning
    gdf_out = gpd.GeoDataFrame({
        "name":         gdf["BAL_AUTH"].apply(clean_str),
        "abbrev":       gdf["BA_Abbrev"].apply(clean_str),
        "area_sqmi":    [clean_int(v) for v in gdf["Area_sq_mi"]],
        "color":        _assign_colors(gdf),
    }, geometry=gdf.geometry, crs="EPSG:4326")

    # Write output
    print(f"  features: {len(gdf_out)}")
    write_shp_csv(gdf_out, BUILD / "eia_ba.shp", indent="  ")

    print("\nDone.")


if __name__ == "__main__":
    main()
