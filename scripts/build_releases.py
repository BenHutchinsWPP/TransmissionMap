#!/usr/bin/env python3
"""
build_releases.py — Build per-layer download ZIP packs.

Reads scripts/release_manifest.yaml and produces, per layer, one of:

  - raster (has `tif:`)       → <pack-id>.zip
        {<layer-id>.tif, <layer-id>.txt, disclaimer.txt}
  - point (`csv_only: true`)  → <pack-id>.zip
        {<name>.csv, <layer-id>.txt, disclaimer.txt}
  - line/polygon (else)       → <pack-id>.zip AND <pack-id>-shp.zip
        <pack-id>.zip:     {<name>.geojson, <name>.csv, <layer-id>.txt, disclaimer.txt}
        <pack-id>-shp.zip: {<name>.shp/.shx/.dbf/.prj/.cpg, <name>.csv, <layer-id>.txt, disclaimer.txt}

`<pack-id>` is the layer id, or `<layer-id>-<code>` for a `continental: true`
layer — those are built once per Geofabrik continent (na eu as sa af oc ca an)
from source paths carrying a `{code}` placeholder. Every format a continental
layer offers is built for every continent, so the download menu can expand any
one of them into the same eight links.

CSV rides inside every vector zip (both the GeoJSON pack and the SHP pack) as
an attribute preview; there is no standalone CSV-only pack for line/polygon
layers. `files:` (multi-source entries) is supported for layers like WECC
Paths that legitimately bundle more than one geometry file into a single map
layer's pack.

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
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path

import geopandas as gpd
import pandas as pd
import yaml

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent

# Geofabrik continental extracts, in the order process_continental_osm.py builds
# them. A `continental: true` layer gets one pack per code, per format.
CONTINENT_CODES = ["na", "eu", "as", "sa", "af", "oc", "ca", "an"]
SOURCE_KEYS = ("geojson_gz", "shp", "geojson", "csv", "tif")

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


def _prep_geometry(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Reproject to EPSG:4326 and repair geometries. Shared by all vector writers."""
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return _clean_geometry(gdf)


def _write_csv(gdf: gpd.GeoDataFrame, stem: str, zf: zipfile.ZipFile) -> None:
    """Write <stem>.csv (attributes + lon/lat representative point) into zf.

    Assumes gdf has already been through `_prep_geometry`.
    """
    pts = gdf.representative_point()
    csv_df = gdf.drop(columns="geometry").copy()
    csv_df.insert(0, "lon", pts.x.round(6))
    csv_df.insert(0, "lat", pts.y.round(6))
    zf.writestr(f"{stem}.csv", csv_df.to_csv(index=False))


def write_csv_only(gdf: gpd.GeoDataFrame, stem: str, zf: zipfile.ZipFile) -> None:
    """Write just <stem>.csv — used for csv_only (point) layers."""
    gdf = _prep_geometry(gdf)
    _write_csv(gdf, stem, zf)


def write_geojson_and_csv(gdf: gpd.GeoDataFrame, stem: str, zf: zipfile.ZipFile) -> None:
    """Write <stem>.geojson + <stem>.csv — used for the GeoJSON pack."""
    gdf = _prep_geometry(gdf)
    buf = BytesIO()
    gdf.to_file(buf, driver="GeoJSON")
    zf.writestr(f"{stem}.geojson", buf.getvalue())
    _write_csv(gdf, stem, zf)


def write_shp_and_csv(gdf: gpd.GeoDataFrame, stem: str, zf: zipfile.ZipFile) -> None:
    """Write a Shapefile fileset (.shp/.shx/.dbf/.prj[/.cpg]) + <stem>.csv.

    Shapefiles have a 10-char field-name limit — geopandas/fiona truncate
    silently; that's an accepted limitation of the format, not a bug here.

    A Shapefile also holds a single geometry family. The CSV keeps every
    feature, but the shapefile keeps only the dominant family (Polygon / Line /
    Point, folding Multi- in) and drops any stray mixed-in geometry, which
    GDAL's ESRI Shapefile driver would otherwise reject mid-write. This assumes
    one dominant family with only noise around it; a layer that is genuinely
    mixed-geometry should be `geojson_only: true` instead (see WECC Paths).
    """
    gdf = _prep_geometry(gdf)
    _write_csv(gdf, stem, zf)  # full attribute table — all features

    fam = gdf.geom_type.str.replace("Multi", "", regex=False)
    dominant_fams = fam.mode(dropna=True)
    if dominant_fams.empty:
        # A shapefile header declares one geometry type, so a layer with no
        # features has nothing to write. The CSV above still ships. Antarctica
        # has no substation polygons, and every continent gets every format.
        log.info("    %s: no features — CSV only", stem)
        return
    dominant = dominant_fams.iloc[0]
    keep = fam == dominant
    if (~keep).any():
        log.warning("    %s: dropping %d non-%s feature(s) from the shapefile",
                    stem, int((~keep).sum()), dominant)
        gdf = gdf[keep]

    with tempfile.TemporaryDirectory() as tmp:
        shp_path = Path(tmp) / f"{stem}.shp"
        gdf.to_file(shp_path, driver="ESRI Shapefile")
        for f in Path(tmp).iterdir():
            if f.stem == stem:
                zf.write(f, f.name)


def _is_csv_only(entry: dict) -> bool:
    """A layer is csv_only if it has no `files:` and is marked csv_only, or it
    has `files:` and every sub-spec is csv_only (in practice: point layers)."""
    if "files" in entry:
        return all(spec.get("csv_only", False) for spec in entry["files"].values())
    return entry.get("csv_only", False)


def _sources(entry: dict, layer_id: str) -> dict:
    """Return {stem: spec} for a layer, whether single-source or `files:`."""
    if "files" in entry:
        return entry["files"]
    return {layer_id: entry}


def build_vector_zips(
    layer_id: str,
    entry: dict,
    disclaimer: Path,
    out_dir: Path,
) -> list[Path]:
    """Build the vector pack(s) for a layer: one CSV-only zip for points, or a
    GeoJSON zip + SHP zip pair for lines/polygons. Returns the zips written."""
    doc = ROOT / entry["doc"]
    doc_arcname, doc_content = md_to_txt(doc)
    sources = _sources(entry, layer_id)
    csv_only = _is_csv_only(entry)

    outputs: list[Path] = []

    if csv_only:
        out = out_dir / f"{layer_id}.zip"
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for stem, spec in sources.items():
                log.info("  loading %s ...", stem)
                gdf = load_vector(spec)
                write_csv_only(gdf, stem, zf)
            zf.writestr(doc_arcname, doc_content)
            zf.write(disclaimer, "disclaimer.txt")
        outputs.append(out)
        return outputs

    geojson_out = out_dir / f"{layer_id}.zip"
    with zipfile.ZipFile(geojson_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for stem, spec in sources.items():
            log.info("  loading %s ...", stem)
            gdf = load_vector(spec)
            write_geojson_and_csv(gdf, stem, zf)
        zf.writestr(doc_arcname, doc_content)
        zf.write(disclaimer, "disclaimer.txt")
    outputs.append(geojson_out)

    # geojson_only skips the SHP pack — used for WECC Paths, whose mixed
    # point+line geometry a single-geometry Shapefile can't hold.
    if entry.get("geojson_only"):
        return outputs

    shp_out = out_dir / f"{layer_id}-shp.zip"
    with zipfile.ZipFile(shp_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for stem, spec in sources.items():
            log.info("  loading %s (shp) ...", stem)
            gdf = load_vector(spec)
            write_shp_and_csv(gdf, stem, zf)
        zf.writestr(doc_arcname, doc_content)
        zf.write(disclaimer, "disclaimer.txt")
    outputs.append(shp_out)

    return outputs


def build_raster_zip(
    layer_id: str,
    entry: dict,
    disclaimer: Path,
    out_dir: Path,
) -> Path:
    tif = ROOT / entry["tif"]
    doc = ROOT / entry["doc"]
    out = out_dir / f"{layer_id}.zip"

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.write(tif, f"{layer_id}.tif")
        doc_arcname, doc_content = md_to_txt(doc)
        zf.writestr(doc_arcname, doc_content)
        zf.write(disclaimer, "disclaimer.txt")

    return out


def _with_code(entry: dict, code: str) -> dict:
    """Copy `entry` with the {code} placeholder filled in on every source path."""
    out = dict(entry)
    for key in SOURCE_KEYS:
        if key in out:
            out[key] = out[key].format(code=code)
    if "files" in out:
        out["files"] = {stem.format(code=code): _with_code(spec, code)
                        for stem, spec in out["files"].items()}
    return out


def pack_variants(layer_id: str, entry: dict, codes: list[str]) -> list[tuple[str, dict]]:
    """One (pack-id, entry) pair per pack this layer produces — itself, or one
    per continent when the layer is `continental: true`."""
    if not entry.get("continental"):
        return [(layer_id, entry)]
    return [(f"{layer_id}-{code}", _with_code(entry, code)) for code in codes]


def source_exists(entry: dict) -> bool:
    """Return False (with a warning) if any required source file is missing."""
    sources = {}
    if "files" in entry:
        for stem, spec in entry["files"].items():
            sources[stem] = spec
    else:
        sources[entry.get("doc", "layer")] = entry

    for name, spec in sources.items():
        for key in SOURCE_KEYS:
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
    ap.add_argument("--code", choices=CONTINENT_CODES,
                    help="Build only this continent's packs (implies continental layers only)")
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

    codes = [args.code] if args.code else CONTINENT_CODES

    ok = skipped = missing = 0

    for layer_id, entry in layers.items():
        if entry.get("skip") or (args.code and not entry.get("continental")):
            log.info("[skip] %s", layer_id)
            skipped += 1
            continue

        for pack_id, spec in pack_variants(layer_id, entry, codes):
            log.info("[%s]", pack_id)

            if not source_exists(spec):
                missing += 1
                continue

            try:
                if "tif" in spec:
                    outs = [build_raster_zip(pack_id, spec, disclaimer, out_dir)]
                else:
                    outs = build_vector_zips(pack_id, spec, disclaimer, out_dir)
                for out in outs:
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
