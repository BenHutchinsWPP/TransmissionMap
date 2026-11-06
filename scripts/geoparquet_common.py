"""geoparquet_common.py — shared pieces of the line geometry Parquet build.

Used by build_line_parquet.py (docs/pipeline.md § Line geometry). The layout
rules are:

  * IDX    — 4k-row groups, no page index, sorted by `fid`.
  * GEO    — 64k-row groups, 256-row pages (`max_rows_per_page` and
             `write_batch_size` both), page index on, Hilbert order.
  * CHAINS — 4k-row groups, no page index, sorted by `chain`, `seq`.
  * ZSTD 9 everywhere; dictionary encoding on string columns that repeat only,
    never on `fid`, `row`, a measure, `bbox` or `geometry` — a dictionary on a
    unique column turns a one-line read into a ~1 MB read.
  * Statistics on `fid`, numeric and `bbox` columns only; the readers prune on
    them, and statistics on WKB would only bloat the footer.

Only the standard library is imported at module level, so `make
test-pipeline` can import this under `python3 -S`; numpy and pyarrow load
inside the functions that need them.
"""
import gzip
import hashlib
import json
import math
import os
from pathlib import Path

R_KM = 6371.0088          # mean Earth radius; the same sphere as assets/sandbox/geo-kit.ts
HILBERT_ORDER = 16        # 65,536 cells a side: ~600 m at the equator
PART_TARGET_BYTES = 64 * 2**20
GEO_GROUP_BYTES = 16 * 2**20   # a GEO row group closes before WKB bytes pass this (one larger row is its own group)
PART_HARD_BYTES = 95 * 2**20   # below the host's 100 MiB per-file limit
GEOPARQUET_VERSION = "1.1.0"
BBOX_FIELDS = ("xmin", "ymin", "xmax", "ymax")

# Writer presets (pyarrow.parquet.write_table keywords). `use_dictionary` is
# filled per table by write_parquet(), and so is `write_statistics` unless the
# preset names its columns: IDX and CHAINS are read by their sort key alone, and
# statistics on every column of ~330 row groups would add ~50 KB to a footer
# every cold lookup downloads.
IDX_PRESET = {"row_group_size": 4096, "write_page_index": False, "write_statistics": ["fid"]}
GEO_PRESET = {"row_group_size": 65536, "write_page_index": True,
              "max_rows_per_page": 256, "data_page_size": 2**20, "write_batch_size": 16}
CHAINS_PRESET = {"row_group_size": 4096, "write_page_index": False, "write_statistics": ["chain"]}
# COLUMNS: the attribute-only files of tiled datasets (columns/<ds>.<sha8>.parquet);
# statistics on every numeric column (and an integer `fid`), no page index.
COLUMNS_PRESET = {"row_group_size": 65536, "write_page_index": False}
COMPRESSION = {"compression": "zstd", "compression_level": 9}

# Columns that are unique (or near enough) per row: never dictionary-encoded.
NO_DICTIONARY = {"fid", "row", "geometry", "bbox", "length_km", "chain", "seq",
                 "start_sub", "end_sub"}


# ── Geometry helpers (numpy) ──────────────────────────────────────────────────

def hilbert_key(x, y, order=HILBERT_ORDER):
    """Hilbert index of lon/lat arrays on a 2^order grid over the whole globe."""
    import numpy as np
    n = 1 << order
    ix = np.clip(np.floor((np.asarray(x, dtype=float) + 180) / 360 * n), 0, n - 1).astype(np.uint64)
    iy = np.clip(np.floor((np.asarray(y, dtype=float) + 90) / 180 * n), 0, n - 1).astype(np.uint64)
    d = np.zeros(len(ix), dtype=np.uint64)
    s = n >> 1
    while s > 0:
        us = np.uint64(s)
        rx = ((ix & us) > 0).astype(np.uint64)
        ry = ((iy & us) > 0).astype(np.uint64)
        d += us * us * ((np.uint64(3) * rx) ^ ry)
        low = ry == 0
        flip = low & (rx == 1)
        ix = np.where(flip, np.uint64(n - 1) - ix, ix)
        iy = np.where(flip, np.uint64(n - 1) - iy, iy)
        ix, iy = np.where(low, iy, ix), np.where(low, ix, iy)
        s >>= 1
    return d


def f32_outward(lo, hi):
    """float64 bounds as float32, rounded outward so the box still covers."""
    import numpy as np
    lo, hi = np.asarray(lo, dtype=np.float64), np.asarray(hi, dtype=np.float64)
    lo32, hi32 = lo.astype(np.float32), hi.astype(np.float32)
    lo32 = np.where(lo32.astype(np.float64) > lo, np.nextafter(lo32, np.float32(-np.inf)), lo32)
    hi32 = np.where(hi32.astype(np.float64) < hi, np.nextafter(hi32, np.float32(np.inf)), hi32)
    return lo32.astype(np.float32), hi32.astype(np.float32)


def bbox_array(bounds):
    """An (n, 4) xmin/ymin/xmax/ymax array → the GeoParquet `bbox` struct column."""
    import pyarrow as pa
    x0, x1 = f32_outward(bounds[:, 0], bounds[:, 2])
    y0, y1 = f32_outward(bounds[:, 1], bounds[:, 3])
    return pa.StructArray.from_arrays([pa.array(v) for v in (x0, y0, x1, y1)],
                                      names=list(BBOX_FIELDS))


def line_lengths_km(geoms):
    """Great-circle length of each (Multi)LineString: the haversine sum per part."""
    import numpy as np
    import shapely
    parts, pidx = shapely.get_parts(geoms, return_index=True)
    xy, vidx = shapely.get_coordinates(parts, return_index=True)
    lon, lat = np.radians(xy[:, 0]), np.radians(xy[:, 1])
    same = vidx[1:] == vidx[:-1]
    dlat, dlon = lat[1:] - lat[:-1], lon[1:] - lon[:-1]
    a = np.sin(dlat / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(dlon / 2) ** 2
    seg = 2 * R_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1))) * same
    per_part = np.bincount(vidx[:-1], weights=seg, minlength=len(parts))
    return np.bincount(pidx, weights=per_part, minlength=len(geoms))


def geo_metadata(geometry_types, bbox=None):
    """The GeoParquet 1.1 `geo` key: WKB, CRS84 (the default), bbox covering."""
    col = {"encoding": "WKB", "geometry_types": sorted(geometry_types),
           "covering": {"bbox": {k: ["bbox", k] for k in BBOX_FIELDS}}}
    if bbox is not None:
        col["bbox"] = [float(v) for v in bbox]
    return {"version": GEOPARQUET_VERSION, "primary_column": "geometry",
            "columns": {"geometry": col}}


def _rings(geom):
    """Polygon rings of a shapely (Multi)Polygon as (is_hole, [(x, y)]) lists."""
    gj = geom.__geo_interface__
    polys = gj["coordinates"] if gj["type"] == "MultiPolygon" else \
        [gj["coordinates"]] if gj["type"] == "Polygon" else []
    return [(i > 0, ring) for poly in polys for i, ring in enumerate(poly)]


def sphere_area_km2(geom):
    """Area of a shapely (Multi)Polygon on the sphere, km², holes subtracted.

    The formula of `ringAreaKm2` in assets/sandbox/geo-kit.ts; 0 for any other type.
    """
    rad = math.pi / 180
    total = 0.0
    for hole, ring in _rings(geom):
        s = 0.0
        for i, p in enumerate(ring):
            q = ring[(i + 1) % len(ring)]
            s += (q[0] - p[0]) * rad * (2 + math.sin(p[1] * rad) + math.sin(q[1] * rad))
        a = abs(s * R_KM * R_KM / 2)
        total += -a if hole else a
    return total


def _haversine_km(p, q):
    la1, la2 = math.radians(p[1]), math.radians(q[1])
    a = math.sin((la2 - la1) / 2) ** 2 + \
        math.cos(la1) * math.cos(la2) * math.sin(math.radians(q[0] - p[0]) / 2) ** 2
    return 2 * R_KM * math.asin(math.sqrt(min(1.0, a)))


def point_on_feature(geom):
    """(x, y) on a shapely geometry: a point itself, a line's midpoint along
    its total length (parts in order), a polygon's `point_on_surface`."""
    gj = geom.__geo_interface__
    t = gj["type"]
    if t == "Point":
        return tuple(gj["coordinates"][:2])
    if t in ("LineString", "MultiLineString"):
        parts = [gj["coordinates"]] if t == "LineString" else gj["coordinates"]
        segs = [(p, q) for part in parts for p, q in zip(part, part[1:])]
        lens = [_haversine_km(p, q) for p, q in segs]
        half = sum(lens) / 2
        for (p, q), n in zip(segs, lens):
            if half <= n and n > 0:
                f = half / n
                return (p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)
            half -= n
        return tuple(segs[-1][1][:2]) if segs else tuple(parts[0][0][:2])
    pt = geom.point_on_surface()
    return (pt.x, pt.y)


# ── Writing ───────────────────────────────────────────────────────────────────

def dictionary_columns(schema, no_dictionary=()):
    """String columns that may take a dictionary: strings outside NO_DICTIONARY and `no_dictionary`."""
    import pyarrow as pa
    skip = NO_DICTIONARY | set(no_dictionary)
    return [f.name for f in schema
            if f.name not in skip and (pa.types.is_string(f.type) or pa.types.is_large_string(f.type))]


def statistics_columns(schema):
    """Numeric (an integer `fid` included; a string id gets none) and bbox leaf columns."""
    import pyarrow as pa
    out = []
    for f in schema:
        if f.name == "bbox":
            out += [f"bbox.{k}" for k in BBOX_FIELDS]
        elif pa.types.is_integer(f.type) or pa.types.is_floating(f.type) \
                or pa.types.is_boolean(f.type):
            out.append(f.name)
    return out


def geo_group_rows(table, max_rows=None, max_bytes=None):
    """Row counts of the GEO row groups: at most `max_rows` (the preset's) rows, and
    a group closes before a row would take its WKB bytes past `max_bytes`; a row
    larger than that is a group of its own."""
    import pyarrow.compute as pc
    max_rows = max_rows or GEO_PRESET["row_group_size"]
    max_bytes = max_bytes or GEO_GROUP_BYTES
    sizes = pc.fill_null(pc.binary_length(table.column("geometry")), 0).to_numpy()
    out, n, acc = [], 0, 0
    for sz in sizes.tolist():
        if n and (n >= max_rows or acc + sz > max_bytes):
            out.append(n)
            n = acc = 0
        n += 1
        acc += sz
    if n:
        out.append(n)
    return out


def write_parquet(table, path, preset, metadata=None, sort_columns=(), no_dictionary=(), group_rows=None):
    """Write one file with a preset; `metadata` (str → str) joins the schema's.

    `no_dictionary` names further columns that never take a dictionary.

    Asserts the dictionary rule on the written file (footgun 1).
    """
    import pyarrow.parquet as pq
    if metadata:
        merged = dict(table.schema.metadata or {})
        merged.update({k.encode(): v.encode() for k, v in metadata.items()})
        table = table.replace_schema_metadata(merged)
    kw = dict(COMPRESSION, **preset)
    kw["use_dictionary"] = dictionary_columns(table.schema, no_dictionary) or False
    kw.setdefault("write_statistics", statistics_columns(table.schema) or False)
    if sort_columns:
        kw["sorting_columns"] = [pq.SortingColumn(table.schema.get_field_index(c))
                                 for c in sort_columns]
    if group_rows is None:
        pq.write_table(table, str(path), **kw)
    else:
        kw.pop("row_group_size", None)
        with pq.ParquetWriter(str(path), table.schema, **kw) as w:
            at = 0
            for n in group_rows:
                w.write_table(table.slice(at, n), row_group_size=n)
                at += n
    bad = dictionary_encoded(path) & _no_dictionary_leaves(table.schema, no_dictionary)
    if bad:
        raise AssertionError(f"{path}: dictionary page on unique column(s) {sorted(bad)}")


def _no_dictionary_leaves(schema, extra=()):
    """Leaf column paths of the NO_DICTIONARY (and `extra`) columns present in a schema."""
    skip = NO_DICTIONARY | set(extra)
    out = set()
    for f in schema:
        if f.name == "bbox":
            out |= {f"bbox.{k}" for k in BBOX_FIELDS}
        elif f.name in skip:
            out.add(f.name)
    return out


def dictionary_encoded(path):
    """Leaf column paths that carry a dictionary page in any row group."""
    import pyarrow.parquet as pq
    md = pq.ParquetFile(str(path)).metadata
    out = set()
    for i in range(md.num_row_groups):
        rg = md.row_group(i)
        for j in range(rg.num_columns):
            c = rg.column(j)
            if c.has_dictionary_page or any("DICTIONARY" in e for e in c.encodings):
                out.add(c.path_in_schema)
    return out


def row_group_bytes(path):
    """Compressed bytes of each row group of a written file."""
    import pyarrow.parquet as pq
    md = pq.ParquetFile(str(path)).metadata
    return [sum(md.row_group(i).column(j).total_compressed_size
                for j in range(md.row_group(i).num_columns))
            for i in range(md.num_row_groups)]


# ── Parts planner (stdlib) ────────────────────────────────────────────────────

def plan_parts(group_bytes, target=PART_TARGET_BYTES, hard=PART_HARD_BYTES):
    """Cut a run of row groups into parts of about `target` bytes.

    `group_bytes` are the compressed sizes of consecutive row groups in one
    trial file. Parts end on group boundaries; the count is ceil(total /
    target) and each cut sits at the boundary nearest an even split. Returns
    [(first_group, end_group)] half-open; raises when a part would pass `hard`.
    """
    sizes = list(group_bytes)
    if not sizes:
        return []
    total = sum(sizes)
    k = max(1, math.ceil(total / target))
    cum = [0]
    for s in sizes:
        cum.append(cum[-1] + s)
    cuts = [0]
    for i in range(1, k):
        want = total * i / k
        best = min(range(cuts[-1] + 1, len(sizes)), key=lambda b: abs(cum[b] - want),
                   default=None)
        if best is None:
            break
        cuts.append(best)
    cuts.append(len(sizes))
    cuts = sorted(set(cuts))
    parts = list(zip(cuts[:-1], cuts[1:]))
    for a, b in parts:
        if cum[b] - cum[a] > hard:
            raise ValueError(f"part of groups {a}-{b} is {cum[b] - cum[a]} bytes, over {hard}")
    return parts


# ── File facts and manifests (stdlib) ─────────────────────────────────────────

def footer_len(path):
    """Length of a Parquet footer (the 4 bytes before the trailing PAR1)."""
    with open(path, "rb") as f:
        f.seek(-8, os.SEEK_END)
        tail = f.read(8)
    if tail[4:] != b"PAR1":
        raise ValueError(f"{path}: not a Parquet file")
    return int.from_bytes(tail[:4], "little")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def content_name(path, stem, suffix=".parquet"):
    """Rename a written file to `<stem>.<sha8><suffix>`; returns (new path, sha256)."""
    path = Path(path)
    digest = sha256_file(path)
    dest = path.with_name(f"{stem}.{digest[:8]}{suffix}")
    path.replace(dest)
    return dest, digest


def file_entry(path, role, rows, digest=None, **extra):
    """One manifest `files` row: what a reader needs to skip a HEAD request."""
    path = Path(path)
    entry = {"role": role, "name": path.name, "bytes": path.stat().st_size,
             "sha256": digest or sha256_file(path), "footer_len": footer_len(path),
             "rows": int(rows)}
    entry.update(extra)
    return entry


def write_json(path, obj):
    """Write JSON beside its destination and rename, so readers never see half."""
    path = Path(path)
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    part.replace(path)


def pmtiles_fields(path, layer):
    """`vector_layers[layer].fields` of a PMTiles v3 archive's metadata (stdlib).

    Reads the 127-byte header, then the metadata block it points at.
    """
    with open(path, "rb") as f:
        head = f.read(127)
        if head[:7] != b"PMTiles" or head[7] != 3 or len(head) < 127:
            raise ValueError(f"{path}: not a PMTiles v3 archive")
        off, length = int.from_bytes(head[24:32], "little"), int.from_bytes(head[32:40], "little")
        compression = head[97]
        f.seek(off)
        raw = f.read(length)
    if compression == 2:
        raw = gzip.decompress(raw)
    elif compression != 1:
        raise ValueError(f"{path}: internal compression {compression} is not supported")
    for vl in json.loads(raw.decode("utf-8")).get("vector_layers", []):
        if vl.get("id") == layer:
            return dict(vl.get("fields", {}))
    raise KeyError(f"{path}: no vector layer {layer!r}")


# ── Consistency of a built data/analysis/ tree (validate_build.py) ────────────

def check_analysis(root, layers_dir=None):
    """Problems with a built data/analysis/ tree, as messages; [] when clean or absent.

    Every file a manifest names exists with its bytes, sha256 and footer length,
    stays under the 95 MiB stop and carries the manifest's build_id; GEO parts
    tile the rows without a gap; nothing else sits in a dataset directory.
    The `columns` section is held to the same rules: each file, its footer and
    build_id, no orphan in columns/, and (given `layers_dir`) `archive_sha256`
    equal to the sha256 of `<layers_dir>/<ds>.pmtiles`.
    """
    root = Path(root)
    index_path = root / "index.json"
    if not index_path.exists():
        return []
    try:
        import pyarrow.parquet as pq
    except ImportError:
        pq = None
    problems = []
    index = json.loads(index_path.read_text(encoding="utf-8"))
    for ds, m in sorted(index.get("datasets", {}).items()):
        d = root / m.get("path", ds + "/")
        entries = [m["idx"], *m["geo"], *([m["chains"]] if m.get("chains") else [])]
        for e in entries:
            p = d / e["name"]
            if not p.exists():
                problems.append(f"{ds}: {e['name']} missing")
                continue
            size = p.stat().st_size
            if size != e["bytes"]:
                problems.append(f"{ds}: {e['name']} is {size} bytes, manifest says {e['bytes']}")
            if size > PART_HARD_BYTES:
                problems.append(f"{ds}: {e['name']} is over the 95 MiB stop")
            if sha256_file(p) != e["sha256"]:
                problems.append(f"{ds}: {e['name']} sha256 differs from the manifest")
            if e["sha256"][:8] not in p.name:
                problems.append(f"{ds}: {e['name']} is not named by its content hash")
            try:
                if footer_len(p) != e["footer_len"]:
                    problems.append(f"{ds}: {e['name']} footer length differs from the manifest")
                if pq is not None:
                    meta = pq.read_schema(p).metadata or {}
                    if meta.get(b"build_id", b"").decode() != m["build_id"]:
                        problems.append(f"{ds}: {e['name']} build_id differs from the manifest")
            except Exception as err:  # a truncated or foreign file: report, keep checking
                problems.append(f"{ds}: {e['name']} unreadable as Parquet ({err.__class__.__name__})")
        offset = 0
        for e in m["geo"]:
            if e.get("row_offset") != offset:
                problems.append(f"{ds}: GEO part {e['name']} starts at row {e.get('row_offset')}, "
                                f"expected {offset}")
            offset += e["rows"]
        if offset != m["rows"] or m["idx"]["rows"] != m["rows"]:
            problems.append(f"{ds}: GEO holds {offset} rows and IDX {m['idx']['rows']}, "
                            f"manifest says {m['rows']}")
        own = d / "_manifest.json"
        if not own.exists() or json.loads(own.read_text(encoding="utf-8")).get("build_id") != m["build_id"]:
            problems.append(f"{ds}: _manifest.json missing or from another build")
        if d.exists():
            names = {e["name"] for e in entries} | {"_manifest.json"}
            for f in sorted(d.iterdir()):
                if f.name not in names:
                    problems.append(f"{ds}: {f.name} is not in the manifest (orphan)")
    cols = index.get("columns", {})
    for ds, m in sorted(cols.items()):
        d = root / m.get("path", "columns/")
        e = m["file"]
        p = d / e["name"]
        if not p.exists():
            problems.append(f"{ds}: columns file {e['name']} missing")
        else:
            size = p.stat().st_size
            if size != e["bytes"]:
                problems.append(f"{ds}: {e['name']} is {size} bytes, manifest says {e['bytes']}")
            if size > PART_HARD_BYTES:
                problems.append(f"{ds}: {e['name']} is over the 95 MiB stop")
            if sha256_file(p) != e["sha256"]:
                problems.append(f"{ds}: {e['name']} sha256 differs from the manifest")
            if e["sha256"][:8] not in p.name:
                problems.append(f"{ds}: {e['name']} is not named by its content hash")
            try:
                if footer_len(p) != e["footer_len"]:
                    problems.append(f"{ds}: {e['name']} footer length differs from the manifest")
                if pq is not None:
                    meta = pq.read_schema(p).metadata or {}
                    if meta.get(b"build_id", b"").decode() != m["build_id"]:
                        problems.append(f"{ds}: {e['name']} build_id differs from the manifest")
            except Exception as err:
                problems.append(f"{ds}: {e['name']} unreadable as Parquet ({err.__class__.__name__})")
        if layers_dir is not None:
            archive = Path(layers_dir) / f"{ds}.pmtiles"
            if not archive.exists():
                problems.append(f"{ds}: archive {archive.name} missing in {layers_dir}")
            elif sha256_file(archive) != m.get("archive_sha256"):
                problems.append(f"{ds}: archive_sha256 differs from {archive.name}")
    cdir = root / "columns"
    if cols and cdir.exists():
        names = {m["file"]["name"] for m in cols.values()}
        for f in sorted(cdir.iterdir()):
            if f.name not in names:
                problems.append(f"columns: {f.name} is not in the manifest (orphan)")
    return problems
