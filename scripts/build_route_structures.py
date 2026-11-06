#!/usr/bin/env python3
"""Route optimizer PD band b13 bldg: residential structures per 250 m EPSG:5070 cell.

Role: writes data/build/route/250m/bldg.tif (uint8, DEFLATE, 512 tiles, nodata 0) plus bldg_meta.json.
Value = 1 + min(n, 254) on CONUS land (state.tif != 0), 0 elsewhere; n = FEMA/ORNL USA Structures
footprints with OCC_CLS = 'Residential' whose footprint centroid (EPSG:5070) falls in the cell.
Source: the 48 CONUS state zips + DC fetched by `fetch_route_inputs.py structures` into
$STRUCTURES_DIR (default data/raw/route/usa_structures/), with structures_zips.json (per-state
deliverable and Last-Modified dates). Licence CC BY 4.0, credit "Oak Ridge National Laboratory (ORNL);
Federal Emergency Management Agency (FEMA) Geospatial Response Office". Only per-cell counts are kept.
Per state: unzip into $STRUCTURES_DIR/_work/<ST>/, count, save the sparse counts to
_work/counts/<ST>.npz (a rerun skips states already counted), delete the unzipped gdb.
Then sums the states, writes the band and prints the checks (total = sum of per-state residential
counts; share of homes in NLCD 22-24 / pop-flag cells per state; cells with >= 1 home).
Deps: scripts/route_grid.py; numpy, rasterio, pyogrio, pyproj, shapely (venv);
data/build/route/250m/{state,landcover,flags}.tif.
Usage: STRUCTURES_DIR=... venv/bin/python scripts/build_route_structures.py
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import pyogrio
import rasterio
import shapely
from pyproj import Transformer
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
SRC = Path(os.environ.get("STRUCTURES_DIR") or ROOT / "data/raw/route/usa_structures")
WORK = SRC / "_work"
AFF = Affine.from_gdal(*G.transform())
SHAPE = (G.ROWS, G.COLS)
BATCH = 1_000_000
CREDIT = "Oak Ridge National Laboratory (ORNL); Federal Emergency Management Agency (FEMA) Geospatial Response Office"

t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


def count_state(st, z):
    """Sparse residential counts of one state: (flat cell index, count), plus its meta."""
    out = WORK / "counts" / f"{st}.npz"
    if out.exists():
        d = np.load(out, allow_pickle=False)
        log(f"{st}: counted earlier ({int(d['n'].sum()):,} residential)")
        return d["idx"], d["n"], json.loads(str(d["meta"]))
    tmp = WORK / st
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    with zipfile.ZipFile(z) as zf:
        zf.extractall(tmp)
    gdbs = sorted(p for p in tmp.rglob("*.gdb") if p.is_dir())
    assert len(gdbs) == 1, (st, gdbs)
    layers = pyogrio.list_layers(gdbs[0])
    poly = [n for n, g in layers if g and "Polygon" in g]
    assert len(poly) == 1, (st, layers)
    info = pyogrio.read_info(gdbs[0], layer=poly[0])
    attrs = pyogrio.read_dataframe(gdbs[0], layer=poly[0], columns=["OCC_CLS", "IMAGE_DATE"], read_geometry=False)
    classes = {str(k): int(v) for k, v in attrs["OCC_CLS"].value_counts(dropna=False).items()}
    imd = attrs["IMAGE_DATE"][(attrs["OCC_CLS"] == "Residential").values]
    yrs = imd.dropna().dt.year
    tr = Transformer.from_crs(info["crs"], 5070, always_xy=True)
    idx, outside, n_res = [], 0, 0
    for skip in range(0, info["features"], BATCH):
        df = pyogrio.read_dataframe(gdbs[0], layer=poly[0], columns=["OCC_CLS"], skip_features=skip,
                                    max_features=BATCH)
        g = df.geometry.values[(df["OCC_CLS"] == "Residential").values]
        g = g[~shapely.is_empty(g) & ~shapely.is_missing(g)]
        c = shapely.centroid(g)
        x, y = tr.transform(shapely.get_x(c), shapely.get_y(c))
        col = np.floor((x - G.X0) / G.CELL).astype(np.int64)
        row = np.floor((G.Y0 - y) / G.CELL).astype(np.int64)
        ok = (col >= 0) & (col < G.COLS) & (row >= 0) & (row < G.ROWS)
        outside += int((~ok).sum())
        n_res += len(g)
        idx.append(row[ok] * G.COLS + col[ok])
    idx, n = np.unique(np.concatenate(idx), return_counts=True)
    meta = {"layer": poly[0], "features": int(info["features"]), "occ_cls": classes,
            "residential": int(classes.get("Residential", 0)), "residential_counted": int(n.sum()),
            "residential_empty_geometry": int(classes.get("Residential", 0)) - n_res,
            "residential_off_grid": outside,
            "image_year": {"null": int(imd.isna().sum()),
                           **({"min": int(yrs.min()), "p5": int(yrs.quantile(.05)), "median": int(yrs.median()),
                               "p95": int(yrs.quantile(.95)), "max": int(yrs.max())} if len(yrs) else {})}}
    (WORK / "counts").mkdir(parents=True, exist_ok=True)
    np.savez(out, idx=idx, n=n.astype(np.int32), meta=json.dumps(meta))
    shutil.rmtree(tmp)
    log(f"{st}: {meta['features']:,} structures, {meta['residential']:,} residential, {len(idx):,} cells; "
        f"images {meta['image_year'].get('min')}-{meta['image_year'].get('max')}")
    return idx, n.astype(np.int32), meta


def main():
    zips = json.loads((SRC / "structures_zips.json").read_text())
    assert len(zips) == 49, f"expected 48 states + DC, got {len(zips)}"
    with rasterio.open(OUT / "state.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE
        state = r.read(1)
    cnt = np.zeros(G.ROWS * G.COLS, np.int32)
    per_state = {}
    for st in sorted(zips):
        idx, n, meta = count_state(st, SRC / zips[st]["zip"])
        np.add.at(cnt, idx, n)
        per_state[st] = {**{k: zips[st][k] for k in ("zip", "deliverable", "last_modified", "url")}, **meta}
    cnt = cnt.reshape(SHAPE)
    land = state > 0
    total = sum(m["residential_counted"] for m in per_state.values())
    assert int(cnt.sum()) == total, (int(cnt.sum()), total)
    off_land = int(cnt[~land].sum())
    band = np.where(land, G.BLDG_OFFSET + np.minimum(cnt, G.BLDG_CAP), 0).astype(np.uint8)
    assert not band[~land].any()
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS, crs=G.CRS,
                transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT / "bldg.tif", "w", **prof) as dst:
        dst.write(band, 1)
    log(f"wrote bldg.tif {(OUT / 'bldg.tif').stat().st_size / 1e6:.1f} MB")

    # checks against NLCD developed (22-24) and the pop flag (PD flags bit 5)
    with rasterio.open(OUT / "landcover.tif") as r:
        dev = np.isin(r.read(1), (22, 23, 24))
    with rasterio.open(OUT / "flags.tif") as r:
        pop = (r.read(1) & 32) > 0
    occ = land & (cnt > 0)
    neither = ~dev & ~pop
    hist_edges = [1, 3, 10, 30, 100, 255, 1 << 30]
    hist = np.histogram(cnt[occ], bins=hist_edges)[0]
    checks = {
        "residential_total": total, "residential_off_land": off_land,
        "land_cells": int(land.sum()), "cells_ge1": int(occ.sum()),
        "cells_ge1_share_of_land": round(float(occ.sum() / land.sum()), 4),
        "cells_ge1_neither_dev_nor_pop": round(float((occ & neither).sum() / occ.sum()), 4),
        "homes_in_dev": round(float(cnt[dev & land].sum() / total), 4),
        "homes_in_pop": round(float(cnt[pop & land].sum() / total), 4),
        "homes_in_neither": round(float(cnt[neither & land].sum() / total), 4),
        "cells_by_count": dict(zip(["1-2", "3-9", "10-29", "30-99", "100-254", "255+"], map(int, hist))),
        "capped_cells": int((cnt >= 255).sum()), "max": int(cnt.max()),
        "p99_occupied": float(np.percentile(cnt[occ], 99)),
    }
    by_state = {}
    for code in np.unique(state[land]):
        m = state == code
        n = int(cnt[m].sum())
        if n:
            by_state[int(code)] = {"homes": n, "in_dev": round(float(cnt[m & dev].sum() / n), 3),
                                   "in_pop": round(float(cnt[m & pop].sum() / n), 3),
                                   "in_neither": round(float(cnt[m & neither].sum() / n), 3)}
    checks["by_state_fips"] = by_state
    for k, v in checks.items():
        if k != "by_state_fips":
            log(f"check {k}: {v}")
    for code, v in by_state.items():
        log(f"  state {code:02d}: {v}")
    deliv = sorted({m["deliverable"] for m in per_state.values()})
    meta = {"built": time.strftime("%Y-%m-%d"),
            "bldg_b13": {"b": 13, "source": "FEMA/ORNL USA Structures (gis-fema.hub.arcgis.com/pages/usa-structures), "
                                             f"state deliverables {deliv[0][:4]}-{deliv[0][4:6]}-{deliv[0][6:]} … "
                                             f"{deliv[-1][:4]}-{deliv[-1][4:6]}-{deliv[-1][6:]}",
                         "credit": CREDIT, "licence": "CC BY 4.0",
                         "value": "1 + min(n, 254) on CONUS land (state != 0), 0 elsewhere; n = OCC_CLS 'Residential' "
                                  "footprints whose centroid falls in the cell",
                         "deliverables": {d: sorted(s for s, m in per_state.items() if m["deliverable"] == d) for d in deliv}},
            "states": per_state, "checks": checks}
    (OUT / "bldg_meta.json").write_text(json.dumps(meta, indent=1))
    log("done")


if __name__ == "__main__":
    main()
