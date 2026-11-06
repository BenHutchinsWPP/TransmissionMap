#!/usr/bin/env python3
"""Route optimizer PD band b14 wetland: NWI wetland share per 250 m EPSG:5070 cell.

Role: writes data/build/route/250m/wetland.tif (uint8, DEFLATE, 512 tiles, nodata 0) plus wetland_meta.json.
Value = 1 + round(100 * share) on CONUS land (state.tif != 0), 0 elsewhere; share = fraction of the cell
covered by USFWS National Wetlands Inventory polygons whose WETLAND_TYPE is Freshwater Emergent Wetland,
Freshwater Forested/Shrub Wetland or Estuarine and Marine Wetland (Other, Lake, Riverine, Freshwater Pond and
Estuarine and Marine Deepwater are dropped). Share is measured on a 25 m sub-lattice (10 x 10 per cell, polygon
covers a sub-cell when it holds the sub-cell centre); overlapping polygons count once.
Source: the 48 CONUS state + DC `<ST>_geopackage_wetlands.zip` in $NWI_DIR (default data/raw/route/nwi/), with
nwi_zips.json (URL, size, Last-Modified). Public domain (USFWS). Layer `<ST>_Wetlands`, field WETLAND_TYPE.
Per state: unzip into $NWI_WORK/<ST>/ (default an external disk; never /vsizip/), count sub-cells
per cell in windows of WIN cells, save sparse counts to $NWI_WORK/counts/<ST>.npz (a rerun skips counted
states), delete the unzipped copy. A WETLAND_TYPE present in the data outside the known values stops the build.
Then combines the states by per-cell max (files overlap at borders and repeat the same polygons), writes the band and prints the checks:
raster area vs the kept polygons' ACRES per state, and the share of land cells in codes 1 / 2-26 / 27-51 / 52-101.
Deps: scripts/route_grid.py; numpy, rasterio, pyogrio, shapely (venv); data/build/route/250m/state.tif.
Usage: venv/bin/python scripts/build_route_wetland.py [ST ...]   (states given: count only those, no band)
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
from rasterio.features import rasterize
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
SRC = Path(os.environ.get("NWI_DIR") or ROOT / "data/raw/route/nwi")
WORK = Path(os.environ.get("NWI_WORK") or ROOT / "data/raw/route/nwi_work")
AFF = Affine.from_gdal(*G.transform())
SHAPE = (G.ROWS, G.COLS)
SUB = 10  # 25 m sub-cells per 250 m cell edge
WIN = 256  # cells per window edge
KEPT = ["Freshwater Emergent Wetland", "Freshwater Forested/Shrub Wetland", "Estuarine and Marine Wetland"]
# Two WA polygons (ATTRIBUTE PSS1C, 14.7 ac) carry the misspelt type "Freshwater Emergent Wetlands"; they are kept as wetland.
KEPT_ALIAS = ["Freshwater Emergent Wetlands"]
# Dropped types: the eight seen in DE plus "Lacustrine" (one 2-acre WI polygon, a lake type).
KNOWN = KEPT + KEPT_ALIAS + ["Freshwater Pond", "Riverine", "Other", "Lake", "Estuarine and Marine Deepwater", "Lacustrine"]
CREDIT = "U.S. Fish and Wildlife Service, National Wetlands Inventory"
M2_PER_ACRE = 4046.8564224
TOL = 0.05

t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


def count_state(st, z):
    """Sparse sub-cell counts of one state: (flat cell index, count 1..100), plus its meta."""
    out = WORK / "counts" / f"{st}.npz"
    key = {"kept": KEPT + KEPT_ALIAS, "sub": SUB}
    if out.exists():
        d = np.load(out, allow_pickle=False)
        meta = json.loads(str(d["meta"]))
        if meta.get("key") == key:
            log(f"{st}: counted earlier")
            return d["idx"], d["n"], meta
        log(f"{st}: cached counts use another type filter, recounting")
    tmp = WORK / st
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        with zipfile.ZipFile(z) as zf:
            zf.extractall(tmp)
        gpkgs = sorted(tmp.rglob("*.gpkg"))
        assert len(gpkgs) == 1, (st, gpkgs)
        gp, layer = gpkgs[0], f"{st}_Wetlands"
        info = pyogrio.read_info(gp, layer=layer)
        crs = str(info["crs"])
        assert "Albers_Conic_Equal_Area" in crs and '"latitude_of_center",23' in crs and '"longitude_of_center",-96' in crs \
            and '"standard_parallel_1",29.5' in crs and '"standard_parallel_2",45.5' in crs and "NAD" in crs, (st, crs)
        attrs = pyogrio.read_dataframe(gp, layer=layer, columns=["WETLAND_TYPE", "ACRES"], read_geometry=False)
        types = {str(k): int(v) for k, v in attrs["WETLAND_TYPE"].value_counts(dropna=False).items() if v}  # a categorical lists unused domain values at 0
        odd = sorted(set(types) - set(KNOWN))
        if odd:
            raise SystemExit(f"STOP: {st} has WETLAND_TYPE values outside the known eight: {odd}")
        kept_mask = attrs["WETLAND_TYPE"].isin(KEPT + KEPT_ALIAS)
        acres_kept = float(attrs.loc[kept_mask, "ACRES"].sum())
        where = "WETLAND_TYPE IN (" + ",".join(f"'{k}'" for k in KEPT + KEPT_ALIAS) + ")"
        xmin, ymin, xmax, ymax = info["total_bounds"]
        c0, r0 = max(0, int((xmin - G.X0) // G.CELL)), max(0, int((G.Y0 - ymax) // G.CELL))
        c1, r1 = min(G.COLS, int((xmax - G.X0) // G.CELL) + 1), min(G.ROWS, int((G.Y0 - ymin) // G.CELL) + 1)
        idx, cnt = [], []
        for ro in range(r0, r1, WIN):
            for co in range(c0, c1, WIN):
                h, w = min(WIN, r1 - ro), min(WIN, c1 - co)
                x0, y0 = G.X0 + co * G.CELL, G.Y0 - ro * G.CELL
                bbox = (x0, y0 - h * G.CELL, x0 + w * G.CELL, y0)
                df = pyogrio.read_dataframe(gp, layer=layer, columns=[], where=where, bbox=bbox)
                geoms = [g for g in df.geometry.values if g is not None and not g.is_empty]
                if not geoms:
                    continue
                tr = Affine(G.CELL / SUB, 0, x0, 0, -G.CELL / SUB, y0)
                m = rasterize(((g, 1) for g in geoms), out_shape=(h * SUB, w * SUB), transform=tr, fill=0,
                              dtype="uint8", all_touched=False)
                c = m.reshape(h, SUB, w, SUB).sum(axis=(1, 3), dtype=np.int32)
                rr, cc = np.nonzero(c)
                idx.append((rr + ro) * G.COLS + cc + co)
                cnt.append(c[rr, cc])
        idx = np.concatenate(idx) if idx else np.zeros(0, np.int64)
        cnt = np.concatenate(cnt) if cnt else np.zeros(0, np.int32)
        meta = {"layer": layer, "features": int(len(attrs)), "wetland_type": types, "kept_features": int(kept_mask.sum()),
                "acres_kept": acres_kept, "acres_raster": float(cnt.sum()) * (G.CELL / SUB) ** 2 / M2_PER_ACRE,
                "cells": int(len(idx)), "key": key}
        (WORK / "counts").mkdir(parents=True, exist_ok=True)
        np.savez(out, idx=idx, n=cnt.astype(np.int32), meta=json.dumps(meta))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    log(f"{st}: {meta['features']:,} polygons, {meta['kept_features']:,} kept, {meta['cells']:,} cells, "
        f"acres kept {acres_kept:,.0f} raster {meta['acres_raster']:,.0f}")
    return idx, cnt.astype(np.int32), meta


def main():
    zips = json.loads((SRC / "nwi_zips.json").read_text())
    assert len(zips) == 49, f"expected 48 states + DC, got {len(zips)}"
    only = sys.argv[1:]
    cnt = np.zeros(G.ROWS * G.COLS, np.int32)
    seen = np.zeros(G.ROWS * G.COLS, np.uint8)
    per_state = {}
    for st in sorted(zips):
        if only and st not in only:
            continue
        idx, n, meta = count_state(st, SRC / f"{st}_geopackage_wetlands.zip")
        np.maximum.at(cnt, idx, n)  # state files overlap at borders and repeat the same polygons: max, not sum
        seen[idx] += 1
        per_state[st] = {"last_modified": zips[st]["last_modified"], "url": zips[st]["url"], **meta}
    if only:
        return
    log(f"check cells in >= 2 state files: {int((seen >= 2).sum()):,}")
    cnt = cnt.reshape(SHAPE)
    with rasterio.open(OUT / "state.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE
        land = r.read(1) != 0
    band = np.where(land, 1 + np.rint(cnt).astype(np.int32), 0).astype(np.uint8)
    assert not band[~land].any() and band.max() <= 101
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS, crs=G.CRS,
                transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT / "wetland.tif", "w", **prof) as dst:
        dst.write(band, 1)
    log(f"wrote wetland.tif {(OUT / 'wetland.tif').stat().st_size / 1e6:.1f} MB")

    outliers = {}
    for st, m in per_state.items():
        ratio = m["acres_raster"] / m["acres_kept"] if m["acres_kept"] else None
        m["raster_over_acres"] = None if ratio is None else round(ratio, 4)
        flag = "" if ratio is not None and abs(ratio - 1) <= TOL else "  OUTLIER"
        if flag:
            outliers[st] = m["raster_over_acres"]
        log(f"check {st}: acres kept {m['acres_kept']:,.0f} raster {m['acres_raster']:,.0f} ratio {m['raster_over_acres']}{flag}")
    nl = int(land.sum())
    c = band[land]
    shares = {"1 (none)": int((c == 1).sum()), "2-26 (>0-25 %)": int(((c >= 2) & (c <= 26)).sum()),
              "27-51 (25-50 %)": int(((c >= 27) & (c <= 51)).sum()), "52-101 (>50 %)": int((c >= 52).sum())}
    shares = {k: round(v / nl, 4) for k, v in shares.items()}
    for k, v in shares.items():
        log(f"check land share of codes {k}: {v}")
    vint = sorted(zips[s]["last_modified"] for s in zips)
    from email.utils import parsedate_to_datetime
    d = sorted(parsedate_to_datetime(s).date().isoformat() for s in vint)
    meta = {"built": time.strftime("%Y-%m-%d"),
            "wetland_b14": {"b": 14, "source": "USFWS National Wetlands Inventory, state downloads "
                                               "(documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/), "
                                               f"Last-Modified {d[0]} … {d[-1]}",
                            "credit": CREDIT, "licence": "public domain (USFWS)",
                            "value": "1 + round(100 * share) on CONUS land (state != 0), 0 elsewhere; share = cell area covered by "
                                     f"NWI polygons with WETLAND_TYPE in {KEPT} (25 m sub-cell centres, overlaps counted once)",
                            "last_modified": {"min": d[0], "max": d[-1]}},
            "states": per_state,
            "checks": {"land_cells": nl, "land_share_by_code": shares, "acreage_tolerance": TOL,
                       "acreage_outliers": outliers}}
    (OUT / "wetland_meta.json").write_text(json.dumps(meta, indent=1))
    log("done")


if __name__ == "__main__":
    main()
