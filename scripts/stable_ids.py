#!/usr/bin/env python3
"""stable_ids.py — check that every served layer carries its stable feature id.

Reads each layer's `id_field` (and `native_id`) from scripts/tile_manifest.yaml,
including its `built_elsewhere` list, and checks what is served from
data/layers/:

  <id>.geojson.gz   every feature; an id seen twice is a duplicate.
  <id>.pmtiles      (plus <id>_*.pmtiles for a `split_voltage_bands` layer)
                    decoded at the archive's max zoom with tippecanoe-decode,
                    streamed. An id repeated **within one tile** is a duplicate.
                    The same id in several tiles is one feature cut by tile
                    edges, which is expected. The archives of a split layer
                    must not share an id either.

An id is missing when a native_id archive's feature has no vector-tile id, or
when the `id_field` property is absent, null or empty.

`--input FILE` (with `--only`) also checks the build intermediate the layer was
tiled from (.csv, .geojson[.gz], .geojsonl, or any OGR file such as .gpkg) for
missing and duplicate ids, and counts its ids absent from the archive (full
passes only).

Exit status: 0 clean, 1 on any missing or duplicate id, 2 on a usage error.

Usage:
  python scripts/stable_ids.py                                 # every layer
  python scripts/stable_ids.py --only osm_generators --max-tiles 500
  python scripts/stable_ids.py --only eia_generators --input data/build/generator_eia.csv
"""
import argparse
import csv
import gzip
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts" / "tile_manifest.yaml"
LAYERS_DIR = ROOT / "data" / "layers"

TILE_RE = re.compile(r'^\{ "type": "FeatureCollection", "properties": \{ "zoom": (\d+), "x": (\d+), "y": (\d+)')
LAYER_RE = re.compile(r'^\{ "type": "FeatureCollection", "properties": \{ "layer": ')
FEATURE_PREFIX = '{ "type": "Feature",'
NATIVE_ID_RE = re.compile(r'^\{ "type": "Feature", "id": (\d+)')


@dataclass
class Stats:
    tiles: int = 0
    features: int = 0
    missing: int = 0
    dups: int = 0
    ids: set = field(default_factory=set)
    examples: list = field(default_factory=list)
    complete: bool = True   # False when --max-tiles cut the pass short


def norm(v):
    """An id as a comparable string, or None when absent. 303622.0 → '303622'."""
    if v is None or v == "":
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)


def scan_features(features, id_field, native=False):
    """Whole features (GeoJSON, an intermediate): any repeated id is a duplicate."""
    st = Stats()
    for f in features:
        st.features += 1
        fid = norm(f.get("id") if native else (f.get("properties") or {}).get(id_field))
        if fid is None:
            st.missing += 1
        elif fid in st.ids:
            st.dups += 1
            if len(st.examples) < 5:
                st.examples.append(fid)
        else:
            st.ids.add(fid)
    return st


def scan_decode(lines, id_field, native, max_tiles=0):
    """tippecanoe-decode output, one tile at a time: duplicates are counted per
    tile and layer, so a feature split across tiles is not one."""
    st, seen, where = Stats(), set(), None
    for line in lines:
        if line.startswith(FEATURE_PREFIX):
            st.features += 1
            if native:
                m = NATIVE_ID_RE.match(line)
                fid = m.group(1) if m else None
            else:
                fid = norm(json.loads(line)["properties"].get(id_field))
            if fid is None:
                st.missing += 1
            elif fid in seen:
                st.dups += 1
                if len(st.examples) < 5:
                    st.examples.append(f"{fid} in {where}")
            else:
                seen.add(fid)
                st.ids.add(fid)
            continue
        m = TILE_RE.match(line)
        if m:
            if max_tiles and st.tiles >= max_tiles:
                st.complete = False
                break
            st.tiles += 1
            where = "/".join(m.groups())
            seen = set()
        elif LAYER_RE.match(line):
            seen = set()
    return st


def pmtiles_max_zoom(path):
    """max_zoom from a PMTiles v3 header (byte 101 of the fixed 127-byte header)."""
    with open(path, "rb") as f:
        head = f.read(127)
    if len(head) < 127 or head[:7] != b"PMTiles" or head[7] != 3:
        raise ValueError(f"{path}: not a PMTiles v3 archive")
    return head[101]


def scan_pmtiles(path, id_field, native, zoom=None, max_tiles=0):
    zoom = pmtiles_max_zoom(path) if zoom is None else zoom
    proc = subprocess.Popen(["tippecanoe-decode", "-z", str(zoom), "-Z", str(zoom), str(path)],
                            stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    try:
        st = scan_decode(proc.stdout, id_field, native, max_tiles)
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    if not st.complete:
        proc.kill()
    proc.stdout.close()
    if proc.wait() != 0 and st.complete:
        raise RuntimeError(f"tippecanoe-decode {path} exited {proc.returncode}")
    return zoom, st


def _open_text(path):
    return gzip.open(path, "rt", encoding="utf-8") if str(path).endswith(".gz") \
        else open(path, encoding="utf-8", newline="")


def read_input_ids(path, id_field):
    """Every row's id from a build intermediate, None where it has none."""
    name = str(path).removesuffix(".gz")
    if name.endswith(".csv"):
        with _open_text(path) as f:
            return [norm(r.get(id_field)) for r in csv.DictReader(f)]
    if name.endswith(".geojson"):
        with _open_text(path) as f:
            return [norm((ft.get("properties") or {}).get(id_field)) for ft in json.load(f)["features"]]
    if name.endswith((".geojsonl", ".geojsons")):
        with _open_text(path) as f:
            return [norm((json.loads(ln).get("properties") or {}).get(id_field))
                    for ln in f if ln.strip()]
    import pyogrio  # gpkg and the rest; venv only
    df = pyogrio.read_dataframe(path, columns=[id_field], read_geometry=False)
    return [norm(v) for v in df[id_field].tolist()]


def artifacts(layer, layers_dir):
    lid = layer["id"]
    paths = [layers_dir / f"{lid}.geojson.gz", layers_dir / f"{lid}.pmtiles"]
    if layer.get("split_voltage_bands"):
        paths += sorted(layers_dir.glob(f"{lid}_*.pmtiles"))
    return [p for p in paths if p.exists()]


def check_layer(layer, layers_dir, zoom=None, max_tiles=0):
    """[(archive name, zoom or '-', Stats)] for every served artifact of a layer;
    a split layer gets one more row for ids its archives share."""
    rows, id_field, native = [], layer["id_field"], bool(layer.get("native_id"))
    for path in artifacts(layer, layers_dir):
        if path.suffix == ".pmtiles":
            z, st = scan_pmtiles(path, id_field, native, zoom, max_tiles)
        else:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                z, st = "-", scan_features(json.load(f)["features"], id_field)
        rows.append((path.name, z, st))
    if len(rows) > 1:
        union = set().union(*(st.ids for _, _, st in rows))
        shared = Stats(dups=sum(len(st.ids) for _, _, st in rows) - len(union), ids=union,
                       complete=all(st.complete for _, _, st in rows))
        rows.append(("(across archives)", "-", shared))
    return rows


def load_layers(manifest_path):
    import yaml  # venv only; the unit tests never need it
    doc = yaml.safe_load(Path(manifest_path).read_text())
    return [L for L in doc["layers"] + (doc.get("built_elsewhere") or []) if L.get("id_field")]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    ap.add_argument("--only", help="check only this layer id")
    ap.add_argument("--max-tiles", type=int, default=0,
                    help="stop each archive after N tiles at the zoom (default 0: all)")
    ap.add_argument("--zoom", type=int, help="decode this zoom instead of the archive's max")
    ap.add_argument("--input", help="also check this build intermediate (needs --only)")
    ap.add_argument("--layers-dir", default=str(LAYERS_DIR))
    ap.add_argument("--manifest", default=str(MANIFEST))
    args = ap.parse_args(argv)
    if args.input and not args.only:
        ap.error("--input needs --only")

    layers = load_layers(args.manifest)
    if args.only:
        layers = [L for L in layers if L["id"] == args.only]
        if not layers:
            ap.error(f"no layer {args.only!r} with an id_field in {args.manifest}")

    fmt = "{:<26} {:<32} {:>4} {:>7} {:>10} {:>10} {:>8} {:>6}"
    print(fmt.format("layer", "archive", "zoom", "tiles", "features", "ids", "missing", "dups"))
    bad, layer_ids = False, set()
    for layer in layers:
        rows = check_layer(layer, Path(args.layers_dir), args.zoom, args.max_tiles)
        if not rows:
            print(fmt.format(layer["id"], "[skip] not built", "", "", "", "", "", ""))
        for name, z, st in rows:
            print(fmt.format(layer["id"], name, z, st.tiles or "-", st.features or "-",
                             len(st.ids), st.missing, st.dups)
                  + ("" if st.complete else "  (sampled)"))
            for ex in st.examples:
                print(f"    duplicate: {ex}")
            bad |= bool(st.missing or st.dups)
        layer_ids = set().union(*(st.ids for _, _, st in rows)) if rows else set()
        complete = bool(rows) and all(st.complete for _, _, st in rows)

    if args.input:
        ids = read_input_ids(args.input, layers[0]["id_field"])
        present = [i for i in ids if i is not None]
        missing, dups = len(ids) - len(present), len(present) - len(set(present))
        absent = len(set(present) - layer_ids) if complete else "n/a (sampled or not built)"
        print(f"\ninput {args.input}: {len(ids)} rows, {missing} missing, {dups} duplicate, "
              f"{absent} absent from the archive at the checked zoom")
        bad |= bool(missing or dups)

    print("\nFAIL: missing or duplicate ids" if bad else "\nOK: every id present and unique")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
