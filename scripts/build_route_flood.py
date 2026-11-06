#!/usr/bin/env python3
"""Route optimizer: floodplain flag on the 250 m EPSG:5070 grid.

Role: writes data/build/route/250m/floodplain.tif (uint8 0/1, DEFLATE, 512 tiles, nodata 0) and
floodplain_meta.json. A cell is 1 where >= 50 % of its valid 30 m source pixels are floodplain
(GDAL `average` over 0/1 with NoData excluded, then >= 0.5); cells with no valid pixel are 0.
build_route_restrict.py ORs the band into flags2 bit 2.
Deps: scripts/route_grid.py (grid); gdalwarp CLI, numpy, rasterio (imported lazily).
Input: EPA EnviroAtlas Estimated floodplain CONUS (fetch_route_inputs.py step `flood`) under
data/raw/route/floodplain/unzipped/.

Usage: venv/bin/python scripts/build_route_flood.py
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import json
import os
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/raw/route/floodplain/unzipped/Estimated_floodplain_CONUS/Estimated_floodplain_CONUS.tif"
OUT = ROOT / "data/build/route/250m"
TMP = ROOT / "tmp/build-tmp"
SRC_NODATA = 3
THRESHOLD = 0.5
SHARE_MIN, SHARE_MAX = 0.03, 0.30  # share of CONUS land cells
# (name, lon, lat, expected). Nags Head NC is not a check point: the dune / NC-12 strip there is
# correctly non-floodplain at 250 m (mean ~0.08 amid cells of 1.0).
POINTS = [("Mississippi River at Vicksburg MS", -90.90, 32.33, 1),
          ("Denver CBD", -104.99, 39.74, 0),
          ("Atchafalaya Basin floodway LA", -91.65, 30.30, 1)]
t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


def is_flood(frac):
    """Mean of the valid 0/1 source pixels in a cell (-1 = none valid) -> flag."""
    return (frac >= THRESHOLD) * 1  # scalar or numpy array


def share_ok(share):
    return SHARE_MIN <= share <= SHARE_MAX


def main():
    import numpy as np
    import rasterio
    from rasterio.transform import Affine
    from pyproj import Transformer

    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    warp = TMP / "floodplain_avg.tif"
    tmp_out, tmp_meta = OUT / "floodplain.tif.tmp", OUT / "floodplain_meta.json.tmp"
    X0, Y0, W, H = G.X0, G.Y0, G.COLS, G.ROWS
    try:
        cmd = ["gdalwarp", "-overwrite", "-t_srs", G.CRS,
               "-te", str(X0), str(Y0 - H * G.CELL), str(X0 + W * G.CELL), str(Y0),
               "-ts", str(W), str(H), "-r", "average", "-ot", "Float32",
               "-srcnodata", str(SRC_NODATA), "-dstnodata", "-1", "-wm", "2048", "-multi",
               "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER",
               str(SRC), str(warp)]
        log(" ".join(cmd))
        subprocess.run(cmd, check=True, env={**os.environ, "GDAL_CACHEMAX": "1024"})
        log("warp done")

        with rasterio.open(warp) as r:
            assert r.shape == (H, W), r.shape
            assert r.transform == Affine.from_gdal(*G.transform()), r.transform
            assert r.crs.to_epsg() == 5070, r.crs
            frac = r.read(1)
        flag = is_flood(frac).astype(np.uint8)
        del frac

        with rasterio.open(ROOT / "data/build/route/250m/state.tif") as r:
            land = r.read(1) > 0
        n_land = int(land.sum())
        n_flood = int((flag.astype(bool) & land).sum())
        share = n_flood / n_land
        log(f"floodplain cells {int(flag.sum()):,} total; {n_flood:,} of {n_land:,} land cells = {100 * share:.2f} %")
        if not share_ok(share):
            sys.exit(f"STOP: land share {100 * share:.2f} % outside {100 * SHARE_MIN:.0f}-{100 * SHARE_MAX:.0f} %")

        to_grid = Transformer.from_crs("EPSG:4326", G.CRS, always_xy=True)
        pts, bad = [], []
        for name, lon, lat, want in POINTS:
            x, y = to_grid.transform(lon, lat)
            c, rw = int((x - X0) // G.CELL), int((Y0 - y) // G.CELL)
            got = int(flag[rw, c])
            pts.append({"name": name, "lon": lon, "lat": lat, "row": rw, "col": c, "value": got, "expected": want})
            log(f"point {name} ({lon}, {lat}) row {rw} col {c} -> {got} (expected {want})")
            if got != want:
                bad.append(name)

        prof = dict(driver="GTiff", dtype="uint8", count=1, width=W, height=H, crs=G.CRS,
                    transform=Affine.from_gdal(*G.transform()), nodata=0, tiled=True,
                    blockxsize=G.BLOCK, blockysize=G.BLOCK, compress="deflate", predictor=2,
                    BIGTIFF="IF_SAFER")
        with rasterio.open(tmp_out, "w", **prof) as dst:
            dst.write(flag, 1)
        meta = {
            "built": date.today().isoformat(), "grid": G.grid_json(),
            "source": "EPA EnviroAtlas Estimated floodplain CONUS (Woznicki et al. 2019, Sci. Total Environ. 647:942-953, doi 10.1016/j.scitotenv.2018.07.353)",
            "url": "https://enviroatlas.epa.gov/download/Estimated_floodplain_CONUS.zip",
            "licence": "CC0 (public domain)",
            "vintage": "issued 2018-08-27; zip modified 2023-10-02",
            "method": "gdalwarp -r average of the 30 m 0/1 pixels (source NoData 3 excluded) onto the 250 m grid, no -tap; then threshold",
            "rule": "1 where >= 50 % of the cell's valid 30 m pixels are floodplain; cells with no valid pixel are 0",
            "flood_cells": int(flag.sum()), "land_cells": n_land, "flood_land_cells": n_flood,
            "land_share": round(share, 5), "point_checks": pts,
        }
        tmp_meta.write_text(json.dumps(meta, indent=1))
        if bad:
            sys.exit(f"STOP: point checks failed: {bad}")
        os.replace(tmp_out, OUT / "floodplain.tif")
        os.replace(tmp_meta, OUT / "floodplain_meta.json")
        log("wrote floodplain.tif, floodplain_meta.json")
    finally:
        for p in (tmp_out, tmp_meta, warp):
            p.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
