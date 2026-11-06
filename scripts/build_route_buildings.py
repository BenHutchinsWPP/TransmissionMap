#!/usr/bin/env python3
"""Observed building footprint shares on the routing lattice.

Role: fetch a bounded USA Structures snapshot by verified object-id batches, then
write built/nonres/bldgunk uint8 rasters and buildings_meta.json. Coverage is the
declared queried EPSG:5070 rectangle, not verified absence of buildings. Only
fully covered land cells receive values. Positive shares round upward so even a
small observed roof survives; Homes is produced separately and is untouched.
Deps: route_grid.py; GDAL/OGR and numpy for geometry/raster work. Fetch tests and
manifest validation run with the standard library alone.
Usage: /usr/bin/python3 scripts/build_route_buildings.py --fetch --bbox W S E N
       /usr/bin/python3 scripts/build_route_buildings.py --input roofs.geojson --bounds XMIN YMIN XMAX YMAX
"""
import argparse
import collections
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0"
FIELDS = "OBJECTID,UUID,OCC_CLS,IMAGE_DATE,PROD_DATE,SOURCE"
NAMES = ("built", "nonres", "bldgunk")
MAX_CELLS, MAX_FEATURES, BATCH = 100_000, 250_000, 256
CREDIT = "Oak Ridge National Laboratory (ORNL); Federal Emergency Management Agency (FEMA) Geospatial Response Office"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, separators=(",", ":"), allow_nan=False)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024*1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def promote_files(stage, output_dir, names, replace=None):
    """Retain previous files until promotion completes; restore them on failure.

    Hashes in the metadata also bind the generation if the process is killed
    without unwinding this rollback.
    """
    stage, output_dir = Path(stage), Path(output_dir)
    previous = stage / "previous"
    previous.mkdir()
    existed = {name for name in names if (output_dir/name).exists()}
    replace = replace or os.replace
    try:
        for name in names:
            if name in existed:
                replace(output_dir/name, previous/name)
        for name in names:
            replace(stage/name, output_dir/name)
    except BaseException:
        for name in names:
            if (previous/name).exists():
                os.replace(previous/name, output_dir/name)
            elif name not in existed:
                (output_dir/name).unlink(missing_ok=True)
        raise


def request(url, params):
    encoded = urllib.parse.urlencode(params)
    target = url + "?" + encoded
    # Hosted GIS proxies can reject long object-ID URLs; queries also accept form POST.
    if len(target) > 1800:
        target = urllib.request.Request(url, data=encoded.encode("utf-8"),
                                       headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(target, timeout=60) as response:
        value = json.load(response)
    return value


def reply(transport, url, params):
    value = transport(url, params)
    if not isinstance(value, dict) or "error" in value or value.get("exceededTransferLimit"):
        raise ValueError("building service returned an error or truncated response")
    return value


def edit_state(meta):
    edits = meta.get("editingInfo")
    if not isinstance(edits, dict) or not any(edits.get(k) is not None for k in ("lastEditDate", "dataLastEditDate")):
        raise ValueError("building service has no verifiable edit state")
    if meta.get("objectIdField") != "OBJECTID" or meta.get("geometryType") != "esriGeometryPolygon":
        raise ValueError("building service schema differs from OBJECTID polygon contract")
    return {"editingInfo": edits, "serviceItemId": meta.get("serviceItemId"), "currentVersion": meta.get("currentVersion")}


def check_bounds(bounds):
    if len(bounds) != 4 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in bounds):
        raise ValueError("bounds must be four finite EPSG:5070 coordinates")
    x0, y0, x1, y1 = bounds
    if not (x0 < x1 and y0 < y1):
        raise ValueError("bounds must have positive width and height")
    c0, r0 = G.cell_of(x0, y1)
    c1 = math.ceil((x1 - G.X0) / G.CELL)
    r1 = math.ceil((G.Y0 - y0) / G.CELL)
    if c0 < 0 or r0 < 0 or c1 > G.COLS or r1 > G.ROWS or (c1-c0)*(r1-r0) > MAX_CELLS:
        raise ValueError("building region is outside the routing grid or exceeds 100000 cells")
    return c0, r0, c1, r1


def validate_snapshot(manifest, cache):
    if manifest.get("complete") is not True or manifest.get("identity", {}).get("source") != SOURCE:
        raise ValueError("building snapshot is incomplete or has the wrong source")
    identity = manifest["identity"]
    if identity.get("crs") != 5070 or identity.get("fields") != FIELDS or not isinstance(identity.get("edit_state"), dict):
        raise ValueError("building snapshot CRS, fields or edit-state contract differs")
    bounds = identity["bounds"]
    check_bounds(bounds)
    rel = Path(manifest["features"])
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("building snapshot feature path must stay inside its cache")
    path = Path(cache) / rel
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest.get("sha256"):
        raise ValueError("building snapshot hash differs from its complete manifest")
    data = json.loads(raw)
    if data.get("spatialReference", {}).get("wkid") != 5070:
        raise ValueError("building snapshot must be EPSG:5070")
    ids = [f.get("attributes", {}).get("OBJECTID") for f in data.get("features", [])]
    if any(type(i) is not int for i in ids) or len(ids) > MAX_FEATURES or len(ids) != len(set(ids)) or sorted(ids) != manifest.get("object_ids"):
        raise ValueError("building snapshot IDs are missing or duplicated")
    return path


def fetch_snapshot(bounds, cache, transport=request, original_bbox=None):
    check_bounds(bounds)
    cache = Path(cache)
    before = edit_state(reply(transport, SOURCE, {"f": "json"}))
    identity = {"source": SOURCE, "bounds": list(bounds), "crs": 5070, "fields": FIELDS, "edit_state": before}
    pointer = cache / "manifest.json"
    if pointer.exists():
        old = json.loads(pointer.read_text())
        if old.get("identity") == identity:
            try:
                validate_snapshot(old, cache)
            except (ValueError, KeyError, OSError, TypeError):
                pass
            else:
                if edit_state(reply(transport, SOURCE, {"f": "json"})) != before:
                    raise ValueError("building service changed while verifying cached snapshot")
                return old
    params = {"f": "json", "where": "1=1", "geometry": ",".join(map(str, bounds)),
              "geometryType": "esriGeometryEnvelope", "inSR": 5070,
              "spatialRel": "esriSpatialRelIntersects", "returnIdsOnly": "true"}
    selected = reply(transport, SOURCE + "/query", params).get("objectIds")
    if not isinstance(selected, list) or len(selected) > MAX_FEATURES or any(type(i) is not int for i in selected) or len(set(selected)) != len(selected):
        raise ValueError("building selection has invalid/duplicate IDs or exceeds 250000 features")
    ids = sorted(selected)
    features = []
    for offset in range(0, len(ids), BATCH):
        wanted = ids[offset:offset+BATCH]
        page = reply(transport, SOURCE + "/query", {"f": "json", "objectIds": ",".join(map(str, wanted)),
                     "outFields": FIELDS, "outSR": 5070, "returnGeometry": "true", "returnTrueCurves": "false"})
        sr = page.get("spatialReference", {})
        if sr.get("latestWkid", sr.get("wkid")) != 5070 or page.get("geometryType") != "esriGeometryPolygon":
            raise ValueError("building page geometry or CRS differs from request")
        got = page.get("features", [])
        actual = [f.get("attributes", {}).get("OBJECTID") for f in got]
        if len(actual) != len(wanted) or set(actual) != set(wanted):
            raise ValueError("building batch IDs are missing or duplicated")
        features.extend(got)
        print(f"building records {len(features)}/{len(ids)}", flush=True)
    if edit_state(reply(transport, SOURCE, {"f": "json"})) != before:
        raise ValueError("building service changed during snapshot fetch")
    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
    folder = Path(tempfile.mkdtemp(prefix=key + "-", dir=cache))
    try:
        feature_path = folder / "features.json"
        atomic_json(feature_path, {"geometryType": "esriGeometryPolygon", "spatialReference": {"wkid": 5070}, "features": features})
        manifest = {"complete": True, "identity": identity, "features": str(feature_path.relative_to(cache)),
                    "sha256": sha256_file(feature_path), "object_ids": ids,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "original_bbox": original_bbox}
        validate_snapshot(manifest, cache)
        atomic_json(folder / "manifest.json", manifest)
        atomic_json(pointer, manifest)
    except BaseException:
        shutil.rmtree(folder)
        raise
    return manifest


def gis():
    from osgeo import gdal, ogr, osr
    import numpy as np
    gdal.UseExceptions()
    ogr.UseExceptions()
    return gdal, ogr, osr, np


def rectangle(ogr, bounds):
    x0, y0, x1, y1 = bounds
    return ogr.CreateGeometryFromWkt(f"POLYGON(({x0} {y0},{x1} {y0},{x1} {y1},{x0} {y1},{x0} {y0}))")


def projected_bbox(bbox):
    _, ogr, osr, _ = gis()
    w, s, e, n = bbox
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ValueError("bbox must be ordered W S E N longitude/latitude")
    src, dst = osr.SpatialReference(), osr.SpatialReference()
    src.ImportFromEPSG(4326); dst.ImportFromEPSG(5070)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    p = rectangle(ogr, bbox)
    p.Segmentize(.01)
    p.Transform(osr.CoordinateTransformation(src, dst))
    x0, x1, y0, y1 = p.GetEnvelope()
    c0, r0, c1, r1 = check_bounds((x0, y0, x1, y1))
    return [G.X0+c0*G.CELL, G.Y0-r1*G.CELL, G.X0+c1*G.CELL, G.Y0-r0*G.CELL]


def polygon_parts(geometry, ogr):
    kind = geometry.GetGeometryName()
    if kind == "POLYGON":
        return [geometry]
    if kind in ("MULTIPOLYGON", "GEOMETRYCOLLECTION"):
        return [p for child in geometry for p in polygon_parts(child, ogr)]
    if geometry.IsEmpty():
        return []
    raise ValueError("building geometry is not polygonal")


def finite_coordinates(geometry):
    if any(not all(math.isfinite(x) for x in geometry.GetPoint(i)) for i in range(geometry.GetPointCount())):
        return False
    return all(finite_coordinates(child) for child in geometry)


def image_year(value):
    if value is None:
        return "Unknown"
    try:
        year = datetime.datetime.fromtimestamp(value/1000, datetime.timezone.utc).year if isinstance(value, (int,float)) else int(str(value)[:4])
        return str(year) if 1900 <= year <= datetime.date.today().year+1 else "Unknown"
    except (ValueError, OverflowError, OSError):
        return "Unknown"


def build_arrays(path, bounds, land):
    _, ogr, osr, np = gis()
    c0, r0, c1, r1 = check_bounds(bounds)
    if land.shape != (r1-r0, c1-c0):
        raise ValueError("state window differs from building region")
    ds = ogr.Open(str(path))
    if ds is None or ds.GetLayerCount() != 1:
        raise ValueError("building input must contain one readable feature layer")
    layer = ds.GetLayer()
    source_crs = layer.GetSpatialRef()
    if source_crs is None:
        raise ValueError("building input has no declared CRS")
    source_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target = osr.SpatialReference(); target.ImportFromEPSG(5070)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_crs, target)
    shape = land.shape
    arrays = {n: np.zeros(shape, dtype=np.uint8) for n in NAMES}
    region = rectangle(ogr, bounds)
    buckets = collections.defaultdict(lambda: collections.defaultdict(list))
    classes, years, repairs = collections.Counter(), collections.Counter(), 0
    count = 0
    for feature in layer:
        count += 1
        if count > MAX_FEATURES:
            raise ValueError("building input exceeds 250000 features")
        geom = feature.GetGeometryRef()
        if geom is None or geom.IsEmpty():
            raise ValueError("building has no usable geometry")
        geom = geom.Clone()
        if not finite_coordinates(geom):
            raise ValueError("building geometry has non-finite coordinates")
        geom.Transform(transform)
        envelope = geom.GetEnvelope()
        if not finite_coordinates(geom) or not all(math.isfinite(x) for x in envelope):
            raise ValueError("building geometry has non-finite coordinates")
        if not geom.IsValid():
            repairs += 1
            geom = geom.MakeValid()
        if not geom.IsValid() or not polygon_parts(geom, ogr):
            raise ValueError("building polygon repair failed")
        cls = feature.GetField("OCC_CLS") if feature.GetFieldIndex("OCC_CLS") >= 0 else None
        classes[str(cls) if cls else "Unknown"] += 1
        group = None if cls == "Residential" else "nonres" if cls in G.NONRESIDENTIAL_CLASSES else "bldgunk"
        image = feature.GetField("IMAGE_DATE") if feature.GetFieldIndex("IMAGE_DATE") >= 0 else None
        years[image_year(image)] += 1
        clipped = geom.Intersection(region)
        if clipped.IsEmpty() or clipped.GetArea() <= 0:
            continue
        x0, x1, y0, y1 = clipped.GetEnvelope()
        ca, ra = G.cell_of(x0, y1)
        cb = math.ceil((x1-G.X0)/G.CELL)
        rb = math.ceil((G.Y0-y0)/G.CELL)
        for r in range(max(ra, r0), min(rb, r1)):
            for c in range(max(ca, c0), min(cb, c1)):
                square = rectangle(ogr, (G.X0+c*G.CELL, G.Y0-(r+1)*G.CELL, G.X0+(c+1)*G.CELL, G.Y0-r*G.CELL))
                piece = clipped.Intersection(square)
                if piece.GetArea() > 0:
                    buckets[r-r0, c-c0]["built"].append(piece)
                    if group:
                        buckets[r-r0, c-c0][group].append(piece)
    observed = np.zeros(shape, dtype=bool)
    for r in range(r0, r1):
        for c in range(c0, c1):
            full = (G.X0+c*G.CELL >= bounds[0] and G.X0+(c+1)*G.CELL <= bounds[2]
                    and G.Y0-(r+1)*G.CELL >= bounds[1] and G.Y0-r*G.CELL <= bounds[3])
            if not full or not land[r-r0, c-c0]:
                continue
            observed[r-r0, c-c0] = True
            for name in NAMES:
                multi = ogr.Geometry(ogr.wkbMultiPolygon)
                for piece in buckets[r-r0, c-c0][name]:
                    for p in polygon_parts(piece, ogr):
                        multi.AddGeometry(p)
                area = multi.UnionCascaded().GetArea() if multi.GetGeometryCount() else 0
                share = area/(G.CELL*G.CELL)
                if not math.isfinite(share) or share < 0 or share > 1+1e-8:
                    raise ValueError("invalid dissolved building area")
                arrays[name][r-r0, c-c0] = G.footprint_encode(min(share, 1))
    assert all(np.array_equal(a > 0, observed) for a in arrays.values())
    assert np.all(arrays["nonres"] <= arrays["built"]) and np.all(arrays["bldgunk"] <= arrays["built"])
    return arrays, {"features": count, "classes": dict(classes), "image_years": dict(years), "repaired_geometries": repairs,
                    "observed_land_cells": int(observed.sum()), "positive_cells": {n: int((a>1).sum()) for n,a in arrays.items()}}


def build(path, bounds, output_dir, provenance=None, state_path=None):
    gdal, _, _, _ = gis()
    c0, r0, c1, r1 = check_bounds(bounds)
    state_path = Path(state_path or ROOT / "data/build/route/250m/state.tif")
    state = gdal.Open(str(state_path))
    if state is None or (state.RasterXSize, state.RasterYSize) != (G.COLS, G.ROWS) or state.GetGeoTransform() != G.transform():
        raise ValueError("state raster differs from routing lattice")
    if state.GetSpatialRef().GetAuthorityCode(None) != "5070":
        raise ValueError("state raster must be EPSG:5070")
    land = state.ReadAsArray(c0, r0, c1-c0, r1-r0) > 0
    arrays, checks = build_arrays(path, bounds, land)
    output_dir = Path(output_dir); output_dir.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="buildings-stage-", dir=output_dir))
    try:
        for name, array in arrays.items():
            out = gdal.GetDriverByName("GTiff").Create(str(stage/(name+".tif")), G.COLS, G.ROWS, 1, gdal.GDT_Byte,
                      ["TILED=YES", "BLOCKXSIZE=512", "BLOCKYSIZE=512", "COMPRESS=DEFLATE", "SPARSE_OK=YES"])
            out.SetGeoTransform(G.transform()); out.SetProjection(state.GetProjection())
            band = out.GetRasterBand(1); band.SetNoDataValue(0); band.WriteArray(array, c0, r0)
            out.FlushCache(); out = None
        coverage = {"crs": 5070, "bounds": list(bounds), "cell_window": [c0,r0,c1-c0,r1-r0],
                    "rule": "fully queried land cells only; 0 outside coverage; no returned footprint is not verified vacancy"}
        meta = {"built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "coverage": coverage,
                "provenance": provenance or {"input": str(path), "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()},
                "files": {n+".tif": sha256_file(stage/(n+".tif")) for n in NAMES},
                "bands": {n: {"b": list(G.PD_BANDS.values()).index(n)+1, "source": "FEMA/ORNL USA Structures observed footprint shares",
                              "credit": CREDIT, "licence": "CC BY 4.0", "value": "0 outside processed coverage; 1 no footprint returned; 2..101 upper-bound percent + 1",
                              "coverage": coverage} for n in NAMES}, "checks": checks}
        atomic_json(stage/"buildings_meta.json", meta)
        promote_files(stage, output_dir, (*[n+".tif" for n in NAMES], "buildings_meta.json"))
    finally:
        shutil.rmtree(stage)
    print(json.dumps({"coverage": coverage, "checks": checks}), flush=True)
    return meta


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fetch", action="store_true")
    p.add_argument("--bbox", nargs=4, type=float)
    p.add_argument("--input", type=Path)
    p.add_argument("--bounds", nargs=4, type=float)
    p.add_argument("--cache-dir", type=Path, default=ROOT/"data/raw/route/buildings")
    p.add_argument("--output-dir", type=Path, default=ROOT/"data/build/route/250m")
    args = p.parse_args()
    if args.input:
        if args.fetch or args.bbox or args.bounds is None:
            p.error("--input needs --bounds and cannot be combined with --fetch/--bbox")
        build(args.input, args.bounds, args.output_dir)
    else:
        if args.bounds or (args.fetch and not args.bbox) or (args.bbox and not args.fetch):
            p.error("--fetch needs --bbox; --bounds is only for explicit local input")
        if args.fetch:
            bounds = projected_bbox(args.bbox)
            manifest = fetch_snapshot(bounds, args.cache_dir, original_bbox=args.bbox)
        else:
            manifest = json.loads((args.cache_dir/"manifest.json").read_text())
        path = validate_snapshot(manifest, args.cache_dir)
        build(path, manifest["identity"]["bounds"], args.output_dir, provenance=manifest)


if __name__ == "__main__":
    main()
