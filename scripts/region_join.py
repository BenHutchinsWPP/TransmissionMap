#!/usr/bin/env python3
"""
region_join.py — Region tags for the pipeline's vector datasets.

Every tagged feature carries `|a|b|` strings (`|none|` for no region) in the
fields of its scope: `global` (countries, admin1; inside the US also counties,
ba, nerc, retail) or `usa` (states, counties, ba, nerc, retail). Wrapping every
value, points included, lets one `contains` filter match any field without the
`USA1`/`USA10` prefix trap. See docs/pipeline.md § Region tags.

The module top imports stdlib only, so `make test-pipeline` can import it
without geo libraries: the value codec, the committed admin-1 short-code table,
the `REGION_STATS` log format, retail ID disambiguation, the boundary file
registry, and the GeoPackage helpers (in-place attribute updates through
sqlite3, and a row-dump hash for re-run equality).

The join imports shapely, numpy and pyogrio inside its functions. It builds an
STRtree over the features and queries it with the prepared boundary polygons,
which are loaded once per process. Points take every region they intersect
(a point on a border gets both); lines and polygons drop a region they only
touch. `tag_file` rewrites a CSV (lon/lat), GeoJSON or GeoJSONSeq (`.gz` too)
with region columns appended, and a GeoPackage in place through sqlite3.

    venv/bin/python scripts/region_join.py tag --scope usa data/build/hifld_natgas_lines.gpkg
    venv/bin/python scripts/region_join.py tag --scope global data/build/datacenter_osm.csv --out x.csv
    python3 scripts/region_join.py hash data/build/padus.gpkg
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FIELDS_GLOBAL = ("countries", "admin1")
FIELDS_US_EXTRA = ("counties", "ba", "nerc", "retail")
FIELDS_USA = ("states", "counties", "ba", "nerc", "retail")
REGION_FIELDS = tuple(dict.fromkeys(FIELDS_GLOBAL + FIELDS_US_EXTRA + FIELDS_USA + ("zcta",)))
SCOPES = {"usa": FIELDS_USA, "global": FIELDS_GLOBAL + FIELDS_US_EXTRA}
CHUNK = 250_000
# Geometries with more vertices than this are queried against a tree of the
# boundary parts instead: testing a prepared boundary against them leaves GEOS
# memory behind per pair (the largest PAD-US units held ~7 GB).
GIANT = 20_000

NONE = "|none|"
CODE_RE = re.compile(r"^[^|\s]+$")

ADMIN1_TABLE = ROOT / "scripts" / "admin1_codes.csv"
ADMIN1_COLUMNS = ("code", "shapeID", "iso3", "name", "current")

# field -> (boundary file, key column, make target that builds it)
_BUILD = ROOT / "data" / "build"
BOUNDARIES = {
    "countries": (_BUILD / "countries.gpkg", "iso_a3", "world-boundaries"),
    "admin1": (_BUILD / "admin1_boundaries.gpkg", "code", "world-boundaries"),
    "states": (_BUILD / "us_states.gpkg", "stusps", "census-boundaries"),
    "counties": (_BUILD / "county_boundaries.geojson", "GEOID", "boundaries"),
    "ba": (_BUILD / "eia_ba.gpkg", "abbrev", "pipeline"),
    "nerc": (_BUILD / "nerc_regions.gpkg", "code", "regions"),
    "retail": (_BUILD / "retail_territories.gpkg", "id", "regions"),
}


def encode(codes):
    """Codes -> `|a|b|`, sorted and deduplicated; no codes -> `|none|`."""
    out = sorted(set(codes))
    for c in out:
        if not CODE_RE.fullmatch(c) or c == "none":
            raise ValueError(f"bad region code: {c!r}")
    return "|" + "|".join(out) + "|" if out else NONE


def decode(value):
    """`|a|b|` -> ['a', 'b']; `|none|` -> []."""
    if value == NONE:
        return []
    if not (value.startswith("|") and value.endswith("|")) or len(value) < 3:
        raise ValueError(f"not a region value: {value!r}")
    codes = value[1:-1].split("|")
    if any(not CODE_RE.fullmatch(c) or c == "none" for c in codes):
        raise ValueError(f"not a region value: {value!r}")
    return codes


def prefer(source, joined):
    """A non-blank source value, wrapped `|x|`; otherwise the spatial join."""
    if source is None or not str(source).strip():
        return joined
    return encode([str(source).strip()])


def to_base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while True:
        n, r = divmod(n, 36)
        s = digits[r] + s
        if not n:
            return s


def assign_admin1_codes(existing, current):
    """Merge the committed code table with this build's units.

    existing: rows of the table (dicts keyed by ADMIN1_COLUMNS, `current` "0"/"1").
    current: (shapeID, iso3, name) of every unit in the build.
    A known shapeID keeps its code; a new one takes the country's next unused
    ordinal (shapeIDs sorted); a vanished one stays with current="0" and its
    code is never reused. Returns the full table, sorted by country and ordinal.
    """
    rows = {r["shapeID"]: dict(r, current="0") for r in existing}
    used = {}
    for r in rows.values():
        used.setdefault(r["iso3"], set()).add(r["code"])
    for shape_id, iso3, name in sorted(current, key=lambda c: (c[1], c[0])):
        if shape_id in rows:
            rows[shape_id].update(current="1", iso3=iso3, name=name)
            continue
        taken = used.setdefault(iso3, set())
        n = 0
        while iso3 + to_base36(n).upper() in taken:
            n += 1
        code = iso3 + to_base36(n).upper()
        if len(code) > 5:
            raise ValueError(f"admin1 code too long: {code}")
        taken.add(code)
        rows[shape_id] = dict(code=code, shapeID=shape_id, iso3=iso3, name=name, current="1")
    return sorted(rows.values(), key=lambda r: (r["iso3"], len(r["code"]), r["code"]))


def read_admin1_table(path=ADMIN1_TABLE):
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_admin1_table(rows, path=ADMIN1_TABLE):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ADMIN1_COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def stats_lines(label, field_values):
    """One `REGION_STATS <label> <field> n=… absent=… none=… multi=… maxlen=…` per field.

    field_values: {field: [value or None, …]}, one entry per feature.
    """
    lines = []
    for field, values in field_values.items():
        absent = sum(v is None or v == "" for v in values)
        none = sum(v == NONE for v in values)
        multi = sum(v not in (None, "", NONE) and v.count("|") > 2 for v in values)
        maxlen = max((len(v) for v in values if v), default=0)
        lines.append(
            f"REGION_STATS {label} {field} n={len(values)} absent={absent} "
            f"none={none} multi={multi} maxlen={maxlen}"
        )
    return lines


def retail_ids(rows):
    """Unique retail IDs from (ID, WKB) pairs, in input order.

    Within a group of equal IDs, rows sort by sha1(WKB); the first keeps the ID
    and the k-th (k >= 2) becomes `<ID>_<k>`. A no-op when the IDs are unique.
    """
    ids = [str(i) for i, _ in rows]
    groups = {}
    for idx, i in enumerate(ids):
        groups.setdefault(i, []).append(idx)
    for i, idxs in groups.items():
        encode([i])
        if len(idxs) > 1:
            idxs.sort(key=lambda x: hashlib.sha1(rows[x][1]).hexdigest())
            for k, x in enumerate(idxs[1:], 2):
                ids[x] = f"{i}_{k}"
    if len(set(ids)) != len(ids):
        raise ValueError("retail IDs not unique after suffixing")
    return ids


def missing_boundaries(fields):
    """[(path, make target)] of the boundary files `fields` need that don't exist."""
    return [(BOUNDARIES[f][0], BOUNDARIES[f][2]) for f in fields if not BOUNDARIES[f][0].exists()]


def _unavailable(*_args):
    raise RuntimeError("spatial SQL function called on a plain sqlite3 connection")


def gpkg_stub_functions(con):
    """Register the SQL functions GDAL's rtree triggers name, so an attribute-only
    UPDATE compiles. The triggers' guard keeps them from running; they raise if it fails."""
    for name in ("ST_IsEmpty", "ST_MinX", "ST_MaxX", "ST_MinY", "ST_MaxY"):
        con.create_function(name, 1, _unavailable, deterministic=True)


def gpkg_row_hash(path):
    """sha256 of every feature table's rows ordered by fid; unlike the file's
    bytes, it is unchanged by a write that leaves the rows as they were."""
    con = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        h = hashlib.sha256()
        tables = [r[0] for r in con.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type='features' ORDER BY table_name")]
        for t in tables:
            h.update(t.encode() + b"\n")
            for row in con.execute(f'SELECT * FROM "{t}" ORDER BY fid'):
                h.update(repr(row).encode() + b"\n")
        return h.hexdigest()
    finally:
        con.close()


def file_hash(path):
    """gpkg: the row-dump hash; anything else: sha256 of the bytes."""
    if str(path).endswith(".gpkg"):
        return gpkg_row_hash(path)
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# --- geo half: shapely / numpy / pyogrio imported inside the functions ------

_BOUNDARY_CACHE = {}  # (path, key column) -> (prepared polygon parts, their codes)


def _is_4326(crs):
    if crs is None:
        raise ValueError("input has no CRS")
    if crs.upper() in ("EPSG:4326", "OGC:CRS84") or crs.endswith("CRS84"):
        return True
    import pyproj
    return pyproj.CRS(crs).to_epsg() == 4326


def _to_4326(geoms, crs):
    """Geometries in EPSG:4326 for the join; the file keeps its own CRS."""
    if _is_4326(crs):
        return geoms
    import numpy as np
    import pyproj
    import shapely
    t = pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return shapely.transform(geoms, lambda c: np.column_stack(t.transform(c[:, 0], c[:, 1])))


def load_boundaries(fields):
    """{field: (parts, codes)}: each boundary's polygonal parts, prepared, beside
    its `str` code. make_valid runs only on invalid units. Cached per process."""
    import numpy as np
    import pyogrio.raw
    import shapely

    missing = missing_boundaries(fields)
    if missing:
        raise FileNotFoundError("missing boundary file(s): " + ", ".join(
            f"{path} (make {target})" for path, target in missing))
    out = {}
    for field in fields:
        path, key, _ = BOUNDARIES[field]
        ck = (str(path), key)
        if ck not in _BOUNDARY_CACHE:
            meta, _, wkb, data = pyogrio.raw.read(path, columns=[key])
            if not _is_4326(meta["crs"]):
                raise ValueError(f"{path}: boundary CRS {meta['crs']} is not EPSG:4326")
            codes = []
            for v in data[0]:
                if v is None:
                    raise ValueError(f"{path}: null {key}")
                codes.append(str(v))
            encode(set(codes))
            geoms = shapely.from_wkb(wkb)
            bad = ~shapely.is_valid(geoms)
            geoms[bad] = shapely.make_valid(geoms[bad])
            # twice: make_valid can return a GeometryCollection holding MultiPolygons
            parts, idx = shapely.get_parts(geoms, return_index=True)
            parts, sub = shapely.get_parts(parts, return_index=True)
            idx = idx[sub]
            poly = shapely.get_type_id(parts) == 3
            parts, idx = parts[poly], idx[poly]
            shapely.prepare(parts)
            _BOUNDARY_CACHE[ck] = (parts, np.array(codes, dtype=object)[idx])
        out[field] = _BOUNDARY_CACHE[ck]
    return out


def join(geoms, field):
    """One `|a|b|` value per geometry for `field`. Points keep every region they
    intersect; lines and polygons drop a region they only touch, unless every
    region they meet is touch-only (a line along a border), and then keep them
    all. A null or empty geometry gets `|none|`."""
    import numpy as np
    import shapely

    parts, codes = load_boundaries([field])[field]
    geoms = np.asarray(geoms, dtype=object)
    lineal = ~np.isin(shapely.get_type_id(geoms), (0, 4))  # not Point / MultiPoint
    hits = [set() for _ in range(len(geoms))]
    touched = [set() for _ in range(len(geoms))]
    big = shapely.get_num_coordinates(geoms) > GIANT
    giant, small = np.flatnonzero(big), np.flatnonzero(~big)
    pairs = [shapely.STRtree(parts).query(geoms[giant], predicate="intersects")[::-1]]
    pairs[0][1] = giant[pairs[0][1]]
    for start in range(0, len(small), CHUNK):
        idx = small[start:start + CHUNK]
        b, g = shapely.STRtree(geoms[idx]).query(parts, predicate="intersects")
        pairs.append(np.stack([b, idx[g]]))
    for b, g in pairs:
        touch = np.zeros(len(b), dtype=bool)
        m = lineal[g]
        touch[m] = shapely.touches(parts[b[m]], geoms[g[m]])
        for gi, code, t in zip(g.tolist(), codes[b].tolist(), touch.tolist()):
            (touched if t else hits)[gi].add(code)
    return [encode(h or t) for h, t in zip(hits, touched)]


def tag_geoms(geoms, scope, fields=None):
    """{field: [value or None]} in scope order. Global features outside the US
    get None (key omitted) for the US-only fields."""
    import numpy as np

    want = [f for f in SCOPES[scope] if fields is None or f in fields]
    if fields is not None and set(fields) - set(SCOPES[scope]):
        raise ValueError(f"fields {sorted(set(fields) - set(SCOPES[scope]))} not in scope {scope}")
    if scope == "usa":
        return {f: join(geoms, f) for f in want}
    geoms = np.asarray(geoms, dtype=object)
    countries = join(geoms, "countries")
    out = {}
    for f in want:
        if f == "countries":
            out[f] = countries
        elif f == "admin1":
            out[f] = join(geoms, f)
    us = np.array(["|USA|" in c for c in countries], dtype=bool)
    for f in want:
        if f in FIELDS_US_EXTRA:
            vals = iter(join(geoms[us], f))
            out[f] = [next(vals) if u else None for u in us.tolist()]
    return out


def _region_values(geoms, scope, fields, prefer_cols, source):
    """tag_geoms, then each prefer_cols {column: field} source value where non-blank."""
    values = tag_geoms(geoms, scope, fields)
    for col, field in (prefer_cols or {}).items():
        if field not in values:
            raise ValueError(f"prefer {col}={field}: {field} is not tagged")
        values[field] = [prefer(s, v) for s, v in zip(source(col), values[field])]
    return values


def _print_stats(label, values):
    lines = stats_lines(label, values)
    for line in lines:
        print(line, flush=True)
    return lines


def _geojson_geoms(geometries):
    import numpy as np
    import shapely
    return shapely.from_geojson(np.array(
        [json.dumps(g) if g else None for g in geometries], dtype=object))


def _tag_feature_dicts(features, scope, fields, prefer):
    """Set the region keys on each feature's properties (appended, keys of other
    region fields removed, None omitted); returns the values."""
    for f in features:
        f["properties"] = f.get("properties") or {}
    values = _region_values(_geojson_geoms([f.get("geometry") for f in features]), scope,
                            fields, prefer, lambda col: [f["properties"].get(col) for f in features])
    for i, f in enumerate(features):
        props = f["properties"]
        for k in REGION_FIELDS:
            props.pop(k, None)
        for k, vals in values.items():
            if vals[i] is not None:
                props[k] = vals[i]
    return values


def tag_features(features, scope, label, prefer=None, fields=None):
    """Tag GeoJSON feature dicts in place and print REGION_STATS; returns them."""
    _print_stats(label, _tag_feature_dicts(features, scope, fields, prefer))
    return features


def _open_text(path, mode, gz):
    """Text handle; gzip is written with a fixed header, so a re-run is byte-identical."""
    if not gz:
        return open(path, mode, newline="" if mode == "w" else None, encoding="utf-8")
    if mode == "r":
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8")
    raw = open(path, "wb")
    gz = gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0)
    return _GzText(gz, raw)


class _GzText(io.TextIOWrapper):
    def __init__(self, gz, raw):
        super().__init__(gz, encoding="utf-8", newline="")
        self._raw = raw

    def close(self):
        super().close()
        self._raw.close()


def _write_swap(src, dst, write):
    """write(handle) into a temp file beside dst, then os.replace it in, with
    src's permission bits."""
    dst = Path(dst)
    fd, tmp = tempfile.mkstemp(dir=dst.parent, prefix=dst.name + ".", suffix=".tmp")
    os.close(fd)
    try:
        with _open_text(tmp, "w", dst.name.endswith(".gz")) as f:
            write(f)
        if os.path.exists(src):
            shutil.copymode(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        os.remove(tmp)
        raise


def _tag_csv(src, dst, scope, prefer_cols, fields, label):
    import numpy as np
    import shapely

    with open(src, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    if "lon" not in header or "lat" not in header:
        raise ValueError(f"{src}: no lon/lat columns")
    ix, iy = header.index("lon"), header.index("lat")

    def num(v):
        try:
            return float(v)
        except ValueError:
            return float("nan")

    x = np.array([num(r[ix]) for r in body])
    y = np.array([num(r[iy]) for r in body])
    ok = np.isfinite(x) & np.isfinite(y)
    geoms = np.full(len(body), None, dtype=object)
    geoms[ok] = shapely.points(x[ok], y[ok])
    values = _region_values(geoms, scope, fields, prefer_cols,
                            lambda col: [r[header.index(col)] for r in body])
    for k in REGION_FIELDS:
        if k in header and k not in values:
            i = header.index(k)
            for r in body:
                r[i] = ""
    for k, vals in values.items():
        if k not in header:
            header.append(k)
            for r in body:
                r.append("")
        i = header.index(k)
        for r, v in zip(body, vals):
            r[i] = "" if v is None else v

    def write(f):
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(body)
    _write_swap(src, dst, write)
    return _print_stats(label, values)


def _tag_gpkg(path, scope, prefer_cols, fields, label):
    """Region columns set in place through sqlite3: TEXT columns added when
    missing and every row updated, all in one transaction (an interrupted run
    leaves the file as it was); geometry and other columns are untouched."""
    import pyogrio.raw
    import shapely

    con = sqlite3.connect(path)
    try:
        tables = [r[0] for r in con.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type='features'")]
        if len(tables) != 1:
            raise ValueError(f"{path}: expected one feature table, found {tables}")
        table = tables[0]
        info = con.execute(f'PRAGMA table_info("{table}")').fetchall()
        cols = [r[1] for r in info]
        pk = next(r[1] for r in info if r[5])
        src_vals = {col: dict(con.execute(f'SELECT "{pk}", "{col}" FROM "{table}"'))
                    for col in (prefer_cols or {})}
    finally:
        con.close()

    meta, fids, wkb, _ = pyogrio.raw.read(path, layer=table, columns=[], return_fids=True)
    geoms = _to_4326(shapely.from_wkb(wkb), meta["crs"])
    fids = fids.tolist()
    values = _region_values(geoms, scope, fields, prefer_cols,
                            lambda col: [src_vals[col].get(fid) for fid in fids])

    con = sqlite3.connect(path, isolation_level=None)
    try:
        gpkg_stub_functions(con)
        con.execute("BEGIN")
        try:
            for k in values:
                if k not in cols:
                    con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{k}" TEXT')
            stale = [k for k in REGION_FIELDS if k in cols and k not in values]
            if stale:
                con.execute(f'UPDATE "{table}" SET ' + ", ".join(f'"{k}" = NULL' for k in stale))
            sets = ", ".join(f'"{k}" = ?' for k in values)
            con.executemany(f'UPDATE "{table}" SET {sets} WHERE "{pk}" = ?',
                            zip(*values.values(), fids))
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.close()
    return _print_stats(label, values)


def _tag_geojson(src, dst, scope, prefer_cols, fields, label):
    """Region keys appended to each feature's properties. Values and key order
    are preserved; whitespace and number text are re-serialised by json."""
    with _open_text(src, "r", src.name.endswith(".gz")) as f:
        fc = json.load(f)
    crs = (fc.get("crs") or {}).get("properties", {}).get("name", "OGC:CRS84")
    if not _is_4326(crs):
        raise ValueError(f"{src}: GeoJSON CRS {crs} is not lon/lat WGS84")
    values = _tag_feature_dicts(fc["features"], scope, fields, prefer_cols)
    _write_swap(src, dst, lambda f: json.dump(fc, f, ensure_ascii=False, separators=(",", ":")))
    return _print_stats(label, values)


def _tag_geojsonseq(src, dst, scope, prefer_cols, fields, label):
    """GeoJSONSeq, streamed CHUNK features at a time."""
    totals = {}

    def flush(lines, f):
        feats = [json.loads(line.lstrip("\x1e")) for line in lines]
        for k, v in _tag_feature_dicts(feats, scope, fields, prefer_cols).items():
            totals.setdefault(k, []).extend(v)
        for line, feat in zip(lines, feats):
            f.write(("\x1e" if line.startswith("\x1e") else "")
                    + json.dumps(feat, ensure_ascii=False, separators=(",", ":")) + "\n")

    def write(f):
        with _open_text(src, "r", src.name.endswith(".gz")) as inp:
            lines = []
            for line in inp:
                if line.strip():
                    lines.append(line)
                if len(lines) == CHUNK:
                    flush(lines, f)
                    lines = []
            if lines:
                flush(lines, f)
    _write_swap(src, dst, write)
    return _print_stats(label, totals)


def tag_file(src, scope, out=None, prefer=None, fields=None):
    """Tag a .csv (lon/lat), .gpkg, .geojson or .geojsonl (each optionally .gz,
    except gpkg) with the scope's region fields; print and return REGION_STATS.

    out=None rewrites src; a gpkg is copied to `out` first and tagged there in
    place. prefer: {source column: field} (D8). fields: a subset of the scope's.
    """
    src = Path(src)
    dst = Path(out) if out else src
    label = src.name
    name = src.name[:-3] if src.name.endswith(".gz") else src.name
    if name.endswith(".gpkg"):
        if dst != src:
            shutil.copyfile(src, dst)
        return _tag_gpkg(dst, scope, prefer, fields, label)
    if name.endswith(".csv"):
        return _tag_csv(src, dst, scope, prefer, fields, label)
    if name.endswith(".geojsonl"):
        return _tag_geojsonseq(src, dst, scope, prefer, fields, label)
    if name.endswith(".geojson"):
        return _tag_geojson(src, dst, scope, prefer, fields, label)
    raise ValueError(f"{src}: unsupported format")


def _prefer_arg(s):
    col, sep, field = s.partition("=")
    if not (sep and col and field):
        raise argparse.ArgumentTypeError(f"expected COL=FIELD, got {s!r}")
    return col, field


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hash", help="print the re-run equality hash of PATH").add_argument("path")
    t = sub.add_parser("tag", help="add region fields to SRC (in place unless --out)")
    t.add_argument("--scope", required=True, choices=sorted(SCOPES))
    t.add_argument("src")
    t.add_argument("--out")
    t.add_argument("--prefer", action="append", default=[], metavar="COL=FIELD", type=_prefer_arg,
                   help="use the source column's value for FIELD where non-blank")
    t.add_argument("--fields", help="comma-separated subset of the scope's fields")
    args = p.parse_args(argv)
    if args.cmd == "hash":
        print(file_hash(args.path))
    elif args.cmd == "tag":
        pref = dict(args.prefer)
        fields = args.fields.split(",") if args.fields else None
        tag_file(args.src, args.scope, out=args.out, prefer=pref, fields=fields)


if __name__ == "__main__":
    sys.exit(main())
