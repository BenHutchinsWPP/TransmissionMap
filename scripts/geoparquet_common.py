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
import hashlib
import json
import math
import os
from pathlib import Path

R_KM = 6371.0088          # mean Earth radius; the same sphere as assets/sandbox/geo-kit.ts
HILBERT_ORDER = 16        # 65,536 cells a side: ~600 m at the equator
PART_TARGET_BYTES = 64 * 2**20
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
              "max_rows_per_page": 256, "write_batch_size": 256}
CHAINS_PRESET = {"row_group_size": 4096, "write_page_index": False, "write_statistics": ["chain"]}
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


# ── Writing ───────────────────────────────────────────────────────────────────

def dictionary_columns(schema):
    """String columns that may take a dictionary: strings outside NO_DICTIONARY."""
    import pyarrow as pa
    return [f.name for f in schema
            if f.name not in NO_DICTIONARY and (pa.types.is_string(f.type) or pa.types.is_large_string(f.type))]


def statistics_columns(schema):
    """`fid`, numeric and bbox leaf columns: the ones a reader prunes on."""
    import pyarrow as pa
    out = []
    for f in schema:
        if f.name == "bbox":
            out += [f"bbox.{k}" for k in BBOX_FIELDS]
        elif f.name == "fid" or pa.types.is_integer(f.type) or pa.types.is_floating(f.type) \
                or pa.types.is_boolean(f.type):
            out.append(f.name)
    return out


def write_parquet(table, path, preset, metadata=None, sort_columns=()):
    """Write one file with a preset; `metadata` (str → str) joins the schema's.

    Asserts the dictionary rule on the written file (footgun 1).
    """
    import pyarrow.parquet as pq
    if metadata:
        merged = dict(table.schema.metadata or {})
        merged.update({k.encode(): v.encode() for k, v in metadata.items()})
        table = table.replace_schema_metadata(merged)
    kw = dict(COMPRESSION, **preset)
    kw["use_dictionary"] = dictionary_columns(table.schema) or False
    kw.setdefault("write_statistics", statistics_columns(table.schema) or False)
    if sort_columns:
        kw["sorting_columns"] = [pq.SortingColumn(table.schema.get_field_index(c))
                                 for c in sort_columns]
    pq.write_table(table, str(path), **kw)
    bad = dictionary_encoded(path) & _no_dictionary_leaves(table.schema)
    if bad:
        raise AssertionError(f"{path}: dictionary page on unique column(s) {sorted(bad)}")


def _no_dictionary_leaves(schema):
    """Leaf column paths of the NO_DICTIONARY columns present in a schema."""
    out = set()
    for f in schema:
        if f.name == "bbox":
            out |= {f"bbox.{k}" for k in BBOX_FIELDS}
        elif f.name in NO_DICTIONARY:
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


# ── Consistency of a built data/analysis/ tree (validate_build.py) ────────────

def check_analysis(root):
    """Problems with a built data/analysis/ tree, as messages; [] when clean or absent.

    Every file a manifest names exists with its bytes, sha256 and footer length,
    stays under the 95 MiB stop and carries the manifest's build_id; GEO parts
    tile the rows without a gap; nothing else sits in a dataset directory.
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
    return problems
