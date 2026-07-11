#!/usr/bin/env python3
"""TransmissionMap — tile build pipeline (manifest-driven).

Reads scripts/tile_manifest.yaml and builds every layer in order:
  geojson → ogr2ogr GeoJSON, gzipped at the end (served as .geojson.gz)
  pmtiles → ogr2ogr GeoJSONSeq → tippecanoe → .pmtiles (intermediate removed)

`.csv` sources are treated as lon/lat point layers automatically.
Missing source files are skipped (not errors); `make validate` flags gaps.

Usage:
  python scripts/build_tiles.py            # build all layers
  python scripts/build_tiles.py --only X   # build only layer id X
"""
import argparse
import gzip
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml

MANIFEST = Path(__file__).parent / "tile_manifest.yaml"
OUT = Path("data/layers")


def run(cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def check_deps():
    for cmd in ("ogr2ogr", "tippecanoe"):
        if not shutil.which(cmd):
            sys.exit(f"ERROR: {cmd} not found. See docs/pipeline.md prerequisites.")


def _src_opts(src: Path):
    """CSV sources carry lon/lat columns; tell ogr2ogr how to read them."""
    if src.suffix == ".csv":
        return ["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                "-oo", "KEEP_GEOM_COLUMNS=NO"]
    return []


def _common_opts(layer):
    opts = []
    if layer.get("select"):
        opts += ["-select", ",".join(layer["select"])]
    if layer.get("where"):
        opts += ["-where", layer["where"]]
    if layer.get("precision"):
        opts += ["-lco", f"COORDINATE_PRECISION={layer['precision']}"]
    return opts


def build_layer(layer):
    lid, src = layer["id"], Path(layer["src"])
    print(f"\n--- {lid} ({layer['format']}) ---")
    if not src.exists():
        print(f"  [skip] {src} not found")
        return
    OUT.mkdir(parents=True, exist_ok=True)

    if layer["format"] == "geojson":
        out = OUT / f"{lid}.geojson"
        out_tmp = OUT / f"{lid}.geojson.tmp"
        out_tmp.unlink(missing_ok=True)
        simplify = ["-simplify", str(layer["simplify"])] if "simplify" in layer else []
        run(["ogr2ogr", "-f", "GeoJSON", out_tmp, src,
             *_src_opts(src), *_common_opts(layer), *simplify, "-lco", "RFC7946=YES"])
        os.replace(out_tmp, out)
    elif layer["format"] == "pmtiles":
        seq, out = OUT / f"{lid}.geojsonl", OUT / f"{lid}.pmtiles"
        seq_tmp = OUT / f"{lid}.geojsonl.tmp"
        seq_tmp.unlink(missing_ok=True)
        run(["ogr2ogr", "-f", "GeoJSONSeq", seq_tmp, src,
             *_src_opts(src), *_common_opts(layer), "-lco", "RFC7946=NO"])
        os.replace(seq_tmp, seq)
        # tmp name keeps the .pmtiles suffix — tippecanoe picks output format
        # from the extension.
        out_tmp = OUT / f"{lid}.tmp.pmtiles"
        tip = ["tippecanoe", "-o", out_tmp, "-l", lid,
               f"--minimum-zoom={layer['min_zoom']}",
               f"--maximum-zoom={layer['max_zoom']}", *layer.get("flags", [])]
        if "simplification" in layer:
            tip.append(f"--simplification={layer['simplification']}")
        tip += [f"--maximum-tile-bytes={layer.get('max_tile_bytes', 500000)}",
                "--read-parallel", "--force", seq]
        run(tip)
        os.replace(out_tmp, out)
        seq.unlink()
    else:
        sys.exit(f"ERROR: layer {lid}: unknown format {layer['format']!r}")
    print(f"  [done] {out.name}  ({out.stat().st_size // 1024} KiB)")


def gzip_served_geojson():
    """Served GeoJSON is committed pre-gzipped; the web app decompresses client-side."""
    print("\n--- Gzipping served GeoJSON ---")
    for f in sorted(OUT.glob("*.geojson")):
        with f.open("rb") as fi, gzip.open(f"{f}.gz", "wb", compresslevel=9) as fo:
            shutil.copyfileobj(fi, fo)
        f.unlink()
        print(f"  [ok] {f.name}.gz")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="build only this layer id")
    args = ap.parse_args()

    check_deps()
    layers = yaml.safe_load(MANIFEST.read_text())["layers"]
    if args.only:
        layers = [L for L in layers if L["id"] == args.only]
        if not layers:
            sys.exit(f"ERROR: no layer with id '{args.only}' in {MANIFEST.name}")

    start = time.time()
    for layer in layers:
        build_layer(layer)
    # The gzip pass consumes (and unlinks) every *.geojson in data/layers/, so a
    # scoped --only run must not trigger it for unrelated layers — it would eat
    # e.g. the local wildfire_live.geojson that `make wildfire-dev` produced.
    if any(L["format"] == "geojson" for L in layers):
        gzip_served_geojson()
    print(f"\n=== {args.only or 'All tiles'} built in {int(time.time() - start)}s ===")


if __name__ == "__main__":
    main()
