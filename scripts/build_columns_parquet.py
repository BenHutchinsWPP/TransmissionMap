#!/usr/bin/env python3
"""build_columns_parquet.py — attribute-only Parquet files for the tiled
datasets, so the table, count/aggregate/query and templates can answer for the
whole dataset instead of the loaded tiles (docs/roadmap/tier1-parquet.plan.md
D1/D2).

One file per dataset, data/analysis/columns/<ds>.<sha8>.parquet:

  columns   the stable id (a native id as `fid` int64; any other id keeps its
            name and is a property), every attribute in the built archive's
            vector_layers fields, `length_km` (lines) or `area_km2` (polygons)
            on the sphere R=6371.0088 km, and `px`, `py` (int32 micro-degrees, round(x·1e6)): the point
            itself, a line's midpoint along it, a polygon's point_on_surface
  layout    Hilbert order on px/py (the same integers), 64k-row groups, no page index, ZSTD 9
  footer    build_id, dataset, geometry, id_field, id_native, region_codes (one
            {field: [codes]} per row group; `none` when a row has no value);
            `counties` is left out of region_codes when the footer would pass
            256 KiB

Rows are read as tippecanoe read them (tile_inputs.py): world layers from the
kept, region-tagged merged input, US layers from the manifest `src`. A JSON
number becomes float64, a string stays a string, a boolean stays a boolean, the
native id is int64; null stays null and "" stays "". The build fails on a
duplicate or missing id, a column that mixes types, an archive field no input
row carries, and an attribute named length_km, area_km2, px or py. A row
without geometry is left out and counted (tippecanoe leaves it out of the
tiles too); rows the tiles dropped for drawing stay in the file.

Memory: pass 1 (types) holds the id set; pass 2 holds the table as Arrow chunks
(strings and numbers, no geometry) plus one uint64 Hilbert key per row, and the
sorted copy `take` makes. For osm_transmission_lines (~1.5M rows, region lists
the widest strings) that is roughly 1-2 GB of Arrow plus ~0.2 GB of ids, so
under 4 GB at the peak; the Makefile target caps it at 14 GB.

index.json gains a top-level `columns` section; `datasets` and unknown keys are
never touched. Only `columns/<ds>.*` of rebuilt datasets is deleted, after the
index names the new file.

Usage:
  python scripts/build_columns_parquet.py                      # all 11
  python scripts/build_columns_parquet.py --only padus
  python scripts/build_columns_parquet.py --scan-types         # types only, no output
  python scripts/build_columns_parquet.py --fixture DIR        # DIR/input → DIR/analysis

--fixture reads DIR/input/<ds>.geojsonl[.gz] (osm_transmission_lines also
transmission_world.geojsonl[.gz]) and DIR/input/fields.json, {ds: {field:
type}}, in place of the archive's vector_layers; build_id is "fixture";
archive_sha256 is the sha256 of DIR/input/<ds>.pmtiles when that file exists,
else null. Without --only a fixture builds the datasets that have an input.
--row-group-size (default 65536) is for fixtures.
"""
import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

import geoparquet_common as gc
from build_line_parquet import load_index

log = logging.getLogger("columns_parquet")

ROOT = Path(__file__).resolve().parent.parent
LAYERS_DIR = ROOT / "data" / "layers"
OUT_DIR = ROOT / "data" / "analysis"
MANIFEST = ROOT / "scripts" / "tile_manifest.yaml"


class Spec(NamedTuple):
    geometry: str      # point | line | polygon
    id_field: str
    native: bool       # tippecanoe --use-attribute-for-id: the id is the tile feature id


SPECS = {
    "osm_transmission_lines": Spec("line", "fid", True),
    "hifld_transmission_lines": Spec("line", "ID", False),
    "osm_pipelines_lines": Spec("line", "fid", True),
    "hifld_natgas_lines": Spec("line", "fid", False),
    "osm_substations_points": Spec("point", "fid", True),
    "osm_substations_polygons": Spec("polygon", "fid", True),
    "osm_plants_polygons": Spec("polygon", "fid", True),
    "osm_generators": Spec("point", "fid", True),
    "retail_territories": Spec("polygon", "id", False),
    "padus": Spec("polygon", "fid", True),
    "crithab": Spec("polygon", "entity_id", False),
}
DATASETS = tuple(SPECS)
MEASURE = {"line": "length_km", "polygon": "area_km2"}
RESERVED = ("length_km", "area_km2", "px", "py")
REGION_FIELDS = ("countries", "admin1", "states", "counties", "ba", "nerc", "retail", "zcta")
BATCH = 100_000
FOOTER_MAX = 256 * 1024
MAX_SAFE = 2 ** 53
ARROW = {"float64": "float64", "string": "string", "bool": "bool_"}


class BuildError(SystemExit):
    """A refusal, printed and exited with 1."""

    def __init__(self, msg):
        super().__init__(f"ERROR: {msg}")


# ── Inputs ────────────────────────────────────────────────────────────────────

class Source:
    """One dataset's rows and archive facts: the real build inputs or a fixture."""

    def __init__(self, ds, fixture=None):
        self.ds = ds
        spec = SPECS[ds]
        if fixture:
            base = Path(fixture) / "input"
            names = [f"{ds}.geojsonl.gz", f"{ds}.geojsonl"]
            if ds == "osm_transmission_lines":
                names += ["transmission_world.geojsonl.gz", "transmission_world.geojsonl"]
            found = next((base / n for n in names if (base / n).exists()), None)
            self.paths = [found] if found else []
            self.opts = lambda p: []
            fields = json.loads((base / "fields.json").read_text()).get(ds)
            self.fields = dict(fields) if fields is not None else None
            arch = base / f"{ds}.pmtiles"
            self.archive = arch if arch.exists() else None
        else:
            import stable_ids
            import tile_inputs
            layer = next((L for L in stable_ids.load_layers(MANIFEST) if L["id"] == ds), None)
            if layer is None or layer["id_field"] != spec.id_field \
                    or bool(layer.get("native_id")) != spec.native:
                raise BuildError(f"{ds}: tile_manifest.yaml id declaration differs from SPECS")
            self.paths, self.opts, _ = tile_inputs.input_rows(layer)
            self.archive = LAYERS_DIR / f"{ds}.pmtiles"
            self.fields = gc.pmtiles_fields(self.archive, ds) if self.archive.exists() else None

    def check(self):
        if not self.paths:
            raise BuildError(f"{self.ds}: no input found")
        if self.fields is None:
            raise BuildError(f"{self.ds}: no archive fields "
                             f"({self.archive or 'fixture fields.json'} missing)")

    def rows(self):
        import tile_inputs
        for p in self.paths:
            yield from tile_inputs.stream_rows(p, self.opts(p), geometry=True)


# ── Column plan and types ─────────────────────────────────────────────────────

def attribute_columns(ds, fields):
    """The archive's attributes as columns, with the id handled: a native id is
    the separate `fid`; any other id must be one of the attributes."""
    spec = SPECS[ds]
    clash = [f for f in fields if f in RESERVED]
    if clash:
        raise BuildError(f"{ds}: archive field(s) {clash} clash with a computed column")
    if spec.native:
        return [f for f in fields if f != "fid"]
    if spec.id_field not in fields:
        raise BuildError(f"{ds}: id field {spec.id_field!r} is not in the archive's fields")
    return list(fields)


def row_id(ds, row):
    """The row's stable id: an int for a native id; the property's value otherwise."""
    spec = SPECS[ds]
    v = row.get(spec.id_field)
    if spec.native and v is None:
        v = row.get("__id")
    if v is None:
        raise BuildError(f"{ds}: a row has no {spec.id_field}")
    if spec.native and (isinstance(v, bool) or not isinstance(v, int)):
        raise BuildError(f"{ds}: native id {v!r} is not an integer")
    return v


def kind_of(v):
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "other"


def has_geometry(row):
    g = row.get("__geometry")
    return bool(g) and (g.get("type") == "GeometryCollection" or bool(g.get("coordinates")))


def scan_types(ds, src):
    """Pass 1: (column types, rows). Raises BuildError on every refusal, all listed."""
    attrs = attribute_columns(ds, src.fields)
    spec = SPECS[ds]
    kinds = {f: set() for f in attrs}
    ids, dups, no_geom, big, n = set(), [], 0, set(), 0
    for row in src.rows():
        if not has_geometry(row):
            no_geom += 1
            continue
        n += 1
        i = row_id(ds, row)
        if i in ids:
            dups.append(i)
        else:
            ids.add(i)
        for f in attrs:
            v = row.get(f)
            if v is not None:
                kinds[f].add(kind_of(v))
                if type(v) is int and abs(v) > MAX_SAFE:
                    big.add(f)
    problems = []
    if n == 0:
        problems.append("no rows")
    if dups:
        problems.append(f"{len(dups)} duplicate id(s), e.g. {dups[:5]}")
    if no_geom:
        log.info("  %s: %d row(s) without geometry left out", ds, no_geom)
    types = {}
    for f in attrs:
        k = kinds[f]
        if not k:
            problems.append(f"archive field {f!r} is missing from every input row")
        elif "other" in k:
            problems.append(f"field {f!r} holds a list or object")
        elif len(k) > 1:
            problems.append(f"field {f!r} mixes {sorted(k)}")
        else:
            types[f] = {"number": "float64", "string": "string", "bool": "bool"}[next(iter(k))]
    for f in sorted(big):
        problems.append(f"number in {f!r} passes 2^53")
    if problems:
        raise BuildError(f"{ds}: " + "; ".join(problems))
    if spec.native:
        types = {"fid": "int64", **types}
    return types, n


# ── Table ─────────────────────────────────────────────────────────────────────

def measures_and_points(geometry, geoms):
    """(measure array or None, px, py) float64 arrays for shapely geometries."""
    import numpy as np
    import shapely
    if geometry == "polygon":
        pts = shapely.point_on_surface(np.array(geoms, dtype=object))
        px, py = shapely.get_x(pts), shapely.get_y(pts)
        measure = np.array([gc.sphere_area_km2(g) for g in geoms])
    else:
        xy = np.array([gc.point_on_feature(g) for g in geoms])
        px, py = xy[:, 0], xy[:, 1]
        measure = gc.line_lengths_km(np.array(geoms, dtype=object)) if geometry == "line" else None
    return measure, px, py


def batch_table(ds, rows, attrs, types):
    import numpy as np
    import pyarrow as pa
    import shapely.geometry
    spec = SPECS[ds]
    cols = {}
    if spec.native:
        cols["fid"] = pa.array([row_id(ds, r) for r in rows], pa.int64())
    for f in attrs:
        cols[f] = pa.array([r.get(f) for r in rows], getattr(pa, ARROW[types[f]])())
    geoms = [shapely.geometry.shape(r["__geometry"]) for r in rows]
    measure, px, py = measures_and_points(spec.geometry, geoms)
    if measure is not None:
        cols[MEASURE[spec.geometry]] = pa.array(measure.astype(np.float32))
    ux, uy = np.rint(px * 1e6).astype(np.int32), np.rint(py * 1e6).astype(np.int32)
    cols["px"], cols["py"] = pa.array(ux, pa.int32()), pa.array(uy, pa.int32())
    return pa.table(cols), gc.hilbert_key(ux / 1e6, uy / 1e6)


def build_table(ds, src, types):
    """Pass 2: the table in Hilbert order."""
    import numpy as np
    import pyarrow as pa
    attrs = attribute_columns(ds, src.fields)
    parts, keys, rows = [], [], []

    def flush():
        t, k = batch_table(ds, rows, attrs, types)
        parts.append(t)
        keys.append(k)
        rows.clear()
    for row in src.rows():
        if not has_geometry(row):
            continue
        rows.append(row)
        if len(rows) == BATCH:
            flush()
    if rows:
        flush()
    table = pa.concat_tables(parts)
    del parts
    order = np.argsort(np.concatenate(keys), kind="stable")
    return table.take(pa.array(order))


def region_codes(table, size):
    """One {field: sorted codes} per row group; `none` stands for a row with no value."""
    import pyarrow as pa
    import pyarrow.compute as pc
    fields = [f for f in REGION_FIELDS
              if f in table.column_names and pa.types.is_string(table.schema.field(f).type)]
    out = []
    for start in range(0, table.num_rows, size):
        group = {}
        for f in fields:
            codes = set()
            for v in pc.unique(table[f].slice(start, size)).to_pylist():
                if v:
                    codes.update(c for c in v.split("|") if c)
                else:
                    codes.add("none")
            group[f] = sorted(codes)
        out.append(group)
    return out


def write_file(table, out_dir, ds, build_id, row_group_size):
    """Write, name by content and check the footer; returns (path, sha256, region fields kept)."""
    spec = SPECS[ds]
    id_col = "fid" if spec.native else spec.id_field
    no_dict = {id_col, "px", "py", "length_km", "area_km2"}
    codes = region_codes(table, row_group_size)
    dropped = False
    while True:
        meta = {"build_id": build_id, "dataset": ds, "geometry": spec.geometry,
                "id_field": spec.id_field, "id_native": "true" if spec.native else "false",
                "region_codes": json.dumps(codes, separators=(",", ":"))}
        tmp = out_dir / f"{ds}.part.parquet"
        preset = dict(gc.COLUMNS_PRESET, row_group_size=row_group_size)
        gc.write_parquet(table, tmp, preset, metadata=meta, no_dictionary=no_dict)
        footer = gc.footer_len(tmp)
        log.info("  footer %.1f KiB%s", footer / 1024, " (counties left out of region_codes)" if dropped else "")
        if footer > FOOTER_MAX and not dropped and any("counties" in g for g in codes):
            log.warning("  footer over %d KiB: leaving counties out of region_codes", FOOTER_MAX // 1024)
            codes = [{k: v for k, v in g.items() if k != "counties"} for g in codes]
            dropped = True
            continue
        if footer > FOOTER_MAX:
            log.warning("  footer %.1f KiB is over the %d KiB budget", footer / 1024, FOOTER_MAX // 1024)
        break
    path, digest = gc.content_name(tmp, ds)
    return path, digest


# ── Index ─────────────────────────────────────────────────────────────────────

def snapshot_date(ds, fixture):
    if fixture or not ds.startswith("osm_"):
        return None
    from build_data_manifest import osm_snapshot_date
    return osm_snapshot_date(ROOT)


def write_columns_index(out, entries):
    """Add `columns` entries to index.json; every other key stays as it is."""
    index = load_index(out)
    cols = index.setdefault("columns", {})
    cols.update(entries)
    index["columns"] = {k: cols[k] for k in sorted(cols)}
    gc.write_json(out / "index.json", index)
    return index


def build_dataset(ds, src, out, build_id, row_group_size, fixture):
    t0 = time.time()
    src.check()
    log.info("%s: pass 1, types", ds)
    types, n = scan_types(ds, src)
    log.info("  %d rows, %d columns: %s", n, len(types),
             ", ".join(f"{k}:{v}" for k, v in types.items()))
    log.info("%s: pass 2, table", ds)
    table = build_table(ds, src, types)
    cdir = out / "columns"
    cdir.mkdir(parents=True, exist_ok=True)
    path, digest = write_file(table, cdir, ds, build_id, row_group_size)
    entry = gc.file_entry(path, "columns", table.num_rows, digest)
    entry.pop("role")
    spec = SPECS[ds]
    manifest = {
        "path": "columns/", "build_id": build_id, "file": entry, "geometry": spec.geometry,
        "id": {"field": spec.id_field, "native": spec.native}, "columns": table.column_names,
        "archive_sha256": gc.sha256_file(src.archive) if src.archive and src.archive.exists() else None,
        "snapshot": snapshot_date(ds, fixture), "tiles_missing": None,
    }
    log.info("  ✓ %s  %.1f MiB, %d rows, %d groups  (%.0f s)", path.name,
             path.stat().st_size / 2**20, table.num_rows,
             -(-table.num_rows // row_group_size), time.time() - t0)
    return manifest


def remove_old(cdir, ds, keep):
    for old in sorted(cdir.glob(f"{ds}.*")):
        if old.name != keep:
            old.unlink()
            log.info("  removed %s from an earlier build", old.name)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--only", action="append", choices=DATASETS, help="build one dataset (repeatable)")
    ap.add_argument("--scan-types", action="store_true", help="read the inputs, report types and refusals, write nothing")
    ap.add_argument("--fixture", help="read DIR/input, write DIR/analysis (tests)")
    ap.add_argument("--row-group-size", type=int, default=gc.COLUMNS_PRESET["row_group_size"],
                    help="rows per group (fixtures only)")
    args = ap.parse_args(argv)
    if args.row_group_size != gc.COLUMNS_PRESET["row_group_size"] and not args.fixture:
        ap.error("--row-group-size is for --fixture")
    out = (Path(args.fixture) / "analysis") if args.fixture else OUT_DIR
    wanted = args.only or DATASETS
    sources = {ds: Source(ds, args.fixture) for ds in wanted}
    if args.fixture and not args.only:
        sources = {ds: s for ds, s in sources.items() if s.paths}
        if not sources:
            raise BuildError(f"no input in {args.fixture}/input")
    if args.scan_types:
        for ds, src in sources.items():
            src.check()
            types, n = scan_types(ds, src)
            log.info("%s: %d rows OK  %s", ds, n, ", ".join(f"{k}:{v}" for k, v in types.items()))
        return 0
    load_index(out)      # refuse an unparseable index.json before the long build
    build_id = "fixture" if args.fixture else \
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + os.urandom(3).hex()
    log.info("build_id %s → %s", build_id, out)
    for ds, src in sources.items():
        manifest = build_dataset(ds, src, out, build_id, args.row_group_size, bool(args.fixture))
        write_columns_index(out, {ds: manifest})
        remove_old(out / "columns", ds, manifest["file"]["name"])
    log.info("✓ %s", out / "index.json")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s",
                        datefmt="%H:%M:%S")
    sys.exit(main())
