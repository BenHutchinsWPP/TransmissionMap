#!/usr/bin/env python3
"""
build_global_tiles.py — Join the continental OSM builds into one global artifact
per layer, which is what the map actually reads.

`process_continental_osm.py` produces eight per-continent builds (`_na`, `_eu`,
`_as`, `_sa`, `_af`, `_oc`, `_ca`, `_an`). Those stay per-continent for the
download packs. This script folds them into a single planet-wide file per layer
so the frontend has one URL per layer and pans across continents without
swapping sources. See docs/hosting-plan.md and docs/pipeline.md.

Three kinds of output:
  * PMTiles already tiled per continent  → `tile-join` (no re-tiling)
  * Polygon layers shipped as GeoJSON    → one `tippecanoe` pass over all eight
  * Small point layers shipped as GeoJSON → concatenated FeatureCollection

Point layers are joined with `-pk` so no substation or generator is ever dropped
or coalesced; the only thing the global build changes is the zoom floor (see
MIN_ZOOM_FLOOR).

Usage:
  python scripts/build_global_tiles.py                 # everything
  python scripts/build_global_tiles.py --only osm_substations_points
  python scripts/build_global_tiles.py --dry-run
"""

import argparse
import gzip
import json
import logging
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("global_tiles")

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "data" / "build"
LAYERS_DIR = ROOT / "data" / "layers"

# Continental codes, in the order tile-join reads them.
#
# Note this order does NOT resolve the Geofabrik overlaps. tile-join concatenates
# the features of a tile that several inputs carry, it does not pick a winner:
# `europe-latest` and `asia-latest` both cover the Caucasus and western Russia,
# and measured over the world archive, the z6 tile on Volgograd holds 2,549 of
# its 2,649 ways twice. Nothing clips the extracts to continent polygons — see
# docs/hosting-plan.md.
REGION_CODES = ["na", "eu", "as", "sa", "af", "oc", "ca", "an"]

CEILING_BYTES = 100 * 2**20  # GitHub hard-rejects any file past this.

# Publishing ceiling: no file over 100 MiB. `process_continental_osm.py` now
# builds each layer at a size that clears it, so a fresh build needs nothing
# here; `--trim` is the catch-up path for archives already on disk from an
# earlier build. Measured with tile-join:
#   osm_generators            120.3 MB → 63.1 MB  (z14 → z13)
#   osm_substations_points    106.0 MB → 83.5 MB  (z14 → z13)
# Keyed by artifact stem so one continent can be capped on its own — but a layer
# that is joined into one world archive must cap every continent the same, or
# the joined maxzoom exceeds what some regions carry and they draw blank there
# instead of overzooming.
MAX_ZOOM_CAP: Dict[str, int] = {
    "osm_generators": 13,
    "osm_substations_points": 13,
}

# Tile attributes nothing in assets/ or src/ reads — no style, filter, popup or
# search. Dropping them is lossless for the map. Empty because every layer now
# selects its columns at tile time (process_continental_osm.py / the tile
# manifest); this is the catch-up path for an archive already on disk.
DROP_ATTRS: Dict[str, List[str]] = {}

# Zoom floor applied when joining. A planet-wide point layer puts every feature
# on Earth in the z0 tile; below these zooms the dots overlap into a smear that
# costs hundreds of KiB to say nothing. Raising the floor drops no features —
# the same points are all present from the floor up.
MIN_ZOOM_FLOOR: Dict[str, int] = {
    "osm_substations_points": 4,
}

# Layers already tiled per continent — joined tile-for-tile, never re-tiled.
# Transmission is not among them: it is re-tiled from the continental GeoPackages
# by retile_transmission() below, which is what lets it dedupe the Geofabrik
# overlaps and carry full vertex detail at maxzoom.
JOIN_PMTILES = [
    "osm_substations_points",
    "osm_generators",
    "osm_pipelines_lines",
]

# ── Transmission: one global re-tile, split by voltage ────────────────────────
#
# Transmission is the one layer that is re-tiled rather than joined. Three things
# fall out of tiling the planet in a single pass that a tile-join cannot give:
#
#  1. **Dedupe.** Geofabrik's continental extracts overlap — europe-latest and
#     asia-latest both cover western Russia, Türkiye and the Caucasus — and
#     `tile-join` concatenates a shared tile's features rather than picking a
#     winner. Merging the sources first and keeping the first feature per osm_id
#     removes 23,833 redundant copies (1.7% of 1,366,072) before tippecanoe runs.
#  2. **One maxzoom by construction.** A PMTiles archive carries a single
#     maxzoom, so joining continents built to different depths makes the archive
#     advertise the deepest one and the shallower regions draw blank above their
#     own ceiling instead of overzooming. One pass makes that structurally
#     impossible.
#  3. **Full detail at maxzoom.** `--simplify-only-low-zooms` keeps the
#     Douglas-Peucker pass on z2-z10 and lets z11 carry every vertex the tile
#     grid can hold. See TRANSMISSION_TIPPECANOE_FLAGS.
#
# The output is six planet-wide archives, one per voltage class, because a single
# world archive is 266 MiB against the host's 100 MiB per-file ceiling. See
# docs/hosting-plan.md for the measured sizes and why the cuts sit where they do.
TRANSMISSION_BASE = "osm_transmission_lines"
TRANSMISSION_SRC_STEM = "transmission_lines"
TRANSMISSION_MIN_ZOOM = 2
TRANSMISSION_MAX_ZOOM = 11

# Columns carried into the tiles. `minz` is needed at tile time (the -j ladder
# selects on it) but nothing in assets/ or src/ reads it, so it is dropped again
# when the voltage bands are cut — worth 2.5% of the archive.
TRANSMISSION_SELECT = ["osm_id", "nominal_kv", "operator", "name",
                       "is_undergrnd", "is_dc", "minz"]
TRANSMISSION_DROP_AFTER_TILING = ["minz"]

# Which lines a transmission tile carries, by zoom. `minz` is the per-feature
# zoom floor `enrich_osm_tags.py::_add_minzoom` writes from voltage, length and
# `line=` — the long EHV trunks first, the rest of the network as you zoom in.
# Selecting on it keeps every zoom a coherent grid instead of a thinned sample,
# so no `--drop-*` flag is involved. tippecanoe filters cannot compare two
# attributes, hence one rung per zoom. `minz` must stay in TRANSMISSION_SELECT:
# tippecanoe evaluates -j against the emitted properties, so dropping it there
# would make the filter match nothing. scripts/tile_manifest.yaml carries the
# same string verbatim; test_continental_osm.py holds the two together.
TRANSMISSION_ZOOM_LADDER = json.dumps(
    {"*": ["any", ["<=", "minz", 2],
           *[["all", [">=", "$zoom", z], ["<=", "minz", z]] for z in range(3, 8)],
           [">=", "$zoom", 8]]},
    separators=(",", ":"),
)

# `--simplify-only-low-zooms` is the precision lever. Without it the
# `--simplification=5` pass also runs at maxzoom, so a z11 line carries ~5 tile
# units of Douglas-Peucker error on top of the grid. Because the 4096-unit tile
# grid at zoom z equals screen pixels at z+4, that is ~5 px of error at z15 —
# visible where a line meets a substation bus. Restricting it to the low zooms
# leaves z11 grid-limited: one screen pixel at z15, the floor for this maxzoom.
# Measured cost: z2-z10 are byte-identical, z11 grows 84.7 -> 123.3 MiB.
#
# `--maximum-tile-bytes` is raised to 1 MB for headroom, so that the zoom ladder
# rather than a byte budget decides what a tile holds: tippecanoe still thins a
# tile that reaches the cap even with no `--drop-*` flag, and it does it
# silently. The densest tile in the world is central Europe at z4 (4/8/5, the
# >=100 kV mesh) at 533 KiB — per-feature identity, osm_id/name/operator, not
# vertices, so simplification does not move it. At this ceiling every tile is
# byte-identical to one built with a 20 MB ceiling, i.e. nothing is dropped
# anywhere; at tippecanoe's 500 KB default, 4/8/5 quietly lost 95 ways. The
# largest z11 tile is 47.5 KiB, so lifting simplification off maxzoom does not
# approach it either.
TRANSMISSION_TIPPECANOE_FLAGS = [
    "--simplification=5",
    "--simplify-only-low-zooms",
    "--maximum-tile-bytes=1000000",
]

# Voltage classes, in ascending order. `suffix` names the artifact and the
# frontend source; `filter` is the tippecanoe/tile-join expression that selects
# the class. Ascending order matters twice over: assets/constants.ts lists the
# archives in this order so MapLibre paints higher voltages last, and
# `nominal_kv = -1` encodes unknown (not NULL, not 0), which sorts below
# everything and so falls into the bottom band for free.
#
# Every cut lands in an empty stretch of the voltage distribution — measured
# over 27.5 M vertices, no mass at all sits between the neighbouring real values
# at 50, 100, 125, 200 or 300 kV — so no dense class is split across two files.
# See docs/hosting-plan.md for the per-band sizes.
TRANSMISSION_BANDS = [
    {"suffix": "kv0",   "filter": ["<", "nominal_kv", 50]},
    {"suffix": "kv50",  "filter": ["all", [">=", "nominal_kv", 50],  ["<", "nominal_kv", 100]]},
    {"suffix": "kv100", "filter": ["all", [">=", "nominal_kv", 100], ["<", "nominal_kv", 125]]},
    {"suffix": "kv125", "filter": ["all", [">=", "nominal_kv", 125], ["<", "nominal_kv", 200]]},
    {"suffix": "kv200", "filter": ["all", [">=", "nominal_kv", 200], ["<", "nominal_kv", 300]]},
    {"suffix": "kv300", "filter": [">=", "nominal_kv", 300]},
]

# Polygon layers the continental build ships as GeoJSON. A planet-wide GeoJSON
# would be a ~20 MiB download before the first polygon draws, so these become
# vector tiles instead. `src` is the data/build/ stem; `min_zoom` matches the
# fill minzoom the frontend draws them at (assets/layers/map-layers-osm.ts).
#
# `max_zoom` stops at 12 — one unit of tile extent is ~2.4 m there, finer than
# any substation fence line or plant boundary carries, and MapLibre overzooms
# past a source's maximum on its own. Carrying these to z14 would more than
# double both archives for detail no one can see.
TILE_POLYGONS = [
    {
        "base": "osm_substations_polygons",
        "src": "substation_polygons",
        "min_zoom": 9,
        "max_zoom": 12,
        "select": ["osm_id", "name", "nominal_kv", "operator", "sub_type"],
    },
    {
        "base": "osm_plants_polygons",
        "src": "plant_polygons",
        "min_zoom": 5,
        "max_zoom": 12,
        "select": ["osm_id", "name", "source", "output_mw", "operator", "start_date"],
    },
]

# Point layers small enough to stay a single gzipped FeatureCollection.
CONCAT_GEOJSON = [
    "osm_plants_points",
    "osm_datacenters",
    "osm_pipelines_points",
]


# Every world artifact and the continental inputs it is built from. A join is
# only as current as its inputs, and a world archive left behind by a later
# continental rebuild is indistinguishable from a frontend bug once published —
# so the mtimes are compared before and after every run.
def _build_plan() -> List[tuple]:
    plan = [(base, [LAYERS_DIR / f"{base}.pmtiles"],
             _inputs(base + "_{code}.pmtiles")) for base in JOIN_PMTILES]
    plan.append((
        TRANSMISSION_BASE,
        [LAYERS_DIR / f"{TRANSMISSION_BASE}_{b['suffix']}.pmtiles" for b in TRANSMISSION_BANDS],
        [BUILD_DIR / f"{TRANSMISSION_SRC_STEM}_{c}.gpkg" for c in REGION_CODES],
    ))
    plan += [(spec["base"], [LAYERS_DIR / f"{spec['base']}.pmtiles"],
              [BUILD_DIR / f"{spec['src']}_{c}.gpkg" for c in REGION_CODES])
             for spec in TILE_POLYGONS]
    plan += [(base, [LAYERS_DIR / f"{base}.geojson.gz"],
              _inputs(base + "_{code}.geojson.gz")) for base in CONCAT_GEOJSON]
    return plan


def stale_layers() -> List[str]:
    """Layers whose world artifact is older than a continental input."""
    stale = []
    for label, outs, ins in _build_plan():
        ins = [p for p in ins if p.exists()]
        outs = [p for p in outs if p.exists()]
        if not ins or not outs:
            continue
        newest_in = max(p.stat().st_mtime for p in ins)
        oldest_out = min(p.stat().st_mtime for p in outs)
        if oldest_out < newest_in:
            stale.append(f"{label} — world artifact is "
                         f"{(newest_in - oldest_out) / 86400:.1f} days behind its inputs")
    return stale


def log_staleness(when: str) -> List[str]:
    stale = stale_layers()
    if stale:
        log.warning("%s: %d layer(s) behind their continental inputs", when, len(stale))
        for line in stale:
            log.warning("  · %s", line)
    else:
        log.info("%s: every world artifact is current with its inputs", when)
    return stale


def run_cmd(cmd: List[str], desc: str, dry_run: bool = False):
    log.info("  $ %s", desc)
    if dry_run:
        return
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log.error("%s failed (exit %d)\n%s", desc, proc.returncode, proc.stderr[-2000:])
        raise SystemExit(proc.returncode)
    log.info("    done in %.1fs", time.time() - started)


def _inputs(pattern: str) -> List[Path]:
    """Existing per-continent files for a name pattern with a `{code}` slot."""
    found = [LAYERS_DIR / pattern.format(code=c) for c in REGION_CODES]
    return [p for p in found if p.exists()]


def _report(out: Path):
    log.info("  ✓ %s (%.1f MiB)", out.name, out.stat().st_size / 2**20)


def join_pmtiles(base: str, dry_run: bool = False):
    srcs = _inputs(base + "_{code}.pmtiles")
    if not srcs:
        log.warning("[skip] %s — no continental archives built", base)
        return
    out = LAYERS_DIR / f"{base}.pmtiles"
    floor = MIN_ZOOM_FLOOR.get(base)
    cmd = ["tile-join", "-f", "-pk", "-o", str(out)]
    if floor is not None:
        cmd += [f"-Z{floor}"]
    cmd += [str(p) for p in srcs]
    log.info("=== %s ← %d continental archives%s ===", base, len(srcs),
             f", z{floor}+" if floor is not None else "")
    run_cmd(cmd, f"tile-join {out.name}", dry_run)
    if not dry_run:
        _report(out)


def trim_pmtiles(path: Path, base: str, dry_run: bool = False) -> bool:
    """Re-write `path` under the publishing ceiling. Returns True if it ran.

    Rewrites in place through a temp file. The archive is a build product —
    `data/build/*.gpkg` and process_continental_osm.py are the source of truth —
    so nothing is lost that a re-tile would not restore, and a second run is a
    no-op because the cap and the attribute list are already applied.
    """
    cap  = MAX_ZOOM_CAP.get(path.stem, MAX_ZOOM_CAP.get(base))
    drop = DROP_ATTRS.get(base, [])
    if cap is None and not drop:
        return False
    if not path.exists():
        log.warning("[skip] trim %s — not built", path.name)
        return False

    before = path.stat().st_size
    cmd = ["tile-join", "-f", "-pk"]
    if cap is not None:
        cmd += [f"-z{cap}"]
    for attr in drop:
        cmd += ["-x", attr]
    # The temp name must keep the .pmtiles extension: tile-join picks its output
    # format from the suffix, and anything else silently writes mbtiles.
    tmp = path.with_name(path.stem + ".trim.pmtiles")
    cmd += ["-o", str(tmp), str(path)]
    log.info("=== trim %s%s%s ===", path.name,
             f" z≤{cap}" if cap is not None else "",
             f" −{','.join(drop)}" if drop else "")
    run_cmd(cmd, f"tile-join {path.name}", dry_run)
    if dry_run:
        return True
    tmp.replace(path)
    after = path.stat().st_size
    log.info("  ✓ %s %.1f → %.1f MiB%s", path.name, before / 2**20, after / 2**20,
             "" if after <= CEILING_BYTES else "  ⚠ still over the 100 MiB ceiling")
    return True


def _merge_deduped(srcs: List[Path], out: Path, select: List[str]) -> tuple[int, int]:
    """Write every source to one GeoJSONSeq, keeping the first feature per osm_id.

    Returns (features read, features written). Geofabrik's continental extracts
    overlap — nothing clips them to continent polygons — so the same way arrives
    from two extracts and would otherwise be tiled twice. Streaming, because the
    merged file is ~1 GB.
    """
    seen: set = set()
    read = kept = 0
    with tempfile.TemporaryDirectory(prefix="global-tx-") as tmp, open(out, "w") as sink:
        for src in srcs:
            seq = Path(tmp) / (src.stem + ".geojsonl")
            run_cmd(
                ["ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(src),
                 "-select", ",".join(select),
                 "-lco", "COORDINATE_PRECISION=6"],
                f"ogr2ogr {seq.name}",
            )
            with open(seq) as fh:
                for line in fh:
                    read += 1
                    osm_id = json.loads(line)["properties"].get("osm_id")
                    if osm_id is not None and osm_id in seen:
                        continue
                    if osm_id is not None:
                        seen.add(osm_id)
                    kept += 1
                    sink.write(line)
            seq.unlink()
    return read, kept


def split_transmission_bands(world: Path, out_dir: Path, base: str = TRANSMISSION_BASE):
    """Cut one finished world archive into the per-voltage-class archives.

    Cutting bands out of a single tiled archive rather than running tippecanoe
    once per class guarantees every band carries the same maxzoom and the same
    geometry it would have had unsplit. Shared with build_tiles.py so the
    US-only pipeline emits the same six filenames the frontend names.
    """
    for band in TRANSMISSION_BANDS:
        out = out_dir / f"{base}_{band['suffix']}.pmtiles"
        cmd = ["tile-join", "-f", "-pk",
               "-j", json.dumps({"*": band["filter"]}, separators=(",", ":"))]
        for attr in TRANSMISSION_DROP_AFTER_TILING:
            cmd += ["-x", attr]
        cmd += ["-o", str(out), str(world)]
        run_cmd(cmd, f"tile-join {out.name}")
        size = out.stat().st_size
        log.info("  ✓ %s (%.1f MiB)%s", out.name, size / 2**20,
                 "" if size <= CEILING_BYTES else "  ⚠ over the 100 MiB ceiling")


def retile_transmission(dry_run: bool = False):
    """Re-tile transmission planet-wide, then cut it into voltage-class archives.

    Not a tile-join: see the TRANSMISSION_BANDS block above for why this layer
    is the exception.
    """
    srcs = [BUILD_DIR / f"{TRANSMISSION_SRC_STEM}_{c}.gpkg" for c in REGION_CODES]
    srcs = [p for p in srcs if p.exists()]
    if not srcs:
        log.warning("[skip] %s — no continental GeoPackages built", TRANSMISSION_BASE)
        return
    log.info("=== %s ← %d continental GeoPackages, re-tiled and split %d ways ===",
             TRANSMISSION_BASE, len(srcs), len(TRANSMISSION_BANDS))

    if dry_run:
        log.info("  $ merge + dedupe %d GeoPackages", len(srcs))
        log.info("  $ tippecanoe z%d-%d %s", TRANSMISSION_MIN_ZOOM, TRANSMISSION_MAX_ZOOM,
                 " ".join(TRANSMISSION_TIPPECANOE_FLAGS))
        for band in TRANSMISSION_BANDS:
            log.info("  $ tile-join -> %s_%s.pmtiles", TRANSMISSION_BASE, band["suffix"])
        return

    with tempfile.TemporaryDirectory(prefix="global-tx-", dir=BUILD_DIR) as tmp:
        merged = Path(tmp) / "transmission_world.geojsonl"
        read, kept = _merge_deduped(srcs, merged, TRANSMISSION_SELECT)
        log.info("  %d features read, %d kept — %d redundant copies dropped (%.1f%%)",
                 read, kept, read - kept, (read - kept) / read * 100 if read else 0)

        world = Path(tmp) / "transmission_world.pmtiles"
        run_cmd(
            ["tippecanoe", "-o", str(world), "-l", TRANSMISSION_BASE,
             f"--minimum-zoom={TRANSMISSION_MIN_ZOOM}",
             f"--maximum-zoom={TRANSMISSION_MAX_ZOOM}",
             "-j", TRANSMISSION_ZOOM_LADDER,
             *TRANSMISSION_TIPPECANOE_FLAGS,
             "--read-parallel", "--force", str(merged)],
            f"tippecanoe {world.name}",
        )
        merged.unlink()
        log.info("  world archive %.1f MiB — split into voltage classes now",
                 world.stat().st_size / 2**20)

        split_transmission_bands(world, LAYERS_DIR)


def tile_polygons(spec: dict, dry_run: bool = False):
    base, src_stem = spec["base"], spec["src"]
    srcs = [BUILD_DIR / f"{src_stem}_{c}.gpkg" for c in REGION_CODES]
    srcs = [p for p in srcs if p.exists()]
    if not srcs:
        log.warning("[skip] %s — no continental %s.gpkg built", base, src_stem)
        return
    out = LAYERS_DIR / f"{base}.pmtiles"
    log.info("=== %s ← %d continental layers ===", base, len(srcs))

    with tempfile.TemporaryDirectory(prefix="global-tiles-") as tmp:
        seqs = []
        for src in srcs:
            seq = Path(tmp) / (src.stem + ".geojsonl")
            run_cmd(
                ["ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(src),
                 "-select", ",".join(spec["select"]),
                 "-lco", "COORDINATE_PRECISION=6", "-lco", "RFC7946=NO"],
                f"ogr2ogr {seq.name}", dry_run,
            )
            seqs.append(str(seq))
        run_cmd(
            ["tippecanoe", "-o", str(out), "-l", base,
             f"--minimum-zoom={spec['min_zoom']}", f"--maximum-zoom={spec['max_zoom']}",
             # Footprints are the point of the layer — keep every one of them.
             "--no-tile-size-limit", "--no-feature-limit",
             "--read-parallel", "--force", *seqs],
            f"tippecanoe {out.name}", dry_run,
        )
    if not dry_run:
        _report(out)


def concat_geojson(base: str, dry_run: bool = False):
    srcs = _inputs(base + "_{code}.geojson.gz")
    if not srcs:
        log.warning("[skip] %s — no continental GeoJSON built", base)
        return
    out = LAYERS_DIR / f"{base}.geojson.gz"
    log.info("=== %s ← %d continental files ===", base, len(srcs))
    if dry_run:
        log.info("  $ concat %d → %s", len(srcs), out.name)
        return
    features = []
    for src in srcs:
        with gzip.open(src, "rt", encoding="utf-8") as f:
            features.extend(json.load(f).get("features", []))
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    log.info("  %d features", len(features))
    _report(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", metavar="LAYER",
                    help="build just this layer (repeatable)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, build nothing")
    ap.add_argument("--trim-only", action="store_true",
                    help="apply the publishing-ceiling trims to archives already built, skip the joins")
    ap.add_argument("--list", action="store_true", help="list buildable layers and exit")
    ap.add_argument("--check", action="store_true",
                    help="report which world artifacts are behind their continental inputs and exit")
    args = ap.parse_args(argv)

    everything = (JOIN_PMTILES + [TRANSMISSION_BASE]
                  + [s["base"] for s in TILE_POLYGONS] + CONCAT_GEOJSON)
    if args.list:
        for name in everything:
            print(name)
        return 0

    if args.check:
        return 1 if log_staleness("staleness check") else 0

    wanted = set(args.only) if args.only else None
    if wanted and (unknown := wanted - set(everything)):
        raise SystemExit(f"unknown layer(s): {', '.join(sorted(unknown))}")

    LAYERS_DIR.mkdir(parents=True, exist_ok=True)
    log_staleness("before build")
    started = time.time()
    for base in JOIN_PMTILES:
        if not wanted or base in wanted:
            if not args.trim_only:
                join_pmtiles(base, args.dry_run)
            trim_pmtiles(LAYERS_DIR / f"{base}.pmtiles", base, args.dry_run)
    if (not wanted or TRANSMISSION_BASE in wanted) and not args.trim_only:
        retile_transmission(args.dry_run)
    for spec in TILE_POLYGONS:
        if not wanted or (spec["base"] in wanted and not args.trim_only):
            tile_polygons(spec, args.dry_run)
    for base in CONCAT_GEOJSON:
        if not wanted or (base in wanted and not args.trim_only):
            concat_geojson(base, args.dry_run)
    log.info("Global build finished in %.1f min", (time.time() - started) / 60)
    if not args.dry_run:
        log_staleness("after build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
