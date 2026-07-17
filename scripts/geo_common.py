"""Shared output helper for extract scripts that emit Shapefile + browsable CSV.

The CSV is the attribute table with the geometry replaced by a representative
point (lon/lat), so it stays human-browsable without a GIS tool.
"""
import argparse
import json
import os
import sys
from pathlib import Path


def write_json_atomic(obj, path, **json_kwargs):
    """Write `obj` as JSON to `path` without ever leaving a half-written file.

    Dumps to a `.tmp` sibling in the same directory (so `os.replace` stays on
    one filesystem) then atomically renames it over `path`. An interrupted
    write leaves the old file intact instead of a truncated/corrupt one.
    """
    json_kwargs.setdefault("separators", (",", ":"))
    path = Path(path)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump(obj, f, **json_kwargs)
    os.replace(tmp_path, path)


def read_prev_feed_last_ok(path):
    """Top-level `feed_last_ok` dict (subfeed → ISO timestamp of its last
    successful pull) from the previous run's output file; {} when the file is
    absent/unreadable or predates the field. Used by the live-feed fetch
    scripts (fetch_nws_alerts.py, fetch_wildfire_live.py) to carry outage
    duration forward: on a subfeed failure the previous stamp survives, so
    the frontend chip can say how old the carried data is."""
    try:
        with open(path) as f:
            return json.load(f).get("feed_last_ok") or {}
    except Exception:
        return {}


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
