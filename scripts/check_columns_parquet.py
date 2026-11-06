#!/usr/bin/env python3
"""check_columns_parquet.py — holds the columns Parquet files
(data/analysis/columns/<ds>.<sha8>.parquet) to the built archives and to IDX
(docs/roadmap/tier1-parquet.plan.md T14).

Independent of the builder: it imports neither build_columns_parquet nor
tile_inputs. The reference is the tiles themselves, decoded at the archive's max
zoom with tippecanoe-decode.

  tile check   every id a max-zoom tile carries is in the Parquet; per id every
               tile attribute equals the Parquet value (numbers by value, to 12
               significant digits; strings stay strings; a null in the Parquet
               is an attribute the tile does not carry); the Parquet-only ids
               are counted and their share written to index.json
               columns.<ds>.tiles_missing {count, share} (reported, never a
               failure: the dataset scope deliberately counts features dropped
               for drawing). For the two transmission datasets Parquet
               `length_km` also equals IDX `length_km` for every fid.
               Fails (exit 1) on any id, attribute or length mismatch.
  point check  `px`/`py` must be int32 micro-degrees; for a feature the tile
               holds as a Point they equal round(tile coordinate·1e6) to one
               tile unit at the max zoom (the tile quantises, the file keeps
               the input coordinate).
  input check  for point datasets, `px`/`py` equal (round(lon·1e6), round(lat·1e6)) of
               the build input's coordinate for every id, exactly (tile_inputs.py
               reads the input; memory: one {id: (px, py)} from the Parquet).
               Mismatches are counted and fail.
  --emit-reference DIR
               DIR/columns-reference.json: totals over the WHOLE Parquet with
               region lists split in Python; sorted keys.
  --mutate     a scratch copy of the Parquet with one row's region code and one
               attribute value changed; exit 0 only when the tile check catches
               both. Nothing is written to index.json.

Memory: the tile pass holds id -> 8-byte digest of the row's non-null attributes
(a dict entry is ~150-200 B), the Parquet is streamed in 100k-row batches and
matched ids are dropped from the dict as they match. osm_generators is the
largest point set; at an assumed 5M max-zoom features the dict peaks near
1 GB, osm_transmission_lines (~1.5M) near 0.3 GB. The length check holds one
{fid: float} per transmission dataset (~0.3 GB for OSM).

Usage:
  python scripts/check_columns_parquet.py                       # all 11
  python scripts/check_columns_parquet.py --only retail_territories --mutate
  python scripts/check_columns_parquet.py --emit-reference tmp/columns-ref
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASETS = (
    "osm_transmission_lines", "hifld_transmission_lines", "osm_pipelines_lines",
    "hifld_natgas_lines", "osm_substations_points", "osm_substations_polygons",
    "osm_plants_polygons", "osm_generators", "retail_territories", "padus", "crithab",
)
LINE_LENGTH = ("osm_transmission_lines", "hifld_transmission_lines")
COMPUTED = {"length_km", "area_km2", "px", "py"}
REGION_NAMES = ("countries", "admin1", "states", "counties", "ba", "nerc", "retail", "zcta")
TX_ADMIN1 = "USAB"          # Area US-TX → admin1 (STATE_TO_ADMIN1 in src/registry/region-codes.ts)
BATCH = 100_000
FEATURE_PREFIX = '{ "type": "Feature",'
NATIVE_ID_RE = re.compile(r'^\{ "type": "Feature", "id": (\d+)')


class CheckError(SystemExit):
    def __init__(self, msg):
        super().__init__(f"ERROR: {msg}")


# ── Canonical values ──────────────────────────────────────────────────────────

def norm_id(v):
    """An id as a comparable string: 303622.0 -> '303622'."""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)


def canon(v):
    """(type tag, value) of an attribute; numbers by value to 12 significant digits."""
    if isinstance(v, bool):
        return ("b", v)
    if isinstance(v, (int, float)):
        return ("n", float(f"{v:.12g}"))
    return ("s", v)


def digest(attrs):
    """8-byte digest of a dict's non-null attributes."""
    items = sorted((k, canon(v)) for k, v in attrs.items() if v is not None)
    return int.from_bytes(hashlib.blake2b(repr(items).encode(), digest_size=8).digest(), "little")


# ── Tiles ─────────────────────────────────────────────────────────────────────

def pmtiles_max_zoom(path):
    with open(path, "rb") as f:
        head = f.read(127)
    if len(head) < 127 or head[:7] != b"PMTiles" or head[7] != 3:
        raise CheckError(f"{path}: not a PMTiles v3 archive")
    return head[101]


def tile_features(lines, id_field, native):
    """(id, properties, [lon, lat] for a point feature else None) for every feature line of tippecanoe-decode output."""
    for line in lines:
        if not line.startswith(FEATURE_PREFIX):
            continue
        feat = json.loads(line.rstrip().rstrip(","))
        props = feat.get("properties") or {}
        if native:
            fid = feat.get("id")
            props.pop(id_field, None)
        else:
            fid = props.get(id_field)
        geom = feat.get("geometry") or {}
        yield fid, props, (geom["coordinates"] if geom.get("type") == "Point" else None)


def read_tiles(archive, id_field, native, lines=None):
    """({id: digest}, stats). Pieces of one feature in several tiles must agree."""
    proc = None
    if lines is None:
        zoom = pmtiles_max_zoom(archive)
        proc = subprocess.Popen(["tippecanoe-decode", "-z", str(zoom), "-Z", str(zoom), str(archive)],
                                stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
        lines = proc.stdout
    seen, points, features, no_id, disagree = {}, {}, 0, 0, []
    try:
        for fid, props, pt in tile_features(lines, id_field, native):
            features += 1
            if fid is None:
                no_id += 1
                continue
            key, d = norm_id(fid), digest(props)
            if pt is not None:
                points.setdefault(key, (pt[0], pt[1]))
            old = seen.setdefault(key, d)
            if old != d and len(disagree) < 5:
                disagree.append(key)
    except BaseException:
        if proc:
            proc.kill()
        raise
    finally:
        if proc:
            proc.stdout.close()
    if proc and proc.wait() != 0:
        raise CheckError(f"tippecanoe-decode {archive} exited {proc.returncode}")
    return seen, {"features": features, "no_id": no_id, "disagree": disagree, "points": points}


# ── Parquet ───────────────────────────────────────────────────────────────────

def parquet_path(analysis, index, ds):
    entry = (index.get("columns") or {}).get(ds)
    if not entry:
        raise CheckError(f"{ds}: no columns entry in {analysis / 'index.json'}")
    return analysis / entry.get("path", "columns/") / entry["file"]["name"], entry


def point_tolerance_udeg(zoom):
    """One 4096-unit tile step at `zoom` in micro-degrees, plus 1 for the decode's rounding."""
    return int(360e6 / (2 ** zoom * 4096)) + 2


def compare_parquet(pq_path, tiles, id_col, native, limit=1000, points=None, tol=0):
    """Stream the Parquet against {id: digest} (consumed: matched ids are removed).
    Returns the result dict; `bad` holds the ids whose attributes differ and
    `bad_point` the ids of a point feature whose px/py (int32 micro-degrees) lie
    more than `tol` micro-degrees from the tile's point (a tile holds a point to
    one tile unit; the file holds the input coordinate itself)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(pq_path)
    names = pf.schema_arrow.names
    if id_col not in names:
        raise CheckError(f"{pq_path.name}: no id column {id_col!r}")
    for c in ("px", "py"):
        if c not in names or pf.schema_arrow.field(c).type != pa.int32():
            raise CheckError(f"{pq_path.name}: {c!r} is not an int32 column")
    skip = COMPUTED | ({id_col} if native else set())
    attrs = [n for n in names if n not in skip]
    rows = matched = bad_count = 0
    bad, bad_point = [], []
    for batch in pf.iter_batches(batch_size=BATCH, columns=[id_col, "px", "py", *attrs]):
        cols = batch.to_pydict()
        ids = cols[id_col]
        rows += len(ids)
        for i, raw in enumerate(ids):
            key = norm_id(raw)
            want = tiles.pop(key, None)
            if want is None:
                continue
            matched += 1
            tp = points.get(key) if points else None
            if tp is not None and (abs(cols["px"][i] - round(tp[0] * 1e6)) > tol
                                   or abs(cols["py"][i] - round(tp[1] * 1e6)) > tol):
                bad_point.append(key)
            if digest({a: cols[a][i] for a in attrs}) != want:
                bad_count += 1
                if len(bad) < limit:
                    bad.append(key)
    return {"rows": rows, "matched": matched, "tile_only": sorted(tiles)[:5],
            "tile_only_count": len(tiles), "bad_count": bad_count, "bad": bad,
            "bad_point": bad_point}


def input_rows(ds, fixture=None):
    """Rows of the build input, as the tiles were cut from them (properties, `__id`,
    `__geometry`). Reading only: the comparison below uses the input's own coordinate."""
    import tile_inputs
    if fixture:
        base = Path(fixture) / "input"
        for n in (f"{ds}.geojsonl.gz", f"{ds}.geojsonl"):
            if (base / n).exists():
                yield from tile_inputs.stream_rows(base / n, [], geometry=True)
                return
        raise CheckError(f"{ds}: no fixture input in {base}")
    import stable_ids
    layer = next((L for L in stable_ids.load_layers(ROOT / "scripts" / "tile_manifest.yaml") if L["id"] == ds), None)
    if layer is None:
        raise CheckError(f"{ds}: not in tile_manifest.yaml")
    paths, opts, _ = tile_inputs.input_rows(layer)
    if not paths:
        raise CheckError(f"{ds}: no build input found")
    for p in paths:
        yield from tile_inputs.stream_rows(p, opts(p), geometry=True)


def compare_input_points(pq_path, rows, id_col, id_field, native, limit=1000):
    """Exact: every Parquet (px, py) equals (round(lon*1e6), round(lat*1e6)) of the input
    row with that id. Holds {id: (px, py)} from the file, then streams `rows`."""
    import pyarrow.parquet as pq
    want = {}
    for b in pq.ParquetFile(pq_path).iter_batches(batch_size=BATCH, columns=[id_col, "px", "py"]):
        d = b.to_pydict()
        want.update(zip((norm_id(k) for k in d[id_col]), zip(d["px"], d["py"])))
    checked = mismatch = 0
    bad = []
    for r in rows:
        fid = r.get(id_field)
        if native and fid is None:
            fid = r.get("__id")
        g = r.get("__geometry") or {}
        if fid is None or g.get("type") != "Point":
            continue
        got = want.get(norm_id(fid))
        if got is None:
            continue
        checked += 1
        lon, lat = g["coordinates"][:2]
        if got != (round(lon * 1e6), round(lat * 1e6)):
            mismatch += 1
            if len(bad) < limit:
                bad.append(norm_id(fid))
    return {"checked": checked, "mismatch": mismatch, "bad": bad}


def length_mismatches(analysis, index, ds, pq_path, id_col):
    """fids whose Parquet length_km differs from IDX, or that only one side has."""
    import pyarrow.parquet as pq
    m = (index.get("datasets") or {}).get(ds)
    if not m:
        raise CheckError(f"{ds}: no datasets entry in index.json for the IDX length check")
    idx_path = analysis / m.get("path", ds + "/") / m["idx"]["name"]
    idx = {}
    for b in pq.ParquetFile(idx_path).iter_batches(batch_size=BATCH, columns=["fid", "length_km"]):
        d = b.to_pydict()
        idx.update(zip((norm_id(x) for x in d["fid"]), d["length_km"]))
    bad = []
    n = 0
    for b in pq.ParquetFile(pq_path).iter_batches(batch_size=BATCH, columns=[id_col, "length_km"]):
        d = b.to_pydict()
        for raw, ln in zip(d[id_col], d["length_km"]):
            n += 1
            key = norm_id(raw)
            if key not in idx:
                bad.append(key)
            elif idx.pop(key) != ln:
                bad.append(key)
    bad += list(idx)       # IDX fids the Parquet lacks
    return len(bad), bad[:5], n


# ── Check one dataset ─────────────────────────────────────────────────────────

def check_dataset(ds, analysis, layers, index, mutate=False, manifest=None, fixture=None):
    """(ok, report line list, share record or None)."""
    pq_path, entry = parquet_path(analysis, index, ds)
    id_field, native = entry["id"]["field"], bool(entry["id"]["native"])
    if manifest is not None:
        want = manifest.get(ds)
        if want and (want[0] != id_field or want[1] != native):
            raise CheckError(f"{ds}: tile_manifest.yaml declares id {want}, index.json says {(id_field, native)}")
    id_col = "fid" if native else id_field
    archive = layers / f"{ds}.pmtiles"
    if not archive.exists():
        raise CheckError(f"{ds}: {archive} is missing")
    out = []
    tiles, st = read_tiles(archive, id_field, native)
    out.append(f"{ds}: {len(tiles)} tile ids from {st['features']} tile features")
    ok = True
    if st["no_id"]:
        ok = False
        out.append(f"  FAIL {st['no_id']} tile features carry no id")
    if st["disagree"]:
        ok = False
        out.append(f"  FAIL tile pieces of one feature disagree on attributes, e.g. ids {st['disagree']}")
    is_point = entry.get("geometry") == "point"
    inputs = (lambda: input_rows(ds, fixture)) if is_point else None
    if mutate:
        return mutation_run(ds, pq_path, tiles, id_col, native, out, st["points"],
                            point_tolerance_udeg(pmtiles_max_zoom(archive)), inputs, id_field)
    tol = point_tolerance_udeg(pmtiles_max_zoom(archive))
    res = compare_parquet(pq_path, tiles, id_col, native, points=st["points"], tol=tol)
    if inputs:
        ri = compare_input_points(pq_path, inputs(), id_col, id_field, native)
        out.append(f"  input points: {ri['checked']} compared exactly, {ri['mismatch']} mismatches")
        if ri["mismatch"]:
            ok = False
            out.append(f"  FAIL {ri['mismatch']} point ids whose px/py differ from round(input coordinate*1e6), e.g. {ri['bad'][:5]}")
    if res["bad_point"]:
        ok = False
        out.append(f"  FAIL {len(res['bad_point'])} point ids whose px/py differ from the tile point by more "
                   f"than {tol} micro-degrees, e.g. {res['bad_point'][:5]}")
    if res["tile_only_count"]:
        ok = False
        out.append(f"  FAIL {res['tile_only_count']} tile ids not in the Parquet, e.g. {res['tile_only']}")
    if res["bad_count"]:
        ok = False
        out.append(f"  FAIL {res['bad_count']} ids with differing attributes, e.g. {res['bad'][:5]}")
    only = res["rows"] - res["matched"]
    share = {"count": only, "share": round(only / res["rows"], 6) if res["rows"] else 0.0}
    out.append(f"  {res['rows']} Parquet rows, {res['matched']} matched, "
               f"{only} Parquet-only ({share['share'] * 100:.2f} %) — reported, not a failure")
    if ds in LINE_LENGTH:
        n_bad, ex, n = length_mismatches(analysis, index, ds, pq_path, id_col)
        if n_bad:
            ok = False
            out.append(f"  FAIL {n_bad} of {n} fids: Parquet length_km differs from IDX, e.g. {ex}")
        else:
            out.append(f"  length_km equals IDX for all {n} fids")
    out.append(f"  {'OK' if ok else 'FAIL'}")
    return ok, out, share


# ── Mutation ──────────────────────────────────────────────────────────────────

def mutation_run(ds, pq_path, tiles, id_col, native, out, points=None, tol=0, inputs=None, id_field=None):
    """Change one region code and one attribute value in a copy; both must be caught."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    table = pq.read_table(pq_path)
    skip = COMPUTED | {id_col}
    strs = [n for n in table.column_names if n not in skip and pa.types.is_string(table.schema.field(n).type)]
    nums = [n for n in table.column_names if n not in skip and pa.types.is_floating(table.schema.field(n).type)]
    region = next((n for n in strs if n in REGION_NAMES), None)
    region_kind = "region"
    if region is None:
        region = next((n for n in strs if n != id_col), None)
        region_kind = "string (no region field in this dataset)"
    value = nums[0] if nums else next((n for n in strs if n != region), None)
    if region is None or value is None:
        out.append("  FAIL --mutate needs a string column and a second attribute column to change")
        return False, out, None
    ids = table.column(id_col).to_pylist()
    pick = []
    for col in (region, value):
        vals = table.column(col).to_pylist()
        row = next((i for i, (k, v) in enumerate(zip(ids, vals))
                    if v is not None and norm_id(k) in tiles and i not in pick), None)
        if row is None:
            out.append(f"  FAIL --mutate found no row with a {col} value that the tiles carry")
            return False, out, None
        pick.append(row)

    def rewrite(t, col, row, new):
        arr = t.column(col).to_pylist()
        arr[row] = new
        return t.set_column(t.column_names.index(col), t.schema.field(col),
                            pa.array(arr, type=t.schema.field(col).type))

    old_region = table.column(region)[pick[0]].as_py()
    table = rewrite(table, region, pick[0], "|ZZ9|")
    old_value = table.column(value)[pick[1]].as_py()
    table = rewrite(table, value, pick[1], old_value + 1 if isinstance(old_value, (int, float)) else old_value + "~")
    keys = [norm_id(ids[r]) for r in pick]
    point_row = next((i for i, k in enumerate(ids) if norm_id(k) in (points or {})), None)
    if point_row is not None:
        table = rewrite(table, "px", point_row, table.column("px")[point_row].as_py() + 100 * tol)
    tmpdir = Path(tempfile.mkdtemp(prefix="columns-mutate-"))
    try:
        copy = tmpdir / pq_path.name
        pq.write_table(table, copy, compression="zstd")
        res = compare_parquet(copy, tiles, id_col, native, limit=10**9, points=points, tol=tol)
        res_in = (compare_input_points(copy, inputs(), id_col, id_field, native, limit=10**9)
                  if inputs and point_row is not None else None)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    caught = [k in set(res["bad"]) for k in keys]
    out.append(f"  mutated {region_kind} {region!r} of id {keys[0]} ({old_region!r} -> '|ZZ9|'): "
               f"{'caught' if caught[0] else 'MISSED'}")
    out.append(f"  mutated attribute {value!r} of id {keys[1]}: {'caught' if caught[1] else 'MISSED'}")
    if point_row is not None:
        key = norm_id(ids[point_row])
        by_tile = key in set(res["bad_point"])
        by_input = None if inputs is None else key in set(res_in["bad"])
        hit = by_tile and by_input is not False
        caught.append(hit)
        out.append(f"  moved px of point id {key} by {100 * tol} micro-degrees: "
                   f"{'caught' if hit else 'MISSED'} (tile comparison: {'caught' if by_tile else 'MISSED'}; "
                   f"input comparison: {'not run' if by_input is None else 'caught' if by_input else 'MISSED'})")
    ok = all(caught)
    out.append(f"  {'OK' if ok else 'FAIL'}: --mutate {'caught both' if ok else 'missed a change'}")
    return ok, out, None


# ── Reference totals ──────────────────────────────────────────────────────────

def split_region(v):
    """'|A|B|' -> ['A', 'B']; null or empty -> ['none']."""
    codes = [c for c in (v or "").split("|") if c]
    return codes or ["none"]


def _numeric(pq_path, col):
    import pyarrow as pa
    import pyarrow.parquet as pq
    t = pq.ParquetFile(pq_path).schema_arrow
    if col not in t.names:
        raise CheckError(f"{pq_path.name}: no column {col!r}")
    if not (pa.types.is_floating(t.field(col).type) or pa.types.is_integer(t.field(col).type)):
        raise CheckError(f"{pq_path.name}: {col!r} is {t.field(col).type}, not a number")


def _fold(groups):
    return {k: {"count": len(v), "sum": math.fsum(v)} for k, v in sorted(groups.items())}


def group_totals(pq_path, key_col, sum_col, split=False, only=None):
    """{key: [sum values]} over the whole file; `only` keeps rows whose split
    key_col contains that code. Rows with a null sum count with 0."""
    import pyarrow.parquet as pq
    groups = {}
    cols = [key_col] if sum_col == key_col else [key_col, sum_col]
    for b in pq.ParquetFile(pq_path).iter_batches(batch_size=BATCH, columns=cols):
        d = b.to_pydict()
        for k, s in zip(d[key_col], d[sum_col]):
            keys = split_region(k) if split else [k if k is not None else "none"]
            if only is not None and only not in keys:
                continue
            for key in keys:
                groups.setdefault(key, []).append(0.0 if s is None else float(s))
    return groups


def emit_reference(wanted, analysis, index, outdir):
    ref = {}
    for ds in ("osm_transmission_lines", "padus", "retail_territories"):
        if ds not in wanted:
            continue
        p, _ = parquet_path(analysis, index, ds)
        if ds == "osm_transmission_lines":
            _numeric(p, "length_km")
            ref[ds] = {
                "admin1_all": _fold(group_totals(p, "admin1", "length_km", split=True)),
                "admin1_US-TX": _fold(group_totals(p, "admin1", "length_km", split=True, only=TX_ADMIN1)),
                "area_US-TX_admin1_code": TX_ADMIN1,
                "sum_field": "length_km",
            }
        elif ds == "padus":
            _numeric(p, "acres")
            ref[ds] = {"by_state": _fold(group_totals(p, "state", "acres")), "sum_field": "acres"}
        else:
            _numeric(p, "customers")
            ref[ds] = {"by_type": _fold(group_totals(p, "type", "customers")), "sum_field": "customers"}
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / "columns-reference.json"
    path.write_text(json.dumps(ref, indent=1, sort_keys=True) + "\n")
    return path


# ── index.json, manifest ──────────────────────────────────────────────────────

def load_index(analysis):
    path = analysis / "index.json"
    try:
        index = json.loads(path.read_text())
    except (OSError, ValueError) as err:
        raise CheckError(f"{path}: {err}")
    if not isinstance(index, dict):
        raise CheckError(f"{path} is not a JSON object")
    return index


def write_shares(analysis, shares):
    """Add tiles_missing to the columns entries; everything else stays as read."""
    index = load_index(analysis)
    for ds, share in shares.items():
        index["columns"][ds]["tiles_missing"] = share
    path = analysis / "index.json"
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(part, path)


def manifest_ids(path):
    """{layer id: (id_field, native)} from tile_manifest.yaml; None without PyYAML."""
    try:
        import yaml
    except ImportError:
        return None
    doc = yaml.safe_load(Path(path).read_text())
    return {L["id"]: (L["id_field"], bool(L.get("native_id")))
            for L in doc["layers"] + (doc.get("built_elsewhere") or []) if L.get("id_field")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", action="append", choices=DATASETS, help="one dataset (repeatable)")
    ap.add_argument("--emit-reference", metavar="DIR", help="write DIR/columns-reference.json and stop")
    ap.add_argument("--mutate", action="store_true", help="change a copy; exit 0 only if both changes are caught")
    ap.add_argument("--fixture", metavar="DIR", help="read point input from DIR/input/<ds>.geojsonl[.gz] (tests)")
    ap.add_argument("--analysis-dir", default=str(ROOT / "data" / "analysis"))
    ap.add_argument("--layers-dir", default=str(ROOT / "data" / "layers"))
    ap.add_argument("--manifest", default=str(ROOT / "scripts" / "tile_manifest.yaml"),
                    help="tile_manifest.yaml to hold index.json's id declarations to ('' skips)")
    args = ap.parse_args(argv)
    analysis, layers = Path(args.analysis_dir), Path(args.layers_dir)
    wanted = args.only or DATASETS
    index = load_index(analysis)
    if args.emit_reference:
        print(f"✓ {emit_reference(wanted, analysis, index, args.emit_reference)}")
        return 0
    manifest = manifest_ids(args.manifest) if args.manifest else None
    results, shares = [], {}
    for ds in wanted:
        ok, lines, share = check_dataset(ds, analysis, layers, index, args.mutate, manifest, args.fixture)
        print("\n".join(lines), flush=True)
        results.append(ok)
        if share is not None and ok:
            shares[ds] = share
    if shares and not args.mutate:
        write_shares(analysis, shares)
        print(f"tiles_missing written to {analysis / 'index.json'} for {len(shares)} dataset(s)")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
