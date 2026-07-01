"""Shared output helper for extract scripts that emit Shapefile + browsable CSV.

The CSV is the attribute table with the geometry replaced by a representative
point (lon/lat), so it stays human-browsable without a GIS tool.
"""
import argparse
import os
import sys
from pathlib import Path


def write_shp_csv(gdf, shp, indent=""):
    """Write `gdf` to a GeoPackage and a sibling `.csv` whose first two columns
    are lon/lat of each feature's representative point.

    `shp` may carry any suffix (legacy callers pass `.shp`); the geometry file is
    always written as `.gpkg` — GDAL/tippecanoe read it natively, single file, no
    10-char column-name limit. ponytail: GPKG not GeoParquet because this repo's
    GDAL build has no Parquet driver.
    """
    out = Path(shp).with_suffix(".gpkg")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    gdf.to_file(out, driver="GPKG")
    print(f"{indent}Wrote {out}  ({len(gdf):,} features)")

    csv = out.with_suffix(".csv")
    pts = gdf.representative_point()
    out = gdf.drop(columns="geometry").copy()
    out.insert(0, "lat", pts.y.round(6))
    out.insert(0, "lon", pts.x.round(6))
    out.to_csv(csv, index=False)
    print(f"{indent}Wrote {csv}")


def run_extraction(build, *, output, description, require, missing_hint, summary=None):
    """Standard main() for a single-input, single-output SHP+CSV extractor.

    Wraps the boilerplate the simple polygon extractors share: `-o/--output`
    argparse, chdir to repo root, input-exists check (else print a download hint
    to stderr and exit 1), build, optional summary, write. Scripts with extra
    flags, auto-download, logging, or multiple outputs keep their own main().

    build()        -> GeoDataFrame
    require        : input path that must exist (relative to repo root)
    missing_hint   : lines printed under the ERROR if `require` is absent
    summary(gdf)   : optional, prints a per-layer summary before writing
    """
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("-o", "--output", default=str(output),
                    help=f"Output shapefile path (default: {output})")
    args = ap.parse_args()

    os.chdir(Path(__file__).parent.parent)
    if not Path(require).exists():
        print(f"ERROR: input not found: {require}", file=sys.stderr)
        for line in missing_hint:
            print(f"  {line}", file=sys.stderr)
        sys.exit(1)

    gdf = build()
    if summary:
        summary(gdf)
    write_shp_csv(gdf, Path(args.output))
