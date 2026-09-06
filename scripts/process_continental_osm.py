#!/usr/bin/env python3
"""
process_continental_osm.py — Process OSM energy infrastructure across continental regions.

Executes the full OSM extraction, tag enrichment, vector tiling (PMTiles / GeoJSON),
and download pack release workflow for any or all Geofabrik continental extracts.

Region code conventions:
  - 2-letter (default): na, eu, as, sa, af, oc, ca, an
  - 3-letter (optional): nam, eur, asi, sam, afr, oce, cam, ant

Usage:
  python scripts/process_continental_osm.py --list
  python scripts/process_continental_osm.py --region europe
  python scripts/process_continental_osm.py --region oc --stage extract
  python scripts/process_continental_osm.py --all --stage tiles
  python scripts/process_continental_osm.py --all
"""

import argparse
import gzip
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("continental_osm")

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
RAW_DIR = ROOT / "data" / "raw" / "osm"
BUILD_DIR = ROOT / "data" / "build"
LAYERS_DIR = ROOT / "data" / "layers"
RELEASES_DIR = ROOT / "data" / "releases"

CONTINENTAL_REGIONS: Dict[str, Dict[str, str]] = {
    "antarctica": {
        "code2": "an",
        "code3": "ant",
        "pbf_candidates": [
            "antarctica-latest_filtered.osm.pbf",
            "antarctica-latest.osm.pbf",
        ],
        "name": "Antarctica",
    },
    "central-america": {
        "code2": "ca",
        "code3": "cam",
        "pbf_candidates": [
            "central-america-latest_filtered.osm.pbf",
            "central-america-latest.osm.pbf",
        ],
        "name": "Central America",
    },
    "oceania": {
        "code2": "oc",
        "code3": "oce",
        "pbf_candidates": [
            "australia-oceania-latest_filtered.osm.pbf",
            "australia-oceania-latest.osm.pbf",
            "oceania-latest_filtered.osm.pbf",
            "oceania-latest.osm.pbf",
        ],
        "name": "Australia & Oceania",
    },
    "south-america": {
        "code2": "sa",
        "code3": "sam",
        "pbf_candidates": [
            "south-america-latest_filtered.osm.pbf",
            "south-america-latest.osm.pbf",
        ],
        "name": "South America",
    },
    "africa": {
        "code2": "af",
        "code3": "afr",
        "pbf_candidates": [
            "africa-latest_filtered.osm.pbf",
            "africa-latest.osm.pbf",
        ],
        "name": "Africa",
    },
    "north-america": {
        "code2": "na",
        "code3": "nam",
        "pbf_candidates": [
            "north-america-latest_filtered.osm.pbf",
            "north-america-latest.osm.pbf",
        ],
        "name": "North America",
    },
    "asia": {
        "code2": "as",
        "code3": "asi",
        "pbf_candidates": [
            "asia-latest_filtered.osm.pbf",
            "asia-latest.osm.pbf",
        ],
        "name": "Asia",
    },
    "europe": {
        "code2": "eu",
        "code3": "eur",
        "pbf_candidates": [
            "europe-latest_filtered.osm.pbf",
            "europe-latest.osm.pbf",
        ],
        "name": "Europe",
    },
}

# Alias map for flexible CLI lookup
ALIAS_MAP: Dict[str, str] = {}
for reg_key, reg_info in CONTINENTAL_REGIONS.items():
    ALIAS_MAP[reg_key.lower()] = reg_key
    ALIAS_MAP[reg_info["code2"].lower()] = reg_key
    ALIAS_MAP[reg_info["code3"].lower()] = reg_key


# Layer ids `--only` restricts the tiles stage to; empty means build everything.
# Mirrors build_global_tiles.py --only. The id is the artifact stem without the
# continent suffix, i.e. what assets/constants.ts names.
ONLY_LAYERS: set = set()


def _skip_layer(layer_id: str) -> bool:
    if ONLY_LAYERS and layer_id not in ONLY_LAYERS:
        log.info("  [skip] %s — not in --only", layer_id)
        return True
    return False


def resolve_region(key: str) -> Optional[str]:
    return ALIAS_MAP.get(key.strip().lower())


def get_region_code(region_key: str, code_style: str = "2letter") -> str:
    info = CONTINENTAL_REGIONS[region_key]
    return info["code3"] if code_style == "3letter" else info["code2"]


def find_region_pbf(region_key: str) -> Optional[Path]:
    info = CONTINENTAL_REGIONS[region_key]
    for cand in info["pbf_candidates"]:
        p = RAW_DIR / cand
        if p.exists():
            return p
    return None


def run_cmd(cmd: List[str], desc: str = "", check: bool = True, dry_run: bool = False) -> bool:
    cmd_str = " ".join(str(c) for c in cmd)
    if dry_run:
        log.info("[dry-run] %s", cmd_str)
        return True

    log.info("Running: %s", cmd_str)
    res = subprocess.run(cmd)
    if res.returncode != 0:
        log.error("Failed (%d): %s", res.returncode, desc or cmd[0])
        if check:
            sys.exit(res.returncode)
        return False
    return True


def list_regions():
    print("\nContinental OSM Regions & Datasets:")
    print(f"{'Region Key':<18} {'Code(2)':<8} {'Code(3)':<8} {'Available PBF File':<45}")
    print("-" * 82)
    for r_key, r_info in CONTINENTAL_REGIONS.items():
        pbf = find_region_pbf(r_key)
        pbf_str = pbf.name if pbf else "MISSING (run scripts/fetch_geofabrik_osm.py)"
        print(f"{r_key:<18} {r_info['code2']:<8} {r_info['code3']:<8} {pbf_str:<45}")
    print()


def extract_continental_lines_and_pipelines(pbf_path: Path, code: str, dry_run: bool = False):
    """Step 1: Extract power lines and pipelines via extract_osm_lines.py."""
    log.info("=== [Stage: Extract] Power lines & pipelines for '%s' ===", code)
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "extract_osm_lines.py"),
        "-I", str(pbf_path),
        "-o", str(BUILD_DIR),
        "--suffix", f"_{code}",
        "--all-na",
    ]
    run_cmd(cmd, desc=f"extract_osm_lines ({code})", dry_run=dry_run)


def enrich_continental_tags(code: str, dry_run: bool = False):
    """Step 2: Enrich other_tags into dedicated columns and alias output files."""
    log.info("=== [Stage: Enrich] Tag enrichment for '%s' ===", code)
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "enrich_osm_tags.py"),
        str(BUILD_DIR),
    ]
    run_cmd(cmd, desc=f"enrich_osm_tags ({code})", dry_run=dry_run)

    # Alias / rename intermediate files into canonical final stems
    lines_proc = BUILD_DIR / f"power_line_lines_{code}_processed.gpkg"
    trans_final = BUILD_DIR / f"transmission_lines_{code}.gpkg"
    if lines_proc.exists() and not dry_run:
        shutil.copyfile(lines_proc, trans_final)
        log.info("  %s -> %s", lines_proc.name, trans_final.name)

    pipe_lines_proc = BUILD_DIR / f"pipeline_lines_{code}_processed.gpkg"
    pipe_routes_final = BUILD_DIR / f"pipeline_routes_{code}.gpkg"
    if pipe_lines_proc.exists() and not dry_run:
        shutil.copyfile(pipe_lines_proc, pipe_routes_final)
        log.info("  %s -> %s", pipe_lines_proc.name, pipe_routes_final.name)

    pipe_pts_proc = BUILD_DIR / f"pipeline_feature_points_{code}_processed.csv"
    pipe_pts_final = BUILD_DIR / f"pipeline_points_{code}.csv"
    if pipe_pts_proc.exists() and not dry_run:
        shutil.copyfile(pipe_pts_proc, pipe_pts_final)
        log.info("  %s -> %s", pipe_pts_proc.name, pipe_pts_final.name)


def extract_continental_substations(pbf_path: Path, code: str, dry_run: bool = False):
    """Step 3: Extract substations (points + polygon footprints)."""
    log.info("=== [Stage: Extract] Substations for '%s' ===", code)
    out_csv = BUILD_DIR / f"substation_osm_{code}.csv"
    out_poly = BUILD_DIR / f"substation_polygons_{code}.gpkg"
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "extract_osm_substations.py"),
        "-i", str(pbf_path),
        "-o", str(out_csv),
        "--poly-shp", str(out_poly),
    ]
    run_cmd(cmd, desc=f"extract_osm_substations ({code})", dry_run=dry_run)


def extract_continental_generators(pbf_path: Path, code: str, dry_run: bool = False):
    """Step 4: Extract generators."""
    log.info("=== [Stage: Extract] Generators for '%s' ===", code)
    out_csv = BUILD_DIR / f"generator_osm_{code}.csv"
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "extract_osm_generators.py"),
        "-i", str(pbf_path),
        "-o", str(out_csv),
    ]
    run_cmd(cmd, desc=f"extract_osm_generators ({code})", dry_run=dry_run)


def extract_continental_datacenters(pbf_path: Path, code: str, dry_run: bool = False):
    """Step 5: Extract data centers."""
    log.info("=== [Stage: Extract] Data centers for '%s' ===", code)
    out_csv = BUILD_DIR / f"datacenter_osm_{code}.csv"
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "extract_osm_datacenters.py"),
        "-i", str(pbf_path),
        "-o", str(out_csv),
    ]
    run_cmd(cmd, desc=f"extract_osm_datacenters ({code})", dry_run=dry_run)


def extract_continental_plants(pbf_path: Path, code: str, dry_run: bool = False):
    """Step 6: Extract power plants (points + polygon footprints)."""
    log.info("=== [Stage: Extract] Power plants for '%s' ===", code)
    out_csv = BUILD_DIR / f"plant_osm_{code}.csv"
    out_poly = BUILD_DIR / f"plant_polygons_{code}.gpkg"
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "extract_osm_plants.py"),
        "-i", str(pbf_path),
        "-o", str(out_csv),
        "--poly-shp", str(out_poly),
    ]
    run_cmd(cmd, desc=f"extract_osm_plants ({code})", dry_run=dry_run)


def _build_geojson_layer(src: Path, out_gz: Path, select: Optional[List[str]] = None,
                         where: Optional[str] = None, precision: int = 6, dry_run: bool = False):
    if _skip_layer(out_gz.name.split(".")[0].rsplit("_", 1)[0]):
        return
    if not src.exists():
        log.warning("  [skip] Source %s does not exist", src)
        return

    out_json = out_gz.with_suffix("")
    if out_json.suffix != ".geojson":
        out_json = out_gz.parent / (out_gz.stem)

    src_opts = []
    if src.suffix == ".csv":
        src_opts = ["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                    "-oo", "KEEP_GEOM_COLUMNS=NO"]

    common_opts = []
    if select:
        common_opts += ["-select", ",".join(select)]
    if where:
        common_opts += ["-where", where]
    if precision:
        common_opts += ["-lco", f"COORDINATE_PRECISION={precision}"]

    cmd = [
        "ogr2ogr", "-f", "GeoJSON", str(out_json), str(src),
        *src_opts, *common_opts, "-lco", "RFC7946=YES"
    ]
    run_cmd(cmd, desc=f"ogr2ogr {out_json.name}", dry_run=dry_run)

    if not dry_run and out_json.exists():
        with open(out_json, "rb") as f_in, gzip.open(out_gz, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        out_json.unlink(missing_ok=True)
        log.info("  ✓ Built %s (%d KiB)", out_gz.name, out_gz.stat().st_size // 1024)


def _build_pmtiles_layer(src: Path, out_pmtiles: Path, layer_id: str,
                         min_zoom: int, max_zoom: int, select: Optional[List[str]] = None,
                         precision: int = 6, simplification: Optional[int] = None,
                         max_tile_bytes: int = 500000, flags: Optional[List[str]] = None,
                         dry_run: bool = False):
    if _skip_layer(layer_id):
        return
    if not src.exists():
        log.warning("  [skip] Source %s does not exist", src)
        return

    seq = out_pmtiles.with_suffix(".geojsonl")
    src_opts = []
    if src.suffix == ".csv":
        src_opts = ["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                    "-oo", "KEEP_GEOM_COLUMNS=NO"]

    common_opts = []
    if select:
        common_opts += ["-select", ",".join(select)]
    if precision:
        common_opts += ["-lco", f"COORDINATE_PRECISION={precision}"]

    cmd_seq = [
        "ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(src),
        *src_opts, *common_opts, "-lco", "RFC7946=NO"
    ]
    run_cmd(cmd_seq, desc=f"ogr2ogr {seq.name}", dry_run=dry_run)

    # tippecanoe needs at least one feature, and --force truncates the target
    # before it reads the input — so an empty layer is skipped outright.
    if not dry_run and (not seq.exists() or seq.stat().st_size == 0):
        log.warning("  [skip] %s has no rows for %s — leaving %s as it was",
                    src.name, layer_id, out_pmtiles.name)
        seq.unlink(missing_ok=True)
        return

    tip = [
        "tippecanoe", "-o", str(out_pmtiles), "-l", layer_id,
        f"--minimum-zoom={min_zoom}",
        f"--maximum-zoom={max_zoom}",
        *(flags or []),
    ]
    if simplification:
        tip.append(f"--simplification={simplification}")
    tip += [f"--maximum-tile-bytes={max_tile_bytes}", "--read-parallel", "--force", str(seq)]

    run_cmd(tip, desc=f"tippecanoe {out_pmtiles.name}", dry_run=dry_run)
    if not dry_run:
        seq.unlink(missing_ok=True)
        if out_pmtiles.exists():
            log.info("  ✓ Built %s (%d KiB)", out_pmtiles.name, out_pmtiles.stat().st_size // 1024)


def build_continental_tiles(code: str, dry_run: bool = False):
    """Step 7: Build PMTiles and GeoJSON.gz for all continental OSM layers."""
    log.info("=== [Stage: Tiles] Building PMTiles & GeoJSON for '%s' ===", code)
    LAYERS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Transmission Lines — no continental PMTiles.
    #
    # `build_global_tiles.py` re-tiles this layer planet-wide from the eight
    # `transmission_lines_{code}.gpkg` files rather than joining per-continent
    # archives, so a continental archive would have no consumer: the download
    # packs are built from the GeoPackages, not the tiles. Re-tiling globally is
    # what lets the build dedupe the Geofabrik seam overlaps and cut the layer
    # into voltage classes; see docs/hosting-plan.md. The zoom ladder and the
    # tippecanoe flags live there too, so this file no longer carries them.

    # 2. Substation Points PMTiles
    _build_pmtiles_layer(
        src=BUILD_DIR / f"substation_osm_{code}.csv",
        out_pmtiles=LAYERS_DIR / f"osm_substations_points_{code}.pmtiles",
        layer_id="osm_substations_points",
        min_zoom=0,
        max_zoom=13,
        select=["osm_id", "name", "nominal_kv", "operator", "sub_type"],
        flags=["-r1", "--no-tile-size-limit", "--no-feature-limit", "--preserve-input-order"],
        dry_run=dry_run,
    )

    # 3. Substation Polygons GeoJSON.gz
    _build_geojson_layer(
        src=BUILD_DIR / f"substation_polygons_{code}.gpkg",
        out_gz=LAYERS_DIR / f"osm_substations_polygons_{code}.geojson.gz",
        select=["osm_id", "name", "nominal_kv", "operator", "sub_type"],
        precision=6,
        dry_run=dry_run,
    )

    # 4. Generators PMTiles
    _build_pmtiles_layer(
        src=BUILD_DIR / f"generator_osm_{code}.csv",
        out_pmtiles=LAYERS_DIR / f"osm_generators_{code}.pmtiles",
        layer_id="osm_generators",
        min_zoom=7,
        max_zoom=13,
        max_tile_bytes=2000000,
        select=["osm_id", "name", "source", "gen_method", "gen_type", "output_mw", "operator"],
        flags=["--drop-densest-as-needed", "--extend-zooms-if-still-dropping"],
        dry_run=dry_run,
    )

    # 5. Plant Points GeoJSON.gz
    _build_geojson_layer(
        src=BUILD_DIR / f"plant_osm_{code}.csv",
        out_gz=LAYERS_DIR / f"osm_plants_points_{code}.geojson.gz",
        select=["osm_id", "name", "source", "output_mw", "operator", "start_date"],
        dry_run=dry_run,
    )

    # 6. Plant Polygons GeoJSON.gz
    _build_geojson_layer(
        src=BUILD_DIR / f"plant_polygons_{code}.gpkg",
        out_gz=LAYERS_DIR / f"osm_plants_polygons_{code}.geojson.gz",
        select=["osm_id", "name", "source", "output_mw", "operator", "start_date"],
        precision=6,
        dry_run=dry_run,
    )

    # 7. Data Centers GeoJSON.gz
    _build_geojson_layer(
        src=BUILD_DIR / f"datacenter_osm_{code}.csv",
        out_gz=LAYERS_DIR / f"osm_datacenters_{code}.geojson.gz",
        select=["osm_id", "osm_type", "name", "operator", "website", "addr_city", "addr_state", "start_date", "im3_sqft", "im3_ref"],
        dry_run=dry_run,
    )

    # 8. Pipeline Routes PMTiles
    _build_pmtiles_layer(
        src=BUILD_DIR / f"pipeline_routes_{code}.gpkg",
        out_pmtiles=LAYERS_DIR / f"osm_pipelines_lines_{code}.pmtiles",
        layer_id="osm_pipelines_lines",
        min_zoom=2,
        max_zoom=12,
        simplification=4,
        select=["name", "substance", "operator"],
        flags=["--drop-densest-as-needed", "--coalesce-densest-as-needed"],
        dry_run=dry_run,
    )

    # 9. Pipeline Points GeoJSON.gz
    _build_geojson_layer(
        src=BUILD_DIR / f"pipeline_points_{code}.csv",
        out_gz=LAYERS_DIR / f"osm_pipelines_points_{code}.geojson.gz",
        where="pipeline != 'valve'",
        dry_run=dry_run,
    )


def build_continental_releases(code: str, dry_run: bool = False):
    """Step 8: Generate download packs (ZIPs) in data/releases/.

    build_releases.py owns pack layout — it reads release_manifest.yaml and, for
    every `continental: true` layer, writes each format this continent offers
    (CSV, GeoJSON, SHP) with the layer doc and attribute CSV bundled in. Passing
    --code restricts it to this continent's packs.
    """
    log.info("=== [Stage: Releases] Building download packs for '%s' ===", code)
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    run_cmd(
        [sys.executable, str(SCRIPTS_DIR / "build_releases.py"), "--code", code],
        desc=f"build_releases ({code})",
        dry_run=dry_run,
    )


def process_region(region_key: str, stage: str = "all", code_style: str = "2letter", dry_run: bool = False):
    code = get_region_code(region_key, code_style=code_style)
    pbf_path = find_region_pbf(region_key)

    if not pbf_path and stage in ("extract", "all"):
        log.error("Cannot process region '%s': raw .osm.pbf file not found in %s", region_key, RAW_DIR)
        return False

    log.info("\n================================================================================")
    log.info("PROCESSING CONTINENT: %s (Code: '%s') | Stage: %s", CONTINENTAL_REGIONS[region_key]['name'], code, stage.upper())
    log.info("Input PBF: %s", pbf_path)
    log.info("================================================================================")

    t0 = time.time()

    if stage in ("extract", "all"):
        extract_continental_lines_and_pipelines(pbf_path, code, dry_run=dry_run)
        enrich_continental_tags(code, dry_run=dry_run)
        extract_continental_substations(pbf_path, code, dry_run=dry_run)
        extract_continental_generators(pbf_path, code, dry_run=dry_run)
        extract_continental_datacenters(pbf_path, code, dry_run=dry_run)
        extract_continental_plants(pbf_path, code, dry_run=dry_run)

    if stage in ("tiles", "all"):
        build_continental_tiles(code, dry_run=dry_run)

    if stage in ("releases", "all"):
        build_continental_releases(code, dry_run=dry_run)

    log.info("✓ Completed '%s' [%.1f s]\n", region_key, time.time() - t0)
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Process OSM energy infrastructure across continental extracts."
    )
    parser.add_argument("--region", "-r", type=str, help="Continent name or code (e.g. europe, eu, oc, all)")
    parser.add_argument("--all", action="store_true", help="Process all available continental extracts")
    parser.add_argument("--stage", "-s", choices=["extract", "enrich", "tiles", "releases", "all"], default="all",
                        help="Processing stage to run (default: all)")
    parser.add_argument("--code-style", choices=["2letter", "3letter"], default="2letter",
                        help="Continent code style in filenames (default: 2letter)")
    parser.add_argument("--only", action="append", metavar="LAYER",
                        help="restrict the tiles stage to this layer id (repeatable), "
                             "e.g. --only osm_transmission_lines")
    parser.add_argument("--dry-run", action="store_true", help="Print execution plan without running")
    parser.add_argument("--list", action="store_true", help="List all available continental regions & PBF files")

    args = parser.parse_args()
    ONLY_LAYERS.update(args.only or [])

    if args.list:
        list_regions()
        return

    if not args.region and not args.all:
        parser.print_help()
        sys.exit(1)

    regions_to_process = list(CONTINENTAL_REGIONS.keys()) if args.all or (args.region and args.region.lower() == "all") else []
    if not regions_to_process:
        resolved = resolve_region(args.region)
        if not resolved:
            log.error("Unknown region '%s'. Run with --list to see available regions and codes.", args.region)
            sys.exit(1)
        regions_to_process = [resolved]

    for reg in regions_to_process:
        success = process_region(reg, stage=args.stage, code_style=args.code_style, dry_run=args.dry_run)
        if not success:
            sys.exit(1)


if __name__ == "__main__":
    main()
