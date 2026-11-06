#!/usr/bin/env python3
"""Build the national building + aviation observations for drawn route reports.

Buildings: one GeoParquet per state, streamed tile by tile from the national-structures
work cache (build_route_buildings_national.py), Hilbert-ordered, lon/lat WKB with a bbox
covering. A record is a footprint piece (a building cut at a 64-cell tile edge appears in
each tile): ids are `<ST>:<tile>:<ordinal>`, unique by construction; the manifest says
`id_kind: "piece"` and gives `piece_inflation` per file. Class is the cache's group
(Residential / Nonresidential / Unknown); the cache holds no per-record image date, so
`image_date` is an all-null column and the imagery years come from each state's manifest.
Row groups hold 16,384 rows with statistics on the four bbox columns only; a state whose
footer exceeds 1.5 MiB or whose largest row group exceeds 12 MiB is rewritten at 8,192
then 4,096 rows.
Aviation: national NTAD facilities (closed ones kept, with status), runways and paired
runway ends from the fetch_route_inputs.py `ntad` step, with ADDS instrument-procedure flags.
Output: an immutable generation `<root>/<hex id>/` plus `<root>/manifest.json` (version 2)
as the pointer; `--link` points data/route/report/screening at the root.
Dependencies for a build: shapely, pyproj, numpy, pyarrow. Manifest, aviation and promotion
checks run with the standard library alone.
"""
import argparse
import collections
import datetime
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import time

import build_route_buildings as producer
import disk_guard

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache")
WORK_DIR = CACHE / "national-structures-work"
NTAD_DIR = CACHE / "route-raw/ntad"
OUTPUT_ROOT = CACHE / "route-screening"
LINK = ROOT / "data/route/report/screening"
GIB, MIB = 2 ** 30, 2 ** 20
NEED_BYTES = 25 * GIB
ROOT_FLOOR = 10 * GIB
ROW_GROUPS = (16384, 8192, 4096)
MAX_FOOTER, MAX_ROW_GROUP = int(1.5 * MIB), 12 * MIB
TILE = 64
RECORD = struct.Struct("<BI")
CLASSES = {0: "Residential", 1: "Nonresidential", 2: "Unknown"}
BBOX = ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"]
STATES = frozenset("AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())
NTAD = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
ADDS = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/"
AVIATION_SCOPE = "National NTAD aviation facilities and runways (closed facilities included, with status); instrument-procedure flag from FAA ADDS."


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha256(path):
    return producer.sha256_file(path)


def guard_disks(root):
    """The external cache disk keeps 25 GB headroom for the build; / must keep 10 GB (temp files live on the cache disk)."""
    disk_guard.require_free(root, NEED_BYTES)
    disk_guard.require_free("/", 0, ROOT_FLOOR)


# ---------------------------------------------------------------- aviation
def finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"invalid {label}")
    return float(value)


def text(value, label):
    if not isinstance(value, str) or not value or len(value) > 300:
        raise ValueError(f"invalid {label}")
    return value


def read_ntad(ntad_dir):
    """The four saved layers, each checked against the fetch manifest's hash and count."""
    ntad_dir = Path(ntad_dir)
    manifest = json.loads((ntad_dir / "ntad_manifest.json").read_text())
    tables = {}
    for name, entry in manifest["layers"].items():
        path = ntad_dir / f"{name}.jsonl"
        if sha256(path) != entry["sha256"]:
            raise ValueError(f"{name}: file differs from the fetch manifest")
        rows = [json.loads(line)["attributes"] for line in path.read_text().splitlines() if line]
        if len(rows) != entry["count"] or entry["count"] != entry["returnCountOnly"]:
            raise ValueError(f"{name}: record count differs from the service count")
        tables[name] = rows
    return manifest, tables


def aviation_from_ntad(manifest, tables, project):
    """Join facilities, runways, paired ends and ADDS flags; project points to EPSG:5070."""
    facilities, runways, ends, adds = (tables[k] for k in ("facilities", "runways", "runway_ends", "adds_airports"))
    cycle = manifest["eff_date"]
    datetime.datetime.strptime(cycle, "%Y/%m/%d")
    if {r.get("EFF_DATE") for t in (facilities, runways, ends) for r in t} != {cycle}:
        raise ValueError("mixed aviation effective cycles")
    by_id = {}
    for f in facilities:
        if text(f.get("ARPT_ID"), "facility id") in by_id:
            raise ValueError("duplicate aviation facility id")
        by_id[f["ARPT_ID"]] = f
    iap = collections.defaultdict(list)
    for a in adds:
        iap[a.get("IDENT")].append(a.get("IAPEXISTS"))

    def xy(row, lon="LONG_DECIMAL", lat="LAT_DECIMAL"):
        x, y = finite(row.get(lon), lon), finite(row.get(lat), lat)
        if not -180 <= x <= 180 or not -90 <= y <= 90:
            raise ValueError("invalid aviation coordinates")
        p = project(x, y)
        return [round(finite(p[0], "projected x"), 1), round(finite(p[1], "projected y"), 1)]

    inventory = []
    for f in facilities:
        flags = iap.get(f["ARPT_ID"])
        inventory.append({"id": f["ARPT_ID"], "siteNo": text(f.get("SITE_NO"), "site number"),
                          "name": text(f.get("ARPT_NAME"), "facility name"), "state": f.get("STATE_CODE"),
                          "country": f.get("COUNTRY_CODE"), "type": text(f.get("SITE_TYPE_CODE"), "facility type"),
                          "use": f.get("FACILITY_USE_CODE"), "status": text(f.get("ARPT_STATUS"), "facility status"),
                          "point": xy(f), "iap": None if not flags else int(any(v == 1 for v in flags))})
    grouped = collections.defaultdict(list)
    for e in ends:
        grouped[(e.get("SITE_NO"), e.get("RWY_ID"))].append(e)
    seen, rows, stats = set(), [], collections.Counter()
    for r in runways:
        k = (text(r.get("SITE_NO"), "site number"), text(r.get("RWY_ID"), "runway id"))
        if k in seen:
            raise ValueError("duplicate aviation runway")
        seen.add(k)
        facility = by_id.get(r.get("ARPT_ID"))
        if facility is None or facility["SITE_NO"] != k[0]:
            raise ValueError("runway facility join failed")
        ids, pair = k[1].split("/"), grouped.get(k, [])
        if len(ids) != 2 or len(pair) != 2 or {e.get("RWY_END_ID") for e in pair} != set(ids):
            raise ValueError("unpaired runway identifiers")
        pair.sort(key=lambda e: ids.index(e["RWY_END_ID"]))
        coords = [xy(e) for e in pair]
        for i, e in enumerate(pair, 1):
            if any(abs(finite(r.get(f"{a}{i}_DECIMAL"), "runway coordinate") - finite(e.get(b), b)) > 1e-8
                   for a, b in (("LONG", "LONG_DECIMAL"), ("LAT", "LAT_DECIMAL"))):
                stats["runway_end_coordinate_mismatch"] += 1
        declared = finite(r.get("RWY_LEN"), "runway length") * .3048
        width = finite(r.get("RWY_WIDTH"), "runway width")
        if declared <= 0 or width <= 0:
            raise ValueError("invalid runway size")
        if abs(math.dist(*coords) / declared - 1) >= .015:
            stats["runway_length_differs_over_1_5_percent"] += 1
        rows.append({"siteNo": k[0], "airport": r["ARPT_ID"], "runway": k[1], "ends": coords, "endIds": ids,
                     "elevationsFt": [None if e.get("RWY_END_ELEV") is None else finite(e["RWY_END_ELEV"], "elevation") for e in pair],
                     "surveyDates": [e.get("RWY_END_ELEV_DATE") or None for e in pair],
                     "elevationSources": [e.get("RWY_END_ELEV_SOURCE") or None for e in pair],
                     "declaredLengthM": round(declared, 2), "widthFt": width})
    points = [f["point"] for f in inventory] + [p for r in rows for p in r["ends"]]
    bounds = [min(p[0] for p in points) - 10_000, min(p[1] for p in points) - 10_000,
              max(p[0] for p in points) + 10_000, max(p[1] for p in points) + 10_000]
    meta = {"file": "aviation.json", "bounds5070": bounds, "cycle": cycle, "scope": AVIATION_SCOPE,
            "source": NTAD, "adds": ADDS, "fetchedAt": text(manifest.get("fetched"), "fetch date"),
            "credit": "Federal Aviation Administration; U.S. Department of Transportation Bureau of Transportation Statistics",
            "license": "Public domain, US federal work; acknowledge FAA/BTS",
            "counts": {"facilities": len(inventory), "runways": len(rows), "runwayEndsOutsidePairedRunways": len(ends) - 2 * len(rows),
                       "facilitiesWithIapFlag": sum(f["iap"] is not None for f in inventory), **dict(stats)},
            "layers": {n: {"url": e["url"], "sha256": e["sha256"], "count": e["count"]} for n, e in manifest["layers"].items()}}
    return {"version": 2, "cycle": cycle, "facilities": inventory, "runways": rows}, meta


# ---------------------------------------------------------------- buildings
def tile_rc(name):
    c, r = name.split(".")[0].split("_")
    return int(c), int(r)


def read_tile(path):
    import numpy as np
    import shapely
    blobs, groups = [], []
    with gzip.open(path, "rb") as f:
        while head := f.read(RECORD.size):
            g, n = RECORD.unpack(head)
            blobs.append(f.read(n))
            groups.append(g)
    return shapely.from_wkb(blobs), np.asarray(groups, np.uint8)


def count_records(path):
    """Independent record count: header walk only, no geometry decoding."""
    n = 0
    with gzip.open(path, "rb") as f:
        while head := f.read(RECORD.size):
            f.seek(RECORD.unpack(head)[1], 1)
            n += 1
    return n


def state_dir(work_dir, st):
    found = [p for p in Path(work_dir).glob(f"{st}-*") if p.is_dir() and not p.name.endswith(".stage")]
    if len(found) != 1:
        raise ValueError(f"{st}: expected one work-cache directory, found {len(found)}")
    return found[0]


def parquet_report(path):
    import pyarrow.parquet as pq
    md = pq.ParquetFile(path).metadata
    with open(path, "rb") as f:
        f.seek(-8, 2)
        footer = struct.unpack("<I", f.read(4))[0] + 8
    return {"rows": md.num_rows, "row_groups": md.num_row_groups, "footer_bytes": footer,
            "max_row_group_bytes": max((md.row_group(i).total_byte_size for i in range(md.num_row_groups)), default=0)}


def write_state(st, directory, output, rows_per_group, rss=lambda: 0):
    """Stream one state's tiles, Hilbert-ordered, into `output`. Returns rows and the tiles' 5070 bounds."""
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq
    import shapely
    from pyproj import Transformer
    import build_route_report_data as report
    import route_grid as G

    to_ll = Transformer.from_crs(5070, 4326, always_xy=True)
    tiles = sorted(json.loads((directory / "manifest.json").read_text())["files"])
    centres = np.array([to_ll.transform(G.X0 + (tile_rc(t)[0] + TILE / 2) * G.CELL, G.Y0 - (tile_rc(t)[1] + TILE / 2) * G.CELL) for t in tiles])
    order = np.argsort(report.hilbert(centres[:, 0], centres[:, 1]), kind="stable")
    box_type = pa.struct([(k, pa.float64()) for k in ("xmin", "ymin", "xmax", "ymax")])
    schema = pa.schema([("id", pa.string()), ("class", pa.string()), ("image_date", pa.string()),
                        ("bbox", box_type), ("geometry", pa.binary())],
                       metadata={"geo": canonical({"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
                           "encoding": "WKB", "geometry_types": ["Polygon", "MultiPolygon"],
                           "covering": {"bbox": {k: ["bbox", k] for k in ("xmin", "ymin", "xmax", "ymax")}}}}})})
    writer = pq.ParquetWriter(output, schema, compression="zstd", compression_level=9, write_statistics=BBOX,
                              use_dictionary=["class"], write_page_index=True)
    pending, held, total = [], 0, 0
    bounds = [math.inf, math.inf, -math.inf, -math.inf]
    try:
        for k, i in enumerate(order):
            name = tiles[i]
            c, r = tile_rc(name)
            geoms, groups = read_tile(directory / name)
            n = len(geoms)
            bounds = [min(bounds[0], G.X0 + c * G.CELL), min(bounds[1], G.Y0 - (r + TILE) * G.CELL),
                      max(bounds[2], G.X0 + (c + TILE) * G.CELL), max(bounds[3], G.Y0 - r * G.CELL)]
            co = shapely.get_coordinates(geoms)
            lon, lat = to_ll.transform(co[:, 0], co[:, 1])
            geoms = shapely.set_coordinates(geoms.copy(), np.column_stack([lon, lat]))
            boxes = shapely.bounds(geoms)
            o = np.argsort(report.hilbert((boxes[:, 0] + boxes[:, 2]) / 2, (boxes[:, 1] + boxes[:, 3]) / 2), kind="stable")
            geoms, boxes, groups = geoms[o], boxes[o], groups[o]
            ids = np.char.add(f"{st}:{name.split('.')[0]}:", o.astype(str))
            struct_box = pa.StructArray.from_arrays([pa.array(boxes[:, j]) for j in range(4)], names=["xmin", "ymin", "xmax", "ymax"])
            pending.append(pa.table({"id": pa.array(ids, pa.string()), "class": pa.array([CLASSES[g] for g in groups], pa.string()),
                                     "image_date": pa.nulls(n, pa.string()), "bbox": struct_box,
                                     "geometry": pa.array(shapely.to_wkb(geoms), pa.binary())}, schema=schema))
            held += n
            total += n
            if held >= rows_per_group:
                table = pa.concat_tables(pending)
                while table.num_rows >= rows_per_group:
                    writer.write_table(table.slice(0, rows_per_group), row_group_size=rows_per_group)
                    table = table.slice(rows_per_group)
                pending, held = ([table] if table.num_rows else []), table.num_rows
            if k % 200 == 0:
                log(st, f"tile {k}/{len(order)} rows {total:,} rss {rss()} MiB")
        if held:
            table = pa.concat_tables(pending)
            writer.write_table(table, row_group_size=table.num_rows)
    finally:
        writer.close()
    return total, bounds


def build_state(st, work_dir, stage, rows_options=ROW_GROUPS, rss=lambda: 0, max_footer=MAX_FOOTER, max_row_group=MAX_ROW_GROUP):
    """One state's file in `stage`; resumable by its sidecar. Verifies tile hashes and record counts first."""
    directory = state_dir(work_dir, st)
    meta = json.loads((directory / "manifest.json").read_text())
    meta_dir = stage.with_name(stage.name + ".meta")
    meta_dir.mkdir(exist_ok=True)
    side, final = meta_dir / f"{st}.json", stage / f"{st}.parquet"
    key = {"work": directory.name, "files": hashlib.sha256(canonical(meta["files"])).hexdigest(), "code": 2}
    if side.is_file() and final.is_file():
        done = json.loads(side.read_text())
        if done["key"] == key and final.stat().st_size == done["bytes"]:
            log(st, "already built")
            return done
    records = 0
    for name, digest in sorted(meta["files"].items()):
        if sha256(directory / name) != digest:
            raise ValueError(f"{st}: work-cache tile {name} differs from its manifest")
        records += count_records(directory / name)
    t0 = time.time()
    temp = stage / f"{st}.parquet.tmp"
    for rg in rows_options:
        rows, bounds = write_state(st, directory, temp, rg, rss)
        rep = parquet_report(temp)
        log(st, f"row_group_rows {rg}: footer {rep['footer_bytes']:,} B, max row group {rep['max_row_group_bytes']:,} B, rows {rows:,}")
        if rep["footer_bytes"] <= max_footer and rep["max_row_group_bytes"] <= max_row_group:
            break
        temp.unlink()
    else:
        raise ValueError(f"{st}: footer or row group over the limit even at {rows_options[-1]} rows")
    if rows != records or rep["rows"] != records:
        raise ValueError(f"{st}: parquet rows {rep['rows']} differ from the work-cache record count {records}")
    os.replace(temp, final)
    info = {"key": key, "state": st, "name": final.name, "bounds5070": bounds, "rows": records,
            "features": meta["features"], "pieces": records - meta["features"],
            "piece_inflation": round((records - meta["features"]) / meta["features"], 5) if meta["features"] else 0,
            "row_group_rows": rg, "row_groups": rep["row_groups"], "footer_bytes": rep["footer_bytes"],
            "max_row_group_bytes": rep["max_row_group_bytes"],
            "imageryYears": sorted(int(y) for y in meta["image_years"] if y.isdigit()),
            "imageryUnknownRecords": sum(v for y, v in meta["image_years"].items() if not y.isdigit()), "bytes": final.stat().st_size,
            "sha256": sha256(final), "workCache": directory.name, "seconds": round(time.time() - t0)}
    producer.atomic_json(side, info)
    return info


def verify_ids(directory, files):
    """Each id carries its file's state prefix and is unique within the file; no two files share a state."""
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    states = [f["state"] for f in files]
    if len(set(states)) != len(states):
        raise ValueError("two files claim the same state")
    for f in files:
        ids = pq.read_table(Path(directory) / f["name"], columns=["id"])["id"]
        if len(ids) != f["rows"]:
            raise ValueError(f"{f['name']}: row count differs from the manifest")
        if not pc.all(pc.starts_with(ids, f["state"] + ":")).as_py():
            raise ValueError(f"{f['name']}: id outside its state")
        if len(pc.unique(ids)) != len(ids):
            raise ValueError(f"{f['name']}: duplicate id")


def activate_generation(stage, output, manifest, replace=os.replace, digests=None):
    """Publish immutable files before the atomic pointer; previous readers retain their generation."""
    stage, output = Path(stage), Path(output)
    names = sorted(p.name for p in stage.iterdir() if p.is_file() and (p.suffix == ".parquet" or p.name == "aviation.json"))
    files = {n: (digests or {}).get(n) or sha256(stage / n) for n in names}
    bound = {**manifest, "files": files}
    generation = hashlib.sha256(canonical(bound)).hexdigest()[:32]
    value = {**bound, "version": 2, "generation": generation}
    producer.atomic_json(stage / "generation.json", value)
    output.mkdir(parents=True, exist_ok=True)
    target = output / generation
    if target.exists():
        if any(not (target / n).is_file() or sha256(target / n) != digest for n, digest in files.items()):
            raise ValueError("existing immutable generation is corrupt")
        if json.loads((target / "generation.json").read_text()) != value:
            raise ValueError("existing immutable generation metadata differs")
    else:
        replace(stage, target)
    producer.atomic_json(output / "manifest.json", value)
    return value


def link_report_dir(root, link=LINK):
    """Point `link` at the generation root, keeping any regional files already there beside it."""
    root, link = Path(root), Path(link)
    if link.is_symlink():
        if link.resolve() == root.resolve():
            return
        raise ValueError("the report link points elsewhere")
    if link.is_dir():
        moves = [(p, root / ("manifest.regional-v1.json" if p.name == "manifest.json" else p.name)) for p in link.iterdir()]
        if any(t.exists() for _, t in moves):
            raise ValueError("a regional file would overwrite a national one")
        for p, t in moves:
            shutil.move(str(p), t)
        link.rmdir()
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(root)


def build(work_dir, ntad_dir, root, states=None, rows_options=ROW_GROUPS):
    import resource
    from pyproj import Transformer

    root = Path(root)
    wanted = sorted(states or STATES)
    root.mkdir(parents=True, exist_ok=True)
    guard_disks(root)
    ntad_manifest, tables = read_ntad(ntad_dir)
    aircraft, aviation_meta = aviation_from_ntad(ntad_manifest, tables, Transformer.from_crs(4326, 5070, always_xy=True).transform)
    stage = root / f".stage-{hashlib.sha256(canonical({'states': wanted, 'ntad': ntad_manifest, 'rg': list(rows_options)})).hexdigest()[:16]}"
    stage.mkdir(exist_ok=True)
    rss = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    infos = []
    for st in wanted:
        guard_disks(root)
        i = build_state(st, work_dir, stage, rows_options, rss)
        infos.append(i)
        log(st, f"rows {i['rows']:,} footer {i['footer_bytes']:,} B max_rg {i['max_row_group_bytes']:,} B file {i['bytes'] / MIB:.0f} MiB peak rss {rss()} MiB")
    producer.atomic_json(stage / "aviation.json", aircraft)
    aviation_meta["sha256"] = sha256(stage / "aviation.json")
    keys = ("name", "state", "bounds5070", "rows", "features", "pieces", "piece_inflation", "row_group_rows", "row_groups",
            "footer_bytes", "max_row_group_bytes", "imageryYears", "imageryUnknownRecords", "bytes", "sha256", "workCache")
    files = [{k: i[k] for k in keys} for i in infos]
    verify_ids(stage, files)
    manifest = {"id_kind": "piece", "complete": set(wanted) == STATES,
                "buildings": {"files": files, "rows": sum(f["rows"] for f in files), "features": sum(f["features"] for f in files),
                              "pieces": sum(f["pieces"] for f in files),
                              "class_encoding": "cache group: Residential / Nonresidential (group 1, not a NONRESIDENTIAL_CLASSES name) / Unknown",
                              "image_date": "null column; the work cache keeps no per-record date, imagery years are per file",
                              "source": "USA Structures (FEMA/ORNL) state archives, via the national-structures work cache",
                              "credit": producer.CREDIT, "license": "CC BY 4.0"},
                "aviation": aviation_meta}
    digests = {f["name"]: f["sha256"] for f in files} | {"aviation.json": aviation_meta["sha256"]}
    result = activate_generation(stage, root, manifest, digests=digests)
    shutil.rmtree(stage.with_name(stage.name + ".meta"), ignore_errors=True)
    log(f"Generation {result['generation']}: {manifest['buildings']['rows']:,} rows in {len(files)} files, "
        f"{len(aircraft['facilities'])} facilities, {len(aircraft['runways'])} runways")
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--work-dir", type=Path, default=WORK_DIR)
    p.add_argument("--ntad-dir", type=Path, default=Path(os.environ.get("NTAD_DIR", NTAD_DIR)))
    p.add_argument("--output-dir", type=Path, default=OUTPUT_ROOT)
    p.add_argument("--states", help="comma-separated subset (dry run; needs a non-default --output-dir)")
    p.add_argument("--link", action="store_true", help="point data/route/report/screening at the output dir")
    args = p.parse_args()
    states = args.states.split(",") if args.states else None
    if states and (args.output_dir == OUTPUT_ROOT or args.link):
        sys.exit("a state subset needs its own --output-dir and is never linked")
    build(args.work_dir, args.ntad_dir, args.output_dir, states)
    if args.link:
        link_report_dir(args.output_dir)


if __name__ == "__main__":
    main()
