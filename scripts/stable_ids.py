#!/usr/bin/env python3
"""stable_ids.py — check that every served layer carries its stable feature id.

Reads each layer's `id_field` (and `native_id`) from scripts/tile_manifest.yaml,
including its `built_elsewhere` list, and checks what is served from
data/layers/:

  <id>.geojson[.gz] every feature; an id seen twice is a duplicate.
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

`--lines` checks the line geometry files instead (data/analysis/, built by
build_line_parquet.py): every id the archives serve at max zoom is in IDX (0
missing; IDX ids no tile carries are counted, not failed), IDX has no
duplicate, IDX `row` and CHAINS `row` point at the GEO row of their fid on a
sample, and sampled tile pieces lie on their GEO geometry within the tile grid.

`--attrs` holds attributes instead: each pmtiles layer's archives are decoded
at every zoom (or `--zooms`), a uniform sample of tiles per zoom is kept
(`--max-tiles`, default 500; `--all-tiles` for all), and every sampled
feature's attributes must equal its build input row's, found by stable id. The
input is read as the build reads it: the manifest `src` through ogr2ogr with
its `select`/`where`, or for a world layer the continental intermediates in
build_global_tiles.py's dedupe order (transmission: the kept merged input). The
region fields a world build adds after the merge are not compared. Memory grows
with the sample, never with the input.

Exit status: 0 clean, 1 on any missing or duplicate id (or, with --attrs, any
mismatched attribute), 2 on a usage error.

Usage:
  python scripts/stable_ids.py                                 # every layer
  python scripts/stable_ids.py --only osm_generators --max-tiles 500
  python scripts/stable_ids.py --only eia_generators --input data/build/generator_eia.csv
  python scripts/stable_ids.py --only dc_moratoriums --layers-dir _private/moratoriums/dataset
  python scripts/stable_ids.py --lines                         # data/analysis/ vs the tiles
  python scripts/stable_ids.py --attrs --only hifld_transmission_lines --zooms 9,10,11
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


def scan_decode(lines, id_field, native, max_tiles=0, on_feature=None):
    """tippecanoe-decode output, one tile at a time: duplicates are counted per
    tile and layer, so a feature split across tiles is not one. `on_feature`,
    when given, is called with (id, feature line) for every feature."""
    st, seen, where = Stats(), set(), None
    for line in lines:
        if line.startswith(FEATURE_PREFIX):
            st.features += 1
            if native:
                m = NATIVE_ID_RE.match(line)
                fid = m.group(1) if m else None
            else:
                fid = norm(json.loads(line)["properties"].get(id_field))
            if on_feature is not None and fid is not None:
                on_feature(fid, line)
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


def scan_pmtiles(path, id_field, native, zoom=None, max_tiles=0, on_feature=None):
    zoom = pmtiles_max_zoom(path) if zoom is None else zoom
    proc = subprocess.Popen(["tippecanoe-decode", "-z", str(zoom), "-Z", str(zoom), str(path)],
                            stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    try:
        st = scan_decode(proc.stdout, id_field, native, max_tiles, on_feature)
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
    # The .gz is the served GeoJSON; a plain sibling is the same features, read once.
    gz, plain = layers_dir / f"{lid}.geojson.gz", layers_dir / f"{lid}.geojson"
    paths = [gz if gz.exists() else plain, layers_dir / f"{lid}.pmtiles"]
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
            with _open_text(path) as f:
                z, st = "-", scan_features(json.load(f)["features"], id_field)
        rows.append((path.name, z, st))
    if len(rows) > 1:
        union = set().union(*(st.ids for _, _, st in rows))
        shared = Stats(dups=sum(len(st.ids) for _, _, st in rows) - len(union), ids=union,
                       complete=all(st.complete for _, _, st in rows))
        rows.append(("(across archives)", "-", shared))
    return rows


# ── --lines: the line geometry files against the served archives ───────────

ANALYSIS_DIR = ROOT / "data" / "analysis"
# A tile vertex is the line's vertex snapped to the tile grid at max zoom
# (within √2/2 grid unit of the GEO geometry), or a clip point on the tile
# buffer, computed on the snapped segment and snapped again (within √2). More
# means the two disagree.
GEOM_TOLERANCE_UNITS = 1.5


def mercator_units(xy, zoom):
    """lon/lat (n, 2) → Web Mercator tile-grid units at `zoom` (4096 a tile)."""
    import numpy as np
    w = 4096 * 2 ** zoom
    lat = np.radians(np.clip(xy[:, 1], -85.0511, 85.0511))
    return np.c_[(xy[:, 0] + 180) / 360 * w,
                 (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / np.pi) / 2 * w]


def tile_vs_geo_units(tile_geom, geo_geom, zoom):
    """Largest distance from a tile piece's vertices to the GEO line, in grid units."""
    import shapely
    t = shapely.get_coordinates(tile_geom)
    parts = shapely.get_parts(geo_geom)
    line = shapely.multilinestrings([shapely.linestrings(mercator_units(shapely.get_coordinates(g), zoom))
                                     for g in parts])
    return float(shapely.distance(shapely.points(mercator_units(t, zoom)), line).max())


def check_lines(analysis_dir, layers_dir, manifest, sample=1000, max_tiles=0, seed=1):
    """Every served tile id in IDX (0 missing), no duplicate in IDX, IDX and
    CHAINS rows pointing at the GEO row of their fid, and a sample of tile
    pieces lying on their GEO geometry. Prints a table; returns True if clean."""
    import random

    import numpy as np
    import pyarrow.parquet as pq
    import shapely

    index = json.loads((Path(analysis_dir) / "index.json").read_text())
    layers = {L["id"]: L for L in load_layers(manifest)}
    clean = True
    for ds, m in sorted(index["datasets"].items()):
        d = Path(analysis_dir) / m["path"]
        layer = layers[ds]
        rng = random.Random(seed)
        pieces, seen = [], [0]

        def keep(fid, line):
            seen[0] += 1
            if len(pieces) < sample:
                pieces.append((fid, line))
            elif (j := rng.randrange(seen[0])) < sample:
                pieces[j] = (fid, line)

        tile_ids, tile_dups, complete, zoom = set(), 0, True, None
        archives = [p for p in artifacts(layer, Path(layers_dir)) if p.suffix == ".pmtiles"]
        if not archives:
            print(f"{ds}: [FAIL] no served archive in {layers_dir} to check against")
            clean = False
            continue
        for path in archives:
            zoom, st = scan_pmtiles(path, layer["id_field"], bool(layer.get("native_id")),
                                    None, max_tiles, keep)
            tile_dups += st.dups + len(tile_ids & st.ids)
            tile_ids |= st.ids
            complete &= st.complete
        idx = pq.read_table(d / m["idx"]["name"]).to_pydict()
        idx_ids = [norm(v) for v in idx["fid"]]
        idx_set = set(idx_ids)
        idx_dups = len(idx_ids) - len(idx_set)
        missing = len(tile_ids - idx_set)
        extras = len(idx_set - tile_ids) if complete else "n/a"
        geo_fid = [norm(v) for e in m["geo"]
                   for v in pq.read_table(d / e["name"], columns=["fid"]).column("fid").to_pylist()]
        pick = rng.sample(range(len(idx_ids)), min(sample, len(idx_ids)))
        bad_ptr = sum(geo_fid[idx["row"][i]] != idx_ids[i] for i in pick)
        bad_chain = 0
        if m.get("chains"):
            ch = pq.read_table(d / m["chains"]["name"]).to_pydict()
            chain_of = dict(zip(idx_ids, idx["chain"]))
            for i in rng.sample(range(len(ch["fid"])), min(sample, len(ch["fid"]))):
                f = norm(ch["fid"][i])
                bad_chain += geo_fid[ch["row"][i]] != f or chain_of.get(f) != ch["chain"][i]
        # tile pieces against their GEO geometry
        row_of = dict(zip(idx_ids, idx["row"]))
        want = {}
        for fid, line in pieces:
            if fid in row_of:
                want.setdefault(row_of[fid], []).append(json.loads(line)["geometry"])
        worst = []
        for e in m["geo"]:
            lo, hi = e["row_offset"], e["row_offset"] + e["rows"]
            rows = [r for r in want if lo <= r < hi]
            if not rows:
                continue
            wkb = pq.read_table(d / e["name"], columns=["geometry"]).column("geometry").take(
                np.array(rows) - lo).to_pylist()
            for r, g in zip(rows, shapely.from_wkb(wkb)):
                for piece in want[r]:
                    worst.append(tile_vs_geo_units(shapely.from_geojson(json.dumps(piece)), g, zoom))
        worst.sort()
        geo_max = worst[-1] if worst else 0.0
        geo_p99 = worst[int(0.99 * (len(worst) - 1))] if worst else 0.0
        ok = not (missing or idx_dups or tile_dups or bad_ptr or bad_chain) \
            and geo_max <= GEOM_TOLERANCE_UNITS
        clean &= ok
        print(f"{ds}: tiles z{zoom} {len(tile_ids)} ids ({'complete' if complete else 'sampled'}), "
              f"IDX {len(idx_ids)} rows · missing {missing} · IDX extras {extras} · "
              f"IDX dups {idx_dups} · tile dups {tile_dups} · pointer errors {bad_ptr}/{len(pick)} · "
              f"chain errors {bad_chain} · tile vs GEO {len(worst)} pieces, max {geo_max:.3f} "
              f"p99 {geo_p99:.3f} grid units (≤ {GEOM_TOLERANCE_UNITS}) · {'OK' if ok else 'FAIL'}")
    return clean


# ── --attrs: every tile feature's attributes against its build input row ──

ATTRS_DEFAULT_TILES = 500   # tiles sampled per zoom unless --max-tiles says otherwise


def attr_value(v):
    """An attribute as compared: None for absent/null/empty, numbers by value
    (tippecanoe stores 345.0 as 345), strings as they are."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (int, float)):
        return repr(float(v))
    return str(v)


def world_spec(layer_id):
    """How build_global_tiles.py builds a world layer: (continental inputs in
    dedupe order, select, region fields it adds) — or None for a layer
    build_tiles.py builds from its manifest `src`."""
    import build_global_tiles as g
    if layer_id == g.TRANSMISSION_BASE:
        if g.TRANSMISSION_KEPT.exists():   # the merged, deduped input, kept as tiled
            return [g.TRANSMISSION_KEPT], g.TRANSMISSION_SELECT, g.LINE_FIELDS
        return ([g.BUILD_DIR / f"{g.TRANSMISSION_SRC_STEM}_{c}.gpkg" for c in g.REGION_CODES],
                g.TRANSMISSION_SELECT, g.LINE_FIELDS)
    for spec in g.RETILE:
        if spec["base"] == layer_id:
            return g._retile_inputs(spec), spec["select"], spec["fields"]
    for spec in g.TILE_POLYGONS:
        if spec["base"] == layer_id:
            return ([g.BUILD_DIR / f"{spec['src']}_{c}.gpkg" for c in g.REGION_CODES],
                    spec["select"], spec["fields"])
    return None


def input_rows(layer):
    """(inputs, ogr2ogr options, fields the tiles may carry beyond the input):
    the rows tippecanoe read for this layer, as the build reads them."""
    world = world_spec(layer["id"])
    if world:
        srcs, select, region_fields = world
        return ([p for p in srcs if p.exists()],
                lambda p: ([] if p.suffix in (".geojsonl", ".gz") else
                           [*(["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                               "-oo", "KEEP_GEOM_COLUMNS=NO"] if p.suffix == ".csv" else []),
                            "-select", ",".join(select)]),
                set(region_fields))
    import build_tiles as b
    src = ROOT / layer["src"]
    return ([src] if src.exists() else [],
            lambda p: [*b._src_opts(p), *b._common_opts(layer)], set())


def stream_rows(path, opts):
    """Each input row's properties (plus a feature `id`, as `__id`), streamed."""
    if str(path).endswith((".geojsonl", ".geojsonl.gz")):
        with _open_text(path) as f:
            for ln in f:
                if ln.strip():
                    ft = json.loads(ln)
                    yield {**(ft.get("properties") or {}), "__id": ft.get("id")}
        return
    proc = subprocess.Popen(["ogr2ogr", "-f", "GeoJSONSeq", "/vsistdout/", str(path), *opts],
                            stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    try:
        for ln in proc.stdout:
            ln = ln.strip().lstrip("\x1e")
            if ln:
                ft = json.loads(ln)
                yield {**(ft.get("properties") or {}), "__id": ft.get("id")}
    finally:
        proc.stdout.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ogr2ogr {path} exited {proc.returncode}")


def sample_tiles(lines, id_field, native, max_tiles, rng):
    """tippecanoe-decode output for one zoom → {id: {attribute key: count}} over a
    uniform sample of `max_tiles` tiles (all when 0), plus (tiles seen, features
    kept, features without an id). An attribute key is the feature's properties,
    the id field dropped, as sorted JSON."""
    reservoir, current, seen, no_id = [], None, 0, 0

    def close():
        nonlocal current
        if current is None:
            return
        if not max_tiles or len(reservoir) < max_tiles:
            reservoir.append(current)
        elif (j := rng.randrange(seen)) < max_tiles:
            reservoir[j] = current
        current = None

    for line in lines:
        if line.startswith(FEATURE_PREFIX):
            if current is None:
                continue
            ft = json.loads(line.rstrip().rstrip(","))
            props = ft.get("properties") or {}
            fid = norm(ft.get("id")) if native else norm(props.get(id_field))
            if fid is None:
                no_id += 1
                continue
            props.pop(id_field, None)
            current.append((fid, json.dumps(props, sort_keys=True)))
        elif TILE_RE.match(line):
            close()
            seen += 1
            current = []
    close()
    out = {}
    for tile in reservoir:
        for fid, key in tile:
            keys = out.setdefault(fid, {})
            keys[key] = keys.get(key, 0) + 1
    return out, seen, sum(len(t) for t in reservoir), no_id


def index_rows(rows, want, id_field):
    """{id: [input rows]} for the ids in `want`, streamed from `rows`. An id's
    rows are all kept: a feature matches when any one of them agrees (HIFLD
    lines repeat an ID; on a world seam copy the first continent's row wins
    the merge and is listed first)."""
    found = {}
    for r in rows:
        fid = norm(r.get(id_field))
        if fid is None:
            fid = norm(r.get("__id"))
        if fid in want:
            found.setdefault(fid, []).append(r)
    return found


def compare_attrs(tile_feats, found, id_field, extra_fields=()):
    """Hold sampled tile features to their input rows.

    `tile_feats` is {id: {attribute key: count}} (sample_tiles), `found` the
    input rows by id (index_rows). A feature mismatches when its id is in no
    input row, or a tile attribute differs from the row's value or is absent
    from it (`extra_fields` excepted: the region fields a world build adds
    after the merge). Input attributes a tile leaves out (nulls, fields dropped
    after tiling) are not counted. Returns (features checked, mismatched,
    {field: count}, examples)."""
    checked = bad = 0
    by_field, examples = {}, []
    for fid, keys in tile_feats.items():
        cands = found.get(fid)
        for key, n in keys.items():
            checked += n
            props = json.loads(key)
            wrong, best_row = ["(id not in input)"], None
            for c in cands or []:
                w = [k for k, v in props.items() if k not in extra_fields
                     and attr_value(v) != attr_value(c.get(k))]
                if best_row is None or len(w) < len(wrong):
                    wrong, best_row = w, c
                if not w:
                    break
            if wrong:
                bad += n
                for k in wrong:
                    by_field[k] = by_field.get(k, 0) + n
                if len(examples) < 8:
                    k = wrong[0]
                    examples.append(f"{id_field}={fid} {k}: tile {props.get(k)!r}, input "
                                    f"{(best_row or {}).get(k)!r}")
    return checked, bad, by_field, examples


def pmtiles_min_zoom(path):
    with open(path, "rb") as f:
        return f.read(127)[100]


def check_attrs(layer, layers_dir, zooms=None, max_tiles=ATTRS_DEFAULT_TILES, seed=1):
    """Every served archive of a pmtiles layer, at each zoom (default: all of
    them), sampled and held to the build input, which is read once. Prints one
    line per archive and zoom; returns True when clean, None when there is no
    archive to check."""
    import random
    archives = [p for p in artifacts(layer, Path(layers_dir)) if p.suffix == ".pmtiles"]
    if not archives:
        return None
    srcs, opts, extra = input_rows(layer)
    if not srcs:
        print(f"{layer['id']}: [FAIL] no build input found to compare with")
        return False
    native, id_field = bool(layer.get("native_id")), layer["id_field"]
    samples = []
    for path in archives:
        zs = zooms or range(pmtiles_min_zoom(path), pmtiles_max_zoom(path) + 1)
        for z in zs:
            rng = random.Random(f"{seed}:{path.name}:{z}")
            proc = subprocess.Popen(["tippecanoe-decode", "-z", str(z), "-Z", str(z), str(path)],
                                    stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
            try:
                got = sample_tiles(proc.stdout, id_field, native, max_tiles, rng)
            finally:
                proc.stdout.close()
            if proc.wait() != 0:
                raise RuntimeError(f"tippecanoe-decode {path} exited {proc.returncode}")
            samples.append((path.name, z, got))
    want = set().union(*(feats for _, _, (feats, *_) in samples))
    found = index_rows((r for s in srcs for r in stream_rows(s, opts(s))), want, id_field)
    clean = True
    for name, z, (feats, tiles, kept, no_id) in samples:
        checked, bad, by_field, examples = compare_attrs(feats, found, id_field, extra)
        ok = not bad and not no_id
        clean &= ok
        fields = ", ".join(f"{k} {n}" for k, n in sorted(by_field.items())) or "-"
        sampled = min(tiles, max_tiles) if max_tiles else tiles
        print(f"{layer['id']}: {name} z{z} · {sampled}/{tiles} tiles · {checked} features "
              f"· {len(feats)} ids · no id {no_id} · mismatched {bad} ({fields}) · "
              f"{'OK' if ok else 'FAIL'}", flush=True)
        for ex in examples:
            print(f"    {ex}")
    return clean


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
    ap.add_argument("--all-tiles", action="store_true",
                    help=f"--attrs: every tile at each zoom (default {ATTRS_DEFAULT_TILES} sampled)")
    ap.add_argument("--zoom", type=int, help="decode this zoom instead of the archive's max")
    ap.add_argument("--input", help="also check this build intermediate (needs --only)")
    ap.add_argument("--layers-dir", default=str(LAYERS_DIR))
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--lines", action="store_true",
                    help="check data/analysis/ (build_line_parquet.py) against the served archives")
    ap.add_argument("--analysis-dir", default=str(ANALYSIS_DIR))
    ap.add_argument("--sample", type=int, default=1000, help="--lines: rows and tile pieces sampled")
    ap.add_argument("--attrs", action="store_true",
                    help="hold each archive's feature attributes to its build input row by id")
    ap.add_argument("--zooms", help="--attrs: comma-separated zooms (default: every zoom)")
    args = ap.parse_args(argv)
    if args.input and not args.only:
        ap.error("--input needs --only")
    if args.attrs:
        zooms = [int(z) for z in args.zooms.split(",")] if args.zooms else None
        tiles = ATTRS_DEFAULT_TILES if args.max_tiles == 0 and not args.all_tiles else args.max_tiles
        layers = [L for L in load_layers(args.manifest) if not args.only or L["id"] == args.only]
        if not layers:
            ap.error(f"no layer {args.only!r} with an id_field in {args.manifest}")
        results = [check_attrs(L, args.layers_dir, zooms, tiles) for L in layers]
        ok = all(r is not False for r in results)
        print("\nOK: every sampled tile feature matches its input row" if ok
              else "\nFAIL: tile attributes differ from the build input")
        return 0 if ok else 1
    if args.lines:
        ok = check_lines(args.analysis_dir, args.layers_dir, args.manifest, args.sample, args.max_tiles)
        print("\nOK: line geometry files agree with the tiles" if ok else "\nFAIL: line geometry files")
        return 0 if ok else 1

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
