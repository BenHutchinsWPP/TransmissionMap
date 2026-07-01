#!/usr/bin/env python3
"""
build_releases.py — Build per-layer download ZIP packs.

Reads scripts/release_manifest.yaml and produces one ZIP per layer in
data/releases/, each containing:
  - <name>.geojson + <name>.csv  (vector layers)
  - <name>.tif                   (raster layers)
  - <layer-id>.txt               (layer documentation, converted from .md via pandoc)
  - disclaimer.txt               (static)

Requires pandoc for .md → .txt conversion; falls back to raw .md if not found.

Usage:
  python scripts/build_releases.py [--layer LAYER_ID] [--out DIR]
"""

import argparse
import gzip
import logging
import shutil
import subprocess
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import geopandas as gpd
import pandas as pd
import yaml

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent

_PANDOC_AVAILABLE: bool | None = None  # cached on first use


def md_to_txt(md_path: Path) -> tuple[str, bytes]:
    """Convert a .md file to plain text via pandoc.

    Returns (arcname, content) — arcname is '<stem>.txt' if pandoc succeeded,
    '<stem>.md' as fallback.
    """
    global _PANDOC_AVAILABLE
    if _PANDOC_AVAILABLE is None:
        _PANDOC_AVAILABLE = shutil.which("pandoc") is not None
        if not _PANDOC_AVAILABLE:
            log.warning("pandoc not found — including raw .md files instead of .txt")

    if _PANDOC_AVAILABLE:
        result = subprocess.run(
            ["pandoc", "-t", "plain", "--wrap=none", str(md_path)],
            capture_output=True,
        )
        if result.returncode == 0:
            return md_path.stem + ".txt", result.stdout

    return md_path.name, md_path.read_bytes()


def load_vector(spec: dict) -> gpd.GeoDataFrame:
    """Load a vector source into a GeoDataFrame."""
    if "geojson_gz" in spec:
        path = ROOT / spec["geojson_gz"]
        with gzip.open(path) as f:
            return gpd.read_file(f)
    if "shp" in spec:
        return gpd.read_file(ROOT / spec["shp"])
    if "geojson" in spec:
        return gpd.read_file(ROOT / spec["geojson"])
    if "csv" in spec:
        df = pd.read_csv(ROOT / spec["csv"])
        lat, lon = spec.get("lat_col", "lat"), spec.get("lon_col", "lon")
        gdf = gpd.GeoDataFrame(
            df.drop(columns=[lat, lon]),
            geometry=gpd.points_from_xy(df[lon], df[lat]),
            crs="EPSG:4326",
        )
        return gdf
    raise ValueError(f"No recognised source key in spec: {list(spec)}")


def _clean_geometry(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Repair geometries so the exported GeoJSON opens cleanly in Google Earth.

    Two failure modes are fixed here:
      * Self-intersecting / unclosed polygon rings — Google Earth Pro rejects the
        whole file with a parse error (the HIFLD retail-territory and
        control-area polygons trip this). ``make_valid`` rebuilds them.
      * Z / M coordinates — flattened to 2D, since Google Earth treats GeoJSON Z
        as absolute altitude and can bury polygons underground.

    Only invalid features are rebuilt, so already-clean layers pass through
    unchanged (aside from the cheap 2D flatten).
    """
    geom = gdf.geometry
    # Flatten any 3D/4D coordinates to lon/lat only.
    if bool(geom.has_z.any()):
        from shapely import force_2d

        geom = geom.apply(lambda g: force_2d(g) if g is not None else g)

    invalid = ~geom.is_valid & geom.notna()
    n_invalid = int(invalid.sum())
    if n_invalid:
        log.info("    repairing %d invalid geometr%s (make_valid)",
                 n_invalid, "y" if n_invalid == 1 else "ies")
        geom = geom.make_valid()
        # make_valid can emit GeometryCollections / stray lines from sliver
        # rings; keep only the polygonal parts so the layer stays a clean
        # (Multi)Polygon and Google Earth doesn't choke on mixed geometry.
        from shapely import GeometryCollection
        from shapely.geometry import MultiPolygon, Polygon

        def _polys_only(g):
            if g is None or isinstance(g, (Polygon, MultiPolygon)):
                return g
            if isinstance(g, GeometryCollection):
                parts = []
                for p in g.geoms:
                    if isinstance(p, MultiPolygon):
                        parts.extend(p.geoms)
                    elif isinstance(p, Polygon):
                        parts.append(p)
                if parts:
                    return parts[0] if len(parts) == 1 else MultiPolygon(parts)
            return g

        geom = geom.apply(_polys_only)

    return gdf.set_geometry(geom)


def write_vector_files(
    gdf: gpd.GeoDataFrame, stem: str, zf: zipfile.ZipFile, csv_only: bool = False
) -> None:
    """Write GeoJSON + CSV (or CSV only) into an open ZipFile."""
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")

    gdf = _clean_geometry(gdf)

    if not csv_only:
        buf = BytesIO()
        gdf.to_file(buf, driver="GeoJSON")
        zf.writestr(f"{stem}.geojson", buf.getvalue())

    # CSV — attributes + lon/lat representative point
    pts = gdf.representative_point()
    csv_df = gdf.drop(columns="geometry").copy()
    csv_df.insert(0, "lon", pts.x.round(6))
    csv_df.insert(0, "lat", pts.y.round(6))
    zf.writestr(f"{stem}.csv", csv_df.to_csv(index=False))


def build_vector_zip(
    layer_id: str,
    entry: dict,
    disclaimer: Path,
    out_dir: Path,
) -> Path:
    out = out_dir / f"{layer_id}.zip"
    doc = ROOT / entry["doc"]

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if "files" in entry:
            for stem, spec in entry["files"].items():
                log.info("  loading %s ...", stem)
                gdf = load_vector(spec)
                write_vector_files(gdf, stem, zf, csv_only=spec.get("csv_only", False))
        else:
            log.info("  loading %s ...", layer_id)
            gdf = load_vector(entry)
            write_vector_files(gdf, layer_id, zf, csv_only=entry.get("csv_only", False))

        doc_arcname, doc_content = md_to_txt(doc)
        zf.writestr(doc_arcname, doc_content)
        zf.write(disclaimer, "disclaimer.txt")

    return out


def build_raster_zip(
    layer_id: str,
    entry: dict,
    disclaimer: Path,
    out_dir: Path,
) -> Path:
    tif = ROOT / entry["tif"]
    doc = ROOT / entry["doc"]
    out = out_dir / f"{layer_id}.zip"

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(tif, f"{layer_id}.tif")
        doc_arcname, doc_content = md_to_txt(doc)
        zf.writestr(doc_arcname, doc_content)
        zf.write(disclaimer, "disclaimer.txt")

    return out


def source_exists(entry: dict) -> bool:
    """Return False (with a warning) if any required source file is missing."""
    sources = {}
    if "files" in entry:
        for stem, spec in entry["files"].items():
            sources[stem] = spec
    else:
        sources[entry.get("doc", "layer")] = entry

    for name, spec in sources.items():
        for key in ("geojson_gz", "shp", "geojson", "csv", "tif"):
            if key in spec:
                p = ROOT / spec[key]
                if not p.exists():
                    log.warning("  [skip] %s — source not found: %s", name, p)
                    return False
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layer", help="Build only this layer ID")
    ap.add_argument("--out", default="data/releases", help="Output directory")
    args = ap.parse_args()

    manifest_path = Path(__file__).parent / "release_manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())

    disclaimer = ROOT / manifest["disclaimer"]
    if not disclaimer.exists():
        log.error("disclaimer.txt not found: %s", disclaimer)
        sys.exit(1)

    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    layers = manifest["layers"]
    if args.layer:
        if args.layer not in layers:
            log.error("Unknown layer: %s", args.layer)
            sys.exit(1)
        layers = {args.layer: layers[args.layer]}

    ok = skipped = missing = 0

    for layer_id, entry in layers.items():
        if entry.get("skip"):
            log.info("[skip] %s", layer_id)
            skipped += 1
            continue

        log.info("[%s]", layer_id)

        if not source_exists(entry):
            missing += 1
            continue

        try:
            if "tif" in entry:
                out = build_raster_zip(layer_id, entry, disclaimer, out_dir)
            else:
                out = build_vector_zip(layer_id, entry, disclaimer, out_dir)
            size = out.stat().st_size / 1_000_000
            log.info("  → %s  (%.1f MB)", out.relative_to(ROOT), size)
            ok += 1
        except Exception as exc:
            log.error("  ERROR: %s", exc)
            missing += 1

    log.info("")
    log.info("Done: %d built, %d skipped, %d missing/failed", ok, skipped, missing)


if __name__ == "__main__":
    main()
