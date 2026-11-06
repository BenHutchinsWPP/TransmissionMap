#!/usr/bin/env python3
"""National observed footprint shares, from the FEMA/ORNL state ZIPs.

Role: extend built/nonres/bldgunk over the existing CONUS land grid. Process one
pair of states at a time into compressed, projected polygon shards, then dissolve all
states' roofs together per cell. Complete, hash-bound state caches are reusable.
Writes staged rasters and buildings_meta.json using the regional byte contract;
does not alter Homes, presets, the active cube or regional report inputs.
Deps: route_grid.py, build_route_buildings.py; numpy/shapely/pyogrio/rasterio.
Inputs: STRUCTURES_DIR/structures_zips.json + 49 ZIPs, the existing state.tif.
Usage: venv/bin/python scripts/build_route_buildings_national.py --source-dir PATH --work-dir PATH
Run under the Makefile's 16 GiB memory limit; keep work on the external data disk.
"""
import argparse
import collections
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import time
import zipfile

import build_route_buildings as B
import route_grid as G

STATES = frozenset("AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())
TILE = 64
BATCH = 1_000_000
CACHE_VERSION = 1
MAX_TILE_RECORDS = 1_000_000
MAX_TILE_BYTES = 512 * 1024 * 1024
MAX_CELL_INTERSECTIONS = 2_000_000
MAX_GEOMETRY_BYTES = 32 * 1024 * 1024
RECORD = struct.Struct("<BI")


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def runtime():
    global np, shapely, pyogrio, rasterio, Affine, Window
    import numpy as np
    import shapely
    import pyogrio
    import rasterio
    from rasterio.transform import Affine
    from rasterio.windows import Window


def source_inventory(source):
    """Require every state before allowing nationwide observed-empty values."""
    manifest = json.loads((source / "structures_zips.json").read_text())
    if set(manifest) != STATES:
        raise ValueError("national footprints require exactly 48 contiguous states plus DC")
    result = {}
    for st, entry in sorted(manifest.items()):
        name = entry.get("zip")
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".zip"):
            raise ValueError(f"{st}: invalid archive name")
        match = re.fullmatch(r"(?:([A-Z]{2})_Structures_(\d{8})|Deliverable(\d{8})([A-Z]{2}))\.zip", name)
        if not match or (match[1] or match[4]) != st or (match[2] or match[3]) != entry.get("deliverable"):
            raise ValueError(f"{st}: archive state or delivery date differs from manifest")
        url = entry.get("url", "")
        if not url.startswith("https://fema-femadata.s3.us-east-1.amazonaws.com/Partners/ORNL/USA_Structures/") or url.rsplit("/", 1)[-1] != name:
            raise ValueError(f"{st}: archive is not the declared FEMA source")
        path = source / name
        if type(entry.get("bytes")) is not int or entry["bytes"] <= 0 or path.stat().st_size != entry["bytes"]:
            raise ValueError(f"{st}: archive size differs from download manifest")
        for field in ("deliverable", "last_modified"):
            if not isinstance(entry.get(field), str) or not entry[field]:
                raise ValueError(f"{st}: missing source vintage")
        result[st] = {**entry, "sha256": B.sha256_file(path)}
        log(f"verified archive {st}: {entry['bytes'] / 1e6:.1f} MB")
    return result


def extract_archive(path, destination):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if any(Path(m.filename).is_absolute() or ".." in Path(m.filename).parts or "\\" in m.filename
               or (m.external_attr >> 16) & 0o170000 == 0o120000 for m in members):
            raise ValueError("unsafe path in structure archive")
        needed = sum(m.file_size for m in members)
        if needed > shutil.disk_usage(destination.parent).free - 2 * 1024**3:
            raise ValueError("insufficient disk space to extract the next state with 2 GiB reserve")
        archive.extractall(destination)
    gdbs = {destination / (m.filename.split(".gdb/")[0] + ".gdb")
            for m in members if ".gdb/" in m.filename}
    if len(gdbs) != 1:
        raise ValueError("structure archive must contain one geodatabase")
    return next(iter(gdbs))


def polygon_parts(geometries, groups):
    """Repair polygons while retaining their class through multipart expansion."""
    if np.any(shapely.is_missing(geometries) | shapely.is_empty(geometries)):
        raise ValueError("structure has missing or empty geometry")
    if not np.all(np.isfinite(shapely.get_coordinates(geometries))):
        raise ValueError("structure geometry has non-finite coordinates")
    valid = shapely.is_valid(geometries)
    repaired = int((~valid).sum())
    geometries = geometries.copy()
    geometries[~valid] = shapely.make_valid(geometries[~valid])
    if np.any(shapely.area(geometries) <= 0) or not np.all(shapely.is_valid(geometries)):
        raise ValueError("structure polygon repair lost its area")
    for _ in range(8):
        kinds = shapely.get_type_id(geometries)
        if np.all(kinds == 3):
            return geometries, groups, repaired
        geometries, parent = shapely.get_parts(geometries, return_index=True)
        groups = groups[parent]
        keep = np.isin(shapely.get_type_id(geometries), [3, 6, 7])
        geometries, groups = geometries[keep], groups[keep]
    raise ValueError("structure geometry collection nesting exceeds bound")


def tile_bounds(c, r):
    return (G.X0 + c * G.CELL, G.Y0 - min(r + TILE, G.ROWS) * G.CELL,
            G.X0 + min(c + TILE, G.COLS) * G.CELL, G.Y0 - r * G.CELL)


def spool_batch(geometries, groups, directory):
    """Assign full polygon interiors to every touched tile, including state edges."""
    bounds = shapely.bounds(geometries)
    keep = ((bounds[:, 2] > G.X0) & (bounds[:, 0] < G.X0 + G.COLS * G.CELL)
            & (bounds[:, 3] > G.Y0 - G.ROWS * G.CELL) & (bounds[:, 1] < G.Y0))
    geometries, groups, bounds = geometries[keep], groups[keep], bounds[keep]
    if not len(geometries):
        return
    x0 = np.maximum(0, np.floor((bounds[:, 0] - G.X0) / (TILE * G.CELL)).astype(np.int64))
    x1 = np.minimum((G.COLS - 1) // TILE, np.floor((bounds[:, 2] - G.X0) / (TILE * G.CELL)).astype(np.int64))
    y0 = np.maximum(0, np.floor((G.Y0 - bounds[:, 3]) / (TILE * G.CELL)).astype(np.int64))
    y1 = np.minimum((G.ROWS - 1) // TILE, np.floor((G.Y0 - bounds[:, 1]) / (TILE * G.CELL)).astype(np.int64))
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    counts = nx * ny
    if np.any(counts > 256):
        raise ValueError("one structure spans more than 256 processing tiles")
    parent = np.repeat(np.arange(len(geometries)), counts)
    offset = np.arange(len(parent)) - np.repeat(np.cumsum(counts) - counts, counts)
    cols = x0[parent] + offset % nx[parent]
    rows = y0[parent] + offset // nx[parent]
    ncols = math.ceil(G.COLS / TILE)
    tile_ids = rows * ncols + cols
    order = np.argsort(tile_ids, kind="stable")
    starts = np.r_[0, np.flatnonzero(np.diff(tile_ids[order])) + 1, len(order)]
    for a, b in zip(starts[:-1], starts[1:]):
        selected = order[a:b]
        c, r = int(cols[selected[0]]) * TILE, int(rows[selected[0]]) * TILE
        tile = tile_bounds(c, r)
        selected_bounds = bounds[parent[selected]]
        inside = ((selected_bounds[:, 0] >= tile[0]) & (selected_bounds[:, 1] >= tile[1])
                  & (selected_bounds[:, 2] <= tile[2]) & (selected_bounds[:, 3] <= tile[3]))
        clipped = geometries[parent[selected]].copy()
        clipped[~inside] = shapely.intersection(clipped[~inside], shapely.box(*tile))
        positive = shapely.area(clipped) > 0
        blobs = shapely.to_wkb(clipped[positive])
        kinds = groups[parent[selected]][positive]
        if not len(blobs):
            continue
        raw = bytearray()
        for group, blob in zip(kinds, blobs):
            if len(blob) > MAX_GEOMETRY_BYTES:
                raise ValueError("structure exceeds the geometry byte budget")
            raw.extend(RECORD.pack(int(group), len(blob)))
            raw.extend(blob)
        with gzip.open(directory / f"{c}_{r}.wkb.gz", "ab", compresslevel=1) as out:
            out.write(raw)


def spool_state(st, entry, source, work):
    work.mkdir(parents=True, exist_ok=True)
    identity = {"archive": entry, "tile": TILE, "version": CACHE_VERSION,
                "nonresidential_classes": list(G.NONRESIDENTIAL_CLASSES),
                "grid": [G.X0, G.Y0, G.CELL, G.COLS, G.ROWS]}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
    destination = work / f"{st}-{key}"
    pointer = destination / "manifest.json"
    if pointer.is_file():
        meta = json.loads(pointer.read_text())
        if meta.get("identity") != identity:
            raise ValueError(f"{st}: cached state identity differs")
        for name, digest in meta["files"].items():
            if Path(name).name != name or B.sha256_file(destination / name) != digest:
                raise ValueError(f"{st}: cached polygon shard differs")
        log(st, "using complete state cache", meta["features"], "records")
        return destination, meta
    stage = work / f"{st}-{key}.stage"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    try:
        extracted = stage / "source"
        gdb = extract_archive(source / entry["zip"], extracted)
        layers = [name for name, kind in pyogrio.list_layers(gdb) if kind and "Polygon" in kind]
        if len(layers) != 1:
            raise ValueError(f"{st}: expected one polygon layer")
        info = pyogrio.read_info(gdb, layer=layers[0])
        if not info["crs"] or not {"OCC_CLS", "IMAGE_DATE"}.issubset(info["fields"]):
            raise ValueError(f"{st}: structure fields or CRS are missing")
        if info["features"] <= 0:
            raise ValueError(f"{st}: empty state inventory")
        classes, years, repairs, count = collections.Counter(), collections.Counter(), 0, 0
        for offset in range(0, info["features"], BATCH):
            frame = pyogrio.read_dataframe(gdb, layer=layers[0], columns=["OCC_CLS", "IMAGE_DATE"],
                                            skip_features=offset, max_features=BATCH)
            if len(frame) != min(BATCH, info["features"] - offset):
                raise ValueError(f"{st}: truncated state read")
            names = frame["OCC_CLS"].fillna("Unknown").astype(str).to_numpy()
            classes.update(names.tolist())
            years.update(B.image_year(x) for x in frame["IMAGE_DATE"])
            groups = np.where(names == "Residential", 0, np.where(np.isin(names, G.NONRESIDENTIAL_CLASSES), 1, 2)).astype(np.uint8)
            geometries, groups, fixed = polygon_parts(frame.to_crs(G.CRS).geometry.to_numpy(), groups)
            repairs += fixed
            spool_batch(geometries, groups, stage)
            count += len(frame)
            log(st, f"{count:,}/{info['features']:,} records partitioned")
        if count != info["features"] or B.sha256_file(source / entry["zip"]) != entry["sha256"]:
            raise ValueError(f"{st}: source changed during processing")
        shutil.rmtree(extracted)
        files = {p.name: B.sha256_file(p) for p in sorted(stage.glob("*.wkb.gz"))}
        meta = {"identity": identity, "features": count, "classes": dict(classes), "image_years": dict(years),
                "repaired_geometries": repairs, "files": files}
        B.atomic_json(stage / "manifest.json", meta)
        stage.rename(destination)
        return destination, meta
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def read_tile(paths):
    blobs, groups, total = [], [], 0
    for path, digest in paths:
        if B.sha256_file(path) != digest:
            raise ValueError("polygon shard hash differs from complete state cache")
        with gzip.open(path, "rb") as src:
            while header := src.read(RECORD.size):
                if len(header) != RECORD.size:
                    raise ValueError("truncated polygon shard header")
                group, size = RECORD.unpack(header)
                total += RECORD.size + size
                if group > 2 or not 0 < size <= MAX_GEOMETRY_BYTES or total > MAX_TILE_BYTES or len(blobs) >= MAX_TILE_RECORDS:
                    raise ValueError("polygon shard exceeds tile budget or class contract")
                blob = src.read(size)
                if len(blob) != size:
                    raise ValueError("truncated polygon shard geometry")
                blobs.append(blob); groups.append(group)
    return shapely.from_wkb(blobs), np.asarray(groups, dtype=np.uint8)


def cell_shares(geometries, groups, c, r, land):
    """Dissolve each class once per tile; disjoint polygon areas add within cells."""
    h, w = land.shape
    arrays = {name: np.where(land, 1, 0).astype(np.uint8) for name in B.NAMES}
    if not len(geometries) or not np.any(land):
        return arrays
    yy, xx = np.indices((h, w))
    x, y = G.X0 + (c + xx.ravel()) * G.CELL, G.Y0 - (r + yy.ravel()) * G.CELL
    cells = shapely.box(x, y - G.CELL, x + G.CELL, y)
    merge = (getattr(shapely, "disjoint_subset_union_all", shapely.union_all)
             if shapely.geos_version >= (3, 12, 0) else shapely.union_all)
    for name, selected in (("built", np.ones(len(geometries), bool)), ("nonres", groups == 1), ("bldgunk", groups == 2)):
        if not np.any(selected):
            continue
        merged = merge(geometries[selected])
        parts, _, _ = polygon_parts(np.array([merged], dtype=object), np.zeros(1, dtype=np.uint8))
        bounds = shapely.bounds(parts)
        widths = np.minimum(w, np.ceil((bounds[:, 2] - G.X0) / G.CELL) - np.floor((bounds[:, 0] - G.X0) / G.CELL) + 1)
        heights = np.minimum(h, np.ceil((G.Y0 - bounds[:, 1]) / G.CELL) - np.floor((G.Y0 - bounds[:, 3]) / G.CELL) + 1)
        if np.sum(widths * heights) > MAX_CELL_INTERSECTIONS:
            raise ValueError("structure/cell intersections exceed the tile budget")
        cell_ids, feature_ids = shapely.STRtree(parts).query(cells)
        inside = ((bounds[feature_ids, 0] >= x[cell_ids]) & (bounds[feature_ids, 2] <= x[cell_ids] + G.CELL)
                  & (bounds[feature_ids, 1] >= y[cell_ids] - G.CELL) & (bounds[feature_ids, 3] <= y[cell_ids]))
        pieces = parts[feature_ids].copy()
        pieces[~inside] = shapely.intersection(cells[cell_ids[~inside]], pieces[~inside])
        shares = np.bincount(cell_ids, weights=shapely.area(pieces), minlength=h * w) / (G.CELL * G.CELL)
        if not np.all(np.isfinite(shares)) or np.any(shares < 0) or np.any(shares > 1 + 1e-8):
            raise ValueError("invalid dissolved national footprint area")
        arrays[name] = np.where(land.ravel(), 1 + np.ceil(100 * np.minimum(1, shares)), 0).astype(np.uint8).reshape(h, w)
    if any(not np.array_equal(a > 0, land) for a in arrays.values()) or np.any(arrays["nonres"] > arrays["built"]) or np.any(arrays["bldgunk"] > arrays["built"]):
        raise ValueError("national footprint share/mask contract differs")
    return arrays


def build(source, work, output, state_path):
    runtime()
    inventory = source_inventory(source)
    work.mkdir(parents=True, exist_ok=True)
    shards, states = collections.defaultdict(list), {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = pool.map(lambda item: spool_state(item[0], item[1], source, work), inventory.items())
        for (st, _), (directory, meta) in zip(inventory.items(), results):
            states[st] = {k: meta[k] for k in ("features", "classes", "image_years", "repaired_geometries")}
            for name, digest in meta["files"].items():
                shards[name].append((directory / name, digest))
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="buildings-national-stage-", dir=output))
    try:
        with rasterio.open(state_path) as state:
            if state.crs != rasterio.crs.CRS.from_epsg(5070) or state.transform != Affine.from_gdal(*G.transform()) or (state.width, state.height) != (G.COLS, G.ROWS):
                raise ValueError("state raster differs from routing lattice")
            profile = dict(driver="GTiff", width=G.COLS, height=G.ROWS, count=1, dtype="uint8", crs=G.CRS,
                           transform=state.transform, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                           compress="deflate", SPARSE_OK=True, BIGTIFF="IF_SAFER")
            import contextlib
            with contextlib.ExitStack() as stack:
                outputs = {n: stack.enter_context(rasterio.open(stage / (n + ".tif"), "w", **profile)) for n in B.NAMES}
                observed, positive = 0, collections.Counter()
                def calculate(c, r, land):
                    geometries, groups = read_tile(shards.get(f"{c}_{r}.wkb.gz", []))
                    return cell_shares(geometries, groups, c, r, land)

                with ThreadPoolExecutor(max_workers=min(6, os.cpu_count() or 1)) as pool:
                    for r in range(0, G.ROWS, TILE):
                        jobs = []
                        for c in range(0, G.COLS, TILE):
                            window = Window(c, r, min(TILE, G.COLS - c), min(TILE, G.ROWS - r))
                            land = state.read(1, window=window) > 0
                            if np.any(land):
                                jobs.append((window, int(land.sum()), pool.submit(calculate, c, r, land)))
                        for window, count, future in jobs:
                            arrays = future.result()
                            for n, a in arrays.items():
                                outputs[n].write(a, 1, window=window)
                                positive[n] += int((a > 1).sum())
                            observed += count
                        log(f"raster rows {min(r + TILE, G.ROWS)}/{G.ROWS}: {observed:,} observed land cells")
        identity = {"source": "FEMA/ORNL USA Structures state archives", "crs": 5070,
                    "fields": ["OCC_CLS", "IMAGE_DATE", "geometry"], "archives": inventory}
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        coverage = {"crs": 5070, "states": sorted(STATES), "rule": "CONUS state.tif land cells after processing all 49 state archives; no returned footprint is not verified vacancy"}
        checks = {"features": sum(s["features"] for s in states.values()), "states": states,
                  "observed_land_cells": observed, "positive_cells": dict(positive),
                  "repaired_geometries": sum(s["repaired_geometries"] for s in states.values())}
        meta = {"built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "coverage": coverage, "checks": checks,
                "provenance": {"identity": identity, "sha256": fingerprint, "feature_count": checks["features"],
                               "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((source / "structures_zips.json").stat().st_mtime))},
                "files": {n + ".tif": B.sha256_file(stage / (n + ".tif")) for n in B.NAMES},
                "bands": {n: {"b": list(G.PD_BANDS.values()).index(n) + 1, "source": "FEMA/ORNL USA Structures observed footprint shares, 49 CONUS state archives",
                              "credit": B.CREDIT, "licence": "CC BY 4.0", "coverage": coverage,
                              "value": "0 outside processed coverage; 1 no footprint returned; 2..101 upper-bound percent + 1"} for n in B.NAMES}}
        B.atomic_json(stage / "buildings_meta.json", meta)
        B.promote_files(stage, output, (*[n + ".tif" for n in B.NAMES], "buildings_meta.json"))
        log("national bands complete", json.dumps({k: v for k, v in checks.items() if k != "states"}))
        return meta
    finally:
        shutil.rmtree(stage)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-dir", type=Path, default=Path(os.environ.get("STRUCTURES_DIR") or B.ROOT / "data/raw/route/usa_structures"))
    p.add_argument("--work-dir", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, default=B.ROOT / "data/build/route/250m")
    p.add_argument("--state-raster", type=Path, default=B.ROOT / "data/build/route/250m/state.tif")
    p.add_argument("--audit", action="store_true", help="verify archive identity and size without processing")
    args = p.parse_args()
    if args.audit:
        inventory = source_inventory(args.source_dir)
        log("source audit", len(inventory), "states", sum(v["bytes"] for v in inventory.values()), "bytes")
    else:
        build(args.source_dir, args.work_dir, args.output_dir, args.state_raster)


if __name__ == "__main__":
    main()
