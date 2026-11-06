#!/usr/bin/env python3
"""check_geometry_parquet.py — hold the geometry files (data/analysis/, built by
build_line_parquet.py) to two references that share no code with the builder.

Reference 1, the build input as stored (data/build/world/<ds>.geojsonl.gz,
transmission_world.geojsonl.gz for OSM transmission; `--input DS=PATH` names
another; for railroads the raw GeoJSON at source precision, which the tiles read at precision 6), read with pyogrio alone: every input fid is in IDX exactly once (no
missing, duplicate or extra fid), each IDX `row` holds its fid in GEO and every
GEO row is pointed at by exactly one IDX row, each GEO geometry equals its input
geometry exactly (ring order, start vertex and direction aside; any moved vertex
fails) and its `bbox` covers it. Features without geometry are counted. GEO is
read one part at a time.

Reference 2, the served archive (`stable_ids.py --lines` for the dataset):
every max-zoom id is in IDX (IDX ids no tile carries are counted, not failed)
and the sampled tile pieces lie on their GEO geometry (polygons: each side opened
by one grid unit, its vertices within 2.5 z12 grid units of the other side's area, both
clipped to the piece's tile).

hifld_natgas_lines has no kept merge: its input is the tile build's GeoPackage
(<root>/../build/hifld_natgas_lines.gpkg), converted here with the system ogr2ogr, the
tool the tiles were built with, selecting the `fid` column and with
COORDINATE_PRECISION=6, then read as the others are. retail_territories, eia_ba,
nerc_regions, control_areas, crithab, padus, us_states, countries, admin1_boundaries, tribal_lands and us_zcta are read from their GeoPackages (<root>/../build/<name>.gpkg), and county_boundaries, bia_tribal_lands and boem_wind_leases from data/build/<name>.geojson, as stored,
and railroads (lines) from data/raw/railroads/narn_rail_lines.geojson, as stored,
at source precision, by pyogrio alone. The id columns and precision are written in
this file, not read from tile_manifest.yaml; test_check_geometry_parquet.py holds them to
the manifest's `id_field`, `src` and `precision`. No builder code is used.

A line dataset with no kept input (HIFLD) is listed and left to `stable_ids.py
--lines`; a polygon dataset without one fails.

`--mutate` checks the checks (on a polygon dataset that has a tolerance): it takes a polygon fid from reference 2's sample
and writes three scratch copies of the files (the real ones are only read): one
with a vertex of that polygon moved inward, one moved outward, one with the fid
dropped from IDX (both moves checked to leave the piece by more than the
tolerance; a copy holds index.json and that dataset only). It passes only when
both references catch all three (six catches).

Defaults follow --root: kept inputs in <root>/../build/world/, archives in
<root>/../layers/ (data/build/world and data/layers for data/analysis).

Exit status: 0 clean (with --mutate: six catches), 1 otherwise, 2 on a usage error.

Usage:
  python scripts/check_geometry_parquet.py --only osm_substations_polygons
  python scripts/check_geometry_parquet.py --only osm_substations_polygons --mutate
  python scripts/check_geometry_parquet.py --root assets/lines/fixtures/analysis --mutate
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_DIR = ROOT / "data" / "analysis"
MANIFEST = ROOT / "scripts" / "tile_manifest.yaml"
# Kept input file names under <build>/world/ that differ from <ds>.geojsonl.gz.
KEPT_NAME = {"osm_transmission_lines": "transmission_world.geojsonl.gz"}
# Each dataset's id column (tile_manifest.yaml `id_field`); the rest: fid.
ID_FIELD = {"hifld_transmission_lines": "ID", "retail_territories": "id", "eia_ba": "abbrev",
            "nerc_regions": "sub_nm", "control_areas": "id",
            "us_states": "stusps", "countries": "iso_a3", "admin1_boundaries": "code",
            "tribal_lands": "geoid", "us_zcta": "zcta5", "county_boundaries": "GEOID",
            "bia_tribal_lands": "LARID", "boem_wind_leases": "fid", "railroads": "FRAARCID",
            "crithab": "entity_id", "padus": "fid"}
# Datasets whose input is a GeoPackage under <build>/ (tile_manifest.yaml `src`); a value
# with a "/" is any OGR-readable file relative to the repo, read as stored.
GPKG_INPUT = {"hifld_natgas_lines": "hifld_natgas_lines.gpkg",
              "retail_territories": "retail_territories.gpkg",
              "eia_ba": "eia_ba.gpkg", "nerc_regions": "nerc_regions.gpkg",
              "control_areas": "control_areas.gpkg", "us_states": "us_states.gpkg",
              "countries": "countries.gpkg", "admin1_boundaries": "admin1_boundaries.gpkg",
              "tribal_lands": "tribal_lands.gpkg", "us_zcta": "us_zcta.gpkg",
              "county_boundaries": "data/build/county_boundaries.geojson",
              "bia_tribal_lands": "data/build/bia_tribal_lands.geojson",
              "boem_wind_leases": "data/build/boem_wind_leases.geojson",
              "railroads": "data/raw/railroads/narn_rail_lines.geojson",
              "crithab": "crithab.gpkg", "padus": "padus.gpkg"}
# The tile build's COORDINATE_PRECISION for the GeoPackages read through ogr2ogr; a
# GeoPackage not listed is read as stored.
GPKG_PRECISION = {"hifld_natgas_lines": 6}
for _ds, _v in GPKG_INPUT.items():
    if _v.endswith(".gz"):
        raise SystemExit(f"{_ds}: {_v} — a path input is not read gzipped")


def kept_input(ds, build_world):
    """The kept input of a dataset, gzipped or plain, or None."""
    if ds in GPKG_INPUT:
        v = GPKG_INPUT[ds]
        p = Path(build_world).parent.parent.parent / v if "/" in v else Path(build_world).parent / v
        return p if p.exists() else None
    name = KEPT_NAME.get(ds, f"{ds}.geojsonl.gz")
    for p in (Path(build_world) / name, Path(build_world) / name.removesuffix(".gz")):
        if p.exists():
            return p
    return None


def _id(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)




def geo_parts(d, m, columns=("fid", "bbox", "geometry")):
    """(first row, table) for each GEO part in row order, one part read at a time."""
    import pyarrow.parquet as pq
    n = 0
    for e in sorted(m["geo"], key=lambda e: e["row_offset"]):
        if e["row_offset"] != n:
            raise ValueError(f"{e['name']}: row_offset {e['row_offset']}, expected {n}")
        t = pq.read_table(Path(d) / e["name"], columns=list(columns))
        yield n, t
        n += t.num_rows


def geo_row(d, m, row):
    """The WKB of one GEO row."""
    for lo, t in geo_parts(d, m, ("geometry",)):
        if lo <= row < lo + t.num_rows:
            return t.column("geometry")[row - lo].as_py()
    raise IndexError(row)


def reference1(ds, m, root, src):
    """The geometry files against the kept input, one GEO part in memory at a time.
    Returns (ok, counts dict, text)."""
    import numpy as np
    import pyarrow.parquet as pq
    import pyogrio
    import shapely

    d = Path(root) / m["path"]
    field = ID_FIELD.get(ds, "fid")
    bad_frame = 0           # a GeoPackage read as stored must be EPSG:4326 and 2D
    if ds not in GPKG_PRECISION and (Path(src).suffix == ".gpkg" or "/" in GPKG_INPUT.get(ds, "")):
        info = pyogrio.read_info(str(src))
        bad_frame = int((info.get("crs") or "").upper() != "EPSG:4326" or "Z" in (info.get("geometry_type") or ""))
    with tempfile.TemporaryDirectory(prefix="geometry-check-") as scratch:
        path = f"/vsigzip/{src}" if str(src).endswith(".gz") else str(src)
        if Path(src).suffix == ".gpkg" and ds in GPKG_PRECISION:
            path = str(Path(scratch) / "input.geojsonl")
            subprocess.run(["ogr2ogr", "-f", "GeoJSONSeq", path, str(src), "-select", field,
                            "-lco", f"COORDINATE_PRECISION={GPKG_PRECISION[ds]}"], check=True)
        df = pyogrio.read_dataframe(path, columns=[field])
    geoms = np.asarray(df.geometry.values, dtype=object)
    has = ~(shapely.is_missing(geoms) | shapely.is_empty(geoms))
    if ds not in GPKG_PRECISION and ds in GPKG_INPUT and has.any() and shapely.has_z(geoms[has]).any():
        bad_frame = 1
    c = {"input rows": len(df), "no geometry": int((~has).sum()), "input not EPSG:4326 2D": bad_frame}
    ids = [_id(v) for v in df[field].tolist()]
    del df
    ref, in_dups = {}, 0        # fid → position in `geoms`
    for i in np.flatnonzero(has):
        if ids[i] in ref:
            in_dups += 1
        ref[ids[i]] = i
    del ids
    c["input dups"] = in_dups
    idx = pq.read_table(d / m["idx"]["name"], columns=["fid", "row"]).to_pydict()
    idx_ids = [_id(v) for v in idx["fid"]]
    idx_set = set(idx_ids)
    c.update({"IDX rows": len(idx_ids), "missing": len(ref.keys() - idx_set),
              "extra": len(idx_set - ref.keys()), "IDX dups": len(idx_ids) - len(idx_set)})
    pointed = {}                # GEO row → the IDX fid pointing at it
    shared = 0
    for f, r in zip(idx_ids, idx["row"]):
        shared += r in pointed
        pointed[r] = f
    del idx, idx_set
    geo_rows = geo_dups = unpointed = bad_bbox = 0
    geo_seen, mismatched, at = set(), [], {}
    for lo, t in geo_parts(d, m):
        fids = [_id(v) for v in t.column("fid").to_pylist()]
        geo_rows += len(fids)
        for j, f in enumerate(fids):
            geo_dups += f in geo_seen
            geo_seen.add(f)
            if (lo + j) in pointed:
                at[lo + j] = f
            else:
                unpointed += 1
        # every GEO row against the input row of its own fid
        keep = [j for j, f in enumerate(fids) if f in ref]
        if keep:
            r = geoms[[ref[fids[j]] for j in keep]]
            g = shapely.from_wkb(t.column("geometry").take(keep).to_pylist())
            eq = shapely.equals_exact(shapely.normalize(g), shapely.normalize(r), tolerance=0)
            mismatched += [fids[j] for j, e in zip(keep, eq) if not e]
            bb = t.column("bbox").take(keep).combine_chunks()
            b = shapely.bounds(r)
            inside = ((bb.field("xmin").to_numpy(zero_copy_only=False) <= b[:, 0])
                      & (bb.field("ymin").to_numpy(zero_copy_only=False) <= b[:, 1])
                      & (bb.field("xmax").to_numpy(zero_copy_only=False) >= b[:, 2])
                      & (bb.field("ymax").to_numpy(zero_copy_only=False) >= b[:, 3]))
            bad_bbox += int((~inside).sum())
        del t, fids
    bad_ptr = shared + sum(at.get(r) != f for r, f in pointed.items())
    c.update({"GEO rows": geo_rows, "GEO dups": geo_dups, "unpointed GEO rows": unpointed,
              "pointer errors": bad_ptr, "geometry mismatches": len(mismatched),
              "bbox errors": bad_bbox})
    ok = not any(c[k] for k in ("input not EPSG:4326 2D", "input dups", "missing", "extra", "IDX dups", "GEO dups",
                                "unpointed GEO rows", "pointer errors", "geometry mismatches",
                                "bbox errors")) and geo_rows == c["IDX rows"]
    text = (f"{ds}: reference 1 (kept input {Path(src).name}): "
            + " · ".join(f"{k} {v}" for k, v in c.items())
            + (f" (e.g. {', '.join(mismatched[:3])})" if mismatched else "")
            + f" · {'OK' if ok else 'FAIL'}")
    return ok, c, text


def reference2(ds, m, root, layers_dir, manifest, sample, max_tiles):
    """The geometry files against the served archive (stable_ids.check_dataset)."""
    import stable_ids
    layer = next((L for L in stable_ids.load_layers(manifest) if L["id"] == ds), None)
    return stable_ids.check_dataset(ds, m, root, layer, layers_dir, sample, max_tiles)


# ── --mutate ────────────────────────────────────────────────────────────────


def moved(g, part, k, xy):
    """`g` (Polygon or MultiPolygon) with vertex k of part `part`'s exterior ring at xy."""
    import shapely
    parts = list(shapely.get_parts(g))
    poly = parts[part]
    shell = [tuple(c) for c in poly.exterior.coords]
    shell[k] = xy
    parts[part] = shapely.Polygon(shell, [list(r.coords) for r in poly.interiors])
    return parts[0] if g.geom_type == "Polygon" else shapely.MultiPolygon(parts)


def pick_vertex(r2, m, root):
    """(fid, GEO row, part, vertex index, inward lon/lat, outward lon/lat) for a
    polygon vertex inside a sampled piece's tile, moved half its distance to the
    part's centroid, where both moves leave the piece by more than the tolerance
    (as reference 2 measures it), or None."""
    import numpy as np
    import pyarrow.parquet as pq
    import shapely
    import stable_ids as si

    d = Path(root) / m["path"]
    idx = pq.read_table(d / m["idx"]["name"], columns=["fid", "row"]).to_pydict()
    row_of = {_id(f): r for f, r in zip(idx["fid"], idx["row"])}
    z, tol = r2["zoom"], r2["tolerance"]
    for fid, piece, where in sorted(r2["pieces"], key=lambda p: (p[0], p[2])):
        if fid not in row_of:
            continue
        x0, y0, x1, y1 = si.tile_box(where)
        tile = shapely.from_geojson(json.dumps(piece))
        g = shapely.from_wkb(geo_row(d, m, row_of[fid]))
        for pi, part in enumerate(shapely.get_parts(g)):
            ring = si.mercator_units(np.asarray(part.exterior.coords), z)
            c = si.mercator_units(np.asarray(part.centroid.coords), z)[0]
            for k in range(1, len(ring) - 1):
                v = ring[k]
                inw, outw = v + (c - v) / 2, v - (c - v) / 2
                if not all(x0 < p[0] < x1 and y0 < p[1] < y1 for p in (v, inw, outw)):
                    continue
                ll = [tuple(p) for p in si.lonlat(np.array([inw, outw]), z).round(6)]
                if all((dist := si.polygon_vs_geo_units(tile, moved(g, pi, k, p), z, where)) is not None
                       and dist > tol for p in ll):
                    return fid, row_of[fid], pi, k, ll[0], ll[1]
    return None


def write_moved(root, m, row, part, k, xy):
    """Rewrite the GEO part holding `row` with vertex k of the part's exterior ring at xy."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    import shapely
    e = next(e for e in m["geo"] if e["row_offset"] <= row < e["row_offset"] + e["rows"])
    p = Path(root) / m["path"] / e["name"]
    t = pq.read_table(p)
    col = t.column("geometry").to_pylist()
    j = row - e["row_offset"]
    col[j] = shapely.to_wkb(moved(shapely.from_wkb(col[j]), part, k, xy))
    i = t.schema.get_field_index("geometry")
    t = t.set_column(i, t.schema.field(i), pa.array(col, type=t.schema.field(i).type))
    pq.write_table(t, p)


def write_dropped(root, m, fid):
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    p = Path(root) / m["path"] / m["idx"]["name"]
    t = pq.read_table(p)
    keep = pc.not_equal(pc.cast(t.column("fid"), "string"), fid)
    pq.write_table(t.filter(keep), p)


def mutate(ds, m, root, src, layers_dir, manifest, sample, max_tiles):
    """Six catches or not: returns True when both references catch all three.
    Each scratch copy holds index.json and this dataset's directory only."""
    r2 = reference2(ds, m, root, layers_dir, manifest, sample, max_tiles)
    got = pick_vertex(r2, m, root)
    if got is None:
        print(f"{ds}: [FAIL] no sampled polygon vertex whose move leaves its piece by > {r2['tolerance']} units")
        return False
    fid, row, part, k, inward, outward = got
    print(f"{ds}: mutating fid {fid} (GEO row {row}, part {part}, vertex {k})")
    catches = 0
    for name, apply in (("vertex moved inward", lambda d: write_moved(d, m, row, part, k, inward)),
                        ("vertex moved outward", lambda d: write_moved(d, m, row, part, k, outward)),
                        ("fid dropped from IDX", lambda d: write_dropped(d, m, fid))):
        with tempfile.TemporaryDirectory(prefix="geometry-check-") as tmp:
            scratch = Path(tmp) / "analysis"
            scratch.mkdir()
            shutil.copyfile(Path(root) / "index.json", scratch / "index.json")
            shutil.copytree(Path(root) / m["path"], scratch / m["path"])
            apply(scratch)
            ok1, c1, _ = reference1(ds, m, scratch, src)
            r = reference2(ds, m, scratch, layers_dir, manifest, sample, max_tiles)
            dropped = name.startswith("fid")
            hit1 = c1["missing"] > 0 if dropped else c1["geometry mismatches"] > 0
            hit2 = r["missing"] > 0 if dropped else r["geo_max"] > r["tolerance"]
            for ref, hit, why in ((1, hit1, f"missing {c1['missing']}" if dropped
                                   else f"geometry mismatches {c1['geometry mismatches']}"),
                                  (2, hit2, f"missing {r['missing']}" if dropped
                                   else f"polygon distance {r['geo_max']:.3f} > {r['tolerance']}")):
                print(f"  {'catch' if hit else 'MISSED'}: {name}, reference {ref} ({why})")
                catches += hit
    print(f"{ds}: {catches}/6 catches")
    return catches == 6


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    ap.add_argument("--root", default=str(ANALYSIS_DIR), help="the analysis directory (index.json)")
    ap.add_argument("--only", help="check only this dataset")
    ap.add_argument("--input", action="append", default=[], metavar="DS=PATH",
                    help="the kept input of a dataset (default <root>/../build/world/)")
    ap.add_argument("--layers-dir", help="served archives (default <root>/../layers)")
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--sample", type=int, default=1000, help="reference 2: rows and tile pieces sampled")
    ap.add_argument("--max-tiles", type=int, default=0, help="reference 2: stop after N tiles (0: all)")
    ap.add_argument("--mutate", action="store_true", help="check that both references catch planted errors")
    args = ap.parse_args(argv)
    root = Path(args.root)
    if not (root / "index.json").exists():
        ap.error(f"{root}/index.json not found")
    layers_dir = Path(args.layers_dir) if args.layers_dir else root.parent / "layers"
    inputs = {}
    for spec in args.input:
        ds, sep, p = spec.partition("=")
        if not sep:
            ap.error(f"--input {spec!r}: expected DS=PATH")
        inputs[ds] = Path(p)
    datasets = json.loads((root / "index.json").read_text())["datasets"]
    if args.only and args.only not in datasets:
        ap.error(f"no dataset {args.only!r} in {root}/index.json")
    todo = []
    for ds, m in sorted(datasets.items()):
        if args.only and ds != args.only:
            continue
        src = inputs.get(ds) or kept_input(ds, root.parent / "build" / "world")
        if src is None or not Path(src).exists():
            if args.only or m.get("geometry") == "polygon":
                print(f"{ds}: [FAIL] no kept input (give --input {ds}=PATH)")
                return 1
            print(f"{ds}: not checked here, no kept input (stable_ids.py --lines holds it to the tiles)")
            continue
        todo.append((ds, m, src))
    if not todo:
        print("FAIL: no dataset with a kept input to check")
        return 1
    clean = True
    for ds, m, src in todo:
        ok1, _, text = reference1(ds, m, root, src)
        print(text, flush=True)
        r2 = reference2(ds, m, root, layers_dir, args.manifest, args.sample, args.max_tiles)
        print(f"{ds}: reference 2 (served archive): {r2['text']}", flush=True)
        clean &= ok1 and r2["ok"]
    if not clean:
        print("\nFAIL: the geometry files differ from a reference")
        return 1
    if args.mutate:
        import stable_ids
        layers = {L["id"]: L for L in stable_ids.load_layers(args.manifest)}
        polys = [t for t in todo if t[1].get("geometry", "line") == "polygon" and t[0] in layers
                 and stable_ids.geometry_tolerance(
                     t[0], t[1], served := stable_ids.served_paths(layers[t[0]], layers_dir)[0], layers[t[0]]) is not None
                 and served != "geojson"]
        if not polys:
            print("\nFAIL: --mutate needs a polygon dataset with a kept input and a tolerance")
            return 1
        ds, m, src = polys[0]
        ok = mutate(ds, m, root, src, layers_dir, args.manifest, args.sample, args.max_tiles)
        print("\nOK: both references caught every planted error" if ok
              else "\nFAIL: a planted error went uncaught")
        return 0 if ok else 1
    print("\nOK: the geometry files match the kept input and the tiles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
