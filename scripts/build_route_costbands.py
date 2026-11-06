#!/usr/bin/env python3
"""Route optimizer PD bands b11 isoreg and b12 landval on the 250 m EPSG:5070 grid.

Role: writes uint8 GeoTIFFs (DEFLATE, 512 tiles, nodata 0) data/build/route/250m/{isoreg,landval}.tif
plus costbands_meta.json. Neither band feeds routing; both only select $ multipliers/land values.
isoreg: EIA balancing-authority polygons (data/build/eia_ba.gpkg, public domain per docs/layers/eia-ba.md,
17 U.S.C. 105) -> ISO code via route_grid.BA_TO_ISO; overlapping BAs resolved by iso_overlap_key
(RTO before non-RTO, then smaller footprint); no BA -> 0 (the solve uses the TEPPC default set).
landval: NASS Census of Agriculture 2022 county "AG LAND, INCL BUILDINGS - ASSET VALUE, $/acre"
(data/raw/route/nass/county_land_value_2022.csv) joined on 5-digit GEOID to data/build/county_boundaries.geojson;
a withheld (D) county, or one absent from NASS (CT planning regions, VA independent cities, ...), takes its
state's NASS value (state rows of the bulk file qs.census2022.txt.gz), else the median of the state's
numeric counties. Encoded with route_grid.landval_encode. Polygons use the centre rule.
Deps: scripts/route_grid.py; numpy, rasterio, geopandas, shapely.

Usage: venv/bin/python scripts/build_route_costbands.py
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import csv
import gzip
import json
import sys
import time
from collections import Counter
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
import shapely
from scipy.ndimage import distance_transform_edt
from rasterio.features import rasterize
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
BA = ROOT / "data/build/eia_ba.gpkg"
COUNTIES = ROOT / "data/build/county_boundaries.geojson"
NASS = ROOT / "data/raw/route/nass"
AFF = Affine.from_gdal(*G.transform())
SHAPE = (G.ROWS, G.COLS)
STATE_FIPS_CONUS = None

t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


def write(name, arr):
    assert arr.dtype == np.uint8 and arr.shape == SHAPE
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS, crs=G.CRS,
                transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT / f"{name}.tif", "w", **prof) as dst:
        dst.write(arr, 1)
    log(f"wrote {name}.tif {(OUT / f'{name}.tif').stat().st_size / 1e6:.1f} MB")


def verify(name):
    with rasterio.open(OUT / f"{name}.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE and r.crs.to_epsg() == 5070, name
        assert r.dtypes[0] == "uint8" and r.nodata == 0, name
        a = r.read(1)
    log(f"{name}: transform/shape/CRS/dtype/nodata == grid OK")
    return a


def window(geom):
    """(row0, row1, col0, col1) of the grid cells a geometry's bbox touches, clipped to the grid."""
    x0, y0, x1, y1 = geom.bounds
    c0, r1 = G.cell_of(x0, y0)
    c1, r0 = G.cell_of(x1, y1)
    return max(r0, 0), min(r1 + 1, G.ROWS), max(c0, 0), min(c1 + 1, G.COLS)


def build_isoreg():
    ba = gpd.read_file(BA).to_crs(G.CRS)
    ba["geometry"] = shapely.make_valid(ba.geometry.values)
    missing = sorted(set(ba["abbrev"]) - set(G.BA_TO_ISO))
    assert not missing, f"BA abbrevs without an ISO: {missing}"
    ba["iso"] = ba["abbrev"].map(G.BA_TO_ISO)
    ba["code"] = ba["iso"].map(G.ISO_CODE_BY_NAME)
    ba["area"] = ba.geometry.area
    ba["key"] = [G.iso_overlap_key(c, a) for c, a in zip(ba["code"], ba["area"])]
    log(f"eia_ba: {len(ba)} BAs -> " + str(ba.groupby("iso").size().to_dict()))
    # smallest key wins: paint worst first
    order = sorted(range(len(ba)), key=lambda i: ba["key"].iloc[i], reverse=True)
    iso = np.zeros(SHAPE, np.uint8)
    count = np.zeros(SHAPE, np.uint8)
    for i in order:
        g, code = ba.geometry.iloc[i], int(ba["code"].iloc[i])
        r0, r1, c0, c1 = window(g)
        if r0 >= r1 or c0 >= c1:
            continue
        x0, y0 = G.xy_of(c0, r0, center=False)
        tr = Affine.from_gdal(x0, G.CELL, 0.0, y0, 0.0, -G.CELL)
        sh = (r1 - r0, c1 - c0)
        m = rasterize([(g, 1)], out_shape=sh, transform=tr, fill=0, dtype="uint8")
        count[r0:r1, c0:c1] += m
        sub = iso[r0:r1, c0:c1]
        sub[m > 0] = code
    st = _state()
    land = st > 0
    # coastal / gap land cells with no BA take the nearest BA's code (nearest cell that carries one)
    gap = land & (iso == 0)
    before = Counter(st[gap].tolist())
    dist, (ri, ci) = distance_transform_edt(iso == 0, return_indices=True)
    iso_f = np.where(gap, iso[ri, ci], iso)
    assert int(((iso_f == 0) & land).sum()) == 0
    after = Counter(st[gap].tolist())
    log(f"isoreg no-BA land cells filled with the nearest BA code: {int(gap.sum()):,}; max distance {dist[gap].max():.1f} cells "
        f"({dist[gap].max() * G.CELL / 1000:.1f} km); by state FIPS before {dict(before.most_common(12))}; after: 0 "
        f"(remaining no-BA land cells {int(((iso_f == 0) & land).sum())})")
    filled_by_code = Counter(iso_f[gap].tolist())
    log("isoreg filled cells by code: " + str({G.ISO_CODES.get(int(k), '?') + f'({k})': n for k, n in filled_by_code.items()}))
    iso = iso_f
    write("isoreg", iso)
    a = verify("isoreg")
    v, c = np.unique(a, return_counts=True)
    log("isoreg cells per code (all): " + str({G.ISO_CODES.get(int(k), 'no BA') + f'({k})': int(n) for k, n in zip(v, c)}))
    v, c = np.unique(a[land], return_counts=True)
    log("isoreg cells per code (CONUS land): " + str({G.ISO_CODES.get(int(k), 'no BA') + f'({k})': int(n) for k, n in zip(v, c)}))
    ov = int((count > 1).sum())
    log(f"isoreg overlap cells (covered by >1 BA): {ov:,} (land {int(((count > 1) & land).sum()):,}); max BAs on a cell {int(count.max())}")
    log(f"isoreg CONUS land cells with no BA after fill: {int(((a == 0) & land).sum()):,}")
    return {"no_ba_fill_rule": "land cells with no BA polygon take the code of the nearest cell that carries a BA (scipy distance_transform_edt, Euclidean, land cells only)",
            "filled_land_cells": int(gap.sum()), "filled_max_distance_km": round(float(dist[gap].max() * G.CELL / 1000), 1),
            "filled_by_state_fips": {f"{k:02d}": n for k, n in sorted(before.items())},
            "filled_by_code": {str(int(k)): n for k, n in filled_by_code.items()},"cells_by_code": {str(int(k)): int(n) for k, n in zip(*np.unique(a, return_counts=True))},
            "overlap_cells": ov, "no_ba_land_cells": int(((a == 0) & land).sum())}


_st = None


def _state():
    global _st
    if _st is None:
        with rasterio.open(OUT / "state.tif") as r:
            _st = r.read(1)
    return _st


def num(s):
    s = s.strip().replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def state_values():
    """STATE-level NASS value per state FIPS from the bulk file (the withheld-county fallback)."""
    gz = NASS / "qs.census2022.txt.gz"
    want = "AG LAND, INCL BUILDINGS - ASSET VALUE, MEASURED IN $ / ACRE"
    out = {}
    if not gz.exists():
        raise FileNotFoundError(f"{gz} missing: the state-level NASS values are the withheld-county fallback")
    with gzip.open(gz, "rt", encoding="utf-8", errors="replace", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            if r["AGG_LEVEL_DESC"] == "STATE" and r["SHORT_DESC"] == want and r["YEAR"] == "2022":
                v = num(r["VALUE"])
                if v:
                    out[r["STATE_FIPS_CODE"].zfill(2)] = v
    assert out, "no state-level NASS values found in the bulk file"
    return out


def build_landval():
    rows = list(csv.DictReader(open(NASS / "county_land_value_2022.csv", newline="")))
    cv = {r["geoid"]: num(r["value_raw"]) for r in rows}
    log(f"NASS county rows {len(rows)}; numeric {sum(v is not None for v in cv.values())}; "
        f"withheld/non-numeric {Counter(r['value_raw'] for r in rows if num(r['value_raw']) is None)}")
    sv = state_values()
    sv.setdefault("11", sv["24"])  # DC has no county/state NASS value: Maryland's state value
    log(f"NASS state-level values: {len(sv)} states (DC <- Maryland {sv['24']:,.0f})")
    by_state = {}
    for g, v in cv.items():
        if v:
            by_state.setdefault(g[:2], []).append(v)
    med = {s: float(np.median(v)) for s, v in by_state.items()}
    cty = gpd.read_file(COUNTIES).to_crs(G.CRS)
    cty["geoid"] = cty["GEOID"].astype(str).str.zfill(5)
    log(f"county_boundaries: {len(cty)} counties")
    cap = float(np.percentile([v for v in cv.values() if v], 99))
    names = dict(zip(cty["geoid"], cty["NAME"] + ", " + cty["STUSPS"]))
    top = sorted(((v, g) for g, v in cv.items() if v), reverse=True)
    log("top 10 counties by NASS $/ac: " + "; ".join(f"{names.get(g, g)} {v:,.0f}" for v, g in top[:10]))
    capped = [(names.get(g, g), v) for v, g in top if v > cap]
    log(f"county value cap = 99th percentile of county values = {cap:,.0f} $/ac; capped {len(capped)} counties: "
        + "; ".join(f"{n} {v:,.0f}" for n, v in capped))
    shapes, n_direct, n_state, n_med, n_none = [], 0, 0, 0, 0
    fb = Counter()
    for geoid, geom in zip(cty["geoid"], shapely.make_valid(cty.geometry.values)):
        v = cv.get(geoid)
        if v:
            n_direct += 1
        else:
            st = geoid[:2]
            if st in sv:
                v, n_state = sv[st], n_state + 1
            elif st in med:
                v, n_med = med[st], n_med + 1
            else:
                n_none += 1
            fb[st] += 1
        code = G.landval_encode(min(v, cap) if v else v)
        if code:
            shapes.append((geom, code))
    log(f"landval county values: direct {n_direct}, state NASS fallback {n_state}, state-median fallback {n_med}, "
        f"no value {n_none}; fallback by state FIPS (top): {dict(fb.most_common(12))}")
    shapes.sort(key=lambda s: s[1])
    arr = rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8")
    write("landval", arr)
    a = verify("landval")
    land = _state() > 0
    vals = a[land & (a > 0)]
    dec = lambda c: G.landval_decode(int(c))
    p5, p50, p95 = (dec(round(x)) for x in np.percentile(vals, [5, 50, 95]))
    log(f"landval decoded $/ac over CONUS land cells with a value: p5 {p5:,.0f}  p50 {p50:,.0f}  p95 {p95:,.0f}; "
        f"min {dec(vals.min()):,.0f} max {dec(vals.max()):,.0f} (codes {int(vals.min())}..{int(vals.max())}, ceiling code 255)")
    log(f"landval CONUS land cells without a value: {int(((a == 0) & land).sum()):,} of {int(land.sum()):,}")
    errs = [abs(G.landval_decode(G.landval_encode(x)) / x - 1) for x in (150, 1234, 5000, 24000, 100000)]
    log(f"landval round-trip error max {max(errs) * 100:.2f} % (limit 2.2 %)")
    assert max(errs) <= 0.022
    return {"county_direct": n_direct, "state_nass_fallback": n_state, "state_median_fallback": n_med,
            "no_value": n_none, "cap_p99_usd_per_acre": round(cap), "capped_counties": [{"county": n, "value": v} for n, v in capped],
            "top10_counties": [{"county": names.get(g, g), "value": v} for v, g in top[:10]],
            "dc_rule": "DC (no county/state NASS value) takes Maryland's state value", "p5": p5, "p50": p50, "p95": p95}


def main():
    meta = {"built": time.strftime("%Y-%m-%d"), "grid": G.grid_json()}
    meta["isoreg_b11"] = {"source": "data/build/eia_ba.gpkg (EIA Balancing Authorities, 85)", "licence": "public domain (US federal work, 17 U.S.C. 105), docs/layers/eia-ba.md",
                          "overlap_rule": "iso_overlap_key: RTO (codes 2-8) before non-RTO, then smaller footprint area", **build_isoreg()}
    meta["landval_b12"] = {"source": "NASS Census of Agriculture 2022, AG LAND INCL BUILDINGS ASSET VALUE $/acre, county; state fallback for withheld/absent counties",
                           "licence": "public domain (USDA)", "join": "5-digit GEOID string", **build_landval()}
    (OUT / "costbands_meta.json").write_text(json.dumps(meta, indent=1))
    log("done")


if __name__ == "__main__":
    main()
