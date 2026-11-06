#!/usr/bin/env python3
"""stable_ids.py — check that every served layer carries its stable feature id.

Reads each layer's `id_field` (and `native_id`) from scripts/tile_manifest.yaml,
including its `built_elsewhere` list, and checks what is served from
data/layers/:

  <id>.geojson[.gz] every feature; an id seen twice is a duplicate.
  <id>.pmtiles                          decoded at the archive's max zoom with tippecanoe-decode,
                    streamed. An id repeated **within one tile** is a duplicate.
                    The same id in several tiles is one feature cut by tile
                    edges, which is expected.

An id is missing when a native_id archive's feature has no vector-tile id, or
when the `id_field` property is absent, null or empty.

`--input FILE` (with `--only`) also checks the build intermediate the layer was
tiled from (.csv, .geojson[.gz], .geojsonl, or any OGR file such as .gpkg) for
missing and duplicate ids, and counts its ids absent from the archive (full
passes only).

`--lines` checks the geometry files instead (data/analysis/, built by
build_line_parquet.py; `--only` picks one dataset): every id the archives serve
at max zoom is in IDX (0 missing; IDX ids no tile carries are counted, not
failed), IDX has no duplicate, IDX `row` and CHAINS `row` point at the GEO row
of their fid on a sample, and sampled tile pieces lie on their GEO geometry:
line and point vertices within the tile grid, polygon pieces (manifest
`geometry: polygon`) each side opened by one grid unit, its vertices within
2.5 grid units of the other side's area, both clipped to the piece's tile
(`POLYGON_TOLERANCE_BY_DATASET` replaces that per dataset; None reports the
measure and checks ids only). A layer served as GeoJSON (no PMTiles archive;
simplified at build) is checked for ids as well, and each served feature against its
GEO geometry: the symmetric-difference area at most 5 % of the GEO area.

`--attrs` holds attributes instead: each pmtiles layer's archives are decoded
at every zoom (or `--zooms`), a uniform sample of tiles per zoom is kept
(`--max-tiles`, default 500; `--all-tiles` for all), and every sampled
feature's attributes must equal its build input row's, found by stable id. The
input is read as the build reads it: the manifest `src` through ogr2ogr with
its `select`/`where`, or for a world layer the continental intermediates in
build_global_tiles.py's kept merged, tagged input when it exists (tile_inputs.py), and
else the continental intermediates in its dedupe order; only on that fallback are
the region fields a world build adds after the merge left out of the comparison. Memory grows
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

from tile_inputs import _open_text, input_rows, stream_rows, world_spec  # noqa: F401

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
    when given, is called with (id, feature line, tile "z/x/y") for every feature."""
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
                on_feature(fid, line, where)
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
    return [p for p in paths if p.exists()]


def check_layer(layer, layers_dir, zoom=None, max_tiles=0):
    """[(archive name, zoom or '-', Stats)] for every served artifact of a layer."""
    rows, id_field, native = [], layer["id_field"], bool(layer.get("native_id"))
    for path in artifacts(layer, layers_dir):
        if path.suffix == ".pmtiles":
            z, st = scan_pmtiles(path, id_field, native, zoom, max_tiles)
        else:
            with _open_text(path) as f:
                z, st = "-", scan_features(json.load(f)["features"], id_field)
        rows.append((path.name, z, st))
    return rows


# ── --lines: the geometry files against the served archives ────────────────

ANALYSIS_DIR = ROOT / "data" / "analysis"
# A line or point tile vertex more than one grid unit inside its tile box is a
# data vertex snapped to the grid: within INTERIOR_TOLERANCE_UNITS of the GEO
# geometry (√2/2 plus decode rounding). Any other vertex (on the tile edge or in
# its buffer) may be a clip point on a long segment: within EDGE_TOLERANCE_UNITS.
# A point's vertices are all interior.
INTERIOR_TOLERANCE_UNITS = 0.8
EDGE_TOLERANCE_UNITS = 2.5
# A polygon piece against its GEO polygon, both clipped to the piece's tile box
# and opened by one grid unit: each side's vertices lie within this distance of
# the other side's area.
POLYGON_TOLERANCE_UNITS = 2.5
# Per polygon dataset, where the default does not apply. retail_territories: a
# placement check, not an accuracy one (tiles simplified at max zoom: simplification 6,
# shared borders, z10; measured max 194.2 units). crithab (z13) and padus (z10) the same:
# tiny-polygon reduction and coalescing move a piece's parts (measured max 4050.7 and
# 2543.5 units on 20,000 pieces). us_zcta (z11, simplification 6, shared borders, coalescing) and
# county_boundaries (z8, simplification 8, shared borders) the same (measured max 1206.1 and
# 1550.5 units on 20,000 pieces). None would report the measure and check ids only.
POLYGON_TOLERANCE_BY_DATASET = {"retail_territories": 400.0, "crithab": 8000.0, "padus": 5000.0,
                                "us_zcta": 2500.0, "county_boundaries": 3100.0}
# A GeoJSON-served polygon may differ from its GEO polygon by this share of the GEO area (symmetric difference; measured max 0.0150).
GEOJSON_AREA_DIFF = 0.05
# Per dataset where 0.05 does not hold (control_areas: measured 0.0789, simplify 0.005).
# None: ids only, the area difference is reported but not judged (us_states, countries,
# admin1_boundaries: simplification 0.005 / 0.01 drops or reshapes small islands; measured max 0.113 / 0.967 / 1.547).
GEOJSON_AREA_DIFF_BY_DATASET = {"control_areas": 0.10, "us_states": None, "countries": None,
                                "admin1_boundaries": None}
EXTENT = 4096
# shapely geometry type id → the manifest `geometry` kind it belongs to
KIND_OF_TYPE = {0: "point", 4: "point", 1: "line", 5: "line", 3: "polygon", 6: "polygon"}


def mercator_units(xy, zoom):
    """lon/lat (n, 2) → Web Mercator tile-grid units at `zoom` (4096 a tile)."""
    import numpy as np
    w = EXTENT * 2 ** zoom
    lat = np.radians(np.clip(xy[:, 1], -85.0511, 85.0511))
    return np.c_[(xy[:, 0] + 180) / 360 * w,
                 (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / np.pi) / 2 * w]


def lonlat(units, zoom):
    """The inverse of mercator_units."""
    import numpy as np
    w = EXTENT * 2 ** zoom
    return np.c_[units[:, 0] / w * 360 - 180,
                 np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * units[:, 1] / w))))]


def to_units(geom, zoom):
    import shapely
    return shapely.transform(geom, lambda xy: mercator_units(xy, zoom))


def tile_vs_geo_units(tile_geom, geo_geom, zoom, where=None):
    """(interior, edge): the largest distance, in grid units, from a tile piece's
    vertices to the GEO line or point; None for a class the piece has no vertex in.
    A vertex more than one unit inside the piece's tile box (`where`, "z/x/y") is
    interior, any other is edge; with no `where` every vertex is interior."""
    import shapely
    xy = mercator_units(shapely.get_coordinates(tile_geom), zoom)
    d = shapely.distance(shapely.points(xy), to_units(geo_geom, zoom))
    if where is None:
        return (float(d.max()) if len(d) else None), None
    x0, y0, x1, y1 = tile_box(where)
    inner = ((xy[:, 0] > x0 + 1) & (xy[:, 0] < x1 - 1) & (xy[:, 1] > y0 + 1) & (xy[:, 1] < y1 - 1))
    return (float(d[inner].max()) if inner.any() else None,
            float(d[~inner].max()) if (~inner).any() else None)


def _opened(x):
    import shapely
    return shapely.get_coordinates(x.buffer(-1).buffer(1))


def _directed_xy(xy, b):
    import shapely
    return float(shapely.distance(shapely.points(xy), b).max()) if len(xy) else 0.0


def tile_box(where):
    """The tile "z/x/y" as its box in grid units at z: (xmin, ymin, xmax, ymax)."""
    _, x, y = (int(v) for v in where.split("/"))
    return x * EXTENT, y * EXTENT, (x + 1) * EXTENT, (y + 1) * EXTENT


def polygon_compare(tile_geom, geo_geom, zoom, where):
    """(distance, why) in grid units between a decoded polygon piece and its GEO
    polygon, both clipped to the piece's tile box and opened by one grid unit:
    the larger of the vertices of each opened side to the other clipped side's
    area. When only one side clips to nothing (a sliver the tile keeps in its
    buffer), the other side's opened vertices are measured to the unclipped
    geometry instead. (None, "empty") when both clip to nothing, (None, "thin")
    when both opened sides are empty (thinner than 2 units inside the tile)."""
    import shapely
    box = tile_box(where)
    t, g = to_units(tile_geom, zoom), to_units(geo_geom, zoom)
    tc = shapely.make_valid(shapely.clip_by_rect(t, *box))
    gc = shapely.make_valid(shapely.clip_by_rect(g, *box))
    if tc.is_empty and gc.is_empty:
        return None, "empty"
    txy, gxy = _opened(tc), _opened(gc)
    if not len(txy) and not len(gxy):
        return None, "thin"
    if tc.is_empty:
        return _directed_xy(gxy, shapely.make_valid(t)), None
    if gc.is_empty:
        return _directed_xy(txy, shapely.make_valid(g)), None
    return max(_directed_xy(gxy, tc), _directed_xy(txy, gc)), None


def polygon_vs_geo_units(tile_geom, geo_geom, zoom, where):
    """The distance of polygon_compare; None when there is nothing to compare."""
    return polygon_compare(tile_geom, geo_geom, zoom, where)[0]


def served_paths(layer, layers_dir):
    """(kind, files) of what a layer serves: its PMTiles archive, else its GeoJSON
    (simplified at build), else ("none", [])."""
    found = artifacts(layer, Path(layers_dir))
    tiles = [p for p in found if p.suffix == ".pmtiles"]
    if tiles:
        return "pmtiles", tiles
    return ("geojson", found) if found else ("none", [])


def area_difference(a, b):
    """|a △ b| / area(b) after make_valid: the share of b's area the two disagree on."""
    import shapely
    a, b = shapely.make_valid(a), shapely.make_valid(b)
    return float(shapely.symmetric_difference(a, b).area / b.area) if b.area else float(a.area > 0)


def geometry_tolerance(ds, m, served, layer=None):
    """The tolerance a dataset's served geometry is held to, or None when it is not judged.
    Tile pieces: grid units (POLYGON_TOLERANCE_BY_DATASET may set None). A layer served as
    GeoJSON: GEOJSON_AREA_DIFF_BY_DATASET, else GEOJSON_AREA_DIFF."""
    if served == "geojson":
        return GEOJSON_AREA_DIFF_BY_DATASET.get(ds, GEOJSON_AREA_DIFF)
    if m.get("geometry", "line") == "polygon":
        return POLYGON_TOLERANCE_BY_DATASET.get(ds, POLYGON_TOLERANCE_UNITS)
    return INTERIOR_TOLERANCE_UNITS


def check_dataset(ds, m, analysis_dir, layer, layers_dir, sample=1000, max_tiles=0, seed=1):
    """One index.json dataset against its served archive at max zoom. Returns a
    dict: `ok`, `text` (the report line), `pieces` (the sampled tile pieces as
    (fid, GeoJSON geometry, tile "z/x/y")), `zoom`, `missing`, `geo_max`, `tolerance`.
    A layer served as GeoJSON (no PMTiles archive) is checked for ids, and each served feature
    against its GEO geometry (area_difference) within geometry_tolerance (GEOJSON_AREA_DIFF, per dataset GEOJSON_AREA_DIFF_BY_DATASET).
    The sample depends only on the archive and `seed`."""
    import random

    import numpy as np
    import pyarrow.parquet as pq
    import shapely

    d = Path(analysis_dir) / m["path"]
    kind = m.get("geometry", "line")
    rng = random.Random(seed)
    pieces, seen = [], [0]

    def keep(fid, line, where):
        seen[0] += 1
        if len(pieces) < sample:
            pieces.append((fid, line, where))
        elif (j := rng.randrange(seen[0])) < sample:
            pieces[j] = (fid, line, where)

    out = {"ok": False, "pieces": [], "zoom": None, "missing": 0, "geo_max": 0.0, "tolerance": None}
    if kind not in ("line", "polygon", "point"):
        out["text"] = f"{ds}: [FAIL] unknown geometry {kind!r} in index.json"
        return out
    if layer is None:
        out["text"] = f"{ds}: [FAIL] no layer with an id_field in the tile manifest"
        return out
    tile_ids, tile_dups, complete, zoom, no_id, served_geom = set(), 0, True, None, 0, {}
    served, archives = served_paths(layer, layers_dir)
    geojson = served == "geojson"
    if not archives:
        out["text"] = f"{ds}: [FAIL] no served {'GeoJSON' if geojson else 'archive'} in {layers_dir} to check against"
        return out
    for path in archives:
        if geojson:
            with _open_text(path) as f:
                feats = json.load(f)["features"]
            zoom, st = "-", scan_features(feats, layer["id_field"])
            no_id += st.missing
            for ft in feats:
                fid = norm((ft.get("properties") or {}).get(layer["id_field"]))
                if fid is not None and ft.get("geometry"):
                    served_geom.setdefault(fid, ft["geometry"])
        else:
            zoom, st = scan_pmtiles(path, layer["id_field"], bool(layer.get("native_id")),
                                    None, max_tiles, keep)
        tile_dups += st.dups + len(tile_ids & st.ids)
        tile_ids |= st.ids
        complete &= st.complete
    idx = pq.read_table(d / m["idx"]["name"], columns=["fid", "row"]).to_pydict()
    idx_ids = [norm(v) for v in idx["fid"]]
    idx_set = set(idx_ids)
    idx_dups = len(idx_ids) - len(idx_set)
    missing = len(tile_ids - idx_set)
    extras = len(idx_set - tile_ids) if complete else "n/a"
    geo_fid = [norm(v) for e in m["geo"]
               for v in pq.read_table(d / e["name"], columns=["fid"]).column("fid").to_pylist()]
    pick = rng.sample(range(len(idx_ids)), min(sample, len(idx_ids)))
    bad_ptr = sum(not 0 <= idx["row"][i] < len(geo_fid) or geo_fid[idx["row"][i]] != idx_ids[i]
                  for i in pick)
    bad_chain = 0
    if m.get("chains"):
        ch = pq.read_table(d / m["chains"]["name"]).to_pydict()
        chain_of = dict(zip(idx_ids, pq.read_table(d / m["idx"]["name"], columns=["chain"])
                            .column("chain").to_pylist()))
        for i in rng.sample(range(len(ch["fid"])), min(sample, len(ch["fid"]))):
            f = norm(ch["fid"][i])
            bad_chain += geo_fid[ch["row"][i]] != f or chain_of.get(f) != ch["chain"][i]
    # tile pieces against their GEO geometry
    row_of = dict(zip(idx_ids, idx["row"]))
    want = {}
    for fid, line, where in pieces:
        if fid in row_of:
            want.setdefault(row_of[fid], []).append((json.loads(line)["geometry"], where))
    for fid, geom in served_geom.items():
        if fid in row_of:
            want.setdefault(row_of[fid], []).append((geom, None))
    tol = geometry_tolerance(ds, m, served, layer)
    worst, edge_worst, both_empty, thin, kinds = [], [], 0, 0, set()
    for e in m["geo"]:
        pf = pq.ParquetFile(d / e["name"])
        meta = json.loads((pf.schema_arrow.metadata or {}).get(b"geo", b"{}"))
        for gt in (meta.get("columns", {}).get("geometry", {}).get("geometry_types") or []):
            kinds.add({"Point": "point", "MultiPoint": "point", "LineString": "line",
                       "MultiLineString": "line", "Polygon": "polygon",
                       "MultiPolygon": "polygon"}.get(gt.removesuffix(" Z"), gt))
        lo, hi = e["row_offset"], e["row_offset"] + e["rows"]
        rows = [r for r in want if lo <= r < hi]
        if not rows:
            continue
        wkb = pq.read_table(d / e["name"], columns=["geometry"]).column("geometry").take(
            np.array(rows) - lo).to_pylist()
        geoms = shapely.from_wkb(wkb)
        kinds |= {KIND_OF_TYPE.get(int(t), f"type {t}") for t in shapely.get_type_id(geoms)}
        for r, g in zip(rows, geoms):
            for piece, where in want[r]:
                t = shapely.from_geojson(json.dumps(piece))
                if geojson:
                    worst.append(area_difference(t, g))
                elif kind == "polygon":
                    dist, why = polygon_compare(t, g, zoom, where)
                    if dist is None:
                        both_empty += why == "empty"
                        thin += why == "thin"
                        continue
                    worst.append(dist)
                else:
                    inner, edge = tile_vs_geo_units(t, g, zoom, where if kind == "line" else None)
                    if inner is not None:
                        worst.append(inner)
                    if edge is not None:
                        edge_worst.append(edge)
    wrong_kind = sorted(kinds - {kind})
    worst.sort()
    geo_max = worst[-1] if worst else 0.0
    geo_p99 = worst[int(0.99 * (len(worst) - 1))] if worst else 0.0
    edge_max = max(edge_worst, default=0.0)
    ok = (not (missing or no_id or idx_dups or tile_dups or bad_ptr or bad_chain or wrong_kind)
          and (tol is None or geo_max <= tol) and edge_max <= EDGE_TOLERANCE_UNITS)
    measure = "opened" if kind == "polygon" else "interior max"
    if geojson and tol is None:
        tail = f", area difference max {geo_max:.4f} (geometry not judged: simplified at build)"
    elif geojson:
        tail = f", area difference max {geo_max:.4f} (≤ {tol})"
    elif tol is None:
        tail = (f", {measure} {geo_max:.3f} p99 {geo_p99:.3f} grid units "
                "(geometry not judged: tiles simplified at max zoom)")
    elif kind != "polygon":
        tail = (f", {measure} {geo_max:.3f} p99 {geo_p99:.3f} (≤ {tol}), edge max {edge_max:.3f} "
                f"(≤ {EDGE_TOLERANCE_UNITS}) grid units")
    else:
        tail = f", {measure} {geo_max:.3f} p99 {geo_p99:.3f} grid units (≤ {tol})"
    out.update(ok=ok, pieces=[(f, json.loads(ln)["geometry"], w) for f, ln, w in pieces],
               zoom=zoom, missing=missing, geo_max=geo_max, edge_max=edge_max, tolerance=tol,
               text=f"{ds} ({kind}): {'GeoJSON' if geojson else f'tiles z{zoom}'} {len(tile_ids)} ids "
                    f"({'complete' if complete else 'sampled'}), "
                    f"IDX {len(idx_ids)} rows · missing {missing} · IDX extras {extras} · "
                    f"IDX dups {idx_dups} · tile dups {tile_dups} · pointer errors {bad_ptr}/{len(pick)} · "
                    f"chain errors {bad_chain} · "
                    + (f"[FAIL] GEO holds {', '.join(wrong_kind)}, index.json says {kind} · " if wrong_kind else "")
                    + (f"served features without an id {no_id} · " if no_id else "")
                    + (f"served GeoJSON vs GEO {len(worst)} features" if geojson else f"tile vs GEO {len(worst)} pieces")
                    + (f" ({', '.join(x for x in (f'{both_empty} empty inside the tile' if both_empty else '', f'{thin} thinner than 2 units' if thin else '') if x)} — not compared)"
                       if both_empty or thin else "")
                    + f"{tail} · {'OK' if ok else 'FAIL'}")
    return out


def check_lines(analysis_dir, layers_dir, manifest, sample=1000, max_tiles=0, seed=1, only=None):
    """Every index.json dataset (or those in `only`) against its served archive:
    every served tile id in IDX (0 missing), no duplicate in IDX, IDX and CHAINS
    rows pointing at the GEO row of their fid, and a sample of tile pieces on
    their GEO geometry — lines and points within INTERIOR_TOLERANCE_UNITS of it (edge
    vertices within EDGE_TOLERANCE_UNITS),
    polygons (manifest `geometry`) within POLYGON_TOLERANCE_UNITS once both are
    clipped to the piece's tile. Prints a line per dataset; returns True if clean."""
    index = json.loads((Path(analysis_dir) / "index.json").read_text())
    layers = {L["id"]: L for L in load_layers(manifest)}
    clean = True
    for ds, m in sorted(index["datasets"].items()):
        if only and ds not in only:
            continue
        r = check_dataset(ds, m, analysis_dir, layers.get(ds), layers_dir, sample, max_tiles, seed)
        clean &= r["ok"]
        print(r["text"])
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
        ok = check_lines(args.analysis_dir, args.layers_dir, args.manifest, args.sample, args.max_tiles,
                         only={args.only} if args.only else None)
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
