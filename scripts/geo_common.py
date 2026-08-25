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


# Size of ADMIN_PALETTE in assets/layers/map-layers-admin.ts, which looks colours
# up by the index this bakes. The style takes it modulo its own palette length,
# so a mismatch shows as unused hues rather than a break — but keep them equal.
ADMIN_PALETTE_LEN = 7


def assign_color_index(gdf, n_colors=ADMIN_PALETTE_LEN, near_deg=0.0, indent=""):
    """Map-color `gdf` so no two touching features share an index.

    Returns a list of ints in `range(n_colors)`, one per row, for the map style
    to look a palette up by. Welsh-Powell: build the adjacency graph with a
    spatial self-join, then walk the features most-neighbours-first, giving each
    the lowest index none of its neighbours holds. Mirrors the colouring in
    extract_eia_ba.py, which keeps its hex palette inline.

    `near_deg` buffers each feature before the join, in degrees, so units that
    near-miss still read apart — worth it for a handful of large areas, wasteful
    for dense ones where plain adjacency is the honest relation. Leave it 0 to
    join on touching geometry alone.
    """
    # Imported here, not at module scope: geo_common must stay importable with
    # the stdlib alone so scripts/test_*.py can run without the venv (see
    # .github/workflows/pipeline-tests.yml).
    import warnings

    import geopandas as gpd

    geom = gdf[["geometry"]].reset_index(drop=True)
    # Buffering full-resolution coastline is where all the time goes — a handful
    # of countries carry hundreds of thousands of vertices each. Adjacency needs
    # far less precision than the shipped geometry, so coarsen first; the
    # tolerance stays an order of magnitude under the buffer, well inside the
    # slack the buffer already introduces. Output geometry is untouched.
    if near_deg >= 0.05:
        geom = geom.assign(geometry=geom.geometry.simplify(near_deg / 10))
    # A small buffer even in the "touching" case: shared borders in generalized
    # source data often miss by a sliver, and an exact-touch join drops those.
    with warnings.catch_warnings():
        # Buffering in degrees is the point here: the distances are deliberately
        # approximate and only feed an adjacency test, so reprojecting per
        # feature would cost time and change nothing about the colouring.
        warnings.filterwarnings("ignore", message=".*geographic CRS.*")
        geom = geom.assign(geometry=geom.geometry.buffer(near_deg or 0.002))

    pairs = gpd.sjoin(geom, geom, how="inner", predicate="intersects")
    adj = {i: set() for i in range(len(geom))}
    for left, right in zip(pairs.index, pairs["index_right"]):
        if left != right:
            adj[left].add(right)
            adj[right].add(left)

    colors = {}
    for i in sorted(adj, key=lambda k: -len(adj[k])):
        taken = {colors[n] for n in adj[i] if n in colors}
        colors[i] = next(c for c in range(len(adj[i]) + 2) if c not in taken)

    used = max(colors.values()) + 1 if colors else 0
    if used > n_colors:
        print(f"{indent}note: colouring used {used} indices; the {n_colors}-colour "
              f"palette wraps, so a few neighbours will repeat")
    clash = sum(1 for i in adj for n in adj[i]
                if colors[i] % n_colors == colors[n] % n_colors) // 2
    print(f"{indent}colour index: {min(used, n_colors)} of {n_colors} used, "
          f"{clash} adjacent pairs sharing a colour")
    return [colors[i] % n_colors for i in range(len(geom))]
