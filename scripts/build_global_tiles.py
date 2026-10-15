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
  * Point and line layers (RETILE, transmission) → the eight continental
    intermediates merged and deduped, then one `tippecanoe` pass
  * Polygon layers (TILE_POLYGONS)              → the same, one pass over all eight
  * Small point layers (CONCAT_GEOJSON)         → concatenated FeatureCollection

Every world layer is built from one merged input, so the Geofabrik seam copies
are dropped once at the merge (see _merge_deduped) and each archive carries a
single maxzoom by construction. Every feature carries `fid`, the stable id the
extracts build (osm_common.osm_fid): the seam dedupe keys on it, and the vector
archives store it as the native MVT feature id (`--use-attribute-for-id`). The merged input is then tagged with the global
region fields (countries and admin1 everywhere, plus counties, ba, nerc and
retail inside the US) by region_join.py, before tippecanoe or the dump.

Usage:
  python scripts/build_global_tiles.py                 # everything
  python scripts/build_global_tiles.py --only osm_substations_points
  python scripts/build_global_tiles.py --dry-run
"""

import argparse
import gzip
import json
import logging
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("global_tiles")

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "data" / "build"
LAYERS_DIR = ROOT / "data" / "layers"

# Continental codes, in the order the merges read them. On a seam copy the first
# continent in this order supplies the kept feature. `europe-latest` and
# `asia-latest` both cover the Caucasus and western Russia, and nothing clips the
# extracts to continent polygons — see docs/hosting-plan.md.
REGION_CODES = ["na", "eu", "as", "sa", "af", "oc", "ca", "an"]

CEILING_BYTES = 100 * 2**20  # GitHub hard-rejects any file past this.

# tippecanoe stderr lines that mean features were thinned or a zoom was extended.
# run_cmd logs them even when the command succeeds, so a build that quietly
# dropped points shows it in its log.
DROP_WARNING_RE = re.compile(r"Going to try|too many features|with detail|dropping")

# ogr2ogr reads a CSV's geometry only from these open options (the continental
# CSVs carry `lon`/`lat` columns).
CSV_OPEN_OPTIONS = ["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                    "-oo", "KEEP_GEOM_COLUMNS=NO"]

# Point and line layers re-tiled planet-wide from the continental intermediates,
# one merged input and one tippecanoe pass each. Values follow
# process_continental_osm.py's continental builds, with two world-only choices:
#  * No `--extend-zooms-if-still-dropping`: with no zoom cap it lets an archive
#    advertise z14, so each spec's `max_zoom` is exactly what `pmtiles show`
#    reports.
#  * Substations start at z4 — below that a single tile holds most of the
#    substations on Earth — and every point is present from z4 up.
#
# Seam copies are dropped on SEAM_KEY, `fid` — the OSM id with its element type,
# so node 123 and way 123 stay apart while the same element from two extracts
# collapses to the copy from the first continent in REGION_CODES, id unchanged.
# Region fields (scripts/region_join.py) each kind of asset is tagged with:
# assets people filter on get the full global set; lines drop `retail`, since
# the owner field already answers "whose line".
GLOBAL_FIELDS = ("countries", "admin1", "counties", "ba", "nerc", "retail")
LINE_FIELDS = ("countries", "admin1", "counties", "ba", "nerc")

SEAM_KEY = "fid"

# tippecanoe flags that turn `fid` into the native MVT feature id, which costs
# fewer bytes than the attribute it replaces. tippecanoe skips a string-valued
# id attribute, so `-T fid:int` makes it read the value as a number.
NATIVE_ID_FLAGS = [f"--use-attribute-for-id={SEAM_KEY}", f"-T{SEAM_KEY}:int"]

RETILE = [
    {
        "base": "osm_substations_points",
        "src_stem": "substation_osm",
        "src_ext": ".csv",
        "select": ["fid", "name", "nominal_kv", "operator", "sub_type"],
        "fields": GLOBAL_FIELDS,
        "min_zoom": 4,
        "max_zoom": 13,
        "max_tile_bytes": 500000,
        "simplification": None,
        # Points are never dropped or coalesced.
        "flags": ["-r1", "--no-tile-size-limit", "--no-feature-limit",
                  "--preserve-input-order"],
    },
    {
        "base": "osm_generators",
        "src_stem": "generator_osm",
        "src_ext": ".csv",
        "select": ["fid", "name", "source", "gen_method", "gen_type", "output_mw",
                   "operator"],
        "fields": GLOBAL_FIELDS,
        "min_zoom": 7,
        "max_zoom": 13,
        "max_tile_bytes": 2000000,
        "simplification": None,
        "flags": ["--drop-densest-as-needed"],
    },
    {
        "base": "osm_pipelines_lines",
        "src_stem": "pipeline_routes",
        "src_ext": ".gpkg",
        "select": ["fid", "name", "substance", "operator"],
        "fields": LINE_FIELDS,
        # A unique id on every line limits --coalesce-densest-as-needed, which
        # would take z12 past the 100 MiB ceiling. z11 with simplification
        # kept off maxzoom is grid-limited (~4.8 m), finer than the z12 it
        # replaces (~9.6 m at simplification 4).
        # The 1 MB tile ceiling keeps every line at every zoom: the densest
        # tile, Gulf Coast 4/3/6, is 507,607 bytes of per-line ids and fields,
        # which simplification barely moves (500,464 at 6). At this ceiling
        # the tiles are byte-identical to a 20 MB build.
        "min_zoom": 2,
        "max_zoom": 11,
        "max_tile_bytes": 1000000,
        "simplification": 4,
        "flags": ["--drop-densest-as-needed", "--coalesce-densest-as-needed",
                  "--simplify-only-low-zooms"],
    },
]

# ── Transmission: one global re-tile, split by voltage ────────────────────────
#
# Transmission follows the RETILE pattern (merge, dedupe, one tippecanoe pass)
# with a zoom ladder and a voltage split on top. Three things fall out of tiling
# the planet in a single pass:
#
#  1. **Dedupe.** Geofabrik's continental extracts overlap — europe-latest and
#     asia-latest both cover western Russia, Türkiye and the Caucasus. Merging
#     the sources first and keeping the first feature per fid removes 23,833
#     redundant copies
#     (1.7% of 1,366,072) before tippecanoe runs.
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
# when the voltage bands are cut — worth 2.5% of the archive. `fid` becomes the
# feature id in the one world pass, before the cut, so each way keeps its id in
# the one band it lands in (tile-join carries feature ids through unchanged).
TRANSMISSION_SELECT = ["fid", "nominal_kv", "operator", "name",
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
# >=100 kV mesh) at 533 KiB — per-feature identity, id/name/operator, not
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
        "select": ["fid", "name", "nominal_kv", "operator", "sub_type"],
        "fields": GLOBAL_FIELDS,
    },
    {
        "base": "osm_plants_polygons",
        "src": "plant_polygons",
        "min_zoom": 5,
        "max_zoom": 12,
        "select": ["fid", "name", "source", "output_mw", "operator", "start_date"],
        "fields": GLOBAL_FIELDS,
    },
]

# Point layers small enough to stay a single gzipped FeatureCollection. They keep
# the continental GeoJSON's columns (process_continental_osm.py), `fid` among
# them, which the frontend promotes to the feature id.
CONCAT_GEOJSON = ["osm_plants_points", "osm_datacenters", "osm_pipelines_points"]


# Every world artifact and the continental inputs it is built from. A join is
# only as current as its inputs, and a world archive left behind by a later
# continental rebuild is indistinguishable from a frontend bug once published —
# so the mtimes are compared before and after every run.
def _build_plan() -> List[tuple]:
    plan = [(spec["base"], [LAYERS_DIR / f"{spec['base']}.pmtiles"], _retile_inputs(spec))
            for spec in RETILE]
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
    hits = [line.strip() for line in re.split(r"[\r\n]+", proc.stderr)
            if DROP_WARNING_RE.search(line)]
    for line in hits[:200]:
        log.warning("    stderr: %s", line)
    if len(hits) > 200:
        log.warning("    stderr: … %d more matching lines", len(hits) - 200)
    log.info("    done in %.1fs", time.time() - started)


def _inputs(pattern: str) -> List[Path]:
    """Existing per-continent files for a name pattern with a `{code}` slot."""
    found = [LAYERS_DIR / pattern.format(code=c) for c in REGION_CODES]
    return [p for p in found if p.exists()]


def _report(out: Path):
    log.info("  ✓ %s (%.1f MiB)", out.name, out.stat().st_size / 2**20)


def _retile_inputs(spec: dict) -> List[Path]:
    return [BUILD_DIR / f"{spec['src_stem']}_{c}{spec['src_ext']}" for c in REGION_CODES]


def _seam_key(feature: dict) -> Optional[int]:
    """A feature's fid, or None when it has none.

    The fid is written back as an integer, so the merged input carries it
    numeric even where a CSV source hands it over as a string.
    """
    props = feature.get("properties") or {}
    value = props.get(SEAM_KEY)
    if value is None or value == "":
        return None
    props[SEAM_KEY] = int(value)
    return props[SEAM_KEY]


def _warn_unkeyed(unkeyed: int):
    if unkeyed:
        log.warning("  %d features lack a dedupe key field (%s) and were kept without deduping",
                    unkeyed, SEAM_KEY)


def _merge_deduped(srcs: List[Path], out: Path, select: List[str]) -> tuple:
    """Write every source to one GeoJSONSeq, keeping the first feature per fid.

    Returns (features read, features written). Geofabrik's continental extracts
    overlap — nothing clips them to continent polygons — so the same element
    arrives from two extracts and would otherwise be tiled twice. A feature
    with no fid is always kept. The written file carries only `select`, which
    includes the fid. Streaming, because a merged file reaches ~1 GB.
    """
    seen: set = set()
    read = kept = unkeyed = 0
    with tempfile.TemporaryDirectory(prefix="global-merge-") as tmp, \
            open(out, "w", encoding="utf-8") as sink:
        for src in srcs:
            seq = Path(tmp) / (src.stem + ".geojsonl")
            run_cmd(
                ["ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(src),
                 *(CSV_OPEN_OPTIONS if src.suffix == ".csv" else []),
                 "-select", ",".join(select),
                 "-lco", "COORDINATE_PRECISION=6"],
                f"ogr2ogr {seq.name}",
            )
            with open(seq, encoding="utf-8") as fh:
                for line in fh:
                    read += 1
                    feature = json.loads(line)
                    key = _seam_key(feature)
                    if key is None:
                        unkeyed += 1
                    else:
                        if key in seen:
                            continue
                        seen.add(key)
                    kept += 1
                    sink.write(json.dumps(feature, ensure_ascii=False) + "\n")
            seq.unlink()
    _warn_unkeyed(unkeyed)
    return read, kept


def _tag_regions(seq: Path, fields):
    """Add the global region fields to a merged, deduped GeoJSONSeq in place.

    Tagging follows the dedupe, so each element is joined once, and precedes
    tippecanoe, so the fields ride into the tiles. The join logs REGION_STATS.
    """
    import region_join  # geo libraries load only when a build reaches this step
    region_join.tag_file(seq, "global", fields=fields)


def _log_merge(read: int, kept: int):
    log.info("  %d features read, %d kept — %d seam copies dropped (%.1f%%) on %s",
             read, kept, read - kept, (read - kept) / read * 100 if read else 0, SEAM_KEY)


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

    See the TRANSMISSION_BANDS block above for the zoom ladder and the split.
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
                 " ".join(TRANSMISSION_TIPPECANOE_FLAGS + NATIVE_ID_FLAGS))
        for band in TRANSMISSION_BANDS:
            log.info("  $ tile-join -> %s_%s.pmtiles", TRANSMISSION_BASE, band["suffix"])
        return

    with tempfile.TemporaryDirectory(prefix="global-tx-", dir=BUILD_DIR) as tmp:
        merged = Path(tmp) / "transmission_world.geojsonl"
        read, kept = _merge_deduped(srcs, merged, TRANSMISSION_SELECT)
        _log_merge(read, kept)
        _tag_regions(merged, LINE_FIELDS)

        world = Path(tmp) / "transmission_world.pmtiles"
        run_cmd(
            ["tippecanoe", "-o", str(world), "-l", TRANSMISSION_BASE, "-t", tmp,
             f"--minimum-zoom={TRANSMISSION_MIN_ZOOM}",
             f"--maximum-zoom={TRANSMISSION_MAX_ZOOM}",
             "-j", TRANSMISSION_ZOOM_LADDER,
             *TRANSMISSION_TIPPECANOE_FLAGS, *NATIVE_ID_FLAGS,
             "--read-parallel", "--force", str(merged)],
            f"tippecanoe {world.name}",
        )
        merged.unlink()
        log.info("  world archive %.1f MiB — split into voltage classes now",
                 world.stat().st_size / 2**20)

        split_transmission_bands(world, LAYERS_DIR)


def retile(spec: dict, dry_run: bool = False):
    """Merge a RETILE layer's continental intermediates, dedupe, tile once."""
    base = spec["base"]
    srcs = [p for p in _retile_inputs(spec) if p.exists()]
    if not srcs:
        log.warning("[skip] %s — no continental %s%s built", base, spec["src_stem"],
                    spec["src_ext"])
        return
    out = LAYERS_DIR / f"{base}.pmtiles"
    log.info("=== %s ← %d continental %s files, merged and re-tiled ===",
             base, len(srcs), spec["src_ext"])
    tip_args = [f"--minimum-zoom={spec['min_zoom']}", f"--maximum-zoom={spec['max_zoom']}",
                *spec["flags"], *NATIVE_ID_FLAGS]
    if spec["simplification"]:
        tip_args.append(f"--simplification={spec['simplification']}")
    tip_args.append(f"--maximum-tile-bytes={spec['max_tile_bytes']}")

    if dry_run:
        log.info("  $ merge + dedupe %d files on %s", len(srcs), SEAM_KEY)
        log.info("  $ tippecanoe %s %s", out.name, " ".join(tip_args))
        return

    with tempfile.TemporaryDirectory(prefix="global-tiles-") as tmp:
        merged = Path(tmp) / f"{base}.geojsonl"
        read, kept = _merge_deduped(srcs, merged, spec["select"])
        _log_merge(read, kept)
        # tippecanoe needs at least one feature, and --force truncates the target
        # before it reads the input — so an empty merge leaves the archive as it was.
        if not kept:
            log.warning("[skip] %s — the merged input has no features", base)
            return
        _tag_regions(merged, spec["fields"])
        run_cmd(
            ["tippecanoe", "-o", str(out), "-l", base, "-t", tmp, *tip_args,
             "--read-parallel", "--force", str(merged)],
            f"tippecanoe {out.name}",
        )
    _report(out)


def tile_polygons(spec: dict, dry_run: bool = False):
    base, src_stem = spec["base"], spec["src"]
    srcs = [BUILD_DIR / f"{src_stem}_{c}.gpkg" for c in REGION_CODES]
    srcs = [p for p in srcs if p.exists()]
    if not srcs:
        log.warning("[skip] %s — no continental %s.gpkg built", base, src_stem)
        return
    out = LAYERS_DIR / f"{base}.pmtiles"
    log.info("=== %s ← %d continental layers ===", base, len(srcs))
    tip_args = [f"--minimum-zoom={spec['min_zoom']}", f"--maximum-zoom={spec['max_zoom']}",
                # Footprints are the point of the layer — keep every one of them.
                "--no-tile-size-limit", "--no-feature-limit", *NATIVE_ID_FLAGS]

    if dry_run:
        log.info("  $ merge + dedupe %d GeoPackages on %s", len(srcs), SEAM_KEY)
        log.info("  $ tippecanoe %s %s", out.name, " ".join(tip_args))
        return

    with tempfile.TemporaryDirectory(prefix="global-tiles-") as tmp:
        merged = Path(tmp) / f"{base}.geojsonl"
        read, kept = _merge_deduped(srcs, merged, spec["select"])
        _log_merge(read, kept)
        _tag_regions(merged, spec["fields"])
        run_cmd(
            ["tippecanoe", "-o", str(out), "-l", base, "-t", tmp, *tip_args,
             "--read-parallel", "--force", str(merged)],
            f"tippecanoe {out.name}",
        )
    _report(out)


def concat_geojson(base: str, dry_run: bool = False):
    srcs = _inputs(base + "_{code}.geojson.gz")
    if not srcs:
        log.warning("[skip] %s — no continental GeoJSON built", base)
        return
    out = LAYERS_DIR / f"{base}.geojson.gz"
    log.info("=== %s ← %d continental files ===", base, len(srcs))
    if dry_run:
        log.info("  $ concat + dedupe %d on %s → %s", len(srcs), SEAM_KEY, out.name)
        return
    features = []
    seen: set = set()
    read = unkeyed = 0
    for src in srcs:
        with gzip.open(src, "rt", encoding="utf-8") as f:
            for feature in json.load(f).get("features", []):
                read += 1
                key = _seam_key(feature)
                if key is None:
                    unkeyed += 1
                else:
                    if key in seen:
                        continue
                    seen.add(key)
                features.append(feature)
    _warn_unkeyed(unkeyed)
    _log_merge(read, len(features))
    import region_join
    region_join.tag_features(features, "global", base, fields=GLOBAL_FIELDS)
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    _report(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", metavar="LAYER",
                    help="build just this layer (repeatable)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, build nothing")
    ap.add_argument("--list", action="store_true", help="list buildable layers and exit")
    ap.add_argument("--check", action="store_true",
                    help="report which world artifacts are behind their continental inputs and exit")
    args = ap.parse_args(argv)

    everything = ([s["base"] for s in RETILE] + [TRANSMISSION_BASE]
                  + [s["base"] for s in TILE_POLYGONS] + list(CONCAT_GEOJSON))
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
    for spec in RETILE:
        if not wanted or spec["base"] in wanted:
            retile(spec, args.dry_run)
    if not wanted or TRANSMISSION_BASE in wanted:
        retile_transmission(args.dry_run)
    for spec in TILE_POLYGONS:
        if not wanted or spec["base"] in wanted:
            tile_polygons(spec, args.dry_run)
    for base in CONCAT_GEOJSON:
        if not wanted or base in wanted:
            concat_geojson(base, args.dry_run)
    log.info("Global build finished in %.1f min", (time.time() - started) / 60)
    if not args.dry_run:
        log_staleness("after build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
